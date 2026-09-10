Find existing knowledge docs relevant to a query.
1. Derive a short query from the user's request (ask only if impossible).
2. Call memory with the query; if results are thin, retry with aggregate=source to discover which area owns the topic, then aggregate=doc inside it.
3. If memory reports the index unavailable or empty: list the library root with glob, triage by filename + opening lines, and grep narrowly.
4. Present candidates as a short list (docId + title + one-line description). Never trigger a reindex yourself.
