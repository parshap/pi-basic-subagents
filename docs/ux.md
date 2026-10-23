# UX

What pi-basic-subagents draws, and the rules every surface follows: its design language. What the tools do is in [spec.md](spec.md). The aim is that a subagent looks the same wherever it appears, and that our output reads like the rest of pi.

## Principles

- **Pi owns the frame.** We never choose a background. Tool blocks use pi's tool shell, and reports use pi's custom-message background, so each item looks like every other item of its kind.
- **Color means status.** Only a subagent's status is colored. Everything else is plain text, muted, or dim.
- **Shared Run line.** Live status and finished summaries use the same Run line; the widget counts what doesn't fit.
- **Collapsed is a summary, expanded is everything.** Collapsed views are single lines cut to the width; expanded views show the full input or output. Expansion follows pi's global toggle (Ctrl+O), plus a click where pi provides one.
- **Content is for the model, details are for rendering.** Renderers draw from structured `details` and tool arguments, never by parsing the text the model reads. That text must stand on its own in print, JSON, and RPC modes, where nothing is rendered.
- **Theme tokens only.** No literal colors, and no text left in the terminal's default color, so light and dark themes work.

## Shapes

### Run line

The atom: one subagent on one line.

```
● sa-1a2b Audit auth flow · bash · 1m12s
✓ sa-1a2b Audit auth flow · completed
```

`<glyph> <id> <description> · <state>`

- **id** bold, **description** text.
- **state** is the current tool or `thinking` while running, and the status word once done. Failed rows add the error's first nonempty line after `failed:`. The model, the child's current context size (`132.3k ctx`), and elapsed time follow, with time last; missing metrics are omitted.
- **Expanded details** show the full model name. Duration covers the latest launch and freezes when it finishes.
- Cut to the width with a `muted` `…`; never wraps.

### Widget

Live Run lines for running and recently finished subagents, above the editor, in start order. No background, no header. Present only while it has rows; it's the only live surface.

```
✓ sa-1a2b Audit auth flow · completed · opus-5-5:high · 72.1k ctx · 48s
● sa-3c4d Map callers · bash npm test --wat… · opus-4-1:high · 132.3k ctx · 1m12s
```

- **Finished rows stay until the parent ends a turn that has their reports** (the wake, or one whose script got them), so a batch shows its progress and clears once the parent has dealt with it. A stopped subagent leaves at once: whoever stopped it already knows.
- **At most 5 lines.** With more than 5, it shows 4 rows in start order, preferring running subagents over finished ones, then a line counting the rest by status: a `muted` `+N more`, then each status's glyph and `muted` count and name (`+16 more · ● 15 running · ✗ 1 failed`). It stays short, so a failure isn't cut off at usual widths.
- **The model's short name** follows the activity/status: omit everything through the last `/`, a leading `claude-`, and a trailing `-latest` or date snapshot (`-YYYYMMDD` or `-YYYY-MM-DD`), keeping the `:thinking` suffix.
- **The current tool's arguments** follow its name: string arguments on one line, `path` first. They take only the width the rest of the line leaves, so they never push anything off, and they're left out when fewer than 3 columns are free besides the space before them. Control characters show escaped (`\x1b`), so arguments can't drive the terminal. With parallel calls, it's the latest one still running.
- The tool name is part of the muted state here, not `toolTitle`.

### Tool block

One per tool call the parent model makes, drawn inside pi's tool shell.

- **Header** (`renderCall`): the tool name in pi's `toolTitle` bold, then its subject. Collapsed it fits on one line; expanded it wraps and shows every argument in full.
- **Body** (`renderResult`): the outcome. Collapsed is a summary with one dim expansion hint; expanded is the full result without a hint.

| Tool | Header, collapsed | Header, expanded | Body, collapsed | Body, expanded |
|---|---|---|---|---|
| `subagent_start` | description · model, then the first 2 lines of the prompt (muted) | all arguments, the prompt as Markdown | `Started <id>.` | same acknowledgment |
| `subagent_message` | id, then the first line of the message (muted) | the full message | `message sent to running subagent` or `subagent resumed with message` | same |
| `subagent_stop` | id | same | the Run line with its status | Run line, model, transcript link, any failure reason |

The widget shows current state; tool results and reports show what they returned and never change.

### Report block

A finished subagent's report, delivered as a custom message. It's the subagent speaking into the conversation, not a tool call, so it uses pi's custom-message frame.

- **Collapsed**: per report, a Run line and one muted preview line from the result, followed by one dim expansion hint for the block.
- **Expanded**: per report, the Run line, full model, the transcript path as a link, any failure reason, then the result as Markdown. Reports are separated by a blank line.

### Toast

`ui.notify`, only for problems with the extension itself: invalid settings, reports that couldn't be delivered. Never for the normal lifecycle, which the other shapes already show.

### Wake message

Not ours to style: a short user message that starts the parent's turn when reports arrive while it's idle. Pi renders it as a user message, and extensions can't change that.

## Color

### Backgrounds

| Background | Used by | Means |
|---|---|---|
| `toolPendingBg` | Tool block, while its call runs | the model's action is in progress |
| `toolSuccessBg` | Tool block, once the call succeeds | the model's action finished |
| `toolErrorBg` | Tool block, when the call throws | the model's action failed (e.g. a subagent failed to start) |
| `customMessageBg` | Report block | something arrived from outside the conversation |
| none | Widget, Run lines inside other shapes | |

Pi applies these; we only pick the shape. A tool block's background is about the tool call, not the subagent: a `subagent_stop` that finds a failed subagent still succeeded.

### Status

| Status | Glyph | Color |
|---|---|---|
| running | `●` | `accent` |
| completed | `✓` | `success` |
| failed | `✗` | `error` |
| stopped | `■` | `warning` |

The glyph, status word, and short failure reason take the color; metadata stays muted.

### Text

| Role | Token |
|---|---|
| Tool names | `toolTitle`, bold |
| Primary text (ids, descriptions) | `text` |
| Markdown bodies (prompts, messages, results) | `toolOutput` in tool blocks, `customMessageText` in report blocks, as in pi's own |
| Secondary metadata (model, context size, elapsed, separators) | `muted` |
| Hints (`(ctrl+o to expand)`, from pi's keybinding) | key `dim`, the rest `muted` |

## Copy

- Status words are lowercase: `running`, `completed`, `failed`, `stopped`.
- Ids are shown as given: `sa-1a2b`.
- Fields are separated by ` · `.
