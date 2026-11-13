/**
 * 平气法排盘（规则层）—— 2026-10-18 新版算法
 *
 * ★ 用户：「pingqi 的算法更新了。你照着这个算法重新改平气法吧。用新的算法」
 *
 * ⚠⚠ 本文件照抄用户给的 `pingqi_bazi.js`（2026-10-18 17:48 版）的规则，不要在这里发明口径。
 *
 * 对外接口与旧版保持一致（`model.js` 只认这些名字）：
 *   paipan / siLing / siLingText / taiYuan / jiaoYun / jiaoYunText / daYun /
 *   monthGzOf / termAt / JIE_ORDER / supported
 *
 * ⚠ 输出形状必须与 `core/chart.js` 的 `paipan()` **同构**（差异只在上限：年月柱/司令/胎元/交运/大运）。
 *   日 / 时柱、十神、藏干、纳音、星运、自坐、空亡 一律复用 chart.js —— 与口径无关，不抄第二份。
 *
 * ★★ 新版比旧版多了什么（这次重写要拿到的）：
 *   ① **交运年切割**：每步大运的流年带 `part`（之后 / 全年 / 之前）、`isSplitYear`、
 *      `shareWithPrev/Next`、`hasCut`；流月带 `cut` / `cutHalf`（交运月被前后两步分占）。
 *      旧版是「每步 10 个整年、不切割」—— 现在算法自己给了，直接透传。
 *   ② 交运：`startYear` / `startYearGan` 等。
 *   ③ 流月：每项带 `zhi` / `jie` / `at` / `short` / `tip` / `cut`。
 */

const DATA = require('./pingqi-terms.js');
const chartLib = require('./chart.js');
/** 农历年（大运岁数基准）—— 与定气法 bazi.js getBirthYear 走同一份实现 */
const tyme = require('../vendor/tyme.js');

/* ================= 常量 ================= */

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
/** 十二节（月柱换柱点），寅月起 */
const JIE_ORDER = ['立春', '惊蛰', '清明', '立夏', '芒种', '小暑',
  '立秋', '白露', '寒露', '立冬', '大雪', '小寒'];
/** 十二节对应的月支（下标与 JIE_ORDER 一一对应） */
const JIE_ZHI = ['寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥', '子', '丑'];
/** 五虎遁：年干 → 寅月的月干下标 */
const WUHU_START = { '甲': 2, '己': 2, '乙': 4, '庚': 4, '丙': 6, '辛': 6, '丁': 8, '壬': 8, '戊': 0, '癸': 0 };
/** 天干五合（甲己 / 乙庚 / 丙辛 / 丁壬 / 戊癸）—— 交运括号里「年干 + 相合干」用 */
const HE_GAN = { '甲': '己', '己': '甲', '乙': '庚', '庚': '乙', '丙': '辛', '辛': '丙', '丁': '壬', '壬': '丁', '戊': '癸', '癸': '戊' };
/** 表里平气 / 定气两个时刻的下标 */
const KEY = 0;

/* ================= 时间轴（无时区字面值） ================= */

/**
 * 解析 'YYYY-MM-DDTHH:mm(:ss)' → Date.UTC（字面值轴）。
 * ⚠ 只用来做差 / 比较，**不换算真实时区** —— 表里的时刻本来就是北京时间字面值。
 */
function parseISO(s) {
  if (!s) return NaN;
  const t = String(s).trim().replace(' ', 'T');
  const y = +t.slice(0, 4);
  const mo = +t.slice(5, 7);
  const d = +t.slice(8, 10);
  const h = t.length >= 13 ? +t.slice(11, 13) : 0;
  const mi = t.length >= 16 ? +t.slice(14, 16) : 0;
  const se = t.length >= 19 ? +t.slice(17, 19) : 0;
  return Date.UTC(y, mo - 1, d, h, mi, se);
}

/** 字面值 → 'YYYY-MM-DD HH:mm' */
function fmt(ms) {
  const d = new Date(ms);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

/** 出生时刻 → 轴 */
function toAxis(y, m, d, hour, minute) {
  return Date.UTC(y, m - 1, d, hour | 0, minute | 0);
}

/* ---------- 节气取值（★★ 2026-10-18 21:05 新版：容错 + 越界推算） ---------- */

/**
 * 表里的年份范围。新版把表扩到 1599–2441，但大运 13 步能推到 2150+，
 * 出生年也可能落在表外 —— 所以取值统一走 `jieAt`，不再直接读 `DATA[y]`。
 */
const DATA_YEARS = Object.keys(DATA).map(Number);
const DATA_YEAR_MIN = Math.min.apply(null, DATA_YEARS);
const DATA_YEAR_MAX = Math.max.apply(null, DATA_YEARS);
/** 平气法一个节气的步长（回归年 / 24） */
const PINGQI_STEP_DAYS = 365.2422 / 24;
/** 24 节气次序（冬至为锚点，平气表按「上一年冬至」起均分） */
const TERM_SEQ = ['冬至', '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏',
  '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露',
  '霜降', '立冬', '小雪', '大雪'];

/**
 * 取某年某节的时刻（毫秒）。key: 0=平气 1=定气。
 * @returns {number} 轴毫秒；取不到时 NaN
 *
 * ★ 21:05 版起的容错口径（照抄来源 `jieAt`）：
 *   ① 年份越界 → 取最近可用年份的同名节气，按「整年数 × 回归年」平移（节气是周期函数）；
 *   ② 平气格为空（生成器把跨年那一节归到下一年的表里）→ 用「上年冬至 + n × 平气步长」当场补算；
 *   ③ 定气格为空就是真缺，不补。
 */
function termAtRaw(year, jie, key) {
  const k = (key == null) ? KEY : key;
  const y = DATA[String(year)];

  // ① 越界：按最近年份平移（jieShift 递归回 jieAt，但 ref 一定在范围内，不会死循环）
  if (!y) {
    const ref = Math.min(DATA_YEAR_MAX, Math.max(DATA_YEAR_MIN, year));
    const t = termAtRaw(ref, jie, k);
    if (!isFinite(t)) return NaN;
    return t + (year - ref) * 365.2422 * 86400000;
  }
  if (!y[jie]) return NaN;
  const raw = y[jie][k];
  if (raw) return parseISO(raw);

  // ③ 定气缺失 = 真缺
  if (k !== 0) return NaN;

  // ② 平气补算：上年冬至 + 序号 × 步长
  const prev = DATA[String(year - 1)];
  if (!prev || !prev['冬至'] || !prev['冬至'][0]) return NaN;
  const anchor = parseISO(prev['冬至'][0]);
  if (!isFinite(anchor)) return NaN;
  const n = TERM_SEQ.indexOf(jie);
  if (n < 0) return NaN;
  return anchor + n * PINGQI_STEP_DAYS * 86400000;
}

/** 取某年某节的时刻（毫秒），语义同 termAtRaw，名字短一点给内部用 */
function jieAt(year, jie, key) {
  return termAtRaw(year, jie, key);
}

/* ================= 四柱 ================= */

/**
 * 平气法四柱（年 / 月柱按平气口径，日 / 时柱复用 chart.js）。
 * 输出与 `chartLib.paipan()` 同构。
 */
/* ================= 日柱 / 时柱（照来源 dayPillar / hourPillar 自算，不再借 chartLib）================= */

/**
 * 日柱：以 1900-01-01（甲戌日，序 10）为基准按天数推干支。
 * 日界取子时 23:00 —— 23:00 起算次日日柱（晚子时进位）。
 */
function dayPillarOf(y, m, d, hour) {
  const late = (hour || 0) >= 23;
  const cur = Date.UTC(y, m - 1, d + (late ? 1 : 0));
  const diff = Math.round((cur - Date.UTC(1900, 0, 1)) / 86400000);
  const idx = ((diff + 10) % 60 + 60) % 60;      // 1900-01-01 = 甲戌（序 10）
  return GAN[idx % 10] + ZHI[idx % 12];
}

/**
 * 时柱：由日干五鼠遁起子时，两个时辰一支（子=23–01）。
 * 时支按实际钟点取：23–01 子、01–03 丑 …… 21–23 亥。
 * 五鼠遁：甲己日起甲子，乙庚起丙子，丙辛起戊子，丁壬起庚子，戊癸起壬子。
 */
const WUSHU_START = { '甲': 0, '己': 0, '乙': 2, '庚': 2, '丙': 4, '辛': 4, '丁': 6, '壬': 6, '戊': 8, '癸': 8 };
function hourPillarOf(y, m, d, hour, minute, dayGan) {
  const h = hour || 0;
  const zIdx = Math.floor(((h + 1) % 24) / 2);   // 23,0 → 子(0)；1,2 → 丑(1) ……
  return GAN[(WUSHU_START[dayGan] + zIdx) % 10] + ZHI[zIdx];
}

function paipan(y, m, d, hour, minute) {
  if (!supported(y)) return null;
  const ref = chartLib.paipan(y, m, d, hour, minute);
  if (!ref) return null;

  const t = toAxis(y, m, d, hour, minute);
  const seg = monthSegmentAt(t);
  if (!seg) return null;

  const yearGz = seg.yearGz;
  const monthGz = monthGzOf(yearGz, seg.idx);

  /*
   * ⚠⚠ 四柱全部用**平气法算法自己**的口径（2026-10-19 00:37 版 dayPillar/hourPillar 移植）：
   *   日柱 = 1900-01-01 甲戌基准 + 晚子时（23:00 起）进位；
   *   时柱 = 日干五鼠遁。之前日/时借 chartLib（定气 core）的现成结果 ——
   *   数值虽一致，但口径上「四柱必须是平气法算法里的」，借的就得还。
   */
  const dayGz = dayPillarOf(y, m, d, hour);
  const dayStemName = dayGz.charAt(0);
  const hourGz = hourPillarOf(y, m, d, hour, minute, dayStemName);
  const pillars = {
    year: pillarOf(yearGz, dayStemName, 'year'),
    month: pillarOf(monthGz, dayStemName, 'month'),
    day: pillarOf(dayGz, dayStemName, 'day'),
    hour: pillarOf(hourGz, dayStemName, 'hour'),
  };
  const elements = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  ['year', 'month', 'day', 'hour'].forEach(function (k) {
    elements[pillars[k].element.charAt(0)] += 1;
    elements[pillars[k].element.charAt(1)] += 1;
  });

  return {
    pillars: pillars,
    fourChars: ['year', 'month', 'day', 'hour'].map(function (k) { return pillars[k].name; }),
    pillarLabels: ['年柱', '月柱', '日柱', '时柱'],
    shiShenList: ['year', 'month', 'day', 'hour'].map(function (k) { return pillars[k].shiShen; }),
    dayMasterName: dayStemName,
    dayMasterElement: pillars.day.element.charAt(0),
    dayMasterYang: '甲丙戊庚壬'.indexOf(dayStemName) >= 0,
    hourName: ref.hourName,
    zodiac: ref.zodiac,
    elements: elements,
    termName: JIE_ORDER[seg.idx],
    method: 'pingqi'
  };
}

/**
 * 一柱的展示字段 —— 与 chartLib.paipan 的 pillars[key] 同形状。
 * ⚠⚠ 2026-10-19 修 bug：纳音/藏干/星运/自坐/空亡此前根本没给（ganZhiInfo 只回十神/五行），
 *   页面上五行全空。这里逐项调 chartLib 的同一批纯函数（一份实现），不另抄表。
 */
function pillarOf(gz, dayStemName, key) {
  const info = chartLib.ganZhiInfo(dayStemName, gz);
  const stemName = gz.charAt(0);
  const branchName = gz.charAt(1);
  return {
    name: gz,
    stem: stemName,
    branch: branchName,
    element: info.element,
    shiShen: info.shiShen,
    // 纳音（60 甲子两两共用）；空亡（本柱旬的两个空亡支，如「辰巳」）
    nayin: chartLib.nayinOf(gz),
    kongWang: chartLib.xunKongOf(gz),
    // 星运 = 日干在此柱地支的十二长生；自坐 = 本柱天干坐本柱地支
    xingYun: chartLib.terrainOf(dayStemName, branchName),
    ziZuo: chartLib.terrainOf(stemName, branchName),
    // 藏干（本气/中气/余气）+ 藏干十神
    canggan: chartLib.cangGanOf(branchName, dayStemName),
  };
}

/**
 * 某时刻落在哪个月段（平气口径）。
 *
 * ⚠⚠⚠ 节气表按「节气落在哪个公历年」存 ⇒ **同一年里「大雪」（12 月）排在次年「小寒」之前**。
 *   所以「下一节」必须**按时间往后扫**取最小 > t 的那个，不能写「下标 + 1」
 *   （旧版踩过：算成「距小寒 −360.3 天」）。
 */
function monthSegmentAt(t) {
  const y0 = new Date(t).getUTCFullYear();
  const cands = [];
  for (let yr = y0 - 1; yr <= y0 + 1; yr++) {
    const row = DATA[String(yr)];
    if (!row) continue;
    for (let i = 0; i < JIE_ORDER.length; i++) {
      const ms = termAtRaw(yr, JIE_ORDER[i], KEY);
      if (isFinite(ms)) cands.push({ ms: ms, jie: JIE_ORDER[i], idx: i });
    }
  }
  cands.sort(function (a, b) { return a.ms - b.ms; });

  let cur = null;
  let next = null;
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].ms <= t) cur = cands[i];
    else { next = cands[i]; break; }
  }
  if (!cur) return null;

  /** 年干支：以**平气立春**为界 */
  let liChun = null;
  for (let i = cands.length - 1; i >= 0; i--) {
    if (cands[i].jie === '立春' && cands[i].ms <= t) { liChun = cands[i]; break; }
  }
  const lcYear = liChun ? new Date(liChun.ms).getUTCFullYear() : y0;
  const yearIndex = (((lcYear - 4) % 60) + 60) % 60;
  const yearGz = GAN[yearIndex % 10] + ZHI[yearIndex % 12];

  return {
    idx: cur.idx,
    jie: cur.jie,
    termMs: cur.ms,
    nextMs: next ? next.ms : NaN,
    nextJie: next ? next.jie : '',
    yearGz: yearGz,
    year: lcYear,
  };
}

/** 五虎遁：某年干 + 第 i 个节（寅=0）→ 月干支 */
function monthGzOf(yearGz, i) {
  const k = ((i % 12) + 12) % 12;
  return GAN[(WUHU_START[yearGz.charAt(0)] + k) % 10] + JIE_ZHI[k];
}

/* ================= 司令 / 胎元 ================= */

/**
 * 人元司令分野（月令藏干分日用事）。
 * ⚠ 口径与来源实现一致：表按「每月 30 日」分，实际月份长度不等时**按比例折算**
 *   （大雪→小寒 30.44 天，表里子月共 30 日 ⇒ 实际过 25.46 天 ≈ 表内 25.09 天）。
 */
const SILING = {
  寅: [{ gan: '戊', days: 7 }, { gan: '丙', days: 7 }, { gan: '甲', days: 16 }],
  卯: [{ gan: '甲', days: 10 }, { gan: '乙', days: 20 }],
  辰: [{ gan: '乙', days: 9 }, { gan: '癸', days: 3 }, { gan: '戊', days: 18 }],
  巳: [{ gan: '戊', days: 5 }, { gan: '庚', days: 9 }, { gan: '丙', days: 16 }],
  午: [{ gan: '丙', days: 10 }, { gan: '己', days: 9 }, { gan: '丁', days: 11 }],
  未: [{ gan: '丁', days: 9 }, { gan: '乙', days: 3 }, { gan: '己', days: 18 }],
  申: [{ gan: '戊', days: 10 }, { gan: '壬', days: 3 }, { gan: '庚', days: 17 }],
  酉: [{ gan: '庚', days: 10 }, { gan: '辛', days: 20 }],
  戌: [{ gan: '辛', days: 9 }, { gan: '丁', days: 3 }, { gan: '戊', days: 18 }],
  亥: [{ gan: '戊', days: 7 }, { gan: '甲', days: 5 }, { gan: '壬', days: 18 }],
  子: [{ gan: '壬', days: 10 }, { gan: '癸', days: 20 }],
  丑: [{ gan: '癸', days: 9 }, { gan: '辛', days: 3 }, { gan: '己', days: 18 }]
};

/**
 * 取当令之干。
 * @returns {{ gan:string, position:string, segmentStart:number }|null}
 */
function siLingGan(zhi, elapsed, monthLen) {
  const segs = SILING[zhi] || [];
  if (!segs.length) return null;
  const total = segs.reduce(function (s, x) { return s + x.days; }, 0);
  const rate = isFinite(monthLen) && monthLen > 0 ? total / monthLen : 1;
  const eff = elapsed * rate;
  let cum = 0;
  let cur = segs[segs.length - 1];
  let curStart = 0;
  for (let i = 0; i < segs.length; i++) {
    if (eff < cum + segs[i].days) { cur = segs[i]; curStart = cum; break; }
    cum += segs[i].days;
  }
  return {
    gan: cur.gan,
    position: cur.gan + '用事第 ' + (Math.floor(eff - curStart) + 1) + ' 日（此段共 ' + cur.days + ' 日）',
    segmentStart: curStart / rate,
  };
}

/** 人元司令分野（按「轴毫秒」算）—— 交运那边要拿交运时刻直接算，所以先拆一层 */
function siLingAt(t) {
  const seg = monthSegmentAt(t);
  if (!seg) return null;
  const len = (seg.nextMs - seg.termMs) / 86400000;
  const elapsed = (t - seg.termMs) / 86400000;
  const r = siLingGan(JIE_ZHI[seg.idx], elapsed, len);
  if (!r) return null;
  return {
    gan: r.gan,
    position: r.position,
    month: JIE_ZHI[seg.idx],
    jie: seg.jie,
    daysElapsed: elapsed,
    monthLength: len,
  };
}

/** 人元司令分野（平气口径） */
function siLing(y, m, d, hour, minute) {
  const t = toAxis(y, m, d, hour, minute);
  return siLingAt(t);
}

/** 旧版 siLing 的实现（保留给别处对照，实际走 siLingAt） */
function siLingOld(y, m, d, hour, minute) {
  const t = toAxis(y, m, d, hour, minute);
  const seg = monthSegmentAt(t);
  if (!seg) return null;
  const len = (seg.nextMs - seg.termMs) / 86400000;
  const elapsed = (t - seg.termMs) / 86400000;
  const r = siLingGan(JIE_ZHI[seg.idx], elapsed, len);
  if (!r) return null;
  return {
    gan: r.gan,
    position: r.position,
    month: JIE_ZHI[seg.idx],
    jie: seg.jie,
    daysElapsed: elapsed,
    monthLength: len,
  };
}

/** 某节的下一节叫什么（十二节环） */
function nextJieName(jie) {
  const i = JIE_ORDER.indexOf(jie);
  return i < 0 ? '' : JIE_ORDER[(i + 1) % 12];
}

/** 司令文案：如「癸司令（大雪第25.5天，距小寒4.9天）」 */
function siLingText(y, m, d, hour, minute) {
  const s = siLing(y, m, d, hour, minute);
  if (!s) return '—';
  const fixed = function (v) { return (Math.round(v * 10) / 10).toFixed(1); };
  const toNext = s.monthLength - s.daysElapsed;
  return s.gan + '司令（' + s.jie + '第' + fixed(s.daysElapsed) + '天，距' +
    nextJieName(s.jie) + fixed(toNext) + '天）';
}

/** 胎元：月干进一、月支进三 */
function taiYuan(y, m, d, hour, minute) {
  const p = paipan(y, m, d, hour, minute);
  if (!p) return null;
  const gi = GAN.indexOf(p.pillars.month.stem);
  const zi = ZHI.indexOf(p.pillars.month.branch);
  return GAN[(gi + 1) % 10] + ZHI[(zi + 3) % 12];
}

/* ================= 交运 ================= */

/**
 * 交运（起第一步大运）：顺排数到下一节、逆排数到上一节；三日折一年。
 */
function jiaoYun(y, m, d, hour, minute, gender) {
  const p = paipan(y, m, d, hour, minute);
  if (!p) return null;
  const t = toAxis(y, m, d, hour, minute);
  const seg = monthSegmentAt(t);
  if (!seg) return null;

  const isYang = '甲丙戊庚壬'.indexOf(p.pillars.year.stem) >= 0;
  const male = gender === 1;
  const forward = (isYang && male) || (!isYang && !male);

  const targetMs = forward ? seg.nextMs : seg.termMs;
  const targetJie = forward ? seg.nextJie : seg.jie;
  if (!isFinite(targetMs)) return null;

  const distDays = (forward ? (targetMs - t) : (t - targetMs)) / 86400000;
  const totalYears = distDays / 3;
  const yrs = Math.floor(totalYears);
  const monthsTotal = (totalYears - yrs) * 12;
  const mos = Math.floor(monthsTotal);
  const dys = Math.floor((monthsTotal - mos) * 30);

  const startAt = addCalendar(t, yrs, mos, dys);
  const step = forward ? 1 : -1;
  const mg = GAN.indexOf(p.pillars.month.stem);
  const mz = ZHI.indexOf(p.pillars.month.branch);
  const firstYun = GAN[(mg + step + 10) % 10] + ZHI[(mz + step + 12) % 12];

  const dh = Math.floor(distDays);
  const hh = Math.round((distDays - dh) * 24);

  /*
   * 交运当年的年柱 / 年干 —— 用**平气年柱**取（交运时刻可能落在立春前后）。
   * ⚠ 括号里显示的就是这个年干 + 它的天干五合（用户：「戊与癸合，定气法有的平气法也必须有」）。
   */
  const atSeg = monthSegmentAt(startAt);
  const startYearGz = atSeg ? atSeg.yearGz : '';

  return {
    direction: forward ? '顺排' : '逆排',
    yangYear: isYang,
    yearGan: p.pillars.year.stem,
    gender: male ? '男' : '女',
    rule: isYang
      ? '阳年（' + p.pillars.year.stem + '）生：男顺排、女逆排'
      : '阴年（' + p.pillars.year.stem + '）生：男逆排、女顺排',
    countTo: targetJie,
    distDays: round2(distDays),
    distText: dh + ' 天 ' + hh + ' 小时',
    startAtMs: startAt,
    startAt: fmt(startAt),
    startAge: yrs,
    startAgeText: yrs + ' 岁 ' + mos + ' 个月 ' + dys + ' 天起运',
    firstYun: firstYun,
    fromMonth: p.pillars.month.name,
    startYear: startYearGz,
    startYearGan: startYearGz ? startYearGz.charAt(0) : '',
    /*
     * ★★ 21:05 版新增：交运时刻所依之节 + 该节之后的偏移天数。
     *   大运**每一步的换运时刻不再固定同一个月日**，而是按「同一节气 + 同一偏移」逐年重算 ——
     *   例如 2006-12-10 男，交运 = 大雪后 30.02 天（离小寒 0.42 天），
     *   20 年后的换运日取那一年的大雪 + 30.02 天，可能落在 01-05 或 01-06。
     *   拿「年份 +10、月日不变」会与节气位置自相矛盾。
     */
    startJie: (function () { const ss = siLingAt(startAt); return ss ? ss.jie : null; })(),
    startDaysSinceJie: (function () { const ss = siLingAt(startAt); return ss ? round2(ss.daysElapsed) : null; })(),
    startJiePosition: (function () {
      const ss = siLingAt(startAt);
      if (!ss || !isFinite(ss.monthLength)) return null;
      return ss.jie + '后 ' + ss.daysElapsed.toFixed(2) + ' 天，距' + nextJieName(ss.jie) +
        ' ' + (ss.monthLength - ss.daysElapsed).toFixed(2) + ' 天';
    })(),
    startDaysToNextJie: (function () {
      const ss = siLingAt(startAt);
      return ss && isFinite(ss.monthLength) ? round2(ss.monthLength - ss.daysElapsed) : null;
    })(),
  };
}

/** 交运文案：「芒种后17天21小时（戊癸）」—— 括号 = 交运年干 + 它的五合 */
function jiaoYunText(y, m, d, hour, minute, gender) {
  const j = jiaoYun(y, m, d, hour, minute, gender);
  if (!j) return '—';
  const dt = new Date(j.startAtMs);
  const s = siLing(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(),
    dt.getUTCHours(), dt.getUTCMinutes());
  if (!s) return j.distText;
  const hh = Math.round((s.daysElapsed - Math.floor(s.daysElapsed)) * 24);
  const gan = j.startYearGan || '';
  const pair = gan + (HE_GAN[gan] || '');
  return s.jie + '后' + Math.floor(s.daysElapsed) + '天' + hh + '小时' + (pair ? '（' + pair + '）' : '');
}

/* ================= 大运 ================= */

/**
 * 童限（起运前）的流年列表。
 * ⚠ 与后面的步不同，童限**没有**「上一步」来切割：首年只给出生之后的月份，
 *   末年给到换运月为止 —— 与定气法 getYearRange 用 `qishi / jiaoyun` 两个节气名截断同一效果。
 *   （2026-10-18 新版算法原本这里也走 liuNian(1, ...) 整年给，首年会带上出生前的月份。）
 */
/** 公历年 → 年柱干支（60 甲子，1984 甲子年） */
function yearGZOf(yr) {
  const i = (((yr - 4) % 60) + 60) % 60;
  return GAN[i % 10] + ZHI[i % 12];
}

function tongXianLiuNian(yFrom, yTo) {
  const out = [];
  for (let yr = yFrom; yr <= yTo; yr++) {
    let months = liuYueAll(yr);
    out.push({
      year: yr,
      ganzhi: yearGZOf(yr),
      gz: yearGZOf(yr),
      zhi: yearGZOf(yr).charAt(1),
      // 童限虚岁同样从农历年起算（与定气法 getYearRange 的 nianling 一致）
      age: yr - yFrom + 1,
      part: '全年',
      isSplitYear: false,
      shareWithPrev: false,
      shareWithNext: false,
      hasCut: false,
      liuYue: months,
    });
  }
  return out;
}

/** 某公历年内的 12 个平气流月（不切割） */
function liuYueAll(yy) {
  const arr = [];
  for (let j = 0; j < 12; j++) {
    const ty = j === 11 ? yy + 1 : yy;
    const ms = termAtRaw(ty, JIE_ORDER[j], KEY);
    if (!isFinite(ms)) continue;
    const atS = fmt(ms);
    arr.push({
      zhi: JIE_ZHI[j],
      jie: JIE_ORDER[j],
      at: atS,
      year: ty,
      short: atS.slice(5).replace('-', '/'),
      tip: JIE_ORDER[j] + ' ' + atS,
      cut: null,
      cutHalf: null,
    });
  }
  return arr;
}

/**
 * 大运 —— 输出 `model.buildDayuns` 能直接吃的形状（startAge / starYear / dayunganzhi）。
 *
 * ★★ 2026-10-18 新版：**每步带 liuNian**（含交运年切割标记 part / isSplitYear / shareWithPrev|Next），
 *   这正是旧版缺的那一块 —— 以前注释写「平气法不做交运年切割」，现在算法自己给了，直接透传。
 *
 * @returns {{ steps: any[] }} steps[0] 是童限（起运前）
 */
function daYun(y, m, d, hour, minute, gender, opts) {
  const o = opts || {};
  const stepYears = o.stepYears || 10;
  const count = o.steps || 12;
  const jy = jiaoYun(y, m, d, hour, minute, gender);
  if (!jy) return null;

  const sa = new Date(jy.startAtMs);
  const startYear = sa.getUTCFullYear();
  const startMonth = sa.getUTCMonth() + 1;
  const startDay = sa.getUTCDate();
  const startAge = (startYear - y) + (startMonth - m) / 12 + (startDay - d) / 365;

  const g0 = GAN.indexOf(jy.firstYun.charAt(0));
  const z0 = ZHI.indexOf(jy.firstYun.charAt(1));
  const step = jy.direction === '顺排' ? 1 : -1;

  const p2 = function (n) { return String(n).padStart(2, '0'); };
  const startMD = p2(startMonth) + '-' + p2(startDay);
  const cutOf = function (i) { return (startYear + i * stepYears) + '-' + startMD; };   // 兜底：数据缺失时才用

  /*
   * 出生时刻（童限起点），**带时分** —— 童限首年要和立春时刻精确比较，
   * 只给日期的话 1 月初出生会把上半月整段算进去。
   */
  const birthYear = y;
  const birthStamp = y + '-' + p2(m) + '-' + p2(d) + ' ' + p2(hour || 0) + ':' + p2(minute || 0);

  /*
   * ===== 每步换运时刻的定义（★★ 21:05 版核心改动，00:37 版补锚年偏移）=====
   * 交运**不是**「同一个公历月日」，而是「同一个节气 + 同一个偏移天数」。
   *   例：2006-12-10 男，交运 = 大雪后 30.02 天；
   *       10 年后 = 2026 年大雪 + 30.02 天 = 2027-01-06 00:04（不是固定的 01-06 08:00）。
   * 按「年份 + 10、月日不变」会与节气位置自相矛盾，且第 6 步之后会整体漂走。
   *
   * ★★ 00:37 版新增 **anchorShift（交运锚年偏移）**：
   *   交运时刻可能落在锚节所在公历年的「下一年」。
   *   例：2006-12-10 08:00 男，交运 = 2016-01-06 08:00 = 「大雪后 30.02 天」，
   *       锚节大雪在 2015-12，而 startYear=2016 —— 若直接查 2016 年的大雪，
   *       会拿到 2016-12 的大雪，整体晚 1 年：每步换运时刻后移一年，
   *       且每步流年的切割格全错位。修法：以 jy.startAt 为基准，在 startYear±1 内
   *       找能让「(startYear+s) 年锚节 + offsetDays」复现交运时刻的偏移 s，全步共用。
   */
  const jieName = jy.startJie;
  const offsetDays = (jy.startDaysSinceJie == null) ? null : jy.startDaysSinceJie;

  const anchorShift = (function () {
    if (!jieName || offsetDays == null) return 0;
    const startT = jy.startAtMs;
    const shifts = [0, -1, 1];
    for (let k = 0; k < shifts.length; k++) {
      const t = jieAt(startYear + shifts[k], jieName, KEY);
      if (isFinite(t) && Math.abs((t + offsetDays * 86400000) - startT) < 45 * 86400000) return shifts[k];
    }
    return 0;
  })();

  /** 在 [lo, hi] 内找离 target 最近、且表里确实有这一节（或可补算）的年份 */
  function nearestDataYear(target, lo, hi) {
    const dir = (target > hi) ? -1 : 1;
    let yy = (dir === -1) ? hi : lo;
    for (let i = 0; i <= hi - lo; i++) {
      const t = jieAt(yy, jieName, KEY);
      if (isFinite(t)) return { year: yy, t: t };
      yy -= dir;
    }
    return null;
  }

  /** 取 y 年的 jieName 交节时刻 + offsetDays（偏移可能跨月甚至跨年，交给 Date 滚）。
   *  ★ 00:37 版：先加 anchorShift 修正锚年；越界时不再返回 null，
   *    而按「最近可用年份的交节时刻 + 整年数 × 回归年 + offsetDays」平移推算 ——
   *    否则 13 步大运推到 2150+ 时换运日会整体漂走。 */
  function stepStamp(yy) {
    if (!jieName || offsetDays == null) return null;
    const target = yy + anchorShift;
    const t0 = jieAt(target, jieName, KEY);
    if (isFinite(t0)) return fmt(t0 + offsetDays * 86400000);
    const ref = nearestDataYear(target, DATA_YEAR_MIN, DATA_YEAR_MAX);
    if (!ref) return null;
    const shiftDays = (target - ref.year) * 365.2422;
    return fmt(ref.t + (shiftDays + offsetDays) * 86400000);
  }

  /** 第 i 步（1 起）的换运时刻：i=1 就是交运本身，其后按节气重算 */
  function cutOfStep(i) {
    if (i <= 0) return jy.startAt;
    return stepStamp(startYear + (i - 1) * stepYears) || cutOf(i - 1);
  }

  /**
   * 某时刻所属「干支年」对应的**公历年份**（以立春分年）。
   * ★ 21:05 版虚岁基准：按干支年算（乙未年 = 那个公历年），不再是「公历年 − 出生公历年」。
   *   2016-01-07 出生 → 年柱乙未 → 返回 2015。
   */
  function gzYearNumOf(stamp) {
    const t = parseISO(stamp);
    if (!isFinite(t)) return null;
    const yy = new Date(t).getUTCFullYear();
    const lc = jieAt(yy, '立春', KEY);
    return (isFinite(lc) && t < lc) ? yy - 1 : yy;
  }
  const gzBirthYear = gzYearNumOf(birthStamp);
  /** 虚岁基数：出生干支年（取不到时退回公历出生年） */
  const tongBase = (gzBirthYear != null) ? gzBirthYear : birthYear;

  /**
   * 某时刻所属**年柱**干支（按立春分年）。
   * ⚠ 新版大运每步多带 `gzYears` / `gzYearLabel`（如「乙未–乙巳（1998–2008）」）——
   *   交运落在立春前时，起点年柱是**上一年**的干支，不能拿公历年直接推。
   */
  function gzYearOf(stamp) {
    const t = parseISO(stamp);
    if (!isFinite(t)) return null;
    const yy = new Date(t).getUTCFullYear();
    const lc = termAtRaw(yy, '立春', KEY);
    return yearGZOf(isFinite(lc) && t < lc ? yy - 1 : yy);
  }

    /**
   * 某公历年内的 12 个流月（平气十二节交节时刻），并按 [startT, endT) 区间裁剪。
   *
   * ★★ 2026-10-18 18:30 新版口径（照抄来源 `daYun` 里的 `liuYue`）：
   *   每个流月**自己**和区间比较，不做「补月」特判、也不按 mode 整段砍：
   *     · 整月结束 <= startT → 整月在本步之前，丢弃
   *     · 整月开始 >= endT   → 整月在本步之后，丢弃
   *     · 月跨过 startT      → 保留，标「交运月：本步占后半」（cutHalf='after'）
   *     · 月跨过 endT        → 保留，标「交运月：本步占前半」（cutHalf='before'）
   *   ⚠ 月份区间是**左闭右开**：startT 正好落在交节那一刻时，该月算「本步占后半」。
   *   ⚠ 丑月（j=11）挂在次年 1 月，`year` 记 y+1。
   */
  function liuYue(yy, startT, endT) {
    const arr = [];
    for (let j = 0; j < 12; j++) {
      const ty = j === 11 ? yy + 1 : yy;
      const ms = termAtRaw(ty, JIE_ORDER[j], KEY);
      if (!isFinite(ms)) continue;
      // 本月结束 = 下一节交节：j=0..9 在当年，j=10 大雪止于次年小寒，j=11 小寒止于次年立春
      const ni = (j + 1) % 12;
      const ny = j >= 10 ? yy + 1 : yy;
      const endMs = termAtRaw(ny, JIE_ORDER[ni], KEY);
      if (!isFinite(endMs)) continue;

      if (isFinite(startT) && endMs <= startT) continue;   // 整月在本步起点之前
      if (isFinite(endT) && ms >= endT) continue;          // 整月在本步终点之后

      let cutFlag = null;
      if (isFinite(startT) && ms <= startT && startT < endMs) cutFlag = '交运月：本步占后半';
      if (isFinite(endT) && ms <= endT && endT < endMs) cutFlag = '交运月：本步占前半';

      const atS = fmt(ms);
      arr.push({
        zhi: JIE_ZHI[j],
        jie: JIE_ORDER[j],
        at: atS,
        year: ty,
        short: atS.slice(5).replace('-', '/'),
        tip: cutFlag ? JIE_ORDER[j] + ' ' + atS + ' — ' + cutFlag : JIE_ORDER[j] + ' ' + atS,
        cut: cutFlag,
        cutHalf: cutFlag ? (cutFlag.indexOf('占前半') >= 0 ? 'before' : 'after') : null,
      });
    }
    return arr;
  }

  /** 换运月日文案（「06月25日」），供渲染层直接显示 */
  const cutMD = p2(startMonth) + '月' + p2(startDay) + '日';

  /**
   * 某步的流年列表（含换运的分割年）。
   * @param i     步号（0 = 童限）
   * @param yFrom 起步公历年
   * @param span  跨年数（童限 = 交运年 − 出生年）
   *
   * ★★ 新版口径：`part` / `isSplitYear` / `hasCut` **全部以实际切割标记为准**，
   *   而不是「首年就是之后、末年就是之前」——交运恰在立春前时，整年可能一格都不属于本步。
   */
  function liuNian(i, yFrom, span) {
    const n = (span === undefined) ? stepYears : span;
    /*
     * ⚠⚠ 区间端点必须用 **cutOfStep**（按「节气 + 偏移」逐年重算的实际换运时刻），
     *   不能用 cutOf（固定的首次交运月日）—— 后者会让切割月和真实换运时刻差上几小时到一天。
     */
    const cutAtStart = (i === 0) ? birthStamp : cutOfStep(i);
    const cutAtEnd = cutOfStep(i + 1);
    const startT = parseISO(cutAtStart);
    const endT = parseISO(cutAtEnd);
    const arr = [];
    /*
     * ⚠⚠ 起点若落在立春前（1 月），它所在的「丑月」挂在**上一公历年**的表尾，
     *   不多扫前一年这一格切割月就整月丢失（实测换运在 1 月初时会少一个月）。
     */
    const lichun = termAtRaw(yFrom, '立春', KEY);
    const firstY = (isFinite(startT) && isFinite(lichun) && startT < lichun) ? yFrom - 1 : yFrom;
    for (let yr = firstY; yr <= yFrom + n; yr++) {
      if (!DATA[String(yr)] && !DATA[String(yr - 1)]) continue;
      const ly = liuYue(yr, startT, endT);
      // 该年在本步区间内没有任何完整 / 跨界月份 → 整年不列
      if (!ly.length) continue;
      const hasAfter = ly.some(function (x) { return x.cutHalf === 'after'; });
      const hasBefore = ly.some(function (x) { return x.cutHalf === 'before'; });
      const part = (hasAfter && hasBefore) ? '首尾' : hasAfter ? '之后' : hasBefore ? '之前' : '全年';
      /*
       * 区间标注文案（渲染层直接显示，不再自己拼）：
       *   童限首年 → 「出生后」；换运分隔年 → 「06月25日后起」/「06月25日前止」。
       *   只有切割月、没有完整月的那一格不再加「后起」——斜纹已经说明了。
       */
      /* ⚠ 出生年 = 出生**干支年**（tongBase），不是公历年 —— 立春前出生时两者差 1。 */
      const isBirthYear = (i === 0 && yr === tongBase);
      const onlyCutMonth = ly.length === 1;
      const partNote = isBirthYear ? '出生后'
        : hasAfter ? (onlyCutMonth ? '' : cutMD + '后起')
          : (hasBefore ? cutMD + '前止' : '');
      arr.push({
        year: yr,
        ganzhi: yearGZOf(yr),
        gz: yearGZOf(yr),
        zhi: yearGZOf(yr).charAt(1),
        /*
         * ⚠⚠ 流年虚岁 = **该干支年 − 出生干支年 + 1**（来源 `liuNian` 里的 `y - gzBirthYear + 1`）。
         *   2026-10-29 版口径：和大运 / 童限**同源**，一律走干支年（tongBase）。
         *   旧版这里用公历出生年（`y - birthYear + 1`），立春前出生的人整列虚岁小 1 岁。
         */
        age: yr - tongBase + 1,
        part: part,
        partNote: partNote,
        isSplitYear: hasAfter || hasBefore,
        shareWithPrev: hasAfter && i > 0,
        shareWithNext: hasBefore && i < count,
        hasCut: ly.some(function (x) { return !!x.cut; }),
        liuYue: ly,
      });
    }
    return arr;
  }

  const steps = [];
  /*
   * 童限：出生 → 起运。
   * ★ 21:05 版：起点/终点与虚岁一律走**干支年**（gzBirthYear → 交运时刻的干支年），
   *   不再是「公历出生年 → 公历交运年」。
   */
  const gzBirth = gzYearOf(birthStamp);
  const gzStartY = gzYearOf(jy.startAt);
  const gzEndNum = gzYearNumOf(jy.startAt);
  const tongYFrom = (gzBirthYear != null) ? gzBirthYear : birthYear;
  const tongYTo = (gzEndNum != null) ? gzEndNum : startYear;
  steps.push({
    step: 0,
    isTongXian: true,
    ganzhi: null,
    ageFrom: 0,
    ageTo: round2(startAge),
    ageFromInt: 1,
    ageToInt: tongYTo - tongYFrom + 1,
    yearFrom: tongYFrom,
    yearTo: tongYTo,
    gzYearFrom: gzBirth,
    gzYearTo: gzStartY,
    gzYears: (gzBirth && gzStartY) ? gzBirth + '–' + gzStartY : null,
    gzYearLabel: (gzBirth && gzStartY)
      ? gzBirth + '–' + gzStartY + '（' + tongYFrom + '–' + tongYTo + '）'
      : null,
    startAt: jy.startAt,
    endAt: jy.startAt,
    cutMD: jy.startAt.slice(5, 7) + '月' + jy.startAt.slice(8, 10) + '日',
    cutAt: jy.startAt,
    note: '童限（未起运）',
    liuNian: liuNian(0, tongYFrom, tongYTo - tongYFrom),
  });

  for (let i = 0; i < count; i++) {
    /* 起止时刻：第 1 步起点 = 交运本身，其后各步按「节气 + 偏移」重算（含锚年偏移）。
     *  兜底串 = 「年份 + 交运的月日时分」（ymd.slice(4)），不是裸月日 —— 00:37 版口径。 */
    const startStamp = (i === 0) ? jy.startAt : (stepStamp(startYear + i * stepYears) || (String(startYear + i * stepYears) + jy.startAt.slice(4)));
    const endStamp = stepStamp(startYear + (i + 1) * stepYears) || (String(startYear + (i + 1) * stepYears) + jy.startAt.slice(4));
    // 虚岁 / 年份列都走干支年（交运在立春前时比公历年小 1）
    const gzYFrom = gzYearNumOf(startStamp);
    const gzYTo = gzYearNumOf(endStamp);
    const yFrom = (gzYFrom != null) ? gzYFrom : (startYear + i * stepYears);
    const yTo = (gzYTo != null) ? gzYTo : (startYear + (i + 1) * stepYears);

    const g = GAN[((g0 + i * step) % 10 + 10) % 10];
    const z = ZHI[((z0 + i * step) % 12 + 12) % 12];
    const gzFrom = gzYearOf(startStamp);
    const gzTo = gzYearOf(endStamp);
    steps.push({
      step: i + 1,
      isTongXian: false,
      ganzhi: g + z,
      ageFrom: round2(startAge + i * stepYears),
      ageTo: round2(startAge + (i + 1) * stepYears),
      ageFromInt: yFrom - tongYFrom + 1,
      ageToInt: yTo - tongYFrom + 1,
      yearFrom: yFrom,
      yearTo: yTo,
      gzYearFrom: gzFrom,
      gzYearTo: gzTo,
      gzYears: (gzFrom && gzTo) ? gzFrom + '–' + gzTo : null,
      gzYearLabel: (gzFrom && gzTo) ? gzFrom + '–' + gzTo + '（' + yFrom + '–' + yTo + '）' : null,
      startAt: startStamp,
      endAt: endStamp,
      /*
       * ⚠ 换运月日**逐年浮动**（01-05 / 01-06 / 01-07 都可能），
       *   所以 cutMD 必须取本步实际终点，不能用固定的首次交运月日。
       */
      cutMD: endStamp ? (endStamp.slice(5, 7) + '月' + endStamp.slice(8, 10) + '日') : null,
      cutAt: endStamp,
      note: '',
      /* `model.buildDayuns` 认的字段（与 chart.js 的 daYun 同构） */
      starYear: yFrom,
      startAge: yFrom - tongYFrom + 1,
      dayunganzhi: g + z,
      liuNian: liuNian(i + 1, yFrom, stepYears),
    });
  }

  return {
    direction: jy.direction,
    rule: jy.rule,
    fromMonth: jy.fromMonth,
    firstYun: jy.firstYun,
    startAt: jy.startAt,
    startMD: startMD,
    cutMD: cutMD,
    startAgeText: jy.startAgeText,
    birthYear: birthYear,
    startYear: startYear,
    stepYears: stepYears,
    steps: steps,
  };
}

/* ================= 工具 ================= */

function round2(x) { return Math.round(x * 100) / 100; }

/**
 * 出生时刻所属的**农历年**（大运岁数的基准）。
 * ⚠ 与定气法 `bazi.js getBirthYear` 完全同一口径（那边取 lunarYear.getYear()）：
 *   1990-01-01 11:04 ⇒ 农历己巳年 ⇒ 1989，**不是**公历 1990，也**不是**立春年 1989
 *   （这一盘两者碰巧同值；春节在立春前后的年份会差）。
 *   走 chart.js 的农历实现，不在这里自己判春节。
 */
function lunarYearOf(bt) {
  try {
    const st = tyme.SolarTime.fromYmdHms(bt.year, bt.month, bt.day, bt.hour || 0, bt.minute || 0, 0);
    const ly = st.getLunarHour().getLunarDay().getLunarMonth().getLunarYear();
    return Number(ly.getYear());
  } catch (e) {
    return bt.year;   // 降级：极端日期取公历年（只在算不出来时兜底）
  }
}

/** 轴 → 加 n 年 n 月 n 天（字面值轴，不做时区换算） */
function addCalendar(ms, yy, mm, dd) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear() + yy, d.getUTCMonth() + mm, d.getUTCDate() + dd,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

/** 该年是否在节气表覆盖范围内 */
function supported(year) {
  return !!DATA[String(year)];
}

/** 取某年某节的时刻（毫秒；无时区轴）。供流月表用。 */
function termAt(year, jie) {
  return termAtRaw(year, jie, KEY);
}

module.exports = {
  paipan: paipan,
  siLing: siLing,
  siLingText: siLingText,
  taiYuan: taiYuan,
  jiaoYun: jiaoYun,
  jiaoYunText: jiaoYunText,
  daYun: daYun,
  monthGzOf: monthGzOf,
  termAt: termAt,
  JIE_ORDER: JIE_ORDER,
  supported: supported
};
