import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND_NAME, BRAND_TAGLINE } from '../../src/brand';

// index.html carries the page's search and AI-answer metadata; the app replaces only #app's fallback.
// The brand placeholders are filled in by vite.config.ts at build time; do the same here.
const html = readFileSync('index.html', 'utf8')
  .replaceAll('__BRAND_NAME__', BRAND_NAME)
  .replaceAll('__BRAND_TAGLINE__', BRAND_TAGLINE);
const page = new DOMParser().parseFromString(html, 'text/html');
const graph: Record<string, unknown>[] = JSON.parse(page.querySelector('script[type="application/ld+json"]')!.textContent!)['@graph'];
const node = (type: string) => graph.find((g) => g['@type'] === type) as Record<string, any>;

describe('index.html search metadata', () => {
  it('has the brand as title, a description, and the structured data types', () => {
    expect(page.title).toContain(BRAND_NAME);
    expect(page.querySelector('meta[name=description]')!.getAttribute('content')!.length).toBeGreaterThan(80);
    expect(graph.map((g) => g['@type'])).toEqual(expect.arrayContaining(['WebApplication', 'HowTo', 'FAQPage']));
  });

  it('carries no link or metadata that points at the original author', () => {
    expect(html).not.toMatch(/deanlin|dean9703111|medium\.com|threads\.com/i);
    expect(page.querySelector('link[rel=canonical]')).toBeNull();
    expect(page.querySelector('meta[name=author]')).toBeNull();
  });

  it('answers every FAQ in the structured data word for word as the visible page does', () => {
    const visible = [...page.querySelectorAll('#faq details')].map((d) => [d.querySelector('summary')!.textContent!.trim(), d.querySelector('p')!.textContent!.trim()]);
    const structured = node('FAQPage').mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text]);
    expect(structured).toEqual(visible);
  });

  it('lists the how-to steps in order, one per step of the app', () => {
    const steps = node('HowTo').step;
    expect(steps.map((s: any) => s.position)).toEqual(steps.map((_: unknown, i: number) => i + 1));
    expect(steps.map((s: any) => s.name)).toEqual(['放入檔案', '檢查標記', '下載']);
  });
});
