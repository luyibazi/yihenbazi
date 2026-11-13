/**
 * 四柱筛选的**纯逻辑层**（记录页与学堂页共用）—— 不 import React / RN，可在纯 Node 里断言。
 *
 * ============ 它管什么、不管什么 ============
 * 八个类别 = 四柱的干与支。★ **筛选在服务端执行**（用户明确要求：
 * 「筛选数据最好由后端解决，app 通过输入参数来获取筛选后的数据」），
 * 所以这里的职责只有两件：
 *   ① 把「用户点了哪几个字」维护成一份状态；
 *   ② 把它翻译成 HTTP 查询参数（query）。
 * **绝不在本地 filter 列表** —— 那等于把全量拉到手机上再筛，
 * 既违背约定，也会在数据多的时候变慢。
 *
 * ⚠ 选项表与服务端 `paipan-server/src/lib/recordFilter.ts` 的 FILTER_CATS
 *   **必须逐项对应**（同名 param、同类字符集）：错一个就会出现
 *   「app 发了参数、服务端不认识 ⇒ 静默不过滤」，而界面上看不出来。
 *   两边的常量各有一份（跨进程没法互相 require），所以各有断言守着。
 *
 * ============ 为什么从记录页搬到这里 ============
 * 2026-10-04 用户要求「把筛选功能的组件封装、复用」，学堂页（书签列表）
 * 也要同一套面板。于是：**逻辑在本文件、界面在 components/FilterModal.tsx**，
 * 两个页面各自持有自己的筛选状态 —— 与「记录页的筛选」和「学堂页的筛选」
 * 互不干扰（用户在学堂筛的字不该影响记录页看到的记录）。
 *
 * ⚠ 记录页的 `screens/records/model.js` 仍然**转发**本文件的导出
 *   （`module.exports = {…, ...pillarFilter}`）：那一页的调用点与既有断言
 *   一个字都不用改。改这里就是改那一页的行为。
 */

/* ================================================================
 * 筛选（照搬 mingliWEB 命例列表的那张面板）
 * ================================================================ */
const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

/**
 * 八个筛选类别 —— **顺序就是面板里的显示顺序**（年 → 月 → 日 → 时，每柱先干后支）。
 * @type {{param:string, label:string, chars:string[]}[]}
 */
const FILTER_CATS = [
  { param: 'yearGan', label: '年干', chars: STEMS.split('') },
  { param: 'yearZhi', label: '年支', chars: BRANCHES.split('') },
  { param: 'monthGan', label: '月干', chars: STEMS.split('') },
  { param: 'monthZhi', label: '月支', chars: BRANCHES.split('') },
  { param: 'dayGan', label: '日干', chars: STEMS.split('') },
  { param: 'dayZhi', label: '日支', chars: BRANCHES.split('') },
  { param: 'hourGan', label: '时干', chars: STEMS.split('') },
  { param: 'hourZhi', label: '时支', chars: BRANCHES.split('') }
];

/**
 * 一份空的筛选状态 —— 每个类别都是空集合，表示「全部」（该类不过滤）。
 *
 * ⚠ **空集合 = 全部**，而不是「一个都没选 ⇒ 什么都不显示」。
 *   这正是 mingliWEB 那张面板的语义（每行默认勾着「全部」），
 *   也是最不容易把人筛到空白页的做法。
 *
 * @returns {Object<string, Object<string, boolean>>} 形如 { yearGan: { 甲: true }, … }
 */
function emptyFilter() {
  const out = {};
  FILTER_CATS.forEach(function (c) { out[c.param] = {}; });
  return out;
}

/**
 * 切换某一个字（勾 / 取消）。
 *
 * ⚠ 返回**新对象**，不改传进来的那份 —— 状态是要进 React 的，
 *   原地改不会触发重渲染。
 *
 * @param {Object} sel 当前筛选状态（emptyFilter() 的形状）
 * @param {string} param 类别（如 'dayGan'）
 * @param {string} ch 字（如 '甲'）
 */
function toggleChar(sel, param, ch) {
  const cur = (sel && sel[param]) || {};
  const next = {};
  Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
  if (next[ch]) delete next[ch];
  else next[ch] = true;
  const out = {};
  const base = sel || emptyFilter();
  /* ⚠ 逐类别浅拷贝：只换掉被动的那一类，其余保持同一个引用
     （省得每次点击都把八个类别全新建一遍） */
  Object.keys(base).forEach(function (k) { out[k] = k === param ? next : base[k]; });
  if (!Object.prototype.hasOwnProperty.call(out, param)) out[param] = next;
  return out;
}

/**
 * 「全部」——清空该类别的所有选中（点一下回到不过滤）。
 */
function clearCat(sel, param) {
  const out = {};
  const base = sel || emptyFilter();
  Object.keys(base).forEach(function (k) { out[k] = k === param ? {} : base[k]; });
  if (!Object.prototype.hasOwnProperty.call(out, param)) out[param] = {};
  return out;
}

/** 某个类别是不是「全部」（一个都没选） */
function isAll(sel, param) {
  const cur = (sel && sel[param]) || {};
  return Object.keys(cur).length === 0;
}

/** 某个类别选了几个字 */
function countOf(sel, param) {
  return Object.keys((sel && sel[param]) || {}).length;
}

/** 整个筛选选中了多少个字（用于「筛选 (N)」那个角标） */
function totalPicked(sel) {
  if (!sel) return 0;
  return Object.keys(sel).reduce(function (n, k) { return n + Object.keys(sel[k] || {}).length; }, 0);
}

/**
 * 筛选状态 → 发给服务端的查询参数。
 *
 * ⚠ 只为**有选中的类别**产出键：
 *   · 空集合 ⇒ **这个键根本不出现**（= 服务端的「不传 = 不过滤」）
 *   · 有选中 ⇒ `'甲,乙'` 这种逗号串（与服务端 recordFilter.ts 的解析一致）
 * ⚠ 不做「空集合发空串」这种事：服务端虽然也能把空串当不过滤处理，
 *   但那意味着 app 在说「我要筛空」，语义上是错的 —— 别依赖对方的兜底。
 *
 * ⚠⚠ 姓名（`name`）是**另一类**条件，刻意不放进 FILTER_CATS：
 *   · 它不是枚举（没有「全部」、没有字符集），是一段自由文本；
 *   · 语义是**包含**匹配而不是精确匹配；
 *   · 它住在弹窗**外面**（入口下方那个输入框），所以是独立的一个入参。
 *   但它照样进 query —— 筛选始终是**服务端**做的那一件事。
 *
 * ⚠ 学堂页（书签列表）**不用** name 这个参数：书签没有姓名，
 *   调用时第二参不传即可（服务端也会忽略它）。两页共用这一份拼参逻辑。
 *
 * @param {Object} sel 八个类别的选中状态
 * @param {string} [name] 姓名关键词（已 trim 过的；空串 = 不按姓名筛）
 * @returns {Object} 如 { name:'张', dayGan:'甲,乙' }；全空时返回 {}
 */
function toQuery(sel, name) {
  const out = {};
  const kw = normalizeName(name);
  if (kw) out.name = kw;
  if (!sel) return out;
  FILTER_CATS.forEach(function (c) {
    const picked = Object.keys(sel[c.param] || {});
    if (picked.length) out[c.param] = picked.join(',');
  });
  return out;
}

/**
 * 姓名关键词的**归一化**（唯一一份口径，视图别自己写）。
 *
 * ⚠ 只做两件事：去首尾空白、限长。**绝不**做这些：
 *   · 不改大小写（中文姓名没有大小写；英文名用户自己会打对）
 *   · 不删中间的空格 / 标点（「张 三」和「张三」是两个不同的搜索词）
 *   · 不 split 逗号（姓名不是一个「字的集合」）
 * 这些字段会原样送到服务端的 `instr(name, ?)` 里 —— 改一个字符就是另一个查询。
 *
 * ⚠ 限长 60 与服务端 `NAME_MAX` 对齐：服务端超长会**忽略**（不截断），
 *   前端也**不截断**，只把它当成空（等于没填这个人名）。
 *   截断会让用户以为自己搜的是完整名字（见 recordFilter.ts 的 NAME_MAX 注释）。
 */
const NAME_MAX = 60;

function normalizeName(raw) {
  if (raw === undefined || raw === null) return '';
  const t = String(raw).trim();
  if (!t) return '';
  if (t.length > NAME_MAX) return '';
  return t;
}

/**
 * 有没有生效中的筛选（决定要不要提示用户、要不要走带参请求）。
 *
 * ⚠⚠ 姓名**也算**筛选：用户打了「张」却看到「共 30 例」、
 *   或者点「清除筛选」清不掉那个名字，都是明显的谎。
 *   所以判据是「query 里有没有键」，而不是「八个类别里选没选」。
 */
function hasFilter(sel, name) {
  return Object.keys(toQuery(sel, name)).length > 0;
}

/**
 * 面板顶部那行「共 N / M 例」。
 *
 * ⚠ 分母 M（总条数）**不能**用「当前列表长度」—— 列表已经是筛过的了。
 *   所以在有筛选时，M 要么是「上次不带筛选时的条数」，要么干脆不显示。
 *   这里采取后者：**只有不带筛选时**才显示「共 N 例」，
 *   带筛选时显示「筛出 N 例」—— 它**不会撒谎**。
 *
 * ⚠ 这是**记录页**的计数口径（「例」）。学堂页的计数是「共 N 个 · 已加载 N 个」
 *   （见 screens/study/model.js 的 countText），刻意不共用 —— 一个说的是
 *   「这一批有多少条」，一个说的是「这个列表加载到哪了」。
 *
 * @param {number} shown 当前列表条数（筛过之后）
 * @param {number|undefined} total 总条数（仅在无筛选时有意义）
 * @param {boolean} filtered 当前有没有生效的筛选
 */
function countText(shown, total, filtered) {
  if (filtered) return '筛出 ' + shown + ' 例';
  const t = typeof total === 'number' ? total : shown;
  return '共 ' + t + ' 例';
}

/**
 * 「这个后端支不支持筛选」→ 给用户的一句话。
 * 不支持时**必须说**：给一个点了没反应的按钮，比不给按钮更糟
 * （用户会以为自己筛对了，只是恰好都符合）。
 *
 * @param {boolean} supported 后端支持吗（store.supportsFilter()）
 * @returns {string} 空串 = 支持，不用提示
 */
function filterUnsupportedTip(supported) {
  return supported ? '' : '当前后端不支持筛选（筛选由服务端提供，切到本地后端即可用）';
}

/* ================================================================
 * 筛选弹窗（★ 用户要求：「点击确定才筛选」）
 * ================================================================
 * 面板从「就地展开、一勾就发请求」改成**弹窗 + 草稿态**。三个概念要分清：
 *   · **生效中的筛选**（applied）—— 界面与请求都以它为准（角标、空态、查询参数）
 *   · **草稿**（draft）—— 弹窗里正在勾的那份，**只活在弹窗里**
 *   · **提交**（apply）—— 点「确定」的那一刻，草稿 → 生效
 *
 * ⚠⚠ 为什么一定要分「草稿」和「生效」两份，而不是共用一份：
 *   共用的话，用户在弹窗里勾到一半就已经改了查询参数 ——
 *   点「取消」根本回不去（那份状态已经脏了）。分两份之后
 *   「取消 = 丢弃草稿」才是真的什么都没发生。
 *   这也是「点了确定才筛选」这句话的字面实现。
 *
 * ⚠ 弹窗打开时必须把 applied **深拷一份**给 draft（见 cloneFilter），
 *   不能把同一个对象引用交过去，否则弹窗里一勾，applied 就跟着变了。
 *   （这一步现在由 components/FilterModal.tsx 在 `visible` 翻真时做。）
 */

/** 深拷一份筛选状态（两层：类别 → 字）。⚠ 必须真拷到第二层，浅拷会共享内层对象 */
function cloneFilter(sel) {
  const out = {};
  const src = sel || {};
  Object.keys(src).forEach(function (k) {
    const inner = src[k] || {};
    const copy = {};
    Object.keys(inner).forEach(function (ch) { copy[ch] = inner[ch]; });
    out[k] = copy;
  });
  return out;
}

/** 两份筛选状态是不是「选中了同一批字」（按类别的键集合 + 每类内的字集合比） */
function sameFilter(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  /* ⚠ 只比「有选中的类别」：一份显式带 8 个空键、另一份不带，
     语义上都是「全部」⇒ 必须判等，否则点确定会被当成「变了」而白发一次请求。 */
  const ca = ka.filter(function (k) { return Object.keys((a || {})[k] || {}).length > 0; }).sort();
  const cb = kb.filter(function (k) { return Object.keys((b || {})[k] || {}).length > 0; }).sort();
  if (ca.join(',') !== cb.join(',')) return false;
  for (let i = 0; i < ca.length; i += 1) {
    const pa = Object.keys((a || {})[ca[i]] || {}).sort().join(',');
    const pb = Object.keys((b || {})[ca[i]] || {}).sort().join(',');
    if (pa !== pb) return false;
  }
  return true;
}

/**
 * 点「确定」之后该怎么办 —— 这是本弹窗**唯一的决策点**，
 * 抽成纯函数是为了能断言（视图里只剩「照它执行」）。
 *
 * 三种结果：
 *   · `'close'` —— 草稿与生效一致 ⇒ 白点了一次，**不发请求**（省一次往返）
 *   · `'reload'` —— 草稿为空（等于「全部」）⇒ 关窗并**拉全量**（不带筛选参数）
 *   · `'reload'` 同样适用于「草稿非空且变了」⇒ 关窗并**带筛选拉**
 *
 * ⚠⚠ 两个必须发请求的情形**不能合成一句「变了才发」**：
 *   「从有筛选改回全部」也是变了，且必须真发一次**不带参数的**请求，
 *   否则界面会停在上一批筛出来的结果上（用户以为「清除筛选没生效」）。
 *
 * ⚠⚠⚠ **弹窗不碰姓名**：姓名是弹窗外面那个输入框管的东西（用户要求
 *   「输入名字查询不放在弹窗里面」），它**已经生效**了 —— 弹窗里点确定
 *   只可能改八个干支类别。所以这里比的是「干支草稿 vs 干支生效」，
 *   姓名原样跟着走（`filter` 只是那八个类别，姓名由调用方另外带上）。
 *   ⚠ 千万别把姓名塞进这个比较里：那样「只改了名字、干支没动」会被判成
 *     「没变 ⇒ 不发请求」，名字就白打了。
 *
 * ⚠ 学堂页没有姓名这回事，所以那里的调用方只用 `plan.filter`
 *   （`sendsQuery` 也只是「干支选没选」）。
 *
 * @param {Object} draft   弹窗里的草稿（八个干支类别）
 * @param {Object} applied 当前生效中的干支筛选
 * @returns {{action:'close'|'reload', filter:Object, sendsQuery:boolean}}
 */
function applyPlan(draft, applied) {
  const next = cloneFilter(draft);
  if (sameFilter(next, applied)) {
    return { action: 'close', filter: next, sendsQuery: false };
  }
  return { action: 'reload', filter: next, sendsQuery: totalPicked(next) > 0 };
}

/**
 * 「确定」按钮上那句数量提示（照 mingliWEB：让用户在点之前就知道自己选了几个）。
 * ⚠ 用**草稿**算，不是生效中的那份。
 */
function confirmText(draft) {
  const n = totalPicked(draft);
  return n > 0 ? '确定（' + n + '）' : '确定';
}

module.exports = {
  /* 筛选（★ 只维护状态与拼参数；过滤本身在服务端做） */
  FILTER_CATS: FILTER_CATS,
  STEMS: STEMS,
  BRANCHES: BRANCHES,
  emptyFilter: emptyFilter,
  toggleChar: toggleChar,
  clearCat: clearCat,
  isAll: isAll,
  countOf: countOf,
  totalPicked: totalPicked,
  toQuery: toQuery,
  /* 姓名查询（★ 独立于弹窗：住在入口下方那个输入框里；学堂页不用它） */
  NAME_MAX: NAME_MAX,
  normalizeName: normalizeName,
  hasFilter: hasFilter,
  countText: countText,
  filterUnsupportedTip: filterUnsupportedTip,
  /* 筛选弹窗（草稿态 + 点确定才提交） */
  cloneFilter: cloneFilter,
  sameFilter: sameFilter,
  applyPlan: applyPlan,
  confirmText: confirmText
};
