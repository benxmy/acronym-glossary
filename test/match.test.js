import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatcher, isMeridiem, skipRanges, findOccurrences } from '../scripts/match.js';

test('buildMatcher returns null for an empty or unusable key list', () => {
  assert.equal(buildMatcher([]), null);
  assert.equal(buildMatcher(['A']), null); // fewer than two alphanumerics
});

test('longest match wins, so EAP-TLS is not matched as EAP', () => {
  const found = findOccurrences('The EAP-TLS handshake.', ['EAP', 'EAP-TLS']);
  assert.deepEqual(found.map((o) => o.acronym), ['EAP-TLS']);
});

test('matching is case-sensitive and boundary-bounded', () => {
  assert.equal(findOccurrences('I am here', ['AM']).length, 0);
  assert.equal(findOccurrences('the CATALOG page', ['CAT']).length, 0);
  assert.equal(findOccurrences('mTLS everywhere', ['mTLS']).length, 1);
});

test('a trailing lowercase s is matched and its length reported', () => {
  const [hit] = findOccurrences('rotate the SANs first', ['SAN']);
  assert.equal(hit.acronym, 'SAN');
  assert.equal(hit.plural, 's');
  assert.equal(hit.length, 4);
});

test('the meridiem guard fires after times, dates and weekdays', () => {
  assert.equal(isMeridiem('AM', 'meeting at 9 '), true);
  assert.equal(isMeridiem('AM', 'on Thu '), true);
  assert.equal(isMeridiem('PM', '2026-08-27 '), true);
  assert.equal(isMeridiem('AM', 'talk to the '), false);
  assert.equal(isMeridiem('MFA', 'at 9 '), false); // guard is only for AM/PM
  assert.equal(findOccurrences('ship it Thu AM please', ['AM']).length, 0);
  assert.equal(findOccurrences('ask the AM about it', ['AM']).length, 1);
});

test('skipRanges covers frontmatter, fences, inline code, links and URLs', () => {
  const text = [
    '---',
    'title: MFA notes',
    '---',
    'Prose about MFA.',
    '```',
    'MFA in a fence',
    '```',
    'Inline `MFA` and [a link](https://example.com/MFA) and https://example.com/MFA',
  ].join('\n');
  const found = findOccurrences(text, ['MFA']);
  // exactly one survivor: the one in prose
  assert.equal(found.length, 1);
  assert.equal(text.slice(found[0].index - 6, found[0].index), 'about ');
  assert.ok(skipRanges(text).length >= 5);
});

test('an unterminated fence skips through end of text, not just to the next line', () => {
  const text = 'before\n```\nMFA inside unterminated fence\nmore text with MFA after';
  assert.equal(findOccurrences(text, ['MFA']).length, 0);
});

test('a fence only closes on its own delimiter, not a mismatched one', () => {
  const text = [
    '```',
    'MFA inside',
    '~~~',
    'MFA between fences',
    '```',
    'MFA after real close',
  ].join('\n');
  const found = findOccurrences(text, ['MFA']);
  // the ``` block runs through the mismatched ~~~ line to its own ``` close;
  // only the MFA after the real close is prose.
  assert.equal(found.length, 1);
  assert.equal(text.slice(found[0].index, found[0].index + 3), 'MFA');
  assert.ok(text.slice(0, found[0].index).endsWith('```\n'));
});
