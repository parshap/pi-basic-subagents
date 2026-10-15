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
	const ui = { notify() {}, setWidget() {} };
	const sessionManager = { getEntries: () => entries, getSessionId: () => "parent", getSessionFile: () => sessionFile };
	handlers.session_start({}, { ui, cwd: tmp, isIdle: () => idle, isProjectTrusted: () => true, sessionManager });
	delete process.env.PI_BASIC_SUBAGENTS_DEPTH;
	const ctx = { cwd: tmp, isProjectTrusted: () => true, sessionManager };
	const execute = (name: string, params: unknown) => tools.get(name).execute("call", params, undefined, undefined, ctx);
	const call = async (name: string, params: unknown) => (await execute(name, params)).structuredContent;
	const callText = async (name: string, params: unknown) => (await execute(name, params)).content[0].text;
	const setIdle = (value: boolean) => (idle = value);
	return { tools: [...tools.keys()], handlers, messages, call, callText, setIdle };
}

test("main session gets the tools", () => {
	assert.deepEqual(load(0).tools, ["subagent_start", "subagent_wait", "subagent_message", "subagent_stop"]);
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

test("a report returned by subagent_wait isn't also sent as a message", async () => {
	const { call, handlers, messages } = load(0);
	const { id } = await call("subagent_start", { subagent_type: "explore", prompt: "hello", description: "d" });
	const [r] = await call("subagent_wait", { ids: [id] });
	assert.equal(r.result, "hello");
	handlers.agent_settled();
	await new Promise((resolve) => setTimeout(resolve, 50));
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

test("a reopened session knows earlier runs: interrupted ones stopped and resumable, finished ones point to their transcript", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const start = { subagent_type: "explore", description: "d" };
	const { id: done } = await first.call("subagent_start", { ...start, prompt: "finished" });
	await first.call("subagent_wait", { ids: [done] });
	const { id: cut } = await first.call("subagent_start", { ...start, prompt: "slow, cut short" });
	await first.handlers.session_shutdown();

	const second = load(0, {}, entries);
	assert.deepEqual(second.messages, []);
	assert.equal(
		await second.callText("subagent_wait", {}),
		`No subagents are running. Earlier ones: ${done} completed, ${cut} stopped. Pass their ids for reports.`,
	);
	const [a, b] = await second.call("subagent_wait", { ids: [done, cut] });
	assert.equal(a.status, "completed");
	assert.match(a.result, /last message in the transcript/);
	assert.match(b.result, /Stopped when the parent session ended/);
	assert.match(b.session_path, new RegExp(`_${entries.find((e) => e.data.id === cut).data.sessionId}\\.jsonl$`));
	assert.equal(
		await second.call("subagent_message", { id: cut, message: "go on" }).then((r: any) => r.delivered),
		"resume",
	);
	const [c] = await second.call("subagent_wait", { ids: [cut] });
	assert.equal(c.result, "go on");
});

test("a fork doesn't take over its original's subagents", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id } = await first.call("subagent_start", { subagent_type: "explore", prompt: "finished", description: "d" });
	await first.call("subagent_wait", { ids: [id] });
	await first.handlers.session_shutdown();
	const fork = load(0, {}, entries, path.join(tmp, "fork.jsonl"));
	await assert.rejects(fork.call("subagent_wait", { ids: [id] }), /Unknown subagent id/);
	await assert.rejects(fork.call("subagent_message", { id, message: "more" }), /Unknown subagent id/);
});

test("a resumed run cut short by shutdown reopens as stopped", async () => {
	const entries: any[] = [];
	const first = load(0, {}, entries);
	const { id } = await first.call("subagent_start", { subagent_type: "explore", prompt: "finished", description: "d" });
	await first.call("subagent_wait", { ids: [id] });
	await first.call("subagent_message", { id, message: "slow more" });
	await first.handlers.session_shutdown();
	const [r] = await load(0, {}, entries).call("subagent_wait", { ids: [id] });
	assert.equal(r.status, "stopped");
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
	const { call } = load(0, {}, entries);
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
	assert.equal(await load(0, {}, entries).callText("subagent_wait", {}), "No subagents are running.");
});

test("a resume that fails to start fails the message, and its report isn't sent again", async () => {
	const { call, handlers, messages, setIdle } = load(0);
	const { id } = await call("subagent_start", { subagent_type: "explore", prompt: "first", description: "d" });
	await call("subagent_wait", { ids: [id] });
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
