import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  entryKey, mergeEntries, glossaryLocations, readGlossaryFile,
  loadGlossary, saveGlossary, byAcronym, entriesFor, rankOf,
} from '../scripts/glossary.js';

const entry = (over = {}) => ({
  acronym: 'MFA', expansion: 'Multi-Factor Authentication', scope: 'general',
  domain: 'identity', definition: null, aliases: null, source: 'curated',
  sourceRef: null, expand: true, ...over,
});

// Every tmpdir() call is tracked and swept up in the after() below, so this suite
// leaves no residue in the OS temp directory across runs.
const createdDirs = [];
function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
  createdDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('entryKey is case-insensitive on both halves', () => {
  assert.equal(entryKey(entry()), entryKey(entry({ acronym: 'mfa', expansion: 'MULTI-FACTOR AUTHENTICATION' })));
});

test('two meanings of one acronym are two entries, not an overwrite', () => {
  const merged = mergeEntries([[
    entry({ acronym: 'CA', expansion: 'Certificate Authority' }),
    entry({ acronym: 'CA', expansion: 'Conditional Access' }),
  ]]);
  assert.equal(merged.length, 2);
});

test('an earlier location wins outright rather than field-merging', () => {
  const merged = mergeEntries([
    [entry({ definition: 'from the project file', domain: 'security' })],
    [entry({ definition: 'from the personal file', domain: 'identity' })],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].definition, 'from the project file');
  assert.equal(merged[0].domain, 'security'); // NOT inherited from the later file
});

test('rankOf puts hand-written above curated above mined', () => {
  assert.ok(rankOf('manual') < rankOf('curated'));
  assert.ok(rankOf('curated') < rankOf('notes'));
  assert.equal(rankOf(undefined), rankOf('anything-mined'));
});

test('glossaryLocations honours the override then project then home', () => {
  const locations = glossaryLocations({
    env: { ACRONYM_GLOSSARY: '/tmp/override.json' }, cwd: '/work/repo', home: '/home/me',
  });
  assert.deepEqual(locations, [
    '/tmp/override.json',
    path.join('/work/repo', '.acronyms/glossary.json'),
    path.join('/home/me', '.acronym-glossary/glossary.json'),
  ]);
});

test('saveGlossary round-trips and sorts, readGlossaryFile returns null when absent', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'nested/glossary.json');
  saveGlossary(file, [entry({ acronym: 'SSO', expansion: 'Single Sign-On' }), entry()]);
  const read = readGlossaryFile(file);
  assert.deepEqual(read.map((e) => e.acronym), ['MFA', 'SSO']);
  assert.equal(readGlossaryFile(path.join(dir, 'missing.json')), null);
});

test('readGlossaryFile rejects a file with no entries array', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{"acronyms": []}');
  assert.throws(() => readGlossaryFile(file), /expected an "entries" array/);
});

test('readGlossaryFile fails loudly on an entry missing acronym or expansion, naming the file and index', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'missing-field.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    entries: [entry(), { acronym: 'SSO' /* no expansion */ }],
  }));
  assert.throws(
    () => readGlossaryFile(file),
    (err) => err.message.includes(file) && /entry 1/.test(err.message)
      && /acronym.*expansion|expansion.*acronym/.test(err.message),
  );
});

test('readGlossaryFile names the file when the JSON itself is unparseable', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{ not valid json');
  assert.throws(() => readGlossaryFile(file), (err) => err.message.startsWith(`${file}:`));
});

test('loadGlossary merges the files that exist, earlier winning', () => {
  const dir = tmpdir();
  const project = path.join(dir, 'project/.acronyms/glossary.json');
  const home = path.join(dir, 'home/.acronym-glossary/glossary.json');
  saveGlossary(project, [entry({ definition: 'project wins' })]);
  saveGlossary(home, [entry({ definition: 'home loses' }), entry({ acronym: 'SSO', expansion: 'Single Sign-On' })]);
  const { entries, files } = loadGlossary({ env: {}, cwd: path.join(dir, 'project'), home: path.join(dir, 'home') });
  assert.equal(files.length, 2);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.acronym === 'MFA').definition, 'project wins');
});

test('byAcronym keys on the stored spelling and ranks best candidate first', () => {
  const index = byAcronym([
    entry({ acronym: 'CA', expansion: 'Conditional Access', source: 'notes' }),
    entry({ acronym: 'CA', expansion: 'Certificate Authority', source: 'manual' }),
    entry({ acronym: 'mTLS', expansion: 'mutual Transport Layer Security' }),
  ]);
  assert.deepEqual([...index.keys()].sort(), ['CA', 'mTLS']);
  assert.equal(index.get('CA')[0].expansion, 'Certificate Authority');
});

test('entriesFor returns only entries whose acronym is actually present', () => {
  const all = [entry(), entry({ acronym: 'SSO', expansion: 'Single Sign-On' })];
  const hit = entriesFor('We need MFA on everything.', all);
  assert.deepEqual(hit.map((e) => e.acronym), ['MFA']);
  assert.deepEqual(entriesFor('Nothing relevant here.', all), []);
});
