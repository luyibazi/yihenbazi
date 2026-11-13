/**
 * 负向验证 —— 证明 `tests/local-check.js` 的断言真拦得住 bug
 *
 * 与 _neg-cloudbase.js / _neg-screens.js / _neg-inject.js 同构，区别只是**守的对象**：
 *   那个守 CloudBase 那条路，这个守**自建 paipan-server** 这一条路
 *   （localsdk / localdb / session 的 local 分支 / auth 的注册守卫）。
 *
 * ⚠⚠ 为什么不在 Node 里 spawn 测试进程：
 *   本沙箱**禁止 Node spawn 任何子进程**（EBUSY、status=null、stdout 全空）。
 *   ⇒ 由**外层 shell** 循环：注入 → 跑测试 → 还原。
 *   本脚本只做「注入 / 还原」，并自带四条自证纪律：
 *     ① 锚点必须存在（找不到就报错退出，不能静默返回原串）
 *     ② 替换后内容必须真的变了
 *     ③ 落盘后读回校验
 *     ④ restore **先逐字节校验通过、才删备份**
 *
 * ⚠⚠ 本文件**没有** `heal` 之外的自动扫描：备份路径带用例下标（铁律①），
 *   且 loadState 取「state ∪ 实际备份文件」的并集。
 *
 * 用法：node tools/_neg-local.js <caseIndex>   → 注入第 N 个 bug
 *       node tools/_neg-local.js restore       → 全部还原
 *       node tools/_neg-local.js list          → 列出用例（含总数自报）
 *       node tools/_neg-local.js check         → 预检所有用例的锚点是否还在（改过源码后先跑它）
 *       node tools/_neg-local.js heal          → 反向写回（治「幽灵备份」，见长注释）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * ⚠⚠ 每条 expect 必须是 `tests/local-check.js` 里**断言文案的逐字副本**
 *   （不是意译），且只在 **FAIL 行**里找它 —— 在整份输出里找的话，
 *   别的用例的 PASS 行会凑出假绿（本项目踩过）。
 *   ⚠ 断言文案一改，**同一次提交必须同步这里的 expect**。
 */
const CASES = [
  /* ================================================================
   * 一、localsdk：规则一致性 / 错误文案 / 永不 reject
   * ================================================================ */
  {
    /* ⚠⚠ 前端那份用户名正则与服务端**必须逐字相同**。
       放宽它 = 前端放行、服务端 400 —— 用户拿到一句他永远改不对的提示。 */
    name: '⚠⚠ 前端用户名正则被放宽（前端放行、服务端 400）',
    file: 'src/core/localsdk.js',
    from: 'const USERNAME_RE = /^[a-z][0-9a-z_-]{5,24}$/;',
    to: 'const USERNAME_RE = /^[a-zA-Z][0-9a-zA-Z_.:+-]{1,47}$/;',
    expect: '⚠ 点号要拒（CloudBase 文档说允许、实测不允许）'
  },
  {
    /* ⚠ 账号大小写不归一 ⇒ 用户把账号记成大写就永远登不上。 */
    name: '账号不转小写（用户把账号记成大写就永远登不上）',
    file: 'src/core/localsdk.js',
    from: "  return String(raw == null ? '' : raw).trim().toLowerCase();",
    to: "  return String(raw == null ? '' : raw).trim();",
    expect: '⚠ 大写要归一后通过（不是直接拒）'
  },
  {
    /* ⚠⚠ 本地后端的错误文案**就该**透传（服务端是我们自己写的，回的就是中文）。
       套一层映射表会把好文案盖掉 —— 与 CloudBase 那边的策略刻意相反。 */
    name: '⚠⚠ 本地错误文案被套上映射表（把服务端给的具体中文盖成通用句）',
    file: 'src/core/localsdk.js',
    from: "  const msg = body && typeof body.error === 'string' ? body.error : '';\n  if (msg) return msg;",
    to: "  const msg = body && typeof body.error === 'string' ? body.error : '';\n  if (false) return msg;",
    expect: 'errText 优先用服务端给的中文原文'
  },
  {
    /* ⚠⚠ 网络失败文案不讲「同一 WiFi / 防火墙 / 服务是否启动」⇒ 用户除了重试什么也做不了。 */
    name: '⚠⚠ 网络失败文案只回一句「请求失败」（用户没法自查）',
    file: 'src/core/localsdk.js',
    from: "  return '连不上服务器。请检查：①手机和电脑是否在同一个 WiFi；②电脑的防火墙是否放行了 4000 端口；③电脑上后端服务是否已启动。';",
    to: "  return '请求失败，请稍后重试';",
    expect: '网络失败提示里点名「防火墙」'
  },
  {
    /* 超时被混进「断网」⇒ 用户不知道是「服务没起」还是「网卡着」。
       ⚠ 注入后 FAIL 的是**码**（NETWORK ≠ TIMEOUT），不是那句文案的比较 ——
         文案比较在同一步里被 ok() 一起判掉了，先报出来的那条才是可检索的。 */
    name: '超时不单独判（把超时也当成普通断网）',
    file: 'src/core/localsdk.js',
    from: "      const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');",
    to: "      const aborted = false;",
    expect: '⚠ 超时 → 码是 TIMEOUT（与 NETWORK 分开）'
  },
  {
    /* ⚠⚠ 只看 status 判成功 ⇒ 中间夹了个代理回 200 + HTML 也会被当成成功。 */
    name: '⚠⚠ 只看 HTTP 2xx 判成功（200 + 一段 HTML 被当成成功）',
    file: 'src/core/localsdk.js',
    from: "          if (status >= 200 && status < 300 && body && body.ok === true) {",
    to: "          if (status >= 200 && status < 300) {",
    expect: '⚠⚠ 200 + 非 JSON → 失败（只看 status 会把一坨 HTML 当成功）'
  },
  {
    /* ⚠⚠ 失败被包成 resolve({ok:true}) ⇒ 上层以为拿到数据了。 */
    name: '⚠⚠ 网络失败被当成成功（ok 恒为 true）',
    file: 'src/core/localsdk.js',
    from: "      return {\n        ok: false, status: 0, code: aborted ? 'TIMEOUT' : 'NETWORK',\n        error: networkHint(aborted)\n      };",
    to: "      return {\n        ok: true, status: 0, code: aborted ? 'TIMEOUT' : 'NETWORK',\n        error: networkHint(aborted)\n      };",
    expect: '⚠ 断网 → ok:false（**永不 reject**）'
  },

  /* ================================================================
   * 二、令牌形状：绝不给本地伪造 refreshToken
   * ================================================================ */
  {
    /* ⚠⚠⚠ 伪造一个 refreshToken ⇒ session 以为能自动续期 ⇒
       用户第 30 天被弹去重新登录，而报错说「续期失败，请检查网络」。 */
    name: '⚠⚠⚠ 给本地伪造一个 refreshToken（用户第 30 天收到「续期失败，请检查网络」）',
    file: 'src/core/localsdk.js',
    from: "      username: d.username || '',\n      /** 秒。服务端给的，别自己编一个默认值 —— 那是两端不一致的起点 */\n      expireIn: d.expireIn || 0",
    to: "      username: d.username || '',\n      /** 秒。服务端给的，别自己编一个默认值 —— 那是两端不一致的起点 */\n      expireIn: d.expireIn || 0,\n      refreshToken: d.token",
    expect: '⚠⚠ 注册**不返回** refreshToken（本地后端没有续期接口）'
  },
  {
    /* ⚠ uid 从响应体取（而非 JWT）⇒ 「两个来源不一致」那类怪问题又回来了。 */
    name: '⚠ uid 改从响应体取（不再以 JWT 为权威）',
    file: 'src/core/localsdk.js',
    from: "      uid: uidFromJwt(d.token) || (d.uid === undefined || d.uid === null ? '' : String(d.uid)),",
    to: "      uid: (d.uid === undefined || d.uid === null ? '' : String(d.uid)) || uidFromJwt(d.token),",
    expect: '⚠⚠⚠ JWT 里的 uid 优先于响应体的 uid（JWT 才是权威）'
  },
  {
    /* ⚠⚠ uid 走 JSON.parse ⇒ 密码/uid 里一旦带引号或转义就崩（本层明确要求正则直抠）。 */
    name: '⚠⚠ uidFromJwt 改走 JSON.parse（可被 payload 里的转义字符带偏）',
    file: 'src/core/localsdk.js',
    from: '    const m = /"uid"\\s*:\\s*"?([A-Za-z0-9_\\-.:|]+)"?/.exec(json);\n    return m ? m[1] : \'\';',
    to: "    const p = JSON.parse(json);\n    return p && p.uid !== undefined && p.uid !== null ? String(p.uid) : '';",
    expect: '⚠⚠⚠ 不是合法 JSON 也照样抠得出 uid（证明没走 JSON.parse）'
  },

  /* ================================================================
   * 三、auth 入口分流 / 注册守卫
   * ================================================================ */
  {
    /* ⚠⚠ canSignUp 在 cloudbase 下也返回 true ⇒ 界面显示注册入口，
       而那条请求 100% 回 501 —— 用户点了「注册」，看到一句看不懂的英文码。 */
    name: '⚠⚠ canSignUp 在 cloudbase 下也放行（显示一个点了必然 501 的注册入口）',
    file: 'src/core/auth.js',
    from: 'function canSignUp() {\n  return useLocal();\n}',
    to: 'function canSignUp() {\n  return useBackend();\n}',
    expect: '⚠⚠ canSignUp() 为 false（平台禁死，501）'
  },
  {
    /* ⚠ 注册守卫被删 ⇒ 在 CloudBase 下去打一个不存在的注册接口（静默 501）。
       ⚠⚠ 锚点必须逐字对应当前源码里那道守卫（含 `const deviceId` 那一行）——
          只写守卫本身的话 heal 会把它写回到错误位置（本项目真踩过：
          守卫被搬到了文件最顶端，md5 对不上但语法还是对的）。 */
    name: '⚠ 删掉注册守卫（在 CloudBase 下去打一个不存在的注册接口）',
    file: 'src/core/auth.js',
    from: "  if (!canSignUp()) {\n    return Promise.resolve({\n      ok: false,\n      code: 'SIGNUP_UNSUPPORTED',\n      error: '当前后端不支持自助注册，请联系管理员开通账号'\n    });\n  }\n  const deviceId = stickyDeviceCode('');",
    to: "  const deviceId = stickyDeviceCode('');",
    /* ⚠⚠ expect 指向**新加的那条 code 断言**，不是 `ok:false` 那条：
       去掉守卫后 localsdk 调用照样失败（也回 ok:false）⇒ 只查 ok 的断言仍绿。
       （这条是负向验证实测挖出来的，见 local-check.js 同处的注释。） */
    expect: '└ 是守卫拦的（code=SIGNUP_UNSUPPORTED），不是网络失败'
  },
  {
    /* ⚠⚠ 本地模式被漏出 useBackend() ⇒ 所有网络分支都进不去（看起来像「没登录」）。 */
    name: '⚠⚠ local 被漏出 hasBackend()（所有网络分支都进不去）',
    file: 'src/core/auth.js',
    from: "  const m = currentMode();\n  return m === 'local' || m === 'cloudbase';",
    to: "  const m = currentMode();\n  return m === 'cloudbase';",
    expect: 'MODE=local 被 hasBackend() 接住'
  },

  /* ================================================================
   * 四、localdb：读失败 ≠ 没数据 / id 在路径 / uid 只认 JWT
   * ================================================================ */
  {
    /* ⚠⚠⚠ 读失败降级成 ok:true + 空数组 —— 上层会把「手机没连上 WiFi」
       当成「云端真没有」，然后拿空列表覆盖 = 丢数据。 */
    name: '⚠⚠⚠ 读失败降级成 ok:true + 空列表（断网 = 丢数据）',
    file: 'src/core/store/localdb.js',
    from: '      if (!r.ok) return r;\n      const d = r.data || {};',
    to: '      if (!r.ok) return { ok: true, records: [] };\n      const d = r.data || {};',
    expect: '⚠⚠ 断网时 pull 返回 ok:false'
  },
  {
    /* ⚠ 形状不符时把 undefined 兜成 [] ⇒ 又一个「读失败伪装成没数据」。 */
    name: '⚠ 对端形状不对时把 records 兜成空数组（读失败伪装成没数据）',
    file: 'src/core/store/localdb.js',
    from: "      if (!Array.isArray(d.records)) {\n        return { ok: false, status: r.status, code: 'BAD_SHAPE', error: '服务器返回的记录格式不对' };\n      }\n",
    to: '',
    expect: '⚠⚠ localdb 校验 records 是数组，不是数组就报 BAD_SHAPE'
  },
  {
    /* ⚠⚠ PUT 的 id 放进 body（不写进路径）⇒ 服务端 404，一条也存不上。 */
    name: '⚠⚠ 写入时把 id 放 body（不走路径 ⇒ 服务端 404）',
    file: 'src/core/store/localdb.js',
    from: "    return sdk.request(BASE + '/' + encodeURIComponent(r0.id), {\n      method: 'PUT',\n      body: { record: r0 },",
    to: "    return sdk.request(BASE, {\n      method: 'PUT',\n      body: { record: r0 },",
    expect: '新增一条 → ok'
  },
  {
    /* ⚠⚠ 没登录时把失败兜成「成功 + 空令牌」⇒ 请求还是会发出去（带空 Bearer），
       服务端 401 —— 表面上 ok 还是 false，于是**断言看不出来**。
       ⇒ 真正能抓住的是「失败分支被整个跳过」：直接返回 ok:true。
       （第一版这里注入的是 `t.token || ''`，实测 0 FAIL = 假用例，已换掉。） */
    name: '⚠⚠ 没登录时也当成成功（跳过失败分支）',
    file: 'src/core/store/localdb.js',
    from: "    if (t && t.ok) return { ok: true, token: t.token };\n    return {\n      ok: false,\n      code: (t && t.code) || 'NO_SESSION',\n      error: (t && t.error) || '还没有登录'\n    };",
    to: "    return { ok: true, token: (t && t.token) || '' };",
    /* ⚠⚠ expect 指向**新加的 code 断言**：注入后请求也会失败（NO_FETCH）⇒
       只查 ok:false 的断言仍绿（负向验证实测挖出来的）。 */
    expect: '└ 是会话层拦的（code=NO_SESSION），不是网络失败'
  },
  {
    /* ⚠⚠ 重复删除报成失败 ⇒ 用户被「删两次」这个动作吓一跳。 */
    name: '⚠⚠ 重复删除报成失败（用户被「删两次」吓一跳）',
    file: 'src/core/store/localdb.js',
    from: "      return { ok: true, deleted: d.deleted === true };",
    to: "      if (d.deleted !== true) return { ok: false, code: 'NOT_FOUND', error: '这条记录不存在' };\n      return { ok: true, deleted: true };",
    expect: '⚠ 重复删除**不算失败**（目标状态已达成）'
  },
  {
    /* ⚠ clearRecords 的 deleted 是**条数**不是布尔 —— 混了上层统计就错。 */
    name: '⚠ clearRecords 把「条数」当布尔回（上层统计从此错）',
    file: 'src/core/store/localdb.js',
    from: "      return { ok: true, deleted: typeof d.deleted === 'number' ? d.deleted : 0 };",
    to: "      return { ok: true, deleted: d.deleted === true };",
    expect: '⚠ deleted 是**条数**（不是布尔，别和 deleteRecord 混）'
  },

  /* ================================================================
   * 五、session：local 模式下**没有续期**
   * ================================================================ */
  {
    /* ⚠⚠⚠ local 模式下 hasRefresh() 返回 true ⇒ getAccessToken 会去发续期请求
       （本地根本没这个接口）⇒ 用户到期时收到「续期失败，请检查网络」。 */
    name: '⚠⚠⚠ hasRefresh() 在 local 下返回 true（去发一个不存在的续期请求）',
    file: 'src/core/session.js',
    from: "    return require('./storeMode.js').MODE !== 'local';",
    to: "    return true;",
    expect: '⚠⚠ local 模式下 hasRefresh() 为 false'
  },
  {
    /* ⚠ 过期判据被删 ⇒ 过期令牌一直被交出去，用户卡在「每次都失败」而没有出口。 */
    name: '⚠ 过期令牌仍被交出去（用户卡在「每次都失败」没有出口）',
    file: 'src/core/session.js',
    from: "    if (s.expireAt && s.expireAt - nowFn() > 0) {\n      return Promise.resolve({ ok: true, token: s.accessToken });\n    }\n    clear();\n    return Promise.resolve({ ok: false, code: 'EXPIRED', error: '登录已过期，请重新登录' });",
    to: "    return Promise.resolve({ ok: true, token: s.accessToken });",
    expect: '⚠ 过期 → ok:false'
  },
  {
    /* ⚠⚠ 过期时不清凭证 ⇒ 下次还是拿这枚废令牌，用户永远出不来（页面一直显示「已登录」）。 */
    name: '⚠⚠ 过期时不 clean 凭证（用户永远出不来这个状态）',
    file: 'src/core/session.js',
    from: "    clear();\n    return Promise.resolve({ ok: false, code: 'EXPIRED', error: '登录已过期，请重新登录' });",
    to: "    return Promise.resolve({ ok: false, code: 'EXPIRED', error: '登录已过期，请重新登录' });",
    expect: '  └ 凭证被清掉了（下次会走到「未登录」而不是一直重试）'
  },
  {
    /* ⚠⚠⚠ uid 只认 `sub` 不认 `uid` ⇒ 本地登录后 uid 恒为空 ⇒
       「登录了却像没登录」。 */
    name: '⚠⚠⚠ session.save 不认 uid 字段（本地登录后 uid 恒空 ⇒ 像没登录）',
    file: 'src/core/session.js',
    from: "  const sub = t.sub || t.uid || '';",
    to: "  const sub = t.sub || '';",
    expect: '⚠⚠⚠ session.save 认了本地后端的 uid 字段（收敛成内部 sub）'
  },

  /* ================================================================
   * 六、storeMode：地址配置
   * ================================================================ */
  {
    /* ⚠⚠⚠ 地址写成 127.0.0.1 ⇒ 手机上指向手机自己，必然连不上，
       而报的是「网络错误」—— 用户会去查 WiFi，永远查不到是这个字面量写错了。 */
    name: '⚠⚠⚠ 地址写成 127.0.0.1（手机上指向手机自己，必然连不上）',
    file: 'src/core/storeMode.js',
    from: "const LOCAL_URL = 'http://192.168.0.103:4000';",
    to: "const LOCAL_URL = 'http://127.0.0.1:4000';",
    expect: '⚠⚠ LOCAL_URL 不是回环地址（手机必须用局域网 IP）'
  },
  {
    /* ⚠ 地址留空 ⇒ 任何云操作都失败，但报的是「未配置」而不是「连不上」。 */
    name: '⚠ 地址留空（界面显示「未配置」而不是「连不上」）',
    file: 'src/core/storeMode.js',
    from: "const LOCAL_URL = 'http://192.168.0.103:4000';",
    to: "const LOCAL_URL = '';",
    expect: '能从 storeMode.js 抠出 LOCAL_URL'
  },
  {
    /* ⚠⚠ CONFIG.base 改成加载时拷贝 ⇒ 改 storeMode 不生效（两处配置漂移）。 */
    name: '⚠⚠ localsdk 的 base 改成加载时拷贝（改 storeMode 不生效）',
    file: 'src/core/localsdk.js',
    from: '  get base() {\n    try {\n      return require(\'./storeMode.js\').LOCAL_URL || \'http://127.0.0.1:4000\';\n    } catch (err) {\n      return \'http://127.0.0.1:4000\';\n    }\n  },',
    to: '  base: \'http://127.0.0.1:4000\',',
    expect: '⚠⚠ localsdk.CONFIG.base 是 **getter**（加载时拷贝的话，测试改 storeMode 不生效）'
  },

  /* ================================================================
   * 二、记录筛选：app 只**传参**，过滤在服务端
   * ================================================================
   * ⚠⚠ 这三条守的都是「筛选这条线断了」的典型形态：
   *   · 驱动不认筛选却硬把参数塞过去（落成 404/报错，用户看到「连不上」）
   *   · 空类别也发出去（变成「我要筛空」⇒ 一条都不显示）
   *   · localdb 把 filter 吞掉（点了没反应，且**不会报错**）
   */
  {
    /* store/index.js 无条件把 filter 透给驱动 ⇒ cloudbase/cloud/gitee 那些
       **没有** listRecordsFiltered 的驱动会当场 TypeError（或 404）。 */
    name: '⚠⚠ store 把 filter 硬塞给不支持的驱动（cloudbase 上直接炸）',
    file: 'src/core/store/index.js',
    from: "  if (filter && Object.keys(filter).length && typeof d.listRecordsFiltered === 'function') {\n    return d.listRecordsFiltered(uid, filter);\n  }\n  return d.listRecords(uid);",
    to: "  if (filter && Object.keys(filter).length) {\n    return d.listRecordsFiltered(uid, filter);\n  }\n  return d.listRecords(uid);",
    expect: '⚠⚠ 驱动没有 listRecordsFiltered 时，只传 uid（不把 filter 塞过去）'
  },
  {
    /* 空数组也发出去 ⇒ 服务端收到 `dayGan=`（空串），虽被兜底成「不过滤」，
       但那是在依赖对方的兜底；更糟的是前端**在语义上说「我要筛空」**。
       ⚠⚠ 上一版注入的是**字符串**空值那条分支（`if (v === '') return;`），
         但 local-check 这一节发的是**数组**（`{dayGan: []}` / `{yearZhi: ['']}`），
         走的根本不是那条分支 ⇒ 注入等于没注（实测 MISS）。
         ⇒ 必须注**数组分支**里那个跳过。 */
    name: '⚠⚠ buildQuery 把数组里的空值也发出去（等于告诉服务端「我要筛空」）',
    file: 'src/core/localsdk.js',
    from: "        if (item === undefined || item === null || item === '') return;",
    to: "        // 注入：数组里的空值照样发",
    expect: '⚠ 空类**不出现在查询串里**（出了就等于「筛空」）'
  },
  {
    /* localdb 把 filter 吞掉 ⇒ 用户勾完筛选、请求也发了，但后端没收到参数，
       于是「列表还是全部」而**页面上没有任何报错**（像「筛选时灵时不灵」）。 */
    name: '⚠⚠ localdb 把 filter 吞掉（勾了筛选但后端收不到参数）',
    file: 'src/core/store/localdb.js',
    from: "    return sdk.request(BASE, { token: t.token, query: filter }).then(function (r) {",
    to: "    return sdk.request(BASE, { token: t.token }).then(function (r) {",
    expect: '⚠ 参数真的发到了服务端（结果对也可能是桩回的全量）'
  }
];

const MARK = '.nv-local-state.json';

function stateFile() { return path.join(ROOT, MARK); }
/**
 * 备份路径**必须带用例下标**。
 * ⚠⚠ 铁律①：多个用例会共用同一个源文件（本文件里 localsdk.js 有 8 例、
 *   session.js 有 4 例），不带下标的话备份路径完全一样，
 *   于是「扫全表」会把共用该文件的所有用例下标都当成 pending
 *   —— `RESTORED n files` 的数字从此不可信。
 */
function backupPath(i) { return path.join(ROOT, CASES[i].file + '.nvlocal-backup.' + i); }
function absOf(i) { return path.join(ROOT, CASES[i].file); }

function saveState() {
  const cur = [];
  CASES.forEach((c, i) => { if (fs.existsSync(backupPath(i))) cur.push(i); });
  fs.writeFileSync(stateFile(), JSON.stringify(cur));
}

/** ⚠ 取「state ∪ 实际备份文件」的并集 —— state 只是快照，**文件系统才是真相** */
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
 * 「删掉」备份 —— 实际 renameSync 挪进 `.neg-stash/local`，**不是 unlink**。
 * ⚠⚠ 本机的删除**对下一进程不可见**（stale FS view）⇒ 驱动的 orphan 扫描会误判
 *   「没还原干净」而拒绝注入。`_neg-reset-local.js` 早用 renameSync 绕过，这里对齐。
 * ⚠ stash 必须**同盘**（项目 D 盘 / `os.tmpdir()` C 盘 ⇒ 跨盘 rename `EXDEV`）。
 */
function stashBackup(b) {
  try {
    const dir = path.join(ROOT, '.neg-stash', 'local');
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
    /* ⚠ 总数自报：外层 shell 循环的范围由它决定，**别再手写 `seq 0 N`** ——
       本项目因为算少了 2，曾经让最后两条（最关键的两条）根本没被执行，
       而输出看起来「跑完了」。 */
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
    /* 锚点预检：一次报全所有失配（改过源码后必须先跑它，
       否则锚点失配会被误读成「测试没抓到」） */
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
       ⚠ `from` 也在时（`to ⊆ from` 那类包含关系）一律跳过，不误改。 */
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
