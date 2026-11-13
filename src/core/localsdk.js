/**
 * 本地后端（paipan-server）HTTP 客户端 —— 认证 + 记录
 *
 * ============ 这一层为什么和 cbsdk.js 长得像，但不是拷贝 ============
 * 两者都「封一层 fetch」，但**对端的契约不同**，照抄会错：
 *
 *   · CloudBase：`/auth/v1/signin` 回 **access_token + refresh_token** 一对，
 *     token 是平台签发的标准 JWT（sub 是 19 位 bigint，还踩过精度丢失）；
 *     注册被平台禁（501）⇒ 客户端**没有**注册。
 *   · 本地：`/auth/signin` + `/auth/signup` 回**单个 accessToken**（没有 refresh），
 *     uid 是我们自己签的 `u`+32hex；注册是我们自己提供的，**这是本文件存在的理由**。
 *
 * ⇒ 所以：**形状对齐**（永不 reject、错误码→中文、超时、可注入 fetch），
 *   但**端点、字段名、令牌形状各按各的来**。别把 cbsdk 的 readTokenResponse 硬套过来。
 *
 * ============ 两条铁律（与 cbsdk.js / store 各驱动一脉相承）============
 *   ① 所有函数**永不 reject** —— 网络失败是预期内的事，用 { ok:false, error } 表达
 *   ② 读失败**绝不**降级成「没有数据」 —— 那是丢数据的起点
 *
 * ============ ⚠⚠ 本地后端特有的三件事 ============
 *   ① **地址是局域网 IP**（192.168.x.x:4000），换 WiFi / 换电脑就会变。
 *      连不上时最可能的三个原因：不在同一 WiFi / Windows 防火墙没放行 4000 / 服务没启动。
 *      所以网络错误的文案必须**把这三条讲出来** —— 只回一句「网络失败」用户没法自救。
 *   ② **服务端也是我们自己写的**，所以错误码是**中文原文直接可用**（不需要映射表）。
 *      这与 CloudBase 那边「必须把英文黑话翻译成中文」的策略**恰好相反**。
 *   ③ **响应永远带 ok 字段**（见 paipan-server/README）。成功判据可以只看 `body.ok`，
 *      但 HTTP 状态码仍然要看（201/200/400/409/429 各有用处）。
 *
 * ============ 超时 ============
 * 本地服务在同一局域网，正常响应是毫秒级。给 10 秒足够 ——
 * 比 CloudBase 的 15 秒短一点：连不上时**快点报错**比让用户在转圈里等更有用。
 */
const CONFIG = {
  /**
   * 本地后端地址。
   * ⚠⚠ 这是**局域网地址**，手机要用它（不能用 127.0.0.1 —— 那指向手机自己）。
   *   换 WiFi 后 IP 会变，要跟着改。
   *   `npm start` 启动 paipan-server 时会直接打印出该填哪一行。
   *
   * ⚠ 真值在 `storeMode.js` 的 `LOCAL_URL`（一处配置，别两边各写一份）。
   *   这里现取而不是加载时拷贝：测试要能改一处就换地址，
   *   拷贝的话改了 storeMode 这个 CONFIG 还是老值。
   *   读不到就退回本地回环 —— 那样至少能给出「连不上」而不是「未配置」，
   *   错误信息更贴近事实（本机调试时也确实在用回环）。
   */
  get base() {
    try {
      return require('./storeMode.js').LOCAL_URL || 'http://127.0.0.1:4000';
    } catch (err) {
      return 'http://127.0.0.1:4000';
    }
  },
  /** 单请求超时（毫秒） */
  timeoutMs: 10000
};

/** 当前的 fetch 实现。测试可用 _setFetch 注入桩（与 cbsdk.js / gitee.js 同一套做法） */
let fetchImpl = (typeof fetch === 'function') ? fetch : null;

/* ------------------------------------------------------------ 小工具 */

/** 取一份当前时间（单独抽出来方便测试打桩） */
function now() {
  return Date.now();
}

/* -------------------------------------------------------- 用户名（账号） */

/**
 * 用户名规则 —— ⚠⚠ 与**服务端** `paipan-server/src/lib/identity.ts` 的 `USERNAME_RE`
 * **必须逐字相同**。
 *
 * ⚠⚠ 为什么这里又抄了一份：前端要在**用户还没提交时**就给出「太短 / 太长 / 字符不对」
 *   的实时提示，不可能为每一次击键去打服务端。
 *   代价是**两份正则可能漂移** —— 一旦漂移，表现是「前端放行、服务端 400」，
 *   用户拿到一句他永远改不对的提示（这是最难查的一类错位）。
 *   ⇒ 测试里有一条**逐字比对**两份正则的断言守着（见 tests/local-check.js）。
 *     改任何一边都会把它打红，逼你两边一起改。
 *
 * 规则：小写字母开头、全小写、只允许 `-` `_`、总长 6~25 位。
 */
const USERNAME_RE = /^[a-z][0-9a-z_-]{5,24}$/;
const USERNAME_MIN = 6;
const USERNAME_MAX = 25;

/**
 * 服务端要求的最短密码长度（`paipan-server/src/routes/auth.ts` 的 `PASSWORD_MIN`）。
 * ⚠ 同样要与服务端保持一致 —— 不一样的话用户会在「明明够长」的情况下被拒。
 */
const PASSWORD_MIN = 6;

/**
 * 密码输入框的防呆上限。
 * ⚠ 与服务端的 PASSWORD_MAX 同量级即可。这里不是安全边界（服务端才是），
 *   只是拦住「误粘贴一整篇文章」，顺便让请求体不至于离谱。
 */
const PASSWORD_MAX = 64;

/**
 * 清洗用户名输入：去首尾空格 + 转小写。
 * ⚠ 转小写是**故意**的：服务端规则只认小写（`normalizeUsername` 也这么做），
 *   用户把账号记成大写输入时，与其让他撞一次「用户名或密码不对」，
 *   不如直接归一化 —— 账号本来就是它。
 */
function normalizeUsername(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/** 用户名是否合法（界面上按钮的可用态靠它） */
function usernameOk(raw) {
  return USERNAME_RE.test(normalizeUsername(raw));
}

/**
 * ⚠⚠ 这里**没有** normalizePassword。
 *   密码是逐字有效的 —— 顺手 `.trim()` 会把「密码结尾真有个空格」变成永远登不上，
 *   而且服务端报的是「用户名或密码不对」，谁都查不出来。
 *   密码只限长，别的一律不碰（见 screens/login/model.js 的 passwordInput）。
 */

/* ------------------------------------------------------------ 错误文案 */

/**
 * 把一次失败收敛成给用户看的中文。
 *
 * ⚠⚠ 与 cbsdk.errText 的策略**刻意相反**，别照着抄：
 *   那边对端是 CloudBase，服务端动不动回英文黑话（"malformed jwt..."），
 *   所以必须有一张**码→中文映射表**兜底，且**绝不**把原文甩给用户。
 *   这边对端是**我们自己写的** paipan-server，它回的中文本来就是给人看的
 *   （「这个用户名已经有人用了，换一个吧」）⇒ **直接用它的原话**，
 *   再套一层映射表反而是多此一举、还会把好文案盖掉。
 *
 * 只有一种情况要自己造文案：**根本没连上**（网络层失败，服务端没说话）。
 */
function errText(body, status, fallback) {
  const msg = body && typeof body.error === 'string' ? body.error : '';
  if (msg) return msg;
  if (fallback) return fallback;
  return '请求失败（HTTP ' + status + '），请稍后重试';
}

/**
 * 网络层失败的文案 —— ⚠⚠ 必须把**三个自查步骤**讲出来。
 *
 * 本地后端的地址是局域网 IP，连不上是最常见的事，而且原因就那么三个。
 * 只回一句「网络请求失败」，用户除了重试什么也做不了；
 * 把「同一 WiFi / 防火墙 / 服务是否启动」写出来，他大概率能自己解决。
 */
function networkHint(aborted) {
  if (aborted) return '请求超时了。请确认手机和电脑在同一个 WiFi，且后端服务还在运行。';
  return '连不上服务器。请检查：①手机和电脑是否在同一个 WiFi；②电脑的防火墙是否放行了 4000 端口；③电脑上后端服务是否已启动。';
}

/* ------------------------------------------------------------ 底层请求 */

/**
 * 把查询参数对象拼成 `?a=1&b=x`。**必须 encodeURIComponent** ——
 * 干支是中文（`?dayGan=甲`），不编码的话有的运行时会直接抛 URIError，
 * 有的会静默丢掉参数（那样筛选就「明明发了却没生效」，最难查）。
 *
 * ⚠ 空值（undefined / null / 空串）**直接丢掉**：它们与服务端的「不传 = 不过滤」同义，
 *   发出去只会让 URL 更长。⚠ 但**不要**把 `[]`（空数组）当成「传了空」——
 *   也当没传，见下。
 *
 * @param {Object|undefined} query
 * @returns {string} 以 '?' 开头，或空串
 */
function buildQuery(query) {
  if (!query) return '';
  const parts = [];
  Object.keys(query).forEach(function (k) {
    const v = query[k];
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      // 数组：展开成重复参数（`?dayGan=甲&dayGan=乙`）。空数组什么都不发。
      v.forEach(function (item) {
        if (item === undefined || item === null || item === '') return;
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(item)));
      });
      return;
    }
    if (v === '') return;                 // 空串 = 不过滤，别发
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * 发一个请求。**永不 reject**。
 *
 * @param {string} path 以 / 开头的路径
 * @param {Object} [o]
 * @param {string} [o.method] 默认 GET
 * @param {Object} [o.body]   JSON 请求体
 * @param {string} [o.token]  Authorization: Bearer <token>
 * @param {Object} [o.query]  查询参数（值可为 string / number / 数组；空串与 null 会被丢掉）
 * @param {number} [o.timeoutMs] 本次请求的超时（毫秒），缺省用 CONFIG.timeoutMs
 *   ⚠⚠ 只有**长轮询**这类「服务端故意挂住」的接口需要传它 ——
 *     心跳最长要等 25 秒，吃默认的 10 秒会让每次正常等待都在客户端先超时
 *     （症状是「心跳永远失败」，而服务端一切正常）。见 core/presence.js 文件头。
 * @returns {Promise<{ok:boolean, status:number, data?:*, code?:string, error?:string}>}
 */
function request(path, o) {
  const opts = o || {};
  const url = CONFIG.base + path + buildQuery(opts.query);
  /* ⚠ 现取而不是写死：默认值仍在 CONFIG 上（一处配置），调用方可以按次覆盖 */
  const limitMs = opts.timeoutMs || CONFIG.timeoutMs || 10000;

  if (!fetchImpl) {
    return Promise.resolve({
      ok: false, status: 0, code: 'NO_FETCH',
      error: '当前运行环境没有 fetch，无法访问服务器'
    });
  }
  if (!CONFIG.base) {
    // 见 storeMode.js 的同款态度：**不静默降级**。否则你会以为数据存上了，其实哪儿都没写。
    return Promise.resolve({
      ok: false, status: 0, code: 'NO_CONFIG',
      error: '本地后端未配置：请填写 core/localsdk.js 的 CONFIG.base'
    });
  }

  const headers = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;

  // 超时：fetch 自身没有 timeout，用 AbortController。RN 0.86 / Node 18+ 都有。
  let timer = null;
  let ctrl = null;
  const ac = (typeof AbortController === 'function') ? AbortController : null;
  if (ac) {
    ctrl = new ac();
    timer = setTimeout(function () {
      try { ctrl.abort(); } catch (err) { /* 已经结束了，忽略 */ }
    }, limitMs);
  }

  const init = { method: (opts.method || 'GET').toUpperCase(), headers: headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (ctrl) init.signal = ctrl.signal;

  return Promise.resolve()
    .then(function () { return fetchImpl(url, init); })
    .then(function (res) {
      if (timer) { clearTimeout(timer); timer = null; }
      const status = (res && res.status) || 0;
      return Promise.resolve()
        .then(function () { return res.text(); })
        .then(function (text) {
          let body = null;
          if (text) {
            try { body = JSON.parse(text); } catch (err) { body = null; }
          }
          // ⚠ 成功判据：状态码 2xx **且** body.ok === true。
          //   服务端承诺「响应永远带 ok 字段」，两个都验是为了——
          //   万一中间夹了个代理回了 200 + 一段 HTML，body 会是 null，
          //   这时若只看 status 就会把「一坨非 JSON」当成成功。
          if (status >= 200 && status < 300 && body && body.ok === true) {
            return { ok: true, status: status, data: body };
          }
          return {
            ok: false, status: status,
            code: (body && body.code) || ('HTTP_' + status),
            data: body,
            error: errText(body, status, null)
          };
        });
    })
    .catch(function (err) {
      if (timer) { clearTimeout(timer); timer = null; }
      const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
      return {
        ok: false, status: 0, code: aborted ? 'TIMEOUT' : 'NETWORK',
        error: networkHint(aborted)
      };
    });
}

/* ------------------------------------------------------- 从 JWT 里解 uid */

const B64_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 → 字节数组。
 * ⚠ 目标环境（React Native / Hermes）**不保证**有 atob，所以自己解。
 *   这里**刻意不复用** cbsdk.js 那份：两者是**并列的驱动**，不该互相依赖
 *   （store / auth 是按 mode 选一个，谁都不该 require 另一个）。
 */
function b64ToBytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i += 4) {
    const n0 = B64_ABC.indexOf(s[i]);
    const n1 = B64_ABC.indexOf(s[i + 1]);
    if (n0 < 0 || n1 < 0) break;
    const c2 = s[i + 2];
    const c3 = s[i + 3];
    const n2 = c2 === '=' || c2 === undefined ? -1 : B64_ABC.indexOf(c2);
    const n3 = c3 === '=' || c3 === undefined ? -1 : B64_ABC.indexOf(c3);
    bytes.push(((n0 << 2) | (n1 >> 4)) & 0xff);
    if (n2 >= 0) bytes.push(((n1 << 4) | (n2 >> 2)) & 0xff);
    if (n3 >= 0) bytes.push(((n2 << 6) | n3) & 0xff);
  }
  return bytes;
}

/** UTF-8 字节 → 字符串 */
function utf8FromBytes(bytes) {
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

/**
 * 从 accessToken（JWT）的 payload 里取 `uid`。
 *
 * ⚠⚠ 为什么**不**直接用响应体的 `uid`（虽然本地服务端也返回了它）：
 *   两条理由——
 *   ① **一致性**：auth / session / userStore 那条链上，uid 的权威来源是「令牌里那个」。
 *      CloudBase 那边被逼这么做（bigint 19 位超 MAX_SAFE_INTEGER，JSON.parse 静默吃低位
 *      ⇒ 「登录成功却读不到记录」）。本地这边虽然没这个风险（uid 是字符串 `u`+hex），
 *      但**保持同一条口径**能少一类「两个来源不一致」的怪问题。
 *   ② **防篡改传递**：将来若在中间加了转发/缓存层，改响应体比改签过名的令牌容易得多。
 *
 * ⚠ 取 uid 用**正则直接抠**，不走 JSON.parse —— 与 cbsdk.subFromJwt 同款态度。
 */
function uidFromJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return '';
    // JWT 用 base64url：-_ 代替 +/，且可能省略尾部 padding
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = utf8FromBytes(b64ToBytes(b64));
    const m = /"uid"\s*:\s*"?([A-Za-z0-9_\-.:|]+)"?/.exec(json);
    return m ? m[1] : '';
  } catch (err) {
    return '';
  }
}

/**
 * 把 signin / signup 的响应收敛成同一种形状。
 *
 * ⚠⚠ 与 cbsdk.readTokenResponse 的**关键差异**：本地后端**没有 refresh_token**。
 *   那边的令牌是「一对」（accessToken + refreshToken，用来撑 31 天自动续期）；
 *   这边只有单个 token，30 天有效，**到期就是要重新登录**。
 *   ⇒ 这里**刻意不造一个假的 refreshToken 字段**（比如回 ''），
 *     因为下游（session.js）一旦看到 refreshToken 就以为「可以自动续期」，
 *     会去调一个本地没有的 refresh 接口 —— 那才是最坏的情况：
 *     用户在用到第 30 天时被弹去重新登录，而报错说「续期失败，请检查网络」。
 *     ⇒ 明确地不给这个字段，让 session 层的 HAS_REFRESH 判断为 false。
 */
function readAuthResponse(r) {
  if (!r.ok) return r;
  const d = r.data || {};
  if (!d.token) {
    return { ok: false, status: r.status, code: 'NO_TOKEN', error: '服务端没有返回登录令牌，请重试' };
  }
  return {
    ok: true,
    status: r.status,
    token: {
      accessToken: d.token,
      // ⚠ 先解 JWT（权威），响应体的 uid 只作兜底
      uid: uidFromJwt(d.token) || (d.uid === undefined || d.uid === null ? '' : String(d.uid)),
      username: d.username || '',
      /** 秒。服务端给的，别自己编一个默认值 —— 那是两端不一致的起点 */
      expireIn: d.expireIn || 0
    }
  };
}

/* ------------------------------------------------------------ 登录 / 注册 */

/**
 * 用「用户名 + 密码」登录。
 *
 * ⚠⚠ 登录失败的文案**故意很含糊**（服务端就是这么回的：「用户名或密码不对」）。
 *   那是**刻意的反账号枚举**：分开报「这个账号不存在」和「密码错了」，
 *   等于免费送一个「这个账号存不存在」的查询接口。
 *   别在这里「好心」把文案改得更具体。
 *
 * @param {string} username 大小写不敏感（归一化成小写）
 * @param {string} password
 * @returns {Promise<{ok:boolean, token?:Object, error?:string}>} 永不 reject
 */
function signInWithPassword(username, password) {
  const u = normalizeUsername(username);
  if (!u) {
    return Promise.resolve({ ok: false, code: 'EMPTY_USERNAME', error: '请输入账号' });
  }
  if (!password) {
    return Promise.resolve({ ok: false, code: 'EMPTY_PASSWORD', error: '请输入密码' });
  }
  return request('/auth/signin', {
    method: 'POST',
    // ⚠ 密码只在这里出现一次，**绝不**写进日志、错误文案或任何持久化字段
    body: { username: u, password: String(password) }
  }).then(readAuthResponse);
}

/**
 * 用「用户名 + 密码」**注册** —— 这是本地后端相对 CloudBase 多出来的能力。
 *
 * ============ ⚠⚠ 与登录的报错口径**刻意相反**，别互相抄 ============
 *   · 登录：三种失败回**同一句**（防账号枚举，见上）
 *   · 注册：必须**说清楚**（用户名被占 / 格式不对 / 密码太短）
 *     理由：注册场景下用户**必须**知道哪里不对才能改，含糊其辞只会让人卡住。
 *     代价是「某用户名是否已存在」变得可探测 —— 这是注册功能的**固有代价**，
 *     任何网站的注册页都如此。真正该防的是**批量探测**，所以服务端做了限流。
 *   ⇒ 所以这里**原样透传**服务端的错误文案（它是具体的中文），不要套映射表压扁。
 *
 * ⚠⚠ 服务端有**限流**：同一 IP 每小时最多成功注册 10 个账号。
 *   注意口径是「注册**成功**才计数」—— 失败的尝试不消耗额度，
 *   所以用户输错几次用户名不会被锁。但**真的连注册 10 个之后**会回 429，
 *   那时要给一句能看懂的话（服务端已经给了中文，透传即可）。
 *
 * @returns {Promise<{ok:boolean, token?:Object, error?:string}>} 永不 reject
 */
function signUpWithPassword(username, password) {
  const u = normalizeUsername(username);
  if (!u) {
    return Promise.resolve({ ok: false, code: 'EMPTY_USERNAME', error: '请输入账号' });
  }
  if (!password) {
    return Promise.resolve({ ok: false, code: 'EMPTY_PASSWORD', error: '请输入密码' });
  }
  return request('/auth/signup', {
    method: 'POST',
    body: { username: u, password: String(password) }
  }).then(readAuthResponse);
}

/**
 * 用当前令牌确认「我还是谁」。
 * ⚠ 本地后端**没有 refresh 接口**（令牌 30 天，到期重新登录），
 *   所以这个函数的用途只有一个：**核对令牌此刻是否还有效**
 *   （是否被删号、是否已过期）。它不能续期 —— 这是与 CloudBase 最大的行为差异。
 */
function whoami(token) {
  if (!token) {
    return Promise.resolve({ ok: false, code: 'NO_TOKEN', error: '还没有登录' });
  }
  return request('/auth/whoami', { token: token }).then(function (r) {
    if (!r.ok) return r;
    const d = r.data || {};
    return { ok: true, uid: d.uid || '', username: d.username || '' };
  });
}

/* ------------------------------------------------------------ 测试用钩子 */

function _setFetch(fn) { fetchImpl = fn; }
function _getConfig() { return CONFIG; }

module.exports = {
  CONFIG: CONFIG,
  /* 用户名 / 密码规则（**必须与服务端一致**，测试里有逐字比对的断言） */
  USERNAME_RE: USERNAME_RE,
  USERNAME_MIN: USERNAME_MIN,
  USERNAME_MAX: USERNAME_MAX,
  PASSWORD_MIN: PASSWORD_MIN,
  PASSWORD_MAX: PASSWORD_MAX,
  normalizeUsername: normalizeUsername,
  usernameOk: usernameOk,
  /* 认证 */
  signInWithPassword: signInWithPassword,
  signUpWithPassword: signUpWithPassword,
  whoami: whoami,
  /* 底层（记录驱动要用） */
  request: request,
  buildQuery: buildQuery,
  errText: errText,
  networkHint: networkHint,
  configured: function () { return !!CONFIG.base; },
  // ⚠ uidFromJwt 单独导出给测试（纯函数，能直接喂各种歪形状的 JWT）
  uidFromJwt: uidFromJwt,
  _setFetch: _setFetch,
  _getConfig: _getConfig,
  _now: now
};
