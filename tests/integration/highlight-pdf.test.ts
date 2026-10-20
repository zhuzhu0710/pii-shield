import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/core/detector';
import { BUILTIN_PATTERNS } from '../../src/core/patterns';
import { applyRedactions } from '../../src/core/redactor';
import { restore } from '../../src/core/restorer';
import { generatePdf, parsePdf } from '../../src/formats/pdf';

const FONT = new Uint8Array(readFileSync('public/fonts/NotoSansTC-Regular.ttf'));
const LINES = ['個案姓名：王小明先生（身分證字號 A123456789）', '聯絡手機 0912-345-678，Email：xiaoming.wang@example.com'];
const GREY = 217 / 255;

async function buildPdf(): Promise<File> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(FONT, { subset: true });
  const page = pdf.addPage([595, 842]);
  LINES.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 24, size: 12, font }));
  return new File([(await pdf.save()) as BlobPart], 'sample.pdf', { type: 'application/pdf' });
}

beforeAll(() => {
  vi.stubGlobal('fetch', async () => new Response(FONT));
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/build/pdf.worker.min.mjs').href;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** pdf-lib's colour objects are { type, red, green, blue } on a 0..1 scale. */
const isGrey = (c: unknown): boolean => {
  const col = c as { red?: number; green?: number; blue?: number } | undefined;
  return !!col && [col.red, col.green, col.blue].every((v) => v !== undefined && Math.abs(v - GREY) < 0.002);
};

describe('PDF output: grey behind each replacement', () => {
  it('draws one grey rectangle per replacement, before the text it sits under', async () => {
    const doc = await parsePdf(await buildPdf());
    const { edits } = applyRedactions(doc.text, detect(doc.text, BUILTIN_PATTERNS));
    expect(edits.length).toBeGreaterThan(0);

    const rects = vi.spyOn(PDFPage.prototype, 'drawRectangle');
    const texts = vi.spyOn(PDFPage.prototype, 'drawText');
    await generatePdf(doc, edits, { highlight: true });

    const grey = rects.mock.calls.filter(([opts]) => isGrey((opts as { color?: unknown }).color));
    expect(grey.length).toBe(edits.length);
    const lastGrey = Math.max(...rects.mock.invocationCallOrder.filter((_, i) => isGrey((rects.mock.calls[i][0] as { color?: unknown }).color)));
    const firstText = Math.min(...texts.mock.invocationCallOrder);
    expect(lastGrey).toBeLessThan(firstText);
    for (const [opts] of grey) expect((opts as { width: number }).width).toBeGreaterThan(0);
  });

  it('draws no grey when the option is off', async () => {
    const doc = await parsePdf(await buildPdf());
    const { edits } = applyRedactions(doc.text, detect(doc.text, BUILTIN_PATTERNS));
    const rects = vi.spyOn(PDFPage.prototype, 'drawRectangle');
    await generatePdf(doc, edits, { highlight: false });
    expect(rects.mock.calls.filter(([opts]) => isGrey((opts as { color?: unknown }).color))).toEqual([]);
  });

  it('restore output has no grey boxes', async () => {
    const original = await parsePdf(await buildPdf());
    const items = detect(original.text, BUILTIN_PATTERNS);
    const { edits, mapping } = applyRedactions(original.text, items);
    const deid = await parsePdf(new File([await (await generatePdf(original, edits, { highlight: true })).arrayBuffer()], 'deid.pdf'));
    const restored = restore(deid.text, mapping);

    const rects = vi.spyOn(PDFPage.prototype, 'drawRectangle');
    const out = await generatePdf(deid, restored.edits);
    expect(rects.mock.calls.filter(([opts]) => isGrey((opts as { color?: unknown }).color))).toEqual([]);
    const back = await parsePdf(new File([await out.arrayBuffer()], 'restored.pdf'));
    expect(back.text.replace(/\s/g, '')).toContain(LINES[0].replace(/\s/g, ''));
  });
});
