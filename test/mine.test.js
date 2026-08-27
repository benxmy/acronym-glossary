import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walk, parseDelimited, candidatesFrom, main } from '../scripts/mine.js';
import { readGlossaryFile } from '../scripts/glossary.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acr-mine-'));
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

test('main exits 2 with no paths', () => {
  assert.equal(main([]), 2);
});
