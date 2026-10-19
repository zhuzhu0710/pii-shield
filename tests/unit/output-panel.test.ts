import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_PREFS_STORAGE_KEY } from '../../src/core/output-prefs';

/** A fresh process view (its state is module-wide) with the pasted text loaded. */
async function loaded(text = '王小明 A123456789 0912-345-678') {
  vi.resetModules();
  const { createProcessView } = await import('../../src/ui/process-view');
  const view = createProcessView();
  document.body.append(view);
  view.querySelector<HTMLTextAreaElement>('textarea')!.value = text;
  [...view.querySelectorAll('button')].find((b) => b.textContent === '開始隱藏個資')!.click();
  await vi.waitFor(() => expect(view.querySelector('.output-settings')).not.toBeNull(), { timeout: 5000 });
  return view;
}
/** Clicks one of the choice buttons (group = output-mode | marker-style, value = its data-value). */
const choose = (view: HTMLElement, group: string, value: string) => {
  view.querySelector<HTMLButtonElement>(`button.choice[data-group=${group}][data-value=${value}]`)!.click();
};
const pressed = (view: HTMLElement, group: string) =>
  [...view.querySelectorAll<HTMLButtonElement>(`button.choice[data-group=${group}]`)]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.dataset.value);
const section = (view: HTMLElement, cls: string) => view.querySelector<HTMLDetailsElement>(`details.${cls}`);
const savedPrefs = () => JSON.parse(localStorage.getItem(OUTPUT_PREFS_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  document.querySelectorAll('.process-view').forEach((v) => v.remove());
});

describe('output settings', () => {
  it('shows both choices with their examples without opening anything', async () => {
    const view = await loaded();
    const panel = view.querySelector('.output-settings')!;
    expect(panel.querySelector('.os-title')!.textContent).toBe('輸出方式（可隨時切換）');
    expect(panel.textContent).toContain('會記住你這次的選擇，下次自動套用');
    expect([...panel.querySelectorAll('.output-row-label')].map((n) => n.textContent)).toEqual(['要露出多少', '標記方式']);

    const keep = [...panel.querySelectorAll<HTMLButtonElement>('button.choice[data-group=output-mode]')];
    expect(keep.map((b) => b.querySelector('.choice-title')!.textContent)).toEqual(['露出部分', '全部隱藏', '自訂']);
    expect(keep[0].querySelector('.choice-example')!.textContent).toBe('王●● 0912●●●●●●');
    expect(keep[1].querySelector('.choice-example')!.textContent).toBe('王小明 → [姓名]');
    expect(pressed(view, 'output-mode')).toEqual(['preview']);

    const marker = [...panel.querySelectorAll<HTMLButtonElement>('button.choice[data-group=marker-style]')];
    expect(marker.map((b) => b.querySelector('.choice-title')!.textContent)).toEqual(['可還原', '類別標記', '空白佔位']);
    expect(marker[0].querySelector('.choice-detail')!.textContent).toBe('之後能用還原鑰匙檔換回原文');
    expect(marker[1].querySelector('.choice-detail')!.textContent).toContain('無法還原');
    expect(pressed(view, 'marker-style')).toEqual(['code']);

    expect(panel.querySelector('.output-live')!.textContent).toContain('A123456789 → A1[身分證]');
    expect(view.querySelectorAll('.output-notice')).toHaveLength(1);
    expect(view.querySelector('.output-notice')!.textContent).toContain('露出部分');
  });

  it('has no 調整 toggle, and keeps the advanced settings folded', async () => {
    const view = await loaded();
    expect([...view.querySelectorAll('button')].some((b) => b.textContent === '調整')).toBe(false);
    expect(section(view, 'output-advanced')!.open).toBe(false);
    expect(section(view, 'output-advanced')!.querySelector('details.by-category > summary')!.textContent).toBe('依類別調整（3 類）');
    expect(section(view, 'output-advanced')!.querySelector('.code-scope')).not.toBeNull();
  });

  it('opens 依類別調整 under 自訂 and drops the shared-key scope when nothing is restored', async () => {
    const view = await loaded();
    choose(view, 'output-mode', 'custom');
    expect(pressed(view, 'output-mode')).toEqual(['custom']);
    expect(section(view, 'output-advanced')!.open).toBe(true);
    expect(section(view, 'by-category')!.open).toBe(true);
    expect(view.querySelector('.output-notice')).toBeNull(); // 自訂 keeps each rule's own setting: nothing kept here
    choose(view, 'marker-style', 'label');
    expect(view.querySelector('.code-scope')).toBeNull();
    expect(view.querySelector('.output-notice')!.textContent).toContain('之後無法還原');
  });

  it('keeps 依類別調整 open for the session once opened, across re-renders', async () => {
    const view = await loaded();
    const adv = section(view, 'output-advanced')!;
    adv.open = true;
    adv.dispatchEvent(new Event('toggle'));
    const s = section(view, 'by-category')!;
    s.open = true;
    s.dispatchEvent(new Event('toggle'));
    choose(view, 'marker-style', 'blank');
    expect(section(view, 'output-advanced')!.open).toBe(true);
    expect(section(view, 'by-category')!.open).toBe(true);
  });

  it('clicking 全部隱藏 updates the preview at once and remembers the choice', async () => {
    const view = await loaded();
    expect(view.querySelector('.preview')!.textContent).toContain('A1');
    choose(view, 'output-mode', 'code');
    expect(pressed(view, 'output-mode')).toEqual(['code']);
    expect(view.querySelector('.output-live')!.textContent).toContain('A123456789 → [身分證]');
    expect(view.querySelector('.preview')!.textContent).not.toContain('A1[');
    expect(savedPrefs()).toMatchObject({ version: 1, outputMode: 'code' });
  });

  it('restores the choices made last time on the next visit', async () => {
    await loaded();
    const first = document.querySelector<HTMLElement>('.process-view')!;
    choose(first, 'output-mode', 'code');
    choose(first, 'marker-style', 'label');
    const again = await loaded();
    // Saved choices fold the card to one line; the header opens it with the same choices.
    expect(again.querySelector('.output-settings.is-open')).toBeNull();
    again.querySelector<HTMLButtonElement>('.output-settings-head')!.click();
    expect(pressed(again, 'output-mode')).toEqual(['code']);
    expect(pressed(again, 'marker-style')).toEqual(['label']);
  });

  it('shows the partial-exposure banner with a link that switches to 全部隱藏', async () => {
    const view = await loaded();
    const banner = view.querySelector('.status-partial')!;
    expect(banner.textContent).toContain('⚠ 部分個資會露出前幾個字方便辨認，例如姓氏');
    expect(banner.getAttribute('data-tip')).toContain('姓名');
    const link = [...banner.querySelectorAll('button')].find((b) => b.textContent === '改成全部隱藏')!;
    expect(link).toBeTruthy();
    link.click();
    expect(pressed(view, 'output-mode')).toEqual(['code']);
    expect(view.querySelector('.status-partial')).toBeNull();
    expect(savedPrefs().outputMode).toBe('code');
  });

  it('hides the banner outside 露出部分', async () => {
    const view = await loaded();
    choose(view, 'output-mode', 'custom');
    expect(view.querySelector('.status-partial')).toBeNull();
    choose(view, 'output-mode', 'code');
    expect(view.querySelector('.status-partial')).toBeNull();
    choose(view, 'output-mode', 'preview');
    expect(view.querySelector('.status-partial')).not.toBeNull();
  });
});

describe('output settings disclosure', () => {
  const head = (view: HTMLElement) => view.querySelector<HTMLButtonElement>('.output-settings-head')!;
  const panel = (view: HTMLElement) => view.querySelector<HTMLElement>('.output-settings')!;
  const isOpen = (view: HTMLElement) => panel(view).classList.contains('is-open');
  const summary = (view: HTMLElement) => view.querySelector('.os-folded-text')?.textContent;
  const buttonNamed = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

  it('first visit is expanded with the intro, one disclosure header and no 變更 / 完成 / 用這個設定 buttons', async () => {
    const view = await loaded();
    expect(isOpen(view)).toBe(true);
    expect(head(view).getAttribute('aria-expanded')).toBe('true');
    expect(head(view).getAttribute('aria-controls')).toBe('output-settings-body');
    expect(view.querySelector('#output-settings-body')).not.toBeNull();
    expect(view.querySelector('.output-intro')!.textContent).toBe('第一次使用：請選擇輸出方式，選好後按右上角 ▲ 收合。之後每份文件都會自動沿用。');
    expect(head(view).textContent).toContain('收合');
    for (const label of ['變更', '完成', '用這個設定']) expect(buttonNamed(view, label)).toBeUndefined();
    expect(view.querySelectorAll('.output-settings button.choice')).toHaveLength(6);
  });

  it('the settings card is its own section above the preview, not inside the preview container', async () => {
    const view = await loaded();
    const p = panel(view);
    const preview = view.querySelector<HTMLElement>('.preview-wrap')!;
    expect(p.closest('.preview-wrap')).toBeNull();
    expect(preview.contains(p)).toBe(false);
    expect(p.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(p.parentElement!.nextElementSibling).toBe(preview);
    // the legend and the unsure-jump row stay with the preview
    expect(p.querySelector('.low-bar')).toBeNull();
    expect(preview.querySelector('.mark-legend')).not.toBeNull();
  });

  it('the header button and its chevron both toggle, and aria-expanded follows', async () => {
    const view = await loaded();
    head(view).click();
    expect(isOpen(view)).toBe(false);
    expect(head(view).getAttribute('aria-expanded')).toBe('false');
    expect(view.querySelector<HTMLElement>('#output-settings-body')!.hidden).toBe(true);
    expect(head(view).querySelector('.os-toggle-label')!.textContent).toBe('展開設定');
    expect(summary(view)).toBe('輸出方式：露出部分・可還原');
    head(view).querySelector<HTMLElement>('.os-chevron')!.click();
    expect(isOpen(view)).toBe(true);
    expect(head(view).getAttribute('aria-expanded')).toBe('true');
    expect(view.querySelector<HTMLElement>('#output-settings-body')!.hidden).toBe(false);
    expect(head(view).querySelector('.os-toggle-label')!.textContent).toBe('收合');
  });

  it('shows only the text that matches the state on first render, folded or expanded', async () => {
    const view = await loaded();
    expect(view.querySelector<HTMLElement>('.os-open-text')!.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>('.os-folded-text')!.hidden).toBe(true);
    head(view).click();
    const again = await loaded();
    expect(again.querySelector<HTMLElement>('.os-open-text')!.hidden).toBe(true);
    expect(again.querySelector<HTMLElement>('.os-folded-text')!.hidden).toBe(false);
  });

  it('the header is a native button, so Enter and Space activate it like a click', async () => {
    const view = await loaded();
    expect(head(view).tagName).toBe('BUTTON');
    expect(head(view).getAttribute('type')).toBe('button');
    expect(head(view).querySelector('.os-chevron')).not.toBeNull();
  });

  it('the expanded header carries the memory note; the folded header shows the plain summary', async () => {
    const view = await loaded();
    expect(head(view).textContent).toContain('輸出方式（可隨時切換）');
    expect(head(view).textContent).toContain('會記住你這次的選擇，下次自動套用');
    head(view).click();
    expect(view.querySelector<HTMLElement>('.os-open-text')!.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>('.os-folded-text')!.hidden).toBe(false);
    expect(summary(view)).toBe('輸出方式：露出部分・可還原');
  });

  it('folding saves the choice, so the next visit starts folded with no intro', async () => {
    const view = await loaded();
    expect(savedPrefs()).toBeNull();
    head(view).click();
    expect(savedPrefs()).toMatchObject({ version: 1, outputMode: 'preview', marker: 'code' });
    const again = await loaded();
    expect(isOpen(again)).toBe(false);
    expect(again.querySelector('.output-intro')).toBeNull();
    expect(summary(again)).toBe('輸出方式：露出部分・可還原');
  });

  it('a choice made on a first visit saves it, and the card stays open', async () => {
    const view = await loaded();
    choose(view, 'output-mode', 'code');
    expect(savedPrefs().outputMode).toBe('code');
    expect(view.querySelector('.output-intro')).toBeNull();
    expect(isOpen(view)).toBe(true);
  });

  it('the one line reflects the current choice in plain words', async () => {
    const view = await loaded();
    head(view).click(); // fold: saves the default choice
    const open = () => head(view).click();
    open();
    choose(view, 'output-mode', 'code');
    choose(view, 'marker-style', 'label');
    head(view).click();
    expect(summary(view)).toBe('輸出方式：全部隱藏・類別標記（之後無法還原）');
    open();
    choose(view, 'marker-style', 'blank');
    head(view).click();
    expect(summary(view)).toBe('輸出方式：全部隱藏・空白佔位（之後無法還原）');
    open();
    choose(view, 'output-mode', 'custom');
    choose(view, 'marker-style', 'code');
    head(view).click();
    expect(summary(view)).toBe('輸出方式：自訂・可還原');
  });

  it('the top banner still switches to 全部隱藏 while folded', async () => {
    const first = await loaded();
    head(first).click();
    const view = await loaded();
    expect(isOpen(view)).toBe(false);
    expect(view.querySelector('.status-partial')).not.toBeNull();
    [...view.querySelectorAll<HTMLButtonElement>('.status-partial button')][0].click();
    expect(isOpen(view)).toBe(false);
    expect(summary(view)).toBe('輸出方式：全部隱藏・可還原');
    expect(view.querySelector('.status-partial')).toBeNull();
    expect(savedPrefs().outputMode).toBe('code');
  });
});
