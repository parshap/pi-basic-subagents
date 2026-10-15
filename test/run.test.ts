import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Run } from "../src/run.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "basic-subagents-run-"));
// Run launches pi the way the current process was started, so point that at the fake.
process.argv[1] = path.join(import.meta.dirname, "fake-pi.mjs");

function fakeRun(env: Record<string, string> = {}, sessionDir = tmp) {
	const log = path.join(tmp, `spawns-${Math.random()}`);
	const run = new Run({ id: "sa-test", sessionId: randomUUID(), type: "explore", description: "test", cwd: tmp, sessionDir, model: undefined, args: () => [], env: { ...process.env, FAKE_LOG: log, ...env }, onSettle() {} });
	const spawns = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
	return { run, spawns };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a run completes with its final message", async () => {
	const { run } = fakeRun();
	await run.prompt("hello");
	await run.done;
	assert.equal(run.status, "completed");
	assert.equal(run.result, "hello");
	assert.match(run.sessionPath ?? "", new RegExp(`_${run.sessionId}\\.jsonl$`));
});

test("a message to a running subagent steers it", async () => {
	const { run } = fakeRun({ FAKE_RUN_MS: "300" });
	await run.prompt("hello");
	assert.equal(await run.send("more", () => {}), "steer");
	await run.done;
	assert.equal(run.result, "hello+more");
});

test("a steer pi accepts as the run settles still runs", async () => {
	const { run, spawns } = fakeRun({ FAKE_STEER_BEFORE_SETTLED: "1" });
	await run.prompt("slow hello");
	assert.equal(await run.send("more", () => {}), "steer");
	await run.done;
	assert.deepEqual([run.status, run.result], ["completed", "more"]);
	assert.equal(spawns().length, 1);
});

test("concurrent messages to a finished subagent resume it once", async () => {
	const { run, spawns } = fakeRun({ FAKE_RUN_MS: "300" });
	await run.prompt("hello");
	await run.done;
	assert.deepEqual(await Promise.all([run.send("a", () => {}), run.send("b", () => {})]), ["resume", "steer"]);
	await run.done;
	assert.equal(run.result, "a+b");
	assert.equal(spawns().length, 2);
});

test("a startup failure settles the run as failed", async () => {
	const { run } = fakeRun({}, "/dev/null/sessions");
	await assert.rejects(run.prompt("hello"));
	assert.equal(run.status, "failed");
	await run.done;
});

test("stop kills a child that ignores stdin EOF and SIGTERM", async () => {
	const { run, spawns } = fakeRun({ FAKE_STUBBORN: "1", FAKE_RUN_MS: "60000" });
	await run.prompt("hello");
	await run.stop();
	assert.equal(run.status, "stopped");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(alive(Number(spawns()[0])), false);
});

test("stop works while pi hasn't accepted the prompt yet", async () => {
	const { run } = fakeRun({ FAKE_PROMPT_HANGS: "1" });
	const prompt = run.prompt("hello");
	await new Promise((r) => setTimeout(r, 200));
	await run.stop();
	assert.equal(run.status, "stopped");
	await prompt;
});

test("a resume racing a stop isn't stopped by it, and the stopped launch's pending start still resolves", async () => {
	const { run } = fakeRun({ FAKE_PROMPT_HANGS: "1" });
	const first = run.prompt("hello");
	await new Promise((r) => setTimeout(r, 200));
	const stopping = run.stop();
	await run.done;
	const resumed = run.send("next", () => {});
	await stopping;
	await first;
	assert.equal(run.status, "running");
	await run.stop();
	assert.equal(await resumed, "resume");
});
