import type { LoadedDocument, MappingEntry } from '../core/types';
import { parseMarkers } from '../core/codes';
import { parseMapping } from '../core/csv';
import { restore, restoreLoose, type RestoreResult } from '../core/restorer';
import { ACCEPT_ATTR, generateDocument, outputFileName, parseDocument } from '../formats';
import { button, clear, downloadBlob, dropZone, el, rejectOversized, toast, withBusy } from './components';
import { renderDocumentPreview, type Decoration } from './preview';
import { RESTORE_SAMPLE, fetchSample, sampleUrl } from './samples';

type Mode = 'file' | 'reply';

interface ReplyState {
  text: string;
  /** Restored text after 還原 is pressed; null until then. */
  output: string | null;
  restoredCount: number;
  unknownCodes: string[];
}

interface State {
  mode: Mode;
  doc: LoadedDocument | null;
  mapping: MappingEntry[] | null;
  result: RestoreResult | null;
  reply: ReplyState;
}

const state: State = {
  mode: 'file',
  doc: null,
  mapping: null,
  result: null,
  reply: { text: '', output: null, restoredCount: 0, unknownCodes: [] },
};

export function createRestoreView(): HTMLElement {
  const root = el('section', { class: 'view restore-view' });
  render(root);
  return root;
}

function render(root: HTMLElement): void {
  clear(root);
  root.append(
    el('div', { class: 'tabs', role: 'group', 'aria-label': '還原方式' },
      modeTab('file', '還原文件', root),
      modeTab('reply', '貼上 AI 的回覆來還原', root),
    ),
  );
  if (state.mode === 'reply') renderReplyMode(root);
  else renderFileMode(root);
}

function modeTab(mode: Mode, label: string, root: HTMLElement): HTMLButtonElement {
  const active = state.mode === mode;
  const b = button(label, () => {
    if (state.mode === mode) return;
    state.mode = mode;
    render(root);
  }, active ? 'tab active' : 'tab');
  b.setAttribute('aria-pressed', String(active));
  return b;
}

/** The 編碼表 slot, shared by both modes: the same key file restores either kind of input. */
function mappingSlot(root: HTMLElement): HTMLElement {
  return state.mapping
    ? fileChip(`還原鑰匙檔：${state.mapping.length} 筆`, () => {
        state.mapping = null;
        state.result = null;
        state.reply.output = null;
        render(root);
      })
    : dropZone({ accept: '.csv,text/csv', label: '選擇還原鑰匙檔（CSV）', hint: '*.mapping.csv', onFiles: (f) => void loadCsv(f[0], root) });
}

function renderFileMode(root: HTMLElement): void {
  root.append(
    el('h2', {}, '還原文件'),
    el('p', { class: 'muted' }, '上傳隱藏個資後的文件，以及下載時附上的還原鑰匙檔（CSV），系統會把標記換回原本的內容。'),
    el('div', { class: 'restore-inputs' },
      el('div', { class: 'restore-slot' },
        el('h3', {}, '1. 隱藏個資後的文件'),
        state.doc ? fileChip(state.doc.fileName, () => { state.doc = null; state.result = null; render(root); }) : dropZone({ accept: ACCEPT_ATTR, label: '選擇隱藏個資後的文件', hint: '.pdf .docx .xlsx .txt .md', onFiles: (f) => void loadDocChecked(f[0], root) }),
      ),
      el('div', { class: 'restore-slot' },
        el('h3', {}, '2. 還原鑰匙檔（CSV）'),
        mappingSlot(root),
      ),
    ),
  );
  if (state.result) root.append(renderResult(root));
  else {
    root.append(
      el('section', { class: 'samples' },
        el('h3', {}, '用範例試試還原'),
        el('p', { class: 'muted small' }, '範例為已隱藏個資的 4 頁契約書與它的還原鑰匙檔（虛構資料）。「載入範例並還原」會同時載入兩個檔案並自動還原。'),
        el('div', { class: 'sample-actions' },
          button('載入範例並還原', () => void withBusy('載入範例中…', () => loadSamplePair(root)), 'btn btn-small btn-primary'),
          el('a', { class: 'btn btn-small', href: sampleUrl(RESTORE_SAMPLE.doc.file), download: RESTORE_SAMPLE.doc.name }, `下載 ${RESTORE_SAMPLE.doc.name}`),
          el('a', { class: 'btn btn-small', href: sampleUrl(RESTORE_SAMPLE.csv.file), download: RESTORE_SAMPLE.csv.name }, `下載 ${RESTORE_SAMPLE.csv.name}`),
        ),
      ),
    );
  }
}

function renderReplyMode(root: HTMLElement): void {
  const reply = state.reply;
  const input = el('textarea', {
    class: 'reply-input',
    rows: '8',
    placeholder: '把 ChatGPT、Claude 等 AI 的回覆貼在這裡',
    'aria-label': 'AI 的回覆',
  }, reply.text);
  input.addEventListener('input', () => {
    state.reply.text = input.value;
  });

  root.append(
    el('h2', {}, '貼上 AI 的回覆來還原'),
    el('p', { class: 'muted' }, '把隱藏個資後的文字交給 AI 處理，再把它的回覆貼回來，系統會把回覆裡的標記換回原本的內容。AI 可能改動了標記的樣子（例如括號或冒號），這裡會盡量辨認。'),
    el('div', { class: 'restore-slot restore-slot-wide' },
      el('h3', {}, '1. 還原鑰匙檔（CSV）'),
      mappingSlot(root),
    ),
    el('div', { class: 'restore-slot restore-slot-wide' },
      el('h3', {}, '2. 貼上 AI 的回覆'),
      input,
      el('div', { class: 'toolbar-actions' }, button('還原', () => runReplyRestore(root), 'btn btn-primary')),
    ),
  );
  if (reply.output !== null) root.append(renderReplyResult());
}

function runReplyRestore(root: HTMLElement): void {
  if (!state.reply.text.trim()) {
    toast('請先貼上 AI 的回覆', 'error');
    return;
  }
  if (!state.mapping) {
    toast('請先選擇還原鑰匙檔（CSV）', 'error');
    return;
  }
  const r = restoreLoose(state.reply.text, state.mapping);
  state.reply.output = r.restoredText;
  state.reply.restoredCount = r.restoredCount;
  state.reply.unknownCodes = r.missingCodes;
  render(root);
}

function renderReplyResult(): HTMLElement {
  const { output, restoredCount, unknownCodes } = state.reply;
  const nothingFound = restoredCount === 0 && unknownCodes.length === 0;
  return el(
    'div',
    { class: 'restore-result' },
    el('div', { class: 'toolbar' },
      el('div', {}, el('strong', {}, `已還原 ${restoredCount} 筆`)),
      button('複製', () => void copyText(output ?? ''), 'btn btn-primary'),
    ),
    unknownCodes.length
      ? el('div', { class: 'notice notice-warn' },
        `有 ${unknownCodes.length} 個標記在還原鑰匙檔中找不到，可能是 AI 改寫了內容`,
        el('div', { class: 'code-list' }, ...unknownCodes.map((c) => el('code', {}, c))))
      : null,
    nothingFound ? el('p', { class: 'muted small' }, '回覆中找不到可還原的標記。') : null,
    el('h3', {}, '還原結果'),
    el('textarea', { class: 'reply-output', readonly: true, rows: '10', 'aria-label': '還原後的文字' }, output ?? ''),
  );
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('已複製到剪貼簿', 'success');
  } catch {
    toast('無法自動複製，請手動選取下方文字後複製', 'error', 6000);
  }
}

async function loadSamplePair(root: HTMLElement): Promise<void> {
  try {
    const [doc, csv] = await Promise.all([fetchSample(RESTORE_SAMPLE.doc), fetchSample(RESTORE_SAMPLE.csv)]);
    state.doc = await parseDocument(doc);
    const { entries, errors } = parseMapping(await csv.text());
    if (errors.length) throw new Error(errors[0]);
    state.mapping = entries;
    state.result = null;
    tryRestore();
    render(root);
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

function fileChip(label: string, onRemove: () => void): HTMLElement {
  return el('div', { class: 'file-chip' }, el('span', {}, label), button('移除', onRemove, 'btn btn-small btn-ghost'));
}

async function loadDocChecked(file: File, root: HTMLElement): Promise<void> {
  if ((await rejectOversized([file])).length > 0) await withBusy('讀取檔案中…', () => loadDoc(file, root));
}

/** Output written with 類別 or 空白佔位 carries no codes, so there is nothing to restore. */
const NO_MARKERS = '這份文件裡找不到可還原的標記；若隱藏時的標記方式選了「類別標記」或「空白佔位」，就無法還原。';

async function loadDoc(file: File, root: HTMLElement): Promise<void> {
  try {
    state.doc = await parseDocument(file);
    if (!state.mapping && parseMarkers(state.doc.text).length === 0) toast(NO_MARKERS, 'error', 8000);
    state.result = null;
    tryRestore();
    render(root);
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

async function loadCsv(file: File, root: HTMLElement): Promise<void> {
  try {
    const { entries, errors } = parseMapping(await file.text());
    if (errors.length) {
      toast(`還原鑰匙檔格式錯誤：${errors.slice(0, 3).join('；')}${errors.length > 3 ? '…' : ''}`, 'error', 9000);
      return;
    }
    state.mapping = entries;
    state.result = null;
    state.reply.output = null;
    if (state.mode === 'file') tryRestore();
    render(root);
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

function tryRestore(): void {
  if (!state.doc || !state.mapping) return;
  state.result = restore(state.doc.text, state.mapping);
  if (state.result.missingCodes.length) toast(`有 ${state.result.missingCodes.length} 個標記在還原鑰匙檔中找不到`, 'error', 7000);
  else if (state.result.restoredCount === 0) toast(NO_MARKERS, 'error', 8000);
  else toast(`已還原 ${state.result.restoredCount} 筆`, 'success');
}

function renderResult(root: HTMLElement): HTMLElement {
  const r = state.result!;
  const doc = state.doc!;
  const preview = el('div', { class: 'preview' });
  const decorations: Decoration[] = r.edits.map((e) => ({
    start: e.start,
    end: e.end,
    kind: 'restored',
    label: e.replacement,
    className: 'mark-restored',
    tip: `已由標記 ${doc.text.slice(e.start, e.end)} 還原`,
  }));
  renderDocumentPreview(preview, doc, decorations);

  return el(
    'div',
    { class: 'restore-result' },
    el('div', { class: 'toolbar' },
      el('div', {}, el('strong', {}, `已還原 ${r.restoredCount} 筆`), r.missingCodes.length ? el('span', { class: 'warn' }, `，${r.missingCodes.length} 個標記無法還原`) : null),
      button('下載還原文件', () => void download(root), 'btn btn-primary'),
    ),
    r.missingCodes.length
      ? el('div', { class: 'notice notice-warn' }, '以下標記在還原鑰匙檔中找不到，已保留原樣：', el('div', { class: 'code-list' }, ...r.missingCodes.map((c) => el('code', {}, c))))
      : null,
    el('h3', {}, '還原預覽'),
    preview,
  );
}

async function download(_root: HTMLElement): Promise<void> {
  const doc = state.doc!;
  const r = state.result!;
  try {
    toast('產生檔案中…', 'info', 2000);
    const blob = await generateDocument(doc, r.edits);
    downloadBlob(blob, outputFileName(doc.fileName.replace(/\.deid(?=\.[^.]+$)/, ''), 'restored'));
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}
