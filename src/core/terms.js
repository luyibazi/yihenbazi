/**
 * 二十四节气 —— 基于 tyme4ts（MIT，https://github.com/6tail/tyme4ts）
 *
 * 只做一件事：给定公历日期，回答「这天是不是节气日、是哪个节气」。
 * 出生时间面板的「日」格要标出节气点（用户要求）；八字里十二「节」还是月柱的分界，
 * 选出生日期时能看见节气是有实际意义的。
 *
 * ⚠ 判「当天是不是节气日」**不能**用 SolarTime.getTerm() ——
 *   它返回的是「该时刻**所处**的节气」，一天之内会变：
 *   2024-02-04 立春 16:27，当天 0 点返回「大寒」，23 点才返回「立春」。
 *   正确做法是取节气本身的公历日：SolarTerm.fromIndex(y, i).getSolarDay()。
 *
 * ⚠ 也**不能**只扫「i = 1..24」就收工：
 *   SolarTerm.fromIndex(y, i) 的 i 是「y 年度序列里的第 i 个」，i=0 是**上一年冬至**。
 *   早年（格里高利历尚未通行）节气会漂到上一个公历年 —— 实测「1001 年的小寒」
 *   落在公历 **1000-12-31**。只扫本年度的话，1000-12-31 这天就标不出「小寒」。
 *   所以按 y-1 ~ y+1 三年一起扫，再按节气**实际的公历日**归到对应年份。
 */

const tyme = require('../vendor/tyme.js');

// 每个公历年只用算一次（只有选中「日」那一步会问到这里，且换了月份也还在同一年）
const yearCache = {};

/** 补零到两位（`2` → `'02'`）：节气时刻要显示成 16:27 / 02:45 这种 */
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * 某公历年的全部节气
 * @param {number} year 公历年
 * @returns {Object} { 'M-D': { name:'立春', jie:true, time:'16:27' }, … }（只有节气日才有键）
 */
function termsOfYear(year) {
  const y = parseInt(year, 10);
  if (yearCache[y]) return yearCache[y];

  const map = {};
  for (let yy = y - 1; yy <= y + 1; yy++) {
    for (let i = 0; i <= 24; i++) {
      let term;
      let day;
      let st;
      try {
        term = tyme.SolarTerm.fromIndex(yy, i);
        day = term.getSolarDay();
        // 节气的**交接时刻**：SolarTerm 本身不给时刻（没有 getSolarTime），
        // 要从它对应的儒略日反算 —— JulianDay.getSolarTime() 才带时分。
        st = term.getJulianDay().getSolarTime();
      } catch (err) {
        continue;   // 超出台库覆盖范围：跳过（面板上不标节气，不报错、不打断排盘）
      }
      if (!day || day.getYear() !== y) continue;   // 邻年的节气不算，一律按实际公历日归年
      map[day.getMonth() + '-' + day.getDay()] = {
        name: term.getName(),
        jie: term.isJie(),     // true = 十二「节」（月柱分界）/ false = 十二「气」
        // 交节时刻（当地时区，与台库口径一致）：2024 立春 = 16:27
        time: st ? (pad2(st.getHour()) + ':' + pad2(st.getMinute())) : ''
      };
    }
  }

  yearCache[y] = map;
  return map;
}

/**
 * 公历某天的节气
 * @returns {Object|null} { name, jie, time }；不是节气日返回 null
 */
function termOfDay(y, m, d) {
  return termsOfYear(y)[m + '-' + d] || null;
}

module.exports = {
  termsOfYear: termsOfYear,
  termOfDay: termOfDay
};
