// The shapes in docs/ux.md. Everything here draws from structured data, never from model-facing text.
import { pathToFileURL } from "node:url";
import { type ExtensionContext, getMarkdownTheme, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	hyperlink,
	Markdown,
	Spacer,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Run, type RunView, STATUSES, type Status } from "./run.ts";

/** A finished subagent's report. */
export interface Report extends RunView {
	result?: string;
	session_path?: string;
}

const STATUS: Record<Status, { glyph: string; color: "accent" | "success" | "error" | "warning" }> = {
	running: { glyph: "●", color: "accent" },
	completed: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	stopped: { glyph: "■", color: "warning" },
};

/** The Run line: `<glyph> <id> <description> · <state>`. */
export function runLine(v: RunView, theme: Theme): string {
	const { glyph, color } = STATUS[v.status];
	const sep = theme.fg("muted", " · ");
	const reason = v.status === "failed" ? firstLines(safeText(v.error ?? ""), 1)[0]?.trim() : undefined;
	const state =
		v.status === "running" && v.state
			? theme.fg("muted", oneLine(v.state))
			: theme.fg(color, reason ? `failed: ${reason}` : v.status);
	const metadata = [
		...(v.model ? [oneLine(shortModel(v.model))] : []),
		...(v.contextTokens ? [`${k(v.contextTokens)} ctx`] : []),
		...(v.elapsedMs !== undefined ? [elapsed(v.elapsedMs)] : []),
	];
	return [
		`${theme.fg(color, glyph)} ${theme.fg("text", theme.bold(v.id))} ${theme.fg("text", oneLine(v.description))}${sep}${state}`,
		...metadata.map((text) => theme.fg("muted", text)),
	].join(sep);
}

/** Lines that are cut to the width, never wrapped. */
export function lines(texts: string[], theme: Theme): Component {
	// Styled: truncateToWidth resets the color before the ellipsis.
	const ellipsis = theme.fg("muted", "…");
	return { render: (width) => texts.map((t) => truncateToWidth(t, width, ellipsis)), invalidate() {} };
}

/** Lines wrapped to the width, for expanded views that show everything. */
function wrapped(text: string): Component {
	return { render: (width) => wrapTextWithAnsi(text, width), invalidate() {} };
}

/** A tool block's header: one cut line collapsed, wrapped in full expanded. */
const header = (text: string, theme: Theme, ctx: Ctx) => (ctx.expanded ? wrapped(text) : lines([text], theme));

/** Body text: `toolOutput` in tool blocks and `customMessageText` in report blocks, like pi's own. */
type BodyColor = "toolOutput" | "customMessageText";

const markdown = (text: string, theme: Theme, color: BodyColor) =>
	new Markdown(text, 0, 0, getMarkdownTheme(), { color: (t) => theme.fg(color, t) });

const title = (name: string, theme: Theme) => theme.fg("toolTitle", theme.bold(name));
const firstLines = (text: string, n: number) =>
	text
		.split("\n")
		.filter((l) => l.trim())
		.slice(0, n);

// keyHint()'s styling, but with the theme renderers are given, not pi's global one.
const expandHint = (theme: Theme) =>
	theme.fg("muted", "(") + theme.fg("dim", keyText("app.tools.expand")) + theme.fg("muted", " to expand)");

/** Untrusted plain text must not drive the terminal or override the theme. */
const safeText = (text: string) =>
	stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\p{Cc}/gu, (c) => (c === "\n" ? c : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`));

/** For text from the model or the child that must stay on one line. */
const oneLine = (text: string) => safeText(text).replace(/\n/g, " ");

const collapsed = (texts: string[], theme: Theme) => lines([...texts, expandHint(theme)], theme);

/** A report's full view: its summary, model, transcript link, error, and result. */
function reportSection(r: Report, theme: Theme, color: BodyColor = "toolOutput"): Component {
	const parts: Component[] = [wrapped(runLine(r, theme))];
	if (r.model) parts.push(wrapped(theme.fg("muted", `model: ${oneLine(r.model)}`)));
	if (r.session_path)
		parts.push(wrapped(theme.fg("muted", hyperlink(r.session_path, pathToFileURL(r.session_path).href))));
	if (r.error) parts.push(new Spacer(1), wrapped(theme.fg(color, safeText(r.error))));
	if (r.result && r.result !== r.error) parts.push(new Spacer(1), markdown(r.result, theme, color));
	return new VStack(parts);
}

function reportList(reports: Report[], expanded: boolean, theme: Theme): Component {
	if (!expanded) {
		const texts = reports.flatMap((r) => [
			runLine(r, theme),
			...firstLines(safeText(r.result !== r.error ? (r.result ?? "") : ""), 1).map((text) => theme.fg("muted", text)),
		]);
		return collapsed(texts, theme);
	}
	const sections = reports.map((r) => reportSection(r, theme, "customMessageText"));
	return new VStack(sections.flatMap((section, i) => (i > 0 ? [new Spacer(1), section] : [section])));
}

/** Errors, which have no structured details. */
function textResult(result: { content: { type: string; text?: string }[] }, theme: Theme, ctx: Ctx): Component {
	const text = safeText(result.content.map((c) => c.text ?? "").join("\n"));
	return ctx.expanded
		? wrapped(theme.fg("toolOutput", text))
		: collapsed(
				text.split("\n").map((l) => theme.fg("toolOutput", l)),
				theme,
			);
}

type Result<D> = { content: { type: string; text?: string }[]; details?: D };
type StartArgs = { description?: string; model?: string; prompt?: string };
type Ctx = { expanded: boolean };

function startHeading(args: StartArgs, theme: Theme): string {
	const head = [`${title("subagent_start", theme)} ${theme.fg("text", oneLine(args.description ?? ""))}`];
	if (args.model) head.push(theme.fg("muted", oneLine(args.model)));
	return head.join(theme.fg("muted", " · "));
}

export const startRenderers = {
	renderCall(args: StartArgs, theme: Theme, ctx: Ctx = { expanded: false }) {
		const prompt = args.prompt ?? "";
		const body = ctx.expanded
			? [new Spacer(1), markdown(prompt, theme, "toolOutput")]
			: [
					lines(
						firstLines(safeText(prompt), 2).map((l) => theme.fg("muted", l)),
						theme,
					),
				];
		return new VStack([header(startHeading(args, theme), theme, ctx), ...body]);
	},
	renderResult(result: Result<{ id?: string }>, _opts: unknown, theme: Theme, ctx: Ctx = { expanded: false }) {
		const id = result.details?.id;
		if (!id) return textResult(result, theme, ctx);
		const acknowledgment = theme.fg("toolOutput", `Started ${id}.`);
		return ctx.expanded ? wrapped(acknowledgment) : collapsed([acknowledgment], theme);
	},
};

export const messageRenderers = {
	renderCall(args: { id?: string; message?: string }, theme: Theme, ctx: Ctx) {
		const message = args.message ?? "";
		const head = `${title("subagent_message", theme)} ${theme.fg("text", oneLine(args.id ?? ""))}`;
		return ctx.expanded
			? new VStack([lines([head], theme), new Spacer(1), markdown(message, theme, "toolOutput")])
			: lines([head, ...firstLines(safeText(message), 1).map((l) => theme.fg("muted", l))], theme);
	},
	renderResult(
		result: Result<{ delivered: "steer" | "resume" }>,
		_opts: unknown,
		theme: Theme,
		ctx: Ctx = { expanded: false },
	) {
		const delivered = result.details?.delivered;
		if (!delivered) return textResult(result, theme, ctx);
		const text = theme.fg(
			"muted",
			delivered === "steer" ? "message sent to running subagent" : "subagent resumed with message",
		);
		return ctx.expanded ? wrapped(text) : collapsed([text], theme);
	},
};

export const stopRenderers = {
	renderCall(args: { id?: string }, theme: Theme) {
		return lines([`${title("subagent_stop", theme)} ${theme.fg("text", oneLine(args.id ?? ""))}`], theme);
	},
	renderResult(result: Result<{ run: Report }>, _opts: unknown, theme: Theme, ctx: Ctx = { expanded: false }) {
		if (!result.details?.run) return textResult(result, theme, ctx);
		const r = result.details.run;
		return ctx.expanded ? reportSection(r, theme) : collapsed([runLine(r, theme)], theme);
	},
};

/** The Report block: a custom message in pi's custom-message frame. */
export function renderReportMessage(
	message: { details?: { reports: Report[] } },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component | undefined {
	const reports = message.details?.reports;
	if (!reports?.length) return undefined; // pi's default rendering of the text.
	const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(reportList(reports, options.expanded, theme));
	return box;
}

const WIDGET_KEY = "basic-subagents";

/** The Widget (docs/ux.md): live Run lines for running and recently finished subagents, above the editor. */
export class Widget {
	private ui: ExtensionContext["ui"] | undefined;
	private tui: TUI | undefined;
	private ticker: NodeJS.Timeout | undefined;
	private shown = false;
	private readonly runs: () => Run[];

	constructor(runs: () => Run[]) {
		this.runs = runs;
	}

	open(ui: ExtensionContext["ui"]) {
		this.ui = ui;
		this.refresh();
	}

	close() {
		this.ui?.setWidget(WIDGET_KEY, undefined);
		this.ui = undefined;
		this.refresh();
	}

	/** Show or hide it as its runs change; while it shows, it redraws every second. */
	refresh = () => {
		if (!this.ui || this.runs().length === 0) {
			clearInterval(this.ticker);
			this.ticker = undefined;
			if (this.shown) this.ui?.setWidget(WIDGET_KEY, undefined);
			this.shown = false;
			this.tui = undefined;
			return;
		}
		this.ticker ??= setInterval(() => this.tui?.requestRender(), 1000).unref();
		if (this.shown) return this.tui?.requestRender();
		this.shown = true;
		this.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			this.tui = tui;
			return {
				render: (width) => lines(widgetLines(this.runs(), width, theme), theme).render(width),
				invalidate() {},
			};
		});
	};
}

const WIDGET_MAX = 5;

/**
 * The widget's lines: past WIDGET_MAX, 4 rows in start order, preferring running subagents over finished
 * ones, then a count of the rest by status.
 */
export function widgetLines(runs: Run[], width: number, theme: Theme): string[] {
	if (runs.length <= WIDGET_MAX) return runs.map((r) => widgetLine(r, width, theme));
	const live = runs.filter((r) => r.status === "running");
	const picked = new Set([...live, ...runs.filter((r) => !live.includes(r))].slice(0, WIDGET_MAX - 1));
	const rest = runs.filter((r) => !picked.has(r));
	const sep = theme.fg("muted", " · ");
	// At most three counts (stopped runs never show), short enough that a failure fits at usual widths.
	const counts = STATUSES.flatMap((s) => {
		const n = rest.filter((r) => r.status === s).length;
		return n ? [`${theme.fg(STATUS[s].color, STATUS[s].glyph)} ${theme.fg("muted", `${n} ${s}`)}`] : [];
	});
	return [
		...runs.filter((r) => picked.has(r)).map((r) => widgetLine(r, width, theme)),
		[theme.fg("muted", `+${rest.length} more`), ...counts].join(sep),
	];
}

/** A widget Run line: the current tool's arguments get only the width the rest leaves free. */
export function widgetLine(r: Run, width: number, theme: Theme): string {
	const view = r.view();
	const tool = view.status === "running" ? r.currentTool : undefined;
	const line = (args?: string) =>
		runLine({ ...view, state: tool ? `${tool.name}${args ? ` ${args}` : ""}` : "thinking" }, theme);
	const base = line();
	const free = width - visibleWidth(base) - 1; // 1 for the space before the arguments.
	const args = free >= 3 ? argsText(tool?.args, free + 1) : "";
	// Stripped: truncateToWidth's reset would end the muted color. args has no escapes of its own left.
	return args ? line(stripTerminalSequences(truncateToWidth(args, free, "…"))) : base;
}

/**
 * About `max` characters of the string arguments on one line: `path` first, then the rest (e.g. edit's
 * text). Reads only that much of each string, so huge arguments cost nothing; control characters are
 * escaped so they print instead of driving the terminal.
 */
function argsText(args: unknown, max: number): string {
	let out = "";
	let cut = false; // Collapsing whitespace can leave it short of `max` with more unread.
	// Deep enough for edit's `edits[i].newText`; a cap so nested arguments can't overflow the stack.
	const add = (v: unknown, depth = 0) => {
		if (out.length >= max) cut = true;
		else if (typeof v === "string") {
			cut ||= v.length > max - out.length;
			out = `${out} ${v.slice(0, max - out.length)}`.replace(/\s+/g, " ").trimStart();
		} else if (v && typeof v === "object" && depth < 3) for (const x of Object.values(v)) add(x, depth + 1);
	};
	const { path, ...rest } = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	add(path);
	add(rest);
	const text = out.trim().replace(/\p{Cc}/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
	return cut && text ? `${text}…` : text;
}

export function shortModel(model: string): string {
	return model
		.slice(model.lastIndexOf("/") + 1)
		.replace(/^claude-/, "")
		.replace(/-(?:latest|\d{8}|\d{4}-\d{2}-\d{2})(:[^:]*)?$/, "$1");
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}
