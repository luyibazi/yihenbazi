/**
 * CloudBase（腾讯云开发）记录级驱动 —— PostgREST + RLS
 *
 * ============ 契约（与 store/cloud.js 完全一致）============
 *   listRecords(uid)      → { ok, records?, error? }
 *   putRecord(uid, rec)   → { ok, record?, error? }
 *   deleteRecord(uid, id) → { ok, deleted?, error? }
 *   clearRecords(uid)     → { ok, deleted?, error? }
 * 业务侧（userStore / history）按 store.fileLevel() 分支，走的是**同一套签名** ——
 * 所以换到 CloudBase 驱动时，业务层一个字都不用改。
 *
 * ============ 失败语义（一个字都不能松，与 cloud.js 同源）============
 *   · 任何函数**永不 reject** —— 网络失败是预期内的事
 *   · 读失败 → { ok:false, error }，**绝不是** { ok:true, records:[] }
 *     后者会让上层把「网络抖一下」当成「云端真没有」，然后拿空列表覆盖云端
 *   · 「这个用户没记录」才是 ok:true + 空数组
 *
 * ============ 为什么这个驱动比 Gitee 那个简单得多 ============
 * Gitee 是「一个用户一个 json 文件」，改一条 = 整份读 → 改 → 整份写回，
 * 于是必须守三条生命线（读失败不写 / 写前重读 sha / 失败即中止）。
 * 这里一条记录一行，改一条**就只动那一行** —— 那三条风险面结构性消失。
 *
 * ============ ⚠⚠ 服务端才是权限的守门人 ============
 * 表上有 RLS 策略（`owner = auth.uid()`，且排除哨兵 'anon'），
 * 所以「只返回自己的记录」这件事**不需要客户端代码参与**：
 *   · 读：即使客户端不写任何过滤条件，数据库也只给回自己的行
 *   · 写：`owner` 列的默认值就是 `auth.uid()`；客户端传错 owner 会被 WITH CHECK 拒掉
 * ⇒ 客户端传 uid 只是为了让 upsert 的冲突键完整（见 putRecord），**不是**安全边界。
 *
 * ============ 字段映射（前端「轻记录」 ↔ 表列）============
 *   前端： { id, name, gender, date,      time,      createdAt, notes? }
 *   表列： { id, name, gender, birth_date, birth_time, created_at, notes, owner }
 * 刻意**不用 date/timestamp 类型**存日期时间，一律 text + bigint：
 * 前端本来就是 '1990-01-01' / '11:04' 这种字符串，直进直出，
 * 没有时区、没有类型转换、没有「存进去和读出来不是同一个值」这类问题。
 */
const cbsdk = require('../cbsdk.js');
const session = require('../session.js');

/** 表名（迁移脚本里建的 public.records） */
const TABLE = 'records';

/** PostgREST 的基路径 */
const REST = '/v1/rdb/rest/' + TABLE;

/**
 * RPC 基路径 —— 调的是建在库里的**函数**，不是表。
 * ⚠ 与 REST 的区别不只是路径：那边是 PostgREST 对表自动生成的增删改查（条件走 query string），
 *   这边是把参数按**名字**放进请求体交给一个函数（见 saveNotes）。
 *   函数在库里是 SECURITY INVOKER ⇒ RLS 照常生效，客户端绕不过去。
 */
const RPC = '/v1/rdb/rest/rpc/';

/**
 * 显式列清单 —— 不用 `*`。
 * ⚠ 为了**不把 owner 带回来**：它是权限列，业务侧完全不需要看见，
 *   带回来还会被 record.toStorage() 的白名单默默剥掉（看起来没问题，但多一层无用数据）。
 */
const SELECT = 'id,name,gender,birth_date,birth_time,created_at,notes';

/* ------------------------------------------------------------ 形状转换 */

/**
 * 轻记录 → 表行。
 * ⚠ `owner` 一并带上，原因见 putRecord 的注释（让 upsert 的冲突键完整）。
 */
function toRow(slim, owner) {
  const s = slim || {};
  const row = {
    owner: owner,
    id: s.id,
    name: s.name,
    gender: s.gender,
    birth_date: s.date,
    birth_time: s.time,
    created_at: s.createdAt
  };
  // notes 是可选字段：没有就**完全不出现**，避免云端留一堆 notes: {}
  if (s.notes && typeof s.notes === 'object' && Object.keys(s.notes).length) {
    row.notes = s.notes;
  }
  return row;
}

/**
 * 表行 → 轻记录。
 * 缺关键字段（id / 出生日期 / 出生时间）的行**返回 null**，由调用方过滤 ——
 * 一条读不出来的脏行不该让整次读取失败，但也不该伪装成一条正常记录。
 */
function fromRow(row) {
  if (!row || !row.id || !row.birth_date || !row.birth_time) return null;
  const out = {
    id: String(row.id),
    name: row.name || '未命名',
    // 表里是 smallint：1 男 / 0 女。非 0 一律当男，与 record.slim 的口径一致
    gender: row.gender === 0 ? 0 : 1,
    date: String(row.birth_date),
    time: String(row.birth_time),
    // ⚠ 兼容字符串：PostgREST 对 bigint 在不同配置下可能给数字也可能给字符串，
    //   不 Number() 一下会让 createdAt 变成字符串，排序/比较静默出错
    createdAt: Number(row.created_at) || 0
  };
  if (row.notes && typeof row.notes === 'object' && Object.keys(row.notes).length) {
    out.notes = row.notes;
  }
  return out;
}

/** 从行数统计里读「影响了几行」（Content-Range 形如 `*​/3` 或 `0-2/3`） */
function affectedFromRange(range) {
  const m = /\/(\d+)\s*$/.exec(String(range || ''));
  return m ? Number(m[1]) : 0;
}

/* ------------------------------------------------------------ 令牌 */

/** 取一个当前可用的 access_token，拿不到就如实报错（**绝不**降级成空数据） */
function withToken() {
  return session.getAccessToken().then(function (t) {
    if (!t || !t.ok) {
      return { ok: false, status: 0, code: (t && t.code) || 'NO_SESSION', error: (t && t.error) || '还没有登录' };
    }
    return { ok: true, token: t.token };
  });
}

/**
 * 统一把 HTTP 失败翻成人能看懂的话。
 *
 * ⚠⚠ **必须先看 code，再看 status** —— 实测（2026-10-02 打真接口）发现
 *   RLS 拒绝写入返回的是 **401 + `DATABASE_42501`**，而不是 403：
 *     {"code":"DATABASE_42501","message":"new row violates row-level security policy for table \"records\""}
 *   只看 status 的话，一次「权限不足」会被显示成「登录已过期」，
 *   排查的人会一路去查令牌，而真正的原因（RLS 策略）就在眼前却看不到。
 */
function httpFail(r, what) {
  const code = (r && r.code) || '';
  // ⚠⚠ 「记录不存在」必须**先于**权限判断分流，而且要带一个显式的 notFound 标志。
  //   实测：函数体里 RAISE 的 P0002 会被网关包成 **500 + `DATABASE_P0002`** ——
  //   500 看起来像「服务端故障」，只看状态码会把它当成网络抖动让用户重试，
  //   而用户重试一万次也没用：那条记录就是不在云端了（多半是另一台设备删的）。
  if (code === 'DATABASE_P0002') {
    return {
      ok: false, status: (r && r.status) || 0, code: code, notFound: true,
      error: '云端没有这条记录（列表可能已过期）'
    };
  }
  // r.error 已由 cbsdk 的 errText 保证是中文，这里只在需要更精确时覆盖
  let error = (r && r.error) || (what + '失败');
  if (code === 'DATABASE_42501' || code === 'PERMISSION_DENIED') {
    error = '没有权限修改这份数据';
  } else if (code === 'MISSING_CREDENTIALS' || code === 'INVALID_TOKEN' || code === 'UNAUTHENTICATED') {
    error = '登录已过期，请重新登录';
  } else if (r && r.status === 401) {
    error = '登录已过期，请重新登录';
  } else if (r && r.status === 403) {
    error = '没有权限访问这份数据（可能登录已失效）';
  }
  return { ok: false, status: (r && r.status) || 0, code: code, error: error };
}

/* ------------------------------------------------------------ 读 */

/**
 * 拉这个用户的全部记录（按 createdAt 倒序）。
 * ⚠ 排序**在服务端做**（order=created_at.desc）—— 客户端排序会让「记录多起来之后
 *   顺序不对」这种问题只在数据量上来后才暴露。
 */
function listRecords(uid) {
  return withToken().then(function (t) {
    if (!t.ok) return t;
    const qs = '?select=' + SELECT + '&order=' + encodeURIComponent('created_at.desc');
    return cbsdk.request(REST + qs, { token: t.token }).then(function (r) {
      if (!r.ok) return httpFail(r, '读取云端记录');
      const rows = Array.isArray(r.data) ? r.data : [];
      return { ok: true, records: rows.map(fromRow).filter(function (x) { return !!x; }) };
    });
  });
}

/* ------------------------------------------------------------ 写 */

/**
 * 写入一条记录（新增或覆盖，按主键 (owner, id) 判定）。
 *
 * ⚠⚠ 为什么 body 里要带 owner（而不是留给数据库的 DEFAULT）：
 *   PostgREST 的 upsert（Prefer: resolution=merge-duplicates）需要知道**冲突键的完整值**
 *   才能生成正确的 ON CONFLICT 子句。本表主键是复合的 (owner, id)，
 *   若 body 里缺 owner，冲突判定就不完整。
 *   带上它**不影响安全性** —— 表上有 WITH CHECK(owner = auth.uid())，
 *   传错值会被数据库直接拒掉（这一条已经用越权测试验证过，不是推测）。
 *
 * @param {string} uid 当前 uid（正常等于 JWT 的 sub；也会兜底用 session 里的 sub）
 * @param {Object} slim 轻记录 { id, name, gender, date, time, createdAt, notes? }
 */
function putRecord(uid, slim) {
  const body = toRow(slim, session.uid() || uid);
  return withToken().then(function (t) {
    if (!t.ok) return t;
    return cbsdk.request(REST, {
      method: 'POST',
      token: t.token,
      body: body,
      // merge-duplicates = ON CONFLICT DO UPDATE（幂等：同 id 重复保存不会长重复）
      // return=representation = 把写入后的行返回，便于确认真的写进去了
      headers: { prefer: 'resolution=merge-duplicates,return=representation' }
    }).then(function (r) {
      if (!r.ok) return httpFail(r, '保存到云端');
      const rows = Array.isArray(r.data) ? r.data : [];
      // ⚠ 服务端没回数据体也不算失败（return=representation 有时被网关吃掉），
      //   以「HTTP 成功」为准 —— 但**只有** HTTP 成功才能这么判
      return { ok: true, record: rows.length ? fromRow(rows[0]) : null };
    });
  });
}

/**
 * 写回某条记录的「事件记录」—— 走**云端数据库函数**，不在客户端做合并。
 *
 * ============ 为什么改成调函数（2026-10-02）============
 * 这条路径原来是「拉全表 → 找到那条 → 改 notes → 整行写回」，两个结构性问题：
 *   ① 为改一条记录动了整张表（一次全量读 + 一次整行覆盖）
 *   ② 两台设备同时改**不同**记录时，后写的整行覆盖会把先写的那条抹掉
 * 现在客户端只说「这条记录的 notes 应该是这个」，存在性校验与更新都在库里完成：
 * 一次请求、只动一行、天然原子。（函数定义见迁移 add_save_notes_fn）
 *
 * ============ 契约 ============
 *   saveNotes(uid, id, notes) → { ok, record?, notFound?, error? }
 *   · notes 传空对象 / null ⇒ 清空（函数把列置回 NULL，不留 `notes: {}`）
 *   · 目标记录不存在 ⇒ { ok:false, notFound:true }，**不是**成功
 *
 * ⚠⚠ 「记录不存在」在 HTTP 上是 **500 + `DATABASE_P0002`**，不是 404。
 *   网关把函数体里抛的异常统一包成 500 + `DATABASE_<SQLSTATE>`，
 *   ⇒ **不能按状态码判断**，必须看 code（与 RLS 那条「先看 code 再看 status」同源的坑）。
 *
 * @param {string} uid 与其它记录级方法保持同形（函数内部用的是 auth.uid()）
 * @param {string} id 记录 id
 * @param {Object} notes key → { text, year, ganzhi, age, md?, jieQi? }，见 core/notes.js
 */
function saveNotes(uid, id, notes) {
  if (!id) return Promise.resolve({ ok: false, status: 0, error: '没有记录 id' });
  return withToken().then(function (t) {
    if (!t.ok) return t;
    // ⚠ p_notes 必须**始终传**（哪怕是 null）：PostgREST 是按**参数名**匹配函数的，
    //   少一个参数就会去找「另一个签名的函数」→ 404 PGRST202，
    //   而不是被理解成「这个参数为空」。
    const body = {
      p_record_id: String(id),
      p_notes: (notes && typeof notes === 'object') ? notes : null
    };
    return cbsdk.request(RPC + 'save_notes', {
      method: 'POST',
      token: t.token,
      body: body
    }).then(function (r) {
      if (!r.ok) return httpFail(r, '保存事件记录');
      // 函数 RETURNS jsonb ⇒ 响应体是**一个对象**（不是数组）。
      // 仍兼容数组形状：万一网关以后按「返回集合」包一层，不至于静默丢掉结果。
      const raw = Array.isArray(r.data) ? r.data[0] : r.data;
      const row = (raw && typeof raw === 'object') ? fromRow(raw) : null;
      return { ok: true, record: row };
    });
  });
}

/**
 * 删掉一条记录。
 * ⚠ 过滤条件只写 id，不写 owner —— RLS 的 USING 已经把可见范围限定在自己那几行，
 *   写上 owner 只是重复一遍（而且 uid 未必等于 sub，写了反而可能一条都删不掉）。
 * ⚠ deleted:false（云端本来就没有这条）**不是**失败，如实往上带：
 *   清单里一条已经没了的记录删两次，第二次报错会把用户吓一跳。
 */
function deleteRecord(uid, id) {
  if (!id) return Promise.resolve({ ok: false, status: 0, error: '没有记录 id' });
  return withToken().then(function (t) {
    if (!t.ok) return t;
    const qs = '?id=eq.' + encodeURIComponent(String(id));
    return cbsdk.request(REST + qs, {
      method: 'DELETE',
      token: t.token,
      headers: { prefer: 'return=representation' }
    }).then(function (r) {
      if (!r.ok) return httpFail(r, '删除云端记录');
      const rows = Array.isArray(r.data) ? r.data : [];
      const n = rows.length || affectedFromRange(r.range);
      return { ok: true, deleted: n > 0 };
    });
  });
}

/**
 * 清空这个用户的全部记录。
 * ⚠ PostgREST 的 DELETE **必须带过滤条件**（无条件的全表删除会被拒），
 *   这里用 owner=eq.<自己的 sub> —— 既是合法条件，也把范围说清楚了。
 */
function clearRecords(uid) {
  const owner = session.uid() || uid;
  if (!owner) return Promise.resolve({ ok: false, status: 0, error: '没有可用的用户标识，无法清空' });
  return withToken().then(function (t) {
    if (!t.ok) return t;
    const qs = '?owner=eq.' + encodeURIComponent(String(owner));
    return cbsdk.request(REST + qs, {
      method: 'DELETE',
      token: t.token,
      headers: { prefer: 'return=representation' }
    }).then(function (r) {
      if (!r.ok) return httpFail(r, '清空云端记录');
      const rows = Array.isArray(r.data) ? r.data : [];
      return { ok: true, deleted: rows.length };
    });
  });
}

module.exports = {
  TABLE: TABLE,
  REST: REST,
  SELECT: SELECT,
  toRow: toRow,
  fromRow: fromRow,
  affectedFromRange: affectedFromRange,
  // ⚠ httpFail 也导出：正常路径下 cbdb **走不到** RLS 拒绝
  //   （putRecord 的 owner 永远取自 session.uid()，客户端没机会传错），
  //   所以「RLS 拒绝该说什么话」这件事只能靠直接单测来守。
  //   不导出的话，把判序改坏（只看 status）测试照样全绿 —— 负向验证实测发现过这一点。
  httpFail: httpFail,
  listRecords: listRecords,
  putRecord: putRecord,
  deleteRecord: deleteRecord,
  clearRecords: clearRecords,
  saveNotes: saveNotes
};
