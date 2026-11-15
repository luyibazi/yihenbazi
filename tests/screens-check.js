/**
 * 五个页面的**纯计算层**自检
 *
 * ⚠ 存在理由：这五页真正的难点不是「画得对不对」，而是那些**埋在 setData 调用里的
 *   分支与文案** —— 三态映射、闸门、白名单、顺序。它们不上模拟器验不了，
 *   所以被拆进各页的 model.js / content.js，在这里直接断言。
 *
 * 覆盖：
 *   · records/model.js  —— withSummary 保留 notes、pullStateOf 三态、
 *                          shouldReload 版本号闸门、toHandoff 剥派生字段
 *   · paipan/model.js   —— cloudStateOf 四态、dtOf 的「四柱降级成公历」、
 *                          switchCalendar 校验、applyGzPick 顺序、gateOnIdentity
 *   · result/model.js   —— loadPlanOf 的三来路 + **两道短路**、savedOf 由来路、
 *                          saveStateOf 三支失败、noteItemOf 白名单与「清空=删除」、
 *                          nextTab 忽略未知 key、gateOf 三种 mode
 *   · settings/content.js —— 条数与逐字文案（含 n3 不再提抖音云）
 *     ⚠ `study/content.js`（老学堂知识卡）2026-10-21 已随「清理废弃学堂代码」删除，
 *       这里不再断言它 —— 文件没了还留着断言，跑起来就是 MODULE_NOT_FOUND。
 *
 * 跑法：node tests/screens-check.js
 */
globalThis.window = globalThis;

const path = require('path');
const ROOT = path.join(__dirname, '..');

const recordsModel = require(path.join(ROOT, 'src', 'screens', 'records', 'model.js'));
const paipanModel = require(path.join(ROOT, 'src', 'screens', 'paipan', 'model.js'));
const resultModel = require(path.join(ROOT, 'src', 'screens', 'result', 'model.js'));
const tabsModel = require(path.join(ROOT, 'src', 'screens', 'tabs', 'model.js'));
const studyModel = require(path.join(ROOT, 'src', 'screens', 'study', 'model.js'));
const storeMode = require(path.join(ROOT, 'src', 'core', 'storeMode.js'));
const settingsContent = require(path.join(ROOT, 'src', 'screens', 'settings', 'content.js'));
const loginModel = require(path.join(ROOT, 'src', 'screens', 'login', 'model.js'));
const loginContent = require(path.join(ROOT, 'src', 'screens', 'login', 'content.js'));
const recordLib = require(path.join(ROOT, 'src', 'core', 'record.js'));
const notesLib = require(path.join(ROOT, 'src', 'core', 'notes.js'));

let pass = 0;
let fail = 0;
const fails = [];

function ok(cond, label, detail) {
  if (cond) { pass++; }
  else {
    fail++; fails.push(label);
    console.log('FAIL  ' + label + (detail === undefined ? '' : '  （' + detail + '）'));
  }
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
/* ⚠ `eq` **不许兼职表达「不等于」** —— 写成 `eq(a === b, false)` 时，
   失败信息只会说「期望 false，实际 true」，看不出到底哪里撞了。 */
function neq(actual, unexpected, label) {
  const a = JSON.stringify(actual);
  const u = JSON.stringify(unexpected);
  if (a !== u) { pass++; }
  else {
    fail++; fails.push(label);
    console.log('FAIL  ' + label + '  不该等于 ' + u);
  }
}

/* 固定锚点：1990-01-01 11:04 男（与 test.js / chart-view-check.js 一致） */
const LIGHT = { id: 'c1', name: '测试', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 1000 };
const RICH = recordLib.hydrate(LIGHT);

/* ================================================================
 * 一、records/model.js
 * ================================================================ */
console.log('\n--- records/model.js ---');

/* --- withSummary：可选字段必须原样跟着走 --- */
{
  const withNotes = recordsModel.withSummary({
    ...LIGHT, notes: { 'dayun:d0': { text: '换工作' } },
  });
  ok(!!withNotes.notes, 'withSummary 保留 notes（否则「点开一条」是空的）');
  eq(withNotes.notes['dayun:d0'].text, '换工作', 'notes 内容原样带过');

  const bare = recordsModel.withSummary(LIGHT);
  ok(!('notes' in bare), '没有 notes 时不凭空造一个');
  eq(bare.fourChars.length, 4, '列表要四柱四字摘要');
  eq(bare.fourChars, RICH.chart.fourChars, '四柱摘要与整盘一致');
  ok(bare.lunarText && bare.lunarText !== '—', '农历文案已算出');
  eq(bare.id, 'c1', 'id 原样');
  eq(bare.createdAt, 1000, 'createdAt 原样（列表排序靠它）');
}

/* --- withSummary：算不出来时必须降级成「—」，不能抛错、更不能崩 --- */
{
  /* ⚠ 找出真正会失败的输入不容易（踩过两次）：
     · time.parseDate 认不出的串一律给 {y:1000} —— 那是**合法**年份，排得出来；
       对 0 / null / undefined / {} / [] 也一样给 1000，所以「传了个怪值」并不会失败。
     · chart.paipan 对 3000 / 9999 年也照样算（lunar 侧到 9999 年都认）。
     真正会抛的只有**年月越界**：月份 13 → 「illegal solar month: 13」。
     所以降级分支的守卫就用它 —— 这条才是那条 catch 真正存在的理由。 */
  const badMonth = recordsModel.withSummary({ id: 'x', name: '坏', gender: 1, date: '1990-13-01', time: '11:04' });
  eq(badMonth.fourChars, ['—', '—', '—', '—'], '月份越界 → 四柱退化成四个「—」（不抛错）');
  eq(badMonth.lunarText, '—', '月份越界 → 农历退化成「—」');
  eq(badMonth.id, 'x', '降级了也还是先把 id 带出去（列表能渲染出一行）');
  eq(badMonth.name, '坏', '降级不影响其它字段');
  eq(badMonth.gender, 1, '降级不影响性别');

  /* 反向：解析不出年份的串**不该**触发降级（parseDate 会补 1000，那是合法年份）——
     记下来免得下次又以为「传 'abc' 就该退化成 —」。 */
  const abc = recordsModel.withSummary({ id: 'z', name: '串', gender: 1, date: 'abc', time: '11:04' });
  ok(abc.fourChars[0] !== '—', '认不出的日期串会被 parseDate 补成 y=1000 → 照常算出四柱（不是降级）');
}

/* --- toHandoff：必须剥掉派生字段，但保留 notes --- */
{
  const item = recordsModel.withSummary({ ...LIGHT, notes: { 'dayun:d0': { text: '甲' } } });
  const handoff = recordsModel.toHandoff(item);
  ok(!('fourChars' in handoff), 'toHandoff 剥掉 fourChars（列表专用派生字段）');
  ok(!('lunarText' in handoff), 'toHandoff 剥掉 lunarText');
  ok(!!handoff.notes, 'toHandoff **保留** notes');
  eq(handoff.date, '1990-01-01', 'toHandoff 保留出生公历');
  const nullHandoff = recordsModel.toHandoff({ id: 'y', name: '缺时间', gender: 1 });
  eq(nullHandoff, null, '出生信息不全 → toHandoff 返回 null（不猜默认值）');
}

/* --- pullStateOf：三态 --- */
{
  eq(recordsModel.pullStateOf({ ok: true, records: [] }).state, 'ok', '拉取成功 → ok');
  eq(recordsModel.pullStateOf({ ok: false, reason: 'no-login' }).state, 'skip', '没标识 → skip（不是「没有记录」）');
  ok(/未登录/.test(recordsModel.pullStateOf({ ok: false, reason: 'no-login' }).text), 'skip 的文案点明是未登录');
  eq(recordsModel.pullStateOf({ ok: false, reason: 'cloud-error' }).state, 'fail', '断网 → fail');
  eq(recordsModel.pullStateOf(null).state, 'fail', '结果整个没了 → fail（绝不退化成 ok）');
  ok(/重试/.test(recordsModel.pullStateOf({ ok: false, reason: 'cloud-error' }).text), 'fail 的文案里有「重试」');
}

/* --- pullActionOf：拉取态那一条点了做什么（⚠ skip 必须可行动） --- */
{
  eq(recordsModel.pullActionOf({ state: 'fail' }), 'retry', '断网 → 重试');
  /* ⚠⚠ 这条是本轮新加的守卫：skip（未登录）以前**完全不显示**，
     未登录的人只看到一个空列表，根本不知道该去登录。 */
  eq(recordsModel.pullActionOf({ state: 'skip' }), 'login', '未登录 → 去登录（不是静默）');
  eq(recordsModel.pullActionOf({ state: 'ok' }), 'none', '成功 → 不显示那一条');
  eq(recordsModel.pullActionOf({ state: 'loading' }), 'none', '加载中 → 不显示那一条');
  eq(recordsModel.pullActionOf({ state: 'idle' }), 'none', 'idle → 不显示那一条');
  eq(recordsModel.pullActionOf(null), 'none', '没有 pull 态时不崩');
}

/* --- emptyTipOf --- */
{
  eq(recordsModel.emptyTipOf({ state: 'loading' }), '正在从云端同步…', '同步中说的是「在等」');
  eq(recordsModel.emptyTipOf({ state: 'ok' }), '排盘后在结果页点「保存到记录」', '否则说怎么才能有记录');
  eq(recordsModel.emptyTipOf(null), '排盘后在结果页点「保存到记录」', '没有 pull 态时不崩');
  /* ⚠ 未登录时空态下面那句不能还说「排盘后点保存」—— 那跟「去登录」是两件事，
     用户按它做了也存不进去（保存需要 uid）。 */
  ok(/登录/.test(recordsModel.emptyTipOf({ state: 'skip' })), '未登录的空态提示指向「登录」');
}

/* --- shouldReload：版本号闸门 --- */
{
  ok(recordsModel.shouldReload(undefined, 0), '从没拉过 → 要拉');
  ok(!recordsModel.shouldReload(3, 3), '版本号没变 → **不拉**（通知栏下拉不该全量重拉）');
  ok(recordsModel.shouldReload(3, 4), '版本号变了 → 要拉');
  ok(recordsModel.shouldReload(4, 3), '版本号倒着变也要拉（不做大小比较，只比相等）');
}

/* --- 下拉刷新：带什么参数、带什么选项 --- */
{
  /* ⚠⚠ 下拉是「刷新我正看着的这张列表」，**不是**「把筛选清掉」——
     打了筛选之后下拉，必须还按那个条件查 */
  const empty = recordsModel.emptyFilter();
  const withCat = recordsModel.toggleChar(empty, 'dayGan', '甲');

  const q1 = recordsModel.refreshQuery(empty, '');
  eq(JSON.stringify(q1.query), '{}', '没筛选时下拉 → 查询参数是空对象（= 拉全量）');
  eq(q1.filtered, false, '  └ 且 filtered 为 false');

  const q2 = recordsModel.refreshQuery(withCat, '');
  eq(q2.query.dayGan, '甲', '⚠⚠ 有干支筛选时下拉 → **仍然带上**那个筛选（下拉不清条件）');
  eq(q2.filtered, true, '  └ 且 filtered 为 true');

  const q3 = recordsModel.refreshQuery(empty, '张三');
  eq(q3.query.name, '张三', '⚠⚠ 有姓名查询时下拉 → 同样带上那个关键词');

  const q4 = recordsModel.refreshQuery(withCat, '张三');
  eq(q4.query.dayGan, '甲', '干支 + 姓名同时有时，下拉两个都带 ①');
  eq(q4.query.name, '张三', '干支 + 姓名同时有时，下拉两个都带 ②');

  /* ⚠⚠ 下拉**不清筛选** —— 这条是最容易写错的地方：
     若 refreshQuery 返回空对象（或视图里下拉走的是 `emptyFilter()`），
     用户下拉一次就会发现自己勾的筛选没了 */
  eq(recordsModel.refreshQuery(withCat, '张三').query.dayGan, '甲',
     '⚠⚠⚠ 下拉**绝不**清掉已有的筛选（下拉 = 重查，不是重置）');

  /* ⚠ 与「带筛选重拉」的 keepTotal 相反：下拉要把总条数也刷新 */
  eq(recordsModel.refreshOpts().keepTotal, false,
     '⚠ 下拉要刷新「共 N 例」的分母（keepTotal:false）——'
     + '另一台设备删了记录、下拉一下，计数必须跟着变，不能钉在旧数字上');
}

/* ================================================================
 * 一之二、筛选（★ 过滤在服务端，model 只维护状态 + 拼参数）
 * ================================================================
 * ⚠ 这一段的每一条都对着一个「静默失效」的坑：
 *   · 空集合必须是「全部」而不是「什么都不显示」
 *   · 空集合不许产出查询键（否则等于告诉服务端「我要筛空」）
 *   · 只改一类别不许动到别的（浅拷贝漏了就会「点一个、别的全清」）
 *   · 「共 N 例」的分母不许用筛后的数字（那是会骗人的）
 */
console.log('\n--- records/model.js：筛选 ---');
{
  /* ① 选项表本身：八个类别、顺序、字符集 —— 与服务端 recordFilter.ts 对应 */
  ok(recordsModel.FILTER_CATS.length === 8, '八个筛选类别（四柱 × 干/支）');
  eq(
    recordsModel.FILTER_CATS.map((c) => c.param).join(','),
    'yearGan,yearZhi,monthGan,monthZhi,dayGan,dayZhi,hourGan,hourZhi',
    '⚠ 类别顺序 = 年→月→日→时、每柱先干后支（与服务端 FILTER_CATS 逐项对应）'
  );
  recordsModel.FILTER_CATS.forEach((c) => {
    const isGan = /Gan$/.test(c.param);
    eq(c.chars.length, isGan ? 10 : 12, c.label + ' 列出 ' + (isGan ? 10 : 12) + ' 个字');
  });
  eq(recordsModel.FILTER_CATS[0].chars[0], '甲', '天干第一个是「甲」');
  eq(recordsModel.FILTER_CATS[1].chars[0], '子', '地支第一个是「子」');

  /* ② emptyFilter：全空 = 全部 */
  const f0 = recordsModel.emptyFilter();
  eq(Object.keys(f0).length, 8, 'emptyFilter 有八个类别键');
  eq(recordsModel.totalPicked(f0), 0, '初始一个都没选');
  eq(recordsModel.hasFilter(f0), false, '初始「没有筛选在生效」');
  ok(recordsModel.isAll(f0, 'dayGan'), '⚠ 空集合 = 该类「全部」（不是「什么都不显示」）');
  eq(Object.keys(recordsModel.toQuery(f0)).length, 0, '⚠ 没有任何选中 ⇒ 查询参数是空对象（不传 = 不过滤）');

  /* ③ toggleChar：勾上 / 取消 */
  const f1 = recordsModel.toggleChar(f0, 'dayGan', '甲');
  ok(!!f1.dayGan['甲'], 'toggleChar 勾上了「甲」');
  eq(recordsModel.isAll(f1, 'dayGan'), false, '勾了一个之后不再是「全部」');
  eq(recordsModel.countOf(f1, 'dayGan'), 1, '该类选了 1 个');
  eq(recordsModel.totalPicked(f1), 1, '总计选了 1 个');
  ok(recordsModel.hasFilter(f1), '有选中 ⇒ 筛选生效中');

  /* ⚠ 关键：只动被点的那一类，别的类别必须原样保留 */
  const f1b = recordsModel.toggleChar(f1, 'hourZhi', '亥');
  /* ⚠⚠ 这里**不能**写 `f1b.dayGan['甲']` —— 一旦 dayGan 被丢掉就是
     `undefined['甲']` ⇒ **整份套件崩栈退出**，后面的断言一条都不跑，
     而负向验证要找的那条 FAIL 也就永远不出现（看着像「测试没抓到」，
     其实是**测试自己先死了**）。先取值、再判空。 */
  const keepDayGan = (f1b.dayGan || {})['甲'];
  ok(!!keepDayGan, '⚠ 点了「时支」之后，「日干」的选择还在（浅拷贝没漏）');
  eq(
    Object.keys(f1b).length, 8,
    '⚠ 仍然是八个类别键（没有因为只改一个就把别的丢掉）'
  );

  /* 取消：再点一次就没了 */
  const f2 = recordsModel.toggleChar(f1, 'dayGan', '甲');
  eq(recordsModel.countOf(f2, 'dayGan'), 0, '再点一次 = 取消');
  ok(recordsModel.isAll(f2, 'dayGan'), '取消到空 ⇒ 回到「全部」');

  /* ④ 不可变性：不能改传进来的那份（否则 React 不重渲染） */
  const before = JSON.stringify(f1);
  recordsModel.toggleChar(f1, 'dayGan', '乙');
  eq(JSON.stringify(f1), before, '⚠ toggleChar 不改原对象（返回新对象，React 才认）');

  /* ⑤ 同类多选 → 逗号串 */
  const multi = recordsModel.toggleChar(recordsModel.toggleChar(f0, 'dayGan', '甲'), 'dayGan', '乙');
  eq(recordsModel.toQuery(multi).dayGan, '甲,乙', '⚠ 同类多选拼成「甲,乙」（服务端按「或」解析）');
  eq(recordsModel.totalPicked(multi), 2, '总计 2 个');

  /* ⑥ 跨类：两个键都在（服务端按「且」解析） */
  const cross = recordsModel.toggleChar(multi, 'yearZhi', '辰');
  const q = recordsModel.toQuery(cross);
  eq(JSON.stringify(Object.keys(q).sort()), '["dayGan","yearZhi"]', '跨类 ⇒ 两个查询键都出现');
  eq(q.yearZhi, '辰', 'yearZhi 是单字也拼成串');

  /* ⑦ clearCat：某一类回「全部」，不动别的 */
  const cleared = recordsModel.clearCat(cross, 'dayGan');
  ok(recordsModel.isAll(cleared, 'dayGan'), 'clearCat 让该类回到「全部」');
  eq(cleared.yearZhi['辰'], true, '⚠ 清一类不动另一类');
  eq(
    Object.prototype.hasOwnProperty.call(recordsModel.toQuery(cleared), 'dayGan'), false,
    '⚠ 清空后该类**不产出查询键**（不能发个空串说「我要筛空」）'
  );

  /* ⑧ 全非法输入不能把它搞崩 */
  eq(recordsModel.countOf(null, 'dayGan'), 0, 'sel 为 null 时 countOf 不崩');
  eq(recordsModel.isAll(null, 'dayGan'), true, 'sel 为 null 时 isAll 视为「全部」');
  eq(recordsModel.totalPicked(null), 0, 'sel 为 null 时 totalPicked 为 0');
  eq(JSON.stringify(recordsModel.toQuery(null)), '{}', 'sel 为 null 时 toQuery 返回空对象');
  const orphan = recordsModel.toggleChar({}, 'dayGan', '甲');
  ok(!!orphan.dayGan['甲'], '⚠ 传了个缺键的 sel 也能勾上（不许因为 key 不在就丢掉点击）');

  /* ⑨ countText：分母不许撒谎 */
  eq(recordsModel.countText(5, 30, false), '共 30 例', '没筛选时显示「共 N 例」');
  eq(recordsModel.countText(3, 30, true), '筛出 3 例', '⚠ 筛选时显示「筛出 N 例」——绝不用筛后的数字当分母');
  eq(recordsModel.countText(7, undefined, false), '共 7 例', '总条数未知时退回用当前条数');

  /* ⑩ 不支持筛选时的提示 */
  eq(recordsModel.filterUnsupportedTip(true), '', '后端支持 ⇒ 不提示');
  ok(recordsModel.filterUnsupportedTip(false).length > 0, '⚠ 后端不支持 ⇒ 必须有一句话说明（不能给个点了没反应的按钮）');

  /* ================================================================
   * ⑪ 弹窗：草稿 / 提交（★「点击确定才筛选」）
   * ================================================================
   * ⚠⚠ 这一组守的是**取消真的能回退**。要证明它，关键是
   *   「弹窗里勾了一堆 → 取消 → 生效筛选还是原样」——
   *   而这只在两份状态是**独立对象**时才成立（见 cloneFilter）。
   */
  {
    const a = recordsModel.emptyFilter();
    const b = recordsModel.toggleChar(a, 'dayGan', '甲');

    /* cloneFilter：必须深拷到第二层 */
    const c = recordsModel.cloneFilter(b);
    ok(c.dayGan['甲'] === true, 'cloneFilter 拷到了内层（第二层也复制了）');
    ok(c.dayGan !== b.dayGan, '⚠⚠ 内层是**新对象**（浅拷会共享 ⇒ 一勾两边一起变）');
    c.dayGan['乙'] = true;
    eq(!!b.dayGan['乙'], false, '⚠⚠ 改克隆件的内层**不影响**原件（这条就是「取消能回退」的地基）');
    /* 键数也要对：cloneFilter 不能让空类别凭空多出来 */
    eq(Object.keys(recordsModel.cloneFilter(b)).length, Object.keys(b).length,
       'cloneFilter 不增删类别键');
    eq(recordsModel.cloneFilter(null).dayGan ? 1 : 0, 0, 'cloneFilter(null) 不崩、返回空对象');

    /* sameFilter：只比「实际选中」的字 */
    ok(recordsModel.sameFilter(a, recordsModel.emptyFilter()), '两个空筛选判等');
    ok(recordsModel.sameFilter(b, recordsModel.cloneFilter(b)), '克隆件与原件的筛选判等');
    ok(!recordsModel.sameFilter(a, b), '空 vs 选了「甲」 ⇒ 不等');
    ok(recordsModel.sameFilter({ dayGan: {} }, {}),
       '⚠ 一份显式带空键、一份不带 ⇒ 仍判等（都是「全部」）');
    ok(!recordsModel.sameFilter({ dayGan: { 甲: true } }, { dayGan: { 乙: true } }),
       '同类但选了不同的字 ⇒ 不等');
    ok(!recordsModel.sameFilter({ dayGan: { 甲: true } }, { dayGan: { 甲: true }, yearZhi: { 辰: true } }),
       '多了一个类别 ⇒ 不等');

    /* applyPlan：三态 */
    const noop = recordsModel.applyPlan(recordsModel.cloneFilter(b), b);
    eq(noop.action, 'close', '⚠⚠ 草稿没变 ⇒ close（不发请求，省一次往返）');
    eq(noop.sendsQuery, false, '  └ 且不带查询');

    const add = recordsModel.applyPlan(recordsModel.toggleChar(b, 'yearZhi', '辰'), b);
    eq(add.action, 'reload', '草稿变了 ⇒ reload');
    eq(add.sendsQuery, true, '  └ 带查询（有选中的字）');
    ok(!!add.filter.yearZhi['辰'], '  └ 新筛选里带上了刚勾的「辰」');

    const cleared = recordsModel.applyPlan(recordsModel.emptyFilter(), b);
    eq(cleared.action, 'reload', '⚠⚠ 从「有筛选」改回「全部」也是变了 ⇒ 必须 reload');
    eq(cleared.sendsQuery, false,
       '⚠⚠⚠ 但**不带查询** —— 这正是「清除筛选看全部」：若这里也发带参请求，界面会停在上一批结果上');
    eq(recordsModel.hasFilter(cleared.filter), false, '  └ 生效筛选确实空了');

    /* confirmText：数量用草稿算 */
    eq(recordsModel.confirmText(recordsModel.emptyFilter()), '确定', '一个没勾 ⇒ 按钮就写「确定」');
    eq(recordsModel.confirmText(b), '确定（1）', '勾了 1 个 ⇒ 带上数量（点之前就知道选了几个）');
    eq(recordsModel.confirmText(recordsModel.toggleChar(b, 'yearZhi', '辰')), '确定（2）', '两个类别共 2 个');
  }

  /* ================================================================
   * ⑫ 姓名查询（★ 在弹窗**外面**，独立于八个干支类别）
   * ================================================================
   * ⚠⚠ 用户要求：「记录页面筛选增加输入名字查询筛选，输入名字查询不放在弹窗里面，
   *   放在筛选下面，不用点进去也能实现输入名字快速筛选」。
   *   这一组守的就是「它是**另一类**条件」——归一化规则、进 query 的方式、
   *   以及最关键的：**它也算「有筛选」**（否则计数和「清除筛选」都会骗人）。
   */
  {
    const empty = recordsModel.emptyFilter();

    /* ---- ① 归一化：只 trim + 限长，别的什么都不许做 ---- */
    eq(recordsModel.normalizeName('  张三  '), '张三', '姓名去首尾空白');
    eq(recordsModel.normalizeName('张 三'), '张 三',
       '⚠ 中间的空格**保留**（「张 三」与「张三」是两个不同的搜索词，不许自作聪明删掉）');
    eq(recordsModel.normalizeName('张三,李四'), '张三,李四',
       '⚠⚠ 逗号**不 split**（姓名不是一个「字的集合」；split 开纯粹是猜）');
    eq(recordsModel.normalizeName('Ma'), 'Ma', '⚠ 大小写**不折叠**（原样送服务端）');
    eq(recordsModel.normalizeName('   '), '', '全空白 ⇒ 空（等于没填）');
    eq(recordsModel.normalizeName(undefined), '', 'undefined ⇒ 空，不崩');
    eq(recordsModel.normalizeName(null), '', 'null ⇒ 空，不崩');
    eq(recordsModel.normalizeName(123), '123', '数字也照 String 过去（不特殊处理）');

    /* ⚠⚠ 限长必须是「超过就当成空」，**不是截断**：
       截断会让用户以为自己搜的是完整名字（见 NAME_MAX 注释）。 */
    const long = '张'.repeat(recordsModel.NAME_MAX + 1);
    eq(recordsModel.normalizeName(long), '', '⚠ 超过 NAME_MAX ⇒ 当成空（**不截断**）');
    const exact = '张'.repeat(recordsModel.NAME_MAX);
    eq(recordsModel.normalizeName(exact), exact, '正好 NAME_MAX 长度 ⇒ 照收');
    eq(recordsModel.NAME_MAX, 60, '⚠⚠ NAME_MAX 必须与服务端 NAME_MAX 一致（改一处要改两处）');

    /* ---- ② 进 query：姓名与干支**可以并存**（跨类「且」） ---- */
    eq(recordsModel.toQuery(empty, '张三').name, '张三', '姓名进 query 的 name 键');
    eq(
      Object.prototype.hasOwnProperty.call(recordsModel.toQuery(empty, '   '), 'name'), false,
      '⚠ 空白姓名**不产出 name 键**（不能发个空串说「我要筛空」）'
    );
    eq(
      Object.prototype.hasOwnProperty.call(recordsModel.toQuery(empty, long), 'name'), false,
      '⚠ 超长姓名也不产出 name 键'
    );
    const both = recordsModel.toQuery(recordsModel.toggleChar(empty, 'dayGan', '甲'), '张');
    eq(both.name, '张', '姓名与干支并存 ①：name 在');
    eq(both.dayGan, '甲', '姓名与干支并存 ②：dayGan 也在（两者是「且」）');
    eq(JSON.stringify(recordsModel.toQuery(null, '张')), '{"name":"张"}',
       '⚠ sel 为 null 时姓名照样进 query（别因为八个类别是空的就把姓名也丢了）');

    /* ---- ③ 姓名**也算「有筛选」**—— 这是最容易漏的一条 ---- */
    eq(recordsModel.hasFilter(empty, '张三'), true,
       '⚠⚠ 只打了姓名也算筛选生效（否则会显示「共 30 例」而列表只有 3 条）');
    eq(recordsModel.hasFilter(empty, '   '), false, '姓名只有空白 ⇒ 不算筛选');
    eq(recordsModel.hasFilter(empty), false, '⚠ 不传姓名时行为与从前一致（老调用点不许被破坏）');
    eq(recordsModel.hasFilter(recordsModel.toggleChar(empty, 'dayGan', '甲'), ''), true,
       '只有干支、姓名为空 ⇒ 照样算筛选');

    /* ---- ④ applyPlan **只比干支**，姓名不参与 ---- */
    /* ⚠⚠⚠ 这条是防「名字白打」：只改了名字、干支没动时，
       applyPlan 必须仍然判「没变」⇒ 不发请求（改名字那条路已经自己拉过了）。
       若哪天有人把姓名塞进 applyPlan 的比较里，这里会立刻红。 */
    const b = recordsModel.toggleChar(recordsModel.emptyFilter(), 'dayGan', '甲');
    eq(recordsModel.applyPlan(recordsModel.cloneFilter(b), b).action, 'close',
       '⚠⚠ 干支草稿没变 ⇒ close —— 姓名由输入框那条路自己拉，不归弹窗管');
  }
}

/* ================================================================
 * 一之二、records/model.js：自定义标签（★ 记录页）
 * ================================================================
 * 用户需求：「在记录页面增加一个自定义标签功能，将八字归类到自定义的标签内」。
 * ⚠⚠ 这一组守的是**纯计算**（拼参数 / 算标签栏 / 「新建还是选中」那一处决策）——
 *   发请求的那半截在 core/tags.js（已由 local-check 十六节守）。
 * ⚠⚠⚠ 最毒的一处是 `module.exports` 的顺序：`toQuery` / `hasFilter` 与
 *   core/pillarFilter.js **重名**，必须写在 `...pillarFilter` 之后。
 *   写在前面会被 spread **静默盖回**只认两维的旧版 —— 旧版看着也能跑，
 *   只是标签那一维永远不生效（请求里少一个参数，服务端就返回全量），
 *   界面照样画得出来。所以这里既断言**行为**，也断言**源码顺序**。
 */
console.log('\n--- records/model.js：自定义标签 ---');
{
  const f = recordsModel.emptyFilter();

  /* ---- ① tagQuery：「全部」与「未分类」的区别全在这一步 ---- */
  eq(JSON.stringify(recordsModel.tagQuery('')), '{}',
     '⚠⚠ 「全部」⇒ 空对象（**一个参数都不发**），而不是 `tagId=`');
  eq(JSON.stringify(recordsModel.tagQuery(undefined)), '{}', 'undefined 也当「全部」');
  eq(JSON.stringify(recordsModel.tagQuery(null)), '{}', 'null 也当「全部」');
  eq(recordsModel.tagQuery(recordsModel.TAG_NONE).tagId, 'none',
     '⚠⚠⚠ 「未分类」⇒ 发一个 `tagId=none`（保留哨兵）。' +
     '写成空对象就变成了「全部」，用户点「未分类」却看到所有记录');
  eq(recordsModel.tagQuery('g1abc').tagId, 'g1abc', '标签 id 原样进 query');

  /* ---- ② toQuery：三个维度一起拼 + 老调用点（两参）行为一字不变 ---- */
  eq(JSON.stringify(recordsModel.toQuery(f, '')), '{}',
     '两参调用（老写法）= 不过滤 —— ⚠⚠⚠ 这是向后兼容的硬约束，' +
     '它一旦变了，其它所有老调用点会同时被改变行为');
  eq(JSON.stringify(recordsModel.toQuery(f, '', '')), '{}', '第三参传空串也当「全部」');
  /* ⚠⚠⚠ 行为级的「没被 spread 盖回旧版」断言 */
  eq(recordsModel.toQuery(f, '', recordsModel.TAG_NONE).tagId, 'none',
     '⚠⚠⚠ 三参 toQuery **真的认标签那一维** —— 若被 pillarFilter 的旧版盖回，' +
     '这里会拿到 undefined（而界面照样画得出来，最难发现）');
  const t3 = recordsModel.toQuery(
    recordsModel.toggleChar(f, 'dayGan', '甲'), '张', recordsModel.TAG_NONE);
  eq(t3.dayGan, '甲', '三分量并存 ①：dayGan 在');
  eq(t3.name, '张', '三分量并存 ②：name 在');
  eq(t3.tagId, 'none', '三分量并存 ③：tagId 也在（三者是「且」的关系）');

  /* ---- ③ hasFilter：标签也算「有筛选」 ---- */
  eq(recordsModel.hasFilter(f, '', recordsModel.TAG_NONE), true,
     '⚠⚠⚠ 只按标签筛也算筛选生效 —— 漏了它就会出现「按标签筛着、' +
     '却给不出『清除筛选』、空态也说『还没有排盘记录』」那套死角');
  eq(recordsModel.hasFilter(f, '', ''), false, '三参都空 ⇒ 没有筛选');
  eq(recordsModel.hasFilter(f, ''), false,
     '⚠ 两参调用（老写法）行为与从前一致 —— 老调用点不许被破坏');

  /* ---- ④ refreshQuery：下拉刷新也要带上标签（下拉 = 重新按这个条件查一遍） ---- */
  eq(recordsModel.refreshQuery(f, '', recordsModel.TAG_NONE).query.tagId, 'none',
     '⚠⚠ 下拉刷新要带标签 —— 不带的话「刷完发现筛选没了」，那是**改变了用户在看的东西**');
  eq(recordsModel.refreshQuery(f, '', recordsModel.TAG_NONE).filtered, true,
     '  └ filtered 也把标签算进去');
  eq(recordsModel.refreshQuery(f, '', '').filtered, false, '三参都空 ⇒ 不是筛过的');

  /* ---- ⑤ tagBar：顺序 / 选中标记 / 计数口径 ---- */
  const tagsList = [
    { id: 'g1', name: '客户', count: 3 },
    { id: 'g2', name: '重点', count: 2 }
  ];
  const bar = recordsModel.tagBar(tagsList, 7, '');
  eq(bar.map((x) => x.key).join(','), ',none,g1,g2',
     '⚠ 顺序 = [全部, 未分类, …各标签] —— 「未分类」**钉在第二个位置**（它是个固定出口，' +
     '位置飘来飘去会让人每次重新找）');
  eq(bar.map((x) => x.label).join(','), '全部,未分类,客户,重点', '文案');
  eq(bar[0].count, 12,
     '⚠⚠「全部」的计数 = 未分类 + 各标签 count 之和（**不是** list.length —— ' +
     '列表此刻已经是筛过的，拿它当分母就是个假数字）');
  eq(bar[1].count, 7, '「未分类」的计数来自 /tags 的 untagged');
  eq(bar.map((x) => (x.on ? '1' : '0')).join(''), '1000',
     '⚠ 空串 ⇒ 选中「全部」那一格');
  eq(recordsModel.tagBar(tagsList, 7, recordsModel.TAG_NONE).map((x) => (x.on ? '1' : '0')).join(''),
     '0100', '选「未分类」时只有它亮');
  eq(recordsModel.tagBar(tagsList, 7, 'g2').map((x) => (x.on ? '1' : '0')).join(''), '0001',
     '选某个标签时只有它亮');
  eq(recordsModel.tagBar([], 0, '').length, 2,
     '⚠ 一个标签都没建 ⇒ 只有 [全部, 未分类] 两格（不画空行）');
  eq(recordsModel.tagBar(null, 3, '').map((x) => x.count).join(','), '3,3',
     '⚠ 脏数据（tags 不是数组）不抛、也不发散');
  eq(recordsModel.tagBar([{ id: 'g1', name: '客户' }], 2, '').map((x) => x.count).join(','), '2,2,0',
     '⚠ 标签没带 count ⇒ 当 0，不变成 undefined/NaN');

  /* ---- ⑥ tagNameOf：取不到给空串（卡片据此不画那枚 chip） ---- */
  eq(recordsModel.tagNameOf(tagsList, 'g1'), '客户', '取得到名字');
  eq(recordsModel.tagNameOf(tagsList, 'gX'), '',
     '⚠⚠ 取不到给**空串**（标签刚在别处被删了）—— 返回 id 本身会把 `g1abc…` 画到卡片上，' +
     '返回「未知标签」会让人以为真有这么一个分类');
  eq(recordsModel.tagNameOf(tagsList, null), '', '没有标签也给空串');

  /* ---- ⑦ planNewTag：标签面板**唯一**的决策点 ---- */
  eq(recordsModel.planNewTag([], '  客户  ').action, 'create',
     '列表里没有 → 去建');
  eq(recordsModel.planNewTag([], '  客户  ').name, '客户',
     '  └ 名字先收拾（去首尾空白）再拿去建');
  eq(recordsModel.planNewTag(tagsList, '客户').action, 'select',
     '⚠⚠⚠ 已经有一个同名的 → **直接选中它**（用户的意图是「把这条归到『客户』下」，' +
     '不是「我要见证一次 insert」）⇒ 省掉一次必然会 409 的往返和一句没必要的报错');
  eq(recordsModel.planNewTag(tagsList, '  客户  ').id, 'g1',
     '  └ 收拾之后的重名**也要认**（不带这一步就漏成一次 409）');
  eq(recordsModel.planNewTag(tagsList, '客户').id, 'g1', '  └ 返回的是那个已存在标签的 id');
  eq(recordsModel.planNewTag(tagsList, '  ').action, 'none',
     '⚠ 空名字 → 就地报错，一个请求都不发');
  ok(/请输入/.test(recordsModel.planNewTag(tagsList, '').error || ''),
     '  └ 而且带一句给用户看的话');
  eq(recordsModel.planNewTag(tagsList, '甲'.repeat(recordsModel.TAG_NAME_MAX + 1)).action, 'none',
     '⚠⚠ 超长 → none（**不许截断**成前 20 个字偷偷建出来）');
  eq(recordsModel.planNewTag(null, '客户').action, 'create',
     '⚠ tags 是 null 也不抛（当作「一个都还没有」）');

  /* ---- ⑧ 常量透传：与服务端逐字相同的那两个 ---- */
  eq(recordsModel.TAG_NONE, 'none',
     '⚠⚠⚠ TAG_NONE 必须是 `none` —— 它与服务端 lib/recordFilter.ts 逐字相同才对得上' +
     '（对不上会被当成「一个叫 none 的标签 id」去查 ⇒ 0 条，而界面写着「未分类」）');
  eq(recordsModel.TAG_NAME_MAX, 20,
     '⚠ TAG_NAME_MAX 从 core/tags.js 透传（只有一份，别在 model 里再写一个字面量）');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'records', 'model.js'), 'utf8');
    /* ⚠⚠ 锚点必须**只切 module.exports 那一段**：`...pillarFilter` 这三个点
       在**文件头的注释里**也出现过一次（「本文件只转发它的导出（见…）」）——
       用 `src.indexOf('...pillarFilter')` 会命中那句注释，于是
       「toQuery 在 spread 之后」变成一条**恒真**的断言（实测：把 toQuery
       挪到 spread 之前，它照样绿 —— 是假绿）。 */
    const iExports = src.indexOf('module.exports = {');
    ok(iExports > 0, '找得到 module.exports 那一段');
    const tail = src.slice(iExports);
    const iSpread = tail.indexOf('...pillarFilter,');
    const iToQuery = tail.indexOf('toQuery: toQuery,');
    const iHasFilter = tail.indexOf('hasFilter: hasFilter,');
    ok(iSpread > 0, '找得到 `...pillarFilter`（module.exports 里那一项）');
    ok(iSpread > 0 && iToQuery > iSpread,
       '⚠⚠⚠ `toQuery` 必须写在 spread **之后** —— 写前面会被静默盖回只认两维的旧版：' +
       '标签那一维永远不生效（请求里少一个参数，服务端返回全量），而界面照样画得出来');
    ok(iSpread > 0 && iHasFilter > iSpread, '⚠⚠⚠ `hasFilter` 同理');
  }
}

/* ================================================================
 * 二、paipan/model.js
 * ================================================================ */
console.log('\n--- paipan/model.js ---');

/* --- cloudStateOf --- */
{
  eq(paipanModel.cloudStateOf({ ok: true }), { state: 'ok', text: '云端已就绪' }, '云端就绪');
  eq(paipanModel.cloudStateOf({ ok: false, reason: 'no-identity' }).state, 'skip', '没有标识 → 静默跳过');
  eq(paipanModel.cloudStateOf({ ok: false, reason: 'no-identity' }).text, '', '跳过的文案是空串（不打扰）');
  eq(paipanModel.cloudStateOf({ ok: false, reason: 'cloud-error' }).state, 'fail', '云端出错 → fail');
  eq(paipanModel.cloudStateOf(null).state, 'fail', '结果没了 → fail');
}

/* --- dtOf：真值永远是公历；「四柱」那一档算出来的文案必须与公历一致 --- */
{
  const solar = paipanModel.dtOf('solar', '1990-01-01', '11:04');
  const sizhu = paipanModel.dtOf('sizhu', '1990-01-01', '11:04');
  /* ⚠ 这条断言**是弱守卫**（负向验证里漏过，如实记下）：
     datepick 内部把「非 lunar」一律当公历，所以去掉 model 里那行
     `sizhu → solar` 降级，结果也还是这个样子，测不出来。
     留着它是防「将来 datepick 加校验时未知值被误伤」，见 model.dtOf 的注释。 */
  eq(sizhu, solar, '「四柱」与「公历」算出来的文案必须一致');

  const lunar = paipanModel.dtOf('lunar', '1990-01-01', '11:04');
  ok(lunar.text !== solar.text, '「农历」那一档的文案与公历不同');
  ok(/十二月/.test(lunar.text), '农历那一档显示的是农历月日（不是公历）');
  ok(/对应公历/.test(lunar.hint), '农历那一档的 hint 里回显公历，便于核对');
  eq(solar.hint, '', '公历那一档没有多余的 hint');
  ok(!!solar.text, '公历档有文案');
  ok(typeof solar.hint === 'string', 'hint 是字符串（没有时也是空串，不是 undefined）');
}

/* --- switchCalendar --- */
{
  eq(paipanModel.switchCalendar('lunar'), 'lunar', '合法历法原样返回');
  eq(paipanModel.switchCalendar('bogus'), null, '非法历法 → null（调用方据此忽略）');
  eq(paipanModel.switchCalendar(undefined), null, 'undefined → null');
}

/* --- applyGzPick：四柱顺序必须是 年 月 日 时 --- */
{
  const r = paipanModel.applyGzPick({
    date: '1990-01-01', time: '11:04',
    pillars: { year: '己巳', month: '丙子', day: '丙寅', hour: '甲午' },
  });
  eq(r.date, '1990-01-01', '写回公历日期');
  eq(r.time, '11:04', '写回时间');
  eq(r.pillarsText, '己巳 丙子 丙寅 甲午', '四柱文本顺序 = 年 月 日 时');
  ok(/1990-01-01/.test(r.notice), '提示里带上填入的日期，便于核对');
  const empty = paipanModel.applyGzPick(null);
  eq(empty.pillarsText, '   ', '没给四柱时不崩（四个空串用空格连起来）');
}

/* --- gateOnIdentity --- */
{
  eq(paipanModel.gateOnIdentity({ uid: 'dev-abc' }).ok, true, '拿得到标识 → 放行');
  eq(paipanModel.gateOnIdentity({ uid: '' }).ok, false, 'uid 空串 → 拦下');
  eq(paipanModel.gateOnIdentity(null).ok, false, '整个没结果 → 拦下');
  ok(/登录/.test(paipanModel.gateOnIdentity(null).notice), '拦下时提示去登录');
}

/* ================================================================
 * 三、result/model.js
 * ================================================================ */
console.log('\n--- result/model.js ---');

/* --- loadPlanOf：三条来路 --- */
{
  /* ① 什么都没有 → 空态 */
  eq(resultModel.loadPlanOf(null, null, false).action, 'empty', '总线空 + 屏上没盘 → 空态');

  /* ② 完整盘（排盘页过来）→ full */
  const full = resultModel.loadPlanOf(RICH, null, false);
  eq(full.action, 'full', '带 chart 的盘 → full（直接用，不重算）');
  eq(full.rec.id, RICH.id, 'full 把那份盘带出来');

  /* ③ 轻记录（记录页过来）→ hydrate */
  const hyd = resultModel.loadPlanOf(LIGHT, null, false);
  eq(hyd.action, 'hydrate', '没有 chart 的轻记录 → hydrate（现场重排）');
  eq(hyd.rec.date, '1990-01-01', 'hydrate 把轻记录带出来');
}

/* --- loadPlanOf：⚠⚠ 两道短路 --- */
{
  /* 短路①：raw 为 null 但屏幕上已经有盘 → keep（绝不拿 null 冲掉） */
  eq(resultModel.loadPlanOf(null, RICH, false).action, 'keep', '短路①：屏上有盘 + 总线空 → 保持不动');
  eq(resultModel.loadPlanOf(null, null, true).action, 'keep', '短路①：正在排盘 + 总线空 → 保持不动');

  /* 短路②：同一份盘已在屏幕上 → keep（不白算一遍） */
  eq(resultModel.loadPlanOf(RICH, RICH, false).action, 'keep', '短路②：同一份完整盘 → 什么都不做');

  /* 短路②的边界：同 id 但屏上那份**没有 chart**（正在排盘）→ 不该 keep */
  const noChart = { ...RICH };
  delete noChart.chart;
  eq(resultModel.loadPlanOf(RICH, noChart, true).action, 'full', '同 id 但没 chart → 不算「已在屏上」，照常铺');

  /* 换了另一份盘 → 照常铺（短路的条件是 id 相同） */
  eq(resultModel.loadPlanOf({ ...RICH, id: 'other' }, RICH, false).action, 'full', '不同 id → 照常重铺');
}

/* --- panelForLoading / panelForLoaded / emptyPanel --- */
{
  const loading = resultModel.panelForLoading();
  eq(loading.hydrating, true, '重排中：hydrating = true');
  eq(loading.save.disabled, true, '重排中：保存按钮不可点');
  eq(loading.rec, null, '重排中：rec 是空的（先渲染壳）');

  const empty = resultModel.emptyPanel();
  eq(empty.save.disabled, false, '空态：保存按钮可点（虽然 rec 为空时根本不渲染它）');
  eq(empty.saved, false, '空态：未保存');

  const saved = resultModel.panelForLoaded(RICH, true);
  eq(saved.saved, true, '已保存：saved = true');
  eq(saved.save.text, '已保存到记录', '已保存：按钮文案');
  eq(saved.save.disabled, true, '已保存：按钮变灰不可点');

  const fresh = resultModel.panelForLoaded(RICH, false);
  eq(fresh.saved, false, '未保存：saved = false');
  eq(fresh.save.text, '保存到记录', '未保存：按钮文案');
  eq(fresh.save.disabled, false, '未保存：按钮可点');

  const bad = resultModel.panelForLoaded(null, true);
  eq(bad.rec, null, '重排失败（rec 为 null）→ 空态');
  eq(bad.saved, false, '重排失败 → saved 强制 false（别显示「已保存」）');
  eq(bad.hydrating, false, '重排失败 → 转圈必须停');
}

/* --- savedOf：由来路决定 --- */
{
  eq(resultModel.savedOf('paipan'), false, '排盘页过来 → 必未保存');
  eq(resultModel.savedOf('records'), true, '记录页过来 → 必已保存');
  eq(resultModel.savedOf('anything'), false, '未知来路 → 保守当未保存');
}

/* --- saveStateOf：一支成功 + 三支失败 --- */
{
  const good = resultModel.saveStateOf({ ok: true });
  eq(good.saved, true, '保存成功 → saved');
  eq(good.save.disabled, true, '保存成功 → 按钮变灰');
  ok(/已保存/.test(good.toast), '保存成功 → 提示「已保存」');

  const noLogin = resultModel.saveStateOf({ ok: false, reason: 'no-login' });
  eq(noLogin.saved, false, '未登录 → saved 保持 false');
  eq(noLogin.save.state, 'fail', '未登录 → fail 态（可重试）');
  ok(/未登录/.test(noLogin.save.text), '未登录的按钮文案点明原因');

  const badRec = resultModel.saveStateOf({ ok: false, reason: 'bad-record' });
  ok(/出生信息/.test(badRec.save.text), '出生信息不全的按钮文案点明原因');

  const net = resultModel.saveStateOf({ ok: false, reason: 'cloud-error' });
  ok(/重试/.test(net.save.text), '网络失败 → 文案里有「重试」');
  eq(net.save.disabled, false, '网络失败 → 按钮可点');

  const weird = resultModel.saveStateOf(null);
  eq(weird.saved, false, '结果没了 → 当失败处理（绝不乐观地当成功）');

  /* 三支失败文案必须两两不同 —— 混成一句用户不知道该去登录还是该重试 */
  const texts = [noLogin.save.text, badRec.save.text, net.save.text];
  ok(new Set(texts).size === 3, '三种失败三句不同的话');

  const pending = resultModel.savePending();
  eq(pending.state, 'pending', '写云端中 → pending');
  eq(pending.disabled, true, '写云端中 → 不可点');
}

/* --- 保存前的小窗：姓名 / 描述 / ★标签草稿（★ 排盘页不再收这两项） --- */
{
  const empty = resultModel.saveAskOf();
  eq(empty, { show: false, name: '', desc: '', job: '', tagId: null, saving: false }, '小窗默认是关着的空壳');

  /* 开窗：预填记录里已有的值（失败重试时不该让用户重打一遍） */
  const opened = resultModel.saveAskOpen({ name: '张三', desc: '做生意的', job: '教师' });
  eq(opened.show, true, '开窗 → show');
  eq(opened.name, '张三', '⚠ 开窗预填已有姓名');
  eq(opened.desc, '做生意的', '⚠ 开窗预填已有描述');
  eq(opened.job, '教师', '⚠ 开窗预填已有职业（2026-10-06 新增字段）');

  /* 记录里没有 name/desc/job 时不能预填出 "undefined" 这种脏值 */
  const bare = resultModel.saveAskOpen({});
  eq(bare.name, '', '记录没名字 → 预填空串（不是 undefined）');
  eq(bare.desc, '', '记录没描述 → 预填空串（不是 undefined）');
  eq(bare.job, '', '⚠ 记录没职业 → 预填空串（不是 undefined）');
  eq(resultModel.saveAskOpen(null).name, '', '记录为 null 也不炸');

  /* 关窗必须清草稿 —— 留着残值会让下次开窗看起来像「已经填进去了」 */
  const closed = resultModel.saveAskClose();
  eq(closed.show, false, '关窗 → show=false');
  eq(closed.name, '', '⚠ 关窗清掉姓名草稿');
  eq(closed.desc, '', '⚠ 关窗清掉描述草稿');
  eq(closed.job, '', '⚠ 关窗清掉职业草稿');
  eq(closed.tagId, null, '⚠ 关窗清掉标签草稿（下次开窗必须回到未分类）');

  /* 打补丁保留其余字段 */
  const p1 = resultModel.saveAskPatch(opened, { name: '李四' });
  eq(p1.name, '李四', 'saveAskPatch 改名字');
  eq(p1.desc, '做生意的', 'saveAskPatch 保留描述');
  eq(p1.job, '教师', '⚠ saveAskPatch 保留职业（三个框各改各的）');
  eq(p1.show, true, 'saveAskPatch 保留 show');
  /* ⚠ 选标签与打名字是两个字段、各改各的：改名字不能把标签草稿冲掉（反之亦然） */
  const p2 = resultModel.saveAskPatch(resultModel.saveAskPatch(opened, { tagId: 'g1a' }), { name: '李四' });
  eq(p2.tagId, 'g1a', '⚠ 改名字不会把标签草稿冲掉');
  eq(resultModel.saveAskPatch(resultModel.saveAskPatch(opened, { tagId: 'g1a' }), { desc: 'x' }).tagId,
     'g1a', '⚠ 改描述也不会把标签草稿冲掉');

  /* ⚠⚠ 姓名 trim、描述**不 trim**（语义相反，别互相抄） */
  const merge = (rec, patch) => Object.assign({}, rec, patch);
  const c1 = resultModel.saveAskCommit({ name: '  王五  ', desc: '  前后有空白  ' }, { id: 'x' }, merge);
  eq(c1.name, '王五', '⚠ 姓名要 trim');
  eq(c1.desc, '  前后有空白  ', '⚠⚠ 描述**不 trim**（多行文本的空白可能是排版）');

  /* 姓名为空 → 传空串下去（由 record 层兜成「未命名」，这里不自己编） */
  const c2 = resultModel.saveAskCommit({ name: '   ', desc: '' }, { id: 'x' }, merge);
  eq(c2.name, '', '⚠ 姓名纯空白 → trim 成空串（兜底交给 record 层，别在这编「未命名」）');

  /* 描述纯空白 / 没填 → 写 undefined（真删键，不是留 ''） */
  /* ⚠ 判据要查**值**，别用 `'desc' in obj` —— mergePatch 内部是 Object.assign，
     键会存在、只是值为 undefined，`in` 恒为 true（假绿）。 */
  eq(resultModel.saveAskCommit({ name: 'a', desc: '   ' }, {}, merge).desc, undefined,
     '⚠ 描述纯空白 → undefined（真删键）');
  eq(resultModel.saveAskCommit({}, {}, merge).desc, undefined, '没填描述 → undefined');

  /* ⚠ 职业与姓名**同一套**（都是单行）：trim；纯空白 / 没填 → undefined（真删键）。
     别照抄描述那套「不 trim」—— 单行字段首尾空格没有意义。 */
  const j1 = resultModel.saveAskCommit({ name: 'a', job: '  教师  ' }, { id: 'x' }, merge);
  eq(j1.job, '教师', '⚠ 职业要 trim（与姓名同套，别照抄描述的「不 trim」）');
  eq(resultModel.saveAskCommit({ name: 'a', job: '   ' }, {}, merge).job, undefined,
    '⚠ 职业纯空白 → undefined（真删键）');
  eq(resultModel.saveAskCommit({ name: 'a' }, {}, merge).job, undefined, '没填职业 → undefined');

  /* ⚠ 提交走的是「整行覆盖」那条路：必须只改 name/desc/job，别把其余字段弄丢 */
  const base = { id: 'r1', gender: 1, date: '1990-01-01', time: '00:00' };
  const c3 = resultModel.saveAskCommit({ name: '赵六', desc: 'x' }, base, merge);
  eq(c3.gender, 1, '⚠ 提交保留 gender');
  eq(c3.date, '1990-01-01', '⚠ 提交保留出生日期');
  eq(c3.id, 'r1', '⚠ 提交保留 id');

  /* ⚠⚠⚠ 标签草稿**绝不能**进轻记录：记录行里没有 tagId 这个键（它只是 GET /records
     的**只读派生字段**），整行 PUT 也不认它 —— 塞进去就是往云端写一个服务端不认识的键。
     归类走的是**另一次专用请求**（`PUT /records/:id/tag`），在 push 成功之后补发。 */
  const c4 = resultModel.saveAskCommit({ name: 'a', desc: 'x', tagId: 'g1a' }, base, merge);
  eq('tagId' in c4, false, '⚠⚠⚠ 保存窗的标签草稿不许进轻记录（归类走专用接口）');
}

/* --- ★ 保存窗里那排「选标签」（saveAskBar / saveAskTag） --- */
{
  /* 一条标签都没建 → 只有「未分类」一格；调用方据此**整块不渲染** */
  const only = resultModel.saveAskBar([], null);
  eq(only.length, 1, '没建过标签 → 只回「未分类」一格（选它等于没选，调用方整块不显示）');
  eq(only[0].key, 'none', '「未分类」那格的 key 是保留值 none');
  /* ⚠⚠ 这条最容易写错：草稿是 null，而格子的 key 是字符串 'none' ——
     直接写 `it.key === cur` 会让这一格**永远不高亮**（一打开就像没选中任何标签）。 */
  eq(only[0].on, true, '⚠⚠ 草稿为 null（未分类）时这一格必须高亮，别拿 null 去比 \'none\'');

  const two = resultModel.saveAskBar(
    [{ id: 'a', name: '客户', count: 3 }, { id: 'b', name: '重点', count: 1 }], 'b'
  );
  eq(two.length, 3, '未分类 + 两个标签 = 三格');
  eq(two.map((x) => x.on), [false, false, true], '只有草稿那一格高亮');
  eq(two[1].count, 3, '带上计数（与记录页那排同一口径）');
  eq(two[0].label, '未分类', '⚠ 头一格是「未分类」（归类）—— 不是记录页那排的「全部」（筛选）');

  /* ⚠⚠ 两排芯片长得几乎一样，但**语义正相反** —— 这条钉住它们不是同一个函数产出的 */
  eq(recordsModel.tagBar([], 0, '')[0].label, '全部',
     '⚠⚠ 记录页那排头一格是「全部」（筛选列表），保存窗这排是「未分类」（给这条归类），别混用');

  /* 脏数据不许画出「名字：undefined」 */
  eq(resultModel.saveAskBar([null, { name: '没id' }, { id: 'ok', name: '正常' }], null).length, 2,
     '没有 id / null 的条目直接跳过');

  /* 保留值翻译：'none' / '' / null → null；真 id 原样带出 */
  eq(resultModel.saveAskTag('none'), null, "⚠ 'none' 必须翻成 null（漏翻 = 拿一个叫 none 的 id 去写库）");
  eq(resultModel.saveAskTag(''), null, '空串也当未分类');
  eq(resultModel.saveAskTag(null), null, 'null 进去 null 出来');
  eq(resultModel.saveAskTag('g1abc'), 'g1abc', '真标签 id 原样带出去');
}

/* --- editorOf / editorPatch --- */
{
  const e0 = resultModel.editorOf();
  eq(e0, { show: false, title: '', key: '', meta: null, text: '', saving: false }, '编辑框的默认空壳');
  const e1 = resultModel.editorOf({ show: true, key: 'dayun:d0' });
  eq(e1.title, '', 'patch 里没给的字段保持默认');
  eq(e1.key, 'dayun:d0', 'patch 给的字段生效');
  const e2 = resultModel.editorPatch(e1, { text: '甲乙' });
  eq(e2.key, 'dayun:d0', 'editorPatch 保留其余字段');
  eq(e2.text, '甲乙', 'editorPatch 应用补丁');
  eq(e1.text, '', 'editorPatch 不改原对象（要整份换）');
}

/* --- editorForNote --- */
{
  const notes = { 'dayun:d0': { text: '换工作' } };
  const r = resultModel.editorForNote({ key: 'dayun:d0', title: '【大运】乙亥大运', meta: { year: 1998 } }, notes);
  eq(r.ok, true, '有 key → 打开编辑框');
  eq(r.editor.text, '换工作', '已有内容回填（便于修改 / 清空）');
  eq(r.editor.title, '【大运】乙亥大运', '标题用组件给的那一份');
  eq(r.editor.saving, false, '刚打开时不在保存中');

  const blank = resultModel.editorForNote({ key: 'liunian:d0:2' }, notes);
  eq(blank.editor.text, '', '这一格还没写过 → 文本为空串（不是 undefined）');

  const noKey = resultModel.editorForNote({ title: 'x' }, notes);
  eq(noKey.ok, false, '没有 key → 拒绝打开（不弹一个空框）');

  const noTitle = resultModel.editorForNote({ key: 'dayun:d0' }, notes);
  eq(noTitle.editor.title, '记事件', '组件没给标题时用兜底文案');
}

/* --- maskTapAction：点遮罩是「先收键盘」还是「关框」 --- */
{
  eq(resultModel.maskTapAction(false, false), 'close',
     '键盘没弹 → 点遮罩关框');
  eq(resultModel.maskTapAction(false, true), 'dismiss-keyboard',
     '⚠⚠ 键盘弹着 → 只收键盘，不关框（否则「想收键盘」那一下把未保存的正文丢光）');
  eq(resultModel.maskTapAction(true, false), 'none',
     '保存中 → 什么都不做（请求回来要有个框接结果）');
  eq(resultModel.maskTapAction(true, true), 'none',
     '⚠ 保存中优先「不关框」，哪怕键盘还弹着');
}

/* --- noteItemOf：白名单 +「清空 = 删除」 --- */
{
  const notes = { 'dayun:d0': { text: '旧' }, 'liunian:d0:1': { text: '留着我' } };

  const write = resultModel.noteItemOf(notes, {
    key: 'liunian:d0:2',
    text: '  换了个工作  ',
    meta: { year: 2020, ganzhi: '庚子', age: 31, md: '', jieQi: '', up: { year: 2018 }, up2: { year: 1998 }, junk: '不要我' },
  });
  eq(write.ok, true, '有 key → 可以写');
  eq(write.deleting, false, '有正文 → 不是删除');
  eq(write.text, '换了个工作', '正文去掉首尾空白');
  eq(write.notes['liunian:d0:2'].text, '换了个工作', '写进了新的那一条');
  eq(write.notes['liunian:d0:2'].year, 2020, '元信息快照：year');
  eq(write.notes['liunian:d0:2'].ganzhi, '庚子', '元信息快照：ganzhi');
  eq(write.notes['liunian:d0:2'].age, 31, '元信息快照：age');
  ok(!('md' in write.notes['liunian:d0:2']), '空串的元信息字段不写进去');
  ok(!('jieQi' in write.notes['liunian:d0:2']), '空串的元信息字段不写进去（jieQi）');
  ok(!('junk' in write.notes['liunian:d0:2']), '⚠ meta 里的字段走白名单：不在表里的不许混进去');
  /* ⚠ up / up2 必须在白名单里：父级那一行自己没写时，时间线靠它才有标题 */
  eq(write.notes['liunian:d0:2'].up, { year: 2018 }, '父级快照 up 被保留');
  eq(write.notes['liunian:d0:2'].up2, { year: 1998 }, '祖父级快照 up2 被保留');
  eq(write.notes['dayun:d0'].text, '旧', '别人那一条原样不动');
  eq(notes['liunian:d0:2'], undefined, '⚠ 不改原对象（失败时要能原样留着）');

  /* 只留空白 = 删除 */
  const del = resultModel.noteItemOf(notes, { key: 'dayun:d0', text: '   \n  ', meta: {} });
  eq(del.deleting, true, '正文只剩空白 → 当作删除');
  ok(!('dayun:d0' in del.notes), '清空正文 = 删除这一条事件');
  eq(del.notes['liunian:d0:1'].text, '留着我', '删一条不影响别的');

  /* 换行归一 + 保留换行 */
  const multi = resultModel.noteItemOf({}, { key: 'dayun:d1', text: '第一行\r\n第二行', meta: {} });
  eq(multi.notes['dayun:d1'].text, '第一行\n第二行', 'CRLF 归一成 LF，正常换行保留');

  const noKey = resultModel.noteItemOf(notes, { text: 'x' });
  eq(noKey.ok, false, '没 key → 拒绝写（不往一个空 key 上挂）');
}

/* --- noteSaveToast --- */
{
  eq(resultModel.noteSaveToast({ ok: true }), '', '成功不需要提示（成功那条另有「已记下 / 已删除」）');
  ok(/登录/.test(resultModel.noteSaveToast({ ok: false, reason: 'no-login' })), '未登录的提示');
  ok(/重进/.test(resultModel.noteSaveToast({ ok: false, reason: 'not-found' })), 'not-found 让人回记录页重进');
  ok(/重试/.test(resultModel.noteSaveToast({ ok: false, reason: 'cloud-error' })), '网络失败提示重试');
}

/* --- nextTab --- */
{
  eq(resultModel.nextTab('chart', 'events'), 'events', '合法 key → 切过去');
  eq(resultModel.nextTab('chart', 'chart'), null, '点当前页签 → 不切（省一次渲染）');
  eq(resultModel.nextTab('chart', 'bogus'), null, '⚠ 未知 key → 忽略（宁可停在原地，也不切出一块空白）');
  eq(resultModel.nextTab('chart', undefined), null, 'undefined → 忽略');
  eq(resultModel.nextTab('chart', 'info'), 'info', '「详细信息」也是合法页签');
  eq(resultModel.nextTab('info', 'chart'), 'chart', '从详细信息能切回排盘结果');
  /* ⚠⚠ 顺序是**用户明确要求的**：详细信息排第一。断言的顺序就是切换栏显示的顺序，
     谁把 info 挪到后面去了，这条必须红 —— 别改成 sort 后再比。 */
  eq(
    resultModel.TAB_KEYS,
    ['info', 'chart', 'events'],
    '页签 key 收敛成这三个字面量，且「详细信息」排第一（= 切换栏的显示顺序）'
  );
  /* ⚠⚠⚠ 用户 2026-10-21：「将排盘结果师傅批字功能隐藏，按钮也隐藏不许出现」。
     页签是从 TAB_KEYS **map 出来的**，所以「不在这个数组里」= 页签与它下面
     那些按钮（发起求测 / 发送 / 刷新）一个都不会渲染。
     这条断言就是那道「别哪天又加回去」的闸。 */
  eq(
    resultModel.TAB_KEYS.indexOf('notes'),
    -1,
    '⚠⚠ 师傅批字的 notes 页签必须不在 TAB_KEYS 里（用户要求隐藏，按钮一起不出现）'
  );
  eq(
    Object.prototype.hasOwnProperty.call(resultModel.TAB_LABELS, 'notes'),
    false,
    '⚠ 文案表里也不许留 notes（留着就是「多余 key」，只加文案不加 key 会白排查一轮）'
  );
  /* ⚠ 每个 key 都要有文案，否则切换栏上会出现一个空白按钮 */
  eq(
    resultModel.TAB_KEYS.every((k) => typeof resultModel.TAB_LABELS[k] === 'string' && resultModel.TAB_LABELS[k]),
    true,
    '每个页签 key 都有对应的显示文案'
  );
  eq(resultModel.TAB_LABELS.info, '详细信息', '第一个页签的文案是「详细信息」');
  /* ⚠⚠ 用户 2026-10-03：「排盘结果的专业排盘的名字去掉，没有意义了」。
     所以 chart 那一格**不许**再是「专业排盘」—— 这条同时守住两件事：
     ① 改名了；② 别哪天有人「顺手改回去」。 */
  eq(resultModel.TAB_LABELS.chart, '排盘结果', '⚠ chart 页签叫「排盘结果」（用户要求去掉「专业排盘」）');
  eq(
    Object.keys(resultModel.TAB_LABELS).some((k) => /专业/.test(resultModel.TAB_LABELS[k])),
    false,
    '⚠ 页签文案里不许再出现「专业」二字'
  );
  /* ⚠ 文案表不许有多余的 key（拼错的 key 会静默变成空白按钮） */
  eq(
    Object.keys(resultModel.TAB_LABELS).sort().join(','),
    resultModel.TAB_KEYS.slice().sort().join(','),
    '文案表的 key 与 TAB_KEYS 完全一致（没有多余的、也没有漏的）'
  );
}

/* --- gateOf：「详细信息」也走同一道门（用户明确要求「跟其它两个一致」）--- */
{
  eq(resultModel.gateOf('info', false, true, false).show, true, '⚠ 未保存 → 详细信息也挡着（与事件记录一致）');
  eq(resultModel.gateOf('info', false, true, false).mode, 'save', '详细信息未保存 → 门里给保存按钮');
  eq(resultModel.gateOf('info', true, true, false).show, false, '已保存 → 详细信息的门让开');
  eq(resultModel.gateOf('info', false, false, true).mode, 'hydrating', '详细信息正在排盘 → 转圈');
  eq(resultModel.gateOf('info', false, false, false).mode, 'gap', '详细信息连盘都没有 → 去排盘');
}

/* --- detailRowsOf：详细信息页签的取数 --- */
{
  const full = {
    name: '张三', gender: 1,
    dateText: '1990年1月1日', timeText: '11:04',
    lunarText: '己巳年腊月初五',
    date: '1990-01-01', time: '11:04',
    job: '教师',
    desc: '甲辰年伤官见官\n第二行'
  };
  const rows = resultModel.detailRowsOf(full);
  const byLabel = {};
  rows.forEach((r) => { byLabel[r.label] = r.value; });

  eq(byLabel['姓名'], '张三', '姓名取 rec.name');
  eq(byLabel['性别'], '男', 'gender 1 → 男');
  eq(byLabel['公历'], '1990年1月1日 11:04', '⚠ 公历行**带时间**（时辰不再单独占一行）');
  eq(byLabel['农历'], '己巳年腊月初五 11:04', '⚠ 农历行也**带时间**（两行都带）');
  eq(byLabel['时辰'], undefined, '⚠ 「时辰」这一行已经去掉，不许再出现');
  eq(byLabel['描述'], '甲辰年伤官见官\n第二行', '⚠ 描述保留原文换行（不许 trim 掉）');
  eq(byLabel['职业'], '教师', '⚠ 职业取 rec.job（2026-10-06 新增的字段）');
  /* ⚠ 职业排在「性别」之后、「公历 / 农历」之前（身份信息在前、时间在后） */
  const labels = rows.map((r) => r.label);
  eq(labels.indexOf('职业') > labels.indexOf('性别') && labels.indexOf('职业') < labels.indexOf('公历'), true,
    '⚠ 职业排在性别之后、公历之前（顺序也是契约，别随手挪）');

  /* ⚠⚠ 断言里**不许直接解引用**：`jobRow.multiline` 在「职业那一行整个没了」时
     会抛 TypeError ⇒ 脚本从这里**中断**，后面的断言一条都不跑 ——
     看起来只是「红了几条」，实际是整套网被掏空（本项目踩过好几次）。 */
  const jobRow = rows.filter((r) => r.label === '职业')[0];
  eq(jobRow && jobRow.multiline, false, '⚠ 职业是**单行**（别照抄描述的 multiline:true）');
  eq(jobRow && jobRow.empty, false, '有职业 → 不标 empty（视图才会显示真的内容）');

  /* 多行标记：描述要能换行，其它字段不用 */
  const descRow = rows.filter((r) => r.label === '描述')[0];
  eq(descRow.multiline, true, '⚠ 描述标记为多行（视图据此用能换行的样式）');
  eq(byLabel['姓名'] && rows.filter((r) => r.label === '姓名')[0].multiline, false, '姓名不是多行');

  /*
   * ⚠⚠⚠ 「描述」这一行**永远存在**（用户 2026-10-03 要求：
   *   「描述字段不管是不是空的，都要显示描述一栏」）。
   *   理由：描述**可以被用户主动清空**，清空后整行消失的话，
   *   他就没有入口再把它填回来了 —— 那一栏等于一次性消耗品。
   */
  const noDescRows = resultModel.detailRowsOf({ name: '李四', gender: 0, dateText: 'x', lunarText: 'y', timeText: 'z' });
  const noDescRow = noDescRows.filter((r) => r.label === '描述')[0];
  eq(!!noDescRow, true, '⚠⚠ 没描述 → 「描述」这一栏**照样在**（用户要求，清空后还要能点回来）');
  eq(noDescRow && noDescRow.value, '', '⚠ 空描述的值是**空串**（占位文案是视图的事，model 只答有没有值）');
  eq(noDescRow && noDescRow.empty, true, '⚠ 空描述要**标出来**（视图据此显示灰字「未填写」）');
  eq(noDescRow && noDescRow.always, true, '⚠ 标记为「恒显」的行（与其它「空就整行消失」的字段区分开）');

  const blankDescRow = resultModel.detailRowsOf({ name: '王五', gender: 1, dateText: 'x', lunarText: 'y', timeText: 'z', desc: '   ' })
    .filter((r) => r.label === '描述')[0];
  eq(blankDescRow && blankDescRow.empty, true, '⚠ 纯空白描述同样算空（但那一栏还是要在）');

  /*
   * ⚠⚠ 「职业」与「描述」**同一套规则**（用户 2026-10-06：新增职业字段，
   *   「同姓名和描述一样」）：恒显 + 空就标 empty。
   *   同样是因为它可以被用户主动清空 —— 清空后整行消失就再没有入口填回来。
   */
  const noJobRow = noDescRows.filter((r) => r.label === '职业')[0];
  eq(!!noJobRow, true, '⚠⚠ 没职业 → 「职业」这一栏**照样在**（同描述，清空后还要能填回来）');
  eq(noJobRow && noJobRow.value, '', '⚠ 空职业的值是**空串**（占位文案是视图的事）');
  eq(noJobRow && noJobRow.empty, true, '⚠ 空职业要**标出来**（视图据此显示灰字「未填写」）');
  eq(noJobRow && noJobRow.always, true, '⚠ 职业也是「恒显」行');
  eq((resultModel.detailRowsOf({ name: '王五', gender: 1, dateText: 'x', lunarText: 'y', timeText: 'z', job: '   ' })
    .filter((r) => r.label === '职业')[0] || {}).empty, true, '⚠ 纯空白职业同样算空（但那一栏还是要在）');

  /* ⚠ 有值时：原样带出 + 不标 empty */
  eq(descRow.empty, false, '⚠ 有描述时 empty=false（视图才会显示真的内容）');
  eq(descRow.value, '甲辰年伤官见官\n第二行', '⚠ 有描述时值原样带出（含换行）');

  /* ⚠⚠ 「姓名」**不享受**这个例外：它不许为空，空就整行不出现（别照抄描述那套） */
  const noNameRows = resultModel.detailRowsOf({ gender: 1, dateText: 'x', lunarText: 'y', timeText: 'z' });
  eq(noNameRows.some((r) => r.label === '姓名'), false,
    '⚠⚠ 姓名与描述的规则**刻意相反**：姓名空 → 整行不出现（它不允许为空，不是「恒显」）');

  /* ⚠ 其它字段（性别 / 农历）仍然是「空就不出现」—— 恒显的例外只有描述与职业，别扩大化 */
  eq(noDescRows.some((r) => r.label === '农历'), true, '农历有值当然要在');
  eq(resultModel.detailRowsOf({ name: 'a', gender: 1, dateText: 'x', timeText: 'z' }).some((r) => r.label === '农历'), false,
    '⚠ 没 lunarText 时农历行仍然不出现（只有描述是恒显的例外）');

  /* 性别两个方向都要对（⚠ 只测一个方向认不出「照抄反了」） */
  eq(resultModel.detailRowsOf({ name: 'a', gender: 0, dateText: 'x', lunarText: 'y', timeText: 'z' })
    .filter((r) => r.label === '性别')[0].value, '女', 'gender 0 → 女');

  /* ⚠ 冷启动只有轻记录（没有 dateText）时，退回裸 date 字段，不能整行消失 */
  const light = resultModel.detailRowsOf({ name: '赵六', gender: 1, date: '1991-02-03', time: '07:30' });
  const lv = {};
  light.forEach((r) => { lv[r.label] = r.value; });
  eq(lv['公历'], '1991-02-03 07:30', '⚠ 没有 dateText 时退回裸 date，并照样带上时间');
  eq(lv['时辰'], undefined, '⚠ 轻记录也不该冒出「时辰」行');
  eq(light.some((r) => r.label === '农历'), false, '没有 lunarText 时农历行不出现');

  /* ⚠ 没有时间就没有时间 —— 不许补个空格尾巴（否则「1991-02-03 」这种脏值进 UI） */
  const noTime = resultModel.detailRowsOf({ name: '孙七', gender: 1, date: '1992-03-04' });
  eq(noTime.filter((r) => r.label === '公历')[0].value, '1992-03-04', '⚠ 无时间时公历行不许留下尾随空格');

  eq(resultModel.detailRowsOf(null), [], '没有记录 → 空数组（视图据此什么都不渲染）');
}

/* --- 详细信息页的「修改（姓名+描述一起改）/ 删除」：纯计算，全在 model 里 --- */
{
  /* editOf：默认没在修改 */
  const e0 = resultModel.editOf();
  eq(e0.on, false, 'editOf 初始不在修改态（要按「修改」按钮才进）');
  eq(e0.name, '', 'editOf 初始 name 为空');
  eq(e0.desc, '', 'editOf 初始 desc 为空');
  eq(e0.job, '', 'editOf 初始 job 为空');
  eq(e0.saving, false, 'editOf 初始不在保存中');

  /*
   * ⚠⚠⚠ editStart **三个字段一起预填**（用户要求「点击才能进入修改姓名和描述的状态」）：
   *   一次把姓名 + 职业 + 描述都变成输入框，改完点一次「保存」一起提交。
   *   ⚠ 不再有「只改一个字段」的模式 —— 旧的 `{mode, text}` 形状已经废弃。
   */
  const rec = { name: '张三', job: '教师', desc: '甲辰年伤官见官' };
  const st = resultModel.editStart(rec);
  eq(st.on, true, '⚠ editStart 进入修改态');
  eq(st.name, '张三', '⚠ editStart 预填姓名（打开就看到现在叫什么）');
  eq(st.job, '教师', '⚠ editStart 预填职业（三个字段一起进修改态）');
  eq(st.desc, '甲辰年伤官见官', '⚠ editStart 预填描述');
  eq(resultModel.editStart(null).name, '', '⚠ rec 为空时 name 是空串，不许崩');
  eq(resultModel.editStart({ name: '张三' }).desc, '', '⚠ 没 desc 时预填空串');
  eq(resultModel.editStart({ name: '张三' }).job, '', '⚠ 没 job 时预填空串（不是 undefined）');
  eq(resultModel.editStart({ desc: '只有描述' }).name, '', '⚠ 没 name 时预填空串');

  /* editPatch：只覆盖传进来的字段（另外两个保持不动） */
  const p0 = resultModel.editStart(rec);
  eq(resultModel.editPatch(p0, { name: '李四' }).name, '李四', 'editPatch 改 name');
  eq(resultModel.editPatch(p0, { name: '李四' }).desc, '甲辰年伤官见官',
    '⚠⚠ 只改 name 时 **desc 保持不动**（三个框同时在，改一个不能把别的抹了）');
  eq(resultModel.editPatch(p0, { name: '李四' }).job, '教师',
    '⚠⚠ 只改 name 时 **job 也保持不动**（新增字段最容易在 patch 里漏掉）');
  eq(resultModel.editPatch(p0, { desc: '新描述' }).name, '张三', '⚠ 只改 desc 时 name 保持不动');
  eq(resultModel.editPatch(p0, { job: '医生' }).desc, '甲辰年伤官见官', '⚠ 只改 job 时 desc 保持不动');
  eq(resultModel.editPatch(p0, { desc: '新描述' }).on, true, '⚠ 打字不会把修改态打没了');

  /* editClose：保存中不许退 */
  eq(resultModel.editClose(resultModel.editPatch(p0, { saving: true })).saving, true,
    '⚠ 保存中不给退出修改态（editClose 是个空操作）—— 请求回来没地方落结果');
  eq(resultModel.editClose(p0).on, false, '不保存时 editClose 直接回到 editOf（退出修改态）');

  /* editCommit：姓名 trim、空拒绝 */
  eq(resultModel.editCommit(resultModel.editPatch(p0, { name: '  李四  ' }), rec).patch.name, '李四',
    '⚠ 姓名提交时 trim（首尾空格没意义）');
  const emptyName = resultModel.editCommit(resultModel.editPatch(p0, { name: '   ' }), rec);
  eq(emptyName.ok, false, '⚠ 姓名清空 → 拒绝（名字是列表页的标识，不能没）');
  eq(emptyName.error, '姓名不能为空', '姓名空的报错文案');

  /*
   * ⚠⚠⚠ **只有真变了的字段才进 patch**（两个字段一起提交时最容易错）：
   *   没动过的那一个不该被「写一遍」—— 值虽然一样，但会让
   *   「值没变 ⇒ 不发请求」这条短路判断失效，也让服务端白写一次。
   */
  const onlyName = resultModel.editCommit(resultModel.editPatch(p0, { name: '李四' }), rec);
  eq(Object.prototype.hasOwnProperty.call(onlyName.patch, 'name'), true, '改了名字 → patch 带 name');
  eq(Object.prototype.hasOwnProperty.call(onlyName.patch, 'desc'), false,
    '⚠⚠ 没动描述 → patch **不带 desc**（别把没变的一起写上去）');
  eq(Object.prototype.hasOwnProperty.call(onlyName.patch, 'job'), false,
    '⚠⚠ 没动职业 → patch **不带 job**（三个字段都可能白写，这里最容易漏）');

  const onlyJob = resultModel.editCommit(resultModel.editPatch(p0, { job: '医生' }), rec);
  eq(onlyJob.patch.job, '医生', '改了职业 → patch 带 job');
  eq(Object.prototype.hasOwnProperty.call(onlyJob.patch, 'desc'), false, '⚠ 改职业**不许**顺带把描述写上');
  eq(Object.prototype.hasOwnProperty.call(onlyJob.patch, 'name'), false, '⚠ 改职业不许顺带写姓名');

  /* ⚠ 职业 trim；纯空白 = 清空（undefined 真删键）—— 与姓名同套，别照抄描述 */
  eq(resultModel.editCommit(resultModel.editPatch(p0, { job: '  医生  ' }), rec).patch.job, '医生',
    '⚠ 职业提交时 trim（单行字段，与姓名同套）');
  eq(resultModel.editCommit(resultModel.editPatch(p0, { job: '   ' }), rec).patch.job, undefined,
    '⚠ 职业纯空白 → 写成 undefined（真删键）');
  /* ⚠ 记录里没有 job 时，「不填」不算变（别白写一次 + 别把 undefined 送上去） */
  eq(Object.keys(resultModel.editCommit(resultModel.editPatch(resultModel.editStart({ name: '张三' }), { name: '张三' }), { name: '张三' }).patch).length,
    0, '⚠ 本来就没有职业、也没填 → 不算变（patch 空）');

  const both = resultModel.editCommit(resultModel.editPatch(p0, { name: '李四', desc: '新描述' }), rec);
  eq(both.patch.name, '李四', '两个都改 → patch 带 name');
  eq(both.patch.desc, '新描述', '两个都改 → patch 带 desc');

  eq(Object.keys(resultModel.editCommit(resultModel.editPatch(p0, { name: '张三', desc: '甲辰年伤官见官' }), rec).patch).length, 0,
    '⚠ 两个都没变 → patch 空（调用方据此不发请求，直接退出修改态）');

  /* 描述**不** trim、纯空白 = 清空 */
  eq(resultModel.editCommit(resultModel.editPatch(p0, { desc: '  两行\n文字  ' }), rec).patch.desc, '  两行\n文字  ',
    '⚠ 描述**原样**提交、绝不 trim（多行文本的首尾空格是用户自己排的版）');
  eq(resultModel.editCommit(resultModel.editPatch(p0, { desc: '   ' }), rec).patch.desc, undefined,
    '⚠ 描述纯空白 → 写成 undefined（让它真消失，不是留一个空字符串）');
  eq(Object.keys(resultModel.editCommit(resultModel.editPatch(p0, { desc: '甲辰年伤官见官' }), rec).patch).length, 0,
    '描述没变 → patch 空');

  /* ⚠⚠ 姓名带尾随空格、记录里也有空格时，trim 后相等 ⇒ 不算变（别白写一次） */
  {
    const spacyRec = { name: '张三 ', desc: '' };
    const spacyEdit = resultModel.editStart(spacyRec);   // 预填 '张三 '
    const out = resultModel.editCommit(resultModel.editPatch(spacyEdit, { name: ' 张三 ' }), spacyRec);
    eq(Object.keys(out.patch).length, 0,
      '⚠ 姓名两侧都 trim 后比较（记录里存了「张三 」不该被再写一遍）');
  }

  /* editToast：改了哪几个就说哪几个（三个字段的任意组合都得说对） */
  eq(resultModel.editToast({ name: '李四' }), '姓名已改', '只改姓名 → 「姓名已改」（原来那句保留）');
  eq(resultModel.editToast({ desc: 'x' }), '描述已保存', '只改描述 → 「描述已保存」');
  eq(resultModel.editToast({ job: '医生' }), '职业已保存',
    '⚠⚠ 只改职业必须说「职业」—— 不加这一条的话三元表达式会退化成「描述已保存」这种谎话');
  eq(resultModel.editToast({ name: 'a', desc: 'x' }), '姓名、描述都已保存', '改了两个 → 两个都点名');
  eq(resultModel.editToast({ name: 'a', job: 'b', desc: 'c' }), '姓名、职业、描述都已保存',
    '三个都改 → 三个都点名');
  eq(resultModel.editToast({}), '', '什么都没改 → 空串（调用方本来也不会走到这一步）');

  /* ---- ★ 2026-10-21 修改出生时间：出生三项并进 `editCommit`（纯函数）----
     ⚠⚠⚠ 用户口径（原话）：「只是点更新排盘的话，只是选中性别和时间，
       不触及更改后端的数据」「只有点保存，才会更新排盘信息」。
       ⇒ 出生三项**没有**独立的写库函数（`birthCommit` 已删），
         它们的「真变了才进 patch / 缺值就拒绝」这套纪律，必须长在
         `editCommit` 里 —— 也就是「保存」那一下、与姓名职业描述**同一次** PUT。 */
  {
    const bRec = { id: 'r1', name: '张三', gender: 1, date: '1990-01-01', time: '11:04' };
    const b0 = resultModel.editStart(bRec);
    eq(b0.gender, 1, '⚠ editStart 把性别预填进草稿（表单要能回填）');
    eq(b0.date, '1990-01-01', '⚠ editStart 预填**裸字段** date（不是 dateText）');
    eq(b0.time, '11:04', '⚠ editStart 预填**裸字段** time（不是 timeText）');
    eq(Object.keys(resultModel.editCommit(b0, bRec).patch).length, 0,
      '⚠⚠ 什么都不改 ⇒ 空 patch（不白写一次、不白重排一次盘）');

    const onlyDate = resultModel.editCommit(resultModel.editPatch(b0, { date: '1991-02-03' }), bRec);
    eq(onlyDate.patch, { date: '1991-02-03' }, '只改日期 ⇒ patch 里只有 date');
    const onlyTime = resultModel.editCommit(resultModel.editPatch(b0, { time: '23:59' }), bRec);
    eq(onlyTime.patch, { time: '23:59' }, '只改时间 ⇒ patch 里只有 time');
    const onlyGender = resultModel.editCommit(resultModel.editPatch(b0, { gender: 0 }), bRec);
    eq(onlyGender.patch, { gender: 0 }, '改了性别 ⇒ patch 里只有 gender（性别决定大运顺逆，必须能改）');

    eq(resultModel.editCommit(resultModel.editPatch(b0, { date: '' }), bRec).ok, false,
      '⚠⚠ 动了出生但日期拿不到合法值 ⇒ **拒绝**（不猜一个日期去排盘）');
    eq(resultModel.editCommit(resultModel.editPatch(b0, { time: '' }), bRec).ok, false,
      '⚠⚠ 动了出生但时间拿不到合法值 ⇒ 拒绝');

    /* ⚠⚠⚠ 只在**真的动了出生**时才校验：老记录的 date/time 可能不是标准写法，
       用户只想改个名字，不该被「出生日期不完整」拦住。 */
    const oddRec = { id: 'r2', name: '张三', gender: 1, date: '1990/1/1', time: '1104' };
    const oddEdit = resultModel.editStart(oddRec);
    eq(oddEdit.date, '1990/1/1', '⚠ 老记录的非标准写法原样预填（不许在 editStart 里悄悄改写）');
    const oddName = resultModel.editCommit(resultModel.editPatch(oddEdit, { name: '李四' }), oddRec);
    eq(oddName.ok, true, '⚠⚠⚠ 只改姓名 + 老记录日期非标准 ⇒ 必须放行（不许被出生校验拦住）');
    eq(oddName.patch, { name: '李四' }, '⚠⚠ 而且 patch 里不许带上被「顺手修正」的出生字段');

    /* ⚠ 归一化：老记录没有 gender 字段时，草稿的默认 1 不算「改过」 */
    const noGender = { id: 'r3', name: '张三', date: '1990-01-01', time: '11:04' };
    eq(Object.keys(resultModel.editCommit(resultModel.editStart(noGender), noGender).patch).length, 0,
      '⚠⚠⚠ rec 缺 gender 时草稿默认 1 **不算变更**（NaN 比较会把它误判成改了，空 patch 就失效）');

    /* 提示：出生三项也要点名 */
    ok(/出生时间/.test(resultModel.editToast({ date: 'x' })), '改日期 → 提示点名「出生时间」');
    eq(resultModel.editToast({ gender: 0, date: 'x', time: 'y' }),
      '出生时间已更新，盘面已重排',
      '三项一起改 ⇒ 合成一句「出生时间」（别糊成三行，也别只说「姓名已保存」）');

    /* ---- ★ 修改态那一行显示什么：`birthOf`（纯函数）----
       用户 2026-10-21：「除了阳历还要显示农历和性别，因为这些都是在排盘页面可以改到的数据」。 */
    const line = resultModel.birthOf(bRec, resultModel.editStart(bRec));
    eq(line.solar, '1990-01-01 11:04', '主行 = 阳历 + 时刻');
    ok(/^农历 .+ · 男$/.test(line.sub), '副行 = 「农历 … · 性别」两样都在');
    eq(line.sub, '农历 一九八九年十二月初五 · 男',
      '⚠⚠⚠ 农历是**按公历日期算出来的**（1990-01-01 → 己巳年腊月初五）');
    eq(resultModel.birthOf(bRec, resultModel.editStart(bRec)).gender, 1, '性别取草稿');

    /* ⚠⚠⚠ 草稿改了日期 ⇒ 农历必须跟着重算。拿 rec.lunarText 充数的话，
       日期换了农历不动，两行字自己打架（比不显示更糟）。 */
    const moved = resultModel.birthOf(
      Object.assign({}, bRec, { lunarText: '一九八九年十二月初五' }),
      resultModel.editPatch(resultModel.editStart(bRec), { date: '2014-10-21' }));
    eq(moved.solar, '2014-10-21 11:04', '草稿日期立刻出现在主行');
    eq(moved.sub, '农历 二〇一四年九月廿八 · 男',
      '⚠⚠⚠ 农历**跟着草稿日期重算**（不是回显记录里那份旧的）');

    eq(resultModel.birthOf(bRec, resultModel.editPatch(resultModel.editStart(bRec), { gender: 0 })).sub,
      '农历 一九八九年十二月初五 · 女', '改了性别 ⇒ 副行立刻变「女」');

    /* ⚠⚠ `editOf()` 的性别默认是 1：拿它当「用户选了男」⇒ 女命记录显示成男 */
    eq(resultModel.birthOf({ gender: 0, date: '1990-01-01', time: '11:04' }, resultModel.editOf()).sub,
      '农历 一九八九年十二月初五 · 女',
      '⚠⚠⚠ 未进修改态时性别取**记录**（草稿默认值不许冒充用户的选中）');

    /* 老记录日期不是标准写法 → 农历算不出来，但阳历照显、不编一个假农历 */
    const odd = resultModel.birthOf(
      { gender: 1, date: '1990/1/1', time: '1104', lunarText: '己巳年腊月初五' },
      resultModel.editStart({ gender: 1, date: '1990/1/1', time: '1104' }));
    eq(odd.solar, '1990/1/1 1104', '老记录：阳历原样显示（不吞、不改写）');
    eq(odd.sub, '男', '⚠ 农历算不出来就只显示性别（宁可少一行字，也不给一个对不上的农历）');
  }

  /* mergePatch：并进轻记录 + undefined 删键 + 剥派生字段 */
  const fullRec = {
    id: 'r1', name: '张三', gender: 1, date: '1990-01-01', time: '11:04',
    dateText: '1990年1月1日', lunarText: '己巳年腊月初五', desc: '旧描述', job: '教师',
    /* 这两个是「几百 KB 的盘面」，绝不许进请求体 */
    chart: { data: 'x'.repeat(5000) }, bazi: { gan: '甲' }
  };
  const merged = resultModel.mergePatch(fullRec, { name: '李四' });
  eq(merged.name, '李四', 'mergePatch 应用 patch');
  /* ⚠⚠⚠ 只改姓名的整行 PUT 里**必须原样带着职业** —— 漏了就是
     「改个名字，职业没了」：服务端的 upsert 是整行覆盖，请求体没有这个键 = 把它写成 NULL。 */
  eq(merged.job, '教师', '⚠⚠⚠ 改姓名时职业必须原样带上（整行覆盖，漏了就被静默抹掉）');
  eq(merged.desc, '旧描述', '⚠⚠ 描述同理（老坑，别在加字段时把它碰掉）');
  eq(Object.prototype.hasOwnProperty.call(merged, 'chart'), false,
    '⚠⚠ mergePatch 必须剥掉 chart —— 不剥就把几百 KB 盘面塞进请求体');
  eq(Object.prototype.hasOwnProperty.call(merged, 'bazi'), false, '⚠⚠ bazi 同样要剥掉');
  eq(Object.prototype.hasOwnProperty.call(merged, 'lunarText'), false, '⚠ lunarText 是派生字段，也要剥掉');
  eq(merged.date, '1990-01-01', '出生信息（排盘输入）要保留');
  eq(Object.prototype.hasOwnProperty.call(resultModel.mergePatch(fullRec, { desc: undefined }), 'desc'), false,
    '⚠ patch 值为 undefined ⇒ 从记录里**删键**（真清空，不是留个空串）');
  eq(resultModel.mergePatch(null, { name: 'x' }), null, '⚠ rec 为空 → null（调用方据此别发请求）');

  /* deleteConfirmText */
  const d1 = resultModel.deleteConfirmText({ name: '张三' });
  eq(d1.title.indexOf('张三') >= 0, true, '删除确认标题里带名字（用户要看清删的是哪条）');
  eq(d1.body.indexOf('无法恢复') >= 0, true, '⚠ 正文必须说清「删了就没了」（结果页没有回收站）');
  const d2 = resultModel.deleteConfirmText(null);
  eq(d2.title.length > 0, true, '⚠ 没名字时标题也不能是空的');

  /* ================================================================
   * ⚠⚠⚠ 删除的「随机数字」二次确认（用户要求）
   * ================================================================
   * 用户原话：「删除功能需要弹出一个随机数字，用户输入后才能成功删除」。
   * 为什么要这个：删除**不可逆**（服务端硬 DELETE），而「再点一次确认」
   * 是**肌肉记忆就能过**的 —— 手指连着点两下就删掉了。要求照着键入一串
   * 随机数字，强制眼睛和手都参与，误触基本不可能发生。
   */
  eq(resultModel.DEL_CODE_LEN_MIN, 4, '口令最短 4 位');
  eq(resultModel.DEL_CODE_LEN_MAX, 5, '口令最长 5 位');

  /* 形状：纯数字、长度在范围内（跑一批，别只测一次） */
  {
    let allNumeric = true;
    let lenOk = true;
    const seen = {};
    for (let i = 0; i < 300; i += 1) {
      const c = resultModel.deleteCodeNew();
      if (!/^[0-9]+$/.test(c)) allNumeric = false;
      if (c.length < resultModel.DEL_CODE_LEN_MIN || c.length > resultModel.DEL_CODE_LEN_MAX) lenOk = false;
      seen[c] = true;
    }
    eq(allNumeric, true, '⚠ 生成的是**纯数字**字符串（不是数值、不带符号/小数点）');
    eq(lenOk, true, '生成长度落在 [MIN, MAX] 里');
    eq(Object.keys(seen).length > 1, true, '⚠ 每次不一样（300 次至少出 2 种 ⇒ 不是写死的常量）');
  }

  /*
   * ⚠⚠⚠ **首位可以是 0** —— 这是「数字字符串 ≠ 数字」的典型坑。
   *   用数值思路写（`1000 + floor(rand*9000)`）永远拿不到首位 0，
   *   等于把 4 位口令砍成 9000 种。必须逐位生成。
   */
  eq(resultModel.deleteCodeNew(function () { return 0; }), '0000',
    '⚠⚠⚠ 随机源全 0 时要能产出 "0000"（首位为 0 是合法口令；用数值写法就永远拿不到）');
  eq(resultModel.deleteCodeNew(function () { return 0.999; }).length, 5,
    '⚠ 随机源接近 1 时取到最长 5 位（长度也真的随随机数走）');

  /* 校验：正确 / 带空格 / 空 / 错 */
  eq(resultModel.deleteCodeCheck('1234', '1234').ok, true, '输对了 → ok');
  eq(resultModel.deleteCodeCheck('1234', ' 1234 ').ok, true,
    '⚠ 两侧都 trim（输入法回车上屏 / 手滑带空格 ⇒ 明明打对了却删不掉，还看不出去哪说理）');
  eq(resultModel.deleteCodeCheck('1234', '').ok, false, '空输入 → 不通过');
  eq(resultModel.deleteCodeCheck('1234', '').empty, true, '⚠ 空输入要单独标 empty（按钮据此画灰）');
  eq(resultModel.deleteCodeCheck('1234', '9999').ok, false, '输错了 → 不通过');
  eq(resultModel.deleteCodeCheck('1234', '9999').empty, false, '⚠ 输错 ≠ 空（两者提示语不同）');
  eq(resultModel.deleteCodeCheck('1234', '9999').error !== resultModel.deleteCodeCheck('1234', '').error, true,
    '⚠ 「没输入」与「输错了」的提示语必须**不一样**（否则用户不知道该干嘛）');
  /* ⚠ 前导零不能因为比较方式而失效（'0012' vs '12' 不是一回事） */
  eq(resultModel.deleteCodeCheck('0012', '0012').ok, true, '⚠ 前导零口令要能对上（字符串比，别转数字）');
  eq(resultModel.deleteCodeCheck('0012', '12').ok, false,
    '⚠⚠ "0012" 与 "12" **不是同一个口令**（转成数字比就会被判通过 —— 那等于把口令空间缩小）');
}

/* --- gateOf --- */
{
  eq(resultModel.gateOf('chart', false, true, false).show, false, '排盘结果不需要门');
  eq(resultModel.gateOf('events', true, true, false).show, false, '已保存 → 门让开');
  const g1 = resultModel.gateOf('events', false, true, false);
  eq(g1.show, true, '未保存 + 有盘 → 门挡着');
  eq(g1.mode, 'save', '有盘 → 门里给保存按钮');
  const g2 = resultModel.gateOf('notes', false, false, true);
  eq(g2.mode, 'hydrating', '正在排盘 → 门里转圈');
  const g3 = resultModel.gateOf('notes', false, false, false);
  eq(g3.mode, 'gap', '连盘都没有 → 门里给「去排盘」');
  ok(/还没有排盘数据/.test(g3.hint), '连盘都没有时的文案');
  eq(resultModel.gateOf('notes', true, false, false).show, false, '已保存 → 门让开（即使那一刻 rec 还没铺上）');
}

/* ================================================================
 * 四、tabs/model.js —— tab 导航
 * ================================================================ */
console.log('\n--- tabs/model.js ---');
{
  /* 与 app.json 的 tabBar.list 逐项对齐 */
  eq(tabsModel.TABS.map((t) => t.key), ['records', 'paipan', 'study', 'settings'], '四个 tab 的 key 与顺序 = app.json');
  eq(tabsModel.TABS.map((t) => t.label), ['记录', '排盘', '学堂', '设置'], '四个 tab 的文案');
  eq(tabsModel.DEFAULT_TAB, 'records', '默认 tab = records（小程序 pages[0]，启动页）');
  /* ⚠ model 不许 require 图标：Node 认不了 .png（这条守的就是本文件的纯 Node 可测性） */
  ok(tabsModel.TABS.every((t) => !('icon' in t)), 'TABS 里不挂图标（图标在视图层）');

  /* switchTo */
  eq(tabsModel.switchTo('records', 'paipan'), 'paipan', '合法切换');
  eq(tabsModel.switchTo('records', 'records'), null, '点当前 tab → 不切（switchTab 对当前页是 no-op）');
  eq(tabsModel.switchTo('records', 'bogus'), null, '未知 key → 忽略');
  eq(tabsModel.switchTo('records', undefined), null, 'undefined → 忽略');

  /* 结果页开关 */
  eq(tabsModel.openResult(0), 1, '第一次进入 = 1');
  eq(tabsModel.openResult(1), 2, '⚠ 计数器递增（关了再开也是一次新的进入，必须重跑 load）');
  eq(tabsModel.resultOpen(0), false, '0 = 关着');
  eq(tabsModel.resultOpen(1), true, '>0 = 开着');
  eq(tabsModel.resultOpen(undefined), false, '没值 = 关着');

  /* 通用推入层：登录页复用同一套计数器语义 */
  eq(tabsModel.openLayer(0), 1, '登录页第一次进入 = 1');
  eq(tabsModel.layerOpen(0), false, '登录页 0 = 关着');
  eq(tabsModel.layerOpen(tabsModel.openLayer(0)), true, '登录页 >0 = 开着');
  eq(tabsModel.layerOpen(undefined), false, '登录页没值 = 关着');
  /* ⚠ 同一个计数器语义（不是各写一份）—— 两份实现迟早会漂 */
  eq(tabsModel.openLayer, tabsModel.openResult, 'openLayer 与 openResult 是同一个实现');
  eq(tabsModel.layerOpen, tabsModel.resultOpen, 'layerOpen 与 resultOpen 是同一个实现');
}

/* ================================================================
 * 五、settings 的静态内容
 * ================================================================
 * ⚠ 原「五、study / settings 的静态内容」里 study/content.js 那一块 2026-10-21 删了：
 *   用户要求清掉废弃的学堂代码，那个文件（老知识卡）已经没有任何 import，文件本身也删了。
 *   现在这一节只剩 settings。
 */

/* ================================================================
 * 5.5 学堂 · 书签列表（懒加载）—— model 纯逻辑 + 页面源码契约
 * ================================================================ */
console.log('\n--- study/model.js（书签列表：展示口径 + 分页状态机）---');
{
  /* 书签名格式「丙寅，丁酉，己酉，丙寅」（全角逗号）→ 与记录页同款的两行干支 */
  eq(studyModel.pillarsOf('丙寅，丁酉，己酉，丙寅'), ['丙寅', '丁酉', '己酉', '丙寅'], '书签名按全角逗号拆成四组');
  eq(
    studyModel.pillarRows('丙寅，丁酉，己酉，丙寅'),
    { stems: '丙 丁 己 丙', branches: '寅 酉 酉 寅', plain: false },
    '四组 → 天干一行 / 地支一行（与记录页同款空格分隔）'
  );
  /* ⚠ Word 对重名书签会自动加 _2 后缀（渊海子平里实测有）—— 显示时必须剥掉 */
  eq(
    studyModel.pillarRows('己未，戊辰，甲寅，癸酉_2').branches,
    '未 辰 寅 酉',
    '⚠ 书签名带 _2 后缀 → 剥掉后缀再进格子（别把 _2 显示给用户）'
  );
  ok(studyModel.pillarRows('甲子乙丑').plain === true, '不是四组 → plain 标记（界面原样一行显示，不硬拆）');
  eq(studyModel.pillarRows('甲子乙丑').stems, '甲子乙丑', '不是四组时 stems 放原文（内容不丢）');

  /* 出处：书名（去 .docx）+ 「第 N 章」
     ⚠⚠⚠ 2026-10-19 换协议：`chapter` 从「层级路径数组」变成了「**章序数字**」（0 起）——
     形状完全不同，不是名字变了。照着老写法 `Array.isArray(ch)` 判会恒假 ⇒ 出处永远只剩书名。 */
  eq(
    studyModel.sourceText({ book: '三命通会（四库本·标点全本）.docx', chapter: 11 }),
    '三命通会（四库本·标点全本） · 第 12 章',
    '⚠⚠⚠ 出处 = 书名 + 章序（章序是 0 起的技术编号，显示要做成 1 起）'
  );
  eq(studyModel.sourceText({ book: '呱呱集（韦千里）.docx', chapter: 0 }), '呱呱集（韦千里） · 第 1 章',
    '⚠ chapter = 0 是**合法值**（第一章）—— 不许被 falsy 判据吃掉');
  eq(studyModel.sourceText({ book: '呱呱集（韦千里）.docx', chapter: null }), '呱呱集（韦千里）',
    '⚠ chapter 缺失（老数据 / 服务端没给）⇒ 不显示那一段，只留书名');
  eq(studyModel.sourceText({ book: '呱呱集（韦千里）.docx', chapter: [] }), '呱呱集（韦千里）',
    '⚠⚠⚠ 老口径的数组**不再被识别**（照着老写法判会恒假 ⇒ 出处只剩书名，一处不报错）');
  eq(studyModel.sourceText({ book: '', chapter: 3 }), '第 4 章', '书名缺失时只显示章号（别拼出一个开头带「· 」的怪串）');
  eq(studyModel.sourceText(null), '', '没有 item 时不崩');

  /* 分页状态机 —— 「不重复请求、不卡死」的守卫 */
  eq(studyModel.PAGE_SIZE, 50, '一页 50 条（与后端默认值一致）');
  ok(studyModel.shouldLoadMore(50, 3731, 'ok'), '已加载 50 / 共 3731 且空闲 → 该要下一页');
  ok(!studyModel.shouldLoadMore(50, 3731, 'loading'), '⚠ 正在加载 → 不再要（否则同一页请求发好几次，列表出现重复条目）');
  ok(!studyModel.shouldLoadMore(50, 3731, 'fail'), '⚠ 失败后不再自动要（等用户点重试，别偷偷重试轰炸后端）');
  ok(!studyModel.shouldLoadMore(3731, 3731, 'ok'), '全部加载完 → 不再要');
  ok(!studyModel.shouldLoadMore(0, 3731, 'ok'), '一条都没有时不由滚动触发（首屏由 active 驱动，不是滚动）');
  eq(studyModel.phaseAfter(3731, 3731, 50), 'end', '加载到 total → end');
  eq(studyModel.phaseAfter(50, 3731, 50), 'ok', '还没到 total → ok（还能继续）');
  eq(studyModel.phaseAfter(50, 3731, 0), 'end', '⚠ 服务端一条都没给 → 收手判 end（否则停在底部会一直要同一页）');

  eq(studyModel.footOf('fail', 50, 3731).retry, true, '底部「加载失败」**可点**（否则失败后用户没有任何出口）');
  eq(studyModel.footOf('end', 3731, 3731).text, '没有更多了', '到底文案');
  eq(studyModel.emptyText('fail', '连不上服务器。'), '连不上服务器。', '⚠ 空列表 + 失败 → 显示失败原因（不是「还没有书签」）');
  eq(studyModel.emptyText('ok', ''), '还没有书籍书签', '真空态与失败态文案不同（同一类坑在记录页踩过）');

  /* ★ 2026-10-04 加筛选后新增的两支 —— 计数与空态都得跟着分岔 */
  eq(studyModel.countText(50, 3731, false), '共 3731 个 · 已加载 50 个', '不带筛选：共 N 个 · 已加载 M 个');
  eq(studyModel.countText(12, 30, true), '筛出 30 个 · 已加载 12 个',
     '⚠⚠ 带筛选说「筛出 N 个」—— 服务端给的 total 本来就是筛后总数，不许拿它冒充全馆总数');
  eq(studyModel.countText(50, 3731, undefined), '共 3731 个 · 已加载 50 个',
     '⚠ 不传 filtered 时按「不带筛选」算（默认值不能变成「筛出」，否则一进页面就撒谎）');
  eq(studyModel.countText(0, 0, false), '', '总数为 0 时那行计数不显示（没数据可数）');
  eq(studyModel.countText(9, 3, true), '筛出 3 个 · 已加载 3 个',
     '⚠ 已加载超过 total 时按 total 收口（数据在两次请求之间被改小时顶部不能出现「已加载 9 / 共 3」）');
  eq(studyModel.emptyText('ok', '', true), '没有符合条件的书签',
     '⚠⚠⚠ 「被筛空」≠「一条都没有」：说成「还没有书籍书签」会让用户以为馆里的书签丢了（记录页同一类坑）');
  eq(studyModel.emptyText('fail', '连不上服务器。', true), '连不上服务器。',
     '⚠ 失败优先于「被筛空」：读不到就先说读不到（别让用户去怪筛选）');

  /* ⚠ 判据是 MODE —— 与 supportsFilter 同一纪律（不做方法探测） */
  eq(storeMode.supportsBooks(), storeMode.MODE === 'local', 'supportsBooks() 的判据 = MODE 是不是 local');
}

console.log('\n--- 学堂页懒加载契约（源码级）---');
{
  const fs = require('fs');

  /**
   * ⚠ 断言前必须去注释：本页注释里**到处**是「FlatList / ScrollView / items.map」
   *   这些词（正是在解释为什么不能用它们），不剥掉就是把说明当实现 —— 真实现被删了
   *   都查不出来（假绿）。与结果页那节同一个坑同一个修法。
   */
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  /* ⚠ 2026-10-11：「查询」这一整块已从 Study.tsx **原样搬到 QueryPane.tsx**
     （Study 现在只是「顶部切换栏 + 两个常驻面板」的壳）⇒ 这一组断言跟着改读 QueryPane。
     下面文案里仍说「学堂页」—— 指的就是学堂页里那个查询面板，语义没变。 */
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'src', 'screens', 'study', 'QueryPane.tsx'), 'utf8')
  );
  /* ⚠⚠⚠ 2026-10-10 深夜定稿：列表用 **RN 原版 FlatList**。
     中间那版要换成 `GestureFlatList`（`createNativeWrapper` 包过的），是为了给
     RNGH 手势让路；那套手势整条撤掉了。现在的下拉刷新（components/PullRefresh.tsx）
     **一个字的手势都不抢**，包装列表只会与列表滚动抢同一个原生视图。 */
  ok(src.indexOf('<FlatList') >= 0,
     '列表用 RN 原版 FlatList 渲染（3000+ 条必须虚拟化）');
  ok(src.indexOf('GestureFlatList') < 0,
     '⚠⚠ 学堂页不许出现 GestureFlatList —— 下拉刷新已是「不抢手势」那版，包装列表只会有害');
  ok(src.indexOf('onEndReached') >= 0, '滚到底由 onEndReached 驱动（懒加载的入口）');
  ok(src.indexOf('items.map(') < 0, '⚠ 不许用 items.map 渲染列表 —— 那正是「一次渲染几千条」的卡死写法');
  ok(src.indexOf('shouldLoadMore') >= 0, '到底判据走 model.shouldLoadMore（可断言那一份，别在页面里另写一遍）');
  ok(src.indexOf('content.ITEMS') < 0, '⚠ 知识卡已彻底下线（2026-10-21：连 content.js 那份数据一起删了）');

  /* ================================================================
   * ★ 四柱筛选（2026-10-04）—— 与记录页**同一套逻辑、同一个组件**
   * ================================================================
   * ⚠⚠ 学堂页的过滤**也在服务端做**（书签 3000+ 条，本地筛等于把全量拉到手机上）：
   *   所以「换筛选」= 清空列表 + 从第 0 条重拉，而不是在本地筛已加载的那些。
   */
  ok(/const canFilter = storeMode\.supportsFilter\(\)/.test(src),
     '可用性判据走 storeMode.supportsFilter（与记录页同一份，不许页面里另写一套）');
  ok(/const filtered = pf\.hasFilter\(filter\)/.test(src),
     'filtered 走公用件 pf.hasFilter（「算不算有筛选」只有一处口径）');
  ok(/pf\.toQuery\(filterRef\.current\)/.test(src),
     '⚠⚠⚠ 筛选参数真的发给服务端（只传参、不本地筛 —— 本地筛在数据变多后会全错，且「服务端有没有按参数筛」从此测不出来）');
  ok(/books\.fetchPage\(offset, model\.PAGE_SIZE, pf\.toQuery\(filterRef\.current\)\)/.test(src),
     '  └ 就在 fetchPage 的第三个参数上（空对象 = 不带参数 = 拉全部）');

  /* ⚠⚠⚠ 请求代次：换筛选时 +1，在飞的旧请求回来发现代次变了 ⇒ 整批扔掉 */
  ok(/const gen = genRef\.current;/.test(src) && /if \(gen !== genRef\.current\) return;/.test(src),
     '⚠⚠⚠ 回调第一件事是验请求代次（不验 ⇒ 旧筛选的数据会追加进新列表，偶发且极难查）');
  {
    const reload = /const reloadWithFilter = useCallback\([\s\S]{0,520}?\}, \[/.exec(src);
    ok(!!reload, '有 reloadWithFilter（换筛选 = 重置列表 + 从第 0 条重拉）');
    ok(reload && /genRef\.current \+= 1/.test(reload[0]), '  └ ⚠⚠ 先作废在飞的旧请求');
    ok(reload && /loadingRef\.current = false/.test(reload[0]),
       '  └ ⚠⚠ 放开闸门（旧请求占着它 ⇒ 新请求被自己的「已经在路上」挡回去，表现为点了确定一动不动）');
    ok(reload && /setItems\(\[\]\)/.test(reload[0]),
       '  └ ⚠⚠ 清空已加载（不清 ⇒ 下一页的 offset 按旧列表长度算，整个错位）');
    ok(reload && /loadPage\(0, true\)/.test(reload[0]), '  └ 新筛选的第一页是**替换**不是追加');
  }

  /* 确定 / 取消：与记录页同一套纪律（决策在公用件里，页面只交数据） */
  ok(/const plan = pf\.applyPlan\(draft, filterRef\.current\)/.test(src),
     '⚠⚠ 确定走 pf.applyPlan（「草稿没变就不发请求」这个决策抽在公用件里，可断言）');
  ok(/if \(plan\.action === 'close'\) return;/.test(src),
     '  └ ⚠ 草稿与生效一致时不发请求（省一次无谓往返）');
  {
    const cancel = /const onFilterCancel = useCallback\([\s\S]{0,200}?\}, \[\]\)/.exec(src);
    ok(!!cancel, '有 onFilterCancel（取消 / 点遮罩）');
    ok(cancel && /setFltOpen\(false\)/.test(cancel[0]), '  └ 取消关窗');
    ok(cancel && !/reloadWithFilter/.test(cancel[0]),
       '⚠⚠⚠ 取消**不发请求**（取消 = 什么都没发生）');
  }

  /* 入口与弹窗都是公用组件（与记录页**同一个外观、同一份逻辑**） */
  ok(/<FilterEntry/.test(src), '学堂页用的是公用入口组件（<FilterEntry）');
  ok(/<FilterModal/.test(src), '学堂页用的是公用弹窗组件（<FilterModal）');
  ok(/<FilterEntry[\s\S]{0,420}?disabled=\{!canFilter\}/.test(src),
     '⚠ 后端不支持筛选时入口不给点（发了一定 404，用户只会看到「加载失败」）');
  eq((src.match(/countText=\{model\.countText\(items\.length, total, filtered\)\}/g) || []).length, 2,
     '⚠⚠ 入口与弹窗的计数**同源**且都用生效筛选（少一处 = 一个说「共 N 个」、一个说「筛出 M 个」）');

  /* ⚠⚠ 工具栏是列表的**兄弟**（钉在顶部），显示条件与内容留白**同源** */
  {
    const iBar = src.indexOf('style={s.toolBar}');
    /* ⚠ 列表标签是 `<FlatList`（2026-10-10 深夜回到 RN 原版） */
    const iList = src.indexOf('<FlatList');
    ok(iBar > 0 && iList > 0 && iBar < iList,
       '⚠⚠⚠ 工具栏在 <FlatList> **之前** —— 是兄弟节点，才会「始终在顶部」（放进列表里会跟着滚走）');
    const tb = /toolBar: \{[\s\S]*?\n    \}/.exec(src);
    ok(tb && !/flexGrow/.test(tb[0]),
       '⚠⚠ 工具栏样式里**没有** flexGrow（套 s.page 会把列表挤没 —— 记录页踩过同一个坑）');
    eq((src.match(/showTools/g) || []).length, 3,
       '⚠⚠ 工具栏「显示条件」与「内容留白」共用同一个 showTools（定义 1 处 + 使用 2 处）');
    ok(/contentContainerStyle=\{showTools \? \[s\.page, s\.pageWithTools\] : s\.page\}/.test(src),
       '  └ 工具栏显示着时才给滚动内容补顶部留白（否则第一条钻到它底下）');
    ok(/canBooks && \(items\.length > 0 \|\| filtered \|\| phase === 'loading'\)/.test(src),
       '  └ ⚠ 判据里带 filtered：被筛空（items 为 0）时工具栏也得在，否则用户没有出口改筛选；'
       + '带 loading：下拉清空那一瞬间别让整屏跳一下（见下面下拉刷新那一组）');
  }

  /* 空态：「被筛空」有独立分支，并且给它出路 */
  ok(/filtered && phase !== 'loading'/.test(src),
     '⚠⚠ 「被筛空」与「真没有」是**两支**（合成一句会让用户以为馆里的书签丢了）');
  ok(/onPress=\{onResetFilter\}/.test(src),
     '  └ 且给「清除筛选」的出口（否则用户只能在筛选面板里瞎试）');

  /* ================================================================
   * ★ 下拉刷新（2026-10-04）—— 记录页那四个「静默失效」的坑一个都不许重犯
   * ================================================================ */
  {
    const onRef = /const onRefresh = useCallback\(\(\) => \{[\s\S]{0,1100}?\}, \[canBooks, loadPage\]\)/.exec(src);
    ok(!!onRef, '有 onRefresh（下拉刷新的入口）');
    ok(onRef && /genRef\.current \+= 1/.test(onRef[0]),
       '⚠⚠ 下拉先作废在飞的请求（它回来会往这份即将被替换的列表追加旧数据）');
    ok(onRef && /loadingRef\.current = false/.test(onRef[0]),
       '  └ ⚠⚠ 放开闸门（旧请求占着 ⇒ 新请求被自己的「已经在路上」挡回去，表现为拉了没反应）');
    ok(onRef && /loadPage\(0, true\)/.test(onRef[0]),
       '  └ 下拉刷的是「正在看的这份列表」：沿用当前筛选、从第 0 条**替换**');
    /* ★ 2026-10-11 用户：「学堂页面下拉刷新时，要将列表数据清空，等待新数据」。
       ⚠⚠ 这一条**翻了旧决定**：旧版特意不清（理由是「失败时别闪成空屏」），
          但那样屏上的列表跟刷新前一模一样 ⇒ 用户看不出刷新有没有生效。 */
    ok(onRef && /setItems\(\[\]\)/.test(onRef[0]) && /itemsRef\.current = \[\]/.test(onRef[0]),
       '⚠⚠⚠ 下拉**必须清空列表**（items + itemsRef 都要清 —— 只清 state 的话 '
       + '下一次翻页会按旧条数算 offset）');
    ok(onRef && /setTotal\(0\)/.test(onRef[0]),
       '  └ total 也要清：不清的话工具栏那句「共 N 个 · 已加载 M 个」会挂着上一份的旧数字');
    ok(onRef && onRef[0].indexOf('setItems([])') < onRef[0].indexOf('loadPage(0, true)'),
       '  └ ⚠ 清空要写在 `loadPage` **之前**（loadPage 会同步 setPhase("loading")，'
       + '顺序反了就先渲染出「旧列表 + 加载中」再闪成空屏）');
    ok(/const showTools = canBooks && \(items\.length > 0 \|\| filtered \|\| phase === 'loading'\)/.test(src),
       '⚠⚠⚠ 清空那一瞬间工具栏**不许跟着消失**（否则整屏往上跳一下再跳回来，像闪屏）'
       + ' ⇒ 显示条件必须带上 phase === "loading"');
    ok(/loadPage\(0, true\)\?\.finally\(\(\) => setRefreshing\(false\)\)/.test(src),
       '⚠⚠ 转圈在真拉完时收（.finally：失败也必须收圈；setTimeout 蒙时长 = 网慢时圈先消失）');
    ok(/const \[refreshing, setRefreshing\] = useState\(false\)/.test(src),
       '⚠ refreshing 必须 useState（ref 改了不重渲染 ⇒ 圈转不起来、也停不下）');
    /* ★ 2026-10-10 二改：下拉刷新 = `components/PullRefresh.tsx`（**松手才刷**）。
       ⚠⚠⚠ 走的是「**包一层**」，但这跟以前那种「包一层手势壳」不是一回事：
          PullRefresh 只被动听 touch（onTouchStart/Move/End）+ 整块 translateY，
          **不抢手势、不碰原生视图**（源码依据在组件顶部）。所以「包错层级 ⇒
          手势根本没附着 ⇒ 拉不动且不报错」那种坑在这里不存在。
       ⚠⚠⚠ 反过来，**不许**再用 RN 的 `RefreshControl`：安卓上它过阈值就刷。 */
    ok(/<PullRefresh\s[\s\S]{0,200}?refreshing=\{refreshing\}[\s\S]{0,200}?onRefresh=\{onRefresh\}/.test(src),
       '⚠⚠⚠ 学堂页的列表要被 `<PullRefresh refreshing={refreshing} onRefresh={onRefresh}>` 包住');
    ok(src.indexOf('RefreshControl') < 0,
       '⚠⚠⚠ 学堂页不许再用 RN 的 `RefreshControl` —— 安卓上它下拉一过阈值就刷（不等松手）');
    ok(!/GestureFlatList|gesture-handler/.test(src),
       '  └ 也不许再出现手势库 / 手势壳的痕迹（下拉刷新一个字的手势都不抢）');
    ok(/return loadPage\(0, true\)\?\.finally\(/.test(src),
       '⚠⚠⚠ `onRefresh` 必须**把 promise 交出去**（`PullRefresh` 钉到它 resolve 才收圈）');

    /* ★ 2026-10-11 用户：「把 .docx 放进登记的书籍文件夹即可 —— 移除这种提示文字。
       以后做功能尽量不要出现这些提示文字」⇒ 空态**只说事实、不教怎么做**。
       ⚠⚠ 判据落在 `emptyTip` 这个**样式**上，不是某一句文案：文案换个名字、位置挪一挪，
         只要那行小字还挂着就照样红（只查「有没有某句话」是假绿）。 */
    ok(!/emptyTip/.test(src),
       '⚠⚠⚠ 查询面板空态里不许再有「怎么做」的说明小字（用户 2026-10-11：「移除这种提示文字」）');
    ok(!/登记的书籍文件夹|只有自建后端提供|换个干支再试|会自动加载/.test(src),
       '  └ 那几句具体的说明文案，也别换个名字又回来');
    ok(/return books\.fetchPage\(offset, model\.PAGE_SIZE/.test(src),
       '⚠⚠ loadPage 返回 promise（不返回 ⇒ 收圈只能靠定时器蒙时长）');
  }

  /* ⚠ App 必须把 active 传下去：漏传 ⇒ 那一处的学堂页永远不加载（白屏，且不报错） */
  const appSrc = stripComments(fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8'));
  const tags = (appSrc.match(/<Study\b/g) || []).length;
  const withActive = (appSrc.match(/<Study\s+active=/g) || []).length;
  ok(tags >= 1, '在 App.tsx 里抓到了 <Study> 标签（正则没写歪）');
  eq(withActive, tags, '⚠ 每一处 <Study> 都传了 active（漏一处 ⇒ 那处学堂页永远不加载）');

  /* ================================================================
   * ★ 阅读页（2026-10-04）—— 点书签 → 推入层读整章 / 整本分页
   * ================================================================ */
  /* ---------------- 学堂页 = 切换栏 + 两个常驻面板（★ 2026-10-11） ---------------- */
  console.log('\n--- 学堂页：顶部切换栏 + 查询/书籍 两个面板 ---');
  {
    const rd = (rel) => {
      const p = path.join(ROOT, rel);
      return fs.existsSync(p) ? stripComments(fs.readFileSync(p, 'utf8')) : '';
    };
    const shellSrc = rd('src/screens/study/Study.tsx');
    const paneSrc = rd('src/screens/study/QueryPane.tsx');
    const booksSrc = rd('src/screens/study/BooksPane.tsx');
    const segSrc = rd('src/components/SegTabs.tsx');

    /* ---- 切换栏：公用件 + 受控 ---- */
    ok(segSrc.length > 0, 'components/SegTabs.tsx 存在（切换栏是公用件，不是学堂页私有）');
    ok(/value: T;/.test(segSrc) && /onChange: \(key: T\) => void;/.test(segSrc),
      '⚠⚠ SegTabs 必须是**受控**的（value/onChange 由调用方给）—— 自己存一份就会出现「组件以为选了 A、页面在显示 B」');
    ok(!/useState/.test(segSrc), '⚠ SegTabs 内部**不存**选中值（不许 useState）');
    ok(/tabs\.map\(/.test(segSrc), '⚠ 页签由 tabs 数组循环渲染（不许在 JSX 里手写两个按钮）');

    /* ---- 壳：引对东西 ---- */
    ok(/from '\.\.\/\.\.\/components\/SegTabs'/.test(shellSrc), '学堂壳从 components/SegTabs 引切换栏');
    ok(/from '\.\/QueryPane'/.test(shellSrc) && /from '\.\/BooksPane'/.test(shellSrc),
      '学堂壳引两个面板（查询 / 书籍）');
    ok(/const PANE_TABS[\s\S]{0,240}?label: '查询'[\s\S]{0,120}?label: '书籍'/.test(shellSrc),
      '⚠⚠ 页签文案只在 PANE_TABS 里写**一份**（别在 JSX 里另写字面量「查询」「书籍」）');

    /* ---- ⚠⚠⚠ 本组最重要：常驻 + display 切，绝不条件渲染 ---- */
    ok(/display: 'none'/.test(shellSrc), '⚠⚠⚠ 没选中的面板用 display:none 藏起来（不是卸载）');
    ok(!/\?\s*<QueryPane|\?\s*<BooksPane|&&\s*<QueryPane|&&\s*<BooksPane/.test(shellSrc),
      '⚠⚠⚠ 两个面板**绝不条件渲染** —— QueryPane 装着已加载列表 + 生效筛选 + 滚动位置，卸载一次全丢（切回来要从第 0 条重拉）');
    ok(/\[s\.pane, showQuery \? null : s\.hidden\]/.test(shellSrc) &&
       /\[s\.pane, showBooks \? null : s\.hidden\]/.test(shellSrc),
      '⚠ 两个面板**都**按选中态切 display（漏一处 = 那个面板永远藏着或永远露着）');
    ok(/active && pane === 'query'/.test(shellSrc) && /active && pane === 'books'/.test(shellSrc),
      '⚠ active 语义 = tab 显示中 **且** 本面板被选中（否则一进学堂就白发一个查询请求）');
    ok(/position: 'absolute', top: 0, left: 0, right: 0, bottom: 0/.test(shellSrc),
      '⚠ 两块面板叠放用**显式四边**，不用 StyleSheet.absoluteFillObject（本项目里它是 undefined ⇒ 静默不定位）');

    /* ---- 两个面板：各自的边界 ---- */
    ok(paneSrc.length > 0, 'QueryPane.tsx 存在（「查询」= 原来的学堂页内容）');
    ok(!/SegTabs/.test(paneSrc),
      '⚠ QueryPane 里不许出现 SegTabs —— 切换栏属于壳；这个面板要被别处复用时不该自带一条切换栏');
    ok(!/display: 'none'/.test(paneSrc),
      '⚠ 显隐由壳统一管（面板自己不藏自己，否则两处判据迟早不一致）');
    ok(booksSrc.length > 0, 'BooksPane.tsx 存在');
    ok(/active: boolean/.test(booksSrc),
      '⚠ BooksPane 吃 active（第一次 active 变 true 才拉 —— 与 QueryPane 同一条懒加载约定）');

    /* ---- 书籍面板 = 书架（★ 2026-10-11「从后端获取书籍列表，显示书籍」）----
       ⚠⚠⚠ 2026-10-19 换协议：书架改走 `GET /books`（`books.shelf()`），
       不再借 `/books/bookmarks` 的 `books[]`（那个接口现在叫「书签列表」，
       它的 `books[] 是「命中书签的书 + 各自数量」，是筛选统计，不是书架）。 */
    ok(/books\.shelf\(\)/.test(booksSrc),
      '⚠⚠ 书架走 core/books.js 的 shelf() —— GET /books 一本一行元信息，不 stat 磁盘');
    /* ⚠ 反着钉一条：别自己发明一个「列书」的接口名（后端没有这个路由，发了必然 404）。 */
    ok(!/\/books\/list|\/books\/books|bookList/.test(booksSrc),
      '⚠ 不许自己拼一个「列书」的接口名 —— 后端没有这个路由，发出去必然 404');
    ok(/Array\.isArray\(res\.items\)/.test(booksSrc),
      '⚠⚠⚠ 清单取的是响应里的 **items**（不是 books —— 老口径那个 books[] 是书签筛选统计，'
      + '拿它当书架会拿到「只有命中书签的书」，一处不报错）');
    ok(/supportsBooks\(\)/.test(booksSrc),
      '⚠ 只有自建后端有这份数据：不支持时如实说明，不发必然 404 的请求');
    /* ⚠ 下面三条**钉在具体那一行/那个函数体**，不是「文件里出现了 startedRef/genRef」——
       只查名字的话，把闸门那一行删掉（留着赋值那句）照样全绿，是标准的假绿。 */
    ok(/if \(startedRef\.current\) return;/.test(booksSrc),
      '⚠ 懒加载闸门（切走再切回不重来 —— 状态都还在）');
    /* ⚠⚠ 代次只有**一处**加法（`bumpGen` 的函数体），下拉刷新与重试都调它：
       分别在两处各写一行的话，漏改一处不会有任何症状，断言也只能看到
       「文件里出现过 +1」—— 又是假绿。 */
    ok(/const bumpGen = useCallback\(\(\) => \{ genRef\.current \+= 1; \}, \[\]\);/.test(booksSrc),
      '⚠⚠ 作废在飞请求只有一处实现（bumpGen），里面真的 +1');
    eq((booksSrc.match(/bumpGen\(\);/g) || []).length, 2,
      '⚠ 下拉刷新与「点这里重试」**都**要作废在飞的请求（漏一处 = 那条路上旧结果会盖掉新画好的书架）');
    ok(/return load\(\)\?\.finally/.test(booksSrc),
      '⚠ 下拉刷新把 promise 交出去（PullRefresh 钉到它 resolve 才收圈；否则网慢时圈提前消失）');
    /* ★ 2026-10-11 用户：「学堂页面下拉刷新时，要将列表数据清空，等待新数据」——
       书架在同一个学堂页里 ⇒ 同一条规矩（两个面板别只改一个）。 */
    const booksRefresh = /const onRefresh = useCallback\(\(\) => \{[\s\S]{0,700}?\}, \[canBooks, load, bumpGen\]\)/.exec(booksSrc);
    ok(!!booksRefresh, '书架 onRefresh 的函数体能抓到（抓不到 ⇒ 下面这条会变哑断言）');
    ok(booksRefresh && /setList\(\[\]\)/.test(booksRefresh[0]),
      '⚠⚠⚠ 书架下拉刷新也要**先清空**（与查询面板同一条：等新数据，别让旧书架挂在屏上）');

    /* ---- 点一本书 ---- */
    ok(/model\.bookTarget\(item\)/.test(booksSrc),
      '⚠ 点封面交给 model.bookTarget 生成 target（那里 chapter/offset 显式给 null ⇒ 点开书接着读）');
    ok(!/chapter:\s*0\b/.test(booksSrc),
      '⚠⚠⚠ 视图里不许出现 `chapter: 0` —— 第一章是**合法值**，阅读页的 `!= null` 判据'
      + '会把它当成「冲着某一段来」，本地阅读位置永远用不上（而且不报错）');
    ok(/onOpenBook=\{onOpenBookmark\}/.test(shellSrc),
      '⚠ 壳把**同一个** onOpenBookmark 透给书架（App 只有一套阅读页 target 形状）');
    /* ⚠ 换协议后没有「读不了的书」了：解析失败的书根本进不了 books 表 ⇒ 没有 bad 分支。 */
    ok(!/\bbad\b/.test(booksSrc),
      '⚠⚠ 老那套「读不了的书」（解析失败置灰）已随协议删除 —— 进不了表的书不会出现在书架上');
    ok(!/敬请期待|暂无|开发中|敬请|coming soon/i.test(booksSrc),
      '⚠ 依然不许占位文案（用户明确反感）——「书籍目录里还没有 docx」说的是事实，不是承诺');

    /* ---- 书架那层纯函数（study/model.js）----
       ⚠⚠⚠ 2026-10-19 换协议：`book` 从**文件名**换成 **book_key**（内容哈希），
       并新增 `title`（App 导航栏书名读它）。`SHELF_LIMIT` 随之删除 ——
       书架不再借 `/books/bookmarks` 拉清单，没有「用 limit=1 把 items 压到最小」这回事了。 */
    eq(typeof studyModel.SHELF_LIMIT, 'undefined',
      '⚠⚠ SHELF_LIMIT 已删（书架改走 GET /books，不再借书签接口的 books[]）');
    eq(studyModel.bookTarget({ bookKey: 'abc123', title: '三命通会' }).chapter, null,
      '⚠⚠⚠ 整本打开时 chapter 必须是 **null**（0 = 第一章 ⇒ 阅读页判为「冲着某一段来」，'
      + '本地阅读位置被跳过，打开到别处且不报错）');
    eq(studyModel.bookTarget({ bookKey: 'abc123', title: '三命通会' }).offset, null,
      '⚠ offset 也必须是 null（否则阅读页会去高亮「书签那一段」，而这里根本没有书签）');
    eq(studyModel.bookTarget({ bookKey: 'abc123', title: '三命通会' }).book, 'abc123',
      '⚠⚠⚠ book 放的是 **book_key**（内容哈希），不再是文件名 —— 拿文件名去 /books/chapter 只会 404');
    eq(studyModel.bookTarget({ bookKey: 'abc123', title: '三命通会' }).title, '三命通会',
      '⚠⚠ 书名另带 title 字段（book 是哈希，导航栏不能显示哈希）');
    eq(studyModel.bookTarget(null).book, '', '没有书时不崩');

    /* ⚠⚠⚠ 2026-10-11 用户：「书籍页面将书签等提示字移除，将书本缩小，太大了」——
       顶部汇总行（「共 13 本 · 3717 条书签」）与每本书下面那行（「750 条书签」 /
       「还没有书签」/「这本书读不了」）**整块删掉**：算它们的纯函数 + 调用点 + 样式一起清
       （本项目规矩：「全部移除」= 逻辑 / 样式 / 文案一起清）。
       ⇒ 这里**正着钉两条「不许回来」**：函数不再导出 + 视图里一个字都不许再出现。
       只钉「某个词不存在」不够 —— 把函数留着不调也叫没清干净（下次有人看见名字就接回去）。 */
    eq(typeof studyModel.shelfSummaryText, 'undefined',
      '⚠⚠ 汇总行那套文案函数已删除（别留在 model 里当死代码）');
    eq(typeof studyModel.bookMetaText, 'undefined',
      '⚠⚠ 每本书下面那行小字的函数已删除');
    ok(!/条书签/.test(booksSrc),
      '⚠⚠⚠ 书架视图里**一个「书签」字样都不该有**（用户要求把这些提示字移除）');
    ok(!/s\.meta\b|s\.bar\b/.test(booksSrc),
      '⚠ 封面下那行小字 / 顶部汇总行的样式与渲染都不许再加回来');

    /* ---- 版式：一行三本 + 封面缩小（用户 2026-10-11：「书本缩小，太大了」）---- */
    ok(/numColumns=\{3\}/.test(booksSrc),
      '⚠ 书架一行**三本**（原先两列 340 宽 —— 一屏只装得下两本，用户嫌太大）');
    ok(/cell: \{ width: rpx\(220\), marginBottom: rpx\(26\) \},/.test(booksSrc),
      '⚠ 每格宽 220（3 × 220 + 2 个 21 间隙 + 24 × 2 外边距 ≈ 750 设计稿宽）');
    ok(/cover: \{[\s\S]{0,80}?width: rpx\(220\),[\s\S]{0,80}?height: rpx\(280\),/.test(booksSrc),
      '⚠ 封面 220 × 280（保持 32 开的 1.27 比例，别只改宽不改高 —— 书会被压扁）');

    /* ★ 2026-10-11 用户：「书籍封面上要显示：共计多少案例。数量就是书签的数量」
       ⇒ 数量必须来自服务端算好的 `item.count`（前端**不自己数**），且画在**封面之内**。
       ⚠⚠ 措辞是「案例」、不是「书签」—— 上面那条「一个『书签』字样都不该有」仍然有效。 */
    ok(/共计\s*\{item\.bookmarkCount\}\s*案例/.test(booksSrc),
      '⚠⚠⚠ 封面底部那行「共计 N 案例」的数量必须来自 `item.bookmarkCount`（服务端算好的），别自己数');
    ok(/style=\{s\.count\}/.test(booksSrc),
      '  └ 而且得画在**封面里**（`s.count` 这一层）—— 加回「封面下面另起一行」就是用户删过的那行');
    ok(/item\.bookmarkCount > 0 \?/.test(booksSrc),
      '⚠ count=0（一条都没命中的那本）不显示这一行 —— 封面上写「共计 0 案例」是负面信息');

    /* ★ 2026-10-11 用户：「把 .docx 放进登记的书籍文件夹即可 —— 移除这种提示文字。
       以后做功能尽量不要出现这些提示文字」⇒ 空态**只说事实、不教怎么做**。 */
    ok(!/emptyTip/.test(booksSrc),
      '⚠⚠⚠ 书架空态里不许再有「怎么做」的说明小字（用户 2026-10-11：「移除这种提示文字」）');
    ok(!/放进登记的书籍文件夹|只有自建后端提供/.test(booksSrc),
      '  └ 那句「把 .docx 放进登记的书籍文件夹即可」也别换个名字又回来');
    eq(studyModel.shelfEmptyText('fail', '登记的书籍目录不存在'), '登记的书籍目录不存在',
      '⚠ 读不到时把服务端那句原话端出来（别吞成笼统的「加载失败」）');    eq(studyModel.shelfEmptyText('ok', ''), '书籍目录里还没有 docx', '真的还没有书时那句');
  }

  console.log('\n--- reader/（点书签进阅读页）---');
  {
    /* ---- core/books.js 契约（⚠⚠⚠ 2026-10-19 换代：read() → chapter()）----
       老口径：一本书 = 一条连续段落流，按字数切片，`file` + 全书段落 `seq` 定位，
               有 `from` / `prevFrom` / `hasMore` / `whole` / `at` 那一整套「在哪一片里」。
       新口径：**章是唯一的阅读单位**。一章一个请求给全，没有片、没有游标、没有续拉。
       ⇒ 四个接口：`shelf()` / `toc()` / `chapter()` / `fetchPage()`。
       ⚠ `read()` / `whole` / `from` / `at` / `section` / `prevFrom` **全部不再导出** ——
         这里**正着钉一条「不许回来」**：它们只要还在，就说明有人把「连续流」那套接回来了。 */
    const booksLib = require(path.join(ROOT, 'src', 'core', 'books.js'));
    ok(typeof booksLib.chapter === 'function', 'core/books.js 有 chapter()（阅读页唯一的取数入口）');
    ok(typeof booksLib.shelf === 'function' && typeof booksLib.toc === 'function',
      'core/books.js 有 shelf() / toc()（书架 / 目录各自的入口）');
    ok(typeof booksLib.fetchPage === 'function', 'core/books.js 有 fetchPage()（书签列表，分页懒加载）');
    eq(typeof booksLib.read, 'undefined', '⚠⚠⚠ read() 已删（「一条连续段落流」那套的入口，别再接回来）');
    const booksSrc = stripComments(
      fs.readFileSync(path.join(ROOT, 'src', 'core', 'books.js'), 'utf8')
    );
    ok(booksSrc.indexOf('/books/chapter') >= 0, 'chapter() 打的是 /books/chapter');
    ok(booksSrc.indexOf('/books/toc') >= 0, 'toc() 打的是 /books/toc');
    ok(booksSrc.indexOf('supportsBooks()') >= 0,
      '⚠ 四个接口都有 supportsBooks 前置门（只有自建后端有这份数据，不支持就如实说，不发必死的请求）');

    /* ---- ★★★ chapter 的 `chapter` 判据必须是 `!= null`（不是 truthy）----
       ⚠⚠⚠ 第 0 章是**合法值**：写成 `if (p.chapter)` 会把「点第 0 章的书签」
       当成「没传」⇒ 服务端默认又正好是 0，**看起来正常**；等到有书从别的章
       进来才炸 —— 而且炸的现象是「跳到了第一章」，不是报错。
       ⚠ 这条与 Reader 里 `chapter = 0` 是合法值是**同一条纪律的两侧**。 */
    ok(/p\.chapter != null/.test(booksSrc),
      '⚠⚠⚠ chapter 的判据是 != null（第 0 章是合法值，truthy 会把它当成没传）');
    ok(!/p\.chapter \?/.test(booksSrc) && !/p\.chapter \|\|/.test(booksSrc),
      '  └ 而且不许出现 truthy / `||` 兜底（那正是把第 0 章吃掉的那两种写法）');

    /* ---- ★★★ 2026-10-19：query 白名单必须**真的带上 chapter** ----
       ⚠⚠⚠ 这次的坑与 2026-10-16 的 `whole` 同源、且更隐蔽：`chapter()` 的 query 是
       **逐键白名单**拼的，没列进来的键**静默丢掉**。写成
       `if (p.chapter != null) q.chapter = p.chapter;` 是对的；一旦有人「顺手」改成
       `const q = { book: p.book }` 少一行，tsc 过、调用处也对、UI 上也确实在加载 ——
       只是**每一章都加载第 0 章**（点第 300 章看到第一章的内容）。
       ⇒ 所以这里**真的调一次 chapter()**，把送进 localsdk 的 query 抓下来。 */
    {
      const sdk = require(path.join(ROOT, 'src', 'core', 'localsdk.js'));
      const realRequest = sdk.request;
      let sent = null;
      sdk.request = function (url, opt) {
        /* ⚠ 同步抓得住：chapter() 是先拼 query、再调 request 的，同一个 tick */
        sent = { url: url, query: (opt && opt.query) || null };
        return Promise.resolve({ ok: true, status: 200, data: { blocks: [] } });
      };
      /* query 归一成「键排序后的 k=v」—— 不因代码里几行的先后顺序变了就误报 */
      function qPairs() {
        const q = sent && sent.query;
        if (!q) return null;
        return Object.keys(q).sort().map(function (k) { return k + '=' + q[k]; });
      }

      booksLib.chapter({ book: 'abc123', chapter: 51 });
      eq(sent && sent.url, '/books/chapter', '⚠ chapter() 打的是 /books/chapter');
      eq(qPairs(), ['book=abc123', 'chapter=51'],
        '⚠⚠⚠ chapter() 必须把 chapter 拼进 query —— 白名单漏键 = **静默丢参**，全链路没有一处会报错');

      booksLib.chapter({ book: 'abc123', chapter: 0 });
      eq(qPairs(), ['book=abc123', 'chapter=0'],
        '⚠⚠⚠ chapter = 0 也必须真的发出去（第一章是合法值，丢掉它就永远从第 0 章开始）');

      /* ⚠ `seek` 是「拿到 blocks 之后再算」的东西，**不是请求参数** ——
         混进 query 服务端不认（白名单外的键会被忽略），但那是把两层搞混的信号。 */
      booksLib.chapter({ book: 'abc123', chapter: 3, seek: { offset: 42, text: 'x' } });
      eq(qPairs(), ['book=abc123', 'chapter=3'],
        '⚠ seek 不许进 query（它是客户端换算用的，不是服务端参数）');

      sdk.request = realRequest;
    }

    /* ---- toc() 的形状兜底（空目录是**正常结果**，不是失败）---- */
    ok(booksSrc.indexOf('d.chapters') >= 0,
      '⚠⚠⚠ toc() 认的字段是 **chapters**（老口径叫 sections，写成 sections 会静默拿到 undefined'
      + ' ⇒ 目录一片空白、一处不报错）');
    ok(booksSrc.indexOf('d.items') >= 0,
      '⚠⚠⚠ shelf() 认的字段是 **items**（不是 books —— 那个 books[] 是书签筛选统计）');

    /* ---- reader/model.js 纯函数直跑 ---- */
    const readerModel = require(path.join(ROOT, 'src', 'screens', 'reader', 'model.js'));
    /* ⚠ 两份源码都**剥注释**后再查：注释里解释「删掉了什么」时会带上旧名字
       （比如 `splitAt` / `atSeqOf` / `idx - 1`），直接全文 indexOf 会被自己的注释顶成假绿。
       ⚠ 声明放在这里（纯函数断言之前）：下面 model 层的反向断言要用 `readerModelSrc`。 */
    const readerSrc = stripComments(
      fs.readFileSync(path.join(ROOT, 'src', 'screens', 'reader', 'Reader.tsx'), 'utf8')
    );
    const readerModelSrc = stripComments(
      fs.readFileSync(path.join(ROOT, 'src', 'screens', 'reader', 'model.js'), 'utf8')
    );
    eq(readerModel.bookTitle('渊海子平（徐大升）.docx'), '渊海子平（徐大升）', '书名去掉 .docx 后缀（导航栏标题）');
    /* ---- ★★★ 2026-10-14 十五改：目录**回来了**（换了形态，取向整体反转）----
       ⚠ 两次改向都记在这里，别再互相打脸：
         · 10-12 用户「移除顶部目录按钮和左侧的文字，就让这个页面完全属于阅读上下懒加载就行了」
           ⇒ 目录**整块移除** —— 删掉的是「**顶部常驻**那一枚按钮 + 面包屑」；
         · 10-14 用户「像那些阅读小说软件一样点击屏幕出现上一章 下一章 目录 夜间等这些
           底部和头顶的工具栏出现」⇒ 目录**回来了**，但形态是「**点屏幕才呼出**的工具栏里的
           一枚按钮，点开的是**全屏目录面板**。
       ⇒ 所以下面这组从「反向断言」**翻成正向**：工具栏文案**必须在**；
         而当年那套常驻形态（面包屑 `crumbText`、旧名 `tocDepth`）**依然不许回流**。 */
    eq(readerModel.TOC_TEXT, '目录', '⚠⚠ 工具栏「目录」按钮的文案（十五改：呼出式工具栏里那一枚）');
    eq(readerModel.PREV_CH_TEXT, '上一章', '⚠⚠ 工具栏「上一章」（导航按钮，语义 = 跳到那一章开头）');
    eq(readerModel.NEXT_CH_TEXT, '下一章', '⚠⚠ 工具栏「下一章」（与上一章对称）');
    eq(readerModel.TOC_EMPTY_TEXT, '这本书没有章节',
      '⚠ 空目录只说**事实**、不教用户怎么办（用户明确反感占位 / 承诺式文案）');
    eq(readerModel.TOC_CLOSE_TEXT, '关闭',
      '⚠ 目录面板是全屏的 ⇒ 必须有一个明确出口（不能只靠系统返回键）');
    /* ---- ★★★ 2026-10-19 照 demo 重做：侧栏抽屉那一族文案 ---- */
    eq(readerModel.BM_TEXT, '书签', '侧栏第二个页签（照 demo 的 aside.tabs：目录 / 书签）');
    eq(readerModel.SEARCH_PLACEHOLDER, '搜索标题 / 书签',
      '⚠⚠ 搜索框占位文案与 demo **一字不改**（`placeholder="搜索标题 / 书签"`）');
    eq(readerModel.BM_EMPTY_TEXT, '这本书没有书签', '⚠ 书签栏空着只说**事实**（同目录那条纪律）');
    eq(readerModel.NOMATCH_CH_TEXT, '没有匹配的章节', '⚠ 搜索没命中也要说一句事实（不是一片空白）');
    eq(readerModel.NOMATCH_BM_TEXT, '没有匹配的书签', '  └ 书签栏同理');
    eq(readerModel.UNTITLED_TEXT, '（卷首）',
      '⚠ 章名为空（无标题书整本一章）时头部显示它 —— 与 demo 的 `（卷首）` 同一个字');
    eq(readerModel.LOADING_TEXT, '正在加载…', '⚠⚠ 加载框与目录「正在取」共用这一句（与其它加载框同一个字，不另写）');
    eq(readerModel.FAIL_TEXT, '加载失败', '⚠ 失败态那句（目录取不到时原样端出来）');
    eq(readerModel.RETRY_TEXT, '点这里重试', '⚠ 失败态要留一个**可点的出口**（不许只显示一句「加载失败」就没了）');
    eq(readerModel.crumbText, undefined, '⚠⚠⚠ 面包屑的 crumbText 依然不许回流（章名只有一级，不做路径）');
    eq(readerModel.tocDepth, undefined, '⚠⚠⚠ 旧名 tocDepth 依然不许回流（改名 blockDepth，别让人以为目录还在）');
    eq(readerModel.titleDepth, undefined,
      '⚠⚠⚠ titleDepth（拿数字 level 算缩进）整条删掉 —— 块类型只有 h1|h2|h3 三档，'
      + '照旧喂数字会**全部落到 0 档**（缩进全没，而且不报错）');

    /* ---- ★★★ 2026-10-19 换代：老协议那一族纯函数**全部不许再导出** ----
       ⚠⚠⚠ 老口径 = 「一本书是一条连续段落流」：全书 `seq` 定位、按字数切片、
         `from` / `prevFrom` / `hasMore` / `whole` / `at` / `section` 那一整套。
         新口径 = 「章是唯一的阅读单位」：一章一次给全，没有片、没有游标、没有续拉。
       ⇒ 这些函数只要还在 module.exports 里，就说明有人打算把「连续流」接回来 ——
         所以这里**正着钉一条「不许回来」**（只删调用点不够，名字留着就有人接）。 */
    {
      const dead = [
        'atSeqOf', 'splitAt', 'needFillUp', 'canLoadUp', 'joinReject', 'joinPrepend', 'prevFrom',
        'mergeParas', 'appendParas', 'prependParas', 'nextFrom', 'hasMoreDown',
        'rowIndexOfSeq', 'seekRowIndex', 'chapterAt', 'chapterRowAt', 'chapterIndex',
        'isBookmarkPara', 'matchPara', 'mergeSections', 'jumpable',
        'SPACER_UP_KEY', 'SPACER_KEY', 'SPACER_DOWN_KEY', 'PREV_KEY',
        'PREV_TIP_TEXT', 'PULL_MORE_TEXT', 'RELEASE_MORE_TEXT', 'PREV_CHAPTER_TEXT',
        'EDGE_RATIO'
      ];
      const alive = dead.filter(function (n) { return readerModel[n] !== undefined; });
      eq(alive, [],
        '⚠⚠⚠ 老协议那一族纯函数必须**全部不再导出**（章是唯一阅读单位，没有「片 / 游标 / 续拉」）'
        + ' —— 还活着的：' + alive.join(', '));
      ok(readerModel.firstContentRowIndex === undefined,
        '⚠⚠⚠ firstContentRowIndex（跳过前置空白找正文第一行）必须删干净 —— '
        + '一次一章之后第 0 行恒为内容行，定位落空时直接 scrollToOffset({offset:0})');
      ok(readerModel.SPACER_DOWN_KEY === undefined,
        '⚠⚠⚠ 老那个「下面那块空白」的 key 也删干净了（曾经留了个墓碑值 __spacer_down__，'
        + '现在整条删除 —— 留着它就是给空白行留后门）');
    }

    /* ---- ★ 块类型 → 缩进层级（老 titleDepth(level) 的接班人）---- */
    eq(readerModel.blockDepth('h1'), 0, '章标题缩进：h1 不缩');
    eq(readerModel.blockDepth('h2'), 1, '  └ h2 缩一级');
    eq(readerModel.blockDepth('h3'), 2, '  └ h3 缩两级（封顶就在 2：块类型只有这三档）');
    eq(readerModel.blockDepth('p'), 0, '⚠ 正文块不缩（它不是标题）');
    eq(readerModel.blockDepth('source'), 0, '⚠ 出处块（小字）同样不缩');
    eq(readerModel.blockDepth(undefined), 0, '⚠ type 缺失 → 0（绝不让 NaN 进样式：rpx(NaN) 把整行算崩且不报错）');
    eq(readerModel.blockDepth(''), 0, '⚠ type 是空串 → 0');
    eq(readerModel.blockDepth(null), 0, '⚠ type 是 null → 0（服务端脏数据）');
    eq(readerModel.blockDepth(1), 0,
      '⚠⚠⚠ 喂**数字**（老口径的 level）一律落 0 档 —— 这正是改名的理由：'
      + '老代码 `titleDepth(item.level)` 在新协议下会把所有标题排成同一级，而且不报错');
    eq(readerModel.blockDepth('h4'), 0,
      '⚠ 未知类型回 0（宁可少缩一点，也不要抛异常 / NaN 把整行算崩）');

    /* ---- ★ 这一块是不是标题块 ---- */
    eq(readerModel.isHeading('h1'), true, 'isHeading：h1 是标题');
    eq(readerModel.isHeading('h2'), true, '  └ h2');
    eq(readerModel.isHeading('h3'), true, '  └ h3');
    eq(readerModel.isHeading('p'), false, '⚠ 正文块不是标题');
    eq(readerModel.isHeading('source'), false, '⚠ 出处块不是标题');
    eq(readerModel.isHeading(undefined), false, '⚠ 缺失 → false（别在视图里内联比字符串，抽出来才守得住）');
    eq(readerModel.isHeading(null), false, '  └ null 同理');

    /* ---- ★ 书名兜底 ---- */
    eq(readerModel.bookTitle('渊海子平（徐大升）.docx'), '渊海子平（徐大升）', '书名去掉 .docx 后缀');
    eq(readerModel.bookTitle(''), '', '空串不崩');
    eq(readerModel.bookTitle(null), '', 'null 不崩');
    eq(readerModel.bookTitle('3f9a2b1c4d5e6f70'), '3f9a2b1c4d5e6f70',
      '⚠⚠⚠ book_key（内容哈希）**原样返回** —— 这个函数只是个兜底，'
      + '导航栏书名必须走响应里的 bookTitle（Reader 的 bookName），否则屏幕上显示的是一串哈希');

    /* ---- ★★★ 章内字符偏移的口径：块文本以 `\n` 相连（分隔符只在块之间）----
       ⚠⚠⚠ 这是**与服务端写入时逐字同一套**的口径（lib/booksSchema.ts）。
         块序列 `["甲乙", "丙丁"]` ⇒ 章文本 `"甲乙\n丙丁"`，`offset = 3` 指的是那个 `\n`、
         `offset = 4` 指的是「丙」。两边只要差一个分隔符，定位就会整体偏出几十个字
         （而且**不报错**，只是落到附近的段落）—— 所以这一组必须逐条钉住。 */
    {
      const blocks2 = [{ idx: 0, type: 'p', text: '甲乙' }, { idx: 1, type: 'p', text: '丙丁' }];
      /* ① 各块的起始偏移表 */
      eq(readerModel.blockStarts(blocks2), [0, 3], 'blockStarts：第 0 块从 0 起，第 1 块从 3 起（2 个字 + 1 个分隔符）');
      eq(readerModel.blockStarts([{ text: '甲' }, { text: '乙' }, { text: '丙' }]), [0, 2, 4],
        '  └ 三块也一样（每过一块多一个 \\n）');
      eq(readerModel.blockStarts([{ text: '' }, { text: 'x' }]), [0, 1],
        '⚠⚠ 空块**照样占一个分隔符**（docx 里的空段是排版的一部分，不能当不存在）');
      eq(readerModel.blockStarts([{ text: '独一块' }]), [0], '单块 ⇒ 只有起点 0');
      eq(readerModel.blockStarts([{}, {}]), [0, 1], '⚠ 没有 text 字段的块按空串算（老数据 / 脏数据）');
      eq(readerModel.blockStarts([]), [], '空章不崩');
      eq(readerModel.blockStarts(null), [], 'null 不崩');

      /* ② 偏移 ⇒ 块下标（章文本 = "甲乙\n丙丁"，长度 5：甲乙=0,1 / \n=2 / 丙丁=3,4） */
      eq(readerModel.locateInChapter(blocks2, 0), 0, 'offset 0 ⇒ 第 0 块（章首第一个字，合法值）');
      eq(readerModel.locateInChapter(blocks2, 1), 0, '  └ 甲');
      eq(readerModel.locateInChapter(blocks2, 2), 0,
        '⚠⚠⚠ offset 恰好落在**分隔符**上（= starts[1] − 1 = 2）⇒ 归**前一块的末尾**'
        + '（那个 \\n 属于「第 0 块后面」）—— 归到下一块会让用户看到「定位到下一段的第一个字」，差一个自然段');
      eq(readerModel.locateInChapter(blocks2, 3), 1, '  └ 丙（第 1 块第一个字 = starts[1]）');
      eq(readerModel.locateInChapter(blocks2, 4), 1, '  └ 丁（第 1 块最后一个字）');
      eq(readerModel.locateInChapter(blocks2, 5), -1,
        '⚠⚠⚠ 越过章尾（offset = 章文本长度本身）⇒ **-1**（不定位，停在章首）—— '
        + '写成 `offset > end` 时这一个是**合法值**，会被循环判成「落在分隔符上」⇒ '
        + '归到**倒数第二块**，用户看到「定位到上一段」且一处都不报错');
      eq(readerModel.locateInChapter(blocks2, 6), -1, '  └ 差得更远的越界同理');
      eq(readerModel.locateInChapter(blocks2, 999), -1, '  └ 差得远的越界同理');
      eq(readerModel.locateInChapter(blocks2, -1), -1, '⚠ 负数 ⇒ -1（绝不让它落到第 0 块上）');
      eq(readerModel.locateInChapter(blocks2, null), -1, '⚠ offset 缺失 ⇒ -1（不是「当 0」）');
      eq(readerModel.locateInChapter(blocks2, undefined), -1, '  └ undefined 同理');
      eq(readerModel.locateInChapter(blocks2, '3'), -1, '⚠⚠ 字符串 "3" ⇒ -1（别让 == 比较把它算进去）');
      eq(readerModel.locateInChapter([], 0), -1, '⚠⚠ 空章 ⇒ -1（不猜一个位置）');
      eq(readerModel.locateInChapter(null, 0), -1, '没有 blocks 时不崩');
      eq(readerModel.locateInChapter([{ text: '独一块' }], 3), -1,
        '⚠ 单块：offset = 长度本身（一个字符都不指）⇒ -1（与上面那条同一条纪律）');
      eq(readerModel.locateInChapter([{ text: '独一块' }], 2), 0, '  └ 最后一个字 ⇒ 0');
      eq(readerModel.locateInChapter([{ text: '' }, { text: 'x' }], 0), 0,
        '⚠⚠ 空块打头：offset 0 归第 0 块（不能因为第 0 块是空的就往后跳）');
      eq(readerModel.locateInChapter([{ text: '' }, { text: 'x' }], 1), 1,
        '  └ offset 1 归第 1 块（空块后面那个分隔符占了 1 格）');

      /* ③ 按书签文字找那一块（offset 错位时的退路）*/
      const dz = [{ idx: 0, type: 'p', text: '八字：辛卯 丁酉 庚午 丙子。' }];
      eq(readerModel.matchBlock(dz, '辛卯，丁酉，庚午，丙子'), 0,
        '⚠⚠ 书签名与正文**不是逐字相同**（正文多「八字：」、逗号变空格）⇒ 两边都只留汉字再比');
      eq(readerModel.matchBlock(dz, '辛卯 丁酉 庚午 丙子'), 0, '  └ 空格不影响（只留汉字）');
      eq(readerModel.matchBlock(dz, '辛卯，丁酉，庚午，丙子_2'), 0,
        '⚠⚠ Word 的 `_2` 重名后缀要先剥（剥不掉就多一个字，前 8 字全歪）');
      eq(readerModel.matchBlock(dz, '辛卯'), -1,
        '⚠ 不足一柱（<4 个汉字）不当锚点 —— 年柱那两个字满书都是，会乱匹配');
      eq(readerModel.matchBlock(dz, '男'), -1, '  └ 一个字的锚点更不行');
      eq(readerModel.matchBlock(dz, '丙寅，丁酉，己酉，丙寅'), -1, '本章真没有 ⇒ -1（调用方不滚，别猜）');
      eq(readerModel.matchBlock(dz, null), -1, '⚠ 书签文字缺失 ⇒ -1');
      eq(readerModel.matchBlock(dz, ''), -1, '  └ 空串同理');
      eq(readerModel.matchBlock([], '辛卯丁酉'), -1, '空章不崩');
      eq(readerModel.matchBlock(null, '辛卯丁酉'), -1, 'null 不崩');
      /* ⚠⚠ 「长 → 短」两档、**顺序不可反**：先 8 字（年月两柱）后 4 字（年柱）。
         三命通会那类正文只写「甲辰乙巳，覆灯火」—— 8 个字永远比不上，只留 8 字
         就等于这本书整本定不了位；反过来先 4 字会撞上眉批 / 目录那种旁注块。 */
      const sm = [{ idx: 0, type: 'p', text: '甲辰乙巳，覆灯火。覆灯火者，金盏衔光。' }];
      eq(readerModel.matchBlock(sm, '甲辰，乙巳，庚午，丙子'), 0,
        '⚠⚠⚠ 正文只有**年月两柱**时也要命中（前 8 字比不上 ⇒ 退回前 4 字）');
      eq(readerModel.matchBlock(sm, '甲辰乙巳，丙午'), 0,
        '⚠⚠ 8 字前缀（甲辰乙巳丙午）比不上、前 4 字（甲辰乙巳）比得上 ⇒ 仍要命中'
        + ' —— 这是「两档都要留」的照妖镜：只留 8 字，三命通会那一类整本定不了位');
      eq(readerModel.matchBlock(sm, '甲辰'), -1,
        '⚠⚠ 只有**一根月柱**（2 个汉字）不当锚点 —— 满书都是这两个字，会乱匹配');

      /* ④ 「书签落在第几块」= offset 优先、文字退路 */
      const blocks3 = [
        { idx: 0, type: 'p', text: '甲乙' },
        { idx: 1, type: 'p', text: '丙丁' },
        { idx: 2, type: 'p', text: '八字：辛卯 丁酉 庚午 丙子。' }
      ];
      eq(readerModel.bookmarkBlock(blocks3, 4, '完全不相干的文字'), 1,
        '⚠⚠ offset 量出来了就信 offset（最硬的线索）—— 文字只是退路');
      eq(readerModel.bookmarkBlock(blocks3, 999, '辛卯，丁酉，庚午，丙子'), 2,
        '⚠⚠⚠ offset 越界 ⇒ 按**文字**再找一次（书在 Word 里重存过就会整体错位）');
      eq(readerModel.bookmarkBlock(blocks2, 999, '不相干'), -1, '两样都没有 ⇒ -1（不定位，停在章首）');
      eq(readerModel.bookmarkBlock(blocks2, null, null), -1, '全空 ⇒ -1');
      eq(readerModel.bookmarkBlock(null, 0, 'x'), -1, '没有 blocks 时不崩');
      eq(readerModel.bookmarkBlock(blocks2, 0, 'x'), 0, '⚠ offset = 0 是合法值（章首第一个字）⇒ 必须命得中');
      eq(readerModel.bookmarkBlock(blocks2, 2, 'x'), 0,
        '⚠⚠ offset 落在分隔符上 ⇒ 归前一块（与 locateInChapter 同一条口径）');
    }

    /* ---- ★★★ 2026-10-19 照 demo 重做：`highlightRange`（demo 的 Range 在 RN 里的对应物）----
       demo 用 `Range.setStart(n, off)` 把偏移那个字一直到段尾包起来；RN 没有 Range，
       等价物是把块文本切成「前 / 高亮 / 后」三段用嵌套 <Text> 画 —— 区间就在这里算。 */
    {
      const blk = '八字：辛卯 丁酉 庚午 丙子。';
      eq(readerModel.highlightRange(blk, 3, '辛卯 丁酉 庚午 丙子'), { start: 3, end: 14 },
        '⚠⚠ 有书签文字且正好从 local 起 ⇒ 只亮**它自己**（真实数据里书签圈住的就是那四柱，'
        + '长段落里只亮四柱才对得上用户点的东西）');
      eq(readerModel.highlightRange('一二三四五', 2, ''), { start: 2, end: 5 },
        '  └ 没有书签文字 ⇒ 亮到**块尾**（照 demo：setEnd(n, nodeValue.length)）');
      eq(readerModel.highlightRange('一二三四五', 1, '四三'), { start: 1, end: 5 },
        '⚠⚠ 书签文字与 local 处**对不上**（书重存过）⇒ 退回亮到块尾，不猜一个区间');
      eq(readerModel.highlightRange('一二三四五', 99, 'x'), null,
        '⚠⚠⚠ local 越界 ⇒ null（这一块没有可亮的东西）—— 绝不算出负数区间把 <Text> 搞崩');
      eq(readerModel.highlightRange('abc', 3, 'x'), null,
        '  └ local 正好在块尾（一个字符都不指）⇒ 同理 null');
      eq(readerModel.highlightRange('', 0, 'x'), null, '空块 ⇒ null');
      eq(readerModel.highlightRange(null, 0, 'x'), null, '没有块文本时不崩');
      eq(readerModel.highlightRange('独一块', 0, '独一块'), { start: 0, end: 3 },
        '整块就是书签内容 ⇒ 整块亮（start/end 覆盖全文）');
    }

    /* ---- ★ 头部那一行位置（照 demo 的 `${i+1}/${N} · ${charCount} 字`）---- */
    eq(readerModel.posText(2, 12, 4200), '第 3/12 章 · 4200 字', '位置行：第几章 / 共几章 · 字数');
    eq(readerModel.posText(0, 1, 0), '第 1/1 章 · 0 字', '⚠ 章序 0 是合法值（第一章）⇒ 照常显示');
    eq(readerModel.posText(null, 12, 4200), '',
      '⚠⚠⚠ 章序取不到（数据还没到）⇒ **空串**（整行不显示）—— 别显示「第 1/0 章」这种自己吓自己的东西');
    eq(readerModel.posText(5, 0, 100), '第 6/0 章 · 100 字',
      '⚠ total 缺失（目录还没回来）⇒ 章数记 0，字数照常（位置行不因此消失）');

    /* ---- ★ 列表行：一行一块（章标题**不再是插进来的行**，它本身就是块）---- */
    {
      eq(readerModel.buildRows(null), [], '没有数据时不崩');
      eq(readerModel.buildRows([]), [], '空章 ⇒ 一行都不产');
      eq(readerModel.buildRows([{ idx: 0, type: 'h1', text: '第一章 甲子' }]),
        [{ key: 'B0', kind: 'block', bi: 0, type: 'h1', text: '第一章 甲子' }],
        '⚠ 一行一块：章标题块与正文块**同一种行**（不再有 title / para 两种行）');
      eq(readerModel.buildRows([{ idx: 0, type: 'p', text: '' }]).length, 1,
        '⚠⚠ 空段（docx 里的空行）**照样成行** —— 丢掉它段间距就没了，'
        + '而且行下标与块下标会对不上（定位要多绕一层）');
      eq(readerModel.buildRows([{ idx: 7 }])[0].type, 'p', '⚠ type 缺失 ⇒ 兜底 p（不抛）');
      eq(readerModel.buildRows([{ idx: 7 }])[0].text, '', '⚠ text 缺失 ⇒ 兜底空串');
      eq(readerModel.buildRows([{ idx: 0, type: 'p', text: 'a' }, null, { idx: 2, type: 'p', text: 'b' }])
        .map((r) => r.key).join(','), 'B0,B2',
        '⚠⚠ 坏条目（null）跳过，但 key / bi 仍按**数组下标**（不是连续重编号）—— '
        + '重编号会让 bi 与 blocks 的下标脱钩，定位当场错位');
      eq(readerModel.buildRows([{ idx: 0, type: 'p', text: 'a' }, { idx: 1, type: 'source', text: '《滴天髓》' }])
        .map((r) => r.type).join(','), 'p,source',
        '出处块（source）也是行的一种，渲染层按它换小字');
    }

    /* ---- ★★★ 2026-10-16 十七改：`fromShelf` —— **来路判据** ----
       ⚠⚠ 它同时管两件事，必须是**同一句**：
         ① 恢复本地阅读位置（不是从书架来就不吃）；② 退场要不要记阅读位置。
         用户原话：「从查询页面进入到阅读页面，再退出就不要保存阅读位置了。
         只有从书籍进入阅读页面退出才保存阅读位置。」 */
    eq(readerModel.fromShelf({ book: 'abc', chapter: null, offset: null }), true,
      '从书架点封面（chapter/offset 都是 null）⇒ 这是「接着读」⇒ 恢复位置 + 退场记位置');
    eq(readerModel.fromShelf({ book: 'abc', chapter: 0, offset: null }), false,
      '⚠⚠⚠ chapter=0 是**第一章**（合法值）—— 判据写成 truthy 会把它误判成「从书架进来」，'
      + '于是去吃本地位置、跳到别的地方，而且**一处都不报错**');
    eq(readerModel.fromShelf({ book: 'abc', chapter: null, offset: 0 }), false,
      '⚠⚠⚠ offset=0 是**章首第一个字**（同样合法）—— 同上');
    eq(readerModel.fromShelf({ book: 'abc', chapter: 8, offset: 144 }), false,
      '点书签 / 从查询页那一条进来（有定位目标）⇒ **不记**阅读位置');
    eq(readerModel.fromShelf(null), false,
      '⚠ 没有 target 时**不当**「从书架来」——宁可不记，也不要把位置记到一本不相干的书上');
    eq(readerModel.fromShelf({ book: 'abc' }), true,
      '⚠ 两个字段都**不存在**（老数据）⇒ 当从书架来（宁可恢复位置，也不要直接跳章首）');

    /* ---- ★★★ 2026-10-19 `openParams`：**唯一一处**算「这一趟从哪一章、哪一块开始」----
       ⚠⚠⚠ 返回值只带 `{book, chapter, seek}`：
         · `chapter` 发给服务端（`/books/chapter?book=&chapter=`）；
         · `seek` = **不是请求参数**，是「拿到 blocks 之后要不要滚、滚到哪」
           （块下标要等这一章的 blocks 下来才算得出来，见 Reader 的 load）。
       ⚠ 判据必须是 `== null`（覆盖 null 与 undefined）：`chapter = 0` 是第一章、
         `offset = 0` 是章首第一个字，都是合法值。 */
    eq(readerModel.openParams({ book: 'abc', chapter: 3, offset: 42 }, null),
      { book: 'abc', chapter: 3, seek: { offset: 42, text: '' } },
      '⚠⚠⚠ 书签 / 查询页 ⇒ 直奔那一章那一块（chapter + offset 都按它给）');
    eq(readerModel.openParams({ book: 'abc', chapter: 0, offset: 0 }, null),
      { book: 'abc', chapter: 0, seek: { offset: 0, text: '' } },
      '⚠⚠⚠ chapter=0 / offset=0 都是**合法值**：第一章的书签、章首的书签都要如实发出去');
    eq(readerModel.openParams({ book: 'abc', chapter: null, offset: 37 }, null),
      { book: 'abc', chapter: 0, seek: { offset: 37, text: '' } },
      '⚠ 缺章（老数据）⇒ 章 0；缺偏移 ⇒ 不定位 —— 宁可回章首，也不要发一个猜出来的偏移');
    eq(readerModel.openParams({ book: 'abc', chapter: 5, offset: null, name: '丙寅，丁酉，己酉，丙寅' }, null),
      { book: 'abc', chapter: 5, seek: { offset: -1, text: '丙寅，丁酉，己酉，丙寅' } },
      '⚠⚠ 只有书签名、没有偏移 ⇒ offset 给 **-1**（= 按文字找，见 matchBlock），'
      + '文字照带（书重存过时它就是唯一的线索）');
    eq(readerModel.openParams({ book: 'abc', chapter: 5, offset: null }, null),
      { book: 'abc', chapter: 5, seek: null },
      '⚠ 章有、偏移没有、文字也没有 ⇒ 不定位（滚到章首给人看见全章）');
    eq(readerModel.openParams({ book: 'abc', chapter: null, offset: null }, null),
      { book: 'abc', chapter: 0, seek: null },
      '从书架点封面、没记过 ⇒ 从头读（章 0、不定位）');
    eq(readerModel.openParams({ book: 'abc', chapter: null, offset: null }, { chapter: 0, offset: 0 }),
      { book: 'abc', chapter: 0, seek: { offset: 0, text: '' } },
      '⚠⚠⚠ 本地位置 chapter=0 / offset=0（读到第一章第一个字）是**合法位置**：'
      + '写成 `pos && pos.chapter` 就退化成从头读，且不报错');
    eq(readerModel.openParams({ book: 'abc', chapter: null, offset: null }, { chapter: 7, offset: 512 }),
      { book: 'abc', chapter: 7, seek: { offset: 512, text: '' } },
      '从书架点封面 ⇒ 回到本地记的那一章那一个字');
    eq(readerModel.openParams({ book: 'abc', chapter: null, offset: null }, { chapter: 3 }),
      { book: 'abc', chapter: 3, seek: null },
      '⚠ 只记了章、没记偏移（半截数据）⇒ 回到那一章开头，**不猜一个偏移**');
    eq(readerModel.openParams({ book: '', chapter: 3, offset: 4 }, null), null,
      '⚠ target 里没有书名（book_key）⇒ 返回 null（调用方据此**不加载**，别发一个空 book 的请求）');
    eq(readerModel.openParams(null, null), null, '没有 target 时不崩');

    /* ---- ★ 「跳到第 N 章开头」的请求参数（工具栏 / 目录共用这一条）---- */
    eq(readerModel.chapterParams('abc', 3), { book: 'abc', chapter: 3 }, '跳章：带 book_key + 章序');
    eq(readerModel.chapterParams('abc', 0), { book: 'abc', chapter: 0 },
      '⚠⚠ chapter = 0 是第一章（合法值）—— 写成 `chapter || 0` 今天结果一样，'
      + '但一旦默认值不是 0 就会静默错');
    eq(readerModel.chapterParams('abc', null), { book: 'abc', chapter: 0 },
      '⚠ 章序算不出来（首章 / 末章）⇒ 兜 0（调用方那侧已经置灰，这里是最后一道）');

    /* ---- ★ 当前章 / 上一章 / 下一章：一律来自服务端，不自己 idx ± 1 ---- */
    eq(readerModel.curChapter({ chapter: { idx: 5, title: '卷五', level: 1, charCount: 3000 } }), 5,
      '当前章 = 这一次加载的 chapter.idx（一次只加载一章，它就是唯一答案）');
    eq(readerModel.curChapter({ chapter: { idx: 0, title: '卷一' } }), 0,
      '⚠⚠⚠ 章序 0 是合法值 —— 判据用 typeof，写成 `if (c.idx)` 会让第一章永远算不出当前章');
    eq(readerModel.curChapter(null), null, '数据还没到 ⇒ null（调用方把两个按钮置灰）');
    eq(readerModel.curChapter({}), null, '  └ 没有 chapter 字段同理');
    eq(readerModel.curChapter({ chapter: { title: '没有 idx' } }), null, '⚠ chapter 里没有 idx（脏数据）⇒ null');
    eq(readerModel.curChapter({ chapter: null }), null, '  └ chapter 是 null 同理');
    eq(readerModel.prevChapter({ prev: 0 }), 0, '⚠⚠⚠ 上一章可以是第 0 章 —— 判据必须是 typeof number');
    eq(readerModel.prevChapter({ prev: 4 }), 4, '  └ 正常情况');
    eq(readerModel.prevChapter({ prev: null }), null, '⚠ 服务端说没有（已经是第一章）⇒ null ⇒ 按钮置灰');
    eq(readerModel.prevChapter({}), null, '⚠ 老服务端没给 prev ⇒ 当没有（宁可点不动，也不要跳到一个 404 的章序）');
    eq(readerModel.prevChapter(null), null, '没有响应时不崩');
    eq(readerModel.nextChapter({ next: 328 }), 328, '下一章 = 响应里的 next');
    eq(readerModel.nextChapter({ next: null }), null, '⚠ 末章 ⇒ null ⇒ 置灰');
    eq(readerModel.nextChapter({}), null, '⚠ 没有 next 字段 ⇒ 当没有');
    eq(readerModel.nextChapter(null), null, '没有响应时不崩');
    /* ⚠⚠⚠ model 层**一行 `idx ± 1` 都不许有** —— 边界由服务端按 total 判过，
       自己再算一遍就是第二份判据（口径一有分歧，两边就会不一致）。
       ⚠ 查的是**剥过注释**的源码：注释里解释「删掉了什么」会带上旧写法。 */
    ok(readerModelSrc.indexOf('idx - 1') < 0 && readerModelSrc.indexOf('idx + 1') < 0
      && readerModelSrc.indexOf('tocList, curSec') < 0,
      '⚠⚠⚠ 不许自己拿 idx ± 1 算上一章 / 下一章，也不许留老那套「按目录反查章」的实现');

    ok(readerModelSrc.indexOf('idx - 1') < 0 && readerModelSrc.indexOf('idx + 1') < 0,
      '⚠⚠⚠ 不许自己拿 idx ± 1 算上一章 / 下一章 —— 边界（idx > 0 / idx+1 < total）'
      + '由服务端按 total 判过，自己再算一遍就是第二份判据');

    /* ---- ★★★ 2026-10-17 定位**重做**：`rowLayoutH` / `seekStep` / `hasRowH` ----
       ⚠⚠ 这三个纯函数是「**量**而不是**估**」的全部 —— 视图只负责把 `onLayout` 的量出来喂进来。
         老那版（`initialScrollIndex` / `scrollToIndex`）对没量过的行只能按**平均行高估**，
         而这套的字面判据就是「**没量到的行，一个像素都不许算进去**」。
       ⚠ 换协议**没有**动它们：那是渲染层的问题，与取数协议无关。 */
    {
      const rowsL = [
        { key: 'B0', kind: 'block', type: 'h1', text: '第一章' },
        { key: 'B1', kind: 'block', type: 'p', text: 'a' },
        { key: 'B2', kind: 'block', type: 'p', text: 'b' },
        { key: 'B3', kind: 'block', type: 'p', text: 'c' }
      ];
      /* ① 全量齐了：y = 前面所有行高度之和（**精确值**，不是估算） */
      const full = { B0: 40, B1: 30, B2: 50, B3: 20 };
      eq(readerModel.rowLayoutH(rowsL, full, 3), { y: 120, gaps: [] },
        '⚠⚠ 量齐时 y 必须是**精确累加**（40+30+50=120），gaps 为空 ⇒ 调用方可以直接滚过去收摊');
      eq(readerModel.rowLayoutH(rowsL, full, 0), { y: 0, gaps: [] },
        '⚠ 第 0 行前面没东西 ⇒ y=0 且没有缺口（**不许**报缺口，否则永远收不了摊）');
      eq(readerModel.rowLayoutH(rowsL, {}, 2), { y: 0, gaps: ['B0', 'B1'] },
        '⚠⚠⚠ **没量到的行不许算进去**（也不许按平均行高补一个数）：'
        + 'y 只累加量到的、缺的进 gaps —— 这就是「估」与「量」的分界');
      eq(readerModel.rowLayoutH(rowsL, { B0: 40, B1: 30 }, 2), { y: 70, gaps: [] },
        '  └ 只量到前两行、目标是第 2 行 ⇒ 已经够算精确 y（70）');
      eq(readerModel.rowLayoutH(rowsL, { B0: 40, B2: 50 }, 3), { y: 90, gaps: ['B1'] },
        '⚠⚠ 中间缺一行时：`y` 是**已知行的和**（40+50=90，是个**下界**，不是位置），'
        + '且 `gaps` 非空 ⇒ 调用方**绝不许**拿这个 y 去冲（只许滚到第一个缺口 B1）。'
        + '「下界 != 位置」这一条正是老版估算滚过头的根');
      eq(readerModel.rowLayoutH(rowsL, { B0: 0 }, 1).gaps, ['B0'],
        '⚠ 高度 0 等于「没量到」（onLayout 没报 / 报了 0）—— 不许当成「这行没高度」');
      eq(readerModel.rowLayoutH(rowsL, full, 99).gaps, [],
        '⚠ 目标越界 ⇒ 当最后一行的位置算（不许抛，也不许返回负 y）');
      eq(readerModel.rowLayoutH(null, full, 2), { y: 0, gaps: [] }, '没有行数组时不崩');
      eq(readerModel.rowLayoutH(rowsL, null, 2), { y: 0, gaps: ['B0', 'B1'] },
        '高度表还没来（首帧）⇒ 全算缺口、y=0');

      /* ② 居中（照 docx-viewer 的 `scrollIntoView({block:'center'})`）：目标行中心落在视口中心。
         ⚠⚠ 判「到位」与「算真值」必须用**同一个** vh —— 只带一处 = 永远判不到位。 */
      eq(readerModel.rowLayoutH(rowsL, full, 3, 200), { y: 30, gaps: [] },
        '⚠ 居中：y = 120 + 目标行半高(10) − 视口半高(100) = 30');
      eq(readerModel.rowLayoutH(rowsL, full, 0, 200), { y: 0, gaps: [] },
        '⚠⚠ 靠近章头时夹到 0（c = 0 + 20 − 100 = −80 ⇒ 不许给负 offset）');
      eq(readerModel.rowLayoutH(rowsL, full, 3, 100), { y: 80, gaps: [] },
        '  └ 视口矮一半 ⇒ y 也差一半（120 + 10 − 50 = 80）：居中是**按视口算**的，不是写死的偏移');
      eq(readerModel.rowLayoutH(rowsL, { B0: 40, B1: 30 }, 2, 100), { y: 20, gaps: [] },
        '⚠⚠ 目标行自己还没量到 ⇒ 它的高按 **0** 算（只把它抬到「视口正中」附近）；'
        + '偏一点无所谓 —— 它一进视口就会报高度，下一发用真值重算');
      eq(readerModel.rowLayoutH(rowsL, full, 3, 0), { y: 120, gaps: [] },
        '⚠ vh 传 0 / 不传 ⇒ 退回顶边对齐（老口径，别把两种口径混在一起）');

      /* ③ 推进一发：有缺口 → 滚到**第一个缺口**；没缺口 → 滚到真值 */
      eq(readerModel.seekStep({ y: 120, gaps: [] }, rowsL, full), 120,
        '⚠ 量齐 ⇒ 直接给真值（滚过去就收摊）');
      eq(readerModel.seekStep({ y: 0, gaps: ['B1', 'B2'] }, rowsL, { B0: 40 }), 40,
        '⚠⚠ 有缺口 ⇒ 只滚到**第一个缺口**那一行（= 它的精确 y，40）——'
        + '要让它进视口被渲染、被量；⚠⚠ **绝不许**直接冲目标 y：'
        + '那样会用一个「下界」当真实位置，冲过头、量到的行反而更少');
      eq(readerModel.seekStep({ y: 0, gaps: [] }, rowsL, {}), 0,
        '  └ 什么都没有 ⇒ 0（停在章首，别给负 offset）');
      eq(readerModel.seekStep(null, rowsL, full), 0, 'plan 缺失时不崩');
      eq(readerModel.seekStep({ y: 120, gaps: ['NOPE'] }, rowsL, full), 120,
        '⚠ 缺口 key 在行数组里找不到（数据刚换）⇒ 退回滚 y（不许抛）');

      /* ④ hasRowH：算 y 与「决定停不停」共用这一句 */
      eq(readerModel.hasRowH({ B1: 30 }, 'B1'), true, '量到了');
      eq(readerModel.hasRowH({ B1: 0 }, 'B1'), false, '⚠ 0 不算量到（onLayout 报 0 那种）');
      eq(readerModel.hasRowH({}, 'B1'), false, '没有');
      eq(readerModel.hasRowH(null, 'B1'), false, '高度表还没来时不崩');
    }

    /* ---- Reader.tsx 源码契约 ---- */
    ok(readerSrc.indexOf('<FlatList') >= 0, '阅读页段落列表用 FlatList（一章可上百块，必须虚拟化 —— 学堂页同一个坑）');
    ok(readerSrc.indexOf('items.map(') < 0, '⚠ 不许 items.map 渲染段落');
    ok(/keyExtractor=\{\(item: any\) => item\.key\}/.test(readerSrc),
      '⚠ key 走**行**自己的 key（`B` + 块下标，见 model.buildRows）');
    ok(/keyExtractor=\{\(it: any\) => 'S' \+ it\.idx\}/.test(readerSrc),
      '  └ 目录行的 key 前缀是 `S`（与正文的 `B` 分开，同一个 FlatList 家族里撞 key 是 RN 的老坑）');

    /* ---- ★★★ 取数：一章一个请求给全（2026-10-19 换代）---- */
    ok(/books\.chapter\(params\)/.test(readerSrc),
      '⚠⚠⚠ 正文唯一的取数入口是 `books.chapter(params)`（`GET /books/chapter?book=&chapter=`）');
    ok(/const params = model\.openParams\(target, readPos\.get\(book\)\)/.test(readerSrc),
      '⚠⚠⚠ 入口的请求参数**只能**由 `model.openParams` 算（唯一一处「这一趟从哪一章开始」）');
    ok(/if \(params\) load\(params, true, !model\.fromShelf\(target\)\)/.test(readerSrc),
      '⚠⚠⚠ 「定位」与「高亮」是**两个**参数：定位恒 true，高亮 = 「不是从书架点封面」'
      + '（书签 / 查询页那一条才亮；恢复阅读位置 / 翻章不亮）');
    ok(readerSrc.indexOf('readPos.get(book)') >= 0,
      '⚠⚠ 入口必须把本地阅读位置一起交给 `openParams`（点封面进书要恢复它）');
    ok(/if \(model\.fromShelf\(target\) && readPosRef\.current\)/.test(readerSrc),
      '⚠⚠⚠ 退场**只有从书架进来才**记阅读位置（用户 2026-10-16 原话）—— '
      + '他这一趟如果是冲着某一段来的（书签 / 查询结果），记下去下次点封面会跳到一个他根本没读过的位置');
    ok(/readPos\.set\(book, readPosRef\.current\.chapter, readPosRef\.current\.offset\)/.test(readerSrc),
      '⚠⚠ 存的位置是 `{chapter, offset}`（章序 + 章内字符偏移）—— '
      + '⚠⚠⚠ 必须是**三参**的 set：老那版两参 `(file, seq)` 会把 offset 塞进 chapter 位，'
      + '下次打开跳到一章不存在的章序，而且一处都不报错');
    ok((readerSrc.match(/model\.fromShelf\(/g) || []).length === 2,
      '⚠⚠⚠ `model.fromShelf` **只许两处**（入口分流 / 退场存位置）—— 两处判据必须是**同一句**，'
      + '各写一份就是「进来时不恢复、退出去却写」这种一半对一半错');
    ok(!/if \(!model\.fromShelf/.test(readerSrc) && !/if \(model\.fromShelf\(target\)\) readPos/.test(readerSrc),
      '⚠⚠ 「点书签不吃本地位置」只住在 `model.openParams` 的 `fromShelf` 分支里 —— '
      + '视图里不许再自己判一遍（同一判据散两处迟早有一处忘了改）');
    ok((readerSrc.match(/readPos\.get\(/g) || []).length === 1,
      '⚠ 取位置也只有一处（入口那一次）—— 别在滚动 / 翻章里反复读');
    ok(/const want = jump && params && params\.seek \? params\.seek : null;/.test(readerSrc),
      '⚠⚠ 「要不要定位」看 `params.seek`（openParams 给的，**不是请求参数**）');
    ok(/const bi = want \? model\.bookmarkBlock\(res\.blocks, want\.offset, want\.text\) : -1;/.test(readerSrc),
      '⚠⚠⚠ 定位换算只此一处：`model.bookmarkBlock`（先 offset、后文字，纯函数可断言）—— '
      + '别在视图里再写一遍「先找块、再在块内找字符」');
    ok(readerSrc.indexOf('hopSec') < 0 && readerSrc.indexOf('hopRef') < 0,
      '⚠⚠⚠ 「本章没有那一段 ⇒ 换章重取」整条删除（老那套 hopRef/hopSec）—— '
      + '章序是请求时**明确指定的**，这一章里没有就是没有；再猜一章只会跳错地方，而且不报错');

    /* ---- ★★★ 目录：回来了，但形态是「点屏幕呼出的工具栏 + 全屏面板」---- */
    ok(readerSrc.indexOf('loadToc') >= 0 && readerSrc.indexOf('tocList') >= 0 &&
       readerSrc.indexOf('renderTocItem') >= 0 && readerSrc.indexOf('jumpTo') >= 0,
      '⚠⚠ 阅读页：目录的取数 / 行渲染 / 按章跳 三样都要在');
    ok(/setTocList\(res\.chapters\)/.test(readerSrc),
      '⚠⚠⚠ 目录认的字段是 **chapters**（老口径叫 sections）—— 写成 sections 会**静默**'
      + '拿到 undefined ⇒ 目录一片空白、一处不报错');
    /* ⚠⚠ 2026-10-19：喂列表的是**筛过的** `tocArr`（搜索在这里做，照 demo 的 renderList）——
       直接喂 tocList 的话搜索框只是个摆设（demo 也是先 filter 再 render）。 */
    ok(/data=\{tocArr\}/.test(readerSrc), '  └ 而且真的喂给了 FlatList（搜索筛过的 tocArr）');
    ok(/data=\{bmArr\}/.test(readerSrc), '  └ 书签那一栏同理（bmArr）');
    ok(readerSrc.indexOf('setView') < 0 && readerSrc.indexOf('openSection') < 0,
      '⚠⚠⚠ 但**形态切换**那一套（setView / openSection）依然不许回来 —— 目录是浮层，不是页面形态');
    ok(readerSrc.indexOf('crumbs') < 0 && readerSrc.indexOf('headRow') < 0 &&
       readerSrc.indexOf('tocBtn') < 0 && readerSrc.indexOf('tocText') < 0,
      '⚠⚠⚠ 当年那套**常驻形态**（面包屑 crumbs / headRow / 顶部 tocBtn / tocText）依然不许回流');
    ok(readerSrc.indexOf('crumbText') < 0, '⚠⚠⚠ crumbText（面包屑纯函数）依然不许回流');
    ok(/s\.head/.test(readerSrc) && /s\.navBtn/.test(readerSrc) &&
       /s\.sideBtn/.test(readerSrc) && /s\.sideHost/.test(readerSrc) && /s\.drawer/.test(readerSrc),
      '⚠⚠ 常驻头部与侧栏抽屉的样式要在（head / navBtn / sideBtn / sideHost / drawer）');
    /* ⚠⚠⚠ 顶栏**不许**再放一个「返回」：App 的 NavBar（返回 + 书名）一直显示在阅读页外面，
       用户 2026-10-14 明确选了「保留它，顶栏只放章名」—— 顶上两个返回，点错一次就退出去。
       ⚠ 判据用**文案**而不是 `onBack`：`onBack` 另有用途（失败态那个「点这里重试」在用）。 */
    ok(readerSrc.indexOf('返回') < 0,
      '⚠⚠⚠ 阅读页里**不许**出现「返回」这两个字（顶栏只有章名；返回由外面那条 NavBar 负责）');
    /* ⚠⚠ 「夜间」本轮**不做**（用户选「以后单独做」）⇒ 工具栏上**不许**先摆一个夜间按钮：
       点了没反应的假按钮比没有更糟。 */
    ok(readerSrc.indexOf('夜间') < 0,
      '⚠⚠ 工具栏里不许出现「夜间」（本轮不做，别放假按钮）');
    /* ⚠ 目录行下标 = 章序（`idx` 0 起连续）⇒ 不再需要 chapterIndex 那一层换算 */
    ok(readerSrc.indexOf('chapterIndex') < 0 && readerSrc.indexOf('chapterAt') < 0,
      '⚠⚠⚠ 不许再按 seq 反查章（chapterIndex / chapterAt 已删）—— 一次只加载一章，'
      + '`data.chapter.idx` 就是唯一答案；目录行的 `idx` 也直接就是章序');
    ok(/const tocCurIdx = curCh && typeof curCh\.idx === 'number' \? curCh\.idx : -1;/.test(readerSrc),
      '⚠⚠ 目录高亮 / 定位目标 = `curCh.idx`（当前加载的这一章）；取不到（还没加载完）⇒ -1（不滚、从头列）');
    ok(/jumpTo\(item \? item\.idx : null\)/.test(readerSrc),
      '⚠⚠ 目录点一行 ⇒ 传**章序数字**（item.idx），不是老那个条目对象（拿它的 seq）');
    ok(/const on = curCh != null && typeof curCh\.idx === 'number' && item && item\.idx === curCh\.idx;/
      .test(readerSrc),
      '⚠⚠ 目录高亮判据：两侧都是数字，且 `curCh.idx` 可能是 null（章还没加载完）—— '
      + '写成 `item.idx === curCh.idx` 时 null 会把**第 0 章**也一起点亮');
    ok(readerSrc.indexOf('model.jumpable') < 0,
      '⚠⚠⚠ 老那套「空章不可点」（model.jumpable）整条删除 —— 新协议下一章一次给全，'
      + '空章照样点得进去（章序是明确指定的，不存在「服务端换算不出起点」）');
    ok(/<Text style=\{s\.sideEmpty\}>\{model\.TOC_EMPTY_TEXT\}<\/Text>/.test(readerSrc),
      '⚠ 空目录只说一句事实（这本书没有章节）—— 不教用户怎么办');
    ok(/model\.TOC_CLOSE_TEXT/.test(readerSrc),
      '⚠ 全屏目录面板必须有一个明确的关闭出口（不能只靠系统返回键）');

    /* ---- ★★★ 翻章 / 上一章下一章：目标一律来自服务端 ---- */
    ok(/load\(model\.chapterParams\(book, chapter\), true, false\)/.test(readerSrc),
      '⚠⚠⚠ 跳章 = `load(model.chapterParams(...))` —— 「换掉整章 + 定位到那一章开头」，用户拍板的就是这个语义');
    ok(/const prevSec = model\.prevChapter\(data\);/.test(readerSrc) &&
       /const nextSec = model\.nextChapter\(data\);/.test(readerSrc),
      '⚠⚠ 「上一章 / 下一章」的目标走 `data.prev` / `data.next`（服务端按 total 判过边界）—— '
      + '自己拿 idx ± 1 算是第二份判据');
    ok(/disabled=\{!prevSec\}/.test(readerSrc) && /disabled=\{!nextSec\}/.test(readerSrc),
      '⚠ 首章 / 末章（目标算出来是 null）⇒ 按钮 disabled（不是「灰按钮」，是真的不可点）');
    ok(readerSrc.indexOf('goSection') < 0 && readerSrc.indexOf('goPage') < 0,
      '⚠ 翻章 / 翻页那两个旧动作必须清干净');
    ok(readerSrc.indexOf('PREV_SEC_TEXT') < 0 && readerSrc.indexOf('NEXT_SEC_TEXT') < 0 &&
       readerSrc.indexOf('PREV_PAGE_TEXT') < 0 && readerSrc.indexOf('NEXT_PAGE_TEXT') < 0,
      '⚠ 「上一章/下一章/上一页/下一页」四个**旧**文案一个都不许留'
      + '（工具栏现在用的是 PREV_CH_TEXT / NEXT_CH_TEXT，上面正向断言守着）');
    ok(readerSrc.indexOf('PREV_CHAPTER_TEXT') < 0,
      '⚠⚠⚠ **「上一章」那颗旧按钮的文案必须删干净**（按钮形态早换了）—— '
      + '留着它 = 视图里还剩一处按「按钮」形态写的文案');

    /* ---- ★★★ 工具栏交互（2026-10-19 重做：头部**常驻**，没有"呼出"这回事了）----
       ⚠⚠ 改向记录：10-14 用户要「像小说软件一样点屏幕呼出工具栏」（onTapStart / onTapEnd /
          TAP_SLOP_RPX / barOnRef）；10-19 用户要「参照 demo 方式做」—— demo 的头部是**常驻**的
          ⇒ 那一族整块删除，换成下面这组（常驻头部 + 侧栏抽屉）。
       ⚠ 别把 onTapStart / onTapEnd / TAP_SLOP_RPX 加回来：没有要呼出的东西了
         （tests 里有反向断言守着这几个名字）。 */
    ok(/style=\{s\.head\}/.test(readerSrc),
      '⚠⚠ 头部是**常驻**的（`s.head`，照 demo 的 header：目录 / 章名+位置 / 上一章 / 下一章）');
    ok(/disabled=\{!prevSec\}/.test(readerSrc) && /disabled=\{!nextSec\}/.test(readerSrc),
      '⚠⚠ 上一章 / 下一章**真的 disabled**（首章 / 末章时点不动，不是"灰按钮"）');
    ok(/const prevSec = model\.prevChapter\(data\);/.test(readerSrc) &&
       /const nextSec = model\.nextChapter\(data\);/.test(readerSrc),
      '⚠⚠ 翻章目标走服务端的 prev / next（不自己 idx ± 1）');
    ok(/onPress=\{onOpenSide\}/.test(readerSrc),
      '⚠⚠ 头部那枚「目录」开的是**侧栏抽屉**（`onOpenSide`）—— 不是全屏面板、也不是底部按钮');
    ok(/style=\{s\.sideHost\}/.test(readerSrc) && /style=\{s\.drawer\}/.test(readerSrc) &&
       /style=\{s\.scrim\}/.test(readerSrc),
      '⚠⚠ 抽屉三件套要在：浮层宿主（sideHost）+ 抽屉本体（drawer）+ 背面遮罩（scrim）');
    ok(/style=\{s\.scrim\} onPress=\{\(\) => setSideOn\(false\)\}/.test(readerSrc),
      '⚠⚠ 背面遮罩**点一下即关**（抽屉的标准出口，与抽屉里那枚「关闭」并列）—— '
      + '⚠⚠ 必须连着 `style={s.scrim}` 一起查：只查 onPress 的话，把遮罩换成不能点的 View，'
      + '抽屉里那枚「关闭」照样能让这条断言通过（假绿）');
    ok(/setSideOn\(false\);/.test(readerSrc) && /const jumpTo = useCallback/.test(readerSrc),
      '⚠⚠ 换内容**之前**先把抽屉收掉（`jumpTo` 里那句）—— 换章后视口要跳，浮层留着会跟着晃');
    ok(/from '\.\.\/\.\.\/components\/PullRefresh'/.test(readerSrc) === false,
      '⚠⚠⚠ 阅读页**不许**再引 `components/PullRefresh`（顶端那个「下拉加载更多」的手势已整块删除）——'
      + ' 引回来 = 顶端又有一个手势，与「一次一章」重复且互相干扰');
    ok(/if \(k === 'bm' && bmPhase === 'idle'\) loadBookmarks\(\);/.test(readerSrc),
      '⚠⚠⚠ 侧栏「书签」页签是**懒加载**的（切过去、且没取过才 `loadBookmarks`）—— '
      + '只读书不翻书签的人不该为那一栏白发一个请求；'
      + '⚠⚠ 必须查这一整行：只查 `onSideTab` / `loadBookmarks` 两个名字存在的话，'
      + '把触发条件删掉（改成启动就取 / 永不取）断言照样绿');
    ok(/model\.openParams\(\s*\{ book: book, chapter: bm\.chapter, offset: bm\.offset, text: bm\.text, name: bm\.name \},/.test(readerSrc),
      '⚠⚠⚠ 侧栏点书签也走 `model.openParams`（与入口分流**同一个函数**），且必须把 `bm.text`'
      + '（Word 书签圈住的原文字）一起带上 —— 2026-10-20 踩过：只带 name（带全角逗号）时'
      + '高亮 `indexOf` 对不上，退到「亮到块尾」把整句都亮了；'
      + '「这一趟从哪一章哪一块开始」全库只有一处算法');
    ok(/SEARCH_PLACEHOLDER/.test(readerSrc),
      '⚠⚠ 侧栏搜索框（照 demo 的 `placeholder="搜索标题 / 书签"`，一字不改）');
    ok(/const BM_PAGE = 1000;/.test(readerSrc),
      '⚠⚠⚠ 侧栏书签一次拿全（BM_PAGE = 1000；真实数据单本最多 736 条）—— '
      + '改成一个页码（50）的话，搜索只在**已加载的那一页**里筛，漏掉的书签永远搜不到');

    /* ---- ★★★ 加载框：翻章 / 定位期间盖住（用户：「加载框状态禁止用户操作」）---- */
    ok(/const loadingBox = phase === 'loading' \|\| !settled;/.test(readerSrc),
      '⚠⚠⚠ 加载框判据 `loadingBox` 必须是「正文在飞（`phase === \'loading\'`）**或** 定位还没落位（`!settled`）」'
      + '—— ⚠⚠ 少了 `!settled` 那一半：「重做后的定位」要**好几轮**才落定（量一段、逼近一段），'
      + '这几轮里屏幕上会先画在 offset 0、再一段段跳 —— 不盖框就是用户当年报的'
      + '「定位的位置是错的」那样「眼看着它跳」');
    ok(/model\.LOADING_TEXT/.test(readerSrc),
      '  └ 框里那句文案走 `model.LOADING_TEXT`（与其它加载框同一个字，不另写）');
    ok(/scrollEnabled=\{!loadingBox\}/.test(readerSrc),
      '⚠⚠ 框开着 ⇒ 列表一个像素都不许动（用户当年那条「加载框状态禁止用户操作」原样适用；'
      + '安卓上只有这一条能真挡住惯性滚动）');
    ok(readerSrc.indexOf('ActivityIndicator') < 0,
      '⚠⚠ 加载框只许是**静态**一块 + 一句话（与其他加载框同款、无动效）——'
      + '不许退回 `ActivityIndicator`（原生转圈；用户两次否掉自动消失类动效）');
    ok(readerSrc.indexOf('prevPhase') < 0,
      '⚠⚠ 「到顶加载」那个模态框（`prevPhase`）必须删干净 —— 那条路没有触发点了');
    ok(/phase !== 'fail' \?/.test(readerSrc),
      '⚠⚠⚠ 列表必须**一直挂着**（只有失败态不挂）—— 条件渲染会让「一屏空白」变成「空白 + 列表重建」'
      + '（内容回来时位置丢）');

    /* ---- ★★★ 定位 = 实测行高累加（2026-10-17 重做，换协议后照旧）---- */
    ok(readerSrc.indexOf('scrollToIndex') < 0 && readerSrc.indexOf('RETRY_MS') < 0
      && readerSrc.indexOf('retryCountRef') < 0,
      '⚠⚠⚠ 正文**一次都不许调 `scrollToIndex`**（连同它的 `RETRY_MS` 重试计数）—— '
      + '没有 `getItemLayout` 时它只能估算位置；重试只是把「估错」再发生几次'
      + '（2026-10-14 用户报的「滚动条反复跳、页面一闪一闪」就是它）');
    ok(readerSrc.indexOf('scrollToOffset') >= 0,
      '  └ 定位走 `scrollToOffset`：offset 由**实测行高**累加得出（`model.rowLayoutH`）');
    ok(readerSrc.indexOf('initialScrollIndex') < 0 && readerSrc.indexOf('onScrollToIndexFailed') < 0,
      '⚠⚠⚠ `initialScrollIndex` 与那个失败兜底都不许回来 —— 它们只能给「估算位置」');
    ok(typeof readerModel.rowLayoutH === 'function' && typeof readerModel.seekStep === 'function'
      && typeof readerModel.hasRowH === 'function',
      '⚠⚠⚠ `model.rowLayoutH` / `seekStep` / `hasRowH` 三个纯函数必须导出 —— '
      + '视图里手写累加 = 越界 / 没量到 / 标题块三件事各错一次，而且都不报错');
    /* ---- +++ 2026-10-19 实测 bug：`onLayout` 只报自己的 border-box，**不含自己的 margin**，
           而 VirtualizedList 的 cell 是一层裸 View，子节点的 margin **算进 cell 占位**
           => 「量的」比「占的」每行少一个 marginBottom，误差随行数线性涨：
           实测第 582 块的书签早滚 7.85 屏（用户报「点击书签没滚到相应位置」）。
       纪律：**被测的那一层，自身 margin 必须为 0；段距用该层的 padding**。 ---- */
    ok(/<View\s+style=\{item && item\.type === 'source' \? s\.srcRow : s\.paraRow\}\s+onLayout=\{onRowLayout\}\s*>/.test(readerSrc),
      '!!! 正文行必须是「**外壳 View 量高度**」这一形态（paraRow / srcRow）—— '
      + 'onLayout 挪回内层 <Text> 就是这个 bug 的复活形态');
    ok(/paraRow: \{ paddingBottom: rpx\(18\) \}/.test(readerSrc) &&
       /srcRow: \{ paddingBottom: rpx\(18\) \}/.test(readerSrc),
      '!!! 段距是外壳的 **paddingBottom**（在盒子里 => onLayout 一定报它）');
    {
      const paraStyle = /para: \{([^}]*)\}/.exec(readerSrc);
      const srcStyle = /srcPara: \{([^}]*)\}/.exec(readerSrc);
      ok(paraStyle && !/margin/.test(paraStyle[1]) && srcStyle && !/margin/.test(srcStyle[1]),
        '!!! `para` / `srcPara` 自己**不许有 margin**（有就是「量到的不等于占到的」）',
        paraStyle ? 'para = {' + paraStyle[1].trim() + '}' : '解析不到 para 样式');
    }
    ok(readerSrc.indexOf('removeClippedSubviews') < 0,
      '!!! 正文列表不许开 removeClippedSubviews：它卸掉视口外的 cell，而定位的'
      + '「滚到缺处 → 让它被量」正依赖那些 cell 一进视口就报 onLayout');
    ok(/rowHRef\.current\[item\.key\] = h;/.test(readerSrc),
      '⚠⚠⚠ 行高只认真话：`renderItem` 里 `onLayout` 报上来的高度要写进 `rowHRef`（用 ref 不用 state —— '
      + '一秒几十次，进 state 就是整页重渲染）');
    ok((readerSrc.match(/onLayout=\{onRowLayout\}/g) || []).length >= 2,
      '⚠⚠⚠ 章标题块与正文块**两种行都要挂 `onLayout`** —— 少挂一种，它前面那几行就永远量不到 '
      + '⇒ 定位永远停在「推进一格」的半路上');
    ok(/const SEEK_ROUNDS_MAX = \d+;/.test(readerSrc),
      '⚠⚠⚠ 有限轮推进**必须有上限**（`SEEK_ROUNDS_MAX`）—— 每量到一批就再推一格，'
      + '碰到量不出来的行就是无限循环（滚动条一直在自己动）');
    ok(/const SEEK_MAX_MS = \d+;/.test(readerSrc),
      '⚠⚠⚠ 定位还要有**时间上限**（`SEEK_MAX_MS`）—— 轮次用满也可能差一点，'
      + '到点必须无条件放加载框（框禁操作，不能永远盖着）');
    ok(/plan\.gaps\.length === 0/.test(readerSrc) && /SEEK_MAX_MS/.test(readerSrc),
      '⚠⚠⚠ 收摊判据两件套：① 目标行之前**全部量齐**（`gaps.length === 0`）⇒ 滚到真值收摊；'
      + '② 时间到（`SEEK_MAX_MS`）⇒ 无条件放加载框');
    ok(/if \(!measured && !outOfRounds\) return;\s*\r?\n\s*if \(outOfRounds\) \{ setSettledNow\(true\); return; \}/
      .test(readerSrc),
      '⚠⚠⚠ **量齐 ≠ 到位**：`pushSeek` 里量齐之后不许直接 `setSettledNow(true)` —— '
      + '上一发只把缺处推进视口（常只露在屏幕底边），当场收摊 = 目标段贴在底边 = 用户说的「定位不对」');
    ok(/Math\.abs\(off - plan\.y\) <= 2/.test(readerSrc),
      '  └ 量齐之后要按「当前 offset 与 y 的差」收手（≤ 2px 才算到位），否则再来一发把它顶上去');
    ok((readerSrc.match(/rowLayoutH\([^)]*vhRef\.current\)/g) || []).length >= 2,
      '⚠⚠ 「算真值」与「判到位」两处必须用**同一个** vh（都居中，照 docx-viewer 的 block:center）—— '
      + '只带一处 = 永远判不到位，每一次定位都要熬到 SEEK_MAX_MS 才揭框');
    ok(/if \(!renderedRef\.current\) \{[\s\S]*?hasRowH[\s\S]*?if \(!ok\) return;/.test(readerSrc),
      '⚠⚠⚠ 渲染完成之前**不许定位**：`pushSeek` 第一关必须是「首批行都量到高度了吗」，'
      + '没量到就 `return`（不滚、不放框）—— 没渲染就去滚，滚的是「缺行当 0 高」的下界');
    ok(/renderedRef\.current = false;[\s\S]{0,40}setRendered\(false\);/.test(readerSrc)
      && /armRenderRef\.current\(\)/.test(readerSrc),
      '⚠ 换内容时必须**重新锁上**渲染门（`armRender`），否则上一章量过的行会成为本章的「已渲染」');
    ok(/initialNumToRender=\{layout\.rows\.length \|\| RENDER_FIRST\}/.test(readerSrc)
      && !/windowSize=/.test(readerSrc) && !/maxToRenderPerBatch=/.test(readerSrc),
      '⚠⚠⚠ 正文列表必须**整章全量挂载**（`initialNumToRender={layout.rows.length || RENDER_FIRST}`，'
      + '且不许有 windowSize / maxToRenderPerBatch）—— 虚拟化挂载下目标行没被挂，行高报不上来，'
      + '「滚到缺处→量到→再滚」循环走不完就熬到 SEEK_MAX_MS ⇒ 页面停在章首，看起来是「点了书签没跳」'
      + '（2026-10-20 用户实测报的就是这个）。demo 百分百准就是因为整章全在 DOM 里。');
    ok(!/v\.item\.seq === want/.test(readerSrc) && !/seekSeqRef\.current\)\) setSettledNow/.test(readerSrc),
      '⚠⚠⚠ 不许再有「目标行**可见**就揭框」的旁路（`onViewRef` 里那条已删）——'
      + '被「滚到缺处」那一发带进视口时它就可见了，此时揭框 = 目标段还贴在屏幕底下；'
      + '**落位判据只许一处**：`pushSeek` 里 offset 与 y 的差');
    {
      /* 硬判据：`onViewRef` 那个回调体里**一次 `setSettledNow` 都不许有** */
      const i = readerSrc.indexOf('const onViewRef = useRef(');
      const j = readerSrc.indexOf('\n  });', i);
      ok(i > 0 && j > i && readerSrc.slice(i, j).indexOf('setSettledNow') < 0
        && readerSrc.slice(i, j).indexOf('setSettled(') < 0,
        '⚠⚠⚠ `onViewRef` 里**一次**都不许改 settled（可见 ≠ 到位）—— 落位判据只在 `pushSeek` 一处');
    }
    ok(/if \(!settledRef\.current && seekRowRef\.current != null\)/.test(readerSrc)
      && /pushSeekRef\.current\(\)/.test(readerSrc),
      '⚠ 定位期间 `onScroll` 也要推一发（`scrollToOffset` 落到哪只有滚动事件知道）—— '
      + '⚠ 必须走 ref：`onScroll` 是 useCallback([]) 、`pushSeek` 定义在它之后');
    ok(/model\.seekStep\(/.test(readerSrc),
      '⚠⚠ 「这一发滚到哪」也走 `model.seekStep`（有缺口 ⇒ 只滚到第一个缺口）—— 视图不自己算');
    ok(/key=\{'L' \+ listId\}/.test(readerSrc),
      '⚠ 每换一章仍**整份重挂**列表（`key={\'L\' + listId}`）：换章要换行数组，重挂最省事也最不容易留旧状态');
    ok(/offsetRef\.current = 0;\s+contentHRef\.current = 0;/.test(readerSrc)
      && /rowHRef\.current = \{\};/.test(readerSrc),
      '⚠⚠⚠ 换内容（load）时必须把 offset / 内容总高 / **行高表**一起清掉 —— '
      + '留着上一章的：offset 会让定位判据用旧数，行高表会让 rowLayoutH 算出**别人的** y（都不报错）');
    ok(readerSrc.indexOf('firstContentRowIndex') < 0,
      '⚠⚠⚠ `firstContentRowIndex` 必须清干净 —— 它唯一的用途就是「跳过最前面那块上侧空白」，'
      + '上侧不摆了 ⇒ 第 0 行恒为内容行；留着它 = 又给「往列表前面塞东西」留了后门');

    /* ---- ★★★ 目录同一套：滚到**当前章那一行**（实测行高，不再 initialScrollIndex）---- */
    {
      const tf = readerSrc.indexOf('const tocHit = useCallback(');
      ok(tf > 0, '⚠⚠⚠ 目录定位要有 `tocHit`（打开目录 ⇒ 按实测行高滚到当前章那一行）');
      {
        const te = readerSrc.indexOf('}, [tocList, tocCurIdx]);', tf);
        const tb = te > tf ? readerSrc.slice(tf, te) : '';
        ok(/model\.rowLayoutH\(/.test(tb) && /scrollToOffset\(/.test(tb),
          '⚠⚠ 目录 y 走**同一个**纯函数 `rowLayoutH`（别在视图里另写累加 —— 两份迟早算出两个位置）',
          tb ? '' : '解析不到 tocHit 函数体');
      }
      ok(/onTocRowLayout/.test(readerSrc),
        '⚠⚠ 目录行要高**实测上报**（`renderTocItem` 的 `onLayout` ⇒ `onTocRowLayout`）—— '
        + '长标题两行，平均行高估出来会差好几章');
      ok(/tocDoneRef/.test(readerSrc),
        '⚠⚠ 目录落定后不许再抢（`tocDoneRef`）—— 否则用户一边看目录，列表一边自己滚');
      ok(/tocHRef\.current = \{\}/.test(readerSrc),
        '⚠⚠ 每次打开抽屉要清掉上一轮实测的高度（`onOpenSide` 里重置）—— 不清，第二次打开就不滚');
      ok(readerSrc.indexOf('onTocScrollFailed') < 0 && readerSrc.indexOf('initialScrollIndex') < 0,
        '⚠⚠ 目录不再 `scrollToIndex` ⇒ 那个失败重试也删干净');
      ok(/onContentSizeChange=\{\(\) => \{ if \(!tocDoneRef\.current\) tocHit\(\); \}\}/.test(readerSrc),
        '⚠ 面板是条件渲染（每次打开新挂载）⇒ 要接 `onContentSizeChange` 再推一发');
    }

    /* ---- ★★★ 视口回调：只做一件事 = 记「当前读到哪一块」---- */
    ok(/onViewableItemsChanged/.test(readerSrc) && /viewabilityConfig/.test(readerSrc) &&
       /onViewRef\.current/.test(readerSrc) && /viewConfigRef\.current/.test(readerSrc),
      '视口回调仍在（`onViewRef.current` / `viewConfigRef.current` 必须走 ref：RN 只在挂载时读一次）');
    ok(/row\.kind !== 'block'/.test(readerSrc),
      '⚠⚠⚠ 阅读位置只认**块行**（现在只有这一行型）—— 将来若加了别的行类型，'
      + '它们身上没有 `bi`，`readPosRef` 会被写进 undefined、把真位置冲没');
    ok(/model\.curChapter\(dataNowRef\.current\)/.test(readerSrc)
      && /model\.blockStarts\(dataNowRef\.current && dataNowRef\.current\.blocks\)/.test(readerSrc),
      '⚠⚠ 位置 = {当前章序, 视口最上面那一块的**首偏移**} —— 章序走 model.curChapter、'
      + '偏移走 model.blockStarts（与服务端写入时同一套口径）');
    ok(/readPosRef\.current = \{ chapter: ch, offset: typeof starts\[row\.bi\] === 'number' \? starts\[row\.bi\] : 0 \};/
      .test(readerSrc),
      '⚠⚠⚠ 章序 0 是合法值 ⇒ 判 `typeof`，别 truthy（写成 `if (ch)` 时第 0 章永远不记位置）');
    ok(readerSrc.indexOf('sectionCount') < 0,
      '⚠⚠⚠ 顶部「目录」入口的老判据（sectionCount）不许回来');
    ok(readerSrc.indexOf('curSecRef') < 0 && readerSrc.indexOf('tocListRef.current = tocList') >= 0,
      '⚠⚠⚠ 目录必须**镜像进 ref**（`tocListRef`）—— `onViewRef` / `tocHit` 是 ref 建的、**只建一次**，'
      + '读 `tocList` **state** 恒是首帧那份（空目录）⇒ 拿它当退路等于没有退路，而且一处都不报错');
    ok(readerSrc.indexOf('rowsNowRef.current = layout.rows') >= 0
      && readerSrc.indexOf('dataNowRef.current = res') >= 0,
      '⚠⚠ 行数组与 data 都要**镜像进 ref**（`rowsNowRef` / `dataNowRef`）—— '
      + '`onViewRef` 一辈子只建一次，闭包里读 state 永远是首帧那份');

    /* ---- ★ 书签高亮（2026-10-20 定案：只亮段内那一段字；用户要求「一直存在」= 常亮）----
       2026-10-21 改**数组**：巾箱补编那类书，书签 text 是竖排拆块拼法
       （`"癸 甲 癸 甲\n亥 寅 酉 寅"`），正文是干、支两个相邻块 ⇒ 最多亮两段。 */
    ok(/const \[hlSegs, setHlSegs\] = useState<Array<\{ bi: number; start: number; end: number \}>>\(\[\]\);/
      .test(readerSrc),
      '⚠⚠⚠ 段内高亮 state `hlSegs` 必须在（用户 2026-10-20 原话「有标记的八字高亮就行了」—— '
      + '只亮书签圈住的那段字，行底那层 `hlPara` 已删，别加回来）');
    ok(!/hlPara/.test(readerSrc) && !/hlRow/.test(readerSrc) && !/markBookmark/.test(readerSrc),
      '⚠⚠⚠ 行底高亮那族（`hlRow` / `hlPara` / `markBookmark`）**一个都不许剩** —— '
      + '2026-10-20 用户定的口径是「不需要两个一起出现」，留一半就是「移除反了」的复活形态');
    /* ⚠⚠⚠ 三条查找路（巾箱 934 条实测：68 / 646 / 216 / 4），顺序不能倒：
       offset 块直接亮 → matchBlock 全章按文字 → 竖排两行成对。
       竖排**必须两行成对判**（干行块紧跟支行块）—— 单看一行会撞
       （同干支的命例不止一个），真库 220 条验证成对判零撞车。 */
    ok(/const first = segOf\(res\.blocks, seek, want\);/.test(readerSrc)
      && /model\.matchBlock\(res\.blocks, want\.text\)/.test(readerSrc)
      && /split\('\\n'\)/.test(readerSrc)
      && /segOf\(res\.blocks, k \+ 1, \{ offset: 0, text: lines\[1\] \}\)/.test(readerSrc),
      '⚠⚠⚠ 高亮三条路必须齐：① offset 块直接亮 ② matchBlock 全章按文字再找 '
      + '③ 竖排拆块（text 含 \\n）按「干行块紧跟支行块」成对找、两块各亮一行');
    ok(/setHlSegs\(segs\);/.test(readerSrc),
      '⚠⚠⚠ 算完统一 `setHlSegs(segs)` —— 空数组 = 不亮（宁可少亮，不给一个对不上的位置）');
    ok(/if \(hl && seek != null && want\) \{/.test(readerSrc)
      && !/if \(seek != null && want\) \{/.test(readerSrc),
      '⚠⚠⚠ 高亮计算必须包在 `hl` 门里 —— 翻章 / 从书架恢复位置也亮的话满屏金色'
      + '（hl 决定亮不亮，jump 决定滚不滚，两件事不能混）');
    ok(/const seg = item && typeof item\.bi === 'number' \? hlMap\.get\(item\.bi\) \|\| null : null;/.test(readerSrc),
      '⚠⚠⚠ renderItem 按 `hlMap`（bi → 段）取 —— 最多两段竖排高亮，别在每行渲染里扫数组');
    ok(!/toValue/.test(readerSrc),
      '⚠⚠⚠ 高亮必须**常亮**：不许出现淡出动画（toValue）—— 用户 2026-10-11 要求「一直存在」');
    ok(!/hlTimer|clearTimeout\(hlTimer/.test(readerSrc),
      '⚠ 淡出的遗留（hlTimer / clearTimeout）必须清干净 —— 常亮版本不需要任何定时器');
    ok(!/setTimeout\([\s\S]{0,120}?setHlSegs\(\[\]\)/.test(readerSrc),
      '⚠⚠⚠ 高亮**不许自动撤**（setHlSegs([]) 的定时器）—— 用户 2026-10-11 原话'
      + '「让这个高亮一直存在啊」；那之后本项目所有「自动播完就没」的动效一律先问再做');
    const hlStyle = /hlText:\s*\{([^}]*)\}/.exec(readerSrc);
    ok(hlStyle && /backgroundColor/.test(hlStyle[1])
      && !/padding|margin|fontSize|lineHeight|width|height/.test(hlStyle[1]),
      '⚠⚠⚠ 段内高亮样式（`hlText`）只许底色/圆角这类**不影响尺寸**的属性 —— '
      + '高亮块尺寸一变，按未高亮量出来的行高就对不上，定位当场算错',
      hlStyle ? 'hlText = {' + hlStyle[1].trim() + '}' : '解析不到 hlText 样式');
    ok(/const segText = useCallback/.test(readerSrc) && /s\.hlText/.test(readerSrc),
      '⚠⚠⚠ 段内高亮的画法 = `segText`（前/高亮/后三个 <Text>，demo 的 Range 在 RN 里的对应物）');

    /* ---- ★ 块类型 → 样式（标题块 / 出处块）---- */
    ok(/model\.isHeading\(item\.type\)/.test(readerSrc),
      '⚠ 标题块判据走 `model.isHeading`（纯函数、可断言），别在 renderItem 里内联比字符串');
    ok(/model\.blockDepth\(item\.type\)/.test(readerSrc),
      '⚠⚠ 标题块缩进走 `model.blockDepth`（老那个 `titleDepth(item.level)` 已删 —— '
      + '块类型是字符串，喂数字会全部落 0 档，缩进全没且不报错）');
    ok(/s\.secWrap/.test(readerSrc) && /s\.secTitle/.test(readerSrc),
      '  └ 标题块有自己的容器与字号样式');
    ok(/item\.type === 'source' \? s\.srcPara : s\.para/.test(readerSrc),
      '⚠⚠ 出处块（source）用小字（`s.srcPara`）—— ⚠ 它的**盒模型必须与 para 完全一致**'
      + '（只换字号不改行高 / 边距），否则行高实测会被它带歪');
    ok(readerSrc.indexOf('kind === \'spacer\'') < 0 && readerSrc.indexOf("kind === 'prev'") < 0,
      '⚠⚠⚠ renderItem 里**不许再有 spacer / prev 分支** —— 列表只剩块行一种');

    /* ---- ★ 并发与状态 ---- */
    ok(readerSrc.indexOf('loadingRef') >= 0, '⚠ 翻章有同步锁（连点翻章 = 发好几个重复请求，setPhase 异步挡不住）');
    ok(readerSrc.indexOf('aliveRef') >= 0, '⚠ 卸载安全（推入层关掉后在飞的请求回来不许再碰已卸载的页）');
    ok(readerSrc.indexOf('lastParamsRef') >= 0, '失败重试用上一次的参数（从哪失败回哪）');
    ok(readerSrc.indexOf('genRef') >= 0, '⚠ 换内容时作废在飞的旧请求（genRef +1）');
    ok(/const headTitle = /.test(readerSrc) && /bookName \|\| \(target && target\.title\)/.test(readerSrc),
      '⚠⚠⚠ 顶栏章名走 `bookName`（响应里的 bookTitle / 目录的 book.title）—— '
      + '**不许**走 `model.bookTitle(target.book)`：`book` 是 book_key（内容哈希），'
      + '那样顶栏会显示一串十六进制，而且一处都不报错');
    ok(/const \[bookName, setBookName\] = useState\(''\);/.test(readerSrc)
      && /setBookName\(res\.bookTitle\)/.test(readerSrc)
      && /setBookName\(res\.book\.title\)/.test(readerSrc),
      '⚠⚠ 书名两处兜底：正文响应（`res.bookTitle`）+ 目录响应（`res.book.title`）—— '
      + '只靠一处，另一条路先回来时顶栏是空的');

    /* ---- ★★★ 入口 effect：点封面 / 点书签都直达内容，目录在它自己那个 effect 里 ---- */
    {
      const entryFn = /useEffect\(\(\) => \{\s*aliveRef\.current = true;[\s\S]*?\}, \[entry[^\]]*\]\);/.exec(readerSrc);
      ok(!!entryFn, '入口 effect 能抓到（抓不到 ⇒ 下面这条是哑断言）');
      ok(entryFn && entryFn[0].indexOf('setView') < 0 && entryFn[0].indexOf('openToc') < 0 &&
         entryFn[0].indexOf('loadToc') < 0,
        '⚠⚠⚠ 入口 effect：没有任何目录分流（点封面 / 点书签都直达内容；目录在它自己那个 effect 里）');
      ok(/useEffect\(\(\) => \{ loadToc\(\); \}, \[entry, loadToc\]\);/.test(readerSrc),
        '⚠⚠ 目录取数是**另一个独立的 effect**（与正文完全解耦：它失败不拦正文，'
        + '只是「上一章 / 下一章 / 目录」那几个按钮取不到目标而置灰）');
    }
    ok(readerSrc.indexOf('moreOverlay') < 0 && readerSrc.indexOf("moreDir === 'up'") < 0,
      '⚠⚠ 顶部不再有「上翻的正在加载…」（2026-10-13 用户要求移除）');
    ok(readerSrc.indexOf('isTocEntry') < 0,
      '⚠⚠⚠ 点开书**直接进正文** —— isTocEntry 这个死函数不许回流');

    /* ---- ★ 2026-10-12 阅读位置（core/readPos.js）：关书就记，开书就回 ---- */
    {
      const readPosLib = require(path.join(ROOT, 'src', 'core', 'readPos.js'));
      const storeLib = require(path.join(ROOT, 'src', 'platform', 'storage.js'));
      /* ⚠ 先塞半截 JSON 再读 —— 必须在**任何读写之前**做（模块的解析缓存是惰性且粘住的，
         一旦被好数据填过，这条就验不到「坏数据兜底」了）。 */
      storeLib.setStorageSync(readPosLib.KEY, 'not-json{{{');
      eq(readPosLib.get('甲.docx'), null, '⚠ 存储里是半截 JSON → 当没记过（绝不抛，阅读位置丢了不要紧）');
      /* 基本读写（Node 里 storage 就是内存镜像；落盘语义由 storage 自己的测试守） */
      readPosLib.set('abc123def456', 3, 42);
      eq(readPosLib.get('abc123def456') && readPosLib.get('abc123def456').chapter, 3, '写入后读回同一条（章序）');
      eq(readPosLib.get('abc123def456') && readPosLib.get('abc123def456').offset, 42, '  └ 章内字符偏移');
      const rawPos = storeLib.getStorageSync(readPosLib.KEY);
      eq(typeof rawPos === 'string' && JSON.parse(rawPos)['abc123def456'].offset, 42,
        '落盘是**整份 JSON**（这是 reload 后还在的前提）');
      eq(readPosLib.KEY, 'paipan_read_pos_v2',
        '⚠⚠⚠ 存储键升到 **v2**（v1 装的是 {文件名 → {seq}}，键和值都不同）—— '
        + '就地改会把每个老值都读成坏数据，跟换键效果一样却多一段看不出在干什么的兼容代码');
      /* ⚠⚠⚠ chapter=0 / offset=0 都是**合法位置**（第一章 / 章首第一个字）——
         「有没有记过」只能看 null，truthy 会把它吃成没读过 */
      readPosLib.set('乙.docx', 0, 0);
      eq(readPosLib.get('乙.docx') && readPosLib.get('乙.docx').chapter, 0,
        '⚠⚠⚠ chapter=0（第一章）是合法位置，必须如实返回（不许被当成「没记过」）');
      eq(readPosLib.get('乙.docx') && readPosLib.get('乙.docx').offset, 0,
        '⚠⚠⚠ offset=0（章首第一个字）同理');
      /* 防御：坏入参不写（写了坏值 = 下次 get 返回 null = 把老位置弄丢） */
      readPosLib.set('丙.docx', -1, 5);
      eq(readPosLib.get('丙.docx'), null, '⚠ 负章序不写（别让坏值把老位置顶掉）');
      readPosLib.set('丁.docx', 3, -1);
      eq(readPosLib.get('丁.docx'), null, '⚠ 负偏移同样不写');
      readPosLib.set('戊.docx', '3', 5);
      eq(readPosLib.get('戊.docx'), null, '⚠⚠ 字符串章序不写（typeof 判过）');
      readPosLib.set(null, 5, 5);
      eq(readPosLib.get(''), null, '⚠ book_key 为空不崩也不写');
      /* ⚠⚠⚠ 半截数据（只记了章、没记偏移）必须**当坏的**：
         重建成 `offset: 0` 会把人送到章首，而他自己读到的是章末 ——
         那比「回到章首」更让人困惑（明明跳了，却跳到了错的地方）。 */
      storeLib.setStorageSync(readPosLib.KEY, JSON.stringify({ half: { chapter: 3 } }));
      const rpPath = path.join(ROOT, 'src', 'core', 'readPos.js');
      delete require.cache[require.resolve(rpPath)];
      eq(require(rpPath).get('half'), null,
        '⚠⚠⚠ 只记了章、没记偏移（半截数据）⇒ 当坏的（不许重建 offset:0）');
    }

    /* ---- ★★★ 一次一章：整章给全（老契约保留）---- */
    ok(readerSrc.indexOf('books.chapter(') >= 0,
      '⚠⚠⚠ 一次一章：`load` 走 `books.chapter`（一章 = 一个请求给全）');
    ok(readerSrc.indexOf('whole') < 0,
      '⚠⚠⚠ `whole` 这个开关没有了 —— 一章天然就是全的，服务端不再需要「只要这一章」的标志位');
    ok(readerSrc.indexOf('hiddenRef') < 0,
      '⚠⚠⚠ 被丢掉的那半片**不许存在本地 / 内存**（用户 2026-10-12：「书的数据不要往本地存，'
      + '因为我会更新书籍的内容的」）—— 存了就会显示**旧内容**，书改了也对不上');

    /* ---- ★★★ 向下**不做**懒加载：空白 / 续拉 / 添屏那一整套一个字都不许回流 ---- */
    {
      /* ⚠⚠ 逐个符号查「声明 / 调用形态」，不查「文件里有没有 loadMore 这个字」那种哑断言：
         注释里的墓碑也会命中 —— 所以下面这批都带 `const` / `=` / `(` 这类结构。 */
      const banned = [
        ['PAD_SCREENS_INIT', /const PAD_SCREENS_INIT\s*=/],
        ['PAD_SCREENS_MAX', /const PAD_SCREENS_MAX\s*=/],
        ['PAD_UP_SCREENS_INIT', /const PAD_UP_SCREENS_INIT\s*=/],
        ['padDown', /const \[padDown, setPadDown\]/],
        ['checkBlank', /const checkBlank = useCallback/],
        ['loadMore', /const loadMore = useCallback/],
        ['commitSlice', /const commitSlice = useCallback/],
        ['moreRef', /const moreRef = useRef/],
        ['moreDir', /const \[moreDir, setMoreDir\]/],
        ['upArmedRef', /const upArmedRef = useRef/],
        ['prevPhase', /const \[prevPhase, setPrevPhase\]/],
        ['PREV_TIMEOUT_MS', /const PREV_TIMEOUT_MS\s*=/],
        ['onPullPrev', /const onPullPrev = useCallback/],
        ['verifyPrepend', /const verifyPrepend = useCallback/],
        ['scheduleVerify', /const scheduleVerify = useCallback/],
        ['isMusting', /const isMusting = useCallback/],
        ['MUST_MS', /const MUST_MS\s*=/],
        ['VERIFY_MS', /const VERIFY_MS\s*=/],
        ['endMore', /const endMore = useCallback/],
        ['shootPrepend', /const shootPrepend/],
        ['clearShots', /const clearShots/],
      ];
      const hit = banned.filter(([, re]) => re.test(readerSrc)).map(([n]) => n);
      ok(hit.length === 0,
        '⚠⚠⚠ 向下懒加载那套**必须一行都不剩**（用户 2026-10-17：「阅读页面向下滑动就不要做懒加载了」）：'
        + '空白行（padDown / PAD_SCREENS_*）、空白判据（checkBlank）、'
        + '续拉（loadMore / commitSlice / moreRef / moreDir）、到顶加载（upArmedRef / prevPhase / onPullPrev）、'
        + '前插守位（verifyPrepend / scheduleVerify / isMusting / MUST_MS / VERIFY_MS）'
        + ' —— 现在查到的还有：' + hit.join(', '));
      ok(!/s\.spacerBox|s\.moreText/.test(readerSrc),
        '⚠⚠⚠ 空白行与「正在加载…」的样式必须随渲染一起删干净（留着就是给空白行留后门）');
      ok(readerSrc.indexOf('hasMoreDown') < 0 && readerSrc.indexOf('appendParas') < 0
        && readerSrc.indexOf('prependParas') < 0 && readerSrc.indexOf('hasPrev') < 0
        && readerSrc.indexOf('upFrom') < 0,
        '⚠⚠⚠ 「往下还有没有 / 往下并数据 / 往上接一片」三个 model 调用不许再出现在视图里 —— '
        + '一次一章之下它们永远为假 / 永远不该发生');
      ok(readerSrc.indexOf('data.prevSection') < 0,
        '⚠⚠ 「上一章」只走 `load(chapter=…)` 这一种形态（整章换内容）—— '
        + '老那个 `data.prevSection`（服务端算好的上一章）不许回来');
      ok((readerSrc.match(/section:/g) || []).length === 0,
        '⚠⚠⚠ 全文一次都不许出现 `section:`（老协议的章标识，接口已经不认）');
      ok(readerSrc.indexOf('atSeqOf') < 0 && readerSrc.indexOf('splitAt') < 0
        && readerSrc.indexOf('nextFrom') < 0 && readerSrc.indexOf('rowIndexOfSeq') < 0
        && readerSrc.indexOf('seekRowIndex') < 0 && readerSrc.indexOf('matchPara') < 0
        && readerSrc.indexOf('mergeSections') < 0,
        '⚠⚠⚠ 「一条连续段落流」那一族（atSeqOf / splitAt / nextFrom / rowIndexOfSeq / '
        + 'seekRowIndex / matchPara / mergeSections）一个调用都不许有');
    }

    /* ---- ★★★ 老机制整族删除的反向断言（一条条点名，别用宽泛正则）---- */
    {
      const dead = [
        'const submit', 'flushPending', 'scrubbingRef', 'pendingRef',
        'settleTimerRef', 'const SETTLE_MS', 'onScrollEndDrag',
        'onMomentumScrollBegin', 'onMomentumScrollEnd', 'onScrollBeginDrag',
        'keepTailAnchor', 'setSpacer', 'const spacerH', 'const prevRef',
        'prependSeqRef', 'mustUntilRef', 'userMovedRef', 'readRowIdxRef',
        'probeBeforeRef', 'const rdRunRef', 'webTop', 'rdReport',
        'retryIdxRef', 'retryCountRef', 'pullPrevRef', 'prevTimerRef',
        'verifyTimersRef', 'prependShotRef', 'const dbg', 'dbgSet', 'dbgSample',
        'hiddenRef', 'TITLE_LOOKAHEAD', 'readSeqRef', 'seekSeqRef', 'hlSeq',
        'curSecRef', 'onTocScrollFailed', 'initialScrollIndex', 'scrollToIndex',
        'onScrollToIndexFailed', 'maintainVisibleContentPosition',
        'contentContainerStyle',
        'onEndReached', 'onEndReachedThreshold', 'EDGE_RATIO', 'upThreshold',
        'isTocEntry', 'setView', 'openSection', 'crumbs', 'headRow',
        'tocBtn', 'tocText', 'crumbText', 'tocDepth', 'titleDepth',
        'isBookmarkPara', 'jumpable', 'chapterAt', 'chapterIndex', 'chapterRowAt',
        'hopRef', 'hopSec', 'firstContentRowIndex', 'SPACER_UP_KEY',
        'SPACER_KEY', 'SPACER_DOWN_KEY', 'PREV_KEY', 'PREV_TIP_TEXT',
        'PULL_MORE_TEXT', 'RELEASE_MORE_TEXT', 'PREV_CHAPTER_TEXT',
        'prevFrom', 'mergeParas', 'atSeqOf', 'splitAt', 'needFillUp',
        'canLoadUp', 'joinPrepend', 'nextFrom', 'hasMoreDown',
        'appendParas', 'prependParas', 'mergeSections', 'matchPara',
        'rowIndexOfSeq', 'seekRowIndex', 'sectionCount', 'goSection', 'goPage',
        'PREV_SEC_TEXT', 'NEXT_SEC_TEXT', 'PREV_PAGE_TEXT', 'NEXT_PAGE_TEXT',
        'prevPhase', 'padDown', 'PAD_SCREENS_INIT', 'PAD_SCREENS_MAX',
        'checkBlank', 'loadMore', 'commitSlice', 'moreRef', 'moreDir',
        'upArmedRef', 'PREV_TIMEOUT_MS', 'onPullPrev', 'verifyPrepend',
        'scheduleVerify', 'isMusting', 'MUST_MS', 'VERIFY_MS', 'endMore',
      ];
      /* ⚠ 查的是「**调用/声明形态**」，不是裸词 —— 墓碑注释里会出现这些名字（那是给后人看的）。
         ⚠ 每个名字后面必须跟一个「它正在被用」的字符：`(` / `.` / 空格 / `=` / `:`。
         这样 `scrollToIndex` 这种**已经删干净**的也能查（墓碑注释已被 stripComments 剥掉）。 */
      const alive = dead.filter(function (n) {
        const re = new RegExp(n.replace(/\./g, '\\.') + '[(.\\s=:]');
        return re.test(readerSrc);
      });
      ok(alive.length === 0,
        '⚠⚠⚠ 老机制整族（前插 / 到顶加载 / 往下续拉 / scrollToIndex 定位 / 常驻目录 / '
        + '连续段落流）**必须一个都不剩** —— 还活着的：' + alive.join(', '));
    }
    ok(readerModelSrc.indexOf('EDGE_RATIO') < 0 && readerModelSrc.indexOf('upThreshold') < 0,
      '⚠⚠⚠ 阈值那套（`EDGE_RATIO` / `upThreshold`）**代码**里一个字符都不许剩 ——'
      + '⚠ 这条查的是**剥过注释**的源码（注释里解释「删掉了什么」不算数，不然它自己就把断言顶成假绿）');
    ok(readerModelSrc.indexOf('splitAt') < 0 && readerModelSrc.indexOf('nextFrom') < 0
      && readerModelSrc.indexOf('appendParas') < 0 && readerModelSrc.indexOf('prependParas') < 0,
      '⚠⚠⚠ model 层同样不许留「连续段落流」那族的**实现**（不只是不导出）—— '
      + '留着实现 = 迟早有人把它接回去');
    ok(readerModelSrc.indexOf('idx - 1') < 0 && readerModelSrc.indexOf('idx + 1') < 0
      && readerModelSrc.indexOf('tocList, curSec') < 0,
      '⚠⚠⚠ 老那套「按目录反查章」（prevChapter(tocList, curSec) / chapterAt）的实现不许回来');

    /* ---- MVCP：翻章是整份换内容，不再有「头部插入」这件事 ---- */
    ok(readerSrc.indexOf('maintainVisibleContentPosition') < 0,
      '⚠⚠⚠ 列表**不许**再挂 `maintainVisibleContentPosition` —— 前插那条路已删（2026-10-17），'
      + 'MVCP 没有要守的东西；翻章时它反而会拿旧锚把新内容拽走（定位刚落地就被拽偏）');
    ok((readerSrc.match(/maintainVisibleContentPosition/g) || []).length === 0,
      '⚠⚠⚠ `maintainVisibleContentPosition` 一次都不许出现');
    ok(readerSrc.indexOf('contentContainerStyle') < 0,
      '⚠⚠ 列表不许有 contentContainerStyle（上下 padding）：定位算的是**行累计高度**，'
      + '多几十像素 padding 就是「怎么滚都差一截」，而且不报错');
    /* ⚠⚠ 只禁**正文那个列表**（`key={'L' + listId}` 那一个）：侧栏抽屉里那两个列表
       没有定位这回事，它们的 Header/Footer 不影响行高累加（2026-10-19 重做后新增的边界）。 */
    {
      const li = readerSrc.indexOf("key={'L' + listId}");
      const lj = li >= 0 ? readerSrc.indexOf('/>', li) : -1;
      const contentList = li >= 0 && lj > li ? readerSrc.slice(li, lj) : '';
      ok(contentList.indexOf('ListHeaderComponent') < 0 && contentList.indexOf('ListFooterComponent') < 0,
        '⚠⚠ 正文行不许做进 ListHeader/FooterComponent —— 那两处会被原生当成视口锚点，'
        + '行高也不在 `onLayout` 上报范围内（定位会漏掉它们的高度）',
        contentList ? '' : '（解析不到正文那个 FlatList）');
    }
    ok(readerSrc.indexOf('onEndReached') < 0,
      '⚠⚠⚠ **不许**再有 onEndReached / onEndReachedThreshold（阈值型预加载）—— 一次一章，'
      + '「到底了自动拉」已随续拉一起删');
    ok(readerSrc.indexOf('onEndReachedThreshold') < 0,
      '⚠⚠ 视图侧同样不许留 onEndReachedThreshold（连属性名一起清）');

    /* ---- ★ 2026-10-11 二改：取消翻章/翻页按钮，改成「一条流读到底」----
       ⚠⚠⚠ 续拉**不传 section**（游标是全书偏移）—— 传了就等于把「跨章连续」又切回「单章」，
         而且不会有任何报错（只是读完这一章就停了）。 */
    ok(readerSrc.indexOf('goSection') < 0 && readerSrc.indexOf('goPage') < 0,
      '⚠ 翻章 / 翻页那两个动作必须清干净（按钮已取消）');

    /* ---- QueryPane.tsx：条目可点 ---- */
    ok(/<Pressable\s+style=\{\[s\.card, s\.bmCard\]\}/.test(src), '学堂页书签条目是 Pressable（原先是不带事件的 View —— 点了没反应，用户报的根因）');
    ok(src.indexOf('onOpenBookmark?.(model.bookmarkTarget(item) as any)') >= 0,
      '⚠⚠⚠ QueryPane 把 onOpenBookmark 回调接到条目 onPress 上，而且传的是'
      + ' **model.bookmarkTarget(item)**（不是原始 item）—— 阅读页要的'
      + ' chapter / offset / book / title 四个字段全靠它拼，漏一个就定位不到或导航栏显示哈希');

    /* ---- App.tsx：推入层接线 ---- */
    ok(/const \[readerEntry, setReaderEntry\]/.test(appSrc), 'App 有 readerEntry 计数（推入层用计数器不用布尔，同结果页/登录页）');
    ok(/const showReader = tabsModel\.layerOpen\(readerEntry\)/.test(appSrc), 'showReader 走 tabsModel.layerOpen（同一套开关语义）');
    ok(/<Reader entry=\{readerEntry\}/.test(appSrc), '阅读层挂上了 <Reader>（entry 驱动重跑 load）');
    ok(/<Study[\s\S]{0,240}?onOpenBookmark=\{onOpenBookmark\}/.test(appSrc), '⚠ <Study> 接上了 onOpenBookmark（不接 = 点了书签什么都不会发生）');
    ok(/else if \(showReader\) onCloseReader\(\)/.test(appSrc), '⚠ 返回键优先级里有阅读层（漏了 = 盖着阅读层按返回退出整个 App）');
    ok(/const live = !showResult && !showLogin && !showReader;/.test(appSrc),
       '⚠ live 判据带 !showReader（推入层盖着时 tab 必须是 onHide —— 漏一层，那页盖着还在后台跑）');
    /* ⚠ 2026-10-21：仿制页（`screens/demo/InfiniteTop`）整页删了，
       live / 返回键 / 推入层都不该再出现 showDemo。 */
    ok(!/showDemo|InfiniteTop/.test(appSrc), '⚠ App.tsx 里不许再有仿制页那一层（已整页删除）');
    ok((appSrc.match(/<Reader\b/g) || []).length >= 1, '在 App.tsx 里抓到了 <Reader> 标签');
    {
      const ov = /overlayReader: \{[\s\S]*?\n  \}/.exec(appSrc);
      ok(!!ov, '阅读层有自己的 overlay 样式');
      ok(ov && /zIndex: 15/.test(ov[0]), '  └ zIndex 15（结果页 10 / 登录 20 之间，不许跟别的层重号）');
      ok(ov && /left: 0/.test(ov[0]) && /bottom: 0/.test(ov[0]), '  └ 显式写四边定位（RN 0.86 删了 absoluteFillObject，展开它 = 什么都没写）');
    }
    /* ⚠⚠⚠ 2026-10-19 换代：导航栏书名**不许**再走 `readerModel.bookTitle(target.book)` ——
       `book` 现在是 book_key（内容哈希），那样顶栏会显示一串十六进制，而且一处都不报错。 */
    ok(/<NavBar title=\{readerTarget \? \(readerTarget\.title \|\| ''\) : ''\} onBack=\{onCloseReader\} \/>/
      .test(appSrc),
      '⚠⚠⚠ App 的 NavBar 书名读 `readerTarget.title`（study/model.js 的 bookTarget / bookmarkTarget 填的）');
    ok(appSrc.indexOf('readerModel') < 0,
      '⚠⚠⚠ App 不再需要 readerModel（那本该是「书名兜底」，而 book 已经是哈希）—— '
      + '留着 import 就是给下一个人留一个「把哈希当书名显示」的坑');
  }
}

/* ================================================================
 * ★ 在线心跳 + 服务端指令（2026-10-04）—— 长轮询在壳里的接线
 * ================================================================
 * ⚠⚠ 逻辑本身（游标 / 去重 / 退避）在 local-check 的第十二节断言，
 *   这里只守**壳**上的三件事：什么时候起停、指令怎么变成界面动作、
 *   提示条有没有真的挂上去。这三件任一漏了都是「功能悄悄不工作」：
 *   · 漏 start        → 后台永远看不到这个人在线
 *   · 漏 stop         → 退后台还在打请求（烧电），
 *   · 不判 isTab      → 一条写错页名的指令把界面切成空白
 *   · 退场不说再见     → 用户关了 App，后台还亮着「在线」一分钟
 */
console.log('\n--- presence（在线心跳 + 指令）---');
{
  const fs = require('fs');
  const appTxt = stripComments(fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8'));
  const noticeSrc = stripComments(
    fs.readFileSync(path.join(ROOT, 'src', 'components', 'Notice.tsx'), 'utf8')
  );

  /* ---- App.tsx：起停时机 ---- */
  ok(/const presence: any = require\('\.\/src\/core\/presence\.js'\)/.test(appTxt),
     'App.tsx 在**模块层**引了 core/presence.js（写进组件体里会在每次渲染重造一个循环）');
  ok(appTxt.indexOf("require('./src/core/presence.js')") < appTxt.indexOf('export default function App'),
     '  └ 而且是文件顶部那句（在组件定义之前）');
  ok(/presence\.createLoop\(/.test(appTxt), '起了一个心跳循环');
  ok(/loop\.start\(\)/.test(appTxt) && /loop\.stop\(/.test(appTxt), '  └ start / stop 都有');
  ok(/return \(\) => \{ loop\.stop\(\{ offline: true \}\); \};/.test(appTxt),
     '⚠⚠⚠ effect 的清理函数里 stop({offline:true})：既要停循环（少了它 ⇒ 换账号/退后台时旧循环还在跑），'
     + '又要告诉服务端「我走了」（少了 offline ⇒ 关了 App 后台还亮着「在线」一分钟）');
  ok(/AppState\.addEventListener\('change'/.test(appTxt),
     '⚠⚠ 监听 AppState：退后台停、回前台重启（否则锁屏后还在每 25 秒发请求）');
  ok(/\}, \[appActive, sessionRev, forceLogout\]\);/.test(appTxt),
     '⚠⚠⚠ effect 依赖里同时有 appActive 与 sessionRev（这俩是**重启信号**，少 sessionRev ⇒ 换账号后心跳还挂在老账号上）；'
     + 'forceLogout 是 useCallback（身份稳定），加进去不会造成无谓重启');
  ok(appTxt.indexOf('const loop = presence.createLoop') > appTxt.indexOf('function Root()'),
     '⚠ 接线在 Root() 里（App() 那半是历史死代码，接错地方 = 根本不生效）');

  /* ---- App.tsx：指令 → 动作 ---- */
  ok(/if \(a\.type === 'toast'\)/.test(appTxt), 'toast 指令 → 走一条分支');
  ok(/setNotice\(\{ id: noticeSeq\.current, text: a\.text \}\)/.test(appTxt),
     '  └ 带自增 id（连着两条一样的提示也要重新计时，见 Notice 文件头）');
  ok(/if \(!tabsModel\.isTab\(a\.tab\)\) return;/.test(appTxt),
     '⚠⚠⚠ goto 的目标页先用 tabsModel.isTab 判（判据复用同一份 tab 表，不许这里再抄一份）');
  {
    const branch = /if \(a\.type === 'goto'\) \{[\s\S]{0,700}?\n        \}/.exec(appTxt);
    ok(!!branch, '抓到 goto 分支（锚点没漂）');
    ok(branch && /setResultEntry\(0\)/.test(branch[0]) && /setReaderEntry\(0\)/.test(branch[0])
      && /setLoginEntry\(0\)/.test(branch[0]),
       '  └ 切 tab 前先把三个推入层收掉（不收 ⇒ 用户落在被盖住的页上，看起来像没反应）');
    ok(branch && /setTab\(a\.tab\)/.test(branch[0]), '  └ 最后才切 tab');
  }
  ok(/console\.log\('\[paipan\] presence ' \+ kind/.test(appTxt),
     '⚠ 心跳状态默认只打日志 —— 不许弹提示（后端没开、换 WiFi 都会失败，每次弹一下会让用户以为 App 坏了）');
  ok(!/onStatus:[\s\S]{0,400}?setNotice/.test(appTxt),
     '  └ onStatus 里确实没有直接 setNotice（唯一会弹的是 unauthorized：凭证作废，走 forceLogout）');

  /* ---- App.tsx：强制下线（logout 指令 + 401 两条路汇到 forceLogout） ---- */
  ok(/if \(a\.type === 'logout'\) \{/.test(appTxt), '⚠ logout 指令 → 单独一条分支');
  ok(/forceLogout\(a\.reason \|\| KICKED_TEXT\)/.test(appTxt),
     '⚠⚠⚠ 收到 logout 就调 forceLogout，并且**服务端没写理由时用兜底话术**'
     + '（一声不吭地把人踢出去 ⇒ 用户只看到「突然回到未登录」，会以为 App 坏了）');
  ok(/const forceLogout = useCallback\(/.test(appTxt),
     '⚠⚠ 两条路（logout 指令 / 任意请求 401）**汇到同一个 forceLogout** —— 各写一份的话行为迟早会漂');
  {
    const fn = /const forceLogout = useCallback[\s\S]{0,1600}?\}, \[onSessionChanged\]\);/.exec(appTxt);
    ok(!!fn, '抓到 forceLogout 函数体（锚点没漂）');
    ok(fn && /presence\.clearCursor\(\)/.test(fn[0]),
       '⚠⚠⚠ forceLogout 里清了**指令游标**：踢人靠下发一条 logout 指令，而那条指令留在服务端库里；'
       + '不清游标 ⇒ 重新登录后会被当成「没收到过」再发一次 ⇒「刚登录就又被踢」');
    ok(fn && /auth\.logout\(\)/.test(fn[0]), '  └ 清掉本地凭证');
    ok(fn && /onSessionChanged\(\)/.test(fn[0]),
       '  └ 通知全局（boot.forget + sessionRev+1 ⇒ 四个常驻 tab 重新加载，记录页显示「未登录」态）');
  }
  ok(/if \(kind === 'unauthorized'\)/.test(appTxt),
     '⚠⚠ 心跳拿到 401 也要有动作（被踢的人如果不在线，只能靠这条发现自己的票废了）');
  {
    const una = /if \(kind === 'unauthorized'\) \{[\s\S]{0,900}?\n        \}/.exec(appTxt);
    ok(una && /auth\.isLoggedIn\(\)/.test(una[0]),
       '  └ 先判本机**有没有**凭证：本来就没登录时什么都不做（没有东西可清，弹提示纯属噪音）');
    ok(una && /forceLogout\(/.test(una[0]), '  └ 有凭证才走 forceLogout');
  }
  ok(/presence\.clearCursor\(\);\n    onSessionChanged\(\);/.test(appTxt),
     '⚠⚠⚠ 登录成功也要清游标（onLoggedIn）—— 被踢的人重新登录时那次心跳必须是「第一次心跳」，'
     + '否则服务端会把那条 logout 重放一遍');
  ok(/if \(!auth\.isLoggedIn\(\)\) return;/.test(appTxt),
     '⚠ 本机没有凭证就不起心跳循环（发了也是 NO_SESSION，白跑一趟）');

  /* ---- core/presence.js：logout 的翻译 + 401 的判据 ---- */
  {
    const presSrc = stripComments(
      fs.readFileSync(path.join(ROOT, 'src', 'core', 'presence.js'), 'utf8')
    );
    ok(/c\.kind === 'logout'/.test(presSrc), '⚠ core 层认得 logout 这个 kind');
    ok(/return \{ type: 'logout', reason: reason \};/.test(presSrc),
       '  └ 而且**没有 reason 也照样返回动作**（照 toast 那样「空就 null」⇒ 没写理由的强制下线会静默失效）');
    ok(/r\.status === 401 \|\| r\.code === 'NO_SESSION' \|\| r\.code === 'EXPIRED'/.test(presSrc),
       '⚠⚠ 判据里必须有 `status === 401`：老版本服务端不带 code，只认 code 就漏了「被踢」这条最重要的情况');
  }

  /* ---- Settings.tsx：退出登录要先说「我走了」 ---- */
  {
    const setTxt = stripComments(
      fs.readFileSync(path.join(ROOT, 'src', 'screens', 'settings', 'Settings.tsx'), 'utf8')
    );
    const byeAt = setTxt.indexOf('presence.bye()');
    const logoutAt = setTxt.indexOf('auth.logout()');
    ok(byeAt > 0,
       '⚠⚠ 退出登录会先说一声「我走了」（presence.bye）—— 不然后台要等 60 秒窗口过期才显示离线，灯一直亮着');
    ok(byeAt > 0 && logoutAt > 0 && byeAt < logoutAt,
       '⚠⚠⚠ 而且这句话必须在 auth.logout() **之前**（清完凭证 bye 就拿不到令牌，只能静默跳过）');
  }

  /* ---- App.tsx：提示条挂上去了 ---- */
  ok(/<Notice key=\{notice\.id\} text=\{notice\.text\} onDone=\{onCloseNotice\} \/>/.test(appTxt),
     '⚠⚠ <Notice> 挂上了，而且 key={notice.id}（同一句话再来一条也要重挂载重计时）');
  ok(/const onCloseNotice = useCallback\(\(\) => \{ setNotice\(null\); \}, \[\]\)/.test(appTxt),
     '  └ 到点/被点掉由父组件清状态（组件自己不持有「还在不在」）');
  ok(appTxt.indexOf('<Notice') > appTxt.indexOf('overlayTop'),
     '⚠ 提示条渲染在**所有推入层之后**（它要盖得住结果页/阅读页/登录页）');

  /* ---- Notice.tsx：不挡手、会自己消失 ---- */
  ok(noticeSrc.indexOf('Alert') < 0,
     '⚠ Notice 不用 Alert（模态会打断用户，后台发来的一句话没这个分量）');
  ok(/setTimeout\(onDone, SHOW_MS\)/.test(noticeSrc), '到点自动消失');
  ok(/return \(\) => clearTimeout\(t\);/.test(noticeSrc),
     '⚠⚠ 必须清计时器：提示被提前点掉、或连着来第二条（重挂载）时，旧计时器会把新的那条关掉');
  ok(/zIndex: 30/.test(noticeSrc), '⚠ zIndex 30（比登录层 20 还高：后台发的话在任何页面上都该看得见）');
  {
    const wrap = /wrap: \{[\s\S]*?\n  \}/.exec(noticeSrc);
    ok(!!wrap, '提示条有 wrap 样式');
    ok(wrap && /position: 'absolute'/.test(wrap[0]) && /top: 0/.test(wrap[0]),
       '  └ 绝对定位 + 贴顶（不进 flex 流 ⇒ 不挤动任何页面的布局）');
  }
}

console.log('\n--- settings/content.js ---');
{
  /* ⚠⚠⚠ 2026-10-21 用户：「将app的设置页面的排盘引擎 晚子时 数据与隐私 清除本机缓存
     无限滚动（仿制）和页面 开源组件。这些移除不要。设置页面这些东西很多余。」
     ⇒ 三张说明卡 + 清除本机缓存 + 开源组件 + 仿制页入口**全部删除**。
     下面这几条就是那道闸：谁把它们加回来，这里必须红。 */
  eq(settingsContent.NOTES, undefined, '⚠ 三张说明卡（排盘引擎 / 晚子时 / 数据与隐私）已删除');
  eq(settingsContent.CLEAR_BODY, undefined, '⚠ 「清除本机缓存」的文案已删除');
  eq(settingsContent.CLEAR_TITLE, undefined, '⚠ 清缓存的标题也删了（不留半个入口）');
  eq(settingsContent.INFO_ROWS.length, 1, '⚠ 信息行只剩「版本」（「开源组件」那一行已删）');
  eq(settingsContent.INFO_ROWS[0].label, '版本', '剩下的那一行是版本');
  ok(
    !settingsContent.INFO_ROWS.some((r) => /开源组件|tyme/.test(r.label + r.value)),
    '⚠ 信息行里不许再出现「开源组件」/ tyme'
  );
  eq(settingsContent.VERSION, '1.0.0', '版本号');
  eq(settingsContent.FOOTER, '本工具仅用于传统历法文化学习，不构成任何建议', '页脚逐字一致');

  /* ⚠ 光删数据不够：页面里也可能留着一句渲染 —— 两处都断言。
     ⚠⚠ 必须**先剥注释**再比对：这个文件的墓碑注释里写着「清除本机缓存 / 无限滚动 /
        InfiniteTop」这些词（说明为什么删），不剥就是自己把自己的断言弄红。 */
  const settingsRaw = require('fs').readFileSync(
    path.join(ROOT, 'src', 'screens', 'settings', 'Settings.tsx'), 'utf8');
  const settingsSrc = settingsRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/content\.NOTES/.test(settingsSrc), '⚠ Settings.tsx 不再渲染 NOTES');
  ok(!/清除本机缓存/.test(settingsSrc), '⚠ Settings.tsx 里不再有「清除本机缓存」这一行');
  ok(!/无限滚动/.test(settingsSrc), '⚠ Settings.tsx 里不再有「无限滚动（仿制）」入口');
  ok(!/InfiniteTop/.test(settingsSrc), '⚠ 也不再引用那个仿制页');
  /* 剩下的必须还在：账号 / 版本 / 页脚 —— 别清过头把整页清空了 */
  ok(/content\.INFO_ROWS\.forEach/.test(settingsSrc), '版本行还在（INFO_ROWS 仍被渲染）');
  ok(/onOpenLogin/.test(settingsSrc) && /onLogout/.test(settingsSrc), '账号区两个入口都还在');

  /*
   * 服务器地址入口（2026-11-13）—— 它**不是**那批被删掉的说明卡：
   * 地址改到运行时之后，这是手机上改地址的**唯一**入口，删了就只剩重打包。
   * ⚠ 断言必须认「有输入框 + 有保存」，只认一个常量名是拦不住误删的。
   */
  ok(/content\.SERVER_LABEL/.test(settingsSrc), '⚠ 设置页有「服务器地址」那一行');
  ok(/<TextInput/.test(settingsSrc) && /serverAddr\.save\(/.test(settingsSrc),
    '⚠⚠ 服务器地址有输入框且真的调了保存（不是只有一行文案）');

  /* 账号那一区的文案：未登录 / 已登录两个入口，以及退出的二次确认 */
  eq(settingsContent.LOGIN_ACTION, '登录', '未登录时那一行显示「登录」');
  eq(settingsContent.LOGGED_ACTION, '退出登录', '已登录时给「退出登录」');
  eq(settingsContent.ACCOUNT_LABEL, '账号', '账号行的标签');
  eq(settingsContent.LOGOUT_TITLE, '退出登录', '退出登录的确认弹窗标题');
  ok(/不会.*删除/.test(settingsContent.LOGOUT_BODY), '⚠ 退出确认必须说清「云端记录不会被删」（否则用户不敢点）');
  ok(/重新.*登录/.test(settingsContent.LOGOUT_BODY), '退出的说明点明「要重新登录才能看到记录」');
}

/* ================================================================
 * 五之二、登录页（login/model.js + login/content.js）
 * ================================================================
 * ⚠ 这一页的难点全在「两个输入的清洗」与「登录按钮什么时候禁用」上 ——
 *   它们被埋在两个 TextInput 的 onChangeText 里时，只有上模拟器才能验。
 *   拆成纯函数后在这里逐条断言。
 *
 * ⚠⚠ 2026-10-02 登录方式从「手机号 + 短信验证码」换成**账号 + 密码**，
 *   这一整段是**重写**的（旧断言测的是 phoneInput / codeInput / countdownLabel /
 *   发码按钮 / isUser 分流，那些函数已经删掉了）。别只删掉跑得红的几条就算完 ——
 *   漏掉的部分等于「换了一套登录方式，但没人守」。
 */
console.log('\n--- login/model.js ---');
{
  /* --- 账号清洗：三类真实输入都要归一 --- */
  eq(loginModel.usernameInput('  zhangsan01  '), 'zhangsan01', '首尾空格要去掉');
  eq(loginModel.usernameInput('ZhangSan01'), 'zhangsan01', '⭐ 大写要转小写（服务端规则只认小写）');
  eq(loginModel.usernameInput('ZHANG_SAN-01'), 'zhang_san-01', '全大写 + _ - 也要归一');
  eq(loginModel.usernameInput(null), '', 'null 不崩');
  eq(loginModel.usernameInput(undefined), '', 'undefined 不崩');
  eq(loginModel.usernameInput('中文账号'), '中文账号', '⚠ 清洗只做归一，不负责合法性（合法与否由 isUsername 判）');

  /* ⚠⚠ 「超长」绝不能被**悄悄截断**成看似合法的值 —— 那样用户会以为能登进去。
     截断只防「误粘贴一整篇文章」，所以上限必须明显大于业务上限（25）。 */
  ok(loginModel.INPUT_MAX > 25, '⚠ 防呆上限明显大于业务上限（否则超长会被截成合法值）',
    'INPUT_MAX=' + loginModel.INPUT_MAX);
  const longIn = 'a' + new Array(30).join('b');       // 30 位，超过业务上限 25
  eq(loginModel.usernameInput(longIn), longIn, '⚠ 超长不截断');
  eq(loginModel.usernameHint(longIn), loginContent.HINT_USERNAME_LONG, '  └ 而是走到「最多 25 位」那条提示');

  /* --- 密码清洗：**只限长，绝不 trim** --- */
  eq(loginModel.passwordInput(' a b  '), ' a b  ', '⚠⚠ 密码不许 trim（首尾空格是真密码的一部分）');
  eq(loginModel.passwordInput('AbC!@#'), 'AbC!@#', '⚠ 密码不许改大小写、不许过滤字符');
  eq(loginModel.passwordInput(null), '', 'null 不崩');
  eq(loginModel.passwordInput(new Array(201).join('x')).length, loginModel.INPUT_MAX, '密码也有防呆上限');

  /* --- 合法性：规则**只问 cbsdk**（前端不许再写一份正则） --- */
  ok(loginModel.isUsername('zhangsan01'), '合法的账号通过');
  ok(!loginModel.isUsername('1zhangsan'), '⚠ 数字开头要拒（服务端正则要求首字符是字母）');
  ok(!loginModel.isUsername('zhang.san'), '⚠ 点号要拒（文档说允许，实测不允许）');
  ok(!loginModel.isUsername('zhang'), '太短要拒');
  ok(!loginModel.isUsername(''), '空要拒');

  /* --- 账号框下面的实时提示：三档分开说，而且**空输入不报错** --- */
  eq(loginModel.usernameHint(''), '', '⚠⚠ 空输入不飘红（刚进页面就报错最讨嫌）');
  eq(loginModel.usernameHint('  '), '', '  └ 只有空格也算「还没输」');
  eq(loginModel.usernameHint('zhang'), loginContent.HINT_USERNAME_SHORT, '太短 → 说「至少 6 位」');
  eq(loginModel.usernameHint('zhang.san'), loginContent.HINT_USERNAME_CHARS,
     '⚠ 字符不对 → 说清「只能用字母数字 - _，且以字母开头」');
  eq(loginModel.usernameHint('zhangsan01'), '', '合法 → 返回空串（别返回一句「格式正确」）');

  /* --- 登录按钮 --- */
  eq(loginModel.submitStateOf({ username: '', password: 'pw-123456' }).disabled, true, '没填账号 → 不能登录');
  eq(loginModel.submitStateOf({ username: 'zhang', password: 'pw-123456' }).disabled, true, '账号格式不合法 → 不能登录');
  eq(loginModel.submitStateOf({ username: 'zhangsan01', password: '' }).disabled, true, '没填密码 → 不能登录');
  eq(loginModel.submitStateOf({ username: 'zhangsan01', password: 'pw-123456' }).disabled, false, '都填对了 → 可登录');
  eq(loginModel.submitStateOf({ username: 'zhangsan01', password: 'pw-123456' }).label,
     loginContent.SUBMIT, '可登录时按钮就是「登录」');
  eq(loginModel.submitStateOf({ username: 'zhangsan01', password: 'pw-123456', submitting: true }).label,
     loginContent.SUBMIT_BUSY, '提交中显示「登录中…」');
  /* ⚠ done 压过 submitting：成功后按钮必须停在「登录成功」，不能回弹成「登录」 */
  eq(loginModel.submitStateOf({ username: 'zhangsan01', password: 'pw-123456', submitting: true, done: true }).label,
     loginContent.SUBMIT_DONE, '⚠ 已成功就锁在「登录成功」（别再让人点）');
  eq(loginModel.submitStateOf(null).disabled, true, '什么都不传时不崩、也不给点');

  /* --- 结果映射 --- */
  const l1 = loginModel.resultOf({ ok: true, session: { cloudbaseUid: 'x' } }, loginModel.MODE_LOGIN);
  eq(l1.ok, true, '登录成功');
  eq(l1.error, undefined, '  └ 成功时不带 error（界面据此不显示红字）');
  ok(!loginModel.resultOf(null, loginModel.MODE_LOGIN).ok, '登录结果整个没了 → 失败');
  ok(/[\u4e00-\u9fa5]/.test(loginModel.resultOf(null, loginModel.MODE_LOGIN).error), '登录失败兜底文案是中文');
  eq(loginModel.resultOf({ ok: false, error: '用户名或密码不对，请重新输入' }, loginModel.MODE_LOGIN).error,
     '用户名或密码不对，请重新输入', '服务端（已翻成中文的）错误原样带出');
  ok(/[\u4e00-\u9fa5]/.test(loginModel.resultOf({ ok: false }, loginModel.MODE_LOGIN).error),
     '连 error 都没有时给中文兜底');
  /* ⚠ 两个形态的兜底句**必须不同**：注册失败时说「登录失败」会让用户以为点错了按钮 */
  eq(loginModel.resultOf({ ok: false }, loginModel.MODE_SIGNUP).error, loginContent.SIGNUP_FAIL,
     '注册态的兜底句与登录态不同（说「注册失败」）');
  neq(loginContent.SIGNUP_FAIL, loginContent.LOGIN_FAIL, '  └ 这两句真的不一样');

  /* ================================================================
   * ⭐ 注册态（MODE_SIGNUP）—— 2026-10-03 接本地后端时新增
   * ================================================================
   * ⚠⚠ 登录 / 注册的规则**刻意不同**，别用同一套断言跑两遍：
   *   · 登录：密码长度**不校验** —— 它是既有事实，加「至少 6 位」会把
   *     早期用短密码注册的老账号**永久锁在门外**，而报的是「密码太短」（前端拦的）。
   *   · 注册：必须校验长度、且**两次一致** —— 不校验就会白撞一次服务端 400。
   * 下面两组断言就是钉住这个差异的。
   */

  /* --- 密码长度：只在注册态判 --- */
  ok(!loginModel.passwordLongEnough('12345'), '5 位密码不够长');
  ok(loginModel.passwordLongEnough('123456'), '6 位够长（服务端 PASSWORD_MIN=6）');
  /* ⚠⚠ 登录态：密码再短按钮也该能点 —— 见上面那段说明 */
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_LOGIN, username: 'zhangsan01', password: '1' }).disabled,
     false, '⚠⚠ 登录态不校验密码长度（短密码的老账号必须还能登）');
  /* ⚠ 反向对照：同一个短密码，注册态必须被拦住。少了这条，「两边都不校验」也会绿。 */
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_SIGNUP, username: 'zhangsan01', password: '1', confirm: '1' }).disabled,
     true, '  └ 但注册态必须拦住它（否则用户提交后才被服务端 400 拒）');

  /* --- 两次密码一致：只在注册态判 --- */
  ok(loginModel.passwordConfirmed('pw123456', 'pw123456'), '两次一样 → true');
  ok(!loginModel.passwordConfirmed('pw123456', 'pw123457'), '差一位 → false');
  ok(!loginModel.passwordConfirmed('pw123456', ''), '确认框空着 → false');
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_SIGNUP, username: 'zhangsan01', password: 'pw-123456', confirm: 'pw-12345' }).disabled,
     true, '⚠ 注册：两次不一致 → 不能提交（否则白填一遍）');
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_SIGNUP, username: 'zhangsan01', password: 'pw-123456', confirm: 'pw-123456' }).disabled,
     false, '注册：都对了 → 可提交');

  /* --- 注册态的按钮文案 --- */
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_SIGNUP, username: 'zhangsan01', password: 'pw-123456', confirm: 'pw-123456' }).label,
     loginContent.SUBMIT_SIGNUP, '注册态按钮是「注册」');
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_SIGNUP, username: 'zhangsan01', password: 'pw-123456', confirm: 'pw-123456', submitting: true }).label,
     loginContent.SUBMIT_SIGNUP_BUSY, '注册中显示「注册中…」');
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_SIGNUP, username: 'zhangsan01', password: 'pw-123456', confirm: 'pw-123456', done: true }).label,
     loginContent.SUBMIT_SIGNUP_DONE, '⚠ 注册成功锁在「注册成功」');
  /* ⚠⚠ 注册态连点**必须**被拦住：第二次会撞服务端的重名检查（409），
     用户看到「用户名已被占用」——而那正是他自己刚注册的。 */
  eq(loginModel.submitStateOf({ mode: loginModel.MODE_SIGNUP, username: 'zhangsan01', password: 'pw-123456', confirm: 'pw-123456', submitting: true }).disabled,
     true, '⚠⚠ 注册提交中必须禁用（连点会撞自己刚建的号 → 409 重名）');

  /* --- 密码提示：注册态才给，且空输入不报错 --- */
  eq(loginModel.passwordHint(loginModel.MODE_LOGIN, '1', ''), '', '⚠⚠ 登录态**永远**不给密码提示（长度是既有事实）');
  eq(loginModel.passwordHint(loginModel.MODE_SIGNUP, '', ''), '', '注册态空密码不飘红（还没输）');
  eq(loginModel.passwordHint(loginModel.MODE_SIGNUP, '123', ''), loginContent.HINT_PASSWORD_SHORT, '注册：太短 → 说「至少 6 位」');
  eq(loginModel.passwordHint(loginModel.MODE_SIGNUP, 'pw-123456', ''), '', '⚠ 确认框还没输时不报「不一致」');
  eq(loginModel.passwordHint(loginModel.MODE_SIGNUP, 'pw-123456', 'pw-12345'), loginContent.HINT_CONFIRM_MISMATCH,
     '注册：两次不一致 → 实时提示（不等提交）');
  eq(loginModel.passwordHint(loginModel.MODE_SIGNUP, 'pw-123456', 'pw-123456'), '', '注册：都对 → 空串');

  /* --- 切换形态要清掉的东西 --- */
  const sw = loginModel.switchState(loginModel.MODE_SIGNUP);
  eq(sw.mode, loginModel.MODE_SIGNUP, '切到注册态');
  eq(sw.password, '', '⚠ 切形态必须清密码（上一形态的密码多半是错的，别带进注册）');
  eq(sw.confirm, '', '确认框也清');
  eq(sw.error, '', '⚠⚠ 必须清错误提示 —— 不清的话用户刚点切换就看到「用户名或密码不对」，以为这次也失败了');
  eq(sw.done, false, 'done 复位（否则按钮停在「登录成功」切不过去）');
  eq(loginModel.switchState('乱传的值').mode, loginModel.MODE_LOGIN, '⚠ 非法值兜底到登录态（不给未定义状态）');
}

console.log('\n--- login/content.js ---');
{
  eq(loginContent.TITLE, '登录', '导航栏标题是「登录」');
  eq(loginContent.HEAD_TITLE, '账号登录', '页头标题（与登录方式对得上）');
  ok(/换手机|重装/.test(loginContent.HEAD_SUB), '页头说明登录的好处（换机 / 重装不丢记录）');
  eq(loginContent.USERNAME_LABEL, '账号', '账号行标签');
  eq(loginContent.PASSWORD_LABEL, '密码', '密码行标签');
  eq(loginContent.SUBMIT, '登录', '提交按钮文案');
  eq(loginContent.SUBMIT_DONE, '登录成功', '成功那一刻的按钮文案');
  eq(loginContent.FOOTER, settingsContent.FOOTER, '登录页与设置页的页脚一致');

  /* ⚠⚠ 本页**有注册入口，但只在本地后端那条路**（CloudBase 对用户名密码自助注册回 501）。
     所以两套文案都必须存在，而且**互相排斥** —— 见下面两条。 */
  ok(/管理员/.test(loginContent.NO_SIGNUP_TIP), '⚠ 必须写明「账号由管理员创建」');
  ok(/注册/.test(loginContent.NO_SIGNUP_TIP), '  └ 且说得出「不支持自助注册」');

  /* ⭐ 注册态文案（2026-10-03 接本地后端时新增）—— 这几条一个都不能少：
     少了占位提示，用户会拿 3 位密码撞一次 400；少了切换文案，他找不到回来的路。 */
  eq(loginContent.HEAD_TITLE_SIGNUP, '注册新账号', '注册态页头标题');
  ok(/字母开头|6~25/.test(loginContent.USERNAME_PLACEHOLDER_SIGNUP),
     '注册态账号框占位写明规则（省得提交后才被拒）');
  ok(/6/.test(loginContent.PASSWORD_PLACEHOLDER_SIGNUP),
     '⚠⚠ 注册态密码框占位必须写出最短长度（否则用户会拿 3 位密码撞 400）');
  eq(loginContent.CONFIRM_LABEL, '确认密码', '确认密码行标签');
  eq(loginContent.SUBMIT_SIGNUP, '注册', '注册按钮文案');
  ok(/注册/.test(loginContent.SUBMIT_SIGNUP_DONE), '注册成功的按钮文案说的是「注册成功」不是「登录成功」');
  ok(/注册/.test(loginContent.TO_SIGNUP_TIP), '「去注册」这句要提注册');
  ok(/登录/.test(loginContent.TO_LOGIN_TIP), '「去登录」这句要提登录');
  /* ⚠⚠ 两句兜底必须**不同**：注册失败时说「登录失败」，用户会以为点错了按钮。 */
  neq(loginContent.SIGNUP_FAIL, loginContent.LOGIN_FAIL, '⚠ 注册兜底句与登录兜底句不同');
  /* ⚠⚠ 互斥规则：底部「账号由管理员创建」只在**不能注册**时显示。
     这两句若同时为真，用户会看到「去注册」和「不支持自助注册」打架。 */
  ok(!/管理员/.test(loginContent.TO_SIGNUP_TIP) && !/管理员/.test(loginContent.TO_LOGIN_TIP),
     '⚠⚠ 切换提示里不能混进「账号由管理员创建」（与注册入口互斥）');

  /* ⚠⚠ 这一页是本轮改口径的**主战场**：登录方式已经换成账号密码，
     文案里再出现「手机号 / 验证码」就是在告诉用户去走一个不存在的入口。 */
  ok(!/手机号|验证码/.test(JSON.stringify(loginContent)),
     '⚠⚠ 文案里不许再出现「手机号 / 验证码」（登录方式已换，留着就是撒谎）');
  /* ⚠ 本 App 没有用户协议 / 隐私政策页面。写一句「登录即表示同意…」而点不开，比不写更糟。 */
  ok(!/用户协议|隐私政策/.test(JSON.stringify(loginContent)), '⚠ 不写点不开的协议链接');
}

/* ================================================================
 * 五、交叉一致性：五个页面 model 的约定必须彼此对得上
 * ================================================================ */
console.log('\n--- 交叉一致性 ---');
{
  /* 记录页交给结果页的那份，必须能直接被 result 的 loadPlanOf 认成 hydrate */
  const item = recordsModel.withSummary({ ...LIGHT, notes: { 'dayun:d0': { text: '甲' } } });
  const handoff = recordsModel.toHandoff(item);
  const plan = resultModel.loadPlanOf(handoff, null, false);
  eq(plan.action, 'hydrate', '记录页 → 结果页：handoff 被认成待重排的轻记录');
  eq(plan.rec.notes['dayun:d0'].text, '甲', '⚠ 这条路上 notes 不能丢（否则「点开一条」是空的）');

  /* 排盘页排完盘放总线 → 结果页认成 full */
  const created = recordLib.create('测试', 1, '1990-01-01', '11:04');
  eq(resultModel.loadPlanOf(created, null, false).action, 'full', '排盘页 → 结果页：完整盘被认成 full');

  /* 结果页写的事件，notes.js 的时间线能读出来（标题用 titleOf，与弹窗同一份）
     ⚠⚠ 2026-10-21 用户：「事件记录也只显示流年的就行了」⇒ 时间线**只剩流年**：
       大运 / 流月写进去也不显示（历史数据里的 `liuyue:` 键同样只丢不显示）。 */
  const w = resultModel.noteItemOf({}, { key: 'liunian:d0:3', text: '换工作', meta: { year: 1998, ganzhi: '乙亥', age: 9 } });
  eq(notesLib.timeline(w.notes).length, 1, '写一条流年事件 → 时间线出一条');
  ok(/【流年】/.test(notesLib.timeline(w.notes)[0].title), '时间线标题带层级名');
  ok(/乙亥/.test(notesLib.timeline(w.notes)[0].title), '时间线标题用得上刚快照的元信息');
  eq(notesLib.timeline(w.notes)[0].text, '换工作', '时间线正文');

  const wd = resultModel.noteItemOf(w.notes, { key: 'dayun:d0', text: '搬家', meta: { year: 1990, ganzhi: '庚午', age: 1 } });
  const wl = resultModel.noteItemOf(wd.notes, { key: 'liuyue:d0:3:5', text: '出差', meta: { year: 1998, ganzhi: '戊午', age: 9 } });
  eq(notesLib.timeline(wl.notes).length, 1,
    '⚠⚠⚠ 大运 / 流月写了也**不进**时间线（只留流年）—— 它们是老功能的残留数据，只丢不显示');
  eq(notesLib.timeline(wl.notes).filter((r) => r.level !== 'liunian').length, 0,
    '⚠ 时间线里不许出现 dayun / liuyue 行');
  eq(notesLib.timeline(wl.notes)[0].text, '换工作',
    '只剩那条流年（大运、流月都被过滤掉）；⚠ 读记录时不用删库里的键');
}

/* ================================================================
 * 六、结果页的生命周期契约（源码级结构断言）
 * ================================================================
 * ⚠⚠ 这是本文件里**唯一**一类「读源码而不是跑行为」的断言，原因是：
 *   它防的 bug 在 model 层是**看不见**的 —— model 的两道短路完全正确，
 *   错的是「谁在什么时候调 clear()」。纯 Node 跑 model 永远跑不出这个错。
 *
 * 踩过的坑（已修）：Result.tsx 曾经把 chartBus.clear() 写在 [entry, load]
 * 那个 effect 的 cleanup 里。React 的 cleanup 在**依赖变化时也会跑**，而
 * entry 变化恰好就是「有一份新盘投进来了」——于是 cleanup 抢在 load() 之前
 * 把新盘清掉，load() 拿 null、短路①兜成 'keep'，**界面静默停在上一份盘上**
 * （不是空态，是显示错的盘，最坏的一种）。
 * 小程序那边 onUnload 只在页面真销毁时触发，照搬语义就会踩这个坑。
 *
 * 契约：clear() 必须挂在**空依赖**的 effect 里（= 只在真卸载时跑），
 *       不能跟 [entry, …] 那个 effect 共用 cleanup。
 */
console.log('\n--- 结果页生命周期契约（源码级） ---');
{
  const fs = require('fs');

  /**
   * ⚠ 断言前必须去注释：本文件里到处是「以前的写法长这样」这类说明，
   *   不去掉就会把注释里的 chartBus.clear() 当真实调用数出来（假红）。
   *   与路径审计同一个坑同一个修法。
   */
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/(^|[^:])\/\/.*$/gm, '$1');   // 行注释（避开 http:// 这类）
  }

  const resultSrc = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/screens/result/Result.tsx'), 'utf8')
  );

  /**
   * 抓出所有 useEffect，支持两种写法：
   *   useEffect(() => { ... }, [deps])        —— 块体
   *   useEffect(() => () => { ... }, [deps])  —— 简洁式，直接 return cleanup
   * 匹配到「useEffect(」之后的第一个「, [ ... ])」为止。
   */
  const effects = resultSrc.match(/useEffect\(\s*\(\)\s*=>[\s\S]*?,\s*\[[^\]]*\]\s*\)/g) || [];
  ok(effects.length >= 2, '结果页至少有两个 useEffect（load 一条、卸载作废一条）');
  ok(effects.length >= 1, '抓到了 effect 文本（正则没写歪）');

  /* ① [entry…] 那个 effect：不许有 cleanup，更不许碰 clear() */
  const entryEffects = effects.filter((e) => /\[\s*entry\b/.test(e));
  eq(entryEffects.length, 1, '恰好有一个 [entry…] 依赖的 effect（就是那个 load）');
  ok(
    !/return\s*\(\s*\)\s*=>/.test(entryEffects[0] || ''),
    '⚠⚠ [entry…] 的 effect **不许有 cleanup** —— 它会在 entry 变化时抢跑、把新盘清掉'
  );
  ok(
    !/chartBus\.clear\s*\(/.test(entryEffects[0] || ''),
    '⚠⚠ chartBus.clear() 绝不能出现在 [entry…] 这个 effect 里'
  );

  /* ② clear() 必须只出现在一个**空依赖** effect 的 cleanup 里 */
  const withClear = effects.filter((e) => /chartBus\.clear\s*\(/.test(e));
  eq(withClear.length, 1, '⚠ chartBus.clear() 只出现在**一个** effect 里（多一处就多一个误清时机）');
  ok(/\[\s*\]\s*\)\s*$/.test(withClear[0] || ''), '⚠ 那个 effect 必须是**空依赖 []**（= 只在真卸载时跑）');

  /* ③ 全文件只调一次 clear()（文案里提到不算，已去注释） */
  const clearCount = (resultSrc.match(/chartBus\.clear\s*\(/g) || []).length;
  eq(clearCount, 1, '⚠ chartBus.clear() 全文件**只出现一次**（多一处就多一个误清时机）');

  /* ④ chartBus.clear 不该出现在 App.tsx 里（作废是结果页自己的事，别两头都管） */
  const appSrc = stripComments(fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8'));
  ok(!/chartBus\.clear\s*\(/.test(appSrc), 'App.tsx 不碰 chartBus.clear()（归属唯一，避免两处各自清一遍）');

  /*
   * ⑤ 行为侧兜底：用最小 React 调度模拟，跑一遍「挂载 → 卸载 → 再挂载」
   *    以及「还没卸载时 entry 又变了」，确认新盘总能顶掉旧盘。
   *    （这模拟的是修好之后的 effect 声明形状，形状由 ①② 两条断言锁住。）
   */
  const bus = require(path.join(ROOT, 'src/core/chartBus.js'));
  function makeReact() {
    let effs = [];
    return {
      commit(next) {
        const prev = effs; const out = [];
        next.forEach((e, i) => {
          const p = prev[i];
          const changed = !p || e.deps.length !== p.deps.length || e.deps.some((d, j) => d !== p.deps[j]);
          if (changed && p && p.cleanup) p.cleanup();
          out.push({ deps: e.deps, cleanup: e.fn() });
        });
        effs = out;
      },
      unmount() { effs.forEach((e) => e.cleanup && e.cleanup()); effs = []; }
    };
  }
  let panel = { rec: null, hydrating: false };
  function loadOnce() {
    const plan = resultModel.loadPlanOf(bus.take(), panel.rec, panel.hydrating);
    if (plan.action === 'empty') panel = { rec: null, hydrating: false };
    if (plan.action === 'full') panel = { rec: plan.rec, hydrating: false };
    return plan;
  }
  const declare = (entry) => [
    { deps: [entry, 'load'], fn: () => { loadOnce(); } },                 // 无 cleanup
    { deps: [], fn: () => () => bus.clear() },                            // 只在卸载时作废
  ];

  bus.clear();
  const R = makeReact();
  bus.put({ id: 'A', chart: {} });
  R.commit(declare(1));
  eq(panel.rec && panel.rec.id, 'A', '首次进入：显示 A');

  R.unmount();
  eq(bus.peek(), null, '卸载后总线已作废（下次进入不会拿到残留的盘）');

  bus.put({ id: 'B', chart: {} });
  R.commit(declare(2));
  eq(panel.rec && panel.rec.id, 'B', '关掉再进：显示新盘 B（不是残留的 A）');

  /* ⚠ 这条是本次修复的正主：还没卸载时 entry 又变了 */
  bus.put({ id: 'C', chart: {} });
  R.commit(declare(3));
  eq(
    panel.rec && panel.rec.id,
    'C',
    '⚠⚠ entry 变化（组件仍挂着）时，新盘 C 必须顶掉 B —— 旧写法在这里会静默停在 B'
  );

  bus.clear();
}

/* ================================================================
 * 六点四点五、结果页「详细信息 → 标签」（★ 全 App **唯一**能换标签的地方）
 * ================================================================
 * ⚠⚠ 2026-10-05 用户定：记录页**列表卡片上的标签入口删掉**，换标签只在
 *   「排盘结果 → 详细信息 → 标签」里做，而且**只能换**（不能新建 / 改名 / 删除）。
 * ⚠ 这一组守的正是那个**去处**：入口删了之后，「换标签」必须真的有一个地方能做 ——
 *   上一轮就是栽在「功能在、但用户找不着」（标签栏当初要求「有标签才显示」）。
 *   ⇒ 四件事一起钉：① 那一行在详细信息里，且**没点「修改」时点不动**
 *        （2026-10-05 用户追加：「标签的修改要在修改按钮点击之后才能修改，
 *          不能分散。如果没有点击修改按钮那么就只是显示标签就行了」）；
 *     ② 打开的面板必须是 `mode='pick'`（能选、不给建/改名/删）；
 *     ③ tagId 从 handoff 带过来、变更后只改本页 state（记录行里根本没这个字段）；
 *     ④ 改完必须推 `history.bumpRev()`，否则记录页回来不重拉、列表上的标签不更新。
 */
console.log('\n--- 结果页「详细信息 → 标签」 ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const result = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/screens/result/Result.tsx'), 'utf8')
  );

  /* ① 那一行有两份，**只差在能不能点**（★ 2026-10-05 用户要求：
        「标签的修改要在修改按钮点击之后才能修改，不能分散。
          如果没有点击修改按钮那么就只是显示标签就行了」）：
          · 展示态 = 普通 View（只读，没有 `›`）
          · 修改态 = Pressable（点开选标签面板，带 `›`）
        ⚠ 上一版只有展示态那一份、而且是可点的 —— 那样「改标签」这个动作
          和「看标签」长在同一行上，谁都能一眼看到它点得动（= 分散）。 */
  {
    const n = (result.match(/<Text style=\{s\.infoLabel\}>标签<\/Text>/g) || []).length;
    ok(n === 2,
       '⚠ 详细信息里「标签」这一行有**且只有两份**（展示态 + 修改态各一）；' +
       '多一份就是入口又散出去了，少一份就有一态看不到标签');
  }
  ok(/\{canTags \? \(\s*<View style=\{s\.infoRow\}>/.test(result),
     '⚠⚠⚠ 展示态那一行是**普通 View**、点不动 —— 没点「修改」就只是显示标签；' +
     '这一行加回 onPress 就等于把入口又散出去了（用户明说「不能分散」）');
  ok(/\{canTags \? \(\s*<Pressable style=\{s\.infoRow\} onPress=\{onTagOpen\}/.test(result),
     '⚠⚠ 可点的那一份在**修改态**里（点开选标签面板）');
  ok((result.match(/onPress=\{onTagOpen\}/g) || []).length === 1,
     '⚠⚠⚠ `onPress={onTagOpen}` 全页只出现 **1** 次 —— 出现两次 = 又有一个没被「修改」按钮管住的入口');
    /* ⚠ 2026-10-21 起修改态有**两**枚 `›`：出生时间 + 标签（both 只在修改态里画）。
       判据仍是「**只出现在修改态**」—— 展示态画了它就是「看着能点、其实点不动」的假入口。 */
    ok((result.match(/<Text style=\{s\.infoTagArrow\}>›<\/Text>/g) || []).length === 2,
     '  └ `›` 只画在修改态（出生时间 + 标签各一枚）：展示态画了它 = 一个「看着能点、其实点不动」的假入口');
  ok(/canTags, tagName, onTagOpen,/.test(result),
     '  └ 修改态那块（EditBlock）要真收到 canTags / tagName / onTagOpen 三个 props');
  ok(/canTags=\{canTags\}[\s\S]{0,120}?onTagOpen=\{onTagOpen\}/.test(result),
     '⚠⚠⚠ 调用点必须把这三个**透传**下去 —— 少传一个，修改态那一行就永远不出现' +
     '（Props 收下了但没人给，是标准的静默失效）');
  ok(/\{tagName \|\| '未分类'\}/.test(result) && /tagName \? null : s\.infoValueEmpty/.test(result),
     '⚠ 两态都画「未分类」灰字（要改就按底部的「修改」）');
  ok(!/autoFocus/.test(result),
     '⚠⚠ 修改态两个输入框都**不许 autoFocus**（2026-10-05 用户要求）：点「修改」只是要改内容，' +
     '不代表要打字 —— 带 autoFocus 会当场弹键盘（与排盘页那种「就是要你输」的场景刻意相反）');

  /* ---- ★★ 2026-10-21 修改出生时间：排盘表单**封装复用**（用户：「排盘页面要封装，这就可以复用了」）----
     ⚠⚠⚠ 这两页必须是**同一个组件**：各写一份表单就是两个口径（今天加个「时辰未知」，
       明天只有一页有），而这种分叉一处都不报错。 */
  {
    const rd = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const formSrc = rd('src/components/PaipanForm.tsx');
    const paipanSrc = rd('src/screens/paipan/Paipan.tsx');
    ok(/export default function PaipanForm\(/.test(formSrc),
       '⚠⚠⚠ 排盘表单必须是**独立封装件** `components/PaipanForm.tsx`（导出 default）');
    ok(/import PaipanForm from '\.\.\/\.\.\/components\/PaipanForm'/.test(paipanSrc),
       '⚠ 排盘页用的是这个封装件（不再自己写一份表单）');
    ok(!/segItemActive|dtValueText|请选择四柱/.test(paipanSrc),
       '⚠⚠⚠ 排盘页**自己不许**再出现表单内部件（性别/历法分段、出生时间行、四柱提示）——' +
       ' 出现了就是把表单又抄回来了一份');
    ok(/import PaipanForm from '\.\.\/\.\.\/components\/PaipanForm'/.test(result),
       '⚠⚠ 结果页也引同一个封装件（「修改出生时间」用它）');
    ok(/<PaipanForm[\s\S]{0,500}?submitText="确定"/.test(result),
       '⚠⚠ 结果页那枚按钮是「确定」（**不是**「更新排盘」：这一刻既没排盘也没更新记录，' +
       '叫「更新排盘」是在承诺一件没发生的事 —— 用户 2026-10-21 指出）');
    ok(!/submitText="更新排盘"/.test(result),
       '⚠⚠⚠ 不许留「更新排盘」这个旧文案（与「只改草稿」的实际行为冲突）');
    ok(/<PaipanForm[\s\S]{0,900}?initial=\{\{/.test(result)
       && /gender: birth\.gender/.test(result) && /date: birth\.date/.test(result)
       && /time: birth\.time/.test(result),
       '⚠⚠⚠ 浮层必须**预填**这条记录现在的性别 / 公历日期 / 时间 —— 空着开局等于让用户重输一遍，' +
       '而且很容易把原来的时间覆盖成默认的 1990-01-01');
    ok(!/gender: panel\.rec/.test(result) && !/date: \(panel\.rec/.test(result),
       '⚠⚠ 预填读 `birth`（草稿优先）**不是** `panel.rec`：选完「确定」不保存、再点开这一行，' +
       '表单必须停在上次选的那一刻；读记录会「回退」成旧时间，用户以为自己白选了一遍');

    /* ⚠⚠⚠ 「确定」不写后端 ⇒ 那一行**必须**读草稿。踩过：只读 `panel.rec.dateText`，
       点完「确定」行上纹丝不动（记录还是旧值），整个功能看起来完全没生效。
       ⚠ 取数在纯函数 `model.birthOf` 里（那边断言算法），这里只断**接线**。 */
    ok(/const birth = useMemo\(\(\) => model\.birthOf\(panel\.rec, edit\), \[edit, panel\.rec\]\)/.test(result),
       '⚠⚠⚠ 那一行的取数走 `model.birthOf(rec, edit)`，依赖里**必须带 `edit`** —— ' +
       '漏了它「确定」之后不会重算（state 变了但 memo 不跑，是另一种「点完没反应」）');
    ok(/birthText=\{birth\.solar\}/.test(result) && /birthSub=\{birth\.sub\}/.test(result),
       '⚠⚠ 两段都透传下去：主行阳历+时刻、副行农历+性别');
    ok(/birthText, birthSub, onBirthOpen,/.test(result),
       '⚠⚠⚠ `EditBlock` 要收下 `birthSub` —— 只显示阳历的话，用户在排盘页改的**性别 / 农历**无处核对' +
       '（用户 2026-10-21：「除了阳历还要显示农历和性别，因为这些都是在排盘页面可以改到的数据」）');
    ok(/\{birthText \|\| '未填写'\}[\s\S]{0,200}?<Text style=\{s\.birthSub\}>\{birthSub\}<\/Text>/.test(result),
       '⚠ 副行（农历 · 性别）就画在主行下面；`未填写` 只兜主行');
    ok(/birthMain:|birthSub:/.test(result),
       '  └ 副行用小一档字号 / 浅一档颜色（它是顺带确认，不和主行抢）');
  }

  /* ---- ★★ 修改出生时间：入口 + 提交（⚠⚠⚠ 只改**草稿**，写库在「保存」那一下）----
     用户口径（原话）：「只是点更新排盘的话，只是选中性别和时间，不触及更改后端的数据」
     「只有点保存，才会更新排盘信息」。 */
  {
    ok(/<Pressable style=\{s\.infoRow\} onPress=\{onBirthOpen\} disabled=\{edit\.saving\}>/.test(result),
       '⚠⚠ 出生时间那一行**只在修改态**可点（展示态是普通 View —— 同「标签」那一行的纪律）');
    ok((result.match(/onPress=\{onBirthOpen\}/g) || []).length === 1,
       '⚠⚠⚠ `onPress={onBirthOpen}` 全页只出现 1 次（多一处就是绕开「修改」按钮的第二个入口）');
    ok(!/birthBusy/.test(result),
       '⚠⚠⚠ 不许再有 `birthBusy`：点了「更新排盘」**没有在飞的请求**，' +
       '留一个 busy 会让人以为它在写后端（而这正是被纠正的逻辑）');

    const body = /const onBirthCommit = useCallback\(\(v: any\) => \{([\s\S]*?)\n  \}, \[/.exec(result);
    ok(!!body, '找得到 onBirthCommit');
    ok(body && /setEdit\(\(e: any\) => model\.editPatch\(e, \{/.test(body[1]),
       '⚠⚠⚠ 「更新排盘」只把 gender/date/time 塞进 `edit` 草稿 —— 这一个动作就是它的全部职责');
    ok(body && !/history\.push/.test(body[1]),
       '⚠⚠⚠ 这里**不许** `history.push`：点了「更新排盘」不写后端（用户明确纠正过）');
    ok(body && !/mergePatch/.test(body[1]) && !/hydrate/.test(body[1]),
       '⚠⚠⚠ 这里也不许 mergePatch / hydrate：盘面重排属于「保存」，不在这条路上');
    ok(body && /setBirthOn\(false\)/.test(body[1]),
       '  └ 收下之后关浮层（选完了不该还杵在那儿）');
    ok(body && /点「保存」后生效/.test(body[1]),
       '⚠⚠⚠ 提示必须说出「点什么才生效」—— 只说「已更新」就是谎话：此刻后端一个字都没改');
    ok(body && /!\s*cur\.rec \|\| !cur\.saved/.test(body[1]),
       '  └ 未保存的盘没有 id，改了也没地方存 ⇒ 早退');

    /* ⚠⚠⚠ 反过来：**写库**必须落在「保存」那条老路上（`onEditCommit`），
       而且是一次 PUT 带齐姓名/职业/描述/出生三项 —— 不许为出生再开第二条写路径。 */
    const saveBody = /const onEditCommit = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(result);
    ok(!!saveBody, '找得到 onEditCommit（底部「保存」）');
    ok(saveBody && /model\.editCommit\(edit, rec\)/.test(saveBody[1]),
       '⚠⚠⚠ 出生三项的差异要由 `model.editCommit` 一起算出来（纯函数、有断言），' +
       '别在视图里再写一遍「哪些字段变了」');
    ok(saveBody && /model\.mergePatch\(rec, out\.patch\)/.test(saveBody[1]),
       '⚠⚠⚠ 走 `mergePatch` 出整条轻记录：姓名/职业/描述/notes/id/createdAt 全要原样带上，' +
       '漏一个就是把它抹掉（整行覆盖那条路的老坑）');
    ok(saveBody && /history\.push\(light\)/.test(saveBody[1]),
       '  └ 「保存」才真的 PUT 上去（出生时间的写库就在这一下）');
    ok(saveBody && /recordLib\.hydrate\(/.test(saveBody[1]),
       '⚠⚠⚠ 成功后必须 **hydrate 整条重排**：四柱 / 大运 / 流年 / 农历 / 生肖全是出生时间的派生，' +
       '只改 rec 上那几个键的话盘面还是旧的，而且一处都不报错');
    ok(saveBody && /if \(!Object\.keys\(out\.patch\)\.length\)/.test(saveBody[1]),
       '⚠ 什么都没变（含「选了但没换」的出生时间）⇒ 直接收摊（不发请求、不重排）');
  }

  /* ② 打开的面板必须是 `mode="pick"`（只能换 / 取消归类） */
  ok(/<TagPicker[\s\S]{0,400}?mode="pick"/.test(result),
     '⚠⚠⚠ 结果页的面板必须是 `mode="pick"` —— **只能换 / 取消归类**；' +
     '新建 / 改名 / 删除一律不在这条路上（用户原话：「只能更换标签，不能删除和改名标签」）');
  ok(/<TagPicker[\s\S]{0,400}?currentId=\{tagId\}/.test(result),
     '  └ 把这条记录**当前**的 tagId 交给面板（它据此标出「当前」那一格，' +
     '并把「未分类」那一格的右侧变成「取消归类」）');
  ok(/<TagPicker[\s\S]{0,700}?onPick=\{onTagPick\}/.test(result),
     '  └ 选中的结果交给 onTagPick（本页唯一的写入口）');
  ok(!/onCreate=\{|onRename=\{|onRemove=\{/.test(
       (/<TagPicker[\s\S]*?\/>/.exec(result) || [''])[0]),
     '⚠⚠⚠ 结果页**不传** onCreate / onRename / onRemove —— 传了就是给那条路留后门' +
     '（组件那一侧也藏了按钮：**两边都要挡**，只挡一边迟早被另一边放进来）');

  /* ③ 换标签：走 setFor、成功后只改本页的 tagId、顺手重拉标签列表 */
  {
    const pick = /const onTagPick = useCallback\(\(next: string \| null\) => \{([\s\S]*?)\}, \[([^\]]*)\]\)/.exec(result);
    ok(!!pick, '找得到 onTagPick');
    ok(pick && /tagsLib\.setFor\(chatRecId, want\)/.test(pick[1]),
       '⚠⚠ 走 core/tags.js 的 setFor（专用接口 PUT /records/:id/tag，**不是**整行 PUT）');
    ok(pick && /\(tagId \|\| null\) === want/.test(pick[1]),
       '⚠ 点的是这条**现在就在**的标签 ⇒ 不写不拉，只关窗（否则每次手滑点一下都白跑一次写请求）');
    ok(pick && /setTagId\(want\)/.test(pick[1]),
       '⚠⚠ 成功后改的是**本页这个 state** —— 记录行里根本没有 `tagId` 这个字段' +
       '（它是 GET /records 的只读派生字段），这里**没有**「改本地再重拉」那回事');
    ok(pick && !/setPanel|hydrate/.test(pick[1]),
       '  └ 不碰 `panel.rec`（换个标签不该把整份盘重排一遍）');
    ok(pick && /loadTags\(\)/.test(pick[1]),
       '  └ 重拉标签列表（`count` 变了：这条从「客户」挪到了「重点」）');
    /* ⚠⚠⚠ 2026-10-05 补：记录页**不会自己知道**标签变了。
       它的 onShow 闸门（model.shouldReload）只认 `history.rev()`，而归类走的是
       `PUT /records/:id/tag` —— 不在 push / saveNotes / drop / clear 那四个
       会 +1 的写操作里。不推的话：换完标签返回记录页，列表不重拉，
       卡片上那枚 chip 还是旧的（用户报障原话：「每条数据的标签也要显示出来」）。 */
    ok(pick && /history\.bumpRev\(\)/.test(pick[1]),
       '⚠⚠⚠ 归类成功后必须推一次 `history.bumpRev()` —— 不推，记录页回来时不重拉，' +
       '卡片上的标签就还停在归类之前（功能全是好的，就是「看不出来」）');
    ok(pick && /if \(!r\.ok\)[\s\S]*?return;[\s\S]*?history\.bumpRev\(\)/.test(pick[1]),
       '  └ 且必须落在**成功分支**里：失败时云端没变，推版本号只会让记录页白拉一次');
  }

  /* ①-b `bumpRev` 得真的导出来（Result 那边 require 的是 history 的导出表） */
  {
    const hist = stripComments(
      fs.readFileSync(path.join(ROOT, 'src/core/history.js'), 'utf8')
    );
    ok(/bumpRev: bumpRev/.test(hist),
       '⚠⚠ history.js 必须导出 `bumpRev` —— 没导出的话调用点就是 `undefined is not a function`，' +
       '而且是**点了标签才崩**（首屏十几张网都看不见，跑起来才知道）');
    ok(/function bumpRev\(\) \{\s*rev \+= 1;\s*\}/.test(hist),
       '  └ 它就是那一个 `rev += 1`，别在这里顺手加别的（它是为「少拉一次」而存在的）');
  }

  /* ④ tagId 的两个来源：记录页 handoff（带上来）+ 保存成功（服务端给的） */
  ok(/setTagId\(src && src\.tagId \? String\(src\.tagId\) : null\)/.test(result),
     '⚠⚠⚠ 从记录页进来时，标签跟着**这条记录**一起换 —— 不设它的话切到另一条记录时，' +
     '标签行会继续显示上一条的标签（一条会让人误操作的**假信息**）');
  ok(/setTagId\(hit && hit\.tagId \? String\(hit\.tagId\) : null\)/.test(result),
     '⚠ 保存成功后从服务端回来的那条取 tagId（刚存下的记录必然未分类，这里就是初始化点）');
  ok((result.match(/setTagId\(null\)/g) || []).length >= 2,
     '⚠ 换盘 / 空盘那两条早退路径也要把标签清掉（留着上一条的 id 就会显示别人的标签）');
  ok(/const canTags = store\.supportsTags\(\)/.test(result),
     '⚠ 能力判据来自 store.supportsTags()（与记录页同一个口径，别自己写 MODE === \'local\'）');

  /* ⑤ handoff 必须真的把 tagId 带过来（不带，上面那条 setTagId(src.tagId) 永远是 undefined） */
  const recModel = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/screens/records/model.js'), 'utf8')
  );
  ok(/function toHandoff\(item\) \{[\s\S]{0,500}?if \(item && item\.tagId\) out\.tagId = item\.tagId;/.test(recModel),
     '⚠⚠⚠ 记录页的 `toHandoff` 必须把 tagId 贴上 —— `record.toStorage()` 是**上云白名单**、不含它；' +
     '不贴的话结果页那一行永远显示「未分类」（而列表里明明挂着标签）');
  ok(/const out = record\.toStorage\(item\);/.test(recModel) && /if \(!out\) return null;/.test(recModel),
     '  └ 仍以 toStorage 为基础（出生信息不全时照旧返回 null —— 调用方那条早退不能被改坏）');
}


/* ================================================================
 * 六点五、事件编辑框 × 系统键盘（源码级）
 * ================================================================
 * ⚠ 2026-10-02 用户真机反馈：长按大运弹出编辑框、点输入框时
 *   ① 系统键盘把弹窗挡住了 —— 「确认 / 取消」正好在被压住的那半截，点不到；
 *   ② 没有任何入口能主动收键盘（多行输入的回车是换行，iOS 上系统不给「完成」）。
 *   查下来的根因还有个③：遮罩那层点一下 = 直接关框，所以用户「想收键盘」
 *   的那一下会连带把框关掉、**未保存的正文一起丢**。
 * 这里把这三条的修复形状锁住 —— 它们全是真机上才暴露的，纯函数断言盖不到。
 */
console.log('\n--- 事件编辑框 × 系统键盘 ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/screens/result/Result.tsx'), 'utf8')
  );

  /* ① 遮罩必须保持「纯遮罩」—— 让位是里面那层的事 */
  const maskBlock = (src.match(/mask:\s*\{[\s\S]*?\}/) || [''])[0];
  ok(!!maskBlock, '抓到了 mask 样式块（正则没写歪）');
  ok(!/padding/.test(maskBlock),
     '⚠⚠ mask 上不许有 padding —— 遮罩自己一让位，空出来的那块就漏出页面、遮罩破相');
  ok(!/justifyContent/.test(maskBlock), 'mask 不负责居中（居中交给避让层）');

  /* ② 避让层存在、撑满、居中，而且不吃触摸（⚠ 只负责「撑满 + 居中」，避让已收归全局） */
  const kavBlock = (src.match(/kav:\s*\{[\s\S]*?\}/) || [''])[0];
  ok(/flex:\s*1/.test(kavBlock) && /justifyContent:\s*'center'/.test(kavBlock),
     '避让层 flex:1 + 居中（撑满遮罩，弹框始终落在可见区域里）');
  ok(/pointerEvents="box-none"/.test(src),
     '⚠ 避让层是 box-none —— 它整层吃掉触摸的话，点空白收键盘就没反应了');

  /* ③ ⚠⚠⚠ 避让「收归全局」（2026-10-03 定案）：本页不再自己套 KeyboardAvoidingView。
     用户原话：「只要当键盘弹出都让 app 直接减去键盘的高度，避让。做一个整体的设计。」
     ⚠ 两层都避让 = 双重上移（小屏上框被顶出屏幕顶）。细则在下面的「六之四」。 */
  ok(!/KeyboardAvoidingView/.test(src),
     '⚠⚠⚠ 结果页不再自己避让（已收归根节点 components/KeyboardAvoid）—— 再叠一层就是双重上移');
  ok(/eaten/.test(src),
     '⚠ 结果页自己再减一次（它是 overlay，不占 App 里内容容器的高度）');

  /* ④ 键盘显隐必须真监听，且两个平台的事件名不同 */
  ok(/keyboardWillShow/.test(src) && /keyboardDidShow/.test(src),
     '⚠ iOS 用 willShow、安卓用 didShow —— 只写一套的话有一端永远收不到事件（且不报错）');
  ok(/Keyboard\.addListener\(\s*shownEvt/.test(src), '事件名走变量挑，不是写死一套');

  /* ⑤ 「收起键盘」入口（用户明确要的）—— 拆两条守，好定位是哪一半坏掉 */
  const kbBtnAt = src.indexOf('收起键盘');
  ok(kbBtnAt >= 0, '有「收起键盘」按钮（用户明确要的入口；iOS 多行输入没有别的路能收）');
  ok(/\{kbShown \? \([\s\S]{0,220}?收起键盘/.test(src),
     '⚠ 按钮只在键盘弹着时出现（不跟显隐走的话，平时白占标题行右侧）');
  ok(/Keyboard\.dismiss\(\)/.test(src), '按钮的动作是 Keyboard.dismiss()');

  /* ⑥ 点遮罩的语义只有一处，且必须走 model 的纯函数 */
  ok(/onPress=\{onMaskTap\}/.test(src),
     '⚠⚠ 遮罩那层挂的是 onMaskTap（两段式）；写回 onNoteClose 会让「想收键盘」变成「关框丢内容」');
  ok(/model\.maskTapAction\(/.test(src),
     '点遮罩走 model.maskTapAction —— 语义不在这里另写一遍（那边是纯函数，有断言守着）');

  /* ⑦ 关框就收键盘，别让键盘压着下面刚露出来的盘 */
  const closeBody = (src.match(/const onNoteClose = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/) || [''])[0];
  ok(!!closeBody, '抓到了 onNoteClose（正则没写歪）');
  ok(/Keyboard\.dismiss\(\)/.test(closeBody),
     '⚠ 关框时先收键盘（框没了、键盘还挂着，看起来像「点了一下什么都没发生」）');

  /* ⑧ 编辑框开着时接管安卓物理返回键（否则按返回会把整个结果页关掉，盘一起丢） */
  ok(/BackHandler\.addEventListener/.test(src),
     '⚠ 编辑框开着时接管物理返回键（不能让它走到「关结果页」那一步）');
  ok(/if \(!editor\.show\) return;/.test(src), '返回键只在框开着时才接管');
  ok(/hardwareBackPress'[\s\S]{0,160}?return true;/.test(src),
     '⚠⚠ 接管后必须 return true —— 返回 false 等于没接管，事件继续往下传，结果页照样被关掉');
}

/* ================================================================
 * 六之二、详细信息页的「修改 / 删除」（源码级）
 * ================================================================
 * ⚠ 这些是**必须留在视图层**的东西（纯函数断言盖不到）：
 *   ① 「时辰」那一行真的不在 JSX 里了（不能只在 model 里删掉、视图还抄一份）；
 *   ② ⚠⚠ 展示态**不可点**、必须按底部「修改」按钮才进修改态
 *      （用户原话：「增加一个修改按钮，点击才能进入修改姓名和描述的状态」）；
 *   ③ 修改态下姓名 / 职业 / 描述**同时**是输入框（一次改完一起保存）；
 *   ④ 「描述」那一栏**永远渲染**，空时显示灰字占位（用户要求）；
 *   ⑤ 删除要**键入随机数字**才能删（用户要求），且口令在动手那一刻再校验一次；
 *   ⑥ 改完 / 删完都不许把整条 hydrate 出来的 rec 直接 PUT（那会带上几百 KB 盘面）。
 */
console.log('\n--- 详细信息页：修改 / 删除（源码级） ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/screens/result/Result.tsx'), 'utf8')
  );

  /* ① 时辰行已从 JSX 消失 —— 取数在 model.detailRowsOf，视图只 map 它 */
  ok(!/'时辰'/.test(src), '⚠ 视图里不再有「时辰」这个标签（已并进公历/农历两行，去 model 看 detailRowsOf）');

  /* ② 「修改」按钮：展示态**不可点**，只有这颗按钮能进修改态 */
  ok(/s\.infoModifyBtn/.test(src), '⚠⚠ 详情页有「修改」按钮（用户要求：点击才能进入修改状态）');
  ok(/onPress=\{onEditStart\}/.test(src), '  └ 那颗按钮调 onEditStart');
  ok(/!edit\.on \? \(/.test(src), '⚠⚠「修改 / 删除」两颗按钮只在**展示态**显示（修改态下不该还在）');
  /* ⚠⚠ 反向也要守：展示态的行**不许**再挂 onPress（不然又变回「点一行改一行」） */
  {
    /* ⚠ 取展示态那一段：从 `infoRows.map(` 起，到它的收尾 `))}` 止
       （⚠⚠ 收尾是 **两个** 右括号 —— `}))` 而不是 `})`，写错就整段抓不到 ⇒ 断言恒绿） */
    const seg = /infoRows\.map\(\(row: any\) => \(([\s\S]*?)\n\s*\)\)\}/.exec(src);
    ok(!!seg, '找得到展示态那段 infoRows.map');
    ok(seg && !/onPress=/.test(seg[1]),
       '⚠⚠⚠ 展示态的字段行**不许挂 onPress**（用户要求改成「按修改按钮才进修改态」，'
       + '行本身还能点就等于那个按钮白加了）');
    ok(seg && !/editable/.test(seg[1]),
       '⚠ 展示态不该再出现 `editable` 那套「哪几行可点」的判断（整块进修改态了，没有单行可点这件事）');
  }

  /* ③ 修改态：姓名 + 职业 + 描述**同时**是输入框（一次改完一起保存） */
  ok(/value=\{edit\.name\}/.test(src), '⚠ 修改态的姓名输入框受控于 edit.name');
  ok(/onChangeText=\{onEditName\}/.test(src), '  └ 姓名输入框接了 onEditName');
  ok(/value=\{edit\.job\}/.test(src), '⚠⚠ 修改态的**职业输入框也在**（2026-10-06 新增字段）');
  ok(/onChangeText=\{onEditJob\}/.test(src), '  └ 职业输入框接了 onEditJob');
  /* ⚠ 职业是**单行**（别照抄描述那个 multiline）—— 取职业那一段的样式，确认没有 multiline */
  {
    const jobSeg = /value=\{edit\.job\}([\s\S]{0,320}?)\/>/.exec(src);
    ok(!!jobSeg, '找得到修改态的职业输入框那一段');
    ok(jobSeg && !/multiline/.test(jobSeg[1]), '⚠ 职业输入框**不是**多行（与描述的样式刻意相反）');
    ok(jobSeg && !/autoFocus/.test(jobSeg[1]),
       '⚠ 职业输入框也不给 autoFocus（点「修改」不该弹键盘，2026-10-05 那条纪律）');
  }
  ok(/value=\{edit\.desc\}/.test(src), '⚠⚠ 修改态的**描述输入框同时也在**（三个字段一次改完）');
  ok(/onChangeText=\{onEditDesc\}/.test(src), '  └ 描述输入框接了 onEditDesc');
  ok(/multiline[\s\S]{0,80}?textAlignVertical="top"/.test(src) || /textAlignVertical="top"/.test(src),
     '⚠ 描述用多行输入框、靠上对齐（只露一行看不清写了什么）');
  /* ⚠ 三个输入框必须**分列**、各有各的 handler —— 合成一个 onChangeText 就是把字段串了 */
  ok(/onChangeText=\{onEditName\}/.test(src)
     && /onChangeText=\{onEditJob\}/.test(src)
     && /onChangeText=\{onEditDesc\}/.test(src),
     '⚠⚠ 三个输入框**各有各的 onChangeText**（共用一个 handler ⇒ 打字串到别的字段去）');

  /* ④ 「描述」那一栏永远渲染（空时灰字占位） */
  ok(/row\.empty \? '未填写' : row\.value/.test(src),
     '⚠⚠ 描述为空时显示占位「未填写」（用户要求：空的也要显示这一栏）');
  ok(/row\.empty \? s\.infoValueEmpty : null/.test(src),
     '  └ 空描述用更淡的灰（一眼区分「没填」与「填了」）');

  /* ⑤ 删除：入口 + 二次确认 + 危险色 */
  ok(/onPress=\{onDeleteAsk\}/.test(src), '有「删除这条八字」入口');
  ok(/model\.deleteConfirmText\(/.test(src),
     '⚠ 删除确认的文案走 model.deleteConfirmText（标题带名字、正文说清「无法恢复」）');
  ok(/onPress=\{onDeleteDo\}/.test(src), '确认弹窗里那颗按钮才真删（onDeleteDo）');
  ok(/delBtnDanger/.test(src), '确认删除那颗按钮用危险色（跟金色主色区分开，防误触）');

  /* ⑤之二 ⚠⚠⚠ 随机数字口令（用户要求「弹出一个随机数字，用户输入后才能成功删除」） */
  ok(/model\.deleteCodeNew\(\)/.test(src), '⚠⚠⚠ 开窗时生成随机口令（model.deleteCodeNew）');
  ok(/setDelCode\(model\.deleteCodeNew\(\)\)/.test(src), '  └ 口令进 state（视图要把它显示出来）');
  ok(/s\.delCodeText/.test(src), '⚠ 口令**显示给用户看**（不显示就没法照着输入）');
  ok(/value=\{delInput\}/.test(src), '⚠ 输入框受控（才能在输错时把按钮画灰）');
  ok(/keyboardType="number-pad"/.test(src), '⚠ 数字键盘（这串是纯数字，弹全键盘是给人添麻烦）');
  ok(/disabled=\{delBusy \|\| !delGate\.ok\}/.test(src),
     '⚠⚠ 输入不对时「删除」按钮不可点（别让他点一下才被告知「数字不对」）');
  ok(/deleteCodeCheck\(delCode, delInput\)/.test(src),
     '⚠ 校验走 model.deleteCodeCheck（两侧都 trim —— 手机输入法容易带空格）');
  /*
   * ⚠⚠⚠ **口令必须在 onDeleteDo 里再校验一次**，不能只靠按钮 disabled：
   *   disabled 只是「视觉上不让点」，而这个回调还能被别的路径触发
   *   （回车提交 onSubmitEditing、将来的快捷键、自动化）——
   *   危险操作必须**在动手那一刻**自己确认前提。
   */
  ok(/onSubmitEditing=\{onDeleteDo\}/.test(src), '⚠ 回车也能提交删除（数字键盘那颗完成键）');
  {
    const doFn = /const onDeleteDo = useCallback\(\(\) => \{([\s\S]*?)\}, \[delBusy/.exec(src);
    ok(!!doFn, '找得到 onDeleteDo');
    ok(doFn && /deleteCodeCheck/.test(doFn[1]),
       '⚠⚠⚠ onDeleteDo **自己再校验一次口令**（disabled 只是视觉拦截；'
       + '回车提交能绕过它 ⇒ 必须在动手那一刻再确认）');
    ok(doFn && /history\.drop\(/.test(doFn[1]), '  └ 校验通过才真删');
  }
  /* ⚠ 每次开窗都要换新口令（复用旧码 = 一个被看过的口令留在那儿，还可能被盲打进去） */
  ok(/setDelInput\(''\)/.test(src), '⚠ 开窗 / 关窗清空输入（别把上次打了一半的数字留着）');

  /* ⑥ 改 / 删都走 history 那一层，且请求体是**轻记录** */
  ok(/model\.mergePatch\(/.test(src),
     '⚠ 改完先 mergePatch 出轻记录再 PUT（绝不把整条 hydrate 的 rec 直接传上去）');
  ok(/history\.push\(/.test(src) && /history\.drop\(/.test(src),
     '改写走 history.push、删除走 history.drop（与列表页共用同一份存储逻辑）');
}

/* ================================================================
 * 六之二点五、师傅批字页签（★ 2026-10-04）—— 源码结构 + model 纯逻辑
 * ================================================================
 * 「会话就是这条记录」：批字的锚点是 record.id，所以它与「事件记录」
 * 共用同一个 gateOf 闸门 —— 那道门一行都没改，也不该改。
 * 这一节钉三件最容易写错的事：
 *   ① 输入条必须是 ScrollView 的**兄弟**（套进滚动容器里会被挤没）
 *   ② 键盘避让（eaten）必须由**外层**承担（还压在 ScrollView 上的话，
 *      输入条会正好落在键盘底下被遮住）
 *   ③ 重试必须**沿用同一个消息 id**（换新的 = 又插一条，用户看到重复消息）
 */
{
  const fs = require('fs');
  function stripComments(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  const result = read('src/screens/result/Result.tsx');

  /* ---------- 六之二点五.1 输入条的位置与显隐 ---------- */
  const iScrollEnd = result.indexOf('</ScrollView>');
  const iComposer = result.indexOf('s.composerOn');
  ok(iScrollEnd > 0, '抓到了 ScrollView 的闭合（正则没写歪）', iScrollEnd);
  ok(
    iComposer > iScrollEnd,
    '⚠⚠ 输入条在 `</ScrollView>` **之后** —— 它是 ScrollView 的兄弟，不是子节点' +
      '（套进滚动容器里会被内容高度挤没，工具栏那次踩过同一个坑）',
    { scrollEnd: iScrollEnd, composer: iComposer }
  );
  ok(
    /composerOn:\s*\{\s*display:\s*'flex'\s*\}/.test(result),
    '⚠ 输入条用 display 切显隐（on = flex）'
  );
  ok(
    /composerOff:\s*\{\s*display:\s*'none'\s*\}/.test(result),
    '⚠⚠ 而且 off 是 display:none 而**不是条件渲染** —— 与四个面板同一条纪律'
  );
  ok(
    /activeTab === 'notes' && panel\.saved/.test(result),
    '⚠ 只在「批字页签 + 已保存」时露出来（未保存的八字没有 id，也就没有会话可挂）'
  );
  /* ⚠⚠⚠ 键盘**收起**时输入条要补底部安全区 —— 不补它就贴在屏幕最下沿、压在
     Home 指示条上（用户报「太靠下，很奇怪」）。
     ⚠ 弹起时**不能**补：那时外层已让位、容器底边正好贴在键盘顶边，再补多出一条缝。 */
  ok(
    /paddingBottom:\s*rpx\(16\)\s*\+\s*\(\s*eaten\s*>\s*0\s*\?\s*0\s*:\s*insets\.bottom\s*\)/.test(result),
    '⚠⚠⚠ 输入条 paddingBottom = 16 + (键盘弹着 ? 0 : 底部安全区) —— 收起时贴屏幕底是「太靠下」的根因'
  );
  ok(
    !/^[\s\S]*?composer:\s*\{[^}]*paddingBottom/m.test(result),
    '⚠⚠ composer 静态样式里不许再写死 paddingBottom（它随键盘在不在变，写死 = 两处真相打架）'
  );

  /* ---------- 六之二点五.2 键盘避让在外层 ---------- */
  ok(
    /backgroundColor:\s*COLORS\.bg,\s*marginBottom:\s*eaten/.test(result),
    '⚠⚠⚠ 键盘高度（eaten）压在最外层那个 View 上 —— 这样输入条才跟着一起上移'
  );
  ok(
    !/s\.scroll,\s*\{\s*marginBottom/.test(result),
    '⚠⚠ 而且半旧的写法（eaten 压在 ScrollView 上）必须已经删掉：' +
      '一旦两头都减，页面会凭空矮两倍'
  );

  /* ---------- 六之二点五.3 会话状态只走 model（不手拼） ---------- */
  ok(/commentsLib\.list\(/.test(result), '拉消息走 core/comments.js');
  ok(/commentsLib\.send\(/.test(result), '发消息走 core/comments.js');
  ok(
    /model\.chatAppend\(cur,\s*res\.comment\)/.test(result),
    '⚠ 发送成功后把返回的那条**并进列表**（走 model.chatAppend），不重拉整条会话'
  );
  ok(
    /model\.chatIdle\(\)/.test(result),
    '⚠ 初始态取自 model.chatIdle()（视图里自己拼 { list: [] } = chatAppend 的入参有两份定义）'
  );

  /* ---------- 六之二点五.3.5 ⚠⚠⚠ 求测单三态：发起求测 / 等接单 / 能聊 ---------- */
  /* 用户 2026-10-05 拍板：「App 上点击发起求测并不是发送一个聊天」——
     点它是**下一张单**（requests 一行），一个字都不写 comments。
     所以这一节钉的是三件事：① 发起真的不写消息 ② 三态由同一根判据分出
     ③ 「还没发起」与「读失败」不混。 */
  ok(
    /requestsLib\.create\(/.test(result),
    '⚠⚠⚠ 「发起求测」走 core/requests.js 的 create（下一张单），不是发消息'
  );
  ok(
    /requestsLib\.get\(/.test(result),
    '⚠ 单子状态也走 core/requests.js 的 get（与消息并行拉，见 onChatLoad）'
  );
  ok(
    !/chatPost\(\s*model\.CHAT_TEXT\.reqText/.test(result),
    '⚠⚠⚠ 发起求测**绝不再落一条求测消息**（旧的 `chatPost(reqText, false)` 必须已经删掉）'
  );
  ok(
    !/clearDraft/.test(result),
    '⚠⚠ 旧的双参数写法（chatPost(text, clearDraft)）必须已经不存在 —— 发起求测不再共用这条通道'
  );
  ok(
    /onPress=\{onChatRequest\}/.test(result),
    '⚠⚠⚠ 空态那颗按钮真的接了 onChatRequest（只画按钮不接线 = 点了没反应）'
  );

  /* ⚠⚠⚠ 三种形态必须由**同一个** chatPhase 分出（互斥的结构保证）——
     各自写一套条件，迟早出现「按钮和输入框同时在屏幕上」。 */
  ok(
    /const chatPhase = model\.chatPhase\(req\)/.test(result),
    '⚠⚠ 三个 phase 都来自同一个 model.chatPhase(req)（视图不自己拼判据）'
  );
  ok(
    /chatPhase === 'none'/.test(result),
    "⚠ 第 1 态用 `chatPhase === 'none'`（这个八字还没发起过求测 → 出那颗按钮）"
  );
  ok(
    /chatPhase === 'pending'/.test(result),
    "⚠⚠ 第 2 态用 `chatPhase === 'pending'`（单子递出、等师傅接单 → **没有输入框**）"
  );
  ok(
    /const chatStarted = chatPhase === 'taken'/.test(result),
    "⚠⚠ 输入条的 `chatStarted` 就是 `chatPhase === 'taken'`（一份判据两头用）"
  );
  ok(
    /activeTab === 'notes' && panel\.saved && chatStarted/.test(result),
    '⚠⚠⚠ 输入条露出条件必须带上「师傅已接单」—— 没接单时不该能对着还不存在的会话说话'
  );
  ok(
    !/state === 'ready' && chat\.list\.length === 0/.test(result),
    '⚠⚠ 出不出输入框/按钮**不许**用「列表空」当判据（那是消息游标的事，与单子无关，两份判据迟早漂）'
  );
  ok(
    /setChatDraft\(''\)/.test(result) && /chatPost\(chatDraft\)/.test(result),
    '⚠ 发送那条路走 chatPost(chatDraft)，成功后清草稿（发起求测不再进这条通道）'
  );

  /* ---------- 六之二点五.4 ⚠⚠⚠ 重试沿用同一个 id ---------- */
  ok(
    /chatRetryId\.current\s*=\s*res\.id/.test(result),
    '⚠⚠⚠ 发送失败时把用过的消息 id 记下来（没有它，重试只能换新 id）'
  );
  ok(
    /\{\s*id:\s*chatRetryId\.current\s*\}/.test(result),
    '⚠⚠⚠ 下一次发送把它传回去 —— 服务端靠同一个 id 做幂等（INSERT OR IGNORE）'
  );

  /* ---------- 六之二点五.5 effect 的依赖与短路 ---------- */
  const chatEffects =
    result.match(/useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\},\s*\[[^\]]*\]\s*\)/g) || [];
  /* ⚠⚠ 判据必须**同时**认 `activeTab`：2026-10-05 结果页多了一个「标签」effect，
     它的依赖里也有 `chatRecId`（同一条记录的 id）——只按 `chatRecId` 取 `[0]`
     会抓到那一个，这两条就变成「拿别人的代码验批字的行为」
     （实测：加完标签 effect 后它们当场变红，而批字本身一个字没动）。 */
  const loadEffect = chatEffects.filter((e) => /chatRecId/.test(e) && /activeTab/.test(e))[0] || '';
  ok(!!loadEffect, '抓到了批字那个 effect（依赖里有 chatRecId）');
  ok(
    /activeTab !== 'notes'/.test(loadEffect),
    '⚠ 只在切到批字页签时才拉（别的页签不该白发请求）'
  );
  ok(
    /chatRecRef\.current === chatRecId/.test(loadEffect),
    '⚠ 一条记录只拉一次：靠 chatRecRef 短路（切走再回来直接用已有那份）'
  );

  /* ================================================================
   * 六之二点五.6 model 的批字纯逻辑
   * ================================================================ */
  const NOW = new Date(2026, 9, 4, 20, 0).getTime(); /* 2026-10-04 20:00 本地 */

  /* 时间文案 */
  const today = new Date(2026, 9, 4, 15, 30).getTime();
  const other = new Date(2026, 8, 30, 9, 5).getTime();
  eq(resultModel.chatTimeOf(today, NOW), '15:30', '今天的消息只显示 HH:mm');
  eq(resultModel.chatTimeOf(other, NOW), '09-30 09:05', '跨天的补上 MM-DD（只给 HH:mm 会分不清是哪天）');
  eq(resultModel.chatTimeOf(0, NOW), '', '没有时间戳 → 空串（不显示 08:00 那类假时间）');

  /* 谁说的话 */
  eq(resultModel.chatMsgOf({ role: 'master' }, NOW).mine, false, '师傅的话在左边');
  eq(resultModel.chatMsgOf({ role: 'ask' }, NOW).mine, true, '我的话在右边');
  eq(
    resultModel.chatMsgOf({ role: 'system' }, NOW).role,
    'ask',
    '⚠ 不认识的 role 一律当 ask（往「自己说的」方向归一，绝不猜成师傅）'
  );

  /* 能不能发 */
  eq(resultModel.chatCanSend('   ').ok, false, '纯空白不能发');
  eq(resultModel.chatCanSend('  你好  ').text, '你好', '⚠ 发送前 trim（服务端也 trim，两边一致）');
  eq(resultModel.chatCanSend('你好').ok, true, '正常文本可发');

  /* 并进列表：去重 + 排序 + lastSeq */
  const a1 = resultModel.chatAppend(
    resultModel.chatIdle(),
    { id: 'm1', seq: 1, role: 'ask', text: '甲', createdAt: today },
    NOW
  );
  eq(a1.list.length, 1, '并进列表：一条');
  eq(a1.lastSeq, 1, '  └ lastSeq 跟着走');
  eq(a1.state, 'ready', '  └ 状态推到 ready');

  const a2 = resultModel.chatAppend(
    a1,
    { id: 'm1', seq: 1, role: 'ask', text: '甲（改过）', createdAt: today },
    NOW
  );
  eq(a2.list.length, 1, '⚠⚠ 同 id 只留一条（重试命中服务端已有那条时不能插成两条）');
  eq(a2.list[0].text, '甲（改过）', '  └ 内容是新的那份（幂等返回的是服务端的真值）');

  const a3 = resultModel.chatAppend(
    resultModel.chatAppend(
      resultModel.chatIdle(),
      { id: 'm2', seq: 2, role: 'master', text: '乙', createdAt: today },
      NOW
    ),
    { id: 'm1', seq: 1, role: 'ask', text: '甲', createdAt: today },
    NOW
  );
  eq(a3.list.map(function (x) { return x.seq; }).join(','), '1,2', '⚠ 并进来之后按 seq 升序（不按到达顺序）');

  /* 没有 id 的东西不进列表 */
  eq(
    resultModel.chatAppend(resultModel.chatIdle(), { text: '没有 id' }, NOW).list.length,
    0,
    '⚠ 没有 id 的消息不进列表（宁可少一条，也不要一条点不开的空消息）'
  );

  /* 拉取结果 → 状态 */
  const loaded = resultModel.chatLoaded(
    { ok: true, comments: [{ id: 'm1', seq: 1, role: 'ask', text: 'x', createdAt: today }], lastSeq: 1 },
    NOW
  );
  eq(loaded.state, 'ready', '拉成功 → ready');
  eq(loaded.list.length, 1, '  └ 消息进来了');
  const failed = resultModel.chatLoaded({ ok: false, error: '炸了' }, NOW);
  eq(failed.state, 'fail', '拉失败 → fail（不与「空会话」混在一起）');
  eq(failed.error, '炸了', '  └ 把服务端的中文原文带出来');
  eq(
    resultModel.chatLoaded({ ok: false }, NOW).error,
    resultModel.CHAT_TEXT.loadFail,
    '  └ 没有 error 字段时才用兜底文案'
  );

  /* ⚠⚠⚠ 三态判据 = **求测单的状态**（不是消息数）—— 2026-10-05 改的口径。
     用户的模型是三件分开的事：发起求测（出一张单）→ 师傅接单 → 才有会话。 */
  eq(resultModel.chatPhase(resultModel.reqIdle()), 'loading', '还没拉过 → loading（视图先判它）');
  eq(resultModel.chatPhase(resultModel.reqLoading()), 'loading', '正在拉 → loading');
  eq(
    resultModel.chatPhase(resultModel.reqLoaded({ ok: true, req: null })),
    'none',
    '⚠⚠⚠ 没这张单（ok:true + req:null）→ none，这才是「发起求测」按钮出现的那一刻'
  );
  eq(
    resultModel.chatPhase(resultModel.reqLoaded({ ok: true, req: { status: 'pending' } })),
    'pending',
    '⚠⚠ 有单子但没人接 → pending（出「等接单」，**没有输入框**）'
  );
  eq(
    resultModel.chatPhase(resultModel.reqLoaded({ ok: true, req: { status: 'taken' } })),
    'taken',
    '⚠⚠ 单子被接下 → taken（输入条这才出来）'
  );
  eq(
    resultModel.chatPhase(resultModel.reqLoaded({ ok: true, req: { status: '未来某种状态' } })),
    'pending',
    '⚠⚠ 没见过的状态值一律当 pending —— 默认方向选「还不能聊」，最坏只是少一个输入框'
  );
  eq(
    resultModel.chatPhase(resultModel.reqLoaded({ ok: false, error: '炸了' })),
    'fail',
    '读失败 → fail（视图要出「重试」，**不是**出「发起求测」）'
  );
  eq(resultModel.chatPhase(null), 'loading', '拿不到游标时按 loading 画（不炸，也不误画按钮）');

  /* ⚠⚠⚠ 「还没有单子」与「读失败」必须是两件事 ——
     把失败兜成 null，界面就会把「断网」显示成「你还没求测」，
     用户会去点那颗按钮、然后一脸茫然（而且会真的多出一张单）。 */
  eq(resultModel.reqLoaded({ ok: true }).state, 'ready', 'ok:true → ready');
  eq(resultModel.reqLoaded({ ok: true }).req, null, '  └ 但没有 req 字段 → null（判成 none）');
  eq(resultModel.reqLoaded({ ok: false }).state, 'fail', 'ok:false → fail（不与「没有单子」混）');
  eq(
    resultModel.reqLoaded({ ok: false }).error,
    resultModel.CHAT_TEXT.reqLoadFail,
    '  └ 服务端没给 error 时才用兜底文案'
  );
  eq(
    resultModel.reqLoaded({ ok: false, error: '单子没拉下来' }).error,
    '单子没拉下来',
    '  └ 有 error 就用服务端原文'
  );

  /* ⚠⚠ 能聊 = taken（输入条唯一的露出条件，也是那颗按钮的否定条件） */
  eq(
    resultModel.chatStarted(resultModel.reqLoaded({ ok: true, req: { status: 'taken' } })),
    true,
    'taken → 能聊'
  );
  eq(
    resultModel.chatStarted(resultModel.reqLoaded({ ok: true, req: { status: 'pending' } })),
    false,
    'pending → 不能聊（等接单）'
  );
  eq(resultModel.chatStarted(resultModel.reqIdle()), false, '还没拉 → 不能聊');
  eq(resultModel.chatStarted(null), false, '拿不到游标 → 不能聊（不炸）');

  /* 文案：三态各有话说，且都不为空 */
  ok(resultModel.CHAT_TEXT.empty.trim().length > 0, '第 1 态（还没求测）有说明');
  ok(resultModel.CHAT_TEXT.reqBtn.trim().length > 0, '空态按钮有字样');
  ok(resultModel.CHAT_TEXT.waiting.trim().length > 0, '第 2 态（等接单）有说明');
  ok(resultModel.CHAT_TEXT.takenEmpty.trim().length > 0, '第 3 态（已接单、还没说话）有提示');
  eq(
    resultModel.CHAT_TEXT.reqText,
    undefined,
    '⚠⚠⚠ 旧常量 `reqText` 必须已经删掉（它代表「发起求测 = 发一条消息」那个被否掉的模型）'
  );

  /* ---------- 六之二点五.7 ⚠⚠⚠ 跨端常量必须与 service 端同值 ---------- */
  /* ⚠⚠ 2026-10-05：消息的读写抽到 lib/commentStore.ts（唯一一份），
     TEXT_MAX 跟着搬了家 —— 这条断言必须跟着改，否则它会一直读不到、
     把「正则没写歪」那条先判红，看着像常量漂了。 */
  const apiSrc = String(
    fs.readFileSync(
      path.join(ROOT, '..', 'paipan-server', 'src', 'lib', 'commentStore.ts'),
      'utf8'
    )
  );
  const m = apiSrc.match(/const TEXT_MAX\s*=\s*(\d+)/);
  ok(!!m, '读到了服务端的 TEXT_MAX（正则没写歪）', m && m[1]);
  eq(
    Number(m && m[1]),
    resultModel.CHAT_INPUT_MAX,
    '⚠⚠⚠ 输入框上限 = 服务端 TEXT_MAX（跨端常量只能靠这条拴住：' +
      '输入框比服务端宽 ⇒ 用户「写完了才被拒」）'
  );
}

/* ================================================================
 * 六之三、保存前的小窗：姓名 / 描述 / ★标签（★ 用户要求）
 * ================================================================
 * 用户原话：「app 排盘页面的描述输入去掉，输入姓名也去掉。
 *            只有点击保存到记录的时候才出现」
 * ⇒ 排盘页不再收这两项，改由**点「保存到记录」时的小窗**去问。
 * 用户原话（2026-10-05 追加）：「点击保存到记录按钮，弹窗能不能同时有选择标签的功能」
 * ⇒ 同一刻也问标签。⚠ 但归类**不能在这一刻发**（记录还没有 id），
 *   见下面 ⑥ 那一组的说明。
 *
 * ⚠ 这一节守的是**接线**（纯函数断言盖不到的部分）：
 *   ① 排盘页真的没有姓名/描述输入框了（别只在文件头写注释、JSX 还留着）；
 *   ② 点「保存到记录」只是**开窗**，不发请求（「才出现」的字面实现）；
 *   ③ 只有小窗里点「保存」才真的 history.push；
 *   ④ 提交的是 saveAskCommit 出的**轻记录**，不是原始 rec；
 *   ⑤ 标签草稿只活在窗里，绝不被 saveAskCommit 带进轻记录；
 *   ⑥ 归类是 push 成功之后的第二次请求（不是点保存时就发）。
 */
console.log('\n--- 保存前的小窗：姓名 / 描述 / 标签（源码级） ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  const paipan = read('src/screens/paipan/Paipan.tsx');
  const result = read('src/screens/result/Result.tsx');

  /* ① 排盘页：真的没有姓名 / 描述输入了 */
  ok(!/请输入姓名/.test(paipan),
     '⚠⚠ 排盘页不再有「请输入姓名」输入框');
  ok(!/descInput|nameInput/.test(paipan),
     '⚠ 排盘页的姓名/描述输入框样式已清掉（留死样式会让人以为这页本来有）');
  ok(!/useState\(\s*''\s*\)[\s\S]{0,80}?desc/.test(paipan),
     '⚠ 排盘页不再持有 desc 这个 state');

  /* ② 点「保存到记录」= 开窗，不发请求 */
  const onSaveBody = /const onSave = useCallback\(\(\) => \{([\s\S]{0,400}?)\}, \[/.exec(result);
  ok(!!onSaveBody, '有 onSave');
  ok(onSaveBody && /model\.saveAskOpen\(/.test(onSaveBody[1]),
     '⚠⚠ 点「保存到记录」只是**开窗**（model.saveAskOpen）');
  ok(onSaveBody && !/history\.push/.test(onSaveBody[1]),
     '⚠⚠⚠ onSave 里**不许**直接 history.push —— 那是「点按钮就存」，违背「填完才存」');

  /* ③ 只有小窗的「保存」才真的提交 */
  /* ⚠ 别把 window 写小：onSaveAskConfirm 的函数体里有注释 + 回调节，远超 200 字。
     用**非贪婪 + 依赖数组收尾**（`}, [saveAsk, showToast]);`）当边界最稳。 */
  const confirmBody = /const onSaveAskConfirm = useCallback\(\(\) => \{([\s\S]*?)\}, \[saveAsk/.exec(result);
  ok(!!confirmBody, '有小窗的确认处理器 onSaveAskConfirm');
  ok(confirmBody && /history\.push\(/.test(confirmBody[1]),
     '⚠⚠ 只有小窗点「保存」才 history.push');
  ok(confirmBody && /model\.saveAskCommit\(/.test(confirmBody[1]),
     '⚠ 提交前先 saveAskCommit 出轻记录（姓名 trim / 描述不 trim / 剥派生字段）');

  /* ④ 取消只关窗，不提交 */
  const cancelBody = /const onSaveAskCancel = useCallback\(\(\) => \{([\s\S]{0,200}?)\}, \[/.exec(result);
  ok(!!cancelBody, '有小窗的取消处理器 onSaveAskCancel');
  ok(cancelBody && /model\.saveAskClose\(\)/.test(cancelBody[1]),
     '⚠ 取消 → saveAskClose（清草稿）');
  ok(cancelBody && !/history\.push/.test(cancelBody[1]),
     '⚠⚠ 取消**不发请求**（取消 = 什么都没发生）');

  /* ⑤ 小窗 JSX：由 saveAsk.show 控制 + 三个输入框接到草稿 */
  ok(/saveAsk\.show \? \(/.test(result), '小窗由 saveAsk.show 控制显隐');
  ok(/value=\{saveAsk\.name\}/.test(result) && /value=\{saveAsk\.desc\}/.test(result),
     '⚠ 两个输入框都绑在**草稿**上（saveAsk.name / saveAsk.desc）');
  ok(/onChangeText=\{onSaveAskName\}/.test(result) && /onChangeText=\{onSaveAskDesc\}/.test(result),
     '⚠ 两个输入框的改动都写回草稿');
  /* ⚠★ 2026-10-06 新增的职业输入框（用户：「每个八字还要增加一个职业的字段。同姓名和描述一样」）
     —— 它必须在**保存窗**里也有（这一刻是用户唯一一次「要把这条存下去」的表态）。 */
  ok(/value=\{saveAsk\.job\}/.test(result), '⚠⚠ 保存窗里也有**职业**输入框（新字段，同姓名/描述一样）');
  ok(/onChangeText=\{onSaveAskJob\}/.test(result), '  └ 职业的改动写回草稿（saveAsk.job）');
  ok(/saveAsk\.saving \? '保存中…' : '保存'/.test(result),
     '⚠ 提交中按钮说「保存中…」（别让用户以为没反应）');

  /* ⑥ ★ 小窗里的「选标签」（用户 2026-10-05：
       「点击保存到记录按钮，弹窗能不能同时有选择标签的功能」）
     ⚠ 这一块最容易出的错**不是画不出来，而是顺序**：归类接口要 `records/:id`，
       而新记录在点「保存」那一刻**还没有 id**（id 由 push 时的 record.slim 生成）
       ⇒ 归类只能是 push 成功之后的**第二次请求**。写成「点保存时就发」= 必然 BAD_ID，
       而界面上看起来只是「选了没生效」。 */
  ok(/import \{ TagBar, TagPicker \}/.test(result),
     '⚠ 保存窗里复用的是 TagBar（与记录页同一枚组件，不另造一排芯片）');
  ok(/canTags && saveBar\.length > 1 \? \(/.test(result),
     '⚠⚠ 标签那块：只在后端支持标签、且**至少建过一个标签**时才出现' +
     '（只有「未分类」一格时整块不渲染 —— 选了等于没选）');
  ok(/<TagBar items=\{saveBar\} onPick=\{onSaveAskTag\} \/>/.test(result),
     '⚠★ 那一排是 TagBar，选一格走 onSaveAskTag（只改草稿，不发请求）');
  ok(/const saveBar = useMemo\(/.test(result) && /model\.saveAskBar\(tags, saveAsk\.tagId\)/.test(result),
     '⚠ saveBar 由 model.saveAskBar 算（tags + 草稿），不在视图里手拼');
  ok(/const onSaveAskTag = useCallback\(/.test(result) && /model\.saveAskTag\(key\)/.test(result),
     "⚠⚠ 草稿那一步必须过 model.saveAskTag（保留值 'none' → null 只有那一处翻译）");
  ok(onSaveBody && /loadTags\(\)/.test(onSaveBody[1]),
     '⚠ 开窗时顺手重拉标签（标签是在记录页「管理」里建的，不重拉就会看到上一轮的旧列表）');
  ok(confirmBody && /const want = saveAsk\.tagId/.test(confirmBody[1]),
     '⚠⚠ 提交前先把标签草稿取成局部量（关窗/清草稿之后就再也读不到了）');
  ok(confirmBody && /tagsLib\.setFor\(hit\.id, want\)/.test(confirmBody[1]),
     '⚠⚠⚠ 归类在 push **成功之后**补发，用的是 push 回来的那条 id —— 不是点保存时就发');
  ok(confirmBody && /if \(!want\) \{/.test(confirmBody[1]) && /showToast\(out\.toast\)/.test(confirmBody[1]),
     '⚠ 没选标签时不发那次归类请求（默认就是未分类，白跑一趟）');
  ok(confirmBody && /history\.bumpRev\(\)/.test(confirmBody[1]),
     '⚠⚠⚠ 归类成功也要推版本号 —— 否则回记录页不重拉，卡片上根本看不出刚选的标签');
  ok(confirmBody && /'已保存，但标签没贴上'/.test(confirmBody[1]),
     '⚠⚠ 归类失败要说实话（记录已存、标签没贴上），不许并进「已保存」那一句');
}

/* ================================================================
 * 六之四、全局键盘避让（用户真机反馈 + 用户定的方案）
 * ================================================================
 * 用户原话（先提现象）：「修改内容，但是输入的太多，保存按钮会移动到下面，
 *            然后被键盘所遮挡，我希望键盘弹出的状态会把页面挤上去」
 * 用户原话（后给定方案）：「只要当键盘弹出都让 app 直接减去键盘的高度，避让。
 *            做一个整体的设计。」
 *
 * ⇒ 定案：**不再逐页各写一遍** `KeyboardAvoidingView`，改成在根节点包**一层**
 *    `components/KeyboardAvoid`，全 App 一次性生效。
 *
 * ⚠ 这一节守的全是**接线与分层**（纯函数断言盖不到）：
 *   ① 全局那一层真的存在、且**在 Provider 子树里**读高度（读错位置 = 恒 0，且不报错）；
 *   ② 「减高度」落在**内容容器**上，不是落在 NavBar 上；
 *   ③ ⚠⚠ 绝对定位的推入层不占内容容器的高度 ⇒ 必须自己再减一次，否则照样被盖；
 *   ④ ⚠⚠ 各页**不许**再自己套一层 —— 两层都避让 = 双重上移（小屏上框被顶出屏幕顶）；
 *   ⑤ 安卓走 `softwareKeyboardLayoutMode: 'resize'`（默认的 'pan' 是整页平移，不是减高度）。
 */
console.log('\n--- 全局键盘避让（源码级） ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  const app = read('App.tsx');
  const kb = read('src/components/KeyboardAvoid.tsx');
  const result = read('src/screens/result/Result.tsx');
  const login = read('src/screens/login/Login.tsx');
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

  /* ① 全局那一层存在，且用的是自己写的（不是 RN 的 KAV） */
  ok(/import KeyboardAvoid[,\s{]/.test(app), '⚠⚠⚠ 根节点引入了全局避让层 KeyboardAvoid（用户要求：整体设计，不逐页写）');
  ok(/<KeyboardAvoid>/.test(app), '  └ 真的包在根节点上（只 import 不包 = 没生效）');
  ok(/<Root\s*\/>|function Root\(/.test(app),
     '⚠⚠ 内容拆进 <KeyboardAvoid> 的**子树**里 —— 消费方不在 Provider 子树里读到的是默认值 0（恒不避让、且不报错）');

  /* ② ⚠⚠⚠ 高度换算只有一处，且用 screenY 直接算遮挡（2026-10-04 第二次报障后改的口径）
     —— **不许再减 insetBottom**：iOS 键盘 frame 顶到屏幕最底（Home 指示条那块也是键盘），
     挡住的内容 = 整个高度。按「高度 − 安全区」算 = 少让 34pt = 输入框底部
     正好沉进键盘最顶上的候选栏底下（真机截图实锤）。 */
  ok(/typeof\s+ec\.screenY\s*===\s*'number'/.test(kb),
     '⚠⚠⚠ 必须用 endCoordinates.screenY 直接算遮挡（屏高 − 键盘顶边）—— 用 height 减安全区是少让 34pt 的旧坑');
  ok(/Math\.max\(0,\s*Math\.min\(\s*Math\.round\(\s*screenH\s*-\s*y/.test(kb),
     '⚠⚠⚠ 遮挡 = screenH - y 且夹在 [0, 屏高]（screenY 落到屏幕外时自动归 0 = 键盘已收起）');
  /* ⚠⚠ must-not：那个「减安全区」的旧口径一旦回来，真机必复现（候选栏盖输入框）。 */
  ok(!/-\s*insetBottom/.test(kb),
     '⚠⚠⚠ 不许再减 insetBottom（键盘 frame 顶到屏幕底，安全区那块本来就是键盘的一部分，再扣 = 少让 34pt）');
  ok(/endCoordinates/.test(kb), '  └ 从事件的 endCoordinates 取高度');

  /* ③ ⚠⚠ 事件名两端不同 + will/did 都要（will 是预估值，did 才是最终值） */
  ok(/keyboardWillShow/.test(kb), "⚠ iOS 用 willShow（跟动画同步，来得及让位）");
  /* ⚠⚠ 只查字面 `keyboardDidShow` 不够 —— 它得**真的被挂上监听**才算数。
     直接钉「那个变量被 addListener 用到」。 */
  ok(/const\s+didEvt\s*=\s*'keyboardDidShow'/.test(kb) && /addListener\(\s*didEvt/.test(kb),
     "⚠⚠⚠ 必须真的把 keyboardDidShow 挂上监听 —— will 给的是**预估**高度（切输入法/外接键盘/候选栏都会变），只认 will 会算错");
  /* ⚠⚠⚠ 2026-10-04 用户报障：批字输入框被键盘整个盖住（第三方输入法）。
     根因是「第三方键盘弹出只发 changeFrame、不发 show」—— 只接 show/didShow 的避让层
     在这条路上恒等于 0，表现就是「避让永远不生效、还不报错」。
     ⚠ 这两条断言必须钉「真的挂上了监听」，光有字面常量是假绿。 */
  ok(/const\s+frameEvt\s*=\s*'keyboardWillChangeFrame'/.test(kb) && /addListener\(\s*frameEvt/.test(kb),
     '⚠⚠⚠ 必须接 keyboardWillChangeFrame 并**真的挂上监听** —— 第三方输入法弹出只发它，不接 = 避让整层静默失效');
  ok(/const\s+frameDidEvt\s*=\s*'keyboardDidChangeFrame'/.test(kb) && /addListener\(\s*frameDidEvt/.test(kb),
     '⚠⚠ 完成时的那一份也要接（与 will/did 同一套道理：did 才是最终值）');
  /* ⚠⚠⚠ changeFrame **收起时也会发**（height 仍是整个键盘高）——
     不判 screenY，收起键盘反而会把页面顶上去。 */
  ok(/screenY/.test(kb) && /Dimensions\.get\('screen'\)/.test(kb),
     '⚠⚠⚠ changeFrame 里必须用 screenY 判「键盘在不在屏幕上」—— 不判的话收起键盘会把页面顶上去（真·反向 bug）');
  ok(!/keyboardDidHide[^)]*setEaten\(0\)[\s\S]{0,80}keyboardWillHide/.test(kb) || /keyboardWillHide/.test(kb),
     '隐藏事件走 willHide/hideHide 之一（两端各一套）');

  /* ④ ⚠⚠⚠ 安卓恒不自己避让（系统 resize 已经缩过窗口，再避 = 双重上移） */
  ok(/Platform\.OS !== 'ios'\)\s*return/.test(kb),
     '⚠⚠⚠ 安卓直接 return（不监听、不避让）—— 系统 adjustResize 已经缩过窗口了');
  ok(appJson.expo.android.softwareKeyboardLayoutMode === 'resize',
     "⚠⚠ app.json 必须配 softwareKeyboardLayoutMode:'resize' —— 默认的 'pan' 是整页**平移**，不是减高度");

  /* ⑤ 「减高度」落在**内容容器**上，且 NavBar 不参与 */
  ok(/paddingBottom:\s*eaten/.test(app),
     '⚠⚠⚠ 内容容器 app 用 paddingBottom: eaten —— 这就是「页面长度减去键盘高度」');
  {
    /* ⚠ 取 NavBar 那一行与内容容器那一行，确认「减高度」没挂到 NavBar 上 */
    const navLine = (app.match(/<NavBar[^\n]*/) || [''])[0];
    ok(navLine && !/eaten/.test(navLine),
       '⚠⚠ NavBar **不参与**避让 —— 键盘吃掉的是内容区的高度，顶部导航栏该原位不动');
  }
  ok(/eaten > 0 \? null : <TabBar/.test(app),
     '⚠ 键盘弹着时把底部 tab 栏**藏掉**（它已被键盘盖住，留着只是白占那几十像素）');

  /* ⑥ ⚠⚠⚠ 绝对定位的推入层不占内容容器的高度 ⇒ 自己再减一次 */
  /* ⚠⚠ 必须**逐个**看两个推入层组件自己有没有收到 ——
     写成 `/eaten=\{eaten\}/` 会恒真（App 里到处都是 eaten），那条断言就是假绿。 */
  ok(/<Result[\s\S]{0,240}?eaten=\{eaten\}/.test(app),
     '⚠⚠ 结果页收到了 eaten（它是 overlay，不占 App 里内容容器的高度）');
  ok(/<Login[\s\S]{0,240}?eaten=\{eaten\}/.test(app),
     '⚠⚠ 登录页也收到了 eaten（同为 overlay）');
  ok(/eaten = 0/.test(result) && /marginBottom:\s*eaten/.test(result),
     '⚠⚠⚠ 结果页自己再减一次（它是 overlay，**不占** App 里 s.stage 的高度）');
  /* ⚠⚠⚠ 2026-10-04 修掉的重复扣高：mask 是**外层那个 View 的绝对定位子节点**，
     跟着外层一起让位就够了 —— 自己再写一次 marginBottom: eaten = 同一个键盘高度扣两遍，
     弹框会飘到屏幕上半截（那行是「减高度挂在 ScrollView 上」时代的遗留）。 */
  ok(!/\[s\.mask,\s*\{\s*marginBottom/.test(result),
     '⚠⚠⚠ 结果页的三个弹框遮罩**不许**自带 marginBottom:eaten —— 外层 View 已经让过位了，再减就是双份');
  ok(/eaten = 0/.test(login) && /paddingBottom:\s*eaten/.test(login),
     '⚠⚠⚠ 登录页同理（同为 overlay）');

  /* ⑦ ⚠⚠⚠ 各页不许再自己套一层（两层 = 双重上移） */
  ok(!/KeyboardAvoidingView/.test(result),
     '⚠⚠⚠ 结果页**不许**再自己套 KeyboardAvoidingView —— 两层都避让 = 双重上移，小屏上框被顶出屏幕顶');
  ok(!/KeyboardAvoidingView/.test(login),
     '⚠⚠⚠ 登录页也不许（原来它自己套了一层，已收归全局）');
  ok(!/KeyboardAvoidingView/.test(kb),
     '⚠ 全局层也不用 RN 那个 KAV —— 它不知道状态栏/导航栏/安全区的位置，算出来的高度不准');
}

/* ================================================================
 * 七、系统 chrome 契约：安全区 / 导航栏 / tab 栏（源码级）
 * ================================================================
 * ⚠ 小程序里「状态栏占位 + 原生导航栏 + tabBar 底部安全区」全是**系统画的**，
 *   RN 里都得自己补。2026-10-02 用户真机反馈「顶部被遮住了、底部菜单太小」
 *   —— 根因就是这一层从来没搬过来。这里把关键动作锁住：
 *
 *   ① App 必须包 SafeAreaProvider（没有它 useSafeAreaInsets 恒为 0，等于没补）；
 *   ② NavBar 的状态栏高度必须 insets.top 现取（刘海屏 44-59pt，写死必错）；
 *   ③ TabBar 底部必须 padding insets.bottom（home indicator 一带）；
 *   ④ 结果页盖满全屏，纵向留白必须含 insets.bottom；
 *   ⑤ tab 栏尺寸不许回退成「太小」（图标盒 / 字号锁下限）。
 */
console.log('\n--- 系统 chrome 契约：安全区 / 导航栏 / tab 栏 ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  const app = read('App.tsx');
  const nav = read('src/components/NavBar.tsx');
  const bar = read('src/screens/tabs/TabBar.tsx');
  const result = read('src/screens/result/Result.tsx');

  /**
   * ⓪ ⚠⚠ 冷启动必须先「读盘」再「渲染」。
   *   凭证是异步读进内存镜像的，而 auth / boot 全是同步读内存 ——
   *   不等它读完就挂载页面，子组件会在 effect 里去问登录态，
   *   读到的必然是「未登录」。**这条曾经真的漏了**：
   *   storage.loadFromDisk 早就写好了，却全项目零个调用点。
   */
  ok(/storage\.loadFromDisk\s*\(\s*\)/.test(app),
     '⚠⚠ App.tsx 调用了 storage.loadFromDisk()（否则冷启动读不到已有凭证）');
  ok(/if\s*\(\s*!\s*booted\s*\)/.test(app),
     '⚠⚠ 渲染被 booted 门住（否则子组件会在凭证还没读回来时就去问登录态）');
  ok(/const\s*\[\s*booted\s*,\s*setBooted\s*\]\s*=\s*useState/.test(app),
     'booted 必须是 state —— 用 ref 的话读完不触发重渲染，页面会永远空着');

  /* ① Provider 在最外层 */
  /*
   * ⚠⚠ 别写成「出现即通过」。
   *   App.tsx 里有**两处** SafeAreaProvider（booted 闸门那一段 + 主 return），
   *   而负向验证的注入是单次 replace、只会改掉第一处 —— 剩下那处照样让
   *   `/ <SafeAreaProvider>/` 变绿。这条洞就是 `_neg-screens` 的用例 [31]
   *   跑出 FAIL=0 抓出来的（写的时候没发现，跑负向才暴露）。
   *   ⇒ 判据要能认出「改坏一处」：开闭必须配对。
   */
  const saOpen = (app.match(/<SafeAreaProvider>/g) || []).length;
  const saClose = (app.match(/<\/SafeAreaProvider>/g) || []).length;
  ok(saOpen > 0 && saOpen === saClose,
     'App.tsx 包了 SafeAreaProvider（开闭配对 —— insets 的供给源）');
  ok(/import\s*\{[^}]*SafeAreaProvider[^}]*\}\s*from\s*'react-native-safe-area-context'/.test(app),
     'App.tsx 真的引进了 SafeAreaProvider（不是只写了标签）');

  /* ② 导航栏：insets 现取 + 标题逐字对上小程序各页 json */
  ok(/useSafeAreaInsets\s*\(\)/.test(nav), 'NavBar 用 useSafeAreaInsets() 现取状态栏高度');
  /* ⚠ 精确到「顶部占位那一行」：写成 /top:\s*\d+/ 会撞上 hitSlop 的 top:8（假红） */
  ok(/\{\s*height:\s*insets\.top\s*\}/.test(nav),
     'NavBar 顶部占位就是 insets.top 本身（不许换成写死的数字）');

  const titles = ['记录', '八字排盘', '学堂', '设置'];
  titles.forEach((t) => {
    ok(app.indexOf("'" + t + "'") >= 0, 'App.tsx 的标题表里有「' + t + '」（对应小程序各页 json）');
  });
  ok(/'排盘结果'/.test(app), '结果页标题是「排盘结果」（result.json 原文）');

  /* ③ tabBar 底部安全区 + 尺寸下限 */
  ok(/paddingBottom:\s*insets\.bottom/.test(bar), 'TabBar 底部 padding 了 insets.bottom（home indicator）');
  ok(/width:\s*rpx\(64\)[\s\S]{0,40}height:\s*rpx\(64\)/.test(bar),
     'tab 图标盒 ≥ rpx(64)（32pt；旧值 rpx(52) 被真机反馈判为太小）');
  ok(/fontSize:\s*rpx\(24\)/.test(bar), 'tab 文字 ≥ rpx(24)（12pt；旧值 rpx(20) 太小）');

  /* ④ 结果页底部留白含安全区（它盖满全屏，没有 tab 栏兜底） */
  ok(/pagePadBottom\)\s*\+\s*insets\.bottom/.test(result),
     '结果页纵向留白含 insets.bottom（最后一颗按钮不许贴屏底）');

  /* ⑤ 返回语义：navigateBack ≠ switchTab */
  ok(/hardwareBackPress/.test(app), 'Android 物理返回键有接管（默认行为是退出 App）');
  ok(/const onBack = useCallback/.test(app) && /setResultEntry\(0\);\s*\n\s*\}, \[\]\);/.test(app),
     'onBack 只 pop 不切 tab（= tt.navigateBack；别复用 onGoPaipan）');
}

/* ================================================================
 * 七之二、登录链路的结构契约（源码级）
 * ================================================================
 * ⚠ 这一层同样防的是「model 全对、接线错了」：
 *   · 登录页自己**不刷新任何东西** —— 它靠 App 递增 sessionRev 把常驻的四个 tab 叫醒；
 *   · 「未登录」必须走 need 态，不能落到 fail + 「重试」（重试一万次也不会好）；
 *   · 登录页的 NavBar 必须与结果页**各一条**（共享的话 overlay 的 top:0 会盖住）。
 * 这三件在纯 Node 里跑不出来（要真挂载 React），只能读源码锁结构。
 */
console.log('\n--- 登录链路结构契约 ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  const app = read('App.tsx');
  const records = read('src/screens/records/Records.tsx');
  const paipan = read('src/screens/paipan/Paipan.tsx');
  const settings = read('src/screens/settings/Settings.tsx');
  const loginView = read('src/screens/login/Login.tsx');

  /* ① 登录页是推入层：自己那条 NavBar，标题取自 content（不另抄一份中文） */
  ok(/import Login from '\.\/src\/screens\/login\/Login'/.test(app), 'App 引了登录页');
  ok(/<Login onClose=\{onCloseLogin\} onLoggedIn=\{onLoggedIn\}/.test(app),
     'App 渲染登录页并接上「关页 / 登录成功」两个回调');
  ok(/loginContent\.TITLE/.test(app), '⚠ 登录页标题取自 content.TITLE（标题只写一份）');
  ok(/<NavBar title=\{loginContent\.TITLE\} onBack=\{onCloseLogin\}/.test(app),
     '登录页有自己那条 NavBar（不复用结果页那条）');

  /* ② 会话信号必须真的发出去，而且能把常驻页面叫醒 */
  ok(/setSessionRev\(\(n\) => n \+ 1\)/.test(app),
     '⚠⚠ 登录 / 退出后必须递增 sessionRev（常驻页面不重挂载，没有它就不刷新）');
  ok(/boot\.forget\(\)/.test(app),
     '⚠⚠ 换人时必须忘掉 boot 的核对结论（否则新账号看到上一个人的记录）');
  ok(/sessionRev=\{sessionRev\}/.test(app), 'sessionRev 传给了 tab 页');
  ok(/onGoLogin=\{onOpenLogin\}/.test(app), '各页的「去登录」接到了 App 的 openLogin');
  ok(/const activeKey = live \? tab : ''/.test(app),
     '⚠ 推入层盖住时 tab 页置为非 active（= 小程序的 onHide，页面据此退订 / 停表）');
  ok(/if \(showLogin\) onCloseLogin\(\)/.test(app), '⚠ 物理返回优先 pop 登录页（不是直接退出 App）');

  /* ③ 记录页：NEED_LOGIN 必须是可点的「去登录」，不是 FAILED 的「重试」 */
  ok(/STAGE\.NEED_LOGIN/.test(records), '记录页处理了 STAGE.NEED_LOGIN');
  ok(/canLogin/.test(records), '记录页把「可去登录」与「可重试」分开');
  ok(/onGoLogin/.test(records), '记录页拿到了去登录的出口');
  ok(/pullActionOf/.test(records), '记录页用 model.pullActionOf 决定那条提示点了做什么');

  /**
   * ③b 退出登录 ⇒ 标签那一整套必须归零（★ 2026-10-21 用户报障「标签管理没重置」）。
   * ⚠ 本页是常驻的：换人时只有 loadCloud 会重拉，`tags`/`untagged`/`tagErr`/`tagOpen`
   *   全是本页自己的 state，**没有任何人会去清** —— 上一个人的标签名、甚至开着的面板
   *   会一直留在屏幕上。所以这条断言要求「五样连着一起清」，而且顺序有讲究（见下一条）。
   */
  ok(/if \(sessionChanged\) \{[\s\S]{0,200}?setTags\(\[\]\);\s*setUntagged\(0\);\s*setTagErr\(''\);\s*setTagOpen\(false\);\s*setTagSel\(''\);\s*tagSelRef\.current = '';/.test(records),
    '⚠⚠⚠ 登录态一变就把标签五样（tags/untagged/tagErr/tagOpen/tagSel+ref）一起归零');
  ok(/tagSelRef\.current = '';\s*\}\s*loadCloud\(\);/.test(records),
    '⚠ 清 tagSelRef 必须在 loadCloud() **之前**（loadCloud 同步读它拼 query，否则这一发还带着上一个人的标签 id）');
  ok(/if \(!auth\.isLoggedIn\(\)\) return Promise\.resolve\(\);/.test(records),
    '⚠⚠ 未登录时默认**不发**标签请求（否则 401 会把「标签加载失败」写回刚清干净的 tagErr）');

  /* ④ 排盘页：未登录 = need（给「去登录」），不是 fail（给「重试」） */
  ok(/setLogin\(\{ state: 'need'/.test(paipan), '⚠ 排盘页未登录走 need 态，不是 fail 态');
  ok(/res\.needLogin/.test(paipan), '排盘页看的是 res.needLogin');
  ok(/去登录/.test(paipan), '排盘页给了「去登录」出口');
  /**
   * ④b 未登录点「开始排盘」⇒ **直接开登录页**（★ 2026-10-21 用户要求）。
   * ⚠ 原来只是原地弹一句「登录后才能排盘」，用户还得自己去找登录入口 —— 中间那一步多余。
   *   所以闸门拦下时必须直接 `onGoLogin()`，并且**不许**再留那句提示（`setToast`）。
   */
  ok(/const gate = model\.gateOnIdentity\(who\);\s*if \(!gate\.ok\) \{\s*onGoLogin\(\);\s*return;\s*\}/.test(paipan),
    '⚠⚠ 闸门拦下时直接 onGoLogin()（不再原地弹提示让人自己找入口）');
  ok(!/setToast/.test(paipan), '⚠ 那句原地提示（toast）已整体移除 —— 别留一个没人 set 的死状态');

  /* ⑤ 设置页：账号行 + 退出登录 */
  ok(/auth\.isLoggedIn\(\)/.test(settings) && /auth\.loginUsername\(\)/.test(settings),
     '设置页读登录态与当前账号名');
  ok(/\[sessionRev\]/.test(settings),
     '⚠ 设置页靠 sessionRev 重读登录态（它常驻，不重读就一直是旧状态）');
  ok(/auth\.logout\(\)/.test(settings), '设置页有退出登录');
  ok(/content\.LOGOUT_BODY/.test(settings), '退出登录有二次确认（文案取自 content）');

  /* ⑥ 登录页：账号 + 密码两框；注册入口**有条件**（只有本地后端能注册） */
  ok(/auth\.signInWithPassword\(/.test(loginView), '登录页调 auth.signInWithPassword 登录');
  ok(/auth\.signInWithPassword\(username, password\)/.test(loginView),
     '⚠⚠ 两个框的值都要真的交出去（漏 password ⇒ 每次都「用户名或密码不对」）');
  ok(/auth\.signUpWithPassword\(/.test(loginView), '登录页调 auth.signUpWithPassword 注册');
  /* ⚠⚠ 这条**必须点名到"注册入口被 CAN_SIGNUP 门住"**，不能只写 /auth\.canSignUp\(\)/：
     那个调用在文件顶部算 CAN_SIGNUP 常量时出现过一次 ⇒ 就算把下面
     `{CAN_SIGNUP ? (` 改成 `{true ? (`（= 入口恒显示），宽正则照样绿。
     （负向验证实测抓到过。） */
  ok(/\{CAN_SIGNUP \? \(/.test(loginView),
     '⚠⚠ 注册入口**由 canSignUp() 决定**，不能写死 —— CloudBase 那条路平台禁死（501），显示了也点不通');
  ok(/auth\.canSignUp\(\)/.test(loginView), '  └ canSignUp 的值确实来自 auth');
  ok(/const CAN_SIGNUP/.test(loginView), '  └ canSignUp 的结果被存下来（不是在 render 里反复调）');
  ok(/<Text style=\{s\.tip\}>\{content\.NO_SIGNUP_TIP\}<\/Text>/.test(loginView),
     '⚠⚠ 不能注册时必须说明账号从哪来（用户找不到注册入口会以为 App 坏了）');
  /* ⚠⚠ 必须检查**两个密码框都遮起来了**，不能只写 /secureTextEntry/：
     本页有 password + confirm 两个框 ⇒ 只写存在性的话，把密码框那个拿掉、
     确认框那个还在，正则照样命中（负向验证实测抓到过 trc=0）。
     计数 = 文件里 secureTextEntry 的出现次数，两个框各一次。 */
  const secureCount = (loginView.match(/secureTextEntry/g) || []).length;
  ok(secureCount >= 2,
     '⚠ 两个密码框都要遮起来（明文显示密码是硬伤）', 'secureTextEntry 出现 ' + secureCount + ' 次，应为 2');
  /* ⚠⚠ 这条**必须点名到账号框那一组属性**，不能只写 /autoCapitalize="none"/：
     密码框也有同一句 ⇒ 宽松正则照样绿（负向验证实测抓到过：
     把账号框那条改成 "sentences"，测试仍然全绿）。 */
  ok(/autoCapitalize="none"\s+autoCorrect=\{false\}\s+textContentType="username"/.test(loginView),
     '⚠ 账号框关掉自动大写（服务端只认小写，iOS 默认会把首字母大写）');
  /* ⚠⚠ 这条**必须点名到 setPassword 那一次调用**，不能只写 /model\.passwordInput\(/：
     确认密码框（onConfirmChange）里也有同一句 ⇒ 宽正则照样绿。
     （负向验证实测抓到过：把密码框那次改成 v.trim()，只写宽正则时测试仍然全绿。） */
  ok(/setPassword\(model\.passwordInput\(/.test(loginView),
     '⚠⚠ 密码走 model.passwordInput（它只限长；直接在视图里 trim 会让「结尾带空格的真密码」永远登不上）');
  /* ⚠⚠ 注册态的确认密码框**必须也走 passwordInput** —— 两边清洗规则不一致的话，
     用户明明输得一样却报「两次不一样」，且他永远查不出来。 */
  ok(/setConfirm\(model\.passwordInput\(/.test(loginView),
     '⚠ 确认密码框与密码框走同一个清洗函数（否则「输得一样」也会报不一致）');
  ok(!/verificationId|isUser|验证码/.test(loginView),
     '⚠ 登录页不许残留短信那套（verificationId / isUser / 验证码）');
  ok(/model\.submitStateOf\(/.test(loginView),
     '按钮的禁用规则来自 model（别在视图里各写一遍）');
  ok(/clearTimeout\(closeTimer\.current\)/.test(loginView),
     '⚠ 成功后延迟关闭的计时器在卸载时被清掉（否则在已卸载组件上 setState）');
  /* ⚠⚠ 密码框的 returnKeyType 在注册态必须指向**确认框**（next），
     登录态才是「提交」（done/go）。写死一个的话，注册时键盘上会出现一个
     点了就提交的键 —— 而那时确认框还空着。 */
  ok(/returnKeyType/.test(loginView), '密码框设了 returnKeyType');
  ok(/'next'/.test(loginView), '  └ 注册态是 next（跳到确认框，不是直接提交）');

  /* ⑦ 「记住账号密码」的接线（存取逻辑本身在 local-check 第十三节里断言过，
        这里守的是**这一页有没有按规矩接**） */
  ok(/useState\(\(\)\s*=>\s*savedLogin\.load\(\)\)/.test(loginView),
     '⚠⚠ 记住的账号密码用**惰性初值**读一次 —— 直接求值的话，本页每敲一个字都会读一遍存储');
  ok(/useState\(boot\.username\)/.test(loginView) && /useState\(boot\.password\)/.test(loginView),
     '⚠⚠ 两个框的初值真的来自它（只读不用 = 白读）');
  ok(/useState\(boot\.remember\)/.test(loginView),
     '⚠ 勾选框的初值也来自它（用户上次取消过就该一直是取消的）');
  /* ⚠⚠⚠ 最关键的一条：写入口必须落在**登录成功之后**。
     边输边存会把打错的密码记下来 —— 下次点「登录」直接撞「用户名或密码不对」，
     而用户确信自己什么都没改过（框里的字是他上次留下的）。那种 bug 两边日志都正常。
     ⚠ 用「失败分支的 return 在 save 之前」钉住相对顺序，比只查 `r.ok` 出现过要强：
     后者把 save 挪到 call 之前照样绿（负向验证实测过）。 */
  ok(/if\s*\(!r\.ok\)\s*\{[\s\S]{0,200}?return;[\s\S]{0,400}?savedLogin\.save\(/.test(loginView),
     '⚠⚠⚠ 「记住」写在**登录成功之后**（失败分支一旦 return，就走不到那句 save）');
  {
    /* ⚠ 全文件只许有**一处**写入口 —— 多一处就迟早有人往错的地方再写一遍 */
    const saveCount = (loginView.match(/savedLogin\.save\(/g) || []).length;
    ok(saveCount === 1, '⚠ 写入口只有一处（多了就迟早有人在错误时机再写一遍）',
       'savedLogin.save( 出现 ' + saveCount + ' 次，应为 1');
  }
  /* ⚠ 勾选框点一下要**立刻**告诉 core（关掉时那边负责把已存的密码擦掉），
     而不是等下次登录成功才生效 —— 「不记住」按下就该算数。 */
  ok(/savedLogin\.setRemember\(/.test(loginView),
     '⚠ 取消勾选时立刻让存储忘掉密码（不是等下次登录成功才生效）');
  ok(/content\.REMEMBER_LABEL/.test(loginView),
     '⚠ 勾选框文案取自 content（文案只写一份）');
  ok(/accessibilityRole="checkbox"/.test(loginView),
     '勾选框声明 checkbox 角色（读屏用户得知道它是个开关）');
  {
    /* ⚠⚠ 漏 remember ⇒ onSubmit 的闭包拿到旧的勾选状态：
       用户刚取消勾选，存下去的却还是「记住」（或者反过来）。运行时很难发现。 */
    const onSubmitDeps = (loginView.match(/\}, \[mode, isSignup[^\]]*\]/) || [''])[0];
    ok(/remember/.test(onSubmitDeps),
       '⚠⚠ onSubmit 的依赖数组里要有 remember（少了它，这次提交用的是上一次的勾选状态）',
       onSubmitDeps);
  }
  /* ⚠⚠⚠ 负向：这个键**不许**被退出登录 / 强制下线清掉 ——
     用户要的正是「退出登录之后，登录页上的账号密码还在，点一下就能登回来」。 */
  ok(!/savedLogin/.test(settings),
     '⚠⚠⚠ 设置页的退出登录**不许**碰「记住的账号密码」（用户明确要求：退出后它还得在）');
  ok(!/savedLogin/.test(app),
     '⚠⚠⚠ App 里（含被管理员强制下线那条路）也不许清它 —— 那正是最需要它的时候');

  /**
   * ⑧ 学堂**只限登录**才可以使用（★ 2026-10-21 用户要求）。
   *
   * ⚠ 挡在**壳**这一层，而且要在 `<SegTabs>` **之前** return ——
   *   否则两个面板照旧挂载：未登录时它们会各发一次必然 401 的请求，
   *   还会带着**上一个人**的书签列表（本页常驻、state 不下线）。
   * ⚠ 登录态必须靠 `sessionRev` 重读：本页常驻，`auth.isLoggedIn()` 自己变了
   *   不会让 effect 重跑（与设置页同一个口径）。
   */
  const studyShell = read('src/screens/study/Study.tsx');
  ok(/auth\.isLoggedIn\(\)/.test(studyShell) && /\[sessionRev\]/.test(studyShell),
     '⚠⚠ 学堂靠 sessionRev 重读登录态（常驻页不会因为登录 / 退出而重挂载）');
  ok(/if \(!logged\) \{[\s\S]{0,900}?onPress=\{onGoLogin\}[\s\S]{0,240}?model\.GATE_LOGIN\.action/.test(studyShell),
     '⚠ 未登录只剩一张说明卡 + 「去登录」（出口必须留）');
  {
    /* ⚠ 位置断言：拦住「卡是画了，但两个面板照样在上面挂着」这种半截状态 */
    const gateAt = studyShell.indexOf('if (!logged)');
    const segAt = studyShell.indexOf('<SegTabs');
    ok(gateAt >= 0 && segAt > 0 && gateAt < segAt,
       '⚠⚠⚠ 未登录那张卡必须**先于**切换栏 return（面板一个都不许挂）');
  }
  ok(studyModel.GATE_LOGIN && studyModel.GATE_LOGIN.title.length > 0 &&
     studyModel.GATE_LOGIN.body.length > 0 && studyModel.GATE_LOGIN.action.length > 0,
     '未登录的文件（标题 / 说明 / 按钮）都在 model.GATE_LOGIN 里（视图里不留中文字面量）');
  ok(/<Study[\s\S]{0,220}?sessionRev=\{sessionRev\}[\s\S]{0,140}?onGoLogin=\{onOpenLogin\}/.test(app),
     '⚠ App 真的把 sessionRev 与「去登录」交给了学堂（只写 prop 类型不算接线）');
}

/* ================================================================
 * 七之三、记录页筛选的**接线契约**（源码级）
 * ================================================================
 * ⚠ 本功能的核心约定是「**过滤在服务端**」（用户明确要求）。
 *   model 里的纯函数已经断言过了，但「视图有没有真的把参数发出去」
 *   纯函数盖不到 —— 那正是最容易漏的一环：
 *   面板画得漂漂亮亮、点击也改了状态，但 request 里**没带 query**，
 *   于是筛选看起来「点了没反应」。这里把这条线锁住。
 */
console.log('\n--- 记录页筛选接线契约（源码级） ---');
{
  const fs = require('fs');
  function stripComments(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  const view = read('src/screens/records/Records.tsx');
  const hist = read('src/core/history.js');
  const ldb = read('src/core/store/localdb.js');
  const sdk = read('src/core/localsdk.js');

  /* ① 视图：筛选状态 + 参数真的发出去 */
  ok(/model\.emptyFilter\(\)/.test(view), '视图用 model.emptyFilter() 起手（别自己写一个字面量对象）');
  ok(/model\.toQuery\(filterRef\.current,\s*nameRef\.current,\s*tagSelRef\.current\)/.test(view),
     '⚠⚠ loadCloud 里真的把筛选翻成查询参数（不翻 = 点了没反应）——八干支 + 姓名 + 标签**三个维度一起带上**');
  ok(/history\.pull\(query, opt\)/.test(view),
     '⚠⚠ 筛选参数交给 history.pull（★ 过滤在服务端，本地不筛）—— 第二参是分页 `{limit, offset}`');
  ok(/store\.supportsFilter\(\)/.test(view),
     '⚠ 面板的可点性由 store.supportsFilter() 决定（后端不支持时不许假装能筛）');
  ok(/keepTotal/.test(view),
     '⚠ 带筛选重拉时不更新「总条数」（否则「共 N 例」的分母会变成筛后的数字）');

  /* ⚠⚠ 视图里**不许**出现本地过滤数组的写法 —— 那等于把功能做回了客户端 */
  ok(!/\.filter\(/.test(view),
     '⚠⚠ 视图里**不许**有 Array.filter —— 过滤必须在服务端（用户的明确要求）');

  /* ② 空态分叉：「真没有」与「筛空了」文案不同 */
  ok(/没有符合条件的记录/.test(view),
     '⚠ 筛空时给的是「没有符合条件的记录」，不是「还没有排盘记录」（后者会让用户以为记录丢了）');

  /* ③ history.pull 把参数透到 userStore */
  ok(/function pull\(filter, opt\)/.test(hist), 'history.pull 接收 filter（+ 可选分页 opt）');
  ok(/userStore\.listRecords\(who\.uid, filter, opt\)/.test(hist), 'history.pull 把 filter 与 opt 透给 userStore');

  /* ④ userStore → store → 驱动，逐层透传 */
  ok(/store\.listRecords\(uid, filter, opt\)/.test(read('src/core/userStore.js')),
     'userStore.listRecords 透传 filter + opt 给 store');

  /* ⑤ 驱动层：真的拼进查询串 */
  ok(/query: query/.test(ldb) && /Object\.assign\(\{\}, filter/.test(ldb),
     '⚠⚠ localdb 把 filter（+ 分页参数）作为 **query** 发出去（不是 body、不是路径）');
  ok(/function listRecordsFiltered/.test(ldb), 'localdb 有 listRecordsFiltered（带筛选的那条路）');

  /* ⑥ 底层：request 支持 query，且必须 encodeURIComponent */
  ok(/function buildQuery/.test(sdk), 'localsdk 有 buildQuery');
  ok(/encodeURIComponent/.test(sdk),
     '⚠⚠ 查询参数必须 encodeURIComponent —— 干支是中文，不编码会 URIError 或静默丢参数');
  ok(/opts\.query/.test(sdk), 'request 读 opts.query');

  /* ⑦ storeMode：只有 local 支持筛选，且这个判断**只有一处** */
  const sm = read('src/core/storeMode.js');
  ok(/function supportsFilter/.test(sm), 'storeMode 有 supportsFilter');
  ok(/supportsFilter[\s\S]{0,120}MODE === 'local'/.test(sm),
     '⚠ 只有 local 后端支筛选（cloudbase / cloud / gitee 都没有这个接口）');

  /* ================================================================
   * ⑧ 弹窗契约（★ 用户要求：「筛选做成弹窗面板吧。点击确定才筛选。」
   *    ⚠ 2026-10-04 起弹窗与入口是**公用组件** components/FilterModal.tsx
   *      （记录页 + 学堂页共用），所以这一组拆成两半：
   *      组件侧守「草稿隔离」，本页侧守「确定之后怎么拉数据」）
   * ================================================================
   * ⚠⚠ 核心是**草稿隔离**：弹窗里勾的必须只写组件内部的 draft，
   *   生效中的 `filter` / `filterRef` 一个字节都不许动。
   *   写坏的样子很隐蔽：勾选时「顺手」也把生效值改了 —— 界面看着完全正常
   *   （因为确定后结果一样），但**点取消就回不去了**（草稿已经被提交了）。
   */
  const fm = read('src/components/FilterModal.tsx');
  {
    ok(/export function FilterEntry/.test(fm), '入口行是公用组件（FilterEntry）');
    ok(/export function FilterModal/.test(fm), '弹窗是公用组件（FilterModal）');

    /* 勾选处理器：只写草稿，不调 onConfirm、不碰生效值 */
    const toggle = /const onToggle = useCallback\([\s\S]{0,240}?\}, \[\]\)/.exec(fm);
    ok(!!toggle, '有 onToggle（弹窗里点字的处理器）');
    ok(toggle && /setDraft\(/.test(toggle[0]), '  └ 它写的是草稿 setDraft');
    ok(toggle && !/onConfirm/.test(toggle[0]),
       '⚠⚠⚠ 它**不调 onConfirm**（勾一下就提交 = 点取消回不去，也违背「点击确定才筛选」）');
    ok(toggle && !/applied/.test(toggle[0]), '⚠⚠ 它**不碰**生效值 applied');

    /* 打开时必须**深拷**一份草稿，不能把生效那份的引用交过去 */
    ok(/if \(visible\) setDraft\(pf\.cloneFilter\(applied\)\)/.test(fm),
       '⚠⚠⚠ 打开时把生效筛选**深拷**成草稿（直接引用 = 草稿一勾，生效就跟着变了）');

    /* 「重置」只清草稿，不关窗不筛（否则点重置就直接生效了） */
    const resetBody = /const onReset = useCallback\([\s\S]{0,240}?\}, \[\]\)/.exec(fm);
    ok(resetBody && /setDraft\(pf\.emptyFilter\(\)\)/.test(resetBody[0]), '重置只清草稿');
    ok(resetBody && !/onClose|onConfirm/.test(resetBody[0]),
       '⚠⚠ 重置**不关窗、不筛**（还要点确定才算数）');

    /* 弹窗渲染读的是草稿，不是生效的那份 */
    ok(/draft\[cat\.param\]/.test(fm),
       '⚠⚠ 弹窗里渲染的勾选态来自**草稿**（用 applied 的话就变成「已经提交了」）');
    ok(/pf\.confirmText\(draft\)/.test(fm),
       '⚠ 确定按钮上的数量用草稿算（让用户点之前就知道选了几个）');

    /* ⚠⚠⚠ 提交只有一个出口：onConfirm 只许在「确定」按钮那一处被调用 */
    eq((fm.match(/onConfirm\(/g) || []).length, 1,
       '⚠⚠⚠ onConfirm 只有**确定按钮**这一处调用（多一处 = 有别的路能提交草稿）');

    /* 遮罩铺满（压住列表）+ 弹窗限高（矮屏上「确定」不能被挤出屏幕） */
    ok(/mask: \{[\s\S]{0,200}?backgroundColor: COLORS\.scrim/.test(fm),
       '⚠ 遮罩用的是全屏 scrim（压住列表）');
    ok(/if \(!visible\) return null;/.test(fm), '弹窗由 visible 控制显隐');
    ok(/maxHeight/.test(fm), '⚠⚠ 弹窗限高（否则小屏上按钮被顶出屏幕，点不到确定）');
  }

  /* ⑧-b 记录页侧：提交后怎么拉数据、入口什么时候给 */
  {
    /* 只有「确定」那一个入口能提交 */
    ok(/const onFilterConfirm = useCallback/.test(view), '有 onFilterConfirm（确定）');
    const confirmBody = /const onFilterConfirm = useCallback\([\s\S]{0,700}?\}, \[/.exec(view);
    ok(confirmBody && /model\.applyPlan\(/.test(confirmBody[0]),
       '⚠⚠ 确定走 model.applyPlan（是否要发请求这个决策抽在 model 里，可断言）');
    ok(confirmBody && /setFltOpen\(false\)/.test(confirmBody[0]), '  └ 确定后关窗');
    ok(confirmBody && /reloadWithFilter\(plan\.filter\)/.test(confirmBody[0]),
       '  └ 确定后才真的重拉（带新筛选）');
    /* ⚠ 草稿没变就别发请求 —— 对应 applyPlan 的 'close' 分支 */
    ok(confirmBody && /plan\.action === 'close'/.test(confirmBody[0]),
       '⚠ 草稿与生效一致时**不发请求**（省一次无谓往返）');

    /* 取消/遮罩 = 丢草稿关窗，且**不重拉** */
    const cancelBody = /const onFilterCancel = useCallback\([\s\S]{0,300}?\}, \[/.exec(view);
    ok(!!cancelBody, '有 onFilterCancel（取消 / 点遮罩）');
    ok(cancelBody && /setFltOpen\(false\)/.test(cancelBody[0]), '  └ 取消关窗');
    ok(cancelBody && !/reloadWithFilter|loadCloud/.test(cancelBody[0]),
       '⚠⚠⚠ 取消**不发请求**（取消 = 什么都没发生）');

    /* 打开：⚠ 深拷那一步已经搬进组件，本页只许开窗（不许顺手改生效值） */
    const openBody = /const onFilterOpen = useCallback\([\s\S]{0,300}?\}, \[/.exec(view);
    ok(openBody && /setFltOpen\(true\)/.test(openBody[0]), '打开弹窗');
    ok(openBody && !/filterRef\.current =/.test(openBody[0]), '⚠ 打开时**不碰**生效筛选');

    /* 用的是公用组件，入口的禁用/清除判据留在本页 */
    ok(/<FilterEntry/.test(view), '记录页用的是公用入口组件（<FilterEntry）');
    ok(/<FilterEntry[\s\S]{0,320}?disabled=\{!canFilter\}/.test(view),
       '⚠ 后端不支持筛选时入口不给点');
    ok(/<FilterEntry[\s\S]{0,320}?onReset=\{model\.hasFilter\(filter, nameKw, tagSel\) \? onResetFilter : undefined\}/.test(view),
       '⚠ 「清除筛选」只在真有筛选时给（没筛就没得清，还会让人以为点了能生效）——⚠ **标签也算筛选**，漏了它就会出现「按标签筛着、却给不出清除」');
    ok(/<FilterModal[\s\S]{0,400}?onConfirm=\{onFilterConfirm\}/.test(view),
       '记录页用的是公用弹窗组件（<FilterModal）');

    /* ⚠⚠⚠ 计数那句必须用**生效**筛选（`filter` + `nameKw` + `tagSel`）算，不能拿草稿：
       列表此刻显示的就是生效筛选的结果，拿草稿算会显示「筛出 5 例」而列表躺着 30 条。
       ⚠ 姓名也要算进去 —— 它在弹窗外面**已经生效**了，不算进来就会显示
         「共 30 例」而列表只有 3 条。标签同理（第三维，见 model.toQuery）。
       ⚠ 入口与弹窗两处必须**同源**（同一个表达式出现两次），
         一处改了另一处没改，就会出现「入口说共 30、弹窗说筛出 5」。 */
    eq(
      (view.match(/countText=\{model\.countText\(shownCount, totalAll, model\.hasFilter\(filter, nameKw, tagSel\)\)\}/g) || []).length,
      2,
      '⚠⚠ 入口与弹窗的计数同源且都用**生效**筛选（少一处 = 两处会各说各话）'
    );

    /* ================================================================
     * ⑧-c 工具区（标签栏 + 筛选入口 + 姓名行）的显示条件合成**一处**
     * ================================================================
     * ⚠⚠ 原来这个条件在 JSX 里写了两遍（工具栏一处、ScrollView 的
     *   contentContainerStyle 一处）—— 改一个忘另一个就出现「顶部白一段」。
     *   现在两处共用 `showTools`，那种错从结构上不可能再犯。
     * ⚠⚠ 判据里多加的两项各有理由，缺了都会出现**闪烁/死角**（见 showTools 注释）。
     */
    {
      const showTools = /const showTools =\s*\n([\s\S]{0,360}?);/.exec(view);
      ok(!!showTools, '工具区的显示条件收成一个 showTools 常量（不再在 JSX 里各写一份）');
      ok(showTools && /list\.length > 0/.test(showTools[1]), '  └ 有记录就显示（老行为）');
      ok(showTools && /canTags && \(tags\.length > 0 \|\| tagSel !== ''\)/.test(showTools[1]),
         '⚠⚠ 有标签 或 正按某个标签筛着也要显示 —— 换标签时 loadCloud 开头会 setList([])，' +
         '只看 list.length 的话工具区（含标签栏）会整块消失再冒出来，明显闪一下');
      ok(showTools && /model\.hasFilter\(filter, nameKw, tagSel\)/.test(showTools[1]),
         '  └ 有生效筛选也显示（否则筛空了连「清除筛选」那个出口都没了）');
      /* ⚠ 只许定义一次：写两份就是又回到「改一个忘另一个」的老坑 */
      eq((view.match(/const showTools =/g) || []).length, 1, '⚠ showTools 只定义一次');

      ok(/\{showTools \? \(\s*<View style=\{s\.toolBar\}>/.test(view),
         '⚠⚠ 工具栏整块由 showTools 控制（判据只有这一处）');
      ok(/contentContainerStyle=\{[\s\S]{0,240}?showTools \? \[s\.page, s\.pageWithTools\] : s\.page/.test(view),
         '⚠⚠⚠ 补顶部留白用的是**同一个** showTools（各写一份条件 ⇒ 改一个忘一个就白一段）');
      /* ⚠⚠⚠ 反向钉死：contentContainerStyle 里**不许**再把条件重写一遍 */
      {
        const ccs = /contentContainerStyle=\{([\s\S]{0,400}?)\}\s*\n/.exec(view);
        ok(!!ccs, 'contentContainerStyle 那一段能切出来');
        ok(ccs && !/list\.length > 0/.test(ccs[1]),
           '⚠⚠⚠ contentContainerStyle 里不许重写一遍显示条件（重写 = 又回到「两处各判一次」）');
      }
    }
  }

  /* ================================================================
   * ⑧-d 记录页的**自定义标签**接线（源码级）
   * ================================================================
   * ⚠ 纯函数（model.tagQuery / tagBar / planNewTag / tagNameOf）在别处断言，
   *   这一组只守「视图有没有真的把它接起来」—— 那正是最容易被漏掉的一环：
   *   面板画得漂漂亮亮、点击也改了 state，但**请求没发出去 / 结果没重拉**。
   */
  {
    /* ① 标签栏：左边可滑的筛选项 + 右边**固定**的「管理」
       （点一格就地生效 —— 与筛选弹窗的「点确定才生效」刻意相反） */
    ok(/<TagBar[\s\S]{0,220}?items=\{model\.tagBar\(tags, untagged, tagSel\)\}[\s\S]{0,160}?onPick=\{onTagBarPick\}/.test(view),
       '⚠ 标签栏的条目由 model.tagBar 算（计数/顺序都在纯函数里，可断言）');
    /* ★ 2026-10-05：标签栏**常驻**（用户反馈「记录页怎么没有标签功能」）——
       上一版要求在 `tags.length > 0 || tagSel !== ''` 时才显示，代价是用户压根不知道
       这页有标签功能（顶部一直空着，入口只剩卡片上那行小灰字）。 */
    ok(/\{canTags \? \(\s*<TagBar/.test(view),
       '⚠⚠⚠ 标签栏**常驻**：判据只有 canTags（不许再挂「已经有标签」这类条件）——' +
       '一枚标签都没建时也要看得见，否则「标签功能在哪」这个问题会再来一次');
    ok(/onManage=\{onTagManage\}/.test(view),
       '  └ 右端那枚**固定**的「管理」接到 onTagManage（一枚标签都没有时它是唯一的标签入口）');
    /* ⚠⚠⚠ 「固定在右侧、不许滑动」是**结构**保证（见下面 ⑨-b 读组件源码那几条）：
       这里先钉死入口本身 —— 旧的 `onNew` / `onTagNew` 一个都不许留（语义已从「新建」变成「管理」）。 */
    ok(!/onTagNew|onNew=/.test(view),
       '⚠⚠ 旧的 `onNew` / `onTagNew` 全删（文案与语义都已变：那一枚现在叫「管理」）');
    ok(/const onTagManage = useCallback\(\(\) => \{[\s\S]{0,200}?setTagOpen\(true\)/.test(view),
       '⚠ `onTagManage` = 直接开管理面板（**不再有** `tagFor` 那套「这次有没有目标记录」的分支）');
    ok(/model\.tagBar\(tags, untagged, tagSel\)/.test(view) && !/list\.length/.test(
      (/<TagBar items=\{[^}]*\}/.exec(view) || [''])[0]),
       '⚠⚠ 标签栏的计数**不拿 list.length 当分母**（列表此刻已经是筛过的，那是假数字）');

    /* ② 点标签栏：⚠⚠ 先写 ref 再 loadCloud（loadCloud 是同步读 ref 的） */
    {
      const pick = /const onTagBarPick = useCallback\(\(key: string\) => \{([\s\S]*?)\}, \[loadCloud\]\)/.exec(view);
      ok(!!pick, '找得到 onTagBarPick（点标签栏某一格）');
      ok(pick && /tagSelRef\.current = next/.test(pick[1]), '  └ 写生效 ref');
      ok(pick && /setTagSel\(next\)/.test(pick[1]), '  └ 也同步 state（标签栏高亮要重渲染）');
      ok(pick && /if \(next === tagSelRef\.current\) return;/.test(pick[1]),
         '⚠ 点的就是当前那一格 ⇒ 不发请求（否则每次手滑点一下都白跑一趟）');
      ok(pick && pick[1].indexOf('tagSelRef.current = next') < pick[1].indexOf('loadCloud('),
         '⚠⚠⚠ 顺序不能换：**先写 ref 再 loadCloud** —— 反了的话这次请求带的是上一格的标签' +
         '（现象：点了「客户」，列表却是「全部」）');
      ok(pick && /keepTotal: true/.test(pick[1]),
         '⚠ 带标签重拉时不动「共 N 例」的分母（标签栏的计数来自 /tags，不是列表长度）');
    }

    /* ③ 卡片上的标签 chip：**只读**（2026-10-05 用户要求「列表中的 + 标签去掉」）
        ⚠ 位置在**名字右侧**（2026-10-10 用户：「标签应该放在名字的右侧」，
          不再自己占一行 —— 那样卡片竖着摊成四层太分散） */
    {
      ok(/const tagName = model\.tagNameOf\(tags, item\.tagId\)/.test(view),
         '⚠ 那枚 chip 的文字从 **tags 列表**算（记录上只有个只读派生 tagId）；' +
         '取不到就给空串 ⇒ 不画 chip，下次刷新自愈（core/tags.js nameOf 的口径）');
      ok(/canTags && tagName \? \(/.test(view),
         '⚠⚠ 没有标签就**整行不渲染**（不画「未分类」占位 —— 那是一行零信息）');
      ok(/canTags && tagName \? \(\s*<View style=\{s\.tagChip\}>/.test(view),
         '⚠⚠⚠ 它是 **View**、不是 Pressable —— 列表里哪儿都不能改标签（用户明确要求去掉那个入口）');
      ok(!/onPress=\{\(\) => onTagOpen\(item\)\}/.test(view),
         '⚠⚠⚠ 旧入口「点卡片那行开归类面板」必须删干净 —— 留着它 = 用户仍能从列表改标签');
      ok(!/tagAddText|tagPlus/.test(view),
         '  └ 旧的「＋ 标签」与小「＋」（文案 + 样式）一并删掉');
      /* 2026-10-10：chip 搬进名字那一行，独占一行的 tagRow 整个删掉 */
      ok(!/s\.tagRow\b/.test(view),
         '⚠⚠ 独占一行的 s.tagRow 已删（2026-10-10 用户：太分散，标签放名字右侧）');
      const nameRow = /<View style=\{s\.recNameRow\}>([\s\S]*?)<\/View>\s*<Text style=\{s\.recSub\}>/.exec(view);
      ok(!!nameRow, '找得到「名字 + 标签」那一行（recNameRow）');
      ok(nameRow && nameRow[1].indexOf('s.recName') < nameRow[1].indexOf('s.tagChip'),
         '⚠⚠⚠ 行内顺序 = **名字在前、chip 在后**（用户要求：标签放在名字的**右侧**）');
      ok(/recName: \{[^}]*flexShrink: 1/.test(view) &&
         /tagChip: \{[^}]*flexShrink: 0/.test(view),
         '⚠ 名字可缩（flexShrink:1）、chip 不可压（flexShrink:0）—— 长名字缩名字，chip 恒完整');
      ok(/recNameRow: \{/.test(view) && !/recNameRow: \{[^}]*nameRow/.test(view),
         '⚠ 样式名叫 recNameRow —— 绝不能叫 nameRow（那是姓名查询行的名字，' +
         '重名会让「ScrollView 里不许有 s.nameRow」那条断言假红）');
    }

    /* ④ 本页**没有**归类那条路（applyTag / onTagPick / tagFor 全删） */
    ok(!/applyTag|onTagPick|tagFor/.test(view),
       '⚠⚠⚠ 记录页已经没有归类功能（`applyTag` / `onTagPick` / `tagFor` 全删）——' +
       '换标签**只**在排盘结果的「详细信息 → 标签」里（用户 2026-10-05 定）');

    /* ⑤ 新建：**只建不归类**（本页唯一的标签写操作） */
    {
      const create = /const onTagCreate = useCallback\(\(name: string\) => \{([\s\S]*?)\}, \[([\s\S]*?)\]\)/.exec(view);
      ok(!!create, '找得到 onTagCreate');
      ok(create && /model\.planNewTag\(tags, name\)/.test(create[1]),
         '⚠⚠ 走 model.planNewTag（非法名 / 重名两个分支可断言，别散在视图里）');
      ok(create && /plan\.action === 'none'/.test(create[1]) && /plan\.action === 'select'/.test(create[1]),
         '  └ 两个分支都处理了（none / select）');
      ok(create && /tagsLib\.newId\(\)/.test(create[1]) &&
         /tagsLib\.create\(plan\.name, \{ id: id \}\)/.test(create[1]),
         '⚠ id 在客户端生成、建的时候一起给它 —— 失败重试要沿用同一个，否则会多建一个');
      ok(create && /setTagOpen\(false\)[\s\S]{0,90}?loadTags\(\)/.test(create[1]),
         '⚠ 建完关窗 + 重拉标签（`count` 与「全部」那一格的分母都变了）');
      ok(create && !/applyTag/.test(create[1]) && !/if \(cur\)/.test(create[1]),
         '⚠⚠⚠ 建完**不再顺手归类** —— 这一页没有目标记录，只建不归类' +
         '（旧的 `if (cur) { applyTag(...) } else { … }` 那套一并删掉）');
      ok(create && /setTagErr\('已经有「' \+ plan\.name \+ '」这个标签了'\)/.test(create[1]),
         '⚠ 撞重名（select 分支）**必须如实说一句** —— 这一页没有「直接选中它」这回事，' +
         '不说的话用户打完字按了新建、界面毫无反应（他会以为功能坏了）');
    }

    /* ⑥ 改名：⚠ 只 setTags，**不重拉记录**（名字只有一份，卡片 chip 自己会变） */
    {
      const ren = /const onTagRename = useCallback\(\(id: string, name: string\) => \{([\s\S]*?)\}, \[\]\)/.exec(view);
      ok(!!ren, '找得到 onTagRename');
      ok(ren && /tagsLib\.rename\(id, name\)/.test(ren[1]), '  └ 走 core/tags.js 的 rename');
      ok(ren && /setTags\(\(prev: any\[\]\) => tagsLib\.upsert\(prev, r\.tag\)\)/.test(ren[1]),
         '  └ 就地并进 tags（重拉是异步的，会慢半拍）');
      ok(ren && !/loadCloud/.test(ren[1]),
         '⚠⚠⚠ 改名**不重拉记录** —— 名字只存在 tags 那一行，卡片那枚 chip 由 tags 算出来，' +
         'setTags 之后自己就变了；重拉一次只会让列表闪一下（loadCloud 开头会 setList([])）');
    }

    /* ⑦ 删标签：⚠ 正按它筛着就必须退回「全部」（否则用户彻底不知道自己在看什么） */
    {
      const rem = /const onTagRemove = useCallback\(\(id: string\) => \{([\s\S]*?)\}, \[loadCloud\]\)/.exec(view);
      ok(!!rem, '找得到 onTagRemove');
      ok(rem && /tagsLib\.remove\(id\)/.test(rem[1]), '  └ 走 core/tags.js 的 remove');
      ok(rem && /setTags\(\(prev: any\[\]\) => tagsLib\.drop\(prev, id\)\)/.test(rem[1]),
         '  └ 就地移出 tags');
      ok(rem && /if \(tagSelRef\.current === id\)/.test(rem[1]),
         '⚠⚠⚠ 删的正是此刻筛着的那个标签 ⇒ 必须把筛选退回「全部」——' +
         '那个标签已经没有记录了，继续按它筛只会是一片空白，而标签栏上那一格也没了' +
         '（用户会彻底不知道自己在看什么、也不知道怎么退出来）');
      ok(rem && /loadCloud\(\{ keepTotal: true \}\)/.test(rem[1]),
         '  └ 删完重拉（记录本身还在，只是回到未分类）');
    }

    /* ⑧ 管理面板：公用组件 + 也是 ScrollView 的**兄弟**；本页只以 `mode="manage"` 用它 */
    ok(/<TagPicker\b/.test(view), '标签面板是公用组件（<TagPicker）');
    ok(/<TagPicker[\s\S]{0,120}?visible=\{tagOpen\}/.test(view), '  └ 由 tagOpen 控制显隐');
    /* ★ 2026-10-05：本页**只剩管理形态**（`mode="manage"`）—— 只建 / 改名 / 删，不归类。
       「能选但不能改」那一态（`'pick'`）归**结果页**用（见 ⑭ 那组断言）。 */
    ok(/<TagPicker[\s\S]{0,900}?mode="manage"/.test(view),
       '⚠⚠⚠ 本页只以 `mode="manage"` 出现 —— 只建 / 改名 / 删；归类在结果页，两件事不许混');
    ok(!/manage=\{!tagFor\}/.test(view) && !/currentId=\{tagFor/.test(view),
       '  └ 旧的 `manage={!tagFor}` / `currentId` 那套一并删掉（本页没有「目标记录」这个概念）');
    ok(/<TagPicker[\s\S]{0,300}?title="标签管理"/.test(view),
       '  └ 标题就是「标签管理」（这一页只有这一种，不再有「把「张三」归到」）');
    ok(/<TagPicker[\s\S]{0,900}?busy=\{tagBusy\}/.test(view) && /<TagPicker[\s\S]{0,900}?err=\{tagErr\}/.test(view),
       '⚠ busy / err 由**本页**喂进去（权威只有一份：本页的 tags；组件里不存副本、也不发请求）');
    ok(!/onPick=\{onTagPick\}/.test(view),
       '⚠⚠ 不传 `onPick` —— manage 态根本不会调它，传了就是留一条**死路**（将来有人会以为那条路还活着）');

    /* ⑨-b 面板自己那两个模式（**源码级**，读组件文件）——
       上面只钉了「本页把 manage 传进去了」；「传进去之后组件真的按它行事」是另一回事。
       ⚠ 传了参数却不用的组件最坑：页面看着全对、行为全错，而且没人会发现。
       ⚠ 先 stripComments：本组件文件里到处都写着 `manage` / `onNew` 这些词，
         不剥注释的话下面每条断言都可能被**注释里的同一串字符**弄成假绿。 */
    {
      const picker = stripComments(
        fs.readFileSync(path.join(ROOT, 'src', 'components', 'TagPicker.tsx'), 'utf8')
      );

      /* TagBar：左边可滑、右边**固定**的「管理」 */
      ok(/onManage\?: \(\) => void/.test(picker),
         '⚠ TagBar 的 onManage 是可选属性（别的页只拿它做筛选时不必给）');
      ok(/\{onManage \? \(/.test(picker), '  └ 那一格由 onManage 存在与否决定渲染');
      ok(/<Text style=\{s\.chipManageText\}>管理<\/Text>/.test(picker),
         '  └ 那一格的文案是「管理」（上一版叫「＋ 新建标签」）');
      /* ⚠⚠⚠ 「固定在右侧、不许滑动」= **结构**：左段 ScrollView 自己滚，
         那一颗在 ScrollView **外面**（同一行、贴右）。
         ⚠ 塞进 ScrollView 里时页面照样能跑、也照样能滑 —— 只是标签一多它就滑出屏幕
           看不见了。那正是上一版的真实毛病（用户 2026-10-05 明确要求「固定」）。 */
      ok(/<View style=\{s\.barRow\}>[\s\S]*?<ScrollView[\s\S]*?<\/ScrollView>[\s\S]*?\{onManage \? \(/.test(picker),
         '⚠⚠⚠ 「管理」在 ScrollView **外面**（同一行、贴右）—— 塞进滚动区就会随标签一起滑走');
      ok(/barScroll: \{ flex: 1, minWidth: 0 \}/.test(picker),
         '  └ 左段 ScrollView 自己 `flex: 1` + `minWidth: 0`' +
         '（少 minWidth 会被内容顶出去，右侧那颗「管理」反过来被挤出屏幕）');
      ok(/chipManage: \{[\s\S]{0,220}?marginRight: 0/.test(picker),
         '  └ 右侧那颗不吃 `marginRight`（它在行尾，右边那份间距归 barWrap 管）');

      /* TagPicker：两态（`mode`）—— 只由这一个参数决定 */
      ok(/mode = 'pick'/.test(picker), '⚠⚠ `mode` 默认 `pick`（结果页那条路：只能换）');
      ok(/const isManage = mode === 'manage'/.test(picker), '  └ 两态由 `mode` 一个参数决定');
      ok(/const canPick = !isManage/.test(picker) && /const canEdit = isManage/.test(picker),
         '⚠⚠ 拆成两个派生量 —— 「不给编辑」与「不给归类」是两件事，' +
         '绑成一个开关时结果页要的「能选、但不能改」根本表达不出来');

      /* pick 态（★ 结果页）：能选 / 能取消归类；**不给**建 / 改名 / 删 */
      ok(/\{canPick && editingId !== 'none' \? \(/.test(picker),
         '⚠ pick 态才渲染「未分类」那一格（它就是「取消归类」）');
      ok(/const on = canPick && t\.id === currentId;/.test(picker),
         '⚠ pick 态才给「当前」高亮 —— 没有目标记录时亮了就是**假信息**');
      ok(/if \(!busy && canPick\) onPick\(t\.id\);/.test(picker) && /disabled=\{busy \|\| !canPick\}/.test(picker),
         '⚠ pick 态才可点标签行（manage 态点了不归类，disabled 一起钉）');
      ok(/\{canEdit \? \(\s*<>[\s\S]{0,400}?改名[\s\S]{0,240}?删除/.test(picker),
         '⚠⚠⚠ 改名 / 删除两个按钮**只在 manage 态**出现 —— 结果页要的是' +
         '「只能更换标签，不能删除和改名标签」（用户 2026-10-05 原话）');
      ok(/\{canEdit \? \(\s*<View style=\{s\.newRow\}>/.test(picker),
         '⚠⚠⚠ 新建输入框**只在 manage 态**出现（同理：结果页不给建标签）');

      /* 空态与底部那半句：两态各不同（都必须是「下一步该去哪」） */
      ok(/list\.length === 0 \? \(\s*<Text style=\{s\.emptyHint\}>/.test(picker),
         '⚠ 一条标签都没有时给一句方向（空面板 + 一个输入框，不给方向用户不知道这儿干嘛的）');
      ok(/isManage\s*\?\s*'还没有标签 —— 在下面输入名字新建一个'/.test(picker),
         '  └ manage 态：告诉他在下面输入框里建');
      ok(/'还没有标签 —— 去记录页顶部的「管理」里新建'/.test(picker),
         '  └ pick 态：告诉他在**哪儿**建（这一页刻意不提供建 / 改 / 删）');
      ok(/isManage\s*\?\s*'\\n归类在「排盘结果 → 详细信息 → 标签」里改'/.test(picker),
         '⚠⚠ manage 态底部必须说**去哪儿归类** —— 列表卡片上那个入口已经删了，' +
         '不说他就会一直翻这一页找（同族教训：入口隐身 = 用户以为功能没有）');
      ok(/'\\n要新建 \/ 改名 \/ 删除，去记录页顶部的「管理」'/.test(picker),
         '  └ pick 态底部说**去哪儿建 / 改 / 删**');
    }

    /* ⑩ 清除筛选：标签是**第三个维度**，必须跟干支、姓名一起清 */
    {
      const reset = /const onResetFilter = useCallback\(\(\) => \{([\s\S]*?)\}, \[reloadWithFilter\]\)/.exec(view);
      ok(!!reset, '找得到 onResetFilter');
      ok(reset && /tagSelRef\.current = ''/.test(reset[1]) && /setTagSel\(''\)/.test(reset[1]),
         '⚠⚠ 清除筛选要**连标签一起清** —— 只清干支和姓名而留着标签，用户点完「清除筛选」' +
         '列表还是筛过的、标签栏那一格还亮着，那句话就成了骗人的（同「只清干支留着姓名」）');
      ok(reset && /model\.hasFilter\(filterRef\.current, nameRef\.current, tagSelRef\.current\)/.test(reset[1]),
         '  └ 判据也是三维（否则按标签筛着时点清除会直接 return，什么都不发生）');
    }

    /* ⑪ 标签拉取与记录拉取**并行且互不牵连** */
    ok(/Promise\.all\(\[history\.pull\(query, opt\), loadTags\(\)\]\)/.test(view),
       '⚠⚠ 标签与记录**并行**拉 —— 标签调失败不许把记录列表一起打成失败（两样东西要能分别诊断）');
    ok(/if \(!canTags\) return Promise\.resolve\(\)/.test(view),
       '⚠ 后端不支持标签时**一个请求都不发**（不是发个必然 404 的再看「加载失败」）');

    /* ================================================================
     * ⑫ 记录页**懒加载 / 分页**（★ 用户要求：
     *    「记录页面的懒加载做了没有？」→「现在54条，可是后面就会变多」）
     * ================================================================
     * ⚠⚠ 这一组守的是四条**彼此独立**的红线，各自都能单独造成
     *   「列表少一截」或者「永远在拉同一页」，而且**四种写坏的样子都不报错**：
     *     ① 每次请求都要显式给 limit（服务端「不传 limit = 全量」）
     *     ② 有没有下一页只认服务端的 `paged` + `total`（不认「这次满没满一页」）
     *     ③ 位次按**服务端返回条数**推进（不是 list.length —— 去重后两者不等）
     *     ④ 续拉回来先比**代次**，过期结果整份丢掉（否则上一份列表的一页会混进来）
     */
    const M = recordsModel;

    /* --- 纯函数：还有没有下一页 --- */
    eq(M.hasMore(50, 200, true), true, '满一页 + 服务端说还有 ⇒ 还要续拉');
    eq(M.hasMore(150, 200, true), true, '倒数第二页（150/200）⇒ 还要续拉');
    eq(M.hasMore(200, 200, true), false,
       '⚠⚠ 回到 total 了就是到底了 —— **不许**用「这次返回满没满一页」判（最后一页正好装满时会多拉一次空页）');
    eq(M.hasMore(0, 0, true), false, '一条都没有 ⇒ 没有下一页');
    /* ⚠⚠ 非分页驱动（cloudbase / cloud / gitee）压根不认 limit/offset，一次给全量、
       回 `paged:false`、也不回 total ⇒ 必须判「没有下一页」。
       判成「有」的话上层会拿着同一个 offset 一直要 ⇒ **无限拉同一页**。 */
    eq(M.hasMore(50, 200, false), false, '⚠⚠ 服务端没切片（paged:false）⇒ 一律判「没有下一页」');
    eq(M.hasMore(50, undefined, true), false, '⚠⚠ 没有 total ⇒ 保守判「没有下一页」');
    eq(M.hasMore(50, 200, undefined), false, '⚠⚠ 连 paged 都没有（老服务端）⇒ 保守判「没有下一页」');

    /* --- 纯函数：页参数 --- */
    eq(M.pageOpt(0), { limit: M.PAGE_SIZE, offset: 0 }, '第一页：offset=0');
    eq(M.pageOpt(150), { limit: M.PAGE_SIZE, offset: 150 }, '第三页：offset=150');
    eq(M.pageOpt(-5), { limit: M.PAGE_SIZE, offset: 0 }, '⚠ 负数位次 ⇒ 退回第一页');
    eq(M.pageOpt(NaN), { limit: M.PAGE_SIZE, offset: 0 },
       '⚠⚠ NaN 位次 ⇒ 退回第一页（宁可多显示一页，也不要发 ?offset=NaN 让服务端去猜）');
    eq(M.pageOpt(undefined), { limit: M.PAGE_SIZE, offset: 0 }, '⚠ 不给位次 ⇒ 第一页');

    /* --- 纯函数：「共 N 例」的分子 --- */
    eq(M.countShown(50, 200), 200,
       '⚠⚠⚠ 有服务端 total 时用它 —— 直接拿 list.length 会把 200 条说成「共 50 例」');
    eq(M.countShown(50, undefined), 50, '没给 total（非分页驱动一次给全量）⇒ 退回列表长度');
    eq(M.countShown(0, 0), 0, '空列表 + total=0 ⇒ 0');

    /* --- 纯函数：底部那行 --- */
    eq(M.footText({ loading: true, hasMore: true, total: 200 }), '正在加载…', '续拉中 ⇒ 「正在加载…」');
    eq(M.footText({ loading: false, hasMore: true, total: 200 }), '',
       '⚠ 还有下一页但还没触发 ⇒ **不显示字**（滚到底会自动拉，写「上拉加载更多」是多余指令）');
    eq(M.footText({ loading: false, hasMore: false, total: 200 }), '没有更多了', '到底了 + 真的分过页 ⇒ 「没有更多了」');
    eq(M.footText({ loading: false, hasMore: false, total: 3 }), '',
       '⚠ 本来就只有一页 ⇒ 不写「没有更多了」（3 条记录后面跟一句「没有更多了」纯属噪音）');
    eq(M.footText({ loading: false, hasMore: false, total: M.PAGE_SIZE }), '',
       '⚠ 正好一页整（没分过页）⇒ 同样不说');
    eq(M.footText({ err: true, loading: true, hasMore: true, total: 200 }), '加载失败 · 点此重试',
       '⚠⚠ 失败态优先级最高 —— 失败被「正在加载…」盖住的话，用户只会看着圈一直转');

    /* --- 纯函数：滚到底判据 --- */
    /* 内容 2000、窗口 800、已滚 700 ⇒ 离底部还有 500 > 提前量 420 */
    eq(M.nearBottom(700, 800, 2000, 420), false, '离底部还有 500 ⇒ 不触发');
    eq(M.nearBottom(800, 800, 2000, 420), true, '离底部 400 ⇒ 触发（提前量 420）');
    eq(M.nearBottom(1200, 800, 2000, 420), true, '已经在底部 ⇒ 触发');
    eq(M.nearBottom(undefined, 800, 2000, 420), false,
       '⚠⚠ 拿不到滚动位置就判「没到」—— 判成「到了」会在列表还没铺开时抢跑，一次把后面几页全拉下来');
    /* ⚠⚠⚠ 这一条**必须拿 Infinity 撞，不能用 NaN** ——
       NaN 会自然传播成 `NaN <= gap → false`，把 isFinite 守卫整行删掉它照样返回 false
       （**哑断言**；2026-10-11 负向探针实测抓出来的）。
       Infinity 才真的翻：`contentH - (Infinity + viewH) = -Infinity <= gap` **恒真**
       ⇒ 判成「到了」⇒ 列表还没铺开就抢跑，一次把后面几页全拉下来。 */
    eq(M.nearBottom(Infinity, 800, 2000, 420), false, '⚠⚠ 无穷大的滚动位置 ⇒ 判「没到」（不许抢跑）');
    /* ⚠ 提前量自己也要撞 Infinity：不认它的话提前量就成了无穷大 ⇒ 永远判「到了」。 */
    eq(M.nearBottom(700, 800, 2000, Infinity), false,
       '⚠⚠ 提前量是无穷大 ⇒ 不认它（按「必须真到底」算），否则永远判「到了」');

    /* --- 纯函数：拼下一页（按 id 去重） --- */
    eq(M.appendUnique([{ id: 'a' }], [{ id: 'b' }]).map(function (x) { return x.id; }),
       ['a', 'b'], '新一页接在后面');
    eq(M.appendUnique([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]).map(function (x) { return x.id; }),
       ['a', 'b'], '⚠ 重叠的那条只留一份（另一台设备刚插一条时 offset 分页会带回它）');
    eq(M.appendUnique(null, [{ id: 'a' }]).length, 1, '⚠ 首次（手上还没有列表）也走同一条路');
    eq(M.appendUnique([{ id: 'a' }], null).length, 1, '⚠ 空页不炸');
    const prevArr = [{ id: 'a' }];
    M.appendUnique(prevArr, [{ id: 'b' }]);
    eq(prevArr.length, 1,
       '⚠ 不许就地改调用方那份数组 —— 原地 push 的话 React 看到的是同一个引用，界面不会更新');

    /* --- 视图：每次请求都显式给 limit --- */
    ok(/model\.pageOpt\(offsetRef\.current\)/.test(view),
       '⚠⚠ 每次请求都显式带 limit/offset（漏带一次 = 服务端按「全量」返回，懒加载白做**且不报错**）');
    ok(/history\.pull\(query, opt\)/.test(view), '  └ 分页参数交给 history.pull（第二参）');

    /* --- 视图：位次怎么推进 --- */
    ok(/const got = Array\.isArray\(res\.records\) \? res\.records\.length : 0/.test(view),
       '⚠ 续拉回来的条数按**服务端返回**的算，不是 withSummaries 之后的');
    ok(/offsetRef\.current \+= got/.test(view),
       '⚠⚠⚠ 位次按服务端返回条数推进 —— 拿 list.length 当位次（去重后会更小）会退回去重拉同一条 ⇒ **原地死循环**');

    /* --- 视图：还有没有下一页 --- */
    ok(/model\.hasMore\(offsetRef\.current, total, res\.paged\)/.test(view),
       '⚠ 判据交给 model.hasMore（只认服务端的 paged + total，不认「这次满没满一页」）');

    /* --- 视图：替换型 vs 续拉 --- */
    ok(/const req = append[\s\S]{0,60}?history\.pull\(query, opt\)/.test(view),
       '⚠ 续拉复用同一条路（按 append 分支：续拉不带标签、不动「正在同步」那条）');
    ok(/if \(gen !== genRef\.current\) return;/.test(view),
       '⚠⚠⚠ 续拉回来先比代次，过期结果**整份丢掉** —— 不丢的话上一份列表的一页会被追加到新列表尾巴上，界面有数据、日志干净');
    ok(/genRef\.current \+= 1/.test(view), '  └ 替换型请求（首屏 / 换筛选 / 下拉刷新）把代次 +1');
    ok(/offsetRef\.current = 0/.test(view),
       '⚠ 替换型请求在**发请求之前**就把位次归零（等响应回来才归零的话，那半秒里发出的续拉会带旧位次）');

    /* --- 视图：续拉的两道闸 --- */
    ok(/if \(!moreRef\.current \|\| loadingMoreRef\.current\) return;/.test(view),
       '⚠⚠ 续拉两道闸：服务端说还有下一页 + 同时只许一个在飞（onScroll 一屏能触发几十次）');
    ok(/loadingMoreRef\.current = true;/.test(view),
       '⚠ 闸门用 **ref** 记而不是 state（state 要等下一次渲染，同一帧连发时那道闸形同虚设）');

    /* --- 视图：滚动触发 --- */
    ok(/onScroll=\{onListScroll\}/.test(view),
       '⚠⚠ ScrollView 上真的挂了 onScroll（PullRefresh 会把它 cloneElement 时**并**到自己那份后面，两者共存）');
    ok(/model\.nearBottom\(y, viewH, contentH, LOAD_MORE_GAP\)/.test(view),
       '  └ 判据走 model.nearBottom（纯函数，别在视图里就地算）');

    /* --- 视图：底部那行 --- */
    ok(/const footLabel = model\.footText\(/.test(view), '底部那行的文案来自 model.footText');
    ok(/\{footLabel \? \([\s\S]{0,400}?disabled=\{!moreErr\}/.test(view),
       '⚠ 底部那行**只有失败态可点**（「正在加载…」点了没反应比不给更糟）');
    ok(/if \(append\) \{\s*setMoreErr\(true\);/.test(view),
       '⚠⚠ 续拉失败只在底部写一句，**不**把已经显示出来的那一屏打成失败态');
    ok(/foot: \{[\s\S]{0,120}?alignItems: 'center' \}/.test(view),
       '底部那行是居中一段灰底小字（不做成白方块 —— 会被当成「还有一张卡片」去点）');

    /* --- 视图：计数口径 --- */
    ok(/const shownCount = model\.countShown\(list\.length, pageTotal\)/.test(view),
       '⚠⚠「共 N 例」的分子走 model.countShown（首屏只有一页，直接拿 list.length 会说成「共 50 例」）');
    ok(!/countText=\{model\.countText\(list\.length/.test(view),
       '⚠⚠ 入口与弹窗两处 countText 都**不许**再拿 list.length 当分子');
    ok(/model\.appendUnique\(prev, items\)/.test(view),
       '  └ 拼下一页走 model.appendUnique（视图里那个 `.filter(` 是红线，见上一条断言）');

    /* ================================================================
     * ⑫-b 分页参数**逐层透传**（视图 → history → userStore → store → 驱动）
     * ================================================================
     * ⚠⚠⚠ 这一小节是**补漏**：链路中间只要有一层把 `opt` 吞掉、
     *   或者把服务端的 `total`/`paged` 剥掉，整条分页就**静默失效** ——
     *   每一层单看都对、没有一层报错，列表照样显示，只是永远停在第 1 页。
     *   2026-10-11 真实踩过：前一轮只改了 store 那三层，
     *   `userStore.listRecords` 的**签名就写死了两个参数** ⇒ 白干。
     * ⚠ local-check 对分页**零覆盖**，所以这几条源码级断言是唯一的网 ——
     *   将来谁再改一次这个签名，必须在这里红一次。
     */
    const ustore = read('src/core/userStore.js');
    ok(/function listRecords\(uid, filter, opt\)/.test(ustore),
       '⚠⚠ userStore.listRecords 的签名必须**收下 opt**（写死两参 = 分页参数在这一跳蒸发）');
    ok(/store\.listRecords\(uid, filter, opt\)/.test(ustore),
       '⚠⚠⚠ 且必须把它**转给 store** —— 只收不用是最容易发生的「改了但没效果」');
    ok(/if \(typeof res\.total === 'number'\) out\.total = res\.total;/.test(ustore),
       '⚠⚠⚠ userStore 必须把 `total` 带回来（它原来只挑出 records 就返回 —— '
       + '上层于是永远拿不到「总共多少」，只能靠「这次拿到几条」蒙，看起来一切正常）');
    ok(/if \(res\.paged === true\) out\.paged = true;/.test(ustore),
       '⚠⚠ 且必须把 `paged` 带回来（判「还有没有下一页」的前提；它同时是「非分页驱动」的识别位）');
    ok(!/out\.total = res\.records\.length/.test(ustore),
       '⚠⚠ 不许在 userStore 里替服务端编 total（非分页驱动没给就是没给，编一个会让上层误判）');

    ok(/if \(opt && opt\.limit != null\)/.test(ldb),
       '⚠⚠ localdb 只在**真的给了 limit** 时才加分页参数（不传 limit = 全量是服务端口径，别绕过它）');
    ok(/q\.limit = String\(opt\.limit\)/.test(ldb) && /q\.offset = String\(opt\.offset\)/.test(ldb),
       '⚠⚠ limit 与 offset 一起拼进 query（只给 limit 不给 offset ⇒ 每次都在拉第一页）');
    ok(/const q = Object\.assign\(\{\}, filter \|\| \{\}\)/.test(ldb),
       '⚠ 拼在**新对象**上，别改调用方传进来的那份 filter（它可能正好是组件里的 state 引用）');
    ok(/total: typeof d\.total === 'number' \? d\.total : d\.records\.length/.test(ldb),
       '⚠⚠ 服务端没回 total 时退成「这次拿到的条数」—— 宁可保守判「没有下一页」，也不凭空造个大数');
    ok(/paged: d\.paged === true/.test(ldb),
       '⚠⚠ 只有服务端**明说 true** 才算切片返回（别的真值、字符串都当没分页）');
  }


  /* ================================================================
   * ⑨ 筛选工具栏**钉在列表上方**（★ 用户要求：
   *    「记录页面的筛选功能，要始终在顶部，不能因为滑到下面就看不到了」）
   * ================================================================
   * ⚠⚠ 这一组守的是**位置**，不是内容：
   *   「筛选」与「姓名查询」两行**整体**必须是 ScrollView 的**兄弟**
   *   （压在上面、不跟随滚动），而不是它的内容。
   *   写坏的样子也**完全不报错** —— 只是滑下去就看不见了，
   *   而每个入口单独看都是「画对了」的。
   *   ⇒ 判据必须能认出「这两行的 JSX 在 <ScrollView> **之前**」这件事，
   *     不能只查「文件里出现了 toolBar / 出现了 fltEntry」。
   */
  {
    /* 切片顺序：[工具栏] … { <ScrollView … } … 列表 …… { </ScrollView> } … [弹窗] */
    const iBar = view.indexOf('style={s.toolBar}');
    /* ⚠ 用 `contentContainerStyle={` 当 ScrollView 的锚 —— 「<ScrollView」在文件里
       有两处（列表 + 弹窗里的类别区），直接找会抓错；`contentContainerStyle` 只有列表有。
       ⚠ 锚点选 `contentContainerStyle={` 而不是整行 —— 整行在「有/无工具栏」两种分支下
       不再唯一（改成三元分支后那一行的字面量变了）。 */
    const iScrollOpen = view.indexOf('contentContainerStyle={');
    /* ⚠ </ScrollView> 也出现两次（列表 + 弹窗类别区）⇒ 从列表那个开标签**之后**找第一个 */
    const iScrollClose = view.indexOf('</ScrollView>', iScrollOpen);
    /* ⚠ 弹窗那一段的锚用 `visible={fltOpen}`（2026-10-04 起弹窗是公用组件，
       字形从 `{fltOpen ? (` 变成传 prop；原来想用「筛选弹窗」那四个字，
       但它在**注释**里，read() 已经把注释剥了 ⇒ 永远找不到）。 */
    const iPop = view.indexOf('visible={fltOpen}');
    ok(iBar > 0, '找得到工具栏（style={s.toolBar}）');
    ok(iScrollOpen > 0, '找得到列表的 ScrollView（contentContainerStyle 带 pageWithTools）');
    ok(iScrollClose > iScrollOpen, '找得到 </ScrollView> 收尾');
    ok(iPop > iScrollClose, '找得到弹窗那一段（在列表之后）');
    /* ⚠⚠⚠ 核心：工具栏在 ScrollView **开标签之前** ⇒ 它是兄弟、不随滚动 */
    ok(iBar > 0 && iScrollOpen > 0 && iBar < iScrollOpen,
       '⚠⚠⚠ 工具栏在 ScrollView **之前** —— 是兄弟节点，才会「始终在顶部」（进去就会被滚走）');
    /* ⚠⚠ 反过来钉死：从 ScrollView 开到关之间**不许**再有 fltEntry / nameRow
       （留一份在列表里 = 上面一个入口、下面又一个，而且下面那个还会滚走） */
    const inScroll = (iScrollOpen > 0 && iScrollClose > iScrollOpen)
      ? view.slice(iScrollOpen, iScrollClose) : '';
    ok(inScroll.length > 0, '  └ 能切出 ScrollView 的内容区');
    ok(inScroll && !/<FilterEntry/.test(inScroll),
       '⚠⚠ 列表里**不许**再有一份筛选入口（会变成两个入口，且那个会跟着滚）');
    ok(inScroll && !/style=\{s\.nameRow\}/.test(inScroll),
       '⚠⚠ 列表里**不许**再有一份姓名查询行（同上）');
    ok(inScroll && !/<TagBar\b/.test(inScroll),
       '⚠⚠ 列表里**不许**有标签栏 —— 它是筛的入口，被滚走就等于「点了没反应」' +
       '（卡片里那枚 tagChip 是**只读**展示，两回事，别混）');

    /* ⚠ 整块工具区的显示条件只有**一份**（`showTools` 常量，见 ⑧-c）。
       ⚠⚠ 切片必须**从条件本身**开始 —— `<View style={s.toolBar}>` 在
         `? (` **之后**，从它开始切就把条件那一行漏在外面了
         （实测：从 `<View style={s.toolBar}>` 切，条件根本不在切片里，
          `match(...)` 返回 null ⇒ 断言在**干净源**上也红，是假红）。
       锚点 = 「{showTools ? ( + 紧跟的 <View style={s.toolBar}>」，抓到列表开标签为止。 */
    const bar = /(\{showTools \? \(\s*<View style=\{s\.toolBar\}>[\s\S]*?)<ScrollView/.exec(view);
    ok(!!bar, '工具栏那一段能切出来（含它自己的显示条件）');
    ok(bar && /<FilterEntry/.test(bar[1]), '  └ 筛选入口在工具栏里');
    ok(bar && /style=\{s\.nameRow\}/.test(bar[1]),
       '⚠⚠ 姓名查询行也在**同一个**工具栏里（整块一起钉 —— 只钉一行会「筛选固定、姓名滚走」）');
    ok(bar && /<TagBar\b/.test(bar[1]),
       '⚠ 标签栏也在**同一个**工具栏里（三样一起钉在顶部，谁都不能跟着列表滚）');
    eq(bar ? (bar[1].match(/\bshowTools\b/g) || []).length : -1, 1,
       '⚠⚠ 工具栏整块只判**一次**显示条件（各判一次 ⇒ 将来只改一行，三样行为会不一致）');

    /* ⚠⚠⚠ 工具栏**不许**套 `s.page`：那里面有 pagePadTop + 左右 padding + flexGrow，
       套上去 flexGrow 会把列表挤没。
       ⚠⚠ 判据必须是**「s.page 没出现在工具栏那个 style 里」**这个**否定**，
         不能只查「`style={s.toolBar}` 在不在」—— 那是**恒真**的写法：
         改成 `style={[s.page, s.toolBar]}` 时它照样命中（已实测：负向用例
         「工具栏套 s.page」第一版报 MISS，就是这么漏的）。
       ⚠ 锚点 = 工具栏**开标签那一整行**。用 `[^\n]*` 钉住单行，避免跨行误抓。 */
    {
      const m = /<View style=\{([^\n]*s\.toolBar[^\n]*)\}>/.exec(view);
      ok(!!m, '工具栏那个 <View> 的 style 能取到');
      ok(m && !/s\.page/.test(m[1]),
         '⚠⚠ 工具栏的 style **不含 s.page**（套 s.page 里的 flexGrow 会把列表挤没）');
      /* ⚠⚠⚠ 光查「JSX 里写了 s.toolBar」不够 —— 样式表里把 key 改名成 toolBarXX，
         JSX 那行**一个字没动**照样命中，但运行时会拿到 `undefined` 样式
         （留白全丢、工具栏塌成一行）。已实测：负向用例「toolBar 样式整块删掉」
         第一版报 MISS。⇒ 必须**同时**钉住「样式表里真的定义了这个 key」。 */
      ok(/^\s*toolBar: \{/m.test(view),
         '⚠⚠ 样式表里**真的定义了** toolBar（只查 JSX 引用会漏掉「改名 = 样式塌掉」）');
      ok(/toolBar: \{\s*\n\s*paddingTop: rpx\(SIZES\.pagePadTop\),/.test(view),
         '  └ toolBar 自己给顶部留白（不靠 s.page）');
      /* ⚠⚠ 同理：`pageWithTools` 的留白值必须是**真的那个令牌**，
         写成 `rpx(0)` / 删掉令牌会让第一张卡钻到工具栏底下。 */
      ok(/^\s*pageWithTools: \{ paddingTop: rpx\(SIZES\.toolBarGap\) \}/m.test(view),
         '⚠⚠ pageWithTools 的顶部留白来自 SIZES.toolBarGap（写成 rpx(0) = 第一张卡钻到工具栏底下）');
      ok(/^\s*toolBarGap: \d+,/m.test(read('src/theme/tokens.ts')),
         '⚠ 令牌 SIZES.toolBarGap 真的存在（删了 ⇒ pageWithTools 取到 undefined）');
    }
    ok(/contentContainerStyle=\{[\s\S]{0,240}?\[s\.page, s\.pageWithTools\]/.test(view),
       '⚠⚠ 内容容器在有工具栏时要补顶部留白 —— 否则第一张卡钻到工具栏底下');
    /* ⚠⚠⚠ 补留白必须**跟着工具区的显示条件走**（`showTools ? [...] : s.page`）：
       写成无条件 `[s.page, s.pageWithTools]` 时，工具区**不显示**（空列表）的那一路
       会吃掉 `s.page` 的 `pagePadTop` ⇒ 顶部留白变浅，空态块往上贴。
       已实测：负向用例「pageWithTools 改成无条件」第一版报 MISS。 */
    ok(/contentContainerStyle=\{[\s\S]{0,240}?showTools \? \[s\.page, s\.pageWithTools\][\s\S]{0,80}?: s\.page/.test(view),
       '⚠⚠⚠ 补留白**受工具区显示条件控制**（无条件补 ⇒ 空列表那一路顶部会变浅）');

    /* ⚠ 只钉「筛选」那一行的写法（把 nameRow 留在列表里）是**故意否掉**的 */
    ok(inScroll && !/style=\{s\.nameRow\}/.test(inScroll) && bar && /style=\{s\.nameRow\}/.test(bar[1]),
       '⚠ 姓名行**不留在列表里**（用户选的不是「只钉筛选一行」那个方案）');
  }

  /* ================================================================
   * ⑬ 下拉刷新：**松手才刷**（源码级，★ 2026-10-10 二改）
   * ================================================================
   * ⚠⚠⚠ 这一节的每一句都对着一个**真的踩过**的坑：
   *   ① 用 RN 自带的 `RefreshControl` ⇒ 安卓上底层是系统 `SwipeRefreshLayout`，
   *      **下拉一过阈值就回调 onRefresh**（不等松手）—— 用户报的正是这个。
   *      更狠的是它一抢到手势就给 JS 发 CANCEL、此后连 ACTION_UP 都收不到
   *      （JSTouchDispatcher.kt:123-126）⇒ 「留着原生控件、只把真实刷新推迟到松手」
   *      这条双保险**在原理上不可能成立**，所以这一块只能自己做。
   *   ② 用 RNGH 的 `GestureDetector` 包列表 ⇒ handler 挂在与列表**同一个原生视图**上、
   *      直接抢手势 ⇒「拉不动且什么都不报」（前两版就死在这）。
   *   ③ 用 PanResponder / 抢 responder ⇒ 一样是跟列表抢，同理。
   * ⚠⚠ 现在这版 = **被动听 touch + 整块 Animated 位移**，一个字的手势都不抢；
   *   「拉得动」靠的是源码事实而不是运气（`ReactRootView.requestDisallowInterceptTouchEvent`
   *   故意不调 super ⇒ 列表滚的时候 JS 照样收得到 MOVE / UP）。
   *
   * ⚠⚠ 这一组守的还是那几个**静默失效**的坑（全都只表现为「拉不动 / 拉了没反应 / 圈收不回」）：
   *   ① `refreshing` 用 ref 而不是 state ⇒ 文案与收圈都不对；
   *   ② `onRefresh` 不返回 promise ⇒ 指示器只能靠定时器蒙时长（网慢时提前收）；
   *   ③ 下拉走 onShow 那道「变了才拉」的闸门 ⇒ 版本号没变就什么都不做；
   *   ④ 位移没走 `useNativeDriver` ⇒ 拖动掉帧（手指在动、画面跟不上）。
   * ⚠ 还有一条**结构性**保证：App 里不再有任何手势库用法（连根容器
   *   `GestureHandlerRootView` 都撤了）⇒ 触摸分发不再多一层原生容器。
   */
  /* ⚠ import 语句在 stripComments 之后仍然完好（注释剥离只动块注释与 //），
     但这一块单独读原文，避免依赖 read() 的实现细节。 */
  const rawRefresh = fs.readFileSync(path.join(ROOT, 'src/screens/records/Records.tsx'), 'utf8');
  /* ⚠ 负向断言（「不许出现 X」）一律用**剥过注释**的文本 —— 注释里为讲清「为什么不用
     RefreshControl」会写到那个词，拿原文断言会把解释当成违规（自己把自己判红）。 */
  const rawRec = stripComments(rawRefresh);
  ok(/import \{ PullRefresh, isPulling \} from '\.\.\/\.\.\/components\/PullRefresh'/.test(rawRefresh),
     '⚠⚠⚠ 下拉刷新走 `components/PullRefresh`（松手才刷那版）；列表项还要从它取 `isPulling`');
  ok(!/RefreshControl/.test(rawRec),
     '⚠⚠⚠ 记录页不许再用 `RefreshControl` —— 安卓上它下拉一过阈值就刷（用户明确不接受）');
  ok(/import \{[^}]*\bScrollView\b[^}]*\} from 'react-native'/.test(rawRefresh),
     '⚠⚠ ScrollView 也从 react-native 导入（2026-10-10 深夜：不再用手势库那个）');
  ok(!/from 'react-native-gesture-handler'/.test(rawRefresh),
     '⚠⚠ 记录页不许再 import 手势库（自研那条路已整条撤掉）');
  ok(/<PullRefresh[\s\S]{0,200}?refreshing=\{refreshing\}[\s\S]{0,200}?onRefresh=\{onRefresh\}/.test(view),
     '⚠⚠⚠ 记录页的滚动组件被 `<PullRefresh refreshing onRefresh>` 包住 ——' +
     '它只被动听 touch + 整块位移、一个字的手势都不抢 ⇒ 以前那种「包错层级就拉不动」的坑不成立');
  ok(/refreshing=\{refreshing\}/.test(view), '⚠ refreshing 绑的是 state（绑错/写死 ⇒ 指示器收不回）');
  ok(/onRefresh=\{onRefresh\}/.test(view), '⚠ 必须接 onRefresh（不接 = 拉了没反应）');

  /* ⚠⚠ refreshing 必须是 useState，不是 useRef（ref 改了不重渲染 ⇒ 指示器收不回） */
  ok(/const \[refreshing, setRefreshing\] = useState\(false\)/.test(view),
     '⚠⚠ `refreshing` 必须是 useState（用 ref 的话指示器收不回来）');

  /* ⚠⚠⚠ 收尾要在 **promise 收尾**时收起，不许用定时器蒙时长 */
  {
    const fn = /const onRefresh = useCallback\(\(\) => \{([\s\S]*?)\}, \[loadCloud\]\)/.exec(view);
    ok(!!fn, '找得到 onRefresh');
    ok(fn && /return loadCloud\(/.test(fn[1]),
       '⚠⚠⚠ `onRefresh` 必须**把 promise 交出去**（`PullRefresh` 钉到它 resolve 才收圈）');
    ok(fn && /setRefreshing\(true\)/.test(fn[1]), '  └ 开头把指示器切到「正在刷新」');
    ok(fn && /\.finally\(/.test(fn[1]),
       '⚠⚠⚠ 用 `.finally(...)` 收尾 —— 拉**失败**也必须收，否则指示器永远转着');
    ok(fn && !/setTimeout|setInterval/.test(fn[1]),
       '⚠⚠⚠ **不许**用定时器决定什么时候收指示器（网慢时它先消失 ⇒ 用户以为刷完了）');
    ok(fn && /loadCloud\(model\.refreshOpts\(\)\)/.test(fn[1]),
       '⚠ 下拉走 model.refreshOpts()（keepTotal:false，把总条数也刷新）');
    /* ⚠⚠ 下拉**不许**看 syncedRev —— 那道闸门是为了「不发请求」，下拉是主动要数据 */
    ok(fn && !/syncedRev|shouldReload/.test(fn[1]),
       '⚠⚠⚠ 下拉不许走 onShow 的「变了才拉」闸门（版本号没变时那会变成「拉了没反应」）');
  }

  /* ⚠ 下拉必须能在**任何**状态下用（空列表 / 拉失败 / 未登录都要能自救）：
     `<PullRefresh>` 的开标签上不许出现任何条件渲染 / 前置判断 */
  {
    const pr = /<PullRefresh([^>]*)>/.exec(view);
    ok(!!pr, '<PullRefresh> 的开标签能抓到');
    ok(pr && !/\?|&&|\|\|/.test(pr[1]),
       '⚠⚠ 下拉刷新**不带任何条件**（列表空 / 拉失败时最需要它，加了条件就把出口藏了）');
  }

  /* ⚠ 内容容器要 flexGrow，否则空列表时下方空白接不住下拉手势 */
  ok(/page: \{[\s\S]{0,320}?flexGrow: 1/.test(view),
     '⚠ 内容容器加 flexGrow:1（空列表时也要能下拉 —— 那正是最想刷新的场景）');

  /* ================================================================
   * ⑬-b `PullRefresh` 的**实现契约**（★ 2026-10-10 二改：松手才刷）
   * ================================================================
   * ⚠⚠⚠ 这个文件是「松手才刷」这件事**唯一**的实现处，它的形状就是那条需求的形状：
   *   · 只要有一天在这里 import 了 `RefreshControl` 或手势库，需求立刻退化；
   *   · 只要把 `onRefresh()` 从 `onTouchEnd` 挪进 `onTouchMove`，「过阈值即刷」立刻回来，
   *     而且**外表完全看不出来**（指示器照样动、数据照样刷）⇒ 这一条必须断言死。
   */
  {
    const PR = path.join(ROOT, 'src/components/PullRefresh.tsx');
    ok(fs.existsSync(PR), '⚠⚠⚠ components/PullRefresh.tsx 必须在（「松手才刷」的唯一实现）');

    /* ⚠ 文件被删只报上面那一条就够了；**不能**让这里 readFileSync 抛出去 ——
       异常会把整个 screens-check 打断，连「失败 N 条」都统计不出来（探针 M10 实测过）。 */
    const prRaw = fs.existsSync(PR) ? fs.readFileSync(PR, 'utf8') : '';
    const pr = stripComments(prRaw);   // ⚠ 负向断言一律用剥过注释的（注释里必然提到这些名字）

    /* ① 不许退化回「原生控件」或「抢手势」那两条老路 */
    ok(!/react-native-gesture-handler/.test(pr),
       '⚠⚠⚠ 不许引手势库 —— 它跟列表抢同一个原生视图，就是前两版「拉不动」的根因');
    ok(!/RefreshControl/.test(pr),
       '⚠⚠⚠ 不许引 `RefreshControl`（安卓过阈值即刷，等于把需求做回去了）');
    ok(!/PanResponder|ShouldSetResponder/.test(pr),
       '⚠⚠ 不许走 responder 那条路（`onStart/MoveShouldSetResponder` 一样是跟列表抢）');
    ok(!/useAnimatedGestureHandler/.test(pr),
       '⚠ 不许用 reanimated 的老 API（4.x 已删，装了也是白装）');

    /* ② 必须是**被动**监听 touch：四个回调都要在 */
    ok(/onTouchStart=\{onTouchStart\}/.test(pr) &&
       /onTouchMove=\{onTouchMove\}/.test(pr) &&
       /onTouchEnd=\{onTouchEnd\}/.test(pr) &&
       /onTouchCancel=\{onTouchEnd\}/.test(pr),
       '⚠⚠⚠ 用 RN 的 touch 事件被动监听（Start / Move / End / Cancel 四个都要挂）');

    /* ③ ★★★ 松手才刷：`onRefresh()` 只能出现在 `onTouchEnd` 里，绝不许出现在 `onTouchMove` */
    const moveFn = /const onTouchMove = useCallback\(\s*\(e: GestureResponderEvent\)[\s\S]*?\n  \);/.exec(pr);
    const endFn = /const onTouchEnd = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[collapse, d, head\]\)/.exec(pr);
    ok(!!moveFn && !!endFn,
       'onTouchMove / onTouchEnd 两个函数体都能抓到（抓不到 = 函数被改名 ⇒ 下面两条会变哑断言）');
    ok(moveFn && !/onRefreshRef\.current\s*\(|onRefresh\(\)/.test(moveFn[0]),
       '⚠⚠⚠ **拖动过程中一次都不许触发刷新** —— 这一条就是「松手才刷」本身');
    ok(endFn && /onRefreshRef\.current\s*\(/.test(endFn[0]),
       '⚠⚠⚠ 触发刷新只能发生在**松手**那一拍（onTouchEnd 里调 onRefresh）');
    ok(endFn && /armedRef\.current/.test(endFn[0]),
       '  └ 松手时要判「过没过阈值」：没过就弹回去，不许刷');

    /* ④ 拖动必须走原生驱动，且位移是**整块**的 */
    ok(/useNativeDriver: true/.test(pr), '⚠⚠ 位移动画必须 `useNativeDriver: true`（否则拖动掉帧）');
    ok(/s\.mover/.test(pr) && /translateY/.test(pr),
       '⚠⚠ 位移是**整块** translateY（指示器 + 列表一起动）—— 分开动一定会错位');

    /* ⑤ atTop 只能来自子列表自己的滚动位置；子元素只许并 prop、不许换组件 */
    /* ⚠⚠ 必须是「从 contentOffset 算出来、**并写回** atTopRef」，不是「文件里有这两个词」——
       只查词的话，把那一行赋值删掉照样全绿（负向探针 M4 实测就是这么漏的）。 */
    ok(/contentOffset[\s\S]{0,160}?atTopRef\.current =/.test(pr),
       '⚠⚠ atTop 必须由子列表的 onScroll（contentOffset.y）算出来并写回 atTopRef —— ' +
       '猜错就会「列表滚在中间也整块被拽下来」');
    ok(/React\.cloneElement\(/.test(pr) && /React\.Children\.only\(/.test(pr),
       '⚠⚠ 只允许**恰好一个**子元素、且只并 prop（cloneElement）—— 不许换组件、不许包手势壳');
    /* ⚠ 不注入这两条的话：安卓边缘辉光 / iOS 橡皮筋会跟我们的位移**叠加**（视觉位移变两倍） */
    ok(/overScrollMode: 'never'/.test(pr) && /bounces: false/.test(pr),
       '⚠⚠⚠ 必须往子列表注入 `overScrollMode:"never"` + `bounces:false`（否则位移变两倍）');

    /* ⑤-b ★ 2026-10-11：**抬手那一拍不许顺带触发列表项的点击**
       （用户原话：「我下刷新抬起手如果手在某本书籍上，这本书就会打开」）。
       ⚠⚠ 判据不能是「文件里出现过 isPulling」—— `isPulling()` 是**给别人用的**，
          真正会错的只有这个标记**立在哪、清在哪**：
            · 立早了 ⇒「斜着划一下」也会把底下的点击吞掉；
            · 不清或清晚了（挪去 onTouchEnd / 用 setTimeout）⇒ 紧接着的一次**真点击**被吃掉。 */
    const startFn = /const onTouchStart = useCallback\(\(e: GestureResponderEvent\) => \{[\s\S]*?\n  \}, \[\]\)/.exec(pr);
    ok(!!startFn && !!moveFn,
       'onTouchStart / onTouchMove 的函数体都能抓到（抓不到 ⇒ 下面三条会变哑断言）');
    ok(startFn && /PULL\.active = false;/.test(startFn[0]),
       '⚠⚠⚠ 标记复位必须在 `onTouchStart` 里（新的手指一落下就清）—— 挪走或用 setTimeout 必错一头');
    ok(moveFn && /PULL\.active = true;/.test(moveFn[0]),
       '⚠⚠ 进入下拉那一刻要立标记（在 onTouchMove 里）');
    ok(moveFn && moveFn[0].indexOf('pullingRef.current = true;') < moveFn[0].indexOf('PULL.active = true;'),
       '⚠⚠⚠ 立标记必须在**确认是下拉**之后 —— 写在 onTouchMove 开头的话，斜着划一下也吞点击');
    ok(/export function isPulling\(\)/.test(pr) && /return PULL\.active;/.test(pr),
       '⚠⚠ 必须导出 `isPulling()` 给列表项用（拿不到标记 = 列表项没法自救）');

    /* ⑥ 对外接口（两个页面共用同一份，不许各写一套） */
    ok(/refreshing: boolean;/.test(pr) && /onRefresh: \(\) => any;/.test(pr),
       '⚠ 对外接口 = `{ refreshing: boolean; onRefresh: () => any }`');
  }

  /* ⑬-c 两个页面用**同一个**组件、**同一套接法**（不然修一个漏一个） */
  {
    const recSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/screens/records/Records.tsx'), 'utf8'));
    /* ⚠ 学堂那一侧读 QueryPane（查询面板）—— 内容 2026-10-11 从 Study.tsx 搬过去了，
       Study 现在只是壳，壳里不出现 PullRefresh（它在这两个面板内部）。 */
    const studySrc = stripComments(
      fs.readFileSync(path.join(ROOT, 'src', 'screens', 'study', 'QueryPane.tsx'), 'utf8'),
    );
    ok(/from '\.\.\/\.\.\/components\/PullRefresh'/.test(recSrc) &&
       /from '\.\.\/\.\.\/components\/PullRefresh'/.test(studySrc),
       '⚠ 记录页与学堂页都从 components/PullRefresh 引（各写一份迟早漂）');
    ok(!/RefreshControl/.test(recSrc) && !/RefreshControl/.test(studySrc),
       '⚠⚠⚠ 两个页面都不许再出现 `RefreshControl`（安卓过阈值即刷）');
    ok(!/react-native-gesture-handler/.test(recSrc) && !/react-native-gesture-handler/.test(studySrc),
       '  └ 也不许引手势库');
    ok(!/GestureFlatList/.test(recSrc) && !/GestureFlatList/.test(studySrc),
       '  └ 也不许再出现手势壳（下拉刷新已不抢手势，包一层只会与列表滚动打架）');
  }

  /* ⑬-d 零手势 ⇒ App 里连根容器都不该有（★ 保留 2026-10-10 的撤除结果） */
  {
    const appRaw = stripComments(fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8'));
    ok(!/react-native-gesture-handler/.test(appRaw),
       '⚠⚠⚠ App.tsx 不许 import 手势库（零手势 ⇒ 连 `GestureHandlerRootView` 一起去掉）');
    ok(!/GestureHandlerRootView/.test(appRaw),
       '  └ 根容器已撤：它是「手势全哑且不报错」的唯一前置条件，' +
       '**将来若真的再上 RNGH 手势，必须把它加回最外层**（见 App.tsx 里的注释）');
  }

  /* ⑬-e 列表项的点击必须给下拉让路（★ 2026-10-11 用户报：抬手时手指底下的书被打开）
   * ================================================================
   * ⚠⚠⚠ 根因：封面 / 卡片 / 书签行这些**大块可点区域**比 `Pressability` 的
   *   `pressRetentionOffset`（默认 20dp）高得多 ⇒ 往下拽 100dp，手指**仍落在同一格内**、
   *   点击不会被取消 ⇒ 「松手」被当成一次正常点击。
   * ⚠⚠⚠ 判据必须钉到**位置上**，只查「文件里有没有 isPulling」是假绿：
   *   把 `if (isPulling()) return;` 挪到 onPress 最后一句，动作照样执行 —— 拦了个寂寞。
   */
  {
    const sites = [
      ['src/screens/study/BooksPane.tsx', '书籍封面'],
      ['src/screens/study/QueryPane.tsx', '书签行'],
      ['src/screens/records/Records.tsx', '记录卡片'],
    ];
    for (const [rel, what] of sites) {
      const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      ok(/isPulling/.test(src) && /from '\.\.\/\.\.\/components\/PullRefresh'/.test(src),
         `⚠⚠ ${what}（${rel}）要从 PullRefresh 取 isPulling（拿不到标记就没法自救）`);
      eq((src.match(/if \(isPulling\(\)\) return;/g) || []).length, 1,
         `⚠⚠⚠ ${what}：全局必须**恰好一处**「if (isPulling()) return;」`);
      ok(/onPress=\{\(\) => \{\s*if \(isPulling\(\)\) return;/.test(src),
         `⚠⚠⚠ ${what}：它必须是 onPress 的**第一句**（写成最后一句 = 动作已经执行了）`);
    }
  }

  /* ================================================================
   * ⑬ 姓名查询：**住在弹窗外面**（★ 用户要求的「不用点进去」）
   * ================================================================
   * ⚠⚠ 这一组的核心是**位置**与**独立性**：
   *   输入框必须在弹窗**之前**（= 入口下面那一段），而且渲染条件里
   *   **不许**出现 fltOpen —— 一出现就说明它被塞进弹窗里了，
   *   那样「不用点进去也能筛」就不成立（这正是用户要避免的）。
   */
  ok(/model\.normalizeName\(/.test(view), '⚠ 视图走 model.normalizeName（口径只有一份，别自己 trim）');
  ok(/nameRef\.current/.test(view), '⚠ 姓名放 ref（loadCloud 是异步回调，读 state 会拿到旧值）');
  ok(/onChangeText=\{onNameChange\}/.test(view), '姓名输入框接了 onChangeText（不接就是画着好看）');
  ok(/placeholder="输入姓名查询"/.test(view), '⚠ 输入框里的提示是「输入姓名查询」（用户原话）');
  ok(/value=\{nameKw\}/.test(view), '姓名输入框是受控的（value 绑 nameKw）');

  /* ================================================================
   * ⚠⚠⚠ 姓名**必须点了「查询」/ 回车才发请求**（用户否掉了边打边筛）
   * ================================================================
   * 用户原话：「输入名字筛选，要点确认才行啊，这样输入中自动筛选很容造成后端压力的」。
   * 这一组守三件事：
   *   ① `onChangeText` 那条路**绝不**能触发网络（打一个字发一次 = 后端的压力源）；
   *   ② 只有 `onNameSearch` 那条路能 `loadCloud`；
   *   ③ 输入框必须挂着提交入口（onSubmitEditing + 一颗查询按钮），
   *      否则用户打完了没有任何「确认」可点。
   */
  {
    /* ① onChangeText 的处理函数体里**不许**出现 loadCloud / history.pull */
    const chg = /const onNameChange = useCallback\(\(text: string\) => \{([\s\S]*?)\}, \[\]\)/.exec(view);
    ok(!!chg, '找得到 onNameChange');
    ok(chg && !/loadCloud|history\.pull/.test(chg[1]),
       '⚠⚠⚠ onChangeText **只改草稿、绝不发请求**（边打边筛 = 打三个字发三次，前两次当场作废）');
    ok(chg && /setNameKw\(text\)/.test(chg[1]), '  └ 它确实把输入写进了草稿');

    /* ② onNameSearch 才是唯一发请求的那条路
       ⚠ 依赖数组现在是 `[loadCloud]`（草稿改从 ref 读，不再依赖 nameKw）；
         用 `\[[^\]]*\]` 兜住，别把形状写死 —— 写死的话改依赖数组就变假红。 */
    const search = /const onNameSearch = useCallback\(\(\) => \{([\s\S]*?)\}, \[[^\]]*\]\)/.exec(view);
    ok(!!search, '找得到 onNameSearch（点「查询」/回车走它）');
    ok(search && /loadCloud\(/.test(search[1]), '⚠⚠ 只有 onNameSearch 才 loadCloud');
    ok(search && /model\.normalizeName\((?:nameDraftRef\.current|draft)\)/.test(search[1]),
       '⚠ 提交前比**归一化后**的值（点两次查询不该发两次）——且草稿从 ref 读');
    ok(search && /nameRef\.current = draft/.test(search[1]),
       '⚠ 提交时才把草稿写进生效 ref —— 这就是「点了确认才筛」');
  }

  /* ③ 输入框必须有提交入口：回车 + 一颗按钮 */
  ok(/onSubmitEditing=\{onNameSearch\}/.test(view), '⚠ 键盘回车也要能提交（returnKeyType="search" 配套）');
  ok(/onPress=\{onNameSearch\}/.test(view), '⚠ 必须有一颗「查询」按钮可点（否则打完了没法确认）');
  ok(/nameDirty/.test(view),
     '⚠⚠ 草稿与生效不一致要有**可见信号**（按钮变亮）—— 输入框没有「取消」，不给信号用户会以为自动筛好了');
  {
    /* ⚠ 按钮的可用性必须绑 nameDirty，而不是恒亮 */
    const goBtn = /<Pressable\s+style=\{\[s\.nameGo, nameDirty \? s\.nameGoOn : null\]\}([\s\S]{0,220}?)<\/Pressable>/.exec(view);
    ok(!!goBtn, '找得到那颗「查询」按钮');
    ok(goBtn && /disabled=\{!nameDirty\}/.test(goBtn[1]),
       '⚠ 草稿没变时按钮是灰的（点一下没反应比按钮亮着不发请求更让人困惑）');
  }

  /* ④ 清空 ✕ 走的是「立即生效」那条路（不要求点查询） */
  {
    const clr = /const onNameClear = useCallback\(\(\) => \{([\s\S]*?)\}, \[loadCloud\]\)/.exec(view);
    ok(!!clr, '找得到 onNameClear');
    ok(clr && /loadCloud\(/.test(clr[1]),
       '⚠ 点 ✕ **立即生效**（意图明确到不需要二次确认，与弹窗里的「清除筛选」同理）');
  }

  /* ================================================================
   * ⑤ ⚠⚠⚠ 「查询/回车点了没反应」的两个真凶（用户实测报障过）
   * ================================================================
   * 症状：输入框亮着、按钮也亮着，点「查询」和按键盘回车**都静默无效**
   *   （没有报错、没有请求、列表纹丝不动）。两个根因都很隐蔽：
   *
   *   ⚠⚠⚠ 真凶一：**在渲染期把生效 ref 刷成草稿**。
   *     曾经写成 `nameRef.current = nameKw`（照抄上面 filterRef 的写法）——
   *     那行**每次渲染都跑** ⇒ 点查询时 `nameRef` 早就等于草稿了 ⇒
   *     「没变就不发请求」的守卫**恒为真** ⇒ 永远 early-return。
   *     ⚠ 这条断言是**本组最值钱的一条**：它检查 `nameRef.current = ...` 这类
   *     赋值**只出现在函数体里**，绝不出现在组件顶层（渲染路径）。
   *
   *   ⚠⚠ 真凶二：提交时读的是 **state（`nameKw`）**而不是 ref。
   *     键盘回车在某些机型/输入法下会赶在 state 冲上来之前触发，
   *     读 state 会拿到**上一个字符**（打完「张三丰」按回车，筛的是「张三」）。
   */
  {
    /* 真凶一：组件顶层（render 路径）不许出现 `nameRef.current = ` 赋值。
       ⚠⚠ 判据不能靠缩进（缩进会被格式化改掉，我第一版就是这么漏掉这个 bug 的：
         `^nameRef\.current` 只匹配顶格，而注入的那行缩进 2 空格 ⇒ **假绿**）。
         改成按**花括号深度**判：`nameRef.current = …` 只允许出现在
         **深度 ≥ 2** 的地方（= `useCallback(() => { … })` 的函数体里）；
         深度 0/1 就是组件渲染路径上的裸语句。
       ⚠ 实现：逐行扫，把「函数体深度」与「对象/JSX 深度」一起数；
         最稳的简单做法是数 `{` / `}`（剥掉注释与字符串后），
         并对 `=> {` 这种箭头函数体不额外计（它本来就是个 `{`）。 */
    function braceDepthBefore(src, idx) {
      let d = 0;
      for (let i = 0; i < idx; i += 1) {
        if (src[i] === '{') d += 1;
        else if (src[i] === '}') d -= 1;
      }
      return d;
    }
    const rawView = fs.readFileSync(path.join(ROOT, 'src/screens/records/Records.tsx'), 'utf8');
    const clean = stripComments(rawView);
    /* 找所有对 nameRef 的赋值（`nameRef.current =`，含 `+=` 之类也一起看） */
    const assignRe = /nameRef\.current\s*=[^=]/g;
    const sites = [];
    let m;
    while ((m = assignRe.exec(clean)) !== null) {
      sites.push({ idx: m.index, depth: braceDepthBefore(clean, m.index) });
    }
    ok(sites.length > 0, '源码里确实有给 nameRef 赋值的地方（它不是只读的）');
    const shallow = sites.filter((s) => s.depth < 2);
    ok(shallow.length === 0,
       '⚠⚠⚠ `nameRef.current = …` 只许出现在 useCallback 函数体里（组件渲染路径上写它 ⇒ '
       + '每渲染同步一次 ⇒ 提交守卫恒为真 ⇒ 点「查询」/回车静默无效）；'
       + '实测深度：' + sites.map((s) => s.depth).join(','));

    /* 真凶二：提交读草稿必须走 ref，不许读 state */
    const search = /const onNameSearch = useCallback\(\(\) => \{([\s\S]*?)\}, \[[^\]]*\]\)/.exec(view);
    ok(!!search, '找得到 onNameSearch');
    ok(search && /nameDraftRef\.current/.test(search[1]),
       '⚠⚠ 提交时草稿读的是 **ref**（键盘回车可能赶在 state 更新之前，读 state 会拿到上一个字符）');
    ok(search && !/normalizeName\(nameKw\)/.test(search[1]),
       '⚠⚠ 提交时**不许**读 `nameKw`（state 会滞后一帧 ⇒ 筛的是上一次打的内容）');

    /* ⚠ 「先写生效 ref、再发请求」的顺序不能反（反了这次请求带的是旧关键词） */
    if (search) {
      const iAssign = search[1].indexOf('nameRef.current =');
      const iLoad = search[1].indexOf('loadCloud(');
      ok(iAssign >= 0 && iLoad >= 0 && iAssign < iLoad,
         '⚠ 顺序：**先写 nameRef 再 loadCloud**（loadCloud 是同步读 ref 拼 query 的）');
    }

    /* 草稿 ref 必须与 state 一起更新（只更一个 ⇒ 两边漂移） */
    const chg = /const onNameChange = useCallback\(\(text: string\) => \{([\s\S]*?)\}, \[\]\)/.exec(view);
    ok(chg && /nameDraftRef\.current = text/.test(chg[1]), 'onNameChange 同步写草稿 ref');
    ok(chg && /setNameKw\(text\)/.test(chg[1]), 'onNameChange 同时更新 state（渲染要用）');

    /* ⚠ 清除筛选时**两个 ref 都要清**：漏掉草稿 ref ⇒ 清除后一按回车旧词又回来了 */
    const reset = /const onResetFilter = useCallback\(\(\) => \{([\s\S]*?)\}, \[reloadWithFilter\]\)/.exec(view);
    ok(reset && /nameRef\.current = ''/.test(reset[1]), '清除筛选清掉生效 ref');
    ok(reset && /nameDraftRef\.current = ''/.test(reset[1]),
       '⚠⚠ 清除筛选也要清掉**草稿 ref**（否则清完一按回车，旧关键词又被筛回来）');
    ok(reset && /setNameKw\(''\)/.test(reset[1]), '清除筛选把输入框也清空（否则看着像「清了但还写着」）');
  }

  /* ⚠⚠⚠ 输入框必须在弹窗**外面**：渲染它的那段里不许出现 fltOpen。
     ⚠ 锚点用 JSX 里的 `style={s.nameRow}`（**不能**用它当全文锚点找位置 ——
       样式表里也有 `nameRow:` 那个 key）。这一段从 nameRow 那行起到
       它的 `) : null}` 收尾，覆盖了整块三元表达式。 */
  {
    const seg = /<View style=\{s\.nameRow\}>([\s\S]*?)\n\s*\) : null\}/.exec(view);
    ok(!!seg, '源码里能找到姓名查询那一块（<View style={s.nameRow}> … ) : null}）');
    ok(seg && /输入姓名查询/.test(seg[0]), '  └ 而且它确实是那个姓名输入框');
    ok(seg && !/fltOpen/.test(seg[0]),
       '⚠⚠⚠ 姓名输入框**不在弹窗里**（这块里不许出现 fltOpen —— 出现就说明「要点进去才能打」了）');
  }
  /* ⚠ 位置：姓名那一行必须排在筛选入口**后面**（用户原话「放在筛选下面」） */
  {
    /* ⚠ 锚点用 `<FilterEntry`（2026-10-04 起入口是公用组件，
       不再有 `style={s.fltEntry}` 这个字面量 —— 那一行现在住在组件里） */
    const iEntry = view.indexOf('<FilterEntry');
    const iName = view.indexOf('style={s.nameRow}');
    ok(iEntry >= 0 && iName >= 0, '筛选入口与姓名输入框都在源码里');
    ok(iEntry < iName,
       '⚠⚠ 姓名输入框在筛选入口**下面**（用户要求「放在筛选下面」；反过来就成了「姓名在上、筛选在下」）');
  }
  /* ⚠ 清除筛选必须**连姓名一起清**，否则「清除筛选」之后列表还是筛过的（那句话在骗人） */
  {
    const reset = /const onResetFilter = useCallback\(\(\) => \{([\s\S]*?)\}, \[reloadWithFilter\]\)/.exec(view);
    ok(!!reset, '找得到 onResetFilter');
    ok(reset && /hasFilter\(filterRef\.current,\s*nameRef\.current,\s*tagSelRef\.current\)/.test(reset[1]),
       '⚠ 清除筛选的判据把姓名（和**标签**）都算进去');
    ok(reset && /setNameKw\(''\)/.test(reset[1]),
       '⚠⚠ 清除筛选**连姓名一起清**（只清干支的话，用户会看到「清了但没清干净」）');
  }
}

/* ================================================================
 * 七、静态检查：所有源文件的 require / import 路径都能落到真实文件
 * ================================================================
 * ⚠⚠ 「相对路径数错级数」在本项目已经犯过**三次**（../../src/core、vendor 放错层…），
 *   症状全是「静默解析到别的目录 / 运行时才炸」，模拟器里只表现为某块空白。
 *   这里把整个 src/ + App.tsx 扫一遍：每一条 require / import 的相对路径
 *   必须能按扩展名探测到真实文件（.js / .ts / .tsx / .png …）。
 */
console.log('\n--- require / import 路径审计 ---');
{
  const fs = require('fs');
  const EXTOrder = ['', '.ts', '.tsx', '.js', '.json', '.png'];

  function probe(base) {
    for (const ext of EXTOrder) {
      const f = base + ext;
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    // 目录形式的包（有 package.json）
    const pkg = path.join(base, 'package.json');
    if (fs.existsSync(pkg)) return pkg;
    return null;
  }

  function walk(dir, out) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|tsx|ts)$/.test(e.name)) out.push(p);
    });
    return out;
  }

  const files = walk(path.join(ROOT, 'src'), []).concat([path.join(ROOT, 'App.tsx')]);
  let checked = 0;
  const broken = [];

  /* 去注释再扫：文件头注释里常写着「原来的 require 长这样」当说明，
     直接全文正则会把说明文字当成真引用（node-resolution-check 也踩过同一坑）。 */
  function stripComments(src) {
    return String(src)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(function (l) { return l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'); }).join('\n');
  }

  files.forEach(function (f) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    /* require('...') 与 from '...'（import / export ... from）。只看静态字符串路径 */
    const re = /(?:require\(\s*|from\s+)(['"])(\.\.?\/[^'"]+)\1/g;
    let m;
    while ((m = re.exec(src))) {
      checked++;
      const spec = m[2];
      const target = probe(path.resolve(path.dirname(f), spec));
      if (!target) broken.push(path.relative(ROOT, f) + '  →  ' + spec);
    }
  });

  ok(checked > 50, '扫到了足够多的相对引用', '共 ' + checked + ' 条');
  eq(broken, [], '⚠ 每一条 require / import 都能落到真实文件');
}

/* ================================================================ */
/* 「同」按钮（2026-11-15）：结果页按**定气法**的四柱去检索记录 + 学堂书签
 *
 * ⚠⚠ 这一节盯的是**接线**而不是长相：按钮存在、点击真的发起检索、
 *   条件取自 `state.pillars`（定气法）而**不是** `pingState.pillars`，
 *   以及检索结果能点开（两条路各自复用已有入口）。
 *   真正的检索逻辑在 core/sameBazi.js，那边由 tests/logic-check.js 断言。
 */
(function () {
  const fs = require('fs');
  function stripComments(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  const chart = read('src/components/chart-view/ChartView.tsx');
  const sheet = read('src/components/chart-view/SameBaziSheet.tsx');
  const result = read('src/screens/result/Result.tsx');
  const app = read('App.tsx');

  ok(/<Text style=\{styles\.sameBtnText\}>同<\/Text>/.test(chart),
    '结果页有「同」按钮（文案就是「同」）');
  ok(chart.indexOf('import SameBaziSheet from') >= 0, 'ChartView 挂上了 SameBaziSheet');

  /* 位置（2026-11-15 用户：「最好和公历同一排」）：
     ⚠ 判据是**切片**而不是「文件里能不能找到」—— 后者管不住位置：
       按钮挪到页脚、挪到另一张卡片里，只要还在这个文件里就照样绿。 */
  function between(src, a, b) {
    const i = src.indexOf(a);
    if (i < 0) return '';
    const j = src.indexOf(b, i + a.length);
    return j < 0 ? '' : src.slice(i, j);
  }
  const gongliRow = between(chart, '>公历</Text>', '</View>');
  ok(gongliRow.indexOf('styles.sameBtnText') >= 0,
    '「同」按钮就在公历那一行里（用户：最好和公历同一排）');
  /* ⚠ 反向：旧写法是单独一行 `sameRow`（右对齐）。留着它渲染出来就是两处按钮/一条空行 */
  ok(chart.indexOf('sameRow') < 0, '⚠ 不再单占一行（旧的 sameRow 写法已删）');
  ok(/source="定气法"/.test(chart), '弹层里标注条件取自定气法（切到平气法也说得清为什么结果不同）');

  ok(/sameBazi\.find\(state\.pillars\)/.test(chart),
    '检索条件取 state.pillars（定气法那一份）');
  /* ⚠ 反向：有人「顺手」改成平气法就会红 —— 用户明确要求条件永远是定气法 */
  ok(!/sameBazi\.find\(\s*pingState/.test(chart), '⚠ 条件不许取自平气法');
  ok(/sameBazi\.charsOf\(state\.pillars\)/.test(chart), '弹层标题下的条件也取自定气法');
  ok(chart.indexOf('onOpenSameRecord') >= 0 && chart.indexOf('onOpenSameBookmark') >= 0,
    'ChartView 把「点开」交回页面（自己不转换数据）');

  ok(sheet.indexOf("require('../../core/sameBazi.js')") >= 0, '弹层用 core/sameBazi 的空态/计数文案');
  ok(sheet.indexOf('onOpenRecord') >= 0 && sheet.indexOf('onOpenBookmark') >= 0,
    '弹层两条路各自可点');
  ok(sheet.indexOf('<Modal') >= 0, '弹层用 RN Modal（结果页是裸 ScrollView，absolute 遮罩会被裁）');
  /* 贴底 sheet（2026-11-15 版式优化）：
     ⚠ 贴底 = 最后一行紧挨屏幕下边缘 ⇒ 必须吃安全区，否则被 Home 横条压住。
       这一层是**全屏 Modal**，不在 App 根节点那层 paddingBottom: eaten 里，别指望外面兜。 */
  ok(sheet.indexOf('useSafeAreaInsets') >= 0 && /Math\.max\(insets\.bottom/.test(sheet),
    '贴底弹层的底部吃安全区（insets.bottom 与 24rpx 取大）');
  /* ⚠ 书签主标题的四柱：原来是三元里连算三遍 pillarRows，一条书签跑三趟 */
  ok((sheet.match(/studyModel\.pillarRows\(/g) || []).length === 1,
    '书签四柱只算一次（别再内联算三遍）');

  /* ⚠ 这两条用 indexOf + 距离，而不是正则：JSX 里那串 `={` / `=>` / `(rec: any)`
     写成正则要转义一堆括号花括号，一旦转义错就变成「永远不匹配」的哑断言
     —— 这个项目已经吃过「锚点写得太脆」的亏（见 CONTRACTS §二十三）。
     距离限制（200 字符）足够表达「就在这个回调里」，又不至于跨到别的属性上。 */
  function near(src, head, tail, span) {
    const i = src.indexOf(head);
    if (i < 0) return false;
    const j = src.indexOf(tail, i);
    return j > i && j - i < (span || 200);
  }
  ok(near(result, 'onOpenSameRecord', 'recordsModel.toHandoff('),
    'Result 用 records/model.js 的 toHandoff 转记录（不另写一套）');
  ok(near(result, 'onOpenSameBookmark', 'studyModel.bookmarkTarget('),
    'Result 用 study/model.js 的 bookmarkTarget 转书签');

  ok(/onOpenRecord=\{onOpenRecord\}/.test(app) && /onOpenBookmark=\{onOpenBookmark\}/.test(app),
    'App 把两个既有入口透传给 Result');
})();

/* ================================================================ */

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log('失败清单：');
  fails.forEach(function (f) { console.log('  - ' + f); });
}
process.exit(fail ? 1 : 0);
