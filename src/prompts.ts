// Everything a model reads from this extension, in one place so it can be reviewed and edited as a whole.
// Run failure reasons, which are diagnostics, stay in run.ts.

import type { Report } from "./render.ts";
import type { Status } from "./run.ts";

// Tools and parameters.

export const descriptions = {
	start: (maxConcurrent: number) =>
		[
			"Start a subagent: a fresh pi session with your tools, skills, and project context, but not this conversation.",
			`It returns at once, and you'll be notified when it finishes. At most ${maxConcurrent} run at once.`,
		].join(" "),
	startAndWait:
		"Like subagent_start, but resolves with its report. A subagent still running when the script ends is stopped. The user can't talk to you until the script ends, so use it only when the script needs the report; otherwise use subagent_start.",
	message:
		"Send a message to a subagent. A running one gets it after its current step; a finished or stopped one resumes with its history and reports again.",
	stop: "Stop a running subagent. subagent_message resumes it.",
	subagentType:
		"explore: asked not to make changes (research, review, verification). general-purpose (the default): can change things.",
	prompt: "All the subagent sees: the goal, relevant context, constraints, and what to report.",
	description: "3-5 words, for display.",
	model: 'Model as "provider/id" with optional ":thinking". Defaults to the current model.',
};

// Tool results and errors. Each says what happens next, so the model doesn't wait to find out.

export const results = {
	// Right where the model decides what's next; a description alone doesn't stop the reflexive wait.
	started: (id: string) => `Started ${id}. You'll be notified when it finishes. Do other work or end your turn.`,
	/** `finished` is the status of a report the model hasn't had yet: it may not know the run had finished. */
	sent: (id: string, resumed: boolean, finished?: Status) => {
		if (finished) return `Resumed ${id}, which had ${finished}. You'll be notified of both reports.`;
		return `${resumed ? "Resumed" : "Sent to"} ${id}. You'll be notified when it finishes.`;
	},
	stop: (id: string, status: Status, queued: boolean) => {
		const tail =
			status === "stopped" ? ". subagent_message resumes it." : queued ? ". You'll be notified with its report." : ".";
		return `${id}: ${status}${tail}`;
	},
};

export const errors = {
	atCapacity: (max: number) => `${max} subagents are already running. Try again after one finishes.`,
	cancelled: (id: string) => `Cancelled; ${id} stopped. subagent_message resumes it.`,
	unknownId: (id: string) => `Unknown subagent id: ${id}`,
};

// Reports.

/** A stopped run's result. */
export const STOPPED = "(Stopped. subagent_message resumes it.)";
/** The result of a run the parent session's exit cut short. */
export const INTERRUPTED = "(Stopped when the parent session ended. subagent_message resumes it.)";

/**
 * A report as the model reads it, without the metrics the UI shows. The transcript path is left out too:
 * the JSONL would flood its context. A failed run keeps its context, so the model can ask it what it has.
 */
export function formatReport(r: Report): string {
	const head = `${r.id} (${r.type}: ${r.description}) ${r.status}`;
	const text = r.result !== undefined ? `${head}\n\n${r.result}` : head;
	return r.status === "failed" ? `${text}\n\nsubagent_message resumes it.` : text;
}

export const notification = (reports: Report[]) =>
	`<subagent_notification>\n${reports.map(formatReport).join("\n\n---\n\n")}\n</subagent_notification>`;

/** The prompt that wakes an idle parent for reports. */
export function wakePrompt(running: string[]): string {
	const text = "Subagent reports arrived above. Continue the task they belong to, or report to the user.";
	// Said outright: a wake with only some of a batch's reports is when a model reaches for a wait.
	return running.length ? `${text} Still running: ${running.join(", ")}; you'll be notified when they finish.` : text;
}

/** Appended to a truncated result; `file` holds the full report, when it could be written. */
export function truncationNote(shown: number, total: number, file: string | undefined): string {
	const rest = file ? `in ${file}` : "the last message in the transcript";
	return `[Result truncated to ${shown} of ${total} lines. The full text is ${rest}.]`;
}

/** A report reduced to where to read it, for the ones a reopened session missed, which could be many. */
export const briefReport = (file: string, lines: number) => `Report: ${file} (${lines} line${lines === 1 ? "" : "s"})`;

// Subagents' role prompts, appended to their system prompt.

const base = `You are a subagent. Your first message is a task from another agent.

Complete the task. Then, respond with a concise report covering what was done and any key findings and evidence. Others may be working in this directory; don't undo changes you didn't make.

You can't ask questions mid-task. If you need input and a reasonable guess exists: make it, note the assumption, keep working. When truly stuck, stop and report what's needed.`;

const explore = `${base}

Don't change the project (its files or git state) or publish or send anything. Running code and checks, and writing temporary files outside the project, is fine.`;

export const SUBAGENT_TYPES = {
	"general-purpose": base,
	explore,
} as const;

export type SubagentType = keyof typeof SUBAGENT_TYPES;
