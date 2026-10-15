import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { messageRenderers, renderReportMessage, runLine, startRenderers, waitRenderers } from "../src/render.ts";

initTheme();
// Plain text, so assertions read the layout, not the colors.
const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t } as any;
const ctx = (over: object = {}) => ({ expanded: false, isError: false, state: {}, invalidate() {}, ...over }) as any;
const draw = (c: { render(w: number): string[] } | undefined, width = 80) => c!.render(width).map((l) => l.trimEnd());

const run = { id: "sa-1a2b", type: "explore", description: "Audit auth", status: "running" as const };

test("a Run line shows a running subagent's activity, and a finished one's status", () => {
	assert.equal(runLine({ ...run, state: "bash · 12s" }, theme), "● sa-1a2b explore · Audit auth · bash · 12s");
	assert.equal(runLine({ ...run, status: "failed" }, theme), "✗ sa-1a2b explore · Audit auth · failed");
});

test("a subagent_start block shows its arguments and a prompt preview behind the bar, and the full prompt expanded", () => {
	const args = { subagent_type: "explore", description: "Audit auth", model: "openai/gpt-6-luna:low", prompt: "Line one\nLine two\nLine three" };
	assert.deepEqual(draw(startRenderers.renderCall(args, theme, ctx())), [
		"▌ subagent_start explore · Audit auth · openai/gpt-6-luna:low",
		"▌ Line one",
		"▌ Line two",
	]);
	assert.ok(draw(startRenderers.renderCall(args, theme, ctx({ expanded: true }))).some((l) => l.includes("Line three")));
	assert.equal(draw(startRenderers.renderCall(args, theme, ctx({ isError: true })))[0], "subagent_start explore · Audit auth · openai/gpt-6-luna:low");
	assert.deepEqual(draw(startRenderers.renderResult({ content: [], details: { run } }, {}, theme, ctx())), ["▌ ● sa-1a2b explore · Audit auth · running"]);
});

test("a subagent_wait block lists Run lines, and full reports expanded", () => {
	const reports = [{ ...run, status: "completed" as const, result: "All good.", session_path: "/s/child.jsonl" }];
	const result = { content: [], details: { reports } };
	assert.deepEqual(draw(waitRenderers.renderResult(result, {}, theme, ctx())), ["✓ sa-1a2b explore · Audit auth · completed"]);
	const expanded = draw(waitRenderers.renderResult(result, {}, theme, ctx({ expanded: true })));
	assert.ok(expanded.some((l) => l.includes("/s/child.jsonl")) && expanded.some((l) => l.includes("All good.")));
	const none = { content: [{ type: "text", text: "No subagents are running." }], details: { reports: [] } };
	assert.deepEqual(draw(waitRenderers.renderResult(none, {}, theme, ctx())), ["No subagents are running."]);
});

test("a subagent_message block gets the bar once its result says it resumed the subagent", async () => {
	const c = ctx();
	let redraws = 0;
	c.invalidate = () => redraws++;
	const args = { id: "sa-1a2b", message: "Also check b.txt" };
	assert.deepEqual(draw(messageRenderers.renderCall(args, theme, c)), ["subagent_message sa-1a2b", "Also check b.txt"]);
	assert.deepEqual(draw(messageRenderers.renderResult({ content: [], details: { delivered: "resume" } }, {}, theme, c)), ["▌ delivered as resume"]);
	await Promise.resolve();
	assert.equal(redraws, 1);
	assert.equal(draw(messageRenderers.renderCall(args, theme, c))[0], "▌ subagent_message sa-1a2b");
});

test("a Report block is one Run line per report until expanded", () => {
	const reports = [{ ...run, status: "completed" as const, result: "Done." }];
	const collapsed = draw(renderReportMessage({ details: { reports } }, { expanded: false, outputPad: 1 }, theme));
	assert.ok(collapsed.some((l) => l.includes("✓ sa-1a2b explore · Audit auth · completed")));
	assert.ok(collapsed.some((l) => l.includes("to expand)")));
	assert.ok(!collapsed.some((l) => l.includes("Done.")));
	assert.ok(draw(renderReportMessage({ details: { reports } }, { expanded: true, outputPad: 1 }, theme)).some((l) => l.includes("Done.")));
	assert.equal(renderReportMessage({}, { expanded: false, outputPad: 1 }, theme), undefined);
});
