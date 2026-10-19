/**
 * 白名單（不要隱藏的詞）and 黑名單（一定要隱藏的詞）.
 *
 * Pure functions plus a small localStorage store, following pattern-store.ts. Nothing here touches the DOM,
 * so the rules can be tested on their own; detector.ts applies them inside detect(), which every file format
 * goes through (the text of a PDF, Word, Excel, TXT or Markdown file is detected the same way).
 */
import { CATEGORIES, type Category } from './types';

export const WORD_LISTS_STORAGE_KEY = 'deid.wordLists.v1';
/** Longest word a list accepts, in characters (UTF-16 units, the same as the text offsets). */
export const MAX_WORD_LENGTH = 50;
/** Most words per list. */
export const MAX_WORDS = 1000;

export interface BlacklistEntry {
  word: string;
  category: Category;
}

export interface WordLists {
  version: 1;
  whitelist: string[];
  blacklist: BlacklistEntry[];
}

export interface WordSpan {
  start: number;
  end: number;
}

export interface BlacklistHit extends WordSpan {
  category: Category;
}

export function emptyWordLists(): WordLists {
  return { version: 1, whitelist: [], blacklist: [] };
}

/**
 * Plain-language reason a word cannot go on a list, or null when it can. An empty word is not a problem
 * here; callers simply do not add it.
 */
export function wordProblem(word: string): string | null {
  const w = word.trim();
  if (!w) return null;
  if (/[\r\n\t]/.test(w)) return '一次只能加入一個詞，不可換行';
  if (w.length > MAX_WORD_LENGTH) return `詞語最多 ${MAX_WORD_LENGTH} 個字`;
  return null;
}

/** Adds a word to the whitelist. It is taken off the blacklist if it was there (the latest choice wins). */
export function addWhitelistWord(lists: WordLists, word: string): WordLists {
  const w = word.trim();
  if (!w || wordProblem(w)) return lists;
  const whitelist = lists.whitelist.includes(w) ? lists.whitelist : [...lists.whitelist, w];
  return { ...lists, whitelist, blacklist: lists.blacklist.filter((b) => b.word !== w) };
}

/** Adds a word to the blacklist with its category (an existing entry takes the new category). Taken off the whitelist. */
export function addBlacklistWord(lists: WordLists, word: string, category: Category): WordLists {
  const w = word.trim();
  if (!w || wordProblem(w)) return lists;
  const blacklist = lists.blacklist.some((b) => b.word === w)
    ? lists.blacklist.map((b) => (b.word === w ? { word: w, category } : b))
    : [...lists.blacklist, { word: w, category }];
  return { ...lists, whitelist: lists.whitelist.filter((x) => x !== w), blacklist };
}

export function removeWhitelistWord(lists: WordLists, word: string): WordLists {
  return { ...lists, whitelist: lists.whitelist.filter((x) => x !== word) };
}

export function removeBlacklistWord(lists: WordLists, word: string): WordLists {
  return { ...lists, blacklist: lists.blacklist.filter((b) => b.word !== word) };
}

/** Adds every word of `incoming` to `base` (import). Words already present are kept as they are. */
export function mergeWordLists(base: WordLists, incoming: WordLists): WordLists {
  let next = base;
  for (const w of incoming.whitelist) next = addWhitelistWord(next, w);
  for (const b of incoming.blacklist) next = addBlacklistWord(next, b.word, b.category);
  return next;
}

/**
 * Every occurrence of every blacklist word, overlapping ones included. Not yet resolved against each other
 * (detector.ts does that, longest word first).
 */
export function blacklistOccurrences(text: string, blacklist: BlacklistEntry[]): BlacklistHit[] {
  const hits: BlacklistHit[] = [];
  for (const { word, category } of blacklist) {
    if (!word) continue;
    for (let p = text.indexOf(word); p !== -1; p = text.indexOf(word, p + 1)) {
      hits.push({ start: p, end: p + word.length, category });
    }
  }
  return hits;
}

/**
 * Drops every item that lies entirely inside an occurrence of a whitelist word. That covers an item whose
 * text equals the word, and a longer item never (金城 does not protect 金城武, which sticks out of it).
 */
export function applyWhitelist<T extends WordSpan>(text: string, items: T[], whitelist: string[]): T[] {
  if (whitelist.length === 0) return items;
  const covered: WordSpan[] = [];
  for (const w of whitelist) {
    if (!w) continue;
    for (let p = text.indexOf(w); p !== -1; p = text.indexOf(w, p + 1)) covered.push({ start: p, end: p + w.length });
  }
  if (covered.length === 0) return items;
  return items.filter((it) => !covered.some((c) => c.start <= it.start && it.end <= c.end));
}

/**
 * The blacklist wins over automatic items: the parts of an automatic item that a blacklist span covers are
 * cut away, and the rest of it stays (so a name is not left half-hidden or dropped silently). Pieces that are
 * only whitespace are dropped. `forced` must not overlap itself.
 */
export function applyBlacklist<T extends WordSpan>(text: string, autos: T[], forced: WordSpan[]): T[] {
  if (forced.length === 0) return autos;
  const out: T[] = [];
  for (const a of autos) {
    const cuts = forced.filter((f) => f.start < a.end && f.end > a.start).sort((x, y) => x.start - y.start);
    if (cuts.length === 0) {
      out.push(a);
      continue;
    }
    let cursor = a.start;
    for (const c of cuts) {
      if (c.start > cursor) out.push({ ...a, start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
    }
    if (cursor < a.end) out.push({ ...a, start: cursor, end: a.end });
  }
  return out.filter((p) => text.slice(p.start, p.end).trim() !== '');
}

// ---------------------------------------------------------------------------------------
// Reading and writing (storage, import/export)
// ---------------------------------------------------------------------------------------
export type WordListsParse = { ok: true; lists: WordLists } | { ok: false; error: string };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Checks a parsed list file. `strict` (import) rejects the whole file on the first bad entry and says why;
 * otherwise (startup from storage) bad entries are skipped. Empty words are ignored in both modes.
 */
function readWordLists(raw: unknown, strict: boolean): WordListsParse {
  const fail = (error: string): WordListsParse => ({ ok: false, error });
  if (!isRecord(raw)) return fail('檔案內容不是詞語清單');
  if (raw.version !== 1) return fail('不支援的清單版本，請使用本工具「匯出清單」產生的檔案');
  if (!Array.isArray(raw.whitelist) || !Array.isArray(raw.blacklist)) return fail('清單缺少「白名單」或「黑名單」的資料');
  if (raw.whitelist.length > MAX_WORDS || raw.blacklist.length > MAX_WORDS) return fail(`每份清單最多 ${MAX_WORDS} 筆`);

  const problems: string[] = [];
  const whitelist: string[] = [];
  raw.whitelist.forEach((w: unknown, i: number) => {
    if (typeof w !== 'string') return void problems.push(`白名單第 ${i + 1} 筆不是文字`);
    const t = w.trim();
    if (!t) return;
    const p = wordProblem(t);
    if (p) return void problems.push(`白名單第 ${i + 1} 筆：${p}`);
    if (!whitelist.includes(t)) whitelist.push(t);
  });
  const blacklist: BlacklistEntry[] = [];
  raw.blacklist.forEach((b: unknown, i: number) => {
    if (!isRecord(b) || typeof b.word !== 'string') return void problems.push(`黑名單第 ${i + 1} 筆格式不正確`);
    const t = b.word.trim();
    if (!t) return;
    const p = wordProblem(t);
    if (p) return void problems.push(`黑名單第 ${i + 1} 筆：${p}`);
    if (!CATEGORIES.includes(b.category as Category)) return void problems.push(`黑名單第 ${i + 1} 筆的類別不認識`);
    if (blacklist.some((x) => x.word === t)) return;
    blacklist.push({ word: t, category: b.category as Category });
  });
  if (strict && problems.length > 0) {
    return fail(`清單內容有誤，未匯入：${problems.slice(0, 3).join('；')}${problems.length > 3 ? '…' : ''}`);
  }
  // A word on both lists is a hidden word: the blacklist keeps it.
  const black = new Set(blacklist.map((b) => b.word));
  return { ok: true, lists: { version: 1, whitelist: whitelist.filter((w) => !black.has(w)), blacklist } };
}

/** Parses the text of an exported list file (import). Garbage is rejected with a plain-language reason. */
export function parseWordListsJson(text: string): WordListsParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '檔案不是有效的 JSON，請使用本工具「匯出清單」產生的檔案' };
  }
  return readWordLists(raw, true);
}

export function serializeWordLists(lists: WordLists): string {
  return JSON.stringify({ version: 1, whitelist: lists.whitelist, blacklist: lists.blacklist }, null, 2) + '\n';
}

// localStorage: every access is wrapped, since storage can be blocked, full, or missing (private windows).
function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Reads the stored lists; anything unreadable gives empty lists. */
export function loadWordLists(): WordLists {
  try {
    const raw = storage()?.getItem(WORD_LISTS_STORAGE_KEY);
    if (!raw) return emptyWordLists();
    const parsed = readWordLists(JSON.parse(raw), false);
    return parsed.ok ? parsed.lists : emptyWordLists();
  } catch {
    return emptyWordLists();
  }
}

/** Returns false when the browser would not keep the lists (storage blocked or full). */
export function saveWordLists(lists: WordLists): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(WORD_LISTS_STORAGE_KEY, JSON.stringify(lists));
    return true;
  } catch {
    return false;
  }
}

/** The lists in use by this page. Kept in memory too, so changes still apply when the browser will not store them. */
let current: WordLists | null = null;

/** Called once at startup (main.ts). */
export function initWordLists(): void {
  current = loadWordLists();
}

export function getWordLists(): WordLists {
  if (!current) current = loadWordLists();
  return current;
}

/** Makes `next` the lists in use and stores them. Returns false when they could not be stored. */
export function setWordLists(next: WordLists): boolean {
  current = next;
  return saveWordLists(next);
}

/** A fingerprint of the lists, used to notice changes (see process-view.ts patternKey). */
export function wordListsKey(lists: WordLists = getWordLists()): string {
  return JSON.stringify([lists.whitelist, lists.blacklist]);
}
