/**
 * CloudBase HTTP 客户端 —— 认证（用户名密码 / 短信 / 匿名）+ 数据面（PostgREST）
 *
 * ============ 这一层为什么存在 ============
 * App 是原生环境（React Native）。CloudBase 的官方 JS SDK（@cloudbase/js-sdk）
 * 假设了浏览器/小程序环境，在 RN 上是否可用没有保证 —— 而 CloudBase 的每一项能力
 * **都有 HTTP 接口**，官方能力路由表里「原生 App / Flutter / React Native」这一档
 * 指向的就是 HTTP API（不是 Web SDK）。
 * ⇒ 所以这里自己封一层 fetch，**不引入任何 SDK 依赖**，App 侧只多一个纯 JS 文件。
 *
 * ============ 两条铁律（与 store/cloud.js 一脉相承）============
 *   ① 所有函数**永不 reject** —— 网络失败是预期内的事，用 { ok:false, error } 表达
 *   ② 读失败**绝不**降级成「没有数据」 —— 那是丢数据的起点
 *      （数据面那条在 store/cbdb.js 落实；本文件只负责如实把错误带上去）
 *
 * ============ 端点从哪来（⚠ 不许凭印象写）============
 * 全部取自官方 OpenAPI 定义（searchKnowledgeBase mode=openapi apiName=auth / pgdb）：
 *   POST /auth/v1/signin                登录（⭐ 当前主路径：{ username, password }）
 *   POST /auth/v1/signin/anonymously    匿名登录（备选，需平台开启 anonymous）
 *   POST /auth/v1/verification          发验证码（短信/邮箱）
 *   POST /auth/v1/verification/verify   校验验证码 → verification_token
 *   POST /auth/v1/signup                注册（⚠ 只给 {username,password} 会被平台 501 拒）
 *   POST /auth/v1/token                 刷新令牌
 *   GET|POST|PATCH|DELETE /v1/rdb/rest/{table}   数据面（PostgREST）
 *
 * ============ 当前走哪条路（2026-10-02 用户拍板）============
 * ⭐ **用户名 + 密码**（signInWithPassword）。账号由管理员在管控面创建（`tcb/CreateUser`），
 *   客户端**不提供注册** —— 平台禁止纯用户名密码自助注册（实测 501 UNIMPLEMENTED）。
 * 短信与匿名驱动**都保留**：短信是探针验「认证端点还活着」的手段，
 *   且平台若放开自助注册可直接启用；匿名是设备级身份（换设备丢记录，但零门槛）。
 *   ⚠ 两者当前都不是 UI 入口，**不调用就不产生任何费用** —— 别误以为「留着 = 在烧钱」。
 *
 * ⚠ 这些认证端点在 OpenAPI 里都标了 `security: []` —— **不需要** Authorization 头。
 *   登录前本来也没有 token，硬塞一个反而是画蛇添足。
 *
 * ============ ⚠⚠ 实测踩到的三个格式坑（都已固化在代码里）============
 *   ① 手机号**必须**带 "+86 " 前缀，且**中间有一个空格**（"+86 13800138000"）。
 *      只给 "13800138000" 会被判 invalid_phone_number。normalizePhone 负责补齐。
 *   ② 发码响应的 `is_user` 决定后面走 signin 还是 signup —— 新用户直接 signin 会失败。
 *   ③ 刷新令牌时**原 refresh_token 立即失效**（官方："原refresh_token使用后立即失效"）。
 *      ⇒ 刷新成功后必须把新的一对都存下来，只存 access_token 会让用户 30 天后彻底登不上。
 */
const CONFIG = {
  /** 环境 ID（也是默认 client_id） */
  envId: 'luyi-d6gyted3jca56a566',
  /** 接口域名 —— 国内地域格式：https://{envId}.api.tcloudbasegateway.com */
  base: 'https://luyi-d6gyted3jca56a566.api.tcloudbasegateway.com',
  /**
   * Publishable Key（role: anon）。
   * ⚠ 它可以**安全地嵌在前端**（官方原话："Can be exposed in browsers"），
   *   因为它只代表匿名身份，配上 RLS 后看不到任何人的数据。
   *   ❌ 绝不能把它换成 API Key（role: service_role）—— 那个有 BYPASSRLS，等于全库裸奔。
   */
  publishableKey: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjMwZDExMzJjLWYwNmUtNDgxZS1iNzIxLTAwOWI3MGM0ZmY5NCJ9.eyJpc3MiOiJodHRwczovL2x1eWktZDZneXRlZDNqY2E1NmE1NjYuYXAtc2hhbmdoYWkudGNiLWFwaS50ZW5jZW50Y2xvdWRhcGkuY29tIiwic3ViIjoiYW5vbiIsImF1ZCI6Imx1eWktZDZneXRlZDNqY2E1NmE1NjYiLCJleHAiOjQwOTQ2MTUwNzcsImlhdCI6MTc5MDkzMTg3Nywibm9uY2UiOiJPVldTeVVtYVFYSzlKeUJtVEttV3lBIiwiYXRfaGFzaCI6Ik9WV1N5VW1hUVhLOUp5Qm1US21XeUEiLCJuYW1lIjoiQW5vbnltb3VzIiwic2NvcGUiOiJhbm9ueW1vdXMiLCJwcm9qZWN0X2lkIjoibHV5aS1kNmd5dGVkM2pjYTU2YTU2NiIsIm1ldGEiOnsicGxhdGZvcm0iOiJQdWJsaXNoYWJsZUtleSJ9LCJyb2xlIjoiYW5vbiIsImlzX2Fub255bW91cyI6dHJ1ZSwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiYW5vbnltb3VzIiwicHJvdmlkZXJzIjpbImFub255bW91cyJdfSwidXNlcl9tZXRhZGF0YSI6eyJuYW1lIjoiQW5vbnltb3VzIn0sInVzZXJfdHlwZSI6IiIsImNsaWVudF90eXBlIjoiY2xpZW50X3VzZXIiLCJpc19zeXN0ZW1fYWRtaW4iOmZhbHNlfQ.qsWyidiEMsRG4UdcR784p4Kg6OJCPFUHuJ51ClIid75UTtn4i6Sa-mjjcWrtyLEKbDJReKuJSt2x44V4fCmYoxPu7MpS5EG0nS__nlvsIA1SKfzA3nO8XsHabQjEb6F4c9ZlpzBIoMGFVyL4DZt3-qYOfvRE-kxAGIRFRo7qghXgb672P-lCL3T2Mt8-bZXdbfJ5i3vp7qxhOr6VqwfVRQyfBTVx1dG_sf41eazsrYzyPh5Fg92SxLB_5TuxUc2MXMOEJ5_Hx8swEbihtx8rH3wE0_ZOBQT8jWDjlwCVEFIlRcpKnOJ2kbfhcdZfQlcrmBZyxLPRsjoCsWITQ4q9Lg',
  /** 单请求超时（毫秒）。短信/登录都在用户面前发生，不能让界面无限等 */
  timeoutMs: 15000
};

/** 当前的 fetch 实现。测试可用 _setFetch 注入桩（与 gitee.js 的 _setHttp 同一套做法） */
let fetchImpl = (typeof fetch === 'function') ? fetch : null;

/* ------------------------------------------------------------ 小工具 */

/**
 * 手机号规范化：用户随手输的 "13800138000" → CloudBase 要的 "+86 13800138000"。
 *
 * ⚠ 那个空格不能省 —— 官方示例与字段说明都写作 `"+86 15588665555"`。
 *   有些实现接受无空格，但这个环境实测按文档来最稳。
 *   已经带了 +86 的输入要能识别（避免拼成 "+86 +86 138..."）。
 */
function normalizePhone(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s-]/g, '');
  if (!s) return '';
  const m = /^(?:\+?86)?(1[3-9]\d{9})$/.exec(s);
  if (!m) return '';
  return '+86 ' + m[1];
}

/** 手机号是否符合大陆号段（用于界面上「发送」按钮的可用态） */
function phoneOk(raw) {
  return !!normalizePhone(raw);
}

/** 打日志 / 显示用的掩码，别把完整手机号写进日志 */
function maskPhone(raw) {
  const n = normalizePhone(raw);
  if (!n) return '';
  const d = n.slice(4);              // 去掉 "+86 "
  return n.slice(0, 4) + d.slice(0, 3) + '****' + d.slice(7);
}

/* -------------------------------------------------------- 用户名（账号） */

/**
 * 用户名规则 —— ⚠⚠ **实测**得到的，跟文档写的完全不是一回事。
 *
 * 文档原话：「长度 2-48 位，支持英文**大小写**、数字、特殊字符（仅支持 `-_.:+ @`），
 *            且只能以字母或数字开头，不支持中文」
 *
 * 实测（2026-10-02 打真接口，服务端自己把正则吐了出来）：
 *     invalid SignUpRequest.Username:
 *       value does not match regex pattern "^$|^[a-z][0-9a-z_-]{5,24}$"
 * ⇒ 真实规则 = **小写字母开头、全小写、只允许 `-` `_`、总长 6~25 位**。
 *   文档说的「支持大小写 / 允许 `.:+ @` / 2-48 位」**全都不成立**。
 *
 * ⚠ 别照着文档把宽松规则写进校验 —— 那样前端放行、服务端 400，
 *   用户看到的是一句他永远改不对的提示。
 * ⚠ `^$` 那一支表示**允许为空**（因为账号也可以用手机号/邮箱注册），
 *   这里不采用它：本页的用户名是必填的。
 */
const USERNAME_RE = /^[a-z][0-9a-z_-]{5,24}$/;

/** 用户名总长（首字符 + 后续 5~24） */
const USERNAME_MIN = 6;
const USERNAME_MAX = 25;

/**
 * 清洗用户名输入。
 * ⚠ 统一**转小写 + 去首尾空格**：规则本身只认小写，用户手输大写时
 *   与其让他撞一次「用户名或密码不对」，不如直接归一化 ——
 *   账号本来就是它，只是他记成了大写。
 */
function normalizeUsername(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/** 用户名是否合法（界面上「登录」按钮的可用态靠它） */
function usernameOk(raw) {
  return USERNAME_RE.test(normalizeUsername(raw));
}

/**
 * 服务端错误码 → 用户能看懂的中文。
 *
 * ⚠⚠ 这个表**只能靠实测**，不能照 API 文档抄 —— 2026-10-02 打过真接口之后发现
 *   两套码根本不是一回事：
 *     文档示例： `invalid_phone_number` / `error_code: 4001`
 *     真机实测： `INVALID_ARGUMENT`  / `error_code: 3`（gRPC 风格，所有入参错误共用这一个）
 *   所以表里**两套都留着**（文档承诺的留着不影响，实测确认的必须加），
 *   并且 INVALID_ARGUMENT 只能给一个中性兜底 —— 它太泛了，
 *   到底是「手机号错」还是「验证码错」只有**发起请求的那个端点自己知道**
 *   ⇒ 见下面各端点的 overrides 参数。
 *
 * ⚠⚠ 还有一条更隐蔽的：**未命中时绝不能把服务端原文当文案**。
 *   实测服务端会回这种句子：
 *     "malformed jwt: oidc: malformed jwt, expected 3 parts got 1"
 *     "invalid SendVerificationCodeRequest.PhoneNumber: value does not match regex pattern ..."
 *   直接显示出去，用户看到的就是英文技术黑话 —— 等于没做翻译。
 *
 * @param {string} code     服务端错误码
 * @param {string} [fallback] 服务端自带的描述（**仅当中文且干净时**才会被采用）
 * @param {Object} [overrides] 端点级覆盖：{ 码: 文案 }，优先级最高
 */
function errText(code, fallback, overrides) {
  // 端点自己知道上下文，它说的算
  if (overrides && code && overrides[code]) return overrides[code];

  const M = {
    // —— 实测确认的（2026-10-02，tools/probe-cloudbase.js 打真接口得到）——
    INVALID_ARGUMENT: '提交的信息有误，请检查后重试',
    DATABASE_42501: '没有权限修改这份数据',
    // —— 数据库函数相关的两个（2026-10-02 实测）——
    // ⚠ 函数体里 RAISE 的异常会被网关包成 `DATABASE_<SQLSTATE>`：
    //   P0002 = no_data_found。注意它在 HTTP 上是 **500**，不是 404。
    //   真正按它分流的逻辑在 store/cbdb.js 的 httpFail（要带 notFound 标志），
    //   这里给一句中文只是保证「万一漏到界面」时不出现英文黑话。
    DATABASE_P0002: '云端没有这条记录',
    DATABASE_PGRST202: '云端没有这个接口，请更新 App',
    UNAUTHENTICATED: '登录已过期，请重新登录',
    INVALID_TOKEN: '登录已过期，请重新登录',
    // —— 文档承诺的（未实测到，留着不影响）——
    invalid_phone_number: '手机号格式不对，请检查后重试',
    invalid_verification_code: '验证码不对，请重新输入',
    verification_code_expired: '验证码已过期，请重新获取',
    user_not_found: '这个账号还不存在',
    rate_limit_exceeded: '操作太频繁，请等 60 秒后再试',
    captcha_required: '操作过于频繁，请稍后再试',
    invalid_grant: '登录已过期，请重新登录',
    // ⚠ 大小写**两套都要留** —— 同上面 INVALID_ARGUMENT 那条的教训：
    //   文档写的是小写 `invalid_username_or_password`，
    //   而 2026-10-02 实测回的是**全大写** `INVALID_USERNAME_OR_PASSWORD`（error_code 4043）。
    //   少留一条，界面上就会冒出英文黑话。
    INVALID_USERNAME_OR_PASSWORD: '用户名或密码不对',
    invalid_username_or_password: '用户名或密码不对',
    UNIMPLEMENTED: '这个方式暂不支持，请联系管理员',
    user_already_exists: '这个手机号已经注册过了',
    MISSING_CREDENTIALS: '没有登录凭证',
    PERMISSION_DENIED: '没有权限访问这份数据'
  };
  if (M[code]) return M[code];

  // 服务端自带的描述：只有在**确认是中文、且没夹着 Go 格式化失败的脏数据**时才用。
  // （实测见过 `无效的验证码%!(EXTRA string=rpc error: ...)`，那串 %!( 是服务端模板格式化失败的产物）
  if (fallback && /[\u4e00-\u9fa5]/.test(fallback) && fallback.indexOf('%!(') < 0) return fallback;

  // 兜底也必须是中文：宁可给一句含糊的中文，也不把英文黑话甩给用户
  return '请求失败（' + (code || '未知错误') + '），请稍后重试';
}

/** 取一份当前时间（单独抽出来方便测试打桩） */
function now() {
  return Date.now();
}

/**
 * 读一个响应头。
 * ⚠ 不同运行时拿头的方式不一样（浏览器/undici 的 Headers 有 get()，
 *   而某些 RN 实现只给一个普通对象）—— 两种都认，读不到就返回空串。
 *   这里读的是 PostgREST 的 `Content-Range`（形如 `*​/3`），用来数「影响了几行」。
 */
function readHeader(res, name) {
  try {
    if (res && res.headers) {
      if (typeof res.headers.get === 'function') return res.headers.get(name) || '';
      const v = res.headers[name] || res.headers[name.toLowerCase()];
      if (v !== undefined && v !== null) return String(v);
    }
    if (res && typeof res.header === 'function') return String(res.header(name) || '');
  } catch (err) {
    /* 头读不到不影响主流程 */
  }
  return '';
}

/* ------------------------------------------------------------ 底层请求 */

/**
 * 发一个请求。**永不 reject** —— 所有异常都收敛成 { ok:false }。
 *
 * @param {string} path  以 / 开头的路径
 * @param {Object} [o]
 * @param {string} [o.method] 默认 GET
 * @param {Object} [o.body]   JSON 请求体
 * @param {string} [o.token]  Authorization: Bearer <token>（不传则不带该头）
 * @param {string} [o.deviceId] 写入 x-device-id 头
 * @param {Object} [o.headers]  额外请求头（数据面的 Prefer 走这里）
 * @param {Object} [o.overrides] 端点级错误文案覆盖：{ 错误码: 中文文案 }
 *   ⚠ 存在的理由：实测服务端把「手机号错 / 验证码错 / token 错」全报成同一个
 *     `INVALID_ARGUMENT`，光看码分不出来 —— 只有发起请求的端点自己知道该怎么说。
 * @param {boolean}[o.raw]    true 时 data 直接是数组/对象（数据面用），不做错误码归一
 * @returns {Promise<{ok:boolean, status:number, data?:*, code?:string, error?:string}>}
 */
function request(path, o) {
  const opts = o || {};
  const url = CONFIG.base + path;

  if (!fetchImpl) {
    return Promise.resolve({
      ok: false, status: 0, code: 'NO_FETCH',
      error: '当前运行环境没有 fetch，无法访问云端'
    });
  }
  if (!CONFIG.base) {
    // 见 storeMode.js 的同款态度：**不静默降级**。否则你会以为数据存上了，其实哪儿都没写。
    return Promise.resolve({
      ok: false, status: 0, code: 'NO_CONFIG',
      error: 'CloudBase 未配置：请填写 core/cbsdk.js 的 CONFIG.base / envId'
    });
  }

  const headers = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  if (opts.deviceId) headers['x-device-id'] = opts.deviceId;
  if (opts.headers) {
    Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
  }

  // 超时：fetch 自身没有 timeout，用 AbortController。RN 0.86 / Node 18+ 都有。
  let timer = null;
  let ctrl = null;
  const ac = (typeof AbortController === 'function') ? AbortController : null;
  if (ac) {
    ctrl = new ac();
    timer = setTimeout(function () {
      try { ctrl.abort(); } catch (err) { /* 已经结束了，忽略 */ }
    }, CONFIG.timeoutMs || 15000);
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
          // PostgREST 用它表达「影响了几行」，写操作的 deleted 判定要用
          const range = readHeader(res, 'content-range');
          if (status >= 200 && status < 300) {
            // ⚠ 成功但解析不出 body（比如 204 No Content）→ 给 null，
            //   调用方按端点自己知道该期待什么结构。这里**不**伪造成 {}。
            return { ok: true, status: status, data: body, range: range };
          }
          // ⚠⚠ 取码顺序是 `code` **优先于** `error`，不能反 —— 实测两套响应形状不同：
          //   数据面： {"code":"DATABASE_42501","message":"..."}                  只有 code
          //   认证面： {"code":"INVALID_ARGUMENT","error":"invalid_argument",...}  两个都有
          //   若反过来优先取 error，认证面就会拿到小写的 "invalid_argument"，
          //   于是映射表里 INVALID_ARGUMENT 那条**永远命中不了**（2026-10-02 实测踩到）。
          //   error 只作为兜底，兼容文档里 { "error": "invalid_verification_code" } 那种形状。
          const code = (body && (body.code || body.error)) || ('HTTP_' + status);
          const desc = (body && (body.error_description || body.message)) || '';
          return {
            ok: false, status: status, code: code, data: body, range: range,
            // ⚠ 文案一律经 errText —— 它保证**任何**情况下都是中文；
            //   服务端的英文黑话（malformed jwt / regex pattern ...）不会漏到界面上
            error: errText(code, desc, opts.overrides)
          };
        });
    })
    .catch(function (err) {
      if (timer) { clearTimeout(timer); timer = null; }
      const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
      return {
        ok: false, status: 0, code: aborted ? 'TIMEOUT' : 'NETWORK',
        error: aborted
          ? '请求超时了，请检查网络后重试'
          : '网络请求失败，请检查网络后重试'
      };
    });
}

/* ------------------------------------------------------------ 认证流程 */

/**
 * 第 1 步：发验证码。
 * @param {string} phone 任意格式的大陆手机号
 * @param {Object} [o] { deviceId }
 * @returns {Promise<{ok:boolean, verificationId?:string, isUser?:boolean, expiresIn?:number, error?:string}>}
 */
function sendCode(phone, o) {
  const opts = o || {};
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return Promise.resolve({ ok: false, code: 'invalid_phone_number', error: '请填写正确的手机号' });
  }

  return request('/auth/v1/verification', {
    method: 'POST',
    // task 用 ANY：不限制用户是否存在 —— 登录和注册都要走这条路
    body: { phone_number: normalized, target: 'ANY' },
    deviceId: opts.deviceId,
    // 这个端点上的 INVALID_ARGUMENT 只可能是手机号问题
    // （实测原文：invalid SendVerificationCodeRequest.PhoneNumber: value does not match ...）
    overrides: { INVALID_ARGUMENT: '手机号格式不对，请检查后重试' }
  }).then(function (r) {
    if (!r.ok) return r;
    const d = r.data || {};
    if (!d.verification_id) {
      // ⚠ 200 但没给 verification_id = 拿不到下一步的钥匙，如实报错，
      //   别让它悄悄变成一个「点了没反应」的按钮
      return { ok: false, status: r.status, code: 'NO_VERIFICATION_ID', error: '服务端没有返回验证码标识，请重试' };
    }
    return {
      ok: true,
      status: r.status,
      verificationId: d.verification_id,
      expiresIn: d.expires_in || 600,
      // is_user 决定后面走登录还是注册（官方：「is_user 为 false 或空 → 调注册接口」）
      isUser: d.is_user === true
    };
  });
}

/**
 * 第 2 步：校验验证码，拿到 verification_token。
 * @returns {Promise<{ok:boolean, verificationToken?:string, error?:string}>}
 */
function verifyCode(verificationId, code, o) {
  const opts = o || {};
  if (!verificationId) {
    return Promise.resolve({ ok: false, code: 'NO_VERIFICATION_ID', error: '请先获取验证码' });
  }
  if (!code) {
    return Promise.resolve({ ok: false, code: 'EMPTY_CODE', error: '请输入验证码' });
  }

  return request('/auth/v1/verification/verify', {
    method: 'POST',
    body: { verification_id: verificationId, verification_code: String(code) },
    deviceId: opts.deviceId,
    // 这个端点上的 INVALID_ARGUMENT = 验证码对不上或已过期
    overrides: { INVALID_ARGUMENT: '验证码不对或已过期，请重新输入' }
  }).then(function (r) {
    if (!r.ok) return r;
    const d = r.data || {};
    if (!d.verification_token) {
      return { ok: false, status: r.status, code: 'NO_VERIFICATION_TOKEN', error: '服务端没有返回验证令牌，请重试' };
    }
    return { ok: true, status: r.status, verificationToken: d.verification_token, expiresIn: d.expires_in || 600 };
  });
}

/* ------------------------------------------------------- 从 JWT 里解 sub */

const B64_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 → 字节数组。
 * ⚠ 目标环境（React Native / Hermes）**不保证**有 atob，所以自己解。
 *   这里**刻意不复用** gitee.js 那份：两者是**并列的驱动**，不该互相依赖
 *   （store/index.js 是按 mode pick 一个，谁都不该 require 另一个；
 *     而且那边要的是双向 + 完整 UTF-8，这边只要单向 base64url 解码）。
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

/** UTF-8 字节 → 字符串（payload 里可能有中文用户名，不能按 charCode 硬塞） */
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
 * 从 access_token（JWT）的 payload 里取 sub —— **uid 最可靠的来源**。
 *
 * ⚠⚠ 为什么不直接用响应体的 `d.sub`（两条都是真实踩过的坑）：
 *   ① **精度**：`auth.users.id` 是 bigint，实测 19 位（如 2105943212899172352），
 *      **远超** Number.MAX_SAFE_INTEGER（16 位）。若服务端把它当 JSON number 返回，
 *      JSON.parse 会**静默吃掉低位** —— 拿到的 uid 与数据库里的 owner 对不上，
 *      表现是「登录成功、却一条记录都读不到」，全程无报错，极难排查。
 *   ② **形状不确定**：响应体里到底有没有 sub，官方文档与真机**已经不一致过两次**
 *      （错误码从 invalid_phone_number 变成 gRPC 的 INVALID_ARGUMENT 那次）。
 *      而 access_token 一定是 JWT（服务端自己报错时说过 "expected 3 parts"），
 *      payload 里必有 sub ⇒ 从 token 里解比信响应体稳。
 *
 * ⚠ 取 sub 用**正则直接抠**，不走 JSON.parse ——
 *   否则①的精度问题当场复发（parse 已经把它变成浮点了，再取就晚了）。
 */
function subFromJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return '';
    // JWT 用 base64url：-_ 代替 +/，且可能省略尾部 padding
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = utf8FromBytes(b64ToBytes(b64));
    const m = /"sub"\s*:\s*"?([A-Za-z0-9_\-.:|]+)"?/.exec(json);
    return m ? m[1] : '';
  } catch (err) {
    return '';
  }
}

/** 把 signin / signup / token 三个端点统一的令牌响应收敛成同一种形状 */
function readTokenResponse(r) {
  if (!r.ok) return r;
  const d = r.data || {};
  if (!d.access_token) {
    return { ok: false, status: r.status, code: 'NO_ACCESS_TOKEN', error: '服务端没有返回登录令牌，请重试' };
  }
  return {
    ok: true,
    status: r.status,
    tokens: {
      accessToken: d.access_token,
      // ⚠ refresh_token 可能为空（client_credentials 模式不返回）——
      //   那种情况如实留空，上层据此判断「只能撑 2 小时，不能自动续」
      refreshToken: d.refresh_token || '',
      expireIn: d.expires_in || 7200,
      // ⚠ 先解 JWT（权威、无精度问题），响应体的 sub 只作兜底。
      //   兜底那条**仍有精度风险**（见 subFromJwt 注释①），所以能解出 JWT 时绝不走它。
      sub: subFromJwt(d.access_token) || (d.sub === undefined || d.sub === null ? '' : String(d.sub)),
      tokenType: d.token_type || 'Bearer'
    }
  };
}

/** 第 3a 步：登录（已存在的用户） */
function signIn(verificationToken, o) {
  const opts = o || {};
  return request('/auth/v1/signin', {
    method: 'POST',
    body: { verification_token: verificationToken },
    deviceId: opts.deviceId,
    // 实测：这个端点上的 INVALID_ARGUMENT 来自 verification_token 解析失败
    // （原文 "malformed jwt: oidc: ..."）⇒ 语义就是「验证信息过期了，重新获取验证码」
    overrides: { INVALID_ARGUMENT: '登录信息已失效，请重新获取验证码' }
  }).then(readTokenResponse);
}

/** 第 3b 步：注册（新用户）。手机号+验证码注册，不设密码也不要用户名 */
function signUp(phone, verificationToken, o) {
  const opts = o || {};
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return Promise.resolve({ ok: false, code: 'invalid_phone_number', error: '请填写正确的手机号' });
  }
  return request('/auth/v1/signup', {
    method: 'POST',
    body: { phone_number: normalized, verification_token: verificationToken },
    deviceId: opts.deviceId,
    overrides: { INVALID_ARGUMENT: '注册信息已失效，请重新获取验证码' }
  }).then(readTokenResponse);
}

/* ------------------------------------------------------------ 匿名登录（备选） */

/**
 * 匿名登录（备选，**未接 UI**）—— 同一设备码固定成一个匿名账号。
 *
 * ⚠ 2026-10-02 实测可用（14/15 通过）：
 *   · header `x-device-id` **必填**，缺了回 `400 请在请求头添加设备id`；
 *   · 返回的 sub **不是** `'anon'`（所以 RLS 那条 `auth.uid() <> 'anon'` 放行）；
 *   · 数据面读 / 写全通，刷新后 sub 不变。
 * ⚠⚠ **换设备或清数据就换账号** —— sub 由 x-device-id 决定，uid 一变记录就看不到了。
 *   ⇒ 只能当「试用 / 临时」入口，**不能**当正式登录（这正是用户没选它的原因）。
 * ⚠ 需平台先开启：`manageAppAuth patchLoginStrategy { anonymous: true }`（本环境已开）。
 * ⚠ 另注：匿名用户**不能自删**（`DELETE /auth/v1/user/me` 回 403 「user scope want [user]」），
 *   且不出现在 `DescribeUserList` ⇒ 造出来的匿名账号**删不掉**，别随手造。
 */
function signInAnonymously(o) {
  const opts = o || {};
  if (!opts.deviceId) {
    return Promise.resolve({ ok: false, code: 'NO_DEVICE_ID', error: '缺少设备标识，无法匿名登录' });
  }
  return request('/auth/v1/signin/anonymously', {
    method: 'POST',
    body: {},
    deviceId: opts.deviceId
  }).then(readTokenResponse);
}

/* ------------------------------------------- 用户名 + 密码登录（当前主路径） */

/**
 * 用「用户名 + 密码」登录 —— **当前 CloudBase 路径的唯一登录入口**。
 *
 * ============ 为什么换成它 ============
 * 用户的诉求是「别再烧短信费」。而短信费的大头其实**不是登录**
 * （refresh_token 默认 31 天，且每次刷新都会重置 ⇒ 活跃用户永不重发），
 * 而是**每个新用户注册那一条**。改成用户名密码后，注册由管理员在管控面完成
 * （`tcb/CreateUser`），客户端侧零短信开销。
 *
 * ============ ⚠⚠ 为什么这里没有「注册」函数 ============
 * `/auth/v1/signup` 只给 `{username, password}` 会被**平台直接拒绝**：
 *     HTTP 501 UNIMPLEMENTED
 *     "you can not signup just by username and password"
 * 这是 2026-10-02 打真接口实测的结果（不是推测）。
 * ⇒ 账号只能由管理员创建，客户端**只有登录**这一个动作，永远别加注册按钮。
 *
 * ⚠ 端点与字段取自 OpenAPI 的 `v1SignInRequest`：{ username, password, verification_token }
 *   三者互斥，本函数只走前两条。实测（2026-10-02）：
 *   · `{username, password}`       → 200 + access_token + refresh_token
 *   · 只给 password 不给 username → 400 "username or verification_token can not both be empty"
 *   · 用户名或密码错               → 400 INVALID_USERNAME_OR_PASSWORD (error_code 4043)
 */
function signInWithPassword(username, password, o) {
  const opts = o || {};
  const u = normalizeUsername(username);
  if (!u) {
    return Promise.resolve({ ok: false, code: 'EMPTY_USERNAME', error: '请输入用户名' });
  }
  if (!password) {
    return Promise.resolve({ ok: false, code: 'EMPTY_PASSWORD', error: '请输入密码' });
  }
  return request('/auth/v1/signin', {
    method: 'POST',
    // ⚠ 密码只在这里出现一次，**绝不**写进日志、错误文案或任何持久化字段
    body: { username: u, password: String(password) },
    deviceId: opts.deviceId,
    // 端点级覆盖：这个码只可能由这个端点产生，说得具体一点
    overrides: { INVALID_USERNAME_OR_PASSWORD: '用户名或密码不对，请重新输入' }
  }).then(readTokenResponse);
}

/**
 * 刷新令牌。
 * ⚠⚠ 返回的 refresh_token 是**新的**，原来那个已经失效 —— 调用方必须整对存下来。
 *    只存 access_token 的写法会让用户在某次刷新之后彻底掉线（且原因极难查）。
 */
function refresh(refreshTokenValue, o) {
  const opts = o || {};
  if (!refreshTokenValue) {
    return Promise.resolve({ ok: false, code: 'NO_REFRESH_TOKEN', error: '没有可用的续期凭证' });
  }
  return request('/auth/v1/token', {
    method: 'POST',
    body: { grant_type: 'refresh_token', refresh_token: refreshTokenValue },
    deviceId: opts.deviceId,
    overrides: { INVALID_ARGUMENT: '登录已过期，请重新登录', invalid_grant: '登录已过期，请重新登录' }
  }).then(readTokenResponse);
}

/* ------------------------------------------------------------ 测试用钩子 */

function _setFetch(fn) { fetchImpl = fn; }
function _getConfig() { return CONFIG; }

module.exports = {
  CONFIG: CONFIG,
  normalizePhone: normalizePhone,
  phoneOk: phoneOk,
  maskPhone: maskPhone,
  /* 用户名（账号）—— 当前登录路径用 */
  USERNAME_RE: USERNAME_RE,
  USERNAME_MIN: USERNAME_MIN,
  USERNAME_MAX: USERNAME_MAX,
  normalizeUsername: normalizeUsername,
  usernameOk: usernameOk,
  signInWithPassword: signInWithPassword,
  signInAnonymously: signInAnonymously,
  errText: errText,
  request: request,
  sendCode: sendCode,
  verifyCode: verifyCode,
  signIn: signIn,
  signUp: signUp,
  refresh: refresh,
  configured: function () { return !!(CONFIG.base && CONFIG.envId); },
  // ⚠ subFromJwt 单独导出给测试（纯函数，能直接喂各种歪形状的 JWT）
  subFromJwt: subFromJwt,
  _setFetch: _setFetch,
  _getConfig: _getConfig,
  _now: now
};
