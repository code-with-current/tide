<!--
name: "directory_tree"
description: "Recursive JSON tree of files and directories."
category: "Files"
tideVersion: "1.0.0"
-->
- `directory_tree` — Get a recursive tree view of files and directories as JSON. Each node has `{name, type, children?}`. Use for understanding project structure at a glance. Max depth 10, max 2000 entries. Path relative to workspace root.
