import './styles.css';
import { BRAND_NAME, BRAND_TAGLINE } from './brand';
import { el, installTooltips } from './ui/components';
import { createProcessView, hasUnsavedResults, syncPatternChanges } from './ui/process-view';
import { createPatternsView } from './ui/patterns-view';
import { createRestoreView } from './ui/restore-view';
import { initWordLists } from './core/word-lists';
import { closeMarkCard } from './ui/mark-card';
import { footerAbout } from './ui/footer';

type ViewId = 'process' | 'restore' | 'settings';

/** The two everyday tasks, shown as tabs in the header. */
const TASKS: { id: ViewId; label: string; create: () => HTMLElement }[] = [
  { id: 'process', label: '隱藏個資', create: createProcessView },
  { id: 'restore', label: '還原', create: createRestoreView },
];
/** Advanced settings are a quiet link at the end of the header, not a main task. */
const SETTINGS = { id: 'settings' as const, label: '進階設定', create: createPatternsView };

const INTRO_KEY = 'deid-intro-seen';

/** The first-visit intro is remembered in this browser only; storage can be blocked, so every access is guarded. */
function introSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}
function rememberIntro(): void {
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    // private window or blocked storage: the intro simply shows again next time
  }
}

/** The mark: a sheet of paper with one bar blacked out. Same shape as the favicon in index.html. */
function brandMark(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '32');
  svg.setAttribute('height', '32');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('brand-mark');
  const rect = (x: number, y: number, w: number, h: number, cls: string) => {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', String(y));
    r.setAttribute('width', String(w));
    r.setAttribute('height', String(h));
    r.setAttribute('rx', '1.5');
    r.setAttribute('class', cls);
    svg.append(r);
  };
  rect(0, 0, 32, 32, 'brand-mark-bg');
  rect(8, 6.5, 16, 19, 'brand-mark-sheet');
  rect(11, 11, 10, 2.6, 'brand-mark-ink');
  rect(11, 16.2, 6.5, 2.6, 'brand-mark-ink');
  return svg;
}

function showIntro(): HTMLDialogElement {
  const dialog = el('dialog', { class: 'intro-dialog', 'aria-labelledby': 'intro-title' });
  const close = () => {
    rememberIntro();
    dialog.close();
  };
  dialog.append(
    el('h2', { id: 'intro-title' }, '先看三件事'),
    el('ul', { class: 'intro-list' },
      el('li', {}, el('strong', {}, '檔案不會離開你的電腦。'), ' 所有處理都在這個瀏覽器中完成，不會上傳到任何伺服器。'),
      el('li', {}, el('strong', {}, '只要三個步驟。'), ' 放入檔案、檢查標記、下載。每一步都會告訴你下一步要做什麼。'),
      el('li', {}, el('strong', {}, '之後可以還原。'), ' 下載時會附上「還原鑰匙檔」，到「還原」頁上傳它，就能換回原文。'),
    ),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'btn btn-primary', type: 'button', onClick: close }, '開始使用')),
  );
  dialog.addEventListener('cancel', () => rememberIntro());
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('.btn-primary')?.focus();
  return dialog;
}

function mount(): void {
  const app = document.getElementById('app')!;
  // Static guide and FAQ shipped in index.html for crawlers; after mount it lives in a dialog opened from the footer.
  const siteInfo = document.getElementById('site-info');
  app.replaceChildren(); // drop the static SEO fallback
  const infoDialog = el('dialog', { class: 'site-info-dialog', 'aria-label': '使用說明與常見問題' });
  if (siteInfo) {
    infoDialog.append(
      el('button', { class: 'dialog-close', type: 'button', 'aria-label': '關閉', onClick: () => infoDialog.close() }, '✕'),
      siteInfo,
    );
    infoDialog.addEventListener('click', (e) => {
      if (e.target === infoDialog) infoDialog.close(); // backdrop click
    });
  }

  const nav = el('nav', { class: 'tabs', 'aria-label': '主要功能' });
  const panels = el('main', { class: 'panels' });
  const views = new Map<ViewId, HTMLElement>();

  const activate = (id: ViewId) => {
    // Popups are attached to <body>, so they would otherwise linger over the other tabs.
    document.querySelector('.add-popup')?.remove();
    closeMarkCard();
    window.getSelection()?.removeAllRanges();
    for (const t of [...TASKS, SETTINGS]) {
      const button = nav.querySelector<HTMLElement>(`[data-tab="${t.id}"]`);
      button?.classList.toggle('active', t.id === id);
      if (button) {
        if (t.id === id) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
      let v = views.get(t.id);
      if (!v && t.id === id) {
        v = t.create();
        views.set(t.id, v);
        panels.append(v);
      }
      if (v) v.hidden = t.id !== id;
    }
    // Settings changed in one place should be visible on return to any page.
    if (id === 'settings') {
      const fresh = createPatternsView();
      views.get('settings')?.replaceWith(fresh);
      views.set('settings', fresh);
    }
    if (id === 'process') syncPatternChanges();
    document.title = id === 'process' ? `${BRAND_NAME}｜隱藏個資` : id === 'restore' ? `${BRAND_NAME}｜還原` : `${BRAND_NAME}｜進階設定`;
  };

  for (const t of TASKS) {
    nav.append(el('button', { class: 'tab', 'data-tab': t.id, type: 'button', onClick: () => activate(t.id) }, t.label));
  }
  nav.append(el('button', { class: 'tab tab-settings', 'data-tab': SETTINGS.id, type: 'button', onClick: () => activate(SETTINGS.id) }, SETTINGS.label));

  const footer = el('footer', { class: 'footer' },
    el('div', { class: 'footer-inner' },
      footerAbout(),
      el('div', { class: 'footer-links' },
        el('button', { class: 'link-btn', type: 'button', onClick: () => showIntro() }, '使用說明'),
        siteInfo ? el('button', { class: 'link-btn', type: 'button', onClick: () => infoDialog.showModal() }, '常見問題') : null,
      ),
    ),
  );

  app.append(
    el('header', { class: 'header' },
      el('div', { class: 'header-inner' },
        el('div', { class: 'brand' },
          brandMark(),
          el('div', { class: 'brand-text' },
            el('h1', {}, BRAND_NAME),
            el('span', { class: 'brand-tagline' }, BRAND_TAGLINE),
          ),
        ),
        nav,
      ),
    ),
    panels,
    footer,
    infoDialog,
  );
  // The word-list card's 進階設定 link (ui/mark-card.ts) opens the settings tab.
  window.addEventListener('deid:open-settings', () => activate(SETTINGS.id));
  activate('process');
  if (!introSeen()) showIntro();

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedResults()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

initWordLists();
mount();
installTooltips();
