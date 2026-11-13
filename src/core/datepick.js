/**
 * 出生时间「点选日历」的模型（纯函数，不依赖小程序环境）
 *
 * 首页的出生时间原来是一个五列轮转选择器（picker mode="multiSelector"）。
 * 用户要求换成点选：先选年 → 选完年份切换出月份 → 再选日 → 时 → 分。
 * 于是把原来长在 pages/paipan/paipan.js 里的列数据与下标换算收拢到这里：
 * 页面、组件、测试都只拿这里的纯函数结果，换算逻辑只有一份。
 *
 * 状态只有一个：{ cal, idx }
 *   · cal === 'solar' → idx = [年 - 1000, 月 - 1, 日 - 1, 时, 分]
 *   · cal === 'lunar' → idx = [年 - 999, 月序（含闰月，闰月为负）, 日 - 1, 时, 分]
 *   （年份基准取 time.SOLAR_YEAR_MIN / lunar.YEAR_MIN，别在这里写死数字）
 *
 * 为什么两种历法各存各的下标、不统一只存公历：
 *   农历「点了哪一年哪一月」是用户明确选出来的，而中间态（只点了年、还没点日）
 *   没法用公历表达 —— 一个农历月横跨两个月公历，反推不回去。
 *   换历法时用 locateInPicker / lunarToSolar 互相踩，见 shiftCalendar。
 *
 * ⚠ 下标收敛规则：上游变化（换年、换月）**只把下游越界下标收敛，不重置**，
 *   与改造前那个选择器的口径一致 —— 2024-02-29 换到 2023 年自动变 2023-02-28。
 *
 * ⚠ 对外（页面 / 记录 / 云端）一律只认公历真值：resolve() 吐出来的 date 永远是
 *   'YYYY-MM-DD'。农历只是「怎么选、怎么显示」的一层皮。
 */

const timeUtil = require('./time.js');
const lunar = require('./lunar.js');
const terms = require('./terms.js');

/** 面板的五步，顺序即 idx 的位次（year→idx[0] … minute→idx[4]） */
const STEPS = ['year', 'month', 'day', 'hour', 'minute'];

const STEP_TITLE = {
  year: '选择年份',
  month: '选择月份',
  day: '选择日期',
  hour: '选择小时',
  minute: '选择分钟'
};

/** 每步网格的列数：年是长列表（4 列）、日要有月历感（7 列）、时分是方格（6 列） */
const STEP_COLS = { year: 4, month: 4, day: 7, hour: 6, minute: 6 };

function clamp(value, min, max) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < min) return min;
  if (n > max) return max;
  return n;
}

function slotOf(step) {
  return STEPS.indexOf(step);
}

/* ---------------- 列数据 ---------------- */

function yearLabels(cal) {
  return cal === 'lunar' ? lunar.lunarYearLabels() : timeUtil.solarYearLabels();
}

/** 年份下标 → 真实年份（公历基准 1000 / 农历基准 999，别在调用处写死数字） */
function yearOf(cal, yearIndex) {
  return (cal === 'lunar' ? lunar.YEAR_MIN : timeUtil.SOLAR_YEAR_MIN) + yearIndex;
}

/** 年份下标 → 安全的年份下标 */
function normYear(cal, yearIndex) {
  return clamp(yearIndex, 0, yearLabels(cal).length - 1);
}

/**
 * 年格上的干支后缀（如 1990 → 庚午）。
 *
 * ⚠ 只是「方便定位哪一年」的标签，不参与排盘 —— 口径是**农历年（以正月初一为界）**，
 *   与排盘结果里的年柱（**以立春为界**）不是同一个口径，别互相替代（见 lunar.js 头注）。
 *   所以公历口径下的年格也会带上它：用户嘴里说的「1990 年」本来就是庚午年。
 *
 * 按年份缓存：年格一次最多铺 120 格，来回翻区 / 换历法会反复问同一批年份。
 */
const gzCache = {};

function gzOfYear(y) {
  if (gzCache[y] === undefined) gzCache[y] = lunar.yearGanZhi(y);
  return gzCache[y];
}

/* -------- 年份分段（年格上方的「前 120 年 / 后 120 年」两个按钮）-------- */

/**
 * 一区的年份跨度：**最多 120 个年份**（用户指定）。
 *
 * 为什么要有分区：年份范围是 1000~2050（用户要求），一共 **1051 格** ——
 * 一次全铺开会让面板展开明显变钝，从 1990 滑到 1000 也要滑很久。
 * 改成「一次只铺一区 + 上方两个按钮翻区」后，年格稳定在 ≤120 格。
 */
const SEG_SIZE = 120;

const segCache = {};

/**
 * 年份分区：从各自的下限（公历 1000 / 农历 999）起，**顺序每 120 年一区**，
 * 末区不足 120 就按实际年数收尾，分区之间不留缝也不重叠。
 *
 *   公历（1000 起，共 1051 年 → 9 区）：1000-1119 / 1120-1239 / … / 1960-2050
 *   农历（ 999 起，共 1052 年 → 9 区）： 999-1118 / 1119-1238 / … / 1959-2050
 *
 * ⚠ 分区起点必须跟着各自的下限走，**不能按整百年对齐** ——
 *   农历比公历多一格（999 年，公历 1000-01-01 的农历年就是它），
 *   若两边都按整百切，那多出来的一格会被并进 1000 那一区，
 *   一旦将来把 SEG_SIZE 调成别的值，两边的区号就会错位。
 *
 * @returns {Array<{v:number, label:string, from:number, to:number}>}
 *          v = 区下标；from / to = **年格下标**范围（与 idx[0] 同一坐标系）
 */
function yearSegments(cal) {
  const c = (cal === 'lunar') ? 'lunar' : 'solar';
  if (segCache[c]) return segCache[c];

  const labels = yearLabels(c);
  const total = labels.length;
  const list = [];

  let from = 0;
  while (from < total) {
    const to = Math.min(from + SEG_SIZE - 1, total - 1);
    const firstYear = yearOf(c, from);
    const lastYear = yearOf(c, to);

    list.push({
      v: list.length,
      label: (firstYear === lastYear) ? String(firstYear) : (firstYear + '-' + lastYear),
      from: from,
      to: to
    });
    from = to + 1;
  }

  segCache[c] = list;
  return list;
}

/** 某个年份下标落在哪一区 */
function segOfYear(cal, yearIndex) {
  const list = yearSegments(cal);
  const yi = normYear(cal, yearIndex);
  for (let i = 0; i < list.length; i++) {
    if (yi >= list[i].from && yi <= list[i].to) return i;
  }
  return list.length - 1;
}

// 农历月表要现算（tyme），而换年 / 换月 / 算日格时会连着问同一年的好几次 —— 按年缓存一层
const lunarMonthCache = {};

/**
 * 某一步「月」的可选项
 * @returns {Object} { labels:[...], values:[...] }（公历的 values 为 null，月序 = 下标 + 1）
 */
function monthOptions(cal, yearIndex) {
  if (cal === 'lunar') {
    const y = lunar.YEAR_MIN + normYear(cal, yearIndex);
    if (!lunarMonthCache[y]) lunarMonthCache[y] = lunar.lunarMonthOptions(y);
    return lunarMonthCache[y];
  }
  return { labels: timeUtil.solarMonthLabels(), values: null };
}

/** 某一步「日」的标签列表（公历 1~31 随大小月闰年变，农历 初一~三十） */
function dayLabels(cal, yearIndex, monthIndex) {
  const yi = normYear(cal, yearIndex);
  if (cal === 'lunar') {
    const mo = monthOptions(cal, yi);
    const mi = clamp(monthIndex, 0, mo.values.length - 1);
    return lunar.lunarDayOptions(lunar.YEAR_MIN + yi, mo.values[mi]).labels;
  }
  return timeUtil.solarDayLabels(timeUtil.SOLAR_YEAR_MIN + yi, monthIndex + 1);
}

/**
 * 日格的「格子下标 → 真实日号」对照表。
 *
 * ⚠ 别再用 `下标 + 1` 当日号 —— **1582 年 10 月不成立**：
 *   儒略历改格里高利历，10-05 ~ 10-14 这十天不存在，那个月只有 21 天，
 *   用「1..21」铺格会让第 5 格变成不存在的「1582-10-05」，点下去排盘直接抛异常。
 *   公历要走 time.solarDayValues（真实日号 [1,2,3,4,15,…,31]）；
 *   农历月没有缺日，就是 1..N。
 */
function dayValues(cal, yearIndex, monthIndex) {
  const c = (cal === 'lunar') ? 'lunar' : 'solar';
  const yi = normYear(c, yearIndex);
  if (c === 'lunar') {
    const mo = monthOptions(c, yi);
    const mi = clamp(monthIndex, 0, mo.values.length - 1);
    return lunar.lunarDayOptions(lunar.YEAR_MIN + yi, mo.values[mi]).values;
  }
  return timeUtil.solarDayValues(timeUtil.SOLAR_YEAR_MIN + yi, clamp(monthIndex, 0, 11) + 1);
}

/** 日格下标 → 真实日号（越界收敛到边界） */
function dayOfIndex(cal, yearIndex, monthIndex, dayIndex) {
  const vals = dayValues(cal, yearIndex, monthIndex);
  return vals[clamp(dayIndex, 0, vals.length - 1)];
}

/** 真实日号 → 日格下标（就是 dayOfIndex 的反向：1582-10-15 是第 5 格，不是第 15 格） */
function indexOfDay(cal, yearIndex, monthIndex, day) {
  const at = dayValues(cal, yearIndex, monthIndex).indexOf(day);
  return at < 0 ? 0 : at;
}

/* -------- 日格上的节气标注 -------- */

/**
 * 日格逐格的节气，与 dayLabels 等长 —— 没有节气的位置是 null。
 * 有节气的位置是 { name, time }：交节时刻（如 2024 立春 16:27）也要显示，用户要求。
 *
 * 节气跟着太阳走，所以两种口径下都要先拿到那一格的**公历日**再查：
 * 公历格就是它自己；农历格先 lunarToSolar 换过去（一个农历月横跨两个公历月，
 * 节气落在哪一格只能一格一格地算）。
 *
 * 按 cal-年-月 缓存：面板来回切步骤（日 → 月 → 日）会反复问同一个月。
 * 上限 120 条，超出丢最早的一条 —— 不会无限涨，也不影响正常来回看。
 */
const dayTermCache = {};
const dayTermKeys = [];
const DAY_TERM_CACHE_MAX = 120;

/** 公历某天的节气（带交节时刻）：不是节气日返回 null */
function termAt(y, m, d) {
  const t = terms.termOfDay(y, m, d);
  return t ? { name: t.name, time: t.time } : null;
}

/**
 * @param {string} cal 'solar' | 'lunar'
 * @param {number} yearIndex 年格下标
 * @param {number} monthIndex 月格下标
 * @returns {Array<Object|null>} 与 dayLabels(cal, yearIndex, monthIndex) 一一对应；
 *          元素是 { name, time }（节气名 + 交节时刻），不是节气日就是 null
 */
function dayTerms(cal, yearIndex, monthIndex) {
  const c = (cal === 'lunar') ? 'lunar' : 'solar';
  const yi = normYear(c, yearIndex);
  const mi = clamp(monthIndex, 0, monthOptions(c, yi).labels.length - 1);
  const key = c + '-' + yi + '-' + mi;
  if (dayTermCache[key]) return dayTermCache[key];

  const marks = [];

  if (c === 'lunar') {
    const ly = lunar.YEAR_MIN + yi;
    const months = monthOptions('lunar', yi);
    const total = lunar.lunarDayOptions(ly, months.values[mi]).values.length;
    for (let i = 0; i < total; i++) {
      const solar = lunar.lunarToSolar(ly, months.values[mi], i + 1);
      marks.push(termAt(solar.y, solar.m, solar.d));
    }
  } else {
    const y = timeUtil.SOLAR_YEAR_MIN + yi;
    // ⚠ 逐「真实日号」查，不是 1..N：1582 年 10 月没有 5~14 日
    timeUtil.solarDayValues(y, mi + 1).forEach(function (d) {
      marks.push(termAt(y, mi + 1, d));
    });
  }

  dayTermCache[key] = marks;
  dayTermKeys.push(key);
  if (dayTermKeys.length > DAY_TERM_CACHE_MAX) delete dayTermCache[dayTermKeys.shift()];
  return marks;
}

/* ---------------- 状态 ---------------- */

/** 把下标全部收敛到合法范围（越界的往下游挤，不重置） */
function clampIndex(cal, idx) {
  const src = idx || [0, 0, 0, 0, 0];
  const out = [0, 0, 0, 0, 0];

  out[0] = normYear(cal, src[0]);

  const months = monthOptions(cal, out[0]).labels;
  out[1] = clamp(src[1], 0, months.length - 1);

  const days = dayLabels(cal, out[0], out[1]);
  out[2] = clamp(src[2], 0, days.length - 1);

  out[3] = clamp(src[3], 0, 23);
  out[4] = clamp(src[4], 0, 59);
  return out;
}

/** 公历真值（＋历法口径）→ 初始状态 */
function fromSolar(dateStr, timeStr, cal) {
  const c = (cal === 'lunar') ? 'lunar' : 'solar';
  const pd = timeUtil.parseDate(dateStr);
  const pt = timeUtil.parseTime(timeStr);

  let idx;
  if (c === 'lunar') {
    const at = lunar.locateInPicker(pd.y, pd.m, pd.d);
    idx = [at.yearIndex, at.monthIndex, at.dayIndex, pt.h, pt.mi];
  } else {
    // ⚠ 日下标要反查，不是 pd.d - 1：1582-10-15 是那个月的第 5 格（5~14 日不存在）
    idx = [
      pd.y - timeUtil.SOLAR_YEAR_MIN,
      pd.m - 1,
      indexOfDay('solar', pd.y - timeUtil.SOLAR_YEAR_MIN, pd.m - 1, pd.d),
      pt.h,
      pt.mi
    ];
  }
  return { cal: c, idx: clampIndex(c, idx) };
}

/**
 * 换历法：以公历真值为桥，把当前选择原样搬到另一种口径下
 * （公历 1990-01-01 换成农历口径 → 一九八九年十二月初五）
 * ⚠ 这一行**不含年份**：`lunarToSolar` 给的 text 只有「月 + 日」，
 *   年份在 hint（对应公历 …）里 —— 所以农历文案改成中文数字年（见 lunar.js）影响不到这里。
 */
function shiftCalendar(state, cal) {
  const c = (cal === 'lunar') ? 'lunar' : 'solar';
  if (state.cal === c) return state;
  const pr = resolve(state);
  return fromSolar(pr.date, pr.time, c);
}

/** 状态 → 公历真值 + 显示文案 */
function resolve(state) {
  const idx = clampIndex(state.cal, state.idx);
  const time = timeUtil.fmtTime(idx[3], idx[4]);

  let y;
  let m;
  let d;
  let text;

  if (state.cal === 'lunar') {
    const ly = lunar.YEAR_MIN + idx[0];
    const mo = monthOptions('lunar', idx[0]);
    const solar = lunar.lunarToSolar(ly, mo.values[idx[1]], dayOfIndex('lunar', idx[0], idx[1], idx[2]));
    y = solar.y;
    m = solar.m;
    d = solar.d;
    // 农历口径下这一行的文案是农历本身（与改造前一致），公历放在 hint 里
    text = solar.text + ' ' + time;
  } else {
    y = timeUtil.SOLAR_YEAR_MIN + idx[0];
    m = idx[1] + 1;
    // ⚠ 日号要查表，不是 idx[2] + 1 —— 1582 年 10 月的第 5 格是 15 日，不是 5 日
    d = dayOfIndex('solar', idx[0], idx[1], idx[2]);
    text = timeUtil.fmtDate(y, m, d) + ' ' + time;
  }

  const date = timeUtil.fmtDate(y, m, d);
  return {
    date: date,
    time: time,
    text: text,
    // 农历口径给一行「对应公历 …」，公历口径没有这句
    hint: (state.cal === 'lunar') ? ('对应公历 ' + date) : ''
  };
}

/* ---------------- 渲染用的三份数据 ---------------- */

/**
 * 当前这一步的网格
 * @param {string} [segIndex] 仅年格用：强制铺哪一区（翻区按钮点出来的）。
 *                            缺省则按已选年份推导 —— 所以点面包屑回「年」时，
 *                            看到的是选中那年所在的区，而不是上次浏览的区。
 */
function gridOf(state, step, segIndex) {
  const at = slotOf(step) < 0 ? STEPS[0] : step;
  const idx = clampIndex(state.cal, state.idx);
  const items = [];
  let seg = null;

  if (at === 'year') {
    const segs = yearSegments(state.cal);
    const si = (segIndex === undefined || segIndex === null)
      ? segOfYear(state.cal, idx[0])
      : clamp(segIndex, 0, segs.length - 1);
    const cur = segs[si];
    // 给翻区按钮的全部信息：范围文案、区号、以及两头到没到头（到头了按钮置灰）
    seg = {
      label: cur.label,
      from: cur.from,
      to: cur.to,
      index: si,
      total: segs.length,
      pos: (si + 1) + '/' + segs.length,
      hasPrev: si > 0,
      hasNext: si < segs.length - 1
    };

    const labels = yearLabels(state.cal);
    // 年格多带一个 gz（干支后缀，见 gzOfYear）—— 只有这一步的格子有 gz，
    // 月 / 日 / 时 / 分的格子不带（用户要求：只年格显示干支）。
    for (let i = cur.from; i <= cur.to; i++) {
      items.push({ v: i, label: labels[i], gz: gzOfYear(yearOf(state.cal, i)) });
    }
  } else if (at === 'month') {
    monthOptions(state.cal, idx[0]).labels.forEach(function (label, i) {
      items.push({ v: i, label: label });
    });
  } else if (at === 'day') {
    // 日格多带一个 term（{ name, time }，不是节气日就是 null）——
    // 用户要求选日时要看得见节气点，并且要带上交节的几点几分。
    // 只有这一步的格子有 term，其余步骤模板里的 tt:if 会跳过。
    const marks = dayTerms(state.cal, idx[0], idx[1]);
    dayLabels(state.cal, idx[0], idx[1]).forEach(function (label, i) {
      items.push({ v: i, label: label, term: marks[i] || null });
    });
  } else if (at === 'hour') {
    for (let h = 0; h <= 23; h++) items.push({ v: h, label: h + '时' });
  } else {
    for (let mi = 0; mi <= 59; mi++) items.push({ v: mi, label: mi + '分' });
  }

  const current = idx[slotOf(at)];
  // 年格上选中的那年可能不在当前区里，这时滚动锚点落到区首 ——
  // 否则 scroll-into-view 指向一个不存在的 id，面板会停在上一区的位置
  const anchor = (seg && (current < seg.from || current > seg.to)) ? seg.from : current;

  return {
    step: at,
    title: STEP_TITLE[at],
    cols: STEP_COLS[at],
    items: items,
    current: current,
    anchor: anchor,
    seg: seg
  };
}

/** 面包屑：五步各显示已选值，可点回退到任意一步改 */
function crumbOf(state, step) {
  const at = slotOf(step) < 0 ? STEPS[0] : step;
  const idx = clampIndex(state.cal, state.idx);
  const list = [];

  if (state.cal === 'lunar') {
    list.push({ step: 'year', label: (lunar.YEAR_MIN + idx[0]) + '年' });
    list.push({ step: 'month', label: monthOptions('lunar', idx[0]).labels[idx[1]] });
    list.push({ step: 'day', label: dayLabels('lunar', idx[0], idx[1])[idx[2]] });
  } else {
    list.push({ step: 'year', label: (timeUtil.SOLAR_YEAR_MIN + idx[0]) + '年' });
    list.push({ step: 'month', label: (idx[1] + 1) + '月' });
    // 日号同样走查表（而不是 idx[2] + 1），与格子里显示的那个数保持一致
    list.push({ step: 'day', label: dayOfIndex('solar', idx[0], idx[1], idx[2]) + '日' });
  }
  list.push({ step: 'hour', label: idx[3] + '时' });
  list.push({ step: 'minute', label: idx[4] + '分' });

  const here = slotOf(at);
  list.forEach(function (item) {
    item.done = slotOf(item.step) < here;
    item.active = item.step === at;
  });
  return list;
}

/**
 * 模板要的全部渲染数据，一次算齐
 * @param {Object} state
 * @param {string} step 当前步骤（缺失则回到第一步）
 * @param {number} [segIndex] 仅年格用，见 gridOf
 */
function view(state, step, segIndex) {
  const at = slotOf(step) < 0 ? STEPS[0] : step;
  const st = { cal: state.cal, idx: clampIndex(state.cal, state.idx) };
  return {
    step: at,
    grid: gridOf(st, at, segIndex),
    crumb: crumbOf(st, at),
    preview: resolve(st)
  };
}

/**
 * 点某一格 → 新状态 + 下一步
 * @returns {Object} { state, step, done }；done 为 true 表示五步走完（该收面板了）
 */
function pick(state, step, value) {
  const pos = slotOf(step);
  if (pos < 0) return { state: state, step: step, done: false };

  const idx = state.idx.slice();
  idx[pos] = value;

  const nextStep = STEPS[pos + 1] || null;
  return {
    state: { cal: state.cal, idx: clampIndex(state.cal, idx) },
    step: nextStep,
    done: !nextStep
  };
}

module.exports = {
  STEPS: STEPS,
  STEP_TITLE: STEP_TITLE,
  STEP_COLS: STEP_COLS,
  SEG_SIZE: SEG_SIZE,
  yearOf: yearOf,
  yearLabels: yearLabels,
  gzOfYear: gzOfYear,
  yearSegments: yearSegments,
  segOfYear: segOfYear,
  monthOptions: monthOptions,
  dayLabels: dayLabels,
  dayValues: dayValues,
  dayOfIndex: dayOfIndex,
  indexOfDay: indexOfDay,
  dayTerms: dayTerms,
  clampIndex: clampIndex,
  fromSolar: fromSolar,
  shiftCalendar: shiftCalendar,
  resolve: resolve,
  gridOf: gridOf,
  crumbOf: crumbOf,
  view: view,
  pick: pick
};
