# Spec

What pi-basic-subagents does: the behavior contract. How it's drawn is in [ux.md](ux.md); how it's built is in [CONTRIBUTING.md](../CONTRIBUTING.md#how-it-works). Tests in `test/` check these rules; their names state the rule they check.

## 1. Scope

The design principles are in the [README](../README.md#design). Beyond those:

- The model's tools never block, so it stays free to talk to the user; reports wake it. Scripts wait through their own tools, as Claude Code's workflow scripts use `agent()`. Why: [research memo](research/2026-10-20-subagent-waiting.md).
- The two types differ only in their role prompt; specialization comes from skills.
- Not included: chains or workflow definitions (codemode scripts cover them), custom agent files, per-type tool restrictions, worktree isolation, or a channel for a subagent to ask its parent questions.

## 2. Tools

| Tool | For | Parameters | Returns |
|---|---|---|---|
| `subagent_start` | the model | `subagent_type?` (`explore` \| `general-purpose`, the default), `prompt`, `description`, `model?` | as soon as the child is running |
| `subagent_message` | the model | `id`, `message` | once the child accepts it, saying whether it steered or resumed |
| `subagent_stop` | the model | `id` | its status: stopped (adding that `subagent_message` resumes it), or how it had already finished |
| `subagent_run` | scripts | as `subagent_start` | once it finishes: the report, `{ id, type, description, status, result?, session_path? }`; a failed run's `result` is its error |
| `subagent_continue` | scripts | as `subagent_message` | the run's next report. It only resumes, so a running id fails. |

In pi's terms, the model's tools are `model-only` and the scripts' are `codemode`: scripts can't call the model's tools, and the model sees the scripts' tools only in codemode's description. With codemode's `only` mode, the model's tools stay declared, since pi hides only tools scripts can call; that keeps a way to delegate without blocking.

- **Types.** Both types get a role prompt: complete the task and end with a concise report of what was done and the findings and evidence, don't undo changes it didn't make (others may share the directory), and make a reasonable guess rather than ask, stopping only when truly stuck. `explore` adds not changing the project or publishing or sending anything. That rule is advisory: nothing enforces it.
- **Model.** `model` is `provider/id` with an optional `:thinking` suffix. It defaults to the parent's model and thinking level.
- **Messages.** `subagent_message` steers a running subagent. A finished or stopped one resumes from its session with full history and reports again on completion. A resume counts toward `maxConcurrent`.
- **Scripts.** `subagent_run` and `subagent_continue` wait for the run, like `await agent()` in a Claude Code workflow script, and the report they return isn't sent again. Like any tool call, a waiting script holds the user's messages until it ends. Cancelling the call (Esc, the script's deadline, or the script ending first) stops the subagent, as aborting a Claude Code workflow does, so its report can't flood the parent later.
- **Ordering.** As with Claude Code's tools that change state, `subagent_message` and `subagent_stop` run in order with the other calls in their message, so calls on one subagent take effect in the order given. pi can only order a whole message, so its other calls run one at a time too. `subagent_start` calls run in parallel.
- **Truncation.** Results over pi's tool-output limits (2000 lines or 50KB) are truncated, pointing to the report's file for the rest.
- **Metrics.** For the UI only, a run keeps its model, duration (of its latest launch), and context size: the tokens in its latest model response, as pi's footer counts them. It carries across resumes and reopening, and drops after a compaction once the next response arrives.

## 3. Reports

When a run finishes, its full report is saved to a file next to its transcript (`<id>-<key>.md`) and waits until the parent is idle. Then pending reports are appended as one `<subagent_notification>` custom message, and a short user prompt wakes the parent, naming any subagents still running: a partial batch is when models tend to wait for the rest. The wake is a prompt rather than `triggerTurn` so it goes through pi's normal prompt path (`before_agent_start`); if pi rejects it, the reports are already in the session. A turn the user ended with Esc gets no wake: the reports wait in the conversation. Open problem: [the wake shows up as something the user typed](issues/wake-prompt-is-a-user-message.md).

- **What the model reads.** A report is its status line, then its result. A failed run's result is only its error, never partial output, followed by `subagent_message resumes it.`: the subagent keeps its context, so the model can ask it for what it has. A report leaves out the UI's metrics and the transcript path: the JSONL would flood the parent's context, and the report's file covers reading more. The UI still links the transcript.
- **Missed reports.** On reopen there may be many, so each is just its status line and `Report: <file> (N lines)`, in the UI too. It has no failure reason: the file has it.

## 4. Runs

- **Process.** Every subagent is a full pi process that starts its own extensions and MCP servers. The child process lives only while a run is active; one that doesn't exit after its run is terminated. Sessions are saved under the parent session's directory (`<parent session file without .jsonl>/`), so they don't show in `/resume`. Open problem: [a `--no-session` parent's subagents are saved anyway](issues/no-session-subagents-are-saved.md).
- **Inherited flags.** The only CLI flags a subagent inherits from its parent are tool and resource restrictions (`--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `-e`, `--no-extensions`, `--no-mcp`, `--skill`, `--no-skills`, `--no-context-files`, `--offline`), so it never gets more than its parent.
- **Directory and trust.** A subagent runs in the parent's directory, so the parent project's settings apply to it too. There's no `cwd` parameter, as in Claude Code: in another directory, the parent project's settings, including tool limits, wouldn't apply. The child gets `--approve` when the parent trusts the project and `--no-approve` otherwise, so it's never more trusted than the parent. Trust and inherited flags are recomputed for every launch, so a resume follows the parent's current state.
- **Dialogs.** Nobody watches a background subagent, so extension dialogs (`select`, `confirm`, `input`, `editor`) are cancelled immediately.
- **Permissions.** With [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages), the child's permission asks are forwarded to the parent session's UI because the child is spawned with `PI_SUBAGENT_PARENT_SESSION`. An inherited value is kept, so nested children forward to the root session.
- **Nesting and print mode.** A subagent, or a parent in print or json mode, exits when it finishes, which stops its own subagents. So before it finishes, it waits for them and continues with their reports. Stopping the process, or the subagent from its parent, ends the wait.

## 5. Sessions

When the parent session shuts down (exit, `/reload`, `/new`, `/resume`), running children are aborted and terminated. Each run and its status changes are recorded in the parent session as custom entries outside the model's context, so subagent ids keep working when the session is reopened, and `subagent_message` resumes runs the exit cut short. The model may have ended its turn expecting reports, so a reopened session also appends, without a wake, one notification covering runs the exit cut short and reports that never arrived ([§3](#3-reports)), each once, as Claude Code does on resume. A fork (`/fork`) doesn't take over its original's subagents, so the two never share a child session; their reports stay in the copied conversation.

## 6. Configuration

The settings, their defaults, and where they go are in the [README](../README.md#configuration). Beyond those:

- Starting or resuming a subagent beyond `maxConcurrent` fails until one finishes.
- A session at `maxDepth` doesn't register the tools at all.
- Invalid values are ignored with a warning.
