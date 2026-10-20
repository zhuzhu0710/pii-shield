import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { detect } from '../../src/core/detector';
import { BUILTIN_PATTERNS } from '../../src/core/patterns';
import { applyRedactions } from '../../src/core/redactor';
import { restore } from '../../src/core/restorer';
import type { RedactionItem } from '../../src/core/types';
import { generateDocx, parseDocx } from '../../src/formats/docx';
import { toFile } from '../helpers/docx-builder';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W = `xmlns:w="${W_NS}"`;

/** Mixed formatting: names are bold, italic or plain; one run holds a partial ID; a table and a header hold names too. */
const BODY = [
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>報名人：</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>王小明</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> 先生</w:t></w:r></w:p>',
  '<w:p><w:r><w:t>聯絡人 林美玲 請來電</w:t></w:r></w:p>',
  '<w:p><w:r><w:rPr><w:b/><w:color w:val="C00000"/></w:rPr><w:t>身分證 A123456789</w:t></w:r></w:p>',
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>陳大文</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
].join('');
const HEADER = `<w:hdr ${W}><w:p><w:r><w:rPr><w:i/></w:rPr><w:t>王小明 機密</w:t></w:r></w:p></w:hdr>`;

const CODES: Record<string, string> = { 王小明: 'a1b2c3', 林美玲: 'd4e5f6', 陳大文: '0a0b0c', A123456789: 'bbcc11' };

async function mixedDocx(): Promise<File> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${BODY}<w:sectPr/></w:body></w:document>`);
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${HEADER}`);
  return toFile(await zip.generateAsync({ type: 'uint8array' }), 'mixed.docx');
}

/** Every occurrence of each name gets its own item; the ID keeps its first two characters visible. */
function itemsFor(text: string): RedactionItem[] {
  const items: RedactionItem[] = [];
  for (const [original, code] of Object.entries(CODES)) {
    const category = original.startsWith('A1') ? '身分證' : original.length === 3 && /^[一-鿿]+$/.test(original) ? '姓名' : '身分證';
    let at = text.indexOf(original);
    while (at >= 0) {
      const head = original === 'A123456789' ? 2 : 0;
      items.push({ id: `${code}-${at}`, category: category as RedactionItem['category'], original, start: at, end: at + original.length, code, origin: 'auto', active: true, head, tail: 0 });
      at = text.indexOf(original, at + original.length);
    }
  }
  return items;
}

async function xmlOf(blob: Blob, path: string): Promise<Document> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return new DOMParser().parseFromString(await zip.file(path)!.async('string'), 'application/xml');
}

const runsOf = (doc: Document): Element[] => Array.from(doc.getElementsByTagNameNS(W_NS, 'r'));
const isGreyRun = (r: Element): boolean => Array.from(r.getElementsByTagNameNS(W_NS, 'shd')).some((s) => s.getAttributeNS(W_NS, 'fill') === 'D9D9D9');
const textOfRun = (r: Element): string => Array.from(r.getElementsByTagNameNS(W_NS, 't')).map((t) => t.textContent ?? '').join('');

/** A paragraph as a list of (run properties, text), adjacent runs with the same properties merged. */
function formattingOf(p: Element): [string, string][] {
  const out: [string, string][] = [];
  for (const r of Array.from(p.getElementsByTagNameNS(W_NS, 'r'))) {
    const rPr = r.getElementsByTagNameNS(W_NS, 'rPr')[0];
    const props = rPr ? new XMLSerializer().serializeToString(rPr) : '';
    const text = textOfRun(r);
    const last = out[out.length - 1];
    if (last && last[0] === props) last[1] += text;
    else out.push([props, text]);
  }
  return out;
}

describe('Word output: grey background on replacements', () => {
  it('shades exactly the replacement runs (body, table, header) and nothing else', async () => {
    const doc = await parseDocx(await mixedDocx());
    const { edits } = applyRedactions(doc.text, itemsFor(doc.text));
    const blob = await generateDocx(doc, edits, { highlight: true });

    const body = await xmlOf(blob, 'word/document.xml');
    const header = await xmlOf(blob, 'word/header1.xml');
    const shaded = [...runsOf(body), ...runsOf(header)].filter(isGreyRun).map(textOfRun);
    expect(shaded).toEqual(['[姓名:a1b2c3]', '[姓名:d4e5f6]', '[身分證:bbcc11]', '[姓名:0a0b0c]', '[姓名:a1b2c3]']);

    // The shading is the exact w:shd the spec names, on the replacement run only.
    const shd = Array.from(body.getElementsByTagNameNS(W_NS, 'shd'))[0];
    expect(shd.getAttributeNS(W_NS, 'val')).toBe('clear');
    expect(shd.getAttributeNS(W_NS, 'color')).toBe('auto');
    expect(shd.getAttributeNS(W_NS, 'fill')).toBe('D9D9D9');

    // The kept prefix of the ID stays unshaded, and the original formatting of the marker run (red, bold) is kept.
    const kept = runsOf(body).find((r) => textOfRun(r) === '身分證 A1');
    expect(kept && isGreyRun(kept)).toBe(false);
    const idRun = runsOf(body).find((r) => textOfRun(r) === '[身分證:bbcc11]')!;
    expect(idRun.getElementsByTagNameNS(W_NS, 'color')[0]?.getAttributeNS(W_NS, 'val')).toBe('C00000');
  });

  it('writes no grey anywhere when the option is off, and leaves other output identical', async () => {
    const doc = await parseDocx(await mixedDocx());
    const { edits } = applyRedactions(doc.text, itemsFor(doc.text));
    const off = await generateDocx(doc, edits, { highlight: false });
    const zip = await JSZip.loadAsync(await off.arrayBuffer());
    for (const path of Object.keys(zip.files)) {
      if (!path.endsWith('.xml')) continue;
      expect(await zip.file(path)!.async('string'), path).not.toContain('D9D9D9');
    }
    expect((await xmlOf(off, 'word/document.xml')).getElementsByTagNameNS(W_NS, 'shd').length).toBe(0);
  });

  it('restore removes the grey and gives back the original text and paragraph formatting', async () => {
    const file = await mixedDocx();
    const original = await parseDocx(file);
    const items = itemsFor(original.text);
    const { edits, mapping } = applyRedactions(original.text, items);
    const deidBlob = await generateDocx(original, edits, { highlight: true });
    const deid = await parseDocx(toFile(new Uint8Array(await deidBlob.arrayBuffer()), 'mixed.deid.docx'));
    expect(deid.text).not.toContain('王小明');

    const restored = restore(deid.text, mapping);
    expect(restored.restoredCount).toBe(items.length);
    const restoredBlob = await generateDocx(deid, restored.edits);

    const restoredText = await parseDocx(toFile(new Uint8Array(await restoredBlob.arrayBuffer()), 'mixed.restored.docx'));
    expect(restoredText.text).toBe(original.text);

    const serializer = new XMLSerializer();
    const originalBlob = new Blob([await file.arrayBuffer()]);
    // Paragraph 0 (bold, italic and bold runs around a name) and the table cell come back byte-for-byte.
    // Paragraphs 1 and 2 have a name or ID inside a plain run, so restore leaves that run split into pieces
    // that carry the same formatting; their text and run properties are compared instead.
    const exact: Record<string, number[]> = { 'word/document.xml': [0, 3], 'word/header1.xml': [] };
    for (const part of ['word/document.xml', 'word/header1.xml']) {
      const before = await xmlOf(originalBlob, part);
      const after = await xmlOf(restoredBlob, part);
      expect(after.getElementsByTagNameNS(W_NS, 'shd').length, part).toBe(0);
      const beforeParas = Array.from(before.getElementsByTagNameNS(W_NS, 'p'));
      const afterParas = Array.from(after.getElementsByTagNameNS(W_NS, 'p'));
      expect(afterParas.length).toBe(beforeParas.length);
      for (const [i, p] of beforeParas.entries()) {
        if (exact[part].includes(i)) {
          expect(serializer.serializeToString(afterParas[i]), `${part} paragraph ${i}`).toBe(serializer.serializeToString(p));
        }
        // Every paragraph: the same text with the same run properties (a split run may stay split).
        expect(formattingOf(afterParas[i]), `${part} paragraph ${i}`).toEqual(formattingOf(p));
      }
    }
  });
});

describe('Word output: detection stays the same', () => {
  it('finds the same items with the option on or off (the option only changes the file)', async () => {
    const doc = await parseDocx(await mixedDocx());
    const items = detect(doc.text, BUILTIN_PATTERNS);
    const a = applyRedactions(doc.text, items).edits;
    const blob = await generateDocx(doc, a, { highlight: true });
    const b = await parseDocx(toFile(new Uint8Array(await blob.arrayBuffer()), 'x.docx'));
    expect(b.text).toBe(applyRedactions(doc.text, items).redactedText);
  });
});

describe('batch archive', () => {
  it('passes the option through to every document in the zip', async () => {
    const { buildArchive } = await import('../../src/formats/batch');
    const doc = await parseDocx(await mixedDocx());
    const items = itemsFor(doc.text);
    for (const [highlight, expectGrey] of [[true, true], [false, false]] as const) {
      const { blob } = await buildArchive([{ doc, items }], undefined, 'code', { highlight });
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const name = Object.keys(zip.files).find((n) => n.endsWith('.deid.docx'))!;
      const xml = await zip.file(name)!.async('uint8array');
      const inner = await JSZip.loadAsync(xml);
      const body = await inner.file('word/document.xml')!.async('string');
      expect(body.includes('D9D9D9'), `highlight ${highlight}`).toBe(expectGrey);
    }
  });
});

describe('Word output: a run that already has other shading', () => {
  it('keeps a single w:shd on the replacement, the grey one', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body><w:p><w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/></w:rPr><w:t>聯絡王小明</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    const doc = await parseDocx(toFile(await zip.generateAsync({ type: 'uint8array' }), 'shade.docx'));
    const { edits } = applyRedactions(doc.text, itemsFor(doc.text).filter((it) => it.original === '王小明'));
    const out = await xmlOf(await generateDocx(doc, edits, { highlight: true }), 'word/document.xml');
    const shdRun = runsOf(out).find((r) => textOfRun(r) === '[姓名:a1b2c3]')!;
    const shds = Array.from(shdRun.getElementsByTagNameNS(W_NS, 'shd'));
    expect(shds.length).toBe(1);
    expect(shds[0].getAttributeNS(W_NS, 'fill')).toBe('D9D9D9');
    expect(runsOf(out).find((r) => textOfRun(r) === '聯絡')!.getElementsByTagNameNS(W_NS, 'shd').length).toBe(1);
  });
});
