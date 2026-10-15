# Design language

What pi-basic-subagents draws, and the rules every surface follows. The aim is that a subagent looks the same wherever it appears, and that our output reads like the rest of pi.

## Principles

- **Pi owns the frame.** We never choose a background. Tool blocks use pi's tool shell, and reports use pi's custom-message background, so each item looks like every other item of its kind.
- **Color means status.** Only a subagent's status, and the Bar marking a started subagent, are colored. Everything else is plain text, muted, or dim.
- **One line per subagent.** Wherever a subagent is listed (widget, wait results, reports), it's the same Run line.
- **Collapsed is a summary, expanded is everything.** Collapsed views are single lines cut to the width; expanded views show the full input or output. Expansion follows pi's global toggle (Ctrl+O), plus a click where pi provides one.
- **Content is for the model, details are for rendering.** Renderers draw from structured `details` and tool arguments, never by parsing the text the model reads. That text must stand on its own in print, JSON, and RPC modes, where nothing is rendered.
- **Theme tokens only.** No literal colors, and no text left in the terminal's default color, so light and dark themes work.

## Shapes

### Run line

The atom: one subagent on one line.

```
● sa-1a2b explore · Audit auth flow · bash · 1m12s
✓ sa-1a2b explore · Audit auth flow · completed
```

`<glyph> <id> <type> · <description> · <state>`

- **id** bold, **type** muted, **description** text.
- **state** is what the subagent is doing while it runs (current tool or `thinking`, elapsed, its context size in tokens), and its status word once it's done.
- Cut to the width with `…`; never wraps.

### Widget

Live Run lines for running subagents, below the editor. No background, no header. Present only while a subagent runs; it's the only live surface.

### Bar

An `accent` `▌` before every line of a tool block whose call started or resumed a subagent: `subagent_start`, and `subagent_message` when it resumed. Starting a subagent has a bigger side effect than other calls (a new process that works on its own), and the bar marks it without leaving pi's frame. A call that failed has no bar.

### Tool block

One per tool call the parent model makes, drawn inside pi's tool shell.

- **Header** (`renderCall`): the tool name in pi's `toolTitle` bold, then its subject. Collapsed it fits on one line; expanded it shows every argument in full.
- **Body** (`renderResult`): the outcome. Collapsed is a line or a few Run lines; expanded is the full result.

| Tool | Header, collapsed | Header, expanded | Body, collapsed | Body, expanded |
|---|---|---|---|---|
| `subagent_start` (with the Bar) | type · description · model, then the first 2 lines of the prompt (muted) | all arguments, the prompt as Markdown | the new Run line | same |
| `subagent_wait` | the ids (or `all`), the timeout if set | same | a Run line per subagent | each report (see Report block) |
| `subagent_message` (with the Bar if it resumed) | id, then the first line of the message (muted) | the full message | `delivered as steer` or `delivered as resume` | same |
| `subagent_stop` | id | same | the Run line with its status | same |

### Report block

A finished subagent's report, delivered as a custom message. It's the subagent speaking into the conversation, not a tool call, so it uses pi's custom-message frame.

- **Collapsed**: a Run line per report, then a dim `(Ctrl+O to expand)`.
- **Expanded**: per report, the Run line, the transcript path as a link, then the result as Markdown. Reports are separated by a blank line.

### Toast

`ui.notify`, only for problems with the extension itself: invalid settings, reports that couldn't be delivered. Never for the normal lifecycle, which the other shapes already show.

### Wake message

Not ours to style: a fixed, short user message that starts the parent's turn when reports arrive while it's idle. Pi renders it as a user message, and extensions can't change that.

## Color

### Backgrounds

| Background | Used by | Means |
|---|---|---|
| `toolPendingBg` | Tool block, while its call runs | the model's action is in progress |
| `toolSuccessBg` | Tool block, once the call succeeds | the model's action finished |
| `toolErrorBg` | Tool block, when the call throws | the model's action failed (e.g. a subagent failed to start) |
| `customMessageBg` | Report block | something arrived from outside the conversation |
| none | Widget, Run lines inside other shapes | |

Pi applies these; we only pick the shape. A tool block's background is about the tool call, not the subagent: a `subagent_wait` that returns a failed subagent still succeeded.

### Status

Besides status, `accent` marks only the Bar.

| Status | Glyph | Color |
|---|---|---|
| running | `●` | `accent` |
| completed | `✓` | `success` |
| failed | `✗` | `error` |
| stopped | `■` | `warning` |

The glyph and the status word take the color; the rest of the Run line doesn't.

### Text

| Role | Token |
|---|---|
| Tool names | `toolTitle`, bold |
| Primary text (ids, descriptions) | `text` |
| Markdown bodies (prompts, messages, results) | `toolOutput` in tool blocks, `customMessageText` in report blocks, as in pi's own |
| Secondary metadata (type, model, elapsed, tokens, separators) | `muted` |
| Hints (`Ctrl+O to expand`) | `dim` |

## Copy

- Status words are lowercase: `running`, `completed`, `failed`, `stopped`.
- Ids are shown as given: `sa-1a2b`.
- Fields are separated by ` · `.
