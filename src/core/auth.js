/**
 * 登录态
 *
 * ============ 从抖音小程序搬过来的两根前提，这里都变了 ============
 * 小程序里：tt.login 能拿一次性 code，且有「设备匿名码」可作 uid 来源。
 * App 里：
 *   · **没有 tt.login**（那是抖音专有 API）
 *   · **没有 anonymousCode**（平台不再提供设备级标识）
 * ⇒ 所以这里自己造一个**设备码**并粘住（见 stickyDeviceCode）。
 *   一旦把它写进云端数据归属，它就再也不能变 —— 变了 = 换一份空数据 = 用户「记录丢了」。
 *
 * ============ 三条路，按存储后端分 ============
 * MODE = 'local'（**当前**）——**用户名 + 密码**，走自建 paipan-server（core/localsdk.js）
 *   登录 `POST /auth/signin`、注册 `POST /auth/signup`。**支持自助注册**。
 *   令牌 30 天、单个（没有 refresh），到期重新登录。
 *
 * MODE = 'cloudbase'（保留）——**用户名 + 密码登录**
 *   走 CloudBase 的身份认证（core/cbsdk.js），登录成功后把 JWT 存进 core/session.js。
 *   这条路解决的是「换手机不丢记录」：uid 变成服务端签发的用户 ID（JWT 的 sub），
 *   不再是设备级的。
 *
 *   ⚠⚠ **这条路不提供注册** —— 账号由管理员在管控面创建（`tcb/CreateUser`）。
 *     平台**禁止**用户自助注册用户名密码 —— 实测 `/auth/v1/signup` 只带
 *     `{username,password}` 会回 `501 UNIMPLEMENTED: you can not signup just by
 *     username and password`。⇒ 页面据此**不显示**注册入口（见 canSignUp）。
 *   ⚠ 用户名规则以**实测正则**为准（`cbsdk.USERNAME_RE`），文档写的那一版是错的。
 *
 * MODE = 'gitee' / 'cloud'（保留）—— 没有服务端时的**本地登录态**
 *   只造一个设备码当 uid，不联任何登录接口。这条路换机就丢记录，是历史兜底。
 *
 * ⚠⚠ 「有没有后端」这件事在本文件里被抽象成 `useBackend()`（= local 或 cloudbase）。
 *   不要再拿 `useCloudbase()` 当「有没有服务端」的判据 —— 那是两个不同的后端，
 *   本地模式会被它误判成「没有服务端」，进而去做只该在离线时做的事。
 *   `useCloudbase()` 保留，但它现在**只回答**「是不是 CloudBase 这一个后端」。
 *
 * ============ 为什么放弃短信登录（2026-10-02 用户拍板）============
 * 用户的诉求是「别再烧短信费」。但**登录**其实不是大头：refresh_token 默认 31 天，
 * 且每次刷新都会重置计时器 ⇒ 只要 31 天内打开过一次 App 就永不重发。
 * 真正贵的是**每个新用户注册的那一条** ⇒ 注册搬到服务端之后，客户端零短信开销。
 * ⚠ 短信驱动（`cbsdk.sendCode` / `verifyCode` / `signIn` / `signUp`）**保留不删**：
 *   探针靠它验「认证端点还活着」，平台若放开自助注册也能直接启用。
 *
 * ============ 页面用法 ============
 *   auth.ensureLogin()                  // 有登录态就复用，没有也不是错误（见 needLogin）
 *   auth.signInWithPassword(user, pwd)  // 登录
 *   auth.signUpWithPassword(user, pwd)  // 注册（**只有本地后端支持**，先问 canSignUp）
 *   auth.isLoggedIn()                   // 同步，本地有没有可用的登录凭证
 *   auth.loginUsername()                // 设置页展示当前账号名
 */
const storage = require('../platform/storage.js');
const cbsdk = require('./cbsdk.js');
const localsdk = require('./localsdk.js');
const session = require('./session.js');

const KEY = 'paipan_login_v1';

/**
 * 设备码要**单独存一份**，不能只放在登录态里。
 * 登录态会被清掉（过期、退出登录），而设备码应当始终是同一个 ——
 * 它是 uid 的唯一来源，uid 又决定云端数据归属。
 */
const ANON_KEY = 'paipan_anon_v1';

/** 没有服务端时的本地登录态有效期（有服务端则用服务端返回的 expireIn） */
const LOCAL_TTL = 7 * 24 * 3600 * 1000;

/**
 * 抖音登录换取接口地址。留空 = 只做本地登录态。
 * ⚠ 这条路**不再使用**（当前后端是 CloudBase，走**账号 + 密码**登录）。
 *   保留它是因为小程序侧仍在用同一套契约；CloudBase 模式下这里恒为空串。
 */
const LOGIN_API = '';

/** 当前 MODE（读不到配置时按「没有后端」处理）。现取的理由同 useCloudbase */
function currentMode() {
  try {
    return require('./storeMode.js').MODE;
  } catch (err) {
    return '';
  }
}

/**
 * 当前是不是**自建本地后端**。
 * ⚠ 现取而不是模块加载时定死：测试会改 storeMode.MODE 来切换后端，
 *   定死的话「换后端」这件事在同一个进程里就测不了了。
 */
function useLocal() {
  return currentMode() === 'local';
}

/**
 * 当前是不是 CloudBase 后端。
 * ⚠ 这个函数现在**只回答这一件事**，不再兼任「有没有服务端」。
 *   要问「有没有服务端」请用 useBackend()。
 */
function useCloudbase() {
  return currentMode() === 'cloudbase';
}

/**
 * 当前有没有**真正的服务端**（local 或 cloudbase）——即 uid 是不是服务端签发的。
 *
 * ⚠⚠ 这是本文件里所有「要不要走网络」分支的**唯一判据**。
 *   从前这个位置写的是 useCloudbase()，接了本地后端之后它会把 local 误判成
 *   「没有服务端」，于是去造设备码当 uid —— 而本地后端的 uid 只认令牌里那个，
 *   结果就是「登录了却一条记录都存不上」。改用这个函数后两边都对。
 */
function useBackend() {
  const m = currentMode();
  return m === 'local' || m === 'cloudbase';
}

/** 当前后端的认证 SDK（local → localsdk，其余 → cbsdk） */
function sdk() {
  return useLocal() ? localsdk : cbsdk;
}

/**
 * 当前后端**是否支持自助注册**。
 *
 * ⚠⚠ 只有本地后端支持。CloudBase 那边平台禁死（501），
 *   页面必须据此决定要不要显示注册入口 —— 显示了而点不通比不显示更糟。
 */
function canSignUp() {
  return useLocal();
}

/* ------------------------------------------------------------------ 存取 */

function readSession() {
  try {
    const raw = storage.getStorageSync(KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn('[paipan] 读取登录态失败', err);
    return null;
  }
}

function writeSession(session) {
  try {
    storage.setAndPersist(KEY, JSON.stringify(session));
  } catch (err) {
    console.warn('[paipan] 写入登录态失败', err);
  }
  return session;
}

/* --------------------------------------------------------- 设备码 */

function readAnon() {
  try { return storage.getStorageSync(ANON_KEY) || ''; } catch (err) { return ''; }
}

function writeAnon(code) {
  try { storage.setAndPersist(ANON_KEY, code); } catch (err) {
    console.warn('[paipan] 写入设备码失败', err);
  }
  return code;
}

/** 造一个足够随机的设备码（不依赖 crypto，RN 的 Hermes 不保证有） */
function makeDeviceCode() {
  const t = Date.now().toString(36);
  let r = '';
  for (let i = 0; i < 4; i++) {
    r += Math.floor(Math.random() * 0x100000000).toString(36);
  }
  // ⚠ 只保留 [a-z0-9]：uid 会被拼进云端文件名，必须过白名单
  return ('d' + t + r).replace(/[^a-z0-9]/g, '').slice(0, 32);
}

/**
 * 定下这台设备要用的码：**首次生成的就是永久那个**。
 *
 * ⚠ 为什么必须粘住（小程序时代实测踩到的坑，App 里同样适用）：
 *   如果每次启动都新生成一个设备码，uid 就变了，云端文件名跟着变 ——
 *   旧文件还在，但新 uid 一条也查不到，用户看到的就是「记录凭空消失」。
 *   所以：有就用旧的，没有才生成并立刻落盘。
 */
function stickyDeviceCode(fresh) {
  const prev = readAnon();
  if (prev) return prev;
  return writeAnon(fresh || makeDeviceCode());
}

/** 本地登录态是否有效 */
function isLoggedIn() {
  if (useBackend()) {
    // ⚠ 这里判的是「有没有凭证」，**不是**「access_token 还没过期」——
    //   过期的 access_token 可以用 refresh_token 自动续期（session.getAccessToken 负责），
    //   不该因为「两小时到了」就把用户踢去重新登录。
    return session.hasSession();
  }
  const s = readSession();
  return !!(s && s.expireAt > Date.now());
}

/** 对外暴露的登录用户信息（脱敏，不带 code / token 这类凭证） */
function getUser() {
  if (useBackend()) {
    const c = session.get();
    if (!c) return null;
    return {
      openid: '',
      // 保持字段形状不变：anonymousId 一直是「本机设备码」那个脱敏视图
      anonymousId: session.deviceId() || '',
      cloudbaseUid: c.sub || '',
      phone: c.phone || '',
      // 当前登录的账号名（用户名密码登录时有值；历史上的短信账号为空）
      username: c.username || '',
      loginAt: c.loginAt || 0,
      expireAt: c.expireAt || 0,
      backend: true
    };
  }
  const s = readSession();
  if (!s) return null;
  return {
    openid: s.openid || '',
    anonymousId: s.deviceCode || '',
    loginAt: s.loginAt || 0,
    expireAt: s.expireAt || 0,
    backend: !!s.backend
  };
}

/**
 * 取「能用来标识这个用户」的凭证。调用方（core/userStore.js 的 uidOf）据此决定 uid。
 *
 * ⚠⚠ CloudBase 模式下**刻意不给设备码**：
 *   这条路上的身份完全由服务端签发（JWT 的 sub），设备码没有任何意义。
 *   给了它，uidOf 会拿设备码当 uid，上层就以为「有身份」而去打接口 ——
 *   然后被服务端以 401 拒掉，报出来的是「没有权限」而不是「你还没登录」，
 *   排查时非常绕。空 uid 会让上层直接走「还没登录」这条清清楚楚的路。
 */
function getIdentity() {
  if (useBackend()) {
    return {
      cloudbaseUid: session.uid(),   // 没登录就是空串，上层据此判「未登录」
      unionid: '',
      openid: '',
      anonymousCode: ''
    };
  }
  const s = readSession();
  return {
    unionid: (s && s.unionid) || '',
    openid: (s && s.openid) || '',
    // 登录态里没有就回退到设备那份：uidOf → 云端定位 要的是一个可用的标识，
    // 不该因为「这次登录态没带上」就拿不到 uid
    anonymousCode: (s && s.deviceCode) || readAnon() || ''
  };
}

/**
 * 退出登录：只清登录凭证，**不动设备码**。
 * 清了设备码下次会生成一个新的，uid 跟着变 —— 在文件级模型下云端就新开一份空数据，
 * 记录又「丢」一次。（在 CloudBase 模型下 uid 来自服务端，设备码无关紧要，
 * 但保持同一个设备码能让服务端那边的登录设备数统计更准。）
 */
function logout() {
  // CloudBase：令牌是登录态本体，必须清掉，否则下次启动还是「已登录」
  if (useBackend()) session.clear();
  try { storage.removeStorageSync(KEY); storage.persistKey(KEY).catch(() => {}); }
  catch (err) { console.warn('[paipan] 清除登录态失败', err); }
}

/** 连设备身份一起重置（只在「换人用这台设备」这种场景才该调） */
function resetDevice() {
  try {
    storage.removeStorageSync(KEY);
    storage.removeStorageSync(ANON_KEY);
    storage.persistKey(KEY).catch(() => {});
    storage.persistKey(ANON_KEY).catch(() => {});
  } catch (err) {
    console.warn('[paipan] 重置设备标识失败', err);
  }
}

/* -------------------------------------------------------------- 登录流程 */

/**
 * 平台侧 session 是否还有效。
 * App 里没有抖音的 checkSession ⇒ 恒为 true（不耽误主流程）。
 */
function checkSession() {
  return Promise.resolve(true);
}

/** 把凭证交给服务端换登录态；没配 LOGIN_API 就落本地标记 */
function exchange(cred) {
  const base = {
    code: cred.code,
    deviceCode: stickyDeviceCode(cred.deviceCode),
    loginAt: Date.now()
  };

  if (!LOGIN_API) {
    return Promise.resolve(writeSession({
      code: base.code,
      deviceCode: base.deviceCode,
      loginAt: base.loginAt,
      token: '',
      openid: '',
      unionid: '',
      expireAt: base.loginAt + LOCAL_TTL,
      backend: false
    }));
  }

  return fetch(LOGIN_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: base.code, anonymousCode: base.deviceCode })
  }).then(function (res) {
    return res.json().then(function (d) {
      if (res.status === 200 && d && d.token) {
        return writeSession({
          code: base.code,
          deviceCode: base.deviceCode,
          loginAt: base.loginAt,
          token: d.token,
          openid: d.openid || '',
          unionid: d.unionid || '',
          expireAt: Date.now() + (d.expireIn ? d.expireIn * 1000 : LOCAL_TTL),
          backend: true
        });
      }
      console.warn('[paipan] 服务端换取登录态失败', res.status);
      return null;
    });
  }).catch(function (err) {
    console.warn('[paipan] 换取登录态请求失败', err);
    return null;
  });
}

/**
 * 走一次完整登录。结果用 `{ ok, session }` / `{ ok:false, error }` 表达，
 * **不做 reject** —— 登录失败是预期内的事，页面不需要 catch。
 *
 * ⚠⚠ CloudBase 模式下这里**不再自造登录态**（老逻辑是「没有服务端就落个设备码」）。
 *   那在现在会凭空造出一个「已登录」的假象：界面显示已登录，
 *   一存记录就被服务端 401 拒掉 —— 错误信息还指向「没有权限」，非常难查。
 *   所以如实返回 `needLogin`，让页面去引导用户去登录页。
 * ⚠ 本模式下「登录」只能由**用户手输用户名密码**完成（见 signInWithPassword），
 *   没有任何无感路径 —— 这正是 ensureLogin 必须忽略 force 的原因。
 */
function login(force) {
  if (useBackend()) {
    return Promise.resolve({
      ok: false,
      needLogin: true,
      error: '请先登录'
    });
  }
  return exchange({ code: '', deviceCode: '' }).then(function (session) {
    if (!session) return { ok: false, error: '建立本地登录态失败' };
    return { ok: true, session: session };
  });
}

/**
 * 保证处于已登录状态：本地有效就直接返回，否则走一次登录。
 * @param {boolean} force 强制重新登录（本地登录态还在时也重走一遍校验）
 */
function ensureLogin(force) {
  if (useBackend()) {
    /**
     * ⚠⚠⚠ cloudbase 下 `force` **必须忽略**，别照抄下面 gitee 分支的语义。
     *
     *   · gitee 的 force = 「重新取一次设备码」——无感、可自动完成，所以那边保留。
     *   · cloudbase 的「重新登录」= 重走一遍用户名密码，**必须用户参与**
     *     ⇒ login() 在 cloudbase 下永远返回 needLogin（刻意不自造登录态）。
     *
     *   所以一旦这里尊重 force，凡是 `ensureLogin(true)` / `boot.whoami({fresh:true})`
     *   都**必然失败** —— 用户明明登录着，点「开始排盘」却被告知「登录后才能排盘」。
     *   （这不是假设：这条路径真实炸过，且因为登录态显示正常而极难定位。）
     *
     *   ⇒ cloudbase 下 force 一律降级为「**确认现有凭证此刻是否可用**」：
     *     有凭证就验它（顺带自动续期），没有才让用户去登录。
     */
    if (session.hasSession()) {
      // 有凭证 → 确认它**此刻真的能用**（顺带触发一次自动续期）
      return session.getAccessToken().then(function (t) {
        if (t.ok) return { ok: true, session: getIdentity() };
        // 凭证本身作废（续期也救不回来）→ 让用户重新登录
        if (t.code === 'EXPIRED' || t.code === 'NO_SESSION') {
          return { ok: false, needLogin: true, error: t.error || '登录已过期，请重新登录' };
        }
        // ⚠ 网络问题：凭证还在，只是这次没连上 —— **不要**说成「需要登录」，
        //   那会在断网时把用户引导去重新登录（而其实他登录着）
        return { ok: false, error: t.error || '网络异常，请稍后重试' };
      });
    }
    return login(force);
  }

  if (!force && isLoggedIn()) {
    return checkSession().then(function (alive) {
      if (alive) return { ok: true, session: readSession() };
      return login(false);
    });
  }
  return login(force);
}

/* ------------------------------------------ 用户名 + 密码（登录 / 注册） */

/**
 * 用「用户名 + 密码」登录，成功后把令牌存下来。
 *
 * ⚠ 两个后端的 SDK 形状相同（都是 { ok, token|tokens, error }），但**令牌内容不同**：
 *   · localsdk 回 `token`（单个，无 refresh）
 *   · cbsdk 回 `tokens`（一对，含 refresh）
 *   下面的 `r.tokens || r.token` 把两种都接住，再交给 session.save ——
 *   session 认 `refreshToken` 是空就当作「不能自动续期」（见 session.js 的 hasRefresh）。
 *
 * @param {string} username 大小写不敏感（SDK 统一归一化成小写）
 * @param {string} password
 * @returns {Promise<{ok:boolean, session?:Object, error?:string}>} 永不 reject
 */
function signInWithPassword(username, password) {
  const deviceId = stickyDeviceCode('');
  const s = sdk();

  const call = useLocal()
    ? s.signInWithPassword(username, password)
    : s.signInWithPassword(username, password, { deviceId: deviceId });

  return call.then(function (r) {
    if (!r.ok) return r;
    // ⚠ CloudBase 必须 accessToken + refreshToken **整对**存下来：
    //   刷新时旧的 refresh_token 立即失效，只存一半会让用户下次刷新直接掉线。
    //   （本地只有一个 token，存进去 refreshToken 是空串 —— 那是如实，不是遗漏）
    session.save(r.tokens || r.token, {
      username: s.normalizeUsername(username),
      deviceCode: deviceId
    });
    return { ok: true, session: getIdentity() };
  });
}

/**
 * 用「用户名 + 密码」**注册**（成功后即处于登录态）。
 *
 * ⚠⚠ **只有本地后端支持**。调用前请先问 `canSignUp()` ——
 *   CloudBase 那边这个请求 100% 被平台回 501。
 *   （这里也守一道：不支持时**如实报错**，而不是发一个注定失败的请求出去。）
 *
 * ⚠ 注册成功后**直接发令牌**（服务端就是这么设计的），所以这里和登录走同一条存令牌的路径 ——
 *   用户注册完不用再登录一次。
 *
 * @returns {Promise<{ok:boolean, session?:Object, error?:string}>} 永不 reject
 */
function signUpWithPassword(username, password) {
  if (!canSignUp()) {
    return Promise.resolve({
      ok: false,
      code: 'SIGNUP_UNSUPPORTED',
      error: '当前后端不支持自助注册，请联系管理员开通账号'
    });
  }
  const deviceId = stickyDeviceCode('');
  return localsdk.signUpWithPassword(username, password).then(function (r) {
    if (!r.ok) return r;
    session.save(r.token, {
      username: localsdk.normalizeUsername(username),
      deviceCode: deviceId
    });
    return { ok: true, session: getIdentity() };
  });
}

/**
 * 当前登录的账号名（设置页展示用）。
 *
 * ⚠ 刷新令牌走的是 `session.save(r.tokens)`（**不带 extra**），靠 session 层**沿用**旧值，
 *   所以这里读到的是「本次登录写进去的名字」，不会因为自动续期而变空。
 *   （本地后端不会自动续期，但这条规则对它同样成立、也不冲突。）
 */
function loginUsername() {
  if (!useBackend()) return '';
  const c = session.get();
  return (c && c.username) || '';
}

module.exports = {
  isLoggedIn: isLoggedIn,
  ensureLogin: ensureLogin,
  login: login,
  getUser: getUser,
  getIdentity: getIdentity,
  logout: logout,
  resetDevice: resetDevice,
  checkSession: checkSession,
  /** 有没有真服务端（决定 uid 是不是设备级的）。⚠ 别再拿 useCloudbase 兼职这个 */
  hasBackend: function () { return useBackend() || !!LOGIN_API; },
  /** 当前是不是 **CloudBase** 后端（**只**回答这一个问题） */
  useCloudbase: useCloudbase,
  /** 当前是不是**自建本地后端** */
  useLocal: useLocal,
  /** 当前后端支不支持自助注册（页面据此决定显不显示注册入口） */
  canSignUp: canSignUp,
  /* ---- 用户名 + 密码 ---- */
  signInWithPassword: signInWithPassword,
  signUpWithPassword: signUpWithPassword,
  /** 已登录的账号名（设置页展示） */
  loginUsername: loginUsername,
  /** 这台设备的稳定码（诊断 / 展示用，也是文件级模型下 uid 的来源） */
  deviceId: readAnon,
  LOGIN_KEY: KEY,
  ANON_KEY: ANON_KEY,
  /** 登录凭证的存储键（core/session.js），设置页「退出登录」要用 */
  SESSION_KEY: session.KEY,
  // 测试用：让测试能直接注入一个设备码 / 拿到令牌层
  _makeDeviceCode: makeDeviceCode,
  _session: session
};
