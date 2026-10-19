# Chinese personal-name detector: baseline

Measured with the original detector (`zh-name` in `src/core/patterns.ts`, run through `detect()` in `src/core/detector.ts`; neither file is changed by this work). Only patterns with category 姓名 are used.

Reproduce:

```
npx tsx scripts/eval-names.ts tests/name-eval/dev.jsonl
npx tsx scripts/eval-names.ts /home/claude/heldout/heldout.jsonl
npx tsx scripts/validate-name-dataset.ts tests/name-eval/dev.jsonl /home/claude/heldout/heldout.jsonl
```

Matching is at mention level: a predicted span is a true positive only if its start and end equal a gold occurrence. Partial matches (overlap without exact match) count as both FP and FN and are shown in parentheses.

## Metrics

| set | items | gold mentions | predicted | TP | FP (partial) | FN (partial) | precision | recall | F1 | FP / 1000 chars |
|---|---|---|---|---|---|---|---|---|---|---|
| dev | 232 | 121 | 157 | 104 | 53 (5) | 17 (5) | 66.2% | 86.0% | 74.8% | 7.74 |
| heldout | 231 | 115 | 157 | 100 | 57 (3) | 15 (3) | 63.7% | 87.0% | 73.5% | 8.33 |
| combined | 463 | 236 | 314 | 204 | 110 (8) | 32 (8) | 65.0% | 86.4% | 74.2% | 8.04 |

Characters: 6,844 in each set (checked independently), 13,688 combined.

## Is 「金共約」 flagged?

Yes. The required sentence 「需要繳交銀行保證金共約1萬元」 (heldout `h051`) is flagged with the span 金共約. The same span is also flagged in heldout `h199` (「甲方之保證金共約為新臺幣十萬元」). Both are FP.

## Per domain (combined)

| domain | items | FP | precision | recall | FP / 1000 chars |
|---|---|---|---|---|---|
| bank | 70 | 15 | 59.5% | 81.5% | 9.72 |
| contract | 63 | 18 | 64.0% | 80.0% | 11.26 |
| government | 50 | 15 | 57.1% | 95.2% | 11.62 |
| news | 46 | 12 | 60.0% | 100.0% | 9.22 |
| school | 42 | 10 | 63.0% | 81.0% | 9.06 |
| medical | 37 | 5 | 77.3% | 100.0% | 5.43 |
| minutes | 36 | 5 | 78.3% | 100.0% | 5.52 |
| email | 36 | 5 | 76.2% | 94.1% | 5.01 |
| hr | 35 | 9 | 64.0% | 88.9% | 10.16 |
| realestate | 34 | 5 | 58.3% | 50.0% | 5.59 |
| document | 14 | 11 | 65.6% | 84.0% | 4.90 |

## Top 15 false positives (combined, both sets)

| # | span | count | of which partial |
|---|---|---|---|
| 1 | 程序 | 6 | 0 |
| 2 | 程表 | 2 | 0 |
| 3 | 金新臺 | 2 | 0 |
| 4 | 易方式 | 2 | 0 |
| 5 | 連江縣 | 2 | 0 |
| 6 | 嚴重 | 2 | 0 |
| 7 | 金共約 | 2 | 0 |
| 8 | 方制度 | 1 | 0 |
| 9 | 周一舉 | 1 | 0 |
| 10 | 謝所 | 1 | 0 |
| 11 | 向人事 | 1 | 0 |
| 12 | 張權利 | 1 | 0 |
| 13 | 嚴格 | 1 | 0 |
| 14 | 向管轄 | 1 | 0 |
| 15 | 高達九 | 1 | 0 |

Nearly all false positives are words that begin with a surname character followed by ordinary text (程, 向, 方, 金, 易, 嚴, 高, 張, 周, 謝...). The full list with item ids is printed by `npx tsx scripts/eval-names.ts <file> --json`.

## Top false negatives (combined)

32 missed mentions. Groups:

- 2-character names (陳明, 楊文, 許豪, 程亮): the detector either does not match the 2-character form or takes one more character from the following text (楊文 becomes 楊文已, 許豪 becomes 許豪您), so the match is both a partial FP and a partial FN.
- Names the stoplist removes: 黃金生 (黃金 is on the stoplist), 葉子豪 and 葉子萱 (葉子 is on the stoplist).
- Compound-surname names such as 東方瑜 and 南宮若琳.
- Other 3-character names missed in some contexts (for example 黃文龍, 許哲維, 鄭秀英).

## Known limitations of the data

- Single author, one writing pass. Dev and heldout come from one pool that was split at random (seeded, stratified by domain). The heldout set is not written independently, so it measures sampling noise, not generalization to other writing styles.
- Names are fictitious but drawn from common Taiwanese names. No check was run against real person registries. Names that resembled well-known public figures were replaced by hand (陳冠希, 柯文瑞, 宋育仁).
- Only full names are labeled. Surname-only mentions (for example 「陳先生」 with no given name) are not in the data, so the detector's behavior on them is not measured.
- Trap occurrences (478 combined) are counted with a fixed word list in `scripts/validate-name-dataset.ts` (`TRAP_WORDS`). It is an approximate count.
- Name length: 221 distinct names, of which 204 are 3 characters, 10 are 2 characters, and 7 are 4 characters. 2-character names are underrepresented.
- 283 of 463 items are name-free. A pool-wide check found no name in any text that is missing from its list.
- Document-style items: 14 (7 per set), each 6 to 15 sentences with 1 to 4 names.
- Exact matching counts a predicted span at a shifted position as both FP and FN, so partial matches lower both precision and recall.
