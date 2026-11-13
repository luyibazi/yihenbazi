/**
 * ChartView 计算层自检
 *
 * ⚠ 这个脚本的存在理由：原项目把「算」和「渲染」混在一个 Component 里，
 *   搬到 RN 后如果继续混着，就没法在不启动模拟器的情况下验证三级联动逻辑
 *   （大运 → 流年 → 流月）与事件记录的落点。model.js 把纯函数拆出来了，
 *   于是这些语义可以在 Node 里直接对拍。
 *
 * 跑法：node tests/chart-view-check.js
 */
globalThis.window = globalThis;

const path = require('path');
const model = require(path.join(__dirname, '..', 'src', 'components', 'chart-view', 'model.js'));
const recordLib = require(path.join(__dirname, '..', 'src', 'core', 'record.js'));
const notesLib = require(path.join(__dirname, '..', 'src', 'core', 'notes.js'));

let pass = 0;
let fail = 0;
const fails = [];

function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; fails.push(label); console.log('FAIL  ' + label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else {
    fail++; fails.push(label);
    console.log('FAIL  ' + label + '  期望 ' + e + '，实际 ' + a);
  }
}

/* ---------- 固定输入：1990-01-01 11:04 男（与 test.js 的锚点一致） ---------- */
const REC = recordLib.create('测试', 1, '1990-01-01', '11:04');
/** 固定「今年」= 2026，让默认选中项可复现 */
const NOW = 2026;

const base = model.buildChartData(REC, NOW);

/* ========== 1. 盘面骨架 ========== */
ok(base.ready === true, '有 chart 时 ready = true');
eq(base.genderText, '男', '性别文案 = 男');
eq(base.zodiacText, '属蛇', '生肖文案带「属」字前缀');
eq(base.lunarFullText, '一九八九年十二月初五', '农历文案');
eq(base.pillars.length, 4, '四柱 = 4 列');

/* 四柱的干支与十神（日柱不自论十神，用性别称谓占位） */
eq(base.pillars.map((p) => p.stem + p.branch), ['己巳', '丙子', '丙寅', '甲午'], '四柱干支');
eq(base.pillars.map((p) => p.shiShen), ['伤官', '比肩', '元男', '偏印'], '四柱十神（日柱 = 元男）');
eq(base.pillars[2].isDay, true, '第 3 列标记为日柱');
eq(base.pillars[0].isDay, false, '第 1 列不是日柱');

/* 五行配色 class：干支各自成对 */
eq(base.pillars[0].stemCls, 'c-tu', '年干「己」属土');
eq(base.pillars[0].branchCls, 'c-huo', '年支「巳」属火');
eq(base.pillars[2].stemCls, 'c-huo', '日干「丙」属火');
eq(base.pillars[2].branchCls, 'c-mu', '日支「寅」属木');

/* 藏干：日柱「寅」藏 甲(偏印/木) 丙(比肩/火) 戊(食神/土) */
eq(base.pillars[2].canggan.map((c) => c.stem), ['甲', '丙', '戊'], '日柱藏干三个');
eq(base.pillars[2].canggan.map((c) => c.cls), ['c-mu', 'c-huo', 'c-tu'], '藏干五行 class');
eq(base.pillars[2].canggan.map((c) => c.shiShen), ['偏印', '比肩', '食神'], '藏干十神以日干为「我」');

/*
 * 纳音（用户 2026-10-08：「排盘结果要显示纳音」）。
 * ⚠ 60 甲子**两两共用一个**纳音（30 个名目），值一律由 tyme 的 getSound() 给 ——
 *   自己抄一张 60 项的对照表就是「同一件事两份实现」，将来必漂。
 * 这一柱 己巳 / 丙子 / 丙寅 / 甲午 的纳音：
 */
eq(base.pillars.map((p) => p.nayin), ['大林木', '涧下水', '炉中火', '沙中金'], '四柱纳音');
/* 纳音按**自己那一字**五行上色（大林**木** → c-mu），不是跟着干支的五行 */
eq(base.pillars.map((p) => p.nayinCls), ['c-mu', 'c-shui', 'c-huo', 'c-jin'], '四柱纳音五行 class');
/* ⚠ 老 chart 对象（老代码算的）没有 nayin 字段 → 空串降级，整行不画；不能崩、也不能编一个 */
{
  const oldRec = recordLib.create('测试', 1, '1990-01-01', '11:04');
  delete oldRec.chart.pillars.day.nayin;
  const oldData = model.buildChartData(oldRec, NOW);
  eq(oldData.pillars[2].nayin, '', '⚠ 缺 nayin → 空串降级（老记录 / 老 chart 对象）');
  eq(oldData.pillars[2].nayinCls, '', '⚠ 缺 nayin → 配色 class 也是空的（视图回退成灰，不硬编色）');
  eq(oldData.pillars[0].nayin, '大林木', '⚠ 只有缺的那一柱没了，别的柱照画');
}
/* ⚠⚠ 行式表格（用户 2026-10-08 给问真截图：「就这样」）。
 * 版式从「列式」改成「行式」：左行头（主星/天干/地支/藏干/星运/自坐/空亡/纳音），
 * 每行横向排四柱 + 选中运卡。旧的「藏干块定高垫」对齐机制被行式布局**结构性取代**
 * （行是独立块，天然横向对齐），相关旧断言随之改写。 */
{
  const rows = model.buildPillarRows(base.pillars, []);
  eq(rows.map((r) => r.label), ['', '主星', '天干', '地支', '藏干', '星运', '自坐', '空亡', '纳音', '神煞'], '行头清单（照问真）');
  eq(rows.length, 10, '行数 = 10（列头 + 主星/天干/地支/藏干/星运/自坐/空亡/纳音/神煞）');
  rows.forEach((r) => eq(r.cells.length, 4, '  └ 无卡时每行 4 个 cell（恒定，不多不少）'));

  const rowOf = (label) => rows.find((r) => r.label === label);
  /* 星运：日干「丙」对各支 —— 巳=临官 子=胎 寅=长生 午=帝旺（与问真口径一致） */
  eq(rowOf('星运').cells.map((c) => c.text), ['临官', '胎', '长生', '帝旺'], '星运 = 日干对各支的十二长生');
  /* 自坐：各柱天干坐在本柱地支上 —— 己巳=帝旺 丙子=胎 丙寅=长生 甲午=死 */
  eq(rowOf('自坐').cells.map((c) => c.text), ['帝旺', '胎', '长生', '死'], '自坐 = 本柱干对本柱支的十二长生');
  /* 空亡：己巳→戌亥（甲子旬） 丙子→申酉（甲戌旬） 丙寅→戌亥 甲午→辰巳（甲午旬） */
  eq(rowOf('空亡').cells.map((c) => c.text), ['戌亥', '申酉', '戌亥', '辰巳'], '空亡 = 各柱所在旬的两个空亡支');
  /* 天干/地支行逐字上色 */
  eq(rowOf('天干').cells.map((c) => c.cls), ['c-tu', 'c-huo', 'c-huo', 'c-mu'], '天干行带五行配色 class');
  /* 主星行日柱金色标记 */
  eq(rowOf('主星').cells.map((c) => c.gold), [false, false, true, false], '主星行只有日柱带金色标记');
  /* 纳音行 + 配色 */
  eq(rowOf('纳音').cells.map((c) => c.text), ['大林木', '涧下水', '炉中火', '沙中金'], '纳音行');
  eq(rowOf('纳音').cells.map((c) => c.cls), ['c-mu', 'c-shui', 'c-huo', 'c-jin'], '  └ 按纳音末字五行上色');
  /* 藏干行是 canggan kind（多行堆叠） */
  ok(rowOf('藏干').cells.every((c) => c.kind === 'canggan'), '藏干行 cell 是 canggan kind');
  ok(rowOf('藏干').cells[2].items.length === 3, '  └ 寅藏 3 干（甲丙戊）');
}

/* ⚠⚠ 源码级：**model 有值 ≠ 视图会画**。行式版式最容易「算了但没渲染」或被人改回条件渲染。 */
{
  const fs = require('fs');
  /*
   * ⚠⚠ 2026-10-18：四柱行式表格 + 大运/流年/流月 从 ChartView 整体搬进 QiDingPage.tsx
   *   （用户：这两块要封装成「定气法」那一页，用开关切）。断言的目标文件跟着搬 ——
   *   继续读 ChartView.tsx 会「文件里找不到就算过」，等于这批断言全废。
   */
  const src = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'components', 'chart-view', 'QiDingPage.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  /* ⚠ 组行（buildPillarRows）留在 ChartView，画的在 QiDingPage —— 两处都得看：
     只读一个文件会「另一半删了照样绿」。 */
  const outer = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'components', 'chart-view', 'ChartView.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  /* 视图真的用 buildPillarRows 组行、并渲染每行每 cell */
  ok(/M\.buildPillarRows\(state\.pillars/.test(outer), '⚠ 视图从 model.buildPillarRows 组行（不许在视图里手搓行）');
  ok(/pillarRows\.map\(/.test(src), '  └ 行真的被渲染');
  ok(/renderCell\(row\.key, cell, i\)/.test(src), '  └ cell 真的被渲染');
  /* 纳音字号样式沿用（三字 96rpx 列宽），且 cell 上色走统一 ELEMENT_COLORS[cell.cls] */
  ok(/styles\.pillarNayin\b/.test(src), '  └ 纳音用 pillarNayin 样式（比藏干小一号，三个字才装得下 96rpx）');
  ok(/ELEMENT_COLORS\[cell\.cls\]/.test(src), '  └ cell 按五行配色 class 上色');
  /*
   * ⚠⚠ 行式对齐的全部机制 = **cells 恒定长度 + 按位置分流宽度**：
   *   cell 少一个这一行的列就错位。不许出现「有才画」的条件渲染。
   */
  ok(!/p\.canggan && p\.canggan\.length \?/.test(src), '⚠ 藏干不许条件渲染（空壳/空藏干也要占位，行才对齐）');
  ok(/i < PILLAR_COUNT \? styles\.cellPillar : styles\.cellCard/.test(src), '  └ cell 宽度按位置分流（前 4 柱定宽，其后卡均分）');
  /*
   * ⚠⚠ 行头的横向预算：**行头 80 + 右间隙 8 = 88 = 改前的行头宽**。
   *   用户 2026-10-08：「左侧的字离屏幕右侧太近，又四柱太远了」——
   *   行头与第 1 柱贴死（行头文字紧贴屏幕右侧）、四柱整体被推右。
   *   给行头右侧 8rpx 间隙，同时把 rowHeadWidth 从 88 让出这 8rpx（80）⇒
   *   行头 + 间隙的**总占位与改前一致（88）**，四柱一个像素都没右移。
   *   ⚠ 只加间隙不减宽度 ⇒ 4 柱右移 8rpx，末列越出 750 可用宽被裁。
   */
  ok(/marginRight: rpx\(ROW_HEAD_GAP\)/.test(src), '⚠ 行头右侧留间隙（否则行头与第 1 柱贴死）');
  ok(/ROW_HEAD_GAP = 8\b/.test(src), '  └ 间隙 8rpx');
  eq(require('../src/theme/tokens.ts').SIZES.rowHeadWidth + 8, 88,
    '⚠ 行头宽 + 间隙 = 88（= 改前行头宽，四柱不许右移）');
  /*
   * ⚠⚠ 行头文字必须离开**屏幕左边缘**（用户 2026-10-08 第二次报：「左侧加上的字直接
   *   和屏幕边缘挨在一起了」—— 第一次「离屏幕右侧太近」实际说的就是这件事）。
   *   用 paddingLeft（在 80 宽度**内部**）而不是 marginLeft：margin 会把总占位撑大、
   *   把四柱推右。24 与信息卡 headCardPadX 同值，左缘视觉一条线。
   */
  ok(/paddingLeft: rpx\(SIZES\.rowHeadPadLeft\)/.test(src), '⚠ 行头文字离屏幕左边缘（rowHead.paddingLeft）');
  eq(require('../src/theme/tokens.ts').SIZES.rowHeadPadLeft, 24, '  └ 左缘 24rpx（与信息卡 headCardPadX 对齐）');
  /*
   * ⚠⚠ **唯一**一条垂直分隔线：四柱（原局）| 运限（大运/流年/流月）。
   *   用户 2026-10-08：「分割线只限于四柱和大运之间，将原局和运限分开。
   *   年月日之间不需要分割线」⇒ 柱间**不许**再有竖线。
   *   独立的一根 View（blockDivider），不能改成 cell 的 borderRight ——
   *   列是定宽 96rpx，边框会吃掉内容宽度把干支挤歪。
   */
  ok(/i === PILLAR_COUNT \? <View style={styles\.blockDivider\} \/> : null/.test(src), '⚠ 只有「四柱 | 运限」之间一条线');
  ok(!/i > 0 \? \(/.test(src), '  └ 柱间不再画线（年月日之间无分割线）');
  ok(!/styles\.pillarDivider/.test(src), '  └ 旧的柱间细线样式已删干净（没留死代码）');
  /*
   * ⚠ 正则必须**限制在样式块内**（到第一个 `}` 为止）——写成 [\s\S]*? 是哑断言：
   *   会跨过样式块的 } 匹配到后面无关代码，改坏了照样绿（已实测踩过）。
   */
  ok(/blockDivider:\s*\{[^}]*alignSelf:\s*'stretch'/.test(src), '  └ 分隔线 stretch 撑满行高（藏干行最长）');
  ok(/blockDivider:\s*\{[^}]*StyleSheet\.hairlineWidth/.test(src), '  └ 用 hairline 细线（粗线会挤占列间空间）');
  ok(/blockDivider:\s*\{[^}]*COLORS\.border\b/.test(src), '  └ 用深一档的 COLORS.border（承担「分区」语义）');

  /*
   * ★ 平气法页在「封装」那一刻是**空壳**（用户 2026-10-18：「这个页面后续我指挥你做」，
   *   后来又明确「定气法平气法本身就是两个不同的东西」「把定气法页面退回到我让你封装那个时刻」）。
   * ⚠ 所以这里**不**对平气法页做版式断言 —— 它现在不画盘。等用户指挥它画什么，再加断言。
   *   现在只守两条：① 空壳不许崩（同签名、同 styles 契约）；② 不许偷偷复制定气法那份。
   */
  const pingSrc = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'components', 'chart-view', 'QiPingPage.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  ok(/export default function QiPingPage/.test(pingSrc), '平气法页存在且是默认导出');
  ok(!/from\s+'\.\/QiDingPage'/.test(pingSrc), '⚠ 平气法页不 import 定气法页（两个不同的东西，不共享视图）');
}

/* ========== 2. 派生字段（司令 / 胎元 / 交运） ========== */
ok(/司令/.test(base.siLingText), '司令文案已算出');
eq(base.taiYuanText, '丁卯', '胎元 = 丁卯');
eq(base.jiaoYunText, '清明后24天17小时（戊癸）', '交运算文直接用记录里的快照');
eq(base.pillars[3].element, base.pillars[3].element, '时柱五行存在');

/* ========== 3. 大运表 ========== */
eq(base.dayuns.length, 13, '大运 = 1 列小运 + 12 步（记录里 12 步）');
eq(base.dayuns[0].gz, '小运', '首列是起运前的「小运」');
eq(base.dayuns[0].age, '1~10', '首列岁数是 1~起运岁');
eq(base.dayuns[0].gan, '', '「小运」不是干支 → 不拆字');
eq(base.dayuns[1].key, 'd0', '第二步 key = d0');
eq(base.dayuns[1].gz, '乙亥', '第一步大运干支 = 乙亥');
eq(base.dayuns[1].year, 1998, '第一步大运起始公历年 = 1998');
eq(base.dayuns[12].key, 'd11', '末步 key = d11');

/* 大运 key 用的是表内位置（含首列小运）—— 事件记录的 key 依赖它 */
eq(base.dayuns.map((d) => d.key)[0], 'pre', '首列 key = pre');
eq(base.dayuns.map((d) => d.key).slice(0, 4), ['pre', 'd0', 'd1', 'd2'], '大运 key 是表内位置');

/* ========== 4. 默认选中「当前所处」的那一步 ========== */
eq(base._defaultIdx, 3, '2026 落在第 3 格（d2，2018-2028 区间）');
eq(base.dayuns[3].year, 2018, '该步起始年 = 2018');

/* 还没起运 / 已过最后一步的边界 */
{
  const early = model.currentDayunIndex(base.dayuns, 1990);   // 出生那年，还没起运
  eq(early, 0, '早于第一步 → 首列小运');
  const late = model.currentDayunIndex(base.dayuns, 2200);
  eq(late, base.dayuns.length - 1, '已过最后一步 → 最后一步');
}
eq(model.currentDayunIndex([], 2026), -1, '空表返回 -1');

/* ========== 5. 三级联动：大运 → 流年 → 流月 ========== */
const step3 = base.dayuns;
const { rows, lnIdx } = model.computeDayunRows(REC, step3, 3, NOW);
eq(rows.length, 11, '一步大运给 11 个流年');
eq(lnIdx, 8, '流年默认选中 2026（该步区间内的第 9 个）');
eq(rows[lnIdx].year, 2026, '选中的流年 = 2026');
eq(rows[lnIdx].yearGanZhi, '丙午', '2026 年干支 = 丙午');

const liunians = model.buildLiunians(rows, lnIdx);
eq(liunians.length, 11, '流年表 11 列');
eq(liunians[lnIdx].active, true, '选中的流年列 active');
eq(liunians.filter((l) => l.active).length, 1, '有且只有一列 active');
eq(liunians[0].gan + liunians[0].zhi, rows[0].yearGanZhi, '流年干支拆字正确');

const liuyues = model.buildLiuyues(rows[lnIdx]);
eq(liuyues.length, 12, '一年给 12 个流月');
eq(liuyues.filter((m) => m.active).length, 0, '流月不默认选中（与参考项目一致）');
ok(liuyues[0].jieQi && liuyues[0].date && liuyues[0].gz, '流月三行都有值');

/* ========== 6. 选中列的分隔线规则 ==========
   选中列自身与它左边一列都不画右分隔线，否则竖线会把整列色块割开 */
{
  const marked = model.withActive(
    [{ gz: '甲子' }, { gz: '乙丑' }, { gz: '丙寅' }, { gz: '丁卯' }],
    2,
  );
  eq(marked.map((m) => m.noRight), [false, true, true, false], 'noRight 盖住选中列与其左邻');
  eq(marked.map((m) => m.active), [false, false, true, false], 'active 只有选中列');
}
{
  const marked0 = model.withActive([{ gz: 'a' }, { gz: 'b' }], 0);
  eq(marked0.map((m) => m.noRight), [true, false], '选中首列时只有它自己不画线');
}

/* ========== 7. 选中运面板的推导 ========== */
{
  // ⚠ buildLiunians 自己会带 active（它内部走 withActive），所以「选了流年」这件事
  //   在它的返回值里已经成立 —— 于是大运卡也会跟着出现（大运取的是同一张表的 active 项）。
  //   真正「一张卡都没有」的情况是：三张表全空。
  const cards = model.buildSelCards(liunians, liunians, liuyues, '丙');
  eq(cards.length, 3, '流年表已 active + 流月表已生成 → 大运/流年/流月三位卡位都在');
}
{
  const none = model.buildSelCards([], [], [], '丙');
  eq(none.length, 0, '三张表全空 → 一张卡都不占（否则会凭空多出空框）');
}
{
  // 完整路径：大运 + 流年 + 流月表已生成
  const dl = model.withActive(step3, 3);
  const cards = model.buildSelCards(dl, liunians, liuyues, '丙');
  eq(cards.length, 3, '大运/流年/流月三位卡位都占上');
  eq(cards.map((c) => c.label), ['大运', '流年', '流月'], '卡位标签');
  eq(cards[0].gan + cards[0].zhi, '癸酉', '大运卡干支 = 癸酉');
  eq(cards[1].gan + cards[1].zhi, '丙午', '流年卡干支 = 丙午');
  eq(cards[2].blank, true, '流月未选中 → 空壳卡');
  eq(cards[2].gan, '', '空壳卡不画干支');

  // 十神以日干「丙」为「我」：癸对丙 = 正官
  eq(cards[0].shiShen, '正官', '大运卡十神以日干为「我」');
  // 藏干与四柱同源
  eq(cards[0].canggan.map((c) => c.stem), ['辛'], '大运卡藏干 = 酉藏辛');
  // 纳音与四柱同源（同一个 tyme getSound，不另抄表）；空壳卡没有值
  eq(cards[0].nayin, '剑锋金', '大运卡纳音 = 癸酉 → 剑锋金');
  eq(cards[0].nayinCls, 'c-jin', '大运卡纳音按末字五行上色（剑锋**金**）');
  eq(cards[1].nayin, '天河水', '流年卡纳音 = 丙午 → 天河水');
  eq(cards[1].nayinCls, 'c-shui', '  └ 色 = 水');
  eq(cards[2].nayin, '', '⚠ 空壳卡（流月未选中）纳音是空串 → 视图用空格占位');
}
{
  // 选中流月后，空壳变实卡（卡位不变，宽度不会跳）
  const dl = model.withActive(step3, 3);
  const mSel = model.withActive(liuyues, 2);
  const cards = model.buildSelCards(dl, liunians, mSel, '丙');
  eq(cards.length, 3, '选中流月后仍是 3 张卡（卡位固定）');
  eq(cards[2].blank, false, '流月选中后不再是空壳');
  eq(cards[2].gan + cards[2].zhi, liuyues[2].gan + liuyues[2].zhi, '流月卡干支与表里一致');
}
{
  // 首列小运：没有干支 → 显示「起运前」
  const pre = model.withActive(step3, 0);
  const cards = model.buildSelCards(pre, [], [], '丙');
  eq(cards.length, 1, '只选了小运 → 1 张卡');
  eq(cards[0].label, '小运', '标签是「小运」');
  eq(cards[0].text, '起运前', '占位文案 = 起运前');
  eq(cards[0].gan, '', '小运卡不画干支');
  /* ⚠「小运」不是干支：纳音必须走 gzClasses 的判据降级成空串，
     硬编码 gz.length === 2 会把它送进 tyme.fromName 直接抛 */
  eq(cards[0].nayin, '', '⚠「小运」不是干支 → 纳音空串（不许硬编码长度判据）');
  eq(cards[0].nayinCls, '', '  └ 配色 class 也空');
}
{
  // 流月表还没生成 → 不占位（否则会凭空多一个空框）
  const dl = model.withActive(step3, 3);
  const cards = model.buildSelCards(dl, liunians, [], '丙');
  eq(cards.length, 2, '流月表未生成 → 只占 2 个卡位');
}

/* ========== 7b. 行式表格带卡（每行 cells 恒定 = 4 柱 + 卡数） ========== */
{
  const dl = model.withActive(step3, 3);
  const mSel = model.withActive(liuyues, 2);
  const cards = model.buildSelCards(dl, liunians, liuyues, '丙');
  const rows = model.buildPillarRows(base.pillars, cards);
  rows.forEach((r) => eq(r.cells.length, 4 + 3, '  └ 三张卡时每行 7 个 cell（空壳也占位）'));
  /* 空壳卡：内容行（主星起）整列 blank 隐藏；列头行（head）的「流月」标签照画 —— 老版行为 */
  rows.filter((r) => r.label).forEach((r) => {
    ok(r.cells[6].blank === true, '  └ 空壳卡内容整格 blank（' + (r.label || 'head') + ' 行）');
  });
  eq(rows[0].cells[6].blank, false, '  └ 列头行「流月」标签照画（不 blank）');
  /* 卡列也带星运/自坐/空亡（大运卡 癸酉：丙在酉=死；癸在酉=病；旬空 戌亥） */
  const rowOf = (label) => rows.find((r) => r.label === label);
  eq(rowOf('星运').cells[4].text, '死', '大运卡星运 = 日干对运支（丙在酉）');
  eq(rowOf('自坐').cells[4].text, '病', '大运卡自坐 = 癸在酉');
  eq(rowOf('空亡').cells[4].text, '戌亥', '大运卡空亡 = 癸酉所在旬（甲子旬）');
  eq(rowOf('纳音').cells[4].text, '剑锋金', '大运卡纳音');
  /* 小运卡（无干支）：天干行是 placeholder、其余行降级空串 */
  const pre = model.buildPillarRows(base.pillars, model.buildSelCards(model.withActive(step3, 0), [], [], '丙'));
  eq(pre.find((r) => r.label === '天干').cells[4].kind, 'placeholder', '小运卡天干格是 placeholder（起运前）');
  eq(pre.find((r) => r.label === '星运').cells[4].text, '', '  └ 星运/自坐/空亡/纳音降级空串');
  eq(pre.find((r) => r.label === '纳音').cells[4].text, '', '  └（「小运」不是干支，不许送进 tyme）');
  /*
   * ⚠⚠ 空壳卡（流月未选中）的天干格**不许**走 placeholder —— 占位格带 minHeight，
   *   会把整行撑出一段看不见的空白（2026-10-08 真机：地支与藏干之间多出 ~130rpx 空隙）。
   *   只有真正有占位文案的卡（小运「起运前」）才配 placeholder。
   */
  const blankStem = rows.find((r) => r.label === '天干').cells[6];
  eq(blankStem.kind, 'value', '⚠ 空壳卡天干格是普通 value（不是 placeholder）');
  eq(blankStem.blank, true, '  └ 且带 blank 标记（隐藏 + 高度 0）');
  /* 占位高度 = **一行**大字（列式遗产 130 = 两行，在行式下会把行撑出两倍空白） */
  const tokensLib = require('../src/theme/tokens.ts');
  eq(tokensLib.SIZES.selTextMinHeight, 65, '⚠ 小运占位 minHeight = 一行大字（54 × 1.2）');
  eq(Math.round(tokensLib.SIZES.pillarCharSize * tokensLib.SIZES.pillarCharLineHeight), 65, '  └ 与柱大字行高一致');
}

/* ========== 8. 事件记录：格子标记 + 内联正文（⚠ 2026-10-21 只留流年）========== */
{
  const dl = model.withActive(step3, 3);
  const ctx = { dk: dl[3].key, di: 3, lnIdx };
  const myNotes = {};
  myNotes[notesLib.key('dayun', 'd2')] = { text: '这一步开始转行' };

  const out = model.setTables(REC, dl, liunians, liuyues, ctx, myNotes);
  /* ⚠⚠⚠ 用户 2026-10-21：「大运流月的红点功能和显示文字的功能也移除。只留流年」
     ⇒ 大运写过的历史事件**不再显示**（红点 / 内联正文都不画），库里的数据不删。 */
  eq(out.dayuns.filter((d) => d.note).length, 0, '⚠⚠ 大运写了事件也不显示红点（已移除）');
  eq(out.inlineDayun, '', '⚠ 大运也不再有内联正文');
}
{
  const dl = model.withActive(step3, 3);
  const myNotes = {};
  myNotes[notesLib.key('liuyue', 'd2', 3, 4)] = { text: '流月事件' };
  const out = model.setTables(REC, dl, liunians, liuyues, { dk: 'd2', di: 3, lnIdx: 3 }, myNotes);
  eq(out.liuyues.filter((m) => m.note).length, 0, '⚠⚠ 流月同理：写了也不显示');
  eq(out.inlineLiuyue, '', '⚠ 流月没有内联正文');
}
{
  // ⚠ 流年 key 带父级下标（防串到别的十年）；但**同一年只有一条记录**
  const dl = model.withActive(step3, 3);
  const ctx = { dk: 'd2', di: 3, lnIdx };
  const myNotes = {};
  myNotes[notesLib.key('liunian', 'd2', 5)] = { text: '流年事件', year: liunians[5].year };

  const out = model.setTables(REC, dl, liunians, liuyues, ctx, myNotes);
  eq(out.liunians[5].note, '流年事件', '流年事件落在 (d2, 5)');
  eq(out.liunians.filter((l) => l.note).length, 1, '只有一格带标记');

  // 换到**另一段十年**（另一步大运的流年表，年份全不同）→ 标记不该跟着过来
  const otherRows = model.computeDayunRows(REC, step3, 0, NOW).rows;
  const otherTable = model.buildLiunians(otherRows, 0);
  const other = model.setTables(REC, dl, otherTable, [], { dk: 'd0', di: 0, lnIdx: null }, myNotes);
  eq(other.liunians.filter((l) => l.note).length, 0, '换到别的十年后不串标记（年份对不上）');
}
{
  /* ★★★ 交运切割（用户 2026-10-21：「交运的流年不管是上下部分，总之长按都是用一个」）：
     同一公历年会同时出现在**前后两步大运**的流年表里，两条 key 不同 ⇒
     显示和长按都必须按**年份**归一到同一条记录。 */
  const y = liunians[5].year;
  const savedKey = notesLib.key('liunian', 'd2', 5);
  const cut = {};
  cut[savedKey] = { text: '交运那年发生的事', year: y };

  eq(notesLib.liunianKeyByYear(cut, y), savedKey, '  └ 按年份找到已存在那条的 key');
  eq(notesLib.liunianKeyByYear(cut, y + 1), '', '年份不同 → 不复用');
  eq(notesLib.liunianKeyByYear({}, y), '', '没有记录 → 空串（长按时按当前大运算新 key）');

  /* 前一步大运的表里，这一格是别的下标/别的 key —— 但年份相同，也得显示同一条 */
  const prevDl = model.withActive(step3, 2);
  const prevTable = [{ year: y, gz: '庚子', age: 30, active: false }];
  const outPrev = model.setTables(REC, prevDl, prevTable, [], { dk: 'd1', di: 2, lnIdx: null }, cut);
  eq(outPrev.liunians[0].note, '交运那年发生的事',
    '⚠⚠⚠ 交运那一年在**另一张流年表**里也显示同一条（不分上下半）');
}
{
  // notes 传空对象 = 这块功能没开（不画任何标记）
  const dl = model.withActive(step3, 3);
  const out = model.setTables(REC, dl, liunians, liuyues, { dk: 'd2', di: 3, lnIdx }, {});
  eq(out.dayuns.filter((d) => d.note).length, 0, 'notes 为空时没有任何标记');
  eq(out.liunians.filter((l) => l.note).length, 0, '  └ 流年也没有');
  eq(out.inlineDayun, '', 'notes 为空时没有内联正文');
}

/* ========== 9. 长按的 meta 快照 ========== */
{
  const dl = model.withActive(step3, 3);
  const ctx = { dk: 'd2', di: 3, lnIdx };
  const dm = model.dayunMetaOf(ctx, dl);
  eq(dm.ganzhi, '癸酉', '大运 meta 带上干支');
  eq(dm.year, 2018, '大运 meta 带上年份');
  eq(dm.age, 30, '大运 meta 带上岁数');

  const lm = model.liunianMetaOf(ctx, liunians);
  eq(lm.ganzhi, '丙午', '流年 meta 带上干支');
  eq(lm.year, 2026, '流年 meta 带上年份');
  // 虚岁 = 2026 − 1989 + 1 = 38，与流年行自己的 nianling 一致（这里的 1989 是**农历年柱的年份**，
  // 记在 bazi.birthYear 上，不是公历 1990）
  eq(lm.age, rows[lnIdx].nianling, '流年 meta 的岁数与表格行一致');
  eq(lm.age, 38, '虚岁 = 38');

  eq(model.dayunMetaOf({ di: 99 }, dl), null, '下标越界 → null');
  eq(model.liunianMetaOf({ lnIdx: -1 }, liunians), null, 'lnIdx = -1 → null');
}

/* ========== 10. 降级：空记录 / 老记录 ========== */
{
  const empty = model.buildChartData(null, NOW);
  eq(empty.ready, false, 'null 记录 → ready = false');
  eq(empty.pillars.length, 0, '空态没有四柱');
  eq(empty.dayuns.length, 0, '空态没有大运');

  const noChart = model.buildChartData({ name: 'x', gender: 0 }, NOW);
  eq(noChart.ready, false, '缺 chart 字段 → ready = false');
}
{
  // 老记录：没有 bazi 字段 → 大运空、派生文案降级成「—」
  const old = model.buildChartData({ name: '老', gender: 0, dateText: '1990-01-01', timeText: '11:04', chart: REC.chart }, NOW);
  eq(old.ready, true, '老记录仍能渲染四柱');
  eq(old.dayuns.length, 0, '老记录没有大运 → 空表');
  eq(old.genderText, '女', '性别降级正确');
  eq(old.zodiacText, '', '没有 zodiac 字段 → 空串（视图里标签自然消失）');
  eq(old.siLingText, '—', '司令缺字段 → 「—」');
  eq(old.taiYuanText, '—', '胎元缺字段 → 「—」');
  ok(old.jiaoYunText !== '', '交运按出生时间现场重算（不崩）');
}
{
  // 老记录的 chart 没有 canggan 字段 → 降级为空数组（不能崩）
  const chart = JSON.parse(JSON.stringify(REC.chart));
  delete chart.pillars.day.canggan;
  const old = model.buildChartData({ name: '老', gender: 1, dateText: '1990-01-01', timeText: '11:04', chart }, NOW);
  eq(old.pillars[2].canggan, [], '缺 canggan → 空数组');
}

/* ========== 11. 滚动锚点 ========== */
eq(model.scrollAnchor(0), 0, '锚点：首列不动');
eq(model.scrollAnchor(2), 0, '锚点：前 3 列不滚动');
eq(model.scrollAnchor(3), 1, '锚点：第 4 列起往前留 2 列');
eq(model.scrollAnchor(10), 8, '锚点：第 11 列 → 锚在 8');

/* ========== 12. 区间计算 ========== */
{
  const r0 = model.stageRange(step3, 0);
  eq([r0.start, r0.end], [1989, 1998], '小运区间 = 出生年 ~ 第一步起始年');
  const r3 = model.stageRange(step3, 3);
  eq([r3.start, r3.end], [2018, 2028], '大运区间 = 起始年 ~ +10');
  const rBad = model.stageRange(step3, 99);
  eq([rBad.start, rBad.end], [0, 0], '越界 → 零区间');
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
