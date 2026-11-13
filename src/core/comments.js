/**
 * 师傅批字 —— 每份八字一个会话
 *
 * ============ 会话就是这条记录 ============
 * 没有 session_id、没有会话列表、没有「新建会话」。
 * 一份八字 ↔ 一个会话本来就是一一对应的，所以锚点直接用 `recordId`。
 * 好处不是省事：这样「会话只属于这份八字」**结构上就不可违反** ——
 * 想挂到别处都没有能挂的地方（服务端 comments 表的复合外键指着 records 的复合主键）。
 *
 * ============ 谁是「师傅」不由前端说了算 ============
 * 服务端按「**现查库**的 is_admin」裁定 role：普通用户写的一律落成 'ask'，
 * 传 'master' 也没用。所以这一层**不做**任何权限判断 ——
 * 客户端若能自己声明「我是师傅」，这个功能就一文不值了。
 * 这里只在管理员路径（opts.role='master'）把意图透下去，能不能生效由服务端定。
 *
 * ============ 消息 id 由客户端给，且重试必须沿用同一个 ============
 * 服务端用 `INSERT OR IGNORE` 靠 id 做幂等。所以：
 *   · 失败时 `send()` 会把用过的 id **一起返回**，调用方重试时原样传回来
 *     （`{ id }`）—— 否则「超时但其实写成功了」会变成两条消息。
 *   · 这一点和 records 是同一口径（记录 id 也是客户端给的）。
 *
 * ============ 不做的 ============
 * 已读 / 未读、推送通知、正在输入…… 现在还没有真正的「发送方」，
 * 先做「进页签拉一次 + 手动刷新」。等真有师傅在另一端写，再谈实时。
 */
const store = require('./store/index.js');
const storeMode = require('./storeMode.js');

/** 当前后端支不支持师傅批字（只有自建 local 有那张表，见 storeMode.supportsComments） */
function supported() {
  return storeMode.supportsComments();
}

/**
 * 生成一个消息 id。
 *
 * ⚠ 必须**在客户端生成**（服务端要的是「重试时同一个 id 不要插两条」，
 *   它自己生成就做不到这件事）。
 * ⚠ 加一个自增计数：只靠毫秒时间戳的话，同一毫秒连点两次会撞成同一个 id，
 *   第二条会被 INSERT OR IGNORE 静默吃掉（用户看到「发了但没出来」）。
 *   字符集只含 [a-z0-9]，与服务端的 id 白名单一致。
 */
let idCounter = 0;
function newId() {
  idCounter = (idCounter + 1) % 46656; /* 36^3，够绕开「同一毫秒」这个尺度 */
  return 'm' + Date.now().toString(36) + idCounter.toString(36);
}

/** 按 seq 升序 —— 服务端已经排好了，这里只是不让「万一乱序」传到界面上 */
function sorted(list) {
  return (Array.isArray(list) ? list : []).slice().sort(function (a, b) {
    return (Number(a && a.seq) || 0) - (Number(b && b.seq) || 0);
  });
}

/**
 * 拉这个会话的消息。
 *
 * @param {string} recordId 会话锚点（这条记录）
 * @param {number} [since] 只取 seq > since 的（传上次拿到的 lastSeq）；不传 = 全量
 * @returns {Promise<{ok:boolean, comments?:Array, lastSeq?:number, truncated?:boolean, error?:string}>}
 *   ⚠ 空会话是 ok:true + comments:[]（不是失败）—— 与「读失败」严格分开。
 */
function list(recordId, since) {
  if (!supported()) {
    return Promise.resolve({
      ok: false,
      code: 'UNSUPPORTED',
      error: '师傅批字目前只在自建后端下可用'
    });
  }
  return store.listComments('', recordId, since).then(function (r) {
    if (!r.ok) return r;
    return {
      ok: true,
      comments: sorted(r.comments),
      lastSeq: typeof r.lastSeq === 'number' ? r.lastSeq : 0,
      truncated: r.truncated === true
    };
  });
}

/**
 * 发一条消息。
 *
 * @param {string} recordId 会话锚点
 * @param {string} text     正文（⚠ 空/纯空白由调用方先挡掉，这里不替它做决定）
 * @param {Object} [opts]   { id: 上次用过的 id（重试路径）, role: 'master'（仅管理员） }
 * @returns {Promise<{ok:boolean, id:string, comment?:Object, duplicated?:boolean, error?:string}>}
 *   ⚠ **失败时也带 `id`** —— 调用方重试时把它传回来，才能保证「重试不产生第二条」。
 */
function send(recordId, text, opts) {
  const o = opts || {};
  const id = o.id || newId();
  if (!supported()) {
    return Promise.resolve({
      ok: false,
      id: id,
      code: 'UNSUPPORTED',
      error: '师傅批字目前只在自建后端下可用'
    });
  }
  return store
    .addComment('', recordId, { id: id, text: text, role: o.role })
    .then(function (r) {
      if (!r.ok) {
        return { ok: false, id: id, code: r.code, error: r.error };
      }
      /* ⚠ 服务端可能回一条 comment:null（理论上不会）。那样界面会短路 —— 
         宁可如实报错，也别往列表里塞一条空消息。 */
      if (!r.comment) {
        return { ok: false, id: id, code: 'BAD_SHAPE', error: '服务器没有返回这条消息' };
      }
      return { ok: true, id: id, comment: r.comment, duplicated: r.duplicated === true };
    });
}

module.exports = {
  supported: supported,
  newId: newId,
  sorted: sorted,
  list: list,
  send: send
};
