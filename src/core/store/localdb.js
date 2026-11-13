/**
 * 本地后端（paipan-server）记录级驱动
 *
 * ============ 契约（与 store/cbdb.js / store/cloud.js 完全一致）============
 *   listRecords(uid)      → { ok, records?, error? }
 *   putRecord(uid, rec)   → { ok, record?, created?, error? }
 *   deleteRecord(uid, id) → { ok, deleted?, error? }
 *   clearRecords(uid)     → { ok, deleted?, error? }
 * 业务侧（userStore / history）按 store.fileLevel() 分支，走的是**同一套签名** ——
 * 所以换到这个驱动时，业务层一个字都不用改。
 *
 * ============ 失败语义（一个字都不能松）============
 *   · 任何函数**永不 reject** —— 网络失败是预期内的事
 *   · 读失败 → { ok:false, error }，**绝不是** { ok:true, records:[] }
 *     后者会让上层把「手机没连上 WiFi」当成「云端真没有」，然后拿空列表覆盖云端
 *   · 「这个用户没记录」才是 ok:true + 空数组
 *
 * ============ ⚠⚠ 与 cbdb.js 的**关键差异**：uid 是「送出去的」，但不是安全边界 ============
 * CloudBase 那边，`owner` 由数据库列的默认值 `auth.uid()` 填，客户端传 uid **只是**为了
 * 让 upsert 的冲突键完整 —— 权限由 RLS 在库里保证。
 * 本地后端也一样：`uid` **只从 JWT 里取**（server 侧 `routes/records.ts` 的 preHandler），
 * 请求体/路径里的 uid 一律被忽略。⇒ 本驱动的 uri 参数只是**契约形状的统一**，
 * 并不是「告诉服务端我是谁」。**别**以为传了 uid 就能访问别人的数据（也访问不到）。
 *
 * ============ 字段映射（前端「轻记录」 ↔ 本地表列）============
 *   前端： { id, name, gender, date,      time,      createdAt, notes? }
 *   表列： { id, name, gender, birth_date, birth_time, created_ms, notes, user_id }
 *
 * ⚠⚠ **与 CloudBase 的列名不同，别照抄 cbdb.js 的映射**：
 *   cbdb 是 `created_at`，本地是 `created_ms`（名字更诚实：它存的是前端给的毫秒数）。
 *   但**出参形状完全相同**（都是 createdAt）—— 业务层看不到这个差别。
 *
 * ⚠ 本地服务端的 `toWire()` 会把列名转回前端形状（birth_date → date），
 *   所以**这里不用做出参转换**，收到什么就是什么。
 *   这与 cbdb 不同（那边 PostgREST 回的是裸列名，要自己转）。
 */
const sdk = require('../localsdk.js');
const session = require('../session.js');

/** 基路径。本地后端把记录接口挂在根上（不是 PostgREST 那种 /v1/rdb/rest/） */
const BASE = '/records';

/** 记录 id 的白名单 —— 与服务端 `routes/records.ts` 的校验逐字一致 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ------------------------------------------------------------ 取令牌 */

/**
 * 拿一个现在能用的令牌，没有就直接返回失败。
 *
 * ⚠⚠ 必须**先问 session**、不能自己去读 auth —— 见 session.js 文件头：
 *   令牌这件事由 session 一层独占，别的层只依赖它。
 *
 * ⚠ 本地后端**没有 refresh**：session.getAccessToken() 在本模式下只会做
 *   「有没有 / 过没过期」两个判断，不会去发续期请求（见 session.js 的 HAS_REFRESH 分支）。
 *   所以 expired 是真的要重新登录，不是能自动救回来的。
 */
function tokenOrFail() {
  return session.getAccessToken().then(function (t) {
    if (t && t.ok) return { ok: true, token: t.token };
    return {
      ok: false,
      code: (t && t.code) || 'NO_SESSION',
      error: (t && t.error) || '还没有登录'
    };
  });
}

/* -------------------------------------------------------------- 读 */

/**
 * 读这个用户的记录（服务端按 createdAt **倒序**返回）。
 *
 * @returns {Promise<{ok:boolean, records?:Array, error?:string}>}
 */
function listRecords(uid) {
  return listRecordsFiltered(uid, null);
}

/**
 * 带筛选地读记录。
 *
 * ⚠⚠ 筛选参数**原样转发给服务端**，本地不过滤 —— 用户明确要求
 *   「筛选数据最好由后端解决，app 通过输入参数来获取筛选后的数据」。
 *   所以这里**不要**自作聪明地「先把全量拉下来再本地 filter」：
 *   那样既违背约定，又会让「筛选」在记录多的时候变慢。
 *
 * @param {string} uid 契约形状用（服务端只认 JWT 里的 uid，见文件头）
 * @param {Object|null} filter 筛选参数，形如 { dayGan:'甲,乙', yearZhi:'辰' }
 *        ⚠ 值可以是逗号分隔的字符串，也可以是数组（buildQuery 会展开成重复参数）。
 *        ⚠ 空 / null = 取全部。
 * @param {Object|null} opt 分页参数 `{ limit, offset }`（2026-10-11 加）。
 *        ⚠⚠⚠ **不传 = 全量**（服务端口径：不传 limit 就是全量，offset 一并忽略）。
 *        这条必须保住 —— 上层有「读全量 → 改一条 → 整份写回」的路径
 *        （history.js 改笔记 / 改标签），默认改成分页 ⇒ 拿一页覆盖整张表 = 静默丢数据。
 *        ⚠ 只在 `limit != null` 时才发出去：`offset` 单给没有意义（服务端也会忽略它），
 *          发出去反而让「传了什么」变得不好读。
 * @returns {Promise<{ok:boolean, records?:Array, total?:number, paged?:boolean, error?:string}>}
 *        `total` = **筛后**总条数（服务端权威）。有没有下一页用
 *        `offset + records.length < total` 判断，**不要**用 `records.length === limit`
 *        （最后一页正好装满时会多拉一次空页）。
 */
function listRecordsFiltered(uid, filter, opt) {
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    /* ⚠ 拼进新对象，别改调用方传进来的 filter（它可能是组件里那份 state 的引用） */
    const q = Object.assign({}, filter || {});
    if (opt && opt.limit != null) {
      q.limit = String(opt.limit);
      if (opt.offset != null) q.offset = String(opt.offset);
    }
    /* 没加任何东西时**原样**把 filter 传下去 —— 不传分页的老路径一个字节都不该变 */
    const query = Object.keys(q).length ? q : filter;
    return sdk.request(BASE, { token: t.token, query: query }).then(function (r) {
      if (!r.ok) return r;
      const d = r.data || {};
      // ⚠ 服务端承诺这里一定是数组。若不是，说明对端不是我们认识的那个服务
      //   ⇒ 如实报错，**不要**把 undefined 兜成 []（那就是「读失败伪装成没数据」）
      if (!Array.isArray(d.records)) {
        return { ok: false, status: r.status, code: 'BAD_SHAPE', error: '服务器返回的记录格式不对' };
      }
      return {
        ok: true,
        records: d.records,
        /* ⚠ 老服务端 / 别的驱动不回 total 时退成「这次拿到的条数」——
           宁可让「还有下一页吗」保守地判成没有，也不要凭空造一个大数。
           `paged` 同理：只有服务端明说 true 才算切片返回。 */
        total: typeof d.total === 'number' ? d.total : d.records.length,
        paged: d.paged === true
      };
    });
  });
}

/* -------------------------------------------------------------- 写 */

/**
 * 新增或覆盖一条。
 *
 * ⚠⚠ PUT 的 id 在**路径**里（`PUT /records/:id`），body 里包一层 `{ record }`。
 *   这是本项目踩过的坑之一：写成 `PUT /records`（id 放 body）会 404。
 *
 * ⚠ `created` 由服务端算（它在一个事务里先查后写）—— 别在客户端猜。
 *
 * @param {string} uid 契约形状用（服务端只认 JWT 里的 uid，见文件头）
 * @param {Object} rec 轻记录
 * @returns {Promise<{ok:boolean, record?:Object, created?:boolean, error?:string}>}
 */
function putRecord(uid, rec) {
  const r0 = rec || {};
  if (!r0.id || !ID_RE.test(String(r0.id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk.request(BASE + '/' + encodeURIComponent(r0.id), {
      method: 'PUT',
      body: { record: r0 },
      token: t.token
    }).then(function (r) {
      if (!r.ok) return r;
      const d = r.data || {};
      return { ok: true, record: d.record || r0, created: d.created === true };
    });
  });
}

/* -------------------------------------------------------------- 删 */

/**
 * 删一条。
 *
 * ⚠⚠ `deleted:false`（本来就没有这条）**不是失败** —— 目标是「删掉」，
 *   结果状态已达成。报错只会让用户被「删两次」这个动作吓一跳。
 *
 * ⚠⚠ 删**别人的** id 也回 `deleted:false`（服务端按 `user_id = 我的 uid` 过滤，
 *   压根匹配不到）—— 所以这个返回值**不能**拿来判断「这条记录是否存在」，
 *   只能判断「我这边删掉了一条没有」。这是刻意的设计：不泄露别人有没有这个 id。
 */
function deleteRecord(uid, id) {
  if (!id || !ID_RE.test(String(id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk.request(BASE + '/' + encodeURIComponent(id), {
      method: 'DELETE',
      token: t.token
    }).then(function (r) {
      if (!r.ok) return r;
      const d = r.data || {};
      return { ok: true, deleted: d.deleted === true };
    });
  });
}

/** 清空自己的全部记录（**只动自己的** —— 服务端按 uid 过滤） */
function clearRecords(uid) {
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk.request(BASE, { method: 'DELETE', token: t.token }).then(function (r) {
      if (!r.ok) return r;
      const d = r.data || {};
      // ⚠ deleted 是**条数**（不是布尔）—— 与 deleteRecord 的形状不同，别混
      return { ok: true, deleted: typeof d.deleted === 'number' ? d.deleted : 0 };
    });
  });
}

/* ---------------------------------------------------- 事件记录（notes） */

/**
 * 只换某一条的 notes，不对整行做覆盖。
 *
 * ⚠⚠ 为什么需要这个单独的方法（而不是直接用 putRecord）：见 store/index.js 的 saveNotes 注释。
 *   putRecord 是**整行覆盖**，会把并发写进来的别的字段一起盖掉。
 *
 * ⚠⚠ 本地后端**没有** CloudBase 那个 RPC 数据库函数，所以这里走的是
 *   「取整条 → 只换 notes → PUT 整条」这条**前端**路径。
 *   它与 putRecord 的差别只有一点：**先读回来再改**，减少覆盖窗口。
 *   （严格说仍然不是原子的 —— 真正的原子性要服务端加一个 `PATCH /records/:id/notes`。
 *     当前是单用户自用场景，先不为此加接口；真出现并发覆盖再补。）
 */
function saveNotes(uid, id, notes) {
  if (!id || !ID_RE.test(String(id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    // ① 先把整条读回来（拿到最新的其它字段，避免拿一份过期快照去覆盖）
    return sdk.request(BASE, { token: t.token }).then(function (r) {
      if (!r.ok) return r;
      const list = (r.data && r.data.records) || [];
      const cur = list.filter(function (x) { return x && x.id === id; })[0];
      if (!cur) {
        return { ok: false, code: 'NOT_FOUND', error: '这条记录已经不在云端了，请回记录页重新进入' };
      }
      // ② 只换 notes，其余字段原样带回去
      const next = {};
      Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
      if (notes && typeof notes === 'object' && Object.keys(notes).length) next.notes = notes;
      else delete next.notes;

      return sdk.request(BASE + '/' + encodeURIComponent(id), {
        method: 'PUT',
        body: { record: next },
        token: t.token
      }).then(function (r2) {
        if (!r2.ok) return r2;
        return { ok: true, record: (r2.data && r2.data.record) || next };
      });
    });
  });
}

/* ------------------------------------------------ 师傅批字（comments） */

/**
 * 拉某个会话的消息 —— 一份八字 = 一个会话。
 *
 * ⚠ 会话锚点就是 `recordId`：服务端**没有** session_id、也**没有**会话表。
 *   一份八字 ↔ 一个会话一一对应，硬造一个会话实体只会多出「对不上」的可能。
 *
 * ⚠ `since` 是**增量游标**（传上次拿到的 lastSeq）：不传 / 传 0 就是全量。
 *   服务端承诺「没有新消息时把 lastSeq 原样回落成 since」——
 *   所以调用方必须把 lastSeq 存下来，否则界面上会出现重复消息。
 *
 * ⚠ 「一条消息都没有」是 ok:true + 空数组，**不是**失败 ——
 *   和「这份八字还没有过批字」是一回事。
 *
 * @param {string} uid 契约形状用（服务端只认 JWT 里的 uid，见文件头）
 * @param {string} recordId 会话锚点（这条记录的 id）
 * @param {number} [since] 只取 seq > since 的消息
 * @returns {Promise<{ok:boolean, comments?:Array, lastSeq?:number, truncated?:boolean, error?:string}>}
 */
function listComments(uid, recordId, since) {
  if (!recordId || !ID_RE.test(String(recordId))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  const q = typeof since === 'number' && since > 0 ? { since: since } : null;
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk.request(BASE + '/' + encodeURIComponent(recordId) + '/comments', {
      token: t.token,
      query: q
    }).then(function (r) {
      if (!r.ok) return r;
      const d = r.data || {};
      // ⚠ 与 listRecords 同一纪律：服务端承诺是数组就必须是数组。
      //   把 undefined 兜成 []，等于把「读失败」伪装成「还没有消息」。
      if (!Array.isArray(d.comments)) {
        return { ok: false, status: r.status, code: 'BAD_SHAPE', error: '服务器返回的消息格式不对' };
      }
      return {
        ok: true,
        comments: d.comments,
        lastSeq: typeof d.lastSeq === 'number' ? d.lastSeq : 0,
        truncated: d.truncated === true
      };
    });
  });
}

/**
 * 写一条消息。
 *
 * ⚠⚠ `role` **不由客户端决定**：服务端按「**现查库**的 is_admin」裁定 ——
 *   普通用户传 'master' 会被强制落成 'ask'（否则谁都能伪造一条「师傅批字」，
 *   这个功能的价值就没了）。这里把 role 透下去，只是为了保住
 *   「管理员可以灌一条批语来打通链路」这条骨架通道，**不是**权限声明。
 *
 * ⚠⚠ `msg.id` 必须由**调用方**生成、并在重试时**保持不变**：
 *   服务端用 `INSERT OR IGNORE` 靠它做幂等。换一个 id 重发 = 两条消息。
 *   见 core/comments.js 的 newId()。
 *
 * ⚠ 返回的 `duplicated:true` = 这个 id 之前就存过（网络重试），
 *   `comment` 是**已存在的那一条**（不是新插的）—— 调用方据此知道「既没丢也没重」。
 *
 * @returns {Promise<{ok:boolean, comment?:Object, duplicated?:boolean, error?:string}>}
 */
function addComment(uid, recordId, msg) {
  if (!recordId || !ID_RE.test(String(recordId))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  const m = msg || {};
  if (!m.id || !ID_RE.test(String(m.id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '消息 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    const body = { id: m.id, text: m.text };
    /* ⚠ 只有 'master' 才显式带上：'ask' 是服务端默认，传了也只是白传。
       少传一个字段 = 少一处「客户端以为自己能定 role」的误解。 */
    if (m.role === 'master') body.role = 'master';
    return sdk.request(BASE + '/' + encodeURIComponent(recordId) + '/comments', {
      method: 'POST',
      body: body,
      token: t.token
    }).then(function (r) {
      if (!r.ok) return r;
      const d = r.data || {};
      return { ok: true, comment: d.comment || null, duplicated: d.duplicated === true };
    });
  });
}

/**
 * 查这个八字的**求测单**（*工单*层，不是会话层）。
 *
 * ⚠⚠ 两个层次别混：
 *   · `listComments` = 「师傅和这个八字说过的话」（会话内容）
 *   · 本函数        = 「有人在等师傅看这个八字」（工单，有自己的生命周期）
 *   用户拍板：「App 上点击发起求测**并不是发送一个聊天**」
 *   ⇒ 发起求测只落一张单，**一个字都不往 comments 里写**。
 *
 * ⚠⚠ 「还没有单子」是 **ok:true + request:null**，不是失败 ——
 *   那是这个接口最正常的一种结果（所有人都是从「还没发起」开始的）。
 *   而「读失败」是 ok:false。两者必须分得开，否则界面会把
 *   「网断了」显示成「你还没发起求测」，用户会去点那个按钮、然后一脸茫然。
 *
 * ⚠ 响应里 `request` 这个键**一定在**（没有单子时值是 null）——
 *   键不见了是形状不对，要报错，**不能**兜成 null
 *   （那正好把「读失败」伪装成「还没发起求测」，就是上一条要避免的事）。
 *
 * @returns {Promise<{ok:boolean, request?:Object|null, error?:string}>}
 */
function getRequest(uid, recordId) {
  if (!recordId || !ID_RE.test(String(recordId))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk
      .request(BASE + '/' + encodeURIComponent(recordId) + '/request', { token: t.token })
      .then(function (r) {
        if (!r.ok) return r;
        const d = r.data || {};
        if (!Object.prototype.hasOwnProperty.call(d, 'request')) {
          return {
            ok: false,
            status: r.status,
            code: 'BAD_SHAPE',
            error: '服务器返回的求测单格式不对'
          };
        }
        return { ok: true, request: d.request || null };
      });
  });
}

/**
 * 发起求测 —— **幂等**：这个八字已经有单子时，原样返回**已有那张**
 * （`duplicated:true`，且它可能已经是 `status:'taken'` 了）。
 *
 * ⚠ 单子 id 由**调用方**生成（与服务端 records/comments 同一口径：
 *   客户端给 id，重试时保持同一个 ⇒ 不会多出一张）。
 *   ⚠ 但真正的防重不是靠它 —— 服务端的 `UNIQUE(user_id, record_id)`
 *   才是结构保证（并发时两张只会进去一张）。id 只是让「第一次」可复现。
 *
 * @returns {Promise<{ok:boolean, request?:Object, duplicated?:boolean, error?:string}>}
 */
function createRequest(uid, recordId, id) {
  if (!recordId || !ID_RE.test(String(recordId))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  if (!id || !ID_RE.test(String(id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '求测单 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk
      .request(BASE + '/' + encodeURIComponent(recordId) + '/request', {
        method: 'POST',
        body: { id: id },
        token: t.token
      })
      .then(function (r) {
        if (!r.ok) return r;
        const d = r.data || {};
        /* ⚠ 这里是**写**：没有 request 就是形状不对，绝不能兜一个空对象
           （界面会拿着一个空单子渲染出「状态：undefined」）。 */
        if (!d.request) {
          return {
            ok: false,
            status: r.status,
            code: 'BAD_SHAPE',
            error: '服务器没有返回求测单'
          };
        }
        return { ok: true, request: d.request, duplicated: d.duplicated === true };
      });
  });
}

/* ------------------------------------------------- 自定义标签（tags） */

/**
 * 标签接口的基路径。
 * ⚠ 与上面 BASE('/records') 并列 —— 归类接口是 `/records/:id/tag`（跨两族），
 *   所以那里拼的是 BASE + …，这里拼的是 TAGS + …，别混。
 */
const TAGS = '/tags';

/**
 * 拉我的标签列表 + **未分类**条数。
 *
 * ⚠⚠ `untagged` 缺了**不能兜成 0**：那会把「服务端没回这个字段」显示成
 *   「一条未分类都没有」。数字是假的、而标签栏照常画出来 —— 用户完全看不出来。
 *   这与 listRecords「不是数组就报错」是同一条纪律：形状不对就如实报错。
 *
 * @returns {Promise<{ok:boolean, tags?:Array, untagged?:number, error?:string}>}
 */
function listTags(uid) {
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk.request(TAGS, { token: t.token }).then(function (r) {
      if (!r.ok) return r;
      const d = r.data || {};
      if (!Array.isArray(d.tags) || typeof d.untagged !== 'number') {
        return {
          ok: false,
          status: r.status,
          code: 'BAD_SHAPE',
          error: '服务器返回的标签格式不对'
        };
      }
      return { ok: true, tags: d.tags, untagged: d.untagged };
    });
  });
}

/**
 * 新建标签。
 *
 * ⚠⚠ **409（重名）要原样带回去**，不能压成一句通用失败：
 *   调用方要分「重名 → 提示换个名字」和「网络失败 → 让他重试」两种，
 *   而这两种的处理方式完全不同（前者重试一万次也没用）。
 *
 * ⚠ `duplicated:true` = 这个 id 之前就建过（网络重试）⇒ `tag` 是**已存在那个**，
 *   既没丢也没重。与 requests 的 createRequest 同一套语义。
 *
 * @returns {Promise<{ok:boolean, tag?:Object, duplicated?:boolean, status?:number, error?:string}>}
 */
function createTag(uid, id, name) {
  if (!id || !ID_RE.test(String(id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '标签 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk
      .request(TAGS, { method: 'POST', body: { id: id, name: name }, token: t.token })
      .then(function (r) {
        if (!r.ok) return r;
        const d = r.data || {};
        /* ⚠ 这是**写**：没有 tag 就是形状不对，绝不能兜一个空对象
           （界面会拿着一个空标签渲染出「名字：undefined」）。 */
        if (!d.tag) {
          return { ok: false, status: r.status, code: 'BAD_SHAPE', error: '服务器没有返回标签' };
        }
        return { ok: true, tag: d.tag, duplicated: d.duplicated === true };
      });
  });
}

/**
 * 重命名标签。
 *
 * ⚠ 改名只动 `tags` 那一行 —— 挂它的记录**下次读到就是新名字**
 *   （名字只有一份，见服务端 schema.ts 里 TagRow 的注释）。
 *   所以这里**不需要**、也**不可以**去逐条改记录：那会写坏几百行，还会漏。
 *
 * ⚠ 409 = 改成别人已在用的名字；404 = 标签不在了（别的地方删掉了）。
 */
function renameTag(uid, id, name) {
  if (!id || !ID_RE.test(String(id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '标签 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk
      .request(TAGS + '/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: { name: name },
        token: t.token
      })
      .then(function (r) {
        if (!r.ok) return r;
        const d = r.data || {};
        if (!d.tag) {
          return { ok: false, status: r.status, code: 'BAD_SHAPE', error: '服务器没有返回标签' };
        }
        return { ok: true, tag: d.tag };
      });
  });
}

/**
 * 删除标签 —— **只解除归类，一条记录都不会少**（服务端那边由外键 CASCADE 保证）。
 *
 * ⚠ `deleted:false`（本来就没有这个标签）**不是失败** —— 与删记录同一口径：
 *   目标是「删掉」，结果状态已达成。
 * ⚠ `detached` = 有多少条记录被解除了归类。界面上用它拼那句
 *   「已删除「客户」，3 条记录回到未分类」—— 没有它，用户会以为记录也被删了。
 */
function deleteTag(uid, id) {
  if (!id || !ID_RE.test(String(id))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '标签 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk
      .request(TAGS + '/' + encodeURIComponent(id), { method: 'DELETE', token: t.token })
      .then(function (r) {
        if (!r.ok) return r;
        const d = r.data || {};
        return {
          ok: true,
          deleted: d.deleted === true,
          detached: typeof d.detached === 'number' ? d.detached : 0
        };
      });
  });
}

/**
 * 把某条记录归到某个标签（`tagId` 传 null / '' ⇒ **取消归类**）。
 *
 * ⚠⚠ 走的是**专用接口** `PUT /records/:id/tag`，**不是** `PUT /records/:id`。
 *   后者是整行覆盖，而 tag 不在它的写入契约里（records 的 upsert 根本不碰 tag）——
 *   这正是「改描述 / 记事件」这类操作不可能顺手抹掉标签的原因
 *   （见服务端 routes/tags.ts 文件头）。
 *
 * ⚠ `null` 是**要发出去的**：`buildQuery` 会把 null 丢掉，但这里是 **body**，
 *   `JSON.stringify({ tagId: null })` 就是 `{"tagId":null}` —— 服务端收到的正是 null。
 *   （服务端把 null / '' / 缺键**都**当「取消归类」，所以三种写法都不会错，
 *     但我们**只发一种**，口径唯一。）
 *
 * @returns {Promise<{ok:boolean, recordId?:string, tagId?:string|null, tagName?:string|null, error?:string}>}
 */
function setRecordTag(uid, recordId, tagId) {
  if (!recordId || !ID_RE.test(String(recordId))) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '记录 id 非法' });
  }
  const want =
    tagId === undefined || tagId === null || tagId === '' ? null : String(tagId);
  if (want !== null && !ID_RE.test(want)) {
    return Promise.resolve({ ok: false, code: 'BAD_ID', error: '标签 id 非法' });
  }
  return tokenOrFail().then(function (t) {
    if (!t.ok) return t;
    return sdk
      .request(BASE + '/' + encodeURIComponent(recordId) + '/tag', {
        method: 'PUT',
        body: { tagId: want },
        token: t.token
      })
      .then(function (r) {
        if (!r.ok) return r;
        const d = r.data || {};
        /* ⚠⚠ 判「这个键在不在」，**不能**判 `!d.tagId` ——
           取消归类时它的值**正是 null**，用真值判会把一次成功误报成形状错误。 */
        if (!Object.prototype.hasOwnProperty.call(d, 'tagId')) {
          return { ok: false, status: r.status, code: 'BAD_SHAPE', error: '服务器没有返回归类结果' };
        }
        return {
          ok: true,
          recordId: recordId,
          tagId: d.tagId || null,
          tagName: d.tagName || null
        };
      });
  });
}

module.exports = {
  BASE: BASE,
  TAGS: TAGS,
  ID_RE: ID_RE,
  listRecords: listRecords,
  listRecordsFiltered: listRecordsFiltered,
  putRecord: putRecord,
  deleteRecord: deleteRecord,
  clearRecords: clearRecords,
  saveNotes: saveNotes,
  listComments: listComments,
  addComment: addComment,
  getRequest: getRequest,
  createRequest: createRequest,
  listTags: listTags,
  createTag: createTag,
  renameTag: renameTag,
  deleteTag: deleteTag,
  setRecordTag: setRecordTag
};
