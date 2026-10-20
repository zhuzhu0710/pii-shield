import type { TextEdit } from '../core/types';

/** A contiguous run of the document's full text owned by one structural node (docx <w:t>, PDF text item). */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

interface LocalOp {
  start: number;
  end: number;
  replacement: string;
  mark?: { start: number; end: number };
}

/** The new text of one segment, and where its replacement text(s) sit inside that new text ([start, end) pairs). */
export interface SegmentChange {
  text: string;
  replaced: [number, number][];
}

/**
 * Distributes full-text edits across segments. An edit that spans several segments puts its
 * replacement in the first segment it touches and deletes the covered text from the others.
 * Returns the new text for every segment that changed, with the replacement spans marked.
 */
export function distributeChanges(segments: Segment[], edits: TextEdit[]): Map<number, SegmentChange> {
  const ops = new Map<number, LocalOp[]>();
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let segIdx = 0;
  for (const e of sorted) {
    while (segIdx < segments.length && segments[segIdx].end <= e.start) segIdx++;
    let first = true;
    for (let i = segIdx; i < segments.length && segments[i].start < e.end; i++) {
      const s = segments[i];
      const localStart = Math.max(e.start, s.start) - s.start;
      const localEnd = Math.min(e.end, s.end) - s.start;
      if (localEnd < localStart) continue;
      if (!ops.has(i)) ops.set(i, []);
      ops.get(i)!.push({ start: localStart, end: localEnd, replacement: first ? e.replacement : '', mark: first ? e.mark : undefined });
      first = false;
    }
    if (first) throw new Error(`編輯範圍 [${e.start}, ${e.end}) 不對應任何文字節點`);
  }
  const out = new Map<number, SegmentChange>();
  for (const [i, list] of ops) {
    const text = segments[i].text;
    let built = '';
    let cursor = 0;
    const replaced: [number, number][] = [];
    for (const op of list.sort((a, b) => a.start - b.start)) {
      built += text.slice(cursor, op.start);
      if (op.replacement.length > 0) {
        const mark = op.mark ?? { start: 0, end: op.replacement.length };
        if (mark.end > mark.start) replaced.push([built.length + mark.start, built.length + mark.end]);
        built += op.replacement;
      }
      cursor = op.end;
    }
    built += text.slice(cursor);
    out.set(i, { text: built, replaced });
  }
  return out;
}

/** Distributes full-text edits across segments and returns only the new text of each changed segment. */
export function distributeEdits(segments: Segment[], edits: TextEdit[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const [i, change] of distributeChanges(segments, edits)) out.set(i, change.text);
  return out;
}
