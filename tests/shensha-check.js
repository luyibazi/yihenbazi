/**
 * 神煞自检 —— 不启动模拟器，纯 Node 断言。
 *
 * ⚠⚠ 本文件的核心价值不是「跑通」，而是**用已知盘逐颗对拍**。
 *   神煞最容易出的错是「规则抄错一格」——代码不报错、界面照常显示，只是**结果悄悄错**。
 *   所以每一节都先给「手算依据」，再用断言钉住。
 *
 * 运行：node tests/shensha-check.js
 */

const path = require('path');
const sha = require(path.join(__dirname, '..', 'src', 'core', 'shensha.js'));
const rules = require(path.join(__dirname, '..', 'src', 'core', 'shensha-rules.js'));
const model = require(path.join(__dirname, '..', 'src', 'components', 'chart-view', 'model.js'));
const recordLib = require(path.join(__dirname, '..', 'src', 'core', 'record.js'));

let pass = 0; let fail = 0; const fails = [];

function ok(cond, label) {
  if (cond) pass++; else { fail++; fails.push(label); console.log('FAIL  ' + label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; fails.push(label); console.log('FAIL  ' + label + '  期望 ' + e + '，实际 ' + a); }
}
/** 断言 list 含所有 want 且不含 forbid */
function hasAll(list, want, label) {
  const miss = want.filter((w) => list.indexOf(w) < 0);
  ok(miss.length === 0, label + (miss.length ? '  缺: ' + miss.join(',') : ''));
}
function hasNone(list, forbid, label) {
  const bad = forbid.filter((w) => list.indexOf(w) >= 0);
  ok(bad.length === 0, label + (bad.length ? '  不该有: ' + bad.join(',') : ''));
}

/* ============ 第 1 节：规则表本身的完整性 ============ */

const R = rules.RULES;
/*
 * ⚠ 共 **55** 条：《问真神煞大全》书简介说「共计收录 55 个常用神煞」。
 *   网站目录的渲染脚本只列了 54 项 —— 漏掉的是第 55 章「拱禄」
 *   （要直接抓 3_1_0_55.html 才有）。所以 55 才是真数，不是 54。
 */
eq(R.length, 55, '⚠ 规则表共 55 条（54 个目录项 + 漏渲染的「拱禄」）');

// key 必须唯一（重复 key 会让 buckets 去重时互相吃掉）
const keys = R.map((r) => r.key);
eq(new Set(keys).size, keys.length, '⚠ key 无重复（重复会让两颗星互相覆盖）');

// name 必须唯一
const names = R.map((r) => r.name);
eq(new Set(names).size, names.length, '  name 无重复');

/*
 * ⚠⚠ 显示用**完整名**，不再有 label 短名（用户 2026-10-08：「神煞不要缩写」）。
 *   所以这里断言两件事：① 规则表里**不存在** label 字段（防有人加回来）；
 *   ② name 都是完整名（≥ 2 字，且不短于一套已知的「缩写过」的旧值）。
 *   宽度靠视图**竖排**（一颗一行）消化，不靠缩字 —— 别再用 96rpx 列宽论证缩写。
 */
const hasLabel = R.filter((r) => 'label' in r).map((r) => r.name);
eq(hasLabel, [], '⚠⚠ 规则表不得再有 label（显示一律用完整 name，见用户「不要缩写」）');

const badName = R.filter((r) => !r.name || r.name.length < 2).map((r) => String(r.name));
eq(badName, [], '  每条都有完整 name（≥2 字）');

// 完整名不该比它「该有的」短：抽查几条最容易被人顺手缩写的
const FULL_NAME_SPOT = [
  ['tianYiGuiRen', '天乙贵人'],
  ['wenChang', '文昌贵人'],
  ['tianLuoDiWang', '天罗地网'],
  ['yinChaYangCuo', '阴差阳错'],
  ['hongYan', '红艳煞'],
];
FULL_NAME_SPOT.forEach(([k, full]) => {
  const r = R.find((x) => x.key === k);
  eq(r && r.name, full, '  完整名：' + k + ' = ' + full);
});

// 每条必须有 kind
const noKind = R.filter((r) => !r.kind).map((r) => r.name);
eq(noKind, [], '  每条规则都有 kind');

// 除 custom 外，必须有 map 或 list 或 pick（`derive` 类如天德合是派生值，不算）
const noData = R.filter((r) => r.kind !== 'custom' && !r.derive && !r.map && !r.list && !r.pick).map((r) => r.name);
eq(noData, [], '  非 custom 规则都带了数据（map/list/pick/derive）');

/* ============ 第 2 节：真机盘逐颗对拍（癸未 乙卯 丁未 庚子 · 女） ============ */

/*
 * 手算依据（逐条可复核）：
 *  天乙贵人 日干丁→亥酉 / 年干癸→卯巳；四支 未卯未子 → 卯 ⇒ 月柱
 *  太极贵人 日干丁→酉卯 / 年干癸→巳申 → 卯 ⇒ 月柱
 *  文昌贵人 日干丁→酉 / 年干癸→卯 → 卯 ⇒ 月柱
 *  禄神     日干丁→午；无午 ⇒ 不命中
 *  羊刃     日干丁→未；除日柱外的未 = 年柱 ⇒ 年柱（日柱自己不算，见 applyHits 的「查余支」）
 *  华盖     年支未(亥卯未)→未（含自己）⇒ 年柱；日支未→未 ⇒ 日柱
 *  将星     年支未→卯 ⇒ 月柱
 *  桃花     年支未→子 ⇒ 时柱
 *  血刃     月支卯→未；年月日时里的未 = 年柱 + 日柱
 *  德秀     月支卯(亥卯未)→甲乙丁壬；月干乙、日干丁 ⇒ 月柱 + 日柱
 *  阴差阳错 日柱丁未 在表 ⇒ 日柱
 *  六秀日   日柱丁未 在表 ⇒ 日柱
 *  八专     日柱丁未 在表 ⇒ 日柱
 *  红艳煞   日干丁→未 ⇒ 年柱 + 日柱（未有两处）
 *  天厨贵人 日干丁→午 / 年干癸→卯 ⇒ 月柱
 *  福星贵人 日干丁→亥 / 年干癸→卯丑 ⇒ 月柱
 *  童子煞   月支卯属春 ⇒ 日支或时支见寅/子；时支子 ⇒ 时柱
 */
const PAN_A = [
  { gz: '癸未', nayin: '杨柳木', label: '年柱' },
  { gz: '乙卯', nayin: '大溪水', label: '月柱' },
  { gz: '丁未', nayin: '天河水', label: '日柱' },
  { gz: '庚子', nayin: '壁上土', label: '时柱' },
];
const a = sha.compute(PAN_A, 0);

const at = (r, idx) => r.byPillar[idx].map((s) => s.key);

hasAll(at(a, 0), ['yangRen', 'huaGai', 'hongYan', 'xueRen'], '盘A 年柱：羊刃/华盖/红艳/血刃');
hasAll(at(a, 1), ['tianYiGuiRen', 'taiJiGuiRen', 'wenChang', 'jiangXing', 'tianChu', 'fuXing'],
  '盘A 月柱：贵人/太极/文昌/将星/天厨/福星');
hasAll(at(a, 2), ['huaGai', 'xueRen', 'deXiu', 'yinChaYangCuo', 'liuXiu', 'baZhuan', 'hongYan'],
  '盘A 日柱：华盖/血刃/德秀/差错/六秀/八专/红艳');
hasAll(at(a, 3), ['taoHua', 'tongZi'], '盘A 时柱：桃花/童子');

// 反向：不该出现的
hasNone(a.flat, ['luShen'], '盘A: 禄神不该出现（日干丁→午，四支无午）');
hasNone(a.flat, ['diaoKe'], '盘A: 吊客不该出现（年支未→巳，四支无巳）');
hasNone(a.flat, ['tianDe', 'yueDe'], '盘A: 天德/月德不该出现（月支卯→申/甲，四干无）');
hasNone(a.flat, ['yiMa'], '盘A: 驿马不该出现（年支未→巳 / 日支未→巳，四支无巳）');

// 华盖「含自己」这条是 2026-10-08 专门修的坑 —— 单独立断言钉死
ok(a.byPillar[0].some((s) => s.key === 'huaGai'), '⚠ 华盖含参考支自己（年支未见未 ⇒ 年柱命中）');

/* ============ 第 3 节：第二个盘（己巳 丙子 丙寅 甲午 · 男） ============ */

/*
 *  禄神   日干丙→巳 ⇒ 年柱
 *  亡神   年支巳(巳酉丑)→申 / 日支寅(寅午戌)→巳 ⇒ 时支午? 否；四支 巳子寅午：
 *         日支寅→『wang』= 巳 ⇒ 年柱巳 命中（月/日/时）—— 年柱是参考柱(日支)之外 ⇒ 年柱
 *  天德   月支子→巳（天德在子月是地支巳）⇒ 年柱
 *  德秀   月支子(申子辰)→壬癸戊己丙辛甲；月干丙、日干丙 ⇒ 月柱 + 日柱
 *  天厨   日干丙→巳 / 年干己→酉；巳 ⇒ 年柱
 *  飞刃   日干丙→子；除日柱外的子 = 月柱 ⇒ 月柱
 *  国印   日干丙→丑 / 年干己→寅；寅 ⇒ 日柱
 *  劫煞   年支巳→寅 / 日支寅→亥；寅 ⇒ 日柱
 *  披麻   年支巳→寅 ⇒ 日柱
 *  词馆   年纳音大林木 → 木见寅 ⇒ 日柱寅
 *  福星   年干己→未 / 月干丙→寅子；寅 ⇒ 日柱、子 ⇒ 月柱
 *  羊刃   日干丙→午 ⇒ 时柱
 *  桃花   年支巳→午 / 日支寅→卯；午 ⇒ 时柱
 *  将星   年支巳→酉 / 日支寅→午；午 ⇒ 时柱
 *  血刃   月支子→午 ⇒ 时柱
 *  童子   月支子属冬 ⇒ 日支或时支见卯/未/辰：无；年纳音木→午卯：时支午 ⇒ 时柱
 */
const PAN_B = [
  { gz: '己巳', nayin: '大林木', label: '年柱' },
  { gz: '丙子', nayin: '涧下水', label: '月柱' },
  { gz: '丙寅', nayin: '炉中火', label: '日柱' },
  { gz: '甲午', nayin: '沙中金', label: '时柱' },
];
const b = sha.compute(PAN_B, 1);

hasAll(at(b, 0), ['luShen', 'wangShen', 'tianDe', 'tianChu'], '盘B 年柱：禄神/亡神/天德/天厨');
hasAll(at(b, 1), ['feiRen'], '盘B 月柱：飞刃');
hasAll(at(b, 2), ['guoYin', 'jieSha', 'piMa', 'deXiu', 'ciGuan', 'fuXing'],
  '盘B 日柱：国印/劫煞/披麻/德秀/词馆/福星');
hasAll(at(b, 3), ['yangRen', 'taoHua', 'jiangXing', 'xueRen', 'tongZi'],
  '盘B 时柱：羊刃/桃花/将星/血刃/童子');

/* ============ 第 4 节：固定日柱类（不依赖其他柱，最不易错，也最该钉死） ============ */

const FIXED = [
  { key: 'kuiGang', name: '魁罡', days: ['戊戌', '庚辰', '庚戌', '壬辰'] },
  { key: 'liuXiu', name: '六秀日', days: ['丙午', '丁未', '戊子', '戊午', '己丑', '己未'] },
  { key: 'baZhuan', name: '八专', days: ['甲寅', '乙卯', '丁未', '戊戌', '己未', '庚申', '辛酉', '癸丑'] },
  { key: 'jiuChou', name: '九丑', days: ['丁酉', '戊子', '戊午', '己卯', '己酉', '辛卯', '辛酉', '壬子', '壬午'] },
  { key: 'shiELian', name: '十恶大败', days: ['甲辰', '乙巳', '壬申', '丙申', '丁亥', '庚辰', '戊戌', '癸亥', '辛巳', '己丑'] },
  { key: 'guLuan', name: '孤鸾煞', days: ['甲寅', '乙巳', '丙午', '丁巳', '戊午', '戊申', '辛亥', '壬子'] },
  { key: 'shiLing', name: '十灵日', days: ['甲辰', '乙亥', '丙辰', '丁酉', '戊午', '庚戌', '庚寅', '辛亥', '壬寅', '癸未'] },
];
FIXED.forEach((f) => {
  const rule = R.find((r) => r.key === f.key);
  eq(rule.list, f.days, f.name + ' 日柱列表');
  // 落地：表里每个日柱喂进去都必须命中
  f.days.forEach((day) => {
    const r = sha.compute(['甲子', '乙丑', day, '丙寅'], 1);
    const hitDay = r.byPillar[2].some((s) => s.key === f.key);
    ok(hitDay, f.name + '：日柱 ' + day + ' 必须命中');
  });
  // 反向：随便一个不在表里的日柱不许命中
  const r2 = sha.compute(['甲子', '乙丑', '戊辰', '丙寅'], 1);
  hasNone(r2.byPillar[2].map((s) => s.key), [f.key], f.name + '：日柱戊辰不该命中');
});

/* ============ 第 5 节：金神查日柱**或时柱**（唯一查两处的一颗） ============ */

const js1 = sha.compute(['甲子', '乙丑', '乙丑', '丙寅'], 1);
ok(js1.byPillar[2].some((s) => s.key === 'jinShen'), '金神：日柱乙丑 ⇒ 命中日柱');
const js2 = sha.compute(['甲子', '乙丑', '戊辰', '己巳'], 1);
ok(js2.byPillar[3].some((s) => s.key === 'jinShen'), '金神：时柱己巳 ⇒ 命中时柱');
const js3 = sha.compute(['甲子', '乙丑', '戊辰', '丙寅'], 1);
hasNone(js3.flat, ['jinShen'], '金神：日时都不是乙丑/己巳/癸酉 ⇒ 不命中');

/* ============ 第 5.5 节：拱禄（第 55 章，问真目录漏渲染的那颗） ============ */

/*
 * 古诀：癸亥日癸丑时 / 癸丑日癸亥时（拱子禄）；丁巳日丁未时 / 己未日己巳时（拱午禄）；
 *      戊辰日戊午时（拱巳禄）
 */
ok(sha.compute(['甲子', '乙丑', '癸亥', '癸丑'], 1).flat.indexOf('gongLu') >= 0, '拱禄：癸亥日癸丑时 ⇒ 命中');
ok(sha.compute(['甲子', '乙丑', '戊辰', '戊午'], 1).flat.indexOf('gongLu') >= 0, '拱禄：戊辰日戊午时 ⇒ 命中');
hasNone(sha.compute(['甲子', '乙丑', '癸亥', '甲子'], 1).flat, ['gongLu'], '拱禄：日对时不对 ⇒ 不命中');
hasNone(sha.compute(['甲子', '乙丑', '戊辰', '己未'], 1).flat, ['gongLu'], '拱禄：日时不同干 ⇒ 不命中');

/* ============ 第 6 节：丧门/吊客/披麻（问真网站表格是坏的，我们按权威口径修正） ============ */

/*
 * ⚠⚠ 问真网站这三条的表格三行都写成「丧门」，是复制粘贴 bug。
 *   权威口径（《盲派神煞应用宝典》「丧吊煞」+ 大道家园《神煞禄马赋》，两处一致）：
 *     丧门 = 年支前两位、吊客 = 年支后两位、披麻 = 年支后三位
 *   子年：丧门寅、吊客戌、披麻酉
 */
const snRule = R.find((r) => r.key === 'sangMen');
const dkRule = R.find((r) => r.key === 'diaoKe');
const pmRule = R.find((r) => r.key === 'piMa');
eq(snRule.map['子'], ['寅'], '⚠ 丧门 = 年支前两位（子→寅）');
eq(dkRule.map['子'], ['戌'], '⚠ 吊客 = 年支后两位（子→戌）');
eq(pmRule.map['子'], ['酉'], '⚠ 披麻 = 年支后三位（子→酉）');
// 三条不能是同一张表（问真网站就是这个 bug）
ok(JSON.stringify(snRule.map) !== JSON.stringify(dkRule.map), '⚠ 丧门与吊客的表必须不同（问真网站的修正是重点）');
ok(JSON.stringify(dkRule.map) !== JSON.stringify(pmRule.map), '⚠ 吊客与披麻的表必须不同');
// 12 支全覆盖
eq(Object.keys(snRule.map).length, 12, '  丧门 12 支全覆盖');
eq(Object.keys(dkRule.map).length, 12, '  吊客 12 支全覆盖');
eq(Object.keys(pmRule.map).length, 12, '  披麻 12 支全覆盖');

/* ============ 第 7 节：「查余三支」vs「查余支」的区分（2026-10-08 修的坑） ============ */

/*
 * 华盖/将星在问真原文里是「查**余支**」（含自己），驿马/桃花/劫煞/亡神是「查**余三支**」（排除自己）。
 * 若全按「排除自己」处理 ⇒ 年柱=戌 的盘会整颗漏掉华盖（戌自己就在寅午戌局里）。
 */
ok(R.find((r) => r.key === 'huaGai').includeSelf === true, '⚠ 华盖 includeSelf（问真原文「查余支」）');
ok(R.find((r) => r.key === 'jiangXing').includeSelf === true, '⚠ 将星 includeSelf（问真原文「查余支」）');
ok(!R.find((r) => r.key === 'yiMa').includeSelf, '  驿马不含自己（问真原文「查余三支」）');
ok(!R.find((r) => r.key === 'taoHua').includeSelf, '  桃花不含自己（问真原文「查余三支」）');

/*
 * ⚠⚠⚠ 血刃也必须 includeSelf —— 问真查法原文是「以月支查**四柱干支**」（含月柱自己）。
 *   用户 2026-10-08 报的正是这个：「亥月，月柱直接有血刃，血刃直接可以包含月柱的」。
 *
 * 这里用**古诀自身的结构**给出不依赖原文措辞的证据：
 *   古诀里有「亥月亥」「子月午」「丑月子」三条 —— 尤其 **亥月亥**，
 *   命中的支与参考支**是同一个字**，只能由月柱自己命中。
 *   若排除自己，亥月生人**永远**查不出血刃（正是报障现象）。
 * 反面：寅月查丑不是同字，所以「含自己」不会让寅月盘误判（下面正向验一遍）。
 */
ok(R.find((r) => r.key === 'xueRen').includeSelf === true,
  '⚠⚠⚠ 血刃 includeSelf（问真「以月支查四柱干支」；古诀「亥月亥」只能由月柱自己命中）');

// 正向：亥月的月柱自己命中血刃（这是用户报障的那个 case）
const HAI = [{ gan: '甲', zhi: '子' }, { gan: '乙', zhi: '亥' }, { gan: '丙', zhi: '寅' }, { gan: '丁', zhi: '卯' }];
const haiRes = sha.compute(HAI, 1);
ok(haiRes.byPillar[1].some((s) => s.key === 'xueRen'),
  '⚠⚠ 亥月（亥月的血刃=亥）⇒ **月柱自己**命中血刃');
ok(!haiRes.byPillar[0].some((s) => s.key === 'xueRen')
  && !haiRes.byPillar[2].some((s) => s.key === 'xueRen')
  && !haiRes.byPillar[3].some((s) => s.key === 'xueRen'),
  '  └ 同盘其余三柱无亥 ⇒ 不误判');

// 反向：寅月（血刃=丑，与月支不同字）⇒ 含自己**不会**让月柱误判，
//       丑落在别的柱上照样命中（说明 includeSelf 只影响「同字自查」，没有放宽判定）
const YIN = [{ gan: '甲', zhi: '丑' }, { gan: '乙', zhi: '寅' }, { gan: '丙', zhi: '寅' }, { gan: '丁', zhi: '卯' }];
const yinRes = sha.compute(YIN, 1);
ok(!yinRes.byPillar[1].some((s) => s.key === 'xueRen'),
  '  └ 寅月（血刃=丑）月柱自己不误判血刃');
ok(yinRes.byPillar[0].some((s) => s.key === 'xueRen'),
  '  └ 寅月的丑落在年柱 ⇒ 照常命中（includeSelf 没放宽判定）');

// 十二个月逐个走一遍：至少「亥月亥 / 子月午 / 丑月子」三条同字自查必须真的能出
const XUE_REN_MAP = R.find((r) => r.key === 'xueRen').map;
[['亥', '亥'], ['子', '午'], ['丑', '子']].forEach(([mz, target]) => {
  // 月支 = mz，并把 target 摆在月柱上（若 target === mz 就是月柱自己）
  const ps = [{ gan: '甲', zhi: '寅' }, { gan: '乙', zhi: mz }, { gan: '丙', zhi: '寅' },
    { gan: '丁', zhi: target === mz ? '卯' : target }];
  const rr = sha.compute(ps, 1);
  ok(rr.flat.indexOf('xueRen') >= 0, `  └ ${mz}月见「${target}」⇒ 命中血刃（古诀自查条目）`);
});
eq(XUE_REN_MAP['亥'], ['亥'], '  血刃 亥月 → 亥（古诀，同字自查）');

/*
 * ⭐ 把上面的教训**升格成通用断言**：凡 map 里出现「同字条目」（map[X] 含 X，
 *   即「X 见 X」这种自查），就**必须** includeSelf —— 否则那条自查永远命中不了
 *   （computeCore 的 applyHits 默认排除参考柱自己）。
 * ⚠ 这条是「同类 bug 的通用防线」：以后新增规则时若抄进一条同字条目却忘了 includeSelf，
 *   这里会立刻报红，不需要再靠人眼逐条看古诀。
 */
const selfSameNoFlag = R.filter((r) => {
  if (r.kind === 'custom' || r.kind === 'dayPillar' || !r.map) return false;
  return Object.keys(r.map).some((k) => (r.map[k] || []).indexOf(k) >= 0) && !r.includeSelf;
}).map((r) => r.name);
eq(selfSameNoFlag, [],
  '⚠⚠ 凡 map 含「同字条目」的规则都必须 includeSelf（否则自查条目永远命中不了）');

/* ============ 第 8 节：年纳音三颗（学堂/词馆/童子）依赖 nayin ============ */

/*
 * ⚠ nayin 缺了这三颗会**静默不出**（不报错）—— 必须显式钉住。
 */
const xr = R.find((r) => r.key === 'xueTang');
ok(!!xr, '  学堂规则存在');
// 金命见巳：年柱纳音为金、其他柱有巳 ⇒ 命中
const xt1 = sha.compute(
  [{ gz: '甲子', nayin: '海中金' }, { gz: '乙丑' }, { gz: '丙寅' }, { gz: '丁巳' }], 1);
ok(xt1.byPillar[3].some((s) => s.key === 'xueTang'), '学堂：年纳音金 + 时支巳 ⇒ 命中');
// 不给 nayin ⇒ 不出（静默降级，是可接受行为，但不能是「出了一半」）
const xt2 = sha.compute(['甲子', '乙丑', '丙寅', '丁巳'], 1);
hasNone(xt2.flat, ['xueTang', 'ciGuan'], '⚠ 缺 nayin 时学堂/词馆静默不出（不报错、不出半成品）');

/* ============ 第 9 节：性别相关（元辰：阳男阴女 +7 / 阴男阳女 +5） ============ */

/*
 * ⚠⚠ 古诀：「阳男阴女★子年未（+7）；阴男阳女★子年巳（+5）」
 *   这里的「阳阴」指**年干的阴阳**，不是性别：
 *     阳男 = 年干阳 + 男 → +7  ｜ 阴女 = 年干阴 + 女 → +7
 *     阴男 = 年干阴 + 男 → +5  ｜ 阳女 = 年干阳 + 女 → +5
 *   ⇒ 甲子年（甲=阳）配**女**是「阳女」⇒ +5 ⇒ 子+5=巳
 *   2026-10-08 这条最初被理解反（以为「女」就够了），是断言先报红才揪出来的。
 */
// 阳男：甲子年 + 男 → +7 → 子+7=未
ok(sha.compute(['甲子', '乙丑', '丙寅', '丁未'], 1).flat.indexOf('yuanChen') >= 0,
  '元辰：阳男（甲子年+男）子+7=未 ⇒ 命中');
// 阳女：甲子年 + 女 → +5 → 子+5=巳
ok(sha.compute(['甲子', '乙丑', '丙寅', '丁巳'], 0).flat.indexOf('yuanChen') >= 0,
  '⚠ 元辰：阳女（甲子年+女）走 +5 ⇒ 子+5=巳 命中');
hasNone(sha.compute(['甲子', '乙丑', '丙寅', '丁未'], 0).flat, ['yuanChen'],
  '⚠ 元辰：阳女不该走 +7（未不该命中）');
// 阴年对照：乙丑年（乙=阴）
ok(sha.compute(['乙丑', '乙丑', '丙寅', '戊午'], 1).flat.indexOf('yuanChen') >= 0,
  '元辰：阴男（乙丑年+男）走 +5 ⇒ 丑+5=午 命中');
ok(sha.compute(['乙丑', '乙丑', '丙寅', '庚申'], 0).flat.indexOf('yuanChen') >= 0,
  '元辰：阴女（乙丑年+女）走 +7 ⇒ 丑+7=申 命中');

/* ============ 第 10 节：接入层（model.buildPillarRows 的 shensha 行） ============ */

const REC = recordLib.create('测试', 0, '2003-04-03', '23:30');
const data = model.buildChartData(REC, 2026);
ok(data.shenshaByPillar.length === 4, '  buildChartData 产出 4 柱神煞');

const rows = model.buildPillarRows(data.pillars, data.selCards, data.shenshaByPillar);
const shaRow = rows.find((r) => r.key === 'shensha');
ok(!!shaRow, '  行式表格有「神煞」行');
eq(shaRow.label, '神煞', '  └ 行头文字');
eq(shaRow.cells.length, rows[0].cells.length, '⚠ 神煞行 cells 长度与其它行一致（对齐机制）');
shaRow.cells.forEach((c, i) => eq(c.kind, 'shensha', `  └ 第 ${i} 格 kind=shensha`));

// 没有神煞的柱给空 items（不是 undefined —— 视图 map 会炸）
const noSha = model.buildPillarRows(data.pillars, data.selCards, null);
const noShaRow = noSha.find((r) => r.key === 'shensha');
noShaRow.cells.forEach((c, i) => eq(c.items, [], `  └ 缺神煞数据时第 ${i} 格 items=[]（不是 undefined）`));

/*
 * ⚠⚠ 运卡格也有神煞了（用户 2026-10-08：「大运流年流月也要显示神煞」）。
 *
 * ⚠⚠⚠ 必须走 **setTables**（真实路径），不能用 buildChartData 的 selCards ——
 *   后者**恒为空数组**（卡是 setTables 里从三张表推导的），
 *   用它测就会「cards.length === 0 ⇒ 整段跳过」⇒ 一条没测还全绿。
 *   （2026-10-08 探针发现的：把运卡 shensha 写死 [] 也照样 164 PASS。）
 *   这里模拟 App：选第 1 步大运 → 建流年 → 建流月 → setTables。
 */
const marked0 = model.decorate(data.dayuns, [], [], {}, null);
const dn = model.withActive(marked0.dayuns, 1);
const { rows: lnRows, lnIdx } = model.computeDayunRows(REC, dn, 1, 2026);
const lns = model.buildLiunians(lnRows, lnIdx);
const lys = lnIdx >= 0 ? model.buildLiuyues(lnRows[lnIdx]) : [];
const tables = model.setTables(REC, dn, lns, lys, { dk: dn[1] && dn[1].key, di: 1, lnIdx }, null);
const cards = tables.selCards || [];
ok(cards.length >= 2, '  setTables 产出了运卡（≥2：大运 + 流年）');

const rows2 = model.buildPillarRows(data.pillars, cards, data.shenshaByPillar);
const shaRow2 = rows2.find((r) => r.key === 'shensha');
const tail = shaRow2.cells.slice(4);
eq(tail.length, cards.length, '  └ 运卡神煞格数量 = 卡数');
tail.forEach((c, i) => {
  const expect = (cards[i].shensha || []).map((s) => s.name);
  eq(c.items, expect, `  └ ${cards[i].label} 格 items = 卡上 shensha（透传，不是写死空数组）`);
});
// 卡上真的算出了神煞（否则「透传」是空对空、断言等于没测）
const anyNonEmpty = cards.some((c) => (c.shensha || []).length > 0);
ok(anyNonEmpty, '  └ 至少一张运卡带神煞（证明运限神煞真的算出来了，不是恒空）');

// 小运（无干支）那张卡的神煞必须是空数组 —— 不能喂进 tyme
const dn0 = model.withActive(marked0.dayuns, 0); // 0 号位 = 起运前小运
if (dn0[0] && dn0[0].gz === '小运') {
  const t0 = model.setTables(REC, dn0, [], [], { di: 0 }, null);
  const xiao = t0.selCards.find((c) => c.label === '小运');
  ok(!!xiao, '  └ 0 号位是小运卡');
  eq(xiao.shensha, [], '⚠ 小运卡神煞 = []（无干支，绝不能喂进 tyme）');
} else {
  ok(true, '  └ （0 号位不是小运，跳过失断言）');
}

// model 里必须有 try/catch 降级（神煞抛错不能白屏）——本命与运限各一处
const fs = require('fs');
const modelSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'chart-view', 'model.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
ok(/try\s*\{[^}]*shenshaLib\.compute\(/.test(modelSrc), '⚠ 本命神煞计算包了 try/catch（抛错不白屏）');
ok(/try\s*\{[^}]*shenshaLib\.computeForColumn/.test(modelSrc), '⚠ 运限神煞计算也包了 try/catch');

// 视图必须**竖排**（用户「不要两个并列」）+ 用完整名（用户「不要缩写」）
const strip = (f) => fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'chart-view', f), 'utf8')
  .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const viewSrc = strip('QiDingPage.tsx');
/* ⚠ 平气法页现在是**空壳**（不画盘），所以这里只对定气法页断言神煞排法。 */
ok(/shaWrap:\s*\{[^}]*flexDirection:\s*'column'/.test(viewSrc),
  '⚠⚠ 神煞格是**竖排**（flexDirection: column）—— 用户「不要两个并列」');
ok(!/shaWrap:\s*\{[^}]*flexWrap/.test(viewSrc),
  '⚠⚠ 神煞格**不许** flexWrap（横向并排 = 用户明确否掉的排法）');
ok(/shaChip:\s*\{[^}]*fontSize:\s*rpx\(SIZES\.smallCellSize\)/.test(viewSrc),
  '  神煞字号用 smallCellSize（竖排完整名要放得下「天乙贵人」）');

/* ============ 第 10.5 节：运限神煞（computeForColumn） ============ */

/*
 * 口径：问真「岁运逢之」—— 把运柱**放进原局一起查**，运柱身上命中的星就是这步运的神煞。
 * ⚠⚠ 三条最容易写错、且错了不报错的：
 *   ① 运柱**不当参考位**（否则一步大运就把全局驿马/桃花参考位改掉，四柱那行跟着变）
 *   ② 运柱**要当靶子**（否则算出来恒空）
 *   ③ 日柱固定类（魁罡/十恶/九丑…）**不认运柱**（那是出生决定的，不能靠走运补上）
 * 用手算可复核的盘钉死（原局：癸未 乙卯 丁未 庚子 · 女）。
 */
const P_A = [
  { gan: '癸', zhi: '未' }, { gan: '乙', zhi: '卯' },
  { gan: '丁', zhi: '未' }, { gan: '庚', zhi: '子' },
];

// ① 运柱甲子：年支未(亥卯未)→ 桃花=子、灾煞=子 ⇒ 两颗都落在运支「子」上
const cJiaZi = sha.computeForColumn(P_A, '甲子', 0);
const jzNames = cJiaZi.map((s) => s.name);
ok(jzNames.indexOf('桃花') >= 0, '  运柱甲子：子为年支未的桃花（亥卯未→子）⇒ 命中桃花');
ok(jzNames.indexOf('灾煞') >= 0, '  └ 同局灾煞也在子 ⇒ 命中灾煞');
// 月支卯 → 月德贵人在甲 ⇒ 运干甲命中
ok(jzNames.indexOf('月德贵人') >= 0, '  └ 卯月的月德贵人是甲 ⇒ 运干甲命中月德贵人');

// ② 运柱丙午：日干丁 → 禄神在午 ⇒ 命中
const P_B = P_A;
ok(sha.computeForColumn(P_B, '丙午', 0).map((s) => s.name).indexOf('禄神') >= 0,
  '  运柱丙午：日干丁的禄神在午 ⇒ 命中禄神');

// ③ 魁罡/十恶/九丑等日柱固定类**不认运柱**：造一个日柱「戊戌」的原局（真魁罡），
//    运柱再摆一个魁罡日（如庚辰）也不该把魁罡挂到运上
const P_KO = [
  { gan: '甲', zhi: '子' }, { gan: '丙', zhi: '寅' },
  { gan: '戊', zhi: '戌' }, { gan: '庚', zhi: '申' },
];
const kuigangY = sha.computeForColumn(P_KO, '庚辰', 1).map((s) => s.name);
ok(kuigangY.indexOf('魁罡') < 0, '⚠ 运柱是魁罡日也**不算**运限魁罡（日柱固定类不认运柱）');
// 反证：本命日柱戊戌确实是魁罡（说明上面不是因为「魁罡规则坏了」才不出现）
ok(sha.compute(P_KO, 1).byPillar[2].map((s) => s.name).indexOf('魁罡') >= 0,
  '  └ 该盘本命日柱戊戌确实是魁罡（反证规则本身是好的）');

// ④ 非干支输入一律 []（大运首列「小运」、未选中流月、单字）
eq(sha.computeForColumn(P_A, '', 0), [], '  空干支 → []（不抛错）');
eq(sha.computeForColumn(P_A, '小运', 0), [], '  「小运」→ []（无干支，绝不能喂进 tyme）');
eq(sha.computeForColumn(P_A, '甲', 0), [], '  单字 → []');

// ⑤ 运限神煞**不影响**本命四柱的神煞（参考位只取前 4 柱）
const baseFlat = sha.compute(P_A, 0).flat.slice().sort().join(',');
const withYun = sha.computeForColumn(P_A, '庚申', 0); // 庚申是驿马/劫煞的强触发支
ok(withYun.length > 0, '  运柱庚申命中若干颗（非空，说明它确实在算）');
eq(sha.compute(P_A, 0).flat.slice().sort().join(','), baseFlat,
  '⚠⚠ 算过运限之后**本命四柱的神煞一模一样**（运柱不当参考位）');

/* ============ 第 11 节：54 颗都能被真实盘触发（防止「写了但永远不可能命中」的死规则） ============ */

/*
 * ⚠ 这一节的价值：如果某条规则的 map 写错了 key（比如把「甲」写成「申」），
 *   它永远不会命中 —— 平时看不出来，只在特定盘上「少了那颗星」。
 *   这里用一批盘跑，检查每颗星**至少被触发过一次**。
 * 说明：不追求 54 颗全覆盖（部分神煞极罕见，如三奇贵人要求三干顺连），
 *  但要求覆盖到绝大多数；未覆盖的列出来人工确认规则本身是否可达。
 */
const SEEDS = [
  ['2003-04-03', '23:30', 0], ['1990-01-01', '11:04', 1],
  ['1984-02-02', '08:00', 1], ['1976-06-15', '14:30', 0],
  ['1965-11-20', '03:15', 1], ['1958-09-09', '19:00', 0],
  ['2001-01-24', '06:45', 1], ['1999-12-31', '22:10', 0],
  ['1970-07-07', '12:00', 1], ['1988-03-18', '05:20', 0],
];
const covered = new Set();
SEEDS.forEach(([d, t, g]) => {
  const rec = recordLib.create('s', g, d, t);
  const dd = model.buildChartData(rec, 2026);
  (dd.shenshaByPillar || []).forEach((list) => list.forEach((s) => covered.add(s.key)));
});
const allKeys = R.map((r) => r.key);
const uncovered = allKeys.filter((k) => !covered.has(k));
ok(covered.size >= 30, '  10 个盘至少覆盖 30 颗（实际 ' + covered.size + '/54）');
console.log('  ℹ 本轮未覆盖（规则可达但需特定盘）：' + (uncovered.join(' ') || '（全覆盖）'));

/* ============ 第 12 节：**每颗都必须可达**（定向构造，不靠随机种子碰运气） ============ */

/*
 * ⚠⚠ 这一节是本节最有价值的断言。第 11 节用 10 个真实盘只覆盖到 30+ 颗 ——
 *   剩下 20 颗「规则写了但碰不到」。碰不到的原因有两种，危害完全不同：
 *     ① 规则罕见（如三奇要求三干顺连）—— 正常，但必须证明它**可达**；
 *     ② map 的 key 写错（如把「甲」写成「申」）—— 这颗星**永远不会出现**，
 *        平时完全看不出来，只在特定盘上「莫名少一颗」。
 *   所以这里对第 11 节未覆盖的每颗，**定向构造一个必须命中的盘**。
 */
const TARGETED = [
  // [说明, 四柱, 性别, 必须命中的 key]
  ['灾煞 年支子(申子辰)→午', ['甲子', '乙丑', '丙寅', '戊午'], 1, 'zaiSha'],
  ['天喜 年支子→酉', ['甲子', '乙丑', '丙寅', '辛酉'], 1, 'tianXi'],
  ['吊客 年支子→戌', ['甲子', '乙丑', '丙寅', '甲戌'], 1, 'diaoKe'],
  // 天德合：月支寅的天德是丁，丁的五合是壬 ⇒ 壬 落某干即命中
  ['天德合 月支寅(天德丁)→壬', ['壬寅', '壬寅', '丙寅', '甲午'], 1, 'tianDeHe'],
  ['天转 寅月+乙卯日', ['甲寅', '丙寅', '乙卯', '己卯'], 1, 'tianZhuan'],
  ['地转 寅月+辛卯日', ['甲寅', '丙寅', '辛卯', '辛卯'], 1, 'diZhuan'],
  ['十灵日 日柱甲辰', ['甲子', '乙丑', '甲辰', '丙寅'], 1, 'shiLing'],
  ['天赦 寅月+戊寅日', ['甲寅', '丙寅', '戊寅', '甲寅'], 1, 'tianShe'],
  // 三奇：天上三奇甲戊庚，须年月日 或 月日时顺连
  ['三奇贵人 甲戊庚顺连(年月日)', ['甲子', '戊辰', '庚午', '丙子'], 1, 'sanQi'],
  // 天罗地网：戌见亥
  ['天罗地网 戌亥同现', ['甲戌', '乙亥', '丙寅', '丁卯'], 1, 'tianLuoDiWang'],
  ['天罗地网 辰巳同现', ['甲辰', '乙巳', '丙寅', '丁卯'], 1, 'tianLuoDiWang'],
  ['金神 日柱乙丑', ['甲子', '乙丑', '乙丑', '丙寅'], 1, 'jinShen'],
];
TARGETED.forEach(([desc, ps, g, key]) => {
  const r = sha.compute(ps, g);
  ok(r.flat.indexOf(key) >= 0, '可达性：' + desc);
});

/* ============ 第 13 节：55 颗全部可达（合起来数） ============ */

/*
 * 把第 11 节的真实盘 + 第 12 节的定向盘合起来，要求 **55 颗全部至少命中一次**。
 * ⚠ 这条断言的作用：以后有人改规则表把某个 map 改坏（key 打错、值写漏），
 *   它会立刻报红并列出「哪颗不可达」—— 这是防止「死规则」的唯一网。
 */
const ALL_REACHED = new Set(covered);
TARGETED.forEach(([, ps, g]) => {
  sha.compute(ps, g).flat.forEach((k) => ALL_REACHED.add(k));
});
// 固定日柱类（第 4 节已逐个验证，这里补进集合）
FIXED.forEach((f) => f.days.forEach((day) => {
  sha.compute(['甲子', '乙丑', day, '丙寅'], 1).flat.forEach((k) => ALL_REACHED.add(k));
}));
// 拱禄（第 5.5 节）
sha.compute(['甲子', '乙丑', '癸亥', '癸丑'], 1).flat.forEach((k) => ALL_REACHED.add(k));
sha.compute(['甲子', '乙丑', '戊辰', '戊午'], 1).flat.forEach((k) => ALL_REACHED.add(k));

const neverReached = allKeys.filter((k) => !ALL_REACHED.has(k));
eq(neverReached, [], '⚠⚠ 55 颗神煞全部可达（不可达 = map 写错成死规则）');

/* ============ 汇总 ============ */

console.log('');
console.log(pass + ' PASS / ' + fail + ' FAIL');
if (fail) {
  console.log('\n失败清单：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
