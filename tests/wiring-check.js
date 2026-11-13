/**
 * 组件接线自检（阶段 1）
 *
 * ⚠ 目的：三个组件的**逻辑层调用序列**能在 Node 里跑通，不必启动模拟器。
 *   验的是「组件按这个顺序调 core，拿到的数据够不够画」这件事 ——
 *   这类错误（字段名写错、返回结构当数组用、相对路径不对）在模拟器里
 *   往往只表现为「某个地方空着」，很难定位。
 *
 * 覆盖：
 *   · DatePicker：view → pick → resolve 的完整五步
 *   · GzPicker：pillars → view → normalize → search → 候选
 *   · ChartView：buildChartData → 三级联动 → setTables
 *
 * 跑法：node tests/wiring-check.js
 */
globalThis.window = globalThis;

const path = require('path');
const base = path.join(__dirname, '..', 'src');

const dp = require(path.join(base, 'core', 'datepick.js'));
const gs = require(path.join(base, 'core', 'gzstep.js'));
const sizhu = require(path.join(base, 'core', 'sizhu.js'));
const chartLib = require(path.join(base, 'core', 'chart.js'));
const recordLib = require(path.join(base, 'core', 'record.js'));
const model = require(path.join(base, 'components', 'chart-view', 'model.js'));

let pass = 0;
let fail = 0;
const fails = [];

function ok(cond, label) {
  if (cond) pass++;
  else { fail++; fails.push(label); console.log('FAIL  ' + label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++; fails.push(label);
    console.log('FAIL  ' + label + '  期望 ' + e + '，实际 ' + a);
  }
}

/* ============================================================
 * 1. DatePicker 的调用序列（对应 DatePicker.tsx 里的 open / onPick / onConfirm）
 * ============================================================ */
{
  // —— open()：fromSolar → view('year')
  let state = dp.fromSolar('1990-01-01', '11:04', 'solar');
  ok(!!state, 'open: fromSolar 返回可用状态');

  let v = dp.view(state, 'year');
  eq(v.step, 'year', 'open 后停在第一步');
  eq(v.grid.cols, 4, '年格 4 列');
  ok(v.grid.items.length > 0, '年格有内容');
  ok(v.grid.seg != null, '年格带翻区信息（视图要靠它画翻区条）');
  eq(Object.keys(v.grid.seg).sort(), ['from', 'hasNext', 'hasPrev', 'index', 'label', 'pos', 'to', 'total'],
     'grid.seg 字段齐全（label/pos/hasPrev/hasNext 是视图直接用的）');
  eq(v.crumb.length, 5, '面包屑 5 步');
  ok(typeof v.preview.text === 'string' && v.preview.text.length > 0, 'preview.text 有值');

  // 视图要渲染的每个字段都真的存在（缺一个画面上就是空白）
  const item = v.grid.items[0];
  ok('v' in item && 'label' in item, '年格项有 v / label');

  // —— 五步走完：pick 链
  //
  // ⚠⚠ 「索引 ≠ 值」陷阱（本项目的老朋友，这次又踩了）：
  //   pick() 收的 `v` 是 **grid.items[].v** —— 对年格来说那是**标签数组的下标**，
  //   不是年份本身。`yearLabels()` 第 0 项是 SOLAR_YEAR_MIN(1000)，所以 1990 → v = 990。
  //   月/日/时/分 的第 0 项就是值 0，索引 == 值。
  //   第一版我按「年份字面值」传了 1990 → 解出 2050（被年表夹到末尾），静默算错。
  //   正确做法：**从 view 里取 item.v**，绝不自己算。
  const steps = ['year', 'month', 'day', 'hour', 'minute'];
  const labels = ['1990', '1月', '1日', '11时', '4分'];
  let done = false;
  for (let i = 0; i < steps.length; i++) {
    const grid = dp.view(state, steps[i]).grid;
    const target = grid.items.find((it) => it.label === labels[i]);
    ok(!!target, '在 ' + steps[i] + ' 步能按 label 找到「' + labels[i] + '」那一格');
    if (!target) break;

    const r = dp.pick(state, steps[i], target.v);
    state = r.state;
    if (r.done) { done = true; break; }
    eq(dp.view(state, r.step).step, steps[i + 1], 'pick 后自动进下一步：' + steps[i] + ' → ' + steps[i + 1]);
  }
  ok(done, '最后一步（分）返回 done = true → 组件据此触发 onSelect');

  // 年格的 v 是下标，不是年份本身 —— 把这条语义钉住，防止以后有人「顺手修正」
  {
    const gy = dp.view(dp.fromSolar('1990-01-01', '11:04', 'solar'), 'year').grid;
    const y = gy.items.find((it) => it.label === '1990');
    eq(y.v, 990, '年格的 v 是索引（1990 → 990 = 1990 − SOLAR_YEAR_MIN）');
    ok(y.v !== 1990, '年格的 v **不是**年份字面值');
  }

  // —— resolve：交回页面
  const pr = dp.resolve(state);
  eq(pr.date, '1990-01-01', 'resolve 的 date');
  eq(pr.time, '11:04', 'resolve 的 time');
  ok(typeof pr.hint === 'string', 'resolve 的 hint 是字符串（视图用 tt:if 判空）');

  // —— 日格带节气（视图要画贴底小字）
  const vd = dp.view(dp.fromSolar('1990-01-01', '11:04', 'solar'), 'day');
  eq(vd.grid.cols, 7, '日格 7 列');
  const withTerm = vd.grid.items.filter((it) => it.term);
  ok(withTerm.length > 0, '日格里至少有一个节气点');
  ok(withTerm[0].term.name && withTerm[0].term.time, '节气点有 name / time 两个字段');
  // 没有节气的项 term 必须是 null（视图用 it.term 判空 → 不能是 undefined 而导致误判）
  eq(vd.grid.items[0].term, null, '无节气的日格 term = null');

  // —— 农历口径也要能开
  const vl = dp.view(dp.fromSolar('1990-01-01', '11:04', 'lunar'), 'year');
  ok(vl.grid.items.length > 0, '农历口径下年格也有内容');

  // —— 翻区
  const v0 = dp.view(dp.fromSolar('1990-01-01', '11:04', 'solar'), 'year', 0);
  ok(v0.grid.seg.index === 0, '强制铺第 0 区');
  eq(v0.grid.seg.hasPrev, false, '第 0 区没有上一区（视图据此置灰）');
  // ⚠ 年格的分区大小（SEG_SIZE）是视图上「一屏最多铺多少年」的直接决定因素，
  //   改它会连带改区号 / 区标签 / 区总数 —— 这三条一起把它钉住。
  //   （负向验证：把 SEG_SIZE 从 120 改成 60，下面三条会同时报红）
  eq(dp.SEG_SIZE, 120, '年格分区大小 = 120 年（视图的翻区粒度）');
  eq(v0.grid.seg.label, '1000-1119', '第 0 区的标签是首 120 年');
  eq(v0.grid.seg.total, 9, '1051 年按 120 分 = 9 个区');
  eq(v0.grid.seg.pos, '1/9', '第 0 区的位次显示 = 1/9');
  const vLast = dp.view(dp.fromSolar('1990-01-01', '11:04', 'solar'), 'year', 8);
  eq(vLast.grid.seg.index, 8, '可以强制铺最后一个区');
  eq(vLast.grid.seg.hasNext, false, '最后一个区没有下一区');
  eq(vLast.grid.seg.pos, '9/9', '最后区的位置显示 = 9/9');
  // 1990 落在第 8 区（不是第 0 区）—— 这条钉住「按已选年份推导区号」这件事
  const vAuto = dp.view(dp.fromSolar('1990-01-01', '11:04', 'solar'), 'year');
  eq(vAuto.grid.seg.index, 8, '不传 segIndex 时按已选年份推出区号 = 8');
  eq(vAuto.grid.seg.label, '1960-2050', '该区的标签');
  eq(vAuto.grid.items.length, 91, '该区铺 1960~2050 共 91 格');
}

/* ============================================================
 * 2. GzPicker 的调用序列
 * ============================================================ */
{
  // —— open()：pillarsToPicks → view(step)
  const pillars = { year: '己巳', month: '丙子', day: '丙寅', hour: '甲午' };
  const picks = gs.pillarsToPicks(pillars);
  eq(picks.length, 8, '八步');
  eq(gs.firstEmpty(picks), -1, '四柱齐 → 没有空缺步');

  const full = gs.view({ picks }, gs.STEPS.length - 1);
  eq(full.crumbCols.length, 4, '四柱表 4 列');
  eq(full.crumbCols[0].cells.length, 2, '每列两个格子（干 / 支）');
  eq(full.ready, true, '四柱齐 → ready = true（「查找」按钮据此可点）');
  // 格子字段（视图直接渲染的）
  const cell = full.crumbCols[0].cells[0];
  eq(Object.keys(cell).sort(), ['active', 'done', 'i', 'label', 'show', 'text'], '格子字段齐全');
  eq(typeof cell.show, 'string', 'cell.show 是字符串（未选时是「—」）');

  // —— 部分录入：停在第一个空缺
  //
  // ⚠ pillarsToPicks 只认**完整的两字干支**；只给一个「丁」不算选了月干，
  //   所以这里清成空 → 第一个空缺是下标 2（月干，一个 gan 步）。
  const partial = gs.pillarsToPicks({ year: '庚午', month: '丁', day: '', hour: '' });
  const at = gs.firstEmpty(partial);
  eq(at, 2, '第一个空缺是下标 2（月干）');
  eq(gs.STEPS[at].label, '月干', '下标 2 对应「月干」');
  eq(gs.STEPS[at].part, 'gan', '它是干的那一步');
  const vp = gs.view({ picks: partial }, at);
  eq(vp.crumbCols[0].cells[0].show, '庚', '年干已选，格子显示「庚」');
  eq(vp.crumbCols[1].cells[0].show, '—', '月干未选，格子显示「—」');
  eq(vp.ready, false, '四柱不齐 → ready = false');

  // —— 选项格子（视图渲染 v / sub / on）
  const opt = vp.grid.options[0];
  ok('v' in opt && 'sub' in opt && 'on' in opt, '选项项有 v / sub / on');
  eq(vp.grid.cols, 5, '干的那几步铺 5 列（10 个两行）');
  eq(vp.grid.options.length, 10, '月干给满 10 个');
  // 支的那几步列数不同（6 个 → 3 列；月/时支只剩 1~2 个）
  const vZhi = gs.view({ picks: partial }, 1);
  eq(vZhi.grid.cols, 3, '年支铺 3 列（6 个两行）');
  eq(vZhi.grid.options.length, 6, '年支给 6 个（与年干同奇偶）');
  // 时支那一步的选项依赖**时干**（五鼠遁）—— 时干没选时选项为空，这是对的
  // （八步向导的顺序设计就是为了避免「走到死胡同」，所以每一步都只依赖前面已选的）
  const beforeHourGan = gs.view(
    { picks: gs.pillarsToPicks({ year: '己巳', month: '丙子', day: '丙寅', hour: '' }) }, 7,
  );
  eq(beforeHourGan.grid.options.length, 0, '时干未选 → 时支选项为空（依赖未就绪）');

  const vHourZhi = gs.view(
    { picks: gs.pillarsToPicks({ year: '己巳', month: '丙子', day: '丙寅', hour: '甲午' }) }, 7,
  );
  eq(vHourZhi.grid.options.length, 1, '丙日干 → 时干「甲」只配「午」一个支（五鼠遁）');
  eq(vHourZhi.grid.options[0].v, '午', '唯一候选是「午」');
  ok(vHourZhi.grid.options[0].sub.length > 0, '时支选项带 sub（时辰区间）');
  eq(vHourZhi.grid.options[0].on, true, '已选的支标记 on（浮框里高亮）');
  // 日支那一步同理：与日干同奇偶 → 6 个
  const vDayZhi = gs.view(
    { picks: gs.pillarsToPicks({ year: '己巳', month: '丙子', day: '丙寅', hour: '' }) }, 5,
  );
  eq(vDayZhi.grid.options.length, 6, '日支给 6 个（与日干同奇偶）');

  // —— normalize：改前一步要清掉配不上的后续
  const bad = ['庚', '午', '丁', '丑', '丙', '寅', '甲', '午'];
  const norm = gs.normalize(['庚', '午', '丁', '子', '丙', '寅', '甲', '午']);
  ok(norm.some((x) => x === ''), 'normalize 会清掉配不上的后续选择');

  // —— picksToPillars：交回页面
  const back = gs.picksToPillars(picks);
  eq(back, pillars, 'picksToPillars 可逆');

  // —— search 的返回契约（App.tsx 里踩过的坑：它不是数组）
  const r = sizhu.search(pillars);
  eq(typeof r.ok, 'boolean', 'search 返回 { ok } 而不是数组');
  ok(Array.isArray(r.list), 'search 的候选在 .list 上');
  eq(r.ok, true, '这组四柱查得到');
  eq(r.list.length, 10, '共 10 个候选（1000~2050 范围内）');
  // 候选项的字段 —— GzPicker 的结果态直接渲染它们
  const it0 = r.list[0];
  ['dateText', 'weekText', 'lunarText', 'zhiText', 'timeText', 'pickDate', 'pickTime']
    .forEach((k) => ok(typeof it0[k] === 'string', '候选项有 ' + k));
  ok('agoText' in it0, '候选项有 agoText（可能为空串）');
  ok('narrow' in it0, '候选项有 narrow（视图据此显示交节提示）');
  ok(!!it0.pickDate && !!it0.pickTime, '候选项带 pickDate / pickTime（onPick 要用）');

  // —— 非法 / 无匹配两种失败也要有 list（视图的 empty 态不会崩）
  const bad1 = sizhu.search({ year: '甲', month: '丑', day: '丙寅', hour: '甲午' });
  eq(bad1.ok, false, '非法干支 → ok = false');
  eq(Array.isArray(bad1.list), true, '失败时 list 仍是数组（视图不崩）');
}

/* ============================================================
 * 3. ChartView 的调用序列
 * ============================================================ */
{
  const rec = recordLib.create('测试', 1, '1990-01-01', '11:04');
  const NOW = 2026;

  // —— 首帧：buildChartData
  const s0 = model.buildChartData(rec, NOW);
  eq(s0.ready, true, 'ready = true');
  // 视图要渲染的每个字段都得在
  ['genderText', 'lunarFullText', 'zodiacText', 'siLingText', 'taiYuanText', 'jiaoYunText']
    .forEach((k) => ok(typeof s0[k] === 'string', 'state.' + k + ' 是字符串'));
  ok(Array.isArray(s0.pillars) && s0.pillars.length === 4, 'pillars 是 4 项数组');
  s0.pillars.forEach((p) => {
    ['label', 'shiShen', 'stem', 'branch', 'stemCls', 'branchCls', 'element', 'canggan']
      .forEach((k) => ok(p[k] !== undefined, 'pillar.' + k + ' 存在'));
  });

  // —— 首帧后的三级联动（useEffect 里的 selectDayun）
  const idx = s0._defaultIdx;
  const { rows, lnIdx } = model.computeDayunRows(rec, s0.dayuns, idx, NOW);
  const dl = model.withActive(s0.dayuns, idx);
  const ls = model.buildLiunians(rows, lnIdx);
  const ly = model.buildLiuyues(rows[lnIdx]);
  const out = model.setTables(rec, dl, ls, ly, { dk: dl[idx].key, di: idx, lnIdx }, {});

  eq(out.selCards.length, 3, '三张选中卡都在（大运 / 流年 / 流月）');
  ok(out.selCards.every((c) => typeof c.label === 'string'), '每张卡都有标签');
  ok(out.selCards[0].gan && out.selCards[0].zhi, '大运卡有干支');
  ok(out.selCards[1].gan && out.selCards[1].zhi, '流年卡有干支');
  eq(out.selCards[2].blank, true, '流月卡是空壳（未选中）');

  // 三张表的每一列都要能被 GzTable 渲染
  out.dayuns.forEach((d) => {
    ['key', 'year', 'age', 'gz', 'gan', 'zhi', 'ganCls', 'zhiCls', 'active', 'noRight']
      .forEach((k) => ok(d[k] !== undefined, 'dayun.' + k + ' 存在'));
  });
  out.liunians.forEach((l) => ok(l.year !== undefined && l.age !== undefined, '流年有 year / age'));
  out.liuyues.forEach((m) => ok(m.jieQi && m.date && m.gz, '流月有 jieQi / date / gz'));

  // —— 点流年列（onPickLiunian）
  const other = 2;
  const out2 = model.setTables(
    rec, out.dayuns, model.withActive(out.liunians, other), model.buildLiuyues(rows[other]),
    { dk: dl[idx].key, di: idx, lnIdx: other }, {},
  );
  eq(out2.liunians.filter((l) => l.active).length, 1, '换流年后有且只有一列 active');
  eq(out2.liuyues.length, 12, '流月跟着换成那一年（仍 12 个）');

  // —— 点流月列（onPickLiuyue）：只切高亮，表不变
  const out3 = model.setTables(rec, out2.dayuns, out2.liunians, model.withActive(out2.liuyues, 5), { dk: dl[idx].key, di: idx, lnIdx: other }, {});
  eq(out3.liuyues.filter((m) => m.active).length, 1, '流月高亮切一列');
  eq(out3.liuyues.length, 12, '流月列数不变');
  eq(out3.selCards[2].blank, false, '选中流月后卡不再是空壳');

  // —— 换一份记录（改出生时间）→ 整块盘重排
  const rec2 = recordLib.create('测试', 1, '1949-10-01', '12:00');
  const s2 = model.buildChartData(rec2, NOW);
  eq(s2.ready, true, '换记录后仍能装配');
  eq(s2.pillars.map((p) => p.stem + p.branch), ['己丑', '癸酉', '甲子', '庚午'], '换记录后四柱变了（锚点：1949-10-01 日柱甲子）');

  // —— notes 变化时的重算路径（refreshNotes）
  /* ⚠⚠ 2026-10-21 修正：事件记录**只留流年**（用户要求，见 chart-view/model.js 的 decorate）——
     大运 / 流月写了也不显示，`inline.dayun` / `inline.liuyue` 恒为空。
     原来这里断言的是「写一条 dayun 事件 → inlineDayun 看得见」，与新契约正好相反，
     所以改成「大运写了也**看不见**」，真正的重算路径用流年那条验。 */
  const notesLib = require(path.join(base, 'core', 'notes.js'));
  const dyKey = notesLib.key('dayun', dl[idx].key);
  const out4 = model.setTables(rec, dl, ls, ly, { dk: dl[idx].key, di: idx, lnIdx }, {
    [dyKey]: { text: '大运写了也不显示' },
  });
  eq(out4.inlineDayun, '', '⚠ 大运写了也不显示（只留流年）');
  /* 流年那条：带 `year` 快照 ⇒ decorate 按年份命中（liunianKeyByYear），与页面写的是同一个 key */
  const lnKey = notesLib.key('liunian', dl[idx].key, lnIdx);
  const out5 = model.setTables(rec, dl, ls, ly, { dk: dl[idx].key, di: idx, lnIdx }, {
    [lnKey]: { text: '重算后要能看见', year: ls[lnIdx].year },
  });
  eq(out5.inlineLiunian, '重算后要能看见', 'notes 重算路径能命中（key 形状与页面一致）');
}

/* ============================================================
 * 4. 记录 → 盘面 的完整往返（页面真实做的事）
 * ============================================================ */
{
  const rec = recordLib.create('卢艺', 1, '1990-01-01', '11:04');
  const s = model.buildChartData(rec, 2026);
  // 四柱与 record.chart.pillars 必须一致（视图和后端都读这一份）
  eq(
    s.pillars.map((p) => p.stem + p.branch),
    ['year', 'month', 'day', 'hour'].map((k) => rec.chart.pillars[k].name),
    '视图四柱 == 记录里的四柱',
  );
  eq(s.lunarFullText, rec.lunarText, '视图农历 == 记录里的农历');
  eq(s.jiaoYunText, rec.bazi.jiaoYunText, '视图交运 == 记录里的交运快照');
}

/* ============================================================
 * 5. 视图问能力：「调的方法名」必须在导出表里
 *
 * ⚠⚠ 2026-10-05 真踩：记录页写的是 `store.supportsTags()`，而
 *   store/index.js 里只转发了 supportsFilter、**没导出 supportsTags** ⇒
 *   首屏渲染时 `undefined is not a function`，整页崩。
 *   ⚠ 为什么两道网都没拦住：
 *     · tsc 看不见 —— `store` 是按 `any` require 进来的；
 *     · 源码断言只查「有没有调这个方法」（它确实调了），
 *       而「这个名字在不在导出表里」**得跑起来才知道**。
 *   ⇒ 这条断言把那个运行时的坑搬到自检里：扫一遍视图源码里所有
 *     `store.<名字>`，逐个核对它是 store 的导出、而且是函数。
 *   ⚠ 别只在「加了新 supportsX」时才想起它 —— 加数据接口（listTags 之类）
 *     同样会这样翻车，所以这里**不挑前缀**，全扫。
 * ============================================================ */
{
  const fs = require('fs');
  const storeLib = require(path.join(base, 'core', 'store', 'index.js'));
  const modeLib = require(path.join(base, 'core', 'storeMode.js'));

  /** 递归收集 .tsx（视图才认 `store` 这个 require 名） */
  function walkTsx(dir, out) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walkTsx(p, out);
      else if (/\.tsx$/.test(f)) out.push(p);
    }
    return out;
  }
  const views = walkTsx(path.join(base, 'screens'), [])
    .concat(walkTsx(path.join(base, 'components'), []));

  const used = new Map(); // 名字 → [用到它的文件]
  for (const f of views) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /\bstore\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let m;
    while ((m = re.exec(src))) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(path.relative(base, f));
    }
  }

  ok(used.size > 0, '视图里确实在向 store 问能力（扫到了调用点）');
  /* ⚠ 先钉住「扫描本身没瞎」：已知存在的两个必须被扫出来。
     否则正则在将来某次重构后**匹配不上任何东西**，下面那个循环
     会因为 used 为空而一条都不跑 —— 又一个「永远绿」的假网。 */
  ok(used.has('supportsFilter'), '扫描有效性：supportsFilter 被扫到了');
  ok(used.has('supportsTags'), '扫描有效性：supportsTags 被扫到了');

  for (const [name, files] of used) {
    ok(
      typeof storeLib[name] === 'function',
      '⚠⚠⚠ `store.' + name + '` 必须真的从 store/index.js 导出（' +
        [...new Set(files)].join('、') + ' 在用）—— 没导出 = 首屏 `undefined is not a function`'
    );
  }

  /* 刚才那处真 bug 的**逐字形状**也钉一条：能力判据要跟 storeMode 同源，
     不能自己写一个 `MODE === 'local'`（两处判据会各自漂移）。
     ⚠⚠ 取值必须**先问类型再调**（`callIfFn`），不能直接 `storeLib.supportsTags()` ——
     导出真的丢了的时候，那一句会抛 TypeError 把整套自检**崩在中途**
     （实测：报完 FAIL 紧跟一串 Node 堆栈，后面的断言一条都不跑）。
     ⚠ 「崩」比「红」危险得多：红是「这条没过」，崩是「后面全没验」。 */
  function callIfFn(obj, name) {
    if (typeof obj[name] !== 'function') return '<缺 ' + name + '>';
    try {
      return obj[name]();
    } catch (e) {
      return '<抛 ' + e.message + '>';
    }
  }
  eq(
    callIfFn(storeLib, 'supportsTags'),
    callIfFn(modeLib, 'supportsTags'),
    'store.supportsTags() 与 storeMode.supportsTags() 同源（判据只有一份）'
  );
  eq(
    callIfFn(storeLib, 'supportsFilter'),
    callIfFn(modeLib, 'supportsFilter'),
    'store.supportsFilter() 与 storeMode.supportsFilter() 同源'
  );
}

/* ---------- 汇总 ---------- */
console.log('');
console.log(pass + ' PASS / ' + fail + ' FAIL');
if (fail) {
  console.log('');
  console.log('失败清单：');
  fails.forEach((f) => console.log('  · ' + f));
}
process.exit(fail ? 1 : 0);
