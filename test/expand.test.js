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

// A scratch document, a scratch glossary and a scratch HOME. The isolated HOME is not
// optional: loadGlossary MERGES all three locations rather than the first winning, so a
// test that set only ACRONYM_GLOSSARY would also read the machine's personal glossary and
// pass or fail depending on whose machine it ran on.
function scratch(text, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-expand-'));
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, text);
  const glossary = path.join(dir, 'glossary.json');
  fs.writeFileSync(glossary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  return { dir, file, glossary, home: fs.mkdtempSync(path.join(os.tmpdir(), 'acr-home-')) };
}

// main() returns an exit code and never calls process.exit, which is what lets it be
// driven in-process. console.log and console.error are stubbed so the assertions can look
// at what the CLI actually printed, and restored in a finally so one failure can't take
// the rest of the suite's output with it.
function runMain(argv, { glossary, home }) {
  const had = (k) => Object.prototype.hasOwnProperty.call(process.env, k);
  const prev = { g: process.env.ACRONYM_GLOSSARY, h: process.env.HOME, hadG: had('ACRONYM_GLOSSARY'), hadH: had('HOME') };
  const out = [];
  const err = [];
  const realLog = console.log;
  const realErr = console.error;
  process.env.ACRONYM_GLOSSARY = glossary;
  process.env.HOME = home;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    return { code: main(argv), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realErr;
    if (prev.hadG) process.env.ACRONYM_GLOSSARY = prev.g; else delete process.env.ACRONYM_GLOSSARY;
    if (prev.hadH) process.env.HOME = prev.h; else delete process.env.HOME;
  }
}

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

// ── An expansion that repeats its own acronym ────────────────────────────────
// The damage this prevents is not a bad report, it is the user's prose growing by another
// copy of the expansion on every --write.

test('an entry whose expansion repeats the acronym is refused and reported', () => {
  const gwp = entry({ acronym: 'GWP', expansion: 'GWP Gross Written Premium' });
  const plan = planExpansions('GWP grew this year.', [gwp]);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0].reason, 'self-referential');
  assert.deepEqual(plan.ambiguous[0].meanings, ['GWP Gross Written Premium']);
});

test('--write is idempotent: a self-referential entry never grows the document', () => {
  const original = 'GWP grew this year.\n';
  const s = scratch(original, [entry({ acronym: 'GWP', expansion: 'GWP Gross Written Premium' })]);
  for (const run of [1, 2, 3]) {
    const { code } = runMain([s.file, '--write'], s);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(s.file, 'utf8'), original, `run ${run} changed the document`);
  }
});

test('an acronym that is only a substring of its expansion still expands', () => {
  // The load-bearing control: an `includes`-based guard would see SAN inside "Subject
  // Alternative Name" and refuse a perfectly good entry, with the idempotency test above
  // still green.
  const san = entry({ acronym: 'SAN', expansion: 'Subject Alternative Name' });
  const plan = planExpansions('The SAN is set.', [san]);
  assert.equal(plan.ambiguous.length, 0);
  assert.equal(plan.changes.length, 1);
  assert.equal(expandOnce('The SAN is set.', [san]), 'The Subject Alternative Name (SAN) is set.');
});

// ── main()'s success path ────────────────────────────────────────────────────

test('a dry run reports the plan under "pending" and exits 1', () => {
  const original = 'MFA is required.\n';
  const s = scratch(original, [entry()]);
  const { code, out } = runMain([s.file, '--json'], s);
  assert.equal(code, 1, 'pending changes in a dry run are the hook-facing 1');
  const report = JSON.parse(out);
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'applied'), false);
  assert.equal(report.pending.length, 1);
  assert.equal(report.pending[0].replacement, 'Multi-Factor Authentication (MFA)');
  assert.equal(fs.readFileSync(s.file, 'utf8'), original, 'a dry run writes nothing');
});

test('--write rewrites the file, reports it under "applied" and exits 0', () => {
  const s = scratch('MFA is required.\n', [entry()]);
  const { code, out } = runMain([s.file, '--write', '--json'], s);
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'pending'), false);
  assert.equal(report.applied.length, 1);
  // The observable effect, not just the exit code: without this, deleting the write
  // altogether leaves the suite green.
  assert.equal(fs.readFileSync(s.file, 'utf8'), 'Multi-Factor Authentication (MFA) is required.\n');
});

test('--scope reaches resolution and settles an otherwise ambiguous acronym', () => {
  const entries = [
    entry({ acronym: 'CA', expansion: 'Certificate Authority', scope: 'general', source: 'manual' }),
    entry({ acronym: 'CA', expansion: 'Conditional Access', scope: 'local', source: 'manual' }),
  ];
  const s = scratch('The CA signs it.\n', entries);
  const without = runMain([s.file, '--json'], s);
  assert.equal(without.code, 0);
  assert.equal(JSON.parse(without.out).ambiguous.length, 1, 'two manual entries tie without a hint');

  const withHint = runMain([s.file, '--scope=general', '--json'], s);
  assert.equal(withHint.code, 1);
  const report = JSON.parse(withHint.out);
  assert.equal(report.ambiguous.length, 0);
  assert.equal(report.pending[0].replacement, 'Certificate Authority (CA)');
});

// ── Failure paths ───────────────────────────────────────────────────────────

test('main exits 2 on a file it cannot write, and says so on stderr', () => {
  const s = scratch('MFA is required.\n', [entry()]);
  fs.chmodSync(s.file, 0o444);
  try {
    const { code, out, err } = runMain([s.file, '--write'], s);
    assert.equal(code, 2, '2, not the hook-facing 1 that means changes are pending');
    assert.match(err, /^expand\.js: cannot write .*doc\.md — /);
    assert.equal(out, '', 'nothing on stdout may claim the write happened');
  } finally {
    fs.chmodSync(s.file, 0o644);
  }
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
