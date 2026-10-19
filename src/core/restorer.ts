import type { MappingEntry, TextEdit } from './types';
import { parseMarkers } from './codes';
import { applyEdits } from './redactor';

export interface RestoreResult {
  restoredText: string;
  edits: TextEdit[];
  missingCodes: string[];
  restoredCount: number;
}

/** One marker-like span: where it sits, which code it names, and whether it carried a category label. */
interface Hit {
  start: number;
  end: number;
  code: string;
  labelled: boolean;
}

function applyHits(text: string, mapping: MappingEntry[], hits: Hit[]): RestoreResult {
  const table = new Map(mapping.map((m) => [m.code, m.original]));
  const edits: TextEdit[] = [];
  const missing = new Set<string>();
  for (const h of hits) {
    const original = table.get(h.code);
    if (original === undefined) {
      // A bare [a1b2c3] that is not in the mapping is more likely ordinary text than a lost marker.
      if (h.labelled) missing.add(h.code);
      continue;
    }
    edits.push({ start: h.start, end: h.end, replacement: original });
  }
  return {
    restoredText: applyEdits(text, edits),
    edits,
    missingCodes: [...missing],
    restoredCount: edits.length,
  };
}

export function restore(text: string, mapping: MappingEntry[]): RestoreResult {
  const hits = parseMarkers(text).map((mk) => ({ start: mk.start, end: mk.end, code: mk.code, labelled: true }));
  return applyHits(text, mapping, hits);
}

/**
 * Markers as an AI chatbot tends to return them. Alternative 1 is the exact form MARKER_REGEX
 * accepts, so exact markers match precisely as in restore(). Alternative 2 tolerates:
 * full-width or mixed brackets and colon, spaces, a markdown backslash before a bracket or colon,
 * uppercase hex, a changed or dropped category ([name:a1b2c3], [a1b2c3]). Backticks are not part
 * of the match, so they stay in the text. Without brackets a 6-hex string is never a marker.
 */
const LOOSE_MARKER =
  /\[([^\[\]:]{1,10}):([0-9a-f]{6})\]|\\?[\[【［][ \t　]*(?:([^\[\]【】［］:：\\\r\n`]{1,20}?)[ \t　]*\\?[:：][ \t　]*)?([0-9a-fA-F]{6})[ \t　]*\\?[\]】］]/g;

/**
 * Restores markers from pasted AI output. Same result shape as restore(). missingCodes lists the
 * labelled markers whose code is not in the mapping (a bare [a1b2c3] that is not in the mapping
 * is left alone, not reported).
 */
export function restoreLoose(text: string, mapping: MappingEntry[]): RestoreResult {
  const hits: Hit[] = [];
  for (const m of text.matchAll(LOOSE_MARKER)) {
    hits.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      code: (m[2] ?? m[4]).toLowerCase(),
      labelled: (m[1] ?? m[3]) !== undefined,
    });
  }
  return applyHits(text, mapping, hits);
}
