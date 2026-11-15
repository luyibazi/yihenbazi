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

/* ---------- 5. 「同八字」检索（2026-11-15） ----------
 *
 * 这一节的判据只回答一件事：**发出去的条件是不是那八颗字**。
 * ⚠ 少发一个参数在服务端等于「这一类不过滤」—— 结果会从「同八字」悄悄变成
 *   「年月日相同、时辰随便」，界面上看起来"查到了更多"，实际一条都不对。
 *   所以下面的断言全部盯住「八键齐全 + 值与四柱逐字相同」。
 */
const pfLib = require('../src/core/pillarFilter.js');
const sameLib = require('../src/core/sameBazi.js');

const s4 = chartLib.paipan(1990, 1, 1, 11, 4);
/* ChartView 的 state.pillars 形状是 { stem, branch }，不是 engine 的 { name, stem, branch } */
const shaped = ['year', 'month', 'day', 'hour'].map(function (k) {
  return { stem: s4.pillars[k].stem, branch: s4.pillars[k].branch };
});

const q8 = sameLib.queryOf(shaped);
ok('四柱 → 八个筛选参数', q8 && Object.keys(q8).length === 8, JSON.stringify(q8));
ok('年干 = 年柱天干', q8 && q8.yearGan === s4.pillars.year.stem, q8 && q8.yearGan);
ok('时支 = 时柱地支', q8 && q8.hourZhi === s4.pillars.hour.branch, q8 && q8.hourZhi);
ok('参数名全部落在 pillarFilter.FILTER_CATS 里',
  q8 && Object.keys(q8).every(function (k) {
    return pfLib.FILTER_CATS.some(function (c) { return c.param === k; });
  }));
ok('四个干与四个支各自对应（不串位）',
  q8 && q8.monthGan === s4.pillars.month.stem && q8.dayZhi === s4.pillars.day.branch,
  q8 && [q8.monthGan, q8.dayZhi].join('/'));

ok('charsOf 给出四个干支用于展示',
  sameLib.charsOf(shaped).join(',') === ['year', 'month', 'day', 'hour']
    .map(function (k) { return s4.pillars[k].name; }).join(','),
  sameLib.charsOf(shaped).join(','));

/* ⚠ 缺一柱就必须拒绝 —— 绝不能「有几柱发几柱」（那是静默放宽） */
ok('只有三柱 → 返回 null', sameLib.queryOf(shaped.slice(0, 3)) === null);
ok('某一柱的干是空 → 返回 null', sameLib.queryOf([
  { stem: '甲', branch: '子' }, { stem: '', branch: '丑' },
  { stem: '丙', branch: '寅' }, { stem: '丁', branch: '卯' }
]) === null);

/* 空态：只有两组都成功且都是 0 才敢说「没有」 */
const okBoth = { ok: true, records: { ok: true, items: [], total: 0 }, bookmarks: { ok: true, items: [], total: 0 } };
ok('两边都空 → 说「没有相同的八字」', sameLib.emptyText(okBoth) === '这个账号下没有相同的八字', sameLib.emptyText(okBoth));
ok('有一组读失败 → 一个空态字都不说（不许把读失败说成没有）',
  sameLib.emptyText({ ok: true, records: { ok: false, items: [], total: 0 }, bookmarks: { ok: true, items: [], total: 0 } }) === '');
ok('有一条记录 → 不说空态',
  sameLib.emptyText({ ok: true, records: { ok: true, items: [{}], total: 1 }, bookmarks: { ok: true, items: [], total: 0 } }) === '');
ok('检索本身失败（四柱不全）→ 不说空态', sameLib.emptyText({ ok: false }) === '');

ok('countText 用服务端 total', sameLib.countText({ ok: true, total: 7 }, '条') === '7 条');
ok('countText 读不到时如实说', sameLib.countText({ ok: false }, '条') === '读不到');

/* find()：三组来源的返回姿势 */
sameLib._setSources({
  records: function () { return Promise.resolve({ ok: true, total: 2, records: [{ id: 'a' }, { id: 'b' }] }); },
  bookmarks: function () { return Promise.resolve({ ok: true, total: 0, items: [] }); }
});

sameLib.find(shaped).then(function (r) {
  ok('find 成功', r.ok === true);
  ok('记录两条、书签零条', r.records.items.length === 2 && r.bookmarks.items.length === 0);
  ok('total 用服务端给的值', r.records.total === 2);
  ok('query 随结果返回（调用方可核对发了什么）', r.query && r.query.yearGan === s4.pillars.year.stem);

  /* 一组失败：另一组的结果必须还在，失败那组带上原因 */
  sameLib._setSources({
    records: function () { return Promise.resolve({ ok: false, reason: 'no-login' }); },
    bookmarks: function () { return Promise.resolve({ ok: true, total: 3, items: [{}, {}, {}] }); }
  });
  return sameLib.find(shaped);
}).then(function (r) {
  ok('记录失败不影响书签结果', r.ok === true && r.bookmarks.items.length === 3);
  ok('失败那组翻成人话（未登录）', r.records.ok === false && r.records.error.indexOf('未登录') >= 0, r.records.error);
  ok('失败那组的 total 兜成 0，不是 undefined', r.records.total === 0, String(r.records.total));

  /* 四柱不全：一个请求都不许发 */
  let hits = 0;
  sameLib._setSources({
    records: function () { hits += 1; return Promise.resolve({}); },
    bookmarks: function () { hits += 1; return Promise.resolve({}); }
  });
  return sameLib.find(shaped.slice(0, 3)).then(function (bad) {
    ok('四柱不全 → ok:false 且一个请求都不发', bad.ok === false && hits === 0, 'hits=' + hits);
  });
}).then(function () {
  sameLib._setSources(null);
  finish();
}).catch(function (e) {
  ok('「同八字」异步段没崩', false, String((e && e.message) || e));
  sameLib._setSources(null);
  finish();
});

function finish() {
  console.log('\n' + (fail ? '有 ' + fail + ' 项未通过' : '全部通过'));
  process.exit(fail ? 1 : 0);
}
