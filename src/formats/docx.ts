import JSZip from 'jszip';
import type { DocxParagraphLayout, GenerateOptions, LoadedDocument, TextEdit } from '../core/types';
import { distributeChanges, type Segment, type SegmentChange } from './segments';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface PartInfo {
  path: string;
  doc: Document;
  nodes: Element[];
  segments: Segment[];
  paragraphs: DocxParagraphLayout[];
}

export interface DocxHandle {
  zip: JSZip;
  parts: PartInfo[];
}

function isW(el: Element, local: string): boolean {
  return el.namespaceURI === W_NS && el.localName === local;
}

let tableSeq = 0;

function styleOf(p: Element): DocxParagraphLayout['style'] {
  const val = p.getElementsByTagNameNS(W_NS, 'pStyle')[0]?.getAttributeNS(W_NS, 'val') ?? '';
  if (/title/i.test(val)) return 'title';
  if (/heading|^h\d/i.test(val)) return 'heading';
  return 'normal';
}

/** Walks a part in document order, collecting <w:t> nodes, the full text they form, and paragraph/table layout. */
function extractPart(path: string, doc: Document, offset: number): { part: PartInfo; text: string } {
  const nodes: Element[] = [];
  const segments: Segment[] = [];
  const paragraphs: DocxParagraphLayout[] = [];
  const partKind: DocxParagraphLayout['part'] = /header/.test(path) ? 'header' : /footer/.test(path) ? 'footer' : 'body';
  const tableStack: { id: number; row: number; col: number }[] = [];
  let text = '';

  const visit = (el: Element) => {
    if (el.namespaceURI === MC_NS && el.localName === 'Fallback') return;
    if (isW(el, 'del') || isW(el, 'delText')) return;
    if (isW(el, 'tbl')) {
      tableStack.push({ id: tableSeq++, row: -1, col: -1 });
      for (const child of Array.from(el.children)) visit(child);
      tableStack.pop();
      return;
    }
    if (isW(el, 'tr') && tableStack.length) {
      const t = tableStack[tableStack.length - 1];
      t.row++;
      t.col = -1;
      for (const child of Array.from(el.children)) visit(child);
      return;
    }
    if (isW(el, 'tc') && tableStack.length) {
      tableStack[tableStack.length - 1].col++;
      for (const child of Array.from(el.children)) visit(child);
      return;
    }
    if (isW(el, 'p')) {
      const start = offset + text.length;
      for (const child of Array.from(el.children)) visit(child);
      const t = tableStack[tableStack.length - 1];
      paragraphs.push({ start, end: offset + text.length, style: styleOf(el), part: partKind, table: t ? { id: t.id, row: t.row, col: t.col } : undefined });
      text += '\n';
      return;
    }
    if (isW(el, 't')) {
      const t = el.textContent ?? '';
      if (t.length > 0) {
        nodes.push(el);
        segments.push({ start: offset + text.length, end: offset + text.length + t.length, text: t });
        text += t;
      }
      return;
    }
    if (isW(el, 'tab')) {
      text += '\t';
      return;
    }
    if (isW(el, 'br') || isW(el, 'cr')) {
      text += '\n';
      return;
    }
    for (const child of Array.from(el.children)) visit(child);
  };

  visit(doc.documentElement);
  return { part: { path, doc, nodes, segments, paragraphs }, text };
}

function partOrder(paths: string[]): string[] {
  const main = paths.filter((p) => p === 'word/document.xml');
  const rest = paths.filter((p) => /^word\/(header|footer)\d*\.xml$/.test(p)).sort();
  return [...main, ...rest];
}

export async function parseDocx(file: File): Promise<LoadedDocument> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const paths = partOrder(Object.keys(zip.files));
  if (!paths.includes('word/document.xml')) throw new Error('不是有效的 Word (.docx) 檔案');

  const parser = new DOMParser();
  const parts: PartInfo[] = [];
  let text = '';
  for (const path of paths) {
    const xml = await zip.file(path)!.async('string');
    const doc = parser.parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) throw new Error(`無法解析 ${path}`);
    const { part, text: partText } = extractPart(path, doc, text.length);
    parts.push(part);
    text += partText;
    if (!text.endsWith('\n')) text += '\n';
  }
  const handle: DocxHandle = { zip, parts };
  const layout = { kind: 'docx' as const, paragraphs: parts.flatMap((p) => p.paragraphs) };
  return { fileName: file.name, format: 'docx', text, handle, layout };
}

function serialize(doc: Document): string {
  const xml = new XMLSerializer().serializeToString(doc);
  return xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

/** The light grey behind replacement text (also the fill that restore looks for; see isGreyShading). */
const GREY_FILL = 'D9D9D9';
/** rPr children that the schema places after w:shd (so w:shd goes in front of them). */
const AFTER_SHD = new Set(['fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath']);

const childNamed = (el: Element, local: string): Element | null => Array.from(el.children).find((c) => isW(c, local)) ?? null;

/** A w:shd with the grey fill, which only this tool writes into a run's properties. */
const isGreyShading = (el: Element): boolean => isW(el, 'shd') && el.getAttributeNS(W_NS, 'fill')?.toUpperCase() === GREY_FILL;

/**
 * Sets or clears the grey shading in a run's rPr (null when there is no rPr to write). Clearing removes only
 * the grey fill, so other shading stays; setting replaces whatever shading the run had, since a run holds
 * one w:shd. An rPr left empty is dropped so the run matches the original.
 */
function withGreyShading(rPr: Element | null, doc: Document, on: boolean): Element | null {
  let rp = rPr;
  if (rp) for (const c of Array.from(rp.children)) if (on ? isW(c, 'shd') : isGreyShading(c)) rp.removeChild(c);
  if (on) {
    if (!rp) rp = doc.createElementNS(W_NS, 'w:rPr');
    const shd = doc.createElementNS(W_NS, 'w:shd');
    shd.setAttributeNS(W_NS, 'w:val', 'clear');
    shd.setAttributeNS(W_NS, 'w:color', 'auto');
    shd.setAttributeNS(W_NS, 'w:fill', GREY_FILL);
    const after = Array.from(rp.children).find((c) => AFTER_SHD.has(c.localName));
    rp.insertBefore(shd, after ?? null);
  }
  if (rp && rp.children.length === 0 && rp.attributes.length === 0) return null;
  return rp;
}

/** The replacement spans and the unchanged spans of a segment's new text, in order. */
function pieces(change: SegmentChange): { text: string; replace: boolean }[] {
  const out: { text: string; replace: boolean }[] = [];
  let cursor = 0;
  for (const [s, e] of change.replaced) {
    if (s > cursor) out.push({ text: change.text.slice(cursor, s), replace: false });
    out.push({ text: change.text.slice(s, e), replace: true });
    cursor = e;
  }
  if (cursor < change.text.length) out.push({ text: change.text.slice(cursor), replace: false });
  return out.length > 0 ? out : [{ text: '', replace: false }];
}

/** Writes a changed <w:t> in place, keeping its run's formatting untouched. */
function writeText(node: Element, text: string): void {
  node.textContent = text;
  node.setAttributeNS(XML_NS, 'xml:space', 'preserve');
}

/**
 * Rewrites one run whose text changed: the run is split so that each replacement sits in its own run,
 * shaded when `highlight` is on. Every piece keeps the run's properties (rPr) and attributes; the grey
 * shading the run carried before (from an earlier de-identification) is removed, which is how restore
 * clears it. Other content in the run (tabs, breaks) stays in the same order.
 */
function rebuildRun(run: Element, changes: Map<Element, SegmentChange>, highlight: boolean): void {
  const parent = run.parentNode!;
  const doc = run.ownerDocument;
  const rPr = childNamed(run, 'rPr');
  const runs: Element[] = [];
  let cur: Node[] = [];
  const makeRun = (children: Node[], shade: boolean): Element => {
    const r = run.cloneNode(false) as Element;
    const rp = withGreyShading(rPr ? (rPr.cloneNode(true) as Element) : null, doc, shade);
    if (rp) r.append(rp);
    r.append(...children);
    return r;
  };
  for (const child of Array.from(run.childNodes)) {
    if (child === rPr) continue;
    const change = child instanceof Element ? changes.get(child) : undefined;
    if (!change || !(child instanceof Element)) {
      cur.push(child);
      continue;
    }
    if (cur.length > 0) runs.push(makeRun(cur, false));
    cur = [];
    for (const piece of pieces(change)) {
      const t = child.cloneNode(false) as Element;
      t.textContent = piece.text;
      if (/^\s|\s$/.test(piece.text)) t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      runs.push(makeRun([t], highlight && piece.replace));
    }
  }
  if (cur.length > 0) runs.push(makeRun(cur, false));
  for (const r of runs) parent.insertBefore(r, run);
  parent.removeChild(run);
}

/**
 * Applies the new text of every changed <w:t>. A run whose text changes is rebuilt only when it has to be:
 * when it gets a replacement that is to be shaded, or when it already carries the grey (restore). Other
 * runs just get their text, so output for an untouched structure stays byte-for-byte the same as before.
 */
function applyChanges(nodes: Element[], changes: Map<number, SegmentChange>, highlight: boolean): void {
  const byRun = new Map<Element, Map<Element, SegmentChange>>();
  for (const [i, change] of changes) {
    const node = nodes[i];
    const run = node.parentNode;
    if (!(run instanceof Element) || !isW(run, 'r')) {
      writeText(node, change.text);
      continue;
    }
    if (!byRun.has(run)) byRun.set(run, new Map());
    byRun.get(run)!.set(node, change);
  }
  for (const [run, list] of byRun) {
    const rPr = childNamed(run, 'rPr');
    const greyed = rPr ? Array.from(rPr.children).some(isGreyShading) : false;
    const shade = highlight && Array.from(list.values()).some((c) => c.replaced.length > 0);
    if (!greyed && !shade) {
      for (const [node, change] of list) writeText(node, change.text);
    } else {
      rebuildRun(run, list, highlight);
    }
  }
}

/**
 * Every call works on a fresh clone of the pristine parts, so repeated downloads stay correct and the
 * loaded document is never changed. With `highlight`, each replacement gets a light-grey background
 * (w:shd fill D9D9D9); without it, runs that get a replacement lose that grey (restore).
 */
export async function generateDocx(doc: LoadedDocument, edits: TextEdit[], opts: GenerateOptions = {}): Promise<Blob> {
  const handle = doc.handle as DocxHandle;
  const out = (handle.zip as JSZip & { clone(): JSZip }).clone();
  for (const part of handle.parts) {
    const partStart = part.segments[0]?.start ?? 0;
    const partEnd = part.segments.at(-1)?.end ?? 0;
    const partEdits = edits.filter((e) => e.start < partEnd && e.end > partStart);

    const cloneDoc = part.doc.cloneNode(true) as Document;
    const { part: clone } = extractPart(part.path, cloneDoc, partStart);
    applyChanges(clone.nodes, distributeChanges(clone.segments, partEdits), opts.highlight ?? false);
    out.file(part.path, serialize(cloneDoc));
  }
  return out.generateAsync({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
}
