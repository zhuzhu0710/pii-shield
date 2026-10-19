import { describe, expect, it } from 'vitest';
import type { MappingEntry } from '../../src/core/types';
import { restore } from '../../src/core/restorer';
import { restoreLoose } from '../../src/core/restorer';

const MAP: MappingEntry[] = [
  { code: 'a1b2c3', category: '姓名', original: '王小明' },
  { code: '0912ab', category: '手機', original: '0912-345-678' },
  { code: 'c3d4e5', category: '電子郵件', original: 'amy.chen@gmail.com' },
];

describe('restoreLoose: tolerated marker forms', () => {
  it('restores an exact marker exactly as restore() does', () => {
    const text = '個案 [姓名:a1b2c3] 的電話是 [手機:0912ab]。';
    expect(restoreLoose(text, MAP)).toEqual(restore(text, MAP));
    expect(restoreLoose(text, MAP).restoredText).toBe('個案 王小明 的電話是 0912-345-678。');
  });

  it('accepts full-width brackets and colon', () => {
    expect(restoreLoose('【姓名：a1b2c3】', MAP).restoredText).toBe('王小明');
    expect(restoreLoose('［姓名：a1b2c3］', MAP).restoredText).toBe('王小明');
  });

  it('accepts mixed bracket and colon styles', () => {
    expect(restoreLoose('【姓名:a1b2c3]', MAP).restoredText).toBe('王小明');
    expect(restoreLoose('[姓名：a1b2c3］', MAP).restoredText).toBe('王小明');
  });

  it('accepts extra spaces around the category, colon and code', () => {
    expect(restoreLoose('[ 姓名 : a1b2c3 ]', MAP).restoredText).toBe('王小明');
    expect(restoreLoose('[姓名: a1b2c3]', MAP).restoredText).toBe('王小明');
    expect(restoreLoose('[姓名：　a1b2c3　］', MAP).restoredText).toBe('王小明');
  });

  it('accepts uppercase hex codes', () => {
    expect(restoreLoose('[姓名:A1B2C3]', MAP).restoredText).toBe('王小明');
  });

  it('accepts markdown escaping of the brackets and colon', () => {
    expect(restoreLoose('\\[姓名:a1b2c3\\]', MAP).restoredText).toBe('王小明');
    expect(restoreLoose('\\[電子郵件\\:c3d4e5\\]', MAP).restoredText).toBe('amy.chen@gmail.com');
  });

  it('restores a marker wrapped in backticks and leaves the backticks in place', () => {
    expect(restoreLoose('`[姓名:a1b2c3]`', MAP).restoredText).toBe('`王小明`');
  });

  it('restores by code when the category is changed', () => {
    expect(restoreLoose('[name:a1b2c3]', MAP).restoredText).toBe('王小明');
    expect(restoreLoose('[Name: A1B2C3]', MAP).restoredText).toBe('王小明');
  });

  it('restores by code when the category is dropped', () => {
    expect(restoreLoose('聯絡人 [a1b2c3] 已確認', MAP).restoredText).toBe('聯絡人 王小明 已確認');
  });
});

describe('restoreLoose: must not replace text that only looks like a code', () => {
  it('leaves a 6-hex color or hash outside brackets alone', () => {
    const text = '按鈕顏色為 #a1b2c3，commit a1b2c3 已合併。';
    const result = restoreLoose(text, MAP);
    expect(result.restoredText).toBe(text);
    expect(result.restoredCount).toBe(0);
    expect(result.missingCodes).toEqual([]);
  });

  it('leaves a bare 6-hex code followed by a bracket-less label alone', () => {
    expect(restoreLoose('編號 a1b2c3:王小明', MAP).restoredCount).toBe(0);
  });

  it('does not treat a code with extra hex characters as a match', () => {
    expect(restoreLoose('[姓名:a1b2c3f]', MAP).restoredCount).toBe(0);
    expect(restoreLoose('[a1b2c3f]', MAP).restoredCount).toBe(0);
  });
});

describe('restoreLoose: partial retention', () => {
  it('keeps characters outside the marker, the same way restore() does', () => {
    const map: MappingEntry[] = [{ code: 'a1b2c3', category: '姓名', original: '小明', prefix: '王' }];
    const text = '王[姓名:a1b2c3] 來電';
    expect(restoreLoose(text, map).restoredText).toBe('王小明 來電');
    expect(restoreLoose(text, map)).toEqual(restore(text, map));
  });

  it('restores a loose partial marker whose kept character sits before a full-width bracket', () => {
    const map: MappingEntry[] = [{ code: 'a1b2c3', category: '姓名', original: '小明', prefix: '王' }];
    expect(restoreLoose('王【姓名：a1b2c3】', map).restoredText).toBe('王小明');
  });
});

describe('restoreLoose: unknown codes', () => {
  it('reports labelled codes that are not in the mapping, once each, and leaves them verbatim', () => {
    const text = '[姓名:ffffff] 與 [name:ffffff] 以及 [手機:123abc]';
    const result = restoreLoose(text, MAP);
    expect(result.missingCodes).toEqual(['ffffff', '123abc']);
    expect(result.restoredText).toBe(text);
    expect(result.restoredCount).toBe(0);
  });

  it('does not report a bare bracketed hex code that is not in the mapping', () => {
    const result = restoreLoose('參考 [ffffff] 條款', MAP);
    expect(result.missingCodes).toEqual([]);
    expect(result.restoredText).toBe('參考 [ffffff] 條款');
  });

  it('matches codes case-insensitively against the mapping and reports none missing', () => {
    const result = restoreLoose('[姓名:A1B2C3] [手機:0912AB]', MAP);
    expect(result.missingCodes).toEqual([]);
    expect(result.restoredCount).toBe(2);
  });
});

describe('restoreLoose: mixed realistic reply', () => {
  it('restores every recognised marker in a pasted AI paragraph and reports only the unknown one', () => {
    const reply =
      '您好，根據您提供的資料，[姓名:a1b2c3] 的聯絡電話為 `[手機:0912ab]`，' +
      '電子郵件是 \\[電子郵件：c3d4e5\\]。另外 #a1b2c3 是網頁的按鈕顏色，' +
      '而【Name：ffffff】這筆資料我找不到，請再確認。';
    const result = restoreLoose(reply, MAP);

    expect(result.restoredText).toBe(
      '您好，根據您提供的資料，王小明 的聯絡電話為 `0912-345-678`，' +
        '電子郵件是 amy.chen@gmail.com。另外 #a1b2c3 是網頁的按鈕顏色，' +
        '而【Name：ffffff】這筆資料我找不到，請再確認。',
    );
    expect(result.restoredCount).toBe(3);
    expect(result.missingCodes).toEqual(['ffffff']);
  });
});
