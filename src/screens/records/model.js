/**
 * 记录页的**纯计算层** —— 不 import 任何 React / RN 东西，可以在纯 Node 里断言。
 *
 * ⚠ 为什么要拆出来：这一页最容易错的不是画得对不对，而是三件事：
 *   ① 「列表项里的可选字段（notes）有没有被筛掉」—— 筛掉就成了用户报的
 *      「记了事件、退出重进就没了」；
 *   ② 「拉取态 / 启动态怎么映射成界面」—— 三态（等 / 就绪 / 失败）各有分支；
 *   ③ 「onShow 要不要重新拉」的版本号闸门 —— 通知栏下拉不该触发全量重拉。
 *   这三件事全都可以纯函数断言，不需要模拟器。所以模型在这里，渲染在 Records.tsx。
 *
 * ⚠ 视图里**不要**依赖 fourChars / lunarText 做「盘」的事：它们只是列表展示用的
 *   四字摘要 + 农历文本。真正的盘由结果页用 record.hydrate() 现场重排。
 */
const chartLib = require('../../core/chart.js');
const lunar = require('../../core/lunar.js');
const timeUtil = require('../../core/time.js');
const record = require('../../core/record.js');

/** 就绪态在界面上停留多久后自动收起（毫秒）—— 成功不该占着用户的地方 */
const HIDE_DELAY = 1400;

/* ================================================================
 * 筛选 —— ★ 逻辑已搬到 core/pillarFilter.js（2026-10-04，用户要求封装复用）
 * ================================================================
 * 记录页与学堂页共用同一份「八个类别 + 草稿态 + 拼 query + 点确定才生效」的逻辑；
 * 本文件只**转发**它的导出（见文件末尾 module.exports 的 ...pillarFilter），
 * 所以这一页的调用点（`model.FILTER_CATS` / `model.applyPlan` …）
 * 与既有断言**一个字都不用改**。
 * ⚠ 要改筛选行为，去 core/pillarFilter.js 改 —— 本文件里已经没有定义，
 *   在这里找不到函数体是**正常**的（别以为是搬漏了又抄一份回来）。
 */
const pillarFilter = require('../../core/pillarFilter.js');
/* ⚠ 单独取出来：下面 `toQuery` 是「干支 + 姓名 **+ 标签**」那一版，
   它内部要调 pillarFilter 那版（只认前两维），所以**必须先把它改名收好** ——
   直接叫 toQuery 的话下面的同名函数会把它盖掉，然后自己无限递归。 */
const pToQuery = pillarFilter.toQuery;

/**
 * 自定义标签的**数据层**（core/tags.js）。
 * ⚠ 本文件只用它的**纯小工具**（pickName / nameOf / totalOf / TAG_NONE），
 *   网络那半截由 Records.tsx 直接调 core/tags.js —— 与「筛选请求在视图里发」同一分工：
 *   模型只管「算」，不管「发」。
 */
const tagsLib = require('../../core/tags.js');

/**
 * 给一条轻记录补上「列表要显示的那点派生信息」：四柱四字 + 农历文本。
 *
 * 列表里显示四柱是值得的（一眼能认出是哪条），但**不能**为此排整份盘 ——
 * 大运 + 70 年逐年小运才是耗时的那部分，列表要 50 条，
 * 每条都真排一遍会让首屏明显卡顿。
 * 所以这里只调 chart.paipan()（纯四柱，很快）+ 农历换算。
 *
 * ⚠⚠ 可选字段（目前是「事件记录」notes）必须原样跟着列表项一起走。
 *   点开一条记录时，结果页能拿到的**唯一**数据就是 record.toStorage(这个对象)
 *   （传盘走内存总线，本地一个字节都不留）—— 在这里筛掉它，
 *   就成了「云端 json 里明明有事件、点开却是空的」。
 *   借 record.toStorage 再过一遍白名单，免得可选字段表在代码里存在两份。
 */
function withSummary(rec) {
  const out = {
    id: rec.id,
    name: rec.name,
    gender: rec.gender,
    date: rec.date,
    time: rec.time,
    createdAt: rec.createdAt,
    fourChars: ['—', '—', '—', '—'],
    lunarText: '—'
  };
  const opt = record.toStorage(rec) || {};
  record.OPTIONAL_FIELDS.forEach(function (k) {
    if (opt[k]) out[k] = opt[k];
  });
  /* ⚠⚠⚠ 标签必须在这里**显式**带上，不能指望上面那个 toStorage：
     `toStorage` 只放行 LIGHT_FIELDS + OPTIONAL_FIELDS（写入契约），
     而 tagId 是**只读派生字段**（服务端 GET /records 才给，见 routes/records.ts
     的 RecordOut）—— 它**故意不在**那两份白名单里（否则整行 PUT 就得带上它，
     漏一处就静默抹掉标签）。
     ⇒ 在列表这一层单独接一下：丢掉它，卡片上那枚标签就永远画不出来。
     ⚠ 形状照抄服务端：**没有标签时连键都不给**（不是 tagId:null）——
       视图那边据此画不画 chip，两个「空」在界面上长得一样但语义不同（见 tagNameOf）。 */
  if (rec.tagId) out.tagId = rec.tagId;
  try {
    const pd = timeUtil.parseDate(rec.date);
    const pt = timeUtil.parseTime(rec.time);
    const chart = chartLib.paipan(pd.y, pd.m, pd.d, pt.h, pt.mi);
    if (chart && chart.fourChars) out.fourChars = chart.fourChars;
    const l = lunar.solarToLunar(pd.y, pd.m, pd.d);
    if (l && l.text) out.lunarText = l.text;
  } catch (err) {
    console.warn('[paipan] 记录摘要计算失败', err);
  }
  return out;
}

/** 一批记录 → 列表展示项 */
function withSummaries(records) {
  return (Array.isArray(records) ? records : []).map(withSummary);
}

/**
 * 列表右侧的四柱**两行**（用户 2026-10-03 定稿）：
 *   第一行 = 年、月、日、时四个**天干**；第二行 = 四个**地支**。
 * 上一版显示的是「年月柱 / 日时柱」两对干支 —— 用户报「排列不对」。
 * fourChars 里可能是 '—' 占位（算不出盘的兜底值），单字符没有地支，照原样放 '—'。
 */
function pillarRows(fourChars) {
  const arr = (Array.isArray(fourChars) && fourChars.length === 4)
    ? fourChars
    : ['—', '—', '—', '—'];
  const at = function (p, i) {
    return (p && p.length >= 2) ? p.charAt(i) : '—';
  };
  return {
    stems: arr.map(function (p) { return at(p, 0); }).join(' '),
    branches: arr.map(function (p) { return at(p, 1); }).join(' ')
  };
}

/** 列表项 → 交给结果页的轻记录（⚠ 必须剥掉 fourChars / lunarText） */
function toHandoff(item) {
  const out = record.toStorage(item);
  if (!out) return null;
  /* ⚠★ 标签 id **单独贴上**（`toStorage` 是「能上云的轻字段」白名单，不含它）：
     结果页的「详细信息 → 标签」要拿它显示 / 更换。
     ⚠ 它只走这条**内存总线**（chartBus.put → 结果页 chartBus.take）——
       保存路径（history.push → PUT /records/:id）**不经过 toHandoff**，
       所以这个字段永远不会被写进记录行（服务端也不接受它，见 routes/records.ts
       的 LIGHT_FIELDS 与「归类为什么不并进整行 PUT」那段）。
     ⚠ 没归类时**连键都不给**（不是给 null）：结果页那边统一按「取不到 → 未分类」处理。 */
  if (item && item.tagId) out.tagId = item.tagId;
  return out;
}

/**
 * pull 的结果 → 界面要显示的拉取态。
 * @returns {{state:'ok'|'fail'|'skip'|'loading', text:string}}
 */
function pullStateOf(res) {
  if (!res) return { state: 'fail', text: '云端记录同步失败 · 重试' };
  if (res.ok) return { state: 'ok', text: '' };
  if (res.reason === 'no-login') {
    // 登录态里没有可用标识 → 明确说，别显示成「没有记录」
    return { state: 'skip', text: '未登录，记录存在云端，登录后可见' };
  }
  return { state: 'fail', text: '云端记录同步失败 · 重试' };
}

/**
 * 拉取态那一行**要不要显示、点了做什么**。
 *
 * ⚠ 之前只渲染 fail（红色可点重试），skip 态是**静默**的 —— 于是没登录的人
 *   看到的是一个空列表 + 一句「排盘后在结果页点保存」，完全不知道该怎么办。
 *   「未登录」是个**可行动**的状态（去登录就好），必须给出口。
 *
 * @param {{state:string}} pull
 * @returns {'none'|'retry'|'login'}
 */
function pullActionOf(pull) {
  const st = (pull && pull.state) || '';
  if (st === 'fail') return 'retry';
  if (st === 'skip') return 'login';
  return 'none';
}

/** 空态下面那行提示：正在同步时说要等，未登录时说去登录，否则说怎么才能有记录 */
function emptyTipOf(pull) {
  const st = (pull && pull.state) || '';
  if (st === 'loading') return '正在从云端同步…';
  if (st === 'skip') return '登录后即可看到云端记录';
  return '排盘后在结果页点「保存到记录」';
}

/**
 * 「这次 onShow 该不该重新拉云端」。
 *
 * 手机上拉一下系统通知栏也会触发一次「后台 → 前台」的 onShow，
 * 原来无条件全量重拉 —— 通知栏就成了最贵的手势。
 * 契约：只有「数据版本号变了」（结果页保存过 / 删除 / 清空）或从没拉过才重拉。
 *
 * @param {number|undefined} syncedRev 上次成功拉取时记下的版本号
 * @param {number} curRev 当前版本号（history.rev()）
 */
function shouldReload(syncedRev, curRev) {
  return syncedRev === undefined || syncedRev !== curRev;
}

/**
 * 下拉刷新时该带哪些参数 —— 与 `loadCloud` 平时用的**完全同一份**
 * （干支 + 姓名 + **标签**，见下面那个三参 toQuery）。
 *
 * ⚠⚠ 为什么要有这个函数而不是「下拉就直接拉全量」：
 *   下拉是「**刷新我刚看到的这张列表**」，不是「把筛选清掉」。
 *   用户筛着「日干=甲」（或「标签=客户」）的时候下拉，期望是「重新按这个条件查一遍」，
 *   而不是刷完发现自己勾的筛选没了、列表变回 30 条 —— 那是**改变了他看的东西**。
 *   ⚠ 所以下拉**绝不动** filterRef / nameRef / tagSelRef，只重新发一次同样的请求。
 *
 * ⚠ 但它与平时那条路有个**关键区别**：要带上 `keepTotal: false`（见 refreshOpts）。
 *
 * @returns {{query:Object, filtered:boolean}} query 为空对象 = 不带筛选（拉全量）
 */
function refreshQuery(sel, name, tagSel) {
  const query = toQuery(sel, name, tagSel);
  return { query: query, filtered: Object.keys(query).length > 0 };
}

/* ================================================================
 * 自定义标签（★ 记录页）
 * ================================================================ */

/**
 * 标签筛选那一维 → 查询参数。
 *
 *   `''`（空串）或 undefined  → `{}`　　　　　＝**不过滤**（「全部」那一格）
 *   `'none'`（TAG_NONE）     → `{ tagId: 'none' }` ＝只看**未分类**的
 *   `'g1abc…'`（标签 id）    → `{ tagId: 'g1abc…' }`
 *
 * ⚠⚠ 「全部」与「未分类」的区别**全在这一步**：前者返回空对象（＝一个参数都不发），
 *   后者发一个 `tagId=none`。要是把 `''` 也发成 `tagId=`，
 *   服务端那边是「空串 = 不过滤」，行为凑巧一样 —— 但那就成了「靠对方的兜底」，
 *   而且一旦服务端的空串口径改了，这边会**静默**变成不过滤。别依赖它。
 */
function tagQuery(tagSel) {
  const v = tagSel === undefined || tagSel === null ? '' : String(tagSel);
  if (!v) return {};
  return { tagId: v };
}

/**
 * 筛选状态 → 查询参数（**三个维度**：八干支 + 姓名 + 标签）。
 *
 * ⚠⚠ 第三参 `tagSel` **可选**：不传 = 不过滤 ⇒ 所有老调用点（两参）行为一个字都不变。
 *   这是刻意的向后兼容 —— 断言与其它调用点不必跟着改一遍（少改一处就少一个坑）。
 *
 * ⚠⚠⚠ 这几个函数（toQuery / hasFilter / refreshQuery）的名字与 pillarFilter 里的
 *   **重名**，所以 module.exports 里必须写在 `...pillarFilter` **之后**
 *   （写在前面会被 spread 悄悄盖回「只认两维」的旧版 —— 而旧版看着也能跑，
 *    只是标签这一维永远不生效，最难发现）。
 */
function toQuery(sel, name, tagSel) {
  const out = pToQuery(sel, name);
  const t = tagQuery(tagSel);
  for (const k in t) {
    if (Object.prototype.hasOwnProperty.call(t, k)) out[k] = t[k];
  }
  return out;
}

/** 有没有生效中的筛选（**含标签这一维**）—— 决定要不要提示用户、要不要走带参请求 */
function hasFilter(sel, name, tagSel) {
  return Object.keys(toQuery(sel, name, tagSel)).length > 0;
}

/**
 * 标签栏的条目：`[全部, 未分类, …各标签]`，每条带 `on`（是不是当前选中的那格）。
 *
 * ⚠⚠ 计数**只由一次 `/tags` 的结果算**（未分类 + 各标签的 count），
 *   **不拿 `list.length` 当分母** —— 列表此刻已经是筛过的了
 *   （这正是 pillarFilter.countText 里「带筛选时不能说『共 N 例』」的同一条纪律）。
 *
 * ⚠ 「未分类」**钉在第二个位置**（不是排在末尾）：它是一个固定的出口，
 *   位置飘来飘去会让人每次重新找。剩下的按服务端给的顺序（＝创建顺序）。
 *
 * @param {Array} tags     `/tags` 回来的标签（带 count）
 * @param {number} untagged 未分类条数
 * @param {string} sel     当前选中的 key（'' = 全部 / 'none' / 标签 id）
 */
function tagBar(tags, untagged, sel) {
  const cur = sel === undefined || sel === null ? '' : String(sel);
  const items = [
    { key: '', label: '全部', count: tagsLib.totalOf(tags, untagged) },
    { key: tagsLib.TAG_NONE, label: '未分类', count: typeof untagged === 'number' ? untagged : 0 }
  ];
  for (const t of (Array.isArray(tags) ? tags : [])) {
    if (!t || !t.id) continue;
    items.push({ key: t.id, label: t.name, count: typeof t.count === 'number' ? t.count : 0 });
  }
  return items.map(function (it) {
    return { key: it.key, label: it.label, count: it.count, on: it.key === cur };
  });
}

/**
 * 卡片上那枚标签的文字；没有标签（或标签已经不在列表里）→ **空串**。
 * ⚠ 空串 = **不画那枚 chip**（见 core/tags.js nameOf 的三条理由：
 *   不能回落到 id 本身、也不能编一个「未知标签」）。
 */
function tagNameOf(tags, id) {
  return tagsLib.nameOf(tags, id);
}

/**
 * ★ 点「新建」那一刻该怎么办 —— 这一处是标签面板**唯一的决策点**，
 *   抽成纯函数是为了能直接断言（视图里只剩「照它执行」）。
 *
 * ⚠⚠ 为什么要在**本地**先查一遍重名：服务端对重名回 **409**，
 *   而「已经有一个叫这个的标签」是客户端**此刻就知道**的事（列表就在手上）——
 *   白白多一次往返、还多弹一句错误提示。
 *   ⇒ 本地命中就直接**选中它**：用户的意图是「把这条八字归到『客户』下」，
 *     不是「我要见证一次 insert」。
 *   ⚠ 服务端的 409 **仍然保留** —— 它是防并发的**结构保证**（UNIQUE(user_id,name)），
 *     不是这里的替代品。
 *
 * @returns {{action:'none'|'create'|'select', id?:string, name?:string, error?:string}}
 *   · `'none'`   —— 名字不合法（`error` 是给用户看的那句话），**什么都不做**
 *   · `'select'` —— 已经有一个同名标签 ⇒ 直接选它（`id`）
 *   · `'create'` —— 真去建（`name` 是收拾过的名字）
 */
function planNewTag(tags, raw) {
  const nm = tagsLib.pickName(raw);
  if ('err' in nm) return { action: 'none', error: nm.err };
  for (const t of (Array.isArray(tags) ? tags : [])) {
    if (t && t.name === nm.name) return { action: 'select', id: t.id };
  }
  return { action: 'create', name: nm.name };
}

/**
 * 下拉刷新要传给 `loadCloud` 的选项。
 *
 * ⚠⚠ 与「带筛选重拉」的 `keepTotal: true` **相反**：下拉是用户主动要求
 *   「什么都给我最新的」，所以**没有筛选时要把总条数也一起刷新**
 *   （`keepTotal:true` 会把「共 N 例」永远钉在上一次的数字上 ——
 *    在另一台设备删了记录、下拉一下，列表变了但计数没变，那就是个假数字）。
 * ⚠ 有筛选时 `loadCloud` 本来就不会动 totalAll（分母要靠不带筛选的拉取得来），
 *   所以这里给 `keepTotal:false` 也不会把分母搞错 —— 两者不冲突。
 */
function refreshOpts() {
  return { keepTotal: false };
}

/* ================================================================
 * 分页（★ 懒加载 · 2026-10-11 用户要求：「现在54条，可是后面就会变多」）
 * ================================================================
 * 三条边界必须分清（错一条就是「列表少了一截」或者「永远在拉同一页」）：
 *   ① **不传 limit = 全量**（服务端口径，见 store/localdb.js 文件头那三段 ⚠）。
 *      本页从此走分页 ⇒ **每一次**都要显式给 limit；漏给一次就是一次全量。
 *   ② 「还有没有下一页」**只能**用服务端给的 `paged` + `total`（筛后总条数）算，
 *      **不许**用「这次返回了满一页」—— 最后一页正好装满时会永远多拉一次空页。
 *   ③ 位次（offset）按**服务端返回的条数**推进，**不是**按 `list.length`：
 *      界面那份列表按 id 去过重，两者会不等 ——
 *      一旦去重后再回退 offset，就会反复拉同一条 ⇒ 原地死循环。
 */

/** 一页多少条。⚠ 服务端「不传 limit」是**全量**，别把两者混为一谈 */
const PAGE_SIZE = 50;

/**
 * 第 `offset` 条开始的那一页的参数。
 *
 * ⚠ offset 是**位次**（从 0 数），不是页码。非法值一律当 0（第一页）——
 *   宁可多显示一页，也不要发出个 `?offset=NaN` 让服务端按 0 去猜。
 */
function pageOpt(offset) {
  const o = (typeof offset === 'number' && isFinite(offset) && offset > 0) ? Math.floor(offset) : 0;
  return { limit: PAGE_SIZE, offset: o };
}

/**
 * 还有没有下一页。
 *
 * ⚠⚠ 两个前置条件缺一不可：
 *   · `paged === true` —— 服务端**这次真的做了切片**。非分页驱动（cloudbase / cloud /
 *     gitee）压根不认 limit/offset，一次就把全部给回来了；这里若判「有下一页」，
 *     上层会拿着同一个 offset 一直要、拿回同一份数据 ⇒ **无限拉同一页**。
 *   · `total` 是数字 —— 没有它就没有「总共多少」这个基准，只能保守判「没有」。
 *
 * @param {number} offset 已经请求到的位次（= 历次返回条数之和）
 * @param {number|undefined} total 服务端给的（筛后）总条数
 * @param {boolean|undefined} paged 服务端这次是不是切片返回
 */
function hasMore(offset, total, paged) {
  if (paged !== true) return false;
  if (typeof total !== 'number' || !isFinite(total)) return false;
  const at = (typeof offset === 'number' && isFinite(offset)) ? offset : 0;
  return at < total;
}

/**
 * 「共 N 例 / 筛出 N 例」里那个 N 该取哪个数。
 *
 * ⚠⚠⚠ 分页之后**绝不能再拿 `list.length`**：首屏只拉了 50 条，而实际总共/筛出来是 200 条
 *   ⇒「共 50 例」是个假数字（用户会以为记录丢了）。
 *   服务端给了 total 就用它（那是筛后的权威值），没给才退回列表长度 ——
 *   退回也**不是**凑数：非分页驱动本来就是一次给全量，那时两者本来就相等。
 */
function countShown(loaded, total) {
  if (typeof total === 'number' && isFinite(total) && total >= 0) return total;
  return (typeof loaded === 'number' && isFinite(loaded) && loaded > 0) ? loaded : 0;
}

/**
 * 列表底部那一行（懒加载的状态条）。
 *
 * 四个状态互斥，顺序就是优先级：
 *   失败（可点重试） > 正在续拉 > 还有下一页（**不显示文字**，滚到底自动拉）> 到底了
 * ⚠ 「没有更多了」**只在真的分过页时才说**（total 超过一页）——
 *   一共 3 条记录也在末尾写一句「没有更多了」，纯属噪音。
 *
 * @param {{loading?:boolean, hasMore?:boolean, total?:number, err?:boolean}} o
 * @returns {string} 空串 = 这一行不渲染
 */
function footText(o) {
  const x = o || {};
  if (x.err) return '加载失败 · 点此重试';
  if (x.loading) return '正在加载…';
  if (x.hasMore) return '';
  if (typeof x.total === 'number' && x.total > PAGE_SIZE) return '没有更多了';
  return '';
}

/**
 * 列表滚到「离底部还有 gap 以内」了吗 —— 到了就该续拉下一页。
 *
 * ⚠ 三个入参全部来自 onScroll 的 nativeEvent（`contentOffset.y` /
 *   `layoutMeasurement.height` / `contentSize.height`），任一不是数字就判「没到」——
 *   判错成「到了」会在列表还没铺开时抢跑，一下把后面几页全拉下来（懒加载白做）。
 *
 * ⚠⚠ 提前量（gap）**不能省**：要求「真滚到最后一条」才拉的话，
 *   用户会看见列表**停下来等**（手指还在滑，圈还没转）。留一屏多一点的提前量，
 *   下一页通常在用户滑到底之前就已经到了。
 *
 * @param {number} y 已滚过的距离
 * @param {number} viewH 可视区高度
 * @param {number} contentH 内容总高度
 * @param {number} [gap] 提前量（dp）；不传按 0（= 必须真到底）
 */
function nearBottom(y, viewH, contentH, gap) {
  if (typeof y !== 'number' || typeof viewH !== 'number' || typeof contentH !== 'number') return false;
  if (!isFinite(y) || !isFinite(viewH) || !isFinite(contentH)) return false;
  const g = (typeof gap === 'number' && isFinite(gap) && gap > 0) ? gap : 0;
  return contentH - (y + viewH) <= g;
}

/**
 * 把新一页拼到已有列表**后面**（顺带按 id 去重）。
 *
 * ⚠⚠ 为什么要去重：offset 分页在「另一台设备刚插了一条」这种情况下，
 *   第二页会把第一页末尾那条再带回来一次 —— 不去重就是重复 id
 *   （React 的 key 告警 + 列表里莫名多出一条）。
 *
 * ⚠⚠⚠ 为什么这件事必须写在模型里，而不是视图里就地写个 `.filter(...)`：
 *   记录页有一条**红线断言**——「视图里不许出现 `.filter(`」，它守的是
 *   「过滤必须在服务端」（用户的明确要求）。在视图里就地 filter 会让那条断言红，
 *   而且日后没人分得清「这个 filter 是在去重还是在偷偷本地筛」。
 *   ⇒ 挪到这里，语义自带名字（appendUnique），视图里只剩「照它拼」。
 *
 * ⚠ 去重**只影响界面那份列表**，**不影响 offset 的推进** ——
 *   位次按服务端返回的条数走（见 pageOpt / Records.tsx 的 offsetRef），
 *   拿去重后的长度当位次会退回去重拉同一条（原地死循环）。
 *
 * @param {Array} prev 已经在屏幕上的那些
 * @param {Array} next 服务端刚回来的这一页
 */
function appendUnique(prev, next) {
  const out = Array.isArray(prev) ? prev.slice() : [];
  const seen = {};
  out.forEach(function (it) { if (it && it.id != null) seen[String(it.id)] = true; });
  (Array.isArray(next) ? next : []).forEach(function (it) {
    if (!it) return;
    if (it.id != null) {
      const k = String(it.id);
      if (seen[k]) return;
      seen[k] = true;
    }
    out.push(it);
  });
  return out;
}

module.exports = {
  HIDE_DELAY: HIDE_DELAY,
  /* 筛选（★ 只维护状态与拼参数；过滤本身在服务端做）
     ⚠ 整组**转发** core/pillarFilter.js：FILTER_CATS / emptyFilter / toQuery /
       applyPlan / confirmText … 都在那边定义（记录页与学堂页共用一份）。
       本文件的调用点与断言照旧 —— 名字一样、行为一样。 */
  ...pillarFilter,
  /* ⚠⚠⚠ 下面这两个**必须在 spread 之后**：它们是「八干支 + 姓名 **+ 标签**」那一版的
     同名单函数，用来覆盖 pillarFilter 里只认前两维的实现。
     写在 spread 前面会被静默盖回旧版 —— 而旧版看着也能跑，只是标签这一维
     永远不生效（请求里少一个参数，服务端就返回全量），界面照样画得出来。 */
  toQuery: toQuery,
  hasFilter: hasFilter,
  /* ===== 自定义标签（★ 记录页）=====
     ⚠ 这里只导出**纯计算**（拼参数 / 算标签栏 / 那一处「新建还是选中」的决策）。
       真正发请求的那半截在 core/tags.js，由 Records.tsx 直接调 ——
       与「筛选请求在视图里发」同一分工：模型只管「算」，不管「发」。 */
  TAG_NAME_MAX: tagsLib.TAG_NAME_MAX,
  TAG_NONE: tagsLib.TAG_NONE,
  tagQuery: tagQuery,
  tagBar: tagBar,
  tagNameOf: tagNameOf,
  planNewTag: planNewTag,
  withSummary: withSummary,
  withSummaries: withSummaries,
  pillarRows: pillarRows,
  toHandoff: toHandoff,
  pullStateOf: pullStateOf,
  pullActionOf: pullActionOf,
  emptyTipOf: emptyTipOf,
  shouldReload: shouldReload,
  /* 下拉刷新 */
  refreshQuery: refreshQuery,
  refreshOpts: refreshOpts,
  /* ===== 分页（★ 懒加载）=====
     ⚠ 这几个都是**纯函数**，所以「还有没有下一页 / 该显示哪行字 / 滚到底了没」
       全都能在纯 Node 里断言 —— 视图里只剩「照它执行」。
     ⚠ 真正发请求的那半截在 core/history.js → store（透传 limit/offset），
       与「筛选请求在视图里发」同一分工：模型只管「算」。 */
  PAGE_SIZE: PAGE_SIZE,
  pageOpt: pageOpt,
  hasMore: hasMore,
  countShown: countShown,
  footText: footText,
  nearBottom: nearBottom,
  appendUnique: appendUnique
};
