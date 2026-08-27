// Acronym extraction. Shared by every mining pass — markdown notes, exported wiki
// HTML, and spreadsheet rows all reduce to lines of text first, so one set of
// patterns covers all of them.
//
// The precision problem: "MFA (Q1 FY27)" and "Jane Doe (MFA)" look exactly like
// "MFA (Multi-Factor Authentication)" to a regex. The filter that separates them is an
// INITIALS MATCH — the candidate expansion's first letters must spell the acronym.
// It is strict enough to make mined data trustworthy and it is why a curated layer
// exists: FedRAMP and SASE fail an initials check and can only be hand-written.

const NOISE = new Set([
  'TODO', 'NOTE', 'NOTES', 'FIXME', 'WARNING', 'IMPORTANT', 'CAUTION', 'TBD', 'TBA',
  'DRAFT', 'FINAL', 'OK', 'OKAY', 'YES', 'NO', 'NEW', 'OLD', 'AND', 'THE', 'FOR',
  'NOT', 'ALL', 'ANY', 'ONE', 'TWO', 'WHO', 'WHY', 'HOW', 'NOW', 'WHAT', 'WHEN',
  'GET', 'PUT', 'POST', 'ADD', 'END', 'TOP', 'KEY', 'MAY', 'CAN', 'DID', 'HAS',
  'ITEM', 'NAME', 'DATE', 'TIME', 'TYPE', 'DONE', 'NEXT', 'OPEN', 'FROM', 'THIS',
  'THAT', 'WITH', 'WILL', 'WERE', 'BEEN', 'HTTP', 'HTTPS', 'WWW', 'PDF', 'DOCX',
  'JIRA', 'ASAP', 'FYI', 'BTW', 'AKA', 'ETC', 'VS', 'RE', 'FW', 'PS', 'ID', 'IDS',
  'US', 'UK', 'EU', 'IT', 'OR', 'IF', 'AT', 'BY', 'ON', 'IN', 'TO', 'DO', 'GO',
  'AN', 'AS', 'BE', 'IS', 'MY', 'OF', 'SO', 'UP', 'WE', 'HE', 'AM', 'PM',
]);

// Words that may be skipped when computing initials — "Cost of Goods Sold" is COGS,
// not COGS-with-an-O. Both variants get tried, so either convention matches.
const SKIPPABLE = new Set([
  'of', 'and', 'for', 'the', 'a', 'an', 'to', 'as', 'in', 'on', 'at', 'with',
  'or', 'from', 'by', 'via', 'over', 'into', '&',
]);

const NUMBER_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

const MAX_DEFINITION = 400;

export function looksLikeAcronym(tok) {
  if (!tok) return false;
  const t = tok.trim();
  if (t.length < 2 || t.length > 12) return false;
  if (!/^[0-9]?[A-Za-z][A-Za-z0-9./-]*$/.test(t)) return false;
  const upper = (t.match(/[A-Z]/g) || []).length;
  const lower = (t.match(/[a-z]/g) || []).length;
  if (upper < 2) return false;      // "Java", "Kubernetes" — words, not acronyms
  if (lower > upper) return false;  // keeps mTLS and IdP, drops Postgres
  if (NOISE.has(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))) return false;
  return true;
}

// Two ways to split, because both conventions are in live use: "EAP-TLS" counts the
// hyphen as a word break, "Cross-domain Identity Management" does not (SCIM). Every
// spelling gets tried, so neither convention loses.
function splitWords(phrase, splitHyphens) {
  return phrase
    .split(splitHyphens ? /[\s/\-–—_]+/ : /[\s/_]+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, ''))
    .filter(Boolean);
}

function initialsOf(words, skipStopwords) {
  let out = '';
  words.forEach((w, i) => {
    const lower = w.toLowerCase();
    if (skipStopwords && i > 0 && SKIPPABLE.has(lower)) return;
    out += (NUMBER_WORDS[lower] || w[0]).toUpperCase();
  });
  return out;
}

// Letters-only form of the acronym, plus the variants worth accepting: a trailing
// plural ("SANs" → SAN) and a version suffix ("SCEPv2" → SCEP).
function acronymVariants(acr) {
  const raw = acr.replace(/[^A-Za-z0-9]/g, '');
  const bare = raw.toUpperCase();
  const out = new Set([bare]);
  // Only a LOWERCASE trailing s is a plural marker — "SANs" and "IdPs" are plurals,
  // while RADIUS, PKCS, and CORS end in a capital S that belongs to the expansion.
  if (/[A-Z]s$/.test(raw)) out.add(bare.slice(0, -1));
  const versioned = bare.match(/^(.+?)V\d+$/);
  if (versioned) out.add(versioned[1]);
  return out;
}

export function initialsMatch(acr, phrase) {
  const spellings = new Set();
  for (const splitHyphens of [true, false]) {
    const words = splitWords(phrase, splitHyphens);
    if (!words.length) continue;
    spellings.add(initialsOf(words, false));
    spellings.add(initialsOf(words, true));
  }
  for (const v of acronymVariants(acr)) if (spellings.has(v)) return true;
  return false;
}

function letterCount(acr) {
  return acr.replace(/[^A-Za-z0-9]/g, '').length;
}

// "Multi-Factor Authentication hardens every login" for MFA → expansion is the first
// two words, the rest is the definition. Shortest match wins, so a longer phrase
// that also happens to match can't swallow the definition.
export function leadingExpansion(acr, text) {
  const raw = (text || '').trim().replace(/^[-–—:|\s]+/, '');
  if (!raw) return null;
  const words = raw.split(/\s+/);
  const need = letterCount(acr);
  const max = Math.min(words.length, need + 6);
  for (let n = 1; n <= max; n++) {
    const span = words.slice(0, n).join(' ');
    const clean = span.replace(/[.,;:\-–—]+$/, '').trim();
    if (initialsMatch(acr, clean)) {
      let rest = words.slice(n).join(' ').replace(/^[\s—–\-:,.)]+/, '').trim();
      if (rest.length > MAX_DEFINITION) rest = `${rest.slice(0, MAX_DEFINITION).trimEnd()}…`;
      return { expansion: clean, definition: rest || null };
    }
    // Test before breaking: the sentence-ending period often sits at the end of the
    // expansion itself ("Single Sign-On. One login for many apps.").
    if (/[.;:)]$/.test(span)) break;
  }
  return null;
}

// The mirror case: "...the Multi-Factor Authentication (MFA) rollout" — scan backwards
// from the paren. Periods and parens bound the span so it can't reach into the last
// sentence; commas are allowed because real expansions contain them.
export function trailingExpansion(acr, before) {
  const raw = (before || '').trim();
  if (!raw) return null;
  const words = raw.split(/\s+/);
  const need = letterCount(acr);
  const max = Math.min(words.length, need + 6);
  for (let n = 1; n <= max; n++) {
    const span = words.slice(words.length - n).join(' ');
    if (/[.;:()"]/.test(span)) break;
    const clean = span.replace(/^[^A-Za-z0-9]+/, '').trim();
    if (initialsMatch(acr, clean)) return clean;
  }
  return null;
}

// ── HTML → lines ─────────────────────────────────────────────────────────────
// Table cells become " | " so a two-column glossary table reads as "ACR | meaning",
// which is the same shape as the markdown bullet form. Block elements become
// newlines so a heading and the paragraph under it stay on separate lines.
const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&hellip;': '…', '&ndash;': '–', '&mdash;': '—',
  '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”',
};

export function htmlToLines(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<(br|\/tr|\/p|\/li|\/h[1-6]|\/div|\/table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter(Boolean);
}

// ── Line patterns ────────────────────────────────────────────────────────────
// Handles, in one pass: "**ACR** — meaning", "ACR: meaning", "| ACR | meaning |",
// "ACR | meaning" (from a flattened HTML table), and a bare "ACR" heading whose
// meaning is on the following line.
const STRIP_MARKUP = (s) => s.replace(/\*\*/g, '').replace(/^#{1,6}\s*/, '').replace(/^[-*•]\s*/, '').trim();

const PAIR = /^([0-9]?[A-Za-z][A-Za-z0-9./-]{1,11})\s*(?:[-–—:]|\|)\s*(.+)$/;
const BARE = /^([0-9]?[A-Za-z][A-Za-z0-9./-]{1,11})$/;

export function fromLines(lines, { allowTwoLetter = true } = {}) {
  const out = [];
  const add = (acr, rawText) => {
    if (!looksLikeAcronym(acr)) return;
    if (!allowTwoLetter && letterCount(acr) < 3) return;
    // A remaining pipe is the next table cell. Turning it into a sentence break stops
    // a third column from being absorbed into the expansion ("OID | Object Identifier
    // | Dotted-number...") while still keeping it as the definition.
    const text = rawText.replace(/\s*\|\s*/g, '. ');
    const hit = leadingExpansion(acr, text);
    if (hit) out.push({ acronym: acr, ...hit });
    else out.push({ acronym: acr, expansion: null, candidate: text.slice(0, 160) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = STRIP_MARKUP(lines[i].replace(/^\|\s*/, '').replace(/\s*\|$/, ''));
    if (!line || line.length > 500) continue;

    const pair = line.match(PAIR);
    if (pair) {
      add(pair[1], pair[2]);
      continue;
    }
    // A lone acronym on its own line — heading style. The meaning is the next line,
    // but only if that line isn't itself a heading or another lone acronym.
    const bare = line.match(BARE);
    if (bare && i + 1 < lines.length) {
      const next = STRIP_MARKUP(lines[i + 1]);
      if (next && !BARE.test(next) && next.length < 500) add(bare[1], next);
    }
  }
  return out;
}

// Inline prose: "Multi-Factor Authentication (MFA)" and "MFA (Multi-Factor Authentication)".
// Two-letter acronyms are excluded here — "a Meeting (AM)" would sail through an
// initials check, and prose has far too many of those to risk it.
const PAREN = /([^\n()]{3,120}?)\s*\(([0-9]?[A-Za-z][A-Za-z0-9./-]{1,11})\)/g;
const REVERSE_PAREN = /\b([0-9]?[A-Z][A-Za-z0-9./-]{1,11})\s*\(([^)\n]{4,120})\)/g;

export function fromParens(text) {
  const out = [];
  const src = String(text || '');

  for (const m of src.matchAll(PAREN)) {
    const acr = m[2];
    if (!looksLikeAcronym(acr) || letterCount(acr) < 3) continue;
    const expansion = trailingExpansion(acr, m[1]);
    if (expansion) out.push({ acronym: acr, expansion, definition: null });
  }

  for (const m of src.matchAll(REVERSE_PAREN)) {
    const acr = m[1];
    if (!looksLikeAcronym(acr) || letterCount(acr) < 3) continue;
    const hit = leadingExpansion(acr, m[2]);
    // The whole parenthetical has to be the expansion. "MFA (Q1 FY27)" has no
    // leftover-free match and gets dropped here.
    if (hit && !hit.definition) out.push({ acronym: acr, expansion: hit.expansion, definition: null });
  }

  return out;
}

// Spreadsheet rows: [acronym, expansion, context?]. When the header row names the
// first column "acronym", the second column IS the expansion by construction — that
// is better evidence than an initials check, and it's the only way FedRAMP-shaped
// entries (initials that don't spell the acronym) ever get mined. Without a trusted
// header, fall back to requiring the match.
export function fromTable(rows, { trusted = false, thirdColumn = 'definition' } = {}) {
  const out = [];
  for (const row of rows || []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const acr = String(row[0] ?? '').trim();
    const text = cleanCell(row[1]);
    const third = cleanCell(row[2]);
    if (!looksLikeAcronym(acr) || text.length < 3) continue;
    if (/^acronym|^abbrev/i.test(acr)) continue; // the header row itself

    // The third column is only a domain when the header said so. In list exports
    // it's a free-text detail field full of pasted URLs, which is worth keeping as
    // a definition and useless as a filter value.
    const extra = thirdColumn === 'domain'
      ? { domain: third || null }
      : { extraDefinition: third || null };

    const hit = leadingExpansion(acr, text);
    if (hit) {
      out.push({ acronym: acr, expansion: hit.expansion, definition: hit.definition, ...extra });
    } else if (trusted) {
      out.push({ acronym: acr, expansion: text.slice(0, 160), definition: null, ...extra });
    } else {
      out.push({ acronym: acr, expansion: null, candidate: text.slice(0, 160) });
    }
  }
  return out;
}

// Spreadsheet cells arrive with pasted URLs and embedded newlines. Neither belongs in
// a tooltip, and a URL will happily satisfy a length check while saying nothing.
function cleanCell(value) {
  return String(value ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasAcronymHeader(rows) {
  const first = (rows || [])[0];
  return Array.isArray(first) && /acronym|abbrev|term/i.test(String(first[0] ?? ''));
}

// Does the third column hold a category label rather than prose?
export function thirdColumnRole(rows) {
  const first = (rows || [])[0];
  const name = Array.isArray(first) ? String(first[2] ?? '') : '';
  return /context|categor|domain|area|topic|group|family/i.test(name) ? 'domain' : 'definition';
}
