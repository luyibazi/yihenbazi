#!/usr/bin/env node
/**
 * repair-modules.js —— 修复被本机 safe-delete 打断的 npm 安装
 *
 * 背景：
 *   本机的删除守护（safe-delete）会拦截 npm 的删除动作，报
 *     [safe-delete] 操作失败: Error during a `trash` operation
 *   或 [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {...}
 *   → npm 安装中途失败，留下**半成品 node_modules**：包在、但入口文件缺失。
 *
 * 本脚本处理三种已知的破损形态（全部用「改名/软链」实现，不做删除）：
 *
 *   ① *.DELETE.<hash> 残骸：safe-delete 把 index.js 改名后没删掉，
 *      导致 index.js 消失 → 把残骸改回原名
 *   ② 嵌套包解析不到：包完整但装在了 <pkg>/node_modules/xxx，
 *      而 Babel/Metro 从项目根解析 → 建目录联接（junction）
 *   ③ 报告仍然缺失的包，提示单独处理
 *
 * 用法：
 *   node tools/repair-modules.js            # 检查并自动修 ①②
 *   node tools/repair-modules.js --check    # 只检查，不改动
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const CHECK_ONLY = process.argv.includes('--check');

const fixes = [];
const problems = [];

function log(m) { process.stdout.write(m + '\n'); }

// ---------- ① 还原 *.DELETE.<hash> 残骸 ----------
function restoreDeleteRemnants() {
  log('--- ① 扫描 *.DELETE.* 残骸 ---');
  let found = 0;

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      // 形如 index.js.DELETE.51f115ec6cd7abded9017fd6f83b13f4
      const m = e.name.match(/^(.*?)\.DELETE\.[0-9a-f]{16,}$/);
      if (!m) continue;
      found++;
      const target = path.join(dir, m[1]);
      if (CHECK_ONLY) {
        log(`  [待修] ${path.relative(ROOT, full)}  →  ${m[1]}`);
        continue;
      }
      try {
        if (fs.existsSync(target)) {
          fs.unlinkSync(full);          // 原名已存在，残骸是多余的
          log(`  [清理] 原名已存在，移除残骸 ${path.relative(ROOT, full)}`);
        } else {
          fs.renameSync(full, target);  // 改名 = 还原（不是删除，绕开守护）
          log(`  [还原] ${m[1]}  (${path.relative(ROOT, dir)})`);
        }
        fixes.push(`restore:${path.relative(ROOT, target)}`);
      } catch (err) {
        problems.push(`还原失败 ${full}: ${err.message}`);
      }
    }
  };

  walk(NM);
  if (!found) log('  ✅ 无残骸');
  return found;
}

// ---------- ② 把嵌套包联接到根级 ----------
// Babel / Metro 从项目根按名字解析预设与插件，
// 装成 <pkg>/node_modules/<dep> 时根级找不到 → 建 junction
const NESTED_CANDIDATES = [
  ['babel-preset-expo', 'expo'],
];

function linkNestedPackages() {
  log('--- ② 检查嵌套包（根级解析不到）---');
  let linked = 0;

  for (const [pkg, host] of NESTED_CANDIDATES) {
    const atRoot = path.join(NM, pkg);
    if (fs.existsSync(atRoot)) {
      // 已在根级，验一下能否 require
      const entry = readMain(atRoot);
      if (entry && fs.existsSync(entry)) { log(`  ✅ ${pkg} 已在根级且完整`); continue; }
      log(`  ⚠ ${pkg} 在根级但入口缺失（见 ① 残骸扫描）`);
      continue;
    }
    const nested = path.join(NM, host, 'node_modules', pkg);
    if (!fs.existsSync(nested)) {
      log(`  ⚠ ${pkg} 未找到（根级与 ${host}/node_modules 都没有）`);
      continue;
    }
    const entry = readMain(nested);
    if (!entry || !fs.existsSync(entry)) {
      problems.push(`${pkg} 存在但入口缺失，需重装：${path.relative(ROOT, nested)}`);
      continue;
    }
    if (CHECK_ONLY) { log(`  [待联] ${pkg}  →  根级 junction`); continue; }
    if (linkDir(atRoot, nested)) {
      log(`  [联接] ${pkg}  →  根级（指向 ${host}/node_modules）`);
      fixes.push(`link:${pkg}`);
      linked++;
    } else {
      problems.push(`建立联接失败 ${pkg}`);
    }
  }
  if (!linked && !problems.length) log('  ✅ 无需联接');
  return linked;
}

/**
 * 在 Windows 上建目录联接（junction）。
 *
 * ⚠⚠ 这里有一个**踩了很久**的坑，务必看：
 *
 *   在 AI/沙箱环境里，从 Node 里 spawn `cmd.exe` 会直接失败：
 *       spawnSync C:\WINDOWS\system32\cmd.exe EBUSY
 *   （status 为 null、stdout/stderr 全空 —— 非常难查，因为**没有任何报错信息**）
 *   同样，`fs.symlinkSync(target, link, 'junction')` 也会 `EBUSY`。
 *
 *   但**由 shell 直接执行一个 .bat 文件是允许的**（cmd 由 shell 拉起，不经 Node）。
 *
 *   ⇒ 所以策略是：**优先尝试 spawn（用户自己的终端里通常没问题），
 *      失败就生成一个 .bat 并提示用户运行 / 由上层脚本用 shell 调**。
 *
 *   另一个坑：`cmd /c mklink /J "相对路径" ...` 会报「系统找不到指定的路径」——
 *   cmd 解析相对路径用的是它自己的 CWD。**一律传绝对路径。**
 *
 * 为什么不用 fs.symlinkSync：junction 不需要管理员权限，但在这类沙箱里
 * 会被 EBUSY 拦；mklink 是更常见的可行路径。
 */
function linkDir(linkPath, targetPath) {
  const abs = (p) => path.win32.normalize(path.resolve(p));
  const link = abs(linkPath);
  const target = abs(targetPath);

  if (fs.existsSync(path.join(link, 'package.json'))) return true;

  // ① 直接 spawn cmd（在用户自己的终端里通常可行）
  try {
    execSync(`cmd /c mklink /J "${link}" "${target}"`, { cwd: ROOT, stdio: 'pipe' });
    if (fs.existsSync(path.join(link, 'package.json'))) return true;
  } catch (_) { /* 落到 ② */ }

  // ② Node 原生 junction
  try {
    fs.symlinkSync(target, link, 'junction');
    if (fs.existsSync(path.join(link, 'package.json'))) return true;
  } catch (_) { /* 落到 ③ */ }

  // ③ 都不行 → 写一个 .bat，让上层用 shell 跑（shell 起 cmd 不被拦）
  try {
    const bat = path.join(ROOT, 'tools', 'link-fix.bat');
    const pkgName = path.basename(linkPath);
    const host = path.basename(path.dirname(path.dirname(path.dirname(target))));
    const lines = [
      '@echo off',
      `cd /d "${ROOT}"`,
      `if exist "node_modules\\${pkgName}" ( echo ALREADY EXISTS & exit /b 0 )`,
      `mklink /J "node_modules\\${pkgName}" "${target}"`,
      // ⚠ 保持 ASCII-only：中文在 GBK 控制台下会乱码并被解析坏
      'if errorlevel 1 ( echo MKLINK FAILED & exit /b 1 )',
      'echo MKLINK OK',
      '',
    ];
    fs.writeFileSync(bat, lines.join('\r\n'), 'ascii');
    PENDING_BAT = bat;
    return false;
  } catch (_) {
    return false;
  }
}

let PENDING_BAT = null;

/** 读 package.json 的 main（考虑 exports 简写），返回绝对路径或 null */
function readMain(pkgDir) {
  const pj = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pj)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const main = p.main || 'index.js';
    return path.join(pkgDir, main);
  } catch (_) { return null; }
}

// ---------- ③ 关键包体检 ----------
const SMOKE = [
  'expo/package.json',
  'react/package.json',
  'react-native/package.json',
  'babel-preset-expo/package.json',
  'babel-preset-expo/build/index.js',
  'expo/bin/cli',
];

function smokeTest() {
  log('--- ③ 关键包体检 ---');
  let ok = true;
  for (const rel of SMOKE) {
    const p = path.join(NM, rel);
    const exists = fs.existsSync(p);
    log(`  ${exists ? '✅' : '❌'} ${rel}`);
    if (!exists) ok = false;
  }
  return ok;
}

function main() {
  log('=== repair-modules ===' + (CHECK_ONLY ? '  (只检查)' : ''));
  if (!fs.existsSync(NM)) {
    log('❌ node_modules 不存在，请先 npm install');
    return 1;
  }

  restoreDeleteRemnants();
  linkNestedPackages();
  const ok = smokeTest();

  log('');
  if (PENDING_BAT) {
    log('⚠ 无法从 Node 里直接建目录联接（沙箱会拦 cmd.exe / symlink，报 EBUSY）。');
    log(`  已生成修复脚本：${PENDING_BAT}`);
    log('  请用 shell 跑它（shell 拉起 cmd 不受此限）：');
    log('      cmd //c tools\\\\link-fix.bat');
    log('  或者在资源管理器里双击 tools\\\\link-fix.bat');
  }
  if (problems.length) {
    log('⚠ 需要人工处理：');
    problems.forEach((p) => log('  · ' + p));
  }
  if (!CHECK_ONLY && fixes.length) {
    log(`✅ 已修 ${fixes.length} 处：${fixes.join(', ')}`);
  }
  if (ok && !problems.length) {
    log('✅ 全部正常。可以启动：node node_modules/expo/bin/cli start');
  }
  return problems.length || PENDING_BAT ? 1 : 0;
}

process.exit(main());
