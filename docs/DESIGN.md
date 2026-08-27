# Acronym Glossary — design

**Status:** Approved, ready for implementation

## Problem

Every organisation accumulates acronyms, and every organisation's are different. Prose
written inside one reads as fluent to insiders and as noise to everyone else — including
your future self, and including a new teammate reading a year-old document.

Two jobs follow from that, and they need each other:

1. **Build a glossary from documents you already have.** Nobody is going to hand-write
   several hundred entries. The material is already sitting in notes, wiki exports and
   spreadsheets.
2. **Use it while writing.** A glossary nobody consults is decoration. The highest-value
   moment is at drafting time: expand each acronym on first mention, so the document
   explains itself.

The hard part of (1) is precision. `MFA (Q1 FY27)` and `Jane Doe (MFA)` look exactly
like `MFA (Multi-Factor Authentication)` to a regex. A miner that admits the first two
poisons the glossary, and a poisoned glossary makes (2) actively harmful.

## Goal

A Claude Code plugin that mines your documents into a glossary, then expands acronyms on
first use in prose you write. **The engine is public; your glossary data stays on your
machine.**

## Non-goals (v1)

Decided, not deferred by accident:

- **Interactive lookup** ("what does X mean") as a user-facing feature.
- **Interactive curation** of the unmatched shortlist. Mining reports it; nothing walks
  you through it.
- **Rendered-HTML annotation or hover tooltips.** See "Building your own UX" below —
  the matching rules are exported so you can build this yourself, but no UI ships here.
- **A `PostToolUse` hook** that expands on every markdown write. Not built — but
  `expand.js` gets a `--json` mode and a meaningful exit code, so adding the hook later
  is a settings change rather than a rewrite.
- **Wiki or SaaS connectors.** Bring your own source: export to HTML or CSV and point
  the miner at it.

## Approach

Two surfaces over one shared script:

- **Skill-driven** — `SKILL.md` tells Claude to resolve and expand acronyms while
  drafting, so it happens in the natural writing flow.
- **Deterministic post-pass** — `/expand-acronyms <file>` runs the same script over any
  document, including ones Claude didn't write.

Both call `scripts/expand.js`. The script is the single source of truth for behaviour;
the skill is the thing that remembers to run it.

## Repository shape

Public, MIT, **zero runtime dependencies**, Node 20+, tests on the built-in `node:test`
runner — so zero devDependencies either. Nothing to audit, nothing to keep patched.

```
acronym-glossary/
├── .claude-plugin/plugin.json
├── skills/acronym-glossary/SKILL.md
├── commands/
│   ├── glossary-mine.md
│   └── expand-acronyms.md
├── scripts/
│   ├── extract.js    # candidate extraction + the initials-match filter
│   ├── match.js      # finding known acronyms in text
│   ├── glossary.js   # load / merge / save / entriesFor(text)
│   ├── mine.js       # CLI: documents → glossary + unmatched report
│   └── expand.js     # CLI: draft → first-use expansions
├── test/
├── examples/glossary.example.json
├── README.md
└── LICENSE
```

## The initials-match filter

This is the core idea and the reason the mined data is trustworthy: **a candidate
expansion is only accepted if its first letters spell the acronym.**

It is strict, and the strictness is the point. Several variants are tried, because more
than one convention is in live use:

- **Stopwords, both ways.** `Cost of Goods Sold` is `COGS`, not `COGSO`. Both spellings
  are tried, so either convention matches.
- **Hyphens, both ways.** `EAP-TLS` counts the hyphen as a word break;
  `Cross-domain Identity Management` (in `SCIM`) does not. Every spelling gets tried.
- **Plurals, carefully.** Only a *lowercase* trailing `s` is a plural marker — `SANs`
  reduces to `SAN`, while `RADIUS`, `CORS` and `PKCS` end in a capital `S` that belongs
  to the expansion.
- **Version suffixes.** `SCEPv2` reduces to `SCEP`.
- **Number words.** `Business to Business` matches `B2B`.

### Why a hand-curated layer is mandatory

`FedRAMP` fails the initials check, and always will. So do most product names. This is
not a bug to be fixed — loosening the filter to admit them would admit `Jane Doe (MFA)`
too, and precision is worth more than coverage here. The consequence is architectural:
**mining can never be the only input.** Hand-written entries are a permanent, first-class
part of the design, and they carry a `source` that outranks anything mined.

## Glossary format

```json
{
  "version": 1,
  "entries": [
    {
      "acronym": "SCIM",
      "expansion": "System for Cross-domain Identity Management",
      "scope": "general",
      "domain": "identity",
      "definition": "User-provisioning protocol.",
      "aliases": null,
      "source": "curated",
      "sourceRef": null,
      "expand": true
    }
  ]
}
```

**Uniqueness is on (acronym, expansion), not acronym.** `CA` is Certificate Authority
*and* Conditional Access *and* Chartered Accountant. `SA` is Service Account *and*
Security Association *and* Situational Awareness. Every meaning is its own entry, and
collapsing them would destroy the information the expander needs to know it should not
guess.

`scope` separates industry-standard terms from organisation-specific ones; `domain` is a
coarse grouping; `expand: false` keeps an entry in the glossary but out of the rewriter's
reach.

### File resolution

Three locations, consulted in order and merged, deduped on (acronym, expansion). Where
the same (acronym, expansion) appears in more than one file with differing `definition`,
`domain` or `expand`, **the earlier location wins outright** — its entry is kept whole
rather than field-merged:

1. `$ACRONYM_GLOSSARY` — explicit override
2. `.acronyms/glossary.json` — project-local, committable, shared with your team
3. `~/.acronym-glossary/glossary.json` — personal, spans every project

This merge is what keeps the engine public and your data private. An
organisation-specific glossary lives in `~` and is never committed anywhere; terms
specific to one project ride along in that project's repo.

## Mining

```
node scripts/mine.js <paths...> [--dry-run] [--source=<tag>] [--out=<file>]
```

| Input | Pipeline |
|---|---|
| `.md`, `.txt` | line patterns + parenthetical patterns |
| `.html` | flatten to lines first, then as above |
| `.csv`, `.tsv` | table rows, with header detection |

Line patterns handle `**ACR** — meaning`, `ACR: meaning`, `\| ACR \| meaning \|`, and a
bare `ACR` heading whose meaning is on the next line. Parenthetical patterns handle both
`Multi-Factor Authentication (MFA)` and `MFA (Multi-Factor Authentication)`.

**Two-letter acronyms are excluded from prose scanning.** `a Meeting (AM)` would sail
through an initials check, and prose contains far too many of those to risk it. They are
still accepted from explicit glossary lines and tables.

**Table headers are stronger evidence than initials.** When a header row names the first
column `acronym`, the second column *is* the expansion by construction — which is the
only way `FedRAMP`-shaped entries ever get mined. Without a trusted header, the initials
match is still required.

Every entry is tagged with its `source`, so a pass that turns out to be junk can be
deleted wholesale rather than picked apart.

Acronyms seen with no defensible expansion go to a sibling `glossary-unmatched.json`
rather than being dropped silently. That file is the shortlist worth adding by hand —
reporting it is in scope, walking it is not.

## Expansion

```
node scripts/expand.js <file> [--write] [--domain=<d>] [--scope=<s>] [--json]
```

- Dry run by default, printing a plan. `--write` applies it.
- **First occurrence only.** Later mentions are left alone.
- Rewrites to `Expansion (ACR)`.
- Honours `expand: false`, and treats an already-expanded first mention as done.
- `--json` plus a meaningful exit code makes it hook-ready.

### Regions it must not touch

Inherited from the same instinct as the initials filter — when in doubt, don't:

- fenced code blocks and inline code spans
- URLs and link targets
- YAML frontmatter

### Resolving overloaded acronyms — refuse to guess

1. One candidate meaning → expand it.
2. Several → filter by the `--domain` / `--scope` hint.
3. Still several → rank by `source` precedence: hand-written beats curated beats mined.
4. Still tied at the top precedence → **leave the text untouched and report it as
   ambiguous.**

A glossary of any size will have an acronym with eight meanings. Silently picking one is
worse than doing nothing: it produces a confident, wrong expansion that a reader has no
reason to distrust. The report is what tells the human to disambiguate the glossary or
pass a hint.

### The meridiem guard

`AM` and `PM` are real acronyms in plenty of glossaries — Asset Management, Account
Manager, Product Manager, Preventive Maintenance — and they also collide with clock
time. `Thu AM`, `2026-08-27 AM` and `5:21 PM ET` are meridiems, and expanding them is
the single most likely false positive in ordinary business prose. The test is what comes
before: a digit, a weekday, or a relative day word.

This is the one hardcoded special case in the codebase. It earns its place because the
collision is with something people write constantly.

## Matching rules

`match.js` finds known acronyms in text. Three decisions worth recording:

- **One regex for the whole glossary**, alternatives sorted longest-first — a few
  hundred alternatives in one pass is far cheaper than a few hundred passes, and
  longest-first is what makes `EAP-TLS` win over `EAP`.
- **Boundaries are spelled out rather than using `\b`**, because acronyms contain `.`,
  `/` and `-`, which `\b` treats as boundaries in their own right.
- **A trailing lowercase `s` is captured and preserved**, so `SANs` matches `SAN` and
  the plural survives the rewrite.

## Building your own UX

No UI ships here, and the split is deliberate. `match.js` and `glossary.js` are the seam:
given a glossary and a block of text, they tell you which known acronyms appear, where,
and what each could mean. Hover tooltips, a searchable glossary view, editor decorations
and inline annotation are all views over that answer.

If you are annotating rendered HTML rather than markdown, note that the skip-region logic
here is markdown-aware; the equivalent for a DOM is a tag denylist (`code`, `pre`, `a`,
`abbr`, `kbd`, `textarea`, `input`, …). Leaving links alone matters more than it looks:
a tinted, underlined acronym inside a link is two affordances fighting each other.

## Keeping your data out of this repo

Guidance for contributors, and the rule the project holds itself to:

- The starter glossary in `examples/` is **industry-standard terms only**.
- **Definition prose is written from scratch, never pasted from an internal source.**
  Copied definitions are where internal framing leaks even out of an apparently generic
  entry.
- Fixtures and README examples use invented names and invented organisations.
- Nothing organisation-specific belongs anywhere in the tree. Your own glossary lives at
  `~/.acronym-glossary/glossary.json`, which this repo never sees.

## Importing an existing glossary

If you already have acronyms in a database or spreadsheet, you do not need the miner.
The format above is plain JSON with a stable shape; a short script that emits it is
usually the fastest path, and `--source` lets you tag those entries so they can be
re-generated or removed as a group later.
