import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { currentDepth, DEFAULTS, inheritedFlags, resolveConfig } from "../src/config.ts";

test("defaults without settings", () => {
	assert.deepEqual(resolveConfig({}), { config: DEFAULTS, warnings: [] });
});

test("settings override defaults key by key", () => {
	assert.deepEqual(resolveConfig({ basicSubagents: { maxDepth: 3 } }).config, { ...DEFAULTS, maxDepth: 3 });
});

test("invalid values are ignored with a warning", () => {
	const { config, warnings } = resolveConfig({ basicSubagents: { maxConcurrent: 0, maxDepth: 1.5 } });
	assert.deepEqual(config, DEFAULTS);
	assert.equal(warnings.length, 2);
	assert.equal(resolveConfig({ basicSubagents: "nope" }).warnings.length, 1);
});

test("maxDepth 0 is allowed", () => {
	assert.equal(resolveConfig({ basicSubagents: { maxDepth: 0 } }).config.maxDepth, 0);
});

test("depth comes from the environment", () => {
	assert.equal(currentDepth({}), 0);
	assert.equal(currentDepth({ PI_BASIC_SUBAGENTS_DEPTH: "2" }), 2);
	assert.equal(currentDepth({ PI_BASIC_SUBAGENTS_DEPTH: "x" }), 0);
});

test("only restrictive and resource CLI flags pass to children, with local paths made absolute", () => {
	const flags = inheritedFlags(
		parseArgs(["--model", "x", "-p", "--tools", "read,grep", "-ne", "-e", "builtin:foo", "-e", "package.json", "hi"]),
	);
	assert.deepEqual(flags, [
		"--tools",
		"read,grep",
		"--no-extensions",
		"--extension",
		"builtin:foo",
		"--extension",
		path.resolve("package.json"),
	]);
});
