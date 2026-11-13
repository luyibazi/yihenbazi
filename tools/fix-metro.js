#!/usr/bin/env node
/**
 * fix-metro.js —— 修复 npm 装出的「空壳 metro 包」
 *
 * 症状：
 *   npx expo start
 *   → Error: Cannot find module 'metro/src/lib/TerminalReporter'
 *
 * 成因：
 *   npm 判定 metro「已安装」所以跳过（或装了半截），
 *   node_modules/metro/ 里只剩 src/ 和 .js.flow，**没有 package.json**。
 *   重装 / --force / 换 --cache 全都无效，因为问题在「它认为已经有了」。
 *
 * 做法：
 *   绕开 npm，直接从镜像下 tarball 解包铺进去，然后自检关键文件。
 *
 * 用法：
 *   node tools/fix-metro.js              # 自动读 metro-config 的版本
 *   node tools/fix-metro.js 0.80.12      # 指定版本
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const MIRROR = 'https://cdn.npmmirror.com/packages';

function log(msg) {
  process.stdout.write(msg + '\n');
}

/** 决定性信号：目录在、但没有 package.json ⇒ 空壳包 */
function isShell(pkgDir) {
  if (!fs.existsSync(pkgDir)) return 'missing';
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) return 'shell';
  return 'ok';
}

/** 从 co-located 的 metro-config 推版本，保证与其余 metro-* 一致 */
function detectVersion() {
  const candidates = ['metro-config', 'metro-core', 'metro-resolver'];
  for (const c of candidates) {
    const pj = path.join(NM, c, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        return JSON.parse(fs.readFileSync(pj, 'utf8')).version;
      } catch (_) { /* 继续试下一个 */ }
    }
  }
  return null;
}

/**
 * 纯 Node 解包 tar.gz —— 不依赖系统 tar。
 * 只实现 npm 包场景够用的子集：普通文件 + 目录 + 长文件名(ustar/L)。
 */
function unpackWithNode(tgzPath, destDir) {
  const zlib = require('zlib');
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  let off = 0;
  let pendingLongName = null;

  const readStr = (b, s, l) => {
    let e = s;
    while (e < s + l && b[e] !== 0) e++;
    return b.toString('utf8', s, e);
  };

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // 全零块 = 归档结束
    if (header.every((x) => x === 0)) break;

    let name = readStr(header, 0, 100);
    const sizeOctal = readStr(header, 124, 12).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = readStr(header, 345, 155);

    off += 512;

    if (typeFlag === 'L' || typeFlag === 'K') {
      // GNU 长文件名：内容就是完整名字
      pendingLongName = buf.toString('utf8', off, off + size).replace(/\0+$/, '');
    } else {
      if (prefix) name = prefix + '/' + name;
      if (pendingLongName) { name = pendingLongName; pendingLongName = null; }
      // 去掉顶层目录（等价于 --strip-components=1）
      const rel = name.split('/').slice(1).join('/');
      if (rel) {
        const target = path.join(destDir, rel);
        // 防目录穿越
        if (target.startsWith(path.resolve(destDir))) {
          if (typeFlag === '5') {
            fs.mkdirSync(target, { recursive: true });
          } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, buf.subarray(off, off + size));
          }
        }
      }
    }

    // 数据按 512 对齐
    off += Math.ceil(size / 512) * 512;
  }
}

function main() {
  const metroDir = path.join(NM, 'metro');
  const state = isShell(metroDir);

  log('=== fix-metro ===');
  log(`metro 现状: ${state === 'ok' ? '正常' : state === 'shell' ? '空壳（有目录无 package.json）' : '整个缺失'}`);

  // ⚠ 别名兼容：SDK 57 起 metro 的版本号与 expo 不同（expo 57 → metro 0.83+）。
  //   优先用 CLI 传入的版本；没有就从 metro-config 读；都没有才提示。
  const version = process.argv[2] || detectVersion();
  if (!version) {
    log('❌ 无法确定 metro 版本（node_modules 里找不到 metro-config 等）。');
    log('   请先跑 npm install 再执行本脚本，或手动指定：node tools/fix-metro.js 0.83.0');
    return 1;
  }

  if (state === 'ok') {
    const probe = path.join(metroDir, 'src/lib/TerminalReporter.js');
    if (fs.existsSync(probe)) {
      log(`✅ metro@${version} 完整，无需修复`);
      return 0;
    }
    log('⚠ package.json 在但 TerminalReporter.js 缺失，仍需重铺');
  }

  log(`将安装 metro@${version}（与 metro-config 等保持一致）`);

  const tgz = path.join(require('os').tmpdir(), `metro-${version}.tgz`);
  const url = `${MIRROR}/metro/${version}/metro-${version}.tgz`;

  log(`下载: ${url}`);
  try {
    execSync(
      `curl -sSL --fail -o "${tgz}" "${url}"`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    log(`❌ 下载失败。可换镜像源重试（淘宝源 cdn.npmmirror.com 或 registry.npmjs.org）。`);
    return 1;
  }

  const size = fs.statSync(tgz).size;
  log(`下载完成: ${size} 字节`);
  if (size < 50000) {
    log('❌ 文件太小，八成下到了错误页而不是 tarball。');
    return 1;
  }

  // 清掉残壳（只删这一个包目录，不碰别的）
  if (fs.existsSync(metroDir)) {
    log('清理残壳目录 node_modules/metro ...');
    fs.rmSync(metroDir, { recursive: true, force: true });
  }

  log('解包 ...');
  fs.mkdirSync(metroDir, { recursive: true });
  try {
    // ⚠ Git Bash 的 tar 会把 "C:\..." 当成远程主机（Cannot connect to C:）。
    //   --force-local 强制按本地文件处理；再统一成正斜杠。
    const tgzPosix = tgz.replace(/\\/g, '/');
    const dstPosix = metroDir.replace(/\\/g, '/');
    execSync(`tar --force-local -xzf "${tgzPosix}" -C "${dstPosix}" --strip-components=1`, { stdio: 'inherit' });
  } catch (e) {
    // 退化路径：用 Node 自己解（不依赖 tar）
    log('tar 不可用，改用 Node 内置解包 ...');
    try {
      unpackWithNode(tgz, metroDir);
    } catch (e2) {
      log(`❌ 解包失败：${e2.message}`);
      return 1;
    }
  }

  // 自检：这几个文件是 @expo/cli / metro 自己真正 require 的
  // ⚠ 别凭印象加「根级 index.js」—— metro@0.80 的 main 是 src/index.js
  const must = [
    'package.json',
    'src/index.js',
    'src/lib/TerminalReporter.js',   // ← 报错里缺的就是它
  ];
  log('=== 自检 ===');
  let allOk = true;
  for (const f of must) {
    const p = path.join(metroDir, f);
    const ok = fs.existsSync(p);
    log(`${ok ? '✅' : '❌'} ${f}`);
    if (!ok) allOk = false;
  }

  // 再验一次「package.json 的 main 指向的文件存在」—— 这才是真正会被 require 的入口
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(metroDir, 'package.json'), 'utf8'));
    const entry = path.join(metroDir, pj.main || 'index.js');
    const ok = fs.existsSync(entry);
    log(`${ok ? '✅' : '❌'} main → ${pj.main}`);
    if (!ok) allOk = false;
  } catch (e) {
    log(`❌ 读 package.json 失败：${e.message}`);
    allOk = false;
  }

  if (!allOk) {
    log('\n⚠ 关键文件仍有缺失，metro 包可能本身不完整。');
    return 1;
  }

  log('\n✅ 修复完成。现在可以跑：npx expo start');
  try { fs.unlinkSync(tgz); } catch (_) {}
  return 0;
}

process.exit(main());
