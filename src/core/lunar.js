/**
 * 农历模块 —— 基于 tyme4ts（MIT，https://github.com/6tail/tyme4ts）
 *
 * 提供两类能力：
 *   1. 公历 ↔ 农历换算（用于结果页展示、记录页文案）
 *   2. 农历多列选择器所需的数据（年 / 月含闰月 / 日）
 *
 * ⚠ 文案里的年份是**中文数字年**（1998 → 一九九八），不是干支年（2026-10-01 用户要求）。
 *    两条理由：
 *      ① 干支年在四柱里已经有了，农历这行再写一遍是重复信息；
 *      ② 农历年的干支以「正月初一」为界，与排盘里的年柱（以立春为界）**不是同一个口径** ——
 *         同一个界面里摆两个「年干支」而口径不同，最容易让人算错。
 *    干支年仍以 `gzYear` 字段给出（生肖 `animal` 就是从它推的），只是不再进文案。
 *
 * 注意：选择器第一列的主文本仍然只放年份数字（避免列过宽），
 *      **干支作为后缀小字**由 `yearGanZhi()` 提供（2026-10-05 用户要求）。
 */

const tyme = require('../vendor/tyme.js');

/**
 * 农历可选年范围：要覆盖公历 1000-01-01 ~ 2050-12-31
 *   · 下限 **999**：公历 1000-01-01 的农历年是 999 年（腊月十八）。
 *     少这一格的话，「公历 1000-01-01 切到农历」会被 locateInPicker 顶到 1000 年，
 *     真值凭空往后跳一年 —— 所以必须留着，哪怕它只有一年。
 *   · 上限 **2050**：公历 2050-12-31 的农历年就是 2050 年。
 *     （农历 2050 年腊月会落到公历 2051 年初，由 time.YEAR_CEIL 兜住校验。）
 */
const YEAR_MIN = 999;
const YEAR_MAX = 2050;

let yearLabelCache = null;

/** 农历年列表（供第一列使用），形如 ['999', '1000', ...] —— 只放数字，避免列过宽 */
function lunarYearLabels() {
  if (!yearLabelCache) {
    const list = [];
    for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
      list.push(String(y));
    }
    yearLabelCache = list;
  }
  return yearLabelCache;
}

/**
 * 某一年的干支，如 1984 → 甲子、1990 → 庚午。
 *
 * ⚠ 口径：**农历年的干支（以正月初一为界）**，也就是民间说的「1990 年是庚午年」。
 *   它与排盘结果里的**年柱**（以立春为界）**不是同一个口径** ——
 *   公历 1990-01-15 的八字年柱是己巳（立春前），而这里会显示庚午。
 *   选择器上只是给「我在挑哪一年」一个便于定位的标签，不参与任何排盘计算；
 *   同一个界面里别把它当年柱用。口径说明见本文件头注 ②。
 *
 * 为什么不用 bazi.getGanZhiByYear：那个函数要拉整份排盘模块（含大运/流年），
 * 而这里只需要「年号 → 干支」这一件事（tyme 算它是纯算术，很轻）。
 */
function yearGanZhi(y) {
  return tyme.LunarYear.fromYear(y).getSixtyCycle().getName();
}

/**
 * 某农历年的月列表（第二列）
 * @returns {Object} { labels:['正月','二月','闰二月'...], values:[1,2,-2...] }
 *                  value 为「带闰月序」，闰月取负值，可直接喂给 LunarMonth.fromYm
 */
function lunarMonthOptions(lunarYear) {
  const months = tyme.LunarYear.fromYear(lunarYear).getMonths();
  const labels = [];
  const values = [];
  months.forEach(function (month) {
    labels.push(month.getName());
    values.push(month.getMonthWithLeap());
  });
  return { labels: labels, values: values };
}

/**
 * 某农历月的日列表（第三列）
 * @returns {Object} { labels:['初一','初二'...], values:[1,2,3...] }
 */
function lunarDayOptions(lunarYear, monthWithLeap) {
  const days = tyme.LunarMonth.fromYm(lunarYear, monthWithLeap).getDays();
  const labels = [];
  const values = [];
  days.forEach(function (day, index) {
    labels.push(day.getName());
    values.push(index + 1);
  });
  return { labels: labels, values: values };
}

/* 中文数字年用的字：0 取「〇」（U+3007），不是「零」——《出版物上数字用法》里
   年份是**逐位读**的，「二〇二六」而非「二千零二十六」，也不写成「二零二六」。 */
const YEAR_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/**
 * 年份逐位转中文：1998 → 一九九八、2026 → 二〇二六、999 → 九九九
 *
 * ⚠ 逐位读**不是**数词读法：「一千九百九十八」是错的，年份不这么念。
 *   所以这里不用「十百千万」那套（那是 `lunarMonthOptions` 里月份「十一月」的规则，别混）。
 */
function chineseYear(y) {
  return String(y).split('').map(function (c) {
    return YEAR_DIGITS[c.charCodeAt(0) - 48];
  }).join('');
}

/** 公历 → 农历信息 */
function solarToLunar(y, m, d) {
  const lunarDay = tyme.SolarDay.fromYmd(y, m, d).getLunarDay();
  const month = lunarDay.getLunarMonth();
  const year = month.getLunarYear();

  return {
    text: chineseYear(year.getYear()) + '年' + month.getName() + lunarDay.getName(),
    yearText: chineseYear(year.getYear()),
    gzYear: year.getSixtyCycle().getName(),
    animal: year.getSixtyCycle().getEarthBranch().getZodiac().getName(),
    lYear: year.getYear(),
    lMonth: month.getMonthWithLeap(),
    lDay: lunarDay.getDay(),
    monthName: month.getName(),
    dayName: lunarDay.getName(),
    isLeap: month.isLeap()
  };
}

/** 农历 → 公历，并给出农历文案 */
function lunarToSolar(lunarYear, monthWithLeap, day) {
  const lunarDay = tyme.LunarDay.fromYmd(lunarYear, monthWithLeap, day);
  const solarDay = lunarDay.getSolarDay();

  return {
    y: solarDay.getYear(),
    m: solarDay.getMonth(),
    d: solarDay.getDay(),
    dateText: solarDay.getYear() + '-' + pad2(solarDay.getMonth()) + '-' + pad2(solarDay.getDay()),
    text: lunarDay.getLunarMonth().getName() + lunarDay.getName()
  };
}

/**
 * 公历日期落在农历选择器里的位置
 * @returns {Object} { yearIndex, monthIndex, dayIndex, text }
 *                  索引按 lunarYearLabels / lunarMonthOptions / lunarDayOptions 的顺序
 */
function locateInPicker(y, m, d) {
  const lunar = solarToLunar(y, m, d);

  let year = lunar.lYear;
  if (year < YEAR_MIN) year = YEAR_MIN;
  if (year > YEAR_MAX) year = YEAR_MAX;

  const monthOptions = lunarMonthOptions(year);
  let monthIndex = monthOptions.values.indexOf(lunar.lMonth);
  if (monthIndex < 0) monthIndex = 0;

  const dayOptions = lunarDayOptions(year, monthOptions.values[monthIndex]);
  let dayIndex = lunar.lDay - 1;
  if (dayIndex < 0) dayIndex = 0;
  if (dayIndex > dayOptions.values.length - 1) dayIndex = dayOptions.values.length - 1;

  return {
    yearIndex: year - YEAR_MIN,
    monthIndex: monthIndex,
    dayIndex: dayIndex,
    year: year,
    month: monthOptions.values[monthIndex],
    day: dayOptions.values[dayIndex],
    text: solarToLunar(y, m, d).text
  };
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

module.exports = {
  YEAR_MIN: YEAR_MIN,
  YEAR_MAX: YEAR_MAX,
  lunarYearLabels: lunarYearLabels,
  yearGanZhi: yearGanZhi,
  lunarMonthOptions: lunarMonthOptions,
  lunarDayOptions: lunarDayOptions,
  solarToLunar: solarToLunar,
  lunarToSolar: lunarToSolar,
  locateInPicker: locateInPicker,
  chineseYear: chineseYear
};
