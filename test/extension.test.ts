import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import basicSubagents, { report } from "../src/index.ts";
import { Run } from "../src/run.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basic-subagents-test-"));
process.argv[1] = path.join(import.meta.dirname, "fake-pi.mjs");

/** Load the extension at `depth` with `settings`, start a session, and return its tools and messages. */
function load(
	depth: number,
	settings: unknown = {},
	entries: unknown[] = [],
	sessionFile = path.join(tmp, "parent.jsonl"),
) {
	process.env.PI_BASIC_SUBAGENTS_DEPTH = String(depth);
	const tools = new Map<string, any>();
	const handlers: Record<string, (...args: any[]) => any> = {};
	const messages: string[] = [];
	let idle = false;
	basicSubagents({
		on: (name: string, fn: (...args: any[]) => any) => (handlers[name] = fn),
		registerTool: (t: any) => tools.set(t.name, t),
		registerMessageRenderer() {},
		getSettings: () => settings,
		getThinkingLevel: () => "off",
		sendMessage: (message: { content: string }) => messages.push(message.content),
		sendUserMessage: (text: string) => messages.push(text),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as any);
	let widget: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	const ui = { notify() {}, setWidget: (_key: string, factory: typeof widget) => (widget = factory) };
	const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t };
	const drawWidget = () => widget?.({ requestRender() {} }, theme).render(200);
	const sessionManager = { getEntries: () => entries, getSessionId: () => "parent", getSessionFile: () => sessionFile };
	handlers.session_start({}, { ui, cwd: tmp, isIdle: () => idle, isProjectTrusted: () => true, sessionManager });
	delete process.env.PI_BASIC_SUBAGENTS_DEPTH;
	const ctx = { cwd: tmp, isProjectTrusted: () => true, sessionManager };
	const execute = (name: string, params: unknown, id = "call", signal?: AbortSignal) =>
		tools.get(name).execute(id, params, signal, undefined, ctx);
	/** The model's call: its details, and for a call about one subagent, that subagent's view. */
	const call = async (name: string, params: unknown) => {
		const { details } = await execute(name, params);
		return details.run ?? details;
	};
	const callText = async (name: string, params: unknown) => (await execute(name, params)).content[0].text;
	/** A codemode script's call, which resolves to the structured result. */
	const script = async (name: string, params: unknown, signal?: AbortSignal) =>
		(await execute(name, params, "codemode/1", signal)).structuredContent;
	const setIdle = (value: boolean) => (idle = value);
	return { tools: [...tools.keys()], handlers, messages, call, callText, script, setIdle, drawWidget };
}

test("main session gets the tools", () => {
	assert.deepEqual(load(0).tools, [
		"subagent_start",
		"subagent_run",
		"subagent_message",
		"subagent_continue",
		"subagent_stop",
	]);
});

test("children at maxDepth get no tools", () => {
	assert.deepEqual(load(1).tools, []);
	assert.equal(load(1, { basicSubagents: { maxDepth: 2 } }).tools.length, 5);
	assert.equal(load(2, { basicSubagents: { maxDepth: 2 } }).tools.length, 0);
});

test("starting beyond maxConcurrent fails", async () => {
	const { call } = load(0, { basicSubagents: { maxConcurrent: 1 } });
	const start = { subagent_type: "explore", prompt: "x", description: "d" };
	const { id } = await call("subagent_start", start);
	await assert.rejects(call("subagent_start", start), /already running/);
	await call("subagent_stop", { id });
	const other = await call("subagent_start", start);
	await assert.rejects(call("subagent_message", { id, message: "resume" }), /already running/);
	await call("subagent_stop", { id: other.id });
});

test("a start without a type is general-purpose", async () => {
	const { call } = load(0);
	const run = await call("subagent_start", { prompt: "slow", description: "d" });
	assert.equal(run.type, "general-purpose");
	await call("subagent_stop", { id: run.id });
});

test("a direct start returns at once, telling the model not to wait", async () => {
	const { call, callText } = load(0);
	const start = { subagent_type: "explore", prompt: "slow", description: "d" };
	const r = await call("subagent_start", start);
	assert.equal(r.status, "running");
	const text = await callText("subagent_start", start);
	assert.match(text, /^Started sa-\w+; its report will wake you\. Do other work or end your turn\.$/);
	await call("subagent_stop", { id: r.id });
	await call("subagent_stop", { id: text.split(" ")[1].slice(0, -1) });
});

test("a script's start resolves with the report, which isn't also sent as a message", async () => {
	const { script, handlers, messages, setIdle } = load(0);
	const r = await script("subagent_run", { subagent_type: "explore", prompt: "hello", description: "d" });
	assert.equal(r.status, "completed");
	assert.equal(r.result, "hello");
	setIdle(true);
	handlers.agent_settled();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(messages, []);
});

test("a script's continue resumes a finished subagent and resolves with its next report, but won't steer", async () => {
	const { call, script } = load(0);
	const { id } = await script("subagent_run", { subagent_type: "explore", prompt: "first", description: "d" });
	assert.equal((await script("subagent_continue", { id, message: "second" })).result, "second");
	await call("subagent_message", { id, message: "slow" });
	await assert.rejects(script("subagent_continue", { id, message: "more" }), new RegExp(`${id} is running`));
	await call("subagent_stop", { id });
});

test("cancelling a script's continue stops the subagent, even while it starts up", async () => {
	const { script, call, handlers, messages, setIdle } = load(0);
	const { id } = await script("subagent_run", { subagent_type: "explore", prompt: "first", description: "d" });
	const stop = new AbortController();
	const waiting = script("subagent_continue", { id, message: "second" }, stop.signal);
	setTimeout(() => stop.abort(), 10); // While its child starts.
	await assert.rejects(waiting, new RegExp(`^Error: Cancelled; ${id} stopped`));
	assert.equal((await call("subagent_stop", { id })).status, "stopped");
	setIdle(true);
	handlers.agent_settled();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(messages, []);
});

test("a script awaiting a resume gets that launch's report, leaving an earlier one queued", async () => {
	const { call, script, handlers, messages, setIdle } = load(0);
	const start = { subagent_type: "explore", description: "d" };
	const { id } = await call("subagent_start", { ...start, prompt: "first" });
	await new Promise((resolve) => setTimeout(resolve, 300)); // Queued: the parent is busy.
	const resumed = script("subagent_continue", { id, message: "slow" });
	await new Promise((resolve) => setTimeout(resolve, 100));
	await call("subagent_stop", { id });
	assert.equal((await resumed).status, "stopped");
	setIdle(true);
	handlers.agent_settled();
	assert.match(messages[0], /\nfirst\n/);
});

test("cancelling a script's call stops the subagent it started, so no report arrives later", async () => {
	const { script, handlers, messages, setIdle } = load(0);
	process.env.FAKE_RUN_MS = "600";
	const stop = new AbortController();
	const waiting = script("subagent_run", { subagent_type: "explore", prompt: "hello", description: "d" }, stop.signal);
	delete process.env.FAKE_RUN_MS;
	setTimeout(() => stop.abort(), 400); // Once it's running.
	await assert.rejects(waiting, /^Error: Cancelled; sa-\w+ stopped\. subagent_message resumes it\.$/);
	await new Promise((resolve) => setTimeout(resolve, 500));
	setIdle(true);
	handlers.agent_settled();
	assert.deepEqual(messages, []);
});

test("a report that settles while the parent is busy wakes it once idle", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	await call("subagent_start", { subagent_type: "explore", prompt: "hello", description: "d" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(messages, []);
	setIdle(true);
	handlers.agent_settled();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(messages.length, 2);
	assert.match(messages[0], /^<subagent_notification>\n.*completed[\s\S]*\nhello\n<\/subagent_notification>$/);
	assert.match(messages[1], /^Subagent reports arrived above/);
});

test("a finished run stays in the widget until a turn with its report ends; a stopped one leaves at once", async () => {
	const { call, script, handlers, setIdle, drawWidget } = load(0);
	const start = { subagent_type: "explore", description: "d" };

	// Delivered by a wake.
	const { id } = await call("subagent_start", { ...start, prompt: "hello" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(drawWidget(), [`✓ ${id} d · completed`]);
	setIdle(true);
	handlers.agent_settled(); // Delivers the report and wakes the parent.
	assert.deepEqual(drawWidget(), [`✓ ${id} d · completed`]);
	handlers.agent_settled(); // The woken turn ends.
	assert.equal(drawWidget(), undefined);

	// Returned to a script in a busy parent's turn.
	setIdle(false);
	const waited = await script("subagent_run", { ...start, prompt: "hi" });
	assert.deepEqual(drawWidget(), [`✓ ${waited.id} d · completed`]);
	handlers.agent_settled();
	assert.equal(drawWidget(), undefined);

	// Finished, then resumed and stopped before its first report arrived.
	const resumed = await call("subagent_start", { ...start, prompt: "hey" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await call("subagent_message", { id: resumed.id, message: "slow" });
	await call("subagent_stop", { id: resumed.id });
	assert.equal(drawWidget(), undefined);
});

test("a reopened session knows earlier runs: interrupted ones resume", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id: cut } = await first.call("subagent_start", {
		subagent_type: "explore",
		prompt: "slow",
		description: "d",
	});
	await first.handlers.session_shutdown();

	const second = load(0, {}, entries);
	const resumed = await second.script("subagent_continue", { id: cut, message: "go on" });

	assert.equal(resumed.result, "go on");
});

test("a fork doesn't take over its original's subagents", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id } = await first.script("subagent_run", {
		subagent_type: "explore",
		prompt: "finished",
		description: "d",
	});
	await first.handlers.session_shutdown();
	const fork = load(0, {}, entries, path.join(tmp, "fork.jsonl"));
	await assert.rejects(fork.call("subagent_stop", { id }), /Unknown subagent id/);
	await assert.rejects(fork.call("subagent_message", { id, message: "more" }), /Unknown subagent id/);
});

test("a resumed run cut short by shutdown reopens as stopped", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id } = await first.script("subagent_run", {
		subagent_type: "explore",
		prompt: "finished",
		description: "d",
	});
	await first.call("subagent_message", { id, message: "slow more" });
	await first.handlers.session_shutdown();
	assert.equal((await load(0, {}, entries).call("subagent_stop", { id })).status, "stopped");
});

test("a message that arrives as a run finishes resumes it without losing the first report", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	process.env.FAKE_STEER_AFTER_SETTLE = "1";
	const { id } = await call("subagent_start", { subagent_type: "explore", prompt: "slow first", description: "d" });
	delete process.env.FAKE_STEER_AFTER_SETTLE;
	assert.equal((await call("subagent_message", { id, message: "second" })).delivered, "resume");
	await new Promise((resolve) => setTimeout(resolve, 300));
	setIdle(true);
	handlers.agent_settled();
	assert.match(messages[0], /\nslow first\n[\s\S]*\nsecond\n/);
});

test("reports held back by /compact arrive once it's done", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	await call("subagent_start", { subagent_type: "explore", prompt: "hello", description: "d" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	handlers.session_compact();
	setIdle(true); // pi is idle only after its session_compact handlers return.
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(messages.length, 2);
});

test("a start that fails leaves no run behind", async () => {
	const entries: any[] = [];
	const { call, drawWidget } = load(0, {}, entries);
	const fakePi = process.argv[1];
	process.argv[1] = path.join(tmp, "broken-pi.mjs");
	fs.writeFileSync(process.argv[1], "process.exit(3);");
	try {
		await assert.rejects(
			call("subagent_start", { subagent_type: "explore", prompt: "x", description: "d" }),
			/pi exited/,
		);
	} finally {
		process.argv[1] = fakePi;
	}
	assert.equal(drawWidget(), undefined);
});

test("a resume that fails to start fails the message, and its report isn't sent again", async () => {
	const { call, script, handlers, messages, setIdle } = load(0);
	const { id } = await script("subagent_run", { subagent_type: "explore", prompt: "first", description: "d" });
	const fakePi = process.argv[1];
	process.argv[1] = path.join(tmp, "broken-pi.mjs");
	fs.writeFileSync(process.argv[1], "process.exit(3);");
	try {
		await assert.rejects(call("subagent_message", { id, message: "again" }), /pi exited/);
	} finally {
		process.argv[1] = fakePi;
	}
	setIdle(true);
	handlers.agent_settled();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(messages, []);
});

test("a subagent about to finish waits for its own subagents, then continues with their reports", async () => {
	const { call, handlers } = load(1, { basicSubagents: { maxDepth: 2 } });
	await call("subagent_start", { subagent_type: "explore", prompt: "hello", description: "d" });
	const other = { type: "custom", customType: "other-extension" };
	const settle = () => handlers.agent_before_settle({ outcome: "completed", entries: [other] }, {});
	const first = await settle();
	assert.deepEqual(
		first.entries.map((e: any) => e.customType),
		["other-extension", "subagent-report"],
	);
	assert.match(first.entries[1].content, /\nhello\n/);
	assert.equal(first.continue, true);
	assert.equal(await settle(), undefined);
});

test("a parent that doesn't exit when done doesn't wait", async () => {
	const { call, handlers } = load(0);
	const { id } = await call("subagent_start", { subagent_type: "explore", prompt: "slow", description: "d" });
	assert.equal(await handlers.agent_before_settle({ outcome: "completed", entries: [] }, { mode: "tui" }), undefined);
	await call("subagent_stop", { id });
});

function finished(result: string): Run {
	const run = new Run({
		id: "sa-test",
		sessionId: randomUUID(),
		type: "explore",
		description: "test",
		cwd: tmp,
		sessionDir: tmp,
		model: undefined,
		args: () => [],
		env: {},
		onSettle() {},
	});
	run.status = "completed";
	run.result = result;
	return run;
}

test("long results are truncated, pointing to the transcript", () => {
	assert.equal(report(finished("all good")).result, "all good");
	const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
	const result = report(finished(long)).result!;
	assert.ok(result.length < long.length);
	assert.match(result, /The full text is the last message in the transcript/);
});
