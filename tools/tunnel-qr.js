#!/usr/bin/env node
/* tools/tunnel-qr.js —— 用 --tunnel 模式起服务，并生成对应的二维码页面
 *
 * 为什么需要这个：
 *   LAN 模式（默认）要求「手机和电脑在同一个 Wi-Fi，且路由器没开 AP 隔离」。
 *   这两个条件经常不成立（公司/访客网络、双频分离、运营商光猫的隔离策略）。
 *   症状就是手机报 "could not connect to the server"。
 *
 *   --tunnel 通过 ngrok 把服务挂到一个公网 https 地址，
 *   手机走流量/任意 Wi-Fi 都能连上 —— 代价是慢一点，且需要联网。
 *
 * 用法：node tools/tunnel-qr.js [port]
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8081;
const ROOT = path.join(__dirname, '..');
const nodeExe = process.execPath;
const cli = path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli');

console.log('正在以 tunnel 模式启动 Metro（首次会下载 ngrok，请稍候）...\n');

const child = spawn(nodeExe, [cli, 'start', '--tunnel', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let buf = '';
let done = false;

function handle(chunk) {
  const s = chunk.toString();
  buf += s;
  process.stdout.write(s);

  // exp:// 或 https:// 后面跟着一串 host，就是 tunnel 地址
  const m = buf.match(/(exp:\/\/[a-z0-9-]+\.(?:exp\.direct|ngrok\.io|ngrok-free\.app)[^\s]*)/i)
        || buf.match(/(https:\/\/[a-z0-9-]+\.(?:exp\.direct|ngrok\.io|ngrok-free\.app)[^\s]*)/i);
  if (m && !done) {
    done = true;
    const url = m[1];
    const expUrl = url.replace(/^https:\/\//, 'exp://');
    console.log('\n' + '='.repeat(56));
    console.log('  TUNNEL 就绪，手机扫下面这个（不用同一个 Wi-Fi）：');
    console.log('    ' + expUrl);
    console.log('='.repeat(56) + '\n');
    try {
      execSync(`"${nodeExe}" "${path.join(__dirname, 'qr.js')}" --url "${expUrl}"`, {
        cwd: ROOT, stdio: 'inherit',
      });
    } catch (e) {
      console.error('生成二维码失败:', e.message);
    }
  }
}

child.stdout.on('data', handle);
child.stderr.on('data', handle);
child.on('exit', (code) => {
  if (!done) {
    console.error('\n[tunnel] 进程退出，code =', code);
    console.error('可能是 @expo/ngrok 没装。装它：npm i -D @expo/ngrok@^4.1.0');
    console.error('（本机 safe-delete 可能拦 npm 的删除动作，失败就重跑 npm run fix:modules）');
  }
});

process.on('SIGINT', () => { child.kill(); process.exit(0); });
