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
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Run, type RunView, STATUSES, type Status } from "./run.ts";

/** A finished (or running) subagent's report, for report messages. */
export interface ReportView extends RunView {
	result?: string;
	session_path?: string;
}

const STATUS: Record<Status, { glyph: string; color: "accent" | "success" | "error" | "warning" }> = {
	running: { glyph: "●", color: "accent" },
	completed: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	stopped: { glyph: "■", color: "warning" },
};

/** The Run line: `<glyph> <id> <type> · <description> · <state>`. */
export function runLine(v: RunView, theme: Theme): string {
	const { glyph, color } = STATUS[v.status];
	const sep = theme.fg("muted", " · ");
	const state = v.status === "running" && v.state ? theme.fg("muted", v.state) : theme.fg(color, v.status);
	// Without the type (the widget), the bold id sets off the description well enough.
	const type = v.type ? ` ${theme.fg("muted", v.type)}${sep}` : " ";
	return `${theme.fg(color, glyph)} ${theme.fg("text", theme.bold(v.id))}${type}${theme.fg("text", v.description)}${sep}${state}`;
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

function stack(children: Component[]): Component {
	return {
		render: (width) => children.flatMap((c) => c.render(width)),
		invalidate: () => {
			for (const c of children) c.invalidate();
		},
	};
}

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

function expandHint(theme: Theme): string {
	let key = "Ctrl+O";
	try {
		key = keyText("app.tools.expand") || key;
	} catch {}
	return theme.fg("dim", `(${key} to expand)`);
}

/** A report's full view: its Run line, transcript link, and result. */
function reportSection(r: ReportView, theme: Theme, color: BodyColor): Component {
	const parts: Component[] = [lines([runLine(r, theme)], theme)];
	if (r.session_path)
		parts.push(lines([theme.fg("muted", hyperlink(r.session_path, pathToFileURL(r.session_path).href))], theme));
	if (r.result) parts.push(new Spacer(1), markdown(r.result, theme, color));
	return stack(parts);
}

function reportList(reports: ReportView[], expanded: boolean, theme: Theme, color: BodyColor): Component {
	if (!expanded)
		return lines(
			reports.map((r) => runLine(r, theme)),
			theme,
		);
	const sections = reports.map((r) => reportSection(r, theme, color));
	return stack(sections.flatMap((section, i) => (i > 0 ? [new Spacer(1), section] : [section])));
}

/** A tool result without our details (an error, or a session from before them): its text as is. */
function textResult(result: { content: { type: string; text?: string }[] }, theme: Theme): Component {
	const text = result.content.map((c) => c.text ?? "").join("\n");
	return lines(
		text.split("\n").map((l) => theme.fg("toolOutput", l)),
		theme,
	);
}

type Result<D> = { content: { type: string; text?: string }[]; details?: D };
type Ctx = { expanded: boolean };

export const startRenderers = {
	renderCall(
		args: { subagent_type?: string; description?: string; model?: string; prompt?: string },
		theme: Theme,
		ctx: Ctx,
	) {
		const sep = theme.fg("muted", " · ");
		const head = [
			`${title("subagent_start", theme)} ${theme.fg("muted", args.subagent_type ?? "general-purpose")}`,
			theme.fg("text", args.description ?? ""),
		];
		if (args.model) head.push(theme.fg("muted", args.model));
		const prompt = args.prompt ?? "";
		const body = ctx.expanded
			? [new Spacer(1), markdown(prompt, theme, "toolOutput")]
			: [
					lines(
						firstLines(prompt, 2).map((l) => theme.fg("muted", l)),
						theme,
					),
				];
		return stack([header(head.join(sep), theme, ctx), ...body]);
	},
	renderResult(result: Result<{ run: RunView }>, _opts: unknown, theme: Theme) {
		if (!result.details?.run) return textResult(result, theme);
		return lines([runLine(result.details.run, theme)], theme);
	},
};

export const messageRenderers = {
	renderCall(args: { id?: string; message?: string }, theme: Theme, ctx: Ctx) {
		const message = args.message ?? "";
		const head = `${title("subagent_message", theme)} ${theme.fg("text", args.id ?? "")}`;
		return ctx.expanded
			? stack([lines([head], theme), new Spacer(1), markdown(message, theme, "toolOutput")])
			: lines([head, ...firstLines(message, 1).map((l) => theme.fg("muted", l))], theme);
	},
	renderResult(result: Result<{ delivered: "steer" | "resume" }>, _opts: unknown, theme: Theme) {
		const delivered = result.details?.delivered;
		if (!delivered) return textResult(result, theme);
		return lines([theme.fg("muted", `delivered as ${delivered}`)], theme);
	},
};

export const stopRenderers = {
	renderCall(args: { id?: string }, theme: Theme) {
		return lines([`${title("subagent_stop", theme)} ${theme.fg("text", args.id ?? "")}`], theme);
	},
	renderResult(result: Result<{ run: RunView }>, _opts: unknown, theme: Theme) {
		if (!result.details?.run) return textResult(result, theme);
		return lines([runLine(result.details.run, theme)], theme);
	},
};

/** The Report block: a custom message in pi's custom-message frame. */
export function renderReportMessage(
	message: { details?: { reports: ReportView[] } },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component | undefined {
	const reports = message.details?.reports;
	if (!reports?.length) return undefined; // pi's default rendering of the text.
	const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(reportList(reports, options.expanded, theme, "customMessageText"));
	if (!options.expanded) box.addChild(lines([expandHint(theme)], theme));
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
	const line = (args?: string) => runLine({ ...r.view(), type: "", state: state(r, args) }, theme);
	const base = line();
	const free = width - visibleWidth(base) - 1; // 1 for the space before the arguments.
	const args = free >= 3 ? argsText(r.currentTool?.args, free + 1) : "";
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

function state(r: Run, args?: string): string {
	const tokens = r.contextTokens ? ` · ${k(r.contextTokens)} tokens` : "";
	const model = r.opts.model ? `${shortModel(r.opts.model)} · ` : "";
	return `${model}${r.currentTool ? `${r.currentTool.name}${args ? ` ${args}` : ""}` : "thinking"} · ${elapsed(Date.now() - r.startedAt)}${tokens}`;
}

const THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/;

/**
 * `provider/id:thinking` shortened for display. Each rule is scoped to ids it can't mangle: a long name
 * beats a wrong one.
 */
export function shortModel(model: string): string {
	const thinking = model.match(THINKING)?.[0] ?? "";
	const full = model.slice(0, model.length - thinking.length);
	let id = full.slice(full.lastIndexOf("/") + 1); // Provider, org, and gateway paths.
	if (full.startsWith("amazon-bedrock/"))
		id = id
			.replace(/^([a-z-]+\.){1,2}(?=[a-z]{2})/, "") // Region and vendor (`us.anthropic.`), but not `deepseek.v3`.
			.replace(/-v\d+:\d+$/, ""); // Version: `-v1:0`.
	id = id
		.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "") // A dated snapshot of an alias.
		.replace(/-latest$/, "")
		.replace(/^claude-(?=[a-z])/, ""); // `opus-4-5`, but not `3-opus`.
	return (id || full) + thinking;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}
