/**
 * Validates name-evaluation datasets (tests/name-eval/*.jsonl style) and prints totals.
 *
 * Usage: npx tsx scripts/validate-name-dataset.ts <file.jsonl> [more.jsonl ...]
 *
 * Checks per line: parses as JSON; fields id/domain/text/names present with the right types;
 * ids unique across all given files; names are distinct, 2–4 characters, and each occurs in text;
 * document-domain items have 6–15 sentences. Exits 1 on any error.
 */
import { readFileSync } from 'node:fs';

interface Item {
  id: string;
  domain: string;
  text: string;
  names: string[];
}

/**
 * Trap words: common words or places/organisations that contain a surname character and must not be
 * flagged as names. Used only to report how many trap occurrences a dataset contains.
 */
export const TRAP_WORDS = [
  '保證金共約', '黃金', '金額', '高雄', '高達', '林業', '方案', '方法', '雙方', '甲方', '乙方', '許多', '何時',
  '陳述', '曾經', '余額', '簡報', '江湖', '王國', '周年', '周邊', '田地', '石油', '白天', '文件', '史上', '全部',
  '成本', '程度', '溫度', '安全', '常用', '強調', '施工', '連續', '包括', '和平', '于是', '范圍', '易於', '羅列',
  '馬上', '洪水', '湯匙', '葉片', '萬元', '毛利', '杜絕', '魏晉', '高中', '高度', '林口', '金融', '金屬', '金錢',
  '黃色', '白色', '江西', '文化', '程式', '任何', '古代', '紀念', '連結', '官方', '包含', '包裝', '管理', '方式',
  '台中市', '高雄市', '花蓮', '宜蘭', '金門', '連江', '周末', '白血', '程序', '謝謝', '游泳', '張貼', '凌晨',
  '康復', '鄭重', '方向', '方面', '向來', '安裝', '安排', '舒服', '管制', '毛巾', '牛肉', '孫子',
];

export function validate(files: string[]): { items: Item[]; byFile: Map<string, Item[]>; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  const byFile = new Map<string, Item[]>();
  const items: Item[] = [];
  for (const file of files) {
    const out: Item[] = [];
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!line.trim()) return;
      const where = `${file}:${idx + 1}`;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        errors.push(`${where} does not parse: ${(e as Error).message}`);
        return;
      }
      const it = obj as Partial<Item>;
      if (typeof it.id !== 'string' || !it.id) errors.push(`${where} missing id`);
      if (typeof it.domain !== 'string' || !it.domain) errors.push(`${where} missing domain`);
      if (typeof it.text !== 'string' || !it.text) errors.push(`${where} missing text`);
      if (!Array.isArray(it.names) || it.names.some((n) => typeof n !== 'string')) {
        errors.push(`${where} names must be an array of strings`);
        return;
      }
      if (typeof it.id !== 'string' || typeof it.text !== 'string' || typeof it.domain !== 'string') return;
      if (ids.has(it.id)) errors.push(`${where} duplicate id ${it.id}`);
      ids.add(it.id);
      const names = it.names;
      if (new Set(names).size !== names.length) errors.push(`${where} ${it.id}: duplicate name in names`);
      for (const n of names) {
        const len = Array.from(n).length;
        if (len < 2 || len > 4) errors.push(`${where} ${it.id}: name "${n}" has length ${len}`);
        if (!it.text.includes(n)) errors.push(`${where} ${it.id}: name "${n}" does not occur in text`);
      }
      for (const a of names) for (const b of names) if (a !== b && a.includes(b)) errors.push(`${where} ${it.id}: name "${b}" is inside "${a}"`);
      if (it.domain === 'document') {
        const sentences = (it.text.match(/[。！？]/g) ?? []).length;
        if (sentences < 6 || sentences > 15) errors.push(`${where} ${it.id}: document has ${sentences} sentences`);
      }
      const item: Item = { id: it.id, domain: it.domain, text: it.text, names };
      out.push(item);
      items.push(item);
    });
    byFile.set(file, out);
  }
  return { items, byFile, errors };
}

function countTraps(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of TRAP_WORDS) {
    let n = 0;
    for (const t of texts) n += t.split(w).length - 1;
    if (n) counts.set(w, n);
  }
  return counts;
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: npx tsx scripts/validate-name-dataset.ts <file.jsonl> [more.jsonl ...]');
    process.exit(2);
  }
  const { items, byFile, errors } = validate(files);
  for (const [file, list] of byFile) {
    const domains = new Map<string, number>();
    for (const it of list) domains.set(it.domain, (domains.get(it.domain) ?? 0) + 1);
    const distinct = new Set(list.flatMap((it) => it.names));
    const traps = countTraps(list.map((it) => it.text));
    const trapTotal = [...traps.values()].reduce((a, b) => a + b, 0);
    console.log(`\n== ${file}`);
    printTotals(list, distinct.size, trapTotal, domains);
  }
  if (byFile.size > 1) {
    const domains = new Map<string, number>();
    for (const it of items) domains.set(it.domain, (domains.get(it.domain) ?? 0) + 1);
    const distinct = new Set(items.flatMap((it) => it.names));
    const trapTotal = [...countTraps(items.map((it) => it.text)).values()].reduce((a, b) => a + b, 0);
    console.log('\n== TOTAL (all files)');
    printTotals(items, distinct.size, trapTotal, domains);
  }
  if (errors.length) {
    console.log(`\n${errors.length} error(s):`);
    for (const e of errors) console.log('  ' + e);
    process.exit(1);
  }
  console.log('\nOK: no errors');
}

function printTotals(list: Item[], distinctNames: number, trapTotal: number, domains: Map<string, number>): void {
  const nameItems = list.filter((it) => it.names.length > 0).length;
  const mentions = list.reduce((a, it) => a + it.names.length, 0);
  console.log(`items: ${list.length} (with names: ${nameItems}, name-free: ${list.length - nameItems})`);
  console.log(`distinct real names: ${distinctNames}; name strings listed: ${mentions}`);
  console.log(`trap occurrences (TRAP_WORDS): ${trapTotal}`);
  console.log('items by domain:');
  for (const [d, n] of [...domains].sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(12)} ${n}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
