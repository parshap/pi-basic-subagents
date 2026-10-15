import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { lines, runLine } from "./render.ts";
import type { Run } from "./run.ts";

const KEY = "basic-subagents";

/** The Widget (docs/design.md): a live Run line per running subagent, below the editor. */
export class Widget {
	private ui: ExtensionContext["ui"] | undefined;
	private tui: TUI | undefined;
	private ticker: NodeJS.Timeout | undefined;
	private shown = false;
	private readonly running: () => Run[];

	constructor(running: () => Run[]) {
		this.running = running;
	}

	open(ui: ExtensionContext["ui"]) {
		this.ui = ui;
		this.refresh();
	}

	close() {
		this.ui?.setWidget(KEY, undefined);
		this.ui = undefined;
		this.refresh();
	}

	/** Show or hide it as subagents start and finish; while any run, it redraws every second. */
	refresh = () => {
		if (!this.ui || this.running().length === 0) {
			clearInterval(this.ticker);
			this.ticker = undefined;
			if (this.shown) this.ui?.setWidget(KEY, undefined);
			this.shown = false;
			this.tui = undefined;
			return;
		}
		this.ticker ??= setInterval(() => this.tui?.requestRender(), 1000).unref();
		if (this.shown) return this.tui?.requestRender();
		this.shown = true;
		this.ui.setWidget(
			KEY,
			(tui, theme) => {
				this.tui = tui;
				return {
					render: (width) => lines(this.running().map((r) => runLine({ ...r.view(), state: state(r) }, theme))).render(width),
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	};
}

function state(r: Run): string {
	const tokens = r.contextTokens ? ` · ${k(r.contextTokens)} tokens` : "";
	return `${r.currentTool ?? "thinking"} · ${elapsed(Date.now() - r.startedAt)}${tokens}`;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}
