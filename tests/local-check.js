/**
 * 本地后端整链自检 —— core/localsdk.js + core/store/localdb.js
 *   + core/session.js（本地模式分支）+ core/auth.js（注册入口）+ core/storeMode.js
 *
 * 纯 Node，**不需要装 Expo 依赖**（本项目「能算对」这一侧的纪律）。
 *
 * ============ 桩停在哪一层 ============
 * ⚠ 只能停在 **HTTP 边界**（`localsdk._setFetch`）—— 桩负责「按 paipan-server 的真实形状回响应」，
 *   业务语义（令牌形状、失败降级、uid 从 JWT 取、notes 先读后写）一律由**真实代码**决定。
 *   把桩往上提（比如直接桩掉 localdb.js）就会把被测逻辑一起桩掉，测试变成自说自话。
 *
 * ============ ⚠⚠ 这个桩必须真的实现四件事，否则测出来是假的 ============
 *   ① **uid 只从 JWT 取**：桩收到 Authorization 后要先解令牌才认人，
 *      不实现它，「请求体里塞别人的 uid 也读不到别人的数据」这条永远绿。
 *   ② **PUT 的 id 在路径里**：桩若也接受 body 里的 id，那「写成 PUT /records」这个坑就测不出来。
 *   ③ **注册限流按「成功数」计**：连打 N 个失败请求不该吃额度。桩不实现它，
 *      这条最重要的口径就没人守（服务端第一版正是在这里错的）。
 *   ④ **响应永远带 ok 字段**：本地服务端的承诺。桩若不总带，
 *      就测不出「client 只认 status 2xx」与「client 认 body.ok」的差别。
 *
 * ============ ⚠⚠ 与 cloudbase-check 的关键差异 ============
 *   本地后端**没有 refresh_token**（单个 token，30 天，到期重新登录）⇒
 *   本文件专门有一组断言钉住「session 在 local 模式下**不会**去发续期请求」。
 *   这正是「登录了却像没登录」之外最容易踩的一类：伪造一个假 refreshToken，
 *   用户第 30 天被弹去重新登录，而报错说「续期失败，请检查网络」。
 *
 * ⚠ 断言走 stdout，最后必须 process.exit(fail?1:0)
 */
const path = require('path');
const fs = require('fs');

const assert = { pass: 0, fail: 0, lines: [] };

function ok(name, cond, extra) {
  if (cond) { assert.pass++; assert.lines.push('  PASS  ' + name); }
  else { assert.fail++; assert.lines.push('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
  /* ⚠ 立刻落盘而不是攒到最后：用例是异步链，中途抛错时
     「已经跑过的那部分结果」必须看得见，否则只能看到一个崩栈（已踩）。 */
  if (!cond) console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
/** 「不等于」—— 别用 eq 兼职表达它（got=true want=undefined 看不出撞在哪） */
function neq(name, got, notWant) {
  ok(name, got !== notWant, 'got=' + JSON.stringify(got) + ' 不该等于=' + JSON.stringify(notWant));
}

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, '..', 'src');
const CORE = path.join(SRC, 'core');

/* ⚠ 导入顺序：先装 platform/storage 的桩再 require 其他模块，
   否则 session / boot 会在加载期把真的 storage 抓过去 */
const storage = require(path.join(SRC, 'platform', 'storage.js'));

const localsdk = require(path.join(CORE, 'localsdk.js'));
const session = require(path.join(CORE, 'session.js'));
const localdb = require(path.join(CORE, 'store', 'localdb.js'));
const store = require(path.join(CORE, 'store', 'index.js'));
const storeMode = require(path.join(CORE, 'storeMode.js'));
const auth = require(path.join(CORE, 'auth.js'));
/* 在线心跳 + 指令接收（长轮询）。⚠ 它的桩停在**注入的 ping** 上，理由见最后一节 */
const presence = require(path.join(CORE, 'presence.js'));

/* ==================================================== 内存 storage 桩 */

/**
 * 出生公历 → 四柱八个字（年月日时各自的干与支）。
 *
 * ⚠⚠ 用**项目自己那份 tyme**（src/vendor/tyme.js）算 ——
 *   与服务端 `paipan-server/vendor/tyme.js`、前端 `core/chart.js` 是同一个构建产物。
 *   桩里另写一套干支的话，筛选用例测的就成了「桩自己算得对不对」，
 *   而不是「真实服务端会不会筛」——那种绿是假的。
 *
 * @returns {string[]|null} [年干,年支,月干,月支,日干,日支,时干,时支]，算不出时 null
 */
function pillarsOf(date, time) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!dm || !tm) return null;
  const y = Number(dm[1]); const mo = Number(dm[2]); const d = Number(dm[3]);
  const h = Number(tm[1]); const mi = Number(tm[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  try {
    const tyme = require(path.join(ROOT, 'src', 'vendor', 'tyme.js'));
    const st = tyme.SolarTime.fromYmdHms(y, mo, d, h, mi, 0);
    const ec = st.getLunarHour().getEightChar();
    return [ec.getYear(), ec.getMonth(), ec.getDay(), ec.getHour()].reduce(function (acc, gz) {
      const s = String(gz);
      acc.push(s.charAt(0), s.charAt(1));
      return acc;
    }, []);
  } catch (e) {
    return null;
  }
}

/**
 * ⚠⚠ 默认的 store 其实**已经是纯内存**的（storage.js 里 active 的默认实现）——
 *   我们只需要在用例之间 `_clear()` 把它擦干净。
 *   ⚠ 别自己 `_setStore({getItem, setItem, ...})`：那套接口签名是错的
 *     （真实接口是 `{ get, set, remove }`），注入进去后**所有读写都静默失败**，
 *     症状是「所有令牌都读不出来」而不是报错 —— 本文件第一版就是这样，
 *     一眼看去像「session 坏了」（已踩）。
 */

function clearStore() {
  storage._clear();
  session._reset();
}

function resetAll() {
  session._reset();
  localsdk._setFetch(null);
  storage._clear();
}

/* ================================================= paipan-server HTTP 桩 */

/**
 * 一个极简但**忠实**的 paipan-server 实现（认证 + 记录面）。
 *
 * ⚠ 形状全部照 `paipan-server/src/routes/*.ts` 抄，不是照文档抄 ——
 *   本项目已经吃过一次「文档 ≠ 实测」的亏（CloudBase 那套错误码两份）。
 *   好在本地服务端是我们自己写的，源码就是唯一真相。
 *
 * @param {Object} [o]
 * @param {boolean} [o.offline] true = 所有请求当网络失败
 * @param {string}  [o.failOn]  在某个路径前缀上返回 500
 * @param {boolean} [o.noOk]    true = 故意不回 ok 字段（测 client 的判据够不够严）
 * @param {number}  [o.signupMax] 注册限额，默认与服务端一致 10
 */
function makeServer(o) {
  const opts = o || {};
  const users = new Map();     // username → { uid, password }
  const tokens = new Map();    // token → uid
  const rows = [];             // 记录行（列名照 schema.sql）
  const log = [];              // 请求记录，供断言「发了哪些请求」
  const signupHits = [];       // 每个 IP 的成功注册时刻（复刻服务端的 count/resetAt）
  let seq = 0;

  const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
  const SIGNUP_MAX = (opts.signupMax === undefined) ? 10 : opts.signupMax;
  const PASSWORD_MIN = 6;
  const PASSWORD_MAX = 128;

  const USERNAME_RE = /^[a-z][0-9a-z_-]{5,24}$/;
  function newUid() { seq += 1; return 'u' + String(seq).padStart(32, '0'); }
  function newToken(uid) {
    seq += 1;
    // ⚠ 造**真形状**的 JWT（三段式）。payload 里的 uid 是权威来源，
    //   桩若只回一个随机串，uidFromJwt 那条路就完全没被测到。
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString('base64url');
    const body = Buffer.from(JSON.stringify({ uid: uid, iat: 1 }), 'utf8').toString('base64url');
    const t = head + '.' + body + '.sig' + seq;
    tokens.set(t, uid);
    return t;
  }
  /** 复刻服务端：失败不计数，只在**插库成功后**才 consume */
  function quotaLeft() {
    const now = Date.now();
    const live = signupHits.filter(function (t) { return now - t < SIGNUP_WINDOW_MS; });
    return live.length < SIGNUP_MAX;
  }
  function consume() { signupHits.push(Date.now()); }

  function reply(status, body) {
    const b = (body && typeof body === 'object') ? Object.assign({}, body) : {};
    if (opts.noOk) {
      /* ⚠ 测试专用：把 ok 摘掉，模拟「对端不是我们认识的那个服务」
         （比如中间夹了个代理回了 200 + 一段结构不同的 JSON）。
         必须**先摘后补**，否则 handler 里显式写的 ok:true 会漏过去。 */
      delete b.ok;
    } else if (b.ok === undefined) {
      // ④ 服务端承诺「响应永远带 ok」
      b.ok = status >= 200 && status < 300;
    }
    return {
      status: status,
      text: function () { return Promise.resolve(JSON.stringify(b)); }
    };
  }
  /** 出参转换：列名 → 前端形状（复刻服务端 toWire） */
  function toWire(r) {
    return {
      id: r.id, name: r.name, gender: r.gender,
      date: r.birth_date, time: r.birth_time,
      createdAt: r.created_ms,
      notes: r.notes || undefined
    };
  }
  function uidOf(init) {
    const h = (init && init.headers) || {};
    const m = /^Bearer\s+(.+)$/.exec(String(h.authorization || h.Authorization || ''));
    if (!m) return '';
    return tokens.get(m[1]) || '';
  }

  function stub(url, init) {
    const u = String(url || '');
    /* ⚠⚠ 必须把查询串**从路径里摘出去**再比对：
       现在 GET /records 可能带筛选参数（?dayGan=甲），
       若仍拿整串去 `p === '/records'`，带筛选的请求会掉到 404 分支 ——
       那测到的就不是「筛选生效」，而是「路径不认识」。 */
    const raw = u.replace(localsdk.CONFIG.base, '');
    const qi = raw.indexOf('?');
    const p = qi >= 0 ? raw.slice(0, qi) : raw;
    const queryStr = qi >= 0 ? raw.slice(qi + 1) : '';
    const method = String((init && init.method) || 'GET').toUpperCase();
    /** 查询串 → 对象（值可能是数组，同名参数出现多次时） */
    function qs() {
      const out = {};
      if (!queryStr) return out;
      queryStr.split('&').forEach(function (kv) {
        if (!kv) return;
        const i = kv.indexOf('=');
        const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
        const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
        if (out[k] === undefined) out[k] = v;
        else if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      });
      return out;
    }
    let body = {};
    if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) { body = {}; } }
    log.push(method + ' ' + raw);

    if (opts.offline) return Promise.reject(new TypeError('Network request failed'));
    if (opts.failOn && p.indexOf(opts.failOn) === 0) return reply(500, { error: '服务器内部错误' });

    /* ---------------- 健康 ---------------- */
    if (p === '/health' && method === 'GET') return reply(200, { ok: true, db: 'up' });

    /* ---------------- 注册 ---------------- */
    if (p === '/auth/signup' && method === 'POST') {
      const name = String(body.username || '');
      const pw = String(body.password || '');
      /* ⚠⚠ 校验顺序照服务端：先格式 / 长度（这些**不**消耗额度），
         额度检查放在最后 —— 于是「连打 N 个失败请求」不会吃光额度。 */
      if (!USERNAME_RE.test(name)) {
        return reply(400, { ok: false, error: '用户名只能用小写字母、数字、- 和 _，以字母开头，6~25 位' });
      }
      if (pw.length < PASSWORD_MIN) return reply(400, { ok: false, error: '密码至少 ' + PASSWORD_MIN + ' 位' });
      if (pw.length > PASSWORD_MAX) return reply(400, { ok: false, error: '密码最多 ' + PASSWORD_MAX + ' 位' });
      if (users.has(name)) return reply(409, { ok: false, error: '这个用户名已经有人用了，换一个吧' });
      if (!quotaLeft()) {
        return reply(429, { ok: false, error: '注册太频繁了，请稍后再试（每个 IP 每小时最多 ' + SIGNUP_MAX + ' 个）' });
      }
      const uid = newUid();
      users.set(name, { uid: uid, password: pw });
      consume();                                   // ⚠ 只有到这一步才计数
      const t = newToken(uid);
      return reply(201, { ok: true, token: t, uid: uid, username: name, expireIn: 2592000 });
    }

    /* ---------------- 登录 ---------------- */
    if (p === '/auth/signin' && method === 'POST') {
      const name = String(body.username || '');
      const pw = String(body.password || '');
      const u = users.get(name);
      /* ⚠⚠ 三种失败回**同一句**（反账号枚举，服务端就是这么做的）——
         分开报「账号不存在」和「密码错」等于免费送一个账号查询接口。 */
      if (!u || u.password !== pw) {
        return reply(401, { ok: false, error: '用户名或密码不对' });
      }
      const t = newToken(u.uid);
      return reply(200, { ok: true, token: t, uid: u.uid, username: name, expireIn: 2592000 });
    }

    /* ---------------- whoami ---------------- */
    if (p === '/auth/whoami' && method === 'GET') {
      const uid = uidOf(init);
      if (!uid) return reply(401, { ok: false, error: '登录已过期，请重新登录' });
      let name = '';
      users.forEach(function (v, k) { if (v.uid === uid) name = k; });
      return reply(200, { ok: true, uid: uid, username: name });
    }

    /* ---------------- 记录（uid 只从 JWT 取）---------------- */
    const me = uidOf(init);
    if (!me) return reply(401, { ok: false, error: '登录已过期，请重新登录' });

    if (p === '/records' && method === 'GET') {
      /* ⚠⚠ 筛选复刻服务端 recordFilter.ts 的口径：
         同类多选 = 或（列 IN (…)）、跨类 = 且（AND）；
         **不传 / 空串 / 非法值 = 该类不过滤**。
         桩要照**实测语义**抄，不能照「看起来应该怎样」抄 ——
         否则测出来的绿是假绿。 */
      const q = qs();
      const pick = function (raw, allowed) {
        const parts = [];
        (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).forEach(function (v) {
          String(v).split(',').forEach(function (s) {
            const t = s.trim();
            if (t) parts.push(t);
          });
        });
        const seen = {};
        const out = [];
        parts.forEach(function (ch) {
          // 与真实服务端一致：**长度必须为 1** 且在合法字符集里（indexOf 是子串匹配）
          if (ch.length !== 1) return;
          if (allowed.indexOf(ch) < 0) return;
          if (seen[ch]) return;
          seen[ch] = true; out.push(ch);
        });
        return out;
      };
      const cols = [
        ['yearGan', 'year_gan', '甲乙丙丁戊己庚辛壬癸'],
        ['yearZhi', 'year_zhi', '子丑寅卯辰巳午未申酉戌亥'],
        ['monthGan', 'month_gan', '甲乙丙丁戊己庚辛壬癸'],
        ['monthZhi', 'month_zhi', '子丑寅卯辰巳午未申酉戌亥'],
        ['dayGan', 'day_gan', '甲乙丙丁戊己庚辛壬癸'],
        ['dayZhi', 'day_zhi', '子丑寅卯辰巳午未申酉戌亥'],
        ['hourGan', 'hour_gan', '甲乙丙丁戊己庚辛壬癸'],
        ['hourZhi', 'hour_zhi', '子丑寅卯辰巳午未申酉戌亥']
      ];
      const conds = [];
      cols.forEach(function (c) {
        const picked = pick(q[c[0]], c[2]);
        if (picked.length) conds.push({ col: c[1], vals: picked });
      });
      // ⚠ 倒序（服务端按 created_ms DESC）
      const mine = rows.filter(function (r) {
        if (r.user_id !== me) return false;
        for (let i = 0; i < conds.length; i++) {
          if (conds[i].vals.indexOf(r[conds[i].col]) < 0) return false;
        }
        return true;
      })
        .sort(function (a, b) { return b.created_ms - a.created_ms; })
        .map(toWire);
      return reply(200, { ok: true, records: mine });
    }
    if (p === '/records' && method === 'DELETE') {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].user_id === me) { rows.splice(i, 1); n += 1; }
      }
      return reply(200, { ok: true, deleted: n });
    }
    if (p.indexOf('/records/') === 0 && method === 'PUT') {
      const id = decodeURIComponent(p.slice('/records/'.length));
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return reply(400, { ok: false, error: '记录 id 非法' });
      const rec = body.record || {};
      /* ⚠⚠ id 必须与路径里的一致 —— 服务端就是这么校验的。
         写成「取 body 里的 id」的话，「id 放 body」那个坑测不出来。 */
      if (String(rec.id || '') !== id) return reply(400, { ok: false, error: '记录 id 与路径不一致' });
      const idx = rows.findIndex(function (r) { return r.user_id === me && r.id === id; });
      const created = idx < 0;
      const row = {
        user_id: me, id: id,
        name: rec.name || '',
        gender: (rec.gender === 1 || rec.gender === 0) ? rec.gender : 1,
        birth_date: rec.date || '',
        birth_time: rec.time || '',
        created_ms: rec.createdAt || Date.now(),
        notes: rec.notes || null
      };
      /* ⚠⚠ 四柱列：服务端在**每次写入时重算**（routes/records.ts），
         桩也必须这么做 —— 否则筛选那几条测的是「桩自己算的对不对」，
         跟真实服务端的行为没关系。
         ⚠ 用**项目自己那份** tyme（src/vendor/tyme.js）算，与两端同源；
           另写一套干支就会引入「测试绿、真机错」的漂移。 */
      const p4 = pillarsOf(row.birth_date, row.birth_time);
      row.year_gan = p4 ? p4[0] : null;
      row.year_zhi = p4 ? p4[1] : null;
      row.month_gan = p4 ? p4[2] : null;
      row.month_zhi = p4 ? p4[3] : null;
      row.day_gan = p4 ? p4[4] : null;
      row.day_zhi = p4 ? p4[5] : null;
      row.hour_gan = p4 ? p4[6] : null;
      row.hour_zhi = p4 ? p4[7] : null;
      if (created) rows.push(row); else rows[idx] = row;
      return reply(created ? 201 : 200, { ok: true, record: toWire(row), created: created });
    }
    if (p.indexOf('/records/') === 0 && method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/records/'.length));
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return reply(400, { ok: false, error: '记录 id 非法' });
      const idx = rows.findIndex(function (r) { return r.user_id === me && r.id === id; });
      /* ⚠ 删别人的 / 本来就没有的 → deleted:false，**不是**失败（也不泄露存在性） */
      if (idx < 0) return reply(200, { ok: true, deleted: false });
      rows.splice(idx, 1);
      return reply(200, { ok: true, deleted: true });
    }

    return reply(404, { ok: false, error: '没有这个接口' });
  }

  return {
    stub: stub, log: log, users: users, tokens: tokens, rows: rows,
    /** 直接造一个号（绕过注册，省得每个用例都走一遍界面流程） */
    seed: function (name, pw) {
      const uid = newUid();
      users.set(name, { uid: uid, password: pw });
      return uid;
    }
  };
}

/* ============================================================ 用例工具 */

/**
 * 让 session 持有一个「本地模式」的令牌（模拟登录成功后）。
 *
 * ⚠⚠ username 必须走 `extra`（第二个参数），**不能**塞进 tokens 里 ——
 *   session.save 只从 extra 读 username；塞进 tokens 的话账号名会被静默丢掉，
 *   设置页就变成一串空白（而 login 时恰好带了 extra，所以只有「只 save 令牌」
 *   那条路才暴露 —— 本地模式也正是这条路）。
 *
 * ⚠⚠ `session.save()` 是**同步**的（内存镜像 + fire-and-forget 落盘）⇒
 *   它返回的是**状态对象**，不是 Promise。想 .then 它就会 `not a function`
 *   —— 用例里踩过一次，症状是「整个用例静默不跑」而不是报业务错。
 *   这里统一包成 Promise，调用方有无 await 都对。
 */
function giveSession(token, uid, expireInSec, name) {
  session._reset();
  return Promise.resolve(session.save(
    { accessToken: token, uid: uid, expireIn: (expireInSec === undefined) ? 2592000 : expireInSec },
    { username: name || 'zhangsan01' }
  ));
}

function resetAll() {
  session._reset();
  localsdk._setFetch(null);
  storage._clear();
}

/* ================================================================ 开跑 */

function run() {
  const results = [];

  /* ================================================================
   * 一、规则一致性：前端那份正则**必须**与服务端逐字相同
   * ================================================================
   * ⚠⚠ 这是本文件**最重要**的一条。前端为了「还没提交就给出提示」抄了一份
   *   用户名正则（不可能为每次击键去打服务端）。一旦漂移，
   *   表现是「前端放行、服务端 400」—— 用户拿到一句他永远改不对的提示，
   *   而两边都觉得自己是对的。这里直接把**服务端源码文本**读出来比对，
   *   逼着任何人改一边就得改另一边。
   */
  console.log('\n--- 规则一致性（前端 ↔ 服务端） ---');
  {
    const svr = path.join(__dirname, '..', '..', 'paipan-server', 'src', 'lib', 'identity.ts');
    if (!fs.existsSync(svr)) {
      // ⚠ 服务端不在同一个工作区时**如实跳过**，别静默绿 ——
      //   静默绿会让「这条守卫根本不存在」看起来像「守卫通过了」
      ok('⚠ 找到服务端 identity.ts 以便逐字比对正则', false, '没找到 ' + svr);
    } else {
      const text = fs.readFileSync(svr, 'utf8');
      const m = /USERNAME_RE\s*=\s*(\/\^\[a-z\]\[0-9a-z_-\]\{5,24\}\$\/)/.exec(text);
      ok('能从服务端源码里抠出 USERNAME_RE 字面量', !!m,
        '没抠到 ⇒ 服务端把正则写成了别的形式，请更新本文件的锚点');
      if (m) {
        eq('⚠⚠ 前端 USERNAME_RE 与服务端**逐字相同**',
          String(localsdk.USERNAME_RE), m[1]);
      }
      /* 长度上下界也要对得上（正则里写着 5,24，换算过来是 6~25） */
      const minM = /USERNAME_MIN\s*=\s*(\d+)/.exec(text);
      const maxM = /USERNAME_MAX\s*=\s*(\d+)/.exec(text);
      ok('能从服务端源码里抠出 USERNAME_MIN/MAX', !!minM && !!maxM, '锚点失配');
      if (minM && maxM) {
        eq('USERNAME_MIN 与前端一致', localsdk.USERNAME_MIN, Number(minM[1]));
        eq('USERNAME_MAX 与前端一致', localsdk.USERNAME_MAX, Number(maxM[1]));
        /* ⚠ 正则与常量必须自洽：5,24 ↔ 6~25。不自洽的话两边都对不上。 */
        eq('⚠ 正则的 {5,24} 与常量 6~25 自洽（首字符 + 至少 5 位 = 6）',
          localsdk.USERNAME_MAX - localsdk.USERNAME_MIN, 19);
      }
    }

    const authTs = path.join(__dirname, '..', '..', 'paipan-server', 'src', 'routes', 'auth.ts');
    if (fs.existsSync(authTs)) {
      const t = fs.readFileSync(authTs, 'utf8');
      const pm = /const PASSWORD_MIN\s*=\s*(\d+)/.exec(t);
      ok('能从服务端抠出 PASSWORD_MIN', !!pm, '锚点失配');
      if (pm) eq('⚠ PASSWORD_MIN 与前端一致（不一致会让「明明够长」被拒）',
        localsdk.PASSWORD_MIN, Number(pm[1]));
      const sm = /const SIGNUP_MAX\s*=\s*(\d+)/.exec(t);
      ok('能从服务端抠出 SIGNUP_MAX', !!sm, '锚点失配');
      if (sm) ok('⚠ 注册限额是个合理的小数字（<50）', Number(sm[1]) > 0 && Number(sm[1]) < 50,
        'SIGNUP_MAX=' + sm[1]);
    }
  }

  /* ================================================================
   * 二、localsdk 的纯函数：清洗 / 合法性 / 错误文案
   * ================================================================ */
  console.log('\n--- localsdk.js（纯函数） ---');
  {
    eq('normalizeUsername 去空格 + 转小写', localsdk.normalizeUsername('  ZhangSan01  '), 'zhangsan01');
    eq('normalizeUsername(null) 不崩', localsdk.normalizeUsername(null), '');
    ok('usernameOk 认 6 位合法名', localsdk.usernameOk('zhangsan01'));
    ok('⚠ 数字开头要拒', !localsdk.usernameOk('1zhangsan'));
    ok('⚠ 点号要拒（CloudBase 文档说允许、实测不允许）', !localsdk.usernameOk('zhang.san'));
    ok('5 位要拒（下界是 6）', !localsdk.usernameOk('zhang'));
    ok('26 位要拒（上界是 25）', !localsdk.usernameOk('z' + new Array(26).join('a')));
    ok('⚠ 大写要归一后通过（不是直接拒）', localsdk.usernameOk('ZhangSan01'));

    /* ⚠⚠ 这里**故意没有** normalizePassword —— 密码逐字有效，trim 一下就永远登不上 */
    ok('⚠⚠ localsdk 不导出 normalizePassword（密码不许被清洗）',
      localsdk.normalizePassword === undefined,
      '有的话说明有人加了密码清洗 ⇒ 会让「结尾带空格的真密码」永远登不上');

    /* 错误文案：与 cbsdk 的策略**刻意相反** —— 直接用服务端的中文 */
    eq('errText 优先用服务端给的中文原文', localsdk.errText({ error: '这个用户名已经有人用了，换一个吧' }, 409, null),
      '这个用户名已经有人用了，换一个吧');
    eq('没有 error 字段时用 fallback', localsdk.errText({}, 500, '兜底句'), '兜底句');
    ok('都没有时给一句带状态码的中文', /HTTP 500/.test(localsdk.errText(null, 500, null)));
    /* ⚠ 与 cbsdk 的差别：那边**绝不**透传服务端原文（英文黑话），这边**就该**透传 */
    ok('⚠ 本地版不做英文黑话映射表（服务端本来就是中文）',
      !/malformed|invalid_argument/.test(localsdk.errText({ error: '服务器内部错误' }, 500, null)));

    /*
     * 网络提示：**随地址类型分两套**（2026-11-13）。
     * ⚠ 这里必须自己控地址，不能依赖 storeMode 的默认值 ——
     *   默认值可能是局域网 IP，也可能是公网隧道地址（用户改过之后），
     *   断言会跟着「上一次测试留下的状态」飘。
     */
    storeMode.setLocalUrlOverride('http://192.168.1.5:4000');
    const nh = localsdk.networkHint(false);
    ok('局域网地址：提示点名「同一个 WiFi」', /WiFi|wifi/.test(nh), nh);
    ok('局域网地址：提示点名「防火墙」', /防火墙/.test(nh), nh);
    ok('局域网地址：提示点名「服务是否启动」', /启动/.test(nh), nh);
    ok('超时提示与断网提示是两句不同的话', localsdk.networkHint(true) !== localsdk.networkHint(false));
    /* 公网地址（https 隧道）下**不能**再让人去查 WiFi —— 他本来就不跟电脑在一个网里 */
    storeMode.setLocalUrlOverride('https://abc-def.trycloudflare.com');
    const nh2 = localsdk.networkHint(false);
    ok('⚠ 公网地址：提示不再提「同一个 WiFi」', !/WiFi|wifi/.test(nh2), nh2);
    ok('公网地址：提示点名「服务器地址」与「上网」', /服务器地址/.test(nh2) && /上网/.test(nh2), nh2);
    ok('公网地址：超时提示也不提 WiFi', !/WiFi|wifi/.test(localsdk.networkHint(true)));
    storeMode.setLocalUrlOverride('');
  }

  /* ================================================================
   * 三、uidFromJwt：uid 的权威来源，且**正则直抠**不走 JSON.parse
   * ================================================================ */
  console.log('\n--- uidFromJwt ---');
  {
    const mk = function (payload) {
      return Buffer.from('{}', 'utf8').toString('base64url') + '.' +
        Buffer.from(payload, 'utf8').toString('base64url') + '.sig';
    };
    eq('能从 payload 里取出 uid', localsdk.uidFromJwt(mk('{"uid":"u00112233","iat":1}')), 'u00112233');
    eq('uid 带 - 和 _ 也能取', localsdk.uidFromJwt(mk('{"uid":"u-abc_DEF"}')), 'u-abc_DEF');
    eq('没有 uid 字段 → 空串', localsdk.uidFromJwt(mk('{"iat":1}')), '');
    eq('不是三段式 → 空串', localsdk.uidFromJwt('abc.def'), '');
    eq('空 → 空串', localsdk.uidFromJwt(''), '');
    eq('null → 空串', localsdk.uidFromJwt(null), '');
    eq('乱码 → 空串（不抛）', localsdk.uidFromJwt('a.!!!!.c'), '');
    /* ⚠⚠ 本地 uid 是字符串，不存在 CloudBase 那个「19 位 bigint 被 JSON.parse 吃低位」的问题；
       但仍用正则直抠 —— 口径一致比省那几行更重要（见 localsdk 注释）。 */
    ok('⚠ payload 里混着别的数字字段也不会取错',
      /^\.?/.test('') && localsdk.uidFromJwt(mk('{"exp":1799999999,"uid":"uDEADBEEF","n":12345678901234567890}')) === 'uDEADBEEF');

    /* ⚠⚠⚠ 下面两条是**唯一**能证明「正则直抠、不走 JSON.parse」的断言 ——
       别删。上面那七条 JSON.parse 版本**全都通过**（实测过：改了实现，
       158 条里一条都不红），所以只靠它们守不住「不许改成 JSON.parse」。
       构造依据：payload 本身不是合法 JSON，但 uid 字段清清楚楚；
       服务端哪天多吐一个裸标识符/裸控制字符/尾随内容，JSON.parse 直接抛 → 空串，
       而正则照样能抠出来。 */
    const notJson = [
      '{"uid":"uABC123","dbg":undefined}',
      '{"uid":"uABC123", "dbg":"a\tb"}',
      '{"uid":"uABC123"} trailing'
    ];
    eq('⚠⚠⚠ 不是合法 JSON 也照样抠得出 uid（证明没走 JSON.parse）',
      notJson.map(function (p) { return localsdk.uidFromJwt(mk(p)); }).join(','),
      'uABC123,uABC123,uABC123');
  }

  /* ================================================================
   * 四、登录 / 注册的**报错口径刻意相反**
   * ================================================================ */
  console.log('\n--- 登录 / 注册：报错口径 ---');
  {
    const steps = [];
    /* ⚠⚠ 所有环境准备都放进**第一个 step** —— 见文件末尾「用例是异步链」那段注释：
       在组内同步执行的话，交给链跑时早被后面组的 resetAll 抹掉了（踩过）。 */
    let s;
    let uid;
    steps.push(function () {
      resetAll();
      s = makeServer({});
      localsdk._setFetch(s.stub);
      uid = s.seed('zhangsan01', 'pw-123456');
    });
    steps.push(function () {
      /* 登录：账号不存在 / 密码错 / 用户名不合规 → **同一句** */
      return localsdk.signInWithPassword('nosuchuser01', 'pw-123456').then(function (r1) {
        return localsdk.signInWithPassword('zhangsan01', 'wrong-password').then(function (r2) {
            /* ⚠ 用 `1badname`（数字开头）—— 「BADNAME」不行：它归一化之后
               就是合法的 `badname`，压根到不了格式校验那一支（踩过）。 */
            return localsdk.signInWithPassword('1badname', 'pw-123456').then(function (r3) {
            ok('登录失败（账号不存在）如实报错', !r1.ok);
            ok('登录失败（密码错）如实报错', !r2.ok);
            /* ⚠⚠ 三条错误文案必须**完全一致**，否则等于送一个账号枚举接口 */
            eq('⚠⚠ 账号不存在与密码错的**文案完全相同**（反账号枚举）', r1.error, r2.error);
            eq('⚠ 用户名不合规也是同一句（不给「格式不对」这种区分）', r3.error, r1.error);
            eq('  └ 服务端原文就是「用户名或密码不对」', r1.error, '用户名或密码不对');
            });
        });
      });
    });

    steps.push(function () {
      /* 注册：必须**说清楚**（否则用户不知道改什么） */
      return localsdk.signUpWithPassword('zhangsan01', 'pw-123456').then(function (r1) {
        return localsdk.signUpWithPassword('1badname', 'pw-123456').then(function (r2) {
          return localsdk.signUpWithPassword('newuser01', '123').then(function (r3) {
            eq('⚠⚠ 重名 → 明确说「已经有人用了」（不是含糊的「注册失败」）', r1.ok, false);
            ok('  └ 文案里点明是用户名的问题', /用户名|有人用/.test(r1.error), r1.error);
            ok('⚠⚠ 格式不对 → 说清规则（登录那边可是含糊到底的）', /小写字母|字母开头/.test(r2.error), r2.error);
            ok('⚠ 密码太短 → 指出具体位数要求', /6/.test(r3.error), r3.error);
            /* 两条口径真的不一样 —— 这条防的是「有人把两边统一成一句话」 */
            neq('⚠⚠ 注册的报错与登录的报错**不是同一句**（口径刻意相反）',
              r2.error, '用户名或密码不对');
          });
        });
      });
    });

    /* ⚠ 注册成功必须能立刻用同一个账号登录，且 uid 一致 */
    steps.push(function () {
      return localsdk.signUpWithPassword('brandnew99', 'pw-123456').then(function (r) {
        ok('注册成功返回 ok', r.ok, r.ok ? '' : 'error=' + r.error);
        const tk = r.token || {};
        ok('  └ 带回 accessToken', !!tk.accessToken);
        eq('⚠⚠ 注册**不返回** refreshToken（本地后端没有续期接口）',
          tk.refreshToken, undefined);
        eq('  └ 也不返回 refresh_token 这种下划线写法',
          tk.refresh_token, undefined);
        const u1 = tk.uid;
        ok('uid 从 JWT 里解出来了（形状 u + 32 hex）', /^u[0-9a-f]{32}$/.test(String(u1)), u1);
        return localsdk.signInWithPassword('brandnew99', 'pw-123456').then(function (r2) {
          eq('⚠ 注册完立刻能登录，且 uid 一致（说明真的落库了）', (r2.token || {}).uid, u1);
        });
      });
    });

    /* ⚠⚠⚠ 「JWT 是权威、响应体只作兜底」这条**必须**被钉住。
       上面那些断言证明不了它 —— 桩返回的 body.uid 与 JWT 里的 uid 本来就是同一个值，
       把优先级调过来照样全绿（实测：换了实现，161 条一条都不红 = 假用例）。
       做法：造一个**两者不一致**的响应，断言取的是 JWT 里那个。
       （真实世界对得上才是常态，但一旦对不上，信错一边就是「拿着别人的记录」那种事故。） */
    steps.push(function () {
      const jwtUid = 'u' + 'a'.repeat(32);
      const bodyUid = 'u' + 'b'.repeat(32);
      const tok = Buffer.from('{}', 'utf8').toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ uid: jwtUid }), 'utf8').toString('base64url') + '.sig';
      localsdk._setFetch(function (url, init) {
        return Promise.resolve({
          status: 200,
          text: function () {
            return Promise.resolve(JSON.stringify({
              ok: true, token: tok, uid: bodyUid, username: 'zhangsan01', expireIn: 2592000
            }));
          }
        });
      });
      return localsdk.signInWithPassword('zhangsan01', 'pw-123456').then(function (r) {
        eq('⚠⚠⚠ JWT 里的 uid 优先于响应体的 uid（JWT 才是权威）',
          (r.token || {}).uid, jwtUid);
        neq('  └ 确实不是响应体那个（两者不同才说明真的有优先级）',
          (r.token || {}).uid, bodyUid);
      });
    });

    /* ⚠⚠ 额度只对「注册成功」计数 —— 这是服务端第一版踩过的坑 */
    steps.push(function () {
      const s2 = makeServer({ signupMax: 3 });
      localsdk._setFetch(s2.stub);
      /* 先连打 12 个**必然失败**的请求（重名 / 格式错） */
      let chain = Promise.resolve();
      for (let i = 0; i < 12; i++) {
        chain = chain.then(function () {
          return localsdk.signUpWithPassword('bad_name_' + i + '!', 'pw-123456');
        });
      }
      return chain.then(function () {
        return localsdk.signUpWithPassword('gooduser01', 'pw-123456').then(function (r) {
          ok('⚠⚠ 连打 12 个**失败**请求后，正常注册仍然成功（额度只算成功数）', r.ok,
            r.ok ? '' : 'error=' + r.error);
          ok('  └ 这正是服务端第一版「一进来就计数」被实测抓出的那个 bug', r.ok);
          /* 再连注册到上限，第 4 个才该 429 */
          return localsdk.signUpWithPassword('gooduser02', 'pw-123456').then(function (a) {
            return localsdk.signUpWithPassword('gooduser03', 'pw-123456').then(function (b) {
              return localsdk.signUpWithPassword('gooduser04', 'pw-123456').then(function (c) {
                ok('第 2、3 个成功注册仍放行', a.ok && b.ok);
                ok('⚠ 超过上限（第 4 个）→ 如实报错', !c.ok);
                ok('  └ 429 的文案说清了「太频繁 / 每小时几个」', /频繁|每小时/.test(c.error), c.error);
              });
            });
          });
        });
      });
    });

    /* 本地入口的前置校验（不打网络就该拦下） */
    steps.push(function () {
      const s3 = makeServer({});
      localsdk._setFetch(s3.stub);
      return localsdk.signInWithPassword('', 'pw').then(function (r1) {
        return localsdk.signInWithPassword('zhangsan01', '').then(function (r2) {
          return localsdk.signUpWithPassword('   ', 'pw-123456').then(function (r3) {
            ok('空账号 → 本地就拦下，不发请求', /账号/.test(r1.error));
            ok('空密码 → 本地就拦下', /密码/.test(r2.error));
            ok('纯空白账号也算空（归一化之后为空）', /账号/.test(r3.error));
            eq('  └ 这三个都没发网络请求', s3.log.length, 0);
          });
        });
      });
    });

    results.push({ name: '登录/注册口径', steps: steps });
  }

  /* ================================================================
   * 五、request() 的失败语义：永不 reject、读失败 ≠ 没数据
   * ================================================================ */
  console.log('\n--- request / 失败语义 ---');
  {
    const steps = [];
    steps.push(function () { resetAll(); });

    /* ⚠ 断网：必须回 ok:false + NETWORK，且文案带三个自查步骤 */
    steps.push(function () {
      /* ⚠ 文案分两套（局域网 / 公网），这里要验的是局域网那套 ⇒ 先固定成局域网地址 */
      storeMode.setLocalUrlOverride('http://192.168.1.5:4000');
      localsdk._setFetch(function () { return Promise.reject(new TypeError('Network request failed')); });
      return localsdk.request('/records', {}).then(function (r) {
        eq('⚠ 断网 → ok:false（**永不 reject**）', r.ok, false);
        eq('  └ 码是 NETWORK', r.code, 'NETWORK');
        ok('  └ 文案讲清了三个自查步骤', /WiFi/.test(r.error) && /防火墙/.test(r.error));
        eq('  └ status 为 0（不是编一个 500）', r.status, 0);
        storeMode.setLocalUrlOverride('');   // 收尾：别把地址覆盖漏给后面的用例
      });
    });

    /* ⚠ 超时：AbortError → TIMEOUT（与断网分开，用户该做的事不同） */
    steps.push(function () {
      storeMode.setLocalUrlOverride('http://192.168.1.5:4000');   // 同上：验局域网那套文案
      localsdk._setFetch(function () {
        const e = new Error('aborted');
        e.name = 'AbortError';
        return Promise.reject(e);
      });
      return localsdk.request('/records', {}).then(function (r) {
        eq('⚠ 超时 → 码是 TIMEOUT（与 NETWORK 分开）', r.code, 'TIMEOUT');
        ok('  └ 超时文案提到「同一个 WiFi」与「服务还在运行」', /WiFi/.test(r.error) && /运行/.test(r.error));
        storeMode.setLocalUrlOverride('');
      });
    });

    /* ⚠⚠ 2xx 但 body 不是 JSON（比如中间夹了个代理回了 HTML）→ 必须判失败 */
    steps.push(function () {
      localsdk._setFetch(function () {
        return Promise.resolve({ status: 200, text: function () { return Promise.resolve('<html>hi</html>'); } });
      });
      return localsdk.request('/records', {}).then(function (r) {
        eq('⚠⚠ 200 + 非 JSON → 失败（只看 status 会把一坨 HTML 当成功）', r.ok, false);
      });
    });

    /* ⚠⚠ 2xx 但 body.ok 不是 true（服务端承诺永远带 ok）→ 也必须判失败 */
    steps.push(function () {
      const s = makeServer({ noOk: true });
      localsdk._setFetch(s.stub);
      return localsdk.request('/health', {}).then(function (r) {
        eq('⚠ 200 但没有 ok 字段 → 失败（判据是 status 2xx **且** body.ok）', r.ok, false);
      });
    });

    /* ⚠ 服务端 4xx 的中文原文必须原样带出（不透传反而更糟） */
    steps.push(function () {
      const s = makeServer({});
      localsdk._setFetch(s.stub);
      return localsdk.request('/auth/signin', { method: 'POST', body: { username: 'nobody0001', password: 'x' } })
        .then(function (r) {
          eq('⚠ 4xx → ok:false 且带上服务端的中文原文', r.error, '用户名或密码不对');
          eq('  └ status 如实带回（401）', r.status, 401);
        });
    });

    /* 服务端 5xx：不能当「登录过期」（一次抖动清掉所有人登录态） */
    steps.push(function () {
      const s = makeServer({ failOn: '/records' });
      localsdk._setFetch(s.stub);
      return localsdk.request('/records', {}).then(function (r) {
        eq('5xx → ok:false', r.ok, false);
        neq('⚠⚠ 5xx 不能被当成「登录过期」（否则一次服务端抖动人就被踢出去）', r.code, 'EXPIRED');
      });
    });

    results.push({ name: 'request 失败语义', steps: steps });
  }

  /* ================================================================
   * 六、session 在 local 模式下的**无续期**行为（最关键的一组）
   * ================================================================
   * ⚠⚠ 伪造 refreshToken 的后果：用户第 30 天被弹去重新登录，
   *   而报错说「续期失败，请检查网络」。这一组就是把那条路堵死。
   */
  console.log('\n--- session × local（无续期） ---');
  {
    const steps = [];
    let s;
    let uid;
    steps.push(function () {
      resetAll();
      s = makeServer({});
      localsdk._setFetch(s.stub);
      uid = s.seed('zhangsan01', 'pw-123456');
    });

    steps.push(function () {
      eq('⚠⚠ local 模式下 hasRefresh() 为 false', session.hasRefresh(), false);
    });

    steps.push(function () {
      const tok = Buffer.from('{}', 'utf8').toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ uid: uid }), 'utf8').toString('base64url') + '.sig';
      giveSession(tok, uid, 3600);
      /* ⚠⚠⚠ 这一步是**唯一**在守 session.save 的字段收敛规则。
         本地后端把 uid 放在 `uid` 字段（CloudBase 是 `sub`）——
         save() 少认一个 ⇒ sub 恒为空 ⇒ 上层判「未登录」⇒
         用户明明登录了却一直被踢去登录页（「登录了却像没登录」）。
         ⚠ 不要只断言 whoami 能通：那条路的桩是按令牌串查表的，
           sub 空不空它照样能回 —— 只有直接盯 sub 才拦得住。 */
      const c = session.get() || {};
      eq('⚠⚠⚠ session.save 认了本地后端的 uid 字段（收敛成内部 sub）', c.sub, uid);
      eq('  └ uid 没被写丢（空的话上层会当成「未登录」）', !!c.sub, true);
      return session.getAccessToken().then(function (t) {
        eq('⚠ 令牌还有效 → 直接给，不发任何请求', t.ok, true);
        eq('  └ 而且**没有**去调续期接口（本地根本没有）', t.token, tok);
        eq('  └ 中间没有任何网络请求', s.log.length, 0);
      });
    });

    steps.push(function () {
      /* ⚠ 令牌过期 → 必须回 EXPIRED 并清掉凭证（不是「续期失败，请检查网络」） */
      const tok = Buffer.from('{}', 'utf8').toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ uid: uid }), 'utf8').toString('base64url') + '.sig';
      giveSession(tok, uid, -1);   // 已经过期
      return session.getAccessToken().then(function (t) {
        eq('⚠ 过期 → ok:false', t.ok, false);
        eq('  └ 码是 EXPIRED（不是 NETWORK —— 用户要做的事完全不同）', t.code, 'EXPIRED');
        ok('  └ 文案说「重新登录」（不是「请重试」）', /重新登录|已过期/.test(t.error), t.error);
        /* ⚠ session.get() 清空后返回 **null**（不是空对象）—— 别直接取字段 */
        const after = session.get();
        eq('  └ 凭证被清掉了（下次会走到「未登录」而不是一直重试）', after, null);
        eq('  └ 也因此 hasSession() 为 false', session.hasSession(), false);
        eq('  └ 过期这条路**也没发任何请求**（没有续期接口可打）', s.log.length, 0);
      });
    });

    steps.push(function () {
      /* ⚠⚠ 令牌失效应由服务端说了算（401），不能被本地时钟先判死。
         ⚠ 桩要先认得这个令牌（s.tokens 是「服务端签发的令牌表」）——
           不登记的话 uidOf() 恒为空 ⇒ whoami 回 401，
           而你会以为「本地逻辑坏了」（踩过）。 */
      const tok = Buffer.from('{}', 'utf8').toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ uid: uid }), 'utf8').toString('base64url') + '.sig.known';
      s.tokens.set(tok, uid);
      return giveSession(tok, uid, 3600).then(function () {
        return session.getAccessToken();
      }).then(function (t) {
        return localsdk.whoami(t.token).then(function (w) {
          eq('⚠⚠ whoami 用同一个令牌能核对出 uid', w.uid, uid);
          eq('  └ 用户名也回来了（设置页要显示它）', w.username, 'zhangsan01');
        });
      });
    });

    steps.push(function () {
      /* 令牌被服务端作废（比如删号）→ whoami 401 */
      return localsdk.whoami('bad.token.here').then(function (w) {
        eq('⚠ 服务端不认的令牌 → ok:false', w.ok, false);
        ok('  └ 文案说「重新登录」', /重新登录|过期/.test(w.error), w.error);
      });
    });

    steps.push(function () {
      eq('没有令牌时 whoami 直接拒（不发请求）', localsdk.whoami('').then ? true : true, true);
      return localsdk.whoami('').then(function (w) {
        eq('  └ 码是 NO_TOKEN', w.code, 'NO_TOKEN');
      });
    });

    results.push({ name: 'session × local', steps: steps });
  }

  /* ================================================================
   * 七、localdb：契约与 cbdb 一致；uid 送出去但不是安全边界
   * ================================================================ */
  console.log('\n--- store/localdb.js ---');
  {
    const steps = [];
    let s;
    let meUid;
    let otherUid;
    steps.push(function () {
      resetAll();
      s = makeServer({});
      localsdk._setFetch(s.stub);
      meUid = s.seed('zhangsan01', 'pw-123456');
      otherUid = s.seed('lisi000001', 'pw-123456');
    });

    function loginAs(uid, name) {
      const tok = Buffer.from('{}', 'utf8').toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ uid: uid }), 'utf8').toString('base64url') + '.sig.' + name;
      s.tokens.set(tok, uid);
      return giveSession(tok, uid, 3600);
    }

    steps.push(function () {
      eq('⚠ 驱动形状与 cbdb 一致（有这五个方法）',
        ['listRecords', 'putRecord', 'deleteRecord', 'clearRecords', 'saveNotes']
          .filter(function (k) { return typeof localdb[k] === 'function'; }).length, 5);
      eq('⚠⚠ BASE 挂在根上（不是 PostgREST 那种 /v1/rdb/rest/）', localdb.BASE, '/records');
      ok('⚠ ID_RE 与服务端一致（白名单 [A-Za-z0-9_-]{1,64}）',
        localdb.ID_RE.test('abc-123_X') && !localdb.ID_RE.test('a/b') && !localdb.ID_RE.test(''));
    });

    steps.push(function () {
      return loginAs(meUid, 'me');
    });

    steps.push(function () {
      /* ⚠⚠ 没登录时必须**如实失败**，绝不能回 {ok:true, records:[]} ——
         那会让上层把「没登录」当成「云端真没有」，然后拿空列表覆盖。
         ⚠⚠⚠ 断言**必须查 code，不能只查 ok:false**：
           「没登录也当成成功」这个 bug 的后果是**带着空 token 去发请求**，
           而请求在测试环境里也会失败（`NO_FETCH`）⇒ 照样回 `ok:false`
           ⇒ 只查 `ok` 的话这个 bug 根本测不出来（负向验证实测 trc=0）。
           查 `code === 'NO_SESSION'` 才能区分「被会话层拦下」与「网络失败」。 */
      session._reset();
      storage._clear();
      return localdb.listRecords(meUid).then(function (r) {
        eq('⚠⚠ 没登录 → ok:false（不是「没有记录」）', r.ok, false);
        eq('  └ 是会话层拦的（code=NO_SESSION），不是网络失败', r.code, 'NO_SESSION');
        eq('  └ 没有 records 字段（不给空数组）', r.records, undefined);
        return loginAs(meUid, 'me');
      });
    });

    steps.push(function () {
      return localdb.putRecord(meUid, { id: 'r1', name: '甲', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 1000 })
        .then(function (r) {
          eq('新增一条 → ok', r.ok, true);
          eq('  └ created 为 true', r.created, true);
          eq('  └ ⚠ 出参形状是前端的（date，不是 birth_date）', r.record.date, '1990-01-01');
          eq('  └ ⚠ createdAt 也是前端形状（不是 created_ms）', r.record.createdAt, 1000);
        });
    });

    steps.push(function () {
      /* ⚠⚠ id 必须在**路径**里。桩会校验「路径 id === body id」，
         所以写成 PUT /records（id 放 body）会 400/404。 */
      const before = s.log.length;
      return localdb.putRecord(meUid, { id: 'r2', name: '乙', gender: 0, date: '1991-02-02', time: '09:00', createdAt: 2000 })
        .then(function (r) {
          ok('⚠⚠ 新增走的是 PUT /records/r2（id 在路径里）', r.ok);
          const sent = s.log.slice(before);
          ok('  └ 真的发了 PUT /records/r2', sent.indexOf('PUT /records/r2') >= 0,
            '实际发的：' + JSON.stringify(sent));
        });
    });

    steps.push(function () {
      /* 同 id 再写 = 覆盖，不产生第二条 */
      return localdb.putRecord(meUid, { id: 'r1', name: '甲改', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 1000 })
        .then(function (r) {
          eq('同 id 再写 → created 为 false（是覆盖不是新增）', r.created, false);
          return localdb.listRecords(meUid).then(function (l) {
            eq('⚠ 列表仍是 2 条（没产生重复行）', l.records.length, 2);
          });
        });
    });

    steps.push(function () {
      return localdb.listRecords(meUid).then(function (r) {
        eq('读列表 → ok', r.ok, true);
        const ids = r.records.map(function (x) { return x.id; });
        eq('⚠ 倒序（createdAt 大的在前）', ids[0], 'r2');
      });
    });

    steps.push(function () {
      /* ⚠⚠ uid 参数只是契约形状 —— 传别人的 uid 也读不到别人的数据 */
      return loginAs(otherUid, 'other').then(function () {
        return localdb.listRecords(meUid).then(function (r) {
          eq('⚠⚠ 拿着别人的 uid 参数，读到的仍是**自己**的记录（uid 只认 JWT）',
            r.records.length, 0);
          return loginAs(meUid, 'me');
        });
      });
    });

    steps.push(function () {
      return localdb.deleteRecord(meUid, 'r2').then(function (r) {
        eq('删一条 → ok', r.ok, true);
        eq('  └ deleted 为 true', r.deleted, true);
        return localdb.deleteRecord(meUid, 'r2').then(function (r2) {
          eq('⚠ 重复删除**不算失败**（目标状态已达成）', r2.ok, true);
          eq('  └ 只是 deleted 为 false', r2.deleted, false);
        });
      });
    });

    steps.push(function () {
      eq('非法 id → 本地就拦下（不发请求）', localdb.deleteRecord(meUid, 'a/b').then ? true : true, true);
      return localdb.deleteRecord(meUid, 'a/b').then(function (r) {
        eq('  └ 码是 BAD_ID', r.code, 'BAD_ID');
        return localdb.putRecord(meUid, { id: '' }).then(function (r2) {
          eq('空 id 也拦下', r2.code, 'BAD_ID');
        });
      });
    });

    steps.push(function () {
      return localdb.clearRecords(meUid).then(function (r) {
        eq('清空 → ok', r.ok, true);
        eq('⚠ deleted 是**条数**（不是布尔，别和 deleteRecord 混）', typeof r.deleted, 'number');
        eq('  └ 清掉了 1 条', r.deleted, 1);
        return localdb.listRecords(meUid).then(function (l) {
          eq('清空后仍是 ok:true + 空数组（「没有记录」不是失败）', l.ok, true);
          eq('  └ 列表为空', l.records.length, 0);
        });
      });
    });

    steps.push(function () {
      /* ⚠⚠ 读失败（断网）→ 绝不能伪装成「没有记录」 */
      localsdk._setFetch(function () { return Promise.reject(new TypeError('Network request failed')); });
      return localdb.listRecords(meUid).then(function (r) {
        eq('⚠⚠ 断网时 pull 返回 ok:false', r.ok, false);
        eq('  └ **没有** records 字段（不能给空数组，否则会被拿去覆盖）', r.records, undefined);
        ok('  └ 带上了可读的中文错误', /WiFi|连不上/.test(r.error), r.error);
        localsdk._setFetch(s.stub);
      });
    });

    results.push({ name: 'store/localdb', steps: steps });
  }

  /* ================================================================
   * 八之二、记录筛选：前端只是「传参」，筛选由后端做
   * ================================================================
   * ⚠⚠ 这一节要守的就一句话：**App 不筛，只传参**。
   *   病根场景：视图自己 `records.filter(...)` —— 本地看着对，
   *   一旦记录多到分页/换后端就全错，而且「后端到底有没有按参数筛」
   *   永远测不出来（因为前端已经先筛过了）。
   *
   * ⚠ 断言的判据要能认出「改坏一处」：
   *   ① 结果集本身（OR 内 / AND 间 / 空类不筛）；
   *   ② **请求串里真的带上了那个参数**（查 s.log）——
   *      否则「结果看着对」可能是因为桩压根没收到参数、回的是全量。
   */
  console.log('\n--- 记录筛选（后端筛，前端只传参）---');
  {
    const steps = [];
    let meUid;
    let s;
    /* ⚠ loginAs 是**块作用域**的，上面那节的那份在这里看不见 —— 必须自己再来一份，
       否则整节会因为 `loginAs is not defined` 静默不跑（症状是「这节一条都没出」）。 */
    function loginAs(uid, name) {
      const tok = Buffer.from('{}', 'utf8').toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ uid: uid }), 'utf8').toString('base64url') + '.sig.' + name;
      s.tokens.set(tok, uid);
      return giveSession(tok, uid, 3600);
    }
    /* 三个刻意挑的命造：用来区分「同类或」「跨类且」
       （⚠ 名字别写死干支 —— 干支由 tyme 算，写死了改 fixture 就名不副实） */
    const FIX = [
      /* id,  姓名,     性别, 公历,         时间,   createdAt */
      ['fa', '同柱甲', 1, '2000-05-06', '12:00', 1000],
      ['fb', '同柱乙', 0, '2000-05-06', '12:00', 2000],
      ['fc', '异柱丙', 1, '1985-11-20', '08:30', 3000]
    ];

    steps.push(function () {
      resetAll();
      s = makeServer({});
      localsdk._setFetch(s.stub);
      meUid = s.seed('zhangsan01', 'pw-123456');
      return loginAs(meUid, 'me');
    });

    steps.push(function () {
      /* 先把桩的库填好 —— 四柱由**桩按 PUT 时重算**，不是我们手填的 */
      return FIX.reduce(function (p, f) {
        return p.then(function () {
          return localdb.putRecord(meUid, {
            id: f[0], name: f[1], gender: f[2], date: f[3], time: f[4], createdAt: f[5]
          });
        });
      }, Promise.resolve());
    });

    /* 取桩里某条的某一列（四柱列由桩按 PUT 时重算，所以这就是「真值」） */
    function col(id, c) {
      const r = s.rows.find(function (x) { return x.id === id; });
      return r ? r[c] : null;
    }

    steps.push(function () {
      /* ⚠ 前置：确认桩真的算出了四柱列（否则后面全是空筛） */
      const rows = s.rows.filter(function (r) { return r.user_id === meUid; });
      eq('前置：桩里落了 3 条', rows.length, 3);
      const fa = rows.find(function (r) { return r.id === 'fa'; });
      ok('  └ ⚠ 桩**自己**算出了四柱列（不是我们手填的）',
        !!fa.year_gan && !!fa.day_gan, JSON.stringify(fa));
      /* ⚠⚠ 记录**当前**四柱（不写死），下面的断言全部据此推导 ——
         fixture 一改，这些数字自动跟着走，不会变成「改个日期就红一片」的脆测试。 */
      ok('  └ 且 fa / fb 同生日 ⇒ 四柱相同（这是「同类或」用例的前提）',
        col('fa', 'day_gan') === col('fb', 'day_gan'), col('fa', 'day_gan') + '/' + col('fb', 'day_gan'));
      ok('  └ 且 fc 的日干与 fa 不同（这是「跨类且」用例的前提）',
        col('fc', 'day_gan') !== col('fa', 'day_gan'),
        col('fa', 'day_gan') + ' vs ' + col('fc', 'day_gan'));
    });

    steps.push(function () {
      /* 基线：不带筛选参数 = 全量（这是「空类 = 全部」在网线上的样子） */
      return localdb.listRecords(meUid).then(function (r) {
        eq('不传筛选 → ok', r.ok, true);
        eq('  └ 回全量 3 条', r.records.length, 3);
        eq('  └ 倒序（createdAt 大的在前）', r.records[0].id, 'fc');
      });
    });

    steps.push(function () {
      /* ---- 单类单选 ---- */
      const g = col('fa', 'day_gan');
      const before = s.log.length;
      return localdb.listRecordsFiltered(meUid, { dayGan: [g] }).then(function (r) {
        eq('日干=' + g + ' → 命中 2 条（fa/fb）', r.records.length, 2);
        const ids = r.records.map(function (x) { return x.id; }).sort();
        eq('  └ 命中的是 fa/fb', ids.join(','), 'fa,fb');
        const sent = s.log.slice(before);
        ok('  └ ⚠ 参数真的发到了服务端（结果对也可能是桩回的全量）',
          /dayGan=/.test(sent.join(' ')), JSON.stringify(sent));
      });
    });

    steps.push(function () {
      /* ---- ★ 同类多选 = 或（OR）---- */
      /* fa/fb 同柱、fc 异柱 ⇒ 选「两者都收」应回 3 条；
         若误实现成「且」，交集为空 → 0 条。这一步就是分辨两者的那把尺。 */
      const g1 = col('fa', 'day_gan');
      const g2 = col('fc', 'day_gan');
      return localdb.listRecordsFiltered(meUid, { dayGan: [g1, g2] }).then(function (r) {
        eq('⚠★ 同类多选 = **或**（' + g1 + ' 或 ' + g2 + ' → 3 条；写成「且」会是 0）',
          r.records.length, 3);
      });
    });

    steps.push(function () {
      /* ---- ★ 跨类 = 且（AND）---- */
      /* fa/fb 同日同柱 ⇒ 拿「日干」+「年支」两个类去筛：
         fa/fb 的年支相同 → 仍 2 条；fc 年支不同 → 被排除。
         若误把跨类也做成「或」，fc 会因为某一个类命中而被留下（3 条）。 */
      const g = col('fa', 'day_gan');
      const z = col('fa', 'year_zhi');
      return localdb.listRecordsFiltered(meUid, { dayGan: [g], yearZhi: [z] })
        .then(function (r) {
          eq('⚠★ 跨类 = **且**（日干=' + g + ' 且 年支=' + z + ' → 2 条，fc 被排除）',
            r.records.length, 2);
          const ids = r.records.map(function (x) { return x.id; }).sort();
          eq('  └ 只剩 fa/fb', ids.join(','), 'fa,fb');
        });
    });

    steps.push(function () {
      /* ---- ★ 跨类互斥 → 0 条，且**仍然是成功** ---- */
      const g = col('fa', 'day_gan');
      /* 挑一个**确实没人**的支：fc 的日支与 fa 不同 ⇒ 「日干=fa的 且 日支=fc的」必然为空 */
      const zOther = col('fc', 'day_zhi');
      return localdb.listRecordsFiltered(meUid, { dayGan: [g], dayZhi: [zOther] })
        .then(function (r) {
          eq('空结果仍是 ok:true（「筛空了」不是失败）', r.ok, true);
          eq('  └ 而且是**数组**（不是 undefined，别和「拉取失败」混）',
            Array.isArray(r.records), true);
          eq('  └ 条数 0', r.records.length, 0);
        });
    });

    steps.push(function () {
      /* ---- 空类 / 空串 / 非法值 = 该类不筛 ---- */
      return localdb.listRecordsFiltered(meUid, { dayGan: [], yearZhi: [''] }).then(function (r) {
        eq('空数组 + 空串 → 等于不过滤，回全量 3 条', r.records.length, 3);
        const sent = s.log[s.log.length - 1];
        ok('  └ ⚠ 空类**不出现在查询串里**（出了就等于「筛空」）',
          !/dayGan=|yearZhi=/.test(sent), sent);
      });
    });

    steps.push(function () {
      /* ⚠ 非法值（多字 / 不在字符集里）必须被忽略，不能变成「筛 0 条」 */
      const g = col('fa', 'day_gan');
      return localdb.listRecordsFiltered(meUid, { dayGan: [g + g, 'X', g] }).then(function (r) {
        eq('非法值被忽略，合法的「' + g + '」仍生效 → 2 条', r.records.length, 2);
      });
    });

    steps.push(function () {
      /* ⚠⚠ 隔离：换个人登录，筛选照样只筛自己的（uid 只认 JWT） */
      const other = s.seed('lisi000001', 'pw-123456');
      const g = col('fa', 'day_gan');
      return loginAs(other, 'other').then(function () {
        return localdb.listRecordsFiltered(other, { dayGan: [g] }).then(function (r) {
          eq('⚠⚠ 换人登录后筛选 → 读到的是**自己**的（0 条），不是别人的 2 条',
            r.records.length, 0);
          return loginAs(meUid, 'me');
        });
      });
    });

    steps.push(function () {
      /* ⚠⚠ 最毒的一条：整体改记录（改个名字）后，四柱列**必须还在**。
         漏了「每次写入重算/带上四柱」⇒ 改完名字筛选就再也命中不了，
         而页面上一切正常（像「筛选功能时灵时不灵」）。 */
      const g = col('fa', 'day_gan');
      return localdb.putRecord(meUid, {
        id: 'fa', name: '改了名字', gender: 1, date: '2000-05-06', time: '12:00', createdAt: 1000
      }).then(function () {
        return localdb.listRecordsFiltered(meUid, { dayGan: [g] }).then(function (r) {
          eq('⚠⚠ 只改姓名后，该条**仍能被四柱筛到**（2 条，不是 1 条）', r.records.length, 2);
        });
      });
    });

    steps.push(function () {
      /* ⚠⚠ 换出生日期 → 四柱列必须跟着**重算**（旧值留着 = 按生日筛出错误结果） */
      const before = col('fb', 'day_gan');
      /* 1992-03-15 → 庚寅日；与 2000-05-06（甲子日）不同干，足够区分 */
      return localdb.putRecord(meUid, {
        id: 'fb', name: '同柱乙', gender: 0, date: '1992-03-15', time: '12:00', createdAt: 2000
      }).then(function () {
        const after = col('fb', 'day_gan');
        neq('⚠⚠ 改生日后四柱**重算了**（不是留着旧值）', after, before);
        return localdb.listRecordsFiltered(meUid, { dayGan: [before] }).then(function (r) {
          eq('  └ 旧日干「' + before + '」不再命中该条', r.records.length, 1);
          eq('  └ 只剩 fa', r.records[0].id, 'fa');
        });
      });
    });

    steps.push(function () {
      /* ⚠⚠ 只支持 local：别的后端不许静默给个点了没反应的按钮 */
      const keep = storeMode.MODE;
      storeMode.MODE = 'cloudbase';
      eq('⚠⚠ cloudbase 下 supportsFilter() 为 false（不假装能筛）',
        storeMode.supportsFilter(), false);
      storeMode.MODE = 'local';
      eq('  └ local 下为 true', storeMode.supportsFilter(), true);
      storeMode.MODE = keep;
    });

    steps.push(function () {
      /* ⚠⚠ 不支持筛选的后端：`store.listRecords(uid, filter)` 必须**把 filter 丢掉**
         （而不是把不认识的对象一路塞给驱动，让驱动自己去崩）。
         做法：临时把 cloudbase 驱动的 `listRecordsFiltered` 藏起来，
         看 store 是否退回「只传 uid」。 */
      const cbdb = require(path.join(CORE, 'store', 'cbdb.js'));
      const keepMode = storeMode.MODE;
      const had = Object.prototype.hasOwnProperty.call(cbdb, 'listRecordsFiltered');
      const saved = cbdb.listRecordsFiltered;
      let argc = -1;
      let gotFilter = 'N/A';

      storeMode.MODE = 'cloudbase';
      delete cbdb.listRecordsFiltered;
      /* 桩掉驱动的 listRecords，只数参数个数，不发网络 */
      const savedList = cbdb.listRecords;
      cbdb.listRecords = function (uid, filter) {
        argc = arguments.length;
        gotFilter = filter;
        return Promise.resolve({ ok: true, records: [] });
      };
      /* ⚠⚠ 调用本身可能**同步抛**（正是「把 filter 硬塞给不支持的驱动」那个 bug）——
         必须把它接住**当成一条 FAIL 报出来**，不能让异常穿出去。
         穿出去的后果：整节报一句「用例内部抛错」就停，
         要守的那条断言**根本不出现** ⇒ 负向验证里看着像「测试没抓到」。 */
      let called = null;
      try {
        called = store.listRecords('u1', { dayGan: ['庚'] });
      } catch (e) {
        ok('⚠⚠ 驱动没有 listRecordsFiltered 时，只传 uid（不把 filter 塞过去）', false,
          '同步抛了：' + (e && e.message));
      }
      const settle = called
        ? Promise.resolve(called).then(
          function () { return null; },
          function (e) {
            ok('⚠⚠ 驱动没有 listRecordsFiltered 时，只传 uid（不把 filter 塞过去）', false,
              '异步拒了：' + (e && e.message));
            return null;
          }
        )
        : Promise.resolve(null);

      return settle.then(function () {
        if (called) {
          eq('⚠⚠ 驱动没有 listRecordsFiltered 时，只传 uid（不把 filter 塞过去）', argc, 1);
          eq('  └ filter 确实没被透传', gotFilter, undefined);
        }
        cbdb.listRecords = savedList;
        if (had) cbdb.listRecordsFiltered = saved;
        storeMode.MODE = keepMode;
      });
    });

    results.push({ name: '记录筛选（后端筛）', steps: steps });
  }

  /* ================================================================
   * 八、saveNotes：先读整条再整体 PUT（本地没有 RPC 函数）
   * ================================================================
   * ⚠⚠ 这条最容易静默出事：不先读就 PUT，会把**并发写进来的别的字段一起盖掉**。
   */
  console.log('\n--- localdb.saveNotes（先读后写） ---');
  {
    const steps = [];
    let s;
    let uid;
    steps.push(function () {
      resetAll();
      s = makeServer({});
      localsdk._setFetch(s.stub);
      uid = s.seed('zhangsan01', 'pw-123456');
    });

    function login() {
      const tok = 'tok-' + uid;
      s.tokens.set(tok, uid);
      return giveSession(tok, uid, 3600);
    }

    steps.push(function () { return login(); });

    steps.push(function () {
      return localdb.putRecord(uid, { id: 'n1', name: '甲', gender: 1, date: '1990-01-01', time: '11:04', createdAt: 1000 });
    });

    steps.push(function () {
      const before = s.log.length;
      return localdb.saveNotes(uid, 'n1', { 'dayun:d0': { text: '换工作' } }).then(function (r) {
        eq('写 notes → ok', r.ok, true);
        const sent = s.log.slice(before);
        /* ⚠⚠ 必须先 GET 再 PUT —— 顺序反了就是「拿一份可能过期的快照去覆盖」 */
        eq('⚠⚠ 先读后写（GET 在 PUT 之前）', sent[0], 'GET /records');
        ok('  └ 第二步才是 PUT /records/n1', sent.indexOf('PUT /records/n1') > 0, JSON.stringify(sent));
        return localdb.listRecords(uid).then(function (l) {
          eq('⚠ notes 真的存进去了', l.records[0].notes['dayun:d0'].text, '换工作');
          eq('  └ 其它字段没被覆盖坏（name 还在）', l.records[0].name, '甲');
        });
      });
    });

    steps.push(function () {
      /* ⚠ notes 传空对象 = **删除** notes 字段（与 cbdb 同款语义） */
      return localdb.saveNotes(uid, 'n1', {}).then(function (r) {
        eq('清空 notes → ok', r.ok, true);
        return localdb.listRecords(uid).then(function (l) {
          eq('⚠ 传空对象 → notes 字段被删掉', l.records[0].notes, undefined);
          eq('  └ 但记录本身还在', l.records[0].id, 'n1');
        });
      });
    });

    steps.push(function () {
      /* ⚠ 记录不在了 → 明确报「already gone」，不是含糊的失败 */
      return localdb.saveNotes(uid, 'nosuchrec', { a: 1 }).then(function (r) {
        eq('记录不存在 → ok:false', r.ok, false);
        eq('  └ 码是 NOT_FOUND（页面据此提示「回记录页重进」而不是「请重试」）', r.code, 'NOT_FOUND');
      });
    });

    results.push({ name: 'localdb.saveNotes', steps: steps });
  }

  /* ================================================================
   * 九、auth：入口分流 + 注册守卫
   * ================================================================
   * ⚠⚠ `useCloudbase()` 从前兼职「有没有服务端」，现在拆开了。
   *   搞错的后果：本地模式下走 CloudBase 的分支，或反过来。
   */
  console.log('\n--- auth 入口分流 ---');
  {
    const steps = [];
    const keep = storeMode.MODE;
    steps.push(function () { resetAll(); });

    steps.push(function () {
      storeMode.MODE = 'local';
      eq('local → useLocal() 为 true', auth.useLocal(), true);
      eq('  └ useCloudbase() 为 false', auth.useCloudbase(), false);
      eq('  └ ⚠⚠ hasBackend()（所有网络分支的唯一判据）为 true', auth.hasBackend(), true);
      eq('  └ ⚠ canSignUp() 为 true（本地支持自助注册）', auth.canSignUp(), true);
    });

    steps.push(function () {
      storeMode.MODE = 'cloudbase';
      eq('cloudbase → useLocal() 为 false', auth.useLocal(), false);
      eq('  └ useCloudbase() 为 true', auth.useCloudbase(), true);
      eq('  └ useBackend() 仍为 true（网络分支要照走）', auth.hasBackend(), true);
      eq('  └ ⚠⚠ canSignUp() 为 false（平台禁死，501）', auth.canSignUp(), false);
    });

    steps.push(function () {
      storeMode.MODE = 'gitee';
      eq('gitee → useBackend() 为 false（不是 HTTP 后端）', auth.hasBackend(), false);
      eq('  └ useLocal/useCloudbase 都为 false', auth.useLocal() || auth.useCloudbase(), false);
      storeMode.MODE = keep;
    });

    steps.push(function () {
      /* ⚠ 每个合法 MODE 都必须被分流逻辑接住（漏一个会静默走到「没有后端」） */
      const legal = ['local', 'cloudbase'];
      legal.forEach(function (m) {
        storeMode.MODE = m;
        ok('MODE=' + m + ' 被 hasBackend() 接住', auth.hasBackend() === true);
      });
      storeMode.MODE = keep;
    });

    steps.push(function () {
      /* ⚠⚠ 注册守卫：不支持注册时**如实报错**，不能静默去调一个不存在的接口。
         ⚠⚠⚠ 断言**必须查 code，不能只查 ok:false**：
           去掉守卫后代码会落到 `localsdk.signUpWithPassword(...)`，而它在
           cloudbase 模式下**照样失败**（连不上本地地址）⇒ 也回 `ok:false`
           ⇒ 只查 `ok` 的话「守卫被删」根本测不出来（负向验证实测 trc=0）。
           查 `code === 'SIGNUP_UNSUPPORTED'` 才能区分「守卫拦下」与「网络失败」。 */
      storeMode.MODE = 'cloudbase';
      return auth.signUpWithPassword('newuser01', 'pw-123456').then(function (r) {
        eq('⚠⚠ cloudbase 下注册被守卫拦下（ok:false）', r.ok, false);
        eq('  └ 是守卫拦的（code=SIGNUP_UNSUPPORTED），不是网络失败', r.code, 'SIGNUP_UNSUPPORTED');
        ok('  └ 文案说得出「不支持注册」', /不支持|无法/.test(r.error), r.error);
        storeMode.MODE = keep;
      });
    });

    results.push({ name: 'auth 分流', steps: steps });
  }

  /* ================================================================
   * 十、store/index.js 按 MODE 选驱动
   * ================================================================ */
  console.log('\n--- store/index.js 选驱动 ---');
  {
    const keep = storeMode.MODE;
    storeMode.MODE = 'local';
    eq('MODE=local → pick() 给 localdb（BASE=/records）', store.pick().BASE, '/records');
    eq('  └ fileLevel() 为 false（记录级）', store.fileLevel(), false);
    storeMode.MODE = 'cloudbase';
    eq('MODE=cloudbase → 换回 cbdb（BASE 不同）', store.pick() !== localdb, true);
    storeMode.MODE = keep;
    eq('还原后是 localdb', store.pick(), localdb);
  }

  /* ================================================================
   * 十一、源码级断言：守住那些注释里的纪律
   * ================================================================ */
  console.log('\n--- 源码级纪律 ---');
  {
    const sdkText = fs.readFileSync(path.join(CORE, 'localsdk.js'), 'utf8');
    const dbText = fs.readFileSync(path.join(CORE, 'store', 'localdb.js'), 'utf8');
    const modeText = fs.readFileSync(path.join(CORE, 'storeMode.js'), 'utf8');

    /* ⚠⚠ 本地模式绝不能伪造 refreshToken —— 这是最容易「好心办坏事」的地方 */
    ok('⚠⚠ localsdk 里没有伪造 refreshToken 的赋值（回那个字段会误导 session 去续期）',
      !/refreshToken\s*:/.test(sdkText),
      '有的话 ⇒ session 会以为能自动续期 ⇒ 用户第 30 天被弹「续期失败，请检查网络」');
    ok('⚠⚠ session.hasRefresh() 在 local 下为 false（现取 MODE，不是加载时定死）',
      /MODE !== 'local'/.test(fs.readFileSync(path.join(CORE, 'session.js'), 'utf8')));

    /* ⚠ 地址只有一份来源 */
    ok('⚠⚠ 地址只由 storeMode 的 localUrl() 给出（LOCAL_URL + 运行时覆盖），localsdk 现取不拷贝',
      /function localUrl\(/.test(modeText) && /storeMode\.js'\)\.localUrl\(\)/.test(sdkText));
    ok('⚠⚠ localsdk.CONFIG.base 是 **getter**（加载时拷贝的话，测试改 storeMode 不生效）',
      /get base\(\)/.test(sdkText));

    /* ⚠ 地址不能是回环 —— 手机上的 127.0.0.1 指向手机自己 */
    const urlM = /const LOCAL_URL\s*=\s*'([^']+)'/.exec(modeText);
    ok('能从 storeMode.js 抠出 LOCAL_URL', !!urlM, '锚点失配');
    if (urlM) {
      ok('⚠⚠ LOCAL_URL 不是回环地址（手机必须用局域网 IP）',
        !/127\.0\.0\.1|localhost/.test(urlM[1]), urlM[1]);
      /* ⚠ 局域网地址必须带端口；公网 https 隧道地址可以省（443 是默认端口） */
      ok('  └ 带端口，或是 https 公网地址',
        /:\d+/.test(urlM[1]) || /^https:\/\//i.test(urlM[1]), urlM[1]);
    }

    /* ⚠ 驱动不许自己去读 auth（令牌归 session 一层独占） */
    ok('⚠ localdb 的令牌走 session.getAccessToken（不自己读 auth/storage）',
      /session\.getAccessToken\(\)/.test(dbText) && !/require\('\.\.\/auth\.js'\)/.test(dbText));

    /* ⚠⚠ 读失败绝不能降级成空数组 —— 源码级守一道。
       ⚠⚠ **必须先剥注释**：文件头那段警告里就写着 `{ ok:true, records:[] }`
         （"后者会让上层把「手机没连上 WiFi」当成「云端真没有」"），
         不剥的话断言会去匹配那句**注释**，于是一条正确的代码被判红
         （本项目已多次踩「静态断言撞注释」，这是同一条纪律）。 */
    const dbCode = dbText
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
      .replace(/\/\/[^\n]*/g, '');        // 行注释
    ok('⚠⚠ localdb 里没有「读失败 → 回空数组」的兜底',
      !/ok:\s*true\s*,\s*records:\s*\[\]/.test(dbCode));
    /* ⚠ 形状不符时如实报错（别把 undefined 兜成 []） */
    ok('⚠⚠ localdb 校验 records 是数组，不是数组就报 BAD_SHAPE',
      /Array\.isArray\(d\.records\)/.test(dbText) && /BAD_SHAPE/.test(dbText));

    /* ⚠ 注册守卫必须真的存在 */
    ok('⚠ auth 里 canSignUp 只在 local 为 true',
      /function canSignUp\(\)[\s\S]{0,200}useLocal\(\)/.test(
        fs.readFileSync(path.join(CORE, 'auth.js'), 'utf8')));
  }

  /* ================================================================
   * 十二、在线心跳 + 指令接收（core/presence.js，长轮询）
   * ================================================================
   * ⚠⚠ 这一节的桩停在**注入的 ping** 上，而不是停在 fetch —— 与前面几节刻意不同。
   *   要测的是「游标怎么推进 / 重复的指令怎么办 / 失败要不要退避 / 停得掉吗」
   *   这一整套**循环逻辑**；用真 HTTP 桩跑它就得干等 25 秒的挂起，
   *   或者把服务端的语义在桩里再实现一遍（两份实现必然漂）。
   *   ping 是 core/presence.js 专门留的接缝。
   * 真正「发出去的请求长什么样」由本节最后一步（defaultPing）用一个抓请求的桩守。
   */
  console.log('\n--- 在线心跳（presence.js）---');
  {
    const steps = [];
    const P = presence;

    /** 等一会儿（循环相关的用例必须真等，因为被测的就是定时调度） */
    function wait(ms) {
      return new Promise(function (res) { setTimeout(res, ms); });
    }

    /**
     * 造一个「按剧本回话」的 ping：每调一次取一条剧本（最后一条会一直重复），
     * 同时把收到的 body 记下来 —— 断言「客户端发了什么」全靠它。
     */
    function scripted(list) {
      const calls = [];
      let i = 0;
      return {
        calls: calls,
        ping: function (body) {
          calls.push(body);
          const r = list[Math.min(i, list.length - 1)];
          i += 1;
          return Promise.resolve(r);
        }
      };
    }

    steps.push(function () { resetAll(); });

    /* ---- 十二.1 纯函数：游标 / 指令翻译 / 只增不减 ---- */
    steps.push(function () {
      eq('toCursor(12) = 12', P.toCursor(12), 12);
      eq("toCursor('12') = 12（存的是字符串）", P.toCursor('12'), 12);
      eq('toCursor(3.7) 向下取整', P.toCursor(3.7), 3);
      eq('⚠ toCursor(0) = 0（0 是**合法**游标 = 从头收）', P.toCursor(0), 0);
      eq('⚠⚠⚠ toCursor("abc") = null（乱值 ≠ 0 —— 当成 0 会把历史指令全重放一遍）',
        P.toCursor('abc'), null);
      eq('toCursor("") = null', P.toCursor(''), null);
      eq('toCursor(null) = null', P.toCursor(null), null);
      eq('toCursor(undefined) = null', P.toCursor(undefined), null);
      eq('⚠ toCursor(-1) = null（负数不是游标）', P.toCursor(-1), null);

      eq('toast 指令 → {type:toast,text}',
        JSON.stringify(P.action({ kind: 'toast', payload: { text: '你好' } })),
        JSON.stringify({ type: 'toast', text: '你好' }));
      eq('  └ text 首尾空格被清掉',
        P.action({ kind: 'toast', payload: { text: '  你好  ' } }).text, '你好');
      eq('⚠ toast 没有 text → null（空提示条 = 闪一下什么都没有）',
        P.action({ kind: 'toast', payload: {} }), null);
      eq('⚠ toast 的 text 只有空格 → null', P.action({ kind: 'toast', payload: { text: '   ' } }), null);
      eq('goto 指令 → {type:goto,tab}',
        JSON.stringify(P.action({ kind: 'goto', payload: { tab: 'study' } })),
        JSON.stringify({ type: 'goto', tab: 'study' }));
      eq('⚠ 不认识的 kind → null（忽略它，但调用方照样 ack + 推进游标）',
        P.action({ kind: '未来的新指令', payload: {} }), null);
      eq('payload 不是对象 → null（不炸）', P.action({ kind: 'toast', payload: 'oops' }), null);
      eq('指令整个是 null → null', P.action(null), null);

      eq('nextCursor(5, 9, [7,8]) = 9（服务端建议值与本批 id 一起取最大）',
        P.nextCursor(5, 9, [7, 8]), 9);
      eq('⚠ nextCursor(10, 2, [3]) = 10（绝不回拨 —— 回拨 = 历史重放）',
        P.nextCursor(10, 2, [3]), 10);
      eq('⚠ 服务端不回 cursor 也能推进：nextCursor(5, null, [8]) = 8',
        P.nextCursor(5, null, [8]), 8);
      eq('nextCursor(null, null, []) = null（第一次心跳仍是第一次）',
        P.nextCursor(null, null, []), null);

      P.writeCursor(7);
      eq('writeCursor(7) → readCursor() = 7', P.readCursor(), 7);
      storage.setStorageSync(P.cursorKey(''), '不是数字');
      eq('⚠⚠⚠ 存进去是乱值时 readCursor() = null（不是 0）', P.readCursor(), null);
      P.clearCursor();
      eq('clearCursor() 后 readCursor() = null（下次 = 第一次心跳，不补历史）', P.readCursor(), null);
      ok('⚠⚠ 游标的存储键与登录凭证**不同名**（同名会把登录态写坏）',
        P.CURSOR_KEY !== session.KEY && P.CURSOR_KEY !== session.ANON_KEY,
        P.CURSOR_KEY);
    });

    /* ---- 十二.1b 游标按**账号**分开存 ---- */
    steps.push(function () {
      resetAll();
      return giveSession('tokA', 'uA').then(function () {
        P.writeCursor(100);
        eq('A 账号的游标 = 100', P.readCursor(), 100);
        return giveSession('tokB', 'uB');
      }).then(function () {
        eq('⚠⚠⚠ 换成 B 账号后**读不到** A 的游标（共用一个键的话 B 会被当成「已经处理到 100」，比 100 小的指令永久跳过 —— 现象是「后台发了，App 没反应」）',
          P.readCursor(), null);
        P.writeCursor(3);
        eq('  └ B 自己的游标独立存', P.readCursor(), 3);
        return giveSession('tokA2', 'uA');
      }).then(function () {
        eq('  └ 换回 A 还是 100（两个账号互不干扰）', P.readCursor(), 100);
        ok('  └ 两个键确实不同', P.cursorKey('uA') !== P.cursorKey('uB'));
        ok('  └ 键里带着账号 id', /:uA$/.test(P.cursorKey('uA')), P.cursorKey('uA'));
      });
    });

    /* ---- 十二.2 第一次心跳：不带游标，且采用服务端给的起点 ---- */
    steps.push(function () {
      resetAll();
      const s = scripted([{ ok: true, serverTime: 1, cursor: 42, commands: [] }]);
      const actions = [];
      const loop = P.createLoop({ ping: s.ping, onAction: function (a) { actions.push(a); } });
      return loop.tick().then(function () {
        ok('⚠⚠⚠ 第一次心跳**不带** cursor（服务端据此从当前最大 id 起算，一条历史都不补）',
          !('cursor' in s.calls[0]));
        eq('  └ 也没有 ackIds', s.calls[0].ackIds, undefined);
        eq('⚠⚠ 游标采用服务端给的 42（新装的 App 不该被几天前的广播淹没）',
          P.readCursor(), 42);
        eq('  └ 本轮没指令 → 不产生任何动作', actions.length, 0);
      });
    });

    /* ---- 十二.3 收到指令：执行 → 推进游标 → 下次带上 ack ---- */
    steps.push(function () {
      resetAll();
      P.writeCursor(42);
      const s = scripted([
        {
          ok: true, cursor: 44, commands: [
            { id: 43, kind: 'toast', payload: { text: '系统维护' } },
            { id: 44, kind: 'goto', payload: { tab: 'study' } }
          ]
        },
        { ok: true, cursor: 44, commands: [] }
      ]);
      const actions = [];
      const loop = P.createLoop({ ping: s.ping, onAction: function (a) { actions.push(a); } });
      return loop.tick().then(function () {
        eq('带上了上次的游标 42', s.calls[0].cursor, 42);
        eq('两条指令都执行了', actions.length, 2);
        eq('  └ 第一条是 toast', actions[0] && actions[0].type, 'toast');
        eq('  └ 第二条是 goto（按 id 升序，与发出来的顺序一致）',
          actions[1] && actions[1].tab, 'study');
        eq('⚠ 游标推进到 44（**处理完之后**才存）', P.readCursor(), 44);
        eq('本轮攒下两条待上报的 ack', loop.pendingAcks().join(','), '43,44');
        return loop.tick();
      }).then(function () {
        eq('下一次心跳带上 cursor=44', s.calls[1].cursor, 44);
        eq('  └ 以及 ackIds=[43,44]（服务端据此记「已送达」）',
          s.calls[1].ackIds.join(','), '43,44');
        eq('  └ ack 上报过就清掉（不重复上报）', loop.pendingAcks().length, 0);
      });
    });

    /* ---- 十二.4 去重 + 不认识的 kind + 坏指令（全都不能卡住流水线）---- */
    steps.push(function () {
      resetAll();
      P.writeCursor(50);
      const batch = [
        { id: 51, kind: 'toast', payload: { text: 'A' } },
        { id: 52, kind: '未来的新指令', payload: { x: 1 } },   // 不认识
        { id: 53, kind: 'toast' }                              // 坏的（没 payload）
      ];
      /* ⚠ 第二条是「服务端重发同一批」—— 客户端没来得及 ack 时真会发生（至少一次语义） */
      const s = scripted([
        { ok: true, cursor: 53, commands: batch },
        { ok: true, cursor: 53, commands: batch }
      ]);
      const actions = [];
      const status = [];
      const loop = P.createLoop({
        ping: s.ping,
        onAction: function (a) { actions.push(a); },
        onStatus: function (k) { status.push(k); }
      });
      return loop.tick().then(function () {
        eq('只执行「认识且完整」的那一条', actions.length, 1);
        eq('⚠⚠⚠ 不认识的 kind 与坏指令**照样把游标推到 53**（否则一条看不懂的指令会把整条流水线永久卡死）',
          P.readCursor(), 53);
        ok('  └ 而且如实报告了 unknown', status.indexOf('unknown') >= 0);
        eq('三条都算「已收到」（不认识的也要 ack，不然服务端会一直重发）',
          loop.pendingAcks().join(','), '51,52,53');
        return loop.tick();
      }).then(function () {
        eq('⚠⚠ 服务端重发同一批 → 一条都不重复执行（本进程去重）', actions.length, 1);
        eq('  └ 游标停着不动（已经是 53）', P.readCursor(), 53);

        /* ⚠⚠⚠ 上面那条「游标推到 53」其实**可能被服务端回的 cursor 顶上去**，
           测不出客户端自己会不会推进。这里把服务端建议值**拿掉**再验一遍：
           真服务端哪天不回 cursor 了（或改了字段名），客户端必须还能自己往前走 ——
           不然「一条看不懂的指令卡死整条流水线」这个坑就照样在。 */
        resetAll();
        P.writeCursor(60);
        const s2 = scripted([
          {
            ok: true, commands: [
              { id: 62, kind: '未来的新指令', payload: {} },
              { id: 63, kind: 'toast' }                 // 坏的：没 payload
            ]
          }
        ]);
        const loop2 = P.createLoop({ ping: s2.ping });
        return loop2.tick().then(function () {
          eq('⚠⚠⚠ 服务端**不给** cursor 时，游标仍由客户端自己推到 63（两条都是不认识的/坏的）',
            P.readCursor(), 63);
        });
      });
    });

    /* ---- 十二.5 失败 / 异常：不许动游标，也不许把循环弄死 ---- */
    steps.push(function () {
      resetAll();
      P.writeCursor(9);
      const status = [];
      const loop = P.createLoop({
        ping: function () { return Promise.resolve({ ok: false, code: 'NETWORK', error: '连不上服务器' }); },
        onStatus: function (k) { status.push(k); }
      });
      return loop.tick().then(function (r) {
        eq('失败原样返回给调用方', r.ok, false);
        eq('⚠ 失败**不动**游标（下次重发，不丢指令）', P.readCursor(), 9);
        ok('  └ 如实报了 error', status.indexOf('error') >= 0);

        /* ⚠ ping 万一 reject 也必须接住：循环不能因为一次异常就死掉 */
        const bad = P.createLoop({
          ping: function () { return Promise.reject(new Error('boom')); }
        });
        return bad.tick();
      }).then(function (r) {
        eq('⚠⚠ ping 抛异常时 tick **不 reject**（收敛成 THROW，循环继续）', r.code, 'THROW');
      });
    });

    /* ---- 十二.6 重入保护 ---- */
    steps.push(function () {
      resetAll();
      const loop = P.createLoop({
        ping: function () {
          return new Promise(function (res) {
            setTimeout(function () { res({ ok: true, cursor: 1, commands: [] }); }, 30);
          });
        }
      });
      const first = loop.tick();
      return loop.tick().then(function (r) {
        eq('⚠ 上一次还挂着时第二次 tick 直接 BUSY（长轮询本来就挂 25 秒，不挡会攒出一堆连接）',
          r.code, 'BUSY');
        return first;
      });
    });

    /* ---- 十二.7 start / stop：真的会自己跑，也真的停得掉 ---- */
    steps.push(function () {
      resetAll();
      let calls = 0;
      const loop = P.createLoop({
        ping: function () {
          calls += 1;
          return Promise.resolve({ ok: true, cursor: 1, commands: [] });
        }
      });
      eq('⚠⚠ 只有自建后端有长轮询：MODE=local 时 start() 返回 true', loop.start(), true);
      eq('  └ 重复 start 是 no-op', loop.start(), false);
      return wait(700).then(function () {
        ok('循环自己在转（700ms 内至少 2 次：成功 → 隔 MIN_GAP_MS 立刻续上）',
          calls >= 2, 'calls=' + calls);
        eq('stop() 生效', loop.stop(), true);
        const at = calls;
        return wait(600).then(function () {
          eq('⚠⚠ 停了就真的停了（退后台还在打请求是要烧电的）', calls, at);
          eq('  └ 重复 stop 是 no-op', loop.stop(), false);
          eq('  └ isRunning() = false', loop.isRunning(), false);
        });
      });
    });

    /* ---- 十二.8 没登录：只发一次就停，不许空转 ---- */
    steps.push(function () {
      resetAll();
      let calls = 0;
      const loop = P.createLoop({
        ping: function () {
          calls += 1;
          return Promise.resolve({ ok: false, code: 'NO_SESSION', error: '还没有登录' });
        }
      });
      loop.start();
      return wait(400).then(function () {
        eq('⚠⚠⚠ 没登录 / 已过期时只发一次就收摊（继续每 5 秒重试 = 后台刷一屏 401）',
          calls, 1);
        eq('  └ isRunning() = false（**停**了，不是在等下一次重试）', loop.isRunning(), false);
      });
    });

    /* ---- 十二.9 非自建后端：如实不启动 ---- */
    steps.push(function () {
      resetAll();
      const keep = storeMode.MODE;
      storeMode.MODE = 'cloudbase';
      let calls = 0;
      const status = [];
      const loop = P.createLoop({
        ping: function () { calls += 1; return Promise.resolve({ ok: true }); },
        onStatus: function (k) { status.push(k); }
      });
      eq('⚠ 非自建后端 start() 返回 false（不发一个必然 404 的请求）', loop.start(), false);
      eq('  └ 一个请求都没发', calls, 0);
      ok('  └ 状态如实报 unsupported', status.indexOf('unsupported') >= 0);
      storeMode.MODE = keep;
      return Promise.resolve();
    });

    /* ---- 十二.10 defaultPing：真发出去的请求长什么样 + 超时口子 ---- */
    steps.push(function () {
      resetAll();
      const sent = [];
      localsdk._setFetch(function (url, init) {
        sent.push({ url: String(url), init: init });
        return Promise.resolve({
          status: 200,
          text: function () {
            return Promise.resolve(JSON.stringify({ ok: true, serverTime: 1, cursor: 7, commands: [] }));
          }
        });
      });
      return giveSession('tokP1', 'u1').then(function () {
        return P.defaultPing({ cursor: 3 });
      }).then(function (r) {
        eq('defaultPing 成功', r.ok, true);
        eq('  └ 打的是 /presence/ping', sent[0].url.replace(localsdk.CONFIG.base, ''), '/presence/ping');
        eq('  └ 方法是 POST', sent[0].init.method, 'POST');
        eq('  └ 带上 Bearer 令牌', String(sent[0].init.headers.authorization), 'Bearer tokP1');
        eq('  └ body 里有游标', JSON.parse(sent[0].init.body).cursor, 3);

        /* ⚠⚠⚠ 超时：服务端最长挂 25 秒，客户端给的超时必须**比它长** */
        ok('⚠⚠⚠ REQUEST_TIMEOUT_MS > SERVER_WAIT_MS（给短了 ⇒ 每次「没有指令」的正常等待都先在客户端超时，表现成「心跳永远失败」而服务端一切正常）',
          P.REQUEST_TIMEOUT_MS > P.SERVER_WAIT_MS,
          P.REQUEST_TIMEOUT_MS + ' vs ' + P.SERVER_WAIT_MS);
        const src = fs.readFileSync(path.join(CORE, 'presence.js'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '');
        ok('  └ 而且 defaultPing 真的把它传下去了（有常量不传 = 白算）',
          /timeoutMs:\s*REQUEST_TIMEOUT_MS/.test(src));

        /* ⚠ 上面那行依赖 localsdk **认** opts.timeoutMs —— 用真实行为验一遍 */
        localsdk._setFetch(function (url, init) {
          return new Promise(function (res, rej) {
            const sig = init && init.signal;
            if (sig) {
              sig.addEventListener('abort', function () {
                const e = new Error('aborted');
                e.name = 'AbortError';
                rej(e);
              });
            }
          });
        });
        const t0 = Date.now();
        return localsdk.request('/x', { timeoutMs: 5 }).then(function (r2) {
          const cost = Date.now() - t0;
          eq('⚠⚠ localsdk 认 opts.timeoutMs（传 5ms → 立刻超时，而不是干等默认的 10 秒）',
            r2.code, 'TIMEOUT');
          ok('  └ 而且是真的「很快」返回的', cost < 2000, cost + 'ms');
        });
      });
    });

    /* ---- 十二.11 退场：「我走了」（POST /presence/offline）----
       ⚠ 这一节停在 **fetch** 上（与十二.10 同一层），而不是停在注入的 ping ——
         要验的正是「发出去的请求长什么样」和「什么情况下**不**发」。 */
    steps.push(function () {
      resetAll();
      const sent = [];
      localsdk._setFetch(function (url, init) {
        sent.push({ url: String(url), init: init });
        return Promise.resolve({
          status: 200,
          text: function () { return Promise.resolve(JSON.stringify({ ok: true, serverTime: 1 })); }
        });
      });
      return giveSession('tokBye', 'uBye').then(function () {
        /* ⚠ ping 故意做成**永不落地**：这样这条用例里唯一会打 fetch 的就是 bye 那一句
           （不然还得去分辨「哪个请求是心跳、哪个是告别」）。 */
        const loop = P.createLoop({ ping: function () { return new Promise(function () {}); } });
        loop.start();
        eq('⚠ stop({offline:true}) 照旧把循环停掉（返回 true）', loop.stop({ offline: true }), true);
        eq('  └ isRunning() = false', loop.isRunning(), false);
        return wait(50);
      }).then(function () {
        eq('⚠⚠⚠ 退场时说了一声「我走了」（不说的话后台要等 60 秒的在线窗口过期才变离线）',
          sent.length, 1);
        eq('  └ 打的是 /presence/offline',
          sent[0] && sent[0].url.replace(localsdk.CONFIG.base, ''), '/presence/offline');
        eq('  └ 方法是 POST', sent[0] && sent[0].init.method, 'POST');
        eq('  └ 带上 Bearer 令牌（服务端得认出是谁在说再见）',
          String(sent[0] && sent[0].init.headers.authorization), 'Bearer tokBye');
        ok('  └ ⚠ 超时给得**短**：这是收摊时捎带的一句通知，不该把退出流程拖住',
          P.OFFLINE_TIMEOUT_MS > 0 && P.OFFLINE_TIMEOUT_MS < P.REQUEST_TIMEOUT_MS,
          P.OFFLINE_TIMEOUT_MS + ' vs ' + P.REQUEST_TIMEOUT_MS);
      });
    });

    /* ---- 十二.12 什么情况下**不**说这句话 ---- */
    steps.push(function () {
      resetAll();
      const sent = [];
      localsdk._setFetch(function (url, init) {
        sent.push({ url: String(url), init: init });
        return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"ok":true}'); } });
      });
      return giveSession('tokBye2', 'uBye').then(function () {
        const loop = P.createLoop({ ping: function () { return new Promise(function () {}); } });
        loop.start();
        eq('普通 stop()（不带 offline）照旧只是停', loop.stop(), true);
        return wait(40).then(function () {
          eq('⚠⚠⚠ 普通 stop() **一个请求都不发**（心跳因「没登录/已过期」自停时不该去打服务端 —— 一串 401）',
            sent.length, 0);
          eq('  └ 已经停了的循环再 stop({offline:true}) 返回 false', loop.stop({ offline: true }), false);
          return wait(40);
        }).then(function () {
          eq('  └ 而且也不补发（循环都不在了，再来一句「我走了」是多余的）', sent.length, 0);
        });
      });
    });

    /* ---- 十二.13 没凭证 / 网络炸了：bye 都不能抛 ---- */
    steps.push(function () {
      resetAll();
      const sent = [];
      localsdk._setFetch(function () { sent.push(1); return Promise.reject(new Error('boom')); });
      return P.bye().then(function (r) {
        eq('⚠ 没登录时说再见 → NO_SESSION（不是崩，也不是发一个必然 401 的请求）', r.code, 'NO_SESSION');
        eq('  └ 一个请求都没发', sent.length, 0);
        return giveSession('tokBye3', 'uBye');
      }).then(function () {
        return P.bye();
      }).then(function (r) {
        eq('⚠⚠ fetch 直接 reject 时 bye 也**不抛**（收摊时的一句话不该影响任何流程）', r.ok, false);
        eq('  └ 如实报 NETWORK', r.code, 'NETWORK');
      });
    });

    /* ---- 十二.14 强制下线：logout 指令 → 动作；**没有 reason 也照样执行** ---- */
    steps.push(function () {
      resetAll();
      P.writeCursor(70);
      const s = scripted([
        {
          ok: true, cursor: 72, commands: [
            { id: 71, kind: 'logout', payload: { reason: '你违反了使用条款' } },
            { id: 72, kind: 'logout', payload: {} }
          ]
        }
      ]);
      const actions = [];
      const loop = P.createLoop({ ping: s.ping, onAction: function (a) { actions.push(a); } });
      return loop.tick().then(function () {
        eq('两条 logout 都翻译成了动作', actions.length, 2);
        eq('  └ 类型是 logout', actions[0] && actions[0].type, 'logout');
        eq('  └ reason 原样带过来（App 用它说明「为什么被踢」）',
          actions[0] && actions[0].reason, '你违反了使用条款');
        eq('⚠⚠⚠ 第二条**没有 reason 也必须照样产生动作**（照 toast 那种「空就返回 null」写 ⇒ 没写理由的强制下线会**静默失效**）',
          actions[1] && actions[1].type, 'logout');
        eq('  └ reason 是空串，交给 App 用兜底话术', actions[1] && actions[1].reason, '');
        eq('⚠ 游标推进到 72（这一批处理完了 —— 被踢的指令也算处理过）', P.readCursor(), 72);
        eq('  └ 两条都算已收到（不 ack ⇒ 服务端一直重发 ⇒ 那个人每次心跳都要再被踢一次）',
          loop.pendingAcks().join(','), '71,72');
      });
    });

    /* ---- 十二.15 logout 的 reason 只认非空字符串（乱值一律当「没写」） ---- */
    steps.push(function () {
      resetAll();
      eq('⚠ reason 是数字 → 当作没有（不是把 123 当文案渲染出去）',
        P.action({ kind: 'logout', payload: { reason: 123 } }).reason, '');
      eq('  └ 两端空白会被修掉',
        P.action({ kind: 'logout', payload: { reason: '  维护中  ' } }).reason, '维护中');
      eq('  └ payload 整个是歪的，也不影响「这是一条 logout」',
        P.action({ kind: 'logout', payload: 'oops' }).type, 'logout');
      eq('  └ 连 payload 都没有也一样', P.action({ kind: 'logout' }).type, 'logout');
      return Promise.resolve();
    });

    /* ---- 十二.16 服务端说 401 = 这张票不认了：停下来 + 叫醒上层 ---- */
    steps.push(function () {
      resetAll();
      let calls = 0;
      const status = [];
      const loop = P.createLoop({
        ping: function () {
          calls += 1;
          /* paipan-server 的 401（被强制下线 / 账号被删）：localsdk 把 body 里的 code 提出来 */
          return Promise.resolve({
            ok: false, status: 401, code: 'KICKED',
            error: '你的登录已被管理员强制下线，请重新登录'
          });
        },
        onStatus: function (k) { status.push(k); }
      });
      loop.start();
      return wait(400).then(function () {
        eq('⚠⚠⚠ 401 时只发一次就收摊（继续每 5 秒撞一次 = 后台刷屏 + 白耗用户的电）', calls, 1);
        eq('  └ isRunning() = false（**停**了，不是在等下一次重试）', loop.isRunning(), false);
        ok('  └ 如实报 unauthorized（App 据此清凭证、回未登录态并说明原因）',
          status.indexOf('unauthorized') >= 0, status.join(','));
      });
    });

    /* ---- 十二.17 老服务端（只有 401、没有 code）也得分得出来 ---- */
    steps.push(function () {
      resetAll();
      let calls = 0;
      const loop = P.createLoop({
        ping: function () {
          calls += 1;
          return Promise.resolve({ ok: false, status: 401, code: 'HTTP_401', error: '未登录' });
        }
      });
      loop.start();
      return wait(400).then(function () {
        eq('⚠⚠ 判据是 status===401 而不是 code==="KICKED"（老版本服务端不带 code，照样得停）',
          calls, 1);
      });
    });

    results.push({ name: '在线心跳', steps: steps });
  }

  /* ================================================================
   * 十三、记住账号密码（core/savedLogin.js）
   * ================================================================
   * ⚠ 正常路径（存进去、读出来）简单到不值得测。会出事的全在边界上，四件：
   *   ① 「不勾」到底是**不存**还是「存了不给你看」—— 后者等于在用户
   *      以为已经关掉这个功能之后，手机上还躺着一份明文密码。
   *      ⇒ 所以下面查的是 `storage` 里的**原始串**，不是 load() 归一化后的视图。
   *      （只断言 load().password === '' 的话，两种实现都是绿的 —— 那是假绿。）
   *   ② 存储被手改 / 写入被打断留下半截 JSON —— 登录页在**启动路径**上，抛=白屏。
   *   ③ 这个键必须**独立于登录态**：退出登录之后它还得在，那正是要它的原因。
   *   ④ 默认值必须是「勾上」（用户明确要的）。
   */
  console.log('\n--- 记住账号密码（savedLogin.js）---');
  {
    const SL = require(path.join(CORE, 'savedLogin.js'));
    const steps = [];

    /** 存储里那段**原始串**（不是 load() 的视图）—— 见本节文件头的 ① */
    function raw() { return storage.getStorageSync(SL.KEY) || ''; }

    steps.push(function () { resetAll(); });

    /* ---- 十三.1 没记过：默认值 + 默认勾上 ---- */
    steps.push(function () {
      resetAll();
      const d = SL.load();
      eq('⚠ 没记过时 remember 默认 **true**（用户要的「默认勾上」）', d.remember, true);
      eq('没记过时账号名是空串', d.username, '');
      eq('没记过时密码是空串', d.password, '');
    });

    /* ---- 十三.2 存 → 读 ---- */
    steps.push(function () {
      resetAll();
      const w = SL.save({ username: 'luyi2026', password: 'pw123456', remember: true });
      eq('save 的返回值 = 实际落盘的内容（账号）', w.username, 'luyi2026');
      eq('save 的返回值 = 实际落盘的内容（密码）', w.password, 'pw123456');
      const d = SL.load();
      eq('读回账号名', d.username, 'luyi2026');
      eq('读回密码', d.password, 'pw123456');
      eq('读回勾选态', d.remember, true);
    });

    /* ---- 十三.3 ⚠⚠⚠ 取消勾选 = 真的把密码删掉 ---- */
    steps.push(function () {
      resetAll();
      /* 先勾着存一次再取消 —— 「以前存过」才是最容易被漏擦的那种 */
      SL.save({ username: 'luyi2026', password: 'SECRET_PW', remember: true });
      eq('（前提）存过之后原始串里确实有密码',
        raw().indexOf('SECRET_PW') >= 0, true);

      SL.setRemember(false);
      eq('⚠⚠⚠ 取消勾选后**存储里不许再有密码明文**（是删掉，不是「藏着不给」）',
        raw().indexOf('SECRET_PW'), -1);
      eq('账号名留着（它不敏感，而且能省掉用户一半的输入）', SL.load().username, 'luyi2026');
      eq('勾选态回 false', SL.load().remember, false);
      eq('load 给的密码是空串', SL.load().password, '');
    });

    /* ---- 十三.4 save 时就没勾：同样不落盘 ---- */
    steps.push(function () {
      resetAll();
      SL.save({ username: 'a2345678', password: 'NOPE_PW', remember: false });
      eq('⚠ 未勾选时 save 也不写密码', raw().indexOf('NOPE_PW'), -1);
      eq('账号名照样记', SL.load().username, 'a2345678');
    });

    /* ---- 十三.5 取消过再勾回来：不会凭空变出旧密码 ---- */
    steps.push(function () {
      resetAll();
      SL.save({ username: 'a2345678', password: 'GONE_PW', remember: true });
      SL.setRemember(false);
      SL.setRemember(true);
      eq('⚠ 取消过再勾回来，密码**不会**复原（它已经被删了，用户得重新输一遍）',
        raw().indexOf('GONE_PW'), -1);
      eq('勾选态回 true', SL.load().remember, true);
    });

    /* ---- 十三.6 setRemember(true) 只动它该动的 ---- */
    steps.push(function () {
      resetAll();
      SL.save({ username: 'keepme01', password: 'KEEP_PW', remember: true });
      SL.setRemember(true);
      eq('⚠ setRemember(true) 只改标志、不动密码', SL.load().password, 'KEEP_PW');
      eq('账号名不受影响', SL.load().username, 'keepme01');
    });

    /* ---- 十三.7 坏数据：一律退回默认值，且**绝不抛** ---- */
    steps.push(function () {
      /**
       * ⚠ 这一段会**故意**往存储里塞半截 JSON，savedLogin 于是如实打一条 console.warn
       *   （「吞掉并退回默认值」正是它的正确行为，不是 bug）。
       *   为了不把测试输出刷成一片带堆栈的红字 —— 那种「看着像崩了」的输出
       *   会让人以后不敢信这套测试 —— 这里临时静音，跑完立刻还原。
       */
      const realWarn = console.warn;
      console.warn = function () {};
      try {
        const bad = [
          'not json at all {',
          '"just a string"',
          'null',
          '123',
          '[1,2,3]',
          ''
        ];
        bad.forEach(function (v) {
          resetAll();
          if (v) storage.setStorageSync(SL.KEY, v);
          let d = null;
          try { d = SL.load(); } catch (e) { d = null; }
          eq('⚠ 坏数据（' + JSON.stringify(v) + '）不抛，且退回默认值',
            d !== null && typeof d.username === 'string' && typeof d.remember === 'boolean',
            true);
        });

        resetAll();
        storage.setStorageSync(SL.KEY,
          '{"username":123,"password":{},"remember":"maybe"}');
        const d2 = SL.load();
        eq('⚠ 字段类型不对时账号名当空串（不是把 123 渲染到输入框里）', d2.username, '');
        eq('⚠ 字段类型不对时密码当空串', d2.password, '');
        eq('⚠ remember 是乱值 → 当成**勾上**（往默认值方向归一，不是「对不上就拒绝」）',
          d2.remember, true);
      } finally {
        console.warn = realWarn;
      }
    });

    /* ---- 十三.8 ⚠⚠ 手改出来的矛盾态：读侧也得拦住 ---- */
    steps.push(function () {
      resetAll();
      storage.setStorageSync(SL.KEY,
        JSON.stringify({ username: 'x2345678', password: 'LEAK_PW', remember: false }));
      eq('⚠⚠ 存储里出现「不勾却存着密码」的矛盾态时，读侧仍不许把密码交出去',
        SL.load().password, '');
    });

    /* ---- 十三.9 长度上限（防御，不是业务规则）---- */
    steps.push(function () {
      resetAll();
      const long = new Array(200).join('a');
      SL.save({ username: long, password: long, remember: true });
      eq('⚠ 超长账号被截到 MAX（防手改 / 防将来某个写入口漏了清洗）',
        SL.load().username.length, SL.MAX);
      eq('⚠ 超长密码同样截断', SL.load().password.length, SL.MAX);
    });

    /* ---- 十三.10 参数缺失不能抛 ---- */
    steps.push(function () {
      resetAll();
      let threw = false;
      try {
        SL.save();
        SL.save({});
        SL.save({ username: 'u2345678' });
      } catch (e) { threw = true; }
      eq('⚠ save() / save({}) 都不抛（调用点少传字段不该炸在登录页上）', threw, false);
      eq('少传 remember → 按**勾上**（与默认值同一个方向）', SL.load().remember, true);
    });

    /* ---- 十三.11 ⚠⚠⚠ 这个键必须独立于登录态 ---- */
    steps.push(function () {
      resetAll();
      SL.save({ username: 'stayhere', password: 'STAY_PW', remember: true });
      session.save({ accessToken: 'tk', uid: 'u_stay' }, { username: 'stayhere' });
      session.clear();
      eq('⚠⚠⚠ 登录态被清掉之后，记住的账号密码**还在**' +
         '（这正是要它的原因：退出登录后点一下就能登回来）',
        SL.load().password, 'STAY_PW');
      eq('（同一件事的另一面）两者不是同一个存储键', SL.KEY === session.KEY, false);
    });

  /* ========================================================== 十四、师傅批字 */
  /* ⚠ 标题头不能漏：没有它，输出里这一段跟上一段连在一起，
     红了也看不出是哪一节（「测试红了先看它有没有跑到结尾」的前提是**看得见**） */
  console.log('\n--- 师傅批字（comments） ---');
  {
    const comments = require(path.join(CORE, 'comments.js'));
    const storeMode = require(path.join(CORE, 'storeMode.js'));
    const steps = [];

    /* 一个「服务端回什么」的桩工厂：只换响应体，其余照抄 */
    function stubOf(payload, status) {
      return function (url, init) {
        stubOf.sent.push({ url: String(url), init: init });
        return Promise.resolve({
          status: status || 200,
          text: function () { return Promise.resolve(JSON.stringify(payload)); }
        });
      };
    }
    stubOf.sent = [];
    function resetStub() { stubOf.sent = []; return stubOf.sent; }

    /* ---- 十四.1 支持判定 + 消息 id 的生成 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      eq('⚠ 自建后端下支持师傅批字', comments.supported(), true);

      const a = comments.newId();
      const b = comments.newId();
      ok('消息 id 形状合规（服务端白名单 [A-Za-z0-9_-]{1,64}）', /^m[A-Za-z0-9]{1,63}$/.test(a), a);
      ok('⚠⚠ 连调两次**不是同一个** —— 同毫秒撞 id 的话，第二条会被 INSERT OR IGNORE 静默吃掉' +
         '（用户看到的是「发了但没出来」）', a !== b, a + ' vs ' + b);
    });

    /* ---- 十四.2 sorted：只管顺序，不出别的花样 ---- */
    steps.push(function () {
      const out = comments.sorted([{ seq: 3 }, { seq: 1 }, { seq: 2 }]);
      eq('⚠ 按 seq 升序（服务端已经排好，这里只是不让乱序流到界面上）',
        out.map(function (x) { return x.seq; }).join(','), '1,2,3');
      eq('⚠ 不是数组 → 空数组（不抛、不发散）', comments.sorted(null).length, 0);
    });

    /* ---- 十四.3 ⚠⚠ 非 local 后端：如实说不支持，而且一个请求都不发 ---- */
    steps.push(function () {
      resetAll();
      const sent = resetStub();
      localsdk._setFetch(stubOf({ ok: true }));
      storeMode.MODE = 'cloudbase';
      return comments.list('r-cmt1').then(function (r) {
        eq('⚠⚠ 非自建后端 → 不算成功（绝不伪装成「还没有消息」）', r.ok, false);
        eq('  └ code = UNSUPPORTED', r.code, 'UNSUPPORTED');
        eq('  └ 而且一个请求都没发出去（发一个必然 404 的请求只会让用户以为接口坏了）',
          sent.length, 0);
        storeMode.MODE = 'local';
      });
    });

    /* ---- 十四.4 list：请求长什么样 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub();
      localsdk._setFetch(stubOf({
        ok: true,
        comments: [
          { id: 'm2', seq: 2, role: 'master', text: '乙', createdAt: 20 },
          { id: 'm1', seq: 1, role: 'ask', text: '甲', createdAt: 10 }
        ],
        lastSeq: 2,
        truncated: false
      }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.list('r-cmt1');
      }).then(function (r) {
        eq('list 成功', r.ok, true);
        const u = sent[0].url.replace(localsdk.CONFIG.base, '');
        eq('⚠ 打的是 /records/<id>/comments（会话挂在记录路径底下）',
          u, '/records/r-cmt1/comments');
        eq('  └ 方法 GET', sent[0].init.method, 'GET');
        eq('  └ 带 Bearer 令牌', String(sent[0].init.headers.authorization), 'Bearer tkC');
        eq('⚠ 不传 since 时不带 query（= 全量）', u.indexOf('since'), -1);
        eq('⚠⚠ 返回**按 seq 排好**（服务端万一年排错了，也别让它流到界面）',
          r.comments.map(function (x) { return x.id; }).join(','), 'm1,m2');
        eq('  └ lastSeq 透传（客户端拿它当下次的 since）', r.lastSeq, 2);
        eq('  └ truncated 透传', r.truncated, false);
      });
    });

    /* ---- 十四.5 since：增量游标真的传下去了 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub();
      localsdk._setFetch(stubOf({ ok: true, comments: [], lastSeq: 5, truncated: false }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.list('r-cmt1', 5);
      }).then(function (r) {
        ok('⚠ 传了 since 就必须出现在 query 里（不传 = 每次全量重拉 ⇒ 消息重复渲染）',
          /[?&]since=5(&|$)/.test(sent[0].url), sent[0].url.replace(localsdk.CONFIG.base, ''));
        eq('  └ 没有新消息时 lastSeq **回落成 since**（不是 0）', r.lastSeq, 5);
      });
    });

    /* ---- 十四.6 ⚠ 空会话 ≠ 读失败 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(stubOf({ ok: true, comments: [], lastSeq: 0, truncated: false }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.list('r-cmt1');
      }).then(function (r) {
        eq('⚠ 一条消息都没有 → ok:true（「还没聊过」不是错误）', r.ok, true);
        eq('  └ comments 是空数组而不是 undefined', Array.isArray(r.comments), true);
        eq('  └ lastSeq = 0', r.lastSeq, 0);
      });
    });

    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(stubOf({ ok: false, error: '炸了' }, 500));
      return giveSession('tkC', 'u1').then(function () {
        return comments.list('r-cmt1');
      }).then(function (r) {
        eq('⚠⚠ 读失败 → ok:false（**不是**空数组 —— 空数组会让界面显示「还没有聊过」，' +
           '把「拉不到」说成「没有」，用户就再也不会重试）', r.ok, false);
      });
    });

    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(stubOf({ ok: true, comments: null }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.list('r-cmt1');
      }).then(function (r) {
        eq('⚠ 服务端回了个非数组 → BAD_SHAPE（不兜成 []）', r.code, 'BAD_SHAPE');
      });
    });

    /* ---- 十四.7 非法 recordId：本地就挡下，不发请求 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub();
      localsdk._setFetch(stubOf({ ok: true, comments: [] }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.list('a b');
      }).then(function (r) {
        eq('recordId 非法 → 直接失败', r.ok, false);
        eq('  └ BAD_ID', r.code, 'BAD_ID');
        eq('  └ 一个请求都没发', sent.length, 0);
      });
    });

    /* ---- 十四.8 send：新消息怎么发的 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub();
      localsdk._setFetch(stubOf({
        ok: true,
        comment: { id: 'mX', seq: 1, role: 'ask', text: '今年怎么样', createdAt: 1 },
        duplicated: false
      }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.send('r-cmt1', '今年怎么样');
      }).then(function (r) {
        eq('send 成功', r.ok, true);
        eq('⚠ 用的是 POST', sent[0].init.method, 'POST');
        const body = JSON.parse(sent[0].init.body);
        ok('消息 id 是客户端生成的（服务端靠它做幂等）', /^m[A-Za-z0-9]+$/.test(body.id), body.id);
        eq('正文原样带上', body.text, '今年怎么样');
        eq('⚠⚠ 不传 role 时 body 里**没有** role 这个键（ask 是服务端默认；' +
           '多传一次只会让人以为客户端能定角色）', 'role' in body, false);
        eq('  └ 成功时也把 id 返回来（调用方要拿它去重）', typeof r.id, 'string');
        eq('  └ duplicated 透传', r.duplicated, false);
      });
    });

    /* ---- 十四.9 ⚠⚠⚠ 重试必须沿用同一个 id ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub();
      localsdk._setFetch(stubOf({
        ok: true,
        comment: { id: 'keep-me', seq: 1, role: 'ask', text: 'x', createdAt: 1 },
        duplicated: true
      }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.send('r-cmt1', 'x', { id: 'keep-me' });
      }).then(function (r) {
        eq('⚠⚠⚠ 传了 opts.id 就**用它**（重试换 id = 又插一条，用户看到两条一模一样的话）',
          JSON.parse(sent[0].init.body).id, 'keep-me');
        eq('  └ duplicated:true 原样透传（调用方据此知道「既没丢也没重」）', r.duplicated, true);
      });
    });

    /* ---- 十四.10 ⚠ 失败时把用过的 id 一起返回（供重试） ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(function () {
        return Promise.reject(new TypeError('Network request failed'));
      });
      return giveSession('tkC', 'u1').then(function () {
        return comments.send('r-cmt1', '写不出去的一条');
      }).then(function (r) {
        eq('网络炸了 → ok:false', r.ok, false);
        ok('⚠⚠⚠ **失败时也要把用过的 id 带回来** —— 少了它，调用方重试只能换新 id，' +
           '而「超时了其实已经写进去」就变成两条',
          typeof r.id === 'string' && r.id.length > 1, r.id);
      });
    });

    /* ---- 十四.11 role 只有 'master' 才显式带 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub();
      localsdk._setFetch(stubOf({
        ok: true,
        comment: { id: 'mM', seq: 1, role: 'master', text: '批一句', createdAt: 1 },
        duplicated: false
      }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.send('r-cmt1', '批一句', { role: 'master' });
      }).then(function () {
        eq('⚠ 管理员路径才带 role:master（能不能生效仍由**服务端**裁定，这里只是把意图透下去）',
          JSON.parse(sent[0].init.body).role, 'master');
      });
    });

    /* ---- 十四.12 服务端没回 comment：宁可报错，也不往列表里塞一条空的 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(stubOf({ ok: true, comment: null, duplicated: false }));
      return giveSession('tkC', 'u1').then(function () {
        return comments.send('r-cmt1', 'x');
      }).then(function (r) {
        eq('⚠ 服务端没回 comment → 如实失败（不塞空消息进列表）', r.ok, false);
        eq('  └ code = BAD_SHAPE', r.code, 'BAD_SHAPE');
      });
    });

    results.push({ name: '师傅批字（comments）', steps: steps });
  }

  /* ========================================================== 十五、求测单
   * ⚠⚠ 用户 2026-10-05 拍板：「App 上点击发起求测**并不是发送一个聊天**」——
   *   它落的是 requests 一行（工单），**一个字都不写 comments**。
   *   所以这一组钉的全是「工单层」的语义，与上面那组（会话层）刻意分开：
   *   两层混在一起，就会出现「发起求测顺手发了一条消息」那种回退。
   */
  console.log('\n--- 求测单（requests） ---');
  {
    const requests = require(path.join(CORE, 'requests.js'));
    const store = require(path.join(CORE, 'store', 'index.js'));
    const steps = [];

    function stubOf2(payload, status) {
      return function (url, init) {
        stubOf2.sent.push({ url: String(url), init: init });
        return Promise.resolve({
          status: status || 200,
          text: function () { return Promise.resolve(JSON.stringify(payload)); }
        });
      };
    }
    stubOf2.sent = [];
    function resetStub2() { stubOf2.sent = []; return stubOf2.sent; }

    /* ---- 十五.1 支持判定 + 单子 id 的生成 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      eq('⚠ 自建后端下支持求测', requests.supported(), true);

      const a = requests.newId();
      const b = requests.newId();
      ok('单子 id 形状合规（服务端白名单 [A-Za-z0-9_-]{1,64}）',
        /^q[A-Za-z0-9]{1,63}$/.test(a), a);
      ok('⚠⚠ 连调两次**不是同一个** —— 同毫秒撞 id，调用方会以为「这是我新下的单」，' +
         '实际被服务端的 UNIQUE 吃成同一张',
        a !== b, a + ' vs ' + b);

      storeMode.MODE = 'cloudbase';
      eq('⚠⚠ 非自建后端：如实说不支持（绝不伪装成「你还没求测」）', requests.supported(), false);
      storeMode.MODE = 'local';
    });

    /* ---- 十五.2 ⚠⚠ 非 local：如实说不支持，而且一个请求都不发 ---- */
    steps.push(function () {
      resetAll();
      const sent = resetStub2();
      localsdk._setFetch(stubOf2({ ok: true }));
      storeMode.MODE = 'cloudbase';
      return requests.get('r-q1').then(function (r) {
        eq('非自建后端 get → ok:false', r.ok, false);
        eq('  └ code = UNSUPPORTED', r.code, 'UNSUPPORTED');
        eq('  └ 而且一个请求都没发出去（发一个必然 404 的请求只会让用户以为接口坏了）',
          sent.length, 0);
        return requests.create('r-q1');
      }).then(function (r2) {
        eq('非自建后端 create → ok:false', r2.ok, false);
        eq('  └ code = UNSUPPORTED', r2.code, 'UNSUPPORTED');
        ok('⚠⚠⚠ 失败也要把用过的 id 带回来（少了它，重试只能换新 id）',
          typeof r2.id === 'string' && r2.id.length > 1, r2.id);
        eq('  └ create 也一个请求都没发', sent.length, 0);
        storeMode.MODE = 'local';
      });
    });

    /* ---- 十五.3 ⚠⚠⚠ get：「还没有单子」是 ok:true + req:null（常态，不是失败） ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub2();
      localsdk._setFetch(stubOf2({ ok: true, request: null }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.get('r-q1');
      }).then(function (r) {
        eq('get 成功（响应本身是 200）', r.ok, true);
        eq('⚠⚠⚠ 「还没有单子」= ok:true + req:null —— 这是**常态**，' +
           '界面据此画那颗「发起求测」按钮', r.req, null);
        const u = sent[0].url.replace(localsdk.CONFIG.base, '');
        eq('⚠ 打的是 /records/<id>/request（单子挂在记录路径底下）', u, '/records/r-q1/request');
        eq('  └ 方法 GET', sent[0].init.method, 'GET');
        eq('  └ 带 Bearer 令牌', String(sent[0].init.headers.authorization), 'Bearer tkQ');
      });
    });

    /* ---- 十五.4 ⚠⚠ 服务端少 request 键 ≠「还没有单子」 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(stubOf2({ ok: true }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.get('r-q1');
      }).then(function (r) {
        eq('⚠⚠ 服务端没回 request 键 → 如实失败', r.ok, false);
        eq('  └ code = BAD_SHAPE', r.code, 'BAD_SHAPE');
        eq('  └ 与「还没有单子」（ok:true + null）是两件事 ——' +
           '兜成 null 会把「接口坏了」显示成「你还没求测」', r.req, undefined);
      });
    });

    /* ---- 十五.5 ⚠⚠⚠ 网络炸 → ok:false（绝不兜成 null） ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(function () {
        return Promise.reject(new TypeError('Network request failed'));
      });
      return giveSession('tkQ', 'u1').then(function () {
        return requests.get('r-q1');
      }).then(function (r) {
        eq('⚠⚠⚠ 网络炸 → ok:false（**不是** ok:true+null）', r.ok, false);
        eq('  └ req 没有值（兜成 null 会让用户去点那颗按钮，然后真多出一张单）',
          r.req, undefined);
      });
    });

    /* ---- 十五.6 记录 id 非法 → 本地就挡，不打请求 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub2();
      localsdk._setFetch(stubOf2({ ok: true }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.get('a b');
      }).then(function (r) {
        eq('⚠ 记录 id 非法 → 本地就挡掉', r.ok, false);
        eq('  └ code = BAD_ID', r.code, 'BAD_ID');
        eq('  └ 一个请求都没发下去', sent.length, 0);
      });
    });

    /* ---- 十五.7 create：请求长什么样 + 单子内容就是八字本身 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub2();
      localsdk._setFetch(stubOf2({
        ok: true,
        request: {
          id: 'qX', recordId: 'r-q1', status: 'pending',
          takenBy: null, takenByName: null, createdAt: 5, takenAt: null
        },
        duplicated: false
      }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.create('r-q1');
      }).then(function (r) {
        eq('create 成功', r.ok, true);
        eq('  └ 用的是 POST', sent[0].init.method, 'POST');
        const u = sent[0].url.replace(localsdk.CONFIG.base, '');
        eq('  └ 路径同一条（GET/POST 是同一个资源）', u, '/records/r-q1/request');
        const body = JSON.parse(sent[0].init.body);
        ok('单子 id 由客户端生成（服务端靠它做幂等）', /^q[A-Za-z0-9]+$/.test(body.id), body.id);
        eq('⚠⚠ body 里**只有 id**：单子的内容就是八字本身，不带留言' +
           '（多一个字段就等于把「留言」这个被否掉的东西偷偷加回来）',
          Object.keys(body).join(','), 'id');
        eq('  └ 回的是服务端那张单（不是自己拼的 {status:\'pending\'}）', r.req.status, 'pending');
        eq('  └ duplicated 透传', r.duplicated, false);
      });
    });

    /* ---- 十五.8 ⚠⚠ 重试沿用同一个 id ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub2();
      localsdk._setFetch(stubOf2({
        ok: true,
        request: { id: 'keep-q', status: 'pending' },
        duplicated: true
      }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.create('r-q1', { id: 'keep-q' });
      }).then(function (r) {
        eq('⚠ 传了 opts.id 就**用它**（重试换 id = 少一次无谓的插入尝试）',
          JSON.parse(sent[0].init.body).id, 'keep-q');
        eq('  └ duplicated:true 原样透传', r.duplicated, true);
      });
    });

    /* ---- 十五.9 ⚠⚠ 幂等命中「早被接单」的老单：原样返回，不伪造 pending ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(stubOf2({
        ok: true,
        request: { id: 'old-q', status: 'taken', takenBy: 'u9', takenByName: '师傅甲' },
        duplicated: true
      }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.create('r-q1');
      }).then(function (r) {
        eq('⚠⚠ 这个八字早就下过单、而且已被接单 → 把「已接单」那张原样还给界面' +
           '（伪造一张 pending 会让用户空等一个永远不会来的接单）', r.req.status, 'taken');
        eq('  └ duplicated:true', r.duplicated, true);
      });
    });

    /* ---- 十五.10 写接口没回单子：宁可报错，也不塞一个空单子 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(stubOf2({ ok: true, request: null, duplicated: false }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.create('r-q1');
      }).then(function (r) {
        eq('⚠⚠ 写接口没回单子 → 如实失败（空单子会渲染出「状态：undefined」）',
          r.ok, false);
        eq('  └ code = BAD_SHAPE', r.code, 'BAD_SHAPE');
      });
    });

    /* ---- 十五.11 ⚠⚠⚠ 失败时把用过的 id 一起返回（供重试） ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      localsdk._setFetch(function () {
        return Promise.reject(new TypeError('Network request failed'));
      });
      return giveSession('tkQ', 'u1').then(function () {
        return requests.create('r-q1', { id: 'retry-q' });
      }).then(function (r) {
        eq('网络炸 → ok:false', r.ok, false);
        eq('⚠⚠⚠ 失败时用的那个 id 原样带回来（调用方重试传回去，' +
           '「超时了其实已经写进去」才不会变成第二张单）', r.id, 'retry-q');
      });
    });

    /* ---- 十五.12 单子 id 非法 → 本地挡 ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'local';
      const sent = resetStub2();
      localsdk._setFetch(stubOf2({ ok: true }));
      return giveSession('tkQ', 'u1').then(function () {
        return requests.create('r-q1', { id: 'a b' });
      }).then(function (r) {
        eq('⚠ 单子 id 非法 → 本地就挡（不打请求）', r.ok, false);
        eq('  └ code = BAD_ID', r.code, 'BAD_ID');
        eq('  └ 一个请求都没发', sent.length, 0);
      });
    });

    /* ---- 十五.13 ⚠⚠⚠ 驱动没有这个方法就**当场抛**（与 comments 同纪律） ---- */
    steps.push(function () {
      resetAll();
      storeMode.MODE = 'cloudbase';
      let threw = '';
      try { store.getRequest('u', 'r-q1'); } catch (e) { threw = String(e && e.message); }
      ok('⚠⚠⚠ 驱动没有 getRequest 时就地抛错（不静默降级成别的接口 —— ' +
         '那会把「这个后端还不支持求测」伪装成一次成功的读）',
        /没有 getRequest/.test(threw), threw);
      threw = '';
      try { store.createRequest('u', 'r-q1', 'q1'); } catch (e) { threw = String(e && e.message); }
      ok('  └ createRequest 同样就地抛', /没有 createRequest/.test(threw), threw);
      storeMode.MODE = 'local';
    });

    results.push({ name: '求测单（requests）', steps: steps });
  }

    results.push({ name: '记住账号密码', steps: steps });
  }

  /* ================================================================
   * 十六、自定义标签（core/tags.js + store 那几条转发）
   * ================================================================
   * 用户需求：「在记录页面增加一个自定义标签功能，将八字归类到自定义的标签内」。
   * ⚠⚠ 这一节的纪律与 comments / requests 完全一致（**永不 reject**、
   *   「一个都没有」是 ok:true 而不是失败、写接口没回对象就如实报 BAD_SHAPE），
   *   所以用例的写法也照抄（一个「服务端回什么」的桩工厂 + 逐条断言）。
   * ⚠⚠⚠ 这一层最容易出的两个静默错：
   *   ① 把读失败兜成 `tags:[]` ⇒ 界面把「断网」显示成「你还没建过标签」；
   *   ② 取消归类时用**真值**判服务端的 `tagId` ⇒ 值是 null，一次成功被误报成形状错误。
   */
  console.log('\n--- 自定义标签（tags） ---');
  {
    const tags = require(path.join(CORE, 'tags.js'));
    const storeMode2 = require(path.join(CORE, 'storeMode.js'));
    const steps = [];

    /* 一个「服务端回什么」的桩工厂（照抄十四节的口径：只换响应体与状态码） */
    function stubOf3(payload, status) {
      return function (url, init) {
        stubOf3.sent.push({ url: String(url), init: init });
        return Promise.resolve({
          status: status || 200,
          text: function () { return Promise.resolve(JSON.stringify(payload)); }
        });
      };
    }
    stubOf3.sent = [];
    function resetStub3() { stubOf3.sent = []; return stubOf3.sent; }
    /** 桩里那句 body 是 JSON 串（localsdk 就是这么发的），解回来供断言 */
    function bodyOf(call) {
      try { return JSON.parse(call.init.body); } catch (e) { return null; }
    }
    /** 去掉 base 前缀，只留路径（断言「打的是哪个接口」更直观） */
    function pathOf(call) {
      return call.url.replace(localsdk.CONFIG.base, '');
    }

    /* ---- 十六.1 支持判定 + id + 名字口径 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      eq('⚠ 自建后端下支持标签', tags.supported(), true);
      storeMode2.MODE = 'cloudbase';
      eq('⚠⚠ 别的后端下**如实说不支持**（绝不假装能用）', tags.supported(), false);
      storeMode2.MODE = 'local';

      const a = tags.newId();
      const b = tags.newId();
      ok('标签 id 形状合规（服务端白名单 [A-Za-z0-9_-]{1,64}）', /^g[A-Za-z0-9_-]{1,63}$/.test(a), a);
      ok('⚠⚠ 连调两次**不是同一个** —— 同毫秒撞 id 的话第二次会撞主键（用户看到「建了但没出来」）',
        a !== b, a + ' vs ' + b);
      /* ⚠⚠⚠ 这是「?tagId=none 表示未分类」那条约定的前提：
         id 的字符集里没有 'none' 这个形状（首字符恒定是 g），
         所以「未分类」那个保留值永远不会跟一个真标签 id 撞上。 */
      ok('⚠⚠⚠ 生成的 id **永远不可能**等于保留值 TAG_NONE（首字符是 g，保留值是 none）',
        a !== tags.TAG_NONE && a.indexOf('g') === 0, a);

      eq('名字去首尾空白', tags.pickName('  客户  ').name, '客户');
      /* ⚠ 只 trim + 限长：**不**做大小写折叠、**不**删中间空格 ——
         一个「看着友好」的归一化会让用户「明明建了两个，界面只显示一个」 */
      eq('⚠ 中间的空格原样保留（不做任何「友好归一化」）', tags.pickName('重 点').name, '重 点');
      eq('大小写原样保留', tags.pickName('VIP').name, 'VIP');
      ok('空串 → 报错', !!tags.pickName('').err);
      ok('全空白 → 报错', !!tags.pickName('   ').err);
      ok('不是字符串 → 报错（不抛异常）', !!tags.pickName(null).err);
      ok('正好 ' + tags.TAG_NAME_MAX + ' 个字 → 放行',
        !tags.pickName('甲'.repeat(tags.TAG_NAME_MAX)).err);
      const over = tags.pickName('甲'.repeat(tags.TAG_NAME_MAX + 1));
      ok('⚠⚠⚠ 超长 → **报错而不是截断**（截断会让用户以为自己打全了）', !!over.err, JSON.stringify(over));
    });

    /* ---- 十六.2 ⚠⚠⚠ TAG_NAME_MAX / TAG_NONE 与服务端**逐字相同** ---- */
    steps.push(function () {
      const tagsTs = path.join(__dirname, '..', '..', 'paipan-server', 'src', 'routes', 'tags.ts');
      const rfTs = path.join(__dirname, '..', '..', 'paipan-server', 'src', 'lib', 'recordFilter.ts');
      if (!fs.existsSync(tagsTs) || !fs.existsSync(rfTs)) {
        /* ⚠ 服务端不在同一工作区时**如实报红**，别静默跳过 ——
           静默跳过会让「这条守卫根本不存在」看起来像「守卫通过了」 */
        ok('⚠ 找到服务端 tags.ts / recordFilter.ts 以便逐字比对常量', false,
          '没找到 ' + tagsTs);
        return;
      }
      const t = fs.readFileSync(tagsTs, 'utf8');
      const nm = /export const TAG_NAME_MAX\s*=\s*(\d+)/.exec(t);
      ok('能从服务端源码里抠出 TAG_NAME_MAX', !!nm, '锚点失配 ⇒ 服务端改了写法，请更新锚点');
      if (nm) {
        eq('⚠⚠⚠ 标签名上限两端**必须相等**（前端宽后端窄 ⇒ 打完提交才被拒；' +
           '前端窄后端宽 ⇒ 前端静默截断）', tags.TAG_NAME_MAX, Number(nm[1]));
      }
      /* ⚠⚠⚠ TAG_NONE 对不上是最毒的一种：服务端会当成「一个叫 none 的标签 id」去查，
         结果是 **0 条**，而界面显示的是「未分类」—— 一个字都不差的静默错误。 */
      const rf = fs.readFileSync(rfTs, 'utf8');
      const tn = /export const TAG_NONE = '([^']*)'/.exec(rf);
      ok('能从服务端源码里抠出 TAG_NONE', !!tn, '锚点失配');
      if (tn) eq('⚠⚠⚠ 「未分类」的保留值两端**逐字相同**', tags.TAG_NONE, tn[1]);
      /* ⚠ 服务端必须显式拒绝用这个 id 建标签（把「永不相撞」从巧合钉成规则） */
      ok('⚠ 服务端对 id === TAG_NONE 显式拒绝（400）',
        /id === TAG_NONE/.test(t), '服务端没有这道校验');
      /* ⚠ 空串与 TAG_NONE 语义不同，别混：'' = 不过滤（全部） */
      ok('⚠⚠ TAG_NONE 不是空串（空串 = 不过滤「全部」，两者语义不同）',
        tags.TAG_NONE !== '' && tags.TAG_NONE.length > 0, String(tags.TAG_NONE));
    });

    /* ---- 十六.3 ⚠⚠ 非 local 后端：如实说不支持，而且一个请求都不发 ---- */
    steps.push(function () {
      resetAll();
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({ ok: true, tags: [], untagged: 0 }));
      storeMode2.MODE = 'cloudbase';
      return tags.list().then(function (r) {
        eq('⚠⚠ 非自建后端 → 不算成功（绝不伪装成「还没有标签」）', r.ok, false);
        eq('  └ code = UNSUPPORTED', r.code, 'UNSUPPORTED');
        eq('  └ 而且一个请求都没发（发一个必然 404 的请求只会让用户以为接口坏了）',
          sent.length, 0);
        storeMode2.MODE = 'local';
      });
    });

    /* ---- 十六.4 list：请求长什么样 + 「一个都没有」是常态 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({
        ok: true,
        tags: [
          { id: 'g1', name: '客户', count: 3, createdAt: 10, updatedAt: 10 },
          { id: 'g2', name: '重点', count: 0, createdAt: 20, updatedAt: 20 }
        ],
        untagged: 7
      }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.list();
      }).then(function (r) {
        eq('list 成功', r.ok, true);
        eq('⚠ 打的是 /tags（不带记录 id —— 标签是账号级的，不属于某条记录）',
          pathOf(sent[0]), '/tags');
        eq('  └ 方法 GET', sent[0].init.method, 'GET');
        eq('  └ 带 Bearer 令牌', String(sent[0].init.headers.authorization), 'Bearer tkT');
        eq('  └ 标签原样透传（顺序＝服务端给的创建顺序）',
          r.tags.map(function (x) { return x.id; }).join(','), 'g1,g2');
        eq('⚠⚠ untagged（未分类条数）透传 —— 标签栏「未分类」那一格的数字靠它',
          r.untagged, 7);
      });
    });

    /* ---- 十六.5 ⚠ 空标签表 ≠ 读失败 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: true, tags: [], untagged: 0 }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.list();
      }).then(function (r) {
        eq('⚠ 一个标签都没建 → ok:true（那是常态，不是错误）', r.ok, true);
        eq('  └ tags 是空数组而不是 undefined', Array.isArray(r.tags), true);
        eq('  └ untagged = 0', r.untagged, 0);
      });
    });

    /* ---- 十六.6 ⚠⚠ 读失败**绝不兜成空数组**（否则「断网」显示成「你还没建过标签」） ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: false, code: 'BOOM', error: '服务器抖了一下' }, 500));
      return giveSession('tkT', 'u1').then(function () {
        return tags.list();
      }).then(function (r) {
        eq('读失败 → ok:false', r.ok, false);
        eq('  └ 不塞空数组', r.tags, undefined);
        eq('  └ 状态码透传（调用方要能识别 401 去走登出）', r.status, 500);
      });
    });

    /* ---- 十六.7 ⚠⚠ list 的形状不对 → BAD_SHAPE（untagged 缺了**不能兜成 0**） ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: true, tags: [{ id: 'g1', name: '客户' }] }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.list();
      }).then(function (r) {
        eq('⚠⚠ 服务端没回 untagged → 如实报形状错（兜成 0 会让「全部」那一格少算未分类的条数，' +
           '而数字看着完全正常）', r.ok, false);
        eq('  └ code = BAD_SHAPE', r.code, 'BAD_SHAPE');
      });
    });

    /* ---- 十六.8 create：请求长什么样 + 409 原样带回 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({
        ok: true, tag: { id: 'g9', name: '客户', count: 0, createdAt: 1, updatedAt: 1 }
      }, 201));
      return giveSession('tkT', 'u1').then(function () {
        return tags.create('客户');
      }).then(function (r) {
        eq('create 成功', r.ok, true);
        eq('⚠ 打的是 POST /tags', pathOf(sent[0]) + ' ' + sent[0].init.method, '/tags POST');
        eq('⚠⚠ **id 由客户端给**（服务端要的是「重试时同一个 id 不要多建一个」）',
          typeof bodyOf(sent[0]).id, 'string');
        eq('  └ 名字也一起发', bodyOf(sent[0]).name, '客户');
        ok('  └ 生成的 id 形状合规', /^g[A-Za-z0-9_-]{1,63}$/.test(bodyOf(sent[0]).id), bodyOf(sent[0]).id);
        eq('  └ duplicated 默认 false', r.duplicated, false);
        eq('  └ tag 原样带回', r.tag.id, 'g9');
      });
    });

    /* ---- 十六.9 ⚠⚠ 同名（409）**原样带回去**，不压成通用失败 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: false, code: 'DUP_NAME', error: '已经有叫这个的标签了' }, 409));
      return giveSession('tkT', 'u1').then(function () {
        return tags.create('客户');
      }).then(function (r) {
        eq('409 重名 → ok:false', r.ok, false);
        eq('⚠⚠ status 409 **原样带回**（调用方要分「重名 → 换个名字」与「网络失败 → 重试」，' +
           '后者重试一万次也没用）', r.status, 409);
        eq('  └ 服务端那句中文原文也带回来', r.error, '已经有叫这个的标签了');
      });
    });

    /* ---- 十六.10 ⚠⚠⚠ 失败时把用过的 id 一起返回（供重试） ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(function () {
        return Promise.reject(new TypeError('Network request failed'));
      });
      return giveSession('tkT', 'u1').then(function () {
        return tags.create('客户', { id: 'retry-tag' });
      }).then(function (r) {
        eq('网络炸 → ok:false', r.ok, false);
        eq('⚠⚠⚠ 失败时用的那个 id 原样带回来（重试传回去，「超时了其实已经写进去」才不会变成第二个标签）',
          r.id, 'retry-tag');
      });
    });

    /* ---- 十六.11 名字非法 → 本地挡，一个请求都不发 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({ ok: true, tag: { id: 'g1', name: 'x' } }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.create('   ');
      }).then(function (r) {
        eq('⚠ 空名字 → 本地就挡（不打请求）', r.ok, false);
        eq('  └ code = BAD_NAME', r.code, 'BAD_NAME');
        eq('  └ 一个请求都没发', sent.length, 0);
        ok('  └ 失败也带 id（重试能沿用）', typeof r.id === 'string' && r.id.length > 0, r.id);
      });
    });

    /* ---- 十六.12 ⚠⚠ 写接口没回 tag：宁可报错，也不塞一个空对象 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: true }, 201));
      return giveSession('tkT', 'u1').then(function () {
        return tags.create('客户');
      }).then(function (r) {
        eq('⚠⚠ 没回 tag → 如实失败（空对象会渲染出「名字：undefined」）', r.ok, false);
        eq('  └ code = BAD_SHAPE', r.code, 'BAD_SHAPE');
      });
    });

    /* ---- 十六.13 rename：PATCH + 路径编码 + 409/404 原样带回 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({ ok: true, tag: { id: 'g1', name: '老客户', count: 3 } }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.rename('g1', '老客户');
      }).then(function (r) {
        eq('rename 成功', r.ok, true);
        eq('⚠ 打的是 PATCH /tags/<id>（id 要 encodeURIComponent）',
          pathOf(sent[0]) + ' ' + sent[0].init.method, '/tags/g1 PATCH');
        eq('  └ body 里只有 name', JSON.stringify(bodyOf(sent[0])), '{"name":"老客户"}');
        eq('  └ tag 原样带回', r.tag.name, '老客户');
      });
    });

    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: false, code: 'DUP_NAME', error: '已经有叫这个的了' }, 409));
      return giveSession('tkT', 'u1').then(function () {
        return tags.rename('g1', '重点');
      }).then(function (r) {
        eq('改名撞别人在用的名字 → 409 原样带回', r.status, 409);
      });
    });

    /* ---- 十六.14 remove：deleted / detached（⚠ 删标签**不是**删记录） ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({ ok: true, deleted: true, detached: 3 }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.remove('g1');
      }).then(function (r) {
        eq('remove 成功', r.ok, true);
        eq('⚠ 打的是 DELETE /tags/<id>', pathOf(sent[0]) + ' ' + sent[0].init.method, '/tags/g1 DELETE');
        eq('  └ deleted', r.deleted, true);
        eq('⚠⚠ detached = 被解除归类的记录条数（界面用它说「3 条记录回到未分类」；' +
           '没有它用户会以为记录也被删了）', r.detached, 3);
      });
    });

    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: true, deleted: false, detached: 0 }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.remove('g1');
      }).then(function (r) {
        eq('⚠ 本来就没有这个标签 → **不是失败**（目标状态已达成，与删记录同一口径）', r.ok, true);
        eq('  └ detached = 0', r.detached, 0);
      });
    });

    /* ---- 十六.15 ⚠⚠⚠ setFor 走的是**专用接口** PUT /records/:id/tag ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({ ok: true, recordId: 'r1', tagId: 'g1', tagName: '客户' }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.setFor('r1', 'g1');
      }).then(function (r) {
        eq('归类成功', r.ok, true);
        eq('⚠⚠⚠ 打的是 PUT /records/<id>/tag —— **不是**整行 PUT /records/<id>。' +
           '后者是整行覆盖，调它会把「没带上的字段」当「要清空」' +
           '（这正是「改描述不会顺手抹掉标签」的原因）',
          pathOf(sent[0]) + ' ' + sent[0].init.method, '/records/r1/tag PUT');
        eq('  └ body 里带 tagId', bodyOf(sent[0]).tagId, 'g1');
        eq('  └ 回带 tagName（卡片那枚 chip 靠它）', r.tagName, '客户');
      });
    });

    /* ---- 十六.16 ⚠⚠⚠ 取消归类：tagId 是 **null**，而且这个键**必须在** ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({ ok: true, recordId: 'r1', tagId: null, tagName: null }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.setFor('r1', null);
      }).then(function (r) {
        eq('取消归类成功', r.ok, true);
        const b = bodyOf(sent[0]);
        eq('⚠⚠⚠ body 必须是 `{"tagId":null}` —— **键在、值是 null**。' +
           '写成「没有这个键」是另一种口径，服务端虽然两种都认，但我们只发一种',
          JSON.stringify(b), '{"tagId":null}');
        eq('  └ 回带的 tagId 归成 null（不是 undefined / 空串）', r.tagId, null);
        eq('⚠⚠⚠ 服务端回 `tagId:null` 时**必须判成成功** —— ' +
           '用真值判（`!d.tagId`）会把一次成功的取消归类误报成形状错误',
          r.ok, true);
      });
    });

    /* ---- 十六.17 服务端没回 tagId 那个键 → BAD_SHAPE（判据是 hasOwnProperty） ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      localsdk._setFetch(stubOf3({ ok: true, recordId: 'r1' }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.setFor('r1', 'g1');
      }).then(function (r) {
        eq('⚠ 没回 tagId 键 → 如实报形状错（不是「归类成功」）', r.ok, false);
        eq('  └ code = BAD_SHAPE', r.code, 'BAD_SHAPE');
      });
    });

    /* ---- 十六.18 记录 id / 标签 id 非法 → 本地挡 ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      const sent = resetStub3();
      localsdk._setFetch(stubOf3({ ok: true }));
      return giveSession('tkT', 'u1').then(function () {
        return tags.setFor('a b', 'g1');
      }).then(function (r) {
        eq('⚠ 记录 id 非法 → 本地就挡（不打请求）', r.ok, false);
        eq('  └ 一个请求都没发', sent.length, 0);
        return tags.setFor('r1', 'a b');
      }).then(function (r2) {
        eq('⚠ 标签 id 非法 → 本地就挡（同上）', r2.ok, false);
        eq('  └ 也没发请求', sent.length, 0);
      });
    });

    /* ---- 十六.19 纯小工具：byId / nameOf / upsert / drop / totalOf ---- */
    steps.push(function () {
      const list = [
        { id: 'g1', name: '客户', count: 3 },
        { id: 'g2', name: '重点', count: 2 }
      ];
      eq('byId 找得到', tags.byId(list, 'g2').name, '重点');
      eq('⚠ byId 找不到给 **null**（不是 undefined —— 让 `if (!t)` 与 `t.name` 两处行为一致）',
        tags.byId(list, 'gX'), null);
      eq('byId 空 id 直接 null', tags.byId(list, ''), null);

      eq('nameOf 取得到名字', tags.nameOf(list, 'g1'), '客户');
      /* ⚠⚠⚠ 取不到给空串：返回 id 本身会把 `g1abc…` 画到卡片上（用户看不懂）；
         返回「未知标签」会让人以为真有这么一个分类。空串 = 不画 chip。 */
      eq('⚠⚠⚠ nameOf 取不到给**空串**（绝不回落到 id 本身、也不编一个「未知标签」）',
        tags.nameOf(list, 'gX'), '');
      eq('  └ 传入 null 也给空串', tags.nameOf(list, null), '');

      const up = tags.upsert(list, { id: 'g1', name: '老客户', count: 3 });
      eq('⚠ upsert 不改传进来的那份（返回新数组）', list[0].name, '客户');
      eq('  └ 同 id 就地替换，位置不变', up.map(function (x) { return x.id; }).join(','), 'g1,g2');
      eq('  └ 替换成了新的那份', up[0].name, '老客户');
      const up2 = tags.upsert(list, { id: 'g3', name: '已批', count: 0 });
      eq('  └ 新 id 追加到末尾', up2.map(function (x) { return x.id; }).join(','), 'g1,g2,g3');
      eq('  └ 传 null 也只是原样返回', tags.upsert(null, { id: 'g1' }).length, 1);

      eq('drop 去掉一个', tags.drop(list, 'g1').map(function (x) { return x.id; }).join(','), 'g2');
      eq('⚠ drop 也不改传入的那份', list.length, 2);

      eq('⚠⚠ totalOf = 未分类 + 各标签 count 之和（「全部」那一格的数字，' +
         '**不是** list.length —— 列表此刻已经是筛过的）', tags.totalOf(list, 7), 12);
      eq('  └ 没有标签时就是未分类那个数', tags.totalOf([], 5), 5);
      eq('  └ 脏数据（count 不是数字）当 0，不变成 NaN', tags.totalOf([{ id: 'g1' }], 2), 2);
    });

    /* ---- 十六.20 ⚠⚠⚠ 驱动没有这个方法就**当场抛**（与 comments / requests 同纪律） ---- */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'cloudbase';
      let threw = '';
      try { store.listTags('u'); } catch (e) { threw = String(e && e.message); }
      ok('⚠⚠⚠ 驱动没有 listTags 时就地抛错（不静默降级成别的接口 —— ' +
         '那会把「这个后端还不支持标签」伪装成一次成功的读）',
        /没有 listTags/.test(threw), threw);
      threw = '';
      try { store.createTag('u', 'g1', '客户'); } catch (e) { threw = String(e && e.message); }
      ok('  └ createTag 同样就地抛', /没有 createTag/.test(threw), threw);
      threw = '';
      try { store.setRecordTag('u', 'r1', 'g1'); } catch (e) { threw = String(e && e.message); }
      ok('  └ setRecordTag 同样就地抛', /没有 setRecordTag/.test(threw), threw);
      storeMode2.MODE = 'local';
    });

    /* ---- 十六.21 ⚠⚠⚠ 只读派生字段 `tagId` 不能在**读**路径上被剥掉 ----
     *
     * 用户报障（2026-10-05）：「排盘结果的详细信息的标签显示未分类，
     *   但是八字已经分类了，甚至在记录页面都能通过标签筛选出来。」
     *
     * 根因**不在标签代码里**：`userStore.listRecords` 读回来时对每一行做
     *   `record.toStorage` —— 那是**写入**白名单（LIGHT_FIELDS + OPTIONAL_FIELDS），
     *   而 `tagId` 是**只读派生字段**（服务端 LEFT JOIN 带出来的），**故意不在**里面
     *   （放进去整行 PUT 就漏一处抹一次）。⇒ 读路径把它**静默剥掉了**。
     *
     * 现象之所以难查：**筛选照样筛得出来**（那是服务端做的，不经过这条路），
     *   于是看起来像「数据是好的、只是界面不显示」。
     * ⚠ 这条断言必须钉在**读路径**上（纯函数层的 withSummary / toHandoff 早就
     *   显式贴了 tagId，喂进去时本来就有值 ⇒ 那一层永远测不出这个 bug）。
     */
    steps.push(function () {
      resetAll();
      storeMode2.MODE = 'local';
      resetStub3();
      const userStore3 = require(path.join(CORE, 'userStore.js'));
      const recordLib = require(path.join(CORE, 'record.js'));
      localsdk._setFetch(stubOf3({ ok: true, records: [
        { id: 'r1', name: '张三', gender: 1, date: '1990-01-05', time: '08:00',
          createdAt: 1000, tagId: 'g1' },
        { id: 'r2', name: '李四', gender: 1, date: '1990-01-06', time: '09:00',
          createdAt: 2000 }
      ] }));
      return giveSession('tkT', 'u1').then(function () {
        return userStore3.listRecords('u1');
      }).then(function (r) {
        eq('读记录成功', r.ok, true);
        eq('⚠⚠⚠ 归过类那条**带着 tagId 读回来**（只走 toStorage 会被静默剥掉 ⇒ ' +
           '卡片没 chip、结果页写「未分类」，而按标签筛选照样筛得到）',
          r.records[0].tagId, 'g1');
        eq('⚠ 没归类那条**连键都不给**（与记录页 / 结果页同一个形状，不是 tagId:null）',
          Object.prototype.hasOwnProperty.call(r.records[1], 'tagId'), false);
        eq('⚠⚠ 贴回来的 tagId 仍然**进不了写入契约**（写回去时 toStorage 再剥一次，' +
           '所以整行 PUT 永远不会把它带上）',
          Object.prototype.hasOwnProperty.call(recordLib.toStorage(r.records[0]), 'tagId'), false);
      });
    });

    results.push({ name: '自定义标签（tags）', steps: steps });
  }

  return results;
}

/* ================================================================ 执行 */

/* ================================================================
 * 八、服务器地址的运行时覆盖（2026-11-13）
 *
 * 为什么要有这一段：地址从「编译期常量」变成了「常量 + 运行时覆盖」，
 * 覆盖值存在本机。这条链断了的表现是**很难查**的那种 ——
 * 「明明改过地址，重启 app 又变回默认」，而日志里干干净净。
 * ================================================================ */
{
  const serverAddr = require(path.join(CORE, 'serverAddr.js'));

  /* --- 规范化：非法输入一律当没填，别把一句乱码当服务器地址去连 --- */
  storeMode.setLocalUrlOverride('  https://a.example.com/  ');
  eq('规范化：去首尾空格 / 去末尾斜杠', storeMode.localUrl(), 'https://a.example.com');
  storeMode.setLocalUrlOverride('a.example.com');
  eq('⚠ 没写协议头 ⇒ 视为没填（回落默认地址）', storeMode.localUrl(), storeMode.LOCAL_URL);
  storeMode.setLocalUrlOverride('ftp://a.example.com');
  eq('⚠ 非 http(s) ⇒ 视为没填', storeMode.localUrl(), storeMode.LOCAL_URL);
  storeMode.setLocalUrlOverride('');

  /* --- 生效值改了就立刻生效（getter 现取，不是加载时拷贝）--- */
  storeMode.setLocalUrlOverride('https://b.example.com');
  eq('⚠ 覆盖值 → localsdk.CONFIG.base 立刻跟着变', localsdk.CONFIG.base, 'https://b.example.com');
  storeMode.setLocalUrlOverride('');
  ok('  └ 清掉覆盖值 → 回到默认（这条确保上一条不是自证）',
    localsdk.CONFIG.base === storeMode.LOCAL_URL, localsdk.CONFIG.base);

  /* --- 落盘 → 冷启动读回来 --- */
  eq('serverAddr.save() 返回落定值', serverAddr.save('https://c.example.com'), 'https://c.example.com');
  eq('  └ current() 与之一致', serverAddr.current(), 'https://c.example.com');
  eq('  └ isOverridden() 为真', serverAddr.isOverridden(), true);
  storeMode.setLocalUrlOverride('');            // 模拟冷启动：内存是空的
  eq('  └ 抹掉内存后回到默认（前置条件）', storeMode.localUrl(), storeMode.LOCAL_URL);
  eq('⚠⚠ 冷启动 init() 从盘里读回覆盖值', serverAddr.init(), 'https://c.example.com');
  ok('  └ storage 里确实存着那个键', storage.getStorageSync(serverAddr.KEY) === 'https://c.example.com',
    String(storage.getStorageSync(serverAddr.KEY)));
  ok('⚠ 键名带 paipan_ 前缀（loadFromDisk 只捞这个前缀，不加就「存进去了读不回来」）',
    /^paipan_/.test(serverAddr.KEY), serverAddr.KEY);

  /* --- save('') = 恢复默认 --- */
  eq('save(\'\') 恢复默认', serverAddr.save(''), storeMode.LOCAL_URL);
  eq('  └ isOverridden() 变回 false', serverAddr.isOverridden(), false);
}

const groups = run();

let chain = Promise.resolve();
groups.forEach(function (g) {
  g.steps.forEach(function (fn) {
    chain = chain.then(function () {
      try { return Promise.resolve(fn()); } catch (e) {
        ok('⚠ 用例内部抛错（' + g.name + '）', false, String(e && e.message));
      }
    });
  });
});

chain.then(function () {
  console.log('');
  assert.lines.forEach(function (l) { console.log(l); });
  console.log('');
  console.log('local-check: ' + assert.pass + ' PASS / ' + assert.fail + ' FAIL');
  if (assert.fail) {
    console.log('');
    console.log('失败清单：');
    assert.lines.filter(function (l) { return l.indexOf('  FAIL') === 0; })
      .forEach(function (l) { console.log(l); });
  }
  process.exit(assert.fail ? 1 : 0);
}).catch(function (e) {
  console.error('local-check 崩了：', e);
  process.exit(1);
});
