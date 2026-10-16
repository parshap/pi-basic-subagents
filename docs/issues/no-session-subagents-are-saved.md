# A `--no-session` parent's subagents are saved anyway

> **open — action needed** (raised 2026-10-15). With `--no-session`, the user asks for nothing to be saved, but every subagent's session is written to disk and kept after pi exits. Frames the problem; the directions below are options, not a decision.

## Situation

A subagent's session is saved under the parent session file's directory ([spec §4](../spec.md#4-runs)). A parent started with `--no-session` has no session file, so `childSessionDir()` in `src/index.ts` falls back to `<agent dir>/sessions/basic-subagents/<parent session id>/`.

## What is wrong

`--no-session` is how users ask for an ephemeral run: scripted and CI use (`pi -p --no-session …`), one-off questions, privacy, or a read-only home. They'd expect a subagent to be as ephemeral as its parent. Instead its full transcript persists after pi exits, where nothing can use it: resuming needs the parent session that knew the subagent's id, and that session was never saved.

A subagent's session can't simply go unsaved either: resuming a finished subagent within the same run reopens it.

## Possible directions

- Keep children's sessions in a temporary directory for the parent's lifetime and delete it on shutdown. Resuming works within the run, nothing outlives it, but a crash leaves files behind.
- Don't offer subagents in a `--no-session` session at all.

## When it bites

Any `--no-session` run whose agent starts a subagent.

## Related

- [spec §4](../spec.md#4-runs), [spec §5](../spec.md#5-sessions)
