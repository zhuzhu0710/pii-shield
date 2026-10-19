import { describe, expect, it } from 'vitest';
import { detect } from '../../src/core/detector';
import { applyRedactions } from '../../src/core/redactor';
import { BUILTIN_PATTERNS } from '../../src/core/patterns';
import { emptyWordLists, type WordLists } from '../../src/core/word-lists';
import { parsePlainText, generatePlainText } from '../../src/formats/plaintext';
import { parseDocx, generateDocx } from '../../src/formats/docx';
import { buildDocx, toFile } from '../helpers/docx-builder';

/** Both lists at work: 施作 must never be hidden, and every 甲公司 must be hidden as a company. */
const LISTS: WordLists = {
  version: 1,
  whitelist: ['施作'],
  blacklist: [{ word: '甲公司', category: '公司' }],
};

const TEXT = '本工程由甲方委託乙方施作，承辦人為林雅婷。甲公司另行通知，甲公司的聯絡人為林雅婷。';

function expectNoOverlaps(items: { start: number; end: number }[]) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
}

describe('word lists in a plain-text pipeline', () => {
  it('honours the whitelist and blacklist and redacts the output text accordingly', async () => {
    const doc = await parsePlainText(new File([TEXT], 'note.txt'), 'txt');
    const items = detect(doc.text, BUILTIN_PATTERNS, undefined, LISTS);

    expect(items.some((it) => it.original === '施作')).toBe(false);
    expect(items.filter((it) => it.original === '甲公司').map((it) => it.category)).toEqual(['公司', '公司']);
    expectNoOverlaps(items.filter((it) => it.active));

    const { edits } = applyRedactions(doc.text, items);
    const out = generatePlainText(doc, edits);
    const redacted = await out.text();
    expect(redacted).toContain('施作');
    expect(redacted).not.toContain('甲公司');
    expect(redacted).not.toContain('林雅婷');
  });

  it('without the lists the same text hides nothing extra, so the lists are what changed the result', () => {
    const without = detect(TEXT, BUILTIN_PATTERNS, undefined, emptyWordLists()).map((it) => it.original);
    expect(without).not.toContain('甲公司');
  });
});

describe('word lists in a Word (.docx) pipeline', () => {
  it('honours both lists through parse, detect, redact and regenerate', async () => {
    const bytes = await buildDocx({ paragraphs: [[TEXT]] });
    const doc = await parseDocx(toFile(bytes, 'lists.docx'));
    const items = detect(doc.text, BUILTIN_PATTERNS, undefined, LISTS);

    expect(items.some((it) => it.original === '施作')).toBe(false);
    expect(items.filter((it) => it.original === '甲公司')).toHaveLength(2);
    expectNoOverlaps(items.filter((it) => it.active));

    const { edits } = applyRedactions(doc.text, items);
    const blob = await generateDocx(doc, edits);
    const redacted = await parseDocx(toFile(new Uint8Array(await blob.arrayBuffer()), 'lists-out.docx'));

    expect(redacted.text).toContain('施作');
    expect(redacted.text).not.toContain('甲公司');
    expect(redacted.text).not.toContain('林雅婷');
  });
});
