<!--
name: "memory"
description: "Semantic search over the RAG index (if enabled)."
category: "Agent"
tideVersion: "1.0.0"
-->
- `memory` — Semantic search over the RAG index (if enabled). Use this FIRST when you need to understand how something works, find where a concept lives, or orient yourself in an unfamiliar codebase. It searches by meaning, not exact strings — so "how do we handle user authentication" or "where is the API client configured" will find relevant code even without knowing the exact function name. Pass a natural-language query and optionally `k` (default 5, max 20). Each result includes file path, line range, symbol name, and source body. If RAG is not enabled, the tool returns a hint instead of failing.
