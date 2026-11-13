/**
 * 结果页的**纯计算层** —— 不 import 任何 React / RN 东西，可在纯 Node 里断言。
 *
 * ⚠ 从 paipan/pages/result/result.js 里拆出来的四件事（都是「纯映射」）：
 *   ① loadPlanOf —— 三条来路 + **两道短路**（下面专门说明，别删）
 *   ② savedOf    —— 「已保存 / 未保存」由**来路**决定，进页面不打任何接口
 *   ③ saveStateOf—— history.push() 的结果 → 保存按钮的三态文案
 *   ④ noteItemOf —— 事件编辑框 → 写进 notes 的那一条（含元信息快照白名单）
 *   外加 editorOf（编辑框整份换对象）与几条小工具。
 *
 * ⚠⚠ 为什么必须拆出来：
 *   这一页最难的不是画，是「进页面那一刻该显示什么」——三条来路 × 两道短路 ×
 *   「别拿 null 把屏幕上的盘冲掉」，全埋在 setData 调用里，不上模拟器根本验不了。
 *   拆成纯函数之后，这四件事每条都能在 Node 里直接断言。
 *
 * ============ ⚠⚠ 两道短路，删了就会出事 ⚠⚠ ============
 * 小程序的 onLoad 与 onShow 是连着触发的（RN 这边对应「进入推入页」与
 * 「从后台回来 / 再次推入」），所以 load 会连着跑两次。而 chartBus.take()
 * 是双槽（pending / current，见 core/chartBus.js），第二次拿到的还是同一份。
 *   · 短路①：raw 为 null 且**已经渲染出盘**（或正在排）→ 保持原样，
 *     绝不拿 null 把屏幕上的盘冲成空态。否则「一进结果页闪一下空态」（老 bug）。
 *   · 短路②：raw 的 id 与当前盘相同、且当前盘已经有 chart → 什么都不做，
 *     否则 onShow 会把盘重排一遍（几十毫秒白算）。
 *
 * ============ 「已保存」由来路决定，不进页面核对 ============
 * 上一版进页面先发一次 GET 核对这个 id 在不在云端（按钮「正在核对…」直到返回）。
 * 那是被一个老 bug 逼的：更早的「已保存」查**本地镜像**，而点保存第一步就是写镜像，
 * 保存失败的盘重进页面照样显示「已保存」并永久跳过云端写入。现在本地镜像根本不存在，
 * 两条来路的答案都是云端事实的**现成推论**：
 *   · 排盘页过来（总线里带 chart）→ 盘是几毫秒前新建的，**必未保存**
 *   · 记录页过来（轻记录，只有出生信息）→ 它本来就是云端列表里的一条，**必已保存**
 * 所以核对 GET 整个删掉，进页面按钮立即就是终态。
 * 保存**动作**的结果仍然只认云端响应：成功 → 已保存；失败 → fail 可重试。
 *
 * ⚠ 本页也**不读 storage**：传盘走内存总线（本地一个字节都不留）。
 */
const record = require('../../core/record.js');
const notesLib = require('../../core/notes.js');
/**
 * 自定义标签的**纯小工具**（core/tags.js）。
 * ⚠ 只取常量与纯函数（TAG_NONE）；网络那半截由 Result.tsx 直接调 ——
 *   与 records 那一页同一分工（见 screens/records/model.js 同位置注释）。
 */
const tagsLib = require('../../core/tags.js');
/**
 * 农历换算（core/lunar.js → tyme）。只为「出生时间」那一行把公历日期换算成
 * 「甲午年九月初八」这种给人看的文案 —— 草稿改了日期，农历必须跟着重算，
 * 不能拿记录里那份旧的（详见 `birthOf`）。
 */
const lunarLib = require('../../core/lunar.js');

/* ------------------------------------------------------------------ 常量 */

/**
 * 三个页签的合法 key —— 收敛成字面量，点错 key 时不会切出一块空白。
 *
 * ⚠⚠ **这个数组的顺序就是切换栏的显示顺序**（视图直接 map 它，不再另抄一份）。
 *   「详细信息」排第一是用户明确要求的：进来先看到「这条八字是谁的、什么时候生的」，
 *   再去啃盘面。改顺序只改这里一处，别去视图里挪。
 * ⚠ 数组第一个**不等于**默认页签 —— 默认仍然是 `chart`（见 Result.tsx 的
 *   `useState('chart')`），因为用户点「开始排盘」的意图就是看盘。
 *
 * ⚠⚠⚠ **`notes`（师傅批字）2026-10-21 被用户要求隐藏** —— 原话
 *   「将排盘结果师傅批字功能隐藏，按钮也隐藏不许出现」。
 *   做法 = 从这个数组里摘掉：视图的切换栏是 `TAB_KEYS.map(...)`，
 *   摘掉即「页签与它下面那些按钮（发起求测 / 发送 / 刷新）**一个都不渲染**」，
 *   比加一堆 `if (hidden)` 干净，也不会有「藏了页签、按钮还露着」的半截状态。
 *   ⚠ 面板四与输入条的 JSX **留在视图里没删**（判断是 `activeTab === 'notes'`，
 *     而这个 key 进不了 activeTab ⇒ 永远不可达）—— 留着是为了将来一句话能恢复：
 *     把 'notes' 加回这里 + 加回下面 TAB_LABELS 的文案，即完整回来。
 */
const TAB_KEYS = ['info', 'chart', 'events'];

/**
 * 切换栏的显示文案（key → 中文）。⚠ 与 TAB_KEYS 一一对应，别只加 key 忘了加文案
 *
 * ⚠⚠ `chart` 原来叫「专业排盘」，用户 2026-10-03 要求把「专业排盘」去掉
 *   （「排盘结果的专业排盘的名字去掉，没有意义了」）。改成「排盘结果」：
 *   这个页签里就是排出来的那些盘（四柱 / 大运 / 流年 / 流月），
 *   而「专业」两个字只是自我表扬，对用户没有任何信息量。
 *   ⚠ 改名字**只改这里** —— 视图里那几处「专业排盘」文案已同步，
 *     别在别处再写死一个「专业排盘」。
 */
const TAB_LABELS = {
  info: '详细信息',
  chart: '排盘结果',
  events: '事件记录'
  /* ⚠ 这里**故意没有** `notes: '师傅批字'`：上面 TAB_KEYS 已经摘掉那个 key，
     文案表留着它就成了「多余的 key」—— 而且哪天有人只把文案加回来、
     忘了加 key，页签也不会出现，白排查一轮。恢复时两处一起加。 */
};

/** 保存按钮的文字（三态 + 已保存态） */
const SAVE_TEXT = {
  idle: '保存到记录',
  saving: '正在保存到云端…',
  saved: '已保存到记录',
  noLogin: '未登录 · 无法保存',
  badRecord: '出生信息不全 · 无法保存',
  failed: '云端保存失败 · 重试'
};

/**
 * 写进一条事件时，从 meta 里快照下来的字段（顺序即 notes.js 的 titleOf 取用顺序）。
 * ⚠ 这是**白名单**：meta 里还带着 up / up2（父级 / 祖父级快照），
 *   它们也在这张表里 —— 漏了 up/up2，父级那一行自己没写正文时，
 *   时间线上就只剩光秃秃一个「【大运】」。
 */
const NOTE_META_FIELDS = ['year', 'ganzhi', 'age', 'md', 'jieQi', 'up', 'up2'];

/* ------------------------------------------------------------------ 工具 */

/** 浅拷贝（只搬自有属性） */
function copyOf(obj) {
  const out = {};
  const src = obj || {};
  for (const k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

/**
 * 保存按钮的初始态。
 * @param {boolean} saved 这条盘是不是已经在云端记录里
 * @returns {{state:'idle', text:string, disabled:boolean}}
 */
function saveIdle(saved) {
  return {
    state: 'idle',
    text: saved ? SAVE_TEXT.saved : SAVE_TEXT.idle,
    disabled: !!saved
  };
}

/** 空面板：没有盘时那三块面板都该是空的 */
function emptyPanel() {
  return { rec: null, hydrating: false, saved: false, save: saveIdle(false) };
}

/* ------------------------------------------------------------------ ① */

/**
 * 拿到要展示的记录 —— 三条来路，优先级从高到低：
 *   1. 内存里刚放下的完整盘（同一次会话里刚从排盘页过来）→ 直接用，省一次重算
 *   2. 从记录页过来的轻记录（只有 id / 出生信息）→ 交给调用方 hydrate 现场排盘
 *   3. 什么都没有（冷启动直接进本页）→ 空态
 *
 * ⚠ 这个函数**只做判定**，不真的去排盘（排盘那几十毫秒是副作用，留给视图层的
 *   setTimeout —— 先让「正在排盘…」那一帧渲染出来，否则用户看不到任何反馈）。
 *
 * @param {Object|null} raw     chartBus.take() 的结果
 * @param {Object|null} curRec  当前屏幕上那份完整记录（可能为 null）
 * @param {boolean}     hydrating 当前是否正在排盘
 * @returns {{action:'keep'|'empty'|'full'|'hydrate', rec?:Object}}
 *   keep    → 什么都不做（**两道短路**都归到这里）
 *   empty   → 摊平到空态（连盘都没有）
 *   full    → 直接拿这份完整盘渲染（必未保存）
 *   hydrate → 该现场排盘；rec 是那份轻记录，调用方负责 record.hydrate + 延后一拍
 */
function loadPlanOf(raw, curRec, hydrating) {
  if (!raw) {
    // 短路①：总线里没有，但屏幕上已经有盘（或正在排）→ 保持不动。
    // 只有「真的什么都没有」才走空态。
    if (curRec || hydrating) return { action: 'keep' };
    return { action: 'empty' };
  }

  // 短路②：同一份盘已经在屏幕上了 → 什么都不做（否则 onShow 白白重排一次）
  // ⚠ 条件里的 `curRec.chart` 不能少：正在 hydrate（盘还没出来）时 id 可能已相同，
  //   少了它就会把「正在排盘」误判成「已经在屏上」，界面永远停在转圈。
  if (curRec && curRec.id === raw.id && curRec.chart) return { action: 'keep' };
  // ⚠ 条件里的 `curRec.chart` 不能少：正在 hydrate（盘还没出来）时 id 可能已相同，
  //   少了它就会把「正在排盘」误判成「已经在屏上」，界面永远停在转圈。


  // 刚从排盘页过来（完整盘）→ 直接用
  if (raw.chart) return { action: 'full', rec: raw };

  // 从记录页过来的轻记录 → 现场重排
  return { action: 'hydrate', rec: raw };
}

/** loadPlanOf 的 'full' / 'hydrate' 两条都要先铺一层面板状态 */
function panelForLoading() {
  return { rec: null, hydrating: true, saved: false, save: { state: 'idle', text: SAVE_TEXT.idle, disabled: true } };
}

/* ------------------------------------------------------------------ ② */

/**
 * 「已保存 / 未保存」只由来路决定 —— 见文件头。
 * @param {'paipan'|'records'} source
 */
function savedOf(source) {
  // 记录页点进来的：它本来就是云端列表里的一条，必已保存
  return source === 'records';
}

/**
 * 盘算好了（或直接拿到完整盘）→ 面板该长什么样。
 * @param {Object|null} rec   完整记录（null = 出生信息非法 / 重排失败 → 空态）
 * @param {boolean}     saved 来路决定的「已保存」
 */
function panelForLoaded(rec, saved) {
  // ⚠ 重排失败（rec 为 null）时 saved 必须**强制 false**：
  //   屏上根本没有盘，按钮却写着「已保存到记录」，是彻头彻尾的谎话。
  if (!rec) {
    return { rec: null, hydrating: false, saved: false, save: saveIdle(false) };
  }
  const isSaved = !!saved;
  return { rec: rec, hydrating: false, saved: isSaved, save: saveIdle(isSaved) };
}

/* ------------------------------------------------------------------ ③ */

/**
 * history.push() 的结果 → 保存按钮的新状态。
 *
 * ⚠ 三种失败各有各的话：登录没标识 / 出生信息不全 / 其它（网络）。
 *   把它们混成一句「保存失败」，用户不知道该去登录还是该重试。
 *
 * @param {Object} res history.push 的返回
 * @returns {{ok:boolean, saved:boolean, save:Object, toast:string}}
 */
function saveStateOf(res) {
  if (res && res.ok) {
    return {
      ok: true,
      saved: true,
      save: { state: 'idle', text: SAVE_TEXT.saved, disabled: true },
      toast: '已保存到记录'
    };
  }

  // ⚠ 三种失败各有各的话。混成一句「保存失败」，用户不知道该去登录还是该重试。
  if (res && res.reason === 'no-login') {
    return {
      ok: false,
      saved: false,
      save: { state: 'fail', text: SAVE_TEXT.noLogin, disabled: false },
      toast: '登录后才能保存到云端'
    };
  }
  if (res && res.reason === 'bad-record') {
    return {
      ok: false,
      saved: false,
      save: { state: 'fail', text: SAVE_TEXT.badRecord, disabled: false },
      toast: '这条记录的出生信息不全'
    };
  }
  return {
    ok: false,
    saved: false,
    save: { state: 'fail', text: SAVE_TEXT.failed, disabled: false },
    toast: '云端保存失败，点一下重试'
  };
}

/** 点下保存那一瞬间的按钮态（写云端中，不可点） */
function savePending() {
  return { state: 'pending', text: SAVE_TEXT.saving, disabled: true };
}

/* -------------------------------------------------- 保存前的小窗（姓名/描述） */

/**
 * 点「保存到记录」时弹出的那个小窗的状态。
 *
 * ⚠⚠ 为什么要有这一步：排盘页**不再收姓名/描述**（用户要求），
 *   但记录里还是要有名字 —— 于是把它挪到「保存」这一刻来问，
 *   这是用户唯一一次「要把这条存下去」的明确表态，此时问最有意义。
 * ⚠★ 2026-10-05 用户又要求「点保存能不能同时有选择标签的功能」——
 *   于是同一刻也问标签。**这是本页唯一一次「还没保存就先选好标签」的机会**：
 *   记录此刻还没有 id，归类得等 `history.push` 拿到 id 之后补一次
 *   （见 Result.tsx 的 onSaveAskConfirm），所以这里存的只是**草稿**。
 *
 * ⚠ 五个字段各管一件事，别合并：
 *   · `show`   —— 窗开不开
 *   · `name` / `desc` / `job` —— 三个输入框的**草稿值**
 *   · `tagId`  —— 标签草稿（`null` = 未分类）。⚠ 它**只活在窗里**，
 *                绝不能被 saveAskCommit 写进轻记录（那里根本没这个字段）。
 *   · `saving` —— 提交中（此时不给关窗，请求回来没地方落结果）
 */
function saveAskOf(patch) {
  const base = { show: false, name: '', desc: '', job: '', tagId: null, saving: false };
  return Object.assign(base, copyOf(patch));
}

/** 在现有小窗上打补丁（其余字段保留） */
function saveAskPatch(cur, patch) {
  return Object.assign(saveAskOf(copyOf(cur)), copyOf(patch));
}

/**
 * 开窗。⚠ **预填记录里已有的值** ——
 *   用户可能之前在「详细信息」里改过名字，保存失败后重试时不该让他重打一遍。
 */
function saveAskOpen(rec) {
  const r = rec || {};
  return saveAskOf({
    show: true,
    name: typeof r.name === 'string' ? r.name : '',
    desc: typeof r.desc === 'string' ? r.desc : '',
    job: typeof r.job === 'string' ? r.job : ''
  });
}

/**
 * 关窗。⚠ 关掉时**清空草稿**：下次开窗必须重新按记录预填，
 *   不能留着上一次没提交的残值（那会让人以为「已经填进去了」）。
 */
function saveAskClose() {
  return saveAskOf();
}

/**
 * 「确定」时把草稿写进记录。
 *
 * ⚠⚠ 走的是**整行覆盖**那条路（同 onEditCommit），所以必须用 `mergePatch`
 *   把原记录原样带上 —— 只改 name / desc，其余字段（notes / gender / 出生时间…）
 *   一个都不能丢。直接 `Object.assign({}, rec, {...})` 也行，但会把这页
 *   hydrate 出来的 chart/bazi 一起带上云（几百 KB），所以固定用 mergePatch。
 *
 * ⚠ 姓名与职业**要 trim**（都是单行字段，首尾空格没意义；空名 = 用默认「未命名」，
 *   由 record 层兜底）；描述**不 trim**（多行文本，前后空白可能是排版的一部分，
 *   语义与那两个相反）。
 *
 * ⚠⚠⚠ **`tagId` 刻意不在这里出现**：它是窗里的草稿，不是记录行的字段。
 *   记录行里根本没有 `tagId` 这个键（它只是 `GET /records` 的只读派生字段），
 *   整行 PUT 也不认它 —— 把它塞进轻记录 = 往云端写一个服务端不认识的键。
 *   归类走的是**另一次专用请求**（`PUT /records/:id/tag`），
 *   而且要等 push 成功、这条记录有了 id 才发（见 Result.tsx）。
 */
function saveAskCommit(ask, rec, mergePatchFn) {
  const a = saveAskOf(ask);
  const next = { name: String(a.name == null ? '' : a.name).trim() };
  /* ⚠ 描述为纯空白时写 undefined（真删键），而不是留一个 ''：
     留 '' 会被 optionals 摘掉、行为一样，但语义上「没填」比「填了空」诚实。 */
  const d = a.desc == null ? '' : String(a.desc);
  next.desc = d.trim() ? d : undefined;
  /* ⚠ 职业跟姓名**同一套**：单行 ⇒ trim；纯空白 = 清空（写 undefined 真删键）。 */
  const j = String(a.job == null ? '' : a.job).trim();
  next.job = j || undefined;
  return mergePatchFn(rec, next);
}

/**
 * ★ 保存窗里那一排「选标签」的格子（喂给 `TagBar`）。
 *
 * ⚠ 与记录页顶部的 `model.tagBar()` **刻意不是同一个函数**，别合并：
 *   那个是**筛选项**（头一格是「全部」＝不过滤，点它换列表）；
 *   这个是**归类**（头一格是「未分类」＝这条不归类，点它改草稿）。
 *   两者只是长得像（都是横排 chip），**语义正相反** ——
 *   「全部」与「未分类」差一个字，混起来就是「点了一下，记录从所有标签里消失」。
 *
 * ⚠ 一条标签都没建时这里只回「未分类」一格 ⇒ 调用方**整块不显示**
 *   （选「未分类」等于什么都没做，白占一行）。
 *
 * @param {Array} tags    `/tags` 回来的标签（带 count）
 * @param {string|null} tagId 窗里当前的草稿（null = 未分类）
 * @returns {Array<{key:string,label:string,count:number,on:boolean}>}
 */
function saveAskBar(tags, tagId) {
  const cur = tagId === undefined || tagId === null || tagId === '' ? null : String(tagId);
  const items = [{ key: tagsLib.TAG_NONE, label: '未分类', count: 0 }];
  for (const t of (Array.isArray(tags) ? tags : [])) {
    if (!t || !t.id) continue;
    items.push({
      key: t.id,
      label: String(t.name || ''),
      count: typeof t.count === 'number' ? t.count : 0
    });
  }
  return items.map(function (it) {
    /* ⚠⚠ 判「是不是当前那格」要**先看草稿是不是 null**：
       未分类在 `items` 里的 key 是保留值 `TAG_NONE`（'none'），而草稿里它是 `null` ——
       直接写 `it.key === cur` 会让「未分类」这一格**永远不高亮**（null ≠ 'none'），
       一打开弹窗看上去就像「没选中任何标签」。 */
    const on = cur === null ? it.key === tagsLib.TAG_NONE : it.key === cur;
    return { key: it.key, label: it.label, count: it.count, on: on };
  });
}

/**
 * 保存窗里点了某一格 → 新的草稿 tagId（`TAG_NONE` / 空 → **null**）。
 *
 * ⚠ 保留值 'none' 的翻译**必须只有这一处**：漏翻 = 拿一个叫 `none` 的 id 去写库，
 *   服务端会当成「一个真的叫 none 的标签」处理 —— 归类静默失败、界面还显示成功了。
 */
function saveAskTag(key) {
  const k = key === undefined || key === null ? '' : String(key);
  return k === '' || k === tagsLib.TAG_NONE ? null : k;
}

/* ------------------------------------------------------------------ ④ */

/**
 * 事件编辑框的完整状态；每次换都**整份换**。
 * ⚠ 不用「editor.xxx」这种路径式更新 —— 老基础库行为不一致，RN 这边也不做路径 setData。
 */
function editorOf(patch) {
  const base = { show: false, title: '', key: '', meta: null, text: '', saving: false };
  return Object.assign(base, copyOf(patch));
}

/** 在现有编辑框上打补丁（其余字段保留）—— onNoteInput / 保存中 都走它 */
function editorPatch(cur, patch) {
  return Object.assign(editorOf(copyOf(cur)), copyOf(patch));
}

/** 长按某一格 → 编辑框该长什么样（已有内容回填，便于修改 / 清空） */
function editorForNote(v, notes) {
  const d = v || {};
  if (!d.key) return { ok: false, editor: null, toast: '这一格没有可记的位置' };
  return {
    ok: true,
    editor: {
      show: true,
      title: d.title || '记事件',
      key: d.key,
      meta: d.meta || null,
      text: notesLib.textOf((notes || {})[d.key]),
      saving: false
    },
    toast: ''
  };
}

/**
 * 点编辑框外面那块遮罩，该干什么。
 *
 * ⚠⚠ 这是个**两段式**，不是一句 onClose：
 *   键盘弹着时点空白，用户的意图几乎总是「先收起键盘看一眼」，
 *   而不是「关掉编辑框」。如果这里直接关，未保存的正文**当场丢光**
 *   —— 而且他再长按打开时看到的是云端旧内容，会以为「刚才白写了」。
 *   所以：键盘弹着 → 只收键盘；键盘收了再点 → 才关。
 *
 * ⚠ saving 时一律 none：保存中关掉框，请求回来就没地方落结果了。
 *
 * @param {boolean} saving  是否正在保存
 * @param {boolean} kbShown 键盘当前是否弹着
 * @returns {'none'|'dismiss-keyboard'|'close'}
 */
function maskTapAction(saving, kbShown) {
  if (saving) return 'none';
  if (kbShown) return 'dismiss-keyboard';
  return 'close';
}

/**
 * 编辑框确认 → 新的 notes 与该条事件。
 *
 * ⚠ **清空正文 = 删除这一条事件**（照参考项目：删除不设单独入口，
 *   否则「有两套删除途径」迟早对不上）。
 * ⚠ 元信息是**写入时快照**的（见 core/notes.js）：读的时候不回算，
 *   所以「事件记录」页签只读 notes 就能渲染，不必再排一遍盘。
 * ⚠ 空串 / undefined / null 的字段不写进去 —— 免得云端存一堆 `md: ''`。
 * ⚠ 失败时那份 notes 要原样留着（不能已经被改脏），所以这里返回**新的副本**，
 *   调用方只在成功后才 applyNotes。
 *
 * @param {Object} notes 当前 notes
 * @param {Object} editor 编辑框（{ key, text, meta }）
 * @returns {{ok:boolean, key:string, text:string, notes:Object, deleting:boolean, toast:string}}
 */
function noteItemOf(notes, editor) {
  const ed = editor || {};
  if (!ed.key) return { ok: false, key: '', text: '', notes: copyOf(notes), deleting: false, toast: '没有要记的位置' };

  // ⚠ 必须是**新的副本**（copyOf）：失败时页面要把原 notes 原样留着，
  //   直接改原对象会让「保存失败」之后屏上的内容已经变脏。
  const next = copyOf(notes);
  const text = String(ed.text || '').replace(/\r\n/g, '\n').trim();
  // ⚠ 清空正文 = **删除**这条事件（不是存一条空 text）——
  //   存空的会让格子上的红点永远消不掉。
  const deleting = !text;

  if (deleting) {
    delete next[ed.key];
  } else {
    const item = { text: text };
    const m = ed.meta || {};
    // ⚠ 白名单：meta 里还带着组件自己的字段，只快照 NOTE_META_FIELDS 里的。
    //   up / up2 必须在表里，否则父级那一行自己没写时时间线只剩「【大运】」。
    NOTE_META_FIELDS.forEach(function (f) {
      const v2 = m[f];
      if (v2 !== undefined && v2 !== null && v2 !== '') item[f] = v2;
    });
    next[ed.key] = item;
  }

  return {
    ok: true,
    key: ed.key,
    text: text,
    notes: next,
    deleting: deleting,
    toast: deleting ? '已删除' : '已记下'
  };
}

/** history.saveNotes() 的结果 → 提示文案（失败时编辑框与内容都留着） */
function noteSaveToast(res) {
  if (res && res.ok) return '';
  if (res && res.reason === 'no-login') return '登录后才能保存到云端';
  if (res && res.reason === 'not-found') return '云端没有这条记录，回记录页重进一次';
  return '保存失败，请重试';
}

/* ------------------------------------------------------------------ 页签 */

/**
 * 顶部切换栏。
 * ⚠ 只切「看哪一块」，**不碰盘本身**：三个面板都挂载着、靠 display 切
 *   （不是条件渲染）—— 所以切走再切回不会重建 ChartView，
 *   组件里「选中哪步大运 / 流年 / 流月」这些内部状态得以保留，切换也是瞬时的。
 * ⚠ 未知 key 直接忽略：宁可停在原页签，也不要切出一块空白。
 * ⚠ 换页签**不改 saved** —— 「已保存」是数据事实，跟看哪一块无关。
 *
 * @returns {string|null} null = 不切换
 */
function nextTab(cur, key) {
  // ⚠ 未知 key 一律忽略（返回 null）：宁可停在原地，也不要切出一块空白
  if (TAB_KEYS.indexOf(key) < 0) return null;
  if (key === cur) return null;
  return key;
}

/**
 * 「事件记录」那道门：没保存就挡着。
 * ⚠ 2026-10-21 起只剩「事件记录」一个页签在用（师傅批字页签已隐藏，见 TAB_KEYS），
 *   函数本身**不动** —— 它判的是「这个页签要不要等保存」，与页签有几个无关。
 */
function gateOf(activeTab, saved, hasRec, hydrating) {
  if (activeTab === 'chart') return { show: false, hint: '', mode: 'normal' };
  if (saved) return { show: false, hint: '', mode: 'normal' };
  if (hasRec) return { show: true, hint: '这条八字还没存进记录，保存后即可使用', mode: 'save' };
  if (hydrating) return { show: true, hint: '正在把这条记录排成盘，稍候', mode: 'hydrating' };
  // ⚠ hydrate 期间 rec 还是 null，所以 hasRec 那支不会截胡，会自然落到 hydrating。
  //   千万别把 hydrating 挪到 hasRec 前面还顺手改文案 —— 负向用例 20 的锚点
  //   就是这两行的**原始形状**，动了它那条用例就跑不起来了。
  return { show: true, hint: '还没有排盘数据，先回排盘页排一次', mode: 'gap' };
}

/* -------------------------------------------------------------- 详细信息 */

/**
 * 「详细信息」页签要展示的字段行。
 *
 * ⚠⚠ 这里是**纯展示**：只把已有字段排成「标签 + 值」两列，一个字都不算。
 *   出生时间那两行直接取 `rec.dateText` / `rec.timeText`（hydrate 已经算好了
 *   公历文案 + 农历文案），**不要在这里再调一次 timeUtil / lunar** ——
 *   那就成了「同一件事有两份实现」，将来历法口径一改必然对不齐。
 *
 * ⚠ 值为空的字段**整行不出现**（不是显示「—」）：名字没填就走默认值「未命名」，
 *   而描述可以真的没有 —— 那时界面上应该干脆没有这一行，
 *   而不是留一个空荡荡的「描述：」在那儿。
 *
 * ⚠⚠ **但「描述」与「职业」是例外**（描述是用户 2026-10-03 明确要求的：
 *   「描述字段不管是不是空的，都要显示描述一栏」；职业 2026-10-06 加字段时
 *   「同姓名和描述一样」⇒ 同一套规则）：
 *   它们**可以被用户主动清空**（`editCommit` 把纯空白写成 `undefined`），
 *   如果清空之后整行消失，用户就**没有入口再把它填回来**了 ——
 *   那一栏等于一次性消耗品。姓名不受影响（它不允许为空）。
 *
 * @param {Object|null} rec 完整记录（可能为 null / 只有轻记录字段）
 * @param {Object} [deps] { genderText, emptyText } 注入用；默认自己判 1/0
 * @returns {Array<{label:string, value:string, multiline:boolean, always:boolean, empty:boolean}>}
 */
function detailRowsOf(rec, deps) {
  if (!rec) return [];
  const d = deps || {};
  const g = typeof d.genderText === 'function'
    ? d.genderText(rec.gender)
    : (rec.gender === 0 ? '女' : '男');

  const rows = [];
  const push = function (label, value, multiline) {
    const v = value === undefined || value === null ? '' : String(value);
    if (!v.trim()) return;              // 空值整行不要（见上面注释）
    rows.push({
      label: label, value: v, multiline: !!multiline, always: false, empty: false
    });
  };

  push('姓名', rec.name);
  push('性别', g);

  /* ⚠⚠ 职业：**恒显行**（与描述同一套规则，见上面那段注释）——
     它是选填、且可以被用户清空，清空后整行消失就没有入口再填回来了。
     ⚠ 单行文本 ⇒ multiline:false；`value` 空时给**空字符串**（占位文案是视图的事）。 */
  const jobRaw = rec.job === undefined || rec.job === null ? '' : String(rec.job);
  rows.push({
    label: '职业',
    value: jobRaw,
    multiline: false,
    always: true,
    empty: !jobRaw.trim()
  });

  /* ⚠ 优先用 dateText（hydrate 排出来的规范文案），退回裸的 date 字段：
     冷启动直接进本页时可能只有轻记录，那时没有 dateText，但有 date。 */
  const dateTxt = rec.dateText || rec.date;
  const lunarTxt = rec.lunarText;
  /* ⚠⚠ 出生时间**不单独占一行**（用户 2026-10-03 明确要求）：
     公历、农历**各带一次**时间，比「时辰」孤零零挂一行更好读 ——
     看农历那行时不用再回头找上面那行的钟点。 */
  const timeTxt = rec.timeText || rec.time;
  const withTime = function (t) {
    if (!t || !String(t).trim()) return t;
    return timeTxt && String(timeTxt).trim() ? t + ' ' + timeTxt : t;
  };
  push('公历', withTime(dateTxt));
  push('农历', withTime(lunarTxt));

  /* ⚠⚠ 描述**永远占一行**（用户要求，见文件头那段注释）。
     ⚠ `value` 在空的时候给**空字符串**（不是占位文案）——占位文案是**视图的事**：
       model 只管「有没有值」，要不要把「未填写」画成灰字由视图决定。
       ⚠ 描述可能是多行（导入的评语里有换行），标出来让视图用能换行的样式。 */
  const descRaw = rec.desc === undefined || rec.desc === null ? '' : String(rec.desc);
  rows.push({
    label: '描述',
    value: descRaw,
    multiline: true,
    always: true,
    empty: !descRaw.trim()
  });

  return rows;
}

/* ------------------------------------------------ 本页的编辑 / 删除（纯计算） */

/**
 * 「本页正在编辑什么」的状态工厂。
 *
 * ⚠⚠ **整块进入修改态，两个字段同时可编**（用户 2026-10-03 要求）：
 *   原来是一行一行点着改（`mode: 'name' | 'desc'` 二选一），现在由底部的
 *   「修改」按钮**一次把姓名 + 描述都变成输入框**，改完点一次「保存」一起提交。
 *   理由：一次想把名字和描述都调一下的时候，不必点两次、也不必担心
 *   「改了名字没提交就去点描述，那个没提交的值会跳走」这类串味问题 ——
 *   两个输入框同时在，谁的草稿都丢不了。
 *
 * ⚠ 字段：
 *   · `on`     —— 在不在修改态（⚠ 不是 `mode`：没有「只改一个字段」这回事了）
 *   · `name` / `job` / `desc` —— 三个输入框各自的**草稿值**
 *   · `saving` —— 提交中（此时不给关，请求回来没地方落结果）
 *
 * @returns {{on:boolean, name:string, job:string, desc:string, saving:boolean}}
 */
function editOf() {
  return {
    on: false, name: '', job: '', desc: '',
    /* 出生三项（2026-10-21）：修改态里的**草稿** —— 在「出生时间」那一行改，
       只在按「保存」时才写进记录（用户原话：「只是点更新排盘的话，只是选中性别和时间，
       不触及更改后端的数据」）。 */
    gender: 1, date: '', time: '',
    saving: false
  };
}

/**
 * 进入修改态（由底部「修改」按钮触发）。
 * ⚠ **所有可改字段都按记录里的现值预填** —— 打开就能看到现在是什么，改哪个动哪个。
 * @param {Object} rec 当前记录（用来取初值）
 */
function editStart(rec) {
  const r = rec || {};
  return {
    on: true,
    name: typeof r.name === 'string' ? r.name : (r.name == null ? '' : String(r.name)),
    job: typeof r.job === 'string' ? r.job : '',
    desc: typeof r.desc === 'string' ? r.desc : '',
    /* ⚠ 出生三项取的是**记录的裸字段**（公历 date / HH:mm）——
       不是 dateText / timeText 那些给人看的文案，表单要的是能回填的值。 */
    gender: r.gender === 0 ? 0 : 1,
    date: typeof r.date === 'string' ? r.date : '',
    time: typeof r.time === 'string' ? r.time : '',
    saving: false
  };
}

/**
 * 编辑框内容同步（打字 / 选出生时间）。只有传进来的字段被改，其余保持不动。
 * ⚠ 姓名与职业**要 trim、描述不 trim**：
 *   前两个是单行文本、首尾空格没有意义，描述是多行文本、
 *   首尾可能有用户自己排的版。⇒ 提交时对姓名 / 职业做 trim，对描述**原样**。
 *
 * @param {Object} cur 现有状态
 * @param {{name?:string, job?:string, desc?:string, gender?:number, date?:string, time?:string, saving?:boolean}} patch
 */
function editPatch(cur, patch) {
  const c = cur || editOf();
  const p = patch || {};
  return {
    on: p.on !== undefined ? p.on : c.on,
    name: p.name !== undefined ? p.name : c.name,
    job: p.job !== undefined ? p.job : c.job,
    desc: p.desc !== undefined ? p.desc : c.desc,
    gender: p.gender !== undefined ? p.gender : c.gender,
    date: p.date !== undefined ? p.date : c.date,
    time: p.time !== undefined ? p.time : c.time,
    saving: p.saving !== undefined ? p.saving : c.saving
  };
}

/** 退出修改态（⚠ 保存中不给退出：请求回来没地方落结果） */
function editClose(cur) {
  const c = cur || editOf();
  return c.saving ? c : editOf();
}

/**
 * 提交前把三个输入框的内容算成「要写进记录的新值」。
 *
 * @returns {{ok:boolean, patch?:{name?:string,job?:string,desc?:string}, error?:string}}
 *   · 姓名为空 → **拒绝**（名字是列表页的标识，空了那条记录就没法认；
 *     服务端 toLightRecord 也会把它兜成「未命名」，与其让他看到「未命名」，
 *     不如当场说清楚）
 *   · 姓名 / 职业 trim 后写回（都是单行字段）；描述**不 trim**（但纯空白视为「清空描述」）
 *   · ⚠ **只有真的变了的字段才进 patch**：几个字段一起提交时，
 *     没动过的那一个不该被「写一遍」（虽然值一样，但会让服务端白写一次，
 *     也让「值没变 ⇒ 不发请求」这条短路判断失效）
 *   · 全都没变 → ok 但 patch 为空对象，调用方直接退出修改态即可（不必发请求）
 */
function editCommit(cur, rec) {
  const c = cur || editOf();
  const nameRaw = String(c.name === undefined || c.name === null ? '' : c.name);
  const jobRaw = String(c.job === undefined || c.job === null ? '' : c.job);
  const descRaw = String(c.desc === undefined || c.desc === null ? '' : c.desc);

  const name = nameRaw.trim();
  if (!name) return { ok: false, error: '姓名不能为空' };

  const patch = {};

  const prevName = rec && rec.name != null ? String(rec.name) : '';
  if (name !== prevName.trim()) patch.name = name;

  /* ⚠ 职业与姓名同一套：trim 后比较；纯空白 = 清空（写 undefined 真删键） */
  const nextJob = jobRaw.trim() || undefined;
  const prevJob = (rec && rec.job) || '';
  if ((nextJob || '') !== prevJob) patch.job = nextJob;

  /* ⚠ 纯空白 = 清空描述（写成 undefined，让它在记录里真的消失，
     而不是留一个 '' —— 那会让「有没有描述」这个判断在界面上糊掉） */
  const nextDesc = descRaw.trim() ? descRaw : undefined;
  const prevDesc = (rec && rec.desc) || '';
  if ((nextDesc || '') !== prevDesc) patch.desc = nextDesc;

  /* ---- 出生三项（2026-10-21）：与上面同一套「真变了才进 patch」----
     ⚠⚠ 用户口径：「只是点更新排盘的话，只是选中性别和时间，不触及更改后端的数据」——
       所以「更新排盘」只改**草稿**（edit 里的 gender/date/time），
       写库这件事只发生在**这里**（整条 PUT），也就是「保存」那一下。
     ⚠ 日期 / 时间必须是 `YYYY-MM-DD` / `HH:mm`：草稿只有两种来源
       （记录本身、或排盘表单），拿不到合法值说明状态坏了 ⇒ 拒绝，不猜。 */
  const r = rec || {};
  /* ⚠⚠ 两边都**归一化**后再比：老记录可能根本没有 gender 字段，
     直接 `Number(r.gender)` 会得到 NaN，`NaN !== 1` 恒为真 ⇒
     空 patch 里被塞进一个 `gender:1`，「什么都没改」的短路就失效了。 */
  const nextGender = c.gender === 0 ? 0 : 1;
  const prevGender = r.gender === 0 ? 0 : 1;
  if (nextGender !== prevGender) patch.gender = nextGender;
  const nextDate = String(c.date === undefined || c.date === null ? '' : c.date).trim();
  const nextTime = String(c.time === undefined || c.time === null ? '' : c.time).trim();
  /* ⚠ 只在**真的动了**出生时才校验：老记录 date 可能不是标准写法，
     但用户没碰它就不该拦着「改姓名」。 */
  const birthTouched = nextDate !== String(r.date || '') || nextTime !== String(r.time || '');
  if (birthTouched) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return { ok: false, error: '出生日期不完整' };
    if (!/^\d{1,2}:\d{2}$/.test(nextTime)) return { ok: false, error: '出生时间不完整' };
  }
  if (nextDate !== String(r.date || '')) patch.date = nextDate;
  if (nextTime !== String(r.time || '')) patch.time = nextTime;

  return { ok: true, patch: patch };
}

/**
 * 改完保存那句提示（纯函数，好断言）。
 *
 * ⚠⚠ 为什么必须算：可能改了三个字段里的任意组合，**不能说一句不分青红皂白的话**
 *   （原来只有姓名/描述两个时写的是三元表达式，加一个字段就退化成谎话：
 *   比如只改了职业却提示「描述已保存」）。
 *
 * @param {{name?:string, job?:string, desc?:string}} patch 已提交的改动
 * @returns {string} 空 patch → 空串（调用方不会走到这一步）
 */
function editToast(patch) {
  const p = patch || {};
  const names = [];
  if (p.name !== undefined) names.push('姓名');
  if (p.job !== undefined) names.push('职业');
  if (p.desc !== undefined) names.push('描述');
  /* 出生三项合并成一句「出生时间」：用户眼里它就是一件事（改了哪一项不重要，
     重要的是「盘已经按新时间重排了」）。 */
  if (p.gender !== undefined || p.date !== undefined || p.time !== undefined) names.push('出生时间');
  if (!names.length) return '';
  /* ⚠ 只改了姓名时保留原来那句「已改」：姓名是标识，改它和改资料不是一回事 */
  if (names.length === 1) {
    if (names[0] === '姓名') return '姓名已改';
    if (names[0] === '出生时间') return '出生时间已更新，盘面已重排';
    return names[0] + '已保存';
  }
  return names.join('、') + '都已保存';
}

/**
 * 修改态「出生时间」那一行显示什么（用户 2026-10-21：
 *   「修改状态下的时间除了阳历还要显示农历和性别，因为这些都是在排盘页面可以改到的数据」）。
 *
 * 返回两段：
 *   · `solar` —— 阳历 + 时刻（`2014-10-21 11:04`），主行
 *   · `sub`   —— `农历 甲午年九月初八 · 男`，副行
 *
 * ⚠⚠⚠ **全部读草稿**（`edit`），读不到才退回记录：点「确定」不写后端，
 *   读记录就永远显示旧值（2026-10-21 踩过，用户报「没显示我确定的时间」）。
 * ⚠⚠ 农历是**派生值，必须按草稿日期重算**：拿 `rec.lunarText` 充数的话，
 *   日期换了农历不动 —— 两行字自己打架，比不显示更糟。
 * ⚠ 用 `edit.on` 判断草稿是否有效：`editOf()` 默认 `gender: 1`，
 *   拿它当「用户选了男」就会把女命的记录显示成男（未进修改态时尤其明显）。
 * ⚠ 换算失败（日期不合法 / 超出农历表范围）不抛：农历留空，阳历照显。
 *   校验是「保存」那一关的事（`editCommit`），这里不抢着报错。
 *
 * @param {Object} rec  当前记录
 * @param {Object} edit 修改态草稿
 * @returns {{solar:string, sub:string, gender:number, date:string, time:string}}
 */
function birthOf(rec, edit) {
  const r = rec || {};
  const e = edit || {};
  const draft = e.on === true;

  const date = String((draft && e.date) || r.date || r.dateText || '').trim();
  const time = String((draft && e.time) || r.time || r.timeText || '').trim();
  const gender = (draft && (e.gender === 0 || e.gender === 1) ? e.gender : r.gender) === 0 ? 0 : 1;

  const solar = [date, time].filter(Boolean).join(' ');

  /* 农历：只认标准公历日期；跟着**草稿日期**算 */
  let lunarText = '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m) {
    try {
      const l = lunarLib.solarToLunar(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
      lunarText = l && l.text ? String(l.text) : '';
    } catch (err) {
      lunarText = '';
    }
  }
  /* 兜底：日期不是标准写法时（老记录）才用记录里那份，别显示一个空农历 */
  if (!lunarText && !draft) lunarText = String(r.lunarText || '').trim();

  const sub = (lunarText ? '农历 ' + lunarText + ' · ' : '') + (gender === 0 ? '女' : '男');

  return { solar: solar, sub: sub, gender: gender, date: date, time: time };
}

/**
 * 把 patch 并进记录，得到**要 PUT 上去的整条轻记录**。
 * ⚠⚠ 必须走 record.toStorage()（它会剥掉 chart / bazi / lunarText 这些派生字段），
 *   绝不能直接把 hydrate 出来的整条 rec 传上去 —— 那会把几百 KB 的盘面塞进请求体，
 *   服务端也不认这些字段。这一点与「保存到记录」走的是同一条纪律。
 */
function mergePatch(rec, patch) {
  if (!rec) return null;
  const light = record.toStorage(rec) || {};
  const out = {};
  Object.keys(light).forEach(function (k) { out[k] = light[k]; });
  Object.keys(patch || {}).forEach(function (k) {
    if (patch[k] === undefined) delete out[k];
    else out[k] = patch[k];
  });
  return out;
}

/**
 * 删除二次确认的文案。
 * ⚠ 必须说清「删了就没了」—— 结果页的删除**没有回收站**，
 *   点到就真删（服务端是硬 DELETE）。
 */
function deleteConfirmText(rec) {
  const nm = (rec && rec.name) || '这条八字';
  return {
    title: '删除' + nm + '？',
    body: '删除后这条记录和它的事件记录都会消失，且无法恢复。',
    ok: '删除',
    cancel: '取消'
  };
}

/* ---------------------------------------- 删除的「随机数字」二次确认（用户要求） */

/** 随机数字的位数（含两端）。4 位够挡误触，又不至于让用户输到烦。 */
const DEL_CODE_LEN_MIN = 4;
const DEL_CODE_LEN_MAX = 5;

/**
 * 生成一串**随机数字**，作为删除的通关口令。
 *
 * ⚠⚠ 为什么不用「打个勾 / 点两下」这种确认：删除**不可逆**（服务端硬 DELETE），
 *   而「再点一次」是**肌肉记忆就能过**的 —— 手指连着点两下就删掉了。
 *   要求**读出并键入一串随机数字**，强制眼睛和手都参与，误触几乎不可能发生。
 *
 * ⚠⚠⚠ **必须用 `Math.random()` 逐位生成，不许 `Math.random()` 取整后按时长拼**：
 *   要保证每一位都是独立的随机数字，而且**首位可以是 0**
 *   （用数值思路写（`1000 + Math.floor(rand*9000)`）会永远拿不到首位 0，
 *   等于把 4 位口令砍成 9000 种 —— 这是细节，也是「数字字符串≠数字」的典型坑）。
 *
 * @param {Function} [rnd] 注入随机源（测试用；默认 Math.random）
 * @returns {string} 纯数字字符串，长度在 [DEL_CODE_LEN_MIN, DEL_CODE_LEN_MAX]
 */
function deleteCodeNew(rnd) {
  const rand = typeof rnd === 'function' ? rnd : Math.random;
  const span = DEL_CODE_LEN_MAX - DEL_CODE_LEN_MIN + 1;
  const len = DEL_CODE_LEN_MIN + Math.floor(rand() * span);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += String(Math.floor(rand() * 10));
  }
  return out;
}

/**
 * 校验用户输入的口令。
 *
 * @param {string} code 弹窗打开时生成的正确口令
 * @param {string} input 用户输入的
 * @returns {{ok:boolean, error?:string, empty:boolean}}
 *   · ⚠ **两侧都 trim**：手机键盘容易带出尾随空格 / 输入法回车上屏，
 *     拿原样比会让用户「明明打对了却删不掉」，且看不出去哪说理。
 *   · ⚠ 空输入单独标一个 `empty`：按钮的禁用状态要用它
 *     （空着就把「删除」画成灰的，别让他点一下才被告知「请输入」）。
 */
function deleteCodeCheck(code, input) {
  const want = code === undefined || code === null ? '' : String(code).trim();
  const got = input === undefined || input === null ? '' : String(input).trim();
  if (!got) return { ok: false, error: '请输入上面的数字', empty: true };
  if (got !== want) return { ok: false, error: '数字不对，请照着上面那一串输入', empty: false };
  return { ok: true, empty: false };
}

/* -------------------------------------------------------------- 师傅批字 */

/**
 * 「师傅批字」页签 —— 一份八字一个会话，锚点就是这条记录的 id。
 * （服务端那张表长什么样、为什么用 record_id 当锚点：见 core/comments.js 文件头）
 *
 * ⚠⚠ 这一节是**纯逻辑**（不 require React / RN / core），所以能在 Node 里直接断言。
 *   真正发请求的部分在 core/comments.js，这里只负责「拿到数据之后怎么摆」。
 */

/** 页面上出现的固定文案（⚠ 视图里别再抄一份） */
const CHAT_TEXT = {
  /**
   * 三态里的第一态 = **还没发起求测**。
   * ⚠ 这里不再是「在下面写你的问题」—— 未发起时输入条根本不出（见 chatPhase）。
   */
  empty: '还没请师傅看过这个八字。点下面的按钮发起求测。',
  reqBtn: '发起求测',
  /**
   * 三态里的第二态 = 单子已经递出去了，**还没人接**。
   * ⚠⚠ 这一态是 2026-10-05 才有的：旧模型里「提交了但没人接」根本无处安放 ——
   *   那时「提交」就等于「往 comments 写了一条消息」，而消息是会话，不是工单。
   */
  waiting: '已提交求测，等师傅接单…',
  /** 三态里的第三态 = 师傅已经接了单，但还没说话（给用户一个「该你了」的提示） */
  takenEmpty: '师傅已接单，可以在下面写下你想问的事。',
  /**
   * ⚠⚠ 这里**不再有 reqText**：发起求测**不发消息**。
   *   用户拍板：「App 上点击发起求测并不是发送一个聊天」——
   *   它落的是 `requests` 一行（单子），**一个字都不写 comments**。
   *   旧实现靠「替你写一句『请师傅批一批这个八字。』」让会话出现 ——
   *   那一条消息同时承担了「下单」和「说第一句话」两件事，两件都不干净。
   */
  unsupported: '师傅批字只在自建后端下可用（当前后端没有这张表）',
  loadFail: '消息没拉下来',
  reqLoadFail: '求测单没拉下来',
  reqFail: '发起求测失败',
  sendFail: '发送失败',
  sending: '提交中…',
  placeholder: '写下你的问题…',
  send: '发送',
  hint: '这个会话只属于这一份八字，别的八字看不到'
};

/**
 * 输入框的上限。
 *
 * ⚠⚠ 这个数字**与服务端 `routes/comments.ts` 的 TEXT_MAX 是同一个**（2000）。
 *   两处必须一起改：输入框比服务端宽，用户会在「写完了才被拒」上撞墙；
 *   比服务端窄则纯属白限。这是跨端常量，绕不开「两处」，只能靠这条注释拴住。
 */
const CHAT_INPUT_MAX = 2000;

function chatPad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 消息的时间文案（纯展示；服务端存的永远是毫秒，不存文案）。
 *   今天 → 'HH:mm'；跨天 → 'MM-DD HH:mm'。
 * ⚠ `nowMs` 可注入：否则这个函数依赖「现在」，测试里没法断言。
 */
function chatTimeOf(ms, nowMs) {
  const t = Number(ms) || 0;
  if (!t) return '';
  const d = new Date(t);
  const now = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
  const hm = chatPad2(d.getHours()) + ':' + chatPad2(d.getMinutes());
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hm : chatPad2(d.getMonth() + 1) + '-' + chatPad2(d.getDate()) + ' ' + hm;
}

/**
 * 一条消息 → 界面要的样子。
 *
 * ⚠⚠ 谁是「我」**只看 role**，不比对 uid：
 *   role 是**服务端裁定**的（客户端伪造不了），uid 是客户端手上就有的东西。
 *   而且管理员给自己批字时 uid 本来就一样 —— 用 uid 判会把师傅的话画到右边去。
 */
function chatMsgOf(raw, nowMs) {
  const m = raw || {};
  const role = m.role === 'master' ? 'master' : 'ask';
  return {
    id: String(m.id || ''),
    seq: Number(m.seq) || 0,
    role: role,
    mine: role === 'ask',
    text: String(m.text || ''),
    timeText: chatTimeOf(m.createdAt, nowMs)
  };
}

function chatListOf(list, nowMs) {
  return (Array.isArray(list) ? list : []).map(function (m) {
    return chatMsgOf(m, nowMs);
  });
}

/**
 * 求测单的状态机 —— **界面就是按这个分三种形态画的**。
 *
 *   'loading' 还没拉回来（或正在拉）
 *   'fail'    拉失败 —— 要出「重试」，**不是**出「发起求测」
 *   'none'    这个八字还没发起过求测 → 画那颗「发起求测」按钮
 *   'pending' 单子已递出、**等师傅接单** → 画「等师傅接单」，**没有输入框**
 *   'taken'   已被某位师傅接下 → **这时才出现输入框**，能聊
 *
 * ⚠⚠⚠ 2026-10-05 改的口径：以前「会话出现了没有」=「这个八字下有没有消息」，
 *   现在 = 「**求测单有没有被接**」。用户的模型是三件分开的事：
 *     发起求测（出一张单）→ 师傅接单（单子归他）→ 才有会话。
 *   旧口径把它们压成「有消息就能开聊」，后果很具体：**单子必须靠一条消息
 *   才能存在**，于是「提交了但没人接」这一态根本表示不出来。
 *
 * ⚠ `reqCur` 是**求测单**那个游标（reqIdle / reqLoading / reqLoaded 产出的），
 *   不是消息游标 —— 两者别传错（传错会一直判成 loading，界面卡在转圈）。
 */
function chatPhase(reqCur) {
  const c = reqCur || {};
  if (c.state === 'fail') return 'fail';
  if (c.state !== 'ready') return 'loading';
  const r = c.req;
  if (!r) return 'none';
  /* ⚠ 只有 'taken' 才算「能聊」，其余（含任何没见过的状态值）都当 'pending' ——
     默认方向选「还不能聊」：万一服务端将来多一个状态，最坏也只是少一个输入框。 */
  return r.status === 'taken' ? 'taken' : 'pending';
}

/** 求测单的初始态（还没拉过） */
function reqIdle() {
  return { state: 'idle', req: null, error: '' };
}

/** 正在拉 */
function reqLoading() {
  return { state: 'loading', req: null, error: '' };
}

/**
 * 拉回来的结果 → 单子状态。
 *
 * ⚠⚠ 「还没有单子」是 **ok:true + req:null**（chatPhase 判成 'none'），
 *   与「读失败」（ok:false → 'fail'）是**两件事**。
 *   把失败兜成 null，界面就会把「断网」显示成「你还没求测」——
 *   用户会去点那颗按钮、然后一脸茫然（而且会真的多出一张单）。
 */
function reqLoaded(res) {
  const r = res || {};
  if (!r.ok) {
    return { state: 'fail', req: null, error: r.error || CHAT_TEXT.reqLoadFail };
  }
  return { state: 'ready', req: r.req || null, error: '' };
}

/**
 * 能不能聊 —— 即「师傅已经接下这张单了」。
 * ⚠ 它是**输入条唯一的露出条件**，也是那颗「发起求测」按钮的否定条件：
 *   两者互斥（同一根判据的两头），少了任何一头都会出现「按钮和输入框同时在」。
 */
function chatStarted(reqCur) {
  return chatPhase(reqCur) === 'taken';
}

/** 会话的初始态（还没拉过） */
function chatIdle() {
  return { state: 'idle', list: [], lastSeq: 0, error: '' };
}

/** 正在拉 */
function chatLoading() {
  return { state: 'loading', list: [], lastSeq: 0, error: '' };
}

/** 拉回来的结果 → 会话状态（失败给一句能看的话，列表留空） */
function chatLoaded(res, nowMs) {
  const r = res || {};
  if (!r.ok) {
    return { state: 'fail', list: [], lastSeq: 0, error: r.error || CHAT_TEXT.loadFail };
  }
  return {
    state: 'ready',
    list: chatListOf(r.comments, nowMs),
    lastSeq: Number(r.lastSeq) || 0,
    error: ''
  };
}

/**
 * 把刚发出去的那条并进列表（省一次重拉）。
 * ⚠ 按 id **去重**：重试命中服务端已有那条（duplicated）时，不能插成两条。
 * ⚠ 并完按 seq 排一次：正常情况下它本来就最大，但排一次更稳。
 */
function chatAppend(cur, comment, nowMs) {
  const c = cur || chatIdle();
  const m = chatMsgOf(comment, nowMs);
  /* 没有 id 的东西不进列表：宁可少一条，也不要列表里出现一条点不开的空消息 */
  if (!m.id) return c;
  const has = c.list.some(function (x) { return x.id === m.id; });
  const list = has
    ? c.list.map(function (x) { return x.id === m.id ? m : x; })
    : c.list.concat([m]);
  list.sort(function (a, b) { return a.seq - b.seq; });
  return {
    state: 'ready',
    list: list,
    lastSeq: Math.max(Number(c.lastSeq) || 0, m.seq || 0),
    error: ''
  };
}

/**
 * 能不能发。
 * ⚠ 只判「非空」（顺手去掉首尾空白）—— 长度上限归输入框自己限，
 *   在这里再判一次就是「同一件事两份实现」，而两份的边界迟早会漂。
 * @returns {{ok:boolean, text:string, error:string}}
 */
function chatCanSend(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return { ok: false, text: '', error: '先写点什么' };
  return { ok: true, text: t, error: '' };
}

/** 发送失败的提示语（local 模式下服务端给的中文原文比我们自己写的好，优先用它） */
function chatSendFail(res) {
  const r = res || {};
  return r.error || CHAT_TEXT.sendFail;
}

module.exports = {
  TAB_KEYS: TAB_KEYS,
  TAB_LABELS: TAB_LABELS,
  SAVE_TEXT: SAVE_TEXT,
  NOTE_META_FIELDS: NOTE_META_FIELDS,
  copyOf: copyOf,
  saveIdle: saveIdle,
  emptyPanel: emptyPanel,
  // ① 来路与短路
  loadPlanOf: loadPlanOf,
  panelForLoading: panelForLoading,
  // ② 来路决定 saved
  savedOf: savedOf,
  panelForLoaded: panelForLoaded,
  // ③ 保存
  savePending: savePending,
  saveStateOf: saveStateOf,
  // ③之二 保存前的小窗（姓名 / 描述 / 标签草稿）
  saveAskOf: saveAskOf,
  saveAskPatch: saveAskPatch,
  saveAskOpen: saveAskOpen,
  saveAskClose: saveAskClose,
  saveAskCommit: saveAskCommit,
  saveAskBar: saveAskBar,
  saveAskTag: saveAskTag,
  // ④ 事件编辑框
  editorOf: editorOf,
  editorPatch: editorPatch,
  editorForNote: editorForNote,
  maskTapAction: maskTapAction,
  noteItemOf: noteItemOf,
  noteSaveToast: noteSaveToast,
  // 页签
  nextTab: nextTab,
  gateOf: gateOf,
  // 详细信息
  detailRowsOf: detailRowsOf,
  // 详细信息页的编辑 / 删除
  editOf: editOf,
  editStart: editStart,
  editPatch: editPatch,
  editClose: editClose,
  editCommit: editCommit,
  editToast: editToast,
  birthOf: birthOf,
  mergePatch: mergePatch,
  deleteConfirmText: deleteConfirmText,
  // 删除的随机数字确认
  DEL_CODE_LEN_MIN: DEL_CODE_LEN_MIN,
  DEL_CODE_LEN_MAX: DEL_CODE_LEN_MAX,
  deleteCodeNew: deleteCodeNew,
  deleteCodeCheck: deleteCodeCheck,
  // 师傅批字
  CHAT_TEXT: CHAT_TEXT,
  CHAT_INPUT_MAX: CHAT_INPUT_MAX,
  chatTimeOf: chatTimeOf,
  chatMsgOf: chatMsgOf,
  chatListOf: chatListOf,
  chatIdle: chatIdle,
  chatStarted: chatStarted,
  /* 求测单（工单层）—— 三态就靠这几个摆出来 */
  chatPhase: chatPhase,
  reqIdle: reqIdle,
  reqLoading: reqLoading,
  reqLoaded: reqLoaded,
  chatLoading: chatLoading,
  chatLoaded: chatLoaded,
  chatAppend: chatAppend,
  chatCanSend: chatCanSend,
  chatSendFail: chatSendFail
};
