import { BRAND_NAME } from '../brand';
import { el } from './components';

/** The original project this one adapts code from. */
export const ATTRIBUTION_REPO_URL = 'https://github.com/dean9703111/data-deidentification';
/** Built next to the page by vite.config.ts from the repo-root LICENSE file. */
export const LICENSE_URL = 'LICENSE.txt';

/** The 「關於」 line of the footer: license, attribution to the original project, and the full license text. */
export function footerAbout(): HTMLParagraphElement {
  const newTab = { target: '_blank', rel: 'noopener noreferrer' };
  return el('p', { class: 'footer-about' },
    el('strong', {}, '關於　'),
    `${BRAND_NAME}以 MIT 授權開源，部分程式碼改編自 Dean Lin 的開源專案 `,
    el('a', { href: ATTRIBUTION_REPO_URL, ...newTab }, 'data-deidentification'),
    '。',
    el('a', { href: LICENSE_URL, ...newTab }, '授權條款（MIT）'),
  );
}
