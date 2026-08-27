---
description: Expand each acronym on first use in a document, using the local glossary
argument-hint: <file> [--write] [--domain=d] [--scope=s]
allowed-tools: Bash(node:*), Read, Edit
---

Run the expander on `$ARGUMENTS` and report what it found:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/expand.js" $ARGUMENTS --json
```

Then:

1. Summarise the `pending` rewrites for the user.
2. List every `ambiguous` acronym with its competing meanings, and ask which is meant.
   Do not choose on the user's behalf.
3. Apply the pending rewrites only if the user asked for them to be written, or if
   `--write` was already among the arguments.
