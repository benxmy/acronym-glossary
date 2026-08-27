#!/usr/bin/env node
// Expand each known acronym on its first mention.
//
// Usage:
//   node scripts/expand.js <file> [--write] [--domain=d] [--scope=s] [--json]
//
// Dry run by default. Exit codes: 0 nothing pending or changes applied, 1 changes
// pending in a dry run, 2 usage error or a failure to read the file or the glossary.
// That plus --json is what makes this usable from a hook later without building the
// hook now.

import fs from 'node:fs';
import path from 'node:path';
import { byAcronym, loadGlossary, rankOf } from './glossary.js';
import { findOccurrences } from './match.js';

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
// job and rewriting would only repeat it.
export function alreadyExpanded(text, index, expansion) {
  return text.slice(0, index).toLowerCase().includes(expansion.toLowerCase());
}

export function planExpansions(text, entries, hint = {}) {
  const index = byAcronym(entries);
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
          meanings: resolved.candidates.map((e) => e.expansion),
        });
      }
      continue;
    }
    if (alreadyExpanded(text, occ.index, resolved.entry.expansion)) continue;
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

  if (flags.json) {
    const key = flags.write ? 'applied' : 'pending';
    console.log(JSON.stringify({ file, [key]: changes, ambiguous }, null, 2));
  } else if (!changes.length && !ambiguous.length) {
    console.log('nothing to expand');
  } else {
    for (const c of changes) console.log(`${c.acronym} → ${c.replacement}`);
    for (const a of ambiguous) {
      console.log(`? ${a.acronym} left alone, ${a.meanings.length} meanings: ${a.meanings.join('; ')}`);
    }
  }

  if (flags.write) {
    if (changes.length) fs.writeFileSync(file, applyExpansions(text, changes));
    return 0;
  }
  return changes.length ? 1 : 0;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
