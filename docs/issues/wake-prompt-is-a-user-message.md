# The wake prompt shows up as something the user typed

> **open — action needed** (raised 2026-10-15). The prompt that wakes the parent for reports appears in the conversation as a user message, though the user never typed it. Frames the problem only; whoever picks it up decides the fix.

## Situation

When reports arrive while the parent is idle, they're appended as a custom message, and then a fixed prompt wakes the parent ([spec §3](../spec.md#3-reports)). The prompt goes through `pi.sendUserMessage` so it takes pi's normal prompt path, including other extensions' `before_agent_start` handlers.

## What is wrong

The wake is drawn in the conversation as a user message: "Subagent reports arrived above. Continue the task they belong to, or report to the user." The user sees words attributed to them that they never typed, once per wake. The wake is plumbing; ideally the user wouldn't see it at all, and the report block alone would show that something arrived.

Secondarily, the wake is recorded in the session as a `role: "user"` message, so anything that reads the transcript for the user's intent counts it as an instruction. A permission reviewer or sandbox that judges actions against the user's messages would read the newest one as the user telling the agent to continue, and the wake can push the user's real latest instruction out of a tight budget.

## When it bites

Every session that receives a report while idle.

## Related

- [spec §3](../spec.md#3-reports)
- `WAKE_TEXT` and `deliver()` in `src/index.ts`
