# pi-basic-subagents

Background-first subagents for [pi](https://pi.dev). A subagent is a regular `pi` session started in a directory, the same as one you'd start yourself, with a short role prompt and a brief.

## Install

```sh
pi install npm:pi-basic-subagents
```

Or from git: `pi install git:github.com/parshap/pi-basic-subagents`.

## Design

- **A subagent is just a pi session.** It gets your settings, extensions, MCP servers at their configured exposure, codemode, skills, `AGENTS.md`, and project config when the project is trusted. There's no special child runtime and no tool allowlist; the only CLI flags it inherits from the parent are tool and resource restrictions (`--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `-e`, `--no-extensions`, `--no-mcp`, `--skill`, `--no-skills`, `--no-context-files`, `--offline`), so it never gets more than its parent.
- **Expose pi's natural shape.** Each run is a `pi --mode rpc` subprocess. Steering and stopping are RPC `steer`/`abort`, resume reopens the saved session file, permission prompts use the `PI_SUBAGENT_PARENT_SESSION` convention, orchestration is codemode, and specialization is skills.
- **Follow Claude Code's model.** Background by default with results delivered on completion, one message verb to steer or resume, generic `explore` and `general-purpose` types, and Claude Code's parameter names.
- **Minimal.** Four tools. Foreground is start + wait, not a second mode.
- **Delegation is one-way: brief in, report out.** A subagent never asks its parent anything mid-run. It makes routine judgment calls and states its assumptions; at a real fork it stops and reports `blocked:` with the options, and the parent answers with `subagent_message`.

Not included: workflows, chains, custom agent files, per-agent tool restrictions, worktree isolation, or a child-to-parent question channel.

## Tools

| Tool | Parameters | Returns |
|---|---|---|
| `subagent_start` | `subagent_type` (`explore` \| `general-purpose`), `prompt`, `description`, `model?` | `{ id }` as soon as the child is running |
| `subagent_wait` | `ids?` (default: running ones and any whose report hasn't arrived), `timeout_ms?` (0 checks status without waiting) | per id: `{ id, status, result?, session_path? }` |
| `subagent_message` | `id`, `message` | `{ delivered: "steer" \| "resume" }` |
| `subagent_stop` | `id` | `{ status }`: `"stopped"`, or how it had already finished |

- `model` is `provider/id` with an optional `:thinking` suffix. It defaults to the parent's model and thinking level.
- When a run finishes, its report waits until the parent is idle. Then pending reports are appended to the session as one `<subagent_notification>` custom message, and a short fixed user prompt wakes the parent. The wake is a prompt rather than a custom message with `triggerTurn` so it goes through pi's normal prompt path (`before_agent_start`). If pi rejects the wake, the reports are already in the session. A report that `subagent_wait` returns first isn't sent again.
- Cancelling a wait (Esc, or a codemode script ending) cancels only the wait.
- `subagent_message` steers a running subagent. A finished or stopped one resumes from its session with full history and reports again on completion.
- As with Claude Code's tools that change state, `subagent_message` and `subagent_stop` run in order with the other calls in their message, so a `subagent_wait` after them sees their effect. pi can only order a whole message, so its other calls run one at a time too. `subagent_start` and `subagent_wait` run in parallel.
- Results over pi's tool-output limits (2000 lines or 50KB) are truncated; the full text is the last message in the transcript.

All four tools work from codemode, since runs belong to the extension and not to the tool call:

```js
const ids = await Promise.all(briefs.map((prompt) => tools.subagent_start({ subagent_type: "explore", prompt, description: "…" })));
return await tools.subagent_wait({ ids: ids.map((r) => r.id) });
```

## Behavior

- The child process lives only while a run is active; one that doesn't exit after its run is terminated. Sessions are saved under the parent session's directory (`<parent session file without .jsonl>/`), so they don't show in `/resume`.
- **Directory and trust.** A subagent runs in the parent's directory, so the parent project's settings apply to it too. There's no `cwd` parameter, as in Claude Code: in another directory, the parent project's settings, including tool limits, wouldn't apply. The child gets `--approve` when the parent trusts the project and `--no-approve` otherwise, so it's never more trusted than the parent. Trust and inherited flags are recomputed for every launch, so a resume follows the parent's current state.
- **Dialogs.** Nobody watches a background subagent, so extension dialogs (`select`, `confirm`, `input`, `editor`) are cancelled immediately.
- **Permissions.** With [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages), the child's permission asks are forwarded to the parent session's UI because the child is spawned with `PI_SUBAGENT_PARENT_SESSION`. An inherited value is kept, so nested children forward to the root session.
- **Nesting and print mode.** A subagent, or a parent in print or json mode, exits when it finishes, which stops its own subagents. So before it finishes, it waits for them and continues with their reports. Stopping the process, or the subagent from its parent, ends the wait.
- **Shutdown and reopening.** When the parent session shuts down (exit, `/reload`, `/new`, `/resume`), running children are aborted and terminated. Each run and its status changes are recorded in the parent session as custom entries outside the model's context, so subagent ids keep working when the session is reopened: `subagent_wait` reports runs cut short by the exit as stopped and points finished ones to their transcripts, and `subagent_message` resumes them. With no ids and nothing running, `subagent_wait` lists the session's earlier subagents. A fork (`/fork`) doesn't take over its original's subagents, so the two never share a child session; their reports stay in the copied conversation.

## Configuration

In `~/.pi/agent/settings.json`, or `.pi/settings.json` in a trusted project (project values override user values key by key):

```json
{ "basicSubagents": { "maxConcurrent": 20, "maxDepth": 1 } }
```

- `maxConcurrent`: running subagents per session. Starting or resuming more fails until one finishes.
- `maxDepth`: subagent layers below the main session. The default of 1 means subagents can't start their own. Every subagent is a full pi process that starts its own extensions and MCP servers, so deep trees multiply processes.

Per-type tool access can be added by passing pi's `--tools` (and optionally `--no-extensions`) to the child.

## Development

```sh
npm install
npm run check
npm test
pi -e .   # try the working copy
```

To release, bump `version` in `package.json`, commit, and push a `v<version>` tag; the publish workflow publishes it to npm.

What the extension draws, and how, is specified in [docs/design.md](docs/design.md).
