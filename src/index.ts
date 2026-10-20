import { randomUUID } from "node:crypto";
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
import { messageRenderers, renderReportMessage, startRenderers, stopRenderers, Widget } from "./render.ts";
import { Run, type RunRecord, STATUSES } from "./run.ts";

// Session entries, outside the model's context: a run's record at start, then patches with its status changes.
const ENTRY = "basic-subagent";
const INTERRUPTED = "(Stopped when the parent session ended. Resume it with subagent_message.)";
const STOPPED = "(Stopped. Resume it with subagent_message.)";
const WAKE_TEXT = "Subagent reports arrived above. Continue the task they belong to, or report to the user.";

/** A run as the model sees it in wait results and reports; also what the report shapes draw. */
const reportSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
	description: Type.String(),
	status: StringEnum(STATUSES),
	result: Type.Optional(Type.String()),
	session_path: Type.Optional(Type.String()),
});
export type Report = Static<typeof reportSchema>;

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

/** A run's report, with a finished run's result truncated like any pi tool output; the full text stays in the transcript. */
export function report(run: Run): Report {
	const base = { ...run.view(), session_path: run.sessionPath };
	if (run.status === "running") return base;
	const t = truncateHead(run.result);
	const note = `\n\n[Result truncated to ${t.outputLines} of ${t.totalLines} lines. The full text is the last message in the transcript.]`;
	return { ...base, result: t.content + (t.truncated ? note : "") };
}

/** Where a session's subagents keep their sessions: in a directory named after its file, so /resume doesn't list them. */
function childSessionDir(sm: ExtensionContext["sessionManager"]): string {
	const file = sm.getSessionFile();
	return file
		? file.replace(/\.jsonl$/, "")
		: path.join(getAgentDir(), "sessions", "basic-subagents", sm.getSessionId());
}

function formatReport(r: Report): string {
	const head = `${r.id} (${r.type}: ${r.description}) ${r.status}`;
	const transcript = r.session_path ? `\ntranscript: ${r.session_path}` : "";
	return `${head}${transcript}${r.result !== undefined ? `\n\n${r.result}` : ""}`;
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
	/** Each launch's report, by the promise it settles, so a script gets the report of the launch it awaited. */
	const reportOf = new WeakMap<Promise<void>, Report>();
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

	/** Empty the outbox into one custom message. */
	function takeReports() {
		const reports = outbox.splice(0);
		const text = reports.map(formatReport).join("\n\n---\n\n");
		const content = `<subagent_notification>\n${text}\n</subagent_notification>`;
		return { customType: "subagent-report", content, display: true, details: { reports } };
	}

	/** Hand every undelivered report to the idle parent and wake it; a busy parent gets them when it settles. */
	function deliver() {
		if (!session?.isIdle() || outbox.length === 0) return;
		try {
			// Append the reports before waking, so a wake pi rejects loses only the turn, not the reports.
			pi.sendMessage(takeReports(), { triggerTurn: false });
			// A user prompt, not sendMessage's triggerTurn, which skips before_agent_start and with it other
			// extensions' prompt sections. Steer queues it if another prompt starts the run first.
			pi.sendUserMessage(WAKE_TEXT, { deliverAs: "steer" });
		} catch (err) {
			session.ui.notify(`pi-basic-subagents: couldn't deliver reports: ${err}`, "error");
		}
	}

	function onSettle(run: Run) {
		// While the session is active, only subagent_stop or a cancelled subagent_start stops runs, and each reports it itself.
		if (run.status === "stopped" || !session) {
			reportOf.set(run.done, report(run));
			if (!session) return; // Shutting down: a reopened session sees the run as interrupted.
			pi.appendEntry(ENTRY, { id: run.id, status: run.status, result: STOPPED });
			lingering.delete(run.id);
		} else {
			// Snapshot now: a resume would replace the result before delivery.
			const r = report(run);
			reportOf.set(run.done, r);
			pi.appendEntry(ENTRY, { id: run.id, status: run.status });
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
		if (i !== -1) outbox.splice(i, 1);
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
		if (i !== -1) outbox.splice(i, 1);
		return r;
	}

	function getRun(id: string): Run {
		const run = runs.get(id);
		if (!run) throw new Error(`Unknown subagent id: ${id}`);
		return run;
	}

	pi.on("agent_settled", () => {
		// Reports still in the outbox are delivered below; their rows stay through the turn that reads them.
		for (const id of lingering) if (!outbox.some((r) => r.id === id)) lingering.delete(id);
		widget.refresh();
		deliver();
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
	 * as running was stopped when its process exited.
	 */
	function restoreRuns(ctx: ExtensionContext) {
		type Saved = RunRecord & { status?: Run["status"]; result?: string };
		const saved = new Map<string, Saved>();
		// All branches: runs are processes, not conversation state, so /tree doesn't change them.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const data = entry.data as Saved;
			saved.set(data.id, { ...saved.get(data.id), ...data });
		}
		for (const { status = "running", result, ...record } of saved.values()) {
			// Runs a fork copied from its original stay with the original, so the two never share a child session.
			// This also drops starts that failed or were cancelled: their status patch was never followed by a record.
			if (record.sessionDir !== childSessionDir(ctx.sessionManager)) continue;
			const run = addRun(record, ctx.sessionManager.getSessionId());
			run.sessionPath = SessionManager.findById(record.cwd, record.sessionId, record.sessionDir);
			run.status = status === "running" ? "stopped" : status;
			run.result = status === "running" ? INTERRUPTED : (result ?? "");
		}
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

	/** Resume a finished or stopped subagent for a script; cancelling, even during startup, stops it again. */
	async function resumeRun(id: string, message: string, signal: AbortSignal | undefined) {
		const run = getRun(id);
		// A script can't steer what it's waiting for, so steering stays with the model's subagent_message.
		if (run.status === "running")
			throw new Error(`${id} is running; its report will wake you. subagent_message steers it.`);
		checkCapacity();
		pi.appendEntry(ENTRY, { id, status: "running" });
		const resuming = run.prompt(message);
		const done = run.done;
		try {
			await untilAborted(resuming, signal);
			if (run.status === "failed") throw new Error(run.result);
		} catch (err) {
			await run.stop();
			retractFailure(run);
			throw signal?.aborted ? new Error(`Cancelled; ${id} stopped. subagent_message resumes it.`) : err;
		}
		widget.refresh();
		return { run, done };
	}

	// The model's tools return at once, so it never blocks; scripts get their own tools that wait, as Claude Code
	// has Agent for the model and agent() for workflow scripts. Each then describes one behavior.
	function registerTools() {
		pi.registerTool({
			name: "subagent_start",
			label: "Subagent",
			description: [
				"Start a subagent: a fresh pi session with your tools, skills, and project context, but not this conversation.",
				`It returns at once, and its report wakes you later. At most ${config.maxConcurrent} run at once; more fail.`,
				"Types: explore is asked not to change the project (research, review, verification); general-purpose (the default) can change things.",
			].join(" "),
			exposure: "model-only",
			parameters: startParams,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { run } = await startRun(params, signal, ctx);
				// Right where the model decides what's next; a description alone doesn't stop the reflexive wait.
				const text = `Started ${run.id}; its report will wake you. Do other work or end your turn.`;
				return { content: [{ type: "text", text }], details: { run: run.view() } };
			},
			...startRenderers,
		});

		pi.registerTool({
			name: "subagent_run",
			label: "Subagent run",
			// subagent_start, which it refers to, stays declared even with codemode.mode "only": that hides only tools scripts can call.
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
					structuredContent: r,
					details: { run: run.view() },
				};
			},
		});

		pi.registerTool({
			name: "subagent_message",
			label: "Subagent message",
			description:
				"Send a message to a subagent. A running one gets it after its current step; a finished or stopped one resumes with its history and reports again.",
			exposure: "model-only",
			// Changes a run's state, so calls on one subagent in the same message take effect in order. Like
			// Claude Code's non-concurrency-safe tools; pi makes the whole message sequential.
			executionMode: "sequential",
			parameters: messageParams,
			async execute(_toolCallId, params, signal) {
				const { run, how } = await sendTo(params.id, params.message, signal);
				// What happens next, so the model doesn't wait to find out.
				const sent = how === "resume" ? `Resumed ${run.id}` : `Sent to ${run.id} after its current step`;
				return { content: [{ type: "text", text: `${sent}; its report will wake you.` }], details: { delivered: how } };
			},
			...messageRenderers,
		});

		pi.registerTool({
			name: "subagent_continue",
			label: "Subagent continue",
			description:
				"Resume a finished or stopped subagent with a message, and resolve with its next report. Cancelling the call stops it.",
			exposure: "codemode",
			parameters: messageParams,
			outputSchema: reportSchema,
			async execute(_toolCallId, params, signal) {
				const { run, done } = await resumeRun(params.id, params.message, signal);
				const r = await nextReport(run, done, signal);
				return {
					content: [{ type: "text", text: formatReport(r) }],
					structuredContent: r,
					details: { run: run.view() },
				};
			},
		});

		pi.registerTool({
			name: "subagent_stop",
			label: "Subagent stop",
			description: "Stop a running subagent. subagent_message resumes it.",
			exposure: "model-only",
			// Changes a run's state, so it's ordered with the other calls in its message (see subagent_message).
			executionMode: "sequential",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_toolCallId, params) {
				const run = getRun(params.id);
				await run.stop();
				return { content: [{ type: "text", text: `${run.id}: ${run.status}.` }], details: { run: run.view() } };
			},
			...stopRenderers,
		});
	}
}
