---
name: acronym-glossary
description: Use when drafting, revising or reviewing a prose document (design doc, README, spec, report, email) that contains acronyms, or when the user asks to build or update an acronym glossary from their documents. Expands each acronym on first mention using a local glossary, and reports acronyms whose meaning is ambiguous rather than guessing.
---

# Acronym Glossary

Prose full of unexplained acronyms reads as fluent to insiders and as noise to everyone
else. This skill expands each acronym on its first mention, using a glossary built from
the user's own documents.

## Expanding a draft

Run the expander on the file and read its plan before changing anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/expand.js" <file> --json
```

- `pending` lists the rewrites it would make. Apply them by re-running with `--write`,
  which reports the same list under `applied` instead — the key name is how you tell a
  proposal from something already on disk.
- `ambiguous` lists acronyms it refused to expand because more than one meaning
  survived resolution. **Do not pick one for the user.** Show them the competing
  meanings and ask, or pass a hint (`--domain=…` / `--scope=…`) if the document's
  subject makes the right domain obvious. One entry there carries
  `reason: "self-referential"` instead: its expansion repeats its own acronym, so the
  entry is malformed and its expansion needs correcting by hand in the glossary.
- Exit code `1` in a dry run means changes are pending. `0` means nothing to do (a
  missing glossary counts as nothing to do, not an error), and `0` is also what a
  successful `--write` returns. `2` means it did not do what you asked: a usage error, an
  unreadable input file, a glossary that exists but is malformed, or a document it could
  not write back. Never read a `2` as "nothing to expand".

If the document is one you are currently drafting rather than one on disk, apply the
same rule by hand: expand each acronym on first mention only, leave later mentions
short, and never invent an expansion that is not in the glossary. An acronym you cannot
find is a question for the user, not a guess.

## Building or updating the glossary

When the user points at documents to learn from:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mine.js" <paths...> --dry-run --source=notes
```

Show them the dry-run output first — mining is precision-tuned but not infallible, and
it is far cheaper to reject a bad entry now than to find it in a document later. Re-run
without `--dry-run` to write.

Mining reports acronyms it saw but could not defensibly expand to a sibling
`glossary-unmatched.json`. That file is a shortlist for the user to fill in by hand;
this skill does not walk it for them.

## Where the glossary lives

Resolved in order and merged, earlier winning: `$ACRONYM_GLOSSARY`, then
`.acronyms/glossary.json` in the project, then `~/.acronym-glossary/glossary.json`.
Glossary data is the user's own and is never committed to this plugin's repo.

## The rule that matters

Expansions must come from the glossary, and ambiguity is reported rather than resolved.
A confidently wrong expansion is worse than no expansion, because a reader has no
reason to distrust it.
