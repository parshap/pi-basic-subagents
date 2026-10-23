import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	lines,
	messageRenderers,
	renderReportMessage,
	runLine,
	shortModel,
	startRenderers,
	stopRenderers,
	widgetLine,
	widgetLines,
} from "../src/render.ts";
import type { RunView } from "../src/run.ts";

initTheme();
setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } })); // As pi binds it.
// Plain text, so assertions read the layout, not the colors.
const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t } as any;
const ctx = (over: object = {}) => ({ expanded: false, ...over }) as any;
const draw = (c: { render(w: number): string[] } | undefined, width = 80) => c!.render(width).map((l) => l.trimEnd());

const run = { id: "sa-1a2b", description: "Audit auth", status: "running" as const };

test("tool headers and previews keep model text on one line, without terminal controls", () => {
	const args = { description: "Audit\nforged row\x1b[2J", model: "m\x07", prompt: "\x1b[2Jfirst\nsecond" };
	assert.deepEqual(draw(startRenderers.renderCall(args, theme, ctx())), [
		"subagent_start Audit forged row · m\\x07",
		"first",
		"second",
	]);
});

test("a Run line keeps text from the model or child on one line, without terminal controls", () => {
	const line = runLine(
		{ ...run, description: "Two\nlines \x1b[31mred", model: "x/m\x07", contextTokens: 3_456_789 },
		theme,
	);
	assert.equal(line, "● sa-1a2b Two lines red · m\\x07 · 3.5M ctx · running");
});

test("a Run line shows a running subagent's activity, and a finished one's status", () => {
	assert.equal(runLine({ ...run, state: "bash", elapsedMs: 12_000 }, theme), "● sa-1a2b Audit auth · 12s · bash");
	assert.equal(runLine({ ...run, status: "failed" }, theme), "✗ sa-1a2b Audit auth · failed");
});

test("a subagent_start block shows its arguments and a prompt preview, and the full prompt expanded", () => {
	const args = {
		description: "Audit auth",
		model: "openai/gpt-6-luna:low",
		prompt: "Line one\nLine two\nLine three",
	};
	assert.deepEqual(draw(startRenderers.renderCall(args, theme, ctx())), [
		"subagent_start Audit auth · openai/gpt-6-luna:low",
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
});

test("start results only acknowledge the id", () => {
	for (const expanded of [false, true]) {
		assert.deepEqual(
			draw(startRenderers.renderResult({ content: [], details: { id: run.id } }, {}, theme, ctx({ expanded }))),
			["Started sa-1a2b.", ...(expanded ? [] : ["(ctrl+o to expand)"])],
		);
	}
});

test("a subagent_message block shows the message, and how it was delivered", () => {
	const args = { id: "sa-1a2b", message: "Also check b.txt\nAnd c.txt" };
	assert.deepEqual(draw(messageRenderers.renderCall(args, theme, ctx())), [
		"subagent_message sa-1a2b",
		"Also check b.txt",
	]);
	assert.deepEqual(draw(messageRenderers.renderResult({ content: [], details: { delivered: "resume" } }, {}, theme)), [
		"subagent resumed with message",
		"(ctrl+o to expand)",
	]);
	assert.ok(
		draw(messageRenderers.renderCall(args, theme, ctx({ expanded: true }))).some((l) => l.includes("And c.txt")),
	);
});

test("a cut line ends in a muted ellipsis, not the default color", () => {
	const dim = { ...theme, fg: (c: string, t: string) => (c === "muted" ? `\x1b[2m${t}\x1b[22m` : t) };
	assert.ok(
		lines(["x".repeat(20)], dim)
			.render(10)[0]
			.includes("\x1b[2m…"),
	);
});

test("a Report block previews each result until expanded", () => {
	const reports = [{ ...run, status: "completed" as const, result: "Done.\nMore details." }];
	const collapsed = draw(renderReportMessage({ details: { reports } }, { expanded: false, outputPad: 1 }, theme));
	assert.ok(collapsed.some((l) => l.includes("✓ sa-1a2b Audit auth · completed")));
	assert.ok(collapsed.some((l) => l.includes("to expand)")));
	assert.ok(collapsed.some((l) => l.includes("Done.")));
	assert.equal(collapsed.filter((l) => l.includes("to expand)")).length, 1);
	assert.ok(!collapsed.some((l) => l.includes("More details.")));
	assert.ok(
		draw(renderReportMessage({ details: { reports } }, { expanded: true, outputPad: 1 }, theme)).some((l) =>
			l.includes("Done."),
		),
	);
	assert.equal(renderReportMessage({}, { expanded: false, outputPad: 1 }, theme), undefined);
});

test("the widget ends with the current tool, its time once slow, and its arguments' first lines", () => {
	const view = { ...run, model: "anthropic/claude-opus-5-5:high", elapsedMs: 0 };
	const now = Date.now();
	const tool = (args: unknown, startedAt = now, name = "bash") =>
		widgetLine({ status: "running", view: () => view, currentTool: { name, args, startedAt } } as any, theme);
	assert.equal(
		widgetLine({ status: "running", view: () => ({ ...view, contextTokens: 12_100 }) } as any, theme),
		"● sa-1a2b Audit auth · opus-5-5:high · 12.1k ctx · 0s · thinking",
	);
	assert.equal(
		tool({ command: "npm  test --watch", timeout: 300 }),
		"● sa-1a2b Audit auth · opus-5-5:high · 0s · bash npm test --watch",
	);
	assert.match(tool({ command: "x" }, now - 72_000), / · bash 1m12s x$/);
	assert.match(
		tool({ command: "\n  umask 077; python3 - <<'PY'\nimport json\nPY\n" }),
		/ · bash umask 077; python3 - <<'PY'…$/,
	);
	assert.match(tool({ command: "y".repeat(100) }), / · bash y{50}…$/);
	assert.match(tool({ command: "abc\n" }), / · bash abc$/);
	assert.match(tool({ a: "a".repeat(25), b: "b".repeat(25) }), / · bash a{25} b{24}…$/);
	assert.match(tool({ path: "p".repeat(50) }), / · bash p{50}$/);
	assert.match(
		tool({ edits: [{ oldText: "a", newText: "b" }], path: "src/x.ts" }, now, "edit"),
		/ edit src\/x\.ts a b$/,
	);
	assert.match(tool({ command: "echo \x1b[99C\x07hi" }), / bash echo \\x1b\[99C\\x07hi$/);
	const nested = JSON.parse(`${"[".repeat(20_000)}"deep"${"]".repeat(20_000)}`);
	assert.doesNotThrow(() => tool({ nested }));
	assert.ok(tool({ content: "y".repeat(10_000_000) }).endsWith("yyy…"));
});

test("the widget shows at most 5 lines, preferring running rows, then counts the rest by status", () => {
	const r = (i: number, status: string) =>
		({
			status,
			view: () => ({ ...run, id: `sa-${i}`, status, model: "openai/gpt-6-luna:low", elapsedMs: 12_000 }),
		}) as any;
	const runs = (statuses: string[]) => statuses.map((s, i) => r(i, s));
	const ids = (ls: string[]) => ls.slice(0, -1).map((l) => l.split(" ")[1]);
	assert.equal(widgetLines(runs(Array(5).fill("completed")), theme).length, 5);
	const capped = widgetLines(
		runs(["completed", "completed", "running", "failed", "running", "running", "running"]),
		theme,
	);
	assert.deepEqual(ids(capped), ["sa-2", "sa-4", "sa-5", "sa-6"]);
	assert.equal(capped[4], "+3 more · ✓ 2 completed · ✗ 1 failed");
	const many = widgetLines(runs([...Array(19).fill("running"), "failed"]), theme);
	assert.equal(lines(many, theme).render(80)[4], "+16 more · ● 15 running · ✗ 1 failed");
	const mixed = runs(["completed", "running", "running", "completed", "completed", "completed"]);
	assert.deepEqual(ids(widgetLines(mixed, theme)), ["sa-0", "sa-1", "sa-2", "sa-3"]);
});

test("the widget and finished summaries share session metrics", () => {
	for (const status of ["running", "completed", "failed", "stopped"] as const) {
		const view: RunView = {
			...run,
			status,
			state: "bash",
			model: "anthropic/claude-opus-5-5:high",
			contextTokens: 132_300,
			elapsedMs: 72_000,
		};
		const expected = `opus-5-5:high · 132.3k ctx · 1m12s · ${status === "running" ? "bash" : status}`;
		const line = runLine(view, theme);
		assert.ok(line.endsWith(expected));
		const result = { content: [], details: { run: view } };
		for (const renderer of [stopRenderers])
			assert.deepEqual(draw(renderer.renderResult(result, {}, theme), 200), [line, "(ctrl+o to expand)"]);
		if (status !== "running") {
			assert.deepEqual(
				draw(renderReportMessage({ details: { reports: [view] } }, { expanded: false, outputPad: 0 }, theme), 200),
				["", line, "(ctrl+o to expand)", ""],
			);
		}
		const widget = { status, view: () => view, currentTool: { name: "bash", args: {}, startedAt: Date.now() } } as any;
		assert.equal(widgetLine(widget, theme), runLine(view, theme));
	}
	assert.equal(runLine({ ...run, state: "thinking", elapsedMs: 0 }, theme), "● sa-1a2b Audit auth · 0s · thinking");
});

test("expanded stop results and reports show full model and a transcript link", () => {
	const report = {
		...run,
		status: "completed" as const,
		model: "anthropic/claude-opus-5-5:high",
		elapsedMs: 72_000,
		contextTokens: 103_602,
		session_path: "/s/child.jsonl",
	};
	const result = { content: [], details: { run: report } };
	const expanded = ctx({ expanded: true });
	const surfaces = [
		stopRenderers.renderResult(result, {}, theme, expanded),
		renderReportMessage({ details: { reports: [report] } }, { expanded: true, outputPad: 0 }, theme),
	];
	for (const surface of surfaces) {
		const text = draw(surface, 200).join("\n");
		assert.ok(text.includes("model: anthropic/claude-opus-5-5:high"));
		assert.ok(text.includes("/s/child.jsonl"));
		assert.ok(text.includes("file:///s/child.jsonl"));
	}
});

test("old snapshots omit unavailable metrics, and results without details keep their text", () => {
	const old = { ...run, status: "completed" as const };
	const result = { content: [], details: { run: old } };
	const expected = ["✓ sa-1a2b Audit auth · completed"];
	for (const renderer of [stopRenderers]) {
		assert.deepEqual(draw(renderer.renderResult(result, {}, theme, ctx({ expanded: true }))), expected);
		assert.deepEqual(draw(renderer.renderResult({ content: [{ type: "text", text: "Old result." }] }, {}, theme)), [
			"Old result.",
			"(ctrl+o to expand)",
		]);
	}
	assert.deepEqual(
		draw(renderReportMessage({ details: { reports: [old] } }, { expanded: true, outputPad: 0 }, theme)),
		["", ...expected, ""],
	);
	assert.equal(widgetLine({ view: () => old } as any, theme), "✓ sa-1a2b Audit auth · completed");
});

test("unstructured errors and legacy text expand in full with one collapsed hint", () => {
	const text = `Failed: ${"long error ".repeat(30)}\x1b[2J\x07`;
	const result = { content: [{ type: "text", text }] };
	for (const renderer of [startRenderers, stopRenderers, messageRenderers]) {
		const collapsed = draw(renderer.renderResult(result, {}, theme, ctx()), 60);
		assert.ok(collapsed.every((l) => visibleWidth(l) <= 60));
		assert.equal(collapsed.filter((l) => l.includes("to expand)")).length, 1);
		const expanded = draw(renderer.renderResult(result, {}, theme, ctx({ expanded: true })), 60);
		assert.ok(expanded.every((l) => visibleWidth(l) <= 60));
		assert.ok(!expanded.some((l) => l.includes("to expand)")));
		assert.equal(
			expanded.join("").replace(/\s/g, ""),
			text.replace("\x1b[2J", "").replace("\x07", "\\x07").replace(/\s/g, ""),
		);
		assert.deepEqual(
			draw(renderer.renderResult({ content: [{ type: "text", text: "Short error." }] }, {}, theme, ctx())),
			["Short error.", "(ctrl+o to expand)"],
		);
	}
});

test("narrow views fit the width while expanded metadata wraps without losing values", () => {
	const view = {
		...run,
		model: "anthropic/claude-opus-5-5:high",
		elapsedMs: 72_000,
		contextTokens: 103_602,
	};
	const tool = { name: "bash", args: { command: "漢字".repeat(100) }, startedAt: Date.now() };
	const widget = { status: "running", view: () => view, currentTool: tool } as any;
	for (const width of [1, 10, 30]) {
		const collapsed = lines([widgetLine(widget, theme), runLine(view, theme)], theme).render(width);
		assert.ok(collapsed.every((line) => visibleWidth(line) <= width));
		assert.ok(collapsed.every((line) => stripTerminalSequences(line).endsWith("…")));
	}
	const expanded = draw(
		stopRenderers.renderResult({ content: [], details: { run: view } }, {}, theme, ctx({ expanded: true })),
		20,
	);
	assert.ok(expanded.every((line) => visibleWidth(line) <= 20));
	const text = expanded.map(stripTerminalSequences).join("").replace(/\s/g, "");
	assert.ok(text.includes(runLine(view, theme).replace(/\s/g, "")));
	assert.ok(text.includes(`model:${view.model}`));
});

test("collapsed reports preview the first nonempty result line, muted and cut to width", () => {
	const reports = [
		{ ...run, status: "completed" as const, result: "\n  \nFirst result line.\n\nSecond result line." },
		{ ...run, id: "sa-other", status: "failed" as const, result: "\nOther result." },
	];
	const styled = { ...theme, fg: (c: string, t: string) => (c === "muted" ? `\x1b[2m${t}\x1b[22m` : t) };
	const preview = draw(
		renderReportMessage({ details: { reports: reports } }, { expanded: false, outputPad: 0 }, styled),
		200,
	);
	assert.ok(preview.includes("\x1b[2mFirst result line.\x1b[22m"));
	assert.ok(preview.includes("\x1b[2mOther result.\x1b[22m"));
	assert.ok(!preview.some((l) => l.includes("Second result line.")));
	assert.equal(preview.filter((l) => l.includes("to expand)")).length, 1);
	const narrow = draw(
		renderReportMessage({ details: { reports: reports } }, { expanded: false, outputPad: 0 }, theme),
		10,
	);
	assert.equal(stripTerminalSequences(narrow[2]), "First res…");
	assert.ok(narrow.every((l) => visibleWidth(l) <= 10));
	const expanded = draw(
		renderReportMessage({ details: { reports: reports } }, { expanded: true, outputPad: 0 }, theme),
		200,
	).join("\n");
	assert.ok(expanded.includes("First result line.") && expanded.includes("Second result line."));
});

test("result previews sanitize controls before selecting the first nonempty line", () => {
	const report = {
		...run,
		status: "completed" as const,
		result: "\x1b[31m\x1b[0m\r\n\rPreview\x07\x08\x9b\x1b[2J\rSecond line.",
	};
	const text = draw(
		renderReportMessage({ details: { reports: [report] } }, { expanded: false, outputPad: 0 }, theme),
		200,
	).join("\n");
	assert.ok(text.includes("Preview\\x07\\x08\\x9b"));
	assert.ok(!text.includes("Second line."));
	assert.ok(!["\x1b", "\x07", "\x08", "\x9b", "\r"].some((control) => text.includes(control)));
});

test("failure summaries use the error, sanitize terminal controls, and keep the full error independently", () => {
	const error =
		"\r\n  \r\n\x1b[31mrate limited\x1b[0m\x1b[2J\r\nretry after 60s\x07\x1b]8;;https://evil.test\x07link\x1b]8;;\x07";
	const view = { ...run, status: "failed" as const, error };
	const colored = { ...theme, fg: (c: string, t: string) => `[${c}]${t}[/${c}]` };
	assert.ok(runLine(view, colored).includes("[error]failed: rate limited[/error]"));
	assert.equal(runLine(view, theme), "✗ sa-1a2b Audit auth · failed: rate limited");
	assert.equal(widgetLine({ view: () => view } as any, theme), "✗ sa-1a2b Audit auth · failed: rate limited");
	assert.ok(!runLine({ ...run, error, status: "completed" }, theme).includes("rate limited"));
	const surfaces = [
		stopRenderers.renderResult({ content: [], details: { run: view } }, {}, theme, ctx({ expanded: true })),
		renderReportMessage({ details: { reports: [view] } }, { expanded: true, outputPad: 0 }, theme),
	];
	for (const surface of surfaces) {
		const text = draw(surface, 200).join("\n");
		assert.ok(text.includes("retry after 60s\\x07link"));
		assert.ok(!text.includes("https://evil.test") && !text.includes("\x1b") && !text.includes("\x07"));
	}
	const longError = "x".repeat(300);
	const result = { content: [], details: { run: { ...view, error: longError } } };
	const collapsed = draw(stopRenderers.renderResult(result, {}, theme), 60);
	assert.equal(collapsed.length, 2);
	assert.ok(stripTerminalSequences(collapsed[0]).endsWith("…"));
	assert.equal(collapsed[1], "(ctrl+o to expand)");
	const expanded = draw(stopRenderers.renderResult(result, {}, theme, ctx({ expanded: true })), 60);
	assert.ok(expanded.every((l) => visibleWidth(l) <= 60));
	assert.ok(expanded.join("").includes(longError));
});

test("an error-only report doesn't repeat its failure as a result preview or body", () => {
	const report = { ...run, status: "failed" as const, error: "rate limited", result: "rate limited" };
	const collapsed = draw(
		renderReportMessage({ details: { reports: [report] } }, { expanded: false, outputPad: 0 }, theme),
		200,
	).join("\n");
	assert.equal(collapsed.split("rate limited").length - 1, 1);
	const expanded = draw(
		renderReportMessage({ details: { reports: [report] } }, { expanded: true, outputPad: 0 }, theme),
		200,
	).join("\n");
	assert.equal(expanded.split("rate limited").length - 1, 2); // Summary and full error, not a third result copy.
});

test("collapsed blocks always show one expansion hint and expanded blocks show none", () => {
	const bare = { ...run, status: "completed" as const };
	const reports = [
		{ ...bare, result: "All good." },
		{ ...bare, id: "sa-other" },
	];
	for (const expanded of [false, true]) {
		const surfaces = [
			startRenderers.renderResult({ content: [], details: { id: run.id } }, {}, theme, ctx({ expanded })),
			...(["steer", "resume"] as const).map((delivered) =>
				messageRenderers.renderResult({ content: [], details: { delivered } }, {}, theme, ctx({ expanded })),
			),
			stopRenderers.renderResult({ content: [], details: { run: bare } }, {}, theme, ctx({ expanded })),
			renderReportMessage({ details: { reports } }, { expanded, outputPad: 0 }, theme),
		];
		for (const surface of surfaces) {
			assert.equal(draw(surface, 200).filter((l) => l.includes("to expand)")).length, expanded ? 0 : 1);
			for (const width of [1, 10, 30]) assert.ok(draw(surface, width).every((l) => visibleWidth(l) <= width));
		}
	}
});

test("short model names drop paths, claude prefixes, and snapshots while keeping thinking", () => {
	assert.equal(shortModel("anthropic/claude-opus-5-5:high"), "opus-5-5:high");
	assert.equal(shortModel("anthropic/claude-sonnet-4-20250514:high"), "sonnet-4:high");
	assert.equal(shortModel("claude-sonnet-4-20250514"), "sonnet-4");
	assert.equal(shortModel("openai/gpt-4o-2024-11-20"), "gpt-4o");
	assert.equal(shortModel("openai/gpt-4o-2024-11-20:off"), "gpt-4o:off");
	assert.equal(shortModel("openai/gpt-5.2-chat-latest:low"), "gpt-5.2-chat:low");
	assert.equal(shortModel("huggingface/deepseek-ai/DeepSeek-R1-0528:max"), "DeepSeek-R1-0528:max");
	assert.equal(
		shortModel("amazon-bedrock/us.anthropic.claude-opus-4-1-v1:0:high"),
		"us.anthropic.claude-opus-4-1-v1:0:high",
	);
	assert.equal(shortModel("amazon-bedrock/deepseek.v3-v1:0:high"), "deepseek.v3-v1:0:high");
	assert.equal(shortModel("anthropic/claude-3-opus"), "3-opus");
});
