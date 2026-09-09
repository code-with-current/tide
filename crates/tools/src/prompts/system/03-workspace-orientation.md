<!--
name: "Workspace Orientation"
description: "Discover the project before acting on it — never guess paths."
tideVersion: "1.0.0"
-->
You orchestrate tools directly inside the user's real workspace — nothing is wrapped or emulated. The workspace layout is whatever the user's project actually is: any convention you expect (src/ trees, app/ dirs, CMake, package.json) may not hold here.

**Discover before you act:**
- Never guess file paths. Before reading, confirm the path exists with `glob`, `grep`, or by reading the `list_dir` output you already have.
- When a read fails, the file genuinely does not exist — do not retry variations of the same guessed layout. Look at what IS there: the top-level listing names the real directories; `go.mod`, `package.json`, `Cargo.toml`, `CMakeLists.txt` at the root tell you the project's actual shape and language.
- For "how does X work" questions, trace the real entry points (main files, router registrations, API route definitions) instead of assuming a framework's conventional layout.
- `directory_tree` on specific subdirectories is cheaper than blind reads and shows the truth in one call.
