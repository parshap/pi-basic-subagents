# Script calls past `maxConcurrent` fail instead of waiting their turn

> **open — further research** (raised 2026-10-20). A codemode script that awaits more subagents at once than `maxConcurrent` allows gets the extra calls rejected, so fanning out over a list takes manual batching.

## Situation

A script waits for subagents by awaiting `subagent_start_and_wait` ([spec §2](../spec.md#2-tools)), so the natural fan-out is `await Promise.all(items.map((item) => tools.subagent_start_and_wait({ ... })))`. Starting beyond `maxConcurrent` fails at once ([spec §6](../spec.md#6-configuration)), as `checkCapacity()` in `src/index.ts` does for every caller.

## What is wrong

With more items than `maxConcurrent` (20 by default), the extra calls reject with "already running", and the script fails or has to batch by hand. Claude Code's workflow scripts share a concurrency cap that queues `agent()` calls instead. For a direct call, failing fast is right: the model shouldn't block. A script's call already blocks, so it could wait for a free slot, but that changes the cap's meaning for scripts and needs a story for cancellation and for the user's steer while queued.
