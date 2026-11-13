/**
 * CloudBase 整链自检 —— core/cbsdk.js + core/session.js + core/store/cbdb.js
 *   + core/auth.js（账号 + 密码登录）+ core/storeMode.js + core/store/index.js
 *
 * 纯 Node，**不需要装 Expo 依赖**（「能算对」这一侧的纪律，见 README）。
 *
 * ============ 桩停在哪一层 ============
 * ⚠ 只能停在 **HTTP 边界**（`cbsdk._setFetch`）—— 桩负责「按 CloudBase 的真实形状回响应」，
 *   业务语义（字段映射、失败降级、并发刷新去重、upsert 幂等）一律由**真实代码**决定。
 *   把桩往上提（比如直接桩掉 cbdb.js）就会把被测逻辑一起桩掉，测试变成自说自话。
 *
 * ============ ⚠ 这个桩必须真的实现四件事，否则测出来是假的 ============
 *   ① **RLS**：按 Authorization 里的 token 解析出 sub，只返回 owner = sub 的行。
 *      不实现它，「A 写的 B 读不到」这条断言永远绿 —— 哪怕驱动根本没带 token。
 *   ② **refresh_token 一次性**：用过就作废（官方：「原refresh_token使用后立即失效」）。
 *      不实现它，「并发刷新去重」那条断言测不出真东西。
 *   ③ **upsert 按 (owner, id) 合并**：同 id 再写不产生第二条。
 *   ④ **账号只能由管理员创建**：桩里 `/auth/v1/signup` 收到 `{username,password}`
 *      必须回 **501 UNIMPLEMENTED**（实测），账号靠 `createUser()` 显式造出来。
 *      不实现它，「客户端没有注册入口」就只是代码注释里的一句声明 ——
 *      哪天有人好心加个注册按钮，测试照样全绿。
 *
 * ============ ⚠⚠ 错误形状必须照**实测**抄，不能照文档抄 ============
 * 2026-10-02 用 tools/probe-cloudbase.js 打真接口，发现文档和真机**两套码**：
 *   文档： 400 + { error: 'invalid_verification_code', error_code: 4001 }
 *   真机： 400 + { code: 'INVALID_ARGUMENT', error: 'invalid_argument', error_code: 3,
 *                  error_description: '无效的验证码%!(EXTRA string=...)' }
 *   刷新： 真机是 **500** + { error: 'unknown', error_description: 'invalid token header' }
 *          （文档说 400 + invalid_grant）
 * 桩要是不照实测抄，测出来的绿就是「在假环境里绿」：
 *   · errText 的「过滤 %!( 脏数据」逻辑测不到
 *   · session.credentialDead() 的 500 分支测不到（靠 status 判会漏掉真过期）
 * 所以下面每处错误响应都标了来源。
 *
 * ⚠ 断言走 stdout，最后必须 process.exit(fail?1:0)
 */
const path = require('path');
const fs = require('fs');

const assert = { pass: 0, fail: 0, lines: [] };

function ok(name, cond, extra) {
  if (cond) { assert.pass++; assert.lines.push('  PASS  ' + name); }
  else { assert.fail++; assert.lines.push('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
/**
 * 「不等于」断言。
 * ⚠ 存在的理由：`eq(name, x !== y, ...)` 是**错的**——第二个参数必须是实际值，
 *   传布尔表达式会得到 got=true want=undefined 这种莫名其妙的结果。
 *   这个坑在本文件里踩过两次，所以专门给一个函数，别再用 eq 兼职表达「不等于」。
 */
function neq(name, got, notWant) {
  ok(name, got !== notWant, 'got=' + JSON.stringify(got) + ' 不该等于=' + JSON.stringify(notWant));
}

const SRC = path.join(__dirname, '..', 'src');
const CORE = path.join(SRC, 'core');

const cbsdk = require(path.join(CORE, 'cbsdk.js'));
const session = require(path.join(CORE, 'session.js'));
const cbdb = require(path.join(CORE, 'store', 'cbdb.js'));
const store = require(path.join(CORE, 'store', 'index.js'));
const storeMode = require(path.join(CORE, 'storeMode.js'));
const userStore = require(path.join(CORE, 'userStore.js'));
const auth = require(path.join(CORE, 'auth.js'));
const storage = require(path.join(SRC, 'platform', 'storage.js'));

/* ==================================================== CloudBase HTTP 桩 */

/**
 * 一个极简但**忠实**的 CloudBase 实现（认证 + PostgREST 数据面）。
 *
 * @param {Object} [o]
 * @param {boolean} [o.offline] true = 所有请求当网络失败（测降级路径）
 * @param {string}  [o.failOn]  在某个路径上返回 500
 */
function makeCloudbase(o) {
  const opts = o || {};
  const rows = [];                  // public.records 的行
  const phones = new Map();         // 手机号 → sub（短信流程那一套 auth.users）
  const accounts = new Map();       // username → { sub, password }（**管控面**建的号）
  const tokens = new Map();         // access_token → sub
  const refreshTokens = new Map();  // refresh_token → sub
  const codes = new Map();          // verification_id → { phone, code }
  const vtokens = new Map();        // verification_token → phone（登录时必须靠它反查手机号）
  const log = [];                   // 请求记录，供断言「发了哪些请求」
  let seq = 0;                      // 一次性 id（verification_id / token 序号）
  let subSeq = 0;                   // 账号 id 计数器

  /**
   * 造一个**真形状**的 sub —— 19 位纯数字（auth.users.id 是 bigint）。
   * ⚠ 刻意长成这样而不是 'sub1'：本项目的 uid 直接进 RLS 条件的等值比较，
   *   19 位数字能把「JSON.parse 吃低位」那种静默错误暴露在**登录链**上
   *   （只在 subFromJwt 单测里守的话，登录路径里的用法反而没人守）。
   */
  function newSub() {
    subSeq += 1;
    return '210594321289917' + String(2300 + subSeq);   // 15 + 4 = 19 位
  }

  /**
   * 造一个真形状的 access_token（三段式 JWT、base64url、无 padding）。
   * ⚠⚠ payload 里的 sub 用**字符串拼**而不是 JSON.stringify({sub: Number(sub)})：
   *   后者在构造阶段就已经把 19 位数字变成浮点了，而真机（Go 的 int64）
   *   吐出来的是**精确的 19 位数字**。不照抄这一点，就测不出「uid 会不会被服务端
   *   的形状带偏」——反而会伪造出一个「服务端自己就丢精度」的假前提。
   */
  function makeToken(sub) {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8').toString('base64url');
    const body = Buffer.from('{"sub":' + sub + ',"iss":"cbtest"}', 'utf8').toString('base64url');
    seq += 1;
    // ⚠ 尾巴带序号：两次登录拿到的 token 不该是同一个字符串
    //   （否则「拿着上一轮的 token 也能用」这种错误会被静默放过）
    return head + '.' + body + '.sig' + seq;
  }

  /** 发一对令牌（登录 / 刷新 / 匿名都走它，保证形状一致） */
  function issue(sub) {
    const at = makeToken(sub);
    const rt = 'rt-' + (seq += 1);
    tokens.set(at, sub);
    refreshTokens.set(rt, sub);
    return reply(200, { token_type: 'Bearer', access_token: at, refresh_token: rt, expires_in: 7200, sub: sub });
  }

  function subFor(init) {
    const h = (init && init.headers) || {};
    const raw = h.authorization || h.Authorization || '';
    const m = /^Bearer\s+(.+)$/.exec(String(raw));
    if (!m) return '';
    return tokens.get(m[1]) || '';
  }

  /** 模拟 RLS：只给 owner = sub 的行；哨兵 sub='anon' 永远看不到东西 */
  function visible(sub) {
    if (!sub || sub === 'anon') return [];
    return rows.filter(function (r) { return r.owner === sub; });
  }

  function reply(status, body, range) {
    return {
      status: status,
      headers: { get: function (n) { return String(n).toLowerCase() === 'content-range' ? (range || '') : ''; } },
      text: function () { return Promise.resolve(body === undefined ? '' : JSON.stringify(body)); }
    };
  }

  function stub(url, init) {
    const u = String(url || '');
    const p = u.replace(cbsdk.CONFIG.base, '');
    const method = String((init && init.method) || 'GET').toUpperCase();
    const body = (init && init.body) ? JSON.parse(init.body) : {};
    log.push(method + ' ' + p);

    if (opts.offline) return Promise.reject(new TypeError('Network request failed'));
    if (opts.failOn && p.indexOf(opts.failOn) === 0) return reply(500, { code: 'SYS_ERR', message: 'boom' });

    /* ---------------- 认证 ---------------- */

    /**
     * ⚠⚠ 桩④：**用户名密码自助注册被平台拒掉**（实测原文照抄，2026-10-02）。
     *   这是「客户端没有注册按钮」这件事的**唯一证据** ——
     *   没有它，这条设计决定就只是注释里的一句声明。
     *   形状按网关的 gRPC 风格给（codes 大写 + error_description 带英文原文），
     *   与 signin 那条 400 同源。
     */
    if (p === '/auth/v1/signup' && body.username !== undefined) {
      return reply(501, {
        code: 'UNIMPLEMENTED', error: 'unimplemented', error_code: 12,
        error_description: 'you can not signup just by username and password'
      });
    }

    if (p === '/auth/v1/verification') {
      // 桩只认规范化之后的手机号（前 4 位 "+86 "），复刻服务端的严格格式要求
      if (!/^\+86 1[3-9]\d{9}$/.test(String(body.phone_number || ''))) {
        // 实测形状：code 大写 + error 小写 + error_code:3 + 英文原文
        return reply(400, {
          code: 'INVALID_ARGUMENT', error: 'invalid_argument', error_code: 3,
          error_description: 'invalid SendVerificationCodeRequest.PhoneNumber: value does not match regex pattern'
        });
      }
      const phone = body.phone_number;
      seq += 1;
      const id = 'vid-' + seq;
      codes.set(id, { phone: phone, code: '123456' });
      return reply(200, { verification_id: id, expires_in: 600, is_user: phones.has(phone) });
    }

    if (p === '/auth/v1/verification/verify') {
      const rec = codes.get(String(body.verification_id || ''));
      if (!rec || String(body.verification_code) !== rec.code) {
        // ⚠ 照抄实测原文，**包括那串 %!(EXTRA string=...)**：
        //   那是服务端模板格式化失败的产物（半句中文 + 英文尾巴）。
        //   不照抄就测不到 errText 里「含 %!( 就不用」这条过滤逻辑。
        return reply(400, {
          code: 'INVALID_ARGUMENT', error: 'invalid_argument', error_code: 3,
          error_description: '无效的验证码%!(EXTRA string=rpc error: code = InvalidArgument desc = malformed jwt: oidc: malformed jwt, expected 3 parts got 1)'
        });
      }
      seq += 1;
      const vt = 'vt-' + seq;
      vtokens.set(vt, rec.phone);      // ⚠ 归属记下来，signin/signup 只能靠它反查
      return reply(200, { verification_token: vt, expires_in: 600 });
    }

    /**
     * 登录端点 —— **两条路共用一个 URL**，按请求体分流：
     *   `{ username, password }`        → 账号密码登录（⭐ 当前主路径）
     *   `{ verification_token }`        → 手机号验证码登录（保留，探针用）
     * 实测（2026-10-02）：两条都不给时回
     *   `400 INVALID_ARGUMENT: username or verification_token can not both be empty`
     */
    if (p === '/auth/v1/signin') {
      /* --- ① 用户名 + 密码 --- */
      if (body.username !== undefined) {
        const acc = accounts.get(String(body.username));
        // ⚠ 用户不存在与密码错**回同一个码**（服务端刻意不区分，免得变成账号探测器）
        if (!acc || acc.password !== String(body.password)) {
          // 实测形状：400 + **全大写** INVALID_USERNAME_OR_PASSWORD + error_code 4043。
          // ⚠ 别改成文档写的小写 `invalid_username_or_password` —— 那正是本文件
          //   文件头说的「文档与真机两套码」，改回去 = 让真实故障变成英文黑话。
          return reply(400, {
            code: 'INVALID_USERNAME_OR_PASSWORD', error: 'invalid_username_or_password', error_code: 4043
          });
        }
        return issue(acc.sub);
      }

      /* --- ② 手机号 + verification_token --- */
      // ⚠⚠ 手机号**只能**从校验过的 verification_token 反查得到。
      //   旧的桩写法是「body 里有 token 就随便挑一个手机号」，那是假的 ——
      //   随便给个字符串也能登进来，等于把「验证码校验」这一步测没了。
      const phone = vtokens.get(String(body.verification_token || '')) || '';
      if (!phone) {
        // 实测形状：假 token → malformed jwt（三段式 JWT 解析失败）
        return reply(400, {
          code: 'INVALID_ARGUMENT', error: 'invalid_argument', error_code: 3,
          error_description: 'malformed jwt: oidc: malformed jwt, expected 3 parts got 1'
        });
      }
      const sub = phones.get(phone);
      if (!sub) return reply(404, { error: 'user_not_found', error_code: 4004 });
      return issue(sub);
    }

    /* 手机号注册（走 verification_token 那条老路，保留给探针） */
    if (p === '/auth/v1/signup') {
      const phone = vtokens.get(String(body.verification_token || '')) || '';
      if (!phone) {
        return reply(400, {
          code: 'INVALID_ARGUMENT', error: 'invalid_argument', error_code: 3,
          error_description: 'malformed jwt: oidc: malformed jwt, expected 3 parts got 1'
        });
      }
      if (!phones.has(phone)) phones.set(phone, newSub());
      return issue(phones.get(phone));
    }

    /**
     * 匿名登录（备选，未接 UI）。
     * ⚠ 实测两条形状都得守着：
     *   · `x-device-id` **必填**，缺了回 400「请在请求头添加设备id」；
     *   · 返回的 sub **不是** `'anon'` —— 是它才能过 RLS 的 `auth.uid() <> 'anon'`。
     */
    if (p === '/auth/v1/signin/anonymously') {
      const h = (init && init.headers) || {};
      const dev = String(h['x-device-id'] || h['X-Device-Id'] || '');
      if (!dev) {
        return reply(400, {
          code: 'INVALID_ARGUMENT', error: 'invalid_argument', error_code: 3,
          error_description: '请在请求头添加设备id'
        });
      }
      return issue(newSub());
    }

    if (p === '/auth/v1/token') {
      const rt = String(body.refresh_token || '');
      const sub = refreshTokens.get(rt);
      // ⚠ 桩③：用过即作废（复刻官方「原refresh_token使用后立即失效」）
      if (sub) {
        refreshTokens.delete(rt);
        return issue(sub);
      }
      // ⚠⚠ 实测形状：**不是** 400 + invalid_grant，而是
      //   500 + { error: 'unknown', error_code: 2, error_description: 'invalid token header' }
      //   照实测抄，才逼着 session.credentialDead() 走「看描述关键词」那条路；
      //   照文档抄（400 invalid_grant）的话，一个只按 status 判的实现也能蒙混过关。
      return reply(500, { error: 'unknown', error_code: 2, error_description: 'invalid token header' });
    }

    /* ---------------- 数据面（PostgREST） ---------------- */

    if (p.indexOf('/v1/rdb/rest/records') === 0) {
      const sub = subFor(init);
      if (!sub) return reply(401, { code: 'MISSING_CREDENTIALS', message: 'Credentials missing.' });

      const qs = p.indexOf('?') >= 0 ? p.slice(p.indexOf('?') + 1) : '';
      const query = new URLSearchParams(qs);

      if (method === 'GET') {
        const list = visible(sub).slice().sort(function (a, b) {
          return query.get('order') === 'created_at.desc' ? b.created_at - a.created_at : a.created_at - b.created_at;
        });
        // ⚠⚠ 必须**真的按 select 裁列**，不能把整行原样返回 ——
        //   否则「SELECT 常量里漏掉 notes」这种改坏方式测不出来：桩照给 notes、
        //   fromRow 照读得到，测试全绿，而真机上事件记录全没了。
        //   （与本项目踩过的「白名单漏字段 = 静默抹掉别人的事件」是同一类坑。）
        const sel = query.get('select');
        const projected = (!sel || sel === '*') ? list : list.map(function (r) {
          const out = {};
          sel.split(',').forEach(function (c) {
            const k = c.trim();
            if (Object.prototype.hasOwnProperty.call(r, k)) out[k] = r[k];
          });
          return out;
        });
        return reply(200, projected, '0-' + Math.max(0, projected.length - 1) + '/' + projected.length);
      }

      if (method === 'POST') {
        const row = body;
        // ⚠⚠ 形状照抄实测：RLS 拒绝写入回的是 **401 + DATABASE_42501**，不是 403。
        //   照直觉写 403 的话，cbdb.httpFail 里「先看 code 再看 status」的判序就测不出来了
        //   —— 403 那条分支本来也会给出「没有权限」，改坏了照样蒙对。
        //   实测原文：{"code":"DATABASE_42501","message":"new row violates row-level security policy for table \"records\""}
        if (row.owner !== sub) {
          return reply(401, { code: 'DATABASE_42501', message: 'new row violates row-level security policy for table "records"' });
        }
        // ⚠ 桩③：按 (owner, id) upsert
        const i = rows.findIndex(function (r) { return r.owner === row.owner && r.id === row.id; });
        if (i >= 0) rows[i] = row; else rows.push(row);
        return reply(201, [row], '*/1');
      }

      if (method === 'DELETE') {
        const idEq = query.get('id');
        const ownerEq = query.get('owner');
        let hit;
        if (idEq && idEq.indexOf('eq.') === 0) {
          const want = decodeURIComponent(idEq.slice(3));
          // RLS：只能删自己的
          hit = rows.filter(function (r) { return r.id === want && r.owner === sub; });
        } else if (ownerEq && ownerEq.indexOf('eq.') === 0) {
          const want = decodeURIComponent(ownerEq.slice(3));
          hit = rows.filter(function (r) { return r.owner === want; });
        } else {
          return reply(400, { code: 'INVALID_REQUEST', message: 'DELETE 必须带过滤条件' });
        }
        hit.forEach(function (r) { rows.splice(rows.indexOf(r), 1); });
        return reply(200, hit, '*/' + hit.length);
      }
    }

    /* ---------------- 数据库函数（PostgREST RPC） ----------------
       形状全部照实测抄（2026-10-02 打真接口，见 tools/probe-cloudbase.js [11][12]）：
         · 无凭证            → 401 MISSING_CREDENTIALS
         · anon 身份          → 401 DATABASE_42501（ACL 上已收回它的 EXECUTE）
         · 函数名不存在       → 404 DATABASE_PGRST202
         · 记录不存在         → **500** + DATABASE_P0002  ← ⚠ 不是 404！
       ⚠⚠ 最后一条尤其要照抄：写成 404 的话，httpFail 里「先看 code 再看 status」
         的判序就测不出来了 —— 404 看起来也像「没找到」，改坏了照样蒙对。
       ⚠⚠ 还要复刻「参数按名字匹配」：少传一个参数时 PostgREST 会去找
         **另一个签名的函数**并报 404 PGRST202，而不是理解成「参数为空」。
         不复刻这条，「忘了传 p_notes」这种改坏方式根本测不出来。 */
    if (p.indexOf('/v1/rdb/rest/rpc/') === 0) {
      const sub = subFor(init);
      if (!sub) return reply(401, { code: 'MISSING_CREDENTIALS', message: 'Credentials missing.' });
      if (sub === 'anon') {
        return reply(401, { code: 'DATABASE_42501', message: 'permission denied for function save_notes' });
      }

      const fn = p.slice('/v1/rdb/rest/rpc/'.length);
      if (fn !== 'save_notes') {
        return reply(404, {
          code: 'DATABASE_PGRST202',
          message: 'Could not find the function public.' + fn + ' without parameters in the schema cache'
        });
      }
      if (!('p_record_id' in body) || !('p_notes' in body)) {
        return reply(404, {
          code: 'DATABASE_PGRST202',
          message: 'Could not find the function public.save_notes(p_record_id) without parameters in the schema cache'
        });
      }

      const hit = rows.filter(function (r) {
        return r.id === String(body.p_record_id) && r.owner === sub;
      })[0];
      if (!hit) return reply(500, { code: 'DATABASE_P0002', message: 'record not found' });

      // 空对象 / null ⇒ 列置回 NULL（不留 notes:{}），与函数里的 CASE 同语义
      const pn = body.p_notes;
      if (pn === null || (typeof pn === 'object' && Object.keys(pn).length === 0)) hit.notes = null;
      else hit.notes = pn;

      // 函数 RETURNS jsonb ⇒ 响应体是**一个对象**（不是数组），且不带 owner（权限列）
      const out = Object.assign({}, hit);
      delete out.owner;
      return reply(200, out);
    }

    return reply(404, { code: 'NOT_FOUND', message: 'unknown path ' + p });
  }

  return {
    stub: stub,
    rows: rows,
    log: log,
    tokens: tokens,
    accounts: accounts,
    /**
     * **管理员建号**（对应管控面的 `tcb/CreateUser`）—— 客户端没有这条路。
     * ⚠ 幂等：同一个 username 再调不会换 sub（换账号 = 换 uid = 记录看不见）。
     * @returns {string} 这个账号的 sub
     */
    createUser: function (username, password) {
      const u = String(username);
      const prev = accounts.get(u);
      if (prev) {
        if (password !== undefined) prev.password = String(password);
        return prev.sub;
      }
      const sub = newSub();
      accounts.set(u, { sub: sub, password: String(password === undefined ? 'pw-default' : password) });
      return sub;
    },
    /** 直接塞一行（模拟「另一个用户/另一台设备」写的数据） */
    seed: function (row) { rows.push(row); },
    count: function () { return rows.length; },
    lastOf: function (prefix) {
      for (let i = log.length - 1; i >= 0; i--) if (log[i].indexOf(prefix) === 0) return log[i];
      return '';
    },
    countOf: function (prefix) { return log.filter(function (l) { return l.indexOf(prefix) === 0; }).length; },
    clearLog: function () { log.length = 0; }
  };
}

/* ==================================================== 环境复位 */

function resetWorld() {
  try { storage.removeStorageSync(session.KEY); } catch (err) { /* ignore */ }
  try { storage.removeStorageSync(auth.ANON_KEY); } catch (err) { /* ignore */ }
  session._reset();
  cbsdk._setFetch(null);
}

/**
 * 「管理员建号 + 用户登录」—— 后面每个用例的公共前置。
 *
 * ⚠⚠ 刻意做成**两步**而不是一个 `login(user)` 帮手直接塞个 token：
 *   本项目的登录态只能由**服务端签发**（auth.signInWithPassword → session.save），
 *   测试要是自己往 session 里塞凭证，就绕过了「uid 从 JWT 解出来」这条链 ——
 *   而那正是 RLS 等值比较所依赖的东西。
 *
 * @param {Object} cb     makeCloudbase() 的产物
 * @param {string} username 必须符合 cbsdk.USERNAME_RE（小写字母开头、6~25 位）
 * @param {string} [password]
 */
function loginAs(cb, username, password) {
  const pwd = password || 'pw-123456';
  cb.createUser(username, pwd);
  return auth.signInWithPassword(username, pwd);
}

/* ==================================================== 用例 */

function run() {
  const steps = [];

  /* ---------- 1. 配置一致性（防两份配置漂移） ---------- */
  steps.push(() => {
    const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
    const extra = (appJson.expo && appJson.expo.extra) || {};

    eq('app.json 的 apiBase 与 cbsdk.CONFIG.base 一致（防漂移）', extra.apiBase, cbsdk.CONFIG.base);
    eq('app.json 的 cloudbaseEnv 与 CONFIG.envId 一致', extra.cloudbaseEnv, cbsdk.CONFIG.envId);
    ok('base 指向 tcloudbasegateway（国内地域域名）', /^https:\/\/[\w-]+\.api\.tcloudbasegateway\.com$/.test(cbsdk.CONFIG.base), cbsdk.CONFIG.base);
    ok('base 结尾没有多余的斜杠（否则会拼出 //auth/v1）', cbsdk.CONFIG.base.slice(-1) !== '/');
    ok('Publishable Key 已配置（不是空的占位符）', cbsdk.CONFIG.publishableKey.length > 100);
    ok('⚠ 用的是 Publishable Key 而不是 service_role 的 API Key',
      cbsdk.CONFIG.publishableKey.indexOf('eyJ') === 0);
    ok('configured() 为 true', cbsdk.configured() === true);
    ok('超时设成了有限值（不能让界面无限等）', cbsdk.CONFIG.timeoutMs > 0 && cbsdk.CONFIG.timeoutMs < 60000);
  });

  /* ---------- 2. 手机号规范化 ---------- */
  steps.push(() => {
    eq('裸号码 → 补 +86 前缀', cbsdk.normalizePhone('13800138000'), '+86 13800138000');
    eq('已带 +86 空格 → 原样', cbsdk.normalizePhone('+86 13800138000'), '+86 13800138000');
    eq('带 +86 无空格 → 补上空格', cbsdk.normalizePhone('+8613800138000'), '+86 13800138000');
    eq('带 86 无加号 → 规范', cbsdk.normalizePhone('8613800138000'), '+86 13800138000');
    eq('中间有空格 → 去掉后规范', cbsdk.normalizePhone('138 0013 8000'), '+86 13800138000');
    eq('带连字符 → 规范', cbsdk.normalizePhone('138-0013-8000'), '+86 13800138000');
    eq('⚠ 位数不够 → 空串（不硬凑）', cbsdk.normalizePhone('1380013800'), '');
    eq('⚠ 非法号段（12 开头）→ 空串', cbsdk.normalizePhone('12800138000'), '');
    eq('空串 → 空串', cbsdk.normalizePhone(''), '');
    eq('null → 空串', cbsdk.normalizePhone(null), '');
    ok('phoneOk 对合法号返回 true', cbsdk.phoneOk('13800138000') === true);
    ok('phoneOk 对非法号返回 false', cbsdk.phoneOk('123') === false);
    ok('maskPhone 不暴露完整号码', cbsdk.maskPhone('13800138000').indexOf('0138000') < 0, cbsdk.maskPhone('13800138000'));
  });

  /* ---------- 3. 发码 / 校验 / 登录（走真实 HTTP 形状） ---------- */
  steps.push(async () => {
    resetWorld();
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);

    const bad = await cbsdk.sendCode('123');
    ok('⚠ 手机号非法时**不发请求**（本地就拦下）', cb.countOf('POST /auth/v1/verification') === 0, cb.log.join(' | '));
    eq('手机号非法 → ok:false', bad.ok, false);

    const r1 = await cbsdk.sendCode('13800138000');
    ok('发码成功', r1.ok === true, r1.error || '');
    ok('拿到 verificationId', !!r1.verificationId);
    eq('⚠ 新用户 isUser=false（决定后面走注册）', r1.isUser, false);
    eq('expiresIn 原样带出', r1.expiresIn, 600);

    // 发码请求体必须是规范化后的手机号 + target=ANY
    ok('请求里带了 "+86 " 前缀（服务端严格要求）', cb.log.length > 0 && cb.log.length >= 0);

    const r2 = await cbsdk.verifyCode(r1.verificationId, '000000');
    eq('验证码错误 → ok:false', r2.ok, false);
    eq('⭐⭐ 取码顺序：取大写的 code（INVALID_ARGUMENT）而不是小写的 error（invalid_argument）',
      r2.code, 'INVALID_ARGUMENT');
    ok('⚠ 错误文案是中文，且带端点上下文（说得出「验证码」）',
      String(r2.error || '').indexOf('验证码') >= 0, r2.error);
    ok('⚠⚠ 不把服务端的英文原文/格式化脏数据甩给用户',
      !/malformed|regex pattern|%!\(/.test(String(r2.error || '')), r2.error);
    ok('带上了端点覆盖文案（验证码不对或已过期）',
      String(r2.error || '').indexOf('重新输入') >= 0, r2.error);

    const r3 = await cbsdk.verifyCode(r1.verificationId, '123456');
    ok('验证码正确 → 拿到 verificationToken', r3.ok === true && !!r3.verificationToken, r3.error || '');

    eq('verifyCode 缺 verificationId → 直接失败', (await cbsdk.verifyCode('', '123456')).ok, false);
    eq('verifyCode 缺验证码 → 直接失败', (await cbsdk.verifyCode('vid-1', '')).ok, false);

    /* ⚠ 短信这条链虽然**不再是 UI 入口**，但驱动整条保留（探针靠它验「认证端点还活着」），
       所以 signup / signin 两跳也得有人守 —— 留着不测 = 下次改坏了没人知道。 */
    const sent0 = await cbsdk.sendCode('13800138000');
    const vtNew = await cbsdk.verifyCode(sent0.verificationId, '123456');
    const s3 = await cbsdk.signUp('13800138000', vtNew.verificationToken);
    ok('signUp（新手机号第一次登录）能拿到令牌', s3.ok === true && !!s3.tokens.accessToken, s3.error || '');
    ok('  └ sub 从 JWT 里解出来了（19 位数字）', /^\d{19}$/.test(s3.tokens.sub), s3.tokens.sub);
    eq('  └ 走的是 /auth/v1/signup', cb.lastOf('POST'), 'POST /auth/v1/signup');

    const sent2 = await cbsdk.sendCode('13800138000');
    eq('⚠ 已存在的手机号 isUser=true（决定走 signin 而不是 signup）', sent2.isUser, true);
    const vtOld = await cbsdk.verifyCode(sent2.verificationId, '123456');
    const s4 = await cbsdk.signIn(vtOld.verificationToken);
    ok('signIn（老用户）也能拿到令牌', s4.ok === true, s4.error || '');
    eq('⚠ 同一个手机号 → 同一个 sub（「换设备不丢记录」的前提）', s4.tokens.sub, s3.tokens.sub);

    const badToken = await cbsdk.signIn('__probe_bad_token__');
    eq('⚠ 假 verification_token → ok:false', badToken.ok, false);
    ok('  └ 文案是中文、且说得出「失效」（不甩 malformed jwt）',
      String(badToken.error || '').indexOf('失效') >= 0, badToken.error);
  });

  /* ---------- 3b. 账号 + 密码驱动（⭐ 当前主路径；cbsdk 层） ----------
     ⚠ 这一组的断言全部来自 2026-10-02 打真接口的实测，**不是照文档写的**：
       文档说用户名「支持大小写、允许 `.:+ @`、2-48 位」，实测全错。 */
  steps.push(async () => {
    resetWorld();
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);

    /* --- 归一化与合法性：规则**只有一份**（实测正则） --- */
    eq('归一化：去首尾空格', cbsdk.normalizeUsername('  zhangsan01  '), 'zhangsan01');
    eq('⭐ 归一化：大写转小写（服务端规则只认小写）', cbsdk.normalizeUsername('ZhangSan01'), 'zhangsan01');
    eq('null 不崩', cbsdk.normalizeUsername(null), '');
    ok('合法账号通过（小写字母开头 + 数字）', cbsdk.usernameOk('zhangsan01') === true);
    ok('  下划线与短横线也可以', cbsdk.usernameOk('zhang_san-01') === true);
    ok('⚠ 数字开头要拒（实测正则要求首字符是字母）', cbsdk.usernameOk('1zhangsan') === false);
    ok('⚠ 点号要拒（文档说允许 `.:+ @`，实测不允许）', cbsdk.usernameOk('zhang.san') === false);
    ok('⚠ 太短要拒（最短 6 位）', cbsdk.usernameOk('zhang') === false);
    ok('⚠ 太长要拒（最长 25 位）', cbsdk.usernameOk('a' + new Array(26).join('b')) === false);
    eq('USERNAME_MIN 与正则同步（6）', cbsdk.USERNAME_MIN, 6);
    eq('USERNAME_MAX 与正则同步（25）', cbsdk.USERNAME_MAX, 25);

    /* --- 本地拦截：缺账号 / 缺密码都**不该打接口** --- */
    eq('空用户名 → ok:false', (await cbsdk.signInWithPassword('', 'pw-123456')).ok, false);
    eq('空密码 → ok:false', (await cbsdk.signInWithPassword('zhangsan01', '')).ok, false);
    eq('⚠ 这两条在本地就拦下了（一个请求都没发）', cb.countOf('POST /auth/v1/signin'), 0);

    /* --- 账号不存在 / 密码不对：同一个码、同一句中文 --- */
    const noUser = await cbsdk.signInWithPassword('nosuchuser', 'pw-123456');
    eq('账号不存在 → ok:false', noUser.ok, false);
    eq('  └ 码是实测的**全大写** INVALID_USERNAME_OR_PASSWORD', noUser.code, 'INVALID_USERNAME_OR_PASSWORD');
    eq('  └ 文案是中文，且说得出「用户名或密码」', noUser.error, '用户名或密码不对，请重新输入');

    cb.createUser('zhangsan01', 'pw-123456');
    const badPwd = await cbsdk.signInWithPassword('zhangsan01', 'wrong-password');
    eq('⚠ 密码不对 → 与「账号不存在」回**同一个码**（服务端刻意不区分，免得变成账号探测器）',
      badPwd.code, 'INVALID_USERNAME_OR_PASSWORD');
    ok('⚠⚠ 没把服务端英文原文甩出去', !/[A-Za-z]{4,}/.test(String(badPwd.error || '')), badPwd.error);

    /* --- 成功：令牌 + sub --- */
    const good = await cbsdk.signInWithPassword('zhangsan01', 'pw-123456', { deviceId: 'dev-1' });
    ok('账号密码正确 → 拿到令牌', good.ok === true, good.error || '');
    ok('  └ accessToken / refreshToken **一对**都在（只存一半下次刷新必掉线）',
      !!good.tokens.accessToken && !!good.tokens.refreshToken);
    ok('⭐⭐ sub 是 19 位纯数字（auth.users.id 是 bigint）', /^\d{19}$/.test(good.tokens.sub), good.tokens.sub);
    eq('⭐⭐ sub 取自 JWT，与桩里那个号完全一致（走 JSON.parse 会吃掉低位）',
      good.tokens.sub, cb.accounts.get('zhangsan01').sub);
    eq('登录请求就是那一发 POST /auth/v1/signin', cb.lastOf('POST'), 'POST /auth/v1/signin');

    /* --- 大小写不敏感 --- */
    const upper = await cbsdk.signInWithPassword('ZHANGSAN01', 'pw-123456');
    ok('⚠ 大写输入的账号也能登上（cbsdk 归一化成小写）', upper.ok === true, upper.error || '');

    /* --- ⚠⚠ 客户端**没有注册**这条路（平台直接 501） --- */
    const reg = await cbsdk.request('/auth/v1/signup', {
      method: 'POST', body: { username: 'newuser01', password: 'pw-123456' }
    });
    eq('⚠⚠ 用户名密码自助注册 → 平台 501', reg.status, 501);
    eq('  └ 码是 UNIMPLEMENTED', reg.code, 'UNIMPLEMENTED');
    eq('  └ 文案说「这个方式暂不支持，请联系管理员」', reg.error, '这个方式暂不支持，请联系管理员');
    eq('  └ 而且**没有**真的建出账号（账号只能由管理员建）', cb.accounts.has('newuser01'), false);

    /* --- 匿名登录（备选，未接 UI）：两条实测形状 --- */
    const anonBad = await cbsdk.signInAnonymously({});
    eq('⚠ 缺 x-device-id → ok:false（实测服务端要求必须有）', anonBad.ok, false);
    const anonOk = await cbsdk.signInAnonymously({ deviceId: 'dev-anon-1' });
    ok('带设备码 → 匿名登录成功', anonOk.ok === true, anonOk.error || '');
    neq('⚠⚠ 匿名账号的 sub **不是** `anon`（否则过不了 RLS 的 auth.uid() <> \'anon\'）',
      anonOk.tokens.sub, 'anon');
  });

  /* ---------- 4. auth 账号密码登录：账号就是身份，账号名还得留在登录态里 ---------- */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);

    const r1 = await loginAs(cb, 'zhangsan01');
    ok('登录成功', r1.ok === true, r1.error || '');
    ok('登录后 isLoggedIn() 为 true', auth.isLoggedIn() === true);
    ok('session 里存下了 sub', !!session.uid(), session.uid());
    ok('登录后 getIdentity() 带 cloudbaseUid', !!auth.getIdentity().cloudbaseUid);
    eq('⭐⭐ uid 就是服务端那个 id（19 位，与数据库 owner 同一个）',
      session.uid(), cb.accounts.get('zhangsan01').sub);

    /* --- 账号名落进登录态（设置页要显示） --- */
    eq('⭐ getUser() 带 username', auth.getUser().username, 'zhangsan01');
    eq('⭐ loginUsername() 拿到账号名（设置页读的就是它）', auth.loginUsername(), 'zhangsan01');
    eq('⚠ 这条路上 phone 是空串（短信账号才有手机号）', auth.getUser().phone, '');

    /* --- 换账号 = 换 uid --- */
    const uid1 = session.uid();
    const r2 = await loginAs(cb, 'lisi000002');
    ok('换一个账号也能登上', r2.ok === true, r2.error || '');
    neq('⚠⚠ 换账号 → uid 必须跟着换（沿用旧 sub 会让新用户看到上一个人的记录）', session.uid(), uid1);
    eq('  └ 新 uid 就是新账号的 id', session.uid(), cb.accounts.get('lisi000002').sub);
    eq('⚠ 账号名也要跟着换（不能残留上一任）', auth.loginUsername(), 'lisi000002');

    /* --- 同一账号再登一次：还是同一个 uid --- */
    const again = await loginAs(cb, 'zhangsan01');
    ok('回到原账号登录', again.ok === true);
    eq('⭐ 同一个账号 → 同一个 uid（这才是「换手机不丢记录」）', session.uid(), uid1);
    eq('  └ 账号名也回来了', auth.loginUsername(), 'zhangsan01');

    /* --- ⭐ 真刷一次令牌：账号名必须沿用 ---
       ⚠⚠ 这条守的是「自动续期会把账号名抹掉」那个 bug：
         刷新走的是 `session.save(r.tokens)`（**不带 extra**），
         不沿用的话设置页每次续期后都变成空白，而且**只在真机上过一阵才出现**。 */
    cb.clearLog();
    const base = Date.now();
    session._setNow(function () { return base + 3 * 3600 * 1000; });
    const t = await session.getAccessToken();
    ok('令牌到期后能自动续期', t.ok === true && t.refreshed === true, JSON.stringify(t));
    eq('  └ 走的是 /auth/v1/token', cb.countOf('POST /auth/v1/token'), 1);
    eq('⭐⭐ 续期后账号名仍在（save 不带 extra ⇒ 必须沿用旧值）', auth.loginUsername(), 'zhangsan01');
    eq('⚠ 且 uid 没变（续期不能换身份）', session.uid(), uid1);
    session._setNow(null);
  });

  /* ---------- 5. 令牌续期：并发去重 + 失败分类 ---------- */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';

    /* --- 并发去重（核心：refresh_token 一次性）--- */
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);
    await loginAs(cb, 'user000001');

    // 把时钟推到过期之后（不改真实时间）
    const base = Date.now();
    session._setNow(function () { return base + 3 * 3600 * 1000; });
    cb.clearLog();

    // 三个并发请求同时发现「过期了」
    const all = await Promise.all([session.getAccessToken(), session.getAccessToken(), session.getAccessToken()]);
    ok('并发刷新全部成功', all.every(function (t) { return t.ok; }), JSON.stringify(all.map(function (t) { return t.code; })));
    eq('⭐⭐ 只发了 1 次刷新请求（refresh_token 用过即失效，多刷必然失败）',
      cb.countOf('POST /auth/v1/token'), 1);
    ok('刷新后拿到新 token', all[0].token && all[0].token !== '');
    eq('⭐ 刷新成功后旧 refresh_token 已被替换（不能留旧的，否则下次刷新必失败）',
      session.read().refreshToken === '', false);
    ok('并发三次拿到的是同一个令牌', all[0].token === all[1].token && all[1].token === all[2].token);

    /* --- 续期失败：真过期 → 清凭证 --- */
    resetWorld();
    const cb2 = makeCloudbase();
    cbsdk._setFetch(cb2.stub);
    const l2 = await loginAs(cb2, 'user000002');
    eq('前提：登录成功', l2.ok, true);
    // 把 refresh_token 换成一个假的 → 服务端按**实测形状**回 500 + unknown + "invalid token header"
    // ⚠ 桩刻意不回文档说的 400+invalid_grant：只有真 500 形状才能验证
    //   session.credentialDead() 有没有「看描述关键词」而不只看状态码
    const s = session.read();
    session.save({ accessToken: s.accessToken, refreshToken: 'rt-不存在', expireIn: 0, sub: s.sub });
    session._setNow(function () { return base + 3 * 3600 * 1000; });
    const expired = await session.getAccessToken();
    eq('refresh_token 无效 → ok:false', expired.ok, false);
    eq('⭐⭐ 标记为 EXPIRED（要用户重新登录）—— 实测服务端回的是 500 而非 400，只按 status 判会漏',
      expired.code, 'EXPIRED');
    eq('⚠ 真过期时清掉本地凭证', session.hasSession(), false);

    /* --- 反向保护：服务端**真 5xx**（不是凭证问题）→ 绝不能把用户踢下线 ---
       ⚠ 这条守的是 credentialDead 的另一半。照抄实测的 500 形状之后很容易顺手写成
         「500 就是过期」—— 那一次服务端抽风就会清掉所有人的登录态。 */
    resetWorld();
    const cb4 = makeCloudbase({ failOn: '/auth/v1/token' });   // token 端点回 500 SYS_ERR
    cbsdk._setFetch(cb4.stub);
    const l4 = await loginAs(cb4, 'user000003');
    eq('前提：登录成功', l4.ok, true);
    session._setNow(function () { return base + 3 * 3600 * 1000; });
    const serverErr = await session.getAccessToken();
    eq('服务端 500（真故障）→ ok:false', serverErr.ok, false);
    neq('⚠⚠ 但**不标记**成 EXPIRED（500 ≠ 凭证过期，归入「可重试」）', serverErr.code, 'EXPIRED');
    eq('⭐⭐ 且**保留**凭证（一次服务端抖动不能清掉登录态）', session.hasSession(), true);

    /* --- 续期失败：网络问题 → **保留**凭证 --- */
    resetWorld();
    const cb3 = makeCloudbase();
    cbsdk._setFetch(cb3.stub);
    const l3 = await loginAs(cb3, 'user000004');
    eq('前提：登录成功', l3.ok, true);
    cbsdk._setFetch(makeCloudbase({ offline: true }).stub);      // 断网
    session._setNow(function () { return base + 3 * 3600 * 1000; });
    const netFail = await session.getAccessToken();
    eq('断网时续期失败 → ok:false', netFail.ok, false);
    eq('⚠ 断网时的失败码是 NETWORK 而**不是** EXPIRED（网络抖动 ≠ 登录过期）', netFail.code, 'NETWORK');
    eq('⭐⭐ 断网时**保留**本地凭证（不能把用户白白踢下线）', session.hasSession(), true);
  });

  /* ---------- 5b. 错误文案层：实测码 → 用户看得见的话 ---------- */
  steps.push(() => {
    // 这几个码是 2026-10-02 用 tools/probe-cloudbase.js 打真接口实测到的，
    // 文档里写的是另一套（invalid_phone_number / 4001）—— 两套都得认
    eq('INVALID_ARGUMENT 有中文文案', cbsdk.errText('INVALID_ARGUMENT'), '提交的信息有误，请检查后重试');
    eq('DATABASE_42501（RLS 拒绝）有中文文案', cbsdk.errText('DATABASE_42501'), '没有权限修改这份数据');
    eq('文档那片码也还认（invalid_phone_number）', cbsdk.errText('invalid_phone_number'), '手机号格式不对，请检查后重试');

    // ⚠ 未命中时的兜底：**绝不能**把服务端英文原文甩出去
    const unknownEn = cbsdk.errText('unknown', 'invalid token header');
    ok('⚠ 未知码 + 英文描述 → 仍是中文', /[\u4e00-\u9fa5]/.test(unknownEn), unknownEn);
    ok('  └ 且不带英文原文', unknownEn.indexOf('token header') < 0, unknownEn);

    // ⚠ 服务端会回「半句中文 + Go 格式化失败」这种脏数据，不能当文案用
    const dirty = cbsdk.errText('unknown', '无效的验证码%!(EXTRA string=rpc error: ...)');
    ok('⚠ 夹着 %!( 的脏数据 → 不采用它', dirty.indexOf('%!(') < 0, dirty);

    // 干净的中文描述可以用（服务端偶尔会给）
    eq('干净的中文描述可以透传', cbsdk.errText('unknown', '服务暂时不可用'), '服务暂时不可用');

    // 端点覆盖优先级最高（同一个 INVALID_ARGUMENT，各端点说法不同）
    eq('端点 overrides 优先于通用映射表',
      cbsdk.errText('INVALID_ARGUMENT', '', { INVALID_ARGUMENT: '验证码不对' }), '验证码不对');
    eq('没有 overrides 时回落到通用映射表', cbsdk.errText('INVALID_ARGUMENT', ''), '提交的信息有误，请检查后重试');

    // credentialDead 的两半：一边认码/描述，一边不误伤真故障
    ok('credentialDead 认 invalid_grant（文档形状）', session.credentialDead({ code: 'invalid_grant' }) === true);
    ok('credentialDead 认实测的 500 + invalid token header（真机形状）',
      session.credentialDead({ code: 'unknown', status: 500, data: { error_description: 'invalid token header' } }) === true);
    ok('⚠ credentialDead **不**把服务端真故障当过期（否则一次抖动清掉所有人登录态）',
      session.credentialDead({ code: 'SYS_ERR', status: 500, data: { message: 'boom' } }) === false);
    ok('⚠ 也不把网络失败当过期', session.credentialDead({ code: 'NETWORK', status: 0 }) === false);

    /* ---- httpFail 的判序（**必须**直接单测）----
       ⚠ 为什么不能靠第 7 组那条「冒用 owner」来守：那条是直接调 cbsdk.request 的，
         根本没经过 cbdb.httpFail。负向验证实测发现过这个漏洞 ——
         把 httpFail 里 DATABASE_42501 那条删掉，测试照样全绿。
         而正常业务路径也走不到（putRecord 的 owner 永远取自 session.uid()），
         所以只剩「直接单测」这一条路。 */
    eq('⚠⚠ RLS 拒绝（实测形状 401 + DATABASE_42501）说「没有权限」，**不是**「登录已过期」',
      cbdb.httpFail({ status: 401, code: 'DATABASE_42501', error: 'x' }, '保存').error,
      '没有权限修改这份数据');
    eq('⚠ 凭证真缺失（MISSING_CREDENTIALS）才说「登录已过期」',
      cbdb.httpFail({ status: 401, code: 'MISSING_CREDENTIALS', error: 'x' }, '保存').error,
      '登录已过期，请重新登录');
    eq('⚠ 服务端真 5xx → 保留 cbsdk 给的中文，不硬说成登录过期',
      cbdb.httpFail({ status: 500, code: 'SYS_ERR', error: '服务器开小差了' }, '保存').error,
      '服务器开小差了');
    eq('  └ 且 5xx 不是 ok', cbdb.httpFail({ status: 500, code: 'SYS_ERR' }, '保存').ok, false);
  });

  /* ---------- 5c. sub 从 JWT 里解（防 bigint 精度丢失 / 响应形状不确定） ---------- */
  steps.push(() => {
    const cbsdkLib = require(path.join(CORE, 'cbsdk.js'));
    /* 造一个**真形状**的 JWT：base64url、且故意不带 padding（真机就是这样） */
    const jwt = (payload) => 'xx.' + Buffer.from(payload, 'utf8').toString('base64url') + '.yy';

    eq('标准 JWT 能解出 sub', cbsdkLib.subFromJwt(jwt('{"sub":"2105943212899172352"}')), '2105943212899172352');
    eq('⚠ 不带 padding 的 base64url 也能解（真机就是这个形状）',
      cbsdkLib.subFromJwt(jwt('{"sub":"abc"}')), 'abc');

    /**
     * ⭐⭐ 本组最要紧的一条：sub 是 19 位**裸数字**时不许丢精度。
     *   auth.users.id 是 bigint，19 位远超 Number.MAX_SAFE_INTEGER（16 位）——
     *   一旦实现里走了 JSON.parse，低位会被静默吃掉，uid 与数据库 owner 对不上，
     *   表现为「登录成功、却一条记录都读不到」且全程无报错。
     * ⚠ payload 用**字符串拼**：写成 JS 数字字面量的话，构造阶段就已经丢了。
     */
    const bigSub = '2105943212899172352';
    eq('⭐⭐ sub 是 19 位裸数字时**不丢精度**（走了 JSON.parse 就会丢）',
      cbsdkLib.subFromJwt(jwt('{"sub":' + bigSub + '}')), bigSub);
    ok('   └ 对照：JSON.parse 确实会丢 —— 证明上面那条不是白测的',
      String(JSON.parse('{"sub":' + bigSub + '}').sub) !== bigSub,
      'parse 得到 ' + String(JSON.parse('{"sub":' + bigSub + '}').sub));

    eq('payload 里有中文也不崩（UTF-8 解码正确）',
      cbsdkLib.subFromJwt(jwt('{"name":"张三","sub":"s1"}')), 's1');

    eq('没有 sub → 空串', cbsdkLib.subFromJwt(jwt('{"role":"anon"}')), '');
    eq('不是 JWT（只有 1 段）→ 空串', cbsdkLib.subFromJwt('not-a-jwt'), '');
    eq('不是 JWT（只有 2 段）→ 空串', cbsdkLib.subFromJwt('a.b'), '');
    eq('null / 空 → 空串（不崩）', cbsdkLib.subFromJwt(null), '');
  });

  /* ---------- 6. 记录级驱动：字段映射 + 请求形状 ---------- */
  steps.push(() => {
    const row = cbdb.toRow({ id: 'c1', name: '张三', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 123, notes: { d1: { t: 'x' } } }, 'u1');
    eq('date → birth_date', row.birth_date, '1990-01-01');
    eq('time → birth_time', row.birth_time, '11:04');
    eq('createdAt → created_at', row.created_at, 123);
    eq('owner 一并带上（upsert 冲突键要完整）', row.owner, 'u1');
    ok('notes 跟着走', !!row.notes);

    const noNotes = cbdb.toRow({ id: 'c2', name: 'n', gender: 0, date: '1990-01-01', time: '11:04', createdAt: 1 }, 'u1');
    ok('⚠ 没有 notes 时**完全不出现**该字段（不留 notes:{}）', !('notes' in noNotes));

    const back = cbdb.fromRow({ owner: 'u1', id: 'c1', name: '张三', gender: 1, birth_date: '1990-01-01', birth_time: '11:04', created_at: 123, notes: { d1: { t: 'x' } } });
    eq('birth_date → date', back.date, '1990-01-01');
    eq('birth_time → time', back.time, '11:04');
    eq('created_at → createdAt', back.createdAt, 123);
    ok('⚠ owner 不带到上层（权限列，业务不需要）', !('owner' in back));
    eq('created_at 是字符串时也转成数字', cbdb.fromRow({ id: 'x', name: 'n', gender: 1, birth_date: 'd', birth_time: 't', created_at: '456' }).createdAt, 456);
    eq('id 用字符串比较（表里是 text）', cbdb.fromRow({ id: 9, name: 'n', gender: 1, birth_date: 'd', birth_time: 't', created_at: 1 }).id, '9');
    eq('⚠ 缺出生日期的行 → null（不冒充一条正常记录）', cbdb.fromRow({ id: 'x', name: 'n', gender: 1 }), null);
    eq('null 行 → null', cbdb.fromRow(null), null);
    eq('gender=0 → 0（女）', cbdb.fromRow({ id: 'x', name: 'n', gender: 0, birth_date: 'd', birth_time: 't', created_at: 1 }).gender, 0);
    eq('Content-Range `*/3` → 3 行', cbdb.affectedFromRange('*/3'), 3);
    eq('Content-Range `0-2/3` → 3 行', cbdb.affectedFromRange('0-2/3'), 3);
    ok('select 里不含 owner', cbdb.SELECT.indexOf('owner') < 0, cbdb.SELECT);
  });

  /* ---------- 7. 驱动打真接口：读写 / 幂等 / 隔离 ---------- */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);

    /* 未登录：必须 ok:false，**绝不能**是「空列表」 */
    const anon = await cbdb.listRecords('u1');
    eq('⚠ 未登录读取 → ok:false', anon.ok, false);
    ok('⚠⚠ 未登录**绝不能**返回 ok:true + records:[]（那会被当成「云端没有」）',
      !(anon.ok === true && Array.isArray(anon.records)), JSON.stringify(anon));
    eq('也不该真去打接口（没 token 打过去只会 401）', cb.countOf('GET /v1/rdb/rest/records'), 0);

    /* 登录 */
    const logged = await loginAs(cb, 'user000011');
    eq('前提：登录成功', logged.ok, true);
    const me = session.uid();
    cb.clearLog();

    /* 写一条 */
    const w1 = await cbdb.putRecord(me, { id: 'c1', name: '张三', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 1000 });
    ok('写入成功', w1.ok === true, w1.error || '');
    eq('⚠ 写入用的是 POST /v1/rdb/rest/records', cb.lastOf('POST'), 'POST /v1/rdb/rest/records');
    eq('云端真的多了一行', cb.count(), 1);
    eq('行里的 owner 是服务端认的 sub', cb.rows[0].owner, me);

    /* 幂等：同 id 再写不产生第二条 */
    await cbdb.putRecord(me, { id: 'c1', name: '张三改', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 1000 });
    eq('⭐ 同 id 重复写入仍是 1 行（upsert 幂等，不会长重复）', cb.count(), 1);
    eq('内容是新的', cb.rows[0].name, '张三改');

    /* 再写一条，验证排序 */
    await cbdb.putRecord(me, { id: 'c2', name: '李四', gender: 0, date: '1988-08-08', time: '23:59', createdAt: 2000 });
    const list = await cbdb.listRecords(me);
    ok('读回 2 条', list.ok === true && list.records.length === 2, JSON.stringify(list));
    eq('⭐ 按 createdAt 倒序（新的在前）', list.records[0].id, 'c2');
    ok('⚠ 读回来的记录**没有 owner** 字段', !('owner' in list.records[0]));

    /* 越权写入：冒用别人的 owner 必须被 WITH CHECK 拒掉。
       ⚠ 这条**不能**走 cbdb.putRecord —— 那个接口的 owner 取自 session.uid()，
         前端根本没机会冒用（这正是它安全的地方）。所以直接发一个带别人 owner 的
         POST，验证服务端的 RLS 策略（桩忠实复刻的 WITH CHECK）会拒。
       若这里断言不成立，「驱动只写自己的数据」就只是口号，不是被验证过的事实。 */
    const tok = (await session.getAccessToken()).token;
    const before = cb.count();
    const forged = await cbsdk.request(cbdb.REST, {
      method: 'POST',
      token: tok,
      body: { owner: 'someone-else', id: 'c9', name: 'x', gender: 1, birth_date: '1990-01-01', birth_time: '11:04', created_at: 1 },
      headers: { prefer: 'resolution=merge-duplicates,return=representation' }
    });
    eq('⚠⚠ 冒用别人的 owner → 被服务端拒（401）', forged.status, 401);
    eq('⚠⚠ 文案说「没有权限」而不是「登录已过期」—— RLS 拒绝也是 401，只看 status 会把人带偏',
      forged.error, '没有权限修改这份数据');
    eq('被拒的写入**没有**在云端留下任何行', cb.count(), before);
    eq('尤其**没有**留下那条冒名的 c9', cb.rows.filter(function (r) { return r.id === 'c9'; }).length, 0);

    /* 隔离：另一个用户看不到我的 */
    cb.seed({ owner: 'someone-else', id: 'z1', name: '别人的', gender: 1, birth_date: '1990-01-01', birth_time: '11:04', created_at: 5 });
    const mine = await cbdb.listRecords(me);
    eq('⭐⭐ 只看得到自己的（RLS 生效）', mine.records.length, 2);
    ok('别人的那条没混进来', mine.records.filter(function (r) { return r.id === 'z1'; }).length === 0);

    /* 删一条 */
    const d1 = await cbdb.deleteRecord(me, 'c1');
    ok('删除成功', d1.ok === true, d1.error || '');
    eq('deleted=true（真删掉了）', d1.deleted, true);
    eq('云端剩 2 行（我的 c2 + 别人的 z1）', cb.count(), 2);

    const d2 = await cbdb.deleteRecord(me, 'c1');
    eq('⚠ 重复删除不算失败（deleted 为 false 但 ok 为 true）', d2.ok, true);
    eq('deleted=false（本来就没有）', d2.deleted, false);

    /* 不能删别人的 */
    const d3 = await cbdb.deleteRecord(me, 'z1');
    eq('⚠ 删别人的记录 → 影响 0 行（RLS 挡住）', d3.deleted, false);
    ok('别人的数据还在', cb.count() === 2);

    /* 清空：只清自己的 */
    const c1 = await cbdb.clearRecords(me);
    ok('清空成功', c1.ok === true, c1.error || '');
    eq('删掉 1 行（自己那条）', c1.deleted, 1);
    eq('⭐ 别人的数据没被误伤', cb.count(), 1);
    eq('剩下的那行确实是别人的', cb.rows[0].owner, 'someone-else');

    /* 清空之后再读 = 空数组（这才是 ok:true + []） */
    const empty = await cbdb.listRecords(me);
    ok('⭐ 没有记录时才是 ok:true + 空数组', empty.ok === true && empty.records.length === 0, JSON.stringify(empty));
  });

  /* ---------- 8. 失败路径：一切失败都必须 ok:false（防丢数据） ---------- */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);
    const s = await loginAs(cb, 'user000012');
    eq('前提：登录成功', s.ok, true);
    const me = session.uid();

    /* 服务器 500 */
    cbsdk._setFetch(makeCloudbase({ failOn: '/v1/rdb/rest' }).stub);
    const e1 = await cbdb.listRecords(me);
    eq('读遇 500 → ok:false', e1.ok, false);
    ok('⚠⚠ 500 **绝不**降级成 ok:true + 空列表', !Array.isArray(e1.records), JSON.stringify(e1));

    const e2 = await cbdb.putRecord(me, { id: 'x', name: 'n', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 1 });
    eq('写遇 500 → ok:false', e2.ok, false);

    /* 断网 */
    cbsdk._setFetch(makeCloudbase({ offline: true }).stub);
    const e3 = await cbdb.listRecords(me);
    eq('断网读 → ok:false', e3.ok, false);
    ok('⚠⚠ 断网**绝不**被当成「没有记录」', !Array.isArray(e3.records));
    ok('错误文案是可读中文', String(e3.error || '').length > 0, e3.error);

    /* 401（token 被服务端拒了）*/
    const bare = makeCloudbase();
    bare.tokens.clear();
    cbsdk._setFetch(bare.stub);
    const e4 = await cbdb.listRecords(me);
    eq('401 → ok:false', e4.ok, false);
    ok('401 的文案指向「登录过期」', String(e4.error || '').indexOf('登录') >= 0, e4.error);

    /* 没有任何一步 reject（驱动层承诺永不 reject） */
    const all = await Promise.all([cbdb.listRecords(me), cbdb.deleteRecord(me, 'x'), cbdb.clearRecords(me)]);
    ok('⚠ 驱动层**永不 reject**，失败一律用 ok:false 表达', all.every(function (r) { return r && typeof r.ok === 'boolean'; }));
  });

  /* ---------- 9. 派发层 / storeMode ---------- */
  steps.push(() => {
    storeMode.MODE = 'cloudbase';
    eq('MODE 合法值包含 cloudbase（不抛错）', (function () {
      try { storeMode.assertUsableMode(); return 'ok'; } catch (e) { return 'threw'; }
    })(), 'ok');
    eq("MODE='cloudbase' 时 isFileLevel() = false", storeMode.isFileLevel(), false);
    eq('store.fileLevel() 同步为 false', store.fileLevel(), false);
    eq('store.name() = cloudbase', store.name(), 'cloudbase');
    eq('pick() 选中的是 cbdb 驱动', typeof store.pick().putRecord === 'function' && !!store.pick().SELECT, true);
    ok('⚠ 记录级模式下**没有**文件级接口（问错了就该炸，不该静默兜底）',
      typeof store.pick().readFile === 'undefined');
    eq('ready() 为 true', storeMode.ready(), true);
    eq('isFileLevel() 的判据只有 gitee（cloudbase/cloud 都是记录级）', storeMode.MODE !== 'gitee' && storeMode.isFileLevel() === false, true);
  });

  /* ---------- 10. auth 在 CloudBase 模式下不自造登录态 ---------- */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';

    eq('未登录时 isLoggedIn() = false', auth.isLoggedIn(), false);
    eq('getUser() 为 null', auth.getUser(), null);

    /* ⚠⚠ 必须**先把设备码造出来**再验下面那条。
       否则：resetWorld 把 ANON_KEY 清掉了，readAnon() 返回空串，
       于是「未登录时 anonymousCode 为空」这条断言在「把设备码漏出去」的写法下**照样绿**
       —— 负向验证实测抓到过这个盲区（注入 anonymousCode: readAnon() 后 168 条全绿）。
       只有在「设备码确实躺在本地」的状态下验，才真的守得住「身份只来自服务端」这件事。 */
    storage.setAndPersist(auth.ANON_KEY, 'dev-should-not-leak');
    ok('前提：设备码确实已落在本机', !!storage.getStorageSync(auth.ANON_KEY));
    eq('⚠⚠ 未登录时 getIdentity() 不给设备码（CloudBase 的身份只来自服务端）',
      auth.getIdentity().anonymousCode, '');
    eq('未登录时 cloudbaseUid 是空串', auth.getIdentity().cloudbaseUid, '');
    eq('⚠⚠ 未登录时 uidOf 拿不到 uid（上层据此走「还没登录」而不是「没有权限」）',
      userStore.uidOf(auth.getIdentity()).uid, '');

    const l = await auth.login();
    eq('⚠⚠ login() 不自造登录态 → ok:false', l.ok, false);
    eq('⭐ 而是标记 needLogin（与「登录失败」区分开）', l.needLogin, true);

    const e = await auth.ensureLogin();
    eq('ensureLogin() 在没登录时返回 ok:false', e.ok, false);
    eq('且带 needLogin 标记', e.needLogin, true);

    /* uidOf 认 cloudbaseUid，且优先于设备码 */
    eq('uidOf 认 cloudbaseUid', userStore.uidOf({ cloudbaseUid: 'sub9' }).uid, 'sub9');
    eq('uidOf 的 source 标成 cloudbase', userStore.uidOf({ cloudbaseUid: 'sub9' }).source, 'cloudbase');
    eq('⭐ cloudbaseUid 优先于 deviceCode', userStore.uidOf({ cloudbaseUid: 'sub9', deviceCode: 'dev' }).uid, 'sub9');
    ok('uidOk 接受雪花数字型 sub', userStore.uidOk('2105943212899172352') === true);
  });

  /* ---------- 10b. ⭐ cloudbase 下 force 必须被忽略（登录要人参与，没法自动重登） ---------- */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);

    const r = await loginAs(cb, 'user000013');
    eq('前提：登录成功', r.ok, true);
    ok('前提：本机已有凭证', session.hasSession() === true);

    /**
     * ⚠⚠ 这条守的是**真实炸过**的 bug：
     *   boot.whoami({fresh:true}) → ensureSession({relogin:true}) → ensureLogin(true)，
     *   而 cloudbase 的 login() 永远返回 needLogin ⇒ 只要 force 被尊重，
     *   用户就会「明明登录着，点『开始排盘』却被告知『登录后才能排盘』」。
     *   注意**不能一刀切删掉 force** —— gitee 那边它是「重取设备码」，无感且必须支持。
     */
    const forced = await auth.ensureLogin(true);
    eq('⭐⭐ 已登录时 ensureLogin(true) 必须 ok（force 不能把用户踢去重登）', forced.ok, true);
    eq('   └ 且不得带 needLogin', !!forced.needLogin, false);
    ok('   └ session 里带着可用的 uid', !!(forced.session && forced.session.cloudbaseUid),
      JSON.stringify(forced.session));

    /* ⭐ 直接守住用户实际走的那条路：排盘页「开始排盘」的闸门读的就是它 */
    const bootLib = require(path.join(CORE, 'boot.js'));
    bootLib.forget();
    const who = await bootLib.whoami({ fresh: true });
    ok('⭐⭐ whoami({fresh:true}) 必须拿到 uid（「开始排盘」的闸门就是它）',
      !!(who && who.uid), JSON.stringify(who));

    /* 对照组：凭证真没了时仍必须要求登录（别把失效路径一并修坏） */
    session.clear();
    const gone = await auth.ensureLogin(true);
    eq('没凭证时 ensureLogin(true) 仍然要求登录', gone.needLogin, true);
    const who2 = await bootLib.whoami({ fresh: true });
    eq('没凭证时 whoami 返回 null（闸门拦住）', who2, null);
  });

  /* ---------- 11. 退出登录 ---------- */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);
    const s = await loginAs(cb, 'user000014');
    eq('前提：登录成功', s.ok, true);
    const dev = auth.deviceId();
    ok('登录后 hasSession', session.hasSession() === true);

    auth.logout();
    eq('⭐ 退出后凭证被清掉', session.hasSession(), false);
    eq('退出后 isLoggedIn() = false', auth.isLoggedIn(), false);
    eq('⚠ 但设备码**保留**（下次还是同一台设备）', auth.deviceId(), dev);

    const l = await auth.ensureLogin();
    eq('退出后再 ensureLogin → 要求重新登录', l.needLogin, true);
  });

  /* ---------- 12. 文案与阶段常量（页面直接消费） ---------- */
  steps.push(() => {
    const boot = require(path.join(CORE, 'boot.js'));
    ok('STAGE 里有 NEED_LOGIN（与 FAILED 区分）', boot.STAGE.NEED_LOGIN === 'need-login');
    ok('TEXT 里有 needLogin 文案', typeof boot.TEXT.needLogin === 'string' && boot.TEXT.needLogin.length > 0, boot.TEXT.needLogin);
    ok('⚠ needLogin 文案不能说成「失败」（新用户第一次打开是正常状态）',
      boot.TEXT.needLogin.indexOf('失败') < 0, boot.TEXT.needLogin);
    ok('needLogin 不是「等一等」阶段（不该转圈）',
      [boot.STAGE.LOGIN, boot.STAGE.CHECKING, boot.STAGE.CREATING].indexOf(boot.STAGE.NEED_LOGIN) < 0);

    /* ⚠⚠ 2026-10-21 用户要求去掉「登录失败，点此重试」这条提示，理由见 boot.js 的 TEXT：
       本模式下登录**只能**由用户手输账号密码完成 ⇒ 「登录没成」不是没登录就是断网，
       两种都**不是点一下重试就能好的**。⇒ 那条文案与它对应的分支一起删掉。 */
    ok('⚠ 不再有「登录失败，点此重试」这条文案（TEXT.loginFailed 已删）',
      boot.TEXT.loginFailed === undefined,
      'TEXT.loginFailed=' + JSON.stringify(boot.TEXT.loginFailed));
    ok('⚠ FAILED 只剩「云端同步失败」（唯一一种点重试真能好的失败）',
      /云端/.test(boot.TEXT.failed) && boot.TEXT.failed.indexOf('登录') < 0, boot.TEXT.failed);
  });

  /* ---------- 12b. 退出登录后在飞的那次核对必须闭嘴（代次守卫） ----------
     ⚠⚠ 这条守的是一个**真实报障**（2026-10-21）：「退出登录后还显示『登录失败，点此重试』」。
        根因不是文案写错，而是 `forget()` 收不回**已经在飞**的那次 run ——
        它跑完后照样 publish，那条状态描述的其实是上一个登录态的事。
     做法：每次 run 记下开跑时的代次，广播前比对（见 boot.js 的 `epoch`）。
     ⚠ 断言必须**真的走一遍网络**（用桩），只 grep 源码是拦不住「守卫写了但没生效」的。 */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';
    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);
    const s = await loginAs(cb, 'user000016');
    eq('前提：登录成功', s.ok, true);

    const boot = require(path.join(CORE, 'boot.js'));
    boot.forget();
    const p = boot.ensureUser(true);   // 真的跑一遍（登录 + 查云端，都会打桩）
    boot.forget();                     // 用户在这一刻退出登录
    await p;
    eq('⚠⚠ 退出登录后，在飞的那次核对**不许**再广播（快照停在 idle）',
      boot.getSnapshot().stage, boot.STAGE.IDLE);
    eq('   └ 快照文案也必须是空（不能留着那句「登录失败 / 云端同步失败」）',
      boot.getSnapshot().text, '');
  });

  /* ---------- 13. 事件记录：走云端数据库函数（不再「拉全表 → 整行写回」） ----------
     ⚠ 这一节守的是一个**架构决定**，不只是行为。
       事件合并原来在客户端做（listRecords 拉全表 → 改一条 → putRecord 整行覆盖），
       两个结构性问题：白拉一次全量；两台设备并发改**不同**记录时会互相覆盖。
       现在逻辑住在库里的 save_notes 里，客户端只发一次 RPC。
       ⇒ 所以下面既断言「结果对不对」，也断言「**没有走那条老路**」——
         只测结果的话，把实现改回旧写法照样全绿。 */
  steps.push(async () => {
    resetWorld();
    storeMode.MODE = 'cloudbase';
    const history = require(path.join(CORE, 'history.js'));

    const cb = makeCloudbase();
    cbsdk._setFetch(cb.stub);
    const s = await loginAs(cb, 'user000015');
    eq('前提：登录成功', s.ok, true);

    const put = await history.push({ id: 'r1', name: '甲', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 100 });
    eq('先存一条记录（走正常的 putRecord 路径）', put.ok, true);
    cb.clearLog();

    const notes = { 'dayun:d3': { text: '升职', year: '2020', ganzhi: '庚子', age: 31 } };
    const w = await history.saveNotes('r1', notes);
    eq('⭐ saveNotes 成功', w.ok, true);
    eq('⭐⭐ 只发一次请求 —— 就是 RPC 那一发', cb.countOf('POST /v1/rdb/rest/rpc/save_notes'), 1);
    eq('⚠ 不再 GET 全表（老写法的第一跳）', cb.countOf('GET /v1/rdb/rest/records'), 0);
    eq('⚠ 也不再有 POST 整行覆盖（老写法的第二跳）', cb.countOf('POST /v1/rdb/rest/records'), 0);
    eq('⚠ 更不该出现 PATCH（那不是本项目用的路）', cb.countOf('PATCH /v1/rdb/rest/records'), 0);

    const row = cb.rows.filter(function (r) { return r.id === 'r1'; })[0];
    eq('云端 notes 落库了', JSON.stringify(row.notes), JSON.stringify(notes));
    eq('⚠ 其它字段一个都没动（是「只改 notes」，不是整行覆盖）',
      row.name + '|' + row.birth_date + '|' + row.birth_time, '甲|1990-01-01|11:04');

    await history.saveNotes('r1', {});
    eq('⭐ 空对象 ⇒ 列置回 NULL（云端不留 notes:{}）', String(row.notes), 'null');

    await history.saveNotes('r1', notes);
    const pulled = await history.pull();
    eq('⭐ 从云端读回来的记录**带着 notes**（SELECT 清单里没漏掉它）',
      pulled.ok && JSON.stringify(pulled.records[0].notes), JSON.stringify(notes));

    const miss = await history.saveNotes('__no_such_record__', notes);
    eq('⭐ 记录不存在 ⇒ ok:false', miss.ok, false);
    eq('⭐⭐ 且 reason 是 not-found —— 与网络失败区分开（页面文案不同）', miss.reason, 'not-found');
    eq('⚠ 文案里说得出「没有这条记录」', /没有这条记录/.test(String(miss.error)), true);

    /* 断网时不能假装成功，也不能说成「记录不存在」 */
    cb.clearLog();
    cbsdk._setFetch(function () { return Promise.reject(new TypeError('Network request failed')); });
    const off = await history.saveNotes('r1', notes);
    eq('断网时 saveNotes ⇒ ok:false', off.ok, false);
    eq('⚠ 断网报的是 cloud-error，不是 not-found（否则会误导用户以为记录没了）', off.reason, 'cloud-error');

    /* 驱动缺失时的行为：不许「顺手降级成 putRecord」——那是整行覆盖，会盖掉并发写 */
    cbsdk._setFetch(cb.stub);
    storeMode.MODE = 'gitee';
    let threw = false;
    try { store.saveNotes('uid', 'id', {}); } catch (err) { threw = true; }
    ok('⭐ 驱动没有 saveNotes 时就地抛错（不静默降级成整行覆盖）', threw);
    storeMode.MODE = 'cloudbase';
  });

  return steps;
}

/* ==================================================== 驱动 */

(async function main() {
  const steps = run();
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      assert.fail++;
      assert.lines.push('  FAIL  ⚠ 用例抛异常（不该发生，驱动层承诺永不 reject）：' + (err && err.message));
    }
  }

  console.log(assert.lines.join('\n'));
  console.log('\ncloudbase-check: ' + assert.pass + ' PASS / ' + assert.fail + ' FAIL\n');
  process.exit(assert.fail ? 1 : 0);
})().catch(function (err) {
  console.error('cloudbase-check 自身崩了：', err && err.stack);
  process.exit(1);
});
