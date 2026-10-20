import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { detect } from '../../src/core/detector';
import { BUILTIN_PATTERNS } from '../../src/core/patterns';
import { applyRedactions } from '../../src/core/redactor';
import { restore } from '../../src/core/restorer';
import { generateXlsx, parseXlsx } from '../../src/formats/xlsx';
import { buildXlsx, toXlsxFile, type XlsxSpec } from '../helpers/xlsx-builder';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** The builder gives every cell the same style (s=1), so changed and unchanged cells share one original style. */
const SPEC: XlsxSpec = {
  headerOnlyBold: true,
  sheets: [
    {
      name: '名單',
      rows: [
        ['姓名', '身分證字號', '備註'],
        ['王小明', 'A123456789', '已確認'],
        ['林美玲', 'B223456782', '聯絡人同上'],
      ],
    },
    { name: '第二頁', rows: [['王小明', '同上']] },
  ],
};

async function xlsxFile(): Promise<File> {
  return toXlsxFile(await buildXlsx(SPEC), 'list.xlsx');
}

async function unzip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

/** Every text cell as "sheet!ref" -> its raw s attribute ('0' when absent, which is the same style) and its text. */
async function cells(blob: Blob): Promise<Map<string, { s: string; text: string }>> {
  const zip = await unzip(blob);
  const sst = zip.file('xl/sharedStrings.xml');
  const shared = sst
    ? Array.from(new DOMParser().parseFromString(await sst.async('string'), 'application/xml').getElementsByTagNameNS(MAIN, 'si')).map((si) =>
        Array.from(si.getElementsByTagNameNS(MAIN, 't')).map((t) => t.textContent ?? '').join(''),
      )
    : [];
  const out = new Map<string, { s: string; text: string }>();
  for (const path of Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort()) {
    const doc = new DOMParser().parseFromString(await zip.file(path)!.async('string'), 'application/xml');
    for (const c of Array.from(doc.getElementsByTagNameNS(MAIN, 'c'))) {
      const v = c.getElementsByTagNameNS(MAIN, 'v')[0]?.textContent ?? '';
      const text = c.getAttribute('t') === 's' ? shared[Number(v)] ?? '' : Array.from(c.getElementsByTagNameNS(MAIN, 't')).map((t) => t.textContent ?? '').join('');
      out.set(`${path}!${c.getAttribute('r')}`, { s: c.getAttribute('s') ?? '0', text });
    }
  }
  return out;
}

interface Xf { fontId: string | null; fillId: string | null; borderId: string | null; numFmtId: string | null; applyFill: string | null }

async function styles(blob: Blob): Promise<{ xfs: Xf[]; fills: string[]; xml: string }> {
  const xml = await (await unzip(blob)).file('xl/styles.xml')!.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const xfs = Array.from(doc.getElementsByTagNameNS(MAIN, 'cellXfs')[0].children).map((x) => ({
    fontId: x.getAttribute('fontId'),
    fillId: x.getAttribute('fillId'),
    borderId: x.getAttribute('borderId'),
    numFmtId: x.getAttribute('numFmtId'),
    applyFill: x.getAttribute('applyFill'),
  }));
  const fills = Array.from(doc.getElementsByTagNameNS(MAIN, 'fills')[0].children).map((f) => new XMLSerializer().serializeToString(f));
  return { xfs, fills, xml };
}

describe('Excel output: grey background on replaced cells', () => {
  it('gives each replaced cell a new style with a grey fill, and leaves cells that share the old style unchanged', async () => {
    const doc = await parseXlsx(await xlsxFile());
    const { edits } = applyRedactions(doc.text, detect(doc.text, BUILTIN_PATTERNS));
    const before = await cells(toBlob(await (await xlsxFile()).arrayBuffer()));
    const blob = await generateXlsx(doc, edits, { highlight: true });
    const after = await cells(blob);
    const st = await styles(blob);

    // Every cell whose text changed is a replaced cell (the name and the ID cells at least).
    const replaced = [...after.entries()].filter(([ref, c]) => before.get(ref)!.text !== c.text);
    const refs = replaced.map(([ref]) => ref.split('!')[1]);
    expect(refs).toEqual(expect.arrayContaining(['A2', 'B2', 'A3', 'B3']));
    expect(replaced.every(([, c]) => c.text.includes('['))).toBe(true);

    for (const [ref, c] of replaced) {
      const xf = st.xfs[Number(c.s)];
      // Compared with the cell's own original style (the header is bold, the data cells are style 0).
      const base = st.xfs[Number(before.get(ref)!.s)];
      expect(xf, 'a new style, not the shared original').not.toBeUndefined();
      expect(Number(c.s)).toBeGreaterThan(1);
      // Fonts, borders and number format are copied from the cell's own style; only the fill changes.
      expect(xf.fontId).toBe(base.fontId);
      expect(xf.borderId).toBe(base.borderId);
      expect(xf.numFmtId).toBe(base.numFmtId);
      expect(xf.applyFill).toBe('1');
      expect(st.fills[Number(xf.fillId)]).toContain('FFD9D9D9');
    }

    // A cell with the same original style and no replacement keeps it exactly.
    expect(after.get('xl/worksheets/sheet1.xml!C2')).toEqual({ s: '1', text: '已確認' });
    expect(before.get('xl/worksheets/sheet1.xml!C2')!.s).toBe('1');
    // The shared default style itself is not mutated (its fill is the workbook's own, not our grey).
    expect(st.xfs[0].applyFill).toBeNull();
    expect(st.fills[Number(st.xfs[0].fillId)]).not.toContain('D9D9D9');
    // The header row keeps its style (it has no replacement).
    expect(after.get('xl/worksheets/sheet1.xml!C1')!.s).toBe('1');
  });

  it('writes no grey when the option is off', async () => {
    const doc = await parseXlsx(await xlsxFile());
    const { edits } = applyRedactions(doc.text, detect(doc.text, BUILTIN_PATTERNS));
    const blob = await generateXlsx(doc, edits, { highlight: false });
    expect((await styles(blob)).xml).not.toContain('D9D9D9');
    // Same style index on every cell as the original; only the text changed.
    const plain = await cells(toBlob(await (await xlsxFile()).arrayBuffer()));
    const out = await cells(blob);
    for (const [ref, c] of plain) expect(out.get(ref)!.s, ref).toBe(c.s);
  });

  it('restore gives every restored cell its original style index and drops the grey styles', async () => {
    const original = await parseXlsx(await xlsxFile());
    const items = detect(original.text, BUILTIN_PATTERNS);
    const { edits, mapping } = applyRedactions(original.text, items);
    const deidBlob = await generateXlsx(original, edits, { highlight: true });
    const originalStyles = await styles(toBlob(await (await xlsxFile()).arrayBuffer()));
    const deid = await parseXlsx(toXlsxFile(new Uint8Array(await deidBlob.arrayBuffer()), 'list.deid.xlsx'));

    const restored = restore(deid.text, mapping);
    expect(restored.restoredCount).toBeGreaterThan(0);
    const restoredBlob = await generateXlsx(deid, restored.edits);

    const restoredCells = await cells(restoredBlob);
    const originalCells = await cells(toBlob(await (await xlsxFile()).arrayBuffer()));
    expect([...restoredCells.keys()]).toEqual([...originalCells.keys()]);
    for (const [ref, c] of originalCells) {
      expect(restoredCells.get(ref), ref).toEqual(c);
    }
    // The restored styles are the original ones again: the same cell formats and no grey fill left over.
    const restoredStyles = await styles(restoredBlob);
    expect(restoredStyles.xfs).toEqual(originalStyles.xfs);
    expect(restoredStyles.fills).toEqual(originalStyles.fills);
    expect(restoredStyles.xml).not.toContain('D9D9D9');
    expect(restoredStyles.xml).not.toContain('urn:pii-shield:grey-styles');
    expect((await parseXlsx(toXlsxFile(new Uint8Array(await restoredBlob.arrayBuffer()), 'r.xlsx'))).text).toBe(original.text);
  });
});

function toBlob(bytes: ArrayBuffer): Blob {
  return new Blob([bytes]);
}
