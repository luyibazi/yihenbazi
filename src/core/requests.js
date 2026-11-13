/**
 * 求测单 —— 「发起求测」的一层
 *
 * ============ 它和 comments 是**两层**，别混 ============
 *   · 本文件（requests）= **工单**：有人在等师傅看这个八字。有生命周期：
 *       `pending`（已提交，等师傅接单） → `taken`（某位师傅接下了）
 *   · `core/comments.js` = **会话**：师傅接单之后，双方说的话
 *
 * ⚠⚠ 用户拍板：「App 上点击发起求测**并不是发送一个聊天**」——
 *   所以 `create()` **一个字都不往 comments 里写**。
 *   旧实现是把「发起」翻译成一条 `请师傅批一批这个八字。` 的消息，
 *   后果是「单子必须靠一条消息才能存在」，空会话没法表示 —— 那是模型的反面。
 *
 * ============ 三态（Result.tsx 就是按这个画界面） ============
 *   `req === null`                 还没发起 → 显示「发起求测」按钮
 *   `req.status === 'pending'`     已提交、等接单 → 显示「等待师傅接单」（**没有输入框**）
 *   `req.status === 'taken'`       已被接单 → 这才出现输入框，可以聊
 * ⚠ 中间那一态是新的：旧模型里「提交了但没人接」根本无处安放。
 *
 * ============ 三个函数的失败语义（与 comments.js 同一纪律） ============
 *   · **永不 reject**；
 *   · `ok:false` = **读/写失败**（网络、401、服务器坏了）；
 *   · `ok:true + req:null` = 「还没发起求测」——**这是常态，不是失败**。
 *   ⚠ 两者绝不能混：把失败兜成 null，界面就会把「断网」显示成「你还没求测」，
 *     用户会去点那个按钮、然后一脸茫然。
 */
const store = require('./store/index.js');
const storeMode = require('./storeMode.js');

/** 当前后端支不支持求测（只有自建 local 后端有 requests 表） */
function supported() {
  return storeMode.supportsRequests();
}

/**
 * 生成一个求测单 id。
 *
 * ⚠ 与服务端 records / comments 同一口径：**客户端给 id**（服务端要的是
 *   「重试时同一个 id 不要多开一张单」）。
 *   ⚠ 但真正的防重不靠它 —— 服务端 requests 表上的 `UNIQUE(user_id, record_id)`
 *   才是结构保证（并发时两张只会进去一张，代码里 OR IGNORE + 回读）。
 *   ⚠ 带自增计数：只靠毫秒时间戳的话，同一毫秒连点会撞成同一个 id。
 *   字符集 [a-z0-9]，与服务端的 id 白名单一致。
 */
let idCounter = 0;
function newId() {
  idCounter = (idCounter + 1) % 46656; /* 36^3，够绕开「同一毫秒」这个尺度 */
  return 'q' + Date.now().toString(36) + idCounter.toString(36);
}

/**
 * 查这个八字的求测单。
 *
 * @param {string} recordId 八字（records.id）
 * @returns {Promise<{ok:boolean, req:Object|null, error?:string}>}
 *   ⚠ `ok:true + req:null` = **还没发起求测**（常态）；
 *     `ok:false` = 读失败。调用方必须分开处理这两个。
 */
function get(recordId) {
  if (!supported()) {
    return Promise.resolve({
      ok: false,
      code: 'UNSUPPORTED',
      error: '求测目前只在自建后端下可用'
    });
  }
  return store.getRequest('', recordId).then(function (r) {
    if (!r.ok) return r;
    return { ok: true, req: r.request || null };
  });
}

/**
 * 发起求测（幂等）。
 *
 * @param {string} recordId 八字
 * @param {Object} [opts] { id: 上次用过的 id（重试路径） }
 * @returns {Promise<{ok:boolean, req:Object, id:string, duplicated:boolean, error?:string}>}
 *   ⚠ **失败时也带 `id`** —— 调用方重试时传回来，才不会多开一张单。
 *   ⚠ `duplicated:true` = 这个八字**已经有单子**了，返回的是**已有那张**
 *     （它可能已经是 `status:'taken'` 了 —— 那就不是「刚提交」，而是「师傅已经在看了」）。
 */
function create(recordId, opts) {
  const o = opts || {};
  const id = o.id || newId();
  if (!supported()) {
    return Promise.resolve({
      ok: false,
      id: id,
      code: 'UNSUPPORTED',
      error: '求测目前只在自建后端下可用'
    });
  }
  return store.createRequest('', recordId, id).then(function (r) {
    if (!r.ok) return { ok: false, id: id, code: r.code, error: r.error };
    /* ⚠ 服务端承诺一定回一张单（没有就是形状不对）。宁可如实报错，
       也别往界面塞一个空单子 —— 那会渲染出「状态：undefined」。 */
    if (!r.request) {
      return { ok: false, id: id, code: 'BAD_SHAPE', error: '服务器没有返回求测单' };
    }
    return { ok: true, id: id, req: r.request, duplicated: r.duplicated === true };
  });
}

module.exports = {
  supported: supported,
  newId: newId,
  get: get,
  create: create
};
