<!--
name: "Data visualization"
description: "Chart design guidelines and mermaid diagram rules."
tideVersion: "1.0.0"
-->
# Diagrams
When explaining flows, architecture, data pipelines, authentication sequences, state machines, or any multi-step process, include a mermaid diagram. Use the appropriate diagram type:
- `sequenceDiagram` for request/response flows, auth flows, API calls
- `flowchart TD` or `flowchart LR` for decision trees, branching logic, pipelines
- `graph` for architecture overviews, component relationships
- `classDiagram` for data models, entity relationships
- `stateDiagram-v2` for state machines, lifecycle transitions

Wrap the diagram in a fenced code block with language `mermaid`. Keep diagrams readable (max ~20 nodes). Place the diagram BEFORE the text explanation so the user sees the visual first.

**Mermaid syntax rules (violations cause render failures):**
- Every line inside a diagram MUST be valid syntax — no bare comments, labels, or prose
- In `flowchart`/`graph`: every node MUST have brackets: `NodeName["Label"]`, not bare text
- In `classDiagram`: do NOT use ER relationship syntax (`||--o{`). Use `A --> B` or `A "label" --> B`
- In `classDiagram`: relationships are `-->`, not `||--||` or `}o--||`
- Node labels with special chars must be quoted: `Node["has spaces / slashes"]`
- Do NOT mix diagram types — a `classDiagram` cannot contain `erDiagram` relationships
- Use `<br/>` for line breaks inside quoted labels, never a literal newline
- Avoid HTML entities (`&amp;`, `&lt;`, `&gt;`) inside labels — use the raw character (`&`, `<`, `>`)
- **NEVER use `end` as a node id or node name.** `end` is the block terminator keyword: `end[Finish]` or `A --> end` breaks the whole parse. Use `Finish[Finish]` or `Terminal`.
- **Subgraph titles with spaces must be quoted:** `subgraph "Main Flow"`. Bare `subgraph Main Flow` fails.
- **No inline `%%` comments after code** (`A --> B %% note`). `%%` comments must be full lines; trailing ones derail the lexer.
- **Do NOT emit `style`, `classDef`, `class`, `linkStyle`, or `click` lines.** A style rule referencing a node id that doesn't exist (typo, renamed, hallucinated) fails the entire render. Plain nodes and edges only.
- **NEVER put braces `{ }` in sequenceDiagram message text.** Mermaid treats `{` as a block opener and the parser fails. Instead of `API-->>A: { data: currentUser }`, write `API-->>A: data: currentUser` or `API-->>A: returns currentUser data`. This applies to ALL message lines (`->>`, `-->>`, `--)`, `-x`).
- In `sequenceDiagram`: keep messages as plain text. Avoid `()`, `?`, `...`, and `{}` in message content unless absolutely necessary — describe the action in words instead.

**Generating diagrams — the critical rule:**

> **You MUST output the ENTIRE diagram from start to finish without stopping.** Once you open a ` ```mermaid ` fence, you commit to closing it. Never pause, never break, never interleave prose mid-diagram. An incomplete diagram renders as nothing — the user sees a broken placeholder, not your intent.

- **Plan the full diagram mentally before writing the first line.** Know every node, every edge, every `end` keyword before you start.
- **Count your `subgraph`/`alt`/`opt` opens and match each with an `end`.** Unbalanced blocks are the #1 render failure. Before closing the fence, verify: every `subgraph`, `alt`, `opt`, `rect`, `box` has a matching `end`.
- **Generate the complete block in one shot.** Do not split across multiple code blocks. Do not write prose between fence-open and fence-close.
- **Close immediately after the last line.** The closing ` ``` ` goes on the line directly after the final diagram line — no trailing blank lines inside the fence.
- **If the diagram is getting long (>30 lines), stop and simplify.** A compact 10-line diagram that renders beats a 60-line diagram that fails. Split a complex process into 2–3 smaller diagrams with a sentence between them.
- **Do not emit `%%{init}%%` directives or `init:` lines.** The renderer configures its own theme; init directives conflict with it and break rendering.
- **Double-check bracket balance before closing.** Every `[`, `{`, `(` opened in a label must be closed with `]`, `}`, `)` on the same line.

# Data visualization guidelines
When creating charts, dashboards, or data visualizations, follow these rules.

## Choosing a form
Decide the chart type from the data's job, not the other way around:
- Single value + trend → **stat tile** (value + delta + sparkline), not a one-bar chart
- A few headline numbers → **KPI row** of stat tiles
- Comparison across categories → **bar chart** (horizontal if labels are long)
- Trend over time → **line chart** (or area if cumulative)
- Part of a whole → **stacked bar** or **donut** (max 5 slices)
- More than ~7 categories → **table** or table + chart, not more colors
- Correlation between two variables → **scatter plot**

## Anti-patterns — check every chart against this list
- **Dual-axis charts** (two y-scales): the alignment is arbitrary and invents fake correlations. Use two charts or index both series to a common base.
- **Recolor-on-filter**: colors must follow the entity, not its rank. Filtering out a series must not repaint survivors.
- **3D charts**: never. They distort proportions and add no information.
- **Pie with >5 slices**: switch to a bar chart or treemap.
- **Rainbow palettes for sequential data**: use a sequential single-hue ramp instead.
- **Missing zero on bar/line axes**: bars must start at zero; truncating the y-axis misleads.
- **Overplotting scatter**: use transparency, aggregation, or a hex bin.

## Color rules
- Use a **consistent palette** — assign colors by entity, not by row position.
- For sequential data: single-hue ramps (light → dark).
- For categorical data: maximally distinct hues, max 7 before switching to a table.
- Always provide a **light/dark mode** variant.
- Never rely on color alone — add labels or patterns for accessibility.
