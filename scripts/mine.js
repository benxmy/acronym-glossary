#!/usr/bin/env node
// Mine acronyms out of documents you already have.
//
// Usage:
//   node scripts/mine.js <paths...> [options]
//     --source=<tag>  tag every entry this run writes (default: mined)
//     --out=<file>    glossary to update (default: the first resolved location)
//     --dry-run       print what would be written, write nothing
//
// Every entry carries its source tag, so a pass that turns out to be junk can be
// deleted wholesale instead of picked apart. Acronyms with no defensible expansion go
// to a sibling glossary-unmatched.json rather than being dropped silently — that file
// is the shortlist worth adding by hand. That file is a report of the most recent run
// and is rewritten each time, so pass every source you care about to a single
// invocation rather than mining one path at a time.

import fs from 'node:fs';
import path from 'node:path';
import {
  fromLines, fromParens, fromTable, hasAcronymHeader, htmlToLines, initialsMatch,
  looksLikeAcronym, thirdColumnRole,
} from './extract.js';
import { entryKey, glossaryLocations, readGlossaryFile, saveGlossary } from './glossary.js';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);
const HTML_EXT = new Set(['.html', '.htm']);
const TABLE_EXT = new Set(['.csv', '.tsv']);

export function walk(target, out = []) {
  if (fs.statSync(target).isFile()) { out.push(target); return out; }
  for (const name of fs.readdirSync(target).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    walk(path.join(target, name), out);
  }
  return out;
}

// A minimal RFC4180-ish reader — enough for exported spreadsheets: quoted fields,
// doubled quotes inside them, and newlines inside quotes. Not a general CSV library,
// and it doesn't need to be.
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function candidatesFrom(file) {
  const ext = path.extname(file).toLowerCase();
  if (TABLE_EXT.has(ext)) {
    const rows = parseDelimited(fs.readFileSync(file, 'utf8'), ext === '.tsv' ? '\t' : ',');
    return fromTable(rows, { trusted: hasAcronymHeader(rows), thirdColumn: thirdColumnRole(rows) });
  }
  if (HTML_EXT.has(ext)) {
    const lines = htmlToLines(fs.readFileSync(file, 'utf8'));
    return [...fromLines(lines), ...fromParens(lines.join('\n'))];
  }
  if (TEXT_EXT.has(ext)) {
    const raw = fs.readFileSync(file, 'utf8');
    return [...fromLines(raw.split('\n')), ...fromParens(raw)];
  }
  return [];
}

// Plural shapes that removing the final "s" does not reverse: "Authorities" would become
// "Authoritie" and "Addresses" "Addresse". initialsMatch cannot catch that on its own,
// because it only ever inspects first letters — a mangled final word still matches. So
// these shapes are refused rather than repaired. Latin plurals ("Indices" → "Indice")
// still slip through; naming every one of them would mean guessing at morphology, and the
// cost of a miss is one visible misspelling in one mined entry a human can correct.
const IRREVERSIBLE_PLURAL = /(?:ies|(?:s|x|z|ch|sh)es)$/i;

/**
 * A plural acronym stored verbatim is close to useless. Matching is case-sensitive and
 * keys on the stored spelling, so an entry stored as "SANs" never matches a document that
 * says "SAN" — the ordinary case — while an entry stored as "SAN" matches both, since the
 * matcher captures a trailing lowercase s of its own accord and the expander carries it
 * into the parenthesis.
 *
 * Only a LOWERCASE trailing s is a plural marker, the same rule initialsMatch already
 * uses: RADIUS, CORS and PKCS end in a capital S that belongs to the expansion.
 *
 * Every step here may decline, and a refusal returns the pair exactly as mined. That is
 * always safe: the entry still lands in the glossary, where a human can see it and fix it.
 */
export function singularForm(acronym, expansion) {
  const asMined = { acronym, expansion };
  if (!/[A-Z]s$/.test(String(acronym))) return asMined;
  const singular = String(acronym).slice(0, -1);
  if (!looksLikeAcronym(singular)) return asMined;

  let phrase = String(expansion);
  const words = phrase.trim().split(/\s+/);
  const last = words[words.length - 1] || '';
  if (/[a-z]s$/.test(last)) {
    if (IRREVERSIBLE_PLURAL.test(last)) return asMined;
    const candidate = [...words.slice(0, -1), last.slice(0, -1)].join(' ');
    // The singularised expansion is kept only if it still spells the singular acronym.
    // "Big Tens" → "Big Ten" fails, because a spelled-out number word becomes a digit.
    if (!initialsMatch(singular, candidate)) return asMined;
    phrase = candidate;
    // Both refusals above abandon the whole transformation rather than keeping the
    // singular acronym beside a plural expansion. A mismatched pair matches more
    // documents but expands them wrongly — "Certificate Authorities (CA)" is prose this
    // tool would be inserting into someone's draft, and wrong prose is a worse outcome
    // than a missed match. An unmatched plural entry is merely inert, and visible.
  }

  // Last gate: if the singular acronym and the expansion we ended up with don't spell
  // each other, transform nothing at all.
  if (!initialsMatch(singular, phrase)) return asMined;
  return { acronym: singular, expansion: phrase };
}

function parseArgs(argv) {
  const flags = {};
  const paths = [];
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
    else paths.push(arg);
  }
  return { flags, paths };
}

export function main(argv) {
  const { flags, paths } = parseArgs(argv);
  if (!paths.length) {
    console.error('usage: mine.js <paths...> [--source=tag] [--out=file] [--dry-run]');
    return 2;
  }
  const source = typeof flags.source === 'string' ? flags.source : 'mined';
  const out = typeof flags.out === 'string' ? flags.out : glossaryLocations()[0];

  // walk() throws on a path that doesn't resolve (ENOENT) or that fs can't stat —
  // an ordinary CLI typo. Caught narrowly here, not around candidatesFrom or the
  // mining loop below: a bad path argument and a mid-run read failure on one document
  // are different failures, and this catch must not swallow the second kind.
  let files;
  try {
    files = paths.flatMap((p) => walk(p));
  } catch (err) {
    console.error(`mine.js: cannot read path — ${err.message}`);
    return 1;
  }

  // readGlossaryFile throws (loudly, by design) on a glossary that exists but is
  // unreadable or malformed. Mining is additive, so it never repairs or replaces that
  // file itself — it stops and reports the problem rather than risk writing new
  // entries alongside content it can't parse, or masking corruption the user needs to
  // see and fix by hand.
  let existing;
  try {
    existing = readGlossaryFile(out) || [];
  } catch (err) {
    console.error(`mine.js: existing glossary is unreadable — ${err.message}`);
    return 1;
  }

  const seen = new Set(existing.map(entryKey));
  const added = [];
  const unmatched = new Map();

  for (const file of files) {
    for (const c of candidatesFrom(file)) {
      if (!c.expansion) {
        const row = unmatched.get(c.acronym) || { acronym: c.acronym, count: 0, samples: [] };
        row.count++;
        if (c.candidate && row.samples.length < 3) row.samples.push({ text: c.candidate, file });
        unmatched.set(c.acronym, row);
        continue;
      }
      // A plural mined verbatim would be unmatchable against the singular form documents
      // ordinarily use — see singularForm, which declines rather than guess.
      const { acronym, expansion } = singularForm(c.acronym, c.expansion);
      // scope stays null: mining can tell you what an acronym expands to, but not
      // whether it is an industry standard or something local to one organisation.
      const entry = {
        acronym,
        expansion,
        scope: null,
        domain: c.domain ?? null,
        definition: c.definition ?? c.extraDefinition ?? null,
        aliases: null,
        source,
        sourceRef: file,
        expand: true,
      };
      const key = entryKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(entry);
    }
  }

  if (flags['dry-run']) {
    for (const e of added) console.log(`+ ${e.acronym} — ${e.expansion}`);
    console.log(`\n${files.length} files, ${added.length} new entries, ${unmatched.size} unmatched (nothing written)`);
    return 0;
  }

  // Both writes return 1, not 2: in this CLI 1 already means an I/O failure — the
  // unreadable-path and unreadable-glossary cases above — while 2 means the arguments
  // were wrong, and a full disk is not a typo. (The expander uses 2 for its failed write,
  // because there 1 is the hook-facing "changes pending" signal. The two CLIs differ on
  // purpose.) Each catch wraps one write and nothing else, so a failure to save the
  // glossary is never reported as a failure to save the shortlist, or the reverse.
  try {
    saveGlossary(out, [...existing, ...added]);
  } catch (err) {
    console.error(`mine.js: cannot write ${out} — ${err.message}`);
    return 1;
  }
  const unmatchedFile = path.join(path.dirname(out), 'glossary-unmatched.json');
  const shortlist = [...unmatched.values()].sort((a, b) => b.count - a.count);
  try {
    fs.writeFileSync(unmatchedFile, `${JSON.stringify(shortlist, null, 2)}\n`);
  } catch (err) {
    console.error(`mine.js: cannot write ${unmatchedFile} — ${err.message}`);
    return 1;
  }
  console.log(`${files.length} files → ${added.length} new entries in ${out}`);
  console.log(`${unmatched.size} acronyms with no defensible expansion → ${unmatchedFile}`);
  return 0;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
