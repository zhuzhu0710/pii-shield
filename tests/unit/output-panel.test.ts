import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh process view (its state is module-wide) with the pasted text loaded and the output settings open. */
async function loaded(text = '王小明 A123456789 0912-345-678') {
  vi.resetModules();
  const { createProcessView } = await import('../../src/ui/process-view');
  const view = createProcessView();
  document.body.append(view);
  view.querySelector<HTMLTextAreaElement>('textarea')!.value = text;
  [...view.querySelectorAll('button')].find((b) => b.textContent === '開始隱藏個資')!.click();
  await vi.waitFor(() => expect(view.querySelector('.output-panel')).not.toBeNull(), { timeout: 5000 });
  view.querySelector<HTMLDetailsElement>('.output-panel')!.open = true;
  return view;
}
const pick = (view: HTMLElement, name: string, value: string) => {
  const r = view.querySelector<HTMLInputElement>(`input[name=${name}][value=${value}]`)!;
  r.checked = true;
  r.dispatchEvent(new Event('change'));
};
const section = (view: HTMLElement, cls: string) => view.querySelector<HTMLDetailsElement>(`details.${cls}`);

beforeEach(() => {
  localStorage.clear();
  document.querySelectorAll('.process-view').forEach((v) => v.remove());
});

describe('output settings', () => {
  it('offers 要露出多少 and 標記方式 as two rows, one merged notice, and keeps the rest folded', async () => {
    const view = await loaded();
    const rows = [...view.querySelectorAll('.output-row')];
    expect(rows.map((r) => r.querySelector('.output-row-label')!.textContent)).toEqual(['要露出多少', '標記方式']);
    expect(rows[0].querySelectorAll('input[name=output-mode]')).toHaveLength(3);
    expect(rows[1].querySelectorAll('input[name=marker-style]')).toHaveLength(3);
    expect(rows[0].querySelector('.output-row-note')!.textContent).toBe('A123456789 → A1[身分證]');
    expect(view.querySelectorAll('.output-notice')).toHaveLength(1);
    expect(view.querySelector('.output-notice')!.textContent).toContain('露出部分');
    expect(section(view, 'by-category')!.open).toBe(false);
    expect(section(view, 'by-category')!.querySelector('summary')!.textContent).toBe('依類別調整（3 類）');
    expect(section(view, 'code-advanced')!.open).toBe(false);
  });

  it('opens 依類別調整 under 自訂 and drops 進階 when nothing is restored', async () => {
    const view = await loaded();
    pick(view, 'output-mode', 'custom');
    expect(section(view, 'by-category')!.open).toBe(true);
    expect(view.querySelector('.output-notice')).toBeNull(); // 自訂 keeps each rule's own setting: nothing kept here
    pick(view, 'marker-style', 'label');
    expect(section(view, 'code-advanced')).toBeNull();
    expect(view.querySelector('.output-notice')!.textContent).toContain('之後無法還原');
  });

  it('keeps a section open for the session once opened, across re-renders', async () => {
    const view = await loaded();
    const s = section(view, 'by-category')!;
    s.open = true;
    s.dispatchEvent(new Event('toggle'));
    pick(view, 'marker-style', 'blank');
    expect(section(view, 'by-category')!.open).toBe(true);
  });

  it('says in one plain sentence what the output does, and warns in plain words', async () => {
    const view = await loaded();
    expect(view.querySelector('.output-panel-summary')!.textContent).toContain('目前設定：個資會換成代號');
    expect(view.querySelector('.status-partial')!.textContent).toBe('⚠ 部分個資會露出前幾個字方便辨認，例如姓氏');
    expect(view.querySelector('.status-partial')!.getAttribute('data-tip')).toContain('姓名');
    pick(view, 'marker-style', 'label');
    expect(view.querySelector('.output-panel-summary')!.textContent).toContain('之後無法還原');
  });
});
