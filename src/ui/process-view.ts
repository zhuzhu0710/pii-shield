import type { Category, LoadedDocument, MappingEntry, RedactionItem, Retention } from '../core/types';
import { CATEGORIES, MAX_FILE_BYTES } from '../core/types';
import { addManualItem, detect, resplitItems, toggleItem } from '../core/detector';
import { applyRedactions, blankOut, isPartial, mergeMappings, outputFor, previewLabel, type MarkerStyle } from '../core/redactor';
import { CodeBook, parseMarkers } from '../core/codes';
import { parseMapping, serializeMapping } from '../core/csv';
import { getEffectivePatterns, loadConfig, saveConfig, setCategoryRetention } from '../core/pattern-store';
import { addBlacklistWord, addWhitelistWord, getWordLists, setWordLists, wordListsKey, wordProblem } from '../core/word-lists';
import { MODE_LABELS, checkRetention, describeRetention, modesFor, splitFor, type RetentionMode } from '../core/retention';
import { hasSavedOutputPrefs, loadOutputPrefs, saveOutputPrefs, type OutputMode } from '../core/output-prefs';
import { ACCEPT_ATTR, formatLimitations, generateDocument, mappingFileName, outputFileName, parseDocument } from '../formats';
import { button, clear, downloadBlob, dropZone, el, rejectOversized, toast, withBusy } from './components';
import { renderDocumentPreview, type Decoration } from './preview';
import { installMarkCards } from './mark-card';
import { MERGED_MAPPING_NAME, buildArchive } from '../formats/batch';
import { SAMPLES, fetchSample, samplesSection } from './samples';
import { ocrOverlay } from './ocr-overlay';

export const MAX_FILES = 10;

/** The three steps, in order. The user always sees which one they are on. */
type Step = 'files' | 'review' | 'download';
const STEPS: { id: Step; title: string }[] = [
  { id: 'files', title: '放入檔案' },
  { id: 'review', title: '檢查標記' },
  { id: 'download', title: '下載' },
];

/** 露出部分 (default) keeps the standard statistics-friendly characters; 全部隱藏 hides every value; 自訂 is set per category. */
const OUTPUT_MODE_LABELS: Record<OutputMode, string> = { preview: '露出部分', code: '全部隱藏', custom: '自訂' };

/** 可還原 restores with the key file; the other two are for output that is never restored. */
const MARKER_LABELS: Record<MarkerStyle, string> = { code: '可還原', label: '類別標記', blank: '空白佔位' };
/** Each marker style on 王小明 and what it means in one plain line (shown on its button). */
const MARKER_NOTES: Record<MarkerStyle, { example: string; detail: string }> = {
  code: { example: '王[姓名:6e679d]', detail: '之後能用還原鑰匙檔換回原文' },
  label: { example: '王[姓名]', detail: '只標出類別，之後無法還原' },
  blank: { example: '王○○', detail: '用○填滿、保留字數，之後無法還原' },
};

/** The plain example under each 要露出多少 button, written for a name (the hidden part follows the marker style). */
function keepExample(mode: OutputMode): string {
  if (mode === 'preview') return '王●● 0912●●●●●●';
  if (mode === 'custom') return '每類別各自設定';
  return state.marker === 'blank' ? '王小明 → ○○○' : '王小明 → [姓名]';
}

/** Monospace fonts draw ○ as a small o: examples written with ○ use the text font. */
const exampleClass = (cls: string, marker: MarkerStyle = state.marker): string => (marker === 'blank' ? cls : `mono ${cls}`);

/** What an ID number becomes under an output mode and marker style (codes show as [類別], as in the preview). */
function modeExample(mode: OutputMode, marker: MarkerStyle): string {
  if (mode === 'custom') return '逐類別設定';
  const [kept, hidden] = mode === 'preview' ? ['A1', '23456789'] : ['', 'A123456789'];
  return `A123456789 → ${kept}${marker === 'blank' ? blankOut(hidden) : '[身分證]'}`;
}

/** One uploaded (or pasted) document and everything the user has done to it. */
interface DocState {
  doc: LoadedDocument;
  items: RedactionItem[];
  book: CodeBook;
  /** Bumped on every change that alters the output; downloads remember the version they were made from. */
  version: number;
  docVer: number;
  csvVer: number;
}

interface State {
  step: Step;
  docs: DocState[];
  /** Index into `docs` of the document shown in the preview. */
  active: number;
  /** Ignore the document layout (Word/Excel/PDF) and preview as plain text. */
  plainView: boolean;
  /** Categories switched off in the category table (applies to every document). */
  disabledCategories: Set<Category>;
  /** The detection list is collapsed by default. */
  showList: boolean;
  /** The 依類別調整 section inside 進階設定, open for the session once opened (open anyway under 自訂). */
  categoriesOpen: boolean;
  /** The 進階設定 disclosure, open for the session once opened (open anyway under 自訂). */
  advancedOpen: boolean;
  /** Every document shares one key book. */
  sharedCodes: boolean;
  /** Imported key file; its numbers are reused for identical values. */
  imported: { fileName: string; entries: MappingEntry[] } | null;
  /** The batch-wide book while sharedCodes is on; created with the first document. */
  sharedBook: CodeBook | null;
  /** How much of each value stays visible in the output (applies to every document). */
  outputMode: OutputMode;
  /** How the hidden part is written; only 可還原 can be restored (applies to every document). */
  marker: MarkerStyle;
  /** 自訂 mode: per-category retention overriding the rules' own setting. */
  overrides: Map<Category, Retention>;
  /** Word, Excel and PDF output: light grey behind each hidden value (applies to every document). */
  highlight: boolean;
  /** Fingerprint of the patterns the loaded documents were last detected with. */
  patternKey: string;
  /** The user has chosen output settings in this browser (saved, or chosen this session). False on a first visit. */
  prefsAccepted: boolean;
  /** The output card is expanded; collapsed it shows one line. Opens by itself on a first visit. */
  panelOpen: boolean;
}

const state: State = {
  step: 'files',
  docs: [],
  active: 0,
  plainView: false,
  disabledCategories: new Set(),
  showList: false,
  categoriesOpen: false,
  advancedOpen: false,
  sharedCodes: false,
  imported: null,
  sharedBook: null,
  outputMode: 'preview',
  marker: 'code',
  overrides: new Map(),
  highlight: true,
  patternKey: '',
  prefsAccepted: false,
  panelOpen: true,
};

/** Retention of the first enabled rule of a category (the 自訂 default before any override). */
function ruleRetention(category: Category): Retention | undefined {
  const r = getEffectivePatterns().find((p) => p.enabled && p.category === category)?.retention;
  return r && r.mode !== 'none' ? r : undefined;
}

/** What an item keeps under the current output mode; manual items follow their category like detected ones. */
function effectiveRetention(it: RedactionItem): Retention | undefined {
  if (state.outputMode === 'code') return undefined;
  if (state.outputMode === 'preview') return { mode: 'preview' };
  return state.overrides.get(it.category) ?? it.retention;
}

function applyOutputMode(d: DocState): void {
  resplitItems(d.items, d.book, effectiveRetention);
}

function applyOutputModeToAll(): void {
  for (const d of state.docs) {
    applyOutputMode(d);
    markDirty(d);
  }
}

/** Seeded from the imported key file when there is one; one book for the whole batch when codes are shared. */
function bookForNewDoc(): CodeBook {
  if (state.sharedCodes && state.sharedBook) return state.sharedBook;
  const book = new CodeBook();
  if (state.imported) book.seed(state.imported.entries);
  if (state.sharedCodes) state.sharedBook = book;
  return book;
}

/** Code scope changed mid-way: give every document a fresh book and reassign all codes. */
function rebuildBooks(): void {
  state.sharedBook = null;
  for (const d of state.docs) d.book = bookForNewDoc();
  applyOutputModeToAll();
}

const restorable = (): boolean => state.marker === 'code';

/** A batch-wide key file is offered whenever codes can repeat across files or continue an earlier one. */
const hasMergedTable = (): boolean => restorable() && (state.sharedCodes || state.imported !== null);

function mergedMapping(): MappingEntry[] {
  return mergeMappings(state.imported?.entries ?? [], ...state.docs.map((d) => applyRedactions(d.doc.text, d.items).mapping));
}
/** The mounted view, so changes made in other tabs can re-render it. */
let viewRoot: HTMLElement | null = null;

const current = (): DocState => state.docs[state.active];

function markDirty(d: DocState): void {
  d.version++;
}

/** Without restoring there is no key file to download, only the document. */
const isDownloaded = (d: DocState): boolean => d.docVer === d.version && (!restorable() || d.csvVer === d.version);

function tooltipFor(it: RedactionItem): string {
  return `${it.category}｜原文：${it.original}｜隱藏後顯示：${outputFor(it, state.marker)}${it.origin === 'manual' ? '｜手動新增' : ''}`;
}

function setCategoryEnabled(category: Category, enabled: boolean): void {
  if (enabled) state.disabledCategories.delete(category);
  else state.disabledCategories.add(category);
  for (const d of state.docs) {
    for (const it of d.items) {
      if (it.category !== category || it.active === enabled) continue;
      try {
        toggleItem(d.items, it.id);
      } catch {
        // re-enabling an item that now overlaps a manual one: leave it cancelled
      }
    }
    markDirty(d);
  }
}

/** Newly detected items honour the categories switched off in the category table. */
function applyDisabledCategories(d: DocState): void {
  for (const it of d.items) if (state.disabledCategories.has(it.category)) it.active = false;
}

export function hasUnsavedResults(): boolean {
  return state.docs.some((d) => d.items.some((it) => it.active) && !isDownloaded(d));
}

/** Starts from the choices the user made last time (see core/output-prefs.ts); first visit or unreadable storage gives the defaults. */
function restoreOutputPrefs(): void {
  const prefs = loadOutputPrefs();
  state.outputMode = prefs.outputMode;
  state.marker = prefs.marker;
  state.overrides = prefs.overrides;
  state.highlight = prefs.highlight;
  // A first visit asks once (the card opens); after that the saved choice applies to every file, folded to one line.
  state.prefsAccepted = hasSavedOutputPrefs();
  state.panelOpen = !state.prefsAccepted;
}

/** Remembers the current output choices. The page keeps working when the browser refuses to store them. */
function persistOutputPrefs(): void {
  saveOutputPrefs({ outputMode: state.outputMode, marker: state.marker, overrides: state.overrides, highlight: state.highlight });
  state.prefsAccepted = true;
}

export function createProcessView(): HTMLElement {
  const root = el('section', { class: 'view process-view' });
  viewRoot = root;
  restoreOutputPrefs();
  state.patternKey = patternKey();
  render(root);
  return root;
}

/** Changes to the rules or to the word lists (白名單／黑名單) make the loaded documents stale. */
function patternKey(): string {
  return JSON.stringify([getEffectivePatterns().filter((p) => p.enabled).map((p) => [p.id, p.category, p.regex]), wordListsKey()]);
}

/** Re-detects every loaded document after the word lists changed, keeping manual items and cancellations. */
function rescanAll(): void {
  for (const d of state.docs) rescan(d, true);
  state.patternKey = patternKey();
}

/**
 * Called when the tab becomes visible again: if detection rules changed in the meantime
 * (e.g. a rule added in「進階設定」), re-detect every loaded document, keeping manual items,
 * codes and the user's cancellations for matches that are still found.
 */
export function syncPatternChanges(): void {
  const key = patternKey();
  if (key === state.patternKey) return;
  state.patternKey = key;
  if (state.docs.length === 0 || !viewRoot) return;
  for (const d of state.docs) rescan(d, true);
  const total = state.docs.reduce((n, d) => n + d.items.length, 0);
  toast(`進階設定已變更，已重新檢查（共找到 ${total} 處）`, 'success');
  render(viewRoot);
}

// ---------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------
/** Parsing a PDF/Word file (and loading its parser) can take a while: lock the page and show progress meanwhile. */
async function loadFiles(files: File[], root: HTMLElement): Promise<void> {
  const accepted = await rejectOversized(files);
  if (accepted.length > 0) await withBusy('讀取檔案中…', () => importFiles(accepted, root));
}

async function importFiles(files: File[], root: HTMLElement): Promise<void> {
  const room = MAX_FILES - state.docs.length;
  if (files.length > room) {
    toast(`一次最多處理 ${MAX_FILES} 個檔案（目前已有 ${state.docs.length} 個，只能再加入 ${room} 個）`, 'error', 7000);
    files = files.slice(0, Math.max(0, room));
    if (files.length === 0) return;
  }
  let loaded = 0;
  let firstNew = -1;
  for (const file of files) {
    try {
      const doc = await parseWithOcr(file);
      const book = bookForNewDoc();
      const d: DocState = { doc, items: detect(doc.text, getEffectivePatterns(), book, getWordLists()), book, version: 0, docVer: -1, csvVer: -1 };
      applyOutputMode(d);
      applyDisabledCategories(d);
      state.docs.push(d);
      if (firstNew < 0) firstNew = state.docs.length - 1;
      loaded++;
      if (parseMarkers(doc.text).length > 0) {
        toast(`${file.name}：原文中已有類似 [類別:編號] 的文字，可能與隱藏後的標記混淆。`, 'error', 8000);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') toast(`已取消辨識「${file.name}」`, 'info');
      else toast(`${file.name}：${(e as Error).message}`, 'error', 7000);
    }
  }
  if (loaded === 0) return;
  state.active = firstNew;
  state.step = 'review';
  const total = state.docs.reduce((n, d) => n + d.items.length, 0);
  toast(loaded === 1 ? `找到 ${current().items.length} 處個資` : `已載入 ${loaded} 個檔案，共找到 ${total} 處個資`, 'success');
  if (current().items.length === 0) toast('這份文件沒有找到個資。你仍可以在預覽中圈選文字新增。', 'info', 6000);
  render(root);
}

/** An image-only PDF is recognised behind its own progress screen, which can cancel it (FR-008, FR-009). */
async function parseWithOcr(file: File): Promise<LoadedDocument> {
  const abort = new AbortController();
  const overlay = ocrOverlay(file.name, () => abort.abort());
  try {
    return await parseDocument(file, { ocr: { signal: abort.signal, onProgress: (p) => overlay.update(p) } });
  } finally {
    overlay.close();
  }
}

/**
 * Re-runs detection on a document, keeping manual items. With `keep`, an automatic match
 * found again at the same place reuses its previous item (id, code, cancelled state).
 */
function rescan(d: DocState, keep: boolean): { auto: number; manual: number } {
  const manual = d.items.filter((it) => it.origin === 'manual');
  const old = new Map(d.items.filter((it) => it.origin === 'auto').map((it) => [`${it.start},${it.end},${it.category}`, it]));
  const fresh = detect(d.doc.text, getEffectivePatterns(), d.book, getWordLists())
    .filter((a) => !manual.some((m) => m.active && a.start < m.end && a.end > m.start))
    .map((a) => (keep && old.get(`${a.start},${a.end},${a.category}`)) || a);
  d.items = [...manual, ...fresh].sort((a, b) => a.start - b.start);
  applyOutputMode(d);
  applyDisabledCategories(d);
  markDirty(d);
  return { auto: fresh.length, manual: manual.length };
}

function redetect(root: HTMLElement): void {
  const { auto, manual } = rescan(current(), false);
  toast(`重新檢查完成：自動找到 ${auto} 處、手動新增 ${manual} 處`, 'success');
  render(root);
}

function removeDoc(index: number, root: HTMLElement): void {
  const d = state.docs[index];
  if (d.items.some((it) => it.active) && !isDownloaded(d) && !confirm(`「${d.doc.fileName}」尚未下載隱藏後的文件${restorable() ? '與還原鑰匙檔' : ''}，確定要移除嗎？`)) return;
  state.docs.splice(index, 1);
  state.active = Math.min(state.active, Math.max(0, state.docs.length - 1));
  render(root);
}

function resetAll(root: HTMLElement): void {
  if (hasUnsavedResults() && !confirm('尚有檔案未下載結果與還原鑰匙檔，確定要全部清除嗎？')) return;
  state.docs = [];
  state.active = 0;
  state.sharedBook = null;
  state.step = 'files';
  render(root);
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------
function render(root: HTMLElement): void {
  clear(root);
  if (state.docs.length === 0) state.step = 'files';
  root.append(renderStepper(root));
  if (state.step === 'files') renderFilesStep(root);
  else if (state.step === 'review') renderReviewStep(root);
  else renderDownloadStep(root);
}

/** The three steps as a horizontal track. Finished steps can be revisited; later ones open once files are in. */
function renderStepper(root: HTMLElement): HTMLElement {
  const index = STEPS.findIndex((s) => s.id === state.step);
  const hasFiles = state.docs.length > 0;
  const track = el('ol', { class: 'steps', style: `--p: ${index / (STEPS.length - 1)}` },
    ...STEPS.map((s, i) => {
      const done = i < index;
      const isCurrent = i === index;
      const reachable = i === 0 || hasFiles;
      const dot = el('span', { class: 'step-dot', 'aria-hidden': 'true' }, done ? '✓' : String(i + 1));
      const label = el('span', { class: 'step-label' }, s.title);
      const inner = reachable && !isCurrent
        ? el('button', { class: 'step-button', type: 'button', onClick: () => { state.step = s.id; render(root); } }, dot, label)
        : el('span', { class: 'step-button' }, dot, label);
      if (isCurrent) inner.setAttribute('aria-current', 'step');
      return el('li', { class: `step${done ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}${reachable ? '' : ' is-locked'}` }, inner);
    }),
  );
  return el('nav', { class: 'stepper', 'aria-label': '處理進度' }, track);
}

/** Step 1: put files in (or paste text, or try the sample). */
function renderFilesStep(root: HTMLElement): void {
  const hasFiles = state.docs.length > 0;
  root.append(
    el('section', { class: 'step-panel step-files' },
      el('h2', {}, hasFiles ? '再加入檔案' : '放入要隱藏個資的文件'),
      el('p', { class: 'lead' }, `支援 PDF（含掃描檔）、Word (.docx)、Excel (.xlsx)、TXT、Markdown，一次最多 ${MAX_FILES} 個、單檔 ${MAX_FILE_BYTES / 1024 / 1024} MB 以內。檔案只在這台電腦處理，不會上傳。`),
      hasFiles
        ? el('div', { class: 'notice-soft' },
            el('span', {}, `目前已有 ${state.docs.length} 個檔案。`),
            button('回到檢查標記', () => { state.step = 'review'; render(root); }, 'btn btn-small'),
          )
        : null,
      dropZone({
        accept: ACCEPT_ATTR,
        multiple: true,
        label: '把檔案拖到這裡，或點一下選擇檔案',
        hint: '.pdf　.docx　.xlsx　.txt　.md',
        onFiles: (files) => void loadFiles(files, root),
      }),
      renderPasteBox(root),
      el('div', { class: 'try-sample' },
        el('div', { class: 'try-sample-text' },
          el('h3', {}, '還不確定怎麼操作？'),
          el('p', { class: 'muted small' }, '用範例檔試一次。範例都是虛構資料，不會有真的個資。'),
        ),
        button('先用範例試試看', () => void loadSample(root), 'btn btn-primary btn-strong'),
      ),
      el('details', { class: 'more-samples' },
        el('summary', {}, '想試其他格式？'),
        samplesSection('範例檔', SAMPLES, (file) => loadFiles([file], root)),
      ),
      el('details', { class: 'code-options', open: state.sharedCodes || state.imported !== null },
        el('summary', {}, '進階：多個檔案共用還原鑰匙'),
        renderCodeScope(root),
      ),
    ),
  );
}

async function loadSample(root: HTMLElement): Promise<void> {
  try {
    const file = await withBusy('載入範例中…', () => fetchSample(SAMPLES[0]));
    await loadFiles([file], root);
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

/**
 * Code scope (shared across the batch / continued from an imported key file). Can be changed at any
 * time: once documents are loaded every code is reassigned and the files need downloading again.
 */
function renderCodeScope(root: HTMLElement): HTMLElement {
  const changed = (msg: string) => {
    if (state.docs.length) {
      rebuildBooks();
      toast(`${msg}；所有檔案的編號已重新配置，請重新下載`, 'info', 5000);
    }
    render(root);
  };
  const shared = el('input', { type: 'checkbox' }) as HTMLInputElement;
  shared.checked = state.sharedCodes;
  shared.addEventListener('change', () => {
    state.sharedCodes = shared.checked;
    changed(shared.checked ? '已開啟整批共用編號' : '已關閉整批共用編號');
  });
  const input = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const { entries, errors } = parseMapping(await file.text());
    if (errors.length) {
      toast(`還原鑰匙檔格式錯誤，未匯入：${errors.slice(0, 3).join('；')}`, 'error', 8000);
      return;
    }
    const warnings = new CodeBook().seed(entries);
    state.imported = { fileName: file.name, entries };
    for (const w of warnings.slice(0, 3)) toast(w, 'error', 8000);
    changed(`已匯入 ${entries.length} 筆還原資料，相同的值會沿用原本的編號`);
  });
  return el(
    'div',
    { class: 'code-scope' },
    el('label', { class: 'check-label' }, shared, ' 整批共用編號：同一批檔案中，相同的值使用同一個編號（方便跨檔案對照）'),
    el('div', { class: 'code-options-row' },
      button(state.imported ? '改匯入其他還原鑰匙檔' : '匯入既有還原鑰匙檔（沿用編號）', () => input.click(), 'btn btn-small'),
      state.imported
        ? el('span', {}, ` 已匯入「${state.imported.fileName}」共 ${state.imported.entries.length} 筆 `, button('移除', () => {
            state.imported = null;
            changed('已移除匯入的還原鑰匙檔');
          }, 'btn btn-ghost btn-small'))
        : null,
      input,
    ),
    el('p', { class: 'muted small' }, '匯入上次下載的還原鑰匙檔後，相同的值會沿用原本的編號，新值才會產生新編號，適合每月資料串接。合併後的還原鑰匙檔會累積歷次所有個資，請長期妥善保管。匯入的內容只存在這個分頁的記憶體中。'),
  );
}

function renderPasteBox(root: HTMLElement): HTMLElement {
  const area = el('textarea', { class: 'input paste-area', rows: '5', placeholder: '或直接把文字貼在這裡（例如信件、對話紀錄、報表內容）', 'aria-label': '貼上要隱藏個資的文字' }) as HTMLTextAreaElement;
  const go = () => {
    const text = area.value;
    if (!text.trim()) {
      toast('請先貼上文字', 'error');
      return;
    }
    const n = state.docs.filter((d) => d.doc.fileName.startsWith('貼上的文字')).length;
    void loadFiles([new File([text], n === 0 ? '貼上的文字.txt' : `貼上的文字-${n + 1}.txt`, { type: 'text/plain' })], root);
  };
  area.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') go();
  });
  return el(
    'div',
    { class: 'paste-box' },
    el('div', { class: 'paste-divider' }, el('span', {}, '或直接貼上文字')),
    area,
    el('div', { class: 'paste-actions' }, button('開始隱藏個資', go, 'btn btn-primary'), el('span', { class: 'muted small' }, '文字會原樣處理，結果可以複製。')),
  );
}

/** Step 2: check the marks. Preview in the middle, a plain summary on the side, output settings folded above. */
function renderReviewStep(root: HTMLElement): void {
  const many = state.docs.length > 1;
  const d = current();
  const ws = el('div', { class: 'workspace' });
  root.append(
    el('section', { class: 'step-panel step-review' },
      el('div', { class: 'review-head' },
        el('div', { class: 'review-title' },
          el('h2', {}, '檢查標記'),
          el('p', { class: 'muted small' }, '確認自動找出的個資都已標記。確認完成後按「下一步：下載」。'),
        ),
        renderToolbar(root),
      ),
      ws,
      renderActionBar([
        button('回上一步', () => { state.step = 'files'; render(root); }, 'btn btn-ghost'),
        button('下一步：下載', () => { state.step = 'download'; render(root); }, 'btn btn-primary btn-strong'),
      ]),
    ),
  );
  renderWorkspace(ws, root, d, many);
}

/** Bottom bar with the step's own actions; the primary one is last and on the right. */
function renderActionBar(buttons: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: 'action-bar' }, ...buttons);
}

/** Step 3: warn about the key file, then download the document and the key file, clearly labelled. */
function renderDownloadStep(root: HTMLElement): void {
  const many = state.docs.length > 1;
  const d = current();
  const body = el('div', { class: 'download-main' },
    restorable() ? keyWarning() : noKeyNotice(),
    renderDownloadRows(root, d),
    hasMergedTable() ? el('div', { class: 'download-together' }, button('下載合併的還原鑰匙檔（涵蓋整批）', downloadMerged, 'btn btn-small btn-ghost')) : null,
  );
  root.append(
    el('section', { class: 'step-panel step-download' },
      el('div', { class: 'review-title' },
        el('h2', {}, '下載結果'),
        el('p', { class: 'muted small' }, restorable() ? '文件和還原鑰匙檔請一起保存。' : '這次的標記方式不會產生還原鑰匙檔。'),
      ),
      el('div', { class: `download-layout${many ? ' with-files' : ''}` },
        many ? renderFilePanel(root) : null,
        body,
      ),
      renderActionBar([
        button('回到檢查標記', () => { state.step = 'review'; render(root); }, 'btn btn-ghost'),
        many ? button(`打包下載全部（${state.docs.length} 個檔案）`, () => void downloadAll(root), 'btn btn-primary btn-strong') : null,
      ]),
    ),
  );
}

function keyWarning(): HTMLElement {
  return el('div', { class: 'key-warning', role: 'note' },
    el('p', {}, el('strong', {}, '請妥善保存『還原鑰匙檔』：'), '沒有它就無法還原；有它的人可以看到所有被隱藏的個資，不要和文件一起寄出。'),
  );
}

function noKeyNotice(): HTMLElement {
  return el('div', { class: 'key-warning key-warning-quiet', role: 'note' },
    el('p', {}, el('strong', {}, '這次不會產生還原鑰匙檔。'), '下載後的文件無法還原，請確認標記方式符合你的用途。'),
  );
}

/** The two downloads for the current file, each labelled by what it is. */
function renderDownloadRows(root: HTMLElement, d: DocState): HTMLElement {
  const outName = outputFileName(d.doc.fileName, 'deid');
  const rows: HTMLElement[] = [
    el('div', { class: 'download-row' },
      el('div', { class: 'download-row-text' },
        el('h3', {}, '隱藏個資後的文件'),
        el('p', { class: 'muted small' }, `${outName}・與原檔相同格式`),
      ),
      button('下載文件', () => void downloadDoc(d, root), 'btn btn-primary'),
    ),
  ];
  if (restorable()) {
    rows.push(
      el('div', { class: 'download-row' },
        el('div', { class: 'download-row-text' },
          el('h3', {}, '還原鑰匙檔'),
          el('p', { class: 'muted small' }, `${mappingFileName(d.doc.fileName)}・記錄被隱藏的原始內容，還原時需要它`),
        ),
        button('下載還原鑰匙檔', () => downloadCsv(d, root), 'btn'),
      ),
      el('div', { class: 'download-together' },
        button('一起下載（文件與還原鑰匙檔）', () => void downloadBoth(d, root), 'btn btn-small btn-ghost'),
        isDownloaded(d) ? el('span', { class: 'tag tag-done' }, '已下載') : null,
      ),
    );
  } else if (isDownloaded(d)) {
    rows.push(el('div', { class: 'download-together' }, el('span', { class: 'tag tag-done' }, '已下載')));
  }
  const text = d.doc.format === 'txt' || d.doc.format === 'md';
  if (text) rows.push(el('div', { class: 'download-together' }, button('複製隱藏個資後的文字', () => void copyText(d), 'btn btn-small btn-ghost')));
  return el('div', { class: 'download-rows' }, ...rows);
}

function renderToolbar(root: HTMLElement): HTMLElement {
  const d = current();
  const doc = d.doc;
  const limits = formatLimitations(doc.format, doc.ocr);
  const many = state.docs.length > 1;
  const partialCats = [...new Set(d.items.filter((it) => it.active && isPartial(it)).map((it) => it.category))];
  // The warning belongs to 露出部分 only; under the other modes the output keeps nothing readable by default.
  const showPartial = state.outputMode === 'preview' && partialCats.length > 0;
  return el('div', { class: 'toolbar toolbar-stack' },
    el('div', { class: 'toolbar-row' },
      el('div', { class: 'file-info' },
        el('strong', {}, doc.fileName),
        el('span', { class: 'badge' }, doc.format.toUpperCase()),
        doc.ocr ? el('span', { class: 'badge badge-ocr', 'data-tip': '此檔為掃描影像，文字由瀏覽器內的文字辨識（OCR）取得' }, '文字辨識') : null,
        el('span', { class: 'muted' }, `${doc.text.length.toLocaleString()} 字`),
        many ? el('span', { class: 'muted' }, `第 ${state.active + 1} 個，共 ${state.docs.length} 個檔案`) : null,
      ),
      el('div', { class: 'toolbar-actions' },
        button('重新檢查', () => redetect(root), 'btn btn-small'),
        button(many ? '全部清除' : '換一個檔案', () => resetAll(root), 'btn btn-ghost btn-small'),
      ),
    ),
    el('div', { class: 'toolbar-row status-line muted small' },
      limits ? el('span', { class: 'status-info', 'data-tip': limits, tabindex: '0' }, '這個檔案的限制') : null,
      showPartial
        ? el('span', { class: 'status-partial notice notice-inline', 'data-tip': `露出的字會出現在下載的文件中，並非完全匿名（${partialCats.join('、')}）`, tabindex: '0' },
            '⚠ 部分個資會露出前幾個字方便辨認，例如姓氏',
            button('改成全部隱藏', () => setOutputMode('code', root), 'btn btn-ghost btn-small status-partial-fix'),
          )
        : null,
    ),
  );
}

function renderFilePanel(root: HTMLElement): HTMLElement {
  const panel = el('aside', { class: 'file-panel' });
  const list = el('ul', { class: 'file-list' });
  state.docs.forEach((d, i) => {
    const active = d.items.filter((it) => it.active).length;
    list.append(
      el(
        'li',
        { class: `file-item${i === state.active ? ' active' : ''}` },
        el('button', { type: 'button', class: 'file-item-main', onClick: () => { state.active = i; render(root); } },
          el('span', { class: 'file-item-name', title: d.doc.fileName }, d.doc.fileName),
          el('span', { class: 'file-item-meta' },
            el('span', { class: 'badge' }, d.doc.format.toUpperCase()),
            el('span', { class: 'muted small' }, `${active} 處`),
            isDownloaded(d) ? el('span', { class: 'tag tag-done' }, '已下載') : null,
          ),
        ),
        el('button', { type: 'button', class: 'file-item-remove', 'aria-label': `移除 ${d.doc.fileName}`, title: '移除此檔案', onClick: () => removeDoc(i, root) }, '×'),
      ),
    );
  });
  const input = el('input', { type: 'file', accept: ACCEPT_ATTR, multiple: true, hidden: true }) as HTMLInputElement;
  input.addEventListener('change', () => {
    if (input.files?.length) void loadFiles(Array.from(input.files), root);
    input.value = '';
  });
  panel.append(
    el('div', { class: 'file-panel-head' }, el('h3', {}, `檔案（${state.docs.length}/${MAX_FILES}）`)),
    list,
    state.docs.length < MAX_FILES
      ? button('＋ 加入檔案', () => { state.step = 'files'; render(root); }, 'btn btn-small')
      : el('p', { class: 'muted small' }, `已達 ${MAX_FILES} 個上限`),
    input,
  );
  return panel;
}

/** Fills the review workspace: preview, summary and the detection list, all for the current document. */
function renderWorkspace(ws: HTMLElement, root: HTMLElement, d: DocState, many: boolean): void {
  const preview = el('div', { class: 'preview', tabindex: '0' });
  const sidebar = el('aside', { class: 'sidebar' });
  const outputHost = el('div', {});
  const lowHost = el('div', {});
  const headTools = el('div', { class: 'preview-head-tools' });
  // The output settings sit above the preview card, not inside it, so the two never blend together.
  const previewWrap = el('div', { class: 'preview-wrap' },
    el('div', { class: 'preview-head' }, el('h3', {}, '預覽'), headTools),
    el('p', { class: 'hint-line' }, '點一下標記可取消；用滑鼠圈選文字可新增'),
    previewHint(d.doc) ? el('p', { class: 'muted small preview-desc' }, previewHint(d.doc)) : null,
    lowHost,
    preview,
  );
  const mainColumn = el('div', { class: 'workspace-main' }, outputHost, previewWrap);
  const refresh = () => {
    clear(outputHost);
    outputHost.append(renderOutputPanel(root));
    clear(headTools);
    const plain = el('input', { type: 'checkbox' }) as HTMLInputElement;
    plain.checked = state.plainView;
    plain.addEventListener('change', () => {
      state.plainView = plain.checked;
      refresh();
    });
    if (d.doc.layout) headTools.append(el('label', { class: 'check-label small' }, plain, ' 只看文字（不顯示排版）'));
    headTools.append(
      button(state.showList ? '收起清單' : `查看全部 ${d.items.length} 處`, () => {
        state.showList = !state.showList;
        refresh();
      }, `btn btn-small list-toggle${state.showList ? ' is-open' : ''}`),
    );
    clear(lowHost);
    lowHost.append(renderLowBar(preview, d));
    ws.classList.toggle('workspace-with-list', state.showList);
    ws.classList.toggle('workspace-with-files', many);
    clear(sidebar);
    sidebar.append(renderSummary(d));
    if (state.showList) renderSidebarList(sidebar, preview, refresh);
    renderPreview(preview, refresh, root);
  };
  if (many) ws.append(renderFilePanel(root));
  ws.append(mainColumn, sidebar);
  refresh();
}

/** Plain-language count per category for the current document; the marks themselves stay in the preview. */
function renderSummary(d: DocState): HTMLElement {
  const active = d.items.filter((it) => it.active);
  const cancelled = d.items.length - active.length;
  const rows = CATEGORIES.map((c) => ({
    c,
    n: active.filter((it) => it.category === c).length,
    low: active.filter((it) => it.category === c && it.confidence === 'low').length,
  })).filter((r) => r.n > 0);
  return el('section', { class: 'summary', 'aria-label': '找到的個資' },
    el('h3', {}, '這份文件找到的個資'),
    el('p', { class: 'summary-total' }, active.length === 0 ? '目前沒有要隱藏的內容。' : `共 ${active.length} 處會被隱藏`),
    rows.length
      ? el('ul', { class: 'summary-list' }, ...rows.map((r) => el('li', {},
          el('span', { class: `badge badge-${r.c}` }, r.c),
          el('span', { class: 'summary-count' }, `${r.n} 處`),
          r.low ? el('span', { class: 'tag tag-low', title: '這些不太確定是不是人名，請在預覽中確認' }, `其中 ${r.low} 處不確定`) : null,
        )))
      : null,
    cancelled > 0 ? el('p', { class: 'muted small' }, `已取消 ${cancelled} 處，這些內容會保留原文。`) : null,
    active.length === 0 ? el('p', { class: 'muted small' }, '你仍可以在預覽中圈選文字，手動新增要隱藏的內容。') : null,
  );
}

/** One option of a choice row: a real button whose plain example sits under its title. */
interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  detail?: string;
  example: string;
  mono?: boolean;
}

/** One labelled row of choice buttons; aria-pressed marks the current one, and each button is a single tab stop. */
function choiceRow<T extends string>(id: string, label: string, options: ChoiceOption<T>[], current: T, onChange: (v: T) => void): HTMLElement {
  return el('div', { class: 'output-row', 'data-row': id },
    el('div', { class: 'output-row-label', id: `${id}-label` }, label),
    el('div', { class: 'choice-grid', role: 'group', 'aria-labelledby': `${id}-label` },
      ...options.map((o) => el('button', {
        type: 'button',
        class: 'choice',
        'data-group': id,
        'data-value': o.value,
        'aria-pressed': o.value === current ? 'true' : 'false',
        onClick: () => onChange(o.value),
      },
        el('span', { class: 'choice-title' }, o.title),
        o.detail ? el('span', { class: 'choice-detail' }, o.detail) : null,
        el('span', { class: `choice-example${o.mono ? ' mono' : ''}` }, o.example),
      )),
    ),
  );
}

/** Changes how much stays visible: the preview and the summary follow at once, and the choice is remembered. */
function setOutputMode(mode: OutputMode, root: HTMLElement): void {
  state.outputMode = mode;
  persistOutputPrefs();
  applyOutputModeToAll();
  render(root); // preview, toolbar status and partial-retention notice all change
}

/** One example line for the current choice, using the same example logic as before (a national ID number). */
function liveExample(): string {
  if (state.outputMode === 'custom') return '身分證等各類別分開設定（展開下方「進階設定」查看）';
  return `身分證 ${modeExample(state.outputMode, state.marker)}`;
}

const OUTPUT_BODY_ID = 'output-settings-body';
const SLIDERS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 12 15 18 9"/></svg>';

/** A small trusted inline SVG (static markup from this file only) inside a span. */
function iconSpan(cls: string, markup: string): HTMLElement {
  const span = el('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = markup;
  return span;
}

/**
 * The single place to decide what the output shows: how much stays visible and the marker style. It is a
 * disclosure: the header is one button (chevron on the right) that folds the choices away to one line.
 * Both choices sit in the body when open; per-category settings, 設為預設 and the shared key scope sit under 進階設定.
 * It lives outside the preview card, directly above it.
 */
function renderOutputPanel(root: HTMLElement): HTMLElement {
  // The output text changes, codes do not: every document needs downloading again.
  const setMarker = (marker: MarkerStyle) => {
    state.marker = marker;
    persistOutputPrefs();
    for (const d of state.docs) markDirty(d);
    render(root);
  };
  const notices = [
    state.outputMode === 'preview' ? '露出部分會留下姓氏、證號前 2 碼、手機前 4 碼等，並非完全匿名' : '',
    restorable() ? '' : `不產生還原鑰匙檔，之後無法還原${state.marker === 'blank' ? '；空白佔位會保留原本的字數，需要更高的匿名性請選「類別標記」' : ''}`,
  ].filter(Boolean);
  const section = (cls: string, title: string, open: boolean, onToggle: (open: boolean) => void, ...body: (HTMLElement | null)[]) => {
    const d = el('details', { class: `output-section ${cls}`, open }, el('summary', {}, title), ...body.filter((b): b is HTMLElement => b !== null)) as HTMLDetailsElement;
    d.addEventListener('toggle', () => onToggle(d.open));
    return d;
  };
  const present = CATEGORIES.filter((c) => state.docs.some((d) => d.items.some((it) => it.category === c))).length;
  const saveDefault = () => {
    let config = loadConfig();
    for (const [category, r] of state.overrides) config = setCategoryRetention(config, category, r);
    saveConfig(config);
    // The saved default is now each item's own rule retention, so the output stays the same after clearing overrides.
    for (const d of state.docs) {
      for (const it of d.items) {
        const r = state.overrides.get(it.category);
        if (!r) continue;
        if (r.mode === 'none') delete it.retention;
        else it.retention = r;
      }
    }
    state.overrides.clear();
    persistOutputPrefs();
    toast('已設為預設：之後選「自訂」會套用這些保留方式（可在「進階設定」頁各規則的「查看規則」中看到）', 'success', 5000);
    render(root);
  };
  const keepOptions: ChoiceOption<OutputMode>[] = (Object.keys(OUTPUT_MODE_LABELS) as OutputMode[]).map((value) => ({
    value,
    title: OUTPUT_MODE_LABELS[value],
    example: keepExample(value),
    mono: value !== 'custom' && state.marker !== 'blank',
  }));
  const markerOptions: ChoiceOption<MarkerStyle>[] = (Object.keys(MARKER_LABELS) as MarkerStyle[]).map((value) => ({
    value,
    title: MARKER_LABELS[value],
    detail: MARKER_NOTES[value].detail,
    example: MARKER_NOTES[value].example,
    mono: value !== 'blank',
  }));
  const highlightBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  highlightBox.checked = state.highlight;
  highlightBox.addEventListener('change', () => {
    state.highlight = highlightBox.checked;
    persistOutputPrefs();
    for (const d of state.docs) markDirty(d); // the file itself changes, so every document needs downloading again
    render(root);
  });
  const advanced = el('details', { class: 'output-advanced', open: state.advancedOpen || state.outputMode === 'custom' },
    el('summary', {}, '進階設定（依類別調整、多個檔案共用還原鑰匙）'),
    el('label', { class: 'output-highlight' }, highlightBox, el('span', {}, '在輸出檔中用淺灰底標出被隱藏的地方（Word、Excel、PDF）')),
    section('by-category', `依類別調整（${present} 類）`, state.outputMode === 'custom' || state.categoriesOpen, (open) => (state.categoriesOpen = open),
      renderCategoryTable(root),
      state.outputMode === 'custom'
        ? el('div', { class: 'form-actions' },
            button('設為預設', saveDefault, 'btn btn-small'),
            el('span', { class: 'muted small' }, state.overrides.size ? '把目前各類別的設定存為各規則的預設（進階設定與手動新增的內容也會沿用），之後選「自訂」會自動套用。' : '目前沿用預設值。'),
          )
        : null,
    ),
    restorable() ? el('div', { class: 'output-subsection' }, el('h4', {}, '多個檔案共用還原鑰匙'), renderCodeScope(root)) : null,
  ) as HTMLDetailsElement;
  advanced.addEventListener('toggle', () => (state.advancedOpen = advanced.open));
  const folded = el('span', { class: 'os-folded-text' },
    el('span', { class: 'os-label' }, '輸出方式：'),
    el('strong', {}, `${OUTPUT_MODE_LABELS[state.outputMode]}・${MARKER_LABELS[state.marker]}`),
    restorable() ? null : el('span', { class: 'os-restore muted small' }, '（之後無法還原）'),
  );
  const expandedTitle = el('span', { class: 'os-open-text' },
    el('span', { class: 'os-title' }, '輸出方式（可隨時切換）'),
    el('span', { class: 'os-note muted small' }, '會記住你這次的選擇，下次自動套用'),
  );
  const toggleLabel = el('span', { class: 'os-toggle-label' }, state.panelOpen ? '收合' : '展開設定');
  folded.hidden = state.panelOpen;
  expandedTitle.hidden = !state.panelOpen;
  const head = el('button', {
    class: 'output-settings-head',
    type: 'button',
    'aria-expanded': String(state.panelOpen),
    'aria-controls': OUTPUT_BODY_ID,
  },
    iconSpan('os-icon', SLIDERS_ICON),
    el('span', { class: 'os-text' }, folded, expandedTitle),
    el('span', { class: 'os-toggle' }, toggleLabel, iconSpan('os-chevron', CHEVRON_ICON)),
  ) as HTMLButtonElement;
  const body = el('div', { class: 'output-settings-body', id: OUTPUT_BODY_ID }, state.prefsAccepted
    ? null
    : el('p', { class: 'output-intro' }, '第一次使用：請選擇輸出方式，選好後按右上角 ▲ 收合。之後每份文件都會自動沿用。'),
    choiceRow('output-mode', '要露出多少', keepOptions, state.outputMode, (mode) => setOutputMode(mode, root)),
    choiceRow('marker-style', '標記方式', markerOptions, state.marker, setMarker),
    el('p', { class: 'output-live' },
      el('span', { class: 'muted small' }, '範例　'),
      el('span', { class: `small ${exampleClass('')}` }, liveExample()),
    ),
    notices.length ? el('p', { class: 'small notice notice-inline output-notice' }, `⚠ ${notices.join('；')}`) : null,
    advanced,
  );
  body.hidden = !state.panelOpen;
  const panel = el('section', { class: `output-settings${state.panelOpen ? ' is-open' : ''}`, 'aria-label': '輸出方式' }, head, body);
  // Opening or folding happens in place, so the chevron can rotate. Folding saves the current choice, so the next visit starts folded.
  const setOpen = (open: boolean) => {
    state.panelOpen = open;
    if (!open) persistOutputPrefs();
    panel.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    folded.hidden = open;
    expandedTitle.hidden = !open;
    toggleLabel.textContent = open ? '收合' : '展開設定';
  };
  head.addEventListener('click', () => setOpen(!state.panelOpen));
  return panel;
}

function renderCategoryTable(root: HTMLElement): HTMLElement {
  const present = CATEGORIES.filter((c) => state.docs.some((d) => d.items.some((it) => it.category === c)));
  if (present.length === 0) return el('p', { class: 'muted small' }, '目前沒有找到個資。');
  const custom = state.outputMode === 'custom';
  const rows = present.map((category) => {
    const items = state.docs.flatMap((d) => d.items).filter((it) => it.category === category);
    const sample = items[0].original;
    const off = state.disabledCategories.has(category);
    const enabled = el('input', { type: 'checkbox', title: '取消勾選即整類不隱藏（套用到所有檔案）' }) as HTMLInputElement;
    enabled.checked = !off;
    enabled.addEventListener('change', () => {
      setCategoryEnabled(category, enabled.checked);
      render(root);
    });
    const override = state.overrides.get(category);
    const applied: Retention | undefined = state.outputMode === 'code' ? undefined : state.outputMode === 'preview' ? { mode: 'preview' } : override ?? ruleRetention(category);
    const out = el('span', { class: exampleClass('small') });
    const msg = el('span', { class: 'small' });
    const show = (r: Retention | undefined) => {
      const s = splitFor(sample, r, category);
      const hidden = sample.slice(s.head, sample.length - s.tail);
      out.textContent = `${sample} → ${sample.slice(0, s.head)}${state.marker === 'blank' ? blankOut(hidden) : `[${category}]`}${sample.slice(sample.length - s.tail)}`;
    };
    show(applied);
    let control: HTMLElement;
    if (!custom || off) {
      control = el('span', { class: 'muted small' }, off ? '不隱藏' : describeRetention(applied));
    } else {
      const current: Retention = override ?? ruleRetention(category) ?? { mode: 'none' };
      const mode = el('select', { class: 'select', 'aria-label': `${category} 的露出方式` },
        el('option', { value: 'rule' }, `預設（${describeRetention(ruleRetention(category))}）`),
        ...modesFor(category).map((m) => el('option', { value: m }, MODE_LABELS[m])),
      ) as HTMLSelectElement;
      mode.value = override ? override.mode : 'rule';
      const head = el('input', { class: 'input input-num', type: 'number', min: '0', value: String(current.mode === 'ends' ? current.head : 0), 'aria-label': '前面露出幾碼' }) as HTMLInputElement;
      const tail = el('input', { class: 'input input-num', type: 'number', min: '0', value: String(current.mode === 'ends' ? current.tail : 0), 'aria-label': '後面露出幾碼' }) as HTMLInputElement;
      const delim = el('input', { class: 'input input-num', value: current.mode === 'delim' ? current.delimiter : '@', 'aria-label': '分隔字元' }) as HTMLInputElement;
      const side = el('select', { class: 'select', 'aria-label': '露出分隔字元之前或之後' }, el('option', { value: 'after' }, '之後'), el('option', { value: 'before' }, '之前')) as HTMLSelectElement;
      if (current.mode === 'delim') side.value = current.side;
      const endsBox = el('span', { class: 'retention-fields', hidden: mode.value !== 'ends' }, '前 ', head, ' 碼，後 ', tail, ' 碼');
      const delimBox = el('span', { class: 'retention-fields', hidden: mode.value !== 'delim' }, delim, side);
      const read = (): Retention | null => {
        const m = mode.value as RetentionMode | 'rule';
        if (m === 'rule') return null;
        if (m === 'ends') return { mode: 'ends', head: Number(head.value), tail: Number(tail.value) };
        if (m === 'delim') return { mode: 'delim', delimiter: delim.value, side: side.value as 'before' | 'after' };
        return { mode: m } as Retention;
      };
      const paint = (r: Retention | null): boolean => {
        const check = r ? checkRetention(sample, r, category) : { error: null, warnings: [] };
        msg.className = `small ${check.error ? 'field-error' : check.warnings.length ? 'notice notice-inline' : ''}`;
        msg.textContent = check.error ?? (check.warnings.length ? `⚠ ${check.warnings.join(' ')}` : '');
        show(r ?? ruleRetention(category));
        return !check.error;
      };
      const apply = () => {
        endsBox.hidden = mode.value !== 'ends';
        delimBox.hidden = mode.value !== 'delim';
        const r = read();
        if (!paint(r)) return; // keep the invalid input on screen with its error, output unchanged
        if (r) state.overrides.set(category, r);
        else state.overrides.delete(category);
        persistOutputPrefs();
        applyOutputModeToAll();
        render(root);
      };
      for (const input of [mode, head, tail, delim, side]) input.addEventListener('change', apply);
      paint(override ?? null);
      control = el('span', { class: 'retention-control' }, mode, endsBox, delimBox);
    }
    return el('tr', { class: off ? 'row-disabled' : '' },
      el('td', { class: 'col-nowrap' }, el('label', { class: 'check-label' }, enabled, el('span', { class: `badge badge-${category}` }, category), el('span', { class: 'muted small' }, ` ${items.length} 處`))),
      el('td', {}, control),
      el('td', {}, out, ' ', msg),
    );
  });
  return el('div', { class: 'table-wrap' }, el('table', { class: 'table output-table' }, el('tbody', {}, ...rows)));
}

function previewHint(doc: LoadedDocument): string {
  if (doc.layout?.kind === 'xlsx') return '上方可切換工作表。';
  if (doc.layout?.kind === 'pdf' && doc.ocr) return '綠框圖片會保留在輸出中（可逐張取消），請對照原檔核對。';
  return '';
}

/** Tooltip wording for a name the detector was unsure about (confidence 'low'). */
const LOW_TIP = '不太確定是不是人名，請確認';

/**
 * The legend for the two mark styles, the count of unsure items, and a button that jumps to the next one
 * (in text order, wrapping around). The jump position is remembered per document.
 */
let lowJump: { doc: number; start: number } | null = null;
function renderLowBar(preview: HTMLElement, d: DocState): HTMLElement {
  const legend = el('div', { class: 'mark-legend' },
    el('span', { class: 'legend-item' }, el('span', { class: 'mark mark-姓名 legend-sample' }, '王小明'), ' 一般標記（有把握）'),
    el('span', { class: 'legend-item' }, el('span', { class: 'mark mark-姓名 mark-low legend-sample' }, '王小明'), ' 不確定，請確認是否為人名'),
  );
  const lows = d.items.filter((it) => it.active && it.confidence === 'low').sort((a, b) => a.start - b.start);
  if (lows.length === 0) return el('div', { class: 'low-bar' }, legend, el('span', { class: 'muted small' }, '沒有不確定的項目'));
  const jump = button('跳到下一筆不確定', () => {
    const next = lows.find((it) => lowJump?.doc === state.active && it.start > lowJump.start) ?? lows[0];
    lowJump = { doc: state.active, start: next.start };
    locate(preview, next.id);
  }, 'btn btn-small low-jump');
  return el('div', { class: 'low-bar' }, legend, el('span', { class: 'low-count' }, `有 ${lows.length} 處不確定，建議優先檢查`), jump);
}

function renderPreview(preview: HTMLElement, refresh: () => void, root: HTMLElement): void {
  const d = current();
  // No tip text: each mark opens its own card (ui/mark-card.ts), which describes the item.
  const decorations: Decoration[] = d.items.map((it) => {
    const low = it.confidence === 'low';
    return it.active
      ? { start: it.start, end: it.end, id: it.id, kind: 'mark', label: previewLabel(it, state.marker), className: `mark-${it.category}${low ? ' mark-low' : ''}`, tip: '' }
      : { start: it.start, end: it.end, id: it.id, kind: 'cancelled', label: '', className: '', tip: '' };
  });
  renderDocumentPreview(preview, d.doc, decorations, {
    plain: state.plainView,
    onTogglePicture: (pic) => {
      pic.keep = !pic.keep;
      markDirty(d);
      refresh();
    },
  });
  preview.onmouseup = () => handleSelection(preview, refresh, root);
  // Marks are reachable by Tab, so the card can open from the keyboard too.
  preview.querySelectorAll<HTMLElement>('[data-id]').forEach((n) => n.setAttribute('tabindex', '0'));
  installMarkCards(preview, {
    itemFor: (id) => current().items.find((it) => it.id === id),
    describe: (it) => [
      it.active ? `隱藏後顯示：${outputFor(it, state.marker)}${it.origin === 'manual' ? '（手動新增）' : ''}` : '已取消隱藏，顯示原文；點擊標記可重新隱藏',
      it.active && it.confidence === 'low' ? LOW_TIP : '',
    ],
    keepWord: (it) => keepWordFromCard(it, root),
    hideWord: (it) => hideWordFromCard(it, root),
    openPopup: (rect, it) => showItemPopup(rect, it, refresh, root),
  });
}

function showItemPopup(rect: DOMRect, item: RedactionItem, done: () => void, root: HTMLElement): void {
  document.querySelector('.add-popup')?.remove();
  const d = current();
  const popup = el(
    'div',
    { class: 'add-popup' },
    el('div', { class: 'add-popup-text' },
      el('span', { class: `badge badge-${item.category}` }, item.category),
      ` ${item.original} → ${previewLabel(item, state.marker)}`,
      el('div', { class: 'muted small' }, `隱藏後顯示 ${outputFor(item, state.marker)}${item.origin === 'manual' ? '（手動新增）' : ''}`),
    ),
    el('div', { class: 'add-popup-row' },
      el('span', {}, item.active ? '要取消這一處的隱藏嗎？' : '要把這一處重新隱藏嗎？'),
      button(item.active ? '取消隱藏' : '重新隱藏', () => {
        try {
          toggleItem(d.items, item.id);
          markDirty(d);
          popup.remove();
          done();
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      }, item.active ? 'btn btn-danger-solid' : 'btn btn-primary'),
      // Cancelling is often a judgement about the word itself: offer to keep it for every future detection.
      item.active && wordProblem(item.original) === null
        ? button(`以後都不要隱藏『${item.original}』`, () => keepWord(d, item, popup, root), 'btn btn-small')
        : null,
      button('關閉', () => popup.remove(), 'btn btn-ghost'),
    ),
  );
  placePopup(popup, rect, root);
}

/** Cancels one item and adds its text to the whitelist, so it is not detected (or hidden) again. */
function keepWord(d: DocState, item: RedactionItem, popup: HTMLElement, root: HTMLElement): void {
  try {
    toggleItem(d.items, item.id);
  } catch (err) {
    toast((err as Error).message, 'error');
    return;
  }
  const stored = setWordLists(addWhitelistWord(getWordLists(), item.original));
  rescanAll();
  popup.remove();
  toast(`已加入白名單：「${item.original}」之後不會被隱藏${stored ? '' : '（此瀏覽器無法保存，關閉分頁後會失效）'}`, stored ? 'success' : 'info', 6000);
  render(root);
}

/** Adds a selected text as an item now and to the blacklist, so every later occurrence is hidden too. */
function hideWordEverywhere(d: DocState, start: number, end: number, category: Category, word: string, popup: HTMLElement, root: HTMLElement): void {
  try {
    const rule = getEffectivePatterns().find((p) => p.enabled && p.category === category);
    addManualItem(d.items, d.doc.text, start, end, category, d.book, rule?.retention);
  } catch (e) {
    toast((e as Error).message, 'error');
    return;
  }
  const stored = setWordLists(addBlacklistWord(getWordLists(), word, category));
  applyOutputMode(d);
  markDirty(d);
  rescanAll();
  popup.remove();
  toast(`已加入黑名單：之後「${word}」每次出現都會以「${category}」隱藏${stored ? '' : '（此瀏覽器無法保存，關閉分頁後會失效）'}`, stored ? 'success' : 'info', 6000);
  render(root);
}

/** The card's 這不是個資: cancels the item (when shown) and keeps its word on the whitelist, then re-detects. */
function keepWordFromCard(item: RedactionItem, root: HTMLElement): void {
  try {
    if (item.active) toggleItem(current().items, item.id);
  } catch (err) {
    toast((err as Error).message, 'error');
    return;
  }
  const stored = setWordLists(addWhitelistWord(getWordLists(), item.original));
  rescanAll();
  toast(`已加入『不要隱藏的詞』（白名單）${stored ? '' : '（此瀏覽器無法保存，關閉分頁後會失效）'}`, stored ? 'success' : 'info', 6000);
  renderAfterCardAction(root);
}

/**
 * The card's 這是個資: the word is hidden with the item's category wherever it occurs. Every occurrence counts,
 * so ones cancelled earlier are shown hidden again (categories switched off in the table stay off).
 */
function hideWordFromCard(item: RedactionItem, root: HTMLElement): void {
  const word = item.original.trim();
  const stored = setWordLists(addBlacklistWord(getWordLists(), word, item.category));
  rescanAll();
  for (const d of state.docs) {
    for (const it of d.items) {
      if (it.active || it.original.trim() !== word || state.disabledCategories.has(it.category)) continue;
      try {
        toggleItem(d.items, it.id);
      } catch {
        // it now overlaps an active item: leave it cancelled
      }
    }
    markDirty(d);
  }
  toast(`已加入『一定要隱藏的詞』（黑名單）${stored ? '' : '（此瀏覽器無法保存，關閉分頁後會失效）'}`, stored ? 'success' : 'info', 6000);
  renderAfterCardAction(root);
}

/** The preview is rebuilt, so focus goes to it (not to a mark, which would open its card again). */
function renderAfterCardAction(root: HTMLElement): void {
  render(root);
  root.querySelector<HTMLElement>('.preview')?.focus({ preventScroll: true });
}

function placePopup(popup: HTMLElement, rect: DOMRect, root: HTMLElement): void {
  const top = rect.bottom + window.scrollY + 6;
  const left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 380));
  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
  root.ownerDocument.body.append(popup);
}

function offsetOf(container: Node, offset: number): number | null {
  const elNode = container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element);
  const holder = elNode?.closest('[data-start]') as HTMLElement | null;
  if (!holder) return null;
  const base = Number(holder.dataset.start);
  if (holder.dataset.plain) {
    return container.nodeType === Node.TEXT_NODE ? base + offset : base;
  }
  // Inside a mark/cancelled span: snap to its boundary.
  return offset === 0 ? base : Number(holder.dataset.end);
}

function handleSelection(preview: HTMLElement, refresh: () => void, root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!preview.contains(range.startContainer) || !preview.contains(range.endContainer)) return;
  const a = offsetOf(range.startContainer, range.startOffset);
  const b = offsetOf(range.endContainer, range.endOffset);
  if (a === null || b === null) return;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (end <= start) return;
  showAddPopup(range.getBoundingClientRect(), start, end, () => {
    sel.removeAllRanges();
    refresh();
  }, root);
}

function showAddPopup(rect: DOMRect, start: number, end: number, done: () => void, root: HTMLElement): void {
  document.querySelector('.add-popup')?.remove();
  const d = current();
  const text = d.doc.text.slice(start, end);
  const select = el('select', { class: 'select', 'aria-label': '類別' }, ...CATEGORIES.map((c) => el('option', { value: c }, c))) as HTMLSelectElement;
  const popup = el(
    'div',
    { class: 'add-popup' },
    el('div', { class: 'add-popup-text' }, `「${text.length > 40 ? text.slice(0, 40) + '…' : text}」`),
    el('div', { class: 'add-popup-row' }, select, button('隱藏這段文字', () => {
      try {
        // FR-009: manual items follow their category's retention, like detected ones.
        const rule = getEffectivePatterns().find((p) => p.enabled && p.category === select.value);
        addManualItem(d.items, d.doc.text, start, end, select.value as Category, d.book, rule?.retention);
        applyOutputMode(d);
        markDirty(d);
        popup.remove();
        toast('已新增', 'success', 1500);
        done();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    }, 'btn btn-primary'),
    wordProblem(text) === null && text.trim()
      ? button(`以後都要隱藏『${text.trim()}』`, () => hideWordEverywhere(d, start, end, select.value as Category, text.trim(), popup, root), 'btn btn-small')
      : null,
    button('取消', () => popup.remove(), 'btn btn-ghost')),
  );
  placePopup(popup, rect, root);
}

/** The full list of detections for the current document, shown under the summary when opened. */
function renderSidebarList(sidebar: HTMLElement, preview: HTMLElement, refresh: () => void): void {
  const d = current();
  const list = el('ul', { class: 'item-list' });
  const sorted = [...d.items].sort((a, b) => a.start - b.start);
  for (const it of sorted) {
    const li = el(
      'li',
      { class: `item ${it.active ? '' : 'item-cancelled'}` },
      el('div', { class: 'item-main', title: tooltipFor(it), onClick: () => locate(preview, it.id) },
        el('span', { class: `badge badge-${it.category}` }, it.category),
        it.active && it.confidence === 'low' ? el('span', { class: 'tag tag-low', title: LOW_TIP }, '不確定') : null,
        el('span', { class: 'item-original' }, it.original),
        el('span', { class: 'item-mask muted' }, `→ ${previewLabel(it, state.marker)}`),
        it.origin === 'manual' ? el('span', { class: 'tag' }, '手動') : null,
      ),
      el('div', { class: 'item-meta' }, button(it.active ? '取消隱藏' : '重新隱藏', () => {
        try {
          toggleItem(d.items, it.id);
          markDirty(d);
          refresh();
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }, 'btn btn-small')),
    );
    list.append(li);
  }
  sidebar.append(
    el('h3', { class: 'list-head' }, `全部 ${d.items.length} 處（其中 ${d.items.filter((it) => it.active).length} 處會被隱藏）`),
    d.items.length === 0 ? el('p', { class: 'muted' }, '目前沒有項目。可在預覽中圈選文字新增。') : list,
  );
}

function locate(preview: HTMLElement, id: string): void {
  const node = preview.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1200);
}

// ---------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------
/** FR-002: a lone download whose partner was taken from an older version would not restore. */
function warnIfStale(partnerVer: number, d: DocState, partner: string): void {
  if (partnerVer >= 0 && partnerVer !== d.version) {
    toast(`之前下載的${partner}是舊版本，和這次的檔案對不起來，請重新下載${partner}`, 'error', 8000);
  }
}

async function saveDoc(d: DocState): Promise<void> {
  const { edits } = applyRedactions(d.doc.text, d.items, state.marker);
  const blob = await generateDocument(d.doc, edits, { highlight: state.highlight });
  downloadBlob(blob, outputFileName(d.doc.fileName, 'deid'));
  d.docVer = d.version;
}

function saveCsv(d: DocState): void {
  const { mapping } = applyRedactions(d.doc.text, d.items);
  downloadBlob(new Blob([serializeMapping(mapping)], { type: 'text/csv;charset=utf-8' }), mappingFileName(d.doc.fileName));
  d.csvVer = d.version;
}

/** The document and its key file together, so the pair always matches. */
async function downloadBoth(d: DocState, root: HTMLElement): Promise<void> {
  try {
    toast('產生檔案中…', 'info', 2000);
    await saveDoc(d);
    if (restorable()) saveCsv(d);
    toast(restorable() ? '已下載文件與還原鑰匙檔' : '已下載隱藏個資後的文件', 'success');
    render(root);
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

async function downloadDoc(d: DocState, root: HTMLElement): Promise<void> {
  try {
    toast('產生檔案中…', 'info', 2000);
    await saveDoc(d);
    warnIfStale(d.csvVer, d, '還原鑰匙檔');
    render(root);
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

function downloadCsv(d: DocState, root: HTMLElement): void {
  saveCsv(d);
  warnIfStale(d.docVer, d, '文件');
  render(root);
}

function downloadMerged(): void {
  downloadBlob(new Blob([serializeMapping(mergedMapping())], { type: 'text/csv;charset=utf-8' }), MERGED_MAPPING_NAME);
  toast('合併的還原鑰匙檔涵蓋匯入的資料與本批所有編號，下次處理時可再匯入沿用；請妥善保管', 'success', 5000);
}

async function copyText(d: DocState): Promise<void> {
  const { redactedText } = applyRedactions(d.doc.text, d.items, state.marker);
  try {
    await navigator.clipboard.writeText(redactedText);
    toast(restorable() ? '已複製隱藏個資後的文字（還原鑰匙檔仍需另外下載才能還原）' : '已複製隱藏個資後的文字', 'success', 4000);
  } catch {
    toast('無法存取剪貼簿，請改用下載', 'error');
  }
}

/** Every document plus its key file in one archive (see formats/batch.ts). */
async function downloadAll(root: HTMLElement): Promise<void> {
  try {
    toast(`打包 ${state.docs.length} 個檔案中…`, 'info', 3000);
    const { blob } = await buildArchive(state.docs.map((d) => ({ doc: d.doc, items: d.items })), hasMergedTable() ? mergedMapping() : undefined, state.marker, { highlight: state.highlight });
    for (const d of state.docs) {
      d.docVer = d.version;
      d.csvVer = d.version;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    downloadBlob(blob, `隱藏個資-${stamp}.zip`);
    toast(restorable() ? '已打包下載全部文件與還原鑰匙檔' : '已打包下載全部隱藏個資後的文件', 'success');
    render(root);
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}
