/**
 * The card behind a mark in the preview. It replaces the old one-line tooltip (which could not hold buttons):
 * it opens on hover, on keyboard focus, or on the first tap of a touch device; it stays open while the pointer
 * is over it; and it offers the two word-list actions (不要隱藏的詞／一定要隱藏的詞).
 *
 * The card lives on <body> (like the other popups), so it is not clipped by the preview's scroll box. The
 * page-level behaviour (what the actions do, re-detecting) comes in through `MarkCardHandlers`, which keeps this
 * module free of the page state in process-view.ts.
 */
import type { RedactionItem } from '../core/types';
import { getWordLists, wordProblem } from '../core/word-lists';
import { el } from './components';

export interface MarkCardHandlers {
  /** The item behind a marked element (its data-id), or undefined. */
  itemFor(id: string): RedactionItem | undefined;
  /** Plain lines describing the item (the hidden output, a low-confidence note). */
  describe(item: RedactionItem): string[];
  /** 這不是個資：never hide this word again. */
  keepWord(item: RedactionItem): void;
  /** 這是個資：always hide this word, with the item's category. */
  hideWord(item: RedactionItem): void;
  /** A click on a mark (not a tap that only opens the card): the existing cancel/re-hide popup. */
  openPopup(rect: DOMRect, item: RedactionItem): void;
}

/** How long the card stays after the pointer or focus leaves, so the pointer can move into it. */
const HIDE_DELAY_MS = 300;
const GAP_PX = 6;

interface OpenCard {
  card: HTMLElement;
  anchor: HTMLElement;
  id: string;
}

let open: OpenCard | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let handlers: MarkCardHandlers | null = null;
/** Set while the card hands focus back to its mark, so that focusing the mark does not reopen the card. */
let suppressFocusOpen = false;
let lastPointerType = 'mouse';
let touchOpenAtDown = false;
let globalsReady = false;

const cancelHide = () => {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = null;
};
const scheduleHide = () => {
  cancelHide();
  hideTimer = setTimeout(() => closeMarkCard(), HIDE_DELAY_MS);
};

/** Removes the card (if any). Called by the page when it re-renders or the user leaves the page. */
export function closeMarkCard(): void {
  cancelHide();
  open?.card.remove();
  open = null;
}

/** Closes the card and returns focus to its mark, without the card reopening. */
function dismiss(): void {
  const anchor = open?.anchor ?? null;
  closeMarkCard();
  if (anchor) {
    suppressFocusOpen = true;
    anchor.focus();
    suppressFocusOpen = false;
  }
}

const focusables = (card: HTMLElement): HTMLElement[] => [...card.querySelectorAll<HTMLElement>('button:not([disabled])')];

/** Puts the card under its mark, or above it when there is no room below, and keeps it inside the viewport. */
function place(card: HTMLElement, rect: DOMRect): void {
  const h = card.offsetHeight;
  const w = card.offsetWidth;
  let top = rect.bottom + GAP_PX;
  if (top + h > window.innerHeight && rect.top - h - GAP_PX > 0) top = rect.top - h - GAP_PX;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An inline SVG icon (no external assets). The path data is drawn with currentColor strokes. */
function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'mark-card-icon');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const ICON_KEEP = [
  'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', // a circle: "this is fine, keep it"
  'M8 12.5l2.7 2.7L16 9.5', // a check mark
];
const ICON_HIDE = [
  'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z', // an eye: visible text
  'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  'M4 4l16 16', // with a slash: hide it
];

/** One list action as a large two-line button: a bold main label and a secondary line naming the word. */
function actionButton(kind: 'keep' | 'hide', word: string, onClick: () => void): HTMLElement {
  const keep = kind === 'keep';
  const main = keep ? '不是個資 → 以後都不要隱藏' : '是個資 → 以後都要隱藏';
  const sub = keep ? '會加入白名單，保留原文' : '會加入黑名單，每次都隱藏';
  return el('button', {
    type: 'button',
    class: `mark-card-action mark-card-action-${kind}`,
    'data-action': kind,
    onClick: () => onClick(),
  },
    el('span', { class: 'mark-card-action-main' }, icon(keep ? ICON_KEEP : ICON_HIDE), el('span', { class: 'mark-card-action-label' }, main)),
    el('span', { class: 'mark-card-action-sub' },
      el('span', { class: 'mark-card-word', title: word },
        '『', el('span', { class: 'mark-card-word-text' }, word), '』'),
      el('span', { class: 'mark-card-action-rest' }, sub),
    ),
  );
}

/** The state when the word is already on that list: a muted, confirmed chip (not a button). */
function listState(stateText: string): HTMLElement {
  return el('span', { class: 'mark-card-state' }, `✓ ${stateText}`);
}

function buildCard(item: RedactionItem): HTMLElement {
  const h = handlers!;
  const word = item.original.trim();
  const lists = getWordLists();
  const inWhite = lists.whitelist.includes(word);
  const inBlack = lists.blacklist.some((b) => b.word === word);
  const problem = wordProblem(word);

  const card = el('div', { class: 'mark-card', role: 'group', 'aria-label': `${item.category}：${item.original}` },
    el('div', { class: 'mark-card-head' },
      el('span', { class: `badge badge-${item.category}` }, item.category),
      el('span', { class: 'mark-card-original' }, `原文：${item.original}`),
    ),
    ...h.describe(item).filter(Boolean).map((line) => el('p', { class: 'muted small mark-card-line' }, line)),
    problem
      ? el('p', { class: 'field-error small' }, `這段文字無法加入詞表：${problem}`)
      : el('div', { class: 'mark-card-actions' },
          inWhite ? listState('已在不要隱藏的詞') : actionButton('keep', word, () => h.keepWord(item)),
          inBlack ? listState('已在一定要隱藏的詞') : actionButton('hide', word, () => h.hideWord(item)),
        ),
    el('p', { class: 'muted small mark-card-note' },
      '白名單＝永遠不隱藏的詞；黑名單＝永遠要隱藏的詞。可在『',
      el('button', { class: 'link-btn mark-card-link', type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('deid:open-settings')) }, '進階設定'),
      '』查看或刪除。',
    ),
  );
  card.addEventListener('mouseenter', cancelHide);
  card.addEventListener('mouseleave', scheduleHide);
  card.addEventListener('focusout', (e) => {
    const next = e.relatedTarget as Node | null;
    if (!next || (!card.contains(next) && next !== open?.anchor)) scheduleHide();
  });
  card.addEventListener('keydown', (e) => {
    const items = focusables(card);
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    } else if (e.key === 'Tab' && items.length > 0) {
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (e.target === edge) {
        e.preventDefault();
        dismiss();
      }
    }
  });
  return card;
}

/** Shows the card for a mark. With `focusCard`, focus moves to its first button (keyboard: Enter on a mark). */
function showFor(mark: HTMLElement, focusCard = false): void {
  if (suppressFocusOpen && !focusCard) return;
  cancelHide();
  const id = mark.dataset.id;
  if (!id || !handlers) return;
  if (open && open.id === id) {
    open.anchor = mark; // another piece of the same item (a mark crossing lines)
  } else {
    const item = handlers.itemFor(id);
    if (!item) return;
    closeMarkCard();
    const card = buildCard(item);
    document.body.append(card);
    open = { card, anchor: mark, id };
  }
  place(open.card, mark.getBoundingClientRect());
  if (focusCard) focusables(open.card)[0]?.focus();
}

/** The card follows its mark when the page or the preview scrolls; it closes once the mark has left the screen. */
function follow(): void {
  if (!open) return;
  const r = open.anchor.getBoundingClientRect();
  if (!open.anchor.isConnected || r.bottom < 0 || r.top > window.innerHeight) closeMarkCard();
  else place(open.card, r);
}

/** Document-wide listeners, added once: outside taps, Escape, and anything that moves the page under the card. */
function ensureGlobals(): void {
  if (globalsReady) return;
  globalsReady = true;
  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    const t = e.target as Node;
    if (open.card.contains(t) || (t instanceof Element && t.closest('[data-id]'))) return;
    closeMarkCard();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) dismiss();
  });
  window.addEventListener('scroll', (e) => {
    if (open && !(e.target instanceof Node && open.card.contains(e.target))) follow();
  }, true);
  window.addEventListener('resize', follow);
}

/**
 * Wires the card to a freshly rendered preview. Call again after every render: the preview element is replaced
 * then, and the card of the old preview is closed.
 */
export function installMarkCards(preview: HTMLElement, h: MarkCardHandlers): void {
  closeMarkCard();
  handlers = h;
  ensureGlobals();
  const markOf = (target: EventTarget | null): HTMLElement | null => {
    const m = (target as Element | null)?.closest?.<HTMLElement>('[data-id]') ?? null;
    return m && preview.contains(m) ? m : null;
  };

  preview.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType || 'mouse';
    const m = markOf(e.target);
    touchOpenAtDown = !!m && open?.id === m.dataset.id;
  });
  preview.addEventListener('mouseover', (e) => {
    const m = markOf(e.target);
    if (m) showFor(m);
  });
  preview.addEventListener('mouseout', (e) => {
    const m = markOf(e.target);
    if (m && !m.contains(e.relatedTarget as Node | null)) scheduleHide();
  });
  preview.addEventListener('focusin', (e) => {
    const m = markOf(e.target);
    if (m) showFor(m);
  });
  preview.addEventListener('focusout', (e) => {
    const m = markOf(e.target);
    const next = e.relatedTarget as Node | null;
    if (m && !(next && open?.card.contains(next))) scheduleHide();
  });
  preview.addEventListener('keydown', (e) => {
    const m = markOf(e.target);
    if (!m || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    showFor(m, true);
  });
  preview.addEventListener('click', (e) => {
    const m = markOf(e.target);
    if (!m) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // a drag-selection, not a click
    const item = handlers?.itemFor(m.dataset.id ?? '');
    if (!item) return;
    // On touch the first tap only opens the card; a second tap on the same mark opens the cancel/re-hide popup.
    if (lastPointerType === 'touch' && !touchOpenAtDown) {
      showFor(m);
      return;
    }
    closeMarkCard();
    handlers?.openPopup(m.getBoundingClientRect(), item);
  });
}
