import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeAcronym, initialsMatch, leadingExpansion, trailingExpansion,
  fromLines, fromParens, fromTable, htmlToLines, hasAcronymHeader, thirdColumnRole,
} from '../scripts/extract.js';

test('looksLikeAcronym keeps mixed-case acronyms and rejects words', () => {
  assert.equal(looksLikeAcronym('MFA'), true);
  assert.equal(looksLikeAcronym('mTLS'), true);
  assert.equal(looksLikeAcronym('IdP'), true);
  assert.equal(looksLikeAcronym('SCEPv2'), true);
  assert.equal(looksLikeAcronym('Kubernetes'), false); // only one capital
  assert.equal(looksLikeAcronym('Postgres'), false);
  assert.equal(looksLikeAcronym('TODO'), false);       // on the noise list
  assert.equal(looksLikeAcronym('A'), false);          // too short
});

test('initialsMatch tries both stopword conventions', () => {
  assert.equal(initialsMatch('COGS', 'Cost of Goods Sold'), true);
  assert.equal(initialsMatch('CGS', 'Cost of Goods Sold'), true);
});

test('initialsMatch tries both hyphen conventions', () => {
  // needs the hyphen treated as a word break
  assert.equal(initialsMatch('EAP-TLS', 'Extensible Authentication Protocol Transport Layer Security'), true);
  // needs the hyphen NOT treated as a word break, plus a skipped stopword
  assert.equal(initialsMatch('SCIM', 'System for Cross-domain Identity Management'), true);
});

test('initialsMatch handles plurals, version suffixes and number words', () => {
  assert.equal(initialsMatch('SANs', 'Subject Alternative Name'), true);
  assert.equal(initialsMatch('SCEPv2', 'Simple Certificate Enrollment Protocol'), true);
  assert.equal(initialsMatch('2FA', 'Two Factor Authentication'), true);
  // a capital trailing S belongs to the expansion and must not be stripped as a plural
  assert.equal(initialsMatch('CORS', 'Cross Origin Resource'), false);
  assert.equal(initialsMatch('CORS', 'Cross Origin Resource Sharing'), true);
});

test('the initials filter rejects parentheticals that are not expansions', () => {
  assert.equal(initialsMatch('MFA', 'Q1 FY27'), false);
  assert.equal(initialsMatch('MFA', 'Jane Doe'), false);
});

test('FedRAMP fails the initials check — this is why a curated layer must exist', () => {
  assert.equal(initialsMatch('FedRAMP', 'Federal Risk and Authorization Management Program'), false);
});

test('leadingExpansion splits the expansion from a trailing definition', () => {
  const hit = leadingExpansion('MFA', 'Multi-Factor Authentication hardens every login.');
  assert.equal(hit.expansion, 'Multi-Factor Authentication');
  assert.equal(hit.definition, 'hardens every login.');
});

test('leadingExpansion returns null when nothing spells the acronym', () => {
  assert.equal(leadingExpansion('MFA', 'Q1 FY27'), null);
});

test('trailingExpansion scans backwards from a parenthesis', () => {
  assert.equal(
    trailingExpansion('MFA', 'we rolled out Multi-Factor Authentication'),
    'Multi-Factor Authentication',
  );
  assert.equal(trailingExpansion('MFA', 'a note from Jane Doe'), null);
});

test('fromLines handles the bullet, colon and table-cell forms', () => {
  const out = fromLines([
    '**MFA** — Multi-Factor Authentication',
    'SSO: Single Sign-On',
    '| SCIM | System for Cross-domain Identity Management |',
  ]);
  const found = Object.fromEntries(out.filter((e) => e.expansion).map((e) => [e.acronym, e.expansion]));
  assert.equal(found.MFA, 'Multi-Factor Authentication');
  assert.equal(found.SSO, 'Single Sign-On');
  assert.equal(found.SCIM, 'System for Cross-domain Identity Management');
});

test('fromParens reads both orders and skips two-letter acronyms', () => {
  const out = fromParens('We shipped Multi-Factor Authentication (MFA) last quarter.');
  assert.ok(out.some((e) => e.acronym === 'MFA' && e.expansion === 'Multi-Factor Authentication'));
  const reversed = fromParens('We shipped MFA (Multi-Factor Authentication) last quarter.');
  assert.ok(reversed.some((e) => e.acronym === 'MFA' && e.expansion === 'Multi-Factor Authentication'));
  // "a Meeting (AM)" would pass an initials check; prose has far too many of those
  assert.equal(fromParens('a Meeting (AM)').length, 0);
});

test('fromParens rejects a parenthetical that is not an expansion', () => {
  assert.equal(fromParens('MFA (Q1 FY27)').length, 0);
  assert.equal(fromParens('signed off by Jane Doe (MFA)').length, 0);
});

test('htmlToLines flattens table cells into the pair form', () => {
  const lines = htmlToLines('<table><tr><td>MFA</td><td>Multi-Factor Authentication</td></tr></table>');
  assert.deepEqual(lines, ['MFA | Multi-Factor Authentication']);
});

test('a trusted header lets initials-mismatched rows through', () => {
  const rows = [
    ['Acronym', 'Expansion'],
    ['FedRAMP', 'Federal Risk and Authorization Management Program'],
  ];
  assert.equal(hasAcronymHeader(rows), true);
  const trusted = fromTable(rows, { trusted: true });
  assert.equal(trusted[0].acronym, 'FedRAMP');
  assert.equal(trusted[0].expansion, 'Federal Risk and Authorization Management Program');
  // without the header's guarantee the same row is only a candidate
  assert.equal(fromTable(rows, { trusted: false })[0].expansion, null);
});

test('thirdColumnRole tells a category label from prose', () => {
  assert.equal(thirdColumnRole([['Acronym', 'Expansion', 'Category']]), 'domain');
  assert.equal(thirdColumnRole([['Acronym', 'Expansion', 'Notes']]), 'definition');
});
