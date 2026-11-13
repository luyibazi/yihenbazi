#!/usr/bin/env node
/* tools/run.js —— 统一入口：无论 PATH 里哪个 node 排在前面，都用「对的 Node」跑。
 *
 * 为什么需要它（真实踩坑）：
 *   本机装了两个 Node，`E:\nodejs\node` = v18.19.0（太老），
 *   另一个是 v22.22.2。**你的终端里 E:\nodejs 排在 PATH 前面**。
 *
 *   而 package.json 里写 `"start": "node node_modules/expo/bin/cli start"` 时，
 *   那个裸 `node` 会走 PATH ⇒ 解析到 v18 ⇒ Expo CLI 直接报：
 *       Node.js (v18.19.0) is outdated and unsupported. Please update to >=20.19.4
 *
 * ⚠⚠ 关键约束（本文件的第一性原理）：
 *   本机守护进程**禁止 Node spawn 任何子进程** —— 连
 *   `spawnSync(process.execPath, ['--version'])` 都返回
 *   `status=null, error.code='EBUSY'`，且 **stdout/stderr 全空、无任何报错信息**。
 *   ⇒ 所以：**本脚本在启动目标之前，绝不能试图「探测」任何 exe 的版本**
 *     （一探测就 EBUSY，一 EBUSY 就误判成「找不到 Node」）。
 *
 *   正确的分工：
 *     · 「哪个 Node 合格」 —— 由 `setup-node.js` 判定（它读 process.version，零 spawn）。
 *     · 「用哪个 Node 跑目标」 —— 由本脚本负责，只做 existsSync + 直接把 exe 交给
 *       spawnSync 去跑目标。**唯一的一次 spawn 就是跑目标本身**；
 *       而这一层 spawn 在**用户自己的终端里是正常的**（EBUSY 是 AI 会话沙箱的限制，
 *       不是用户环境的限制）。为了在 AI 沙箱里也能自测，本脚本额外支持
 *       `--print` 模式：只输出它「会」用哪个 exe，不真跑。
 *
 * 用法：
 *   node tools/run.js --print <目标脚本>     # 只报告将用哪个 node（沙箱里可测）
 *   node tools/run.js <目标脚本> [参数...]   # 真跑
 *   例：node tools/run.js node_modules/expo/bin/cli start
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIN = [20, 19, 4];
const MIN_STR = MIN.join('.');

/** 只做字符串比较，不 spawn。读的是调用方传进来的 version 串。 */
function versionOk(v) {
  const m = String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b, c] = [m[0] || 0, m[1] || 0, m[2] || 0];
  if (a !== MIN[0]) return a > MIN[0];
  if (b !== MIN[1]) return b > MIN[1];
  return c >= MIN[2];
}

function norm(p) {
  return path.win32.normalize(path.resolve(p));
}

/** 候选列表，按可信度排序。全部来自「读文件/读环境」，零 spawn。 */
function candidates() {
  const out = [];

  // ① 显式环境变量 —— 用户/上层脚本说了算，最高优先
  if (process.env.PAIPAN_NODE) out.push({ exe: norm(process.env.PAIPAN_NODE), why: 'PAIPAN_NODE 环境变量' });

  // ② 项目级配置（setup-node.js --write 生成的）
  const cfg = path.join(ROOT, '.node-path');
  try {
    const line = fs.readFileSync(cfg, 'utf8').split(/\r?\n/)[0].trim();
    if (line) out.push({ exe: norm(line), why: '.node-path' });
  } catch { /* 没有就算了 */ }

  // ③ workbuddy 托管目录里的 `current` 指针文件
  //    ⚠ 它是个**文件**而不是目录，内容就是版本名（如 `22.22.2-6`）。
  //      比下面「按版本号排序猜一个」更准：这是托管方自己认的那个版本。
  const base = path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'node', 'versions');
  try {
    const cur = fs.readFileSync(path.join(base, 'current'), 'utf8').split(/\r?\n/)[0].trim();
    if (cur) out.push({ exe: norm(path.join(base, cur, 'node.exe')), why: `versions/current 指针 (${cur})` });
  } catch { /* 没有就算了 */ }

  // ④ 扫 workbuddy 管理的版本目录（按版本号从高到低）
  // ⚠⚠⚠ 2026-10-09 事故：这里原来硬编码了 `22.22.2-3`，但该目录**已被删**，
  //   当前只有 `22.22.2-6` ⇒ 硬编码兜底等于指向空气（start.bat 同款毛病）。
  //   修法不写死任何版本号：指针文件（③）+ 目录扫描（④）自行适应。
  try {
    const vers = fs.readdirSync(base, { withFileTypes: true })
      // ⚠ 必须 isDirectory()：`current` 是**文件**，不过滤会把它当成版本目录，
      //   拼出 `versions/current/node.exe` 这条不存在的候选。
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        return 0;
      });
    for (const v of vers) out.push({ exe: norm(path.join(base, v, 'node.exe')), why: `扫描 versions/${v}` });
  } catch { /* ignore */ }

  // ⑤ 当前进程自己 —— ⚠ 放最后，因为它可能正是那个 v18
  if (process.execPath) out.push({ exe: norm(process.execPath), why: '当前进程 (process.execPath)' });

  return out;
}

/**
 * ⚠ 本函数**不 spawn**。
 * 「候选存在 + 当前进程合格」时挑哪个，我们只按优先级取第一个存在的。
 * 版本是否合格交给两条独立证据：
 *   (a) 调用方自己就是合格 node 时（process.execPath 命中）→ 直接用；
 *   (b) 其余情况把「存在性」当准入门槛，真正跑起来若仍报版本错，
 *       说明选错了 —— 那时 setup-node.js 会给出准确结论。
 * 这样做的原因：**测版本 = spawn = 必 EBUSY**，一旦 EBUSY 整个脚本就废了。
 * 与其「探测失败后误报找不到」，不如「按优先级取第一个存在的，跑起来再说」。
 */
function pick() {
  const list = candidates();
  const selfNorm = process.execPath ? norm(process.execPath) : '';
  for (const c of list) {
    if (!c.exe) continue;
    if (!fs.existsSync(c.exe)) continue;
    return { ...c, isSelf: c.exe.toLowerCase() === selfNorm.toLowerCase() };
  }
  return null;
}

const argv = process.argv.slice(2);
const printOnly = argv.includes('--print');
const args = argv.filter((a) => a !== '--print');
const target = args[0];

if (!target) {
  console.error('用法: node tools/run.js [--print] <目标脚本> [参数...]');
  process.exit(2);
}

const chosen = pick();
if (!chosen) {
  console.error('\n[ERROR] 找不到可用的 Node（需要 >= ' + MIN_STR + '）。');
  console.error('已检查的位置都没命中。请任选一种方式解决：');
  console.error('  A) 双击项目根的 start.bat（已硬编码指向 v22）');
  console.error('  B) 安装最新 LTS： https://nodejs.org/en/download');
  console.error('  C) 设置环境变量： set PAIPAN_NODE=<node.exe 完整路径>');
  console.error('  D) 在项目根建 .node-path 写入 node.exe 完整路径');
  console.error('');
  process.exit(1);
}

if (printOnly) {
  console.log(`[run] 会使用：${chosen.exe}`);
  console.log(`[run] 来源：  ${chosen.why}`);
  console.log(`[run] 目标：  ${path.resolve(ROOT, target)}`);
  process.exit(0);
}

if (process.env.PAIPAN_VERBOSE) {
  console.error(`[run] using ${chosen.exe}  (via ${chosen.why})`);
}

const spawnArgs = [path.resolve(ROOT, target), ...args.slice(1)];
const r = spawnSync(chosen.exe, spawnArgs, { cwd: ROOT, stdio: 'inherit' });

if (r.error) {
  // EBUSY 是本机沙箱特性，不是用户的问题 —— 把它翻译成人话
  if (r.error.code === 'EBUSY' || r.status === null) {
    console.error('');
    console.error('[run] 无法在本环境启动子进程（EBUSY）。');
    console.error('      这通常是 AI 会话沙箱的限制，不是你的项目坏了。');
    console.error('      ⇒ 请直接双击项目根目录的 start.bat 运行。');
    console.error('');
    process.exit(1);
  }
  console.error('[run] 启动失败:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
