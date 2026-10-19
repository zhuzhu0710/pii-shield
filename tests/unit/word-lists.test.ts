import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/core/detector';
import {
  MAX_WORD_LENGTH,
  WORD_LISTS_STORAGE_KEY,
  addBlacklistWord,
  addWhitelistWord,
  applyBlacklist,
  applyWhitelist,
  emptyWordLists,
  loadWordLists,
  mergeWordLists,
  parseWordListsJson,
  removeBlacklistWord,
  removeWhitelistWord,
  saveWordLists,
  serializeWordLists,
  wordProblem,
  type WordLists,
} from '../../src/core/word-lists';
import type { Category, Pattern } from '../../src/core/types';

/** A plain RegExp rule, enabled, in the given category. */
const rule = (regex: string, category: Category = '姓名'): Pattern => ({
  id: `t-${regex}`,
  name: regex,
  category,
  source: 'custom',
  regex,
  example: '',
  enabled: true,
});

const lists = (over: Partial<WordLists>): WordLists => ({ ...emptyWordLists(), ...over });

/** The active items, as [original, category] pairs in text order. */
const active = (text: string, patterns: Pattern[], l: WordLists) =>
  detect(text, patterns, undefined, l)
    .filter((it) => it.active)
    .map((it) => [it.original, it.category]);

const noOverlap = (text: string, patterns: Pattern[], l: WordLists) => {
  const items = detect(text, patterns, undefined, l).filter((it) => it.active);
  for (let i = 1; i < items.length; i++) expect(items[i].start).toBeGreaterThanOrEqual(items[i - 1].end);
};

const STORAGE_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  if (STORAGE_DESCRIPTOR) Object.defineProperty(globalThis, 'localStorage', STORAGE_DESCRIPTOR);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.restoreAllMocks();
});

describe('whitelist (不要隱藏的詞)', () => {
  it('keeps an item whose text equals a whitelist word from being produced', () => {
    const text = '本工程由甲方委託乙方施作，承辦人為林雅婷。';
    const pats = [rule('施作'), rule('林雅婷')];
    expect(active(text, pats, emptyWordLists())).toEqual([
      ['施作', '姓名'],
      ['林雅婷', '姓名'],
    ]);
    expect(active(text, pats, lists({ whitelist: ['施作'] }))).toEqual([['林雅婷', '姓名']]);
  });

  it('drops an item that lies entirely inside an occurrence of a whitelist word', () => {
    // 金城 is inside 金城武先生, so the detected 金城 is not produced.
    expect(active('金城武先生來電', [rule('金城')], lists({ whitelist: ['金城武先生'] }))).toEqual([]);
  });

  it('does not protect a longer item that only starts with the whitelist word', () => {
    // 金城武 sticks out of the whitelisted 金城, so it is still hidden.
    expect(active('金城武來電', [rule('金城武')], lists({ whitelist: ['金城'] }))).toEqual([['金城武', '姓名']]);
  });

  it('applies to every occurrence of the word in the text', () => {
    const text = '施作一、施作二、施作三';
    expect(active(text, [rule('施作')], lists({ whitelist: ['施作'] }))).toEqual([]);
  });

  it('applyBlacklist cuts only the covered part of an item and drops whitespace-only pieces', () => {
    const text = '王 大明';
    // The blacklist covers the space and 大: 王 and 明 remain as pieces of the automatic item.
    expect(applyBlacklist(text, [{ start: 0, end: 4 }], [{ start: 1, end: 3 }])).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
    // Only the space is left between two blacklisted words: it is dropped, not kept as an item.
    expect(applyBlacklist(text, [{ start: 0, end: 4 }], [{ start: 0, end: 1 }, { start: 2, end: 4 }])).toEqual([]);
  });

  it('applyWhitelist keeps items that stick out of, or lie outside, every whitelisted span', () => {
    const items = [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ];
    expect(applyWhitelist('abcdefg', items, ['ab'])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
  });
});

describe('blacklist (一定要隱藏的詞)', () => {
  it('turns every occurrence of a blacklist word into an item of the chosen category', () => {
    const text = '甲公司與甲公司合作，另函甲公司。';
    expect(active(text, [], lists({ blacklist: [{ word: '甲公司', category: '公司' }] }))).toEqual([
      ['甲公司', '公司'],
      ['甲公司', '公司'],
      ['甲公司', '公司'],
    ]);
  });

  it('wins over an overlapping automatic item: the automatic item keeps only the part outside the blacklist word', () => {
    // 王大明 is detected as a name; 大明 is blacklisted as an address. The 王 is still hidden as a name.
    const text = '承辦人王大明';
    const out = active(text, [rule('王大明')], lists({ blacklist: [{ word: '大明', category: '地址' }] }));
    expect(out).toEqual([
      ['王', '姓名'],
      ['大明', '地址'],
    ]);
    noOverlap(text, [rule('王大明')], lists({ blacklist: [{ word: '大明', category: '地址' }] }));
  });

  it('replaces an automatic item completely when the blacklist word covers it', () => {
    expect(active('王大明', [rule('王大明')], lists({ blacklist: [{ word: '王大明', category: '公司' }] }))).toEqual([
      ['王大明', '公司'],
    ]);
  });

  it('is not removed by the whitelist (the blacklist is a stronger instruction)', () => {
    // Only adding through the UI moves a word between lists; a file that has both keeps the word hidden.
    const l = lists({ whitelist: ['林雅婷'], blacklist: [{ word: '林雅婷', category: '姓名' }] });
    expect(active('林雅婷', [rule('林雅婷')], l)).toEqual([['林雅婷', '姓名']]);
  });

  it('uses the enabled rule retention of its category, like manual items do', () => {
    const withRetention = { ...rule('X'), retention: { mode: 'surname' as const } };
    const [item] = detect('王小明', [withRetention], undefined, lists({ blacklist: [{ word: '王小明', category: '姓名' }] }));
    expect(item.retention).toEqual({ mode: 'surname' });
  });
});

describe('cleaning up words', () => {
  it('ignores empty and whitespace-only words', () => {
    const base = lists({ whitelist: ['施作'] });
    expect(addWhitelistWord(base, '   ')).toEqual(base);
    expect(addWhitelistWord(base, '')).toEqual(base);
    expect(addBlacklistWord(base, ' \t ', '姓名')).toEqual(base);
    expect(active('王小明', [], lists({ blacklist: [{ word: '  ', category: '姓名' }] }))).toEqual([]);
    expect(parseWordListsJson(JSON.stringify({ version: 1, whitelist: ['  ', ''], blacklist: [{ word: ' ', category: '姓名' }] }))).toEqual({
      ok: true,
      lists: emptyWordLists(),
    });
  });

  it('dedupes a word added twice, and a blacklist word added again takes the new category', () => {
    let l = addWhitelistWord(addWhitelistWord(emptyWordLists(), ' 施作 '), '施作');
    expect(l.whitelist).toEqual(['施作']);
    l = addBlacklistWord(addBlacklistWord(l, '甲公司', '姓名'), '甲公司', '公司');
    expect(l.blacklist).toEqual([{ word: '甲公司', category: '公司' }]);
  });

  it('moves a word between the two lists rather than keeping it on both', () => {
    let l = addBlacklistWord(emptyWordLists(), '林雅婷', '姓名');
    l = addWhitelistWord(l, '林雅婷');
    expect(l).toEqual({ version: 1, whitelist: ['林雅婷'], blacklist: [] });
    l = addBlacklistWord(l, '林雅婷', '姓名');
    expect(l).toEqual({ version: 1, whitelist: [], blacklist: [{ word: '林雅婷', category: '姓名' }] });
  });

  it('refuses words that are too long or span lines, with a plain reason', () => {
    expect(wordProblem('甲'.repeat(MAX_WORD_LENGTH + 1))).toContain(`${MAX_WORD_LENGTH}`);
    expect(wordProblem('甲\n乙')).toContain('一次只能加入一個詞');
    expect(wordProblem('甲'.repeat(MAX_WORD_LENGTH))).toBeNull();
    expect(addWhitelistWord(emptyWordLists(), '甲\n乙')).toEqual(emptyWordLists());
  });

  it('removes words from either list', () => {
    const l = lists({ whitelist: ['施作'], blacklist: [{ word: '甲公司', category: '公司' }] });
    expect(removeWhitelistWord(l, '施作').whitelist).toEqual([]);
    expect(removeBlacklistWord(l, '甲公司').blacklist).toEqual([]);
  });

  it('merges an imported list into the current one without duplicates', () => {
    const merged = mergeWordLists(
      lists({ whitelist: ['施作'], blacklist: [{ word: '甲公司', category: '公司' }] }),
      lists({ whitelist: ['施作', '承辦人'], blacklist: [{ word: '林雅婷', category: '姓名' }] }),
    );
    expect(merged.whitelist).toEqual(['施作', '承辦人']);
    expect(merged.blacklist).toEqual([
      { word: '甲公司', category: '公司' },
      { word: '林雅婷', category: '姓名' },
    ]);
  });
});

describe('overlaps', () => {
  it('blacklist items never overlap each other, longest word first', () => {
    const l = lists({
      blacklist: [
        { word: '甲公司', category: '公司' },
        { word: '公司', category: '地址' },
      ],
    });
    expect(active('甲公司簽約', [], l)).toEqual([['甲公司', '公司']]);
  });
});

describe('storage', () => {
  it('loads empty lists when nothing is stored', () => {
    expect(loadWordLists()).toEqual(emptyWordLists());
  });

  it('saves and loads the same lists', () => {
    const l = lists({ whitelist: ['施作'], blacklist: [{ word: '甲公司', category: '公司' }] });
    expect(saveWordLists(l)).toBe(true);
    expect(loadWordLists()).toEqual(l);
  });

  it('skips bad stored entries instead of dropping the whole list', () => {
    localStorage.setItem(
      WORD_LISTS_STORAGE_KEY,
      JSON.stringify({ version: 1, whitelist: ['施作', 42], blacklist: [{ word: '甲公司', category: '公司' }, { word: 'x', category: '不存在' }] }),
    );
    expect(loadWordLists()).toEqual({ version: 1, whitelist: ['施作'], blacklist: [{ word: '甲公司', category: '公司' }] });
  });

  it('resets to empty lists on corrupt stored JSON', () => {
    localStorage.setItem(WORD_LISTS_STORAGE_KEY, '{broken');
    expect(loadWordLists()).toEqual(emptyWordLists());
  });

  it('does not crash when localStorage is unavailable (access throws)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(loadWordLists()).toEqual(emptyWordLists());
    expect(saveWordLists(lists({ whitelist: ['施作'] }))).toBe(false);
    // The rules still apply in this session.
    expect(active('施作', [rule('施作')], lists({ whitelist: ['施作'] }))).toEqual([]);
  });

  it('reports false instead of throwing when writing fails (quota or blocked)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(saveWordLists(lists({ whitelist: ['施作'] }))).toBe(false);
  });
});

describe('import and export', () => {
  it('round-trips through the exported file', () => {
    const l = lists({ whitelist: ['施作'], blacklist: [{ word: '甲公司', category: '公司' }] });
    expect(parseWordListsJson(serializeWordLists(l))).toEqual({ ok: true, lists: l });
  });

  it('rejects garbage with a plain reason', () => {
    const cases: string[] = [
      'not json at all',
      '[]',
      'null',
      JSON.stringify({ whitelist: [], blacklist: [] }),
      JSON.stringify({ version: 2, whitelist: [], blacklist: [] }),
      JSON.stringify({ version: 1, whitelist: '施作', blacklist: [] }),
      JSON.stringify({ version: 1, whitelist: [], blacklist: [{ word: '甲公司', category: '不存在的類別' }] }),
      JSON.stringify({ version: 1, whitelist: [7], blacklist: [] }),
      JSON.stringify({ version: 1, whitelist: [], blacklist: ['甲公司'] }),
      JSON.stringify({ version: 1, whitelist: ['甲'.repeat(MAX_WORD_LENGTH + 1)], blacklist: [] }),
    ];
    for (const text of cases) {
      const r = parseWordListsJson(text);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error.length, text).toBeGreaterThan(0);
    }
  });
});
