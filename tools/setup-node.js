#!/usr/bin/env node
/* tools/setup-node.js —— 自动探测一个合格的 Node，并写进 .node-path
 *
 * 为什么需要：本机 PATH 里第一个 node 是 v18.19.0（太老），
 * Expo SDK 57 要 >= 20.19.4。让用户手动改 PATH 很容易改错，
 * 所以让脚本自己找、写进一个项目级配置文件，之后 tools/run.js 会读它。
 *
 * ⚠⚠ 本脚本**绝不能**用 child_process 去探测别的 node 版本。
 *   实测：脚本自己 spawn 任何 exe（连 node --version / hostname 都算）
 *   在本机守护进程下会被拦，返回 `status=null, error.code='EBUSY'`，
 *   且 **stdout/stderr 全空、没有任何报错信息** ⇒ 表现成
 *   「一个都没找到」，极易误判成「没装 Node」。
 *
 *   ⇒ 定义：**这个进程自己用的 node 就是唯一的 ground truth**。
 *     要验别的 node 版本，必须**由外层 shell 拿那个 exe 去跑本脚本**
 *     （shell 起进程不受此限），见 `--probe` 模式与 `--report` 模式。
 *
 * 用法：
 *   node tools/setup-node.js              # 体检：报告当前 node 是否合格（不写文件）
 *   node tools/setup-node.js --write      # 合格则写入 .node-path
 *   node tools/setup-node.js --probe <exe># 报告 exe 的版本并比对门槛（供外层脚本 cwd）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIN = [20, 19, 4];
const CFG = path.join(ROOT, '.node-path');

function parseVersion(v) {
  const m = String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  return [m[0] || 0, m[1] || 0, m[2] || 0];
}

function versionOk(v) {
  const [a, b, c] = parseVersion(v);
  if (a !== MIN[0]) return a > MIN[0];
  if (b !== MIN[1]) return b > MIN[1];
  return c >= MIN[2];
}

const MIN_STR = MIN.join('.');

// ─────────────────────────────────────────────────────────────
// 模式 A：--probe <exe> —— 由外层 shell 用目标 exe 调用本文件
//   本进程的 process.version 就是「exe 的版本」，
//   完全不需要 spawn ⇒ 绕过 EBUSY。
// ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const probeIdx = argv.indexOf('--probe');
if (probeIdx >= 0) {
  const claimed = argv[probeIdx + 1] || process.execPath;
  const ok = versionOk(process.version);
  console.log(
    `PROBE\t${ok ? 'OK' : 'FAIL'}\t${process.version}\t${path.win32.normalize(claimed)}`
  );
  process.exit(ok ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────
// 模式 B：默认 / --write —— 报告 + 可选落盘
// ─────────────────────────────────────────────────────────────
const write = argv.includes('--write') || argv.includes('-w');
const self = path.win32.normalize(process.execPath);
const selfVer = process.version;
const ok = versionOk(selfVer);

console.log('');
console.log('当前进程使用的 Node：');
console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${selfVer.padEnd(10)} ${self}`);
console.log(`  门槛：>= ${MIN_STR}（Expo SDK 57 要求）`);

if (!ok) {
  console.log('');
  console.log(`[ERROR] 你正在用的 Node ${selfVer} 太老（需要 >= ${MIN_STR}）。`);
  console.log('');
  console.log('请任选一种方式解决：');
  console.log('  A) 双击项目根目录的 start.bat —— 它已硬编码指向 v22，绕开 PATH');
  console.log('  B) 装最新 LTS： https://nodejs.org/en/download');
  console.log('  C) 临时指定： set PAIPAN_NODE=<node.exe 完整路径>  然后 npm start');
  console.log('');
  console.log('⚠ 不要指望本脚本「自动降级」到旧 Node —— 那只会把问题推后。');
  console.log('');
  process.exit(1);
}

// 顺带扫一下本机还有哪些 node.exe（纯读目录 + existsSync，不 spawn ⇒ 安全）
// ⚠ 这里只能「列出文件」，**不能测它们各自的版本** —— 测版本必须 spawn，
//   而 spawn 在本机被拦。所以「别的版本是多少」这件事，本脚本不妄下结论；
//   用户想知道就自己拿那个 exe 跑 `node --version`。
console.log('');
console.log('本机扫到的 node.exe（仅列出，不测版本）：');
const seen = new Set();
const bases = [
  path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'node', 'versions'),
  'C:\\Program Files\\nodejs',
  'E:\\nodejs',
  'E:\\nodejs\\node.exe', // 有些安装直接把 exe 放在这里
];
for (const base of bases) {
  if (!base || !fs.existsSync(base)) continue;
  // base 自己就是 exe
  if (base.toLowerCase().endsWith('.exe')) { seen.add(base); continue; }
  // base 就是安装根（如 E:\nodejs）
  const direct = path.join(base, 'node.exe');
  if (fs.existsSync(direct)) seen.add(path.win32.normalize(direct));
  // base/版本号/node.exe
  let entries = [];
  try { entries = fs.readdirSync(base); } catch { continue; }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const guess = path.join(base, e, 'node.exe');
    if (fs.existsSync(guess)) seen.add(path.win32.normalize(guess));
  }
}
const list = [...seen];
if (!list.length) console.log('  （没扫到 —— 不影响，你现在用的这个就是最好的）');
else for (const p of list) console.log(`  ${p === self ? '[正在用] ' : ''}${p}`);

if (write) {
  fs.writeFileSync(CFG, self + '\n', 'utf8');
  console.log('');
  console.log(`✅ 已写入 ${CFG}`);
  console.log(`   内容：${self}`);
  console.log('');
} else {
  console.log('');
  console.log('（加 --write 可把这个路径写进 .node-path，供 tools/run.js 读取）');
  console.log('');
}
