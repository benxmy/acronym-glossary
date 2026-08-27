// Finding known acronyms in text. The matching rules here are ported from a DOM
// annotator with the DOM removed: what carries over is where the correctness lives.
//
// Matching is case-SENSITIVE. "AM" is an acronym, "am" is a verb, and "CAT" inside
// "CATALOG" is neither. Never uppercase an acronym before matching it — "mTLS" and
// "IdP" have to match their own casing.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

// One regex for the whole glossary — a few hundred alternatives is far cheaper than a
// few hundred passes over the text. Longest first, so "EAP-TLS" wins over "EAP".
//
// Boundaries are spelled out rather than using \b, because acronyms contain '.', '/'
// and '-', which \b treats as boundaries in their own right. The leading boundary is
// captured so it can be put back.
export function buildMatcher(keys) {
  const usable = [...new Set(keys)]
    .filter((k) => k.replace(/[^A-Za-z0-9]/g, '').length >= 2)
    .sort((a, b) => b.length - a.length);
  if (!usable.length) return null;
  const alt = usable.map(escapeRe).join('|');
  return new RegExp(`(^|[^A-Za-z0-9])(${alt})(s?)(?![A-Za-z0-9])`, 'g');
}

// AM and PM are real acronyms in plenty of glossaries — Asset Management, Account
// Manager, Preventive Maintenance — and they also collide with clock time. "Thu AM",
// "2026-08-27 AM" and "5:21 PM ET" are meridiems, and expanding one is the single most
// likely false positive in ordinary business prose. The test is what comes before: a
// digit, a weekday, or a relative day word.
//
// This is the only hardcoded special case in the codebase. It earns its place because
// the collision is with something people write constantly.
const MERIDIEM = /^(AM|PM)$/;
const BEFORE_MERIDIEM =
  /(\d|\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\.?|\b(today|tomorrow|yesterday))\s*$/i;

export function isMeridiem(acr, textBefore) {
  return MERIDIEM.test(acr) && BEFORE_MERIDIEM.test(textBefore);
}

// Regions of a markdown document where an acronym is markup or data, not prose. The
// equivalent in a rendered view is a tag denylist (code, pre, a, abbr, kbd, textarea).
// Overlap between patterns is harmless — a backtick span inside a fence just yields a
// redundant subrange.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---/;
const REPEATING = [
  /^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[^\n]*$/gm, // fenced code
  /`[^`\n]*`/g,                                        // inline code
  /\[[^\]\n]*\]\([^)\n]*\)/g,                          // whole markdown link
  /\]\([^)\s]*/g,                                      // link target, unclosed
  /\bhttps?:\/\/\S+/g,                                 // bare URL
];

export function skipRanges(text) {
  const ranges = [];
  const front = text.match(FRONTMATTER);
  if (front && front.index === 0) ranges.push([0, front[0].length]);
  for (const pattern of REPEATING) {
    for (const m of text.matchAll(pattern)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

export function inRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Every place a known acronym appears in prose, in document order.
 * `keys` are acronyms exactly as stored; each result's `acronym` is the key verbatim.
 */
export function findOccurrences(text, keys) {
  const matcher = buildMatcher(keys);
  if (!matcher || !text) return [];
  const skip = skipRanges(text);
  const out = [];
  matcher.lastIndex = 0;
  let m;
  while ((m = matcher.exec(text)) !== null) {
    const [, lead, acronym, plural] = m;
    const index = m.index + lead.length;
    if (inRanges(index, skip)) continue;
    if (isMeridiem(acronym, text.slice(0, index))) continue;
    out.push({ acronym, index, length: acronym.length + plural.length, plural });
  }
  return out;
}
