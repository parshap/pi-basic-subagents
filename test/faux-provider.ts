// A scripted model for test/pi.test.ts, loaded into the real pi with -e (and inherited by its subagents).
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const text = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((c) => (c.type === "text" ? c.text : "")).join("")
			: "";

/**
 * The parent awaits a subagent in a codemode script, which also starts and stops one in the background,
 * then starts another directly and ends its turn, then
 * repeats both reports once the second wakes it. A subagent answers its brief.
 */
function respond(context: TranscriptContext): AssistantMessage {
	const messages = context.messages as { role: string; content: unknown }[];
	if (getCurrentSystemPrompt(context.messages).includes("You are a subagent")) {
		const brief = text(messages.find((m) => m.role === "user")?.content);
		return fauxAssistantMessage(`pong: ${brief}`);
	}
	const results = messages.filter((m) => m.role === "toolResult");
	const start = { subagent_type: "explore", description: "echo" };
	if (results.length === 0) {
		const code = [
			`const r = await tools.subagent_start_and_wait(${JSON.stringify({ ...start, prompt: "scripted" })});`,
			`const { id } = await tools.subagent_start(${JSON.stringify({ ...start, prompt: "background" })});`,
			"const { status } = await tools.subagent_stop({ id });",
			'return r.result + " " + status;',
		].join("\n");
		return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
	}
	if (results.length === 1) {
		return fauxAssistantMessage(fauxToolCall("subagent_start", { ...start, prompt: "direct" }), {
			stopReason: "toolUse",
		});
	}
	if (!text(messages.at(-1)?.content).startsWith("Subagent reports arrived")) return fauxAssistantMessage("started");
	return fauxAssistantMessage(`parent saw: ${text(results[0].content)} | ${text(messages.at(-2)?.content)}`);
}

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array(100).fill(respond));
	pi.registerProvider(faux.provider);
}
