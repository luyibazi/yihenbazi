/**
 * 负向验证（临时脚本，跑完删）—— 证明 cloudbase-check 的断言真拦得住 bug
 *
 * 与 _neg-inject.js 同构，区别只是**守的对象不同**：
 *   那个守小程序侧（session-check），这个守 CloudBase 这一轮新写的东西
 *   （cbsdk / session / cbdb / auth）。
 *
 * ⚠⚠ 为什么不在 Node 里 spawn 测试进程：
 *   本沙箱**禁止 Node spawn 任何子进程**（EBUSY、status=null、stdout 全空）。
 *   ⇒ 由**外层 shell** 循环：注入 → 跑测试 → 还原。
 *   本脚本只做「注入 / 还原」，并自带四条自证纪律：
 *     ① 锚点必须存在（找不到就报错退出，不能静默返回原串）
 *     ② 替换后内容必须真的变了
 *     ③ 落盘后读回校验
 *     ④ restore **先逐字节校验通过、才删备份**（_neg-inject.js 那边曾经写反过）
 *
 * 用法：node tools/_neg-cloudbase.js <caseIndex>   → 注入第 N 个 bug
 *       node tools/_neg-cloudbase.js restore       → 全部还原
 *       node tools/_neg-cloudbase.js list          → 列出用例
 *       node tools/_neg-cloudbase.js check         → 预检所有用例的锚点是否还在（改过源码后先跑它）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CASES = [
  {
    name: '取码顺序反了：取小写 error 而不是大写 code（INVALID_ARGUMENT 永远认不出）',
    file: 'src/core/cbsdk.js',
    from: "          const code = (body && (body.code || body.error)) || ('HTTP_' + status);",
    to: "          const code = (body && (body.error || body.code)) || ('HTTP_' + status);",
    expect: '取码顺序：取大写的 code'
  },
  {
    name: '错误文案拿英文原文兜底（把 malformed jwt 甩到界面上）',
    file: 'src/core/cbsdk.js',
    from: "  if (fallback && /[\\u4e00-\\u9fa5]/.test(fallback) && fallback.indexOf('%!(') < 0) return fallback;",
    to: "  if (fallback) return fallback;",
    expect: '未知码 + 英文描述 → 仍是中文'
  },
  {
    name: '不过滤 %!( 脏数据（服务端格式化失败的产物直接显示）',
    file: 'src/core/cbsdk.js',
    from: "  if (fallback && /[\\u4e00-\\u9fa5]/.test(fallback) && fallback.indexOf('%!(') < 0) return fallback;",
    to: "  if (fallback && /[\\u4e00-\\u9fa5]/.test(fallback)) return fallback;",
    expect: '夹着 %!( 的脏数据 → 不采用它'
  },
  {
    name: '凭证失效判据只看 HTTP 状态码（实测真过期回的是 500，会被当成网络抖动）',
    file: 'src/core/session.js',
    from: "  const code = String((r && r.code) || '').toLowerCase();\n  if (code === 'invalid_grant' || code === 'invalid_token' || code === 'unauthenticated') return true;\n  const desc = String((r && r.data && (r.data.error_description || r.data.message)) || '').toLowerCase();\n  return /invalid token|invalid jwt|malformed jwt|token header|token has expired|token expired|invalid_grant/.test(desc);",
    to: "  return !!(r && (r.status === 400 || r.status === 401));",
    expect: '标记为 EXPIRED（要用户重新登录）'
  },
  {
    name: '反过来：把 5xx 一律当成凭证过期（一次服务端抖动清掉所有人的登录态）',
    file: 'src/core/session.js',
    from: "  const code = String((r && r.code) || '').toLowerCase();\n  if (code === 'invalid_grant' || code === 'invalid_token' || code === 'unauthenticated') return true;\n  const desc = String((r && r.data && (r.data.error_description || r.data.message)) || '').toLowerCase();\n  return /invalid token|invalid jwt|malformed jwt|token header|token has expired|token expired|invalid_grant/.test(desc);",
    to: "  const code = String((r && r.code) || '').toLowerCase();\n  if (code === 'invalid_grant') return true;\n  return !!(r && r.status >= 500);",
    expect: '但不标记成 EXPIRED（500 ≠ 凭证过期，归入「可重试」）'
  },
  {
    name: 'httpFail 不认 DATABASE_42501（RLS 拒绝被说成「登录已过期」）',
    file: 'src/core/store/cbdb.js',
    from: "  if (code === 'DATABASE_42501' || code === 'PERMISSION_DENIED') {\n    error = '没有权限修改这份数据';\n  } else if (code === 'MISSING_CREDENTIALS' || code === 'INVALID_TOKEN' || code === 'UNAUTHENTICATED') {",
    to: "  if (false) {\n    error = '没有权限修改这份数据';\n  } else if (code === 'MISSING_CREDENTIALS' || code === 'INVALID_TOKEN' || code === 'UNAUTHENTICATED') {",
    expect: 'RLS 拒绝（实测形状 401 + DATABASE_42501）说「没有权限」，不是「登录已过期」'
  },
  {
    name: '刷新不做并发去重（refresh_token 用过即废 → 第二个请求必然失败）',
    file: 'src/core/session.js',
    from: "  if (inflight) return inflight;",
    to: "  if (false) return inflight;",
    expect: '只发了 1 次刷新请求'
  },
  {
    name: '写入时不带 owner（upsert 冲突键不完整 + 落到别人的桶里）',
    file: 'src/core/store/cbdb.js',
    from: "  const body = toRow(slim, session.uid() || uid);",
    to: "  const body = toRow(slim, '');",
    /* ⚠ 命中的是「写入成功」而不是「行里的 owner 是服务端认的 sub」：
       桩忠实复刻了 RLS（WITH CHECK owner = auth.uid()），owner 为空 ⇒ 写入直接被
       401 拒掉，测试在到达「行里的 owner…」那条断言之前就已经失败（后者还会因为
       cb.rows[0] 是 undefined 而抛异常）。所以最早的可判定症状就是这条。 */
    expect: '写入成功'
  },
  {
    name: '读失败降级成 ok:true + 空列表（上层当成「云端没有」→ 覆盖 = 丢数据）',
    file: 'src/core/store/cbdb.js',
    from: "      if (!r.ok) return httpFail(r, '读取云端记录');",
    to: "      if (!r.ok) return { ok: true, records: [] };",
    expect: '读遇 500 → ok:false'
  },
  {
    name: '未登录时也给设备码当身份（会去打接口被 401，报成「没有权限」）',
    file: 'src/core/auth.js',
    from: "      cloudbaseUid: session.uid(),   // 没登录就是空串，上层据此判「未登录」\n      unionid: '',\n      openid: '',\n      anonymousCode: ''",
    to: "      cloudbaseUid: session.uid(),   // 没登录就是空串，上层据此判「未登录」\n      unionid: '',\n      openid: '',\n      anonymousCode: readAnon()",
    expect: '未登录时 getIdentity() 不给设备码'
  },
  {
    name: '手机号不加那个空格（+8613800138000，服务端正则直接拒）',
    file: 'src/core/cbsdk.js',
    from: "  return '+86 ' + m[1];",
    to: "  return '+86' + m[1];",
    expect: '裸号码 → 补 +86 前缀'
  },
  {
    name: 'SELECT 把 owner 也带回来（权限列漏进业务层）',
    file: 'src/core/store/cbdb.js',
    from: "const SELECT = 'id,name,gender,birth_date,birth_time,created_at,notes';",
    to: "const SELECT = 'id,name,gender,birth_date,birth_time,created_at,notes,owner';",
    expect: 'select 里不含 owner'
  },
  {
    name: '⚠⚠ ensureLogin 恢复「尊重 force」⇒ 已登录时 whoami 必然失败（用户被误判成未登录）',
    file: 'src/core/auth.js',
    from: `    if (session.hasSession()) {\n      // 有凭证 → 确认它**此刻真的能用**（顺带触发一次自动续期）`,
    to: `    if (!force && session.hasSession()) {\n      // 有凭证 → 确认它**此刻真的能用**（顺带触发一次自动续期）`,
    expect: '已登录时 ensureLogin(true) 必须 ok'
  },
  {
    name: '⚠⚠ subFromJwt 改走 JSON.parse ⇒ 19 位雪花数字丢低位（uid 与 owner 对不上，静默读不到数据）',
    file: 'src/core/cbsdk.js',
    from: `    const m = /"sub"\\s*:\\s*"?([A-Za-z0-9_\\-.:|]+)"?/.exec(json);\n    return m ? m[1] : '';`,
    to: `    const p = JSON.parse(json);\n    return p && p.sub !== undefined && p.sub !== null ? String(p.sub) : '';`,
    expect: '19 位裸数字时**不丢精度**'
  },
  {
    name: '⚠⚠ saveNotes 少传 p_notes ⇒ PostgREST 按参数名匹配不到函数（404 PGRST202，而不是「参数为空」）',
    file: 'src/core/store/cbdb.js',
    from: '      p_notes: (notes && typeof notes === \'object\') ? notes : null',
    to: '      p_notes: void 0',
    expect: 'saveNotes 成功'
  },
  {
    name: '⚠⚠ httpFail 不认 DATABASE_P0002（「记录不存在」被说成网络故障 → 用户重试到死）',
    file: 'src/core/store/cbdb.js',
    from: "  if (code === 'DATABASE_P0002') {",
    to: '  if (false) {',
    expect: 'reason 是 not-found'
  },
  {
    name: '⚠⚠ saveNotes 退回旧写法：先 listRecords 拉全表再写（白拉一次 + 并发互相覆盖）',
    file: 'src/core/history.js',
    from: '      return userStore.saveNotes(who.uid, id, notes).then(function (w) {',
    to: '      return userStore.listRecords(who.uid).then(function () { return userStore.saveNotes(who.uid, id, notes); }).then(function (w) {',
    expect: '不再 GET 全表'
  },
  {
    name: '⚠⚠ SELECT 清单漏掉 notes（读回来的记录没有事件 = 静默抹掉别人的录入）',
    file: 'src/core/store/cbdb.js',
    from: "const SELECT = 'id,name,gender,birth_date,birth_time,created_at,notes';",
    to: "const SELECT = 'id,name,gender,birth_date,birth_time,created_at';",
    expect: '带着 notes'
  },

  /* ---------- 2026-10-02：登录方式换成「账号 + 密码」后新增的三条 ---------- */
  {
    /* 平台回的是 501 + UNIMPLEMENTED，映射表里少一条 ⇒ 界面冒出英文黑话。 */
    name: '错误映射表删掉 UNIMPLEMENTED（平台 501 时界面出现英文原文）',
    file: 'src/core/cbsdk.js',
    from: "    UNIMPLEMENTED: '这个方式暂不支持，请联系管理员',\n",
    to: "",
    expect: '└ 文案说「这个方式暂不支持，请联系管理员」'
  },
  {
    /* 登录成功却**没把账号名写进登录态** ⇒ 设置页的账号行永远是空白。
       ⚠ 锚点跟着源码演进过：`cbsdk.` → `s.`（sdk() 选出的那个），
         `r.tokens` → `r.tokens || r.token`（本地只有一个 token）。
         这类「源文件改了、锚点没跟」会以「锚点不存在」报出来 ——
         它不是断言测不出来，是注入脚本自己过期了。 */
    name: '⚠ 登录成功后没把账号名写进登录态（设置页账号行永远空白）',
    file: 'src/core/auth.js',
    from: "    session.save(r.tokens || r.token, {\n      username: s.normalizeUsername(username),\n      deviceCode: deviceId\n    });",
    to: "    session.save(r.tokens || r.token, { deviceCode: deviceId });",
    expect: '⭐ loginUsername() 拿到账号名（设置页读的就是它）'
  },
  {
    /* ⚠⚠ 自动续期走的是 `save(r.tokens)`（不带 extra）——
       不沿用旧账号名 ⇒ 每次续期都把设置页抹成空白，且只在真机上过一阵才出现。 */
    name: '⚠⚠ save() 不沿用 username（自动续期一次，设置页账号名就没了）',
    file: 'src/core/session.js',
    from: "  else if (prev && prev.username) next.username = prev.username;\n",
    to: "",
    expect: '⭐⭐ 续期后账号名仍在（save 不带 extra ⇒ 必须沿用旧值）'
  }
];

const MARK = '.nv-cb-state.json';

function stateFile() { return path.join(ROOT, MARK); }
/**
 * 备份路径**必须带用例下标**。
 * ⚠⚠ 这条是本项目早就记下的铁律，这里曾经漏掉：多个用例会共用同一个源文件
 *   （[0][1][2][10] 都是 src/core/cbsdk.js），不带下标的话备份路径完全一样，
 *   于是「扫全表」时会把共用该文件的所有用例下标都当成 pending
 *   —— `RESTORED n files` 的数字从此不可信（真实还原 1 个却列出 4 个）。
 */
function backupPath(i) { return path.join(ROOT, CASES[i].file + '.nvcb-backup.' + i); }
function absOf(i) { return path.join(ROOT, CASES[i].file); }

function saveState() {
  const cur = [];
  CASES.forEach((c, i) => { if (fs.existsSync(backupPath(i))) cur.push(i); });
  fs.writeFileSync(stateFile(), JSON.stringify(cur));
}

/**
 * 该还原哪些用例？
 *
 * ⚠⚠ 不能只信 state 文件 —— state 是「快照」，**文件系统才是真相**。
 *   实测踩到过：备份还在盘上、state 已被删 ⇒ restore 报 `RESTORED 0 files`、
 *   却把残留文件留在源码目录里。下一轮 inject 才撞上它报「发现残留备份」，
 *   而人看到的是「上一轮的问题」，根本查不到是 restore 自己漏了。
 *   ⇒ 所以这里取「state file ∪ 实际存在的备份文件」的并集，宁可多扫不可漏。
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

  /* ⚠ 注入前发现残留备份 → 必须拒绝（说明上一轮没还原干净，再注入会污染基线） */
  if (fs.existsSync(backupPath(i))) {
    throw new Error('⚠ 发现残留备份（上一轮没还原干净），先跑 restore：' + c.file);
  }

  const orig = fs.readFileSync(abs, 'utf8');

  /* ① 锚点必须存在 */
  if (orig.indexOf(c.from) < 0) {
    throw new Error('⚠ 锚点不存在（注入脚本自己错了，不是断言测不出来）：' + c.file + ' ← ' + c.name);
  }
  /* ② 替换后必须真的变了 */
  const injected = orig.replace(c.from, c.to);
  if (injected === orig) {
    throw new Error('⚠ replace 静默返回原串（负向验证假绿！）：' + c.name);
  }
  fs.writeFileSync(backupPath(i), orig);
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
  /* ⚠⚠ 先校验通过、才删备份。反过来的话，一次写回不干净就永久失去恢复能力。 */
  const now = fs.readFileSync(abs, 'utf8');
  if (now !== orig) throw new Error('⚠ 还原不干净（备份已保留，可重试）：' + CASES[i].file);
  stashBackup(b);
  return true;
}

/**
 * 「删掉」备份 —— 实际 renameSync 挪进 `.neg-stash/`，**不是 unlink**（理由同 _neg-inject.js）。
 * ⚠ stash 必须**同盘**（项目 D 盘 / `os.tmpdir()` C 盘 ⇒ 跨盘 rename `EXDEV`）。
 */
function stashBackup(b) {
  try {
    const dir = path.join(ROOT, '.neg-stash', 'cb');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(b, path.join(dir, path.basename(b) + '.' + Date.now()));
    return;
  } catch (e) { /* rename 都失败才退回删除 */ }
  fs.unlinkSync(b);
}

function main() {
  const arg = process.argv[2];
  if (arg === 'list') {
    CASES.forEach((c, i) => console.log(i + '\t' + c.name));
    // ⚠ 总数自报：外层 shell 循环的范围由它决定，**别再手写 `seq 0 N`** ——
    //   本项目因为算少了 2，曾经让最后两条（最关键的两条）根本没被执行，
    //   而输出看起来「跑完了」。
    console.log('--- 共 ' + CASES.length + ' 例（下标 0..' + (CASES.length - 1) + '）');
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
    /* 锚点预检：一次报全所有失配（理由见 _neg-screens.js 的同名分支） */
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
    /* ⚠⚠ 备份存的是「注入时刻」的快照。若某个备份是在源码已被别的用例改坏之后
       才建的，它就是**叠加了多次注入的脏内容**，一轮 restore 会整体写回源码。
       注入都是精确字符串替换 ⇒ 可逐条反向：`to` 在而 `from` 不在 = 这一例正生效。
       ⚠ `from` 也在时（`to ⊆ from` 那类包含关系）一律跳过，不误改。
       详见 _neg-inject.js 同名分支的长注释。 */
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
