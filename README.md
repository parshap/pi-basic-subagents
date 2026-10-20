# pi-basic-subagents

Minimal subagents for [pi](https://pi.dev), where each subagent is a regular pi session with the same tools and access as your agent, rather than task-specific restricted subagents.

```
● sa-1a2b Audit auth flow · opus-5-5:high · bash rg -n "session" src/auth · 1m12s · 48.3k tokens
● sa-3c4d Fix flaky upload test · gpt-6-luna:max · thinking · 24s · 12.1k tokens
```

## Design

- **Just a pi session.** Each subagent runs in your project with your settings, extensions, MCP servers, skills, and `AGENTS.md`, and its transcript is a normal pi session you can open.
- **Nothing to configure.** There are no agent definitions, prompts, or tool lists to write. Install it and ask your agent to delegate to subagents.
- **Familiar to models.** Tools modeled on Claude Code's subagent tools, which many models know from training.
- **One-way communication.** Your agent (the parent) sends a prompt and can steer or stop the subagent while it works. The subagent reports back only when it finishes.
- **Never blocks your agent.** Subagents report back when they're done, so your agent stays free to talk to you. For workflows that wait on subagents, it writes [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md) scripts.

## Install

```sh
pi install npm:pi-basic-subagents
```

## Use

Ask for it in plain words; your agent calls the tools:

> Have a subagent research the best queuing approach while you fix the failing test.

> Have two subagents review this work, one using Opus and one using GPT, and compare what they find.

Starting a subagent returns right away, so you can keep talking to your agent. Running subagents show live above the editor with their model, token use, and time. When one finishes, its report lands in your conversation and wakes your agent. Your agent can steer running subagents, or resume finished ones, by sending them messages. With codemode, it can also script many subagents and pass on only what matters.

There are two subagent types: `explore` for research, review, and verification, told not to change the project or publish anything (an instruction, not a security sandbox), and `general-purpose`, the default, for work that changes things. A subagent uses the same model as your agent unless your agent picks another.

To steer subagent usage and model choices, add guidance to your `AGENTS.md`, for example:

```markdown
## Subagents

Delegate to subagents only when asked. Choose model and thinking level by task:

- Complex implementation or research: `gpt-6.1-sol:medium`
- Well-specified edits to 1–3 files: `gpt-6-luna:low`
- Reviews: `claude-opus-5-5:high` or `gpt-6.1-sol:high`
```

## Configuration

Optional. Set any of these under `basicSubagents` in `~/.pi/agent/settings.json`, or in `.pi/settings.json` in a trusted project, which overrides it per setting:

```json
{
  "basicSubagents": {
    "maxConcurrent": 5
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `maxConcurrent` | `20` | How many subagents can run at once per session. |
| `maxDepth` | `1` | How many layers of subagents are allowed below your session. At `1`, subagents can't start their own. |

## Compared to other subagent packages

The most used pi subagent packages, and the example that ships with pi, as of October 2026 ([`pi-subagents`](https://github.com/nicobailon/pi-subagents) 0.78.0, [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) 0.22.0, [`pi-subagent-manager`](https://github.com/championswimmer/pi-subagent-manager) 0.29.1, pi's [`subagent` example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) in 1.3.0):

| | pi-basic-subagents | pi-subagents | @tintinweb/pi-subagents | pi-subagent-manager | pi's example |
|---|---|---|---|---|---|
| Subagent runs as | its own pi process | inside your pi process (foreground) or a separate runner (background) | inside your pi process | inside your pi process | its own pi process |
| Gets your extensions, MCP, skills, AGENTS.md | yes | depends on agent and mode | yes; AGENTS.md only in `general-purpose` | your conversation and tools; no skills or AGENTS.md | yes |
| Setup | none | none (7 built-in agents) | none (3 built-in agents) | none (6 built-in agents) | agent files and symlinks |
| Custom agents, per-agent tools and model | no | yes | yes | yes | yes |
| Model-facing tools | 3, plus 2 for codemode scripts | 1 main, plus helpers | 3 | 8 | 1 |
| Background runs, reports wake your agent | yes | yes | yes | optional | no (blocks) |
| Steer / stop / resume | yes / yes / yes | yes / yes / except stopped | yes / UI only / up to 10 min after it finishes | yes / yes / yes | no / no / no |
| Subagent can ask your agent questions | no (stops and reports) | yes | no | no | no |
| Workflows & orchestration | via codemode | custom scripts, parallel, lanes | custom scripts, parallel, pipelines | nested subagents | parallel, chains |
| Manage git worktrees | no | yes | yes | no | no |
| Source lines | ~980 | ~101k | ~21k | ~13k | ~1.1k |

## FAQ

**Why model the tools on Claude Code's subagent tools?**

Many models have seen Claude Code's subagent tools in training, so they already know the pattern: a self-contained brief, a type, a short description, results that arrive later, and a message to follow up. Using the same shape and parameter names (`subagent_type`, `prompt`, `description`) means your agent delegates well without long instructions.

**Why is there no tool for my agent to wait for subagents?**

So you can keep talking to your agent. Given a wait tool, models tend to call it right after starting subagents, and you're shut out until they finish; Claude Code removed its wait tool for the same reason. Instead, each report wakes your agent when it arrives, and waiting happens only in codemode scripts. The [research memo](docs/research/2026-10-20-subagent-waiting.md) compares how Claude Code, Codex, and other pi packages handle this.

**How do subagents work in codemode?**

Scripts get two tools of their own that wait, like `await agent()` in Claude Code's workflows: `subagent_run` starts a subagent and returns its report, and `subagent_continue` resumes one with a message and returns its next report. A script can fan out with `Promise.all` and return only what your agent needs. While it runs, your agent is busy, as with any long tool call, and stopping it (Esc) stops its subagents. Past `maxConcurrent`, calls fail, so batch big fan-outs.

**Why one-way communication? What if a subagent gets stuck?**

A subagent works in the background, where nobody is watching to answer questions, and your agent, busy with its own work, is a poor stand-in. So a subagent makes routine judgment calls itself and states its assumptions in its report. At a decision that would change the outcome, it stops and reports what needs deciding. Your agent, or you through it, answers with a message, which resumes the subagent with its full history. Extension dialogs in a subagent are cancelled for the same reason.

**Is `explore` read-only?**

No. It's told not to change the project or publish anything, but it has the same tools as any pi session. Read-only work often needs to run code and write temporary files: even scripting a few commands together takes `bash`, and `bash` can edit any file. For enforced limits, use a sandbox or a permission system.

**Can two subagents work on the same files?**

They can, and they can collide: subagents work in your project directory, not a copy, so that your project's settings and trust apply to them. Give parallel subagents separate files, or ask for isolation when you delegate: a `general-purpose` subagent can create a git worktree and work there.

**Can I see what a subagent did?**

Expand its report (Ctrl+O) for the transcript path. `pi --session <path>` opens it; to continue the work yourself, use `pi --fork <path>`, which leaves the original for your agent to resume.

**What happens to running subagents when I quit pi?**

They're stopped. Their ids remain valid when you reopen the session, so your agent can resume them with a message.

## Learn more

- [docs/spec.md](docs/spec.md): exactly how the tools and subagents behave
- [docs/ux.md](docs/ux.md): what it draws and why
- [CONTRIBUTING.md](CONTRIBUTING.md): how it works, developing, and releasing

## License

[MIT](LICENSE)
