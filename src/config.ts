import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "@earendil-works/pi-coding-agent";

export interface Config {
	/** Concurrently running subagents per session. */
	maxConcurrent: number;
	/** Subagent layers allowed below the main session. */
	maxDepth: number;
}

export const DEFAULTS: Config = { maxConcurrent: 20, maxDepth: 1 };
const MIN: Config = { maxConcurrent: 1, maxDepth: 0 };

/** The `basicSubagents` key of pi's settings (global and trusted project, already merged by pi). */
export function resolveConfig(settings: unknown): { config: Config; warnings: string[] } {
	const config = { ...DEFAULTS };
	const warnings: string[] = [];
	const section = (settings as { basicSubagents?: unknown } | undefined)?.basicSubagents;
	if (section === undefined) return { config, warnings };
	if (typeof section !== "object" || section === null) {
		return { config, warnings: ["basicSubagents must be an object; ignoring it"] };
	}
	for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
		const value = (section as Record<string, unknown>)[key];
		if (value === undefined) continue;
		if (Number.isInteger(value) && (value as number) >= MIN[key]) config[key] = value as number;
		else warnings.push(`basicSubagents.${key} must be an integer >= ${MIN[key]}; ignoring ${JSON.stringify(value)}`);
	}
	return { config, warnings };
}

/** This process's depth below the main session (0 for the main session). */
export function currentDepth(env: NodeJS.ProcessEnv): number {
	const depth = Number(env.PI_BASIC_SUBAGENTS_DEPTH);
	return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * The parent's CLI tool and resource restrictions, so a subagent never gets more than its parent.
 * Only these flags pass through; the child picks its own session, mode, model, and trust.
 */
export function inheritedFlags(args: Args): string[] {
	// Make local paths absolute, since the child may run elsewhere; leave builtin:/npm: sources alone.
	const abs = (p: string) => (fs.existsSync(p) ? path.resolve(p) : p);
	return [
		...(args.tools ? ["--tools", args.tools.join(",")] : []),
		...(args.excludeTools ? ["--exclude-tools", args.excludeTools.join(",")] : []),
		...(args.noTools ? ["--no-tools"] : []),
		...(args.noBuiltinTools ? ["--no-builtin-tools"] : []),
		...(args.noExtensions ? ["--no-extensions"] : []),
		...(args.extensions ?? []).flatMap((e) => ["--extension", abs(e)]),
		...(args.noMcp ? ["--no-mcp"] : []),
		...(args.noSkills ? ["--no-skills"] : []),
		...(args.skills ?? []).flatMap((s) => ["--skill", abs(s)]),
		...(args.noContextFiles ? ["--no-context-files"] : []),
		...(args.offline ? ["--offline"] : []),
	];
}
