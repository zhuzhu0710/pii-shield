/**
 * Evaluates the personal-name detector on a labeled dataset (tests/name-eval/*.jsonl).
 *
 * Usage: npx tsx scripts/eval-names.ts <file.jsonl> [--json]
 *
 * Only the builtin pattern(s) with category 姓名 are used. Matching is at mention level:
 * - gold occurrences = every position where a listed name string occurs in the text;
 * - exact TP = a predicted span with the same start and end as a gold occurrence;
 * - partial = a predicted span that overlaps a gold occurrence without being exact (counts as FP and FN);
 * - FP = every predicted span that is not an exact TP; FN = every gold occurrence not exactly matched.
 *
 * To test another engine, change detectNames() only.
 */
import { readFileSync } from 'node:fs';
import { detect } from '../src/core/detector';
import { getEffectivePatterns } from '../src/core/pattern-store';

const NAME_PATTERNS = getEffectivePatterns({ version: 1, disabledBuiltins: [], customPatterns: [] }).filter(
  (p) => p.category === '姓名',
);

/** The only place the engine is called. Returns predicted name spans as [start, end) offsets. */
export function detectNames(text: string): { start: number; end: number }[] {
  return detect(text, NAME_PATTERNS).map((it) => ({ start: it.start, end: it.end }));
}

interface Item {
  id: string;
  domain: string;
  text: string;
  names: string[];
}

interface Counts {
  items: number;
  chars: number;
  gold: number;
  pred: number;
  tp: number;
  fp: number;
  fn: number;
  partialPred: number;
  partialGold: number;
}

const zero = (): Counts => ({ items: 0, chars: 0, gold: 0, pred: 0, tp: 0, fp: 0, fn: 0, partialPred: 0, partialGold: 0 });

function add(a: Counts, b: Counts): void {
  for (const k of Object.keys(a) as (keyof Counts)[]) a[k] += b[k];
}

function metrics(c: Counts) {
  const precision = c.pred ? c.tp / c.pred : NaN;
  const recall = c.gold ? c.tp / c.gold : NaN;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : NaN;
  const fpPer1000 = c.chars ? (c.fp / c.chars) * 1000 : NaN;
  return { precision, recall, f1, fpPer1000 };
}

interface FpRecord {
  id: string;
  domain: string;
  value: string;
  partial: boolean;
}

interface FnRecord {
  id: string;
  name: string;
}

function evaluate(items: Item[]) {
  const total = zero();
  const byDomain = new Map<string, Counts>();
  const fpCounts = new Map<string, { count: number; partial: number }>();
  const fnCounts = new Map<string, number>();
  const fps: FpRecord[] = [];
  const fns: FnRecord[] = [];

  for (const it of items) {
    const c = zero();
    c.items = 1;
    c.chars = it.text.length;
    const gold: { start: number; end: number; name: string; hit: boolean }[] = [];
    for (const name of it.names) {
      let i = it.text.indexOf(name);
      while (i >= 0) {
        gold.push({ start: i, end: i + name.length, name, hit: false });
        i = it.text.indexOf(name, i + 1);
      }
    }
    c.gold = gold.length;
    const preds = detectNames(it.text);
    c.pred = preds.length;

    for (const p of preds) {
      const value = it.text.slice(p.start, p.end);
      const exact = gold.find((g) => !g.hit && g.start === p.start && g.end === p.end);
      if (exact) {
        exact.hit = true;
        c.tp++;
        continue;
      }
      const overlaps = gold.some((g) => p.start < g.end && g.start < p.end);
      c.fp++;
      if (overlaps) c.partialPred++;
      fps.push({ id: it.id, domain: it.domain, value, partial: overlaps });
      const e = fpCounts.get(value) ?? { count: 0, partial: 0 };
      e.count++;
      if (overlaps) e.partial++;
      fpCounts.set(value, e);
    }
    for (const g of gold) {
      if (g.hit) continue;
      c.fn++;
      const overlapsPred = preds.some((p) => p.start < g.end && g.start < p.end);
      if (overlapsPred) c.partialGold++;
      fns.push({ id: it.id, name: g.name });
      fnCounts.set(g.name, (fnCounts.get(g.name) ?? 0) + 1);
    }

    add(total, c);
    const d = byDomain.get(it.domain) ?? zero();
    add(d, c);
    byDomain.set(it.domain, d);
  }
  return { total, byDomain, fpCounts, fnCounts, fps, fns };
}

function pct(x: number): string {
  return Number.isNaN(x) ? 'n/a' : (x * 100).toFixed(1) + '%';
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length !== 1) {
    console.error('usage: npx tsx scripts/eval-names.ts <file.jsonl> [--json]');
    process.exit(2);
  }
  const items: Item[] = readFileSync(files[0], 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Item);
  const r = evaluate(items);
  const m = metrics(r.total);

  if (asJson) {
    const domains = Object.fromEntries(
      [...r.byDomain].map(([d, c]) => [d, { ...c, ...metrics(c) }]),
    );
    console.log(
      JSON.stringify(
        {
          file: files[0],
          totals: { ...r.total, ...m },
          domains,
          topFalsePositives: [...r.fpCounts].sort((a, b) => b[1].count - a[1].count).slice(0, 50).map(([value, v]) => ({ value, count: v.count, partial: v.partial })),
          topFalseNegatives: [...r.fnCounts].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([name, count]) => ({ name, count })),
          falsePositives: r.fps,
          falseNegatives: r.fns,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`file: ${files[0]}`);
  console.log(`items ${r.total.items}, chars ${r.total.chars}, gold mentions ${r.total.gold}, predicted ${r.total.pred}`);
  console.log(`TP ${r.total.tp}  FP ${r.total.fp} (partial ${r.total.partialPred})  FN ${r.total.fn} (partial ${r.total.partialGold})`);
  console.log(`precision ${pct(m.precision)}  recall ${pct(m.recall)}  F1 ${pct(m.f1)}  FP per 1000 chars ${m.fpPer1000.toFixed(2)}`);

  console.log('\nper domain (domain  items  TP  FP  FN  precision  recall  F1  FP/1000ch):');
  for (const [d, c] of [...r.byDomain].sort((a, b) => b[1].items - a[1].items)) {
    const dm = metrics(c);
    console.log(
      `  ${d.padEnd(12)} ${String(c.items).padStart(4)} ${String(c.tp).padStart(4)} ${String(c.fp).padStart(4)} ${String(c.fn).padStart(4)}  ${pct(dm.precision).padStart(7)}  ${pct(dm.recall).padStart(7)}  ${pct(dm.f1).padStart(7)}  ${dm.fpPer1000.toFixed(2)}`,
    );
  }

  console.log('\ntop 50 false positives (string  count  of which partial):');
  for (const [value, v] of [...r.fpCounts].sort((a, b) => b[1].count - a[1].count).slice(0, 50)) {
    console.log(`  ${value}  ${v.count}  ${v.partial}`);
  }

  console.log('\ntop false negatives (name  missed occurrences):');
  for (const [name, n] of [...r.fnCounts].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${name}  ${n}`);
  }
}

main();
