/**
 * CloudBase 真实连通性探针 —— **只读，不发短信，不写任何业务数据**
 *
 * 为什么需要它：cloudbase-check.js 是「拿桩喂真实代码」，证明的是**逻辑对不对**；
 * 但「环境是不是真配好了」桩证明不了 —— 域名、Publishable Key、RLS、认证端点
 * 这四样任何一样没到位，桩测试照样全绿、真机上照样 401。
 * 所以这个探针专门打**真接口**，样本量小但每一条都打在真实环境上。
 *
 * 用法：
 *   node tools/run.js tools/probe-cloudbase.js
 *
 * 判定基准（预期值都写在代码里，不靠人肉记忆）：
 *   · 无凭证读数据面            → 401（要么就是 anon 哨兵被挡，总之**不能**读出行来）
 *   · Publishable Key 读数据面  → 200 + []（RLS 的 auth.uid() <> 'anon' 把它排除了）
 *   · Publishable Key 写数据面  → 必须失败（anon 没有写入资格）
 *   · 非法手机号发码            → 4xx（证明认证端点活着）
 *   · 合法手机号                → **不打**（会真发短信花钱，留给 App 里由人触发）
 *   · 用户名密码登录            → 400 + INVALID_USERNAME_OR_PASSWORD（证明这条链路可用）
 *                               ⚠ 不合规 / 不存在的用户名**同码同状态**（不泄露规则、不区分账号）
 *   · 用户名密码自助注册        → **不合规用户名先被 400 拦（响应里带服务端正则原文）**；
 *                                **合规用户名才到 501**（「客户端没有注册按钮」的唯一依据）
 *
 * ⚠⚠ 探针只验「失败那一半」——**成功那一半（真账号登录）刻意不做**：
 *   那需要真账号与真密码，跑一次就多一个登录会话，没有知识增量。
 */
const path = require('path');
const cbsdk = require(path.join(__dirname, '..', 'src', 'core', 'cbsdk.js'));

const B = cbsdk.CONFIG.base;
const PK = cbsdk.CONFIG.publishableKey;
const REST = '/v1/rdb/rest/records';

let pass = 0;
let fail = 0;
const lines = [];

function check(name, cond, extra) {
  if (cond) { pass++; lines.push('  PASS  ' + name); }
  else { fail++; lines.push('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

/** 打一个真请求，返回 { status, headers, body(text), json } */
async function hit(method, path_, o) {
  const opts = o || {};
  const headers = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
  try {
    const res = await fetch(B + path_, {
      method: method,
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(cbsdk.CONFIG.timeoutMs || 15000)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (err) { /* 非 JSON 就留 null */ }
    return { status: res.status, text: text, json: json, range: res.headers.get('content-range') || '' };
  } catch (err) {
    return { status: 0, text: '', json: null, range: '', error: (err && err.message) || String(err) };
  }
}

function show(label, r) {
  const body = r.text ? r.text.slice(0, 400) : '(空)';
  console.log('    ' + label + ' → ' + (r.error ? 'ERR ' + r.error : r.status + '  ' + body));
}

async function run() {
  console.log('CloudBase 探针 · ' + B);
  console.log('Publishable Key 前缀: ' + String(PK).slice(0, 24) + '…  (长度 ' + String(PK).length + ')');
  console.log('');

  /* ---- 1. 数据面 · 无凭证 ---- */
  console.log('[1] 数据面 GET 不带任何凭证');
  const r1 = await hit('GET', REST + '?select=id');
  show('GET ' + REST, r1);
  check('不带凭证**读不出任何行**来', r1.status !== 200 || (Array.isArray(r1.json) && r1.json.length === 0),
    'status=' + r1.status + ' body=' + r1.text.slice(0, 80));

  /* ---- 2. 数据面 · Publishable Key（anon 哨兵） ---- */
  console.log('[2] 数据面 GET 带 Publishable Key（role=anon）');
  const r2 = await hit('GET', REST + '?select=id,name,owner', { token: PK });
  show('GET ' + REST, r2);
  check('⭐ anon 身份读数据面返回 200', r2.status === 200, 'status=' + r2.status + ' body=' + r2.text.slice(0, 120));
  check('⭐⭐ anon 哨兵在 RLS 下**看不到任何行**（这条是整库隔离的地基）',
    Array.isArray(r2.json) && r2.json.length === 0,
    'body=' + r2.text.slice(0, 200));

  /* ---- 3. 数据面 · anon 想写 ---- */
  console.log('[3] 数据面 POST 带 Publishable Key（anon 想写一条）');
  const r3 = await hit('POST', REST, {
    token: PK,
    body: { owner: 'anon', id: '__probe_should_never_land__', name: 'x', gender: 1, birth_date: '1990-01-01', birth_time: '11:04', created_at: 1 },
    headers: { prefer: 'return=representation' }
  });
  show('POST ' + REST, r3);
  check('⚠ anon 写入被拒（不是 2xx）', !(r3.status >= 200 && r3.status < 300),
    'status=' + r3.status + ' body=' + r3.text.slice(0, 120));

  /* ---- 4. 认证端点 · 非法手机号（**不会**真发短信） ---- */
  console.log('[4] 认证端点 POST /auth/v1/verification（非法手机号）');
  const r4 = await hit('POST', '/auth/v1/verification', { body: { phone_number: '123', target: 'ANY' } });
  show('POST /auth/v1/verification', r4);
  check('认证端点存在（不是 404）', r4.status !== 404, 'status=' + r4.status);
  check('⚠ 非法手机号被服务端拒（4xx）', r4.status >= 400 && r4.status < 500,
    'status=' + r4.status + ' body=' + r4.text.slice(0, 120));

  /* ---- 5. 客户端本地校验：非法号根本不发请求 ---- */
  console.log('[5] 本地校验（不该产生任何网络请求）');
  const bad = await cbsdk.sendCode('1380013800');   // 10 位，缺一位
  check('⭐ 位数不对的号码本地就拦下（ok:false）', bad.ok === false, JSON.stringify(bad));
  check('且错误码是 invalid_phone_number', bad.code === 'invalid_phone_number', bad.code);
  check('normalizePhone 把合法号补齐成 "+86 13800138000"', cbsdk.normalizePhone('13800138000') === '+86 13800138000');

  /* ---- 6. 真实错误形状（假 id / 假 token，**不会**真发短信） ----
     ⚠ 这一步的存在理由：errText 的码表是照 OpenAPI 文档写的，但实测
       [4] 返回的是 gRPC 风格的 INVALID_ARGUMENT / error_code:3，
       跟文档里的 invalid_phone_number / 4001 **对不上**。
       ⇒ 文档不能当实测用，必须把这些码真打出来，再看翻译层认不认。 */
  console.log('[6] 认证端点错误形状（假 id / 假 token，不发短信）');
  const r6 = await hit('POST', '/auth/v1/verification/verify', {
    body: { verification_id: '__probe_not_exist__', verification_code: '000000' }
  });
  show('verify(假 id)', r6);
  const r7 = await hit('POST', '/auth/v1/signin', { body: { verification_token: '__probe_bad_token__' } });
  show('signin(假 token)', r7);
  const r8 = await hit('POST', '/auth/v1/signup', {
    body: { phone_number: '+86 13800138000', verification_token: '__probe_bad_token__' }
  });
  show('signup(假 token)', r8);
  check('校验接口存在（不是 404）', r6.status !== 404, 'status=' + r6.status);
  check('登录接口存在（不是 404）', r7.status !== 404, 'status=' + r7.status);
  check('注册接口存在（不是 404）', r8.status !== 404, 'status=' + r8.status);

  /* ---- 7. 翻译层覆盖检查：实测到的码必须能翻成中文 ----
     ⚠ 判据**不能**只看「含中文」：实测 verify 的 error_description 里服务端自己带了
       半句中文（"无效的验证码%!(EXTRA string=rpc error: ...)"），含中文却夹着
       Go 格式化失败的脏数据，显示出去比英文还糟。
     干净的判据是**映射表是否命中**：命中时结果只由 code 决定，fallback 传什么都不变；
     没命中才会跟着 fallback 漂移。⇒ 同一个码喂两个不同 fallback，结果必须一致。 */
  console.log('[7] 错误码翻译覆盖（实测码 → 界面文案）');
  [['发码', r4], ['校验', r6], ['登录', r7], ['注册', r8]].forEach(function (pair) {
    const r = pair[1];
    const code = (r.json && (r.json.code || r.json.error)) || '';
    if (!code) return;
    const real = cbsdk.errText(code, (r.json && r.json.error_description) || '');
    const a = cbsdk.errText(code, 'FALLBACK-A');
    const b = cbsdk.errText(code, 'FALLBACK-B');
    console.log('    ' + pair[0] + ' ' + code + '  →  ' + String(real).slice(0, 100));
    check('⭐ ' + pair[0] + '的实测码 ' + code + ' 命中映射表（文案不随 fallback 漂移）',
      a === b && a.indexOf('FALLBACK') < 0, a);
    check('  └ 且不含服务端英文原文 / 格式化脏数据',
      !/malformed|regex pattern|%!\(/.test(String(real)), String(real));
  });

  /* ---- 8. 走真实端点函数打真接口（verify 用假 id，**不发短信**） ----
     这一步验证的是「端点级 overrides 有没有真的生效」——
     [7] 只验了通用映射表，绕过端点函数是验不到 overrides 的。 */
  console.log('[8] 真实端点函数打真接口（verify 用假 id）');
  const v = await cbsdk.verifyCode('__probe_not_exist__', '000000');
  console.log('    verifyCode → ok=' + v.ok + '  code=' + v.code + '  error=' + v.error);
  check('⭐ 端到端错误文案是中文、且带端点上下文（说得出「验证码」）',
    v.ok === false && /验证码/.test(String(v.error)), String(v.error));
  check('  └ 不含英文原文', !/malformed|regex pattern/.test(String(v.error)), String(v.error));

  /* ---- 9. 刷新端点错误形状（假 refresh_token，不发短信） ----
     既然要把桩改成「复刻真实」，那真实形状就得一个都不落下 —— 尤其是这个，
     它同时是「令牌过期」路径的唯一判据来源（session.js 靠 code 区分 EXPIRED 和 NETWORK）。 */
  console.log('[9] 刷新端点错误形状（假 refresh_token）');
  const r9 = await hit('POST', '/auth/v1/token', {
    body: { grant_type: 'refresh_token', refresh_token: '__probe_bad_refresh__' }
  });
  show('token(假 refresh)', r9);
  check('刷新接口存在（不是 404）', r9.status !== 404, 'status=' + r9.status);
  const r9code = (r9.json && (r9.json.code || r9.json.error)) || '';
  const r9text = cbsdk.errText(r9code, (r9.json && r9.json.error_description) || '');
  console.log('    刷新失败码 ' + r9code + '  →  ' + String(r9text).slice(0, 100));
  check('⭐ 刷新失败的码也能翻成中文', /[\u4e00-\u9fa5]/.test(r9text) && !/malformed|%!\(/.test(r9text), r9text);

  /* ---- 10. 造几个格式合法的假 JWT，把「令牌真失效」的形状摸清楚 ----
     ⚠ 为什么非做不可：session.js 判「登录过期」的唯一依据就是这个响应。
       实测一个**垃圾串** refresh_token 只得到 500 + error:"unknown" + "invalid token header"，
       这跟「网络失败」长得像。如果真失效也是这个形状，
       用户会永远卡在「续期失败请检查网络」，而真正该做的是重新登录。 */
  console.log('[10] 假 JWT 形态探测（不发短信）');
  const b64 = function (o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); };
  const hdr = b64({ alg: 'RS256', typ: 'JWT' });
  const shapes = [
    ['exp 已过期', hdr + '.' + b64({ sub: '1', exp: 1, iat: 1 }) + '.AAAA'],
    ['exp 在未来', hdr + '.' + b64({ sub: '1', exp: 9999999999, iat: 1 }) + '.AAAA']
  ];
  for (let i = 0; i < shapes.length; i++) {
    const rr = await hit('POST', '/auth/v1/token', { body: { grant_type: 'refresh_token', refresh_token: shapes[i][1] } });
    show(shapes[i][0], rr);
  }

  /* ---- 11. RPC 路由：数据库函数能不能从网关调得到 ----
     ⚠ 为什么单独验这一段：**函数建在库里 ≠ App 调得到**。
       中间还隔着「网关鉴权 → 路由分发 → PostgREST 找函数」三步，
       桩测试对这三步一无所知，只有打真接口才知道。
     ⚠⚠ 「真函数名 vs 假函数名」的对照**必须带凭证**做 ——
       不带凭证时网关在鉴权那一步就返回 401，**根本走不到找函数**，
       于是两个名字的响应必然一模一样（2026-10-02 实测踩到，断言白写）。 */
  console.log('[11] RPC 路由（数据库函数 save_notes）');
  const rpcBody = { p_record_id: '__probe__', p_notes: { a: 1 } };
  const r11 = await hit('POST', '/v1/rdb/rest/rpc/save_notes', { body: rpcBody });
  show('POST rpc/save_notes（无凭证）', r11);
  check('⭐ RPC 路由存在（不是 404）', r11.status !== 404,
    'status=' + r11.status + ' body=' + r11.text.slice(0, 120));
  check('⭐ 未认证调用被拒（不是 2xx）', !(r11.status >= 200 && r11.status < 300),
    'status=' + r11.status);

  /* ---- 12. 带 anon 凭证：路由按名字分发吗 + 匿名身份能拿到什么 ----
     ⚠ 两条都必须带凭证 —— 无凭证时它们会在同一步被 401 拦下，分不出来。 */
  console.log('[12] RPC · anon 身份（Publishable Key）');
  const r12 = await hit('POST', '/v1/rdb/rest/rpc/no_such_function_xyz', { token: PK, body: {} });
  show('POST rpc/no_such_function_xyz（函数名不存在）', r12);
  const r13 = await hit('POST', '/v1/rdb/rest/rpc/save_notes', { token: PK, body: rpcBody });
  show('POST rpc/save_notes（anon）', r13);
  check('⭐ 路由按函数名分发：真名与假名的响应可区分',
    r12.status !== r13.status || r12.text.slice(0, 60) !== r13.text.slice(0, 60),
    'save_notes=' + r13.status + ' / 不存在=' + r12.status);
  check('⭐ anon 调不动这个函数（ACL 上已收回 anon 的 EXECUTE）',
    !(r13.status >= 200 && r13.status < 300),
    'status=' + r13.status + ' body=' + r13.text.slice(0, 160));
  /* ⚠ 这条判据比「不是 2xx」强：P0002 是**函数体内的报错**，
     它出现在响应里就说明请求**已经进到函数里了**（= ACL 没收干净，只是被 RLS 兜住）。
     这正是 2026-10-02 第一版实测到的形状（500 + DATABASE_P0002），
     所以把它反向写成断言：**响应里不许出现 P0002**。 */
  check('⭐ 且没进到函数体内（响应不含 P0002，说明 ACL 那道就挡住了）',
    String(r13.text).indexOf('P0002') < 0,
    String(r13.text).slice(0, 160));

  /* ---- 13. 账号 + 密码登录（⭐ 当前主路径） ----
     ⚠ 这一段是「平台到底支不支持账号密码登录」的**唯一**硬证据 ——
       桩测试只能证明「我们的代码按这个形状发的」，证明不了「平台认这个形状」。
     ⚠ 全部用假账号：不发短信、不改任何数据。
     ⚠⚠ 副作用风险只在 13d：那里**必须**用**合规**用户名才能打到 501
       （不合规的会在参数校验那一层就被 400 拦掉，根本到不了 501）。
       所以「万一平台哪天放开了自助注册」时，那一发会真的建出 `probe-never-register`
       这个号。真出现了就说明「登录页没有注册按钮」这个结论过期了 ——
       那时请去管控面把它删掉，并重新评估要不要加注册入口。
     ⚠⚠ 2026-10-02 实测纠正了两处原先的错记：
       ① 正则原文**不是**从 signin 吐的（signin 对不合规用户名只回通用的
          INVALID_USERNAME_OR_PASSWORD，刻意不泄露规则、也不区分账号是否存在）；
          它只从 **signup 的参数校验失败**里漏出来。
       ② signup 回 400 还是 501，**取决于用户名合不合规**：
          不合规 → 400 INVALID_ARGUMENT + 正则原文；合规 → 501 UNIMPLEMENTED。 */
  console.log('[13] 账号 + 密码登录（用假账号，不建号不写数据）');

  /* 13a 用户名不合平台正则 → signin 只回**通用**的 INVALID_USERNAME_OR_PASSWORD。
     ⚠ 这里要守的是**不泄露**：服务端不能把「规则是什么」或「账号存不存在」告诉调用方，
       否则登录页就成了账号枚举器。 */
  const r14 = await hit('POST', '/auth/v1/signin', { body: { username: 'ZhangSan.Dot', password: '__probe__' } });
  show('signin(用户名不合规)', r14);
  const r14code = (r14.json && (r14.json.code || r14.json.error)) || '';
  check('⭐ 用户名不合规时 signin 回**通用**的 INVALID_USERNAME_OR_PASSWORD（不是 400 参数错）',
    r14code === 'INVALID_USERNAME_OR_PASSWORD', r14code);
  check('  └ ⚠ 且**不泄露**规则（响应里没有 regex pattern 原文）',
    !/regex pattern/.test(r14.text), r14.text.slice(0, 200));

  /* 13b 账号不存在（但用户名**合规**）→ 与 13a 同一个码。
     ⚠ 这两条一起才说明「服务端不区分『账号不存在』与『密码错』」—— 反枚举。 */
  const r15 = await hit('POST', '/auth/v1/signin', {
    body: { username: 'probe-no-such-user', password: '__probe__' }
  });
  show('signin(账号不存在，用户名合规)', r15);
  check('⭐ 账号密码登录端点可用（不是 404 / 501）', r15.status !== 404 && r15.status !== 501,
    'status=' + r15.status);
  const r15code = (r15.json && (r15.json.code || r15.json.error)) || '';
  console.log('    码=' + r15code + '  error_code=' + (r15.json && r15.json.error_code) + '  →  '
    + cbsdk.errText(r15code, (r15.json && r15.json.error_description) || ''));
  check('⭐⭐ 码是 INVALID_USERNAME_OR_PASSWORD（**全大写**，实测形状）',
    r15code === 'INVALID_USERNAME_OR_PASSWORD', r15code);
  check('  └ ⚠⚠ 与「用户名不合规」那一条**同码同状态**（不区分账号是否存在，防账号枚举）',
    r15code === r14code && r15.status === r14.status,
    r14.status + '/' + r14code + '  vs  ' + r15.status + '/' + r15code);
  check('  └ 且能翻成中文、不甩英文原文',
    /[\u4e00-\u9fa5]/.test(cbsdk.errText(r15code, '')) &&
    !/invalid_username|invalid_argument/.test(cbsdk.errText(r15code, '')), cbsdk.errText(r15code, ''));

  /* 13c 用户名不合规时打 signup → 400 + 服务端把自己的正则**原样吐回来**。
     ⚠ 这是本项目「别照文档抄规则」那条铁律的来源，所以要一直守着：
       正则一旦变，前端的 USERNAME_RE 必须跟着变，否则前端放行 / 服务端 400。 */
  const r16 = await hit('POST', '/auth/v1/signup', {
    body: { username: '__probe_bad__', password: '__probe__' }
  });
  show('signup(用户名不合规)', r16);
  /* ⚠⚠ 别在**原始响应文本**上正则：里面的引号是 JSON 转义过的（`pattern \"^$|...\"`），
     按未转义写会永远匹配不上（踩过一次）。先 JSON.parse 解出描述文字再匹配。 */
  const desc16 = (r16.json && (r16.json.error_description || r16.json.message)) || r16.text;
  const re16 = /regex pattern "([^"]*)"/.exec(desc16);
  check('⭐ 服务端会把用户名正则原文吐回来（规则的真实来源）', !!re16, r16.text.slice(0, 200));
  if (re16) {
    console.log('    服务端正则：' + re16[1]);
    check('⭐⭐ 实测正则是 `^[a-z][0-9a-z_-]{5,24}$`（只认小写、只允许 - 和 _）',
      re16[1].indexOf('[a-z][0-9a-z_-]{5,24}') >= 0, re16[1]);
    /* 比对时要把服务端那个 `^$|` 前缀摘掉（它是「允许为空」那一支，前端不采用） */
    check('  └ 且前端 cbsdk.USERNAME_RE 与它逐字一致（漂移 = 前端放行、服务端 400）',
      String(cbsdk.USERNAME_RE.source) === re16[1].replace('^$|', ''), cbsdk.USERNAME_RE.source);
  }

  /* 13d ⚠⚠ 客户端**不能**自助注册用户名密码 —— 「登录页没有注册按钮」的唯一依据。
     ⚠ 用户名必须**合规**，否则连 501 都到不了（会被当成 13c 那种参数错）。 */
  const r17 = await hit('POST', '/auth/v1/signup', {
    body: { username: 'probe-never-register', password: '__probe__' }
  });
  show('signup(用户名合规，username+password)', r17);
  check('⭐⭐ 用户名密码自助注册被平台拒（501 UNIMPLEMENTED）', r17.status === 501, 'status=' + r17.status);
  check('  └ 原话是 "you can not signup just by username and password"',
    /can not signup just by username and password/.test(r17.text), r17.text.slice(0, 200));

  /* 13e 只给密码 → 服务端要求 username / verification_token 二选一 */
  const r18 = await hit('POST', '/auth/v1/signin', { body: { password: '__probe__' } });
  show('signin(只给密码)', r18);
  check('⭐ 只给密码时服务端要求 username 或 verification_token 二选一',
    /username or verification_token|can ?not both be empty/i.test(r18.text), r18.text.slice(0, 200));

  console.log('');
  lines.forEach(function (l) { console.log(l); });
  console.log('');
  console.log('probe-cloudbase: ' + pass + ' PASS / ' + fail + ' FAIL');
  console.log('（注：短信真发链路需在 App 里输真实手机号触发，探针刻意不碰；');
  console.log('  账号密码链路的**成功**那一半需要真账号，同理不在探针里做）');
  return fail ? 1 : 0;
}

run().then(function (code) { process.exit(code); }, function (err) {
  console.error('探针自身异常:', err && err.stack || err);
  process.exit(1);
});
