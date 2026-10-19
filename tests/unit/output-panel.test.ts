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
  await vi.waitFor(() => expect(view.querySelector('.output-panel')).not.toBeNull(), { timeout: 5000 });
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
    const panel = view.querySelector('.output-panel')!;
    expect(panel.querySelector('h3')!.textContent).toBe('輸出方式（可隨時切換）');
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

  it('has no 調整 toggle or summary-only state, and keeps the advanced settings folded', async () => {
    const view = await loaded();
    expect(view.querySelector('.output-panel-summary')).toBeNull();
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
    // Saved choices fold the card to one line; 變更 opens it with the same choices.
    expect(again.querySelector('.output-panel-folded')).not.toBeNull();
    again.querySelector<HTMLButtonElement>('.output-summary-change')!.click();
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

describe('folded output card', () => {
  const summary = (view: HTMLElement) => view.querySelector('.output-summary-text')?.textContent;
  const button = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

  it('is expanded with a first-visit intro when nothing is saved', async () => {
    const view = await loaded();
    expect(view.querySelector('.output-panel-folded')).toBeNull();
    expect(view.querySelector('.output-intro')!.textContent).toBe('第一次使用：請選擇輸出方式。選一次就好，之後每份文件都會自動沿用，隨時可以按『變更』修改。');
    expect(button(view, '用這個設定')).toBeTruthy();
    expect(button(view, '完成')).toBeUndefined();
  });

  it('用這個設定 saves the choice and folds the card', async () => {
    const view = await loaded();
    button(view, '用這個設定')!.click();
    expect(savedPrefs()).toMatchObject({ version: 1, outputMode: 'preview', marker: 'code' });
    expect(view.querySelector('.output-panel-folded')).not.toBeNull();
    expect(view.querySelectorAll('button.choice')).toHaveLength(0);
    expect(summary(view)).toBe('輸出方式：露出部分・可還原');
  });

  it('shows the intro only once: a later visit starts folded with no intro', async () => {
    const first = await loaded();
    choose(first, 'marker-style', 'code');
    const again = await loaded();
    expect(again.querySelector('.output-panel-folded')).not.toBeNull();
    expect(again.querySelector('.output-intro')).toBeNull();
  });

  it('a choice made on a first visit saves it and changes the button to 完成', async () => {
    const view = await loaded();
    choose(view, 'output-mode', 'code');
    expect(savedPrefs().outputMode).toBe('code');
    expect(view.querySelector('.output-intro')).toBeNull();
    expect(button(view, '完成')).toBeTruthy();
    expect(view.querySelector('.output-panel-folded')).toBeNull(); // stays open until it is closed
  });

  it('變更 expands the saved card and 完成 folds it again, moving focus to 變更', async () => {
    const first = await loaded();
    button(first, '用這個設定')!.click();
    const view = await loaded();
    view.querySelector<HTMLButtonElement>('.output-summary-change')!.click();
    expect(view.querySelector('.output-panel-folded')).toBeNull();
    expect(view.querySelectorAll('button.choice')).toHaveLength(6);
    expect(button(view, '完成')).toBeTruthy();
    button(view, '完成')!.click();
    expect(view.querySelector('.output-panel-folded')).not.toBeNull();
    expect(document.activeElement).toBe(view.querySelector('.output-summary-change'));
  });

  it('the one line reflects the current choice in plain words', async () => {
    const view = await loaded();
    button(view, '用這個設定')!.click();
    const expand = () => view.querySelector<HTMLButtonElement>('.output-summary-change')!.click();
    expand();
    choose(view, 'output-mode', 'code');
    choose(view, 'marker-style', 'label');
    button(view, '完成')!.click();
    expect(summary(view)).toBe('輸出方式：全部隱藏・類別標記（之後無法還原）');
    expand();
    choose(view, 'marker-style', 'blank');
    button(view, '完成')!.click();
    expect(summary(view)).toBe('輸出方式：全部隱藏・空白佔位（之後無法還原）');
    expand();
    choose(view, 'output-mode', 'custom');
    choose(view, 'marker-style', 'code');
    button(view, '完成')!.click();
    expect(summary(view)).toBe('輸出方式：自訂・可還原');
  });

  it('the top banner still switches to 全部隱藏 while folded', async () => {
    const view = await loaded();
    button(view, '用這個設定')!.click();
    expect(view.querySelector('.output-panel-folded')).not.toBeNull();
    expect(view.querySelector('.status-partial')).not.toBeNull();
    [...view.querySelectorAll<HTMLButtonElement>('.status-partial button')][0].click();
    expect(view.querySelector('.output-panel-folded')).not.toBeNull();
    expect(summary(view)).toBe('輸出方式：全部隱藏・可還原');
    expect(view.querySelector('.status-partial')).toBeNull();
    expect(savedPrefs().outputMode).toBe('code');
  });
});

