import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	lines,
	messageRenderers,
	renderReportMessage,
	runLine,
	shortModel,
	startRenderers,
	waitRenderers,
	widgetLine,
	widgetLines,
} from "../src/render.ts";

initTheme();
// Plain text, so assertions read the layout, not the colors.
const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t } as any;
const ctx = (over: object = {}) => ({ expanded: false, ...over }) as any;
const draw = (c: { render(w: number): string[] } | undefined, width = 80) => c!.render(width).map((l) => l.trimEnd());

const run = { id: "sa-1a2b", type: "explore", description: "Audit auth", status: "running" as const };

test("a Run line shows a running subagent's activity, and a finished one's status", () => {
	assert.equal(runLine({ ...run, state: "bash · 12s" }, theme), "● sa-1a2b explore · Audit auth · bash · 12s");
	assert.equal(runLine({ ...run, status: "failed" }, theme), "✗ sa-1a2b explore · Audit auth · failed");
	assert.equal(runLine({ ...run, type: "", state: "bash · 12s" }, theme), "● sa-1a2b Audit auth · bash · 12s");
});

test("a subagent_start block shows its arguments and a prompt preview, and the full prompt expanded", () => {
	const args = {
		subagent_type: "explore",
		description: "Audit auth",
		model: "openai/gpt-6-luna:low",
		prompt: "Line one\nLine two\nLine three",
	};
	assert.deepEqual(draw(startRenderers.renderCall(args, theme, ctx())), [
		"subagent_start explore · Audit auth · openai/gpt-6-luna:low",
		"Line one",
		"Line two",
	]);
	assert.ok(
		draw(startRenderers.renderCall(args, theme, ctx({ expanded: true }))).some((l) => l.includes("Line three")),
	);
	const long = { ...args, description: "d".repeat(100) };
	assert.ok(
		draw(startRenderers.renderCall(long, theme, ctx({ expanded: true }))).some((l) => l.includes("gpt-6-luna")),
	);
	assert.ok(!draw(startRenderers.renderCall(long, theme, ctx())).some((l) => l.includes("gpt-6-luna")));
	assert.deepEqual(draw(startRenderers.renderResult({ content: [], details: { run } }, {}, theme)), [
		"● sa-1a2b explore · Audit auth · running",
	]);
});

test("a subagent_wait block lists Run lines, and full reports expanded", () => {
	const reports = [{ ...run, status: "completed" as const, result: "All good.", session_path: "/s/child.jsonl" }];
	const result = { content: [], details: { reports } };
	assert.deepEqual(draw(waitRenderers.renderResult(result, {}, theme, ctx())), [
		"✓ sa-1a2b explore · Audit auth · completed",
	]);
	const expanded = draw(waitRenderers.renderResult(result, {}, theme, ctx({ expanded: true })));
	assert.ok(expanded.some((l) => l.includes("/s/child.jsonl")) && expanded.some((l) => l.includes("All good.")));
	const none = { content: [{ type: "text", text: "No subagents are running." }], details: { reports: [] } };
	assert.deepEqual(draw(waitRenderers.renderResult(none, {}, theme, ctx())), ["No subagents are running."]);
});

test("a subagent_message block shows the message, and how it was delivered", () => {
	const args = { id: "sa-1a2b", message: "Also check b.txt" };
	assert.deepEqual(draw(messageRenderers.renderCall(args, theme, ctx())), [
		"subagent_message sa-1a2b",
		"Also check b.txt",
	]);
	assert.deepEqual(draw(messageRenderers.renderResult({ content: [], details: { delivered: "resume" } }, {}, theme)), [
		"delivered as resume",
	]);
});

test("a cut line ends in a muted ellipsis, not the default color", () => {
	const dim = { ...theme, fg: (c: string, t: string) => (c === "muted" ? `\x1b[2m${t}\x1b[22m` : t) };
	assert.ok(
		lines(["x".repeat(20)], dim)
			.render(10)[0]
			.includes("\x1b[2m…"),
	);
});

test("a Report block is one Run line per report until expanded", () => {
	const reports = [{ ...run, status: "completed" as const, result: "Done." }];
	const collapsed = draw(renderReportMessage({ details: { reports } }, { expanded: false, outputPad: 1 }, theme));
	assert.ok(collapsed.some((l) => l.includes("✓ sa-1a2b explore · Audit auth · completed")));
	assert.ok(collapsed.some((l) => l.includes("to expand)")));
	assert.ok(!collapsed.some((l) => l.includes("Done.")));
	assert.ok(
		draw(renderReportMessage({ details: { reports } }, { expanded: true, outputPad: 1 }, theme)).some((l) =>
			l.includes("Done."),
		),
	);
	assert.equal(renderReportMessage({}, { expanded: false, outputPad: 1 }, theme), undefined);
});

test("the widget's tool arguments fill only the free width", () => {
	const r = {
		view: () => run,
		opts: { model: "anthropic/claude-opus-5-5:high" },
		currentTool: { name: "bash", args: { command: "npm  test\n--watch", timeout: 300 } },
		startedAt: Date.now(),
		contextTokens: 0,
	} as any;
	const bare = "● sa-1a2b Audit auth · opus-5-5:high · bash · 0s";
	assert.equal(widgetLine(r, 200, theme), "● sa-1a2b Audit auth · opus-5-5:high · bash npm test --watch · 0s");
	assert.equal(widgetLine(r, bare.length + 5, theme), "● sa-1a2b Audit auth · opus-5-5:high · bash npm… · 0s");
	assert.equal(widgetLine(r, bare.length + 4, theme), "● sa-1a2b Audit auth · opus-5-5:high · bash np… · 0s");
	assert.equal(widgetLine(r, bare.length + 3, theme), bare);
	const tool = (args: unknown) => widgetLine({ ...r, currentTool: { name: "edit", args } }, 200, theme);
	assert.match(tool({ edits: [{ oldText: "a", newText: "b" }], path: "src/x.ts" }), / edit src\/x\.ts a b · /);
	assert.match(tool({ command: "echo \x1b[99C\x07hi" }), / edit echo \\x1b\[99C\\x07hi · /);
	const fit = widgetLine(
		{ ...r, currentTool: { name: "bash", args: { command: "abc", timeout: 300 } } },
		bare.length + 4,
		theme,
	);
	assert.equal(fit, "● sa-1a2b Audit auth · opus-5-5:high · bash abc · 0s");
	const nested = JSON.parse(`${"[".repeat(20_000)}"deep"${"]".repeat(20_000)}`);
	assert.doesNotThrow(() => tool({ nested }));
	const huge = tool({ content: "y".repeat(10_000_000) });
	assert.ok(huge.length <= 200 && huge.includes("yyy…"));
});

test("the widget shows at most 5 lines, preferring running rows, then counts the rest by status", () => {
	const r = (i: number, status: string) =>
		({
			status,
			view: () => ({ ...run, id: `sa-${i}`, status }),
			opts: {},
			startedAt: Date.now(),
			contextTokens: 0,
		}) as any;
	const runs = (statuses: string[]) => statuses.map((s, i) => r(i, s));
	const ids = (ls: string[]) => ls.slice(0, -1).map((l) => l.split(" ")[1]);
	assert.equal(widgetLines(runs(Array(5).fill("completed")), 200, theme).length, 5);
	const capped = widgetLines(
		runs(["completed", "completed", "running", "failed", "running", "running", "running"]),
		200,
		theme,
	);
	assert.deepEqual(ids(capped), ["sa-2", "sa-4", "sa-5", "sa-6"]);
	assert.equal(capped[4], "+3 more · ✓ 2 completed · ✗ 1 failed");
	const many = widgetLines(runs([...Array(19).fill("running"), "failed"]), 80, theme);
	assert.equal(lines(many, theme).render(80)[4], "+16 more · ● 15 running · ✗ 1 failed");
	const mixed = runs(["completed", "running", "running", "completed", "completed", "completed"]);
	assert.deepEqual(ids(widgetLines(mixed, 200, theme)), ["sa-0", "sa-1", "sa-2", "sa-3"]);
});

test("a model's short name drops what rarely tells models apart", () => {
	assert.equal(shortModel("anthropic/claude-opus-5-5:high"), "opus-5-5:high");
	assert.equal(shortModel("amazon-bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0:high"), "opus-4-1:high");
	assert.equal(shortModel("openai/gpt-4o-2024-11-20"), "gpt-4o");
	assert.equal(shortModel("openai/gpt-5.2-chat-latest:low"), "gpt-5.2-chat:low");
	assert.equal(shortModel("huggingface/deepseek-ai/DeepSeek-R1-0528:max"), "DeepSeek-R1-0528:max");
	// Kept where shortening would mangle the name.
	assert.equal(shortModel("amazon-bedrock/deepseek.v3-v1:0:high"), "deepseek.v3:high");
	assert.equal(shortModel("amazon-bedrock/us.deepseek.v3.2"), "deepseek.v3.2");
	assert.equal(shortModel("together/black-forest-labs/flux.2-pro"), "flux.2-pro");
	assert.equal(shortModel("anthropic/claude-3-opus"), "claude-3-opus");
});
