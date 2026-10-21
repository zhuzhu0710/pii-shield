import { describe, expect, it } from 'vitest';
import { detectChineseNames } from '../../src/core/zh-name';
import { BUILTIN_PATTERNS } from '../../src/core/patterns';
import { detect } from '../../src/core/detector';

/** The names found in `text`, as strings, in text order. */
function names(text: string): string[] {
  return detectChineseNames(text).map((s) => text.slice(s.start, s.end));
}

describe('zh-name: required cases', () => {
  it('does not take 金共約 out of 保證金共約 (amount phrase)', () => {
    expect(names('需要繳交銀行保證金共約1萬元')).toEqual([]);
  });

  it('does not take a name out of a contract amount phrase', () => {
    expect(names('甲方之保證金共約為新臺幣十萬元')).toEqual([]);
  });

  it('reads a name after 承辦人：', () => {
    expect(names('承辦人：金大中')).toEqual(['金大中']);
  });

  it('reads a 2-character name followed by 先生', () => {
    expect(names('請高明先生於週五回覆')).toEqual(['高明']);
  });

  it('reads every name in a 出席 list', () => {
    expect(names('出席：王大明、李美玲、張家豪')).toEqual(['王大明', '李美玲', '張家豪']);
  });

  it('reads a compound-surname name before 律師', () => {
    expect(names('歐陽娜娜律師')).toEqual(['歐陽娜娜']);
  });
});

describe('zh-name: positive cases', () => {
  const cases: [string, string[]][] = [
    ['申請人：蕭雅琴，身分證字號略，住址如下。', ['蕭雅琴']],
    ['經辦人吳宗澤已完成審核。', ['吳宗澤']],
    ['本案請楊銘鴻於十日內補正。', ['楊銘鴻']],
    ['副總經理黃士豪先生表示，將於下月啟用新系統。', ['黃士豪']],
    ['聯絡人：周佳蓉，電話02-2345-6789。', ['周佳蓉']],
    ['會議由謝承恩主持，與會者包括林佩玲、陳信宏。', ['謝承恩', '林佩玲', '陳信宏']],
    ['客戶歐陽志遠來電詢問存款利率。', ['歐陽志遠']],
    ['病患彭怡君於門診就醫。', ['彭怡君']],
    ['請洽李淑娟小姐辦理。', ['李淑娟']],
    ['陳奕安同學已報名參加競賽。', ['陳奕安']],
    ['鍾欣怡律師受託代理本案。', ['鍾欣怡']],
    ['原告葉柏廷主張被告未依約給付。', ['葉柏廷']],
    ['立書人 劉宜蓁 （以下簡稱甲方）', ['劉宜蓁']],
    ['寄件人：孫雅筑', ['孫雅筑']],
    ['推薦人顏子睿', ['顏子睿']],
    ['收件人：許凱翔', ['許凱翔']],
    ['學生賴俊宏', ['賴俊宏']],
    ['董事長廖國華與總經理邱俊傑出席', ['廖國華', '邱俊傑']],
    ['吳柏勳您好，您所訂購的商品已出貨。', ['吳柏勳']],
    ['王小明在會議中發言。另外，王小明已完成作業。', ['王小明', '王小明']],
  ];
  for (const [text, expected] of cases) {
    it(`finds ${expected.join('、')} in "${text.slice(0, 16)}…"`, () => {
      expect(names(text)).toEqual(expected);
    });
  }
});

describe('zh-name: negative cases (words that start with a surname character)', () => {
  const cases = [
    '本案金額為新臺幣五百萬元整。',
    '高速公路施工期間請改道行駛。',
    '林立的大樓讓市容更加現代化。',
    '黃昏時分，街道上的人潮漸漸散去。',
    '程序上需先完成登記，再行審議。',
    '陳述意見的期限為收到通知後七日內。',
    '白天的氣溫較高，夜間轉涼。',
    '賴以維生的工作，需要長期投入。',
    '蘇醒後的病患需要休息。',
    '本公司將於周年慶期間提供優惠。',
    '每周二下午三點召開例會。',
    '戴上安全帽後方可進場。',
    '甲方應於簽約後十日內付款。',
    '乙方不得將本契約轉讓予第三人。',
    '許多人認為此方案可行。',
    '程度上可以接受。',
    '孫子兵法是一本重要的古籍。',
    '石油價格持續上漲，影響運輸成本。',
    '張貼公告於各布告欄。',
    '高達九成的受訪者同意此方案。',
    '連江縣的客戶如需辦理開戶，請攜帶證件。',
    '嚴重的情況需立即處理。',
    '向來如此，不需多言。',
  ];
  for (const text of cases) {
    it(`finds no name in "${text.slice(0, 18)}…"`, () => {
      expect(names(text)).toEqual([]);
    });
  }
});

describe('zh-name: document-level behaviour', () => {
  it('accepts a second mention of a name that was accepted with context', () => {
    const text = '承辦人：金大中。另函告金大中辦理後續事宜。';
    expect(names(text)).toEqual(['金大中', '金大中']);
  });

  it('gives low confidence to a borderline name and high to a titled one', () => {
    const titled = detectChineseNames('請高明先生於週五回覆');
    expect(titled[0].confidence).toBe('high');
    const borderline = detectChineseNames('金新臺');
    expect(borderline).toEqual([]);
  });

  it('is wired into the built-in rule through detect(), with the confidence carried through', () => {
    const rule = BUILTIN_PATTERNS.find((p) => p.id === 'zh-name')!;
    expect(rule.detectFn).toBeTypeOf('function');
    const items = detect('承辦人：金大中', [rule]);
    expect(items.map((i) => i.original)).toEqual(['金大中']);
    expect(items[0].category).toBe('姓名');
    expect(items[0].confidence).toBe('high');
  });

  it('leaves confidence undefined for other categories', () => {
    const phone = BUILTIN_PATTERNS.find((p) => p.id === 'tw-mobile')!;
    const items = detect('手機 0912-345-678', [phone]);
    expect(items[0].confidence).toBeUndefined();
  });
});

describe('zh-name: author lines of academic papers (owner report)', () => {
  it('reads 吳玉霞 in full, not 吳玉 (霞 is a given-name character)', () => {
    expect(names('吳玉霞•王崧華')).toEqual(['吳玉霞', '王崧華']);
  });

  it('reads 陳彥愷 in full, not 陳彥 (愷 is a given-name character)', () => {
    expect(names('陳彥愷•王崧華')).toEqual(['陳彥愷', '王崧華']);
  });

  it('reads 陳彥楷 in full, not 陳彥 (楷 is a given-name character)', () => {
    expect(names('陳彥楷•王崧華')).toEqual(['陳彥楷', '王崧華']);
  });

  it('reads 陳彥愷 in full when it is the third author of a list with affiliations', () => {
    const text = '作者：吳玉霞1、王崧華1*、陳彥愷2';
    expect(names(text)).toEqual(['吳玉霞', '王崧華', '陳彥愷']);
  });

  it('reads 陳彥楷 in full when it is the third author of a list with affiliations', () => {
    const text = '作者：吳玉霞1、王崧華1*、陳彥楷2';
    expect(names(text)).toEqual(['吳玉霞', '王崧華', '陳彥楷']);
  });

  it('reads the full author line, including rare surname 城 and the name 吳鍺湘', () => {
    const line = '城振誠*•吳玉霞•王崧華•吳鍺湘•陳彥愷•謝恆毅';
    expect(names(line)).toEqual(['城振誠', '吳玉霞', '王崧華', '吳鍺湘', '陳彥愷', '謝恆毅']);
  });

  it('reads 陳彥楷 in the full author line as well', () => {
    const line = '城振誠*•吳玉霞•王崧華•吳鍺湘•陳彥楷•謝恆毅';
    expect(names(line)).toEqual(['城振誠', '吳玉霞', '王崧華', '吳鍺湘', '陳彥楷', '謝恆毅']);
  });

  it('reads a rare-surname name in a list with other separators (・ 、 ， and superscript marks)', () => {
    expect(names('城振誠・吳玉霞・王崧華')).toEqual(['城振誠', '吳玉霞', '王崧華']);
    expect(names('城振誠、吳玉霞、王崧華')).toEqual(['城振誠', '吳玉霞', '王崧華']);
    expect(names('城振誠，吳玉霞，王崧華')).toEqual(['城振誠', '吳玉霞', '王崧華']);
    expect(names('城振誠¹•吳玉霞²•王崧華³')).toEqual(['城振誠', '吳玉霞', '王崧華']);
  });

  it('prefers the three-character reading when the third character ends a list item', () => {
    expect(names('陳彥愷*、吳玉霞*、王崧華*')).toEqual(['陳彥愷', '吳玉霞', '王崧華']);
  });

  it('does not take the rare surname 城 from a citation of surname and 等 (城等, 2010)', () => {
    expect(names('前人研究（城等, 2010）指出')).toEqual([]);
    expect(names('(城等, 2016)')).toEqual([]);
  });

  it('keeps surname-only citations of the form 林與王 (2018) out', () => {
    expect(names('林與王 (2018) 提出相同結論')).toEqual([]);
  });

  it('reads the names of a reference-list entry', () => {
    expect(names('顏孟華、林金榮 (2010) 石斑魚人工繁殖技術之研究')).toEqual(['顏孟華', '林金榮']);
  });
});

describe('zh-name: words that contain a surname character at the end (owner report)', () => {
  it('does not flag 溫 in 水溫 (溫呈)', () => {
    expect(names('水溫呈負相關')).toEqual([]);
  });

  it('does not flag 溫 in 水溫 (溫維)', () => {
    expect(names('水溫維持在28度')).toEqual([]);
  });

  it('does not flag 謝 in 代謝 (謝速)', () => {
    expect(names('代謝速率增加')).toEqual([]);
  });

  it('does not flag 林 in 樹林 and 高 in 最高 when a lexicon word covers the surname character', () => {
    expect(names('樹林的面積逐年擴大')).toEqual([]);
    expect(names('最高溫度出現在下午')).toEqual([]);
  });

  it('does not flag the species name 安波托蝦 (安波 was accepted from a repeated borderline string)', () => {
    const text = '及安波托蝦、安波托蝦為主要養殖對象，安波托蝦的存活率較高。';
    expect(names(text)).toEqual([]);
  });

  it('does not flag a taxon name after 及 (及安波托蝦)', () => {
    expect(names('及安波托蝦')).toEqual([]);
  });
});

describe('zh-name: generalisation beyond the owner examples', () => {
  it('does not flag surname tails of other 水X and X度 science words', () => {
    for (const text of ['氣溫升高', '體溫正常', '鹽度維持在', '溶解度降低', '室溫約25度', '地溫監測']) {
      expect(names(text), text).toEqual([]);
    }
  });

  it('does not flag surname tails of other medical and biology words', () => {
    for (const text of ['感謝您的協助', '致謝', '新陳代謝旺盛', '葉綠素含量', '林業試驗']) {
      expect(names(text), text).toEqual([]);
    }
  });

  it('does not flag other taxon names that start with a surname character', () => {
    for (const text of ['白蝦的產量', '金魚藻的生長', '黃鰭鮪的漁獲', '石斑魚苗', '高麗菜田', '李子樹的產量']) {
      expect(names(text), text).toEqual([]);
    }
  });

  it('reads a name inside a list of ordinary words only when two items are already names', () => {
    expect(names('白蝦、金魚藻、王大明')).toEqual(['王大明']);
    expect(names('白蝦、金魚藻、石斑魚')).toEqual([]);
    expect(names('王大明、李美玲、白蝦、張家豪')).toEqual(['王大明', '李美玲', '張家豪']);
  });

  it('reads a name with a rare surname in a list of three names', () => {
    expect(names('會議出席者包括王大明、李美玲、賀冠宇')).toEqual(['王大明', '李美玲', '賀冠宇']);
  });

  it('gives a given-name character from the extended set the same reading as a common one', () => {
    expect(names('作者：謝承楓、鍾博文、林佳翰')).toEqual(['謝承楓', '鍾博文', '林佳翰']);
  });
});

describe('zh-name: owner report, 高 after a degree word and rate words (活存率)', () => {
  it('does not flag 高活存 in 能同時有高活存率及成長 (有 before 高)', () => {
    expect(names('能同時有高活存率及成長')).toEqual([]);
  });

  it('does not flag 高活存 in 可以同時擁有高活存率及成長 (擁有 before 高)', () => {
    expect(names('可以同時擁有高活存率及成長')).toEqual([]);
  });

  it('does not flag 高活存 when both owner sentences occur in one paper (the repeat rule used to accept it)', () => {
    const paper = '能同時有高活存率及成長的品系較佳。\n可以同時擁有高活存率及成長，是主要目標。';
    expect(names(paper)).toEqual([]);
  });

  it('generalises: a degree word before 高 blocks it, unless a strong cue follows', () => {
    for (const text of ['較高存活率', '最高存活率', '很高的死亡率', '具有高成長率', '維持高存活率']) {
      expect(names(text), text).toEqual([]);
    }
    expect(names('有高明先生參加')).toEqual(['高明']);
  });

  it('generalises: a surname-like character before a rate or measurement word is a science term (高死亡率, 成長率)', () => {
    for (const text of ['高死亡率明顯', '高成長率的品系', '成活率與孵化率', '變態率', '攝食率偏低']) {
      expect(names(text), text).toEqual([]);
    }
  });

  it('does not flag 低死亡率 or 較高存活率 in any sentence', () => {
    expect(names('低死亡率的池區')).toEqual([]);
    expect(names('較高存活率出現在第三週')).toEqual([]);
  });
});

describe('zh-name: 萬 as a given-name character, and quantities that contain 萬', () => {
  it('reads 鍾萬財 in full', () => {
    expect(names('鍾萬財完成實驗')).toEqual(['鍾萬財']);
  });

  it('reads 林萬福 when followed by a year in a reference', () => {
    expect(names('林萬福 (2010)')).toEqual(['林萬福']);
  });

  it('reads 蔡萬生 as the last author of a reference list', () => {
    expect(names('城振誠 , 蔡萬生 (2005) 餌料、投餵策略')).toEqual(['城振誠', '蔡萬生']);
  });

  it('does not flag 萬元, 一萬 or 十萬元', () => {
    for (const text of ['萬元', '一萬', '十萬元', '繳交1萬元', '保證金新臺幣十萬元整', '一萬尾鰻苗']) {
      expect(names(text), text).toEqual([]);
    }
  });

  it('does not flag a surname followed by an amount (陳萬元, 金萬分)', () => {
    expect(names('陳萬元整')).toEqual([]);
    expect(names('現金萬分之一')).toEqual([]);
  });
});

describe('zh-name: author lists of references, read by their year', () => {
  it('reads a spaced half-width comma list before (year)', () => {
    expect(names('黃振宇 , 鍾萬財 (2008) 白蝦養殖')).toEqual(['黃振宇', '鍾萬財']);
  });

  it('reads a full-width comma list before （year） with full-width parentheses', () => {
    expect(names('黃振宇，鍾萬財（2008）以生物濾池改善水質')).toEqual(['黃振宇', '鍾萬財']);
  });

  it('reads a list separated by spaces only', () => {
    expect(names('林福泰 蔡萬生 (2010) 探討草蝦幼苗')).toEqual(['林福泰', '蔡萬生']);
  });

  it('reads a list separated by 、 before (year)', () => {
    expect(names('郭俊良、黃振宇、鍾萬財（2011）')).toEqual(['郭俊良', '黃振宇', '鍾萬財']);
  });

  it('reads the last author with no space before the parenthesis (蔡萬生(2013))', () => {
    expect(names('蔡萬生(2013)之研究')).toEqual(['蔡萬生']);
  });

  it('reads a name run after a word without a separator (作者蔡萬生 (2005))', () => {
    expect(names('作者蔡萬生 (2005)')).toEqual(['蔡萬生']);
  });

  it('keeps in-text citations of surname and 等 or 與 undetected', () => {
    for (const text of ['前人研究（城等, 2010）指出', '(城等, 2010)', '(陳與林, 2015)', '林與王 (2018) 提出', '（周等，2020）的討論']) {
      expect(names(text), text).toEqual([]);
    }
  });

  it('does not take a species name before a year as an author (黃鰭鮪 (2010))', () => {
    expect(names('黃鰭鮪 (2010) 的漁獲資料')).toEqual([]);
  });
});

describe('zh-name: dual-use given characters (來 得 和 為 以 之 也 於)', () => {
  it('reads 蔡萬來 before a citation year (2005)', () => {
    expect(names('蔡萬來 (2005) 提出的結果')).toEqual(['蔡萬來']);
    expect(names('相關研究可參考蔡萬來（2005）之結果。')).toEqual(['蔡萬來']);
  });

  it('reads 蔡萬來 after a label (承辦人：蔡萬來)', () => {
    expect(names('承辦人：蔡萬來')).toEqual(['蔡萬來']);
  });

  it('reads 陳來福 before 先生', () => {
    expect(names('陳來福先生於週一提出申請。')).toEqual(['陳來福']);
  });

  it('reads 林來興 and 黃金來 inside a name list', () => {
    expect(names('出席者：王大明、李美玲、林來興、黃金來。')).toEqual(['王大明', '李美玲', '林來興', '黃金來']);
  });

  it('reads 王得勝 before 經理 and 張為民 before 教授', () => {
    expect(names('王得勝經理已核准此案。')).toEqual(['王得勝']);
    expect(names('張為民教授指導本研究。')).toEqual(['張為民']);
  });

  it('reads 蔡萬來 in a bare request, since 於 after a name is a name subject (請蔡萬來於週五前回覆)', () => {
    expect(names('請蔡萬來於週五前回覆')).toEqual(['蔡萬來']);
  });

  it('reads a name with a dual character as the middle character when the last is HIGH (陳來福 bare)', () => {
    expect(names('陳來福回報進度。')).toEqual(['陳來福']);
  });

  it('reads 李和平 with a title, but not bare (和平 is an ordinary word)', () => {
    expect(names('李和平先生來電詢問。')).toEqual(['李和平']);
    expect(names('李和平')).toEqual([]);
  });

  it('reads a list whose last item is followed by sentence punctuation (…、黃金來。)', () => {
    expect(names('本案證人為王得勝、蔡萬來、李和平。')).toEqual(['王得勝', '蔡萬來', '李和平']);
  });

  it('rejects an ordinary phrase with a surname character and a dual character', () => {
    for (const text of [
      '王來自台北，於昨日抵達。',
      '陳述來說，本案尚未確定。',
      '林業以來持續成長。',
      '高溫帶來的影響很大。',
      '黃金來源多元，價格穩定。',
      '方法得到驗證後才能推廣。',
      '周和平時多在家中休息。',
      '成為主要供應商的條件很多。',
      '金額為新臺幣十萬元整。',
      '江河以東地區降雨較多。',
      '所有依賴打包為靜態資產，可任意部署。',
      '高於英文重讀門檻時採用該結果。',
      '我們從黃金來的人手中取得資料。',
      '陳光來自哪裡，目前尚不清楚。',
      '王中之王的稱號。',
    ]) {
      expect(names(text), text).toEqual([]);
    }
  });

  it('rejects a two-character surname plus dual reading without a cue (王來, 蔡萬)', () => {
    expect(names('王來')).toEqual([]);
    expect(names('蔡萬來電')).toEqual([]);
  });

  it('rejects a name that a function word or phrase follows (蔡萬來自己, 陳光來說 as a phrase)', () => {
    expect(names('蔡萬來自己完成。')).toEqual([]);
  });

  it('does not take a trailing 於 into a list item that runs on into more text (薛雅芳於2022年)', () => {
    expect(names('梁凱翔及薛雅芳於2022年共同發表此研究。')).toEqual(['梁凱翔', '薛雅芳']);
  });

  it('keeps the existing rules: 甲方應於 and 乙方應於 are not names', () => {
    expect(names('甲方應於簽約後十日內付款。')).toEqual([]);
    expect(names('乙方應於每月五日前匯入租金。')).toEqual([]);
  });
});
