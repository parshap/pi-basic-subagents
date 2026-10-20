// End to end against the real pi from devDependencies, with a scripted model (test/faux-provider.ts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const piPackage = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
const piCli = path.join(piPackage, JSON.parse(fs.readFileSync(path.join(piPackage, "package.json"), "utf8")).bin.pi);

test("a real pi gets reports from real pi children: awaited in a script, and by wake", {
	timeout: 120_000,
}, async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-basic-subagents-"));
	fs.mkdirSync(path.join(tmp, "agent"));
	fs.writeFileSync(path.join(tmp, "agent/settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
	const args = [
		...["--mode", "rpc", "--session-dir", path.join(tmp, "sessions")],
		...["-e", path.join(root, "src/index.ts"), "-e", path.join(root, "test/faux-provider.ts")],
		...["--model", "faux/faux-1"],
	];
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: path.join(tmp, "agent"),
		PI_OFFLINE: "1",
		PI_BASIC_SUBAGENTS_DEPTH: undefined, // Run from a subagent, the parent would get no tools.
		PI_SKIP_VERSION_CHECK: "1",
	};
	const pi = spawn(process.execPath, [piCli, ...args], { cwd: tmp, env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	pi.stderr.on("data", (chunk) => (stderr += chunk));

	const assistantTexts: string[] = [];
	const settled = new Promise<void>((resolve, reject) => {
		let buffer = "";
		pi.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			buffer += chunk;
			for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
				const event = JSON.parse(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				if (event.type === "response" && !event.success) reject(new Error(`${event.command}: ${event.error}`));
				if (event.type === "message_end" && event.message.role === "assistant") {
					assistantTexts.push(event.message.content.map((c: any) => c.text ?? "").join(""));
				}
				// The run the second report wakes.
				if (event.type === "agent_settled" && assistantTexts.at(-1)?.startsWith("parent saw")) resolve();
			}
		});
		pi.once("close", (code) => reject(new Error(`pi exited (${code}):\n${stderr}`)));
	});

	try {
		pi.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "go" })}\n`);
		await settled;
		const final = assistantTexts.at(-1) ?? "";
		assert.match(
			final,
			/^parent saw: Script completed[\s\S]*\npong: scripted \| <subagent_notification>[\s\S]*completed[\s\S]*pong: direct/,
		);
	} finally {
		pi.stdin.end();
		pi.kill();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
