# Spec

What pi-basic-subagents does: the behavior contract. How it's drawn is in [ux.md](ux.md); how it's built is in [CONTRIBUTING.md](../CONTRIBUTING.md#how-it-works). Tests in `test/` check these rules; their names state the rule they check.

## 1. Scope

The design principles are in the [README](../README.md#design). Beyond those:

- Foreground is start then wait, not a second mode.
- The two types differ only in their role prompt; specialization comes from skills.
- Not included: chains or workflow definitions (codemode scripts cover them), custom agent files, per-type tool restrictions, worktree isolation, or a channel for a subagent to ask its parent questions.

## 2. Tools

| Tool | Parameters | Returns |
|---|---|---|
| `subagent_start` | `subagent_type` (`explore` \| `general-purpose`), `prompt`, `description`, `model?` | `{ id }` as soon as the child is running |
| `subagent_wait` | `ids?` (default: running ones and any whose report hasn't arrived), `timeout_ms?` (0 checks status without waiting) | per id: `{ id, type, description, status, result?, session_path? }` |
| `subagent_message` | `id`, `message` | `{ delivered: "steer" \| "resume" }` |
| `subagent_stop` | `id` | `{ status }`: `"stopped"`, or how it had already finished |

- **Types.** Both types get a role prompt: do the task directly, don't re-delegate, report the answer first with evidence, and stop with `blocked:` at a decision that would change the outcome. `explore` adds that the project must be left as found. That rule is advisory: nothing enforces it.
- **Model.** `model` is `provider/id` with an optional `:thinking` suffix. It defaults to the parent's model and thinking level.
- **Messages.** `subagent_message` steers a running subagent. A finished or stopped one resumes from its session with full history and reports again on completion. A resume counts toward `maxConcurrent`.
- **Waiting.** Cancelling a wait (Esc, or a codemode script ending) cancels only the wait. With no ids and nothing running, `subagent_wait` lists the session's earlier subagents.
- **Ordering.** As with Claude Code's tools that change state, `subagent_message` and `subagent_stop` run in order with the other calls in their message, so a `subagent_wait` after them sees their effect. pi can only order a whole message, so its other calls run one at a time too. `subagent_start` and `subagent_wait` run in parallel.
- **Truncation.** Results over pi's tool-output limits (2000 lines or 50KB) are truncated; the full text is the last message in the transcript.
- **Codemode.** All four tools work from codemode, since runs belong to the extension and not to the tool call.

## 3. Reports

When a run finishes, its report waits until the parent is idle. Then pending reports are appended to the session as one `<subagent_notification>` custom message, and a short fixed user prompt wakes the parent. The wake is a prompt rather than a custom message with `triggerTurn` so it goes through pi's normal prompt path (`before_agent_start`). If pi rejects the wake, the reports are already in the session. A report that `subagent_wait` returns first isn't sent again. Open problem: [the wake shows up as something the user typed](issues/wake-prompt-is-a-user-message.md).

## 4. Runs

- **Process.** Every subagent is a full pi process that starts its own extensions and MCP servers. The child process lives only while a run is active; one that doesn't exit after its run is terminated. Sessions are saved under the parent session's directory (`<parent session file without .jsonl>/`), so they don't show in `/resume`. Open problem: [a `--no-session` parent's subagents are saved anyway](issues/no-session-subagents-are-saved.md).
- **Inherited flags.** The only CLI flags a subagent inherits from its parent are tool and resource restrictions (`--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `-e`, `--no-extensions`, `--no-mcp`, `--skill`, `--no-skills`, `--no-context-files`, `--offline`), so it never gets more than its parent.
- **Directory and trust.** A subagent runs in the parent's directory, so the parent project's settings apply to it too. There's no `cwd` parameter, as in Claude Code: in another directory, the parent project's settings, including tool limits, wouldn't apply. The child gets `--approve` when the parent trusts the project and `--no-approve` otherwise, so it's never more trusted than the parent. Trust and inherited flags are recomputed for every launch, so a resume follows the parent's current state.
- **Dialogs.** Nobody watches a background subagent, so extension dialogs (`select`, `confirm`, `input`, `editor`) are cancelled immediately.
- **Permissions.** With [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages), the child's permission asks are forwarded to the parent session's UI because the child is spawned with `PI_SUBAGENT_PARENT_SESSION`. An inherited value is kept, so nested children forward to the root session.
- **Nesting and print mode.** A subagent, or a parent in print or json mode, exits when it finishes, which stops its own subagents. So before it finishes, it waits for them and continues with their reports. Stopping the process, or the subagent from its parent, ends the wait.

## 5. Sessions

When the parent session shuts down (exit, `/reload`, `/new`, `/resume`), running children are aborted and terminated. Each run and its status changes are recorded in the parent session as custom entries outside the model's context, so subagent ids keep working when the session is reopened: `subagent_wait` reports runs cut short by the exit as stopped and points finished ones to their transcripts, and `subagent_message` resumes them. A fork (`/fork`) doesn't take over its original's subagents, so the two never share a child session; their reports stay in the copied conversation.

## 6. Configuration

The settings, their defaults, and where they go are in the [README](../README.md#configuration). Beyond those:

- Starting or resuming a subagent beyond `maxConcurrent` fails until one finishes.
- A session at `maxDepth` doesn't register the four tools at all.
- Invalid values are ignored with a warning.
