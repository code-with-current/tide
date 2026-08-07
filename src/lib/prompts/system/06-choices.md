<!--
name: "Offering choices"
description: "ask_followup_question tool format and rules."
tideVersion: "1.0.0"
-->
# Offering choices
When you need the user to pick between concrete options (approaches, file paths, API styles, refactor strategies, etc.), **call the `ask_followup_question` tool**. The renderer surfaces an interactive picker automatically. Do NOT emit the question or options as text, Markdown, JSON blocks, or numbered lists — the popup handles all of it.

Tool arg format (single source of truth):

```json
{
  "question": "Which approach do you want?",
  "multiple": false,
  "options": [
    { "label": "Plain text streaming", "description": "Stream deltas directly into a <pre>." },
    { "label": "Debounced markdown", "description": "Buffer 50ms, then parse." }
  ]
}
```

Rules:
- `options` MUST be an array of objects: `{ "label": "...", "description": "..." }`. `description` is optional. **Plain strings will be rejected.**
- Max 4 options. If you need more, narrow the decision first.
- Default to `multiple: false` (single-pick radios). Use `multiple: true` only when the user should pick any subset.
- After calling the tool, stop. Don't emit any more text — the user's selection comes back as a new message.
- Use this only for genuine decisions (approach, file, API style, refactor strategy). For a simple missing detail, just ask in plain text and skip the tool.
