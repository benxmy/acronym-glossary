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
  letterCount, looksLikeAcronym, thirdColumnRole,
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

// Whether the final word of an expansion is a plural at all is decided on positive
// evidence, not on the absence of a denylist match. initialsMatch cannot help decide it —
// it only ever inspects first letters, so a mangled final word still satisfies it — and
// the cost of getting it wrong is not one bad glossary entry a human can correct. The
// expander carries the entry into the user's draft and writes "An Root Cause Analysi (RCA)
// was done." into their prose, which is a worse outcome than a missed match.
//
// REGULAR_PLURAL is the evidence. A regular plural is the singular plus a bare "s", and
// the only thing that can testify to it is the letter in front of that s. A bare -s
// follows "e" (Names, Services, Certificates) or a consonant that is not a sibilant
// (Domains, Gateways, Graphs). It does not follow a, i, o or u: those are far more often
// the tail of a singular noun (Alias, Analysis, Chaos, Status) than a plural marker. A
// sibilant stem takes -es instead, which is IRREVERSIBLE_PLURAL's business. So the letters
// that count as evidence are every letter except a, i, o, u, s, x and z — written below as
// that complement, because the exclusions are the part worth reading. It is only ever
// applied to a word already known to end in a LOWERCASE letter plus s, so it needs no /i.
//
// IRREVERSIBLE_PLURAL then catches the -es and -ies forms that ARE plurals but that
// dropping one "s" does not reverse: "Authorities" would become "Authoritie" and
// "Addresses" "Addresse".
//
// What the pair still lets through, in each direction:
//   - Refused though genuinely plural: -as and -os plurals (Areas, Scenarios), Latin
//     plurals (Indices → Indice), and invariants (Series). The cost is an entry stored
//     with its plural acronym, which then matches nothing — inert, and visible in the
//     glossary where a human can see it. README lists this under Known limitations.
//   - Accepted though singular: the few consonant-stem singular nouns (Lens, News, Means,
//     Corps). Telling those from Domains needs a dictionary, not a rule.
const REGULAR_PLURAL = /[^aiousxz]s$/;
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
    if (!REGULAR_PLURAL.test(last) || IRREVERSIBLE_PLURAL.test(last)) return asMined;
    phrase = [...words.slice(0, -1), last.slice(0, -1)].join(' ');
    // Both refusals above abandon the whole transformation rather than keeping the
    // singular acronym beside a plural expansion. A mismatched pair matches more
    // documents but expands them wrongly — "Certificate Authorities (CA)" is prose this
    // tool would be inserting into someone's draft, and wrong prose is a worse outcome
    // than a missed match. An unmatched plural entry is merely inert, and visible.
  }

  // Last gate, and the only initials check left here: if the singular acronym and the
  // expansion we ended up with don't spell each other, transform nothing at all. It
  // covers two shapes. A singularised expansion that no longer spells the acronym —
  // "Big Tens" → "Big Ten" fails, because a spelled-out number word becomes a digit —
  // and a pair that never spelled each other to begin with, where stripping the
  // acronym's s would invent an entry the document never supported.
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
      // The two-letter prose exclusion is applied to the acronym as it will be STORED,
      // not as it was written. fromParens counts the letters it sees, and "JDs" has three
      // — so the candidate clears that gate and singularForm then strips the s, storing
      // exactly the two-letter prose entry the gate exists to keep out. "Jane Does (JDs)"
      // is DESIGN.md's own "Jane Doe (MFA)" false positive, one letter shorter. Only prose
      // candidates are dropped here: a glossary-shaped line or a table row is evidence in
      // its own right, and two-letter acronyms stay welcome from those.
      if (c.prose && letterCount(acronym) < 3) continue;
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

// realpathSync, not just path.resolve: import.meta.filename is already realpath-resolved,
// so invoked through a symlinked path — which an installed plugin's directory can be — the
// two spellings compare unequal, main() never runs, and the CLI exits 0 having printed and
// written nothing. The fallback covers realpathSync throwing on a path that no longer exists.
function invokedAs(arg) {
  try {
    return fs.realpathSync(arg);
  } catch {
    return path.resolve(arg);
  }
}

if (process.argv[1] && import.meta.filename === invokedAs(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
