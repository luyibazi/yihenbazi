/**
 * Gitee 仓库读写 —— HTTP 层 + base64 编解码 + 路径白名单
 *
 * ⚠⚠⚠ 安全警告：token 是**硬编码在前端的**
 *   本项目没有自建后端，为了让「换设备还能看到数据」成立，只能让前端直连仓库。
 *   代价：token 被打进代码包，反编译 / F12 就能拿到，拿到就能读写整个私有仓库
 *   （包含全部用户数据）。缓解措施：
 *     ① 这个 token **只**对应一个私有仓库、只勾最小权限
 *     ② 代码里集中成一处常量（CONFIG），泄露后换新只改一行
 *     ③ 真正的解法是挪到服务端 —— 等哪天接了后端，把 request() 换掉即可，上层无感
 *
 * ============ Gitee contents 接口的四个坑（实测，别照 GitHub 经验猜）============
 *   | 动作 | 请求 | 结果 |
 *   |---|---|---|
 *   | 读**存在**的文件 | GET /repos/{o}/{r}/contents/{path} | 200，{ content: '<base64>', sha } |
 *   | 读**不存在**的文件 | 同上 | **200，响应体是 `[]`** |
 *   | 创建 | POST 同路径，**不带 sha** | 文件已存在 → 400「文件名已存在」 |
 *   | 更新 | PUT 同路径，**必须带 sha** | 缺 sha → 400「sha is missing」 |
 *
 *   推论：① 判存在性不能只看状态码（不存在的也是 200）→ 必须再判 Array.isArray
 *         ② **不是 upsert**（GitHub 的 PUT 能建能改，Gitee 不能）→ 只能 GET 探 → POST/PUT
 *         ③ content 字段类型不一致：GET 是 base64 **字符串**，POST/PUT 是**元信息对象**
 *         ④ 两台设备同时首次登录 → 后到的 POST 收 400 → **这不是错误**，回退成「已存在」
 *
 * ============ base64 为什么不直接用 atob / btoa ============
 * 目标环境（React Native / Hermes）**不保证**有 atob/btoa。
 * 而且即便有，**直接对 charCode 做 base64 会让中文编错**（云端存进去就是乱码）。
 * 所以这里自己写一套 **UTF-8 感知**的编解码：字符串 ↔ UTF-8 字节 ↔ base64。
 */

/* ------------------------------------------------------------------ 配置 */

/**
 * ⚠ 换仓库 / 换 token 只改这里。
 * 与 mingliWEB/modules/storage.js 同一套凭据（同一个仓库、同一份数据），
 * 所以两边的数据是互通的 —— 这也是「恢复 Gitee 版本」的意义所在。
 */
const CONFIG = {
  OWNER: 'a-treasure-trove-of-wisdom',
  REPO: 'bazi-data',
  BRANCH: 'master',
  TOKEN: 'f66594ca2bba32caad9d255b278dcabd',
  base: 'https://gitee.com/api/v5'
};

/** 记录都存在这个目录下，一个用户一个 json 文件 */
const DIR = 'userData';

/* ------------------------------------------------------- base64（UTF-8 感知） */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符串 → UTF-8 字节数组 */
function toUtf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    // 代理对（emoji 这类）要合起来算成 4 字节，否则编出来是错的
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return bytes;
}

/** UTF-8 字节数组 → 字符串 */
function fromUtf8Bytes(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

/** 字节数组 → base64 字符串 */
function bytesToB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
    out += b1 < 0 ? '=' : B64_CHARS[((b1 & 0x0f) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
    out += b2 < 0 ? '=' : B64_CHARS[b2 & 0x3f];
  }
  return out;
}

/** base64 字符串 → 字节数组 */
function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[\r\n\s]/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = B64_CHARS.indexOf(clean[i]);
    const n1 = B64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2];
    const c3 = clean[i + 3];
    const n2 = c2 === '=' || c2 === undefined ? -1 : B64_CHARS.indexOf(c2);
    const n3 = c3 === '=' || c3 === undefined ? -1 : B64_CHARS.indexOf(c3);
    if (n0 < 0 || n1 < 0) continue;
    bytes.push(((n0 << 2) | (n1 >> 4)) & 0xff);
    if (n2 >= 0) bytes.push(((n1 << 4) | (n2 >> 2)) & 0xff);
    if (n3 >= 0) bytes.push(((n2 << 6) | n3) & 0xff);
  }
  return bytes;
}

/** 字符串 → base64（UTF-8 感知） */
function b64encode(str) {
  return bytesToB64(toUtf8Bytes(String(str)));
}

/** base64 → 字符串（UTF-8 感知） */
function b64decode(b64) {
  return fromUtf8Bytes(b64ToBytes(b64));
}

/* ------------------------------------------------------------------ 路径 */

/**
 * uid → 文件名。**白名单**过滤，不是黑名单 —— 黑名单永远漏。
 * ⚠ uid 来自登录凭证，直接拼进路径就能路径穿越（`../../foo`）。
 * ⚠ 空值**绝不能**出路径（否则会写到 userData/.json，所有空 uid 用户共用一个文件）。
 */
function safeUid(uid) {
  return String(uid == null ? '' : uid).replace(/[^A-Za-z0-9_-]/g, '');
}

/** uid → 仓库里的完整路径；uid 非法时返回 '' */
function pathOf(uid) {
  const safe = safeUid(uid);
  return safe ? DIR + '/' + safe + '.json' : '';
}

/* ------------------------------------------------------------- HTTP 通道 */

/**
 * ⚠ 唯一与平台相关的一处。小程序里是 tt.request，RN / 浏览器里是 fetch。
 *   做成可替换的（_setHttp）是为了让测试能停在**传输边界**注入桩，
 *   而不是去重实现业务语义 —— 桩只负责「按 Gitee 的真实怪癖回响应」。
 */
let httpImpl = null;

function defaultHttp(opts) {
  const init = { method: opts.method || 'GET', headers: opts.header || {} };
  if (opts.data && opts.method && opts.method !== 'GET') {
    init.body = JSON.stringify(opts.data);
  }
  return fetch(opts.url, init).then(function (res) {
    return res.text().then(function (t) {
      let data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
      // ⚠ 非 2xx 也走 success（与小程序 tt.request 行为一致），由调用方判 statusCode
      return { statusCode: res.status, data: data };
    });
  });
}

/** 测试接缝：注入桩（只停在 SDK / fetch 边界） */
function _setHttp(impl) {
  httpImpl = impl;
}

function request(opts) {
  const impl = httpImpl || defaultHttp;
  return Promise.resolve()
    .then(function () { return impl(opts); })
    .catch(function (err) {
      // 网络层失败统一成 statusCode 0 —— 与小程序 fail 分支一致
      return { statusCode: 0, data: null, error: String((err && err.message) || err) };
    });
}

/* ------------------------------------------------------- contents 接口 */

/** 读文件 → 三态（**绝不能**把「读失败」退化成「不存在」） */
function readRaw(uid) {
  const p = pathOf(uid);
  if (!p) {
    return Promise.resolve({ failed: true, status: 0, error: '用户标识为空或非法，无法定位云端文件' });
  }
  const url = CONFIG.base + '/repos/' + CONFIG.OWNER + '/' + CONFIG.REPO +
    '/contents/' + p + '?access_token=' + encodeURIComponent(CONFIG.TOKEN) +
    '&ref=' + CONFIG.BRANCH;

  return request({ url: url, method: 'GET' }).then(function (res) {
    const st = res.statusCode;
    if (st === 200) {
      const body = res.data;
      // ⚠ 坑①：不存在的文件也是 200，响应体是 `[]` —— 判存在性必须看形状
      if (Array.isArray(body)) return { exists: false };
      if (body && typeof body === 'object' && body.content) {
        // ⚠ 坑③：GET 的 content 是 base64 字符串（也可能是被包了一层）
        const raw = typeof body.content === 'object' ? body.content.sha : body.content;
        const sha = (body.content && typeof body.content === 'object') ? body.content.sha : body.sha;
        return { exists: true, sha: sha, text: b64decode(raw) };
      }
      // 形状不对（例如返回了目录列表对象的变体）→ 当不存在处理，但不标 failed
      return { exists: false };
    }
    if (st === 404) return { exists: false };   // 目录不存在
    return { failed: true, status: st, error: '读取失败 HTTP ' + st };
  });
}

/** 创建（POST，**不带 sha**） */
function createFile(uid, text) {
  const p = pathOf(uid);
  if (!p) return Promise.resolve({ ok: false, status: 0, error: 'uid 非法' });
  const url = CONFIG.base + '/repos/' + CONFIG.OWNER + '/' + CONFIG.REPO + '/contents/' + p;
  return request({
    url: url,
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    data: {
      access_token: CONFIG.TOKEN,
      message: 'create ' + p,
      content: b64encode(text),
      branch: CONFIG.BRANCH
    }
  }).then(function (res) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = res.data || {};
      const sha = (body.content && body.content.sha) || body.sha;
      return { ok: true, sha: sha };
    }
    return { ok: false, status: res.statusCode, error: '创建失败 HTTP ' + res.statusCode };
  });
}

/** 更新（PUT，**必须带 sha**） */
function updateFile(uid, sha, text) {
  const p = pathOf(uid);
  if (!p) return Promise.resolve({ ok: false, status: 0, error: 'uid 非法' });
  if (!sha) return Promise.resolve({ ok: false, status: 0, error: '缺少 sha（Gitee 的 PUT 必须带 sha）' });
  const url = CONFIG.base + '/repos/' + CONFIG.OWNER + '/' + CONFIG.REPO + '/contents/' + p;
  return request({
    url: url,
    method: 'PUT',
    header: { 'Content-Type': 'application/json' },
    data: {
      access_token: CONFIG.TOKEN,
      message: 'update ' + p,
      content: b64encode(text),
      sha: sha,
      branch: CONFIG.BRANCH
    }
  }).then(function (res) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = res.data || {};
      const next = (body.content && body.content.sha) || body.sha;
      return { ok: true, sha: next };
    }
    return { ok: false, status: res.statusCode, error: '更新失败 HTTP ' + res.statusCode };
  });
}

/**
 * 幂等写：读探存在 → 有则 PUT(带 sha)，无则 POST。
 * ⚠ 坑②：Gitee **不是 upsert**，不能直接 PUT 一个新路径。
 * ⚠ 坑④：POST 撞 400「文件名已存在」= 并发竞态（另一台设备刚建好），
 *         **不是错误** → 回退成「已存在」再读一次拿 sha，重试 PUT。
 */
function upsertFile(uid, text) {
  return readRaw(uid).then(function (found) {
    // ⚠ 读失败**不能**降级成「那就新建一个吧」—— 会把已有文件覆盖/撞 400
    if (found.failed) return { ok: false, status: found.status || 0, error: found.error };
    if (found.exists) return updateFile(uid, found.sha, text);

    return createFile(uid, text).then(function (created) {
      if (created.ok) return created;
      if (created.status === 400) {
        // 撞车：别人刚建好 → 回读拿 sha 再改
        return readRaw(uid).then(function (again) {
          if (again.exists) {
            return updateFile(uid, again.sha, text).then(function (w) {
              if (w.ok) w.raced = true;
              return w;
            });
          }
          return { ok: false, status: 400, error: '创建失败且回读不到（可能 uid 非法）' };
        });
      }
      return created;
    });
  });
}

module.exports = {
  CONFIG: CONFIG,
  DIR: DIR,
  // base64
  b64encode: b64encode,
  b64decode: b64decode,
  toUtf8Bytes: toUtf8Bytes,
  fromUtf8Bytes: fromUtf8Bytes,
  // 路径
  safeUid: safeUid,
  pathOf: pathOf,
  // 接口
  readRaw: readRaw,
  createFile: createFile,
  updateFile: updateFile,
  upsertFile: upsertFile,
  // 测试接缝
  _setHttp: _setHttp
};
