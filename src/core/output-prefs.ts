/**
 * The output choices the user last made (要露出多少, 標記方式, and the 自訂 per-category settings), remembered
 * in this browser so the next visit starts from them. Pure parsing plus a small localStorage store, following
 * word-lists.ts: every storage access is wrapped, and anything unreadable or unknown falls back to the defaults.
 */
import { CATEGORIES, type Category, type Retention } from './types';
import { modesFor, sanitizeRetention } from './retention';
import type { MarkerStyle } from './redactor';

export const OUTPUT_PREFS_STORAGE_KEY = 'deid.outputPrefs.v1';

/** 露出部分 (preview) keeps the standard statistics-friendly characters; 全部隱藏 (code) hides every value; 自訂 is per category. */
export const OUTPUT_MODES = ['preview', 'code', 'custom'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];
export const MARKER_STYLES: readonly MarkerStyle[] = ['code', 'label', 'blank'];

export interface OutputPrefs {
  outputMode: OutputMode;
  marker: MarkerStyle;
  /** 自訂 mode: per-category retention, kept even while another mode is selected. */
  overrides: Map<Category, Retention>;
}

/** The first-visit choices: 編碼 (可還原) and 露出部分. */
export function defaultOutputPrefs(): OutputPrefs {
  return { outputMode: 'preview', marker: 'code', overrides: new Map() };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCategory = (x: string): x is Category => (CATEGORIES as readonly string[]).includes(x);

/**
 * Checks a parsed stored object field by field: an unknown version drops everything, and an unknown value
 * is ignored on its own (that field keeps its default), so one bad field never loses the others.
 */
export function parseOutputPrefs(raw: unknown): OutputPrefs {
  const out = defaultOutputPrefs();
  if (!isRecord(raw) || raw.version !== 1) return out;
  if ((OUTPUT_MODES as readonly unknown[]).includes(raw.outputMode)) out.outputMode = raw.outputMode as OutputMode;
  if (MARKER_STYLES.includes(raw.marker as MarkerStyle)) out.marker = raw.marker as MarkerStyle;
  if (isRecord(raw.overrides)) {
    for (const [key, value] of Object.entries(raw.overrides)) {
      if (!isCategory(key)) continue;
      const r = sanitizeRetention(value);
      // Only the modes the category's settings offer (e.g. 保留姓氏 belongs to 姓名 alone).
      if (!r || !modesFor(key).includes(r.mode)) continue;
      out.overrides.set(key, r);
    }
  }
  return out;
}

/** Returns the storage, or null when the browser blocks it (private window, disabled site data). */
function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Reads the saved choices; anything missing, unreadable or corrupt gives the defaults. */
export function loadOutputPrefs(): OutputPrefs {
  try {
    const raw = storage()?.getItem(OUTPUT_PREFS_STORAGE_KEY);
    if (!raw) return defaultOutputPrefs();
    return parseOutputPrefs(JSON.parse(raw));
  } catch {
    return defaultOutputPrefs();
  }
}

/** Returns false when the browser would not keep the choices (storage blocked or full). */
export function saveOutputPrefs(prefs: OutputPrefs): boolean {
  try {
    const s = storage();
    if (!s) return false;
    const data = {
      version: 1,
      outputMode: prefs.outputMode,
      marker: prefs.marker,
      overrides: Object.fromEntries(prefs.overrides),
    };
    s.setItem(OUTPUT_PREFS_STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
