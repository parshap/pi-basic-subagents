import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import basicSubagents, { report } from "../src/index.ts";
import { Run } from "../src/run.ts";

setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } })); // As pi binds it.

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
	return {
		tools: [...tools.keys()],
		definitions: tools,
		execute,
		handlers,
		messages,
		call,
		callText,
		script,
		setIdle,
		drawWidget,
	};
}

/** The file a brief report points to, from a notification. */
const briefFile = (notification: string, id: string) =>
	notification.match(new RegExp(`${id} \\(explore: d\\) \\w+\\n\\nReport: (\\S+\\.md) \\(\\d+ lines?\\)`))![1];

test("main session gets the tools", () => {
	assert.deepEqual(load(0).tools, ["subagent_start", "subagent_start_and_wait", "subagent_message", "subagent_stop"]);
});

test("children at maxDepth get no tools", () => {
	assert.deepEqual(load(1).tools, []);
	assert.equal(load(1, { basicSubagents: { maxDepth: 2 } }).tools.length, 4);
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
	const { id } = await call("subagent_start", { prompt: "slow", description: "d" });
	assert.equal((await call("subagent_stop", { id })).type, "general-purpose");
});

test("a direct start returns at once, telling the model not to wait", async () => {
	const { callText } = load(0);
	const start = { subagent_type: "explore", prompt: "slow", description: "d" };
	const text = await callText("subagent_start", start);
	assert.match(text, /^Started sa-\w+; its report will wake you\. Do other work or end your turn\.$/);
	const id = text.split(" ")[1].slice(0, -1);
	assert.equal(await callText("subagent_stop", { id }), `${id}: stopped. subagent_message resumes it.`);
});

test("scripts call the model's tools and get structured results; only waiting tools are script-only", async () => {
	const { definitions, script } = load(0);
	const exposures = Object.fromEntries([...definitions].map(([name, t]) => [name, t.exposure ?? "direct"]));
	assert.deepEqual(exposures, {
		subagent_start: "direct",
		subagent_start_and_wait: "codemode",
		subagent_message: "direct",
		subagent_stop: "direct",
	});
	const { id } = await script("subagent_start", { prompt: "slow", description: "d" });
	assert.match(id, /^sa-\w+$/);
	assert.deepEqual(await script("subagent_message", { id, message: "also" }), { id, resumed: false });
	assert.deepEqual(await script("subagent_stop", { id }), { id, status: "stopped" });
	assert.deepEqual(await script("subagent_message", { id, message: "slow" }), { id, resumed: true });
	await script("subagent_stop", { id });
});

test("a script's start_and_wait resolves with the report, which isn't also sent as a message", async () => {
	const { script, handlers, messages, setIdle } = load(0);
	const r = await script("subagent_start_and_wait", { subagent_type: "explore", prompt: "hello", description: "d" });
	assert.equal(r.status, "completed");
	assert.equal(r.result, "hello");
	setIdle(true);
	handlers.agent_settled({ aborted: false });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(messages, []);
});

test("a reopened session gets the reports a script took when pi quit before the script's turn ended", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id } = await first.script("subagent_start_and_wait", {
		subagent_type: "explore",
		prompt: "done",
		description: "d",
	});
	await first.handlers.session_shutdown();
	const [notification] = load(0, {}, entries).messages;
	assert.equal(fs.readFileSync(briefFile(notification, id), "utf8"), "done");
});

test("cancelling a script's call stops the subagent it started, so no report arrives later", async () => {
	const { script, handlers, messages, setIdle } = load(0);
	process.env.FAKE_RUN_MS = "600";
	const stop = new AbortController();
	const waiting = script(
		"subagent_start_and_wait",
		{ subagent_type: "explore", prompt: "hello", description: "d" },
		stop.signal,
	);
	delete process.env.FAKE_RUN_MS;
	setTimeout(() => stop.abort(), 400); // Once it's running.
	await assert.rejects(waiting, /^Error: Cancelled; sa-\w+ stopped\. subagent_message resumes it\.$/);
	await new Promise((resolve) => setTimeout(resolve, 500));
	setIdle(true);
	handlers.agent_settled({ aborted: false });
	assert.deepEqual(messages, []);
});

test("a report that settles while the parent is busy wakes it once idle", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	await call("subagent_start", { subagent_type: "explore", prompt: "hello", description: "d" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(messages, []);
	setIdle(true);
	handlers.agent_settled({ aborted: false });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(messages.length, 2);
	assert.match(messages[0], /^<subagent_notification>\n.*completed[\s\S]*\nhello\n<\/subagent_notification>$/);
	assert.equal(messages[1], "Subagent reports arrived above. Continue the task they belong to, or report to the user.");
});

test("after Esc, reports join the conversation without waking the parent", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	await call("subagent_start", { subagent_type: "explore", prompt: "hello", description: "d" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	setIdle(true);
	handlers.agent_settled({ aborted: true });
	assert.equal(messages.length, 1);
	assert.match(messages[0], /^<subagent_notification>/);
});

test("a wake names the subagents still running", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	const start = { subagent_type: "explore", description: "d" };
	const { id: slow } = await call("subagent_start", { ...start, prompt: "slow" });
	await call("subagent_start", { ...start, prompt: "hello" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	setIdle(true);
	handlers.agent_settled({ aborted: false });
	assert.match(messages[1], new RegExp(`Still running: ${slow}; their reports will wake you too\\.$`));
	await call("subagent_stop", { id: slow });
});

test("a finished run stays in the widget until a turn with its report ends; a stopped one leaves at once", async () => {
	const { call, script, handlers, setIdle, drawWidget } = load(0);
	const start = { subagent_type: "explore", description: "d" };

	// Delivered by a wake.
	const { id } = await call("subagent_start", { ...start, prompt: "hello" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.match(drawWidget()![0], new RegExp(`^✓ ${id} d · completed · \\d+(?:m\\d+)?s$`));
	setIdle(true);
	handlers.agent_settled({ aborted: false }); // Delivers the report and wakes the parent.
	assert.match(drawWidget()![0], new RegExp(`^✓ ${id} d · completed · \\d+(?:m\\d+)?s$`));
	handlers.agent_settled({ aborted: false }); // The woken turn ends.
	assert.equal(drawWidget(), undefined);

	// Returned to a script in a busy parent's turn.
	setIdle(false);
	const waited = await script("subagent_start_and_wait", { ...start, prompt: "hi" });
	assert.match(drawWidget()![0], new RegExp(`^✓ ${waited.id} d · completed · \\d+(?:m\\d+)?s$`));
	handlers.agent_settled({ aborted: false });
	assert.equal(drawWidget(), undefined);

	// Finished, then resumed and stopped before its first report arrived.
	const resumed = await call("subagent_start", { ...start, prompt: "hey" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	await call("subagent_message", { id: resumed.id, message: "slow" });
	await call("subagent_stop", { id: resumed.id });
	assert.equal(drawWidget(), undefined);
});

test("a reopened session reports runs it never heard from, once, without waking the parent", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const start = { subagent_type: "explore", description: "d" };
	const { id: done } = await first.call("subagent_start", { ...start, prompt: "finished" });
	await new Promise((resolve) => setTimeout(resolve, 300)); // Settles while the parent is busy.
	const { id: cut } = await first.call("subagent_start", { ...start, prompt: "slow" });
	await first.handlers.session_shutdown();

	const second = load(0, {}, entries);
	assert.equal(second.messages.length, 1); // No wake.
	assert.equal(fs.readFileSync(briefFile(second.messages[0], done), "utf8"), "finished");
	assert.match(
		second.messages[0],
		new RegExp(`${cut} \\(explore: d\\) stopped\\n\\n\\(Stopped when the parent session ended`),
	);
	await second.call("subagent_message", { id: cut, message: "go on" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	second.setIdle(true);
	second.handlers.agent_settled({ aborted: false }); // Delivers the resumed run's report.
	assert.match(second.messages[1], /\ngo on\n/);
	await second.handlers.session_shutdown();
	assert.deepEqual(load(0, {}, entries).messages, []);
});

test("a fork doesn't take over its original's subagents", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id } = await first.script("subagent_start_and_wait", {
		subagent_type: "explore",
		prompt: "finished",
		description: "d",
	});
	await first.handlers.session_shutdown();
	const fork = load(0, {}, entries, path.join(tmp, "fork.jsonl"));
	await assert.rejects(fork.call("subagent_stop", { id }), /Unknown subagent id/);
	await assert.rejects(fork.call("subagent_message", { id, message: "more" }), /Unknown subagent id/);
});

test("stopping or messaging a finished run whose report hasn't arrived says it will wake the parent", async () => {
	const { callText, handlers, setIdle } = load(0);
	const text = await callText("subagent_start", { subagent_type: "explore", prompt: "hello", description: "d" });
	const id = text.split(" ")[1].slice(0, -1);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(await callText("subagent_stop", { id }), `${id}: completed; its report will wake you.`);
	const resumed = await callText("subagent_message", { id, message: "again" });
	assert.equal(resumed, `Resumed ${id}, which had completed; its reports will wake you.`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	setIdle(true);
	handlers.agent_settled({ aborted: false });
	assert.equal(await callText("subagent_stop", { id }), `${id}: completed.`);
});

test("a resumed run cut short by shutdown reopens as stopped", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id } = await first.script("subagent_start_and_wait", {
		subagent_type: "explore",
		prompt: "finished",
		description: "d",
	});
	await first.call("subagent_message", { id, message: "slow more" });
	await first.handlers.session_shutdown();
	assert.match(load(0, {}, entries).messages[0], new RegExp(`${id} \\(explore: d\\) stopped`));
});

test("a message that arrives as a run finishes resumes it without losing the first report", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	process.env.FAKE_STEER_AFTER_SETTLE = "1";
	const { id } = await call("subagent_start", { subagent_type: "explore", prompt: "slow first", description: "d" });
	delete process.env.FAKE_STEER_AFTER_SETTLE;
	assert.equal((await call("subagent_message", { id, message: "second" })).delivered, "resume");
	await new Promise((resolve) => setTimeout(resolve, 300));
	setIdle(true);
	handlers.agent_settled({ aborted: false });
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
	assert.deepEqual(load(0, {}, entries).messages, []); // Not reported as interrupted either.
});

test("a resume that fails to start fails the message, and its report isn't sent again", async () => {
	const { call, script, handlers, messages, setIdle } = load(0);
	const { id } = await script("subagent_start_and_wait", {
		subagent_type: "explore",
		prompt: "first",
		description: "d",
	});
	const fakePi = process.argv[1];
	process.argv[1] = path.join(tmp, "broken-pi.mjs");
	fs.writeFileSync(process.argv[1], "process.exit(3);");
	try {
		await assert.rejects(call("subagent_message", { id, message: "again" }), /pi exited/);
	} finally {
		process.argv[1] = fakePi;
	}
	setIdle(true);
	handlers.agent_settled({ aborted: false });
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

test("a start acknowledgment stays fixed while the widget follows the run", async () => {
	const app = load(0);
	process.env.FAKE_USAGE = JSON.stringify({ input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160 });
	let start: any;
	try {
		start = await app.execute("subagent_start", {
			subagent_type: "explore",
			prompt: "hello",
			description: "d",
			model: "anthropic/claude-opus-5-5:high",
		});
	} finally {
		delete process.env.FAKE_USAGE;
	}
	const id = start.details.id;
	const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t };
	const renderer = app.definitions.get("subagent_start").renderResult;
	const draw = (expanded = false) => renderer(start, {}, theme, { expanded }).render(300).join("\n");
	assert.equal(draw(), `Started ${id}.\n(ctrl+o to expand)`);
	assert.match(app.drawWidget()![0], /thinking · opus-5-5:high/);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.match(app.drawWidget()![0], /completed · opus-5-5:high · 160 ctx/);
	await app.call("subagent_message", { id, message: "slow again" });
	assert.match(app.drawWidget()![0], /thinking · opus-5-5:high · 160 ctx/);
	await app.call("subagent_stop", { id });
	assert.equal(draw(true), `Started ${id}.`);
	await app.handlers.session_shutdown();
});

test("context size survives reopening, and a resume replaces it", async () => {
	const entries: any[] = [];
	const app = load(0, {}, entries);
	process.env.FAKE_USAGE = JSON.stringify({ input: 42, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 50 });
	let id: string;
	try {
		({ id } = await app.script("subagent_start_and_wait", {
			subagent_type: "explore",
			prompt: "hello",
			description: "d",
			model: "openai/gpt-6-luna:low",
		}));
	} finally {
		delete process.env.FAKE_USAGE;
	}
	const first = await app.call("subagent_stop", { id });
	await app.handlers.session_shutdown();
	process.env.FAKE_USAGE = JSON.stringify({ input: 62, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 70 });
	const reopened = load(0, {}, JSON.parse(JSON.stringify(entries)));
	delete process.env.FAKE_USAGE;
	const restored = await reopened.call("subagent_stop", { id });
	assert.equal(restored.contextTokens, 50);
	assert.equal(first.contextTokens, 50);
	assert.equal(restored.elapsedMs, first.elapsedMs);
	assert.equal(restored.model, first.model);
	await reopened.call("subagent_message", { id, message: "again" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal((await reopened.call("subagent_stop", { id })).contextTokens, 70);
	assert.equal(restored.contextTokens, 50); // Earlier snapshots don't change.
	await reopened.handlers.session_shutdown();
});

test("a run cut short by shutdown keeps its last saved context size", async () => {
	const entries: any[] = [];
	const app = load(0, {}, entries);
	process.env.FAKE_USAGE = JSON.stringify({ input: 42, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 50 });
	let id: string;
	try {
		({ id } = await app.script("subagent_start_and_wait", {
			subagent_type: "explore",
			prompt: "hello",
			description: "d",
		}));
	} finally {
		delete process.env.FAKE_USAGE;
	}
	await app.call("subagent_message", { id, message: "slow again" });
	await app.handlers.session_shutdown();
	const reopened = load(0, {}, JSON.parse(JSON.stringify(entries)));
	assert.equal((await reopened.call("subagent_stop", { id })).contextTokens, 50);
	await reopened.handlers.session_shutdown();
});

test("a failed run reports only its reason, and that it can be resumed", async () => {
	const app = load(0);
	process.env.FAKE_ERROR = "rate limit exceeded\nRetry after 30 seconds";
	let failed: any;
	try {
		failed = await app.execute(
			"subagent_start_and_wait",
			{ subagent_type: "explore", prompt: "Partial answer", description: "d" },
			"codemode/1",
		);
	} finally {
		delete process.env.FAKE_ERROR;
	}
	assert.equal(failed.structuredContent.status, "failed");
	assert.equal(failed.structuredContent.result, "rate limit exceeded\nRetry after 30 seconds");
	assert.match(
		failed.content[0].text,
		/failed\n\nrate limit exceeded\nRetry after 30 seconds\n\nsubagent_message resumes it\.$/,
	);
	await app.handlers.session_shutdown();
});

test("a failed report a reopened session missed keeps its failure reason in its file", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	process.env.FAKE_ERROR = "rate limit exceeded";
	try {
		await first.call("subagent_start", { subagent_type: "explore", prompt: "Partial answer", description: "d" });
	} finally {
		delete process.env.FAKE_ERROR;
	}
	await new Promise((resolve) => setTimeout(resolve, 300)); // Settles while the parent is busy.
	await first.handlers.session_shutdown();
	const [notification] = load(0, {}, entries).messages;
	const file = notification.match(/Report: (\S+\.md) \(1 line\)/)![1];
	assert.equal(fs.readFileSync(file, "utf8"), "rate limit exceeded");
});

test("long results are truncated, pointing to the report file", () => {
	assert.equal(report(finished("all good"), "/s/sa-test-1.md").result, "all good");
	const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
	const result = report(finished(long), "/s/sa-test-1.md").result!;
	assert.ok(result.length < long.length);
	assert.match(result, /The full text is in \/s\/sa-test-1\.md\.\]$/);
});
