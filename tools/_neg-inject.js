/**
 * 负向验证（临时脚本，跑完删）—— 证明 session-check 的断言真拦得住 bug
 *
 * ⚠⚠ 为什么不在 Node 里 spawn 测试进程：
 *   本沙箱**禁止 Node spawn 任何子进程**（EBUSY、status=null、stdout 全空）。
 *   ⇒ 由**外层 shell** 循环：注入 → 跑测试 → 还原。
 *   本脚本只做「注入 / 还原」，并且自己保证三条自证纪律：
 *     ① 锚点必须存在（找不到就报错退出，不能静默返回原串）
 *     ② 替换后内容必须真的变了
 *     ③ 落盘后读回校验
 *
 * 用法：node tools/_neg-inject.js <caseIndex>   → 注入第 N 个 bug
 *       node tools/_neg-inject.js restore       → 全部还原
 *       node tools/_neg-inject.js list          → 列出用例
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CASES = [
  {
    name: '生命线①：读失败退化成 exists:false（会丢数据）',
    file: 'src/core/store/gitee.js',
    from: "    if (r.failed) {\n      return { exists: false, failed: true, status: r.status || 0, error: r.error || '读取失败' };\n    }",
    to: "    if (r.failed) {\n      return { exists: false };\n    }",
    expect: 'store/gitee.readFile 保留 failed 三态'
  },
  {
    name: '生命线②：写前不重读 sha（另一台设备的改动被抹掉）',
    file: 'src/core/userStore.js',
    from: "  // 生命线②：写前重读最新 sha\n  return store.readFile(uid).then(function (r) {",
    to: "  // 生命线②被拿掉了\n  return Promise.resolve({ exists: true, sha: 'STALE' }).then(function (r) {",
    expect: '发生了竞态回退（raced / refetched）'
  },
  {
    name: 'pathOf 空 uid 出路径（所有空 uid 共用一个文件）',
    file: 'src/core/userStore.js',
    from: "  return s ? s + '.json' : '';",
    to: "  return s + '.json';",
    expect: 'pathOf 空 uid → 空串'
  },
  {
    name: 'uidOf 不认 deviceCode（RN 登录态字段）',
    file: 'src/core/userStore.js',
    from: "  const anon = session.anonymousCode || session.anonymousId || session.deviceCode;",
    to: "  const anon = session.anonymousCode || session.anonymousId;",
    expect: 'uidOf 认 deviceCode（RN 侧登录态字段）'
  },
  {
    name: 'take() 取完即清（结果页闪空态那个 bug）',
    file: 'src/core/chartBus.js',
    from: "function take() {\n  if (pending) {\n    current = pending;\n    pending = null;\n  }\n  return current;\n}",
    to: "function take() {\n  const v = pending || current;\n  pending = null;\n  current = null;\n  return v;\n}",
    expect: '第二次 take 仍拿到同一份'
  },
  {
    name: 'pull 读失败降级成空列表（丢数据）',
    file: 'src/core/history.js',
    from: "        return { ok: false, reason: 'cloud-error', error: res.error };",
    to: "        return { ok: true, records: [] };",
    expect: '读失败时 pull 返回 ok:false'
  },
  {
    name: 'saveNotes 找不到就偷偷补一条',
    file: 'src/core/history.js',
    from: "      if (!hit) {\n        return {\n          abort: { ok: false, reason: 'not-found', error: '云端没有这条记录（列表可能已过期）' }\n        };\n      }",
    to: "      if (!hit) {\n        return { abort: { ok: true } };\n      }",
    expect: '不存在的 id → ok:false'
  },
  {
    name: 'boot 不广播 creating（文件级少了那一步）',
    file: 'src/core/boot.js',
    from: "    if (e.created && !quiet) publish(STAGE.CREATING, TEXT.creating);",
    to: "    if (false) publish(STAGE.CREATING, TEXT.creating);",
    expect: '阶段里有 creating（文件级才有的那一步）'
  },
  {
    name: '设备码不粘住（每次登录换新 uid = 记录凭空消失）',
    file: 'src/core/auth.js',
    from: "  const prev = readAnon();\n  if (prev) return prev;\n  return writeAnon(fresh || makeDeviceCode());",
    to: "  return writeAnon(fresh || makeDeviceCode());",
    expect: '设备码粘住（两次登录同一码）'
  },
  {
    name: 'logout 顺手清了设备码（记录又「丢」一次）',
    file: 'src/core/auth.js',
    /* ⚠ 2026-10-02：logout() 在「登录方式换成账号密码」时前面插了 CloudBase 两行，
       锚点跟着更新（否则 inject 报「锚点不存在」，而看起来像「测试没抓到」）。 */
    from: "  if (useCloudbase()) session.clear();\n  try { storage.removeStorageSync(KEY); storage.persistKey(KEY).catch(() => {}); }",
    to: "  if (useCloudbase()) session.clear();\n  try { storage.removeStorageSync(KEY); storage.removeStorageSync(ANON_KEY); storage.persistKey(KEY).catch(() => {}); }",
    expect: 'logout 后设备码仍在'
  },
  {
    name: 'writeCache 存对象不序列化（缓存写了读不到）',
    file: 'src/core/boot.js',
    from: "    storage.setAndPersist(CLOUD_KEY, JSON.stringify({ uid: uid, path: path || '', at: Date.now() }));",
    to: "    storage.setAndPersist(CLOUD_KEY, { uid: uid, path: path || '', at: Date.now() });",
    expect: '核对成功后 lastKnown 有值',
    allowMiss: true   // platform/storage.js 的 encode() 现在会兜住，未必测得出
  },
  {
    name: 'push 覆盖同 id 时不去重（列表长重复）',
    file: 'src/core/history.js',
    from: "      const kept = rows.filter(function (r) {\n        if (r.id === slim.id) { created = false; return false; }\n        return true;\n      });",
    to: "      const kept = rows.slice();",
    expect: '同 id 覆盖后仍然是 2 条（不是 3 条）'
  }
];

const MARK = '.nv-state.json';

function stateFile() { return path.join(ROOT, MARK); }

/**
 * 备份路径**必须带用例下标**。
 * ⚠⚠ 本项目的铁律。曾漏掉：多个用例会共用同一个源文件
 *   （auth.js / history.js 都各有多条用例），不带下标的话备份路径完全一样，
 *   「扫全表」时会把这些用例下标全当成 pending，`RESTORED n files` 的数就不可信了。
 */
function backupPath(i) { return path.join(ROOT, CASES[i].file + '.nv-backup.' + i); }

function absOf(i) { return path.join(ROOT, CASES[i].file); }

function saveState() {
  const cur = [];
  CASES.forEach((c, i) => {
    if (fs.existsSync(backupPath(i))) cur.push(i);
  });
  fs.writeFileSync(stateFile(), JSON.stringify(cur));
}

/**
 * 该还原哪些用例？
 *
 * ⚠⚠ 不能只信 state 文件 —— state 是「快照」，**文件系统才是真相**。
 *   踩过：备份还在盘上、state 已被删 ⇒ restore 报 `RESTORED 0 files`，
 *   残留文件却留在源码目录里，下一轮 inject 才撞上。
 *   ⇒ 取「state file ∪ 实际存在的备份文件」的并集，宁可多扫不可漏。
 */
function loadState() {
  const set = new Set();
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    (JSON.parse(raw) || []).forEach((i) => set.add(i));
  } catch (e) { /* state 不存在或坏掉都不影响：下面直接扫全表 */ }
  CASES.forEach((c, i) => { if (fs.existsSync(backupPath(i))) set.add(i); });
  return Array.from(set).sort((a, b) => a - b);
}

function inject(i) {
  const c = CASES[i];
  if (!c) throw new Error('没有第 ' + i + ' 个用例');
  const abs = absOf(i);
  const orig = fs.readFileSync(abs, 'utf8');

  /* ① 锚点必须存在 */
  if (orig.indexOf(c.from) < 0) {
    throw new Error('⚠ 锚点不存在（注入脚本自己错了，不是断言测不出来）：' + c.file);
  }
  /* ② 替换后必须真的变了 */
  const injected = orig.replace(c.from, c.to);
  if (injected === orig) {
    throw new Error('⚠ replace 静默返回原串（负向验证假绿！）：' + c.name);
  }
  if (!fs.existsSync(backupPath(i))) fs.writeFileSync(backupPath(i), orig);
  fs.writeFileSync(abs, injected);

  /* ③ 落盘后读回校验 */
  const readback = fs.readFileSync(abs, 'utf8');
  if (readback !== injected) throw new Error('⚠ 落盘后内容不一致：' + c.file);

  saveState();
  console.log('INJECTED [' + i + '] ' + c.name);
  console.log('  file=' + c.file + ' expect=«' + c.expect + '»');
}

function restore(i) {
  const abs = absOf(i);
  const b = backupPath(i);
  if (!fs.existsSync(b)) return false;
  const orig = fs.readFileSync(b, 'utf8');
  fs.writeFileSync(abs, orig);
  /* ⚠⚠ 顺序不能反：先**逐字节校验通过**，才允许删备份。
     曾经写成「写回 → 读回 → unlink → 比」——那样一旦写回不干净，
     备份已经没了，源码就再也回不来了（本项目踩过「假还原」）。
     校验失败时必须把备份**留着**，让人还有第二次机会。 */
  const now = fs.readFileSync(abs, 'utf8');
  if (now !== orig) throw new Error('⚠ 还原不干净（备份已保留，可重试）：' + CASES[i].file);
  stashBackup(b);
  return true;
}

/**
 * 「删掉」备份 —— 实际 renameSync 挪进 `.neg-stash/`，**不是 unlink**。
 * ⚠⚠ 为什么：本机的删除**对下一个进程不可见**（stale FS view）。unlink 后本进程
 *   `existsSync` 是 false，但紧接着**驱动里下一进程**的 orphan 扫描仍看得见该文件
 *   ⇒ 误判「上一轮没还原干净」⇒ 拒绝注入 ⇒ 整轮停在第 1 例。
 *   `_neg-reset-local.js` 早就这么干了（它的文件头有完整说明），这里跟它对齐。
 * ⚠ stash 必须**同盘**：项目在 D 盘、`os.tmpdir()` 在 C 盘 ⇒ 跨盘 rename 报 `EXDEV`。
 */
function stashBackup(b) {
  try {
    const dir = path.join(ROOT, '.neg-stash', 'sess');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(b, path.join(dir, path.basename(b) + '.' + Date.now()));
    return;
  } catch (e) { /* rename 都失败才退回删除 */ }
  fs.unlinkSync(b);
}

function main() {
  const arg = process.argv[2];
  if (arg === 'list') {
    CASES.forEach((c, i) => console.log(i + '\t' + c.name + '\t' + (c.allowMiss ? '(允许漏)' : '')));
    return;
  }
  if (arg === 'restore') {
    const pending = loadState();
    let n = 0;
    pending.forEach((i) => { if (restore(i)) n++; });
    if (fs.existsSync(stateFile())) stashBackup(stateFile());
    console.log('RESTORED ' + n + ' files');
    return;
  }
  if (arg === 'check') {
    /* 锚点预检：一次报全所有失配。
       ⚠ 为什么必须有：锚点失配时 `inject` 直接报错，而外层循环把「没注入成功」
       与「测试没抓到」看成一回事 —— 本日 case [9] 就这么被漏过去了
       （logout 在登录改造时被重写，锚点没跟着更新）。 */
    const bad = [];
    CASES.forEach((c, i) => {
      let src = '';
      try { src = fs.readFileSync(absOf(i), 'utf8'); }
      catch (err) { bad.push(i + '  ' + c.file + '   ← (文件读不到)'); return; }
      if (src.indexOf(c.from) < 0) bad.push(i + '  ' + c.file + '   ←  ' + c.name);
    });
    if (bad.length) {
      console.error('锚点失配 ' + bad.length + ' / ' + CASES.length + ' 例：');
      bad.forEach((b) => console.error('  ' + b));
      process.exit(1);
    }
    console.log('ANCHOR-OK 全部 ' + CASES.length + ' 例的锚点都在');
    return;
  }
  if (arg === 'heal') {
    /* ⚠⚠ 为什么需要这个：备份里存的是「注入时刻」的内容**快照**。
       万一某个备份是在源码已经被别的用例改坏之后才建的，那它就是一份
       **叠加了多次注入的脏内容**；一轮 restore 就会把这一堆脏改动整体写回源码。
       2026-10-02 实际发生过：userStore.js / history.js / boot.js 被写成了
       叠加 2~3 个注入的状态（`expect` 反而看起来都对得上，因为测试确实在红）。
       好在注入都是**精确字符串替换**，所以可以逐条反向：若 `to` 在而 `from` 不在，
       说明这一例正生效 ⇒ 把 `to` 换回 `from`。
       ⚠ 若 `from` 也在（说明是 `to ⊆ from` 那种包含关系），一律跳过，不能误改。 */
    const fixed = [];
    CASES.forEach((c, i) => {
      const abs = absOf(i);
      let src;
      try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
      const at = src.indexOf(c.to);
      if (at < 0) return;
      if (src.indexOf(c.from) >= 0) return;
      const next = src.slice(0, at) + c.from + src.slice(at + c.to.length);
      if (next === src) return;
      fs.writeFileSync(abs, next);
      fixed.push(i + '  ' + c.file + '  ← ' + c.name);
    });
    console.log('HEALED ' + fixed.length + ' 处：');
    fixed.forEach((f) => console.log('  ' + f));
    return;
  }
  inject(parseInt(arg, 10));
}

try {
  main();
} catch (err) {
  console.error('NEG-ERROR: ' + ((err && err.message) || err));
  process.exit(1);
}
