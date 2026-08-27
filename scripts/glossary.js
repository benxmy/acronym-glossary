// Loading, merging and saving the glossary. Three locations are consulted so the
// engine can be public while the data stays local: an explicit override, a
// project-local file that can be committed alongside a repo, and a personal file that
// spans every project.
//
// Uniqueness is on (acronym, expansion), never on acronym alone. "CA" is Certificate
// Authority AND Conditional Access AND Chartered Accountant. Collapsing those would
// destroy exactly the information the expander needs in order to refuse to guess.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOccurrences } from './match.js';

// Hand-written entries outrank curated ones, which outrank anything mined. Mined
// passes carry arbitrary tags (--source=notes), so everything unlisted ties last.
//
// SOURCE_RANK is exported with no consumer in this repo on purpose: it belongs to the
// documented reuse seam (see "Building your own UX" in the README), so someone writing a
// glossary browser or a tooltip view can order competing meanings exactly the way the
// expander does, instead of re-deriving the precedence and drifting from it.
export const SOURCE_RANK = { manual: 0, curated: 1 };
export const rankOf = (source) => SOURCE_RANK[source] ?? 2;

// Case-insensitive on both halves — dedup keys on meaning, not on how a file happened
// to capitalize it, while entries are still stored and matched with their real casing.
//
// Consequence worth knowing: two entries whose acronyms differ only by case, with
// expansions equal case-insensitively, collapse to one at merge time. The survivor
// keeps whichever spelling came from the earlier location, and the discarded spelling
// is unmatchable afterwards — byAcronym never sees it. That unmatchability comes from
// matching being case-sensitive by design, not from the merge; the merge just inherits
// it, and it's correct to collapse them, since they're the same term.
export function entryKey(entry) {
  return `${String(entry.acronym).toUpperCase()}::${String(entry.expansion).toUpperCase()}`;
}

// The earlier location wins outright: the whole entry is kept rather than field-merged,
// so a project override can't partially inherit a personal definition.
//
// The missing-field guard below is a defensive no-op for lists built by hand or in a
// test, not the enforcement point — readGlossaryFile already rejects a malformed entry
// on the way in, loudly and with a file and index, so nothing reaches this function
// silently dropped. This function stays a pure merge.
export function mergeEntries(lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const entry of list || []) {
      if (!entry?.acronym || !entry?.expansion) continue;
      const key = entryKey(entry);
      if (!seen.has(key)) seen.set(key, entry);
    }
  }
  return [...seen.values()];
}

export function glossaryLocations({ env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const list = [];
  if (env.ACRONYM_GLOSSARY) list.push(env.ACRONYM_GLOSSARY);
  list.push(path.join(cwd, '.acronyms/glossary.json'));
  list.push(path.join(home, '.acronym-glossary/glossary.json'));
  return list;
}

export function readGlossaryFile(file) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  if (!Array.isArray(parsed?.entries)) throw new Error(`${file}: expected an "entries" array`);
  // A dropped entry is the worst failure this tool has: a term the user believes they
  // added, silently missing, with nothing telling them to look. So a malformed entry
  // fails loudly here — where the filename and index are in hand — rather than
  // vanishing quietly in mergeEntries.
  parsed.entries.forEach((entry, i) => {
    if (!entry?.acronym || !entry?.expansion) {
      throw new Error(`${file}: entry ${i} is missing "acronym" or "expansion"`);
    }
  });
  return parsed.entries;
}

export function loadGlossary(opts = {}) {
  const lists = [];
  const files = [];
  for (const file of glossaryLocations(opts)) {
    const entries = readGlossaryFile(file);
    if (entries) { lists.push(entries); files.push(file); }
  }
  return { entries: mergeEntries(lists), files };
}

export function saveGlossary(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = [...entries].sort((a, b) =>
    a.acronym.localeCompare(b.acronym, 'en', { sensitivity: 'base' })
    || a.expansion.localeCompare(b.expansion, 'en', { sensitivity: 'base' }));
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
}

// Acronym exactly as stored → its entries, best candidate first. Keyed on the stored
// spelling rather than an uppercased form because matching is case-sensitive.
export function byAcronym(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = String(e.acronym);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  for (const list of map.values()) {
    list.sort((a, b) => rankOf(a.source) - rankOf(b.source) || a.expansion.localeCompare(b.expansion));
  }
  return map;
}

// Only the entries whose acronym actually appears. A several-thousand-entry glossary
// then costs a few hundred tokens to consider, rather than all of them.
export function entriesFor(text, entries) {
  const index = byAcronym(entries);
  const present = new Set(findOccurrences(text, [...index.keys()]).map((o) => o.acronym));
  return entries.filter((e) => present.has(String(e.acronym)));
}
