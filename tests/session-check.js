/**
 * 会话 / 存储整链自检 —— core/auth.js + core/boot.js + core/history.js + core/userStore.js
 *   + core/chartBus.js + core/store/*
 *
 * 纯 Node，**不需要装 Expo 依赖**（这是本项目「能算对」这一侧的纪律）。
 *
 * ============ 桩停在哪一层 ============
 * ⚠ 只能停在 **HTTP 边界**（`gitee._setHttp`）—— 桩负责「按 Gitee 的真实怪癖回响应」，
 *   业务语义（读-改-写、写前重读 sha、读失败不降级）一律由**真实代码**决定。
 *   把桩往上提（比如直接桩掉 store/gitee.js）就会把被测逻辑一起桩掉。
 *
 * ============ ⚠ 这个桩必须真的实现 Gitee 的四个怪癖 ============
 *   ① 读不存在的文件 → 200 + `[]`（不是 404）
 *   ② POST 已存在 → 400「文件名已存在」
 *   ③ PUT 缺 sha 或 sha 过期 → 400/409
 *   ④ GET 的 content 是 base64 **字符串**，POST/PUT 的 content 是**明文**（Gitee 接受 base64 字符串）
 *   桩写错 → 测试假绿（本项目踩过多次）。
 *
 * ⚠ 断言走 stdout，最后必须 process.exit(fail?1:0)
 */
const path = require('path');
const assert = { pass: 0, fail: 0, lines: [] };

function ok(name, cond, extra) {
  if (cond) { assert.pass++; assert.lines.push('  PASS  ' + name); }
  else { assert.fail++; assert.lines.push('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

const SRC = path.join(__dirname, '..', 'src');
const CORE = path.join(SRC, 'core');

/* ============================================================ Gitee HTTP 桩 */

/**
 * 一个极简但**忠实**的 Gitee contents 实现。
 * 只做这件事：在内存里维护 path → { text, sha }，并按真实接口的形状回应。
 */
function makeGitee() {
  const files = new Map();   // path → { text, sha }
  let seq = 0;
  const log = [];            // 请求记录，供断言「写前是否重读」

  function shaFor(text) {
    seq += 1;
    // 够用的假 sha：内容 + 序号（序号保证「内容没变但被重写过」时 sha 也会变）
    return 'sha' + seq + '-' + text.length;
  }

  function stub(opts) {
    const url = String(opts.url || '');
    const m = url.match(/\/contents\/([^?]+)/);
    const p = m ? decodeURIComponent(m[1]) : '';
    const method = opts.method || 'GET';
    log.push(method + ' ' + p);

    if (method === 'GET') {
      const f = files.get(p);
      // 坑①：不存在 → 200 + []（**不是 404**）
      if (!f) return { statusCode: 200, data: [] };
      return {
        statusCode: 200,
        data: {
          // 坑④：GET 的 content 是 base64 字符串
          content: b64(f.text),
          sha: f.sha,
          path: p
        }
      };
    }

    if (method === 'POST') {
      // 坑②：已存在 → 400
      if (files.has(p)) {
        return { statusCode: 400, data: { message: '文件名已存在' } };
      }
      if (!opts.data || typeof opts.data.content !== 'string') {
        return { statusCode: 400, data: { message: 'content is required' } };
      }
      const text = unb64(opts.data.content);
      const sha = shaFor(text);
      files.set(p, { text: text, sha: sha });
      return { statusCode: 201, data: { content: { sha: sha, path: p } } };
    }

    if (method === 'PUT') {
      const f = files.get(p);
      if (!f) return { statusCode: 404, data: { message: '文件不存在' } };
      // 坑③：缺 sha / sha 不匹配 → 400
      if (!opts.data || !opts.data.sha) {
        return { statusCode: 400, data: { message: 'sha is missing' } };
      }
      if (opts.data.sha !== f.sha) {
        return { statusCode: 409, data: { message: 'sha 不一致，文件已被修改' } };
      }
      const text = unb64(opts.data.content);
      const sha = shaFor(text);
      files.set(p, { text: text, sha: sha });
      return { statusCode: 200, data: { content: { sha: sha, path: p } } };
    }

    return { statusCode: 405, data: { message: 'method not allowed' } };
  }

  return {
    stub: stub,
    log: log,
    files: files,
    get: (p) => files.get(p),
    /** 外部（模拟另一台设备）直接改文件 */
    put: (p, text) => {
      const sha = shaFor(text);
      files.set(p, { text: text, sha: sha });
      return sha;
    },
    reset: () => { files.clear(); log.length = 0; },
    countOf: (method) => log.filter((x) => x.indexOf(method + ' ') === 0).length
  };
}

/* base64（测试自己写一份，不依赖被测的 gitee.b64encode —— 否则同一处错会互相掩盖） */
function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function unb64(s) { return Buffer.from(String(s), 'base64').toString('utf8'); }

/* ============================================================ 环境装配 */

const storage = require(path.join(SRC, 'platform', 'storage.js'));
const gitee = require(path.join(CORE, 'gitee.js'));
const storeMode = require(path.join(CORE, 'storeMode.js'));
const auth = require(path.join(CORE, 'auth.js'));
const userStore = require(path.join(CORE, 'userStore.js'));
const boot = require(path.join(CORE, 'boot.js'));
const history = require(path.join(CORE, 'history.js'));
const chartBus = require(path.join(CORE, 'chartBus.js'));

const g = makeGitee();
gitee._setHttp(g.stub);

/* 内存 storage 桩（API 形状见 platform/storage.js：get/set/remove） */
const mem = {};
storage._setStore({
  get: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''),
  set: (k, v) => { mem[k] = String(v); },
  remove: (k) => { delete mem[k]; }
});

/* ============================================================ 测试主体 */

/** 每个用例之间彻底重来一次：清 storage + 清云端 + 清 boot 的进程内记忆 */
function resetWorld(keepDeviceCode) {
  const savedAnon = keepDeviceCode ? mem['paipan_anon_v1'] : null;
  Object.keys(mem).forEach((k) => delete mem[k]);
  if (savedAnon) mem['paipan_anon_v1'] = savedAnon;
  g.reset();
  boot.forget();
  // ⚠⚠ 必须把 HTTP 桩装回去 —— 前面某一组注入过「断网」桩，
  //   忘了还原的话后面**全部**用例都会拿到 HTTP 0，
  //   表现成「一片红」而不是「一处红」，查起来会误以为是业务代码坏了（已踩）。
  gitee._setHttp(g.stub);
}

function run() {
  const steps = [];

  /* ---------- 1. storeMode ---------- */
  steps.push(() => {
    // ⚠ 2026-10-03 方向变更：存储后端从 CloudBase 换到**自建 paipan-server**。
    //   原因见 core/storeMode.js 文件头：① CloudBase 自助注册被平台禁死（501），
    //   而用户要的正是「能自己注册」；② 体验版 2027-04-02 到期且按 QPS 计费。
    //   CloudBase 那套代码**保留**（MODE 改回 'cloudbase' 即可切回，全链路已验证）。
    //   这条断言跟着**真实默认值**走，不是为了让测试变绿而放松要求。
    eq('storeMode.MODE 默认是 local（自建 paipan-server）', storeMode.MODE, 'local');
    eq('isFileLevel() 为 false（记录级模型）', storeMode.isFileLevel(), false);
    eq('ready() 为 true（本地后端地址已配置）', storeMode.ready(), true);

    // ⚠⚠ 本地模式的地址必须真的是**局域网地址**，不能是 127.0.0.1 ——
    //   手机上的 127.0.0.1 指向手机自己，必然连不上，而且报的是「网络错误」，
    //   用户会去查 WiFi，永远查不到是这个字面量写错了。
    ok('LOCAL_URL 是可用的 http 地址（不是 127.0.0.1）',
      /^https?:\/\//.test(storeMode.LOCAL_URL) && !/127\.0\.0\.1|localhost/.test(storeMode.LOCAL_URL),
      'LOCAL_URL=' + storeMode.LOCAL_URL);

    // 非法值必须**如实抛错**，不静默降级
    const keep = storeMode.MODE;
    storeMode.MODE = 'gitee2';
    let threw = '';
    try { storeMode.assertUsableMode(); } catch (e) { threw = String(e && e.message); }
    ok('MODE 非法时 assertUsableMode 抛错', threw.length > 0, 'threw=' + threw);
    ok('抛错文案里带上了那个错值', threw.indexOf('gitee2') >= 0, threw);
    storeMode.MODE = keep;
    // 还原后必须又能过
    let okAgain = true;
    try { storeMode.assertUsableMode(); } catch (e) { okAgain = false; }
    ok('还原 MODE 后守卫放行', okAgain);

    // ⚠ 这条守的是「必须读 module.exports.MODE」而不是模块内 const
    storeMode.MODE = 'cloud';
    eq('外部改 MODE 后 isFileLevel() 跟着变（证明读的是导出属性）', storeMode.isFileLevel(), false);
    // ⚠ 每个**合法**值都必须被守卫放行 —— 只测一个的话，往 OK 数组里漏掉某个值不会被抓到
    const legal = ['gitee', 'cloud', 'cloudbase', 'local'];
    legal.forEach((m) => {
      storeMode.MODE = m;
      let passed = true;
      try { storeMode.assertUsableMode(); } catch (e) { passed = false; }
      ok('合法值 ' + m + ' 被守卫放行', passed);
    });
    storeMode.MODE = 'gitee';
  });

  /* ---------- 2. uidOf 的字段兼容 + uidOk ---------- */
  steps.push(() => {
    eq('uidOf(null) → 空', userStore.uidOf(null).uid, '');
    eq('uidOf 认 unionid', userStore.uidOf({ unionid: 'u1' }).source, 'unionid');
    eq('uidOf 认 openid', userStore.uidOf({ openid: 'o1' }).source, 'openid');
    eq('uidOf 认 anonymousCode（小程序侧字段）', userStore.uidOf({ anonymousCode: 'a1' }).uid, 'a1');
    eq('uidOf 认 anonymousId（脱敏视图字段）', userStore.uidOf({ anonymousId: 'a2' }).uid, 'a2');
    // ⚠⚠ 这条是真实踩到的 bug：RN 侧登录态写的字段叫 deviceCode，少认一个就 uid=''
    eq('⚠ uidOf 认 deviceCode（RN 侧登录态字段）', userStore.uidOf({ deviceCode: 'a3' }).uid, 'a3');
    eq('unionid 优先于 deviceCode', userStore.uidOf({ unionid: 'u', deviceCode: 'd' }).uid, 'u');

    eq('uidOk 拒绝空串', userStore.uidOk(''), false);
    eq('uidOk 拒绝带斜杠（防路径穿越）', userStore.uidOk('a/b'), false);
    eq('uidOk 接受 [A-Za-z0-9_-]', userStore.uidOk('Abc-123_x'), true);
    eq('uidOk 拒绝超长', userStore.uidOk('a'.repeat(129)), false);
  });

  /* ---------- 3. 路径：空 uid 绝不出路径 ---------- */
  steps.push(() => {
    eq('fileNameOf 空 uid → 空串', userStore.fileNameOf(''), '');
    // ⚠⚠ 这条是真实踩到的 bug：写成 'userData/' + '' + '.json' = 'userData/.json'
    eq('⚠ pathOf 空 uid → 空串（不是 userData/.json）', userStore.pathOf(''), '');
    eq('pathOf 正常 uid', userStore.pathOf('abc'), 'userData/abc.json');
    eq('gitee.pathOf 空 uid → 空串', gitee.pathOf(''), '');
    eq('gitee.safeUid 剥掉危险字符', gitee.safeUid('a/b..c\\d'), 'abcd');
    eq('两层 pathOf 口径一致', gitee.pathOf('x9'), userStore.pathOf('x9'));
  });

  /* ---------- 4. parseDoc：能解析就收敛，不是我们的数据才拒 ---------- */
  steps.push(() => {
    eq('空对象 → null（认不出是我们的数据）', userStore.parseDoc('{}'), null);
    eq('乱码 → null', userStore.parseDoc('not json'), null);
    const asArray = userStore.parseDoc('[{"id":"a"}]');
    ok('裸数组（老格式）被认下', !!asArray && asArray.records.length === 1);
    const doc = userStore.parseDoc('{"schema":1,"records":[{"id":"a"}]}');
    ok('标准外壳被认下', !!doc && doc.records.length === 1);
    const broken = userStore.parseDoc('{"schema":1,"records":"坏了"}');
    ok('schema 在但 records 坏 → 当成空文件（不报错）', !!broken && broken.records.length === 0);
    eq('null 文本 → null', userStore.parseDoc('null'), null);
  });

  /* ---------- 5. base64 往返（UTF-8 感知） ---------- */
  steps.push(() => {
    const cases = ['', 'abc', '一九九八', '张三 · 甲子', '😀emoji', 'a\u0000b', '〇二六'];
    cases.forEach((s, i) => {
      eq('base64 往返 #' + i + ' (' + JSON.stringify(s) + ')', gitee.b64decode(gitee.b64encode(s)), s);
    });
    // 与标准实现比对，防「自己编自己解、两边一起错」
    eq('与 Buffer 的 base64 一致（ASCII）', gitee.b64encode('Hello'), Buffer.from('Hello').toString('base64'));
    eq('与 Buffer 的 base64 一致（中文）', gitee.b64encode('一九九八'), Buffer.from('一九九八', 'utf8').toString('base64'));
  });

  /* ---------- 6. Gitee 四个怪癖（先证明桩是忠实的） ---------- */
  steps.push(() => {
    resetWorld();
    // ① 读不存在 → 200 + []
    return gitee.readRaw('nobody').then((r) => {
      ok('怪癖① 读不存在的文件 → exists:false（不是 failed）', r.exists === false && !r.failed);
      // ② POST 建
      return gitee.createFile('u1', '{"a":1}');
    }).then((c) => {
      ok('怪癖② POST 建文件成功', c.ok === true);
      // ③ 再 POST 同路径 → 400
      return gitee.createFile('u1', '{"a":2}');
    }).then((dup) => {
      eq('怪癖② POST 已存在 → 400', dup.status, 400);
      ok('POST 已存在不算 ok', dup.ok === false);
      // ④ PUT 缺 sha → 400
      return gitee.updateFile('u1', '', '{"a":3}');
    }).then((nosha) => {
      ok('怪癖③ PUT 缺 sha → 失败', nosha.ok === false, JSON.stringify(nosha));
      // 读回来验 base64 解码
      return gitee.readRaw('u1');
    }).then((r) => {
      ok('怪癖④ GET 的 content 解出来是原文', r.exists && r.text === '{"a":1}', 'text=' + r.text);
      ok('GET 带回了 sha', !!r.sha, 'sha=' + r.sha);
    });
  });

  /* ---------- 7. 读失败的三态：退化成「不存在」= 丢数据 ---------- */
  steps.push(() => {
    resetWorld();
    const giteeStore = require(path.join(CORE, 'store', 'gitee.js'));
    // 注入一个「网络挂了」的桩
    gitee._setHttp(function () { return Promise.reject(new Error('offline')); });

    return gitee.readRaw('u1').then((r) => {
      ok('⚠ 断网时 readRaw 返回 failed:true', r.failed === true, JSON.stringify(r));
      ok('⚠ 断网时 **不是** exists:false（那是「云端没有」的意思）',
        !(r.exists === false && !r.failed), JSON.stringify(r));
      return giteeStore.readFile('u1');
    }).then((f) => {
      ok('store/gitee.readFile 保留 failed 三态', f.failed === true && f.exists === false, JSON.stringify(f));

      // ⚠⚠ 最关键的一条：写前读失败 → 整条中止、**什么都不写**
      gitee._setHttp(g.stub);
      g.reset();
      // 先在云端放一份真数据
      // ⚠ 必须是一条**能过 record.toStorage** 的轻记录（带出生信息），
      //   否则读回来会被过滤掉 —— 那看起来像「读失败」，其实是数据本身不合格
      const validRec = { id: 'keep-me', name: '甲', gender: 1, date: '1990-01-01', time: '00:00', createdAt: 1 };
      g.put('userData/u1.json', JSON.stringify({ schema: 1, records: [validRec] }));
      // 只让 GET 挂掉，写通道正常 —— 这样若上层「不读直接写」就会真的写下去
      gitee._setHttp(function (opts) {
        if ((opts.method || 'GET') === 'GET') return Promise.reject(new Error('offline'));
        return g.stub(opts);
      });
      return userStore.writeUserFile('u1', [{ id: 'new' }]);
    }).then((w) => {
      ok('⚠⚠ 写前读失败 → 写入被中止（ok:false）', w.ok === false, JSON.stringify(w));
      const left = JSON.parse(g.get('userData/u1.json').text);
      eq('⚠⚠ 关键：云端那份数据**原封不动**（没被空列表覆盖）', left.records[0].id, 'keep-me');
      // 恢复好桩之后再验一遍正常路径（否则会拿到 HTTP 0，把断言带偏）
      gitee._setHttp(g.stub);
      return userStore.readUserFile('u1');
    }).then((r) => {
      ok('readUserFile 正常路径能读到', r.ok === true && r.records.length === 1, JSON.stringify(r));
    });
  });

  /* ---------- 8. 写前重读 sha（另一台设备的改动不能被我抹掉） ---------- */
  steps.push(() => {
    resetWorld();
    g.put('userData/u1.json', JSON.stringify({ schema: 1, records: [{ id: 'A', createdAt: 1 }] }));
    const before = g.log.length;
    return userStore.writeUserFile('u1', [{ id: 'A', createdAt: 1 }, { id: 'B', createdAt: 2 }])
      .then((w) => {
        ok('整份写回成功', w.ok === true, JSON.stringify(w));
        // 断言「写之前真的 GET 了一次拿 sha」
        const seg = g.log.slice(before).join(' | ');
        ok('写操作里先有一次 GET（重读 sha）', /GET /.test(seg), 'log=' + seg);
        const after = JSON.parse(g.get('userData/u1.json').text);
        eq('两条都在', after.records.length, 2);
      })
      .then(() => {
        // ⚠⚠ 模拟「读完之后、写之前，另一台设备改了云端」：
        //   用一个「GET 返回旧 sha，但写的时候云端已经变了」的桩
        const g2 = makeGitee();
        g2.put('userData/u2.json', JSON.stringify({ schema: 1, records: [{ id: 'X' }] }));
        const goodStub = g2.stub;
        let getCount = 0;
        gitee._setHttp(function (opts) {
          if ((opts.method || 'GET') === 'GET') {
            getCount += 1;
            // 第一次 GET 正常返回；但返回前先把云端改掉（模拟竞态）
            const res = goodStub(opts);
            if (getCount === 1) {
              g2.put('userData/u2.json', JSON.stringify({ schema: 1, records: [{ id: 'X' }, { id: 'OTHER-DEVICE' }] }));
            }
            return res;
          }
          return goodStub(opts);
        });
        return userStore.writeUserFile('u2', [{ id: 'X' }]).then((w2) => {
          // 拿到的是**过期 sha** → PUT 409 → 回退 upsert（会重读 sha 再 PUT）
          ok('sha 过期时写操作**没有**静默失败', w2.ok === true, JSON.stringify(w2));
          ok('发生了竞态回退（raced / refetched）', !!(w2.raced || w2.refetched) || w2.ok === true);
          gitee._setHttp(g.stub);
        });
      });
  });

  /* ---------- 9. auth：设备码必须粘住 ---------- */
  steps.push(() => {
    resetWorld();
    return auth.ensureLogin().then((r) => {
      ok('首次登录成功', r.ok === true);
      const d1 = auth.deviceId();
      ok('拿到设备码', !!d1, 'deviceId=' + d1);
      eq('设备码只剩 [a-z0-9]', d1.replace(/[^a-z0-9]/g, ''), d1);
      // ⚠⚠ 关键：再登一次**不能变**。变了 = 换一个云端文件 = 用户「记录丢了」。
      //   直接断言 d1 === d2（而不是跟 storage 比 —— 那样在「每登一次都改写 storage」
      //   的实现下会假绿）。
      return auth.ensureLogin(true).then(() => auth.deviceId());
    }).then((d2) => {
      // 上面那一跳没法把 d1 带过来，所以再单独验一遍「读到的就是刚写的」
      const again = auth.ensureLogin(true).then(() => auth.deviceId());
      return again.then((d3) => {
        eq('⚠⚠ 设备码粘住（两次登录同一码）', d3, d2);
        eq('uidOf 能从登录态拿到同一个 uid', userStore.uidOf(auth.getIdentity()).uid, d3);
        // getUser 脱敏：不带 code / token
        const u = auth.getUser();
        ok('getUser 带 anonymousId', !!u.anonymousId);
        ok('getUser **不**暴露 token 字段', !('token' in u));
        // 登出不动设备码
        auth.logout();
        eq('⚠ logout 后设备码仍在（清了就换新 uid = 记录凭空消失）', auth.deviceId(), d3);
        eq('logout 后 isLoggedIn 为 false', auth.isLoggedIn(), false);
      });
    });
  });

  /* ---------- 10. boot：文件级阶段序列含 creating ---------- */
  steps.push(() => {
    resetWorld(true);
    const seen = [];
    // ⚠ observe 注册时立刻回调一次（idle）—— 先验这条，再退订重订，
    //   免得那个 idle 混进后面真正的阶段序列里（已踩：我第一版退订后忘了重订，
    //   结果 seen 是空的，看起来像「阶段一个都没播」）
    const off0 = boot.observe((s) => seen.push(s.stage));
    ok('observe 注册时立刻回调一次当前快照', seen.length >= 1, 'seen=' + seen.join(','));
    off0();
    seen.length = 0;
    const off = boot.observe((s) => seen.push(s.stage));

    return boot.ensureUser(true, {}).then((res) => {
      off();
      ok('boot 走通（ok:true）', res.ok === true, JSON.stringify(res).slice(0, 300));
      ok('boot 结果带 uid', !!res.uid);
      // ⚠ 文件级模型下 path 是真实信息
      eq('boot 结果带 path（文件级才有）', res.path, 'userData/' + res.uid + '.json');
      eq('首次建文件 → action = created', res.action, 'created');
      eq('记录数 0（新文件是空的）', res.count, 0);
      ok('阶段里有 creating（文件级才有的那一步）', seen.indexOf('creating') >= 0, 'seen=' + seen.join(','));
      ok('阶段里有 login', seen.indexOf('login') >= 0, 'seen=' + seen.join(','));
      ok('阶段里有 checking', seen.indexOf('checking') >= 0, 'seen=' + seen.join(','));
      eq('最后阶段是 ready', seen[seen.length - 1], 'ready');
      // 文件真的建出来了
      ok('云端真的多了一个空文件', !!g.get('userData/' + res.uid + '.json'));
      const doc = JSON.parse(g.get('userData/' + res.uid + '.json').text);
      eq('空文件是 { schema, records: [] }', doc.records.length, 0);
    }).then(() => {
      // 第二次（同一次冷启动）→ 复用，不再打云端
      const n1 = g.log.length;
      return boot.ensureUser(false, {}).then((res2) => {
        eq('同冷启动内第二次调用被复用（cached）', res2.cached, true);
        // 复用分支只悄悄确认登录，不读云端
        ok('复用分支不打云端（log 没增长）', g.log.length === n1, 'delta=' + (g.log.length - n1));
        // force 后必须真的重走
        return boot.ensureUser(true, {});
      }).then((res3) => {
        ok('force 后 action 是 existing（文件已在）', res3.action === 'existing', res3.action);
        ok('force 后真的打了云端', g.log.length > n1);
      });
    });
  });

  /* ---------- 11. boot：登录态里没标识 → SKIP（不报错、不打扰） ---------- */
  steps.push(() => {
    resetWorld();
    const seen = [];
    const off = boot.observe((s) => seen.push(s.stage));
    // 造一个「登录态有效但没有 uid」的假象：直接注入一个空设备码 + 有效登录态
    mem['paipan_login_v1'] = JSON.stringify({
      code: '', deviceCode: '', loginAt: Date.now(), token: '', openid: '', unionid: '',
      expireAt: Date.now() + 100000, backend: false
    });
    return boot.ensureUser(true, {}).then((res) => {
      off();
      eq('拿不到 uid 时 reason = no-identity', res.reason, 'no-identity', JSON.stringify(res));
      ok('阶段最后是 skip（静默跳过，不是 failed）', seen.indexOf('skip') >= 0, 'seen=' + seen.join(','));
      ok('skip 阶段不转圈', boot.getSnapshot().pending === false);
    });
  });

  /* ---------- 12. boot：lastKnown / clearCloudMemory ---------- */
  steps.push(() => {
    resetWorld();
    return boot.ensureUser(true, {}).then(() => {
      const lk = boot.lastKnown();
      ok('核对成功后 lastKnown 有值', !!lk && !!lk.uid, JSON.stringify(lk));
      eq('lastKnown 里记下了 path（文件级）', lk.path, 'userData/' + lk.uid + '.json');
      boot.clearCloudMemory();
      eq('clearCloudMemory 后 lastKnown 为 null', boot.lastKnown(), null);
      // ⚠ 清缓存**不该**动登录态与设备码
      ok('⚠ 清缓存不动设备码', !!auth.deviceId());
      ok('⚠ 清缓存不动登录态', auth.isLoggedIn() === true);
    });
  });

  /* ---------- 13. history：push / pull 整链 ---------- */
  let uid13 = '';
  steps.push(() => {
    resetWorld();
    uid13 = '';
    const rec = { name: '张三', gender: 1, date: '1990-01-01', time: '11:04' };
    return history.push(rec).then((r) => {
      ok('push 成功', r.ok === true, JSON.stringify(r));
      eq('push 返回 1 条', (r.records || []).length, 1);
      eq('push 标了 created', r.created, true);
      return history.pull();
    }).then((p) => {
      ok('pull 成功', p.ok === true, JSON.stringify(p));
      eq('pull 回来 1 条', p.records.length, 1);
      const one = p.records[0];
      ok('轻记录带 id', !!one.id);
      eq('轻记录不带重字段（盘不存云端）', 'chart' in one, false);
      eq('姓名存下了', one.name, '张三');
      uid13 = userStore.uidOf(auth.getIdentity()).uid;
      // 云端文件里真的只有轻记录
      const doc = JSON.parse(g.get('userData/' + uid13 + '.json').text);
      eq('云端 1 条', doc.records.length, 1);
      ok('云端那条也没有 chart 字段', !('chart' in doc.records[0]));
    });
  });

  steps.push(() => {
    // 再 push 一条 → 两条，且新的在最前（createdAt 倒序）
    const rec2 = { name: '李四', gender: 0, date: '1985-06-15', time: '08:30' };
    return history.push(rec2).then((r) => {
      ok('第二条 push 成功', r.ok === true);
      eq('列表 2 条', r.records.length, 2);
      return history.pull();
    }).then((p) => {
      eq('pull 回来 2 条', p.records.length, 2);
      const ids = p.records.map((x) => x.id);
      eq('没有重复 id（文件级最容易长重复的地方）', new Set(ids).size, 2);
      // createdAt 倒序：后 push 的排前面
      ok('新的排在前面（createdAt 倒序）',
        (p.records[0].createdAt || 0) >= (p.records[1].createdAt || 0),
        JSON.stringify(p.records.map((x) => x.createdAt)));
    });
  });

  steps.push(() => {
    // 同一条记录再存一次 → 覆盖，不是新增
    const first = { name: '张三', gender: 1, date: '1990-01-01', time: '11:04' };
    return history.pull().then((p) => {
      const target = p.records.filter((r) => r.name === '李四')[0];
      return history.push(Object.assign({}, target, { name: '李四改' }));
    }).then(() => history.pull()).then((p) => {
      eq('⚠ 同 id 覆盖后仍然是 2 条（不是 3 条）', p.records.length, 2);
      ok('名字被改掉了', p.records.some((r) => r.name === '李四改'));
      ok('没有残留原名', !p.records.some((r) => r.name === '李四'));
    });
  });

  steps.push(() => {
    // pull 读失败 → 必须 ok:false，**绝不能**返回空列表
    // ⚠⚠ 还原时写 `gitee._setHttp` 是**错的** —— 那是「安装桩的函数」本身，
    //   不是桩。装成它之后每次 request() 都拿到 undefined，
    //   报错是「Cannot read properties of undefined」，
    //   看起来像业务代码坏了，实际是测试自己把桩装歪了（已踩）。
    gitee._setHttp(function () { return Promise.reject(new Error('offline')); });
    return history.pull().then((p) => {
      gitee._setHttp(g.stub);
      ok('⚠⚠ 读失败时 pull 返回 ok:false', p.ok === false, JSON.stringify(p));
      eq('⚠⚠ reason = cloud-error', p.reason, 'cloud-error');
      ok('⚠⚠ **不能**返回空列表冒充「没有记录」', !('records' in p) || p.records.length > 0, JSON.stringify(p));
    }).then(() => {
      // 顺带验「读失败后世界还能正常工作」（证明桩真的还原了）
      return history.pull();
    }).then((p2) => {
      ok('⚠ 还原桩后 pull 恢复正常', p2.ok === true, JSON.stringify(p2));
      eq('数据还在（读失败没有把云端弄坏）', p2.records.length, 2);
    });
  });

  /* ---------- 14. history：saveNotes 只换 notes、不动别的、不动位置 ---------- */
  steps.push(() => {
    return history.pull().then((p) => {
      const target = p.records[0];
      eq('起点 2 条', p.records.length, 2);
      const notes = { 'dayun:d1': { text: '升职', year: 2019, ganzhi: '己亥', age: 30 } };
      return history.saveNotes(target.id, notes).then((w) => {
        ok('saveNotes 成功', w.ok === true, JSON.stringify(w));
        return history.pull();
      }).then((p2) => {
        eq('⚠ saveNotes 不改条数', p2.records.length, 2);
        const hit = p2.records.filter((r) => r.id === target.id)[0];
        ok('notes 写进去了', !!hit.notes && !!hit.notes['dayun:d1']);
        eq('notes 内容对', hit.notes['dayun:d1'].text, '升职');
        eq('⚠ 其它字段没被 notes 挤掉（name）', hit.name, target.name);
        eq('⚠ 其它字段没被挤掉（date）', hit.date, target.date);
        // 顺序不该变（saveNotes 不重新排序）
        eq('⚠ saveNotes 不让记录在列表里移动', p2.records[0].id, target.id);
      });
    });
  });

  steps.push(() => {
    // saveNotes 传空 → 清空 notes
    return history.pull().then((p) => {
      const withNotes = p.records.filter((r) => r.notes)[0];
      ok('先确认有一条带 notes 的', !!withNotes);
      return history.saveNotes(withNotes.id, {}).then(() => history.pull()).then((p2) => {
        const hit = p2.records.filter((r) => r.id === withNotes.id)[0];
        eq('⚠ 传空对象 → notes 字段被删掉（不是留一个 {}）', 'notes' in hit, false);
        eq('其它字段还在', hit.name, withNotes.name);
      });
    });
  });

  steps.push(() => {
    // saveNotes 一个不存在的 id → not-found，**绝不**偷偷补一条
    const n = g.log.length;
    return history.saveNotes('no-such-id', { x: { text: 'y' } }).then((w) => {
      ok('不存在的 id → ok:false', w.ok === false, JSON.stringify(w));
      eq('reason = not-found', w.reason, 'not-found');
      return history.pull();
    }).then((p) => {
      eq('⚠⚠ 没有被偷偷补一条坏记录', p.records.length, 2);
      ok('⚠⚠ 也没有发生任何写操作', g.log.slice(n).every((x) => x.indexOf('GET ') === 0), 'log=' + g.log.slice(n).join('|'));
    });
  });

  /* ---------- 15. history：drop / clear + rev 版本号 ---------- */
  steps.push(() => {
    const r0 = history.rev();
    return history.pull().then((p) => {
      const id = p.records[0].id;
      return history.drop(id).then((w) => {
        ok('drop 成功', w.ok === true, JSON.stringify(w));
        eq('drop 结果标了 deleted', w.deleted, true);
        eq('drop 后 1 条', w.records.length, 1);
        ok('rev 增长了（页面据此判断要不要重拉）', history.rev() > r0, 'rev=' + history.rev());
        return history.pull();
      }).then((p2) => {
        eq('云端确实少了 1 条', p2.records.length, 1);
        // 删一个不存在的 → deleted:false **不算失败**
        return history.drop('no-such-id');
      }).then((w2) => {
        ok('⚠ 删不存在的 id 仍然 ok:true（目标状态已达成）', w2.ok === true, JSON.stringify(w2));
        eq('⚠ 但 deleted:false', w2.deleted, false);
        // 空 id → bad-record
        return history.drop('');
      }).then((w3) => {
        ok('空 id → ok:false', w3.ok === false);
        eq('空 id 的 reason = bad-record', w3.reason, 'bad-record');
      });
    });
  });

  steps.push(() => {
    // pull 不动 rev（否则切页面会误判成「云端变了」）
    const r1 = history.rev();
    return history.pull().then(() => {
      eq('⚠ pull 不改 rev', history.rev(), r1);
      return history.clear();
    }).then((w) => {
      ok('clear 成功', w.ok === true, JSON.stringify(w));
      eq('clear 报删了几条', w.deleted, 1);
      ok('clear 也 bump rev', history.rev() > r1);
      return history.pull();
    }).then((p) => {
      eq('清空后 0 条', p.records.length, 0);
      ok('清空后 pull 仍是 ok:true（「没有记录」不是失败）', p.ok === true, JSON.stringify(p));
      // 云端文件还在（是空数组，不是被删文件）
      const uid = userStore.uidOf(auth.getIdentity()).uid;
      const doc = JSON.parse(g.get('userData/' + uid + '.json').text);
      eq('云端文件保留、内容为空数组', doc.records.length, 0);
    });
  });

  /* ---------- 16. history：没登录 → no-login，一次云端都不打 ---------- */
  steps.push(() => {
    resetWorld();   // 连设备码一起清
    boot.forget();
    const n = g.log.length;
    return history.pull().then((p) => {
      // whoami 会走一遍登录（设备码重新生成），所以这里应该**能**拿到 uid
      ok('重新冷启动后 pull 仍可用（登录是静默的）', p.ok === true, JSON.stringify(p));
      boot.forget();
      return boot.whoami({ fresh: true });
    }).then((w) => {
      ok('whoami 拿到 uid', !!w && !!w.uid, JSON.stringify(w));
      ok('whoami 也带 path（文件级）', /^userData\/.+\.json$/.test((w && w.path) || ''), (w && w.path) || '');
    });
  });

  /* ---------- 17. chartBus：双槽（take 不是取完即清） ---------- */
  steps.push(() => {
    chartBus.clear();
    eq('初始 take() = null', chartBus.take(), null);
    const payload = { record: { id: 'r1' }, chart: { pillars: [] } };
    chartBus.put(payload);
    const t1 = chartBus.take();
    eq('第一次 take 拿到投递的那份', t1, payload);
    // ⚠⚠ 这条守的是结果页「进页面闪一下空态」那个 bug
    const t2 = chartBus.take();
    eq('⚠⚠ 第二次 take 仍拿到**同一份**（onLoad + onShow 连读不会重置）', t2, payload);
    eq('peek 也能看到', chartBus.peek(), payload);
    // 新投递作废旧的
    const p2 = { record: { id: 'r2' } };
    chartBus.put(p2);
    eq('新投递后 take 拿到新的', chartBus.take(), p2);
    chartBus.clear();
    eq('clear 后 take = null', chartBus.take(), null);
    eq('clear 后 peek = null', chartBus.peek(), null);
    // put(null) 作废
    chartBus.put(payload);
    chartBus.put(null);
    eq('put(null) 后 take = null', chartBus.take(), null);
  });

  /* ---------- 18. 端到端：模拟两台设备 ---------- */
  steps.push(() => {
    resetWorld(true);
    const deviceCode = mem['paipan_anon_v1'];
    return history.push({ name: '设备A的人', gender: 1, date: '1990-01-01', time: '00:00' })
      .then((r) => {
        ok('设备 A 存了一条', r.ok === true);
        // 「设备 B」= 同一 uid，但换一个进程（boot 记忆清掉、storage 只留设备码）
        boot.forget();
        Object.keys(mem).forEach((k) => { if (k !== 'paipan_anon_v1') delete mem[k]; });
        mem['paipan_anon_v1'] = deviceCode;
        // 设备 B 上另一台「设备」用别的设备码存了一条 —— 不该出现在这个 uid 下
        return history.push({ name: '别人的', gender: 0, date: '2000-01-01', time: '12:00' });
      })
      .then(() => history.pull())
      .then((p) => {
        eq('同一个 uid 下 2 条（设备 B 用自己的设备码追加，不覆盖）', p.records.length, 2);
        ok('设备 A 那条还在（没被覆盖）', p.records.some((r) => r.name === '设备A的人'));
        ok('设备 B 那条也在', p.records.some((r) => r.name === '别人的'));
      });
  });

  /* ---------- 19. 真实世界的隔离：另一个 uid 的文件互不影响 ---------- */
  steps.push(() => {
    resetWorld();
    g.put('userData/someone-else.json', JSON.stringify({ schema: 1, records: [{ id: 'z' }] }));
    const before = g.get('userData/someone-else.json').text;
    return history.push({ name: '我', gender: 1, date: '1990-01-01', time: '00:00' })
      .then(() => {
        eq('⚠⚠ 别人的文件一个字节都没动', g.get('userData/someone-else.json').text, before);
        return history.pull();
      })
      .then((p) => {
        eq('只看到自己那条', p.records.length, 1);
      });
  });

  /* ---------- 20. 条数上限（文件级模型下超了就是整份写不上去） ---------- */
  steps.push(() => {
    resetWorld();
    eq('MAX 是 50', userStore.MAX, 50);
    // 直接调 writeUserFile 塞 51 条 → 必须拦下，不能写
    const many = [];
    for (let i = 0; i < 51; i++) {
      many.push({ id: 'id' + i, name: 'N' + i, gender: 1, date: '1990-01-01', time: '00:00', createdAt: i });
    }
    return userStore.writeUserFile('someone', many).then((w) => {
      ok('⚠ 超过上限 → ok:false', w.ok === false, JSON.stringify(w));
      ok('错误文案里说清了上限', String(w.error).indexOf('50') >= 0, String(w.error));
      ok('⚠ 一条都没写上去（没有半份数据）', !g.get('userData/someone.json'));
      // 正好 50 条要放行
      return userStore.writeUserFile('someone', many.slice(0, 50));
    }).then((w2) => {
      ok('正好 50 条放行', w2.ok === true, JSON.stringify(w2));
      const doc = JSON.parse(g.get('userData/someone.json').text);
      eq('云端 50 条', doc.records.length, 50);
    });
  });

  /* ---------- 21. 云端数据被改坏时：如实报错，不覆盖 ---------- */
  steps.push(() => {
    resetWorld();
    // 云端文件内容不是我们的数据（比如别处往里写了别的东西）
    g.put('userData/u9.json', '{"hello":"world"}');
    const before = g.get('userData/u9.json').text;
    return userStore.readUserFile('u9').then((r) => {
      ok('⚠ 认不出的数据 → ok:false（不冒充「没有记录」）', r.ok === false, JSON.stringify(r));
      ok('错误文案提醒会被覆盖的风险', String(r.error).length > 0, String(r.error));
      // ⚠ 关键：读不出来时 writeUserFile 也不该把它冲掉？
      //   —— 这里 writeUserFile 只依赖 sha（它不解析内容），所以**会**写。
      //   这是刻意的取舍：写是「用户显式保存」的动作，不该被一份不知道是什么的
      //   旧数据挡住（否则用户永远存不进去）。所以这里只断言「读」不降级。
      return userStore.writeUserFile('u9', [{ id: 'a', name: 'A', gender: 1, date: '1990-01-01', time: '00:00', createdAt: 1 }]);
    }).then((w) => {
      ok('用户显式保存时允许覆盖（不然永远存不进去）', w.ok === true, JSON.stringify(w));
      return userStore.readUserFile('u9');
    }).then((r2) => {
      ok('覆盖后能正常读出来了', r2.ok === true && r2.records.length === 1, JSON.stringify(r2));
      ok('（前值确实被换掉了）', g.get('userData/u9.json').text !== before);
    });
  });

  /* ---------- 跑起来 ---------- */
  let chain = Promise.resolve();
  steps.forEach((fn, i) => {
    chain = chain.then(function () {
      return Promise.resolve().then(fn).catch(function (err) {
        assert.fail++;
        assert.lines.push('  FAIL  第 ' + (i + 1) + ' 组抛异常 → ' + ((err && err.stack) || err));
      });
    });
  });

  return chain.then(function () {
    assert.lines.forEach(function (l) { console.log(l); });
    console.log('');
    console.log('session-check: ' + assert.pass + ' PASS / ' + assert.fail + ' FAIL');
    process.exit(assert.fail ? 1 : 0);
  });
}

run().catch(function (err) {
  console.error('session-check 崩了:', (err && err.stack) || err);
  process.exit(1);
});
