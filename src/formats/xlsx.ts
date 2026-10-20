import JSZip from 'jszip';
import type { GenerateOptions, LoadedDocument, TextEdit, XlsxCellLayout } from '../core/types';
import { distributeChanges, type Segment, type SegmentChange } from './segments';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface CellRef {
  sheetIdx: number;
  /** Index into the sheet's cell list (document order); resolved on a fresh clone at generation time. */
  cellIdx: number;
}

interface SheetInfo {
  path: string;
  doc: Document;
}

export interface XlsxHandle {
  zip: JSZip;
  sheets: SheetInfo[];
  /** Pristine xl/sharedStrings.xml, kept so every generation scrubs from the original. */
  sharedStringsXml: string | null;
  /** Pristine xl/styles.xml; each generation rewrites its own copy (see StyleBook). */
  stylesXml: string | null;
  segments: Segment[];
  cells: CellRef[];
}

function isMain(el: Element, local: string): boolean {
  return el.namespaceURI === MAIN_NS && el.localName === local;
}

function textOf(el: Element): string {
  // Concatenates every <t> under a <si>/<is>, covering rich-text runs (<r><t>).
  let out = '';
  const walk = (n: Element) => {
    if (isMain(n, 't')) {
      out += n.textContent ?? '';
      return;
    }
    if (isMain(n, 'rPh')) return; // phonetic hints are not visible cell text
    for (const c of Array.from(n.children)) walk(c);
  };
  walk(el);
  return out;
}

function parseXml(xml: string, path: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error(`無法解析 ${path}`);
  return doc;
}

async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return [];
  const doc = parseXml(await file.async('string'), 'xl/sharedStrings.xml');
  return Array.from(doc.documentElement.children)
    .filter((si) => isMain(si, 'si'))
    .map(textOf);
}

function cellCoords(ref: string): { row: number; col: number } {
  const m = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return { row: 0, col: 0 };
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

async function sheetPaths(zip: JSZip): Promise<{ path: string; name: string }[]> {
  // Prefer workbook order; fall back to numeric file order.
  const wb = zip.file('xl/workbook.xml');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const wbDoc = parseXml(await wb.async('string'), 'xl/workbook.xml');
    const relDoc = parseXml(await rels.async('string'), 'xl/_rels/workbook.xml.rels');
    const targets = new Map<string, string>();
    for (const r of Array.from(relDoc.documentElement.children)) {
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
    }
    const out: { path: string; name: string }[] = [];
    for (const s of Array.from(wbDoc.getElementsByTagNameNS(MAIN_NS, 'sheet'))) {
      const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const p = rid ? targets.get(rid) : undefined;
      if (p && zip.file(p)) out.push({ path: p, name: s.getAttribute('name') ?? p });
    }
    if (out.length) return out;
  }
  return Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((path) => ({ path, name: path.replace(/^.*\//, '').replace(/\.xml$/, '') }));
}

/** Text-bearing cells in document order: shared-string and inline-string cells. */
function textCells(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagNameNS(MAIN_NS, 'c')).filter((c) => {
    const t = c.getAttribute('t');
    return t === 's' || t === 'inlineStr';
  });
}

function cellText(c: Element, shared: string[]): string {
  if (c.getAttribute('t') === 's') {
    const v = c.getElementsByTagNameNS(MAIN_NS, 'v')[0];
    const idx = Number(v?.textContent ?? '');
    return Number.isInteger(idx) ? (shared[idx] ?? '') : '';
  }
  const is = c.getElementsByTagNameNS(MAIN_NS, 'is')[0];
  return is ? textOf(is) : '';
}

function rowOf(c: Element): string {
  return (c.getAttribute('r') ?? '').replace(/[A-Z]+/i, '');
}

export async function parseXlsx(file: File): Promise<LoadedDocument> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const paths = await sheetPaths(zip);
  if (paths.length === 0) throw new Error('不是有效的 Excel (.xlsx) 檔案');
  const shared = await loadSharedStrings(zip);

  const sheets: SheetInfo[] = [];
  const segments: Segment[] = [];
  const cells: CellRef[] = [];
  const layoutSheets: { name: string; cells: XlsxCellLayout[] }[] = [];
  let text = '';

  for (const [sheetIdx, { path, name }] of paths.entries()) {
    const doc = parseXml(await zip.file(path)!.async('string'), path);
    sheets.push({ path, doc });
    const layoutCells: XlsxCellLayout[] = [];
    let lastRow = '';
    textCells(doc).forEach((c, cellIdx) => {
      const t = cellText(c, shared);
      if (t.length === 0) return;
      const row = rowOf(c);
      if (text.length > 0 && !text.endsWith('\n')) text += row === lastRow ? '\t' : '\n';
      lastRow = row;
      const coords = cellCoords(c.getAttribute('r') ?? '');
      segments.push({ start: text.length, end: text.length + t.length, text: t });
      layoutCells.push({ start: text.length, end: text.length + t.length, ...coords });
      cells.push({ sheetIdx, cellIdx });
      text += t;
    });
    layoutSheets.push({ name, cells: layoutCells });
    if (!text.endsWith('\n')) text += '\n';
    text += '\n';
  }

  const sharedStringsXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? null;
  const stylesXml = (await zip.file('xl/styles.xml')?.async('string')) ?? null;
  const handle: XlsxHandle = { zip, sheets, sharedStringsXml, stylesXml, segments, cells };
  return { fileName: file.name, format: 'xlsx', text, handle, layout: { kind: 'xlsx', sheets: layoutSheets } };
}

function setInlineString(c: Element, value: string): void {
  const doc = c.ownerDocument;
  for (const child of Array.from(c.children)) {
    if (isMain(child, 'v') || isMain(child, 'is') || isMain(child, 'f')) c.removeChild(child);
  }
  c.setAttribute('t', 'inlineStr');
  const is = doc.createElementNS(MAIN_NS, 'is');
  const t = doc.createElementNS(MAIN_NS, 't');
  t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  t.textContent = value;
  is.append(t);
  c.append(is);
}

function serialize(doc: Document): string {
  const xml = new XMLSerializer().serializeToString(doc);
  return xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

/** Empties every <si> that no cell references any more, so redacted values cannot linger in the archive. */
function scrubSharedStrings(xml: string, referenced: Set<number>): string {
  const doc = parseXml(xml, 'xl/sharedStrings.xml');
  Array.from(doc.documentElement.children)
    .filter((si) => isMain(si, 'si'))
    .forEach((si, idx) => {
      if (referenced.has(idx)) return;
      while (si.firstChild) si.removeChild(si.firstChild);
      const t = doc.createElementNS(MAIN_NS, 't');
      si.append(t);
    });
  return serialize(doc);
}

/**
 * Grey cell styles. Partial-text shading is impossible in a cell, so a cell that got a replacement gets a
 * new cellXfs entry: a copy of its own style with a solid D9D9D9 fill. Existing entries are never changed,
 * so other cells sharing the original style keep it.
 *
 * Restore needs the original index of each grey entry. That mapping is written into styles.xml under an
 * <extLst> entry with a private URI (Excel and LibreOffice ignore extensions they do not know). Restore
 * reads it back, points each restored cell at its original index, and drops the grey entries no cell uses.
 */
const GREY_EXT_URI = 'urn:pii-shield:grey-styles:v1';
const GREY_NS = 'urn:pii-shield:grey-styles';

interface GreyRecord {
  /** Index of the grey fill appended to <fills>, or null when none has been added. */
  fill: number | null;
  /** grey: index of the added cellXfs entry; orig: the index it was cloned from. Grey entries are contiguous at the end. */
  entries: { grey: number; orig: number }[];
}

class StyleBook {
  readonly doc: Document;
  readonly record: GreyRecord;
  readonly cellXfs: Element | null;
  readonly fills: Element | null;
  dirty = false;

  constructor(xml: string) {
    this.doc = parseXml(xml, 'xl/styles.xml');
    const root = this.doc.documentElement;
    const child = (local: string) => Array.from(root.children).find((c) => isMain(c, local)) ?? null;
    this.cellXfs = child('cellXfs');
    this.fills = child('fills');
    this.record = readRecord(root);
  }

  /** The style index a cell would have without our grey (a grey entry maps back to the one it was cloned from). */
  original(s: number): number {
    return this.record.entries.find((e) => e.grey === s)?.orig ?? s;
  }

  /** The grey entry for an original style, created on first use; null when the styles cannot be read. */
  grey(base: number): number | null {
    if (!this.cellXfs || !this.fills) return null;
    const existing = this.record.entries.find((e) => e.orig === base);
    if (existing) return existing.grey;
    const xfs = Array.from(this.cellXfs.children);
    const src = xfs[base];
    if (!src) return null;
    if (this.record.fill === null) {
      const fill = this.doc.createElementNS(MAIN_NS, 'fill');
      const pattern = this.doc.createElementNS(MAIN_NS, 'patternFill');
      pattern.setAttribute('patternType', 'solid');
      const fg = this.doc.createElementNS(MAIN_NS, 'fgColor');
      fg.setAttribute('rgb', 'FFD9D9D9');
      const bg = this.doc.createElementNS(MAIN_NS, 'bgColor');
      bg.setAttribute('indexed', '64');
      pattern.append(fg, bg);
      fill.append(pattern);
      this.fills.append(fill);
      this.fills.setAttribute('count', String(this.fills.children.length));
      this.record.fill = this.fills.children.length - 1;
    }
    const xf = src.cloneNode(true) as Element;
    xf.setAttribute('fillId', String(this.record.fill));
    xf.setAttribute('applyFill', '1');
    this.cellXfs.append(xf);
    this.cellXfs.setAttribute('count', String(this.cellXfs.children.length));
    const grey = this.cellXfs.children.length - 1;
    this.record.entries.push({ grey, orig: base });
    this.dirty = true;
    return grey;
  }

  /** Drops grey entries (and their fill) that no cell uses any more, then writes the record back. */
  finish(referenced: Set<number>): void {
    if (!this.cellXfs) return;
    const { entries } = this.record;
    while (entries.length > 0) {
      const last = entries[entries.length - 1];
      if (referenced.has(last.grey) || last.grey !== this.cellXfs.children.length - 1) break;
      this.cellXfs.removeChild(this.cellXfs.lastElementChild!);
      entries.pop();
      this.cellXfs.setAttribute('count', String(this.cellXfs.children.length));
      this.dirty = true;
    }
    if (entries.length === 0 && this.record.fill !== null && this.fills) {
      if (this.record.fill === this.fills.children.length - 1) {
        this.fills.removeChild(this.fills.lastElementChild!);
        this.fills.setAttribute('count', String(this.fills.children.length));
      }
      this.record.fill = null;
      this.dirty = true;
    }
    if (this.dirty) writeRecord(this.doc.documentElement, this.record);
  }

  serialize(): string {
    return serialize(this.doc);
  }
}

function readRecord(root: Element): GreyRecord {
  const record: GreyRecord = { fill: null, entries: [] };
  const extLst = Array.from(root.children).find((c) => isMain(c, 'extLst'));
  const ext = extLst && Array.from(extLst.children).find((c) => c.getAttribute('uri') === GREY_EXT_URI);
  const body = ext && Array.from(ext.children).find((c) => c.namespaceURI === GREY_NS);
  if (!body) return record;
  const fill = Number(body.getAttribute('fill'));
  if (Number.isInteger(fill)) record.fill = fill;
  for (const xf of Array.from(body.children)) {
    const grey = Number(xf.getAttribute('grey'));
    const orig = Number(xf.getAttribute('orig'));
    if (Number.isInteger(grey) && Number.isInteger(orig)) record.entries.push({ grey, orig });
  }
  return record;
}

/** Replaces the grey record in the styles' extLst (removing the extLst when nothing is left in it). */
function writeRecord(root: Element, record: GreyRecord): void {
  const doc = root.ownerDocument;
  let extLst = Array.from(root.children).find((c) => isMain(c, 'extLst')) ?? null;
  if (extLst) {
    for (const ext of Array.from(extLst.children)) if (ext.getAttribute('uri') === GREY_EXT_URI) extLst.removeChild(ext);
  }
  if (record.fill === null && record.entries.length === 0) {
    if (extLst && extLst.children.length === 0) root.removeChild(extLst);
    return;
  }
  if (!extLst) {
    extLst = doc.createElementNS(MAIN_NS, 'extLst');
    root.append(extLst);
  }
  const ext = doc.createElementNS(MAIN_NS, 'ext');
  ext.setAttribute('uri', GREY_EXT_URI);
  const body = doc.createElementNS(GREY_NS, 'greyStyles');
  body.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:grey', GREY_NS);
  if (record.fill !== null) body.setAttribute('fill', String(record.fill));
  for (const e of record.entries) {
    const xf = doc.createElementNS(GREY_NS, 'grey:xf');
    xf.setAttribute('grey', String(e.grey));
    xf.setAttribute('orig', String(e.orig));
    body.append(xf);
  }
  ext.append(body);
  extLst.append(ext);
}

/** Sets a cell's style index; index 0 is the default and is written as no attribute. */
function setStyle(c: Element, index: number): void {
  if (index === 0) c.removeAttribute('s');
  else c.setAttribute('s', String(index));
}

/**
 * Grey for a changed cell that got a replacement (`grey` true), or the original style back for a cell
 * that is grey and is changed without one (restore). Other cells keep whatever they have.
 */
function restyle(c: Element, book: StyleBook, grey: boolean): void {
  const raw = c.getAttribute('s');
  const current = raw === null ? 0 : Number(raw);
  if (grey) {
    const target = book.grey(book.original(current));
    if (target !== null && target !== current) setStyle(c, target);
    return;
  }
  const base = book.original(current);
  if (base !== current) setStyle(c, base);
}

/**
 * Changed cells are rewritten as inline strings so every cell keeps its own code even when
 * several cells originally shared one entry in sharedStrings.xml. Cells with a replacement get a grey
 * style when `highlight` is on (see StyleBook); with it off, a grey cell that is changed (restore) gets its
 * original style back. Other styles and every other part of the workbook are untouched, except that
 * shared-string entries no longer referenced by any cell are blanked (see scrubSharedStrings).
 */
export async function generateXlsx(doc: LoadedDocument, edits: TextEdit[], opts: GenerateOptions = {}): Promise<Blob> {
  const handle = doc.handle as XlsxHandle;
  const changes = distributeChanges(handle.segments, edits);

  const perSheet = new Map<number, Map<number, SegmentChange>>();
  for (const [segIdx, change] of changes) {
    const ref = handle.cells[segIdx];
    if (!perSheet.has(ref.sheetIdx)) perSheet.set(ref.sheetIdx, new Map());
    perSheet.get(ref.sheetIdx)!.set(ref.cellIdx, change);
  }

  const out = (handle.zip as JSZip & { clone(): JSZip }).clone();
  const book = handle.stylesXml !== null ? new StyleBook(handle.stylesXml) : null;
  const referenced = new Set<number>();
  const styleRefs = new Set<number>();
  const sheets: { path: string; xml: string }[] = [];
  for (const [sheetIdx, sheet] of handle.sheets.entries()) {
    const clone = sheet.doc.cloneNode(true) as Document;
    const cellChanges = perSheet.get(sheetIdx);
    if (cellChanges) {
      const cells = textCells(clone);
      for (const [cellIdx, change] of cellChanges) {
        const cell = cells[cellIdx];
        setInlineString(cell, change.text);
        if (book) restyle(cell, book, (opts.highlight ?? false) && change.replaced.length > 0);
      }
    }
    for (const c of Array.from(clone.getElementsByTagNameNS(MAIN_NS, 'c'))) {
      if (c.getAttribute('t') === 's') {
        const idx = Number(c.getElementsByTagNameNS(MAIN_NS, 'v')[0]?.textContent ?? '');
        if (Number.isInteger(idx)) referenced.add(idx);
      }
      const s = c.getAttribute('s');
      if (s !== null) styleRefs.add(Number(s));
    }
    for (const el of [...Array.from(clone.getElementsByTagNameNS(MAIN_NS, 'row')), ...Array.from(clone.getElementsByTagNameNS(MAIN_NS, 'col'))]) {
      const s = el.getAttribute(el.localName === 'row' ? 's' : 'style');
      if (s !== null) styleRefs.add(Number(s));
    }
    sheets.push({ path: sheet.path, xml: serialize(clone) });
  }
  for (const sheet of sheets) out.file(sheet.path, sheet.xml);
  if (book) {
    book.finish(styleRefs);
    if (book.dirty) out.file('xl/styles.xml', book.serialize());
  }
  if (handle.sharedStringsXml !== null) {
    out.file('xl/sharedStrings.xml', scrubSharedStrings(handle.sharedStringsXml, referenced));
  }
  return out.generateAsync({ type: 'blob', mimeType: XLSX_MIME, compression: 'DEFLATE' });
}
