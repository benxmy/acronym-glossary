# Acronym Glossary

Mines the acronyms out of documents you already have into a local glossary, then
expands each one on its first use when you write. The glossary stays on your machine;
only the mining and expansion engine is public.

Install as a Claude Code plugin, then use `/glossary-mine` and `/expand-acronyms`, or
let the `acronym-glossary` skill do both while you draft.

## Quick start

Copy the starter glossary somewhere the engine will find it:

```bash
mkdir -p ~/.acronym-glossary
cp examples/glossary.example.json ~/.acronym-glossary/glossary.json
```

Mine a directory of your own notes as a dry run first — this only prints what it would
add, it writes nothing:

```bash
node scripts/mine.js ~/notes --dry-run --source=notes
```

Read the proposed entries and the unmatched count, then drop `--dry-run` to write. From
there, run the expander on something you're drafting:

```bash
/expand-acronyms path/to/draft.md
```

It reports a plan — which acronyms it would expand on first mention, and which ones it
found ambiguous and left alone — before it changes anything.

## The initials-match filter

Mining a pile of documents for acronym definitions runs into one problem immediately:
`MFA (Q1 FY27)` and `Jane Doe (MFA)` look exactly like `MFA (Multi-Factor
Authentication)` to a regex that just looks for `ACR (something)`. The filter that tells
them apart is an initials match — the candidate expansion's first letters have to spell
the acronym:

- `MFA (Multi-Factor Authentication)` — accepted. M-F-A.
- `MFA (Q1 FY27)` — rejected. Neither word starts with the right letter.
- `Jane Doe (MFA)` — rejected, for the same reason in the other order.

It is strict on purpose, and the strictness is the point: loosening it to catch more
real expansions would also let the false ones through, and a poisoned glossary is worse
than a small one.

The cost of that strictness is real, though: `FedRAMP` fails the initials check, and
always will — its capital letters don't line up with the words in "Federal Risk and
Authorization Management Program" the way an acronym's would. So do most product names.
This isn't a bug waiting on a smarter regex. It means a hand-curated layer — entries you
write yourself, like the ones in `examples/glossary.example.json` — is a permanent part
of this tool's design, not a stopgap until mining improves. See `docs/DESIGN.md` for the
full set of variants the filter tries (stopwords, hyphens, plurals, version suffixes,
number words) and why each one exists.

## Glossary format and the three file locations

A glossary is a JSON file shaped like `examples/glossary.example.json`: a `version` and
an `entries` array, each entry an `{acronym, expansion, scope, domain, definition,
aliases, source, sourceRef, expand}` object. Uniqueness is on `(acronym, expansion)`,
not on `acronym` alone — `CA` is both Certificate Authority and Conditional Access, and
collapsing those would destroy the information the expander needs in order to know it
should refuse to guess.

Three locations are checked, in this order, and merged rather than the first one
winning outright:

1. `$ACRONYM_GLOSSARY` — an explicit path override
2. `.acronyms/glossary.json` — project-local, safe to commit alongside that project
3. `~/.acronym-glossary/glossary.json` — personal, spans every project you work in

Where the same `(acronym, expansion)` appears in more than one location, the earlier
location's entry wins whole, rather than the two being field-merged. This structure is
what lets the engine stay public while your data stays private: **your own glossary
never belongs in this repo**, and nothing here reads or writes outside the three
locations above.

## Building your own UX

No tooltip view, editor decoration or glossary browser ships in this plugin — see
`docs/DESIGN.md` for why that's a deliberate non-goal rather than an oversight. What
ships instead is the seam those things would be built on: `match.js` and `glossary.js`.

Given a glossary and a block of text, `findOccurrences(text, keys)` tells you every
place a known acronym appears, in document order, with its index, length and whether it
was written as a plural — the skip-region and `AM`/`PM` guard logic is already applied,
so a consumer inherits both for free and shouldn't reimplement either. `byAcronym(entries)`
turns a glossary into a `Map` from acronym to its candidate meanings, best source first.
`entriesFor(text, entries)` narrows a large glossary down to only the entries whose
acronym actually appears in a given piece of text — the cheap way to hand a
several-thousand-entry glossary to a model or a view without paying for all of it.

If you're annotating rendered HTML rather than markdown, the skip-region logic here is
markdown-aware (fenced code, inline code, links, frontmatter); the equivalent for a DOM
is a tag denylist — `code`, `pre`, `a`, `abbr`, `kbd`, `textarea`, `input`, and similar.
Leave links alone regardless: a tinted, underlined acronym sitting inside a link is two
affordances fighting each other for the reader's attention.

## Known limitations

Stated plainly, so they don't surprise you later:

- **Two-letter acronyms are not mined from prose.** `a Meeting (AM)` would pass an
  initials check just as easily as a real expansion, and ordinary prose contains far too
  many of those to risk it. Two-letter acronyms are still accepted from explicit
  glossary-shaped lines and table rows, where the format itself is the evidence.
- **A plural expands inside the parenthesis, not inside the expansion.** `SAN`s become
  `Subject Alternative Name (SANs)`, not `Subject Alternative Names (SANs)` —
  mechanically pluralizing the expansion (`Authoritys` for `Certificate Authority`)
  would be exactly the kind of guess this tool declines to make.
- **`AM` and `PM` are special-cased.** They're real acronyms in plenty of glossaries and
  they also collide with clock time; a word, digit, or weekday before them is treated as
  a meridiem and left alone.
- **Mining cannot determine `scope`.** It can tell you what an acronym expands to, not
  whether that's an industry standard or something specific to one organisation. Mined
  entries always come in with `scope: null` — set it by hand if you want the distinction.

## Importing an existing glossary

If your acronyms already live in a database or a spreadsheet, you don't need the
miner at all. The glossary format above is plain JSON with a stable, documented shape —
a short script that reads your source and emits entries in that shape is almost always
the fastest path, faster than exporting to a format the miner can read and hoping the
patterns line up. Tag whatever you generate with a `--source`-style value of your own
choosing (mining does the same with `--source=<tag>`), so an import that turns out wrong
can be found and removed as a group rather than picked apart entry by entry.

## Contributing

Nothing organisation-specific belongs anywhere in this tree — no employer name, internal
product name, internal system name, or colleague name, in code, comments, tests,
fixtures, docs, filenames or commit messages. Examples use invented people (`Jane Doe`)
and public standards (`MFA`, `SCIM`, `EAP-TLS`, `SSO`, `SAN`, `FedRAMP`).

Every definition in this repo is written from scratch. Never paste a definition from
another source, even one that looks generic — copied prose is where internal framing
leaks out even of an apparently harmless entry.

See `docs/DESIGN.md` for the reasoning behind all of the above: the initials-match
filter, the three-location merge, the resolve-or-report rule for ambiguous acronyms, and
the non-goals this plugin deliberately doesn't cover.
