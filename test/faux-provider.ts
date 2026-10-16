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

/** The parent starts a subagent, waits for it, and repeats its report; the subagent answers its brief. */
function respond(context: TranscriptContext): AssistantMessage {
	const messages = context.messages as { role: string; content: unknown }[];
	if (getCurrentSystemPrompt(context.messages).includes("You are a subagent")) {
		const brief = text(messages.find((m) => m.role === "user")?.content);
		return fauxAssistantMessage(`pong: ${brief}`);
	}
	const results = messages.filter((m) => m.role === "toolResult");
	if (results.length === 0) {
		return fauxAssistantMessage(
			fauxToolCall("subagent_start", { subagent_type: "explore", description: "echo", prompt: "ping" }),
			{ stopReason: "toolUse" },
		);
	}
	if (results.length === 1) return fauxAssistantMessage(fauxToolCall("subagent_wait", {}), { stopReason: "toolUse" });
	return fauxAssistantMessage(`parent saw: ${text(results.at(-1)?.content)}`);
}

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array(100).fill(respond));
	pi.registerProvider(faux.provider);
}
