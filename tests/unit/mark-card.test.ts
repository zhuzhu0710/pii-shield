import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORD_LISTS_STORAGE_KEY } from '../../src/core/word-lists';

const ID = 'A123456789';

/** A fresh process view with the pasted text loaded (the ID number is a 身分證 mark). */
async function loaded(text = `受理編號 ${ID}，請回覆。`) {
  vi.resetModules();
  const { createProcessView } = await import('../../src/ui/process-view');
  const view = createProcessView();
  document.body.append(view);
  view.querySelector<HTMLTextAreaElement>('textarea')!.value = text;
  [...view.querySelectorAll('button')].find((b) => b.textContent === '開始隱藏個資')!.click();
  await vi.waitFor(() => expect(view.querySelector('.preview')).not.toBeNull(), { timeout: 5000 });
  return view;
}

const marks = () => [...document.querySelectorAll<HTMLElement>('.preview [data-id]')];
/** The mark that covers the ID number (the only mark in the default text). */
const idMark = () => marks()[0];
const card = () => document.querySelector<HTMLElement>('.mark-card');
const cardButtons = () => [...(card()?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
const btnByText = (part: string) => cardButtons().find((b) => b.textContent?.includes(part));
/** The two action buttons, found by their main label (the word is on the second line of each). */
const keepBtn = () => btnByText('以後都不要隱藏');
const hideBtn = () => btnByText('以後都要隱藏');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hover = (m: HTMLElement) => m.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
const leave = (m: HTMLElement, to: EventTarget | null = null) => m.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
const lists = () => JSON.parse(localStorage.getItem(WORD_LISTS_STORAGE_KEY) ?? '{}');

beforeEach(() => {
  localStorage.clear();
  document.querySelectorAll('.process-view, .mark-card, .add-popup').forEach((n) => n.remove());
});

describe('hover card on a mark', () => {
  it('opens on hover with both list actions and the plain-language note', async () => {
    const view = await loaded();
    expect(idMark()).toBeTruthy();
    expect(view.querySelector('.preview [data-tip]')).toBeNull(); // no one-line tooltip on top of the card
    hover(idMark());
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain(`原文：${ID}`);
    expect(keepBtn()!.textContent).toContain('不是個資 → 以後都不要隱藏『A123456789』會加入白名單，保留原文');
    expect(hideBtn()!.textContent).toContain('是個資 → 以後都要隱藏『A123456789』會加入黑名單，每次都隱藏');
    expect(keepBtn()!.querySelector('.mark-card-word')!.getAttribute('title')).toBe(ID);
    expect(hideBtn()!.querySelector('svg')).not.toBeNull();
    expect(card()!.querySelector('.mark-card-note')!.textContent).toContain('白名單＝永遠不隱藏的詞；黑名單＝永遠要隱藏的詞。可在『進階設定』查看或刪除。');
    expect(card()!.querySelector<HTMLButtonElement>('.mark-card-link')!.textContent).toBe('進階設定');
  });

  it('stays open while the pointer moves into it, and closes after the delay once it leaves both', async () => {
    await loaded();
    const m = idMark();
    hover(m);
    leave(m, card());
    card()!.dispatchEvent(new MouseEvent('mouseenter')); // the browser fires this when the pointer enters the card
    await wait(400);
    expect(card()).not.toBeNull();
    card()!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    await wait(400);
    expect(card()).toBeNull();
  });

  it('closes on Escape', async () => {
    await loaded();
    hover(idMark());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card()).toBeNull();
  });

  it('這不是個資 adds the word to 不要隱藏的詞, re-detects, and the mark goes away', async () => {
    const view = await loaded();
    hover(idMark());
    keepBtn()!.click();
    expect(lists().whitelist).toEqual([ID]);
    expect(card()).toBeNull();
    expect(marks()).toHaveLength(0);
    expect(document.body.textContent).toContain('已加入『不要隱藏的詞』（白名單）');
    expect(view.querySelector('.preview')!.textContent).toContain(ID);
  });

  it('這是個資 adds the word to 一定要隱藏的詞 with the item category, and then shows the state', async () => {
    await loaded();
    hover(idMark());
    hideBtn()!.click();
    expect(lists().blacklist).toEqual([{ word: ID, category: '身分證' }]);
    expect(marks()).toHaveLength(1);
    expect(document.body.textContent).toContain('已加入『一定要隱藏的詞』（黑名單）');
    hover(idMark());
    expect(hideBtn()).toBeUndefined();
    expect(card()!.querySelector('.mark-card-state')!.textContent).toBe('✓ 已在一定要隱藏的詞');
  });

  it('這是個資 brings back a mark the user had cancelled', async () => {
    await loaded();
    idMark().click(); // the existing popup: 取消隱藏
    [...document.querySelectorAll<HTMLButtonElement>('.add-popup button')].find((b) => b.textContent === '取消隱藏')!.click();
    expect(document.querySelector('.preview .cancelled')).not.toBeNull();
    hover(document.querySelector<HTMLElement>('.preview .cancelled')!);
    hideBtn()!.click();
    expect(document.querySelector('.preview .cancelled')).toBeNull();
    expect(marks()).toHaveLength(1);
  });

  it('a click on the mark still opens the cancel/re-hide popup', async () => {
    await loaded();
    idMark().click();
    expect(document.querySelector('.add-popup')).not.toBeNull();
    expect(card()).toBeNull();
  });

  it('Tab focus shows the card, and Enter moves focus into its first button', async () => {
    await loaded();
    const m = idMark();
    m.focus();
    expect(card()).not.toBeNull();
    m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement).toBe(keepBtn());
  });

  it('a first tap only opens the card; a second tap on the same mark opens the popup', async () => {
    await loaded();
    const m = idMark();
    const touch = (type: string) => {
      const ev = new Event(type, { bubbles: true });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      m.dispatchEvent(ev);
    };
    touch('pointerdown');
    hover(m); // browsers emulate hover on a tap
    m.click();
    expect(card()).not.toBeNull();
    expect(document.querySelector('.add-popup')).toBeNull();
    touch('pointerdown');
    m.click();
    expect(document.querySelector('.add-popup')).not.toBeNull();
  });
});
