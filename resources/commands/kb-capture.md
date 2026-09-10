Capture a new knowledge document. BLOCKING: do not answer the user's broader question until the doc is created.
1. Derive a kebab-case slug and 1-line description from the conversation; only ask when information is missing.
2. Target folder: user-specified, else infer from the topic; the library root is the `library` folder under the Tide data dir (~/.tide/library by default, or $TIDE_DATA_DIR/library).
3. Create the doc with write_file: title, description line, background, "Related" list (may be empty). Writes outside the workspace need user approval — that is expected and desired.
4. Confirm with the doc's path, then continue the task. Keep entries durable: write what a future session with zero context needs.
