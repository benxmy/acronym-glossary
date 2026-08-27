import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { walk, parseDelimited, candidatesFrom, singularForm, main } from '../scripts/mine.js';
import { readGlossaryFile } from '../scripts/glossary.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acr-mine-'));
}

// main() returns an exit code and never calls process.exit, so it can be driven in-process;
// console.error is stubbed to check the message goes to stderr, and restored in a finally.
function runMain(argv) {
  const err = [];
  const real = console.error;
  console.error = (...a) => err.push(a.join(' '));
  try {
    return { code: main(argv), err: err.join('\n') };
  } finally {
    console.error = real;
  }
}

test('parseDelimited handles quotes, doubled quotes and embedded newlines', () => {
  const rows = parseDelimited('a,b\n"x, y","he said ""hi"""\n"multi\nline",z\n', ',');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
});

test('parseDelimited handles tabs', () => {
  assert.deepEqual(parseDelimited('a\tb\n', '\t'), [['a', 'b']]);
});

test('walk finds files recursively and skips dotfiles and node_modules', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'sub/node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '');
  fs.writeFileSync(path.join(dir, 'sub/b.md'), '');
  fs.writeFileSync(path.join(dir, 'sub/node_modules/c.md'), '');
  fs.writeFileSync(path.join(dir, '.hidden/d.md'), '');
  const found = walk(dir).map((f) => path.basename(f)).sort();
  assert.deepEqual(found, ['a.md', 'b.md']);
});

test('candidatesFrom dispatches on extension', () => {
  const dir = tmpdir();
  const md = path.join(dir, 'notes.md');
  fs.writeFileSync(md, '- **MFA** — Multi-Factor Authentication\n\nWe use Single Sign-On (SSO) too.\n');
  const fromMd = candidatesFrom(md).filter((c) => c.expansion);
  assert.ok(fromMd.some((c) => c.acronym === 'MFA'));
  assert.ok(fromMd.some((c) => c.acronym === 'SSO' && c.expansion === 'Single Sign-On'));

  const html = path.join(dir, 'page.html');
  fs.writeFileSync(html, '<table><tr><td>SCIM</td><td>System for Cross-domain Identity Management</td></tr></table>');
  assert.ok(candidatesFrom(html).some((c) => c.acronym === 'SCIM' && c.expansion));

  const csv = path.join(dir, 'sheet.csv');
  fs.writeFileSync(csv, 'Acronym,Expansion,Category\nFedRAMP,"Federal Risk and Authorization Management Program",compliance\n');
  const fromCsv = candidatesFrom(csv);
  assert.equal(fromCsv[0].acronym, 'FedRAMP');
  assert.equal(fromCsv[0].domain, 'compliance'); // header named the third column
  assert.ok(fromCsv[0].expansion); // trusted header beats the initials check

  assert.deepEqual(candidatesFrom(path.join(dir, 'ignored.pdf')), []);
});

test('main writes new entries, tags the source and reports the unmatched', () => {
  const dir = tmpdir();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, '- **MFA** — Multi-Factor Authentication\n- QQQ: no defensible expansion here\n');
  const out = path.join(dir, 'glossary.json');

  const code = main([notes, `--out=${out}`, '--source=notes']);
  assert.equal(code, 0);

  const entries = readGlossaryFile(out);
  const mfa = entries.find((e) => e.acronym === 'MFA');
  assert.equal(mfa.expansion, 'Multi-Factor Authentication');
  assert.equal(mfa.source, 'notes');
  assert.equal(mfa.sourceRef, notes);
  assert.equal(mfa.expand, true);
  assert.equal(mfa.scope, null); // mining cannot know the scope

  const unmatched = JSON.parse(fs.readFileSync(path.join(dir, 'glossary-unmatched.json'), 'utf8'));
  assert.ok(unmatched.some((u) => u.acronym === 'QQQ'));
});

test('main is additive and never duplicates an existing meaning', () => {
  const dir = tmpdir();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, '- **MFA** — Multi-Factor Authentication\n');
  const out = path.join(dir, 'glossary.json');
  main([notes, `--out=${out}`]);
  main([notes, `--out=${out}`]);
  assert.equal(readGlossaryFile(out).filter((e) => e.acronym === 'MFA').length, 1);
});

test('--dry-run writes nothing', () => {
  const dir = tmpdir();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, '- **MFA** — Multi-Factor Authentication\n');
  const out = path.join(dir, 'glossary.json');
  main([notes, `--out=${out}`, '--dry-run']);
  assert.equal(fs.existsSync(out), false);
});

// ── Plural acronyms ─────────────────────────────────────────────────────────
// A plural stored verbatim is unmatchable: matching is case-sensitive and keys on the
// stored spelling, so "SANs" never matches a document that says "SAN".

test('a mined plural acronym is stored singular, expansion and all', () => {
  assert.deepEqual(
    singularForm('SANs', 'Subject Alternative Names'),
    { acronym: 'SAN', expansion: 'Subject Alternative Name' },
  );
});

test('nothing is transformed when removing the expansion s would not reverse the plural', () => {
  // "Authoritie" is not a word, and an initials check cannot tell — it only ever inspects
  // first letters. Since the expansion has to stay plural, the acronym stays plural too:
  // storing CA beside "Certificate Authorities" would expand a singular mention into
  // "Certificate Authorities (CA)", which is wrong prose in the user's own draft.
  assert.deepEqual(
    singularForm('CAs', 'Certificate Authorities'),
    { acronym: 'CAs', expansion: 'Certificate Authorities' },
  );
});

test('nothing is transformed when singularising the expansion would break the initials match', () => {
  // "Tens" contributes a T; "Ten" becomes the digit 10, so the singularised phrase no
  // longer spells BT. Same rule as above: the pair stays as mined rather than splitting
  // a singular acronym off from a plural expansion.
  assert.deepEqual(singularForm('BTs', 'Big Tens'), { acronym: 'BTs', expansion: 'Big Tens' });
});

test('an already-singular expansion still singularises the acronym', () => {
  // The number-agreement rule must not block this case: there is no plural to reverse in
  // "Subject Alternative Name", so the only thing standing between SANs and SAN is the
  // initials check, which passes. Without this test the rule above could be tightened into
  // refusing every plural acronym and the suite would stay green.
  assert.deepEqual(
    singularForm('SANs', 'Subject Alternative Name'),
    { acronym: 'SAN', expansion: 'Subject Alternative Name' },
  );
});

test('an uppercase trailing S is never stripped', () => {
  const radius = ['RADIUS', 'Remote Authentication Dial-In User Service'];
  const cors = ['CORS', 'Cross-Origin Resource Sharing'];
  assert.deepEqual(singularForm(...radius), { acronym: radius[0], expansion: radius[1] });
  assert.deepEqual(singularForm(...cors), { acronym: cors[0], expansion: cors[1] });
});

test('an uppercase trailing S is never stripped even when the initials would still match', () => {
  // The case rule needs a shape where the FINAL initials gate cannot rescue it, or the test
  // says nothing: widening the rule to /[A-Za-z]s$/i leaves RADIUS and CORS green, because
  // "RADIU" does not spell their expansions anyway. Here it does. initialsMatch tries the
  // phrase both with and without the hyphen as a word break, so "Network Name-Space" spells
  // both NNS and NN — the trailing S is redundant, and only the case rule stands between
  // NNS and a wrongly singularised NN.
  assert.deepEqual(
    singularForm('NNS', 'Network Name-Space'),
    { acronym: 'NNS', expansion: 'Network Name-Space' },
  );
});

test('a mismatched pair is never transformed, even with no plural to reverse', () => {
  // Pins the final initials gate on its own. The expansion's last word is not a plural, so
  // the plural branch never runs and this gate is the only thing standing between a
  // mis-mined pair and an invented two-part entry the document never supported.
  assert.deepEqual(
    singularForm('DCs', 'Domain Registry'),
    { acronym: 'DCs', expansion: 'Domain Registry' },
  );
});

// ── A final word that ends in a lowercase s but is not a plural ──────────────
// The plural branch keys on a trailing lowercase s, which -sis, -us and -ss words have
// without being plural at all. Initials cannot catch it — they only ever inspect first
// letters — and the damage does not stop at the glossary: the expander writes
// "An Root Cause Analysi (RCA) was done." into the user's own draft.

test('a final word ending in a non-plural lowercase s is left alone', () => {
  for (const [acronym, expansion] of [
    ['RCAs', 'Root Cause Analysis'],   // -sis, a singular Greek noun
    ['HSs', 'Health Status'],          // -us
    ['NAs', 'Network Access'],         // -ss
    ['PPs', 'Peer Process'],           // -ss again, and an ordinary English word
  ]) {
    assert.deepEqual(singularForm(acronym, expansion), { acronym, expansion },
      `${acronym} / ${expansion} must not be transformed`);
  }
});

test('ordinary plurals still singularise', () => {
  // The other side of the same predicate. Without these, tightening the rule into refusing
  // every plural would leave the suite green, and the README promises these shapes work.
  for (const [acronym, expansion, wantAcronym, wantExpansion] of [
    ['SANs', 'Subject Alternative Names', 'SAN', 'Subject Alternative Name'],
    ['ADs', 'Alternate Domains', 'AD', 'Alternate Domain'],
    ['MSs', 'Managed Services', 'MS', 'Managed Service'],
    ['DCs', 'Device Certificates', 'DC', 'Device Certificate'],
  ]) {
    assert.deepEqual(singularForm(acronym, expansion),
      { acronym: wantAcronym, expansion: wantExpansion },
      `${acronym} / ${expansion} must singularise`);
  }
});

test('the singular form is what actually reaches the glossary', () => {
  const dir = tmpdir();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, 'We issued SANs (Subject Alternative Names) last year.\n');
  const out = path.join(dir, 'glossary.json');
  assert.equal(main([notes, `--out=${out}`]), 0);
  const entries = readGlossaryFile(out);
  assert.deepEqual(entries.map((e) => [e.acronym, e.expansion]), [['SAN', 'Subject Alternative Name']]);
});

// ── The two-letter prose exclusion, applied to what gets STORED ──────────────

test('a two-letter acronym does not reach the glossary through the plural path', () => {
  // fromParens counts the letters it sees and "JDs" has three, so the candidate clears the
  // prose gate and singularForm then strips the s — storing exactly the two-letter prose
  // entry the gate exists to keep out. "Jane Does (JDs)" is DESIGN.md's own "Jane Doe (MFA)"
  // false positive, one letter shorter.
  const dir = tmpdir();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, 'We met Jane Does (JDs) yesterday and used Endpoint Protections (EPs) too.\n');
  const out = path.join(dir, 'glossary.json');
  assert.equal(main([notes, `--out=${out}`]), 0);
  assert.deepEqual(readGlossaryFile(out).map((e) => [e.acronym, e.expansion]), []);
});

test('a two-letter acronym from a trusted table row is still stored', () => {
  // The other half: only the PROSE path excludes two-letter acronyms. A table row whose
  // header names the first column is evidence in its own right, which is the whole reason
  // the exclusion was ever scoped to prose. (SA rather than AM: AM is in the NOISE list and
  // never becomes a candidate from any source, so it would pass this test vacuously.)
  const dir = tmpdir();
  const sheet = path.join(dir, 'terms.csv');
  fs.writeFileSync(sheet, 'Acronym,Expansion\nSA,Service Account\n');
  const out = path.join(dir, 'glossary.json');
  assert.equal(main([sheet, `--out=${out}`]), 0);
  assert.deepEqual(readGlossaryFile(out).map((e) => [e.acronym, e.expansion]), [['SA', 'Service Account']]);
});

test('invoked through a symlinked path the CLI still runs', () => {
  // import.meta.filename is realpath-resolved and process.argv[1] is not, so the entry
  // guard's plain path.resolve comparison failed through a symlink: main() never ran and the
  // process exited 0 having printed nothing, which reads as "no acronyms found". An installed
  // plugin's directory can be a symlink. Driven as a child process because the guard only
  // exists at module top level.
  const dir = tmpdir();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, '- **MFA** — Multi-Factor Authentication\n');
  const link = path.join(dir, 'linked');
  fs.symlinkSync(path.resolve(import.meta.dirname, '..'), link);
  const r = spawnSync(
    process.execPath,
    [path.join(link, 'scripts', 'mine.js'), notes, '--dry-run', `--out=${path.join(dir, 'glossary.json')}`],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\+ MFA — Multi-Factor Authentication/);
});

test('main exits 1 on a glossary it cannot write, and says so on stderr', () => {
  const dir = tmpdir();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, '- **MFA** — Multi-Factor Authentication\n');
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o555);
  const out = path.join(locked, 'glossary.json');
  try {
    const { code, err } = runMain([notes, `--out=${out}`]);
    assert.equal(code, 1, '1 is this CLI\'s I/O failure; 2 means the arguments were wrong');
    assert.match(err, /^mine\.js: cannot write .*glossary\.json — /);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('main exits 2 with no paths', () => {
  assert.equal(main([]), 2);
});

test('main exits 1 on a path that does not exist', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'glossary.json');
  assert.equal(main([path.join(dir, 'nope.md'), `--out=${out}`]), 1);
  assert.equal(fs.existsSync(out), false);
});
