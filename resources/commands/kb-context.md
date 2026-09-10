Load project background from the knowledge library BEFORE starting a task.
1. Call memory with aggregate=doc for the task's domain; read the top 3-10 docs by path under the Knowledge Library source.
2. Extract: key constraints, past decisions, current state, open questions/risks.
3. Cite every claim with the hit's docId (library) or path:lineRange.
4. Summarize the loaded context in <=10 lines, then proceed with the user's task.
Rules: never trigger a reindex (indexing is app-owned); if memory signals the index is unavailable, fall back to grep over the library root. Atomic single-sentence facts belong to the remember tool, not the library.
