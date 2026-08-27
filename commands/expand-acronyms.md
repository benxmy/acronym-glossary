---
description: Expand each acronym on first use in a document, using the local glossary
argument-hint: <file> [--write] [--domain=d] [--scope=s]
allowed-tools: Bash(node:*), Read, Edit
---

Run the expander on `$ARGUMENTS` and report what it found:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/expand.js" $ARGUMENTS --json
```

The rewrites come back under one of two keys, and which one tells you whether the file has
already changed:

- `pending` — a dry run. Nothing has been written; these are the rewrites it would make.
- `applied` — `--write` was among `$ARGUMENTS`, so **the file has already been rewritten**
  with exactly these changes. There is nothing left for you to apply.

Then:

1. Summarise the rewrites — as a proposal under `pending`, or as a report of what has
   already changed under `applied`.
2. List every `ambiguous` acronym with its competing meanings, and ask which is meant.
   Do not choose on the user's behalf. One case there is not a question for the user: an
   entry reported with `reason: "self-referential"` has an expansion that repeats its own
   acronym, which is malformed — tell them to correct that entry in the glossary by hand.
3. Apply `pending` rewrites only if the user asks for them. Re-run the script with
   `--write` rather than editing the file yourself, so the script stays the one thing that
   decides how a rewrite is made.
