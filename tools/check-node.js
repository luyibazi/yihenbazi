#!/usr/bin/env node
/**
 * check-node.js —— 启动前的 Node 版本守卫
 *
 * 为什么需要：
 *   本机装了多个 Node，PATH 里排第一的是 v18.19.0，
 *   而 Expo SDK 57 要求 >= 20.19.4。
 *   v18 没有 Array.prototype.toReversed，Metro 加载配置时崩在
 *     TypeError: configs.toReversed is not a function
 *   —— 这个报错完全没提 Node 版本，排查要绕一大圈。
 *   所以提前拦一下，直接把话说清楚。
 *
 * 用法：
 *   node tools/check-node.js          # 不符合要求时退出码 1
 *   node tools/check-node.js --quiet  # 只在不合格时输出
 */

const MIN = [20, 19, 4];
const REQUIRED_TEXT = '20.19.4';

const quiet = process.argv.includes('--quiet');

const cur = process.versions.node.split('.').map(Number);

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

const ok = cmp(cur, MIN) >= 0;

if (ok) {
  if (!quiet) {
    process.stdout.write(`✅ Node v${process.versions.node} 符合要求（>= ${REQUIRED_TEXT}）\n`);
  }
  process.exit(0);
}

// ---- 不合格：给出可操作的指引 ----
process.stderr.write('\n');
process.stderr.write('=========================================================\n');
process.stderr.write(` ❌ Node 版本过低：当前 v${process.versions.node}\n`);
process.stderr.write(`    Expo SDK 57 要求 >= ${REQUIRED_TEXT}\n`);
process.stderr.write('=========================================================\n');
process.stderr.write('\n');
process.stderr.write('  直接用这个版本启动会崩，报错是：\n');
process.stderr.write('    TypeError: configs.toReversed is not a function\n');
process.stderr.write('  （那个报错完全没提 Node 版本，所以这里提前拦下来。）\n');
process.stderr.write('\n');
process.stderr.write('  可选办法：\n');
process.stderr.write('\n');
process.stderr.write('  A) 最省事 —— 双击项目根目录的 start.bat\n');
process.stderr.write('     它会显式用 v22 来跑，不动系统设置。\n');
process.stderr.write('\n');
process.stderr.write('  B) 永久修复 —— 把新版 Node 提到 PATH 最前面\n');
process.stderr.write('     本机已装有：\n');
process.stderr.write('       C:\\Users\\luerse\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\n');
process.stderr.write('     把这个目录加到「系统环境变量 PATH」里，\n');
process.stderr.write('     并确保它排在 E:\\nodejs 前面。改完重开终端。\n');
process.stderr.write('\n');
process.stderr.write('  C) 或去 nodejs.org 装最新 LTS（>= 22）\n');
process.stderr.write('\n');

process.exit(1);
