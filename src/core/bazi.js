/**
 * 八字排盘封装
 *
 * 移植自用户本地项目 mingliWEB（D:/aiProjecct/workbuddyApp/mingliWEB）：
 *   - dayunliunianliuyue.js 的 window.BaZiCalc —— 大运 / 流年 / 流月 / 司令分野 / 胎元 / 起运交运
 *   - bazi.js 的 calculateBaZi —— 四柱 + 起运 + 逐年小运与所属大运
 *   - rysl.json 的十二地支藏干分日用事（与 dayunliunianliuyue.js 内嵌的 RYSL_DATA 完全一致）
 *
 * 只取计算逻辑，不含其页面 UI。原文件是挂在 window 上的 IIFE、直接使用全局 tyme 类；
 * 这里改为 CommonJS 并从 vendor/tyme.js 取类，函数体逐行保持一致。
 *
 * 移植时与原文件的已知差异（都为了能跑在小程序里，不影响计算结果）：
 *   1. 不返回 childLimit 等 tyme 实例（无法序列化，存 storage 会炸），改返回派生出的纯数据
 *   2. generateLunarMonths 里原有一段 jieQiMap 赋值后从未被使用，已略去
 *   3. padStart / 模板字符串 / 箭头函数等改为 ES5 写法（与项目其余文件一致）
 *
 * 与 utils/chart.js 的分工：
 *   chart.js   四柱 / 十神 / 五行 / 时辰 / 生肖（结果页四柱区）
 *   bazi.js    司令分野 / 胎元 / 起运交运 / 大运 / 流年流月
 */

const tyme = require('../vendor/tyme.js');

const SolarTime = tyme.SolarTime;
const SolarDay = tyme.SolarDay;
const SolarTerm = tyme.SolarTerm;
const LunarYear = tyme.LunarYear;
const LunarMonth = tyme.LunarMonth;
const ChildLimit = tyme.ChildLimit;

/* 天干五合映射 */
const GAN_HE_MAP = {
  '甲': '己', '己': '甲',
  '乙': '庚', '庚': '乙',
  '丙': '辛', '辛': '丙',
  '丁': '壬', '壬': '丁',
  '戊': '癸', '癸': '戊'
};

/* 十二个月的「节」，顺序与月支一致：寅月起于立春 */
const MONTH_JIE_QI = ['立春', '惊蛰', '清明', '立夏', '芒种', '小暑', '立秋', '白露', '寒露', '立冬', '大雪', '小寒'];

// rysl.json · 十二地支藏干人元司令分日用事
// 顺序：寅(立春) → 卯(惊蛰) → 辰(清明) → 巳(立夏) → 午(芒种) → 未(小暑)
//       申(立秋) → 酉(白露) → 戌(寒露) → 亥(立冬) → 子(大雪) → 丑(小寒)
// 算法：前面各段按固定天数，最后一段吃掉当月剩余所有天数（不论月大月小）
const RYSL_DATA = [
  { 月份: '寅月', 节气: '立春', 分日用事: [{ 天数: 7, 藏干: '戊' }, { 天数: 7, 藏干: '丙' }, { 天数: 16, 藏干: '甲' }] },
  { 月份: '卯月', 节气: '惊蛰', 分日用事: [{ 天数: 10, 藏干: '甲' }, { 天数: 20, 藏干: '乙' }] },
  { 月份: '辰月', 节气: '清明', 分日用事: [{ 天数: 9, 藏干: '乙' }, { 天数: 3, 藏干: '癸' }, { 天数: 18, 藏干: '戊' }] },
  { 月份: '巳月', 节气: '立夏', 分日用事: [{ 天数: 5, 藏干: '戊' }, { 天数: 9, 藏干: '庚' }, { 天数: 16, 藏干: '丙' }] },
  { 月份: '午月', 节气: '芒种', 分日用事: [{ 天数: 10, 藏干: '丙' }, { 天数: 9, 藏干: '己' }, { 天数: 11, 藏干: '丁' }] },
  { 月份: '未月', 节气: '小暑', 分日用事: [{ 天数: 9, 藏干: '丁' }, { 天数: 3, 藏干: '乙' }, { 天数: 18, 藏干: '己' }] },
  { 月份: '申月', 节气: '立秋', 分日用事: [{ 天数: 10, 藏干: '戊' }, { 天数: 3, 藏干: '壬' }, { 天数: 17, 藏干: '庚' }] },
  { 月份: '酉月', 节气: '白露', 分日用事: [{ 天数: 10, 藏干: '庚' }, { 天数: 20, 藏干: '辛' }] },
  { 月份: '戌月', 节气: '寒露', 分日用事: [{ 天数: 9, 藏干: '辛' }, { 天数: 3, 藏干: '丁' }, { 天数: 18, 藏干: '戊' }] },
  { 月份: '亥月', 节气: '立冬', 分日用事: [{ 天数: 7, 藏干: '戊' }, { 天数: 5, 藏干: '甲' }, { 天数: 18, 藏干: '壬' }] },
  { 月份: '子月', 节气: '大雪', 分日用事: [{ 天数: 10, 藏干: '壬' }, { 天数: 20, 藏干: '癸' }] },
  { 月份: '丑月', 节气: '小寒', 分日用事: [{ 天数: 9, 藏干: '癸' }, { 天数: 3, 藏干: '辛' }, { 天数: 18, 藏干: '己' }] }
];

/* ---------------- 基础工具 ---------------- */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 时辰名称（原 bazi.js 的 getShiChen，口径：23 点后称夜子时） */
function getShiChen(hour) {
  if (hour >= 23) return '夜子时';
  const names = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const idx = Math.floor((hour + 1) / 2);
  return names[idx] + '时';
}

/** 日期字符串 → {year, month, day, hour, minute}，支持「2026年4月15日 08:00」与「1998-11-27 08:00」 */
function dateZhuanhuan(birthDate) {
  const zhRegex = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/;
  let match = birthDate.match(zhRegex);

  if (!match) {
    const enRegex = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/;
    match = birthDate.match(enRegex);
  }

  if (!match) {
    throw new Error('日期格式无效，请使用 "2026年4月15日 08:00" 或 "1998-11-27 08:00" 格式');
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  };
}

/** tyme4ts 时间对象 → 纯字段对象 */
function toPlainTime(t) {
  return {
    year: t.getYear(),
    month: t.getMonth(),
    day: t.getDay(),
    hour: t.getHour(),
    minute: t.getMinute(),
    second: t.getSecond()
  };
}

/** 时刻 → SolarTime 对象 */
function toSolarTime(time) {
  return SolarTime.fromYmdHms(
    time.year, time.month, time.day,
    time.hour || 0, time.minute || 0, time.second || 0
  );
}

/* ---------------- 童限（起运）与交运 ---------------- */

/** 查询出生农历年（例如 2026） */
function getBirthYear(baziTime) {
  const solarTime = toSolarTime(baziTime);
  const lunarHour = solarTime.getLunarHour();
  const lunarYear = lunarHour.getLunarDay().getLunarMonth().getLunarYear();
  return lunarYear.getYear();
}

/** 童限开始时间 = 出生时间 */
function getKaiShiTime(baziTime, genderCode) {
  const solarTime = toSolarTime(baziTime);
  const childLimit = ChildLimit.fromSolarTime(solarTime, genderCode);
  return childLimit.info.startTime;
}

/** 童限结束时间 = 起运时间 */
function getQiYunTime(baziTime, genderCode) {
  const solarTime = toSolarTime(baziTime);
  const childLimit = ChildLimit.fromSolarTime(solarTime, genderCode);
  return childLimit.info.endTime;
}

/**
 * 某时刻距上一个「节」的时差信息
 * @returns {Object|null} { jieQi, days, hours, totalHours, yearGan, heGan, jiaoYunGan }
 */
function getLastJieQiDiff(time) {
  const solarTime = toSolarTime(time);
  const targetTs = solarTime.getJulianDay();

  const eightChar = solarTime.getLunarHour().getEightChar();
  const yearGan = eightChar.getYear().getName().charAt(0);
  const heGan = GAN_HE_MAP[yearGan] || '';

  let lastTerm = null;
  let lastTs = null;
  for (let y = time.year - 1; y <= time.year + 1; y++) {
    for (let i = 0; i < 24; i++) {
      try {
        const term = SolarTerm.fromIndex(y, i);
        if (!term.isJie()) continue;
        const termTs = term.getJulianDay();
        if (termTs <= targetTs && (!lastTs || termTs > lastTs)) {
          lastTs = termTs;
          lastTerm = term;
        }
      } catch (e) { /* 超出库支持范围，跳过 */ }
    }
  }
  if (!lastTerm) return null;

  const totalHours = Math.floor((targetTs - lastTs) * 24);
  return {
    jieQi: lastTerm.getName(),
    days: Math.floor(totalHours / 24),
    hours: totalHours % 24,
    totalHours: totalHours,
    yearGan: yearGan,
    heGan: heGan,
    jiaoYunGan: yearGan + heGan
  };
}

/** 第一步大运的年份（用交运时刻的年柱干支去匹配农历年干支） */
function getfirstTime(tongxianjiesushijian) {
  const mohuNianFeng = [
    tongxianjiesushijian.getYear() - 1,
    tongxianjiesushijian.getYear(),
    tongxianjiesushijian.getYear() + 1
  ].map(function (year) {
    return {
      year: year,
      ganzhi: LunarYear.fromYear(year).getSixtyCycle().getName()
    };
  });

  const solarTime = toSolarTime(toPlainTime(tongxianjiesushijian));
  const ec = solarTime.getLunarHour().getEightChar();
  const jiaoyunganzhi = ec.getYear().getName();

  for (let i = 0; i < mohuNianFeng.length; i++) {
    if (mohuNianFeng[i].ganzhi === jiaoyunganzhi) return mohuNianFeng[i];
  }
  return undefined;
}

/**
 * 排出十二步大运
 * @param {Object} baziTime 出生时间 { year, month, day, hour, minute }
 * @param {string} targetTianGan 交运天干
 * @param {string} yueGZ 月柱干支
 * @param {number} dir 1 顺行 / 0 逆行
 * @param {number} gender 1 男 / 0 女
 * @returns {Array<{starYear, dayunganzhi, startAge}>}
 */
function findYearsByGanZhi(baziTime, targetTianGan, yueGZ, dir, gender) {
  const startY = getBirthYear(baziTime);
  const tongxianjiesushijian = getQiYunTime(baziTime, gender);
  const dayunStartYear = getfirstTime(tongxianjiesushijian);

  const tianGan = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const diZhi = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

  const getOffsetGanZhi = function (startGanZhi, steps) {
    const tgIdx = tianGan.indexOf(startGanZhi[0]);
    const dzIdx = diZhi.indexOf(startGanZhi[1]);
    if (tgIdx === -1 || dzIdx === -1) throw new Error('无效的干支');

    let startIndex = -1;
    for (let i = 0; i < 60; i++) {
      if (i % 10 === tgIdx && i % 12 === dzIdx) {
        startIndex = i;
        break;
      }
    }

    let targetIndex;
    if (dir === 1) {
      targetIndex = (startIndex + steps + 1) % 60;
    } else {
      targetIndex = (startIndex - (steps + 1) + 60) % 60;
    }

    return tianGan[targetIndex % 10] + diZhi[targetIndex % 12];
  };

  const targetIdx = tianGan.indexOf(targetTianGan);
  if (targetIdx === -1) {
    throw new Error('无效的天干，请输入：甲、乙、丙、丁、戊、己、庚、辛、壬、癸');
  }

  const dayunArr = [];
  for (let i = 0; i < 12; i++) {
    const year = dayunStartYear.year + i * 10;
    dayunArr.push({
      starYear: year,
      dayunganzhi: getOffsetGanZhi(yueGZ, i),
      startAge: year - startY + 1
    });
  }

  return dayunArr;
}

/** 某公历年对应的干支（用 6 月 1 日定农历年，避开春节前后偏差） */
function getGanZhiByYear(year) {
  const solarDay = SolarDay.fromYmd(year, 6, 1);
  const lunarYear = solarDay.getLunarDay().getLunarMonth().getLunarYear();
  return lunarYear.getSixtyCycle().getName();
}

/** 童限区间内逐年的干支与流月（含各流月对应的节气与阳历时刻） */
function getYearRange(baziTime, gender) {
  const startYear = getBirthYear(baziTime);
  const tongxianjiesushijian = getQiYunTime(baziTime, gender);
  const jiaoyun = getLastJieQiDiff(toPlainTime(tongxianjiesushijian));
  const qishi = getLastJieQiDiff(toPlainTime(getKaiShiTime(baziTime, gender)));
  const endYear = getfirstTime(tongxianjiesushijian).year;

  const years = [];
  const min = Math.min(startYear, endYear);
  const max = Math.max(startYear, endYear);

  for (let i = min; i <= max; i++) {
    const months = MONTH_JIE_QI.filter(function (jieQiName) {
      const refIndexStart = MONTH_JIE_QI.indexOf(qishi.jieQi);
      const refIndexEnd = MONTH_JIE_QI.indexOf(jiaoyun.jieQi);
      const targetIndex = MONTH_JIE_QI.indexOf(jieQiName);
      if (i === min) {
        if (refIndexStart === targetIndex) return true;
        if (targetIndex < refIndexStart) return false;
      }
      if (i === max) {
        if (refIndexEnd === targetIndex) return true;
        if (targetIndex > refIndexEnd) return false;
      }
      return true;
    }).map(function (jieQiName) {
      const lunarMonth = LunarMonth.fromYm(i, MONTH_JIE_QI.indexOf(jieQiName) + 1);
      const monthGanZhi = lunarMonth.getSixtyCycle().getName();

      let solarTime;
      if (jieQiName === '大寒' || jieQiName === '小寒') {
        solarTime = SolarTerm.fromName(i + 1, jieQiName).getJulianDay().getSolarTime();
      } else {
        solarTime = SolarTerm.fromName(i, jieQiName).getJulianDay().getSolarTime();
      }
      return { JieQi: jieQiName, ganZhi: monthGanZhi, solarDate: solarTime };
    });

    years.push({
      nianling: i - startYear + 1,
      year: i,
      yearGanZhi: getGanZhiByYear(i),
      months: months
    });
  }
  return years;
}

/** 起始年起 11 个年份及对应干支 */
function getTenYearsRange(startYear) {
  const years = [];
  for (let i = 0; i <= 10; i++) {
    const year = startYear + i;
    const lunarYear = SolarDay.fromYmd(year, 6, 1).getLunarDay().getLunarMonth().getLunarYear();
    years.push({ year: year, ganZhi: lunarYear.getSixtyCycle().getName() });
  }
  return years;
}

/**
 * 某一步大运内，逐年农历月份、月干支与节令阳历时刻
 * @param {number} dayunIndex 第几步大运（0 起）
 */
function generateLunarMonths(baziTime, gender, dayunIndex) {
  const birthYear = getBirthYear(baziTime);
  const tongxianjiesushijian = getQiYunTime(baziTime, gender);
  const jiaoyun = getLastJieQiDiff(toPlainTime(tongxianjiesushijian));
  let startYear = getfirstTime(tongxianjiesushijian).year;
  startYear = startYear + dayunIndex * 10;

  const yearsData = getTenYearsRange(startYear);

  return yearsData.map(function (item, index, arr) {
    const lunarYear = LunarYear.fromYear(item.year);
    void lunarYear;
    const isFirst = index === 0;
    const isLast = index === arr.length - 1;

    const monthsArr = MONTH_JIE_QI.filter(function (m) {
      const refIndex = MONTH_JIE_QI.indexOf(jiaoyun.jieQi);
      const targetIndex = MONTH_JIE_QI.indexOf(m);
      if (isFirst) {
        if (refIndex === targetIndex) return true;
        if (targetIndex < refIndex) return false;
      }
      if (isLast) {
        if (refIndex === targetIndex) return true;
        if (targetIndex > refIndex) return false;
      }
      return true;
    }).map(function (jieQiName) {
      const lunarMonth = LunarMonth.fromYm(item.year, MONTH_JIE_QI.indexOf(jieQiName) + 1);
      const monthGanZhi = lunarMonth.getSixtyCycle().getName();

      let solarTime;
      if (jieQiName === '大寒' || jieQiName === '小寒') {
        solarTime = SolarTerm.fromName(item.year + 1, jieQiName).getJulianDay().getSolarTime();
      } else {
        solarTime = SolarTerm.fromName(item.year, jieQiName).getJulianDay().getSolarTime();
      }
      return { JieQi: jieQiName, ganZhi: monthGanZhi, solarDate: solarTime };
    });

    return {
      nianling: item.year - birthYear + 1,
      year: item.year,
      yearGanZhi: item.ganZhi,
      months: monthsArr
    };
  });
}

/* ---------------- 司令分野 / 胎元 / 交运 ---------------- */

/**
 * 按 RYSL_DATA 的分日用事天数计算司令分野
 * @param {Object} time { year, month, day, hour, minute, second }
 * @returns {string} 例如「癸司令（清明第12.3天，距立夏17.8天）」
 */
function getSiLingFromRysl(time) {
  try {
    const solarTime = toSolarTime(time);
    const targetJD = solarTime.getJulianDay();
    const y = solarTime.getYear();

    const ryslJieNames = RYSL_DATA.map(function (x) { return x.节气; });

    // 收集 targetYear ±1 年内所有「节」
    const candidates = [];
    for (let yy = y - 1; yy <= y + 1; yy++) {
      for (let i = 0; i < 24; i++) {
        try {
          const term = SolarTerm.fromIndex(yy, i);
          if (!term.isJie()) continue;
          const idx = ryslJieNames.indexOf(term.getName());
          if (idx === -1) continue;
          candidates.push({ term: term, jd: term.getJulianDay(), ryslIdx: idx });
        } catch (e) { /* 跳过 */ }
      }
    }
    candidates.sort(function (a, b) { return a.jd - b.jd; });

    // 找到 <= targetJD 的最后一个节（当前月令起始）
    let curIdx = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].jd <= targetJD) curIdx = i;
      else break;
    }
    if (curIdx === -1 || curIdx + 1 >= candidates.length) return '—';

    const curJie = candidates[curIdx];
    const nextJie = candidates[curIdx + 1];
    const monthData = RYSL_DATA[curJie.ryslIdx];

    const elapsedDays = targetJD - curJie.jd;   // 交节时刻 = 0 天
    const remainDays = nextJie.jd - targetJD;

    const jieName = curJie.term.getName();
    const nextJieName = nextJie.term.getName();

    // 分段命中：前面各段按固定天数累加，最后一段吃掉当月剩余所有天数
    const segs = monthData.分日用事;
    let hit = segs[segs.length - 1];
    let accEnd = 0;
    for (let i = 0; i < segs.length; i++) {
      accEnd += segs[i].天数;
      if (i === segs.length - 1) {
        hit = segs[i];
        break;
      }
      if (elapsedDays < accEnd) {
        hit = segs[i];
        break;
      }
    }

    const fmtDay = function (d) {
      if (d < 0) d = 0;
      return Math.round(d * 10) / 10;
    };

    return hit.藏干 + '司令（' + jieName + '第' + fmtDay(elapsedDays) + '天，距' + nextJieName + fmtDay(remainDays) + '天）';
  } catch (e) {
    return '—';
  }
}

/** 胎元干支（如「壬午」） */
function getTaiYuan(baziTime) {
  const solarTime = toSolarTime(baziTime);
  const eightChar = solarTime.getLunarHour().getEightChar();
  return eightChar.getFetalOrigin().getName();
}

/**
 * 起运 / 交运信息
 * @returns {{jiaoYun, qishi, startTime, endTime, childLimit}}
 */
function getJiaoYunInfo(baziTime, genderCode) {
  const solarTime = toSolarTime(baziTime);
  const childLimit = ChildLimit.fromSolarTime(solarTime, genderCode);
  const startTime = childLimit.info.startTime;
  const endTime = childLimit.info.endTime;

  let jiaoYun = null;
  let qishi = null;
  if (endTime) jiaoYun = getLastJieQiDiff(toPlainTime(endTime));
  if (startTime) qishi = getLastJieQiDiff(toPlainTime(startTime));

  return { jiaoYun: jiaoYun, qishi: qishi, childLimit: childLimit, startTime: startTime, endTime: endTime };
}

/**
 * 交运文案：「白露后22天5小时（辛丙）」
 * 与 mingliWEB 排盘卡的「交运」展示保持一致，便于两个项目对照
 * @param {Object|null} jiaoYun getJiaoYunInfo().jiaoYun
 */
function jiaoYunText(jiaoYun) {
  if (!jiaoYun) return '';
  return jiaoYun.jieQi + '后' + jiaoYun.days + '天' + jiaoYun.hours + '小时（' + jiaoYun.jiaoYunGan + '）';
}

/* ---------------- 主入口 ---------------- */

/** 纯数据化：SolarTime → 「1998年3月4日 06:06:00」 */
function solarTimeText(t) {
  if (!t) return '';
  return t.toString();
}

/** 纯数据化：SolarTime → {y,m,d,h,mi,second,text} */
function solarTimePlain(t) {
  if (!t) return null;
  const p = toPlainTime(t);
  p.text = solarTimeText(t);
  p.dateText = p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
  p.timeText = pad2(p.hour) + ':' + pad2(p.minute);
  return p;
}

/**
 * 排八字（四柱 + 司令分野 + 胎元 + 起运交运 + 大运 + 逐年小运）
 *
 * @param {Object} input { year, month, day, hour, minute, gender }
 *                      gender: 1 男 / 0 女
 * @returns {Object} 全部为纯数据，可直接 setData / 存 storage
 */
function calculate(input) {
  const year = input.year;
  const month = input.month;
  const day = input.day;
  const hour = input.hour || 0;
  const minute = input.minute || 0;
  const genderCode = input.gender === 0 ? 0 : 1;

  const baziTime = { year: year, month: month, day: day, hour: hour, minute: minute };
  const solarTime = SolarTime.fromYmdHms(year, month, day, hour, minute, 0);
  const lunarHour = solarTime.getLunarHour();
  const eightChar = lunarHour.getEightChar();

  const lunarYear = lunarHour.getLunarDay().getLunarMonth().getLunarYear();

  // 司令分野（按藏干分日用事天数）
  const siLing = getSiLingFromRysl(baziTime);

  // 起运（童限）与交运
  const jyInfo = getJiaoYunInfo(baziTime, genderCode);
  const childLimit = jyInfo.childLimit;
  const jiaoYun = jyInfo.jiaoYun;
  const qishi = jyInfo.qishi;

  // 大运顺逆：男逢阳年 / 女逢阴年顺行，男逢阴年 / 女逢阳年逆行
  const yearGan = eightChar.getYear().getName().charAt(0);
  const isYangGan = '甲丙戊庚壬'.indexOf(yearGan) >= 0;
  const isMale = genderCode === 1;
  const dayunDirection = (isMale === isYangGan) ? 1 : 0;

  const dayuns = jiaoYun
    ? findYearsByGanZhi(baziTime, jiaoYun.yearGan, eightChar.getMonth().getName(), dayunDirection, genderCode)
    : [];

  // 出生年起到第 70 年，逐年小运与所属大运
  const birthYear = year;
  const endYear = birthYear + 70;
  const yearlyFortunes = [];
  const firstFortune = childLimit.getStartFortune();
  const firstDecade = childLimit.getStartDecadeFortune();
  const endSixtyCycleYear = childLimit.getEndSixtyCycleYear().getYear();
  const startDecadeYear = firstDecade.getStartSixtyCycleYear().getYear();

  for (let y = birthYear; y <= endYear; y++) {
    const offset = y - endSixtyCycleYear;
    const fortune = firstFortune.next(offset);

    let daYunName = '';
    const daYunIndex = Math.floor((y - startDecadeYear) / 10);
    if (daYunIndex >= 0) {
      daYunName = firstDecade.next(daYunIndex).getName();
    }

    yearlyFortunes.push({
      year: y,
      age: fortune.getAge(),
      daYun: daYunName,
      xiaoYun: fortune.getName()
    });
  }

  return {
    qianKun: genderCode === 1 ? '乾' : '坤',

    // 四柱
    year: eightChar.getYear().getName(),
    month: eightChar.getMonth().getName(),
    day: eightChar.getDay().getName(),
    hour: eightChar.getHour().getName(),

    // 司令分野 / 胎元
    siLing: siLing,
    taiYuan: getTaiYuan(baziTime),

    // 起运交运
    qiYunTime: solarTimePlain(jyInfo.endTime),
    jiaoYun: jiaoYun,
    qishi: qishi,

    // 大运 / 小运
    dayunDirection: dayunDirection,
    dayuns: dayuns,
    yearlyFortunes: yearlyFortunes,

    // 展示用文案
    shiChen: getShiChen(hour),
    birthYear: lunarYear.getYear(),
    gender: genderCode,
    birthDate: year + '年' + month + '月' + day + '日 ' + pad2(hour) + ':' + pad2(minute),
    solarDate: year + '年' + month + '月' + day + '日',
    lunarDate: lunarHour.getLunarDay().getLunarMonth().getName() + lunarHour.getLunarDay().getName(),
    lunarYearGanZhi: lunarYear.getSixtyCycle().getName(),
    inputParams: { year: year, month: month, day: day, hour: hour, minute: minute, gender: genderCode }
  };
}

module.exports = {
  calculate: calculate,

  // 与原 BaZiCalc 一一对应的细分接口
  dateZhuanhuan: dateZhuanhuan,
  getBirthYear: getBirthYear,
  getKaiShiTime: getKaiShiTime,
  getQiYunTime: getQiYunTime,
  getLastJieQiDiff: getLastJieQiDiff,
  findYearsByGanZhi: findYearsByGanZhi,
  getGanZhiByYear: getGanZhiByYear,
  getYearRange: getYearRange,
  getTenYearsRange: getTenYearsRange,
  generateLunarMonths: generateLunarMonths,
  getSiLingFromRysl: getSiLingFromRysl,
  getTaiYuan: getTaiYuan,
  getJiaoYunInfo: getJiaoYunInfo,
  jiaoYunText: jiaoYunText,

  getShiChen: getShiChen,
  RYSL_DATA: RYSL_DATA,
  MONTH_JIE_QI: MONTH_JIE_QI
};
