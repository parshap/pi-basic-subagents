import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	parseArgs,
	SessionManager,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type Config, currentDepth, inheritedFlags, resolveConfig } from "./config.ts";
import { SUBAGENT_TYPES, type SubagentType } from "./prompts.ts";
import { messageRenderers, type Report, renderReportMessage, startRenderers, stopRenderers, Widget } from "./render.ts";
import { Run, type RunRecord, type RunView, STATUSES } from "./run.ts";

// Session entries, outside the model's context: a run's record at start, then patches with its status changes.
const ENTRY = "basic-subagent";
const INTERRUPTED = "(Stopped when the parent session ended. Resume it with subagent_message.)";
const STOPPED = "(Stopped. Resume it with subagent_message.)";
const WAKE_TEXT = "Subagent reports arrived above. Continue the task they belong to, or report to the user.";

/** What a script's subagent_start_and_wait resolves to: the report's content, no metrics. */
const reportSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
	description: Type.String(),
	status: StringEnum(STATUSES),
	result: Type.Optional(Type.String()),
	session_path: Type.Optional(Type.String()),
});
const forScript = (r: Report): Static<typeof reportSchema> => {
	const { id, type, description, status, session_path } = r;
	return { id, type, description, status, result: r.result, session_path };
};

const startParams = Type.Object({
	subagent_type: Type.Optional(StringEnum(Object.keys(SUBAGENT_TYPES) as SubagentType[])),
	prompt: Type.String({
		description: "All the subagent sees: the goal, relevant context, constraints, and what to report.",
	}),
	description: Type.String({ description: "3-5 words, for display." }),
	model: Type.Optional(
		Type.String({ description: 'Model as "provider/id" with optional ":thinking". Defaults to the current model.' }),
	),
});
const messageParams = Type.Object({ id: Type.String(), message: Type.String() });

/** A run's report, with a finished run's result truncated like any pi tool output, pointing to `file` for the rest. */
export function report(run: Run, file?: string): Report {
	const base = { ...run.view(), session_path: run.sessionPath };
	if (run.status === "running") return base;
	return { ...base, result: truncated(run.result, file) };
}

function truncated(text: string, file: string | undefined): string {
	const t = truncateHead(text);
	if (!t.truncated) return t.content;
	const rest = file ? `in ${file}` : "the last message in the transcript";
	return `${t.content}\n\n[Result truncated to ${t.outputLines} of ${t.totalLines} lines. The full text is ${rest}.]`;
}

/**
 * Keep a finished launch's full report in a file next to its transcript, so the model can read it in
 * parts, and a reopened session can deliver it, without either loading the JSONL transcript.
 */
function writeReport(run: Run, key: string): string | undefined {
	const file = path.join(run.opts.sessionDir, `${run.id}-${key.slice(0, 8)}.md`);
	try {
		fs.writeFileSync(file, run.result);
		return file;
	} catch {
		return undefined;
	}
}

/** A report reduced to where to read it, for the ones a reopened session missed, which could be many. */
function briefLine(file: string, lines: number): string {
	return `Report: ${file} (${lines} line${lines === 1 ? "" : "s"})`;
}

/** Where a session's subagents keep their sessions: in a directory named after its file, so /resume doesn't list them. */
function childSessionDir(sm: ExtensionContext["sessionManager"]): string {
	const file = sm.getSessionFile();
	return file
		? file.replace(/\.jsonl$/, "")
		: path.join(getAgentDir(), "sessions", "basic-subagents", sm.getSessionId());
}

/**
 * A report as the model reads it, without the metrics the UI shows. The transcript path is left out too:
 * the JSONL would flood its context. A failed run keeps its context, so the model can ask it what it has.
 */
function formatReport(r: Report): string {
	const head = `${r.id} (${r.type}: ${r.description}) ${r.status}`;
	const text = r.result !== undefined ? `${head}\n\n${r.result}` : head;
	return r.status === "failed" ? `${text}\n\nsubagent_message resumes it.` : text;
}

/** `promise`, or a rejection once `signal` aborts (pi waits for a tool's execute() even after Esc). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Cancelled"));
		if (signal.aborted) abort();
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export default function basicSubagents(pi: ExtensionAPI) {
	const depth = currentDepth(process.env);
	const runs = new Map<string, Run>();
	/** Reports, snapshotted at settle, that haven't reached the parent yet via a wake or a script's call. */
	const outbox: Report[] = [];
	/** Each queued report's key in the session entries, which record its delivery for a reopened session. */
	const keys = new WeakMap<Report, string>();
	/** Each launch's report, by the promise it settles, so a script gets the report of the launch it awaited. */
	const reportOf = new WeakMap<Promise<void>, Report>();
	/** Reports a tool call took, recorded delivered once the turn ends, when its result is in the session. */
	const taken: Report[] = [];
	let session: ExtensionContext | undefined;
	let config: Config;

	const running = (): Run[] => [...runs.values()].filter((r) => r.status === "running");
	/**
	 * Finished runs that stay in the widget until a parent turn that has their reports ends, so the user
	 * sees a batch's progress. Stopped runs leave at once: whoever stopped them already knows.
	 */
	const lingering = new Set<string>();
	const widget = new Widget(() => [...runs.values()].filter((r) => r.status === "running" || lingering.has(r.id)));
	pi.registerMessageRenderer("subagent-report", renderReportMessage);

	/** Record that these reports reached the parent, so a reopened session doesn't send them again. */
	function delivered(reports: Report[]) {
		for (const r of reports) {
			const key = keys.get(r);
			if (key) pi.appendEntry(ENTRY, { id: r.id, delivered: key });
		}
	}

	/** Empty the outbox into one custom message. */
	function takeReports() {
		const reports = outbox.splice(0);
		delivered(reports);
		const text = reports.map(formatReport).join("\n\n---\n\n");
		const content = `<subagent_notification>\n${text}\n</subagent_notification>`;
		return { customType: "subagent-report", content, display: true, details: { reports } };
	}

	/** Hand every undelivered report to the idle parent and wake it; a busy parent gets them when it settles. */
	function deliver(wake = true) {
		if (!session?.isIdle() || outbox.length === 0) return;
		try {
			// Append the reports before waking, so a wake pi rejects loses only the turn, not the reports.
			pi.sendMessage(takeReports(), { triggerTurn: false });
			if (!wake) return;
			// A user prompt, not sendMessage's triggerTurn, which skips before_agent_start and with it other
			// extensions' prompt sections. Steer queues it if another prompt starts the run first.
			// Said outright: a wake with only some of a batch's reports is when a model reaches for a wait.
			const others = running().map((r) => r.id);
			const more = others.length ? ` Still running: ${others.join(", ")}; their reports will wake you too.` : "";
			pi.sendUserMessage(WAKE_TEXT + more, { deliverAs: "steer" });
		} catch (err) {
			session.ui.notify(`pi-basic-subagents: couldn't deliver reports: ${err}`, "error");
		}
	}

	function onSettle(run: Run) {
		// While the session is active, only subagent_stop or a cancelled subagent_start stops runs, and each reports it itself.
		if (run.status === "stopped" || !session) {
			reportOf.set(run.done, report(run));
			if (!session) return; // Shutting down: a reopened session sees the run as interrupted.
			pi.appendEntry(ENTRY, { ...run.view(), result: STOPPED });
			lingering.delete(run.id);
		} else {
			const key = randomUUID();
			const file = writeReport(run, key);
			// Snapshot now: a resume would replace the result before delivery.
			const r = report(run, file);
			const lines = run.result.split("\n").length;
			reportOf.set(run.done, r);
			keys.set(r, key);
			pi.appendEntry(ENTRY, { ...run.view(), settled: key, report: file, lines });
			outbox.push(r);
			lingering.add(run.id);
		}
		widget.refresh();
		deliver();
	}

	/** Flags for a launch, from the parent's current state, so a resume never replays an old trust decision. */
	function launchArgs(record: RunRecord): string[] {
		// A child is never more trusted than its parent (a reopened session might run elsewhere).
		const trusted = session?.isProjectTrusted() && record.cwd === session.cwd;
		return [
			...inheritedFlags(parseArgs(process.argv.slice(2))),
			...(record.model ? ["--model", record.model] : []),
			trusted ? "--approve" : "--no-approve",
			"--append-system-prompt",
			SUBAGENT_TYPES[record.type as SubagentType],
		];
	}

	function addRun(record: RunRecord, parentSessionId: string): Run {
		const run = new Run({
			...record,
			args: () => launchArgs(record),
			env: {
				...process.env,
				// Permission asks forward to this session. A subagent passes on its own parent's, so they reach
				// the root; the root ignores any inherited value, which can only name an unrelated session.
				PI_SUBAGENT_PARENT_SESSION: (depth > 0 && process.env.PI_SUBAGENT_PARENT_SESSION) || parentSessionId,
				PI_BASIC_SUBAGENTS_DEPTH: String(depth + 1),
			},
			onSettle,
		});
		runs.set(record.id, run);
		return run;
	}

	/** Take back a failed launch's report: the tool's error delivers it instead. */
	function retractFailure(run: Run) {
		const i = outbox.findLastIndex((r) => r.id === run.id);
		if (i !== -1) taken.push(...outbox.splice(i, 1));
	}

	function checkCapacity() {
		if (running().length < config.maxConcurrent) return;
		throw new Error(`${config.maxConcurrent} subagents are already running. Try again after one reports.`);
	}

	/**
	 * A script's call ends with its run's next report, as awaiting `agent()` does in a Claude Code workflow.
	 * Cancelling the call stops the launch, as aborting a workflow stops its agents, so no report floods the parent.
	 */
	async function nextReport(run: Run, done: Promise<void>, signal: AbortSignal | undefined): Promise<Report> {
		try {
			await untilAborted(done, signal);
		} catch {
			if (run.done === done) await run.stop();
			throw new Error(`Cancelled; ${run.id} stopped. subagent_message resumes it.`);
		}
		const r = reportOf.get(done) ?? report(run);
		const i = outbox.indexOf(r); // Not there if stopped, which queues no report.
		if (i !== -1) taken.push(...outbox.splice(i, 1));
		return r;
	}

	function getRun(id: string): Run {
		const run = runs.get(id);
		if (!run) throw new Error(`Unknown subagent id: ${id}`);
		return run;
	}

	pi.on("agent_settled", (event) => {
		delivered(taken.splice(0));
		// Reports still in the outbox are delivered below; their rows stay through the turn that reads them.
		for (const id of lingering) if (!outbox.some((r) => r.id === id)) lingering.delete(id);
		widget.refresh();
		deliver(!event.aborted); // After Esc, the user has the floor: the reports wait in the conversation.
	});
	// Compaction and /tree summaries hold reports back; pi is idle again only after these events.
	const deliverSoon = () => void setTimeout(deliver);
	pi.on("session_compact", deliverSoon);
	pi.on("session_compact_failed", deliverSoon);
	pi.on("session_tree", deliverSoon);

	// A subagent, or a print-mode pi, exits when it finishes, which would stop its own subagents. So
	// before finishing, it waits for them and continues with their reports. pi can't abort this wait;
	// stopping the process (or the subagent, via its parent) ends it, since shutdown stops the children.
	pi.on("agent_before_settle", async (event, ctx) => {
		const exitsWhenDone = depth > 0 || ctx.mode === "print" || ctx.mode === "json";
		if (!exitsWhenDone || event.outcome !== "completed") return;
		await Promise.all(running().map((r) => r.done));
		if (outbox.length === 0) return;
		return { entries: [...event.entries, { type: "custom_message", ...takeReports() }], continue: true };
	});

	pi.on("session_start", (_event, ctx) => {
		session = ctx;
		widget.open(ctx.ui);
		// Global and trusted project settings, merged by pi.
		const resolved = resolveConfig(pi.getSettings());
		config = resolved.config;
		for (const warning of resolved.warnings) ctx.ui.notify(`pi-basic-subagents: ${warning}`, "warning");
		if (depth >= config.maxDepth) return;
		// Once per instance: pi loads extensions afresh for each session and reload.
		registerTools();
		restoreRuns(ctx);
	});

	/**
	 * Runs started by earlier processes of this session, so their ids keep working. One last recorded
	 * as running was stopped when its process exited. The model is told about runs it never heard from,
	 * without a wake, as Claude Code does on resume: it may have ended its turn expecting their reports.
	 */
	function restoreRuns(ctx: ExtensionContext) {
		type Saved = RunRecord & Partial<RunView> & { result?: string };
		type Patch = Saved & { settled?: string; delivered?: string; report?: string; lines?: number };
		const saved = new Map<string, Saved>();
		/** Reports, by key, that were queued but never delivered. */
		const missed = new Map<string, { id: string; status: Run["status"]; file?: string; lines?: number }>();
		// All branches: runs are processes, not conversation state, so /tree doesn't change them.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const { settled, delivered, report: file, lines, ...data } = entry.data as Patch;
			saved.set(data.id, {
				...saved.get(data.id),
				...(data.status === "running" ? { elapsedMs: undefined, error: undefined } : {}),
				...data,
			});
			if (settled) missed.set(settled, { id: data.id, status: data.status ?? "completed", file, lines });
			if (delivered) missed.delete(delivered);
		}
		for (const { status = "running", result, error, elapsedMs, contextTokens, ...record } of saved.values()) {
			// Runs a fork copied from its original stay with the original, so the two never share a child session.
			// This also drops starts that failed or were cancelled: their status patch was never followed by a record.
			if (record.sessionDir !== childSessionDir(ctx.sessionManager)) continue;
			const run = addRun(record, ctx.sessionManager.getSessionId());
			run.sessionPath = SessionManager.findById(record.cwd, record.sessionId, record.sessionDir);
			run.status = status === "running" ? "stopped" : status;
			run.error = error;
			run.elapsedMs = elapsedMs;
			run.contextTokens = contextTokens;
			run.result = status === "running" ? INTERRUPTED : (result ?? "");
			for (const [key, m] of missed) {
				if (m.id !== run.id) continue;
				const result = m.file && briefLine(m.file, m.lines ?? 0);
				// No error: it may be a later launch's, and the file has this one's.
				const r: Report = { ...run.view(), status: m.status, error: undefined, session_path: run.sessionPath, result };
				keys.set(r, key);
				outbox.push(r);
			}
			if (status !== "running") continue;
			// Recorded as stopped, so the next reopen doesn't report the interruption again.
			pi.appendEntry(ENTRY, { id: run.id, status: run.status, result: run.result });
			outbox.push(report(run));
		}
		if (outbox.length > 0) pi.sendMessage(takeReports(), { triggerTurn: false });
	}

	pi.on("session_shutdown", async () => {
		session = undefined;
		widget.close();
		await Promise.all([...runs.values()].map((r) => r.stop()));
		runs.clear();
	});

	/** Launch a new subagent; resolves once its child is running, with the launch to wait on. */
	async function startRun(params: Static<typeof startParams>, signal: AbortSignal | undefined, ctx: ExtensionContext) {
		checkCapacity();
		const model = params.model ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}:${pi.getThinkingLevel()}`);
		let id: string;
		do id = `sa-${Math.random().toString(16).slice(2, 6)}`;
		while (runs.has(id));
		const record: RunRecord = {
			id,
			sessionId: randomUUID(),
			type: params.subagent_type ?? "general-purpose",
			description: params.description,
			// The parent's directory: elsewhere, the parent project's settings and trust wouldn't apply.
			cwd: ctx.cwd,
			sessionDir: childSessionDir(ctx.sessionManager),
			model,
		};
		const run = addRun(record, ctx.sessionManager.getSessionId());
		try {
			await untilAborted(run.prompt(params.prompt), signal);
			if (run.status === "failed") throw new Error(run.result);
		} catch (err) {
			await run.stop(); // Reap the child before forgetting it.
			retractFailure(run);
			runs.delete(id);
			widget.refresh();
			throw err;
		}
		// Recorded outside the model's context, so a reopened session can resume it.
		// After any status patch from startup: restore merges them by id.
		pi.appendEntry(ENTRY, record);
		widget.refresh();
		return { run, done: run.done };
	}

	/** Steer a running subagent or resume a finished one; resolves once pi accepts the message. */
	async function sendTo(id: string, message: string, signal: AbortSignal | undefined) {
		const run = getRun(id);
		let resumed = false;
		const sending = run.send(message, () => {
			checkCapacity();
			resumed = true;
			pi.appendEntry(ENTRY, { id: run.id, status: "running" });
		});
		// Cancelling the call doesn't take back a message pi already accepted.
		const how = await untilAborted(sending, signal).finally(() => {
			if (!resumed || run.status !== "failed") return;
			retractFailure(run);
			throw new Error(run.result);
		});
		widget.refresh();
		return { run, how };
	}

	// The model's tools return at once, so it never blocks, and scripts can call them too; only scripts get tools
	// that wait, as Claude Code has Agent for the model and agent() for workflow scripts.
	function registerTools() {
		pi.registerTool({
			name: "subagent_start",
			label: "Subagent",
			description: [
				"Start a subagent: a fresh pi session with your tools, skills, and project context, but not this conversation.",
				`It returns at once, and its report wakes you later. At most ${config.maxConcurrent} run at once; more fail.`,
				"Types: explore is asked not to change the project (research, review, verification); general-purpose (the default) can change things.",
			].join(" "),
			parameters: startParams,
			outputSchema: Type.Object({ id: Type.String() }),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { run } = await startRun(params, signal, ctx);
				// Right where the model decides what's next; a description alone doesn't stop the reflexive wait.
				const text = `Started ${run.id}; its report will wake you. Do other work or end your turn.`;
				return { content: [{ type: "text", text }], structuredContent: { id: run.id }, details: { id: run.id } };
			},
			...startRenderers,
		});

		pi.registerTool({
			name: "subagent_start_and_wait",
			label: "Subagent start and wait",
			description:
				"Like subagent_start, but resolves with the subagent's report once it finishes. Cancelling the call, as when the script ends, stops the subagent. The user can't talk to you until the script ends, so use it only when the script needs the report; otherwise use subagent_start.",
			exposure: "codemode",
			parameters: startParams,
			outputSchema: reportSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { run, done } = await startRun(params, signal, ctx);
				const r = await nextReport(run, done, signal);
				return {
					content: [{ type: "text", text: formatReport(r) }],
					structuredContent: forScript(r),
					details: { run: run.view() },
				};
			},
		});

		pi.registerTool({
			name: "subagent_message",
			label: "Subagent message",
			description:
				"Send a message to a subagent. A running one gets it after its current step; a finished or stopped one resumes with its history and reports again.",
			// Changes a run's state, so calls on one subagent in the same message take effect in order. Like
			// Claude Code's non-concurrency-safe tools; pi makes the whole message sequential.
			executionMode: "sequential",
			parameters: messageParams,
			outputSchema: Type.Object({ id: Type.String(), resumed: Type.Boolean() }),
			async execute(_toolCallId, params, signal) {
				const { run, how } = await sendTo(params.id, params.message, signal);
				// What happens next, so the model doesn't wait to find out.
				const sent = how === "resume" ? `Resumed ${run.id}` : `Sent to ${run.id} after its current step`;
				return {
					content: [{ type: "text", text: `${sent}; its report will wake you.` }],
					structuredContent: { id: run.id, resumed: how === "resume" },
					details: { delivered: how },
				};
			},
			...messageRenderers,
		});

		pi.registerTool({
			name: "subagent_stop",
			label: "Subagent stop",
			description: "Stop a running subagent. subagent_message resumes it.",
			// Changes a run's state, so it's ordered with the other calls in its message (see subagent_message).
			executionMode: "sequential",
			parameters: Type.Object({ id: Type.String() }),
			outputSchema: Type.Object({ id: Type.String(), status: StringEnum(STATUSES) }),
			async execute(_toolCallId, params) {
				const run = getRun(params.id);
				await run.stop();
				const resumes = run.status === "stopped" ? " subagent_message resumes it." : "";
				return {
					content: [{ type: "text", text: `${run.id}: ${run.status}.${resumes}` }],
					structuredContent: { id: run.id, status: run.status },
					details: { run: { ...run.view(), session_path: run.sessionPath } },
				};
			},
			...stopRenderers,
		});
	}
}
