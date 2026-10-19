import type { Pattern } from './types';
import { isValidTaxId, isValidTwId } from './twid';
import { ibanLength, isBirthDate, isCardNumber, isIpv6, isSsn, phoneLength } from './intl';
import { detectChineseNames } from './zh-name';

const CJK = '\\u4e00-\\u9fa5';

export const CITIES =
  '(?:[臺台]北市|新北市|桃園市|[臺台]中市|[臺台]南市|高雄市|基隆市|新竹[市縣]|嘉義[市縣]|苗栗縣|彰化縣|南投縣|雲林縣|屏東縣|宜蘭縣|花蓮縣|[臺台]東縣|澎湖縣|金門縣|連江縣)';
const DISTRICT = `(?:[${CJK}]{1,4}[鄉鎮市區])?`;
const ROAD = `(?:[${CJK}\\d]{1,8}(?:路|街|大道))`;
const ADDRESS_TAIL =
  `(?:[${CJK}]{1,4}[村里])?(?:\\d{1,3}鄰)?` +
  `(?:[一二三四五六七八九十\\d]{1,3}段)?(?:\\d{1,4}巷)?(?:\\d{1,4}弄)?` +
  `\\d{1,5}(?:之\\d{1,3})?號(?:[\\d一二三四五六七八九十]{1,3}樓)?(?:之\\d{1,3})?(?:[${CJK}\\d]{1,3}室)?`;

const ADDRESS_REGEX =
  `(?:${CITIES}${DISTRICT}(?:[${CJK}]{1,4}[村里])?(?:\\d{1,3}鄰)?${ROAD}?` +
  `|(?<![${CJK}])${DISTRICT}${ROAD})` +
  ADDRESS_TAIL;

/** +886 numbers: area code with or without its 0 or brackets (mobiles, +886-9, are 手機). */
const TW_LANDLINE_INTL = '\\+886[-\\x20]?\\(?0?(?:826|836|82|89|37|49|[2-8])\\)?[-\\x20]?\\d{3,4}[-\\x20]?\\d{3,4}';

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
/**
 * A date of birth only counts right after a label saying so, on the same line (a table's next cell
 * counts, a column header above a list of dates does not); other dates are not personal data.
 */
const BIRTH_LABEL = '(?:DOB|D\\.O\\.B\\.?|[Dd]ate [Oo]f [Bb]irth|[Bb]irth ?[Dd]ate|[Bb]irthday|[Bb]orn(?: [Oo]n)?|出生日期|出生年月日|生日)';
const BIRTH_DATE =
  `(?<=${BIRTH_LABEL}[\\x20\\t]*[:：]?[\\x20\\t]*)(?:` +
  '(?:民國\\s*)?\\d{2,4}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日?' +
  '|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}' +
  '|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}' +
  `|${MONTH}\\.?\\x20+\\d{1,2}(?:st|nd|rd|th)?,?\\x20+\\d{4}` +
  `|\\d{1,2}(?:st|nd|rd|th)?\\x20+${MONTH}\\.?,?\\x20+\\d{4})`;

/** Organisation suffixes that reliably end a company name; bare 公司 is too ambiguous (本公司, 公司電話). */
const COMPANY_SUFFIX = '(?:股份有限公司|有限公司|無限公司|兩合公司|企業社|工作室|事務所|商行|診所|基金會|協會|合作社|工程行|企業行|實業社|文化事業)';
/** Characters that never start a company name but often precede one in prose. */
const COMPANY_NOT_FIRST = '的與和及於在由向從為對將把讓依據至到給經受同各該本貴我敝此其係即為者以並或如';
const COMPANY_REGEX = `(?:(?![${COMPANY_NOT_FIRST}])[${CJK}A-Za-z0-9&·]){2,14}?${COMPANY_SUFFIX}`;

const COMPOUND_SURNAMES = '歐陽|司馬|諸葛|上官|張簡|范姜|司徒|東方|令狐|南宮|端木|皇甫|尉遲|夏侯';
const SINGLE_SURNAMES =
  '陳林黃張李王吳劉蔡楊許鄭謝郭洪邱曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴范方宋鄧杜傅侯曹薛丁卓阮馬董溫唐藍蔣石古紀姚連馮歐程湯田康姜白汪鄒尤巫鐘黎塗龔嚴韓袁金童陸夏柳邵錢伍倪甘秦官辛戚易祝樊喬向殷凌闕舒包鮑冉牛管毛涂';

/**
 * The rule's RegExp, kept for display and for compatibility. Matching uses detectChineseNames (zh-name.ts),
 * which scores the same surname + 1–2 character shape against the surrounding words.
 */
const NAME_REGEX =
  `(?:${COMPOUND_SURNAMES}|[${SINGLE_SURNAMES}])` +
  `(?:[${CJK}]{1,2})`;

export const BUILTIN_PATTERNS: Pattern[] = [
  {
    id: 'zh-name',
    name: '中文姓名',
    group: 'tw',
    note: '常見姓氏（含複姓）加 1–2 字名；依名字用字、前後文（姓名：、先生、您好…）與常見詞（高雄、程序、保證金…）評分，邊界情況標為低信心',
    category: '姓名',
    source: 'builtin',
    regex: NAME_REGEX,
    example: '王小明、歐陽志遠',
    enabled: true,
    detectFn: detectChineseNames,
  },
  {
    id: 'tw-id',
    name: '台灣身分證字號',
    group: 'tw',
    note: '身分證檢核碼驗證，錯誤的號碼不命中',
    category: '身分證',
    source: 'builtin',
    regex: '(?<![A-Za-z0-9])[A-Z][12]\\d{8}(?!\\d)',
    example: 'A123456789',
    enabled: true,
    validate: isValidTwId,
  },
  // Before 市話: a labelled SSN of 9 bare digits starting with 0 also reads as a Kaohsiung number.
  // Unlabelled it needs 3-2-4 separators, which no Taiwanese format uses.
  {
    id: 'us-ssn',
    name: '美國社會安全碼（SSN）',
    group: 'intl',
    note: '排除 000、666、9xx 區碼與 00 組碼、0000 序號；「SSN:」標籤後的 9 位數也算',
    category: 'SSN',
    source: 'builtin',
    regex:
      '(?<![\\d-])(?:\\d{3}-\\d{2}-\\d{4}|\\d{3}\\x20\\d{2}\\x20\\d{4})(?![\\d-])' +
      '|(?<=(?:SSN|Social Security (?:Number|No\\.?))\\s*[:#：]?\\s*)\\d{9}(?!\\d)',
    example: '123-45-6789、SSN: 123456789',
    enabled: true,
    validate: isSsn,
  },
  {
    id: 'tw-mobile',
    name: '手機號碼',
    group: 'tw',
    note: '09 開頭或 +886 9 開頭，前後不得緊鄰數字',
    category: '手機',
    source: 'builtin',
    regex: '(?<![\\d+])(?:\\+886[-\\x20]?9|09)\\d{2}[-\\x20]?\\d{3}[-\\x20]?\\d{3}(?!\\d)',
    example: '0912-345-678、0912345678、+886-912-345-678',
    enabled: true,
  },
  {
    id: 'tw-landline',
    name: '市話號碼',
    group: 'tw',
    note: '依區碼要求位數，8 位數統編不會被當成市話；含 +886 寫法',
    category: '市話',
    source: 'builtin',
    // Separated/parenthesised forms, or unseparated forms with the exact digit count per area
    // code (02/04: 10 digits, 03–08: 9, 082/089: 9, 0826/0836: 9) so an 8-digit 統編 is never a 市話.
    regex:
      '(?<![\\d(])(?:\\(0(?:826|836|82|89|37|49|[2-8])\\)[-\\x20]?\\d{3,4}[-\\x20]?\\d{3,4}' +
      '|0(?:826|836|82|89|37|49|[2-8])[-\\x20]\\d{3,4}[-\\x20]?\\d{3,4}' +
      '|0[24]\\d{8}|0[3-8]\\d{7}|08[29]\\d{6}|08[23]6\\d{5}|' + TW_LANDLINE_INTL + ')(?!\\d)',
    example: '(02)2712-3456、02-27123456、0227123456、037-123456、+886-2-2712-3456',
    enabled: true,
  },
  {
    id: 'tw-address',
    name: '台灣地址',
    group: 'tw',
    note: '以縣市名為錨點，含鄉鎮市區、路街段巷弄號樓',
    category: '地址',
    source: 'builtin',
    regex: ADDRESS_REGEX,
    example: '台北市信義區市府路45號8樓',
    enabled: true,
  },
  {
    id: 'tw-company',
    name: '公司／組織名稱',
    group: 'tw',
    note: '以股份有限公司、有限公司、事務所、診所、基金會等結尾；排除「本／該／貴公司」',
    category: '公司',
    source: 'builtin',
    regex: COMPANY_REGEX,
    example: '築夢實業股份有限公司、大安聯合診所',
    enabled: true,
  },
  {
    id: 'tw-tax-id',
    name: '統一編號',
    group: 'tw',
    note: '統一編號檢核碼驗證（含 2023 年新制）',
    category: '統編',
    source: 'builtin',
    regex: '(?<![\\d-])\\d{8}(?![\\d-])',
    example: '統一編號 04595257',
    enabled: true,
    validate: isValidTaxId,
  },
  {
    id: 'email',
    name: '電子郵件',
    group: 'intl',
    category: '電子郵件',
    source: 'builtin',
    regex: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    example: 'someone@example.com',
    enabled: true,
  },
  // International formats (specs/007-intl-pii-patterns). After the Taiwanese rules, so a +886 number
  // they both match stays 手機 or 市話.
  {
    id: 'intl-phone',
    name: '國際電話',
    group: 'intl',
    note: '含國碼的各國號碼或北美格式，以 libphonenumber 驗證號碼有效性；+886 號碼歸手機／市話',
    category: '國際電話',
    source: 'builtin',
    regex:
      '(?<![\\w+])(?:\\+[1-9]\\d{0,2}(?:[\\x20.-]?(?:\\(\\d{1,4}\\)|\\d{1,5})){1,6}' +
      '|(?:\\(\\d{3}\\)\\x20?|\\d{3}[-.\\x20])\\d{3}[-.\\x20]\\d{4})(?!\\w)',
    example: '+1 (415) 867-5309、+44 20 7946 0958、(416) 967-1111',
    enabled: true,
    validate: phoneLength,
  },
  {
    id: 'credit-card',
    name: '信用卡號',
    group: 'intl',
    note: 'Luhn 檢核＋發卡機構號段（Visa、Mastercard、AmEx、Discover、JCB、UnionPay、Diners）＋常見分組格式',
    category: '信用卡',
    source: 'builtin',
    regex: '(?<![\\d-])\\d(?:[\\x20-]?\\d){12,18}(?![\\d-])',
    example: '4242 4242 4242 4242、3782 822463 10005',
    enabled: true,
    validate: isCardNumber,
  },
  {
    id: 'iban',
    name: 'IBAN 國際銀行帳號',
    group: 'intl',
    note: 'mod-97 檢核碼＋各國固定長度',
    category: 'IBAN',
    source: 'builtin',
    regex: '(?<![A-Za-z0-9])[A-Z]{2}\\d{2}(?:\\x20?[A-Z0-9]{4}){2,7}(?:\\x20?[A-Z0-9]{1,3})?(?![A-Za-z0-9])',
    example: 'GB82 WEST 1234 5698 7654 32、DE89370400440532013000',
    enabled: true,
    validate: ibanLength,
  },
  {
    id: 'ipv4',
    name: 'IPv4 位址',
    group: 'intl',
    note: '各段 0–255，排除版本號',
    category: 'IP',
    source: 'builtin',
    regex: '(?<![\\d.])(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?!\\.?\\d)',
    example: '192.168.1.10',
    enabled: true,
  },
  {
    id: 'ipv6',
    name: 'IPv6 位址',
    group: 'intl',
    note: '以瀏覽器內建的網址解析驗證，排除時間與 MAC 位址',
    category: 'IP',
    source: 'builtin',
    regex: '(?<![\\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{1,4}(?![\\w:])',
    example: '2001:db8::1',
    enabled: true,
    validate: isIpv6,
  },
  {
    id: 'dob',
    name: '出生日期',
    group: 'intl',
    note: '只偵測「DOB／Date of Birth／Birthday／Born／出生日期／生日」等標籤後、同一行的日期；驗證月日',
    category: '生日',
    source: 'builtin',
    regex: BIRTH_DATE,
    example: 'DOB: 1985-03-14、Date of Birth: March 14, 1985、出生日期：民國 80 年 5 月 1 日',
    enabled: true,
    validate: isBirthDate,
  },
];
