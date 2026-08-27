import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveMeaning, alreadyExpanded, planExpansions, applyExpansions, main,
} from '../scripts/expand.js';

const entry = (over = {}) => ({
  acronym: 'MFA', expansion: 'Multi-Factor Authentication', scope: 'general',
  domain: 'identity', definition: null, aliases: null, source: 'curated',
  sourceRef: null, expand: true, ...over,
});

const expandOnce = (text, entries, hint) => applyExpansions(text, planExpansions(text, entries, hint).changes);

test('a single meaning is used', () => {
  const r = resolveMeaning([entry()]);
  assert.equal(r.reason, 'unique');
  assert.equal(r.entry.expansion, 'Multi-Factor Authentication');
});

test('a domain hint narrows before source rank is consulted', () => {
  const candidates = [
    entry({ acronym: 'CA', expansion: 'Certificate Authority', domain: 'pki', source: 'notes' }),
    entry({ acronym: 'CA', expansion: 'Chartered Accountant', domain: 'finance', source: 'manual' }),
  ];
  assert.equal(resolveMeaning(candidates, { domain: 'pki' }).entry.expansion, 'Certificate Authority');
  // with no hint, the better source wins instead
  assert.equal(resolveMeaning(candidates).entry.expansion, 'Chartered Accountant');
});

test('an unmatched hint is ignored rather than emptying the pool', () => {
  const r = resolveMeaning([entry()], { domain: 'nonexistent' });
  assert.equal(r.entry.expansion, 'Multi-Factor Authentication');
});

test('a genuine tie is reported, never guessed', () => {
  const r = resolveMeaning([
    entry({ acronym: 'CA', expansion: 'Certificate Authority', source: 'manual' }),
    entry({ acronym: 'CA', expansion: 'Conditional Access', source: 'manual' }),
  ]);
  assert.equal(r.entry, null);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.candidates.length, 2);
});

test('expand:false suppresses an entry', () => {
  const r = resolveMeaning([entry({ expand: false })]);
  assert.equal(r.entry, null);
  assert.equal(r.reason, 'suppressed');
});

test('only the first mention is expanded', () => {
  const out = expandOnce('MFA is good. MFA again. And MFA.', [entry()]);
  assert.equal(out, 'Multi-Factor Authentication (MFA) is good. MFA again. And MFA.');
});

test('an already-expanded first mention is left alone', () => {
  const text = 'We use Multi-Factor Authentication here. MFA is required.';
  assert.equal(alreadyExpanded(text, text.indexOf('MFA is'), 'Multi-Factor Authentication'), true);
  assert.equal(expandOnce(text, [entry()]), text);
});

test('a plural keeps its s inside the parenthesis', () => {
  const san = entry({ acronym: 'SAN', expansion: 'Subject Alternative Name' });
  assert.equal(expandOnce('Check the SANs.', [san]), 'Check the Subject Alternative Name (SANs).');
});

test('code, links and frontmatter are not rewritten', () => {
  const text = '---\ntitle: MFA\n---\nRun `MFA` and see [MFA](https://example.com/MFA).\n';
  assert.equal(expandOnce(text, [entry()]), text);
});

test('an ambiguous acronym is reported and the text is untouched', () => {
  const entries = [
    entry({ acronym: 'CA', expansion: 'Certificate Authority', source: 'manual' }),
    entry({ acronym: 'CA', expansion: 'Conditional Access', source: 'manual' }),
  ];
  const plan = planExpansions('The CA signs it.', entries);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0].acronym, 'CA');
  assert.equal(plan.ambiguous[0].meanings.length, 2);
});

test('several acronyms in one document all land at the right offsets', () => {
  const entries = [entry(), entry({ acronym: 'SSO', expansion: 'Single Sign-On' })];
  assert.equal(
    expandOnce('We need MFA and SSO.', entries),
    'We need Multi-Factor Authentication (MFA) and Single Sign-On (SSO).',
  );
});

test('an expansion inside code, a link or frontmatter does not count as already expanded', () => {
  const cases = [
    ['inline code', 'See `Multi-Factor Authentication` in the sample. MFA is required.'],
    ['link text', 'See [Multi-Factor Authentication](https://example.com/x) docs. MFA is required.'],
    ['frontmatter', '---\ntitle: Multi-Factor Authentication rollout\n---\nMFA is required.'],
  ];
  for (const [label, text] of cases) {
    const out = expandOnce(text, [entry()]);
    assert.ok(out.includes('Multi-Factor Authentication (MFA)'), `${label}: first prose use should expand`);
  }
});

test('a genuine earlier mention in prose still counts as already expanded', () => {
  const text = 'We use Multi-Factor Authentication here. MFA is required.';
  assert.equal(expandOnce(text, [entry()]), text);
});

test('a meridiem is not expanded, but a real use of the same acronym is', () => {
  const am = entry({ acronym: 'AM', expansion: 'Asset Management' });
  assert.equal(expandOnce('Ship it Thu AM.', [am]), 'Ship it Thu AM.');
  assert.equal(expandOnce('The AM team owns it.', [am]), 'The Asset Management (AM) team owns it.');
});

test('main exits 2 on a file it cannot read', () => {
  assert.equal(main(['/nonexistent/nope.md']), 2);
});

test('main exits 2 when the glossary is malformed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-expand-'));
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, 'MFA is fine.\n');
  const badGlossary = path.join(dir, 'glossary.json');
  fs.writeFileSync(badGlossary, '{ not valid json');

  const hadPrev = Object.prototype.hasOwnProperty.call(process.env, 'ACRONYM_GLOSSARY');
  const prev = process.env.ACRONYM_GLOSSARY;
  process.env.ACRONYM_GLOSSARY = badGlossary;
  try {
    assert.equal(main([file]), 2);
  } finally {
    if (hadPrev) process.env.ACRONYM_GLOSSARY = prev;
    else delete process.env.ACRONYM_GLOSSARY;
  }
});
