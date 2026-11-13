/**
 * 平气法排盘自检
 *
 * ★ 2026-10-18 用户：「这是平气法的排八字的四柱和大运流年流月的算法。平气法就用这个来排盘。
 *   排出来的 UI 要和定气法的一样。」
 *
 * 这个脚本守两件事：
 *   ① **算得对**：四柱 / 司令 / 胎元 / 交运 / 大运 与用户提供的来源实现（pingqi_bazi.js）逐例对拍；
 *   ② **长得一样**：平气法与定气法产出的**形状**必须同构 —— 同样的字段、同样长度的表、
 *      同样的岁数基准。少一个字段 tsc 看不见（都是 any），只有这里能拦住。
 *
 * 跑法：node tests/pingqi-check.js
 */
globalThis.window = globalThis;

const path = require('path');
const root = path.join(__dirname, '..');
const pingqiLib = require(path.join(root, 'src/core/pingqi-bazi.js'));
const model = require(path.join(root, 'src/components/chart-view/model.js'));
const recordLib = require(path.join(root, 'src/core/record.js'));

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + label); }
}
function eq(a, b, label) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) { pass++; }
  else { fail++; console.log('FAIL  ' + label + '  期望 ' + y + '，实际 ' + x); }
}

/* ============ 1. 与来源实现逐例对拍 ============ */
// ⚠ 用户提供的原文件不在本仓库里（在另一个工作目录）。
//   有就读来对拍；没有就跳过这一段 —— 跳过时**必须显式打印**，否则「没跑」会被当成「过了」。
const SRC = 'D:/aiProjecct/workbuddyApp/2026-10-17-20-51-21/pingqi/pingqi_bazi.js';
let src = null;
try { src = require(SRC); } catch (e) { /* 换机就没有，下面会打印 */ }

if (src) {
  let n = 0;
  let bad = 0;
  for (let y = 1900; y <= 2030; y += 7) {
    for (let m = 1; m <= 12; m++) {
      for (const d of [3, 15, 27]) {
        const t = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') + 'T12:00';
        const mine = pingqiLib.paipan(y, m, d, 12, 0);
        const theirs = src.pillarFor(t, 'pingqi');
        n++;
        if (!mine || !theirs) {
          if (!!mine !== !!theirs) bad++;
          continue;
        }
        const a = mine.fourChars.join('');
        const b = [theirs.year, theirs.month, theirs.day, theirs.hour].join('');
        if (a !== b) {
          bad++;
          if (bad <= 5) console.log('      不一致 ' + t + '：本实现 ' + a + ' / 来源 ' + b);
        }
      }
    }
  }
  eq(bad, 0, '⚠ 四柱与来源实现逐例一致（' + n + ' 例）');
} else {
  console.log('  ℹ 跳过与来源实现对拍（找不到 ' + SRC + '）');
}

/* ============ 1.5 流年虚岁口径 + 大运/流年逐条对拍 ============ */
/*
 * ⚠⚠⚠ 2026-10-29 来源实现改了口径：流年虚岁从「公历年 − 出生公历年 + 1」
 *   改成「该干支年 − 出生**干支年** + 1」，与童限 / 大运同源。
 *   差别只在**立春前出生**的人：整列虚岁旧版小 1 岁（2014-01-25 生 → 2013 年虚岁 1，旧版给 0）。
 *   这里既断言数值，也在有来源文件时逐条对拍（对拍才拦得住「又改回去」）。
 */
{
  const pre = pingqiLib.daYun(2014, 1, 25, 8, 0, 1);   // 立春 2014-02-04 之前
  const ln0 = pre.steps[0].liuNian;
  eq(ln0[0].year, 2013, '立春前出生：童限首年 = 出生干支年 2013（不是公历 2014）');
  eq(ln0[0].age, 1, '⚠ 立春前出生：出生那一年虚岁 1（旧版口径给 0）');
  eq(ln0[0].partNote, '出生后', '  └ 「出生后」标在干支年那一格');
  eq(ln0[1].age, 2, '  └ 下一干支年虚岁 2（整列跟着干支年走）');
  const after = pingqiLib.daYun(1958, 10, 9, 2, 0, 1);  // 立春后出生：两种口径本就相同
  eq([after.steps[0].liuNian[0].year, after.steps[0].liuNian[0].age], [1958, 1],
    '立春后出生：虚岁 1 落在出生当年（口径变化不影响这一档）');
}

if (src) {
  // 样本刻意含 1 月 / 2 月初（立春前）与常规月份，两边都要逐条对得上
  const cases = [
    [2014, 1, 25, 8], [1982, 1, 24, 5], [2006, 12, 10, 8], [1958, 10, 9, 2],
    [1900, 2, 4, 13], [1931, 2, 3, 0], [1990, 2, 5, 12], [2020, 1, 20, 23],
    [1975, 6, 15, 18], [1640, 3, 8, 9], [2299, 12, 30, 22], [1601, 1, 2, 4],
  ];
  let n = 0, bad = 0, first = '';
  for (const [y, m, d, h] of cases) {
    const t = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
      + 'T' + String(h).padStart(2, '0') + ':00';
    for (const g of [0, 1]) {
      const A = src.daYun(t, g === 1 ? 'male' : 'female', 'pingqi');   // 来源
      const B = pingqiLib.daYun(y, m, d, h, 0, g);                     // 本实现
      if (!A || !B) { if (!!A !== !!B) bad++; continue; }
      if (A.steps.length !== B.steps.length) { bad++; continue; }
      for (let i = 0; i < A.steps.length; i++) {
        const sa = A.steps[i], sb = B.steps[i];
        if (String(sa.ganzhi) !== String(sb.ganzhi)
          || String(sa.startAt) !== String(sb.startAt)
          || String(sa.endAt) !== String(sb.endAt)) {
          bad++;
          if (!first) first = t + ' 第' + i + '步 步界/干支 不一致';
        }
        const la = sa.liuNian || [], lb = sb.liuNian || [];
        if (la.length !== lb.length) {
          bad++;
          if (!first) first = t + ' 第' + i + '步 流年条数 ' + la.length + '/' + lb.length;
          continue;
        }
        for (let j = 0; j < la.length; j++) {
          n++;
          const keys = ['year', 'ganzhi', 'age', 'part', 'partNote', 'isSplitYear'];
          const miss = keys.filter(function (k) { return String(la[j][k]) !== String(lb[j][k]); });
          if (miss.length) {
            bad++;
            if (!first) first = t + ' 第' + i + '步 ' + la[j].year + ' 年 ' + miss.join('/')
              + '：来源 ' + la[j][miss[0]] + ' / 本实现 ' + lb[j][miss[0]];
          }
        }
      }
    }
  }
  if (first) console.log('      ' + first);
  eq(bad, 0, '⚠⚠ 大运 / 流年与来源实现逐条一致（' + cases.length + ' 例 × 2 性别，' + n + ' 个流年）');
}

/* ============ 2. 平气 vs 定气：该不一样的必须不一样 ============ */
{
  // 1958-10-08：寒露在平气表里比真黄经早一天多 ⇒ 月柱从辛酉变壬戌
  const pq = pingqiLib.paipan(1958, 10, 8, 12, 0);
  eq([pq.pillars.year.name, pq.pillars.month.name], ['戊戌', '壬戌'], '平气 1958-10-08：戊戌 壬戌');
  // 1990-02-05：平气立春还没到（平气立春 02-05 21:05），定气立春 02-04 已过 ⇒ 整年整月都差一柱
  const pq2 = pingqiLib.paipan(1990, 2, 5, 12, 0);
  eq([pq2.pillars.year.name, pq2.pillars.month.name], ['己巳', '丁丑'], '⚠ 平气 1990-02-05 12:00 仍在己巳年丁丑月（平气立春 21:05）');

  // 不该变的：日柱 / 时柱与口径无关（同一份 chart.js 出的）
  const rec = recordLib.create('测试', 1, '1958-10-08', '12:00');
  const ding = model.buildChartData(rec, 2026, 'dingqi');
  const ping = model.buildChartData(rec, 2026, 'pingqi');
  eq(ping.pillars[2].stem + ping.pillars[2].branch, ding.pillars[2].stem + ding.pillars[2].branch, '日柱与口径无关');
  eq(ping.pillars[3].stem + ping.pillars[3].branch, ding.pillars[3].stem + ding.pillars[3].branch, '时柱与口径无关');
  ok(ping.fourChars ? ping.fourChars[1] !== ding.fourChars[1] : ping.pillars[1].stem + ping.pillars[1].branch !== ding.pillars[1].stem + ding.pillars[1].branch,
    '⚠ 这一盘（1958-10-08）的月柱两套口径确实不同（否则「对拍一致」是假的）');
}

/* ============ 3. 形状同构：UI 才能一模一样 ============ */
{
  const rec = recordLib.create('测试', 1, '1990-01-01', '11:04');
  const ding = model.buildChartData(rec, 2026, 'dingqi');
  const ping = model.buildChartData(rec, 2026, 'pingqi');
  ok(ding.ready === true && ping.ready === true, '两套口径都 ready');

  // 四柱每柱的字段集合必须完全一致（视图按这些字段画行）
  /*
   * ⚠ 键名是 buildChartData 加工后的（不是 chart.js 原始柱对象）：干支在 stem / branch 上，
   *   四字整体在 fourChars 里。按「视图真正要读的字段」列，别按引擎原样列。
   */
  const KEYS = ['stem', 'branch', 'element', 'shiShen', 'nayin', 'xingYun', 'ziZuo', 'kongWang', 'canggan', 'stemCls', 'branchCls', 'label', 'isDay'];
  ding.pillars.forEach(function (p, i) {
    KEYS.forEach(function (k) {
      ok(ping.pillars[i][k] !== undefined, '.pillars[' + i + '] 平气法也有 ' + k + ' 字段');
    });
  });

  // 大运：同样 13 列（1 列小运 + 12 步），字段名逐字一致
  eq(ping.dayuns.length, ding.dayuns.length, '大运列数一致（首列小运 + 12 步）');
  eq(ping.dayuns[0].gz, '小运', '首列是「小运」');
  eq(ping.dayuns[1].gz, '乙亥', '第一步大运 乙亥');
  eq(ping.dayuns[1].year, 1998, '第一步起始年 1998');
  /*
   * ⚠⚠ 岁数基准必须与定气法一致：定气法的 startAge = starYear - 出生立春年 + 2。
   *   这是原引擎的口径，不是「标准虚岁」；两边不一致 ⇒ 大运整列的岁数错开，
   *   用户看到的「UI 一样」就破了。
   */
  /*
   * ⚠ 21:05 版把虚岁基准改成**干支年**（立春分年）—— 1990-01-01 生时年柱还是己巳（1989），
   *   所以基数 = 1989，起运 1998 ⇒ 10/20/30，与定气法同值（那边取农历年，恰好也是 1989）。
   */
  eq(ping.dayuns.slice(1, 4).map(function (d) { return d.age; }), [10, 20, 30], '大运虚岁按干支年（21:05 版口径）');
  eq(ping.dayuns.map(function (d) { return d.key; }), ding.dayuns.map(function (d) { return d.key; }),
    '大运 key 一致（事件记录的 key 靠它）');

  // 流年 / 流月表：格数一致、字段一致
  /*
   * 流年：新版算法自带区间裁剪与换运切割断言（见下面「交运年切割」一段）。
   * ⚠ 这里**不再**逐格比对定气法：两边虚岁基准不同（定气法农历年、平气法公历年），
   *   且平气法首年可能因切割被整年剔除 —— 拿它当基准会掩盖真问题。
   *   改为断言平气法流年**自身闭合**：年份连续递增、干支与年份对得上、每格都有流月。
   */
  for (const idx of [0, 1, 3, 12]) {
    const p = model.computeDayunRows(rec, ping.dayuns, idx, 2026, 'pingqi');
    ok(p.rows.length >= 1, '第 ' + idx + ' 步有流年');
    const yrs = p.rows.map(function (r) { return r.year; });
    const sorted = yrs.slice().sort(function (a, b) { return a - b; });
    eq(yrs, sorted, '  └ 第 ' + idx + ' 步年份递增');
    const gzOk = p.rows.every(function (r) { return /^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/.test(r.yearGanZhi); });
    ok(gzOk, '  └ 第 ' + idx + ' 步每格都有流年干支');
    const monOk = p.rows.every(function (r) { return r.months.length >= 1; });
    ok(monOk, '  └ 第 ' + idx + ' 步每格都有流月（切割后不为空）');
  }

  /*
   * 流月：**整年**的 12 格，干支按平气节排（寅月起）。
   * ⚠⚠ 2026-10-18 新算法：换运那年会被切割（新步首年只剩换运月之后）。
   *   所以这里取「全年」那一格验 12 节，另起一段专验切割年 ——
   *   拿 rows[0] 验 12 格是旧口径的断言，新算法下它只有 8 格（芒种起）。
   */
  const p3 = model.computeDayunRows(rec, ping.dayuns, 3, 2026, 'pingqi');
  const fullRow = p3.rows.filter(function (r) { return r.part === '全年'; })[0] || p3.rows[1];
  const ly = model.buildLiuyues(fullRow);
  eq(ly.length, 12, '整年流月 12 格');
  eq(ly.map(function (x) { return x.jieQi; }),
    ['立春', '惊蛰', '清明', '立夏', '芒种', '小暑', '立秋', '白露', '寒露', '立冬', '大雪', '小寒'],
    '流月按十二节（寅月起）');
  ok(/^\d+\/\d+$/.test(ly[0].date), '流月第二行是「月/日」（不是空）');
  ok(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/.test(ly[0].gz), '流月第三行是干支');

  /* ---- 交运年切割（新版算法核心）---- */
  {
    const idx = 3;
    const split = p3.rows.filter(function (r) { return r.isSplitYear; });
    ok(split.length >= 1, '⚠ 这一步存在交运年（否则切割断言是空的）');
    const first = p3.rows[0];
    eq(first.part, '之后', '首年 = 换运「之后」（只有后半）');
    ok(first.months.length < 12, '  └ 首年流月不足 12 格（换运月之前的被切掉）');
    const cutM = first.months.filter(function (m) { return !!m.cut; });
    eq(cutM.length, 1, '  └ 恰好一个月标了交运');
    /*
     * 文案方向：**站在本步的角度**说占哪一半。
     * 新步从换运时刻起算 ⇒ 它的第一个月是本步占**后半**（2026-10-18 18:30 版口径；
     * 上一版反过来写成「上一步占前半」，那是站在上一步的角度）。
     */
    ok(/本步占后半/.test(cutM[0].cut), '  └ 新步的首月标「交运月：本步占后半」');
    eq(cutM[0].cutHalf, 'after', '  └ cutHalf = after');

    // 上一步的同一年：标注是反向的
    const prev = model.computeDayunRows(rec, ping.dayuns, idx - 1, 2026, 'pingqi');
    const lastRow = prev.rows[prev.rows.length - 1];
    eq(lastRow.part, '之前', '上一步末年是「之前」（只有前半）');
    const pc = lastRow.months.filter(function (m) { return !!m.cut; });
    eq(pc.length, 1, '  └ 上一步末年也恰好一个月标了交运');
    ok(/本步占前半/.test(pc[0].cut), '  └ 上一步末年标「交运月：本步占前半」');
    eq(pc[0].cutHalf, 'before', '  └ cutHalf = before');
    ok(/前止/.test(lastRow.partNote), '  └ 末年 partNote 是「MM月DD日前止」');
    ok(/后起/.test(first.partNote), '  └ 新步首年 partNote 是「MM月DD日后起」');
  }

  /*
   * ⚠⚠ 交运落在 1 月（立春前）：那一格只剩「丑月」—— 而丑月挂在**上一公历年**的节气表尾。
   *   算法必须多扫前一年，否则这一格整月丢失、流年直接少一格（而且不报错）。
   *   1983-04-10 男：交运 1984-01-13 ⇒ 童限末年 1983 只剩丑月 1 个。
   */
  {
    const r83 = recordLib.create('测试', 1, '1983-04-10', '08:00');
    const b83 = model.buildChartData(r83, 2026, 'pingqi');
    const tong = b83.bazi && b83.bazi.dayuns ? null : null;   // 只取页面用的行
    const p0 = model.computeDayunRows(r83, b83.dayuns, 0, 2026, 'pingqi');
    eq(p0.rows.length, 1, '⚠ 1 月交运：童限只剩 1 格流年');
    eq(p0.rows[0].months.length, 10, '  └ 且这一格是「出生后」的 10 个月（不小于 1）');
    const p1 = model.computeDayunRows(r83, b83.dayuns, 1, 2026, 'pingqi');
    const firstRow = p1.rows.filter(function (r) { return r.part === '之后'; })[0];
    ok(!!firstRow, '  └ 第 1 步有「之后」的分割年');
    eq(firstRow.months.length, 1, '  └ 那一格只剩丑月 1 个月（丑月挂在上一年的表尾，必须多扫一年才取得到）');
    eq(firstRow.months[0].JieQi, '小寒', '  └ 且是「小寒」（丑月起于小寒）');
    ok(/本步占后半/.test(firstRow.months[0].cut || ''), '  └ 标了「交运月：本步占后半」');
  }

  // 司令 / 胎元 / 交运 都有值（视图那边显示「—」就说明这一段没接上）
  ok(/-?\d/.test(ping.siLingText), '司令文案有数字');
  ok(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/.test(ping.taiYuanText), '胎元是两字干支');
  ok(ping.jiaoYunText !== '—' && ping.jiaoYunText.length > 0, '交运文案非空');
}

/* ============ 3.5 21:05 版：换运月日浮动 / 越界补算 ============ */
{
  /*
   * ★★ 这一版最核心的改动：**每步换运时刻按「同一节气 + 同一偏移天数」重算**，
   *   而不是「年份 + 10、月日不变」。
   *   2006-12-10 08:00 男：交运 = 大雪后 30.02 天（离小寒 0.42 天）
   *   ⇒ 第 2 步终点 = 2027-01-06 00:04，第 3 步 = 2037-01-05 10:32 —— 月日会 01-05/01-06 浮动。
   */
  const jy = pingqiLib.jiaoYun(2006, 12, 10, 8, 0, 1);
  eq(jy.startAt, '2016-01-06 08:00', '2006 例：交运 2016-01-06 08:00');
  eq(jy.startJie, '大雪', '  └ 交运所依之节 = 大雪');
  ok(Math.abs(jy.startDaysSinceJie - 30.02) < 0.02, '  └ 该节之后 30.02 天');
  ok(/大雪后 30\.02 天/.test(jy.startJiePosition || ''), '  └ 节气位置文案对');

  const d6 = pingqiLib.daYun(2006, 12, 10, 8, 0, 1);
  /*
   * ★★ 00:37 版新增 anchorShift（交运锚年偏移）：交运 = 「大雪后 30.02 天」，
   *   锚节大雪在 **2015**-12（startYear=2016 的上一年）⇒ 各步按 2015+10n 年的大雪重算：
   *   第 1 步终点 2026-01-05 18:22、第 2 步 2036-01-06 04:35 —— 月日仍逐年浮动。
   *   旧版（21:05）没修锚年，每步整体晚 1 年，已废弃。
   */
  eq(d6.steps[1].endAt, '2026-01-05 18:22', '第 1 步终点按「锚年大雪 + 偏移」重算（锚年 = 2015）');
  eq(d6.steps[2].endAt, '2036-01-06 04:35', '第 2 步终点落在 01-06（月日两年不同）');
  ok(d6.steps[1].cutMD !== d6.steps[2].cutMD, '⚠ 各步 cutMD 不再恒定（01月05日 vs 01月06日）');
  eq(d6.cutMD, '01月06日', '顶层 cutMD = 首次交运的月日');
  eq(d6.steps[2].yearFrom, 2025, '第 2 步起点落在 2025（干支年，锚年偏移后比交运年小 1）');

  // 越界年份：2250 已超出旧表（2200），新表可算；2400 也应在范围内
  ok(pingqiLib.termAt(2300, '立春') > 0, '2300 年立春取得到（越界按回归年平移）');
  ok(pingqiLib.termAt(2400, '立春') > 0, '2400 年立春取得到（新表内）');
  ok(pingqiLib.daYun(1980, 6, 1, 12, 0, 1).steps.length === 13, '13 步大运（2220 年前后）仍能算全');

  /*
   * ★★ 切割年的「归属格」两种形态（抽样本时各挑了一盘，别嫌冗余）：
   *   A. 起点在立春前（1900-02-02 男，起运 1909-01-21，立春 02-06）
   *      ⇒ 那一格**归上一年**（1908 戊申），`part='之后'`，只剩丑月 1 个月。
   *      这是「起点扫前一年」分支唯一能验证到的形态，去掉 firstY 就整格消失。
   *   B. 起点在立春后很久（1924-01-01 男，起运 1932-03-03，立春后 25.70 天）
   *      ⇒ **寅月本身**跨过起点，算「本步占后半」，整年仍是 12 个月；
   *      起点落在月内不会被丢，只有「整月都在起点之前」才会丢（A 盘丢的是子月）。
   *      两盘合起来证明 `part` 取自**实际切割标记**，不是「首年必之后」的硬判定。
   */
  const rA = pingqiLib.daYun(1900, 2, 2, 12, 0, 1).steps[1];
  const cellA = rA.liuNian.filter(function (x) { return x.part === '之后'; })[0];
  ok(!!cellA, 'A. 起点在立春前：有「之后」格');
  eq(cellA && cellA.year, 1908, '  └ 且它归上一公历年（1908 戊申）');
  eq(cellA && cellA.liuYue.length, 1, '  └ 只剩丑月 1 个月（子月整月在前，丢了）');
  eq(cellA && cellA.liuYue[0].year, 1909, '  └ 丑月挂在 1909 表头（小寒）');

  const rB = pingqiLib.daYun(1924, 1, 1, 12, 0, 1).steps[1];
  const cellB = rB.liuNian.filter(function (x) { return x.part === '之后'; })[0];
  ok(!!cellB, 'B. 起点在立春后 25 天：仍有「之后」格');
  eq(cellB && cellB.year, 1932, '  └ 归当年（1932 壬申）');
  eq(cellB && cellB.liuYue.length, 12, '  └ 起点落在月内不丢月，仍是 12 个月');
  eq(cellB && cellB.liuYue[0].zhi, '寅', '  └ 第一格仍是寅月（本月被切一半，不丢）');
  ok(cellB && cellB.liuYue[0].cut, '  └ 且带「本步占后半」');
}

/* ============ 4. 边界与降级 ============ */
{
  // 超出节气表范围（1600–2200）⇒ 明确算不出来，而不是崩或者给个错盘
  /*
   * ★ 21:05 版把节气表从 1600–2200 扩到 **1599–2441**，且越界年份会按回归年平移推算。
   *   所以 2300 现在**算得出来**（不再 null）；1500 仍超出，仍旧 null。
   */
  ok(pingqiLib.paipan(1500, 1, 1, 12, 0) === null, '1500 年超出表范围 → null');
  ok(pingqiLib.paipan(2300, 1, 1, 12, 0) !== null, '2300 年在新表范围内（1599–2441）→ 算得出');
  ok(pingqiLib.paipan(2100, 1, 1, 12, 0) !== null, '2100 年也能算（旧表 2200 上限内）');
  const rec = recordLib.create('测试', 1, '1990-01-01', '11:04');
  rec.dateText = '1500-01-01';
  const bad = model.buildChartData(rec, 2026, 'pingqi');
  eq(bad.ready, false, '⚠ 平气法算不出来时 ready = false（视图据此显示空态）');
  eq(bad.pingqiFailed, true, '  └ 且标记 pingqiFailed（区别于「还没排盘」）');

  // 平气节是等分的：相邻两节间隔应都在 30 天上下（这是「平气」的定义性特征）
  const a = pingqiLib.termAt(1990, '立春');
  const b = pingqiLib.termAt(1990, '惊蛰');
  const days = (b - a) / 86400000;
  ok(days > 29 && days < 32, '平气立春→惊蛰 ≈ 30 天（实际 ' + days.toFixed(2) + '）');
}

/* ============ 5. 平气法页 = 抄定气法的 UI；定气法页不许被动 ============ */
/*
 * ★ 用户 2026-10-18（最终口径）：「你做平气法的内容吧，ui 就抄定气法的。
 *   定气法页面的任何代码你都不要改动。平气法算法就用 …\pingqi」
 *
 * 三条要守的：
 *   ① 平气法是**整份盘面**（不是空壳）—— 行式表格骨架一项不能少；
 *   ② 平气法页**单向依赖**：它 import 定气法页可以，定气法页 import 它**不行**；
 *   ③ ChartView 里定气法那一块的 props 必须还是原来那几个（数据源不许被换）。
 */
{
  const fs = require('fs');
  const dir = path.join(root, 'src', 'components', 'chart-view');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const ding = strip(fs.readFileSync(path.join(dir, 'QiDingPage.tsx'), 'utf8'));
  const ping = strip(fs.readFileSync(path.join(dir, 'QiPingPage.tsx'), 'utf8'));
  const chartView = strip(fs.readFileSync(path.join(dir, 'ChartView.tsx'), 'utf8'));

  /* ① 平气法页必须画完整盘面（抄定气法的骨架，一项都不能少） */
  const SKELETON = [
    [/pillarRows\.map\(/, '四柱逐行渲染'],
    [/renderCell\(row\.key, cell, i\)/, 'cell 逐格渲染'],
    [/i === PILLAR_COUNT \? <View style=\{styles\.blockDivider\} \/> : null/, '四柱 | 运限 一条分隔线'],
    [/i < PILLAR_COUNT \? styles\.cellPillar : styles\.cellCard/, 'cell 宽度按位置分流'],
    [/'canggan'/, '藏干格'],
    [/'shensha'/, '神煞格'],
    [/label="大运"/, '大运表'],
    [/label="流年"/, '流年表'],
    [/label="流月"/, '流月表'],
    [/state\.siLingText/, '司令'],
    [/state\.taiYuanText/, '胎元'],
    [/state\.jiaoYunText/, '交运'],
    [/export function makeStyles/, '自带样式表'],
  ];
  for (const [re, name] of SKELETON) {
    ok(re.test(ping), '平气法页有：' + name);
  }
  ok(/shaWrap:\s*\{[^}]*flexDirection:\s*'column'/.test(ping),
    '  └ 神煞竖排（用户「不要两个并列」）');
  ok(/state\.pingqiFailed/.test(ping), '  └ 超表范围时的空态分支（平气法专有）');

  /* ② 单向依赖：平气法抄定气法可以，反过来不行 */
  ok(!/from\s+'\.\/QiPingPage'/.test(ding),
    '⚠⚠⚠ 定气法页**不 import** 平气法页（用户：定气法任何代码都不要动）');

  /* ③ ChartView 里定气法那一块的数据源不许被换 */
  ok(/<QiDingPage[\s\S]{0,200}?state=\{state\}/.test(chartView),
    '⚠⚠⚠ 定气法页仍吃 state（单份盘面），没被改成别的口径');
  ok(/<QiDingPage[\s\S]{0,400}?styles=\{ding\}/.test(chartView), '  └ 定气法页仍用 ding 样式表');
  ok(/<QiPingPage[\s\S]{0,200}?state=\{pingState\}/.test(chartView),
    '  平气法页吃自己那一份 pingState');
  ok(/M\.buildChartData\(record, nowYear\)/.test(chartView),
    '⚠ 定气法仍走默认口径（不传 mode）');
  ok(/M\.buildChartData\(record, nowYear, 'pingqi'\)/.test(chartView),
    '  平气法显式传 pingqi');

  /*
   * ⚠⚠⚠ 平气法的点击回调必须是**独立的一份**（用户 2026-10-18：「平气法的大运流年流月
   *   为什么不可以点击切换呢？」）。根因就是把定气法的 6 个回调直接递过去了 ——
   *   那些回调写死读 `state` / `ctxRef` / `rowsRef`，点下去改的是定气法。
   */
  ok(/onPingPickDayun/.test(chartView) && /onPingPickLiunian/.test(chartView)
    && /onPingPickLiuyue/.test(chartView), '⚠⚠ 平气法有自己的一套 onPick 回调');
  ok(/<QiPingPage[\s\S]{0,300}?onPickDayun=\{onPingPickDayun\}/.test(chartView),
    '⚠⚠⚠ 平气法页接的是 onPingPick*（不是定气法那套 —— 接了等于点了改别人）');
  ok(/<QiPingPage[\s\S]{0,300}?ctx=\{pingCtxRef\.current\}/.test(chartView),
    '⚠ 平气法用自己的 ctx（滚动锚点才对得上自家选中列）');
  ok(!/onPingPickDayun[\s\S]{0,200}?state\.dayuns/.test(chartView),
    '  └ 平气法回调不读定气法的 state');
}

console.log('\n' + (fail ? '✗ ' : '') + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
