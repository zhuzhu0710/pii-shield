import { describe, expect, it } from 'vitest';
import { footerAbout } from '../../src/ui/footer';

describe('footer 關於 line', () => {
  const about = footerAbout();
  const links = [...about.querySelectorAll('a')];

  it('links the original project and the full license text, both in a new tab', () => {
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['data-deidentification', 'https://github.com/dean9703111/data-deidentification'],
      ['授權條款（MIT）', 'LICENSE.txt'],
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('keeps the attribution wording around the links', () => {
    expect(about.textContent).toContain('以 MIT 授權開源，部分程式碼改編自 Dean Lin 的開源專案 data-deidentification。');
  });
});
