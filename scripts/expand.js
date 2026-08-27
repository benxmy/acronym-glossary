#!/usr/bin/env node
// Expand each known acronym on its first mention.
//
// Usage:
//   node scripts/expand.js <file> [--write] [--domain=d] [--scope=s] [--json]
//
// Dry run by default. Exit codes: 0 nothing pending or changes applied, 1 changes
// pending in a dry run, 2 usage error or a failure to read the file or the glossary or
// to write the file back. That plus --json is what makes this usable from a hook later
// without building the hook now.

import fs from 'node:fs';
import path from 'node:path';
import { byAcronym, loadGlossary, rankOf } from './glossary.js';
import { buildMatcher, findOccurrences, inRanges, skipRanges } from './match.js';

/**
 * Which meaning to use — or none. This never guesses:
 *   one candidate           → use it
 *   several                 → narrow by the domain, then the scope hint
 *   still several           → best source rank wins
 *   still tied at that rank → ambiguous; the caller leaves the text alone
 *
 * A hint that matches nothing is ignored rather than emptying the pool: a wrong hint
 * should not silently suppress every expansion in the document.
 */
export function resolveMeaning(candidates, { domain, scope } = {}) {
  let pool = candidates.filter((e) => e.expand !== false);
  if (!pool.length) return { entry: null, reason: 'suppressed' };
  for (const [key, want] of [['domain', domain], ['scope', scope]]) {
    if (pool.length > 1 && want) {
      const narrowed = pool.filter((e) => e[key] === want);
      if (narrowed.length) pool = narrowed;
    }
  }
  if (pool.length === 1) return { entry: pool[0], reason: 'unique' };
  const best = Math.min(...pool.map((e) => rankOf(e.source)));
  const top = pool.filter((e) => rankOf(e.source) === best);
  if (top.length === 1) return { entry: top[0], reason: 'source-rank' };
  return { entry: null, reason: 'ambiguous', candidates: top };
}

// Spelled out earlier in the document already? Then the first mention has done its
// job and rewriting would only repeat it. An appearance inside a skip region (code,
// a link, a bare URL, frontmatter) doesn't count — a config sample or a link title
// that happens to contain the spelled-out phrase is not a prose use, and treating it
// as one would silently swallow the document's real first mention. All four skip-
// region kinds are treated the same way here, uniformly, even the ones a reader does
// technically see rendered (link text, a frontmatter title): the alternative is a
// carve-out per region kind, and the cost of skipping one redundant expansion is far
// smaller than the cost of silently never expanding at all.
export function alreadyExpanded(text, index, expansion, ranges = skipRanges(text)) {
  const prefix = text.slice(0, index).toLowerCase();
  const needle = expansion.toLowerCase();
  let from = 0;
  let found;
  while ((found = prefix.indexOf(needle, from)) !== -1) {
    if (!inRanges(found, ranges)) return true;
    from = found + 1;
  }
  return false;
}

// An expansion that contains its own acronym cannot be expanded even once safely. The
// rewrite drops the acronym inside the text it inserts, so the next run finds that copy
// as the document's earliest mention, looks for a spelling-out *before* it, finds none,
// and expands again — every --write grows the user's prose by another copy. Guessing a
// repaired expansion would be exactly the guess this codebase declines to make, so such
// an entry is refused and reported instead.
//
// The test is the matcher's own boundary rule, not a substring check: `includes` would
// see SAN inside "Subject Alternative Name" and silently stop a perfectly good entry
// from ever expanding. buildMatcher is used rather than findOccurrences because skip
// regions and the AM/PM guard are prose concerns — an expansion is not prose being
// rewritten, and the meridiem guard could even hide a real self-reference here. The
// regex is built fresh per call, so its /g lastIndex starts clean.
export function isSelfReferential(acronym, expansion) {
  const matcher = buildMatcher([acronym]);
  return matcher ? matcher.test(String(expansion)) : false;
}

/**
 * The plan: what would be rewritten, and what was deliberately left alone.
 *
 * Every entry in `ambiguous` carries the reason it was skipped — `ambiguous` (more than
 * one meaning survived resolution) or `self-referential` (the entry's own expansion
 * contains the acronym, so it is malformed and needs correcting by hand). resolveMeaning's
 * other reasons — `unique`, `source-rank`, `suppressed` — never surface here: the first
 * two produce a change and the third is the user's own `expand: false`, asked for and so
 * not worth reporting.
 */
export function planExpansions(text, entries, hint = {}) {
  const index = byAcronym(entries);
  const ranges = skipRanges(text);
  const firstSeen = new Set();
  const changes = [];
  const ambiguous = [];
  for (const occ of findOccurrences(text, [...index.keys()])) {
    if (firstSeen.has(occ.acronym)) continue;
    firstSeen.add(occ.acronym);
    const resolved = resolveMeaning(index.get(occ.acronym) || [], hint);
    if (!resolved.entry) {
      if (resolved.reason === 'ambiguous') {
        ambiguous.push({
          acronym: occ.acronym,
          index: occ.index,
          reason: resolved.reason,
          meanings: resolved.candidates.map((e) => e.expansion),
        });
      }
      continue;
    }
    // Checked before the already-expanded test, not after: a self-referential entry is
    // malformed whatever the document says, and reporting it must not depend on whether
    // this particular document happens to spell the expansion out earlier.
    if (isSelfReferential(occ.acronym, resolved.entry.expansion)) {
      ambiguous.push({
        acronym: occ.acronym,
        index: occ.index,
        reason: 'self-referential',
        meanings: [resolved.entry.expansion],
      });
      continue;
    }
    if (alreadyExpanded(text, occ.index, resolved.entry.expansion, ranges)) continue;
    // The plural rides inside the parenthesis rather than being grafted onto the
    // expansion: pluralising "Certificate Authority" mechanically would produce
    // "Authoritys", and inventing a plural is exactly the kind of guess this
    // codebase declines to make.
    changes.push({
      acronym: occ.acronym,
      index: occ.index,
      length: occ.length,
      expansion: resolved.entry.expansion,
      replacement: `${resolved.entry.expansion} (${occ.acronym}${occ.plural})`,
    });
  }
  return { changes, ambiguous };
}

// Applied last-to-first so the earlier offsets stay valid.
export function applyExpansions(text, changes) {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, c.index) + c.replacement + out.slice(c.index + c.length);
  }
  return out;
}

function parseArgs(argv) {
  const flags = {};
  const files = [];
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else files.push(arg);
  }
  return { flags, files };
}

export function main(argv) {
  const { flags, files } = parseArgs(argv);
  if (files.length !== 1) {
    console.error('usage: expand.js <file> [--write] [--domain=d] [--scope=s] [--json]');
    return 2;
  }
  const file = files[0];

  // A file that doesn't exist or can't be read is a usage error, not "changes are
  // pending" — 1 already means the latter and is the hook-facing signal that there is
  // work to apply, so this must not be confused with it.
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`expand.js: cannot read ${file} — ${err.message}`);
    return 2;
  }

  // loadGlossary throws (loudly, by design) on a glossary that exists but is
  // unreadable or malformed. That is deliberate upstream, but main() must still return
  // a number rather than let the exception escape, so it's caught narrowly here.
  let entries;
  try {
    ({ entries } = loadGlossary());
  } catch (err) {
    console.error(`expand.js: glossary is unreadable — ${err.message}`);
    return 2;
  }

  const hint = {
    domain: typeof flags.domain === 'string' ? flags.domain : null,
    scope: typeof flags.scope === 'string' ? flags.scope : null,
  };
  const { changes, ambiguous } = planExpansions(text, entries, hint);

  // Write first, report second, so nothing tells the caller "applied" before the bytes
  // are on disk. A failed write is a 2, the same code as the two read failures above,
  // because 1 is the hook-facing "changes pending" signal: a hook that saw 1 here would
  // conclude there was a plan to apply when what actually happened is that the file could
  // not be written. applyExpansions runs outside the try on purpose — the catch covers
  // the I/O and nothing else, so a bug in the rewriter can never be reported as a disk
  // problem.
  if (flags.write && changes.length) {
    const rewritten = applyExpansions(text, changes);
    try {
      fs.writeFileSync(file, rewritten);
    } catch (err) {
      console.error(`expand.js: cannot write ${file} — ${err.message}`);
      return 2;
    }
  }

  if (flags.json) {
    const key = flags.write ? 'applied' : 'pending';
    console.log(JSON.stringify({ file, [key]: changes, ambiguous }, null, 2));
  } else if (!changes.length && !ambiguous.length) {
    console.log('nothing to expand');
  } else {
    for (const c of changes) console.log(`${c.acronym} → ${c.replacement}`);
    for (const a of ambiguous) {
      if (a.reason === 'self-referential') {
        console.log(`? ${a.acronym} left alone: its expansion repeats the acronym (${a.meanings[0]}) — correct that entry by hand`);
      } else {
        console.log(`? ${a.acronym} left alone, ${a.meanings.length} meanings: ${a.meanings.join('; ')}`);
      }
    }
  }

  if (flags.write) return 0;
  return changes.length ? 1 : 0;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
