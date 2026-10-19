/**
 * Chinese personal-name detector.
 *
 * For every position where a surname starts (single or compound), the candidate names are the surname
 * plus 1 or 2 given-name characters. Each candidate gets a score from:
 *   - the surname (ordinary-word surnames such as 金、高、方 score lower than 陳、林、黃);
 *   - the given-name characters (common name characters score high, never-name characters reject);
 *   - the words around it (a title or label before/after is strong evidence, a clause or amount is not);
 *   - lexicon words that start at the candidate or contain the surname character (保證金, 程序, 高達…).
 * The best-scoring length wins per start. Afterwards, names in a list (甲、乙、丙) and every other
 * occurrence of an accepted name are accepted too, and a borderline string that repeats in the text is
 * accepted. Accepted spans carry 'high' or 'low' confidence.
 */
import {
  AFTER_GREET,
  AFTER_TITLE,
  AFTER_VERB,
  BEFORE_STRONG,
  BEFORE_WEAK,
  COMPOUND_SURNAMES,
  CUE_TRIM,
  DETERMINERS,
  GIVEN_HIGH,
  GIVEN_MED,
  GIVEN_NEVER,
  LEXICON,
  LIST_SEPARATORS,
  ORDINARY_SURNAMES,
  STRONG_SURNAMES,
} from './zh-name-data';

export interface NameSpan {
  start: number;
  end: number;
  confidence?: 'high' | 'low';
}

/** A candidate scoring below this is not a name unless other evidence accepts it. */
const ACCEPT = 1.2;
/** Scores at or above this are shown as high confidence. */
const HIGH_CONFIDENCE = 2.2;
/** Bonus for a name in a list right after an accepted name (甲、乙、丙). */
const LIST_BONUS = 1.5;
/** A borderline string needs this minimum score to be accepted because it repeats in the text. */
const REPEAT_MIN = 0.6;
/** Longest name in characters: a compound surname plus two given-name characters. */
const MAX_NAME_LENGTH = 4;

const SURNAME_BASE = new Map<string, number>();
for (const c of STRONG_SURNAMES) SURNAME_BASE.set(c, 1.5);
for (const c of ORDINARY_SURNAMES) SURNAME_BASE.set(c, 0.6);

const GIVEN_SCORE = new Map<string, number>();
for (const c of GIVEN_MED) GIVEN_SCORE.set(c, 0.4);
for (const c of GIVEN_HIGH) GIVEN_SCORE.set(c, 1);

const BEFORE_STRONG_SET = new Set(BEFORE_STRONG);
const BEFORE_WEAK_SET = new Set(BEFORE_WEAK);
const AFTER_TITLE_SET = new Set(AFTER_TITLE);
const AFTER_VERB_SET = new Set(AFTER_VERB);
const AFTER_GREET_SET = new Set(AFTER_GREET);
/** Longest cue in characters, for the prefix and suffix lookups below. */
const CUE_MAX = 6;
const CUE_MIN = 1;
/** First (or last) characters of each cue list, so most positions skip the substring work. */
const firstChars = (cues: string[]) => new Set(cues.map((c) => c[0]));
const lastChars = (cues: string[]) => new Set(cues.map((c) => c[c.length - 1]));
const BEFORE_LAST = new Set([...lastChars(BEFORE_STRONG), ...lastChars(BEFORE_WEAK)]);
const TITLE_FIRST = firstChars(AFTER_TITLE);
const VERB_FIRST = firstChars(AFTER_VERB);
const LEXICON_FIRST = new Set([...LEXICON].map((w) => w[0]));
/** Every character that appears in a lexicon word. */
const LEXICON_CHARS = new Set([...LEXICON].flatMap((w) => [...w]));

const isHan = (ch: string): boolean => {
  const c = ch.charCodeAt(0);
  return (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff);
};
const isDigit = (ch: string | undefined): boolean => ch !== undefined && (/[0-9０-９]/.test(ch));

/** Score of one given-name character, or null when the character never appears in a given name. */
function givenScore(ch: string): number | null {
  if (GIVEN_NEVER.has(ch)) return null;
  return GIVEN_SCORE.get(ch) ?? -0.6;
}

/** Evidence from the text right before the candidate (a label, a role, a determiner, a digit). */
function beforeScore(text: string, start: number): number {
  let k = start;
  while (k > 0 && CUE_TRIM.has(text[k - 1])) k--;
  if (k > 0 && BEFORE_LAST.has(text[k - 1])) {
    for (let len = CUE_MAX; len >= CUE_MIN; len--) {
      if (k - len < 0) continue;
      if (BEFORE_STRONG_SET.has(text.slice(k - len, k))) return 2;
    }
    for (let len = CUE_MAX; len >= CUE_MIN; len--) {
      if (k - len < 0) continue;
      if (BEFORE_WEAK_SET.has(text.slice(k - len, k))) return 0.6;
    }
  }
  if (start > 0 && (DETERMINERS.has(text[start - 1]) || isDigit(text[start - 1]))) return -1;
  return 0;
}

/** Evidence from the text right after the candidate (a title, a greeting, a verb, digits). */
function afterScore(text: string, end: number): number {
  // A digit touching the name (金大中3) is suspicious; a digit after a space (a table cell) is not.
  if (isDigit(text[end])) return -1;
  let k = end;
  while (k < text.length && (text[k] === ' ' || text[k] === '\u3000')) k++;
  if (TITLE_FIRST.has(text[k])) {
    for (let len = CUE_MAX; len >= CUE_MIN; len--) {
      if (k + len > text.length) continue;
      if (AFTER_TITLE_SET.has(text.slice(k, k + len))) return 2;
    }
  }
  if (AFTER_GREET_SET.has(text[k])) return 1.5;
  if (text.startsWith('你好', k)) return 1.5;
  if (VERB_FIRST.has(text[k])) {
    for (let len = CUE_MAX; len >= CUE_MIN; len--) {
      if (k + len > text.length) continue;
      if (AFTER_VERB_SET.has(text.slice(k, k + len))) return 0.6;
    }
  }
  if (text[k] === '的') return 0.5;
  return 0;
}

/** A lexicon word that starts earlier and covers the candidate's surname character (保證金 covers 金). */
function coveredPenalty(text: string, start: number): number {
  if (!LEXICON_CHARS.has(text[start])) return 0;
  for (let j = start - 1; j >= Math.max(0, start - 3); j--) {
    for (let len = 2; len <= 4; len++) {
      const e = j + len;
      if (e <= start || e > text.length) continue;
      if (LEXICON.has(text.slice(j, e))) return -2;
    }
  }
  return 0;
}

/** A lexicon word that starts at the candidate and is at most as long as the candidate (高達, 黃金生). */
function prefixPenalty(text: string, start: number, length: number): number {
  if (!LEXICON_FIRST.has(text[start])) return 0;
  for (let k = 2; k <= length; k++) {
    if (LEXICON.has(text.slice(start, start + k))) return -3;
  }
  return 0;
}

const CELL_BREAK = new Set(['\t', '\n', '\r']);

/** True when the span is the only text between cell or line breaks. */
function isWholeCell(text: string, start: number, end: number): boolean {
  return (start === 0 || CELL_BREAK.has(text[start - 1])) && (end === text.length || CELL_BREAK.has(text[end]));
}

/** True when every given-name character is one the lists know (not just unrecognised). */
function allKnownGiven(text: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (!GIVEN_SCORE.has(text[k])) return false;
  return true;
}

/** Score of the name with the given surname and given-name length, or null when it cannot be a name. */
function scoreName(text: string, start: number, surnameLen: number, base: number, givenLen: number, startContext: number): number | null {
  const end = start + surnameLen + givenLen;
  if (end > text.length) return null;
  let score = base;
  for (let k = 0; k < givenLen; k++) {
    const ch = text[start + surnameLen + k];
    if (!isHan(ch)) return null;
    const g = givenScore(ch);
    if (g === null) return null;
    score += g;
  }
  const length = surnameLen + givenLen;
  score += startContext + afterScore(text, end);
  score += prefixPenalty(text, start, length);
  // A name that fills a whole table cell or line (a column of names in a spreadsheet) has a cue of its own.
  if (isWholeCell(text, start, end) && allKnownGiven(text, start + surnameLen, end)) score += 1;
  // A two-character given part that is an ordinary word (向主治 from 主治醫師) is not a given name.
  if (givenLen === 2 && LEXICON.has(text.slice(start + surnameLen, end))) score -= 2;
  return score;
}

interface Candidate {
  start: number;
  end: number;
  score: number;
}

/** The best candidate starting at `start`, or null. Ties go to the longer name. */
function bestAt(text: string, start: number): Candidate | null {
  const options: [number, number][] = [];
  const compound = COMPOUND_SURNAMES[text.slice(start, start + 2)];
  if (compound !== undefined) options.push([2, compound]);
  const single = SURNAME_BASE.get(text[start]);
  if (single !== undefined) options.push([1, single]);
  let best: Candidate | null = null;
  // Context before the name and words covering the surname character do not depend on the name's length.
  const startContext = beforeScore(text, start) + coveredPenalty(text, start);
  for (const [surnameLen, base] of options) {
    for (let givenLen = 1; givenLen <= 2; givenLen++) {
      const score = scoreName(text, start, surnameLen, base, givenLen, startContext);
      if (score === null) continue;
      if (!best || score >= best.score) best = { start, end: start + surnameLen + givenLen, score };
    }
  }
  return best;
}

/** Detects personal names in Traditional Chinese text. Returns non-overlapping spans in text order. */
export function detectChineseNames(text: string): NameSpan[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = bestAt(text, i);
    if (c && c.score >= REPEAT_MIN) candidates.push(c);
  }

  const taken = new Uint8Array(text.length);
  const accepted = new Map<number, { end: number; confidence: 'high' | 'low' }>();
  const free = (s: number, e: number) => {
    for (let k = s; k < e; k++) if (taken[k]) return false;
    return true;
  };
  const endingAt = new Map<number, number>();
  const accept = (s: number, e: number, confidence: 'high' | 'low') => {
    for (let k = s; k < e; k++) taken[k] = 1;
    accepted.set(s, { end: e, confidence });
    endingAt.set(e, s);
  };

  // Pass 1: strongest candidates first, without overlaps.
  const byScore = [...candidates].sort((a, b) => b.score - a.score || a.start - b.start);
  for (const c of byScore) {
    if (c.score < ACCEPT || !free(c.start, c.end)) continue;
    accept(c.start, c.end, c.score >= HIGH_CONFIDENCE ? 'high' : 'low');
  }

  // Pass 2: names in a list after an accepted name (王大明、李美玲、張家豪).
  const byStart = [...candidates].sort((a, b) => a.start - b.start);
  for (const c of byStart) {
    if (accepted.has(c.start) || !free(c.start, c.end)) continue;
    if (c.start === 0 || !LIST_SEPARATORS.has(text[c.start - 1])) continue;
    if (!endingAt.has(c.start - 1)) continue;
    if (c.score + LIST_BONUS >= ACCEPT) accept(c.start, c.end, c.score + LIST_BONUS >= HIGH_CONFIDENCE ? 'high' : 'low');
  }

  // Pass 3: every other occurrence of an accepted name (one scan over the text, names are 2–4 characters).
  const names = new Map<string, 'high' | 'low'>();
  for (const [s, v] of accepted) {
    const str = text.slice(s, v.end);
    if (names.get(str) !== 'high') names.set(str, v.confidence);
  }
  for (let i = 0; i < text.length; i++) {
    for (let len = 2; len <= MAX_NAME_LENGTH && i + len <= text.length; len++) {
      const confidence = names.get(text.slice(i, i + len));
      if (confidence !== undefined && free(i, i + len)) accept(i, i + len, confidence);
    }
  }

  // Pass 4: a borderline string that repeats in the text is accepted (counted in one scan).
  const borderline = new Map<string, number>();
  for (const c of candidates) {
    if (c.score < REPEAT_MIN || accepted.has(c.start) || !free(c.start, c.end)) continue;
    borderline.set(text.slice(c.start, c.end), 0);
  }
  if (borderline.size > 0) {
    for (let i = 0; i < text.length; i++) {
      for (let len = 2; len <= MAX_NAME_LENGTH && i + len <= text.length; len++) {
        const str = text.slice(i, i + len);
        if (borderline.has(str)) borderline.set(str, borderline.get(str)! + 1);
      }
    }
    for (const c of candidates) {
      if (c.score < REPEAT_MIN || accepted.has(c.start) || !free(c.start, c.end)) continue;
      if ((borderline.get(text.slice(c.start, c.end)) ?? 0) >= 2) accept(c.start, c.end, 'low');
    }
  }

  return [...accepted]
    .sort((a, b) => a[0] - b[0])
    .map(([start, v]) => ({ start, end: v.end, confidence: v.confidence }));
}
