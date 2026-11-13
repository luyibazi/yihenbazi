#!/usr/bin/env node
/* tools/diagnose.js —— 真机连不上时的「体检 + 定位」工具
 *
 * 用法：node tools/diagnose.js [port]
 *
 * 它按「从服务端到手机」的顺序逐项检查，并明确指出**是哪一环断了**。
 * 设计原则：每一项都要给出「实测值」而不是「我认为」，
 *          最后打印一个结论 + 可操作的下一步。
 *
 * ⚠ 不能替用户做的事：检查手机端的 Wi-Fi / VPN / AP 隔离。
 *    所以最后一项会给出「用手机浏览器打开这个地址」的判据。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const PORT = Number(process.argv[2]) || 8081;
const ROOT = path.join(__dirname, '..');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok === true ? 'OK  ' : ok === false ? 'FAIL' : 'WARN';
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

function pickLanIP() {
  const skip = /virtual|vmware|vbox|hyper-v|loopback|bluetooth|teredo|tunnel/i;
  const cands = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      cands.push({ name, address: i.address });
    }
  }
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  cands.sort((a, b) => rank(a.address) - rank(b.address));
  return cands[0] || null;
}

function probe(host, port, urlPath, timeout = 15000, raw = false) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ ok: true, status: res.statusCode, len: buf.length, buf, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(3000);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  console.log('='.repeat(64));
  console.log('  八字排盘 App — 真机联调体检');
  console.log('='.repeat(64));

  /* ---------- 1. Node 版本 ----------
   * ⚠ 只读 process.versions.node，**绝不 spawn 去探测别的 node**（必 EBUSY）。
   *   想知道「另一个 node 是多少」，只能由外层 shell 拿那个 exe 跑它。
   */
  const nv = process.versions.node.split('.').map(Number);
  const nodeOk = nv[0] > 20 || (nv[0] === 20 && (nv[1] > 19 || (nv[1] === 19 && nv[2] >= 4)));
  record('Node 版本', nodeOk, `v${process.versions.node}${nodeOk ? '' : '（需 >= 20.19.4）'}`);
  console.log(`       当前解释器：${process.execPath}`);

  // 顺带报告 .node-path 指向哪里（tools/run.js 的第一优先级来源）
  try {
    const line = fs.readFileSync(path.join(ROOT, '.node-path'), 'utf8').split(/\r?\n/)[0].trim();
    const exists = line && fs.existsSync(line);
    record('.node-path 配置', exists, exists ? line : (line ? `指向的文件不存在：${line}` : '未设置（npm run setup:node 可生成）'));
  } catch {
    record('.node-path 配置', null, '未设置 —— npm run setup:node 可生成（不设置也能跑，有硬编码兜底）');
  }

  /* ---------- 2. 网络接口 ---------- */
  const lan = pickLanIP();
  record('局域网网卡', !!lan, lan ? `${lan.name} → ${lan.address}` : '没找到可用网卡');
  if (!lan) { finish(); return; }

  /* ---------- 3. Metro 是否在监听 ---------- */
  const listening = await isPortListening(PORT);
  record(`Metro 监听 ${PORT}`, listening, listening ? '本地可连接' : '端口没在监听 —— 先运行 npm start');

  /* ---------- 4. 服务是否可达（本机视角）---------- */
  const status = await probe(lan.address, PORT, '/status');
  record('本机经局域网 IP 访问', status.ok && status.status === 200,
    status.ok ? `HTTP ${status.status}` : status.error);

  /* ---------- 5. Expo 登录态 ---------- */
  // ⚠ Expo Go 客户端要求「已登录」才能打开项目，否则报：
  //     You need to be signed in to Expo Go and Expo CLI to open your project.
  //   登录态存在 ~/.expo/state.json 的 auth 字段里（只有 uuid = 没登录）。
  {
    const p = path.join(os.homedir(), '.expo', 'state.json');
    let loggedIn = null;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      loggedIn = !!(j && j.auth && (j.auth.sessionSecret || j.auth.accessToken || j.auth.username));
    } catch { /* 没有文件 = 没登录 */ loggedIn = false; }
    record('Expo 登录态', loggedIn,
      loggedIn === true ? '已登录'
        : '未登录 —— 手机扫码会报 "You need to be signed in to Expo Go"。'
          + '修复：npm run login:browser（或 npm run login）');
  }

  /* ---------- 6. manifest 是否正常 ---------- */
  if (status.ok) {
    const mf = await probe(lan.address, PORT, '/manifest');
    let nameOk = null;
    if (mf.ok && mf.status === 200) {
      try {
        const j = JSON.parse(mf.buf.toString('utf8'));
        const nm = j?.extra?.expoClient?.name ?? '';
        nameOk = nm === '八字排盘';
      } catch { /* ignore */ }
    }
    record('manifest 可解析', mf.ok && mf.status === 200, mf.ok ? `HTTP ${mf.status}` : mf.error);
    record('manifest 中文名正确', nameOk === true,
      nameOk === true ? '「八字排盘」' : '显示层乱码（iOS Expo Go 已知显示问题，不影响运行）');
  }

  /* ---------- 7. bundle 能否编译 ---------- */
  if (status.ok) {
    const q = '?platform=ios&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable';
    const t0 = Date.now();
    const b = await probe(lan.address, PORT, '/index.ts.bundle' + q, 180000);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (b.ok && b.status === 200) {
      const text = b.buf.slice(0, 200).toString('latin1');
      const isHermes = b.buf[0] === 0xc6 && b.buf[1] === 0x1f && b.buf[2] === 0xbc;
      record('bundle 编译', true, `HTTP 200 / ${(b.len / 1048576).toFixed(1)}MB / ${secs}s`);
      // dev 模式下 Expo 故意不产出字节码（isHermesEnabled 里 !dev 才为真），返回纯 JS 是正常的
      record('bundle 形态', true,
        isHermes ? 'Hermes 字节码' : '纯 JS 文本（dev 模式正常行为）');
      const hasApp = b.buf.includes('App.tsx');
      const hasChart = b.buf.includes('ChartView');
      record('业务代码进包', hasApp && hasChart,
        `App.tsx ${hasApp ? '✓' : '✗'} / ChartView ${hasChart ? '✓' : '✗'}`);
    } else {
      record('bundle 编译', false, b.ok ? `HTTP ${b.status}` : b.error);
      if (b.ok) {
        console.log('\n---- 编译错误内容 ----');
        console.log(b.buf.toString('utf8').slice(0, 2500));
      }
    }
  }

  /* ---------- 8. 防火墙 ---------- */
  // ⚠ 中文 Windows 上 netsh 输出是 GBK。这里走 PowerShell 的 .NET 接口
  //   直接读注册表值（不依赖控制台编码，也不依赖 iconv 是否装了）。
  //   0 = 关闭，1 = 启用。读不到就如实说「无法读取」，不给假结论。
  const { execSync } = require('child_process');
  let fwOff = null;
  const ps =
    'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy" ' +
    '-ErrorAction SilentlyContinue | ForEach-Object { (Get-ItemProperty $_.PSPath -Name EnableFirewall ' +
    '-ErrorAction SilentlyContinue).EnableFirewall }';
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      encoding: 'utf8', timeout: 20000,
    });
    const vals = out.split(/\s+/).filter((x) => x === '0' || x === '1');
    if (vals.length) fwOff = vals.every((v) => v === '0');
  } catch { /* ignore */ }
  record('防火墙', fwOff !== false,
    fwOff === true ? '所有 profile 均已关闭，不拦截入站'
      : fwOff === false ? '防火墙开着，可能拦截入站（需放行 node.exe 的 8081 入站）'
        : '无法读取（不影响判断，可跳过）');

  finish();

  function finish() {
    console.log('\n' + '='.repeat(64));
    const failed = results.filter((r) => r.ok === false);
    if (failed.length === 0) {
      console.log('  服务端全部正常 ✅');
      console.log('='.repeat(64));
      console.log(`
如果手机仍报错，对照下面这句报错本身定位：

【A】"could not connect to the server" / "there was a problem running
      the requested project"       → 手机到电脑这一段不通

  ① 手机浏览器打开：http://${lan ? lan.address : '<你的IP>'}:${PORT}
       - 能看到 packager-status:running  → 网络通，问题在 Expo Go
       - 打不开                          → 网络不通，看 ②③④
  ② 手机和电脑连的是**同一个 Wi-Fi**（注意 2.4G / 5G 可能是不同 SSID）
  ③ 路由器是否开了「AP 隔离 / 客户端隔离」
  ④ 手机关掉 VPN、关掉「无线局域网助理」
  ⑤ 都不行 → npm run tunnel（走公网隧道，手机用流量都能连）

【B】"You need to be signed in to Expo Go and Expo CLI"
                                → 只是没登录，网络已经通了（是好事）

  在终端里跑：
      npm run login:browser      ← 推荐，用浏览器登录，不用敲密码
  或  npm run login              ← 命令行输入账号密码
  登录后看：npm run whoami
  ⚠ 登录是「电脑端 Expo CLI」和「手机上 Expo Go」都要有账号，
    用**同一个账号**登录。手机端在 Expo Go 的 Settings / Account 里登录。
`);
    } else {
      console.log(`  发现 ${failed.length} 个问题：`);
      for (const f of failed) console.log(`   ✗ ${f.name} — ${f.detail}`);
      console.log('='.repeat(64));
    }
    process.exit(failed.length === 0 ? 0 : 1);
  }
})().catch((e) => {
  console.error('体检脚本自身出错:', e && e.stack || e);
  process.exit(2);
});
