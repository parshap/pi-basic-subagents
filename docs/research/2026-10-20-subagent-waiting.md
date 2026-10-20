# How subagent systems keep models from blocking on subagents

> **Status: settled (2026-10-20).** Prompted by models calling `subagent_wait` on every subagent right after starting them, which kept the user from talking to the agent until all were done. Outcome: adopted Claude Code's model: no wait tool for the model, reports wake it, and waiting happens in scripts through their own tools. Informs [spec §1–§3](../spec.md) and the README FAQ. Findings are as of the date and are not updated.

## Question

Why do models reflexively wait on background subagents with our tools but not with others', and what do Claude Code, Codex, and popular pi subagent packages do about it: tool shapes, model-facing wording, notifications, cancellation, and reopened sessions?

## Findings

**The cause was our wording, not model behavior.** `subagent_start`'s description said to "call subagent_wait when you need it before continuing", its result never said the model could end its turn, `subagent_wait` with no arguments waited for every subagent, and the capacity error pointed at `subagent_wait`. Models nearly always think they need the result.

**Claude Code removed its blocking wait tool.** `TaskOutput` (`block` defaulting to true) was added in 2.0.60, steered away from in 2.1.15, and gone by 2.1.83. Agents run in the background by default since 2.1.198. What replaced it:

- One instruction repeated wherever the model decides, most pointedly in the launch result: "You will be notified automatically when it completes — do NOT sleep, poll, or proactively check… Continue with other work or respond to the user." Some variants: "briefly tell the user what you launched… and end your response." The reason given is the user: "so the user can hand you other work."
- Foreground (`run_in_background: false`) only "when your very next action depends on the result and nothing else could usefully happen"; "Wanting the result 'next' is not enough on its own." Typing during a foreground call moves it to the background.
- No-peeking and no-guessing rules: don't read or tail the JSONL transcript ("reading it will overflow your context"); before the notification, "you know nothing about its results".
- Status checks: none for the model. "If the user asks for progress, say the agent is still running." The user watches progress in the UI.
- Notifications are user-role `<task-notification>` messages, marked as not user input, queued for the next turn, waking an idle session.
- Workflows (`Workflow` tool) run a script as one background task. Inside it, `await agent(prompt, opts)` is the only wait; there is no steer, resume, or stop in scripts. Aborting a workflow aborts its agents.
- On resume, agents the previous process left running get one queued notification without a wake: "It was running when the previous Claude Code process exited and did not complete… Resume it by sending it a message with SendMessage…"

**Codex (openai/codex main, 2026-10-19)** keeps a wait tool but fences it: "Call wait_agent very sparingly. Only call wait_agent when you need the result immediately for the next critical-path step and you are blocked until it returns." "Do not repeatedly wait by reflex." Its wait needs explicit targets and returns when the first finishes. Waking an idle parent on agent messages (`wake_on_agent_messages`) defaults off. It also prefers long waits, which reduces polling but not blocking, and a repository orchestrator template says "wait for them before yielding", the opposite of what we wanted.

**pi packages:**

- `pi-subagents` 0.78.0 puts the instruction in every async launch result: "Detached. Return control now: native completion wakes you, so do not sleep, poll, or call bg_wait for it." Its `bg_wait` description reserves it for work without native notification, and a user message ends an open `bg_wait`.
- `pi-subagent-manager` 0.29.3 states the reason best: "end your turn so you remain free to talk to the user while they work", and in orchestration mode "you must NEVER be blocked waiting for subagents." Its tool descriptions still suggest launch-all-then-wait, undercutting the prompt.
- `@tintinweb/pi-subagents` 0.22.0 allows foreground only when the next action depends on the result and nothing else could happen, then its running-result text says "Use wait: true or check back later", undercutting that too.
- pi's own `subagent` example (1.3.0) is synchronous only.

**Lesson across all of them:** the instruction works where the model decides what's next (the launch result) and fails if any other string (an error, a result, a template) suggests waiting.

## What we did with it

- Removed `subagent_wait`. The model's tools (`subagent_start`, `subagent_message`, `subagent_stop`) never block and are `model-only`; their results say the report will wake the model and to do other work or end its turn. The capacity error no longer points at waiting.
- The wake names subagents still running, since a wake with part of a batch is when models reach for a wait.
- Scripts wait through their own `codemode`-exposed tools, `subagent_run` and `subagent_continue`, like Claude Code's `agent()`, so each tool describes one behavior. Cancelling a script's call stops its subagent, as aborting a workflow does.
- A reopened session tells the model, without a wake, about runs cut short and reports it missed, briefly, with each report kept in a file.
- The transcript path is left out of model-facing reports.
- Not adopted: Claude Code's examples, its no-guessing rule, and brief-writing guidance, for length and because we hadn't seen those failures; a user message ending script waits, because cutting a script short would flood the parent with the reports the script was keeping out of context.

## Shelf life

The pattern (no model-facing wait, the instruction in the launch result, no contradicting strings) is durable. Version numbers, verbatim wording, and Codex's defaults are dated and will drift.

## Sources

- Claude Code `@anthropic-ai/claude-code` 2.1.303 (2026-10-18), JS extracted from the native linux-x64 binary; `cli.js` from 2.1.14 for `TaskOutput`; Piebald-AI/claude-code-system-prompts at 2.1.302.
- openai/codex at `89461ea6833832b0551ce24ee32205824d5c108d` (2026-10-19), `codex-rs` multi-agent tool handlers and prompts.
- npm: `pi-subagents` 0.78.0, `@tintinweb/pi-subagents` 0.22.0, `pi-subagent-manager` 0.29.3, `@earendil-works/pi-coding-agent` 1.3.0 `examples/extensions/subagent`.
