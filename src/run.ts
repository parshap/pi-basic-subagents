import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const STATUSES = ["running", "completed", "failed", "stopped"] as const;
export type Status = (typeof STATUSES)[number];

/** One subagent, as every shape in docs/ux.md shows it. `state` is what a running one is doing. */
export interface RunView {
	id: string;
	description: string;
	status: Status;
	state?: string;
	error?: string;
	model?: string;
	elapsedMs?: number;
	contextTokens?: number;
}

/** What identifies a run across parent processes; recorded in the parent session. */
export interface RunRecord {
	id: string;
	/** The child's pi session id. */
	sessionId: string;
	description: string;
	cwd: string;
	sessionDir: string;
	model: string | undefined;
}

export interface RunOptions extends RunRecord {
	/** Extra pi CLI flags, computed per launch so a resume gets the parent's current trust and limits. */
	args: () => string[];
	env: NodeJS.ProcessEnv;
	onSettle: (run: Run) => void;
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const STDERR_TAIL = 4096;
const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 10_000;

// Unref'd so pending cleanup never holds the parent open; the child exits on stdin EOF anyway.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** Wait up to `graceMs` for a process to exit on its own, then SIGTERM, then SIGKILL. */
async function reap(proc: ChildProcess | undefined, exited: Promise<void>, graceMs: number): Promise<void> {
	const alive = () => proc !== undefined && proc.exitCode === null && proc.signalCode === null;
	await Promise.race([exited, sleep(graceMs)]);
	if (alive()) proc!.kill("SIGTERM");
	await Promise.race([exited, sleep(5000)]);
	if (alive()) proc!.kill("SIGKILL");
}

/** Run pi with the given args the way the current process was started (node script or compiled binary). */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exec = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** One subagent: a `pi --mode rpc` child that lives while a prompt is running. */
export class Run {
	status: Status = "running";
	result = "";
	error: string | undefined;
	sessionPath: string | undefined;
	/** Tool calls in flight, by call id; pi runs a message's tool calls in parallel. */
	readonly tools = new Map<string, { name: string; args: unknown }>();
	startedAt: number | undefined;
	/** The child's context size as of its latest model response, as pi's footer shows it. */
	contextTokens: number | undefined;
	/** Frozen at settlement; restored snapshots can assign this directly. */
	elapsedMs: number | undefined;
	/** Resolves when the current run settles. */
	done: Promise<void> = Promise.resolve();

	private proc: ChildProcess | undefined;
	private exited: Promise<void> = Promise.resolve();
	private settle = () => {};
	private starting: Promise<void> = Promise.resolve();
	/** Bumped per launch so a previous process's late events can't touch the current run. */
	private generation = 0;
	private stopping = false;
	/** pi accepted a steer during this launch's current prompt. */
	private steered = false;
	private stderr = "";
	private lastAssistant: any;
	private nextId = 0;
	private pending = new Map<string, (response: any) => void>();

	readonly opts: RunOptions;

	constructor(opts: RunOptions) {
		this.opts = opts;
	}

	/** The latest tool call still running. */
	get currentTool() {
		return [...this.tools.values()].at(-1);
	}

	get id() {
		return this.opts.id;
	}

	get sessionId() {
		return this.opts.sessionId;
	}

	view(): RunView {
		const elapsedMs =
			this.status === "running" && this.startedAt !== undefined
				? Math.max(0, Date.now() - this.startedAt)
				: this.elapsedMs;
		return {
			id: this.id,
			description: this.opts.description,
			status: this.status,
			...(this.error !== undefined && { error: this.error }),
			...(this.opts.model !== undefined && { model: this.opts.model }),
			...(elapsedMs !== undefined && { elapsedMs }),
			...(this.contextTokens !== undefined && { contextTokens: this.contextTokens }),
		};
	}

	/**
	 * Deliver `message`: steer the running child, or resume the finished one from its session.
	 * `beforeResume` runs in the same tick as the resume's reservation, so it can enforce a cap.
	 */
	async send(message: string, beforeResume: () => void): Promise<"steer" | "resume"> {
		// A steer that loses a race to the run settling is retried as a resume, or as a steer of whatever
		// resume another caller started meanwhile.
		while (this.status === "running") if (await this.steer(message)) return "steer";
		beforeResume();
		await this.prompt(message);
		return "resume";
	}

	/** Launch the child on its session (new or saved) and send `message` as a prompt. */
	prompt(message: string): Promise<void> {
		// Reserve the run synchronously so concurrent callers steer this launch instead of starting another.
		this.status = "running";
		this.result = "";
		this.error = undefined;
		this.stopping = false;
		this.steered = false;
		this.stderr = "";
		this.lastAssistant = undefined;
		this.startedAt = Date.now();
		this.elapsedMs = undefined;
		this.done = new Promise((resolve) => (this.settle = resolve));
		this.starting = this.launch(message, ++this.generation).catch((err) => {
			this.finish("failed", `Failed to start pi: ${err instanceof Error ? err.message : err}`);
			throw err;
		});
		return this.starting;
	}

	private async launch(message: string, generation: number): Promise<void> {
		await this.exited;
		if (generation !== this.generation || this.status !== "running") return; // Stopped meanwhile.
		fs.mkdirSync(this.opts.sessionDir, { recursive: true });
		const pi = piInvocation([
			"--mode",
			"rpc",
			"--session-dir",
			this.opts.sessionDir,
			"--session-id",
			this.sessionId,
			...this.opts.args(),
		]);
		const proc = spawn(pi.command, pi.args, {
			cwd: this.opts.cwd,
			env: this.opts.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;
		this.exited = new Promise((resolve) => proc.once("close", () => resolve()));

		const current = () => generation === this.generation;
		// Per launch, so a stopped process's requests still resolve after a resume replaced it.
		const pending = new Map<string, (response: any) => void>();
		this.pending = pending;
		let buffer = "";
		proc.stdout!.setEncoding("utf8");
		proc.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			// Split on LF only: JSON strings may contain U+2028/U+2029 (pi's docs/json.md).
			for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (line) this.handle(line, pending, current());
			}
		});
		proc.stderr!.setEncoding("utf8");
		proc.stderr!.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
		});
		proc.stdin!.on("error", () => {}); // EPIPE after exit is reported via "close".
		proc.once("error", (err) => current() && this.finish("failed", `Failed to start pi: ${err.message}`));
		proc.once("close", (code, signal) => {
			for (const resolve of pending.values()) resolve({ success: false, error: "pi exited" });
			pending.clear();
			if (!current()) return;
			const reason = `pi exited before finishing (code ${code}, signal ${signal}).\n${this.stderr.trim()}`;
			this.finish(this.stopping ? "stopped" : "failed", reason);
		});

		// pi answers once it has started; a child stuck in startup fails here. Prompts aren't
		// bounded because pi may compact before accepting one.
		const state = await this.request({ type: "get_state" }, STARTUP_TIMEOUT_MS);
		if (!current()) return;
		if (!state.success) return this.finish("failed", `pi didn't start: ${state.error}\n${this.stderr.trim()}`);
		this.sessionPath = state.data?.sessionFile;
		// followUp: an extension in the child may already have started a turn.
		const res = await this.request({ type: "prompt", message, streamingBehavior: "followUp" });
		if (!current()) return;
		if (!res.success) this.finish("failed", `pi rejected the prompt: ${res.error}`);
		else if (res.data?.disposition === "handled")
			this.finish("completed", "(the prompt was handled without a model run)");
	}

	/** Steer a running child; returns false if its run finished first. */
	private async steer(message: string): Promise<boolean> {
		await this.starting.catch(() => {});
		if (this.status !== "running") return false;
		const generation = this.generation;
		const res = await this.request({ type: "steer", message });
		// pi answers a steer as it queues it. If the run settled first, nothing will read the queue,
		// so report it undelivered and let the caller resume with the message instead.
		if (this.status !== "running" || generation !== this.generation) return false;
		if (!res.success) throw new Error(`pi rejected the message: ${res.error}`);
		this.steered = true;
		return true;
	}

	/** Abort a running child, then make sure its process is gone. The session file stays for resuming. */
	async stop(): Promise<void> {
		// Capture this launch: once it settles, a resume may start the next one, which isn't ours to stop.
		const { generation, proc, exited } = this;
		if (this.status === "running") {
			this.stopping = true;
			// Not awaiting startup: a child stuck before accepting its prompt must still be stoppable.
			await this.request({ type: "abort" }, 2000);
			if (generation === this.generation) this.finish("stopped", this.text() || "(stopped before reporting)");
		}
		// A little grace: once pi starts shutting down on stdin EOF, SIGTERM would cut its cleanup short.
		await reap(proc, exited, 3000);
	}

	private request(command: Record<string, unknown>, timeoutMs?: number): Promise<any> {
		const id = `req-${++this.nextId}`;
		const pending = this.pending;
		return new Promise((resolve) => {
			if (!this.write({ ...command, id })) return resolve({ success: false, error: "pi is not running" });
			pending.set(id, resolve);
			if (timeoutMs === undefined) return;
			setTimeout(() => {
				if (!pending.delete(id)) return;
				resolve({ success: false, error: `no response to ${command.type} within ${timeoutMs / 1000}s` });
			}, timeoutMs).unref();
		});
	}

	private write(record: unknown): boolean {
		const stdin = this.proc?.stdin;
		if (!stdin?.writable) return false;
		stdin.write(`${JSON.stringify(record)}\n`);
		return true;
	}

	private handle(line: string, pending: Map<string, (response: any) => void>, current: boolean) {
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "response") {
			pending.get(event.id)?.(event);
			pending.delete(event.id);
			return;
		}
		if (!current) return; // A replaced process's events don't describe this run.
		switch (event.type) {
			case "extension_ui_request":
				// Nobody watches a background subagent: cancel dialogs so they can't hang it.
				// Permission asks reach the parent via PI_SUBAGENT_PARENT_SESSION instead.
				if (DIALOGS.has(event.method)) this.write({ type: "extension_ui_response", id: event.id, cancelled: true });
				break;
			case "tool_execution_start":
				this.tools.set(event.toolCallId, { name: event.toolName, args: event.args });
				break;
			case "tool_execution_end":
				this.tools.delete(event.toolCallId);
				break;
			case "message_end":
				if (event.message?.role === "assistant") {
					this.lastAssistant = event.message;
					// Aborted and failed responses can report zero, which isn't the context's size.
					if (event.message.usage?.totalTokens > 0) this.contextTokens = event.message.usage.totalTokens;
				}
				break;
			case "agent_settled":
				void this.settled(event.aborted);
				break;
		}
	}

	private async settled(aborted: boolean) {
		const generation = this.generation;
		// pi marks the run idle before it reports it settled, and a steer it accepts in between is
		// queued with no run to read it. Run what's queued instead of finishing.
		if (this.steered && !aborted && !this.stopping) {
			this.steered = false;
			const cleared = await this.request({ type: "clear_queue" }, 2000);
			if (generation !== this.generation || this.status !== "running") return;
			const queued = [...(cleared.data?.steering ?? []), ...(cleared.data?.followUp ?? [])];
			if (queued.length > 0) {
				const res = await this.request({ type: "prompt", message: queued.join("\n\n"), streamingBehavior: "followUp" });
				if (generation !== this.generation || this.status !== "running") return;
				if (res.success && res.data?.disposition !== "handled") return; // Its run settles later.
			}
		}
		if (!this.stopping && (this.lastAssistant?.stopReason === "error" || aborted)) {
			const reason =
				this.lastAssistant?.errorMessage || (aborted ? "pi aborted before finishing" : "Model response failed");
			return this.finish("failed", reason);
		}
		this.finish(this.stopping ? "stopped" : "completed", this.text() || "(no output)");
	}

	private text(): string {
		const content = this.lastAssistant?.content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim();
	}

	/** A failed run's result is its reason: partial output would read as an answer. */
	private finish(status: Status, result: string) {
		if (this.status !== "running") return;
		this.status = status;
		if (this.startedAt !== undefined) this.elapsedMs = Math.max(0, Date.now() - this.startedAt);
		this.result = result;
		this.error = status === "failed" ? result : undefined;
		this.tools.clear();
		// The process lives only while a run is active; closing stdin lets it exit cleanly.
		this.proc?.stdin?.end();
		void reap(this.proc, this.exited, EXIT_GRACE_MS);
		this.settle();
		this.opts.onSettle(this);
	}
}
