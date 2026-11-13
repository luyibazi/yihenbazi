/**
 * 排盘与农历测试（Node 直接运行：node tests/test.js）
 *
 * 基准来源：tyme4ts 的八字 / 农历输出。tyme 是独立实现的成熟库，
 * 这里用「已知的真实结果」做断言，避免自己算自己。
 */

const chart = require('../src/core/chart.js');
const lunar = require('../src/core/lunar.js');
const timeUtil = require('../src/core/time.js');
const bazi = require('../src/core/bazi.js');
const recordLib = require('../src/core/record.js');
const szLib = require('../src/core/sizhu.js');
const gsLib = require('../src/core/gzstep.js');

let failed = 0;

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log('PASS  ' + label + '  →  ' + JSON.stringify(actual));
  } else {
    failed += 1;
    console.error('FAIL  ' + label + '  期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

/**
 * 安全地取深层字段：at(obj, 'notes', 'dayun:d0', 'text')。
 *
 * ⚠ 断言里别写 `hydrated.notes['dayun:d0'].text` 这种直接解引用的链子 ——
 *   一旦上游把 notes 弄丢了（正是这些断言要拦的 bug），这里抛的是 TypeError 崩栈，
 *   **脚本当场挂掉、后面所有用例一条都不跑**：看起来像"只有这一处坏了"，
 *   实际是回归检查从中间断掉了。取值走这个函数，坏掉时是一条正经的 FAIL。
 */
function at(obj) {
  let cur = obj;
  for (let i = 1; i < arguments.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[arguments[i]];
  }
  return cur;
}

/**
 * 崩栈兜底。
 *
 * 断言里一旦直接解引用（`.a.b[0].c`）而那一环恰好被改坏，抛的是 TypeError、
 * **脚本当场终止** —— 后面几十条用例一条都不跑，输出里只剩一段栈。
 * 那比报 FAIL 危险得多：看起来像"只有这一处坏了"。
 * 这里把它变成一句人话，并且明确说"后面的用例没跑"。
 */
process.on('uncaughtException', function (err) {
  console.error('\nFAIL  用例链在这里崩断了 —— 后面的用例一条都没跑！');
  console.error('      ' + (err && err.stack ? String(err.stack).split('\n')[0] : String(err)));
  console.error('      断言里取值请走 at()，别写 .a.b[0].c 这种直接解引用。');
  process.exit(1);
});

/* ---------- 用例 1：对齐参考 App 截图 2026-09-30 11:04 → 丙午 丁酉 丁未 丙午 ---------- */
const c1 = chart.paipan(2026, 9, 30, 11, 4);
assertEqual(c1.fourChars, ['丙午', '丁酉', '丁未', '丙午'], '2026-09-30 11:04 四柱');
assertEqual(c1.hourName, '午时', '时辰');
assertEqual(c1.zodiac, '马', '生肖');
assertEqual(c1.dayMasterName + c1.dayMasterElement, '丁火', '日主');
assertEqual(c1.dayMasterYang, false, '日主阴阳（丁为阴）');
assertEqual(c1.shiShenList, ['劫财', '比肩', '日主', '劫财'], '十神');
assertEqual(c1.elements, { '木': 0, '火': 6, '土': 1, '金': 1, '水': 0 }, '五行统计');

/* ---------- 用例 2：1990-01-01 00:00（立春前，年柱按上一年） ---------- */
const c2 = chart.paipan(1990, 1, 1, 0, 0);
assertEqual(c2.fourChars, ['己巳', '丙子', '丙寅', '戊子'], '1990-01-01 00:00 四柱');
assertEqual(c2.pillars.year.shiShen, '伤官', '年干十神');
assertEqual(c2.pillars.hour.shiShen, '食神', '时干十神');

/* ---------- 用例 3：日柱锚点 ---------- */
assertEqual(chart.paipan(1949, 10, 1, 12, 0).pillars.day.name, '甲子', '1949-10-01 日柱');
assertEqual(chart.paipan(2000, 1, 1, 12, 0).pillars.day.name, '戊午', '2000-01-01 日柱');

/* ---------- 用例 4：晚子时（23:00 后日柱进次日） ---------- */
const c4 = chart.paipan(2026, 9, 30, 23, 30);
assertEqual(c4.fourChars, ['丙午', '丁酉', '戊申', '壬子'], '2026-09-30 23:30 晚子时');
assertEqual(chart.paipan(2026, 9, 30, 22, 59).pillars.day.name, '丁未', '22:59 仍为当日日柱');

/* ---------- 用例 5：立春时刻分界（2024 立春为 2/4 16:27） ---------- */
assertEqual(chart.paipan(2024, 2, 4, 10, 0).fourChars.slice(0, 2), ['癸卯', '乙丑'], '立春前 10:00');
assertEqual(chart.paipan(2024, 2, 4, 17, 0).fourChars.slice(0, 2), ['甲辰', '丙寅'], '立春后 17:00');

/* ---------- 用例 6：农历换算 ----------
 * ⚠ 文案里的年份是**中文数字年**（1998 → 一九九八），不是干支年 —— 2026-10-01 用户要求。
 *   断言故意用完整串（而不是只查「包含某年」）：
 *   干支年换个说法照样能拼出来（「己巳年十二月初五」），只有整串比对才拦得住退回。 */
assertEqual(lunar.solarToLunar(2026, 9, 30).text, '二〇二六年八月二十', '公历转农历');
assertEqual(lunar.solarToLunar(1990, 1, 1).text, '一九八九年十二月初五', '1990-01-01 农历');
assertEqual(lunar.solarToLunar(2023, 3, 22).text, '二〇二三年闰二月初一', '闰月标识');
assertEqual(lunar.lunarToSolar(2023, -2, 1).dateText, '2023-03-22', '闰月反向换算');
assertEqual(lunar.lunarToSolar(2026, 8, 20).dateText, '2026-09-30', '农历转公历');
assertEqual(lunar.solarToLunar(1901, 1, 1).lYear, 1900, '公历 1901 年初落在农历 1900 年');

/* 中文年的写法：逐位读（不是数词），0 取「〇」不取「零」 */
assertEqual(lunar.chineseYear(1998), '一九九八', '中文年：用户举的例子');
assertEqual(lunar.chineseYear(2026), '二〇二六', '中文年：0 是「〇」不是「零」（出版物上数字用法的规范写法）');
assertEqual(lunar.chineseYear(2000), '二〇〇〇', '中文年：整千年不会退化成「二千」');
assertEqual(lunar.chineseYear(999), '九九九', '中文年：三位数年份（农历下限 999）不补零');
assertEqual(lunar.chineseYear(1000), '一〇〇〇', '中文年：四位数含 0');

/* 同一份农历信息里，干支年仍在（生肖是它推出来的），只是不再进文案 */
assertEqual(lunar.solarToLunar(1990, 1, 1).gzYear, '己巳', '干支年仍由 gzYear 给出（文案里不再用）');
assertEqual(lunar.solarToLunar(1990, 1, 1).yearText, '一九八九', '中文年另给一个字段，供别处拼文案');
assertEqual(lunar.solarToLunar(1990, 1, 1).text.indexOf('己巳'), -1, '农历文案里不许出现干支年');

/* ---------- 用例 6b：宽年区间（1000~2050）----------
 * 出生年份可选范围已从 1901~2049 扩到 **1000~2050**（用户要求）。
 * 底层是 tyme4ts，不查固定年份表，所以极早年份也要算得出来：
 *   · 流年区间跟着出生年走（1000 年生 → 1000~1070），不是写死到某个现代年份
 *   · record.hydrate 的年份校验要比可选范围各宽一年，
 *     因为农历换算天然越界（公历 1000-01-01 是农历 999 年；农历 2050 年腊月落在公历 2051 年初）
 */
assertEqual(lunar.solarToLunar(1000, 6, 15).text, '一〇〇〇年五月十一', '公历 1000 年农历换算');
assertEqual(lunar.solarToLunar(1500, 7, 7).text, '一五〇〇年六月十二', '公历 1500 年农历换算');
assertEqual(lunar.solarToLunar(2050, 12, 31).text, '二〇五〇年十一月十八', '公历 2050 年农历换算');

assertEqual(chart.paipan(1000, 6, 15, 12, 0).fourChars, ['庚子', '壬午', '丁亥', '丙午'], '1000-06-15 四柱');
assertEqual(chart.paipan(1100, 3, 15, 8, 30).fourChars, ['庚辰', '己卯', '庚子', '庚辰'], '1100-03-15 四柱');
assertEqual(chart.paipan(2050, 12, 31, 23, 59).fourChars, ['庚午', '戊子', '丙戌', '戊子'], '2050-12-31 四柱');

const bEarly = bazi.calculate({ year: 1000, month: 6, day: 15, hour: 12, minute: 0, gender: 1 });
assertEqual(bEarly.siLing, '己司令（芒种第14.5天，距小暑17天）', '1000 年出生：司令分野');
assertEqual(bEarly.qiYunTime.dateText + ' ' + bEarly.qiYunTime.timeText, '1006-02-12 13:46', '1000 年出生：起运时刻');
assertEqual(bEarly.dayuns.length, 12, '1000 年出生：十二步大运照常');
assertEqual(
  [bEarly.yearlyFortunes[0].year, bEarly.yearlyFortunes[bEarly.yearlyFortunes.length - 1].year],
  [1000, 1070],
  '1000 年出生：流年区间跟着出生年走（1000~1070），不是写死的现代年份'
);

/* record 的年份校验：可选范围外的 ±1 年要放行（农历换算会越到这里），再往外才拒 */
assertEqual(recordLib.hydrate({ id: 'a', name: 'x', gender: 1, date: '0999-06-01', time: '08:00', createdAt: 0 }) !== null,
  true, 'hydrate 接受 999 年（农历下限，公历 1000-01-01 落在这一年）');
assertEqual(recordLib.hydrate({ id: 'b', name: 'x', gender: 1, date: '2051-01-20', time: '08:00', createdAt: 0 }) !== null,
  true, 'hydrate 接受 2051 年（农历 2050 年腊月换算出来就在这里）');
assertEqual(recordLib.hydrate({ id: 'c', name: 'x', gender: 1, date: '2052-01-20', time: '08:00', createdAt: 0 }),
  null, 'hydrate 拒绝 2052 年（超上限）');
assertEqual(recordLib.hydrate({ id: 'd', name: 'x', gender: 1, date: '0998-01-01', time: '08:00', createdAt: 0 }),
  null, 'hydrate 拒绝 998 年（低于下限）');

/* 农历 2050 年腊月初一确实落在公历 2051 年 —— 这就是 YEAR_CEIL 存在的理由 */
assertEqual(lunar.lunarToSolar(2050, 12, 1).dateText, '2051-01-13', '农历 2050 年腊月初一 → 公历 2051-01-13');

/* ---------- 用例 7：选择器列数据 ---------- */
assertEqual(lunar.lunarMonthOptions(2023).labels.indexOf('闰二月') >= 0, true, '有闰月的年包含闰月列');
assertEqual(lunar.lunarMonthOptions(2026).labels.indexOf('闰二月'), -1, '无闰月的年不含闰月列');
assertEqual(lunar.lunarDayOptions(2026, 8).labels.length, 29, '2026 八月为小月（29 天）');
assertEqual(lunar.lunarDayOptions(2023, 2).labels.length, 30, '2023 二月为大月（30 天）');

/* 选择器定位 ↔ 反向换算 必须自洽（遍历整个可选年份区间，含 1000 年那段极早年份） */
let inconsistent = 0;
for (let y = timeUtil.SOLAR_YEAR_MIN; y <= timeUtil.SOLAR_YEAR_MAX; y += 7) {
  for (let m = 1; m <= 12; m += 5) {
    const at = lunar.locateInPicker(y, m, 15);
    const back = lunar.lunarToSolar(lunar.YEAR_MIN + at.yearIndex, at.month, at.day);
    if (back.y !== y || back.m !== m || back.d !== 15) inconsistent += 1;
  }
}
assertEqual(inconsistent, 0, '农历选择器定位与反向换算自洽（1000~2050 全区间抽样）');

/* ---------- 用例 7b：出生时间点选面板的模型（utils/datepick.js）----------
 * 面板已从「五列轮转选择器」改成「年 → 月 → 日 → 时 → 分」的点选网格，
 * 列数据与下标换算都收在 datepick 里。这层是纯函数，直接在这里验算 ——
 * 页面与组件只负责把 gridOf/crumbOf/resolve 的结果画出来。
 * 下标口径：公历年以 SOLAR_YEAR_MIN（1000）为 0，农历年以 lunar.YEAR_MIN（999）为 0。
 */
const dp = require('../src/core/datepick.js');
const yearCount = timeUtil.SOLAR_YEAR_MAX - timeUtil.SOLAR_YEAR_MIN + 1;

const solarSt = dp.fromSolar('1990-01-01', '00:00', 'solar');
assertEqual(solarSt.idx, [1990 - timeUtil.SOLAR_YEAR_MIN, 0, 0, 0, 0], '公历 1990-01-01 → 面板下标');
assertEqual(dp.resolve(solarSt).text, '1990-01-01 00:00', '公历口径行内文案');
assertEqual(dp.resolve(solarSt).hint, '', '公历口径不给换算提示');

/* 第一屏是年份（4 列长列表），点完年进月、点完分才算走完 */
/* 年格不再一次铺全部 —— 一次只铺一「区」（最多 120 年），全量 1051 格靠两个翻区按钮 */
assertEqual(dp.yearLabels('solar').length, yearCount, '公历年表覆盖 1000~2050');
assertEqual(dp.view(solarSt, 'year').grid.cols, 4, '年份格 4 列');
assertEqual(dp.view(solarSt, 'year').grid.seg.label, '1960-2050', '1990 落在末区 1960-2050');
assertEqual(dp.view(solarSt, 'year').grid.items.length, 91, '末区不满 120 年 → 只有 1960~2050 共 91 格');
assertEqual(dp.view(solarSt, 'year').grid.items[0].label, '1960', '区首是 1960');
assertEqual(dp.view(solarSt, 'year').grid.items[90].label, '2050', '区末是 2050');

/* 年格上的干支后缀（2026-10-05 用户要求：只年格显示干支，月日时不用管）。
   ⚠ 口径是**农历年（以正月初一为界）**，不是排盘年柱（以立春为界）——
     所以 1990-01-15 的年柱是己巳，而这里显示庚午，两者都对、用途不同。 */
const yearItems = dp.view(solarSt, 'year').grid.items;
const yearItemOf = function (label) {
  return yearItems.filter(function (it) { return it.label === label; })[0];
};
assertEqual(yearItemOf('1990').gz, '庚午', '公历 1990 年格带干支「庚午」');
assertEqual(yearItemOf('1984').gz, '甲子', '1984 是甲子年（这一对能区分「差一位」的错）');
assertEqual(dp.gzOfYear(1990) === dp.gzOfYear(2050), true, '干支 60 年一轮（1990 与 2050 同为庚午）');
assertEqual(yearItems.every(function (it) { return typeof it.gz === 'string' && it.gz.length === 2; }),
  true, '每个年格的 gz 都是 2 个字的干支');
/* 「只年格有」是用户点名的范围 —— 四步都要逐条钉住，漏一步就等于多点了一步 */
assertEqual(dp.view(solarSt, 'month').grid.items.some(function (it) { return 'gz' in it; }), false, '月格不带干支');
assertEqual(dp.view(solarSt, 'day').grid.items.some(function (it) { return 'gz' in it; }), false, '日格不带干支');
assertEqual(dp.view(solarSt, 'hour').grid.items.some(function (it) { return 'gz' in it; }), false, '时格不带干支');
assertEqual(dp.view(solarSt, 'minute').grid.items.some(function (it) { return 'gz' in it; }), false, '分格不带干支');
/* 换农历口径（年格变农历年）—— 干支照样要有，否则切过去年格就秃了 */
const lunarYearSt = dp.fromSolar('1990-01-01', '00:00', 'lunar');
assertEqual(lunarYearSt.cal, 'lunar', '前置：已切到农历口径');
assertEqual(dp.view(lunarYearSt, 'year').grid.items.filter(function (it) { return it.label === '1990'; })[0].gz,
  '庚午', '农历口径的年格也带干支');

assertEqual(dp.view(solarSt, 'day').grid.cols, 7, '日格 7 列（月历感）');
assertEqual(dp.pick(solarSt, 'year', 1).step, 'month', '点完年份自动进月份');
assertEqual(dp.pick(solarSt, 'minute', 5).done, true, '点完分钟 = 五步走完');

/* 翻区按钮：只换「看哪一区」，不动已选年份 —— 所以 current 仍在 1990（区外） */
const seg0 = dp.view(solarSt, 'year', 0).grid;
assertEqual(seg0.seg.label, '1000-1119', '第 0 区 = 1000-1119');
assertEqual(seg0.items.length, dp.SEG_SIZE, '第 0 区满 120 格');
assertEqual(seg0.current, 1990 - timeUtil.SOLAR_YEAR_MIN, '翻区不动已选年份');
assertEqual(seg0.seg.index, 0, '第 0 区区号是 0');
assertEqual(seg0.seg.hasPrev, false, '第 0 区没有更早的区 →「前 120 年」按钮置灰');
assertEqual(seg0.seg.hasNext, true, '第 0 区后面还有 →「后 120 年」按钮可用');
assertEqual(seg0.seg.pos, '1/9', '第 0 区的区号文案 1/9');
assertEqual(seg0.anchor, 0, '选中年不在区内 → 滚动锚点落到区首（否则 scroll-into-view 找不到目标）');
assertEqual(dp.view(solarSt, 'year').grid.anchor, 1990 - timeUtil.SOLAR_YEAR_MIN, '选中年在区内 → 锚点就是它自己');
assertEqual(dp.view(solarSt, 'year').grid.seg.hasNext, false, '末区后面没有了 →「后 120 年」按钮置灰');

/* 分区：从下限（1000）起每 120 年一区，末区不满 120 按实际年数收尾 */
const solarSegs = dp.yearSegments('solar');
assertEqual(solarSegs.length, 9, '公历 1000~2050 共 9 区（1051 年 ÷ 120 向上取整）');
assertEqual(solarSegs[0].label, '1000-1119', '公历首区 1000-1119');
assertEqual(solarSegs[solarSegs.length - 1].label, '1960-2050', '公历末区不满 120 → 显示真实范围');
assertEqual(dp.segOfYear('solar', 1000 - timeUtil.SOLAR_YEAR_MIN), 0, '1000 在第 0 区');
assertEqual(dp.segOfYear('solar', 2050 - timeUtil.SOLAR_YEAR_MIN), 8, '2050 在末区');

/* 「每区最多 120 个年份」是这次改造的硬指标（用户指定）：先钉住这个数，
   再逐区验没有超标的 —— 同时各区拼起来必须不重不漏地覆盖全部可选年份。
   ⚠ 上限这里写**字面 120**，不要用 dp.SEG_SIZE：否则谁把常量改大了断言也跟着松，守不住。 */
assertEqual(dp.SEG_SIZE, 120, '一区最多 120 个年份');
const overSized = solarSegs.filter(function (s) { return s.to - s.from + 1 > 120; });
assertEqual(overSized.length, 0, '公历每一区都不超过 120 个年份');
assertEqual(solarSegs.reduce(function (n, s) { return n + (s.to - s.from + 1); }, 0), yearCount,
  '公历各区年数之和 = 全部可选年份（不重不漏）');

/* 闰年 + 越界只收敛不重置：2024-02-29 换到 2023 年应变 02-28 */
const leapSt = { cal: 'solar', idx: [2024 - timeUtil.SOLAR_YEAR_MIN, 1, 28, 0, 0] };
assertEqual(dp.resolve(leapSt).date, '2024-02-29', '2024 二月 29 日可选中');
assertEqual(dp.view(leapSt, 'day').grid.items.length, 29, '2024 二月 29 天');
assertEqual(dp.resolve(dp.pick(leapSt, 'year', 2023 - timeUtil.SOLAR_YEAR_MIN).state).date,
  '2023-02-28', '换年把 29 日收敛成 28 日（不是重置成 1 日）');

/* 农历口径：同一套下标结构，只是年月日按农历解释；文案是农历、公历放 hint */
const lunarSt = dp.fromSolar('1990-01-01', '00:00', 'lunar');
assertEqual(lunarSt.idx, [1989 - lunar.YEAR_MIN, 11, 4, 0, 0],
  '公历 1990-01-01 → 农历面板下标（己巳 = 1989 年，十二月初五）');
assertEqual(dp.resolve(lunarSt).text, '十二月初五 00:00', '农历口径行内文案');
assertEqual(dp.resolve(lunarSt).hint, '对应公历 1990-01-01', '农历口径给出对应公历');
assertEqual(dp.yearLabels('lunar').length, lunar.YEAR_MAX - lunar.YEAR_MIN + 1, '农历年表数量');

/* 农历的年份下限是 999 —— 公历 1000-01-01 的农历年就是它（见下一条）。
   分区起点跟着各自的下限走，所以农历第 0 区是 999~1118（公历是 1000~1119）。 */
const lunarSegs = dp.yearSegments('lunar');
assertEqual(lunarSegs.length, 9, '农历 999~2050 共 9 区');
assertEqual(lunarSegs[0].label, '999-1118', '农历首区从 999 起（999~1118）');
assertEqual(lunarSegs[0].to - lunarSegs[0].from + 1, 120,
  '农历首区满 120 格（999 那格被算进来，不再是单独一区）');
assertEqual(dp.segOfYear('lunar', 0), 0, '农历 999 在第 0 区');
assertEqual(dp.segOfYear('lunar', 1000 - lunar.YEAR_MIN), 0, '农历 1000 也在第 0 区（区分界跟下限走，不按整百年对齐）');
const lunarOver = lunarSegs.filter(function (s) { return s.to - s.from + 1 > 120; });
assertEqual(lunarOver.length, 0, '农历每一区都不超过 120 个年份');
assertEqual(lunarSegs.reduce(function (n, s) { return n + (s.to - s.from + 1); }, 0),
  lunar.YEAR_MAX - lunar.YEAR_MIN + 1, '农历各区年数之和 = 全部可选农历年');

/* 年份范围的下限边界：公历 1000-01-01 的农历年是 **999** 年（腊月），
   所以 lunar.YEAR_MIN 必须是 999。若把它设成 1000，切一次历法真值就会跳到 1000 年腊月。 */
assertEqual(lunar.solarToLunar(1000, 1, 1).lYear, 999, '公历 1000-01-01 落在农历 999 年');
const floorSt = dp.fromSolar('1000-01-01', '00:00', 'lunar');
assertEqual(dp.resolve(floorSt).date, '1000-01-01', '公历下限切农历口径：真值不变（少 999 这一格就会跳到次年）');
assertEqual(dp.resolve(dp.shiftCalendar(floorSt, 'solar')).date, '1000-01-01', '再从农历切回公历仍不变');

/* 上限边界：公历 2050-12-31 的农历年是 2050 年；农历 2050 年腊月会落到公历 2051 年初 */
assertEqual(lunar.solarToLunar(2050, 12, 31).lYear, 2050, '公历 2050-12-31 落在农历 2050 年');
const ceilSt = dp.fromSolar('2050-12-31', '00:00', 'lunar');
assertEqual(dp.resolve(ceilSt).date, '2050-12-31', '公历上限切农历口径：真值不变');

/* 2023 年有闰二月，闰二月是小月 29 天 */
const m2023 = dp.monthOptions('lunar', 2023 - lunar.YEAR_MIN);
const leapIdx = m2023.labels.indexOf('闰二月');
assertEqual(leapIdx >= 0, true, '农历月表含闰二月');
assertEqual(dp.dayLabels('lunar', 2023 - lunar.YEAR_MIN, leapIdx).length, 29, '2023 闰二月 29 天');

/* 换历法只换口径，公历真值不许动 */
assertEqual(dp.resolve(dp.shiftCalendar(solarSt, 'lunar')).date, '1990-01-01', '公历 → 农历口径：真值不变');
assertEqual(dp.resolve(dp.shiftCalendar(lunarSt, 'solar')).date, '1990-01-01', '农历 → 公历口径：真值不变');

/* ---------- 用例 7c：日格上的节气标注（utils/terms.js + datepick.dayTerms）----------
 * 用户要求：选「日」的时候，日选项里要标出节气点。
 * 节气跟着太阳走，两种历法口径下都是先取那一格的**公历日**再查 ——
 * 农历一个月的格子里通常横跨两个公历月，只能一格一格地换算。
 */
const terms = require('../src/core/terms.js');

/* 取「名字(节|气) 时刻」的紧凑文本，没有节气时是「(无)」。
   ⚠ 断言不要直接点 .name：实现坏到返回 null 时整个脚本会抛 TypeError，
     后面的用例全都不跑了，等于用异常掩盖了断言失败。 */
function termText(y, m, d) {
  const t = terms.termOfDay(y, m, d);
  return t ? (t.name + (t.jie ? '(节)' : '(气)') + ' ' + t.time) : '(无)';
}

/** 日格上的那一格：dayTerms / gridOf 给的是 { name, time } 或 null */
function markText(m) {
  return m ? (m.name + ' ' + m.time) : '(无)';
}

assertEqual(termText(2024, 2, 4), '立春(节) 16:27', '2024-02-04 立春（十二「节」，月柱分界），16:27 交节');
assertEqual(termText(2024, 2, 19), '雨水(气) 12:13', '2024-02-19 雨水（十二「气」），12:13 交节');
assertEqual(termText(2024, 2, 5), '(无)', '2024-02-05 不是节气日');
/* 时刻要补零到两位：立秋 02:45 不能显示成 2:45（日格里两行小字，长短不一会看着歪） */
assertEqual(termText(1990, 8, 8), '立秋(节) 02:45', '交节时刻补零到两位（02:45，不是 2:45）');
const t2024 = terms.termsOfYear(2024);
assertEqual(Object.keys(t2024).length, 24, '2024 年共 24 个节气');
assertEqual(Object.keys(t2024).filter(function (k) { return t2024[k].jie; }).length, 12, '其中 12 个是「节」');
assertEqual(Object.keys(t2024).filter(function (k) { return !/^\d\d:\d\d$/.test(t2024[k].time); }).length, 0,
  '每个节气都带 HH:mm 形式的交节时刻');

/* ⚠ 早年节气会漂到上一个公历年：实测「1001 年的小寒」落在公历 1000-12-31。
   只扫本年度的实现会把这天漏掉 —— 这条守着「按 y-1~y+1 三年扫、再按实际公历日归年」。
   （判「当天是不是节气」也不能用 SolarTime.getTerm()：它返回的是该时刻**所处**的节气，
     一天内会变 —— 2024-02-04 立春 16:27，当天 0 点还返回「大寒」。）
   （交节时刻也不是 SolarTerm 直接给的：它没有 getSolarTime，
     得走 getJulianDay().getSolarTime() —— 少了这一步 time 会是空的。） */
assertEqual(termText(1000, 12, 31), '小寒(节) 19:00', '1001 年的小寒落在 1000-12-31（按公历日归年）');

/* 公历口径：日格逐格标 —— 2024 年 2 月是 4 日立春 / 19 日雨水 */
const febMarks = dp.dayTerms('solar', 2024 - timeUtil.SOLAR_YEAR_MIN, 1);
assertEqual(febMarks.length, 29, '节气标注与日格一一对应（2024 二月 29 格）');
assertEqual(markText(febMarks[3]), '立春 16:27', '2/4 那一格标立春 + 交节时刻');
assertEqual(markText(febMarks[18]), '雨水 12:13', '2/19 那一格标雨水 + 交节时刻');
assertEqual(febMarks.filter(function (x) { return x; }).length, 2, '公历一个月通常只有 2 个节气');
assertEqual(markText(dp.gridOf({ cal: 'solar', idx: [2024 - timeUtil.SOLAR_YEAR_MIN, 1, 3, 0, 0] }, 'day').items[3].term),
  '立春 16:27', 'gridOf 的日格带上了 term（含时刻）');
assertEqual('term' in dp.gridOf(solarSt, 'year').items[0], false, '年 / 月 / 时 / 分的格子不带 term');

/* 农历口径：农历 2024 正月 = 公历 2024-02-10 起 → 初十 = 02-19（雨水）、廿五 = 03-05（惊蛰） */
const lzMarks = dp.dayTerms('lunar', 2024 - lunar.YEAR_MIN, 0);
assertEqual(markText(lzMarks[9]), '雨水 12:13', '农历 2024 正月初十 = 公历 2024-02-19（雨水）');
assertEqual(markText(lzMarks[24]), '惊蛰 10:22', '农历 2024 正月廿五 = 公历 2024-03-05（惊蛰）');

/* ---------- 用例 8：时间工具 ---------- */
assertEqual(timeUtil.parseDate('1990-01-01'), { y: 1990, m: 1, d: 1 }, '解析日期');
assertEqual(timeUtil.parseTime('11:04'), { h: 11, mi: 4 }, '解析时间');
assertEqual(timeUtil.fmtDate(2026, 9, 3), '2026-09-03', '格式化日期');

/* ---------- 用例 8b：公历月长 / 闰年一律走 tyme（含 1582 改历那两处）----------
 * 这两组断言是「日历凭什么不会错」的落点：项目里的历法计算**只有 tyme 一个来源**，
 * 全量交叉验证在 tools/check-calendar.js（逐月 + 逐日 38 万天，与原生 Date 对照）。
 * 这里只放几个**卡在改历边界上的样本**，让改坏时有短平快的反馈。
 */
const tymeLib = require('../src/vendor/tyme.js');

assertEqual(timeUtil.daysInMonth(2024, 2), 29, '2024 年二月 29 天（格里高利闰年）');
assertEqual(timeUtil.daysInMonth(1900, 2), 28, '1900 年二月 28 天（百年不闰）');
assertEqual(timeUtil.daysInMonth(2000, 2), 29, '2000 年二月 29 天（四百年再闰）');
assertEqual(timeUtil.isLeapYear(1500), true, '1500 年是闰年 —— 改历前走**儒略历**（能被 4 整除即可）');
assertEqual(timeUtil.isLeapYear(1700), false, '1700 年不是闰年 —— 改历后走格里高利历（百年不闰）');

/* 1582 年 10 月：儒略历改格里高利历，5~14 日不存在 */
assertEqual(timeUtil.daysInMonth(1582, 10), 21, '1582 年 10 月只有 21 天（缺 5~14 日）');
assertEqual(timeUtil.solarDayValues(1582, 10).join(','), '1,2,3,4,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31',
  '1582-10 的真实日号跳过 5~14');
assertEqual(timeUtil.solarDayValues(2024, 2).length, 29, '常月的日号就是 1..N');
assertEqual(timeUtil.solarDayValues(2024, 2)[28], 29, '常月日号表最后一个 = 天数');

/* 面板语义：**格子下标 ≠ 日号**的地方（1582-10）必须查表换算。
 * 旧实现用「下标 + 1」当日号，那个月的第 5 格会变成不存在的 1582-10-05 —— 点下去排盘抛异常。 */
const y1582 = 1582 - timeUtil.SOLAR_YEAR_MIN;
assertEqual(dp.dayOfIndex('solar', y1582, 9, 4), 15, '1582-10 第 5 格是 15 日（不是 5 日）');
assertEqual(dp.indexOfDay('solar', y1582, 9, 15), 4, '1582-10-15 落在第 5 格');
assertEqual(dp.resolve({ cal: 'solar', idx: [y1582, 9, 4, 12, 0] }).date, '1582-10-15', '点第 5 格 → 1582-10-15');
assertEqual(dp.fromSolar('1582-10-15', '12:00', 'solar').idx[2], 4, '1582-10-15 回填到第 5 格');
assertEqual(dp.view({ cal: 'solar', idx: [y1582, 9, 4, 12, 0] }, 'day').crumb[2].label, '15日',
  '面包屑显示的日号与格子一致');
assertEqual(dp.dayLabels('solar', y1582, 9).length, 21, '1582-10 的日格是 21 格');
assertEqual(dp.dayLabels('solar', y1582, 9)[4], '15日', '第 5 格标 15日');
/* 那一整个月能点出来的日期，逐个都必须真实存在 —— 旧实现会在这里炸出 5~14 日 */
let bad1582 = 0;
for (let i = 0; i < 21; i++) {
  try {
    tymeLib.SolarDay.fromYmd(1582, 10, dp.dayOfIndex('solar', y1582, 9, i));
  } catch (e) {
    bad1582++;
  }
}
assertEqual(bad1582, 0, '1582-10 面板能点出来的 21 个日期全都真实存在（否则点了就崩）');
/* 节气也跟着走：那个月的寒露落在**不存在的 10-08** 上，所以整月只剩霜降一个。
   节气标注必须与 21 个日格一一对应，而不是与「日历上的 31 天」对应。 */
const marks1582 = dp.dayTerms('solar', y1582, 9);
assertEqual(marks1582.length, 21, '1582-10 的节气标注跟着日格数（21），不跟着天数（31）');
/* 格下标不是「日号 - 1」：日号表是 [1,2,3,4,15,…,31]，所以 22 日落在第 4 + (22-15) = 11 格 */
assertEqual(markText(marks1582[11]), '霜降 02:56', '1582-10-22 霜降（跳过缺口后的第 12 格）');
assertEqual(marks1582.filter(function (x) { return x; }).length, 1, '1582 年 10 月只剩霜降一个节气');

/* ---------- 用例 9：八字扩展（司令分野 / 胎元 / 起运 / 大运 / 逐年小运）----------
 * utils/bazi.js 移植自 mingliWEB 的排八字封装。下面的期望值取自该原实现的输出，
 * 并由 tools/check-bazi-port.js 做过逐字段对拍；改动本文件后请重跑那个脚本。
 */

const b1 = bazi.calculate({ year: 2026, month: 9, day: 30, hour: 11, minute: 4, gender: 1 });
assertEqual([b1.year, b1.month, b1.day, b1.hour], ['丙午', '丁酉', '丁未', '丙午'], '八字四柱与 chart 一致');
assertEqual(b1.qianKun, '乾', '男命称乾造');
assertEqual(b1.shiChen, '午时', '时辰称谓');
assertEqual(b1.siLing, '辛司令（白露第22.5天，距寒露8.1天）', '司令分野');
assertEqual(b1.taiYuan, '戊子', '胎元');
assertEqual(b1.birthYear, 2026, '出生农历年');
assertEqual(b1.lunarDate, '八月二十', '农历月日');
assertEqual(b1.qiYunTime.dateText + ' ' + b1.qiYunTime.timeText, '2029-06-16 13:38', '起运时刻');
assertEqual(b1.dayunDirection, 1, '大运方向（男逢阳年顺行）');
assertEqual(b1.dayuns.length, 12, '共十二步大运');
assertEqual(
  [b1.dayuns[0].starYear, b1.dayuns[0].dayunganzhi, b1.dayuns[0].startAge],
  [2029, '戊戌', 4],
  '第一步大运'
);
assertEqual(
  [b1.dayuns[11].starYear, b1.dayuns[11].dayunganzhi],
  [2139, '己酉'],
  '第十二步大运'
);
assertEqual(b1.yearlyFortunes.length, 71, '逐年小运条数（出生年起 71 年）');
assertEqual(
  [b1.yearlyFortunes[0].year, b1.yearlyFortunes[0].age, b1.yearlyFortunes[0].xiaoYun],
  [2026, 1, '丁未'],
  '逐年小运首年'
);

/* 女命：对立规则（阳男阴女顺行 → 己为阴干，女命顺行） */
const b2 = bazi.calculate({ year: 1990, month: 1, day: 1, hour: 0, minute: 0, gender: 0 });
assertEqual(b2.qianKun, '坤', '女命称坤造');
assertEqual(b2.qiYunTime.dateText, '1991-08-23', '女命起运日期');
assertEqual(b2.dayunDirection, 1, '大运方向（己为阴干，女命顺行）');
assertEqual(
  [b2.dayuns[0].starYear, b2.dayuns[0].dayunganzhi],
  [1991, '丁丑'],
  '女命第一步大运'
);

/* 晚子时：时辰称谓为夜子时，日柱进次日 */
const b3 = bazi.calculate({ year: 2026, month: 9, day: 30, hour: 23, minute: 30, gender: 1 });
assertEqual(b3.shiChen, '夜子时', '晚子时时辰称谓');
assertEqual([b3.day, b3.hour], ['戊申', '壬子'], '晚子时日柱进次日');

/* 司令分野跨节气：立春前后 1 小时换段 */
assertEqual(
  bazi.getSiLingFromRysl({ year: 2024, month: 2, day: 4, hour: 16, minute: 0, second: 0 }),
  '己司令（小寒第29.5天，距立春0天）',
  '立春前 16:00 司令'
);
assertEqual(
  bazi.getSiLingFromRysl({ year: 2024, month: 2, day: 4, hour: 17, minute: 0, second: 0 }),
  '戊司令（立春第0天，距惊蛰29.7天）',
  '立春后 17:00 司令'
);

/* 藏干分日用事数据完整性：十二个月令齐备 */
assertEqual(bazi.RYSL_DATA.length, 12, '十二地支藏干分日用事齐备');
assertEqual(bazi.MONTH_JIE_QI.length, 12, '十二节齐备');

/* ---------- 五行配色映射（页面逐字上色用） ---------- */
/* 10 干 + 12 支必须全部有配色；缺一个字页面就会渲染成默认墨色，肉眼很难发现 */
const elementCodeOf = function (chars) {
  return chars.split('').map(function (c) { return chart.elementClass(c); });
};
assertEqual(
  elementCodeOf('甲乙丙丁戊己庚辛壬癸'),
  ['c-mu', 'c-mu', 'c-huo', 'c-huo', 'c-tu', 'c-tu', 'c-jin', 'c-jin', 'c-shui', 'c-shui'],
  '十天干五行配色'
);
assertEqual(
  elementCodeOf('子丑寅卯辰巳午未申酉戌亥'),
  ['c-shui', 'c-tu', 'c-mu', 'c-mu', 'c-tu', 'c-huo', 'c-huo', 'c-tu', 'c-jin', 'c-jin', 'c-tu', 'c-shui'],
  '十二地支五行配色'
);
assertEqual(chart.elementClass('〇'), '', '非干支字无配色（空串）');

/* gzClasses：逐字拆开给色；非干支（大运首列的「小运」）一律空串，页面回退整串渲染 */
assertEqual(chart.gzClasses('甲子'), { gan: '甲', zhi: '子', ganCls: 'c-mu', zhiCls: 'c-shui' }, 'gzClasses 甲子');
assertEqual(chart.gzClasses('小运'), { gan: '', zhi: '', ganCls: '', zhiCls: '' }, 'gzClasses 小运（非干支）');

/* 藏干（cangGanOf）：顺序 = 本气/中气/余气，十神以传入日干为「我」，cls 为五行配色 */
assertEqual(
  chart.cangGanOf('辰', '丙').map(function (x) { return x.stem + x.shiShen + '/' + x.cls; }),
  ['戊食神/c-tu', '乙正印/c-mu', '癸正官/c-shui'],
  '藏干 辰（日主丙）'
);
assertEqual(
  chart.cangGanOf('亥', '丁').map(function (x) { return x.stem + x.shiShen; }),
  ['壬正官', '甲正印'],
  '藏干 亥（日主丁，与问真专业细盘截图一致）'
);
assertEqual(chart.cangGanOf('寅', '〇'), [], '非法日干名 → 藏干为空');

/* ---------- 用例 10：事件记录（utils/notes.js）----------
   版式与交互照 mingliWEB 案例详情（modules/detail.js 的「事件记录」Tab），
   这一块是纯数据变换，最容易错的是三件：key 拼法、时间线的分层与排序、
   以及「大运自己没写、但它下面的流年写了」时那一行还得在（否则看不出这步流年属于谁）。 */
const notesLib = require('../src/core/notes.js');

assertEqual(notesLib.key('dayun', 'd3'), 'dayun:d3', '事件 key · 大运');
assertEqual(notesLib.key('liunian', 'd3', 2), 'liunian:d3:2', '事件 key · 流年');
assertEqual(notesLib.key('liuyue', 'd3', 2, 5), 'liuyue:d3:2:5', '事件 key · 流月');
assertEqual(notesLib.key('dayun', 'pre'), 'dayun:pre', '事件 key · 起运前小运');

/* 老数据可能直接是字符串（参考项目就是这么存的），两种都要认 */
assertEqual(notesLib.textOf('搬家'), '搬家', 'textOf · 字符串');
assertEqual(notesLib.textOf({ text: '生子' }), '生子', 'textOf · 对象');
assertEqual(notesLib.textOf(null), '', 'textOf · 空');
assertEqual(notesLib.textOf({}), '', 'textOf · 对象但没有正文');

/* 标题：弹窗与时间线共用一份，三层各验一条（年份 / 干支 / 岁数 / 月日都得上标题） */
assertEqual(
  notesLib.titleOf('dayun', { year: 2020, ganzhi: '庚子', age: 31 }),
  '【大运】庚子大运 2020 31岁',
  '事件标题 · 大运'
);
assertEqual(
  notesLib.titleOf('dayun', { year: 1990, ganzhi: '小运', age: '1~10' }),
  '【大运】起运前小运 1990 1~10岁',
  '事件标题 · 起运前小运'
);
assertEqual(
  notesLib.titleOf('liunian', { year: 2023, ganzhi: '癸卯', age: 34 }),
  '【流年】2023 癸卯 · 34岁',
  '事件标题 · 流年'
);
assertEqual(
  notesLib.titleOf('liuyue', { ganzhi: '甲寅', md: '2/4', jieQi: '立春' }),
  '【流月】立春 2/4 甲寅',
  '事件标题 · 流月'
);

/* 时间线：三层摊平 + 排序（起运前最前、其余按大运下标）+ 半空分组保留 */
const tlNotes = {
  'liuyue:d3:2:5': {
    text: '换了工作', ganzhi: '甲寅', md: '2/4', jieQi: '立春', year: 2023, age: 34,
    up: { year: 2023, ganzhi: '癸卯', age: 34 }, up2: { year: 2020, ganzhi: '庚子', age: 31 }
  },
  'liunian:d3:2': { text: '结婚', year: 2023, ganzhi: '癸卯', age: 34, up2: { year: 2020, ganzhi: '庚子', age: 31 } },
  'dayun:d3': { text: '这十年在南方', year: 2020, ganzhi: '庚子', age: 31 },
  'dayun:pre': { text: '起运前的旧事', year: 1990, ganzhi: '小运', age: '1~10' },
  'liunian:pre:0': { text: '出生那年的旧事', year: 1990, ganzhi: '庚午', age: 1, up2: { year: 1990, ganzhi: '小运', age: '1~10' } },
  // 空白正文 = 用户把它删空了 = 这条不算（否则时间线上会出现一条没有内容的空行）
  'dayun:d10': { text: '   ' },
  // 老数据：直接存字符串、没有元信息 —— 正文照显示，标题退化到只剩层级名
  'dayun:d1': '只有一句话的老数据',
  // 只写了流年、大运那一行自己没写 → 靠子级带回来的 up2 才有标题
  'liunian:d6:1': { text: '爸爸住院', year: 2030, ganzhi: '庚戌', age: 41, up2: { year: 2026, ganzhi: '丙午', age: 37 } }
};
const tl = notesLib.timeline(tlNotes);
/* ⚠⚠⚠ 2026-10-21 用户：「长按只有流年可以输入记录。大运，流月长按功能都移除掉。
   事件记录也只显示流年的就行了」⇒ `timeline` 现在**只返回流年那一行**
   （见 core/notes.js 末尾那句 filter，注释里写着为什么不在渲染时再过滤）。
   ⇒ 下面这三条按**新口径**写。别再按「大运 / 流月也出现」改回去：
     那样改完这里看着绿了，事件记录那一栏反而是坏的（用户明确要求过只留流年）。 */
assertEqual(
  tl.map(function (r) { return r.level; }),
  ['liunian', 'liunian', 'liunian'],
  '事件时间线 · 层级：**只留流年**（大运、流月不再进时间线）'
);
assertEqual(
  tl.map(function (r) { return r.title; }),
  ['【流年】1990 庚午 · 1岁', '【流年】2023 癸卯 · 34岁', '【流年】2030 庚戌 · 41岁'],
  '事件时间线 · 标题（按年份由早到晚；起运前那条也在）'
);
/* 反面守一遍：大运行 / 流月行一行都不许冒出来 —— 只写了大运的记录，时间线是空的 */
assertEqual(
  tl.filter(function (r) { return r.level !== 'liunian'; }).length, 0,
  '⚠⚠ 时间线里不许出现非流年的行（大运写了也不显示）'
);
assertEqual(
  notesLib.timeline({ 'dayun:d3': { text: '只写了大运', year: 2020, ganzhi: '庚子', age: 31 } }).length, 0,
  '⚠ 只写了大运 ⇒ 时间线为空（大运那条不进结果，但它的 key 仍然是合法的）'
);
assertEqual(notesLib.count(tlNotes), 7, '事件条数：只有空白的那条不算');

/* 流年那一行的父级快照来自它下面的流月（up），同样要能补出标题 */
assertEqual(
  notesLib.timeline({
    'liuyue:d2:4:6': {
      text: '住院', ganzhi: '乙酉', md: '3/5', jieQi: '惊蛰', year: 2031, age: 42,
      up: { year: 2031, ganzhi: '辛亥', age: 42 }, up2: { year: 2020, ganzhi: '庚子', age: 31 }
    }
  }).map(function (r) { return r.title; }),
  ['【流年】2031 辛亥 · 42岁'],
  '事件时间线 · 只写了流月时：流年那一行的标题靠 up 补对（流月自己不再显示）'
);

assertEqual(notesLib.timeline({}), [], '事件时间线 · 没有任何事件时是空数组');
assertEqual(notesLib.timeline({ 'dayun:d0': { text: '   ' } }), [], '事件时间线 · 只有空白正文等于没写');

/* 大运 key 的换算只此一份（chart-view 建表与事件 key 都用它） */
assertEqual(notesLib.dayunKeyOf(-1) + ',' + notesLib.dayunKeyOf(0) + ',' + notesLib.dayunKeyOf(11), 'pre,d0,d11', '大运 key 换算');
assertEqual(notesLib.dayunIndexOf('pre') + ',' + notesLib.dayunIndexOf('d0') + ',' + notesLib.dayunIndexOf('d11'), '-1,0,11', '大运 key 反查下标');

/* ---------- 用例 10b：事件记录跟着记录上云，不能被压掉 ----------
   ⚠ 这是最容易出人命的一条：history.push() 会把云端**已有的每一条**都过一遍
     record.toStorage()。toStorage 一旦不认 notes，保存任何一条新记录
     都会顺手把别人的事件记录抹掉 —— 而且现场看不出来。 */
const recWithNotes = {
  id: 'c1', name: '带事件的', gender: 1, date: '1990-01-01', time: '11:04',
  createdAt: 1, chart: { fake: true }, notes: { 'dayun:d0': { text: '搬家', year: 1990 } }
};
const slimmed = recordLib.toStorage(recWithNotes);
assertEqual(Object.keys(slimmed).sort(), ['createdAt', 'date', 'gender', 'id', 'name', 'notes', 'time'],
  'toStorage：轻记录 6 个字段 + 有事件时才多一个 notes');
assertEqual(at(slimmed, 'notes', 'dayun:d0', 'text'), '搬家', 'toStorage：事件正文没被压掉');
assertEqual(Object.keys(recordLib.toStorage({
  id: 'c2', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', notes: {}
})).length, 6, 'toStorage：空 notes 不落库（云端不该多出一堆 notes:{}）');
assertEqual(recordLib.toStorage({
  id: 'c2', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', notes: ''
}).notes, undefined, 'toStorage：notes 不是对象时直接忽略');

/* hydrate 要把 notes 带回来，否则「从记录页点开」看到的事件会凭空消失 */
const hydrated = recordLib.hydrate({ id: 'c1', name: '带事件的', gender: 1, date: '1990-01-01', time: '11:04', notes: { 'dayun:d0': { text: '搬家' } } });
assertEqual(at(hydrated, 'notes', 'dayun:d0', 'text'), '搬家', 'hydrate：重排后仍带着事件记录');
assertEqual(at(recordLib.hydrate({ id: 'c1', name: 'x', gender: 1, date: '1990-01-01', time: '11:04' }), 'notes'),
  {}, 'hydrate：没有事件时给一个干净的空对象（页面不用到处判 null）');

/* ---------- 用例 10c：描述（desc）同样不能被压掉 ----------
   ⚠ 和 notes 是**完全同一条路**：history.push() 会把每条都过一遍 toStorage，
     toStorage 一旦不认 desc，保存任何一条新记录都会把**别人的描述**抹掉。
     所以这里按同一套口径验：非空要带上、空/空白/非字符串要摘掉、hydrate 要带回来。 */
const recWithDesc = {
  id: 'c3', name: '带描述的', gender: 1, date: '1990-01-01', time: '11:04',
  createdAt: 1, chart: { fake: true }, desc: '甲辰年伤官见官\n第二行'
};
const slimmedDesc = recordLib.toStorage(recWithDesc);
assertEqual(Object.keys(slimmedDesc).sort(), ['createdAt', 'date', 'desc', 'gender', 'id', 'name', 'time'],
  'toStorage：有描述时才多一个 desc');
assertEqual(slimmedDesc.desc, '甲辰年伤官见官\n第二行',
  '⚠ toStorage：描述原文照搬（含换行），不许 trim 掉换行');
assertEqual(recordLib.toStorage({
  id: 'c4', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', desc: ''
}).desc, undefined, 'toStorage：空描述不落库');
assertEqual(recordLib.toStorage({
  id: 'c4', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', desc: '   '
}).desc, undefined, '⚠ toStorage：纯空白描述不落库（只按 !v 判的话 "   " 会被当成有内容存上去）');
assertEqual(recordLib.toStorage({
  id: 'c4', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', desc: 123
}).desc, undefined, 'toStorage：描述不是字符串时直接忽略');
/* ⚠ 描述与事件是**两个字段**，一个在不会把另一个挤掉 */
const bothOpt = recordLib.toStorage({
  id: 'c5', name: 'a', gender: 1, date: '1990-01-01', time: '11:04',
  desc: '有描述', notes: { 'dayun:d0': { text: '搬家' } }
});
assertEqual(Object.keys(bothOpt).sort(), ['createdAt', 'date', 'desc', 'gender', 'id', 'name', 'notes', 'time'],
  '⚠ toStorage：描述与事件可以同时在（别写成互斥）');

/* hydrate 要把 desc 带回来，否则「从记录页点开」看到的描述会凭空消失 */
assertEqual(recordLib.hydrate({
  id: 'c3', name: '带描述的', gender: 1, date: '1990-01-01', time: '11:04', desc: '甲辰年伤官见官'
}).desc, '甲辰年伤官见官', 'hydrate：重排后仍带着描述');
assertEqual(recordLib.hydrate({
  id: 'c3', name: 'x', gender: 1, date: '1990-01-01', time: '11:04'
}).desc, undefined, '⚠ hydrate：没有描述时是 undefined（不是空串）—— 界面上「有没有描述」是个明确判断');

/* ---------- 用例 10d：职业（job）—— 2026-10-06 新增的可选字段 ----------
   ⚠ 它和 desc 是**完全同一条路**（同一张 OPTIONAL_FIELDS 表、同一条整行 PUT 的保存路径）：
     toStorage 不认它 ⇒ 改别的字段时职业被静默抹掉；
     hydrate 不带它 ⇒ 从记录页点开看不到职业，而一保存就真没了。 */
const recWithJob = {
  id: 'c6', name: '带职业的', gender: 1, date: '1990-01-01', time: '11:04',
  createdAt: 1, chart: { fake: true }, job: '教师'
};
const slimmedJob = recordLib.toStorage(recWithJob);
assertEqual(Object.keys(slimmedJob).sort(), ['createdAt', 'date', 'gender', 'id', 'job', 'name', 'time'],
  'toStorage：有职业时才多一个 job');
assertEqual(slimmedJob.job, '教师', 'toStorage：职业原样带上');
assertEqual(recordLib.toStorage({
  id: 'c6', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', job: ''
}).job, undefined, 'toStorage：空职业不落库');
assertEqual(recordLib.toStorage({
  id: 'c6', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', job: '   '
}).job, undefined, '⚠ toStorage：纯空白职业不落库（与描述同一条判空纪律）');
assertEqual(recordLib.toStorage({
  id: 'c6', name: 'a', gender: 1, date: '1990-01-01', time: '11:04', job: 123
}).job, undefined, 'toStorage：职业不是字符串时直接忽略');
/* ⚠ 描述 / 职业 / 事件三个可选字段互不挤占 */
assertEqual(Object.keys(recordLib.toStorage({
  id: 'c7', name: 'a', gender: 1, date: '1990-01-01', time: '11:04',
  desc: '有描述', job: '教师', notes: { 'dayun:d0': { text: '搬家' } }
})).sort(), ['createdAt', 'date', 'desc', 'gender', 'id', 'job', 'name', 'notes', 'time'],
  '⚠ toStorage：描述 / 职业 / 事件可以同时在（别写成两两互斥）');

/* ⚠⚠⚠ hydrate **必须把 job 带回来**（读路径）——
   漏了它就是最坏的一类 bug：界面上显示「未填写」，而**改任意别的字段再保存**
   正好把库里的职业抹掉（mergePatch 走 toStorage(rec)，rec 上没有 job 这个键）。 */
assertEqual(recordLib.hydrate({
  id: 'c6', name: '带职业的', gender: 1, date: '1990-01-01', time: '11:04', job: '教师'
}).job, '教师', '⚠⚠⚠ hydrate：重排后仍带着职业（漏了 = 保存别的字段时静默抹掉它）');
assertEqual(recordLib.hydrate({
  id: 'c6', name: 'x', gender: 1, date: '1990-01-01', time: '11:04'
}).job, undefined, '⚠ hydrate：没有职业时是 undefined（不是空串）—— 与 desc 同一口径');

/* create() 要能收第 5 个参数（排盘页填的描述直接进记录） */
const createdWithDesc = recordLib.create('测试', 1, '1990-01-01', '11:04', '我是描述');
assertEqual(createdWithDesc.desc, '我是描述', 'create：第 5 个参数是描述');
assertEqual(recordLib.create('测试', 1, '1990-01-01', '11:04').desc, undefined, 'create：不传描述时没有 desc 字段');

/* ---------- 用例 11：四柱 → 出生日期（反查） ----------
 *
 * 反查的整个价值就在一条闭环上：**查出来的日期拿去排盘，四柱必须和输入的一模一样**。
 * 所以下面每一条候选都要过一遍 chart.paipan() 复验，而不是只看条数对不对。
 */

/** 四柱对象 → '庚午 戊寅 庚子 丙子' */
function szText(p) { return [p.year, p.month, p.day, p.hour].join(' '); }

/** 候选项的「回填值」拿去真排一次盘，返回四柱串 */
function szChars(it) {
  const dt = timeUtil.parseDate(it.pickDate);
  const tm = timeUtil.parseTime(it.pickTime);
  return chart.paipan(dt.y, dt.m, dt.d, tm.h, tm.mi).fourChars.join(' ');
}

assertEqual(szLib.gzList().length, 60, '四柱：60 甲子表');
assertEqual(szLib.gzList()[0] + '…' + szLib.gzList()[59], '甲子…癸亥', '四柱：60 甲子首尾');
assertEqual(szLib.isValidGZ('甲子') + ',' + szLib.isValidGZ('庚午'), 'true,true', '四柱：入表的干支认得出来');
assertEqual(szLib.isValidGZ('甲丑') + ',' + szLib.isValidGZ('乙子'), 'false,false',
  '四柱：天干地支要同奇偶，甲丑 / 乙子 不在 60 甲子里（查之前就得拦掉）');

/* 五鼠遁：时柱的天干是日干推出来的，不相容的组合一定无解 */
assertEqual(szLib.hourMatchesDay('甲子', '甲子'), true, '四柱 五鼠遁：甲子日的子时是甲子（甲己还加甲）');
assertEqual(szLib.hourMatchesDay('庚子', '丙子'), true, '四柱 五鼠遁：庚子日的子时是丙子（乙庚丙作初）');
assertEqual(szLib.hourMatchesDay('庚子', '甲子'), false, '四柱 五鼠遁：庚子日推不出甲子时');
assertEqual(szLib.hourMatchesDay('丁未', '丙午'), true, '四柱 五鼠遁：丁未日的午时是丙午（丁壬庚子居）');
assertEqual(szLib.hourMatchesDay('丁未', '壬午'), false, '四柱 五鼠遁：丁未日推不出壬午时');

/* ---------- 用例 11a：四柱录入的八步向导（utils/gzstep.js）----------
 *
 * 用户反馈「四列各滚一条 60 甲子太过于麻烦了」，于是录入改成八步：
 *   年干 → 年支 → 月干 → 月支 → 日干 → 日支 → 时干 → 时支
 * 干那四步给满 10 个；支那四步只给「配得上的」。这一节守的就是**那四条约束**，
 * 以及一条最重要的性质：**走得到底，且走到底的一定是历法上存在的四柱**。
 */

assertEqual(gsLib.STEPS.length, 8, '向导：一共八步');
assertEqual(gsLib.STEPS.map(function (s) { return s.label; }).join(''),
  '年干年支月干月支日干日支时干时支', '向导：八步的顺序是 年干→年支→月干→月支→日干→日支→时干→时支');
assertEqual(gsLib.STEPS.filter(function (s) { return s.part === 'gan'; }).length, 4,
  '向导：其中四个「干」步、四个「支」步');

/* 每个干只配 6 个支（干支同奇偶），而且配出来的必须真的在 60 甲子里 */
const gsPartnerBad = szLib.GAN.filter(function (g) {
  const zs = szLib.zhiPartnersOfGan(g);
  return zs.length !== 6 || zs.filter(function (z) { return !szLib.isValidGZ(g + z); }).length > 0;
});
assertEqual(gsPartnerBad.join(''), '', '向导：每个干都恰好配 6 个支，且配出来都在 60 甲子里');
assertEqual(szLib.zhiPartnersOfGan('甲').join(''), '子寅辰午申戌', '向导：甲配 子寅辰午申戌（甲丑这种不存在）');
assertEqual(szLib.zhiPartnersOfGan('乙').join(''), '丑卯巳未酉亥', '向导：乙配 丑卯巳未酉亥');

/* 两句口诀：五虎遁（年上起月）、五鼠遁（日上起时）—— 分组都是 干序号 % 5 */
assertEqual(szLib.GAN.map(function (g) { return szLib.GAN[szLib.fiveTigerStart(g)]; }).join(''),
  '丙戊庚壬甲丙戊庚壬甲', '向导 五虎遁：甲己丙作首、乙庚戊为头、丙辛庚起、丁壬壬、戊癸甲寅');
assertEqual(szLib.GAN.map(function (g) { return szLib.GAN[szLib.fiveRatStart(g)]; }).join(''),
  '甲丙戊庚壬甲丙戊庚壬', '向导 五鼠遁：甲己甲、乙庚丙、丙辛戊、丁壬庚、戊癸壬');

/**
 * 把某几步的**所有**合法走法穷举出来，同时记下每一步选项数的上下界。
 * 前一半（年干→月支）与后一半（日干→时支）互不依赖，各 ~900 条，跑起来毫无压力。
 */
function gsWalk(from, to) {
  let fronts = [gsLib.emptyPicks()];
  const bounds = [];
  for (let i = from; i <= to; i++) {
    const next = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let n = 0; n < fronts.length; n++) {
      const opts = gsLib.optionsAt(i, fronts[n]);
      if (opts.length < lo) lo = opts.length;
      if (opts.length > hi) hi = opts.length;
      for (let k = 0; k < opts.length; k++) {
        const p = fronts[n].slice();
        p[i] = opts[k].v;
        next.push(p);
      }
    }
    bounds.push([lo, hi]);
    fronts = next;
  }
  return { ends: fronts, bounds: bounds };
}

const gsFront = gsWalk(0, 3);
const gsBack = gsWalk(4, 7);

/* 干步永远 10 个 —— 这条保证了「任何一步都不会无路可走」 */
assertEqual(gsFront.bounds[0].join('~') + '/' + gsFront.bounds[2].join('~'), '10~10/10~10',
  '向导：年干 / 月干 那两步对任意前缀都给满 10 个干（走不到死胡同）');
assertEqual(gsBack.bounds[0].join('~') + '/' + gsBack.bounds[2].join('~'), '10~10/10~10',
  '向导：日干 / 时干 那两步也是 10 个');
assertEqual(gsFront.bounds[1].join('~'), '6~6', '向导：年支每一步都是 6 个（同奇偶）');
assertEqual(gsBack.bounds[1].join('~'), '6~6', '向导：日支每一步都是 6 个（同奇偶）');
assertEqual(gsFront.bounds[3][0] >= 1 && gsFront.bounds[3][1] <= 2, true,
  '向导：月支被五虎遁收窄到 1~2 个（实测 ' + gsFront.bounds[3].join('~') + '）');
assertEqual(gsBack.bounds[3][0] >= 1 && gsBack.bounds[3][1] <= 2, true,
  '向导：时支被五鼠遁收窄到 1~2 个（实测 ' + gsBack.bounds[3].join('~') + '）');

/* 走到底的四柱必须合法：年月柱满足五虎遁，时柱满足五鼠遁 */
const gsBadMonth = gsFront.ends.filter(function (p) {
  const k = (szLib.ZHI.indexOf(p[3]) - 2 + 12) % 12;          // 月序：寅 = 0
  const want = szLib.GAN[(szLib.fiveTigerStart(p[0]) + k) % 10];
  return !szLib.isValidGZ(p[0] + p[1]) || !szLib.isValidGZ(p[2] + p[3]) || want !== p[2];
});
const gsBadHour = gsBack.ends.filter(function (p) {
  return !szLib.isValidGZ(p[4] + p[5]) || !szLib.isValidGZ(p[6] + p[7]) ||
    !szLib.hourMatchesDay(p[4] + p[5], p[6] + p[7]);
});
assertEqual(gsFront.ends.length + ' 条全合法' + (gsBadMonth.length ? '（有 ' + gsBadMonth.length + ' 条不合）' : ''),
  gsFront.ends.length + ' 条全合法',
  '向导：穷举前一半 ' + gsFront.ends.length + ' 条走法，年 / 月柱都在 60 甲子里且满足五虎遁');
assertEqual(gsBack.ends.length + ' 条全合法' + (gsBadHour.length ? '（有 ' + gsBadHour.length + ' 条不合）' : ''),
  gsBack.ends.length + ' 条全合法',
  '向导：穷举后一半 ' + gsBack.ends.length + ' 条走法，日 / 时柱都在 60 甲子里且满足五鼠遁');

/* 主路径上每一步的选项：丙午 丁酉 丁未 丙午 */
assertEqual(gsLib.optionsAt(1, ['丙']).map(function (o) { return o.v; }).join(''), '子寅辰午申戌',
  '向导：选了年干「丙」之后，年支只给 子寅辰午申戌');
assertEqual(gsLib.optionsAt(3, ['丙', '午', '丁']).map(function (o) { return o.gz; }).join(','), '丁酉',
  '向导：丙年 + 丁月 → 月支只剩「丁酉」（八月，从白露起）');
assertEqual(gsLib.optionsAt(7, ['丙', '午', '丁', '酉', '丁', '未', '丙']).map(function (o) { return o.gz; }).join(','),
  '丙午', '向导：丁日 + 丙时 → 时支只剩「丙午」（11:00-13:00）');
assertEqual(gsLib.hintAt(3, ['丙', '午', '丁']), '年上起月（五虎遁）：丙辛必定寻庚起',
  '向导：月支那一步把用到的口诀写出来（用户才知道为什么只剩一个）');
assertEqual(gsLib.hintAt(7, ['', '', '', '', '丁', '未', '丙']), '日上起时（五鼠遁）：丁壬庚子居',
  '向导：时支那一步同理');

/* 改前面一步 → **只清配不上的**，与它无关的保住 */
const gsPicks = gsLib.pillarsToPicks({ year: '丙午', month: '丁酉', day: '丁未', hour: '丙午' });
assertEqual(gsPicks.join(','), '丙,午,丁,酉,丁,未,丙,午', '向导：四柱 → 八步 picks');
assertEqual(gsLib.firstEmpty(gsPicks), -1, '向导：八步都齐了 → firstEmpty = -1');
const gsChanged = gsPicks.slice();
gsChanged[0] = '乙';
assertEqual(gsLib.normalize(gsChanged).join(','), '乙,,丁,,丁,未,丙,午',
  '向导 收敛：年干 丙→乙 只清掉配不上的年支与月支（乙年不能有 丁酉），' +
  '与年干无关的月干、整根日柱与整根时柱都保住');
assertEqual(gsLib.picksToPillars(gsPicks).year + gsLib.picksToPillars(gsPicks).hour, '丙午丙午',
  '向导：八步 picks → 四柱');

/* 视图：面包屑 / 已选 / ready */
const gsView = gsLib.view({ picks: gsPicks }, 0);
assertEqual(gsView.crumb.length + '/' + gsView.stepTotal + '/' + gsView.stepNo, '8/8/1',
  '向导 视图：面包屑八项，八步全走完时停在第 8 步');
assertEqual(gsView.crumb.filter(function (c) { return c.done; }).length, 8, '向导 视图：面包屑八项全亮');
assertEqual(gsView.crumb[0].active + ',' + gsView.crumb[1].active, 'true,false',
  '向导 视图：只有当前那一步是 active（点面包屑回退靠它）');
assertEqual(gsView.pickedText, '丙午 · 丁酉 · 丁未 · 丙午', '向导 视图：已选那行按「年 月 日 时」拼');
const gsCrumbEmpty = gsLib.view({ picks: gsLib.emptyPicks() }, 0).crumb[0];
assertEqual(gsCrumbEmpty.show + '/' + gsCrumbEmpty.text + '/' + gsCrumbEmpty.done, '—//false',
  '向导 视图：没选的那一步用「—」占位（模板不挂 tt:if）—— 两行面包屑的高度才不会随进度变');
assertEqual(gsLib.view({ picks: gsLib.emptyPicks() }, 0).pickedText, '— · — · — · —',
  '向导 视图：一步没选时四根柱都是「—」');
assertEqual(gsLib.view({ picks: gsLib.emptyPicks() }, 0).ready, false, '向导 视图：没选齐 → ready 为假');

/* 视图：四柱表（crumbCols）—— 一列一根柱、**干在上支在下**。
   用户原话：「第一排上面为年干 下面为年支」。
   这几条守的是「列的切法」：切歪了模板照样能渲染，但四根柱会串位，只能在这里抓。 */
assertEqual(gsView.crumbCols.map(function (c) { return c.title; }).join('/'), '年柱/月柱/日柱/时柱',
  '向导 四柱表：四列依次是 年柱 / 月柱 / 日柱 / 时柱');
assertEqual(gsView.crumbCols.map(function (c) { return c.cells.length; }).join('/'), '2/2/2/2',
  '向导 四柱表：每列两个格子（上面干、下面支）');
assertEqual(gsView.crumbCols[0].cells.map(function (c) { return c.label; }).join(','), '年干,年支',
  '向导 四柱表：列内第 0 格是**干**、第 1 格是**支**（顺序反了就成了「支在上干在下」）');
const gsColSteps = [];
gsView.crumbCols.forEach(function (c) { c.cells.forEach(function (x) { gsColSteps.push(x.i); }); });
assertEqual(gsColSteps.join(','), '0,1,2,3,4,5,6,7',
  '向导 四柱表：八步在表里各出现一次、且按「同柱的干 + 同柱的支」两两成列（一个都不许丢，也不许重复）');
assertEqual(gsView.crumbCols[0].cells.map(function (c) { return c.show; }).join(''), '丙午',
  '向导 四柱表：年柱那一列显示成「上丙下午」');
assertEqual(gsView.crumbCols.map(function (c) { return c.active; }).join(','), 'true,false,false,false',
  '向导 四柱表：停在年干那一步时只有年柱整列高亮（gsView 传的是 stepIdx=0）');
assertEqual(gsLib.view({ picks: gsPicks }, 7).crumbCols.map(function (c) { return c.active; }).join(','),
  'false,false,false,true', '向导 四柱表：停在最后一步（时支）时亮的是时柱');
assertEqual(gsLib.view({ picks: gsLib.emptyPicks() }, 2).crumbCols[0].cells.map(function (c) {
  return c.show;
}).join(''), '——', '向导 四柱表：没选时两格都是「—」（模板不挂 tt:if，高度才稳定）');

/**
 * ⚠ 取 view 的结果时**别直接解引用**：越界没收敛的话 `STEPS[99]` 是 undefined，
 *   一路 `undefined.part` 会抛 TypeError，**整个测试脚本当场崩掉、后面一条用例都不跑**，
 *   看起来像「只有这一处坏了」—— 比真报错还误导（见技能 assertion-negative-verification）。
 *   这里先合成一个可比较的值，任何异常都变成一条 FAIL 文案。
 */
function gsStepOf(state, i) {
  try {
    return gsLib.view(state, i).step;
  } catch (err) {
    return '抛异常：' + err.message;
  }
}

assertEqual(gsStepOf({ picks: gsPicks }, 99), 7, '向导 视图：步号越界收敛到最后一步（不抛异常）');
assertEqual(gsStepOf({ picks: gsPicks }, -3), 0, '向导 视图：步号负数收敛到第一步');

/* 回填：从记录 / 上一次的四柱回到面板 */
assertEqual(gsLib.pillarsToPicks({ year: '丙午', month: '丁酉', day: '丁未', hour: '' }).join(','),
  '丙,午,丁,酉,丁,未,,', '向导 回填：只录了三根柱 → 停在时干那一步');
assertEqual(gsLib.pillarsToPicks({ year: '丙午', month: '丁酉', day: '丁未', hour: '甲子' }).join(','),
  '丙,午,丁,酉,丁,未,甲,',
  '向导 回填：存着一个**配不上的**时柱（丁日推不出甲子时）→ 时支被清掉；' +
  '时干「甲」本身是合法的可选项，留着（用户接着选时支就行）');
assertEqual(gsLib.pillarsToPicks(null).join(','), ',,,,,,,', '向导 回填：没录过就给空');


/* --- 主用例：项目基准日 2026-09-30 11:04 → 丙午 丁酉 丁未 丙午 --- */
const SZ_BASE = { year: '丙午', month: '丁酉', day: '丁未', hour: '丙午' };
const rSz = szLib.search(SZ_BASE);
const sz2026 = rSz.list.filter(function (it) { return it.dateText === '2026-09-30'; })[0];

assertEqual(rSz.ok, true, '四柱反查：丙午 丁酉 丁未 丙午 查得到（' + rSz.list.length + ' 条）');
assertEqual(sz2026 ? sz2026.pickTime : '(缺)', '12:00', '四柱反查：2026-09-30 那条回填 12:00（午时中点）');
assertEqual(at(sz2026, 'timeText'), '11:00-13:00', '四柱反查：午时的标称区间');
assertEqual(at(sz2026, 'zhiText'), '午时', '四柱反查：非子时的时辰名');
assertEqual(at(sz2026, 'lunarText'), '二〇二六年八月二十', '四柱反查：候选项带农历（中文数字年）');
assertEqual(at(sz2026, 'weekText'), '星期三', '四柱反查：候选项带星期');
assertEqual(at(sz2026, 'narrow'), false, '四柱反查：2026-09-30 不在交节日，整段可用');
assertEqual(at(sz2026, 'spanText'), '', '四柱反查：没被交节切过就不给「实际」那行');

/* 闭环：每一条候选的回填值拿去排盘，四柱都要和输入完全一致 */
assertEqual(
  rSz.list.filter(function (it) { return szChars(it) !== szText(SZ_BASE); })
    .map(function (it) { return it.dateText + ' ' + it.pickTime; }),
  [],
  '四柱反查：' + rSz.list.length + ' 条候选的回填值逐条排盘，四柱全都与输入一致'
);

/* 历法约束住了数量，也拉开了年份跨度 */
assertEqual(rSz.list.length >= 8 && rSz.list.length <= 40, true,
  '四柱反查：候选是十来个量级（' + rSz.list.length + ' 条），不是几万条');
const szSpan = rSz.list[0].year - rSz.list[rSz.list.length - 1].year;
assertEqual(szSpan > 500, true, '四柱反查：候选横跨 ' + szSpan + ' 年（同一组八字每 60 年重现一轮）');
let szDesc = true;
for (let i = 1; i < rSz.list.length; i++) {
  if (rSz.list[i].year > rSz.list[i - 1].year) szDesc = false;
}
assertEqual(szDesc, true, '四柱反查：按年份由近及远（' + rSz.list[0].dateText + ' 开头）');

/* --- 无解与非法输入 --- */
const rBad = szLib.search({ year: '庚午', month: '戊寅', day: '庚子', hour: '甲子' });
assertEqual(rBad.ok + ',' + rBad.reason, 'false,nomatch',
  '四柱反查：庚子日配甲子时 → 五鼠遁直接判无解，不报「程序坏了」');
const rIll = szLib.search({ year: '甲丑', month: '戊寅', day: '庚子', hour: '丙子' });
assertEqual(rIll.ok + ',' + rIll.reason, 'false,invalid', '四柱反查：甲丑 不在 60 甲子里 → invalid');

/* --- 子时：早子与晚子是两个不同的出生日期 --- */
const SZ_ZI = { year: '庚午', month: '戊寅', day: '庚子', hour: '丙子' };
const rZi = szLib.search(SZ_ZI);
const ziLate = rZi.list.filter(function (it) { return it.lateZi; });
const ziEarly = rZi.list.filter(function (it) { return !it.lateZi; });
assertEqual(ziLate.length > 0 && ziEarly.length > 0, true,
  '四柱反查 子时：早子（00:00-01:00）与晚子（23:00-24:00）各有一批候选');
assertEqual(at(ziLate[0], 'pickTime'), '23:30', '四柱反查 晚子时：回填落在 23:00-24:00');
assertEqual(at(ziLate[0], 'zhiText'), '晚子时', '四柱反查 晚子时：文案与早子区分开');
assertEqual(at(ziLate[0], 'timeText'), '23:00-01:00', '四柱反查 子时：标称区间是跨日的 23:00-01:00');
assertEqual(at(ziEarly[0], 'pickTime'), '00:30', '四柱反查 早子时：回填落在 00:00-01:00');
assertEqual(at(ziEarly[0], 'zhiText'), '子时', '四柱反查 早子时：就叫「子时」');
assertEqual(szChars(ziLate[0]), szText(SZ_ZI),
  '四柱反查 晚子时：' + ziLate[0].pickDate + ' 23:30 排出来正是输入的八字（日柱按次日算）');
assertEqual(szChars(ziEarly[0]), szText(SZ_ZI),
  '四柱反查 早子时：' + ziEarly[0].pickDate + ' 00:30 排出来也一致');

/* --- 交节当天：同一个时辰会被「节」切成两半，给的是实测出来的那一段 ---
   1900 年立春 02-04 13:52 交节 —— 13:00-15:00 这个未时只有 13:52 之后才属戊寅月，
   13:00-13:51 还算上一月（丁丑）。候选项必须把这一点如实标出来。 */
const SZ_JQ = { year: '庚子', month: '戊寅', day: '戊申', hour: '己未' };
const rJq = szLib.search(SZ_JQ);
const jqNarrow = rJq.list.filter(function (it) { return it.narrow; });
const jqSeg = (jqNarrow[0] && jqNarrow[0].spanText || '').split('-');

assertEqual(rJq.ok, true, '四柱反查 交节：交节当天那个时辰的八字查得到');
assertEqual(jqNarrow.length, 1, '四柱反查 交节：只有交节当天那一条被标成 narrow');
assertEqual(at(jqNarrow[0], 'dateText'), '1900-02-04', '四柱反查 交节：就是 1900 立春当天');
assertEqual(at(jqNarrow[0], 'timeText'), '13:00-15:00', '四柱反查 交节：标称区间仍是整个未时');
assertEqual(jqSeg[0] > '13:00' && jqSeg[0] < '15:00', true,
  '四柱反查 交节：实际起点被收窄到交节时刻之后（实际 ' + (jqNarrow[0] || {}).spanText + '）');
assertEqual(jqSeg[1], '15:00', '四柱反查 交节：实际终点仍是这个时辰的末了');
assertEqual(szChars({ pickDate: '1900-02-04', pickTime: jqSeg[0] }), szText(SZ_JQ),
  '四柱反查 交节：实际区间**起点那一刻**排出来正是输入的四柱');
assertEqual(szChars({ pickDate: '1900-02-04', pickTime: '13:00' }), '己亥 丁丑 戊申 己未',
  '四柱反查 交节：同一个未时里 13:00 还是**上一年、上一月**（立春同时换年柱和月柱）' +
  '—— 所以不能说「这个未时都对」');

/* --- ★★ 2026-10-22 用户报障回归：交节当天的**前一段**曾整段查不到 ---
 * 原话：「录入四柱 戊戌 辛酉 己未 乙丑，没有出现 1958-10-09」。
 * 根因（不是算错，是**没扫到那一天**）：tyme 的 `SixtyCycleMonth.getDays()` 按**整日**
 *   归属 —— 1958 寒露 10-09 **03:20** 交节，于是 10-09 整天被划进**壬戌**月；
 *   可 10-09 的 00:00-03:19 仍是**辛酉**月。
 *   只扫「辛酉月的 days」时这一天根本不在列表里；扫壬戌月时又因为月柱名不等于输入而被跳过。
 * ⇒ 修法：每个干支月额外把「下一个月的首日」也扫一遍（见 sizhu.js 的 collect）。
 * ⚠ 这一组用例是**成对**的：一条验「交节之后那一段」，一条验「交节之前那一段」；
 *   只留一条的话，把修复方向反过来写照样能绿。 */
const SZ_NL = { year: '戊戌', month: '辛酉', day: '己未', hour: '乙丑' };
const rNl = szLib.search(SZ_NL);
const nl = rNl.list.filter(function (it) { return it.dateText === '1958-10-09'; });
assertEqual(nl.length, 1,
  '四柱反查 交节（报障用例）：戊戌 辛酉 己未 乙丑 必须查得到 1958-10-09（寒露 03:20 交节，丑时仍是辛酉月）');
assertEqual(nl[0] ? szChars(nl[0]) : '', szText(SZ_NL),
  '  └ 那条回填时刻拿去排盘，四柱正是输入的八字');
assertEqual(nl[0] ? nl[0].pickTime : '', '02:00', '  └ 回填落在丑时中点 02:00');
assertEqual(nl[0] ? nl[0].narrow : true, false,
  '  └ 丑时（01:00-03:00）整段都在交节之前 ⇒ 不该标 narrow');

/* 同一天 03:00-03:19 是「辛酉月 + 丙寅时」—— 只有 20 分钟，也必须查得到 */
const SZ_NL2 = { year: '戊戌', month: '辛酉', day: '己未', hour: '丙寅' };
const nl2 = szLib.search(SZ_NL2).list.filter(function (it) { return it.dateText === '1958-10-09'; })[0];
assertEqual(!!nl2, true, '四柱反查 交节（报障用例）：1958-10-09 的丙寅时（仅 03:00-03:19 属辛酉月）也查得到');
assertEqual(nl2 ? nl2.narrow : false, true, '  └ 并被标成 narrow（实际区间被交节收窄）');
assertEqual(nl2 ? nl2.spanText : '', '03:00-03:20', '  └ 实际区间止于交节那一刻 03:20');
assertEqual(nl2 ? szChars(nl2) : '', szText(SZ_NL2), '  └ 回填时刻排出来一致');

/* 对称的另一半：1900 立春 13:52 之前那一段属**上一年上一月**（己亥 丁丑 戊申 己未） */
const SZ_JQ_PRE = { year: '己亥', month: '丁丑', day: '戊申', hour: '己未' };
const pre = szLib.search(SZ_JQ_PRE).list.filter(function (it) { return it.dateText === '1900-02-04'; })[0];
assertEqual(!!pre, true,
  '四柱反查 交节：立春**前**那一段（1900-02-04 13:00-13:52，上一年上一月）也查得到');
assertEqual(pre ? pre.spanText : '', '13:00-13:52', '  └ 实际区间止于立春那一刻 13:52');
assertEqual(pre ? szChars(pre) : '', szText(SZ_JQ_PRE), '  └ 回填时刻排出来一致');

/* 闭环：这一组候选（含刚修好的交节边界那两天）回填后逐条真排盘，四柱都要与输入一致。
   ⚠ 这条比「数量对不对」有用：边界候选的 pickTime 一旦落错（比如取到交节另一侧），
     这里会当场红。 */
assertEqual(
  rNl.list.filter(function (it) { return szChars(it) !== szText(SZ_NL); })
    .map(function (it) { return it.dateText + ' ' + it.pickTime; }),
  [],
  '四柱反查 交节（报障用例）：' + rNl.list.length + ' 条候选的回填值逐条排盘，四柱全都与输入一致'
);

/* ---------- 汇总 ---------- */
console.log('');
if (failed) {
  console.error(failed + ' 个用例失败');
  process.exit(1);
} else {
  console.log('全部通过');
}
