# Issues

Open problems, one per file and undated: the problem and its evidence, not the fix. Each opens with a banner (`open — action needed` or `open — further research`, the date raised, and one line on the problem), resolves into the spec or a plan, and is then deleted.

- [wake-prompt-is-a-user-message.md](wake-prompt-is-a-user-message.md): the wake for reports shows up as something the user typed
- [no-session-subagents-are-saved.md](no-session-subagents-are-saved.md): a `--no-session` parent's subagents are saved anyway
- [script-calls-past-max-concurrent-fail.md](script-calls-past-max-concurrent-fail.md): a script awaiting more subagents than `maxConcurrent` gets the extra calls rejected
