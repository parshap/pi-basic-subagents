// Stand-in for `pi --mode rpc` in lifecycle tests: each run replies with its prompt and steers joined by "+".
// A run takes FAKE_RUN_MS, or a minute when its prompt starts with "slow".
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
// A minimal session file like pi's, for code that reads finished transcripts.
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionFile = join(arg("--session-dir"), `2026_${arg("--session-id")}.jsonl`);
if (!existsSync(sessionFile)) {
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: arg("--session-id"), timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
	);
}
let entryId = 0;
if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, `${process.pid}\n`);
if (env.FAKE_STUBBORN) {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
}

const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
let timer;
let messages = [];
const queue = [];

/** End the run; `beforeSettled` runs after pi marks it idle, `settledDelay` ms before it reports agent_settled. */
function settle(aborted, beforeSettled = () => {}, settledDelay = 0) {
	clearTimeout(timer);
	timer = undefined;
	const message = {
		role: "assistant",
		stopReason: aborted ? "aborted" : "stop",
		content: [{ type: "text", text: messages.join("+") }],
	};
	const id = `${process.pid}-${++entryId}`;
	appendFileSync(
		sessionFile,
		`${JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message })}\n`,
	);
	out({ type: "message_end", message });
	messages = [];
	beforeSettled();
	if (settledDelay) setTimeout(() => out({ type: "agent_settled", aborted }), settledDelay);
	else out({ type: "agent_settled", aborted });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
		const cmd = JSON.parse(buffer.slice(0, nl));
		buffer = buffer.slice(nl + 1);
		const respond = (data) => out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
		if (cmd.type === "get_state") respond({ sessionFile });
		else if (cmd.type === "prompt" && env.FAKE_PROMPT_HANGS) continue;
		else if (cmd.type === "prompt") {
			messages.push(cmd.message);
			if (timer) respond({ disposition: "queued" });
			else {
				const ms = cmd.message.startsWith("slow") ? 60_000 : Number(env.FAKE_RUN_MS ?? 100);
				timer = setTimeout(() => settle(false), ms);
				respond({ disposition: "started" });
			}
		} else if (cmd.type === "steer") {
			if (env.FAKE_STEER_AFTER_SETTLE) settle(false); // The run finishes just before the steer arrives.
			if (env.FAKE_STEER_BEFORE_SETTLED) {
				// The run finishes as the steer arrives, and agent_settled handlers take a while: pi accepts the
				// steer into a queue no run will read.
				settle(
					false,
					() => {
						queue.push(cmd.message);
						respond({ disposition: "queued" });
					},
					100,
				);
				continue;
			}
			messages.push(cmd.message);
			respond({ disposition: "queued" });
		} else if (cmd.type === "clear_queue") {
			respond({ steering: queue.splice(0), followUp: [] });
		} else if (cmd.type === "abort") {
			if (timer) settle(true);
			respond();
		}
	}
});
