# pi-basic-subagents

Minimal subagents for [pi](https://pi.dev), where each subagent is a regular pi session with the same tools and access as your agent, rather than task-specific restricted subagents.

```
● sa-1a2b explore · Audit auth flow · bash · 1m12s
● sa-3c4d general-purpose · Fix flaky upload test · thinking · 24s
```

## Design

- **Just a pi session.** Each subagent runs in your project with your settings, extensions, MCP servers, skills, and `AGENTS.md`, and its transcript is a normal pi session you can open.
- **Nothing to configure.** There are no agent definitions, prompts, or tool lists to write. Install it and ask your agent to delegate to subagents.
- **Familiar to models.** Four tools (start, wait, message, stop) modeled on Claude Code's subagent tools.
- **One-way communication.** Your agent (the parent) sends a prompt and can steer or stop the subagent while it works. The subagent reports back only when it finishes.
- **Built for codemode.** Pi's [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md) lets your agent write dynamic subagent workflows.

## Install

```sh
pi install npm:pi-basic-subagents
```

## Use

Ask for it in plain words; your agent calls the tools:

> Have a subagent research the best queuing approach while you fix the failing test.

> Have two subagents review this work, one using Opus and one using GPT, and compare what they find.

Starting a subagent returns right away, and running subagents show live below the editor. When one finishes, its report lands in your conversation and your agent picks it up. Your agent can steer running subagents, or resume finished ones, by sending them messages.

There are two subagent types: `explore` for research, review, and verification, told to leave the project as it found it (an instruction, not a security sandbox), and `general-purpose` for work that changes things. A subagent uses the same model as your agent unless your agent picks another.

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

## FAQ

**Why model the tools on Claude Code's subagent tools?**

Many models have seen Claude Code's subagent tools in training, so they already know the pattern: a self-contained brief, a type, a short description, results that arrive later, and a message to follow up. Using the same shape and parameter names (`subagent_type`, `prompt`, `description`) means your agent delegates well without long instructions.

**Why one-way communication? What if a subagent gets stuck?**

A subagent works in the background, where nobody is watching to answer questions, and your agent, busy with its own work, is a poor stand-in. So a subagent makes routine judgment calls itself and states its assumptions in its report. At a decision that would change the outcome, it stops and reports `blocked:` with the options. Your agent, or you through it, answers with a message, which resumes the subagent with its full history. Extension dialogs in a subagent are cancelled for the same reason.

**Is `explore` read-only?**

No. It's told to leave the project as it found it, but it has the same tools as any pi session. Per-type tool lists would be one more thing to configure. To restrict tools, start pi itself with `--tools` or `--exclude-tools`; subagents inherit those limits.

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
