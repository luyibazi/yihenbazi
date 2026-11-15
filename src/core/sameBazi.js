/**
 * 「同八字」检索 —— 拿**这一张盘**的四柱，去自己的**记录**和**学堂书签**里找同样的八字。
 *
 * ============ 一句话说清它是不是新接口 ============
 * **不是**。它就是把已有的四柱筛选拉两次：
 *   · 记录 —— `GET /records?yearGan=甲&…`（`core/history.js` 的 pull）
 *   · 书签 —— `GET /books/bookmarks?yearGan=甲&…`（`core/books.js` 的 fetchPage）
 * 两个接口本来就吃同一套八参数（服务端 `lib/recordFilter.ts` 解析，
 * 前端 `core/pillarFilter.js` 拼参）。所以这里**一个新接口都不加**，
 * 也不做任何本地过滤 —— 与 pillarFilter 开头那条纪律一致：
 * 筛选由服务端做，客户端只负责把条件翻译成 query。
 *
 * ============ ⚠⚠ 条件永远是「定气法」那一份 ============
 * 用户 2026-11-15 明确要求：「排盘结果页面的定气法的八字作为条件」。
 * 所以调用方必须传**定气法**的四柱（ChartView 的 `state.pillars`），
 * **不能**传 `pingState.pillars` —— 哪怕页面上正显示着平气法。
 * 原因很实在：记录和书签里存的是同一种口径的数据，拿平气法的四柱去比，
 * 立春前后／节气交界那些命例会漏掉一批（见 pingqi-bazi.js 的虚岁口径注释）。
 *
 * ============ 为什么单独一个文件而不是塞进 pillarFilter ============
 * pillarFilter 管的是「用户点了哪几个字」的**面板状态**（空集合 = 全部、
 * 草稿与生效两份、确定才提交…）。这里管的是「给定四柱、精确匹配一次」——
 * 没有草稿、没有部分选中、没有「确定」这一步。塞进去会让那个文件多出一整套
 * 与面板无关的概念，读的人分不清哪条规则属于哪一边。
 *
 * ⚠ 纯逻辑层：不 import React / RN，可在纯 Node 里断言。
 *   取数的两个来源**可注入**（`_setSources`），测试不必起服务。
 */
'use strict';

const pf = require('./pillarFilter.js');

/** 每组最多取多少条（两组的「总条数」仍以服务端 total 为准，不是这个数） */
const LIMIT = 50;

/** 四柱的顺序 —— 与 FILTER_CATS 的排列一一对应（年→月→日→时，每柱先干后支） */
const PILLARS = ['year', 'month', 'day', 'hour'];

/**
 * 八个筛选参数名。
 * ⚠⚠ **从 `pillarFilter.FILTER_CATS` 派生，不另抄一份** ——
 *   抄一份就会漂（漂了的表现是「发了参数、服务端不认识 ⇒ 静默不过滤」，
 *   界面上完全看不出来，这正是 pillarFilter 文件头第 13 行警告的那件事）。
 */
const PARAMS = PILLARS.map(function (_, i) {
  return [pf.FILTER_CATS[i * 2].param, pf.FILTER_CATS[i * 2 + 1].param];
});

/**
 * 四柱 → 四个「干支」（`['甲子','乙丑','丙寅','丁卯']`）。
 * 只用于**显示**（弹层标题下那串条件），不参与请求。
 *
 * @param {Array<{stem:string, branch:string}>} pillars ChartView 的 state.pillars
 */
function charsOf(pillars) {
  return (pillars || []).slice(0, 4).map(function (p) {
    return String((p && p.stem) || '') + String((p && p.branch) || '');
  });
}

/**
 * 四柱 → 精确筛选 query（`{ yearGan:'甲', yearZhi:'子', … }`）。
 *
 * ⚠⚠ 四柱必须**完整**，缺一柱就返回 null（调用方据此拒绝检索）。
 *   绝不能「有几柱发几柱」—— 少发一个参数在服务端等于「这一类不过滤」，
 *   结果会从「同八字」变成「年、月、日相同、时辰随便」，看起来查到了很多，
 *   其实一条都不是用户要的。这是**静默放宽**，比报错难查得多。
 *
 * @returns {Object|null}
 */
function queryOf(pillars) {
  const list = (pillars || []).slice(0, 4);
  if (list.length < 4) return null;
  const q = {};
  for (let i = 0; i < 4; i += 1) {
    const p = list[i] || {};
    const stem = String(p.stem || '');
    const branch = String(p.branch || '');
    if (!stem || !branch) return null;
    q[PARAMS[i][0]] = stem;
    q[PARAMS[i][1]] = branch;
  }
  return q;
}

/* ------------------------------------------------------------ 取数 */

/**
 * 两个数据来源。默认走真实接口，测试可用 `_setSources` 换掉。
 *
 * ⚠ 用**函数**而不是在文件顶部 require：`history.js` / `books.js` 会拉起
 *   boot / store / 平台层，纯 Node 断言里不需要这一串副作用（也起不来）。
 */
let injected = null;

function sources() {
  if (injected) return injected;
  return {
    records: function (query, limit) {
      return require('./history.js').pull(query, { limit: limit });
    },
    bookmarks: function (query, limit) {
      return require('./books.js').fetchPage(0, limit, query);
    }
  };
}

/** 测试注入（与 localsdk 的 `_setFetch` 同一套做法） */
function _setSources(src) {
  injected = src || null;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asNumber(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/** 失败原因翻成人话（`no-login` 是最常见的一种，必须说出来） */
function reasonText(r) {
  if (!r) return '没有返回';
  if (r.reason === 'no-login') return '未登录，看不到这一组';
  return String(r.error || '读取失败');
}

/**
 * 检索。
 *
 * @param {Array} pillars **定气法**的四柱（ChartView 的 state.pillars）
 * @param {Object} [opt] `{ limit }`
 * @returns {Promise<Object>} 永不 reject
 *   ```
 *   { ok:true, chars:['甲子',…], query:{…},
 *     records:{ ok, total, items, error },
 *     bookmarks:{ ok, total, items, error } }
 *   ```
 *   `ok:false` 只有一种情况：四柱不完整（`error` 说明原因）。
 *   两组**各有各的 ok**：一组失败不该把另一组的结果也吞掉。
 */
function find(pillars, opt) {
  const query = queryOf(pillars);
  const chars = charsOf(pillars);
  if (!query) {
    return Promise.resolve({
      ok: false,
      chars: chars,
      error: '这条盘的四柱不完整，没法按八字检索'
    });
  }
  const limit = (opt && opt.limit) || LIMIT;
  const src = sources();

  function step(fn) {
    return Promise.resolve()
      .then(function () { return fn(query, limit); })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  return Promise.all([step(src.records), step(src.bookmarks)]).then(function (both) {
    const rec = both[0] || {};
    const bk = both[1] || {};
    const recItems = asArray(rec.records);
    const bkItems = asArray(bk.items);
    return {
      ok: true,
      chars: chars,
      query: query,
      records: {
        ok: !!rec.ok,
        /* ⚠ total 缺省兜成「这次拿到几条」，**不是** 0 ——
           写 0 会让「筛出 0 条」和「不知道多少条」看起来一样。 */
        total: asNumber(rec.total, recItems.length),
        items: recItems,
        error: rec.ok ? '' : reasonText(rec)
      },
      bookmarks: {
        ok: !!bk.ok,
        total: asNumber(bk.total, bkItems.length),
        items: bkItems,
        error: bk.ok ? '' : reasonText(bk)
      }
    };
  });
}

/**
 * 整屏没有一条时的文案。
 *
 * ⚠⚠ 只有在**两组都成功且都是 0** 时才说「没有」。任何一组读失败都返回空串 ——
 *   「读失败」说成「没有相同的八字」是在撒谎，而且用户会以为数据丢了
 *   （与 history.js「读失败绝不降级成空列表」同一条铁律）。
 *
 * ⚠ 文案只说事实、不教怎么做（用户对空态的固定要求）。
 */
function emptyText(data) {
  if (!data || !data.ok) return '';
  if (!data.records.ok || !data.bookmarks.ok) return '';
  if (data.records.items.length + data.bookmarks.items.length > 0) return '';
  return '这个账号下没有相同的八字';
}

/** 分组标题右侧的计数：`记录 · 3 条` / `学堂书签 · 5 个` */
function countText(g, unit) {
  if (!g) return '';
  if (!g.ok) return '读不到';
  return String(g.total) + ' ' + unit;
}

module.exports = {
  LIMIT: LIMIT,
  PILLARS: PILLARS,
  PARAMS: PARAMS,
  charsOf: charsOf,
  queryOf: queryOf,
  find: find,
  emptyText: emptyText,
  countText: countText,
  _setSources: _setSources
};
