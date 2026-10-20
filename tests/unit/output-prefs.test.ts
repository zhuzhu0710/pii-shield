import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Category, Retention } from '../../src/core/types';
import { OUTPUT_PREFS_STORAGE_KEY, defaultOutputPrefs, loadOutputPrefs, parseOutputPrefs, saveOutputPrefs, type OutputPrefs, hasSavedOutputPrefs } from '../../src/core/output-prefs';

const KEY = 'deid.outputPrefs.v1';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('output preferences', () => {
  it('uses the storage key deid.outputPrefs.v1', () => {
    expect(OUTPUT_PREFS_STORAGE_KEY).toBe(KEY);
  });

  it('save then load gives back the same choices', () => {
    const prefs: OutputPrefs = {
      outputMode: 'code',
      marker: 'label',
      overrides: new Map([['姓名', { mode: 'surname' }]]),
      highlight: false,
    };
    expect(saveOutputPrefs(prefs)).toBe(true);
    const loaded = loadOutputPrefs();
    expect(loaded.outputMode).toBe('code');
    expect(loaded.marker).toBe('label');
    expect([...loaded.overrides]).toEqual([['姓名', { mode: 'surname' }]]);
  });

  it('first visit (nothing saved) gives the defaults: 露出部分, 編碼 (可還原), no overrides', () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    const loaded = loadOutputPrefs();
    expect(loaded).toEqual(defaultOutputPrefs());
    expect(loaded.outputMode).toBe('preview');
    expect(loaded.marker).toBe('code');
    expect(loaded.overrides.size).toBe(0);
  });

  it('corrupt JSON, or a non-object value, gives the defaults without throwing', () => {
    for (const raw of ['{not json', '', '"text"', '42', 'null', '[1,2,3]']) {
      localStorage.setItem(KEY, raw);
      expect(() => loadOutputPrefs()).not.toThrow();
      expect(loadOutputPrefs()).toEqual(defaultOutputPrefs());
    }
  });

  it('unknown values are ignored field by field; the other valid fields are kept', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        outputMode: 'bogus',
        marker: 'pdf',
        overrides: {
          不存在的類別: { mode: 'none' }, // unknown category
          手機: { mode: 'surname' }, // mode not offered for 手機
          姓名: { mode: 'ends', head: -1, tail: 0 }, // invalid numbers
          身分證: { mode: 'delim', delimiter: '', side: 'after' }, // empty delimiter
          電子郵件: { mode: 'none' }, // valid: kept
        },
      }),
    );
    const loaded = loadOutputPrefs();
    expect(loaded.outputMode).toBe('preview');
    expect(loaded.marker).toBe('code');
    expect([...loaded.overrides]).toEqual([['電子郵件', { mode: 'none' }]]);

    // A valid marker is kept even when the output mode is unknown.
    localStorage.setItem(KEY, JSON.stringify({ version: 1, outputMode: 'custom', marker: 'blank' }));
    const second = loadOutputPrefs();
    expect(second.outputMode).toBe('custom');
    expect(second.marker).toBe('blank');
  });

  it('an unknown version is treated as nothing saved', () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 2, outputMode: 'code', marker: 'label', overrides: {} }));
    expect(loadOutputPrefs()).toEqual(defaultOutputPrefs());
  });

  it('a throwing storage (blocked site data, private window) falls back to the defaults', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => loadOutputPrefs()).not.toThrow();
    expect(loadOutputPrefs()).toEqual(defaultOutputPrefs());
  });

  it('a throwing or full storage makes saving report false instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => saveOutputPrefs(defaultOutputPrefs())).not.toThrow();
    expect(saveOutputPrefs(defaultOutputPrefs())).toBe(false);
  });

  it('custom per-category retention is persisted, even while another output mode is selected', () => {
    const prefs: OutputPrefs = {
      outputMode: 'preview',
      marker: 'code',
      highlight: true,
      overrides: new Map<Category, Retention>([
        ['手機', { mode: 'ends', head: 0, tail: 4 }],
        ['電子郵件', { mode: 'delim', delimiter: '@', side: 'after' }],
      ]),
    };
    saveOutputPrefs(prefs);
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    expect(raw.version).toBe(1);
    expect(raw.overrides).toEqual({
      手機: { mode: 'ends', head: 0, tail: 4 },
      電子郵件: { mode: 'delim', delimiter: '@', side: 'after' },
    });
    const loaded = loadOutputPrefs();
    expect(loaded.outputMode).toBe('preview');
    expect(loaded.overrides.get('手機')).toEqual({ mode: 'ends', head: 0, tail: 4 });
    expect(loaded.overrides.get('電子郵件')).toEqual({ mode: 'delim', delimiter: '@', side: 'after' });
  });

  it('parseOutputPrefs accepts every mode each category offers, including 全部隱藏 per category', () => {
    const parsed = parseOutputPrefs({
      version: 1,
      outputMode: 'custom',
      marker: 'label',
      overrides: { 地址: { mode: 'district' }, 姓名: { mode: 'surname' }, 統編: { mode: 'none' } },
    });
    expect(parsed.overrides.get('地址')).toEqual({ mode: 'district' });
    expect(parsed.overrides.get('姓名')).toEqual({ mode: 'surname' });
    expect(parsed.overrides.get('統編')).toEqual({ mode: 'none' });
  });
});

describe('hasSavedOutputPrefs (first-visit check)', () => {
  it('is false when nothing is saved, and false for unreadable data', () => {
    localStorage.clear();
    expect(hasSavedOutputPrefs()).toBe(false);
    localStorage.setItem(OUTPUT_PREFS_STORAGE_KEY, '{not json');
    expect(hasSavedOutputPrefs()).toBe(false);
    localStorage.setItem(OUTPUT_PREFS_STORAGE_KEY, JSON.stringify({ version: 2 }));
    expect(hasSavedOutputPrefs()).toBe(false);
  });

  it('is true once choices have been saved', () => {
    localStorage.clear();
    saveOutputPrefs(defaultOutputPrefs());
    expect(hasSavedOutputPrefs()).toBe(true);
  });
  it('the grey highlight is on by default, including for prefs saved before the option existed', () => {
    expect(defaultOutputPrefs().highlight).toBe(true);
    localStorage.setItem(KEY, JSON.stringify({ version: 1, outputMode: 'code', marker: 'label', overrides: {} }));
    expect(loadOutputPrefs().highlight).toBe(true);
    expect(loadOutputPrefs().marker).toBe('label');
  });

  it('a saved "off" choice is kept, and anything that is not a boolean falls back to on', () => {
    expect(parseOutputPrefs({ version: 1, highlight: false }).highlight).toBe(false);
    expect(parseOutputPrefs({ version: 1, highlight: 'no' }).highlight).toBe(true);
    expect(parseOutputPrefs({ version: 1, highlight: null }).highlight).toBe(true);
    const prefs: OutputPrefs = { ...defaultOutputPrefs(), highlight: false };
    expect(saveOutputPrefs(prefs)).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!).highlight).toBe(false);
    expect(loadOutputPrefs().highlight).toBe(false);
  });
});

