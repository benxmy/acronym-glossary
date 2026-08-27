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
// is the shortlist worth adding by hand.

import fs from 'node:fs';
import path from 'node:path';
import {
  fromLines, fromParens, fromTable, hasAcronymHeader, htmlToLines, thirdColumnRole,
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

  const files = paths.flatMap((p) => walk(p));

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
      // scope stays null: mining can tell you what an acronym expands to, but not
      // whether it is an industry standard or something local to one organisation.
      const entry = {
        acronym: c.acronym,
        expansion: c.expansion,
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

  saveGlossary(out, [...existing, ...added]);
  const unmatchedFile = path.join(path.dirname(out), 'glossary-unmatched.json');
  const shortlist = [...unmatched.values()].sort((a, b) => b.count - a.count);
  fs.writeFileSync(unmatchedFile, `${JSON.stringify(shortlist, null, 2)}\n`);
  console.log(`${files.length} files → ${added.length} new entries in ${out}`);
  console.log(`${unmatched.size} acronyms with no defensible expansion → ${unmatchedFile}`);
  return 0;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
