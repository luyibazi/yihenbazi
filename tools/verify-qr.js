const fs = require('fs');
const path = require('path');
const { toQR } = require('toqr');

const htmlPath = path.join(__dirname, '..', '.qr.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const m = html.match(/exp:\/\/[^\s<"']+/);
if (!m) { console.error('FAIL  .qr.html 里找不到 exp:// 链接'); process.exit(1); }
const text = m[0];

const d = toQR(text);
const e = Math.sqrt(d.byteLength) | 0;
const at = (r, c) => d[r * e + c];

let black = 0;
for (let i = 0; i < d.byteLength; i++) black += d[i];

function finder(r0, c0) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = (r === 0 || r === 6 || c === 0 || c === 6);
      const core = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      const want = (ring || core) ? 1 : 0;
      if (at(r0 + r, c0 + c) !== want) return false;
    }
  }
  return true;
}

const tl = finder(0, 0), tr = finder(0, e - 7), bl = finder(e - 7, 0);
const pct = black / (e * e) * 100;
const svgW = (html.match(/width="(\d+)"/) || [])[1];

console.log('URL           :', text);
console.log('extent        :', e + 'x' + e + ' = ' + (e * e) + ' 格');
console.log('black modules :', black, '(' + pct.toFixed(1) + '%)  [期望 40~60%]');
console.log('finder TL     :', tl ? 'OK' : 'FAIL');
console.log('finder TR     :', tr ? 'OK' : 'FAIL');
console.log('finder BL     :', bl ? 'OK' : 'FAIL');
console.log('crispEdges    :', /crispEdges/.test(html) ? 'OK' : 'FAIL');
console.log('svg width     :', svgW);

const ok = tl && tr && bl && /crispEdges/.test(html) && pct > 40 && pct < 60;
console.log(ok ? '\nALL OK' : '\nSOMETHING FAILED');
process.exit(ok ? 0 : 1);
