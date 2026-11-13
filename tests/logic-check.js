/* 阶段 0 逻辑自检：不依赖 RN 运行时，只验证 App.tsx 里那套「取数据 → 排盘」的逻辑。
 *
 * 为什么单独写这个：
 *   真机/模拟器要先装 Expo 依赖，而「算法层搬过来能不能出正确结果」这件事
 *   其实不需要 UI 就能验完。先把这层验死，再上真机时就只剩样式问题。
 *
 * 跑法：node tests/logic-check.js
 */
globalThis.window = globalThis;

const chartLib = require('../src/core/chart.js');
const lunarLib = require('../src/core/lunar.js');
const timeLib = require('../src/core/time.js');

let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    console.log('PASS  ' + label + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
  } else {
    fail += 1;
    console.error('FAIL  ' + label + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''));
  }
}

console.log('=== 阶段 0 逻辑自检 ===\n');

/* ---------- 1. App.tsx 里用的取选项逻辑（与 toChips 同一套换算） ---------- */
/* ⚠ base 参数是必须的：年份标签第 0 项是 1000（= SOLAR_YEAR_MIN），
 *   索引不等于值。月/日/时/分的 base 是 0，所以可以省。
 *   （第一版就是漏了这个 base，年份算成 988 —— 被这条断言抓住的。） */
function toChips(labels, from, count, base) {
  const b = base || 0;
  return labels.slice(from, from + count).map(function (label, i) {
    return { label: label, value: from + i + b };
  });
}

const Y0 = timeLib.SOLAR_YEAR_MIN;
const years = toChips(timeLib.solarYearLabels(), 1990 - Y0 - 2, 9, Y0);
ok('年选项：值域正确（不是索引当值）', years.length === 9 && years.some(function (x) { return x.value === 1990; }),
  years.map(function (x) { return x.value; }));
ok('年选项：label 与 value 对得上',
  years.every(function (x) { return String(x.value) === x.label; }),
  years[0].label + '=' + years[0].value);

const months = toChips(timeLib.solarMonthLabels(), 0, 12);
ok('月选项：12 项，索引即值', months.length === 12 && months[0].value === 0 && months[11].value === 11,
  months.map(function (x) { return x.label; }).join(','));

const days = toChips(timeLib.solarDayLabels(1990, 1), 0, 31);
ok('日选项：1990-01 有 31 天', days.length === 31 && days[30].value === 30, days.length + ' 项');

const hours = toChips(timeLib.hourLabels(), 0, 24);
ok('时选项：24 项', hours.length === 24 && hours[23].value === 23, hours[23].label);

const minutes = toChips(timeLib.minuteLabels(), 0, 60);
ok('分选项：60 项', minutes.length === 60 && minutes[59].value === 59, minutes[59].label);

/* ---------- 2. 排盘：三个快捷按钮的期望值 ---------- */
const cases = [
  { y: 1990, m: 1, d: 1, h: 11, mi: 4, day: '丙寅', lunar: '一九八九年十二月初五' },
  { y: 2026, m: 9, d: 30, h: 23, mi: 30, day: '戊申', lunar: null },
  { y: 1949, m: 10, d: 1, h: 12, mi: 0, day: '甲子', lunar: null }
];

cases.forEach(function (c) {
  const ch = chartLib.paipan(c.y, c.m, c.d, c.h, c.mi);
  const label = c.y + '-' + c.m + '-' + c.d + ' ' + c.h + ':' + c.mi;
  ok('排盘 ' + label + ' 日柱 = ' + c.day, ch.pillars.day.name === c.day, ch.pillars.day.name);

  if (c.lunar) {
    ok('农历 ' + label, lunarLib.solarToLunar(c.y, c.m, c.d).text === c.lunar,
      lunarLib.solarToLunar(c.y, c.m, c.d).text);
  }
});

/* ---------- 3. App.tsx 渲染时真正读的字段必须存在 ---------- */
const sample = chartLib.paipan(1990, 1, 1, 11, 4);
['year', 'month', 'day', 'hour'].forEach(function (k) {
  const p = sample.pillars[k];
  ok('pillars.' + k + ' 有 stem/branch/name',
    typeof p.stem === 'string' && typeof p.branch === 'string' && typeof p.name === 'string',
    p.name + ' / ' + p.stem + p.branch);
});

ok('pillars.day 没有 heavenStem/earthBranch（App.tsx 别用错）',
  sample.pillars.day.heavenStem === undefined && sample.pillars.day.earthBranch === undefined);

/* ---------- 4. 切日期时结果真的跟着变 ---------- */
const a = chartLib.paipan(1990, 1, 1, 11, 4).pillars.day.name;
const b = chartLib.paipan(1990, 1, 2, 11, 4).pillars.day.name;
ok('换一天 → 日柱变化（证明响应式数据源是活的）', a !== b, a + ' → ' + b);

console.log('\n' + (fail ? '有 ' + fail + ' 项未通过' : '全部通过'));
process.exit(fail ? 1 : 0);
