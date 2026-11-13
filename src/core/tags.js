/**
 * 自定义标签 —— 「把八字归到自己定义的名目下」的一层（记录页在用）
 *
 *   标签定义（tags）   ：用户建的分类名目（「客户」「已批」「重点」…）
 *   归类（record_tags）：哪条记录归到哪个标签 —— **一条记录最多一个**（用户拍板）
 *
 * ============ 三件事必须一起看 ============
 *   ① 标签的 id 由**客户端**生成（`newId()`），服务端要的是「重试时同一个 id
 *      不要多建一个」。真正的防重是服务端 `UNIQUE(user_id, name)` + 复合主键，
 *      客户端这份只是让「第一次」可复现。
 *   ② **归类走专用接口**（`PUT /records/:id/tag`），不是整行 PUT ——
 *      整行 PUT 会把没带上的字段当「要清空」，而 tag 根本不在它的写入契约里
 *      （见服务端 routes/tags.ts 文件头）。所以这一层只调用 store.setRecordTag。
 *   ③ **删标签 ≠ 删记录**：删标签只解除归类（服务端由外键 CASCADE 保证）。
 *      界面文案必须把这件事说清楚（「N 条记录回到未分类」），
 *      否则用户会以为记录一起没了。
 *
 * ============ 失败语义（与 requests.js / comments.js 同一纪律） ============
 *   · **永不 reject**；
 *   · `ok:false` = 读/写失败（网络、401、409 重名、服务器坏了）；
 *   · 「一个标签都没有」是 `ok:true + tags:[]` —— **那是常态，不是失败**。
 *   ⚠ 两者绝不能混：把失败兜成空数组，界面就会把「断网」显示成「你还没建过标签」。
 *
 * ============ 名字上限 ============
 * ⚠ `TAG_NAME_MAX` 与**服务端** `routes/tags.ts` 的 `TAG_NAME_MAX` **必须相等**：
 *   前端宽后端窄 ⇒ 用户打完提交才被拒（最气人的一种）；
 *   前端窄后端宽 ⇒ 前端静默截断（用户以为自己打全了）。
 *   与 localsdk.js 的 USERNAME_RE 是同一类纪律，测试里有逐字比对的断言守着。
 */
const store = require('./store/index.js');
const storeMode = require('./storeMode.js');

/** 标签名上限 —— ⚠ 必须与服务端 `routes/tags.ts` 的 TAG_NAME_MAX 相等 */
const TAG_NAME_MAX = 20;

/**
 * 「未分类」在 **URL 参数**里的保留值（`?tagId=none`）。
 *
 * ⚠⚠ 与服务端 `lib/recordFilter.ts` 的 `TAG_NONE` **必须逐字相同** ——
 *   它不是一个「挑个别的写法也行」的常量：字符串对不上，
 *   服务端就会把它当成一个「叫 none 的标签 id」去查，结果是 **0 条**，
 *   而界面显示的是「未分类」—— 一个字都不差的静默错误。
 *
 * ⚠ 这里的 `''`（空串）与 `TAG_NONE` **语义不同**，别混：
 *   · `''`       = **不过滤**（全部）
 *   · `TAG_NONE` = 只看**没有标签**的
 *   两者的区别正是「全部」与「未分类」的区别。
 */
const TAG_NONE = 'none';

/** 当前后端支不支持标签（只有自建 local 后端有 tags / record_tags 两张表） */
function supported() {
  return storeMode.supportsTags();
}

/**
 * 生成一个标签 id。
 *
 * ⚠ 与服务端 records / comments / requests 同一口径：**客户端给 id**
 *   （服务端要的是「重试时同一个 id 不要多建一个」）。
 * ⚠ 带自增计数：只靠毫秒时间戳的话，同一毫秒连点会撞成同一个 id。
 * 字符集 [a-z0-9] ⇒ 永远不可能等于保留值 'none'（服务端还会显式拒绝 'none'）。
 */
let idCounter = 0;
function newId() {
  idCounter = (idCounter + 1) % 46656; /* 36^3，够绕开「同一毫秒」这个尺度 */
  return 'g' + Date.now().toString(36) + idCounter.toString(36);
}

/* ------------------------------------------------------- 标签名的收拾 */

/**
 * 收拾标签名（去首尾空白 + 限长）。
 *
 * ⚠ **只做这两件事**：不做大小写折叠、不删中间空格、不替换标点 ——
 *   一个「看着友好」的归一化会让用户「明明建了两个标签，界面只显示一个」
 *   却不知道是谁把它们合并了（服务端也刻意存原样，见 schema.sql 的 tags.name）。
 * ⚠ 超长时返回 `{err}` 而**不是截断**：截断会让用户以为自己打全了。
 *
 * @returns {{name:string}|{err:string}}
 */
function pickName(raw) {
  if (typeof raw !== 'string') return { err: '请输入标签名' };
  const t = raw.trim();
  if (!t) return { err: '请输入标签名' };
  if (t.length > TAG_NAME_MAX) return { err: '标签名最多 ' + TAG_NAME_MAX + ' 个字' };
  return { name: t };
}

/* ------------------------------------------------------------ 读列表 */

/**
 * 拉我的标签 + 未分类条数。
 *
 * @returns {Promise<{ok:boolean, tags?:Array, untagged?:number, error?:string}>}
 *   ⚠ `ok:true + tags:[]` = **一个标签都还没建**（常态）；
 *     `ok:false` = 读失败。调用方必须分开处理。
 */
function list() {
  if (!supported()) {
    return Promise.resolve({ ok: false, code: 'UNSUPPORTED', error: '标签目前只在自建后端下可用' });
  }
  return store.listTags('').then(function (r) {
    if (!r.ok) return r;
    return { ok: true, tags: r.tags || [], untagged: typeof r.untagged === 'number' ? r.untagged : 0 };
  });
}

/* ------------------------------------------------------------ 写 */

/**
 * 新建标签。
 *
 * @param {string} name 标签名（未收拾的原样传进来，由 pickName 收拾）
 * @param {Object} [opts] { id: 上次用过的 id（重试路径） }
 * @returns {Promise<{ok:boolean, tag?:Object, id:string, status?:number, duplicated?:boolean, error?:string}>}
 *   ⚠ **失败时也带 `id`** —— 调用方重试时传回来，才不会多建一个。
 *   ⚠ `status === 409` 是**重名**（可识别、可提示用户换个名字），不是网络失败。
 */
function create(name, opts) {
  const o = opts || {};
  const id = o.id || newId();
  const nm = pickName(name);
  if ('err' in nm) {
    return Promise.resolve({ ok: false, id: id, code: 'BAD_NAME', error: nm.err });
  }
  if (!supported()) {
    return Promise.resolve({
      ok: false, id: id, code: 'UNSUPPORTED', error: '标签目前只在自建后端下可用'
    });
  }
  return store.createTag('', id, nm.name).then(function (r) {
    if (!r.ok) return { ok: false, id: id, status: r.status, code: r.code, error: r.error };
    /* ⚠ 服务端承诺一定回一个标签。宁可如实报错，也别往界面塞一个空对象 ——
       那会渲染出「名字：undefined」。 */
    if (!r.tag) {
      return { ok: false, id: id, code: 'BAD_SHAPE', error: '服务器没有返回标签' };
    }
    return { ok: true, id: id, tag: r.tag, duplicated: r.duplicated === true };
  });
}

/**
 * 重命名标签。
 * ⚠ 只改 `tags` 那一行 —— 挂它的记录下次读到就是新名字，**不要**去逐条改记录。
 * @returns {Promise<{ok:boolean, tag?:Object, status?:number, error?:string}>}
 */
function rename(id, name) {
  const nm = pickName(name);
  if ('err' in nm) return Promise.resolve({ ok: false, code: 'BAD_NAME', error: nm.err });
  if (!supported()) {
    return Promise.resolve({ ok: false, code: 'UNSUPPORTED', error: '标签目前只在自建后端下可用' });
  }
  return store.renameTag('', id, nm.name).then(function (r) {
    if (!r.ok) return { ok: false, status: r.status, code: r.code, error: r.error };
    if (!r.tag) return { ok: false, code: 'BAD_SHAPE', error: '服务器没有返回标签' };
    return { ok: true, tag: r.tag };
  });
}

/**
 * 删除标签 —— **只解除归类，一条记录都不会少**。
 * @returns {Promise<{ok:boolean, deleted?:boolean, detached?:number, error?:string}>}
 */
function remove(id) {
  if (!supported()) {
    return Promise.resolve({ ok: false, code: 'UNSUPPORTED', error: '标签目前只在自建后端下可用' });
  }
  return store.deleteTag('', id).then(function (r) {
    if (!r.ok) return { ok: false, status: r.status, code: r.code, error: r.error };
    return { ok: true, deleted: r.deleted === true, detached: r.detached || 0 };
  });
}

/**
 * 把某条记录归到某个标签（`tagId` 传 null ⇒ **取消归类**）。
 * @returns {Promise<{ok:boolean, recordId?:string, tagId?:string|null, tagName?:string|null, error?:string}>}
 */
function setFor(recordId, tagId) {
  if (!supported()) {
    return Promise.resolve({ ok: false, code: 'UNSUPPORTED', error: '标签目前只在自建后端下可用' });
  }
  return store.setRecordTag('', recordId, tagId);
}

/* --------------------------------------------------------- 纯小工具 */

/**
 * 在标签列表里按 id 找一个标签。找不到返回 **null**（不是 undefined）——
 * 让调用点的 `if (!t)` 与 `t.name` 两处行为一致，不必分辨两种「没有」。
 */
function byId(tags, id) {
  if (!id) return null;
  const arr = Array.isArray(tags) ? tags : [];
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] && arr[i].id === id) return arr[i];
  }
  return null;
}

/**
 * 按 id 取标签名；取不到给**空串**。
 *
 * ⚠ 取不到（标签刚被别处删掉、或这次列表还没拉回来）时给空串，
 *   **不要**返回 id 本身、也不要返回「未知标签」——
 *   前者会把一串 `g1abc...` 画到卡片上（用户完全看不懂），
 *   后者会让人以为真有一个叫「未知标签」的分类。
 *   卡片那边拿到空串就**不画那枚 chip**，视觉上等同未分类，下次刷新自愈。
 */
function nameOf(tags, id) {
  const t = byId(tags, id);
  return t && typeof t.name === 'string' ? t.name : '';
}

/** 往标签列表里加一个（已有同 id 就替换）—— 返回**新数组**，不改传进来的那份 */
function upsert(tags, tag) {
  if (!tag || !tag.id) return Array.isArray(tags) ? tags : [];
  const out = [];
  let hit = false;
  for (const t of (Array.isArray(tags) ? tags : [])) {
    if (t && t.id === tag.id) {
      out.push(tag);
      hit = true;
    } else {
      out.push(t);
    }
  }
  if (!hit) out.push(tag);
  return out;
}

/** 从标签列表里去掉一个 —— 返回**新数组** */
function drop(tags, id) {
  return (Array.isArray(tags) ? tags : []).filter(function (t) {
    return !t || t.id !== id;
  });
}

/** 「全部」那个计数：未分类 + 各个标签下条数之和（不必再单独问服务端要总数） */
function totalOf(tags, untagged) {
  let n = typeof untagged === 'number' ? untagged : 0;
  for (const t of (Array.isArray(tags) ? tags : [])) {
    n += typeof t.count === 'number' ? t.count : 0;
  }
  return n;
}

module.exports = {
  TAG_NAME_MAX: TAG_NAME_MAX,
  TAG_NONE: TAG_NONE,
  supported: supported,
  newId: newId,
  pickName: pickName,
  list: list,
  create: create,
  rename: rename,
  remove: remove,
  setFor: setFor,
  byId: byId,
  nameOf: nameOf,
  upsert: upsert,
  drop: drop,
  totalOf: totalOf
};
