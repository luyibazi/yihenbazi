/**
 * 时间工具：解析、格式化，以及出生时间选择器要用的列数据
 *
 * 公历可选年范围在这里定义 —— 首页「出生时间」是五步点选面板
 * （年 / 月 / 日 / 时 / 分），各列数据都从这里取。
 *
 * ⚠ 公历的月长与闰年**一律问 tyme**（不再自己算）。理由不是「手写那四行会错」，
 *   而是**口径只能有一个来源**：农历 / 闰月 / 节气早就走 tyme，公历月长却自己算 ——
 *   一旦哪天规则被改坏（比如漏掉「百年不闰、四百年再闰」这一条），
 *   1000~2050 这个区间里**永远暴露不出来**（要 2100 年才踩得到），抽样测试也测不到。
 *   交给库就没有这一层可能。代价是零：记录页 / 结果页本来就通过
 *   chart.js、lunar.js 载入 tyme，换过来不增加任何加载。
 *   `tools/check-calendar.js` 会拿 tyme 与**原生 Date** 两路独立结果全量对拍
 *   （1000~2051 逐月 + 逐日往返约 38 万天）。
 */

const tyme = require('../vendor/tyme.js');

/**
 * 出生年份可选范围：1000 ~ 2050
 * 下限放到 1000 是用户要求的（历史人物排盘）；底层 tyme4ts 完全覆盖 ——
 * 实测 1000 / 1100 / 1500 / 2100 年的农历换算、四柱、司令、起运、大运、流年都正常，
 * 流年区间跟着出生年走（1000 年生 → 1000~1070），不是写死的年份表。
 */
const SOLAR_YEAR_MIN = 1000;
const SOLAR_YEAR_MAX = 2050;

/**
 * **真值校验**用的宽松边界，比可选范围各宽一年。
 *
 * 农历换算天然会越出公历可选范围：
 *   · 公历 1000-01-01 落在农历 **999 年**腊月（所以 lunar.YEAR_MIN 是 999）
 *   · 农历 2050 年腊月会落到公历 **2051 年**初
 * 这两个都是合法真值，record.hydrate 不能拿可选范围去卡它们 ——
 * 卡掉的话，用户从农历 2050 年腊月点确定，排盘会莫名其妙失败。
 */
const YEAR_FLOOR = SOLAR_YEAR_MIN - 1;
const YEAR_CEIL = SOLAR_YEAR_MAX + 1;

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** '1990-01-01' → { y:1990, m:1, d:1 } */
function parseDate(str) {
  const parts = String(str || '').split('-');
  return {
    y: parseInt(parts[0], 10) || SOLAR_YEAR_MIN,
    m: parseInt(parts[1], 10) || 1,
    d: parseInt(parts[2], 10) || 1
  };
}

/** '11:04' → { h:11, mi:4 } */
function parseTime(str) {
  const parts = String(str || '').split(':');
  return {
    h: parseInt(parts[0], 10) || 0,
    mi: parseInt(parts[1], 10) || 0
  };
}

function fmtDate(y, m, d) {
  return y + '-' + pad2(m) + '-' + pad2(d);
}

function fmtTime(h, mi) {
  return pad2(h) + ':' + pad2(mi);
}

/* ---------------- 选择器列数据 ---------------- */

/**
 * 公历闰年。tyme 的 `SolarYear.isLeap()` 就是标准格里高利规则
 * （能被 4 整除且不能被 100 整除，或能被 400 整除），不再自己写一遍。
 */
function isLeapYear(y) {
  return tyme.SolarYear.fromYear(y).isLeap();
}

/**
 * 某年某月的天数，m 为 1~12。
 * ⚠ tyme 对越界月份是**抛异常**（`illegal solar month: 13`）而不是返回 0 ——
 *   所以这里先把 m 收敛到 1~12 再问，免得下标算错时直接白屏。
 *   （调用点本来就会 clamp，这里只是最后一道防线。）
 */
function daysInMonth(y, m) {
  const mm = m < 1 ? 1 : (m > 12 ? 12 : m);
  return tyme.SolarMonth.fromYm(y, mm).getDayCount();
}

/* -------- 真实日号列表（1582 年 10 月那一处缺口）-------- */

const dayValueCache = {};
const dayValueKeys = [];
const DAY_VALUE_CACHE_MAX = 64;

/**
 * 该公历月**真实存在**的日号列表（1-based）。
 *
 * 绝大多数月份就是 `[1..N]`，但有**一处**例外：**1582 年 10 月** ——
 * 那一年儒略历改成格里高利历，10-05 ~ 10-14 这十天在历法上不存在
 * （1582-10-04 的次日就是 1582-10-15）。tyme 如实实现了这次改历：
 * `SolarMonth.fromYm(1582,10).getDayCount()` 给的是 **21**，不是 31。
 *
 * ⚠ 所以面板的日格**不能**按「1..N」铺：那样第 5 格会标成「5 日」，
 *   用户点下去拿到的是 1582-10-05 —— 一个不存在的日期，
 *   排盘时 `SolarDay.fromYmd` 直接抛 `illegal solar day`（历史遗留的崩溃点）。
 *   日格要铺真实日号，且「格子下标 → 日号」必须走这张表，不能再用 `下标 + 1`。
 *
 * 构造用**逐日推进**而不是 `SolarMonth.getDays()`：
 * 后者内部会对 1..N 逐个 `SolarDay.fromYmd`，撞上 1582-10-05 就抛异常。
 * 从 1 号起连着 `next(1)` 走 N 步，会自动跨过缺口，且不抛。
 *
 * @returns {Array<number>} 例：1582-10 → [1,2,3,4,15,16,…,31]（21 个）
 *          ⚠ 返回的是**内部缓存数组**，调用方只读、不要改。
 */
function solarDayValues(y, m) {
  const mm = m < 1 ? 1 : (m > 12 ? 12 : m);
  const key = y + '-' + mm;
  if (dayValueCache[key]) return dayValueCache[key];

  const count = tyme.SolarMonth.fromYm(y, mm).getDayCount();
  const list = [];
  let day = tyme.SolarDay.fromYmd(y, mm, 1);
  for (let i = 0; i < count; i++) {
    list.push(day.getDay());
    day = day.next(1);
  }

  dayValueCache[key] = list;
  dayValueKeys.push(key);
  if (dayValueKeys.length > DAY_VALUE_CACHE_MAX) delete dayValueCache[dayValueKeys.shift()];
  return list;
}

// 不随年月变化的列只生成一次
let yearCache = null;
let monthCache = null;
let hourCache = null;
let minuteCache = null;

/** 年份列 ['1000', '1001', ...] —— 面板里按「区（最多 120 年）」铺，见 utils/datepick.js */
function solarYearLabels() {
  if (!yearCache) {
    const list = [];
    for (let y = SOLAR_YEAR_MIN; y <= SOLAR_YEAR_MAX; y++) list.push(String(y));
    yearCache = list;
  }
  return yearCache;
}

/** 第二列：月份 ['1月', ...] */
function solarMonthLabels() {
  if (!monthCache) {
    const list = [];
    for (let m = 1; m <= 12; m++) list.push(m + '月');
    monthCache = list;
  }
  return monthCache;
}

/** 第三列：日 ['1日', ...]，随年月变化（闰年二月 29 天；1582 年 10 月只有 21 格） */
function solarDayLabels(y, m) {
  return solarDayValues(y, m).map(function (d) { return d + '日'; });
}

/** 第四列：小时 ['0时', ...] */
function hourLabels() {
  if (!hourCache) {
    const list = [];
    for (let h = 0; h <= 23; h++) list.push(h + '时');
    hourCache = list;
  }
  return hourCache;
}

/** 第五列：分钟 ['0分', ...] */
function minuteLabels() {
  if (!minuteCache) {
    const list = [];
    for (let mi = 0; mi <= 59; mi++) list.push(mi + '分');
    minuteCache = list;
  }
  return minuteCache;
}

module.exports = {
  SOLAR_YEAR_MIN: SOLAR_YEAR_MIN,
  SOLAR_YEAR_MAX: SOLAR_YEAR_MAX,
  YEAR_FLOOR: YEAR_FLOOR,
  YEAR_CEIL: YEAR_CEIL,
  pad2: pad2,
  parseDate: parseDate,
  parseTime: parseTime,
  fmtDate: fmtDate,
  fmtTime: fmtTime,
  isLeapYear: isLeapYear,
  daysInMonth: daysInMonth,
  solarDayValues: solarDayValues,
  solarYearLabels: solarYearLabels,
  solarMonthLabels: solarMonthLabels,
  solarDayLabels: solarDayLabels,
  hourLabels: hourLabels,
  minuteLabels: minuteLabels
};
