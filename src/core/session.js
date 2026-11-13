/**
 * 登录凭证（令牌）—— 存取 + 自动续期
 *
 * ============ 两个后端，令牌形状不同 ============
 *   · CloudBase：`access_token` + `refresh_token` **一对**。
 *     刷新时旧 refresh_token 立即失效 ⇒ 可用 31 天自动续期，用户几乎不用重输密码。
 *   · 本地 paipan-server：**只有一个 token**，30 天有效，**没有续期接口**。
 *     到期就是要重新登录。
 *
 * ⚠⚠ **绝不要给本地模式伪造一个 refreshToken**（哪怕回空串以外的假值）：
 *   下游一旦看到 refreshToken 就以为「能自动续期」，会去调一个本地不存在的接口 ——
 *   那才是最坏的情况：用户用到第 30 天被弹去重新登录，而报错说「续期失败，请检查网络」。
 *   ⇒ 本地模式**真的不给这个字段**，让 needsRefresh()/getAccessToken() 走「到期即重新登录」。
 *   见下面 LOCAL_HAS_REFRESH。
 *
 * ============ 为什么单独一层 ============
 * 「令牌」被两拨人需要，而且它们不该互相认识：
 *   · core/auth.js  —— 登录成功后**写**进来
 *   · core/store/cbdb.js / localdb.js —— 每次访问数据面前**读**出去
 * 如果让驱动直接去问 auth，auth 又会依赖登录流程里的别的东西，容易绕成环。
 * 所以把「令牌」这件小事单独放一层，两边都只依赖它。
 *
 * ============ ⚠⚠ 这里防的是一个真会发生的 bug（只在 CloudBase 那条路）============
 * CloudBase 刷新令牌时，**原来那个 refresh_token 立刻失效**（官方原文：
 * 「原refresh_token使用后立即失效」）。
 *
 * 于是「两个请求同时发现 access_token 过期」这件事就变得致命：
 *   请求 A 拿 refresh_token 换到了新的一对 → 旧的作废
 *   请求 B 也拿**同一个** refresh_token 去换 → invalid_grant → 直接判「登录过期」
 * 结果是：打开记录页那一刻同时发了两个请求，用户被莫名其妙踢出登录。
 *
 * ⇒ 所以 refresh 必须**并发去重**（inflight 单例），让第二个调用复用第一个的结果。
 *   ⚠ 这不是「优化」，是正确性要求 —— 少了它，偶发的「突然说我登录过期了」根本没法查。
 *
 * ============ 失败要分两种，处理方式相反 ============
 *   · 凭证本身废了      → 真过期了 → **清掉**本地凭证，让用户重新登录
 *   · 网络失败 / 超时    → 只是这次没连上 → **保留**凭证，下次再试
 * 把网络抖动当成「登录过期」会把用户的登录态无谓地清掉。
 *
 * ⚠⚠ 而「凭证废了」的判据**不能只看 HTTP 状态码** —— 这是实测踩出来的：
 *   文档说 refresh_token 失效 → 400 + `invalid_grant`
 *   实测（2026-10-02，tools/probe-cloudbase.js 打真接口）→ **500** + `error:"unknown"`
 *     + `"invalid token header"`
 *   只看 status 的话，一次真过期会被归进「网络问题」分支 ⇒ 凭证不清、
 *   用户永远卡在「续期失败请检查网络」，而正确做法是重新登录。
 *   ⇒ 见 credentialDead()，判据同时看 code 和服务端描述里的关键词。
 *
 * ⚠ 本地后端不适用上面这条：它由**我们自己**写，`/auth/whoami` 对失效令牌
 *   老老实实回 401 + ok:false ⇒ 判据可以简单直接（见 getAccessToken 的 local 分支）。
 */
const storage = require('../platform/storage.js');
const cbsdk = require('./cbsdk.js');

/** 本机凭证的存储键 */
const KEY = 'paipan_cbsession_v1';

/**
 * 设备码的存储键 —— 与 core/auth.js 的 ANON_KEY **必须一致**。
 * ⚠ 这里直接读 auth 的 key 而不是依赖 auth 模块，是为了避免循环依赖
 *   （auth 依赖本模块）。两者一致性由测试守着。
 */
const ANON_KEY = 'paipan_anon_v1';

/** 提前量：剩余寿命少于它就当作「要过期」，提前刷新，避免「刚发出去就过期」 */
const SKEW_MS = 5 * 60 * 1000;

/**
 * 当前后端**有没有**续期能力。
 *
 * ⚠⚠ 本地 paipan-server **没有** refresh 接口（令牌 30 天，到期重新登录）⇒ false。
 *   这个开关的意义是让 getAccessToken() 不要明知没有续期接口还去发请求 ——
 *   那样用户在到期时会收到一句「续期失败，请检查网络」，把「该重新登录了」
 *   误导成「网络有问题」（正是文件头警告的那类误诊）。
 *
 * ⚠ 现取而不是模块加载时定死：测试会改 storeMode.MODE 来切换后端。
 */
function hasRefresh() {
  try {
    return require('./storeMode.js').MODE !== 'local';
  } catch (err) {
    return true; /* 读不到配置时按「有」处理：宁可多试一次续期，也别把一个能自愈的后端当成不能 */
  }
}

/** 在飞的刷新（并发去重，见文件头） */
let inflight = null;

/** 可注入的时钟（测试用） */
let nowFn = function () { return Date.now(); };

/* ------------------------------------------------------------ 存取 */

/**
 * 同步读回本机凭证。
 * ⚠ storage 是字符串存储（见 platform/storage.js），写进去的对象会被 stringify，
 *   读出来必须 parse —— 少了这一步 `s.accessToken` 恒为 undefined，
 *   表现为「明明登录过却永远是未登录」。
 */
function read() {
  try {
    const raw = storage.getStorageSync(KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn('[paipan] 读取登录凭证失败', err);
    return null;
  }
}

function write(s) {
  try {
    storage.setAndPersist(KEY, JSON.stringify(s));
  } catch (err) {
    console.warn('[paipan] 写入登录凭证失败', err);
  }
  return s;
}

/**
 * 保存一对令牌。
 * ⚠⚠ 必须 accessToken 与 refreshToken **一起**存 —— 刷新后旧 refresh_token 已作废，
 *    只更新 accessToken 会让下一次刷新拿着废票去换，直接掉线。
 *    （本地后端没有 refreshToken，存进来就是空串 —— 这是**如实**，不是遗漏。）
 *
 * @param {Object} tokens 驱动返回的 tokens：{ accessToken, refreshToken, expireIn, sub|uid }
 * @param {Object} [extra] 额外要记住的（如 username / phone）
 */
function save(tokens, extra) {
  const t = tokens || {};
  const at = nowFn();
  const expireIn = t.expireIn || 7200;

  /**
   * ⚠⚠ 两个后端给 uid 的**字段名不同**，两个都要认：
   *   · CloudBase 的叫 `sub`（JWT 的 sub，19 位 bigint）
   *   · 本地后端叫 `uid`（我们自己签的 `u`+32hex）
   *   少认一个的后果是 uid 恒为空 ⇒ 上层判「未登录」⇒ 用户明明登录了却一直被踢去登录页。
   *   这里统一收敛成内部字段 `sub`（保持既有字段名不变，userStore 不用改）。
   */
  const sub = t.sub || t.uid || '';

  // sub 变了 = 换了个账号登录 → 沿用旧 sub 会造成「显示的还是上一个人」
  const prev = read();
  if (prev && prev.sub && sub && prev.sub !== sub) {
    console.log('[paipan] 登录账号发生变化，已切换到新账号');
  }

  const next = {
    accessToken: t.accessToken || '',
    refreshToken: t.refreshToken || '',
    sub: sub || (prev && prev.sub) || '',
    expireAt: at + expireIn * 1000,
    loginAt: at
  };
  if (extra && extra.phone) next.phone = extra.phone;
  else if (prev && prev.phone) next.phone = prev.phone;
  // ⚠ username 与 phone 用同一套「沿用」规则，而且**沿用是必须的**：
  //   刷新令牌时调的是 `save(r.tokens)`（**不带 extra**），
  //   不沿用的话每次自动续期都会把账号名抹掉，设置页就变成空白。
  //   而登录成功时一定带着 username 进来 ⇒ 换账号不会残留上一任的名字。
  if (extra && extra.username) next.username = extra.username;
  else if (prev && prev.username) next.username = prev.username;
  if (extra && extra.deviceCode) next.deviceCode = extra.deviceCode;
  else if (prev && prev.deviceCode) next.deviceCode = prev.deviceCode;

  inflight = null;      // 有了新令牌，在飞的刷新结果不再需要
  return write(next);
}

/** 清掉本机凭证（真过期 / 用户主动退出）。⚠ 不碰设备码 —— 它不是凭证 */
function clear() {
  inflight = null;
  try {
    storage.removeStorageSync(KEY);
    storage.persistKey(KEY).catch(function () {});
  } catch (err) {
    console.warn('[paipan] 清除登录凭证失败', err);
  }
}

/** 脱敏视图（页面展示用，不带 token 本体） */
function get() {
  const s = read();
  if (!s) return null;
  return {
    sub: s.sub || '',
    phone: s.phone || '',
    // 当前登录的账号名（用户名密码登录时可显示；短信登录时为空）
    username: s.username || '',
    loginAt: s.loginAt || 0,
    expireAt: s.expireAt || 0,
    // ⚠ 本地后端恒为 false（没有 refresh_token）。页面据此可以把「自动续期」的
    //   说法去掉，改成「登录有效期 30 天」—— 别承诺一个做不到的能力。
    hasRefresh: !!s.refreshToken
  };
}

/** 用户 ID（CloudBase 的 sub）。没有就是空串 */
function uid() {
  const s = read();
  return (s && s.sub) || '';
}

/** 本机有没有可用于访问数据的凭证（不判断是否过期 —— 那个交给 getAccessToken） */
function hasSession() {
  const s = read();
  return !!(s && s.accessToken);
}

/** 当前的设备码（与 auth.js 同一份）。空串表示还没生成 */
function deviceId() {
  try { return storage.getStorageSync(ANON_KEY) || ''; } catch (err) { return ''; }
}

/** access_token 是不是已经在「提前量」之内（即为将来判断成要刷新） */
function needsRefresh() {
  const s = read();
  if (!s || !s.accessToken) return false;
  return !(s.expireAt && s.expireAt - nowFn() > SKEW_MS);
}

/**
 * 这次刷新失败，是不是意味着「凭证已经不可能是好的了」？
 *
 * ⚠⚠ 存在的唯一原因：实测发现**文档与真机不一致**（见文件头）。
 *   ⇒ 判据必须**同时看 code 和「服务端描述里的关键词」**，不能只看 HTTP 状态码。
 *
 * ⚠ 反向也要守住：服务端真的抽风（真 5xx 内部错误）时描述里不会有 token 字样，
 *   会被归入「网络失败」→ 保留凭证下次重试。不能让一次服务端波动把用户踢下线。
 *
 * ⚠ 这条只服务于 **CloudBase**（本地后端没有 refresh，走不到这里）。
 */
function credentialDead(r) {
  const code = String((r && r.code) || '').toLowerCase();
  if (code === 'invalid_grant' || code === 'invalid_token' || code === 'unauthenticated') return true;
  const desc = String((r && r.data && (r.data.error_description || r.data.message)) || '').toLowerCase();
  return /invalid token|invalid jwt|malformed jwt|token header|token has expired|token expired|invalid_grant/.test(desc);
}

/**
 * 拿一个**现在能用**的 access_token；快过期就自动续期。
 *
 * @returns {Promise<{ok:boolean, token?:string, error?:string, code?:string}>}
 *          永不 reject
 */
function getAccessToken() {
  const s = read();
  if (!s || !s.accessToken) {
    return Promise.resolve({ ok: false, code: 'NO_SESSION', error: '还没有登录' });
  }
  if (s.expireAt && s.expireAt - nowFn() > SKEW_MS) {
    return Promise.resolve({ ok: true, token: s.accessToken });
  }

  /**
   * ⚠⚠ 没有续期能力的后端（本地）：**不要**去发那个不存在的 refresh 请求。
   *
   *   判据分两种：
   *     · 快到点但**还没真的过期**（在 SKEW 窗口内）→ 仍然把这枚令牌交出去。
   *       理由是「提前量」本来就是保守估计，令牌此刻其实还能用；
   *       直接判过期会把用户提前 5 分钟踢下线，而那个请求本来会成功。
   *     · **已经过了 expireAt** → 真的没得救，清掉凭证、让上层引导重新登录。
   *       （措辞是「登录已过期，请重新登录」而不是「续期失败，请检查网络」——
   *        后者会把用户引去查网络，而他其实只需要重新登录一次。）
   */
  if (!hasRefresh()) {
    if (s.expireAt && s.expireAt - nowFn() > 0) {
      return Promise.resolve({ ok: true, token: s.accessToken });
    }
    clear();
    return Promise.resolve({ ok: false, code: 'EXPIRED', error: '登录已过期，请重新登录' });
  }

  // ⚠ 并发去重：见文件头。第二个调用直接复用第一个的结果，
  //   绝不能拿着同一个（马上要作废的）refresh_token 再刷一次。
  if (inflight) return inflight;

  if (!s.refreshToken) {
    clear();
    return Promise.resolve({ ok: false, code: 'EXPIRED', error: '登录已过期，请重新登录' });
  }

  const p = cbsdk.refresh(s.refreshToken, { deviceId: deviceId() }).then(function (r) {
    if (r.ok) {
      save(r.tokens);
      return { ok: true, token: r.tokens.accessToken, refreshed: true };
    }
    // 凭证本身废了 → 清掉，让用户重新登录。
    // ⚠ 判据见 credentialDead()：**不能只看 status**，实测真过期回的是 500 而非 400/401
    if (credentialDead(r)) {
      clear();
      return { ok: false, code: 'EXPIRED', error: '登录已过期，请重新登录' };
    }
    // 网络失败 → **保留**凭证，下次再试（把网络抖动当成过期会白白踢掉用户）
    return { ok: false, code: r.code || 'NETWORK', error: r.error || '续期失败，请检查网络' };
  });

  const done = function () { if (inflight === p) inflight = null; };
  p.then(done, done);
  inflight = p;
  return p;
}

/* ------------------------------------------------------------ 测试用 */

function _setNow(fn) { nowFn = fn || function () { return Date.now(); }; }
function _reset() { inflight = null; nowFn = function () { return Date.now(); }; }

module.exports = {
  KEY: KEY,
  ANON_KEY: ANON_KEY,
  SKEW_MS: SKEW_MS,
  read: read,
  save: save,
  clear: clear,
  get: get,
  uid: uid,
  hasSession: hasSession,
  hasRefresh: hasRefresh,
  deviceId: deviceId,
  needsRefresh: needsRefresh,
  credentialDead: credentialDead,
  getAccessToken: getAccessToken,
  _setNow: _setNow,
  _reset: _reset
};
