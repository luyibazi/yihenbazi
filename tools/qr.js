#!/usr/bin/env node
/**
 * qr.js —— 生成「一定能扫出来」的二维码（离线 SVG，浏览器打开）
 *
 * 为什么需要这个脚本：
 *   终端里的二维码是用 ▀ ▄ █ 和空格拼的方块图（见 expo CLI 的 createHalfblockOutput）。
 *   它假设「一个方块字符的宽度 == 一个空格的宽度」——但终端字体不是等宽方块，
 *   半角空格比全角方块窄。结果整个码被横向压缩，模块不成正方形，手机扫不出来。
 *
 *   所以这里改成：拿 Expo 自带的 `toqr` 算出二维码矩阵，画成**真正的 SVG**，
 *   每个模块都是严格的正方形，在浏览器里显示。不依赖任何网络资源。
 *
 * 关键实现细节（来自阅读 expo CLI 的 qr.js 源码）：
 *   - toQR(url) 返回 Uint8Array，是**扁平的模块位图**
 *   - 宽度/高度 = Math.sqrt(data.byteLength)（一定是正方形）
 *   - 取某格用 data[row * extent + col]
 *
 * 用法：
 *   node tools/qr.js                # 端口 8081
 *   node tools/qr.js 8090           # 指定端口
 *   node tools/qr.js 8081 --no-open # 只生成文件，不打开浏览器
 *   node tools/qr.js --url exp://xxx.exp.direct   # 直接给定地址（tunnel 模式用）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const port = args.find((a) => /^\d+$/.test(a)) || '8081';
const noOpen = args.includes('--no-open');
// --url <完整地址>：tunnel 模式由 tunnel-qr.js 传进来
const urlIdx = args.indexOf('--url');
const explicitUrl = urlIdx >= 0 ? args[urlIdx + 1] : null;

// ---------- 找局域网 IP ----------
function lanIP() {
  const ifaces = os.networkInterfaces();
  const cands = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (/virtual|vmware|vbox|hyper-v|loopback|bluetooth/i.test(name)) continue;
      cands.push({ name, address: ni.address });
    }
  }
  const priv =
    cands.find((c) => /^192\.168\./.test(c.address)) ||
    cands.find((c) => /^10\./.test(c.address)) ||
    cands.find((c) => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  return priv || cands[0] || { name: '(none)', address: '127.0.0.1' };
}

// ---------- 用 toqr 算矩阵，再画成 SVG ----------
function qrSVG(text, { module = 8, quiet = 4 } = {}) {
  let toQR;
  try {
    ({ toQR } = require('toqr'));
  } catch (_) {
    // 退化：从 expo CLI 内置的 node_modules 里找
    try {
      ({ toQR } = require(path.join(ROOT, 'node_modules', 'toqr')));
    } catch (e) {
      return null;
    }
  }

  const data = toQR(text);
  const extent = Math.sqrt(data.byteLength) | 0;
  if (!extent || extent * extent !== data.byteLength) return null;

  const size = (extent + quiet * 2) * module;

  let path_ = '';
  for (let row = 0; row < extent; row++) {
    for (let col = 0; col < extent; col++) {
      // 1 = 黑模块，0 = 白
      if (data[row * extent + col]) {
        const x = (col + quiet) * module;
        const y = (row + quiet) * module;
        path_ += `M${x} ${y}h${module}v${module}h-${module}z`;
      }
    }
  }

  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
      `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
      `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
      `<path d="${path_}" fill="#000000"/>` +
      `</svg>`,
    extent,
  };
}

function buildHTML(url, svg, isTunnel = false) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫码进入 · 八字排盘</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f2f3f5; padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
  }
  .card { background:#fff; padding:36px 40px 28px; border-radius:14px;
          box-shadow:0 4px 24px rgba(0,0,0,.07); text-align:center; max-width:540px; width:100%; }
  h1 { font-size:19px; margin:0 0 6px; color:#16181d; font-weight:600; letter-spacing:.5px; }
  .sub { font-size:13px; color:#8a8f99; margin:0 0 24px; }
  #qr { display:inline-block; padding:14px; background:#fff; border:1px solid #e8eaed;
        border-radius:10px; line-height:0; }
  #qr svg { display:block; width:280px; height:280px; }
  .url { margin-top:22px; font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
         font-size:14px; color:#16181d; background:#f2f3f5; padding:11px 14px;
         border-radius:8px; word-break:break-all; user-select:all; cursor:text;
         border:1px solid #e8eaed; }
  .tip { margin-top:22px; padding-top:18px; border-top:1px solid #eff0f2;
         font-size:12.5px; color:#8a8f99; line-height:1.85; text-align:left; }
  .tip b { color:#4a4f57; font-weight:600; }
  .tip code { background:#f2f3f5; padding:1px 5px; border-radius:4px;
              font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#c0392b; }
  .row { display:flex; gap:10px; margin-top:8px; }
  .row span { flex:1; }
</style>
</head>
<body>
<div class="card">
  <h1>八字排盘 · 开发预览</h1>
  <p class="sub">手机扫码即可进入</p>
  <div id="qr">${svg}</div>
  <div class="url" title="点击可全选">${url}</div>
  <div class="tip">
    <b>怎么扫</b>
    <div class="row">
      <span>iPhone：用系统「相机」对准二维码</span>
      <span>安卓：打开 Expo Go，用里面的扫码</span>
    </div>
    <b style="display:block;margin-top:12px">扫不出来？</b>
    ${isTunnel
      ? `本页是 <b>tunnel 模式</b>：地址走公网，手机<b>不需要</b>和电脑同一个 Wi-Fi。<br>
         ① 确保手机能上网（流量也行）<br>
         ② 首次连接较慢，请耐心等 10~30 秒<br>
         ③ tunnel 地址每次启动都会变，<b>重启服务后必须重扫</b>`
      : `① 确认手机和电脑连的是<b>同一个 Wi-Fi</b>（这一步最容易漏）<br>
         ② 若确认同 Wi-Fi 仍连不上，多半是路由器开了「AP 隔离」，改用 <code>npm run tunnel</code><br>
         ③ 实在不行，在 Expo Go 里手动输入上面那串地址<br>
         ④ 地址不对？本页地址来自电脑当前网卡，换网络后要重跑 <code>start.bat</code>`}
  </div>
</div>
</body>
</html>`;
}

function main() {
  const { name, address } = lanIP();
  const isTunnel = !!explicitUrl;
  const url = explicitUrl || `exp://${address}:${port}`;

  process.stdout.write('\n');
  process.stdout.write('========================================================\n');
  process.stdout.write('  在 Expo Go 里打开：\n');
  process.stdout.write('\n');
  process.stdout.write(`      ${url}\n`);
  process.stdout.write('\n');
  if (isTunnel) {
    process.stdout.write('  （tunnel 模式 —— 手机不必和电脑同一个 Wi-Fi）\n');
  } else {
    process.stdout.write(`  （网卡：${name}）\n`);
  }
  process.stdout.write('========================================================\n');

  const r = qrSVG(url);
  if (!r) {
    process.stdout.write('\n[WARN] 无法生成二维码（找不到 toqr 模块）。\n');
    process.stdout.write('       请手动把上面的地址输入 Expo Go。\n\n');
    return 1;
  }

  const out = path.join(ROOT, '.qr.html');
  fs.writeFileSync(out, buildHTML(url, r.svg, isTunnel), 'utf8');

  process.stdout.write(`\n二维码已生成（${r.extent}×${r.extent} 模块，纯 SVG 离线）\n`);
  process.stdout.write(`文件：${out}\n`);

  if (!noOpen) {
    try {
      execSync(`cmd /c start "" "${out}"`, { stdio: 'ignore' });
      process.stdout.write('已用浏览器打开。用手机扫浏览器里的二维码。\n');
    } catch (_) {
      process.stdout.write('请手动用浏览器打开上面的文件。\n');
    }
  }
  process.stdout.write('\n');
  return 0;
}

process.exit(main());
