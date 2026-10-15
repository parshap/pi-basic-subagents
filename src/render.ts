// The shapes in docs/design.md. Everything here draws from structured data, never from model-facing text.
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, hyperlink, Markdown, Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import type { Status } from "./run.ts";

/** One subagent, as every shape shows it. `state` is what a running one is doing. */
export interface RunView {
	id: string;
	type: string;
	description: string;
	status: Status;
	state?: string;
}

/** A finished (or running) subagent's report, for wait results and report messages. */
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
	return `${theme.fg(color, glyph)} ${theme.fg("text", theme.bold(v.id))} ${theme.fg("muted", v.type)}${sep}${theme.fg("text", v.description)}${sep}${state}`;
}

/** Lines that are cut to the width, never wrapped. */
export function lines(texts: string[]): Component {
	return { render: (width) => texts.map((t) => truncateToWidth(t, width, "…")), invalidate() {} };
}

function stack(children: Component[]): Component {
	return {
		render: (width) => children.flatMap((c) => c.render(width)),
		invalidate: () => children.forEach((c) => c.invalidate()),
	};
}

/** Body text: `toolOutput` in tool blocks and `customMessageText` in report blocks, like pi's own. */
type BodyColor = "toolOutput" | "customMessageText";

const markdown = (text: string, theme: Theme, color: BodyColor) =>
	new Markdown(text, 0, 0, getMarkdownTheme(), { color: (t) => theme.fg(color, t) });

/** The accent bar marking a call that started or resumed a subagent. */
export function barred(child: Component, theme: Theme): Component {
	const bar = `${theme.fg("accent", "▌")} `;
	return {
		render: (width) => child.render(Math.max(1, width - 2)).map((line) => bar + line),
		invalidate: () => child.invalidate(),
	};
}

const title = (name: string, theme: Theme) => theme.fg("toolTitle", theme.bold(name));
const firstLines = (text: string, n: number) => text.split("\n").filter((l) => l.trim()).slice(0, n);

function expandHint(theme: Theme): string {
	let key = "Ctrl+O";
	try {
		key = keyText("app.tools.expand") || key;
	} catch {}
	return theme.fg("dim", `(${key} to expand)`);
}

/** A report's full view: its Run line, transcript link, and result. */
function reportSection(r: ReportView, theme: Theme, color: BodyColor): Component {
	const parts: Component[] = [lines([runLine(r, theme)])];
	if (r.session_path) parts.push(lines([theme.fg("muted", hyperlink(r.session_path, pathToFileURL(r.session_path).href))]));
	if (r.result) parts.push(new Spacer(1), markdown(r.result, theme, color));
	return stack(parts);
}

function reportList(reports: ReportView[], expanded: boolean, theme: Theme, color: BodyColor): Component {
	if (!expanded) return lines(reports.map((r) => runLine(r, theme)));
	const sections = reports.map((r) => reportSection(r, theme, color));
	return stack(sections.flatMap((section, i) => (i > 0 ? [new Spacer(1), section] : [section])));
}

/** A tool result without our details (an error, or a session from before them): its text as is. */
function textResult(result: { content: { type: string; text?: string }[] }, theme: Theme): Component {
	const text = result.content.map((c) => c.text ?? "").join("\n");
	return lines(text.split("\n").map((l) => theme.fg("toolOutput", l)));
}

type Result<D> = { content: { type: string; text?: string }[]; details?: D };
type Ctx = { expanded: boolean; isError: boolean; state: Record<string, unknown>; invalidate(): void };

export const startRenderers = {
	renderCall(args: { subagent_type?: string; description?: string; model?: string; prompt?: string }, theme: Theme, ctx: Ctx) {
		const sep = theme.fg("muted", " · ");
		const head = [`${title("subagent_start", theme)} ${theme.fg("muted", args.subagent_type ?? "")}`, theme.fg("text", args.description ?? "")];
		if (args.model) head.push(theme.fg("muted", args.model));
		const prompt = args.prompt ?? "";
		const body = ctx.expanded
			? [new Spacer(1), markdown(prompt, theme, "toolOutput")]
			: [lines(firstLines(prompt, 2).map((l) => theme.fg("muted", l)))];
		const call = stack([lines([head.join(sep)]), ...body]);
		return ctx.isError ? call : barred(call, theme);
	},
	renderResult(result: Result<{ run: RunView }>, _opts: unknown, theme: Theme, ctx: Ctx) {
		if (!result.details?.run) return textResult(result, theme);
		return barred(lines([runLine(result.details.run, theme)]), theme);
	},
};

export const waitRenderers = {
	renderCall(args: { ids?: string[]; timeout_ms?: number }, theme: Theme) {
		const ids = args.ids?.length ? args.ids.join(", ") : "all";
		const timeout = args.timeout_ms !== undefined ? theme.fg("muted", ` · timeout ${args.timeout_ms / 1000}s`) : "";
		return lines([`${title("subagent_wait", theme)} ${theme.fg("text", ids)}${timeout}`]);
	},
	renderResult(result: Result<{ reports: ReportView[] }>, _opts: unknown, theme: Theme, ctx: Ctx) {
		const reports = result.details?.reports;
		if (!reports?.length) return textResult(result, theme);
		return reportList(reports, ctx.expanded, theme, "toolOutput");
	},
};

export const messageRenderers = {
	renderCall(args: { id?: string; message?: string }, theme: Theme, ctx: Ctx) {
		const message = args.message ?? "";
		const head = `${title("subagent_message", theme)} ${theme.fg("text", args.id ?? "")}`;
		const call = ctx.expanded
			? stack([lines([head]), new Spacer(1), markdown(message, theme, "toolOutput")])
			: lines([head, ...firstLines(message, 1).map((l) => theme.fg("muted", l))]);
		// The result tells whether it resumed the subagent; renderResult records it and redraws.
		return ctx.state.resumed ? barred(call, theme) : call;
	},
	renderResult(result: Result<{ delivered: "steer" | "resume" }>, _opts: unknown, theme: Theme, ctx: Ctx) {
		const delivered = result.details?.delivered;
		if (!delivered) return textResult(result, theme);
		const resumed = delivered === "resume";
		if (resumed !== Boolean(ctx.state.resumed)) {
			ctx.state.resumed = resumed;
			queueMicrotask(ctx.invalidate); // Not mid-render: pi is still drawing this block.
		}
		const body = lines([theme.fg("muted", `delivered as ${delivered}`)]);
		return resumed ? barred(body, theme) : body;
	},
};

export const stopRenderers = {
	renderCall(args: { id?: string }, theme: Theme) {
		return lines([`${title("subagent_stop", theme)} ${theme.fg("text", args.id ?? "")}`]);
	},
	renderResult(result: Result<{ run: RunView }>, _opts: unknown, theme: Theme) {
		if (!result.details?.run) return textResult(result, theme);
		return lines([runLine(result.details.run, theme)]);
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
	if (!options.expanded) box.addChild(lines([expandHint(theme)]));
	return box;
}
