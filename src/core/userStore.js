/**
 * 云端用户身份与记录存取 —— 一个 uid 对应云端的一份数据
 *
 * ============ ⚠⚠ 两种模型，本文件按 MODE 分支处理 ⚠⚠ ============
 * ⚠ 当前 MODE = 'cloudbase'（记录级，一条记录一行）。下面描述的**文件级**模型
 *   是 gitee 分支的行为，它仍可切换（见 storeMode.js 文件头）。
 * 文件级模型下：`userData/<uid>.json`，一个用户一个文件，
 * 改一条记录 = 读全量 → 改内存 → **整份写回**。
 *
 * 但文件里**同时保留**记录级（抖音云）那条路 —— 不是历史包袱，是因为：
 *   · store/index.js 两个驱动的接口本来就不同级（fileLevel() 会把这件事说明白），
 *     硬抹平会让「整份重写」这个最需要被看见的语义消失；
 *   · 分支写在**一处**（本文件 + history.js），比藏在适配层里安全得多。
 *
 * 对外接口刻意做成**两套**，调用方按 store.fileLevel() 选：
 *   文件级：ensureUserFile / readUserFile / writeUserFile
 *   记录级：listRecords / putRecord / deleteRecord / clearRecords
 * ⚠ history.js 是唯一调用方，它按同一个 fileLevel() 分支。
 *
 * ============ 文件级的三条生命线（少一条就丢数据）============
 * 见 store/gitee.js 文件头。本文件负责的是**第二条**：
 *   「写之前必须重新读一次拿最新 sha」—— 否则另一台设备刚存过一条，
 *   这边拿旧 sha 一 PUT 就把它抹掉（Gitee 的 PUT 是整份覆盖）。
 * 所以 writeUserFile 的签名是 (uid, list) 而**不是** (uid, list, sha)：
 * 它自己去读、自己拿最新的 sha。少一个「上层可能传错」的参数。
 *
 * ============ ⚠ 现在拿不到真 unionid ⚠ ============
 * unionid 只能由**服务端**用 code2session 换（见 core/auth.js 文件头），
 * 而当前 LOGIN_API 为空 ⇒ uidOf() 一定会降级到设备码。
 * 那是**设备级**标识：换手机、清缓存、重装都会变成新 uid，
 * 记录随之「消失」（其实还在旧 uid 名下）。等接上服务端会自动切到 unionid。
 */
const store = require('./store/index.js');
const record = require('./record.js');

/** 文件里的数据版本，将来改结构时用来判断要不要迁移 */
const SCHEMA = 1;

/**
 * 一个用户文件里最多存多少条。
 * ⚠ 文件级模型下这个上限**更紧要**：整个列表是一个 json，超了就是整份写不上去。
 *   记录级时代只是「列表长一点」，这里却是「写失败」。界面侧（记录页）也会用这个数。
 */
const MAX = 50;

/** 空文件的规范形态 —— 建文件时用它，读文件时把坏数据收敛成它 */
function emptyDoc() {
  return { schema: SCHEMA, records: [] };
}

/* ------------------------------------------------------------- 标识 */

/**
 * 从登录态里取用户标识，并说明它的来源。
 * 优先级 cloudbaseUid > unionid > openid > anonymousCode（越靠前越稳定）。
 *
 * ⚠⚠ 为什么 CloudBase 那条排最前：
 *   接入后端之后，uid 要跟**服务端认的那个身份**对上 —— 也就是 JWT 的 `sub`
 *   （数据库里 RLS 策略比对的就是它）。其它几个字段都是「我们本地的叫法」，
 *   拿它们去跟服务端对话，等于各说各话。
 *
 * ⚠⚠ 同一用户可能**同时**带着 openid 与设备码，而云端数据很可能是
 *   **上一次**按设备码存下的。若这里改选 openid，就会去读另一份数据 ——
 *   一条都查不到，用户记录「凭空清空」（旧数据还在，只是再没人去读）。
 *   ⇒ 「选哪个标识」必须与**既有数据**对齐，不是纯粹按稳定性排序。
 *   （CloudBase 那条不受此影响：它是新模型下的唯一标识，没有历史包袱。）
 */
function uidOf(session) {
  if (!session) return { uid: '', source: '' };
  // CloudBase：服务端签发的用户 ID（JWT 的 sub）
  if (session.cloudbaseUid) return { uid: session.cloudbaseUid, source: 'cloudbase' };
  if (session.unionid) return { uid: session.unionid, source: 'unionid' };
  if (session.openid) return { uid: session.openid, source: 'openid' };
  // ⚠⚠ 字段名有三种，全都得认（踩过）：
  //   · anonymousCode —— 小程序侧登录态的名字
  //   · anonymousId   —— auth.getUser() 那套脱敏视图的名字
  //   · deviceCode    —— **RN 侧登录态自己的名字**（core/auth.js 写的）
  //   少认一个就会得到 uid='' → 定位不到云端文件 → 用户看到「记录没了」。
  const anon = session.anonymousCode || session.anonymousId || session.deviceCode;
  if (anon) return { uid: anon, source: 'anonymous' };
  return { uid: '', source: '' };
}

/**
 * uid 是否可用于拼云端路径。
 * ⚠ 与 store/gitee.js 的 safeUid 同一口径（那边是防路径穿越的最后一道），
 *   这里提前拦一次是为了**报错更早更清楚**，不是替代它。
 */
function uidOk(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(uid);
}

/* ------------------------------------------------------- 文件级：路径 */

/**
 * 文件名的构成 —— 只用 uid 本身，不加前后缀、不做哈希。
 * 好处是「看到一个文件名就知道是谁的」，排查线上问题时能直接对上人。
 * （安全性靠 uidOk 保证：uid 已经限定在 [A-Za-z0-9_-]。）
 *
 * ⚠⚠ 空 uid 必须返回空串，**不能**拼出 '.json' —— 那会变成仓库根目录下的
 *   一个叫 `.json` 的文件，所有「没有 uid」的调用挤在同一个文件里，
 *   互相覆盖。store/gitee.js 的 pathOf 也是同样口径（那边是最后一道）。
 */
function fileNameOf(uid) {
  const s = typeof uid === 'string' ? uid : '';
  return s ? s + '.json' : '';
}

/**
 * 云端仓库里的完整路径（唯一决定「数据存哪」的地方）。
 * ⚠ 空 uid → 空串（不是 'userData/.json'）。调用方据此判断「定位不到文件」。
 */
function pathOf(uid) {
  const f = fileNameOf(uid);
  return f ? 'userData/' + f : '';
}

/* --------------------------------------------------- 文件级：读 / 写 / 建 */

/**
 * 确保该用户的文件存在（不存在就建一个空的）。
 *
 * ⚠ 返回值必须区分「建好了」「本来就有」「失败」三态 —— 登录流程
 *   （core/boot.js）要靠它决定进度条文字走不走「正在创建数据文件…」。
 *
 * ⚠⚠ 读失败时**绝不能**当成「不存在」然后去 POST 一个空文件 ——
 *   那会在断网时把一份空数据写上去，用户一联上就发现记录没了。
 *   （Gitee 读不存在的文件返回 200 + `[]`，一旦这里判错就正好走成这条路。）
 *
 * @returns {Promise<{ok:boolean, created?:boolean, existed?:boolean, error?:string}>}
 */
function ensureUserFile(uid) {
  if (!uidOk(uid)) {
    return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法定位云端文件' });
  }
  return store.readFile(uid).then(function (r) {
    // 生命线①：读失败 ≠ 不存在
    if (r.failed) {
      return { ok: false, error: r.error || '读取云端文件失败' };
    }
    if (r.exists) return { ok: true, existed: true };

    // 确实不存在 → 建一个空的。
    // ⚠ 用 upsertFile 而不是 createFile：如果两台设备同时首次登录，
    //   另一台可能刚好抢先建好了，POST 会撞 400「文件名已存在」——
    //   那不是错误，upsert 会回退成「已存在」再正常返回。
    return store.upsertFile(uid, JSON.stringify(emptyDoc())).then(function (w) {
      if (!w.ok) return { ok: false, error: w.error || '创建云端数据文件失败' };
      return { ok: true, created: true, raced: !!w.raced };
    });
  });
}

/**
 * 读该用户的全部记录（已压成轻记录、已过滤坏数据）。
 *
 * ⚠⚠ 「没有记录」与「读失败」是两件事：
 *   · 没有记录 → { ok:true, records:[] }
 *   · 读失败   → { ok:false, error }
 *   调用方（history.pull）靠这个区别决定「列表空着」还是「报错让用户重试」。
 *   把读失败降级成空列表 = 让用户以为数据没了，或让上层拿空列表覆盖云端。
 *
 * @returns {Promise<{ok:boolean, records?:Array, error?:string}>}
 */
function readUserFile(uid) {
  if (!uidOk(uid)) {
    return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法定位云端文件' });
  }
  return store.readFile(uid).then(function (r) {
    if (r.failed) return { ok: false, error: r.error || '读取云端文件失败' };
    // 文件不存在 = 这个用户还没存过东西，是「空」不是「失败」
    if (!r.exists) return { ok: true, records: [], existed: false };

    const doc = parseDoc(r.text);
    // ⚠ parseDoc 失败要**如实报错**而不是返回空列表 ——
    //   否则解析不了的老数据/坏数据会被当成「没有」，下一次写就把它冲掉了
    if (!doc) {
      return { ok: false, error: '云端数据格式无法识别（可能被别处改坏了），已中止以防覆盖' };
    }
    return {
      ok: true,
      records: doc.records.map(record.toStorage).filter(function (x) { return !!x; }),
      existed: true
    };
  });
}

/**
 * 整份写回（**文件级模型的核心操作**）。
 *
 * ⚠⚠ 签名里**没有 sha** 是刻意的（见文件头）：本函数自己重读一次拿最新 sha。
 *   上层若被允许传 sha，就一定会有人传成「上一次读到的那个」——
 *   那正是「另一台设备刚存过一条、这边一覆盖就全没」的成因。
 *
 * @param {string} uid
 * @param {Array}  list 轻记录数组（本函数不筛，调用方已经过 toStorage）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function writeUserFile(uid, list) {
  if (!uidOk(uid)) {
    return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法写入' });
  }
  const rows = Array.isArray(list) ? list : [];
  if (rows.length > MAX) {
    return Promise.resolve({
      ok: false,
      error: '记录条数超过上限（' + MAX + ' 条），云端文件存不下，请先删掉一些'
    });
  }
  const text = JSON.stringify({ schema: SCHEMA, records: rows });

  // 生命线②：写前重读最新 sha
  return store.readFile(uid).then(function (r) {
    // 生命线③：读失败就整条失败，什么都不写
    if (r.failed) return { ok: false, error: r.error || '写入前读取云端失败，已中止（避免覆盖）' };

    if (!r.exists) {
      // 文件不在（第一次写 / 被删了）→ 创建
      return store.writeFile(uid, text, '').then(function (w) {
        if (w.ok) return { ok: true };
        // 竞态：POST 撞 400「已存在」→ 用 upsert 走一遍（它会回读 sha 再 PUT）
        if (w.raced || w.status === 400) {
          return store.upsertFile(uid, text).then(function (u) {
            return u.ok ? { ok: true } : { ok: false, error: u.error || '写入云端失败' };
          });
        }
        return { ok: false, error: w.error || '创建云端文件失败' };
      });
    }

    return store.writeFile(uid, text, r.sha).then(function (w) {
      if (w.ok) return { ok: true };
      // 竞态：刚读到的 sha 已经被别人改过了（PUT 会报 409/400）→ 回退成 upsert
      if (w.raced || w.status === 409 || w.status === 400) {
        return store.upsertFile(uid, text).then(function (u) {
          return u.ok ? { ok: true, refetched: true } : { ok: false, error: u.error || '写入云端失败' };
        });
      }
      return { ok: false, error: w.error || '写入云端失败' };
    });
  });
}

/**
 * 解析文件内容。
 * ⚠ 只在**解析不了**时返回 null（调用方据此报错中止）；能解析但结构怪异的
 *   一律收敛（老数据是裸数组、records 不是数组、单条是 null…），不报错。
 *   区分点是「这份数据到底是不是这个应用的」—— 是就尽力读，不是就宁可不读。
 */
function parseDoc(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (err) { return null; }
  if (!raw) return null;

  // 老版本直接存了数组（没有 schema/records 外壳）→ 认它
  if (Array.isArray(raw)) return { schema: SCHEMA, records: raw };
  if (typeof raw !== 'object') return null;
  if (!Array.isArray(raw.records)) {
    // 有 schema 但 records 坏了 → 当成「这个文件是我们的、只是空的」
    if (raw.schema) return emptyDoc();
    return null;
  }
  return { schema: raw.schema || SCHEMA, records: raw.records };
}

/* --------------------------------------------- 记录级（抖音云）：备用 */

/**
 * 服务端那一行 → 「轻记录 + 只读派生字段」。
 *
 * ⚠⚠⚠ `record.toStorage` 是**写入**白名单（`LIGHT_FIELDS` + `OPTIONAL_FIELDS`）——
 *   它保证「上云的字段永远是固定那几个」。但从服务端**读**回来的行里还有一个
 *   **只读派生字段** `tagId`（`GET /records` 用 LEFT JOIN 带出来的，见
 *   paipan-server 的 `routes/records.ts` → `RecordOut`），它**故意不在**写入白名单里
 *   （放进去的话，整行 `PUT /records/:id` 就得带上它，漏一处就静默抹掉标签）。
 *
 *   ⇒ **读路径必须单独把它接回来。** 只走 `toStorage` 的话 tagId 被静默剥掉，
 *     现象是「这条记录明明有标签，列表卡片上没有、结果页详细信息还写『未分类』」——
 *     而**按标签筛选照样筛得出来**（那是服务端做的，跟这条路无关），
 *     于是看起来像「数据是好的、界面坏了」，最难查的一种。
 *
 * ⚠ 贴回来是安全的：写回去的路上（putRecord / push → record.toStorage）
 *   还会再剥一次，它永远进不了请求体。
 * ⚠ 「没有标签」时**连键都不给**（不是 tagId:null）—— 与 withSummary / 结果页
 *   同一个口径（`if (row.tagId)`），两边形状必须一致。
 */
function lightOf(row) {
  const out = record.toStorage(row);
  if (!out) return null;
  if (row && row.tagId) out.tagId = row.tagId;
  return out;
}

/**
 * 记录级：列出记录。
 *
 * ⚠ `filter` 是**可选的筛选参数**，会被透传到 store（本地后端支持，其余驱动忽略）。
 *   过滤**由服务端执行**（用户明确要求）—— 这里绝不自己再 filter 一遍。
 *
 * ⚠⚠ `opt` 是**可选的分页参数** `{ limit, offset }`（2026-10-11 加）。
 *   **不传 = 全量** —— 见 store/index.js 与 store/localdb.js 文件头那条红线：
 *   本文件下面几处「读全量 → 改一条 → 整份写回」的路径靠它活着，
 *   默认改成分页 ⇒ 拿一页覆盖整张表 = 静默丢数据。
 *
 * ⚠⚠⚠ `total` / `paged` **必须跟着回来**：记录页靠它们判「还有没有下一页」。
 *   这里原来是「只挑出 records 就返回」—— 那两样被静默吃掉之后，
 *   上层只能拿「这次拿到几条」蒙，**看起来一切正常**，只是永远不再续拉
 *   （或者反过来，每次都以为还有下一页而不停拉同一页）。
 *   ⚠ 但**不能无条件塞**：非分页驱动（cloudbase / cloud / gitee）压根不给这两个字段，
 *     硬塞 `total: records.length` 就等于替服务端编了一个数字。有才带，没有就不带。
 *
 * @param {Object|null} opt `{ limit, offset }`；不传 = 全量
 * @returns {Promise<{ok:boolean, records?:Array, total?:number, paged?:boolean, error?:string}>}
 */
function listRecords(uid, filter, opt) {
  if (!uidOk(uid)) {
    return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法定位云端记录' });
  }
  return store.listRecords(uid, filter, opt).then(function (res) {
    if (!res || res.ok !== true) {
      return { ok: false, error: (res && res.error) || '读取云端记录失败' };
    }
    const rows = Array.isArray(res.records) ? res.records : [];
    const out = {
      ok: true,
      records: rows.map(lightOf).filter(function (r) { return !!r; })
    };
    /* ⚠ 只在真的给了的时候带 —— 见上面那条（别替服务端编数字） */
    if (typeof res.total === 'number') out.total = res.total;
    if (res.paged === true) out.paged = true;
    return out;
  });
}

function putRecord(uid, rec) {
  if (!uidOk(uid)) {
    return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法保存' });
  }
  const slim = record.toStorage(rec);
  if (!slim) return Promise.resolve({ ok: false, error: '这条记录的出生信息不全，存不进去' });
  return store.putRecord(uid, slim);
}

function deleteRecord(uid, id) {
  if (!uidOk(uid)) return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法删除' });
  if (!id) return Promise.resolve({ ok: false, error: '没有记录 id' });
  return store.deleteRecord(uid, id);
}

function clearRecords(uid) {
  if (!uidOk(uid)) return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法清空' });
  return store.clearRecords(uid);
}

/**
 * 保存某条记录的事件记录 —— 转给驱动层的**云端函数**（记录级专有）。
 * ⚠ 文件级模型下**不要**走这里：那条路在 history.saveNotes 里用 mutateFile 处理。
 */
function saveNotes(uid, id, notes) {
  if (!uidOk(uid)) return Promise.resolve({ ok: false, error: '用户标识为空或非法，无法保存' });
  if (!id) return Promise.resolve({ ok: false, error: '没有记录 id' });
  return store.saveNotes(uid, id, notes);
}

module.exports = {
  SCHEMA: SCHEMA,
  MAX: MAX,
  uidOf: uidOf,
  uidOk: uidOk,
  // 文件级
  fileNameOf: fileNameOf,
  pathOf: pathOf,
  emptyDoc: emptyDoc,
  ensureUserFile: ensureUserFile,
  readUserFile: readUserFile,
  writeUserFile: writeUserFile,
  parseDoc: parseDoc,
  // 记录级（备用）
  listRecords: listRecords,
  putRecord: putRecord,
  deleteRecord: deleteRecord,
  clearRecords: clearRecords,
  saveNotes: saveNotes
};
