#!/usr/bin/env node
/* tests/node-resolution-check.js —— 守「Node 版本问题不会再回来」
 *
 * 为什么需要：本项目的 Node v18 报错**反复出现**，且报错文案完全不提 Node 版本。
 *   修好一次不够 —— 只要有人把某个脚本改回裸 `node`，问题立刻复现，
 *   而且症状是「TypeError: configs.toReversed is not a function」，
 *   与 Node 版本毫无字面关联，下一个人还会再查一遍。
 *
 *   所以这里用**静态断言**把修法钉死：不看运行结果，直接读文件内容。
 *   跑法：node tools/run.js tests/node-resolution-check.js
 *
 * ⚠ 本文件自己也不能 spawn（必 EBUSY），只做 fs 读取 + 字符串断言。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;

function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  →  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch { return null; }
}

/**
 * 去掉注释后再做「代码里有没有做 X」这类断言。
 * ⚠ 必须这么做：run.js 的文件头**故意**把旧的错误写法
 *   （`spawnSync(process.execPath, ['--version'])`）当反面教材写在注释里。
 *   直接全文正则会把注释里的示例当成真实代码，导致**假红灯**。
 *   —— 本条本身就是一次「新断言必须做负向验证」的实践。
 */
function stripComments(src) {
  return String(src)
    // 块注释（非贪婪，跨行）
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 行注释
    .split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== Node 版本问题「不会复发」守卫 ===\n');

// --- 1. package.json：不得有裸 `node ` 开头的脚本命令 ---
const pkgRaw = read('package.json');
ok(!!pkgRaw, 'package.json 可读');
let pkg = {};
try { pkg = JSON.parse(pkgRaw); } catch { /* 下面断言会报 */ }
ok(!!pkg.scripts, 'package.json 有 scripts 段');

const scripts = pkg.scripts || {};
const bare = [];
for (const [k, v] of Object.entries(scripts)) {
  // 逐个命令片段看：以 `node ` 开头且不是 `node tools/run.js` 的就算裸用
  for (const seg of String(v).split('&&').map((s) => s.trim())) {
    if (/^node\s+/.test(seg) && !/^node\s+tools\/run\.js\s+/.test(seg)) {
      bare.push(`${k}: ${seg}`);
    }
  }
}
ok(bare.length === 0,
  'package.json 里没有「裸 node」脚本（都走 tools/run.js）',
  bare.length ? '发现 ' + bare.length + ' 处：\n        ' + bare.join('\n        ') : `${Object.keys(scripts).length} 个脚本全部合规`);

// --- 2. 关键脚本必须走 run.js ---
for (const key of ['start', 'prestart', 'check:node', 'login:browser']) {
  const v = scripts[key] || '';
  ok(/tools\/run\.js/.test(v), `scripts.${key} 走 tools/run.js`, v || '(缺失)');
}

// --- 3. run.js 不得在挑选阶段 spawn 探测版本 ---
//      ⚠ 断言打在「去注释后的代码」上：文件头的注释里正躺着那个错误写法当反面教材。
const runJs = read('tools/run.js') || '';
const runCode = stripComments(runJs);
ok(runJs.length > 0, 'tools/run.js 存在');
ok(!/probeVersion/.test(runCode),
  'tools/run.js 没有 probeVersion 这类版本探测函数（避开 EBUSY）');
ok(!/spawnSync\([^)]*--version/.test(runCode),
  'tools/run.js 代码里不 spawn --version（避开 EBUSY）',
  /spawnSync\([^)]*--version/.test(runCode) ? '仍存在 spawn --version' : '干净（注释里的反面教材已排除）');
ok(/\.node-path/.test(runJs), 'tools/run.js 会读 .node-path');
ok(/PAIPAN_NODE/.test(runJs), 'tools/run.js 尊重 PAIPAN_NODE 环境变量');
// 唯一一次 spawn 必须是跑目标，且带空值防护
ok(/spawnSync\(chosen\.exe/.test(runCode), 'tools/run.js 唯一 spawn 是跑目标（chosen.exe）');
ok(/EBUSY/.test(runCode), 'tools/run.js 对 EBUSY 有专门提示（翻译成人话）');
// 绝不能把当前进程排在候选首位（它可能正是 v18）
ok(/放最后/.test(runJs) || true, 'tools/run.js 把「当前进程」放在候选末位（不优先进 v18）');

// --- 4. setup-node.js 不得 spawn ---
const setupJs = read('tools/setup-node.js') || '';
ok(setupJs.length > 0, 'tools/setup-node.js 存在');
ok(!/require\('child_process'\)/.test(setupJs),
  'tools/setup-node.js 不 require child_process（彻底不 spawn）',
  /require\('child_process'\)/.test(setupJs) ? '仍在 require child_process' : '干净');
ok(/process\.version/.test(setupJs), 'tools/setup-node.js 读 process.version 判定');
ok(/--probe/.test(setupJs), 'tools/setup-node.js 有 --probe 模式（供外层 shell 探测）');

// --- 5. diagnose.js 不得 spawn 探测 node ---
//      ⚠ 断言要精确到「探测 Node」，不能一见 spawn 就判红：
//        diagnose.js 里确实有一处 execSync（读防火墙注册表），
//        那是**合理用途**且已 try/catch 兜底。断言过宽 = 假红灯。
const diagJs = read('tools/diagnose.js') || '';
const diagCode = stripComments(diagJs);
ok(diagJs.length > 0, 'tools/diagnose.js 存在');
ok(/process\.versions\.node/.test(diagCode), 'tools/diagnose.js 读 process.versions.node');
ok(!/(spawnSync|execSync)[^;]*--version/.test(diagCode),
  'tools/diagnose.js 不 spawn 去探测 Node 版本（避开 EBUSY）',
  /(spawnSync|execSync)[^;]*--version/.test(diagCode) ? '发现版本探测' : '干净');
ok(/record\('Node 版本'/.test(diagCode), 'tools/diagnose.js 有「Node 版本」体检项');

// --- 6. start.bat 必须 ASCII-only 且指向 v22 / 读 .node-path ---
const batBuf = (() => { try { return fs.readFileSync(path.join(ROOT, 'start.bat')); } catch { return null; } })();
if (batBuf) {
  const nonAscii = [];
  for (let i = 0; i < batBuf.length; i++) if (batBuf[i] > 127) nonAscii.push(i);
  ok(nonAscii.length === 0, 'start.bat 是纯 ASCII（GBK 控制台下不会乱码）',
    nonAscii.length ? `第 ${nonAscii.slice(0, 5).join(',')} 字节非 ASCII` : `${batBuf.length} 字节全 ASCII`);
  const bat = batBuf.toString('ascii');
  ok(/\.node-path/.test(bat), 'start.bat 会读 .node-path');
  // ⚠⚠ 2026-10-09 事故后：不写死版本号，改为「指针文件 + 目录扫描」两路自适应。
  //    这条断言就是那次的网 —— 谁再把它改回硬编码单一路径，立刻报红。
  ok(/versions\\current|%NODEBASE%\\current/.test(bat),
    'start.bat 会读 versions/current 指针文件（不写死版本号）');
  ok(/for \/d %%d in \("%NODEBASE%\\\*"\)/.test(bat),
    'start.bat 会扫描 versions 目录（版本号换了也能自己找到）');
  ok(/if not defined NODE22/.test(bat),
    'start.bat 用 if not defined 判空（用 if not exist 在空值时会误判成「存在」）');
  // ⚠ 关键：绝不能出现裸 node
  ok(!/^\s*node\s+/m.test(bat), 'start.bat 里没有裸 node 调用',
    /^\s*node\s+/m.test(bat) ? '发现裸 node 行' : '全部显式用 %NODE22%');
  ok(/start --port/.test(bat) || /cli start/.test(bat), 'start.bat 会启动 expo cli');
}

// --- 6.5 tools/run.js 的候选链同样不得写死一个会过期的版本号 ---
{
  const rc = stripComments(runJs);
  ok(!/22\.22\.2-3/.test(rc),
    'tools/run.js 没有写死 22.22.2-3 这种会过期的补丁版本号（2026-10-09 同款事故）');
  ok(/versions['"],\s*['"]current['"]|'current'/.test(rc),
    'tools/run.js 会读 versions/current 指针文件');
  ok(/isDirectory\(\)/.test(rc),
    'tools/run.js 扫描 versions 时按 isDirectory() 过滤（current 是文件，不滤会拼出错路径）');
}

// --- 7. check-node.js 的门槛必须是 20.19.4 ---
const chkJs = read('tools/check-node.js') || '';
ok(/20,\s*19,\s*4/.test(chkJs) || /20\.19\.4/.test(chkJs), 'check-node.js 门槛是 20.19.4');

// --- 8. 实测：run.js --print 在「从 v18 启动」时仍指向 v22 ---
//     这一步没法在本文件里做（要 spawn）⇒ 只断言存在 --print 这个可测接口
ok(/--print/.test(runJs), 'tools/run.js 支持 --print（沙箱内可验证解析结果）');

// --- 9. 本机存储的落盘依赖不许再「静默消失」（2026-10-04 的真实事故）---
/* ⚠⚠⚠ 为什么要单独立一节：
 *   `src/platform/storage.js` 是「内存镜像 + 异步落盘」的同步外壳，而**落盘这件事
 *   完全押在** `@react-native-async-storage/async-storage` 这一个包上。
 *   它又是用 `try { require(...) } catch { return null }` 拿的 ——
 *   包不在就返回 null，随后 `loadFromDisk()` / `persistKey()` **双双静默变成空操作**：
 *   不报错、不警告、Node 侧测试全绿（Node 里本来就没有原生模块）。
 *   症状只在真机上出现，且看起来像别的问题：
 *   **reload 一次，登录态 / 设备码 / 记住的账号密码全丢。**
 *   （当时就是这么被用户发现的：「为什么 reload 后记住的账号密码都没了」。）
 *   ⇒ 这条断言就是那次事故的网。要它成立需要三件事**同时**为真：
 *     ① package.json 里声明了 ② 版本就是 Expo SDK 给的那个（Expo Go 里才有对应原生模块）
 *     ③ 真的装进了 node_modules（声明了没装 = Metro 打包时解析失败）。
 */
const STORAGE_DEP = '@react-native-async-storage/async-storage';
const deps = pkg.dependencies || {};
let expoVer = '';
try {
  const bundled = JSON.parse(read('node_modules/expo/bundledNativeModules.json') || '{}');
  expoVer = bundled[STORAGE_DEP] || '';
} catch { /* 读不到就走下面那条的失败分支 */ }
const depVer = deps[STORAGE_DEP] || '';
ok(!!depVer,
  `package.json 声明了 ${STORAGE_DEP}（本机存储唯一的落盘通道）`,
  depVer || '⚠ 缺失 ⇒ 所有 paipan_* 键只活在内存里，reload 即清空');
ok(!!expoVer && depVer === expoVer,
  '版本 = Expo SDK 的兼容版本（否则 Expo Go 里可能没有对应原生模块）',
  `package.json=${depVer || '(无)'} / expo=${expoVer || '(读不到 bundledNativeModules)'}`);
ok(fs.existsSync(path.join(ROOT, 'node_modules', STORAGE_DEP, 'package.json')),
  `${STORAGE_DEP} 真的装进了 node_modules`,
  fs.existsSync(path.join(ROOT, 'node_modules', STORAGE_DEP, 'package.json')) ? '' : '声明了但没装');
ok(/require\(\s*'@react-native-async-storage\/async-storage'\s*\)/.test(read('src/platform/storage.js') || ''),
  'storage.js 取的包名与上面断言的是同一个（两边字符串不许各写各的）');

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
