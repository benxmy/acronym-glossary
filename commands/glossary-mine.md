---
description: Mine acronyms out of documents into the local glossary
argument-hint: <paths...> [--source=tag]
allowed-tools: Bash(node:*), Read
---

Mine `$ARGUMENTS` as a dry run first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mine.js" $ARGUMENTS --dry-run
```

Show the user the proposed entries and the unmatched count. Ask before writing. If they
approve, re-run the same command without `--dry-run`, then tell them where the
unmatched shortlist was written so they can fill in the entries the initials-match
filter could not confirm.

The unmatched shortlist is a report of the most recent run only — it is rewritten every
time the miner runs, not appended to. If the user has more than one source they care
about, mine all of them in a single invocation rather than one path at a time, or an
earlier run's shortlist will be silently overwritten.
