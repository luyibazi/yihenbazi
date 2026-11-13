#!/usr/bin/env node
/* tests/gitee-check.js —— Gitee 驱动的契约测试
 *
 * 为什么需要它：Gitee 原版代码**已经被物理删除了**（README 明确写了
 * 「utils/store/gitee.js 已随本次重构彻底删除」），全盘也没有可对拍的旧实现。
 * 所以这次是**按契约重写**，契约测试就是唯一的「参照实现」。
 *
 * ⚠ 桩必须**刻意复刻 Gitee 的那些怪癖**（不存在返回 200+[]、POST 已存在返回 400、
 *   PUT 缺 sha 返回 400），否则那些反直觉分支没有任何东西守着，改坏了也测不出来。
 *
 * ⚠ 桩只停在 **HTTP 边界**（调用协议 + 它脚下的「仓库」），
 *   业务语义由 gitee.js 本体决定 —— 不要在桩里重实现业务逻辑。
 *
 * 跑法：node tools/run.js tests/gitee-check.js
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const gitee = require(path.join(ROOT, 'src/core/gitee.js'));
const storeGitee = require(path.join(ROOT, 'src/core/store/gitee.js'));
const storeMode = require(path.join(ROOT, 'src/core/storeMode.js'));
const store = require(path.join(ROOT, 'src/core/store/index.js'));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  →  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

/* ─────────────────────────────────────────────────────────────
 * 内存版「Gitee 仓库」桩 —— 复刻真实 API 的行为（含怪癖）
 * ───────────────────────────────────────────────────────────── */
function makeRepo() {
  const files = new Map();          // path → { text, sha }
  let shaSeq = 0;
  const log = [];

  function nextSha() { shaSeq += 1; return 'sha' + shaSeq + 'x'.repeat(12); }

  /** 返回一个 http 桩：入参形状与 tt.request / fetch 封装一致 */
  function http(opts) {
    const url = String(opts.url || '');
    const body = opts.data || {};
    // 从 URL 里抠出 path（.../contents/<path>?access_token=...）
    const m = url.match(/\/contents\/([^?]+)/);
    const p = m ? decodeURIComponent(m[1]) : '';
    const method = (opts.method || 'GET').toUpperCase();
    log.push(method + ' ' + p);

    // ---- GET ----
    if (method === 'GET') {
      if (!files.has(p)) {
        // ⚠ 怪癖①：不存在的文件返回 200 + `[]`（不是 404）
        return Promise.resolve({ statusCode: 200, data: [] });
      }
      const f = files.get(p);
      // ⚠ 怪癖③：GET 的 content 是 base64 **字符串**
      return Promise.resolve({
        statusCode: 200,
        data: { content: gitee.b64encode(f.text), sha: f.sha, path: p }
      });
    }

    // ---- POST（创建）----
    if (method === 'POST') {
      if (!body.content) {
        return Promise.resolve({ statusCode: 400, data: { message: 'content is empty' } });
      }
      if (files.has(p)) {
        // ⚠ 怪癖②：已存在 → 400「文件名已存在」（并发竞态，不是错误）
        return Promise.resolve({ statusCode: 400, data: { message: '文件名已存在' } });
      }
      const sha = nextSha();
      files.set(p, { text: gitee.b64decode(body.content), sha: sha });
      // ⚠ 怪癖③：POST/PUT 的 content 是**文件元信息对象**
      return Promise.resolve({ statusCode: 201, data: { content: { sha: sha, path: p } } });
    }

    // ---- PUT（更新）----
    if (method === 'PUT') {
      if (!files.has(p)) {
        return Promise.resolve({ statusCode: 404, data: { message: 'Not Found' } });
      }
      if (!body.sha) {
        // ⚠ 怪癖④：缺 sha → 400（Gitee 的 PUT 必须带 sha，不是 upsert）
        return Promise.resolve({ statusCode: 400, data: { message: 'sha is missing' } });
      }
      if (body.sha !== files.get(p).sha) {
        return Promise.resolve({ statusCode: 409, data: { message: 'sha does not match' } });
      }
      const sha = nextSha();
      files.set(p, { text: gitee.b64decode(body.content), sha: sha });
      return Promise.resolve({ statusCode: 200, data: { content: { sha: sha, path: p } } });
    }

    return Promise.resolve({ statusCode: 405, data: { message: 'method not allowed' } });
  }

  /** 让下一次请求失败（模拟断网）—— 测「读失败绝不退化成不存在」用 */
  let failNext = 0;
  function httpWithFailure(opts) {
    if (failNext > 0) {
      failNext -= 1;
      return Promise.resolve({ statusCode: 0, data: null, error: 'network down' });
    }
    return http(opts);
  }

  return {
    http: httpWithFailure,
    files: files,
    log: log,
    /** 直接往「云端」塞一份内容（模拟另一台设备写的） */
    seed: function (p, text) { const sha = nextSha(); files.set(p, { text: text, sha: sha }); return sha; },
    shaOf: function (p) { return files.has(p) ? files.get(p).sha : null; },
    textOf: function (p) { return files.has(p) ? files.get(p).text : null; },
    makeNextRequestFail: function (n) { failNext = n || 1; },
    reset: function () { files.clear(); log.length = 0; failNext = 0; }
  };
}

const repo = makeRepo();
gitee._setHttp(repo.http);

/* ───────────────────────────────────────────────────────────── */
async function main() {
  console.log('\n=== Gitee 驱动契约测试 ===\n');

  /* ============ 第 1 组：UTF-8 感知的 base64 ============ */
  console.log('--- base64（UTF-8 感知）---');

  ok(gitee.b64encode('abc') === 'YWJj', 'encode("abc") === "YWJj"（对照标准值）',
    gitee.b64encode('abc'));
  ok(gitee.b64decode('YWJj') === 'abc', 'decode("YWJj") === "abc"');

  // ⚠ 中文：直接对 charCode 做 base64 会编错 —— 这条专治那个错法
  const zh = '一九九八年十二月';
  ok(gitee.b64decode(gitee.b64encode(zh)) === zh, '中文往返一致', zh);
  ok(gitee.b64encode(zh) === '5LiA5Lmd5Lmd5YWr5bm05Y2B5LqM5pyI', '中文编码是标准 UTF-8 base64（不是 charCode）',
    gitee.b64encode(zh));

  const emoji = '命理 🀄 排盘';
  ok(gitee.b64decode(gitee.b64encode(emoji)) === emoji, 'emoji（代理对）往返一致', emoji);

  ok(gitee.b64decode(gitee.b64encode('')) === '', '空串往返为空');
  ok(gitee.b64decode(gitee.b64encode('a')) === 'a', '1 字节边界', 'a');
  ok(gitee.b64decode(gitee.b64encode('ab')) === 'ab', '2 字节边界', 'ab');
  ok(gitee.b64decode(gitee.b64encode('abc')) === 'abc', '3 字节边界', 'abc');
  ok(gitee.b64decode(gitee.b64encode('{"records":[]}')) === '{"records":[]}',
    'JSON 文本往返（真实载荷形状）');
  ok(gitee.b64decode(gitee.b64encode('行1\n行2\ttab')) === '行1\n行2\ttab', '换行 / tab 往返');

  /* ============ 第 2 组：路径白名单（防穿越） ============ */
  console.log('\n--- 路径白名单 ---');

  ok(gitee.safeUid('abc123_-') === 'abc123_-', '合法字符原样保留', 'abc123_-');
  ok(gitee.safeUid('../../../etc/passwd') === 'etcpasswd',
    '路径穿越被白名单清掉（只剩字母数字）', gitee.safeUid('../../../etc/passwd'));
  ok(gitee.safeUid('a/b\\c d') === 'abcd', '斜杠 / 空格 / 反斜杠都被清掉', gitee.safeUid('a/b\\c d'));
  ok(gitee.pathOf('abc') === 'userData/abc.json', 'pathOf 形状正确', gitee.pathOf('abc'));

  // ⚠ 空 uid 绝不能出路径（否则所有空 uid 用户共用一个文件）
  ok(gitee.pathOf('') === '', '空 uid → 空路径', JSON.stringify(gitee.pathOf('')));
  ok(gitee.pathOf('///') === '', '全非法 uid → 空路径', JSON.stringify(gitee.pathOf('///')));
  ok(gitee.pathOf(null) === '', 'null uid → 空路径');
  ok(gitee.pathOf(undefined) === '', 'undefined uid → 空路径');

  /* ============ 第 3 组：contents 接口的四个怪癖 ============ */
  console.log('\n--- Gitee contents 接口怪癖 ---');
  repo.reset();

  // 怪癖①：读不存在的文件 = 200 + []
  const r1 = await gitee.readRaw('nobody');
  ok(r1.exists === false && !r1.failed,
    '【怪癖①】读不存在的文件 → exists:false（不是靠 404 判）',
    JSON.stringify(r1));

  // 创建
  const c1 = await gitee.createFile('u1', '{"records":[]}');
  ok(c1.ok === true && !!c1.sha, '【创建】POST 成功并返回 sha', c1.sha);

  // 怪癖③：读回来 content 是 base64 字符串，且能正确解出中文
  repo.seed('userData/u2.json', '{"n":"张三"}');
  const r2 = await gitee.readRaw('u2');
  ok(r2.exists === true && r2.text === '{"n":"张三"}',
    '【怪癖③】GET 回来能正确解出中文（说明按 base64 字符串解的）', r2.text);

  // 怪癖②：POST 已存在的文件 → 400
  const c2 = await gitee.createFile('u2', 'x');
  ok(c2.ok === false && c2.status === 400, '【怪癖②】POST 已存在 → 400', 'status=' + c2.status);

  // 怪癖④：PUT 缺 sha → 400
  const u1 = await gitee.updateFile('u2', '', 'y');
  ok(u1.ok === false, '【怪癖④】PUT 缺 sha → 失败（Gitee 不是 upsert）', u1.error);

  /* ============ 第 4 组：upsert 的竞态回退 ============ */
  console.log('\n--- upsert 与并发竞态 ---');
  repo.reset();

  // 首次写 → 走 POST
  const w1 = await gitee.upsertFile('race', 'v1');
  ok(w1.ok === true, '首次 upsert → 创建成功', w1.sha);
  ok(repo.textOf('userData/race.json') === 'v1', '内容已落盘', repo.textOf('userData/race.json'));

  // 再次写 → 走 PUT（带 sha）
  const w2 = await gitee.upsertFile('race', 'v2');
  ok(w2.ok === true, '二次 upsert → 更新成功', w2.sha);
  ok(repo.textOf('userData/race.json') === 'v2', '内容被更新', repo.textOf('userData/race.json'));

  // ⭐ 竞态：模拟「读到不存在 → 正要 POST 时别人建好了」
  //   做法：让第一次 GET 说「不存在」，但 POST 时文件其实已存在
  repo.reset();
  const raceRepo = (function () {
    let getCount = 0;
    return function (opts) {
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'GET') {
        getCount += 1;
        if (getCount === 1) {
          // 第一次 GET：谎报不存在（模拟两台设备同时首次登录）
          return Promise.resolve({ statusCode: 200, data: [] });
        }
      }
      if (method === 'POST') {
        // 别人的 POST 已经赢了 → 我们这次的 POST 撞 400
        repo.seed('userData/race2.json', '{"by":"other"}');
        return Promise.resolve({ statusCode: 400, data: { message: '文件名已存在' } });
      }
      return repo.http(opts);
    };
  })();
  gitee._setHttp(raceRepo);
  const raced = await gitee.upsertFile('race2', '{"by":"me"}');
  ok(raced.ok === true, '⭐ 撞 400「已存在」后回退成 update，最终成功（不是报错）',
    'raced=' + raced.raced + ' sha=' + raced.sha);
  ok(repo.shaOf('userData/race2.json') !== null, '文件存在且已更新');

  gitee._setHttp(repo.http);

  /* ============ 第 5 组：三态返回（读失败绝不退化成不存在） ============ */
  console.log('\n--- 三态返回（生命线①）---');
  repo.reset();
  repo.seed('userData/u3.json', '{"records":[]}');

  const okRead = await storeGitee.readFile('u3');
  ok(okRead.exists === true && !!okRead.sha && okRead.text === '{"records":[]}',
    '态①：存在 → {exists:true, sha, text}');

  const noExist = await storeGitee.readFile('fresh');
  ok(noExist.exists === false && !noExist.failed,
    '态②：云端确实没有 → {exists:false}（可以放心创建）',
    JSON.stringify(noExist));

  repo.makeNextRequestFail(1);
  const failedRead = await storeGitee.readFile('u3');
  ok(failedRead.exists === false && failedRead.failed === true,
    '⭐ 态③：读失败 → {exists:false, failed:true}（**不是**裸的 exists:false）',
    JSON.stringify(failedRead));
  ok(!!failedRead.error, '失败态带回 error 文案', failedRead.error);

  /* ============ 第 6 组：读失败时写操作必须整条失败 ============ */
  console.log('\n--- 生命线③：读失败时绝不写 ---');
  repo.reset();
  repo.seed('userData/u4.json', '{"records":[{"id":"keep-me"}]}');
  const before = repo.textOf('userData/u4.json');
  repo.makeNextRequestFail(1);
  const wFail = await gitee.upsertFile('u4', '{"records":[]}');
  ok(wFail.ok === false, '读失败时 upsert 直接失败（不猜「那就新建」）',
    'status=' + wFail.status);
  ok(repo.textOf('userData/u4.json') === before,
    '⭐⭐ 云端内容**一个字都没被改**（没拿空数据覆盖）', repo.textOf('userData/u4.json'));

  /* ============ 第 7 组：storeMode 与派发层 ============ */
  console.log('\n--- storeMode / 派发层 ---');

  // ⚠ 本文件测的是 Gitee **文件级驱动**，所以显式把 MODE 置成 gitee ——
  //   不再依赖「默认值恰好是 gitee」（默认已切到 cloudbase，见 core/storeMode.js 文件头）。
  storeMode.MODE = 'gitee';
  ok(storeMode.MODE === 'gitee', '本组显式置 MODE = gitee', storeMode.MODE);
  ok(storeMode.isFileLevel() === true, 'isFileLevel() = true（文件级模型）');
  ok(store.name() === 'gitee', 'store.name() = gitee');
  ok(store.fileLevel() === true, 'store.fileLevel() = true');
  ok(typeof store.readFile === 'function', '文件级接口存在：readFile');
  ok(typeof store.writeFile === 'function', '文件级接口存在：writeFile');
  ok(typeof store.upsertFile === 'function', '文件级接口存在：upsertFile');

  // ⚠ assertUsableMode 必须读 module.exports.MODE（不能读模块内 const）
  storeMode.MODE = 'gitee';
  let threw = false;
  try { storeMode.assertUsableMode(); } catch (e) { threw = true; }
  ok(threw === false, "'gitee' 是合法值，不抛错");

  storeMode.MODE = 'cloud';
  threw = false;
  try { storeMode.assertUsableMode(); } catch (e) { threw = true; }
  ok(threw === false, "'cloud' 也是合法值（备用后端），不抛错");

  storeMode.MODE = 'gitee2';
  let errMsg = '';
  try { storeMode.assertUsableMode(); } catch (e) { errMsg = e.message; }
  ok(errMsg.indexOf('gitee2') >= 0,
    '⭐ 非法值如实抛错且报出那个值（防「以为在 A、其实写 B」）', errMsg.slice(0, 60) + '…');

  // ⚠ 这条最容易被写错：守卫读的是导出对象属性，不是模块内 const
  storeMode.MODE = 'gitee';  // 还原
  ok(storeMode.MODE === 'gitee', '还原 MODE = gitee');

  /* ============ 第 8 组：派发层能换驱动（测试接缝） ============ */
  console.log('\n--- 派发层切换驱动 ---');
  storeMode.MODE = 'cloud';
  ok(store.fileLevel() === false, "MODE='cloud' 时 fileLevel() = false");
  ok(store.name() === 'cloud', "MODE='cloud' 时 name() = cloud");
  storeMode.MODE = 'gitee';
  ok(store.fileLevel() === true, '切回 gitee 后 fileLevel() = true（现取，不是加载时定死）');

  /* ───────────────────────────────────────────────────────────── */
  console.log(`\n${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n[FATAL] 测试脚本崩了:', err && err.stack || err);
  process.exit(1);
});
