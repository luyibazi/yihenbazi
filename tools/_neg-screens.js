/**
 * 负向验证（临时脚本，跑完删）—— 证明 screens-check 的断言真拦得住 bug
 *
 * ⚠⚠ 为什么不在 Node 里 spawn 测试进程：
 *   本沙箱**禁止 Node spawn 任何子进程**（EBUSY、status=null、stdout 全空）。
 *   ⇒ 由**外层 shell** 循环：注入 → 跑测试 → 还原。
 *   本脚本只做「注入 / 还原」，并且自己保证三条自证纪律（本项目踩过假绿）：
 *     ① 锚点必须存在（找不到就报错退出，不能静默返回原串）
 *     ② 替换后内容必须真的变了
 *     ③ 落盘后读回校验；还原时逐字节比
 *
 * 用法：node tools/_neg-screens.js <caseIndex>   → 注入第 N 个 bug
 *       node tools/_neg-screens.js restore       → 全部还原
 *       node tools/_neg-screens.js list          → 列出用例
 *       node tools/_neg-screens.js check         → 预检所有用例的锚点是否还在（改过源码后先跑它）
 *       node tools/_neg-screens.js snapshot|verify → 基线快照 / 校验
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CASES = [
  /* ---------- records/model.js ---------- */
  {
    name: '列表项把 notes 筛掉（“记了事件、退出重进就没了”）',
    file: 'src/screens/records/model.js',
    from: "  const opt = record.toStorage(rec) || {};\n  record.OPTIONAL_FIELDS.forEach(function (k) {\n    if (opt[k]) out[k] = opt[k];\n  });",
    to: "  const opt = record.toStorage(rec) || {};",
    expect: 'withSummary 保留 notes'
  },
  {
    name: 'toHandoff 不剥派生字段（fourChars / lunarText 跟着上云）',
    file: 'src/screens/records/model.js',
    /* ⚠ 2026-10-05 改锚点：toHandoff 现在还要**单独贴 tagId**（`toStorage` 不含它），
       原来那个「整个函数体只有一行」的锚点匹配不上了。
       ⇒ 锚点必须跟着源码一起搬（这正是本项目反复栽的那一条：源码改了、
         用例的 `from:` 没改 ⇒ 那条用例变哑巴，永远绿）。 */
    from: "  const out = record.toStorage(item);\n  if (!out) return null;",
    to: "  const out = Object.assign({}, item);\n  if (!out) return null;",
    expect: 'toHandoff 剥掉 fourChars'
  },
  {
    name: '读失败降级成「成功但没记录」（断网被当成数据没了）',
    file: 'src/screens/records/model.js',
    from: "  if (res.reason === 'no-login') {\n    // 登录态里没有可用标识 → 明确说，别显示成「没有记录」\n    return { state: 'skip', text: '未登录，记录存在云端，登录后可见' };\n  }\n  return { state: 'fail', text: '云端记录同步失败 · 重试' };",
    to: "  return { state: 'ok', text: '' };",
    expect: '断网 → fail'
  },
  {
    name: 'shouldReload 永远返回 true（通知栏下拉也全量重拉）',
    file: 'src/screens/records/model.js',
    from: "  return syncedRev === undefined || syncedRev !== curRev;",
    to: "  return true;",
    expect: '版本号没变 → 不拉'
  },

  /* ---------- paipan/model.js ---------- */
  {
    /* ⚠ 原来这里是「去掉 dtOf 的 sizhu → solar 降级」，但那条**测不出来**：
       datepick 内部把「非 lunar」一律当公历，所以降级是有也行、没有也一样的
       等价改写（已实测，见 model.dtOf 的注释）。换成一条真能测出来的：
       「农历」那一档也不再区分 —— 这就是「换历法不生效」那个 bug。 */
    name: '农历那一档也当成公历算（选「农历」等于没选）',
    file: 'src/screens/paipan/model.js',
    from: "  const cal = calendar === 'sizhu' ? 'solar' : calendar;",
    to: "  const cal = 'solar';",
    expect: '「农历」那一档的文案与公历不同'
  },
  {
    name: '四柱文本顺序写反（日 月 年 时）',
    file: 'src/screens/paipan/model.js',
    from: "    pillarsText: [p.year, p.month, p.day, p.hour].join(' '),",
    to: "    pillarsText: [p.day, p.month, p.year, p.hour].join(' '),",
    expect: '四柱文本顺序 = 年 月 日 时'
  },
  {
    name: '排盘闸门只看「有没有结果」不看标识（拿不到 uid 也放行）',
    file: 'src/screens/paipan/model.js',
    from: "  if (!who || !who.uid) {\n    return { ok: false, notice: '登录后才能排盘' };\n  }",
    to: "  if (!who) {\n    return { ok: false, notice: '登录后才能排盘' };\n  }",
    expect: 'uid 空串 → 拦下'
  },
  {
    name: '云端 no-identity 不再静默跳过（界面上闪一条没用的失败）',
    file: 'src/screens/paipan/model.js',
    from: "  if (res && res.reason === 'no-identity') {\n    // 登录是好的，只是这个登录态里没有任何能当标识的凭证 → 静默跳过\n    return { state: 'skip', text: '' };\n  }",
    to: "",
    expect: '没有标识 → 静默跳过'
  },

  /* ---------- result/model.js ---------- */
  {
    name: '⚠短路①被删：总线空了就拿 null 把屏上的盘冲成空态（闪空态老 bug）',
    file: 'src/screens/result/model.js',
    from: "    if (curRec || hydrating) return { action: 'keep' };\n    return { action: 'empty' };",
    to: "    return { action: 'empty' };",
    expect: '短路①：屏上有盘 + 总线空'
  },
  {
    name: '⚠短路②被删：同一份盘也重排一遍（白算几十毫秒）',
    file: 'src/screens/result/model.js',
    from: "  if (curRec && curRec.id === raw.id && curRec.chart) return { action: 'keep' };",
    to: "",
    expect: '短路②：同一份完整盘'
  },
  {
    name: '⚠短路②的条件漏掉「有 chart」：正在排盘时被误判成「已在屏上」',
    file: 'src/screens/result/model.js',
    from: "  if (curRec && curRec.id === raw.id && curRec.chart) return { action: 'keep' };",
    to: "  if (curRec && curRec.id === raw.id) return { action: 'keep' };",
    expect: '同 id 但没 chart'
  },
  {
    name: 'savedOf 反过来：排盘页过来也当「已保存」（新盘永远存不进云端）',
    file: 'src/screens/result/model.js',
    from: "  return source === 'records';",
    to: "  return source !== 'records';",
    expect: '排盘页过来 → 必未保存'
  },
  {
    name: '重排失败时还把 saved 当真（NULL 盘显示「已保存到记录」）',
    file: 'src/screens/result/model.js',
    from: "  if (!rec) {\n    return { rec: null, hydrating: false, saved: false, save: saveIdle(false) };\n  }\n  const isSaved = !!saved;",
    to: "  const isSaved = !!saved;\n  if (!rec) {\n    return { rec: null, hydrating: false, saved: isSaved, save: saveIdle(isSaved) };\n  }",
    expect: '重排失败 → saved 强制 false'
  },
  {
    name: '三种保存失败混成同一句（用户不知道该登录还是该重试）',
    file: 'src/screens/result/model.js',
    from: "  if (res && res.reason === 'no-login') {\n    return {\n      ok: false,\n      saved: false,\n      save: { state: 'fail', text: SAVE_TEXT.noLogin, disabled: false },\n      toast: '登录后才能保存到云端'\n    };\n  }\n  if (res && res.reason === 'bad-record') {\n    return {\n      ok: false,\n      saved: false,\n      save: { state: 'fail', text: SAVE_TEXT.badRecord, disabled: false },\n      toast: '这条记录的出生信息不全'\n    };\n  }",
    to: "",
    expect: '三种失败三句不同的话'
  },
  {
    name: '事件元信息白名单漏掉 up / up2（父级那行只剩「【大运】」）',
    file: 'src/screens/result/model.js',
    from: "const NOTE_META_FIELDS = ['year', 'ganzhi', 'age', 'md', 'jieQi', 'up', 'up2'];",
    to: "const NOTE_META_FIELDS = ['year', 'ganzhi', 'age', 'md', 'jieQi'];",
    expect: '父级快照 up 被保留'
  },
  {
    name: '元信息不做白名单（meta 里的任何字段都塞进云端）',
    file: 'src/screens/result/model.js',
    from: "    NOTE_META_FIELDS.forEach(function (f) {\n      const v2 = m[f];\n      if (v2 !== undefined && v2 !== null && v2 !== '') item[f] = v2;\n    });",
    to: "    Object.keys(m).forEach(function (f) {\n      const v2 = m[f];\n      if (v2 !== undefined && v2 !== null && v2 !== '') item[f] = v2;\n    });",
    expect: '不在表里的不许混进去'
  },
  {
    name: '⚠ 清空正文不删事件（改成写一条空 text，红点永远消不掉）',
    file: 'src/screens/result/model.js',
    from: "  if (deleting) {\n    delete next[ed.key];\n  } else {",
    to: "  if (false) {\n    delete next[ed.key];\n  } else {",
    expect: '清空正文 = 删除这一条事件'
  },
  {
    name: 'noteItemOf 直接改原 notes（失败时内容已被改脏）',
    file: 'src/screens/result/model.js',
    from: "  const next = copyOf(notes);\n  const text = String(ed.text || '').replace(/\\r\\n/g, '\\n').trim();",
    to: "  const next = notes || {};\n  const text = String(ed.text || '').replace(/\\r\\n/g, '\\n').trim();",
    expect: '⚠ 不改原对象'
  },
  {
    name: '正文不 trim（只打了空格也当成一条事件存下去）',
    file: 'src/screens/result/model.js',
    from: "  const text = String(ed.text || '').replace(/\\r\\n/g, '\\n').trim();",
    to: "  const text = String(ed.text || '').replace(/\\r\\n/g, '\\n');",
    expect: '正文只剩空白 → 当作删除'
  },
  {
    name: 'nextTab 不校验 key（点到未知 key 切出一块空白）',
    file: 'src/screens/result/model.js',
    from: "  if (TAB_KEYS.indexOf(key) < 0) return null;\n  if (key === cur) return null;",
    to: "  if (key === cur) return null;",
    expect: '未知 key → 忽略'
  },
  {
    name: '门的三种 mode 混成一种（没盘时也给「保存」按钮 → 点了没反应）',
    file: 'src/screens/result/model.js',
    from: "  if (hasRec) return { show: true, hint: '这条八字还没存进记录，保存后即可使用', mode: 'save' };\n  if (hydrating) return { show: true, hint: '正在把这条记录排成盘，稍候', mode: 'hydrating' };",
    to: "  if (hasRec) return { show: true, hint: '这条八字还没存进记录，保存后即可使用', mode: 'save' };",
    expect: '正在排盘 → 门里转圈'
  },
  {
    name: '换页签时把 saved 也改了（看块面板就当成保存了）',
    file: 'src/screens/result/model.js',
    from: "  if (activeTab === 'chart') return { show: false, hint: '', mode: 'normal' };",
    to: "  if (activeTab === 'chart') return { show: false, hint: '', mode: 'normal' };\n  saved = true;",
    expect: '未保存 + 有盘 → 门挡着'
  },

  /* ---------- 新增：「详细信息」页签（info） ---------- */
  {
    name: '⚠⚠ 「详细信息」没排到第一位（用户明确要求它排第一）',
    file: 'src/screens/result/model.js',
    from: "const TAB_KEYS = ['info', 'chart', 'events', 'notes'];",
    to: "const TAB_KEYS = ['chart', 'events', 'notes', 'info'];",
    expect: '「详细信息」排第一'
  },
  {
    name: '⚠ 少了「详细信息」这个页签（用户点不到）',
    file: 'src/screens/result/model.js',
    from: "const TAB_KEYS = ['info', 'chart', 'events', 'notes'];",
    to: "const TAB_KEYS = ['chart', 'events', 'notes'];",
    expect: '页签 key 收敛成这四个字面量'
  },
  {
    name: '⚠⚠ 文案表漏了 info（切换栏上出现一个空白按钮）',
    file: 'src/screens/result/model.js',
    from: "  info: '详细信息',\n  chart: '专业排盘',",
    to: "  chart: '专业排盘',",
    expect: '每个页签 key 都有对应的显示文案'
  },
  {
    name: '⚠ 文案表多了个拼错的 key（多余项没人发现）',
    file: 'src/screens/result/model.js',
    from: "  info: '详细信息',\n  chart: '专业排盘',\n  events: '事件记录',\n  notes: '师傅批字'",
    to: "  info: '详细信息',\n  chart: '专业排盘',\n  events: '事件记录',\n  notes: '师傅批字',\n  info2: '详细'",
    expect: '文案表的 key 与 TAB_KEYS 完全一致'
  },
  {
    name: '⚠⚠ 详细信息不加门（未保存也能看 —— 用户明确要求「跟其它两个一致」）',
    file: 'src/screens/result/model.js',
    from: "  if (activeTab === 'chart') return { show: false, hint: '', mode: 'normal' };\n  if (saved) return { show: false, hint: '', mode: 'normal' };",
    to: "  if (activeTab === 'chart' || activeTab === 'info') return { show: false, hint: '', mode: 'normal' };\n  if (saved) return { show: false, hint: '', mode: 'normal' };",
    expect: '未保存 → 详细信息也挡着'
  },
  {
    name: '⚠⚠ 详细信息自己重算公历日期（不认 hydrate 算好的 dateText，两份实现必然漂移）',
    file: 'src/screens/result/model.js',
    from: "  push('公历', rec.dateText || rec.date);",
    to: "  push('公历', rec.date);",
    expect: '⚠ 公历优先用 hydrate 算好的 dateText'
  },
  {
    /* ⚠⚠ 这条**踩过假绿**：第一版注入写成 `String(value).trim()`，
       而测试 fixture 的值是 `'甲辰年伤官见官\n第二行'` —— **首尾都没有空白**，
       所以 .trim() 是个 no-op，注入后测试照样全绿，看起来"证明过了"其实什么都没证。
       ⇒ 注入必须写**真能把换行干掉**的改写（下面这条把 \n 摞成空格），
         而且 fixture 里必须**真的带换行**（已经是了）。 */
    name: '⚠⚠ 描述里的换行被摞成空格（多行的评语挤成一行）',
    file: 'src/screens/result/model.js',
    from: "    const v = value === undefined || value === null ? '' : String(value);\n    if (!v.trim()) return;              // 空值整行不要（见上面注释）\n    rows.push({ label: label, value: v, multiline: !!multiline });",
    to: "    const v = value === undefined || value === null ? '' : String(value).split('\\n').join(' ');\n    if (!v.trim()) return;\n    rows.push({ label: label, value: v, multiline: !!multiline });",
    expect: '⚠ 描述保留原文换行'
  },
  {
    name: '⚠ 空值也占一行（界面上留一个空荡荡的「描述：」）',
    file: 'src/screens/result/model.js',
    from: "    if (!v.trim()) return;              // 空值整行不要（见上面注释）",
    to: "    if (false) return;",
    expect: '没描述 → 这一行整行不出现'
  },
  {
    name: '⚠ 描述没标成多行（视图用不换行的样式，长评语顶破一行）',
    file: 'src/screens/result/model.js',
    from: "  push('描述', rec.desc, true);",
    to: "  push('描述', rec.desc);",
    expect: '描述标记为多行'
  },
  {
    name: '⚠⚠ 性别判反（男女颠倒 —— 排盘结论全错）',
    file: 'src/screens/result/model.js',
    from: "    : (rec.gender === 0 ? '女' : '男');",
    to: "    : (rec.gender === 0 ? '男' : '女');",
    expect: 'gender 1 → 男'
  },
  {
    name: '⚠⚠ 详细信息退回裸 date 的分支被删（冷启动进来公历那行凭空消失）',
    file: 'src/screens/result/model.js',
    from: "  push('公历', rec.dateText || rec.date);",
    to: "  push('公历', rec.dateText);",
    expect: '没有 dateText 时退回裸 date'
  },
  {
    name: '⚠ 没有记录时不返回空数组（视图会拿到 undefined 崩掉）',
    file: 'src/screens/result/model.js',
    from: "function detailRowsOf(rec, deps) {\n  if (!rec) return [];",
    to: "function detailRowsOf(rec, deps) {\n  if (!rec) return;",
    expect: '没有记录 → 空数组'
  },

  /* ---------- tabs/model.js ---------- */
  {
    name: 'switchTo 不校验 key（点错 tab 切出一块空白）',
    file: 'src/screens/tabs/model.js',
    from: "function switchTo(cur, key) {\n  if (!isTab(key)) return null;\n  if (key === cur) return null;\n  return key;\n}",
    to: "function switchTo(cur, key) {\n  return key;\n}",
    expect: '未知 key → 忽略'
  },
  {
    name: 'openResult 不递增（关了再开 useEffect 不触发、盘不刷新）',
    file: 'src/screens/tabs/model.js',
    from: "function openResult(curEntry) {\n  return (curEntry || 0) + 1;\n}",
    to: "function openResult(curEntry) {\n  return 1;\n}",
    expect: '⚠ 计数器递增'
  },
  {
    name: '默认 tab 不在 TABS 里（启动就切不出一块空白页）',
    file: 'src/screens/tabs/model.js',
    from: "const DEFAULT_TAB = 'records';",
    to: "const DEFAULT_TAB = 'home';",
    expect: '默认 tab = records'
  },

  /* ---------- settings/content.js ---------- */
  {
    name: '⚠⚠ n3 文案写回 Gitee 那套说法（「云端仓库 / 文件名」是对用户撒谎）',
    file: 'src/screens/settings/content.js',
    from: "    body: '排盘记录只保存在你自己的云端账号里（用账号登录，数据按账号隔离），换手机 / 重装后重新登录仍可看到，本机不保存任何记录。所以断网时记录页会打不开，这是刻意的取舍。记录不会分享给其他用户。'",
    to: "    body: '排盘记录只保存在你自己的云端仓库里（按你的账号隔离，文件名就是你的账号标识），换手机 / 重装后重新登录仍可看到，本机不保存任何记录。所以断网时记录页会打不开，这是刻意的取舍。记录不会分享给其他用户。'",
    expect: 'n3 不许再说「云端仓库」'
  },
  {
    name: '⚠ 退出确认丢掉「云端记录不会被删」（用户不敢点退出）',
    file: 'src/screens/settings/content.js',
    from: "const LOGOUT_BODY = '退出后需要重新用账号密码登录才能看到云端记录，云端记录本身不会被删除。';",
    to: "const LOGOUT_BODY = '确定要退出登录吗？';",
    expect: '⚠ 退出确认必须说清「云端记录不会被删」'
  },
  {
    name: '学堂少一条知识卡',
    file: 'src/screens/study/content.js',
    from: "    id: 'k5',",
    to: "    id: 'k5x',",
    expect: '五条卡的 id 顺序'
  },

  /* ---------- result/Result.tsx：生命周期契约（源码级断言的正主） ---------- */
  {
    /* ⚠⚠ 这条**复现的就是本轮修掉的那个真 bug**：
       clear() 挪回 [entry, load] 那个 effect 的 cleanup。
       React 在依赖变化时也会跑 cleanup，而 entry 变化 = 「新盘投进来了」，
       于是 cleanup 抢跑把新盘清掉 → load() 拿 null → 短路①兜成 keep →
       **界面静默停在上一份盘上**（不是空态，是显示错的盘）。 */
    name: '⚠⚠ chartBus.clear() 挪回 [entry] 的 cleanup（重进静默显示上一份盘）',
    file: 'src/screens/result/Result.tsx',
    from: "  useEffect(() => {\n    load();\n  }, [entry, load]);",
    to: "  useEffect(() => {\n    load();\n    return () => { chartBus.clear(); };\n  }, [entry, load]);",
    expect: '[entry…] 的 effect 不许有 cleanup'
  },
  {
    /* 作废挪到 App.tsx：两头都管 → 关页时清一遍、重进又被 App 清一遍，
       且归属不清（本页不再自己收拾），断言②④都会红。 */
    name: '把 clear() 搬到 App.tsx（作废归属不唯一）',
    file: 'App.tsx',
    from: "  const onGoPaipan = useCallback(() => {\n    setResultEntry(0);",
    to: "  const onGoPaipan = useCallback(() => {\n    chartBus.clear();\n    setResultEntry(0);",
    expect: 'App.tsx 不碰 chartBus.clear()'
  },
  {
    /* 空依赖那条 effect 的依赖写成 [entry]：它就会在重进时也清一次 ——
       与上一条是同一个 bug 的另一种写法，断言②（必须是空依赖）能拦住。 */
    name: '卸载作废那条 effect 误写成 [entry] 依赖（重进也清一遍）',
    file: 'src/screens/result/Result.tsx',
    from: "  useEffect(() => () => { chartBus.clear(); }, []);",
    to: "  useEffect(() => () => { chartBus.clear(); }, [entry]);",
    expect: '空依赖 []'
  },

  /* ---------- 系统 chrome：安全区 / 导航栏 / tab 栏（2026-10-02 真机反馈） ---------- */
  {
    /* SafeAreaProvider 没了 → useSafeAreaInsets 恒为 0 → 顶部又被状态栏压住。
       这就是「顶部被遮住了」的直接复发路径。 */
    name: 'App 丢了 SafeAreaProvider（insets 恒 0，顶部又被遮）',
    file: 'App.tsx',
    from: "<SafeAreaProvider>",
    to: "<>",
    expect: 'App.tsx 包了 SafeAreaProvider'
  },
  {
    /* 状态栏占位写死 44：非刘海（20pt）会白一条，大刘海（59pt）照样被遮。 */
    name: 'NavBar 状态栏占位写死数字（刘海屏照样被遮）',
    file: 'src/components/NavBar.tsx',
    from: "<View style={{ height: insets.top }} />",
    to: "<View style={{ height: 44 }} />",
    expect: '顶部占位就是 insets.top 本身'
  },
  {
    /* 图标盒回退到旧值 rpx(52)（26pt）——真机反馈「底部菜单太小」里的图标那半句。 */
    name: 'tab 图标盒回退成 rpx(52)（太小）',
    file: 'src/screens/tabs/TabBar.tsx',
    from: "icon: { width: rpx(64), height: rpx(64), resizeMode: 'contain' },",
    to: "icon: { width: rpx(52), height: rpx(52), resizeMode: 'contain' },",
    expect: 'tab 图标盒 ≥ rpx(64)'
  },
  {
    /* 底部安全区没了：整条栏贴着屏幕下沿，被 home indicator 压住。 */
    name: 'TabBar 丢了 insets.bottom（贴屏底、被 home indicator 压）',
    file: 'src/screens/tabs/TabBar.tsx',
    from: "paddingBottom: insets.bottom,",
    to: "paddingBottom: 0,",
    expect: 'TabBar 底部 padding 了 insets.bottom'
  },
  {
    /* 结果页盖满全屏、没有 tab 栏兜底，底部留白不算 insets 会把按钮压到屏底。 */
    name: '结果页纵向留白不算 insets.bottom（按钮贴屏底）',
    file: 'src/screens/result/Result.tsx',
    from: "page: { paddingBottom: rpx(SIZES.pagePadBottom) + insets.bottom },",
    to: "page: { paddingBottom: rpx(SIZES.pagePadBottom) },",
    expect: '结果页纵向留白含 insets.bottom'
  },
  {
    /* onBack 顺手切 tab：从记录页点开的用户按返回却落在排盘页（≠ navigateBack）。 */
    name: 'onBack 复用成 switchTab（返回却落到排盘页）',
    file: 'App.tsx',
    from: "  const onBack = useCallback(() => {\n    setResultEntry(0);\n  }, []);",
    to: "  const onBack = useCallback(() => {\n    setResultEntry(0);\n    setTab('paipan');\n  }, []);",
    expect: 'onBack 只 pop 不切 tab'
  },

  /* ================================================================
   * 登录链路（2026-10-02 换成**账号 + 密码**后重写）
   * ================================================================
   * ⚠ 这一批守的都是「真机上会疼」的点：
   *   账号粘进来带首尾空格 / 手输了大写、密码被顺手 trim、
   *   超长账号被悄悄截成看似合法的值、空输入就飘红、
   *   按钮放行一个格式不对的账号、密码压根没传给接口、
   *   以及**有人好心加一个注册按钮**（平台对用户名密码自助注册回 501）。
   * ⚠⚠ 其中「用户名规则」那条注到 cbsdk.js：规则只许有一份，
   *   放宽了它 = 前端放行、服务端 400，用户拿到一句他永远改不对的提示。
   */
  /* ---------- 用户名规则（localsdk.js，唯一一份） ---------- */
  {
    /* ⚠⚠ 文件**必须**指 localsdk.js，不能指 cbsdk.js。
       screens-check.js 全程**没有** require cbsdk（它只走 login/model.js，
       而 login/model.js 用的是 localsdk）⇒ 注到 cbsdk 就是注进一个
       **本测试根本不加载**的文件，断言永远绿 —— 实测踩过，
       两条用例（本条 + 账号不转小写）都因此报「trc=0 nFailLines=0」。
       ⚠ 两个 core 文件里 USERNAME_RE / normalizeUsername 的**字面量一模一样**，
         所以这条锚点两边都能命中 —— 靠 file 字段区分，别再抄错。 */
    name: '⚠⚠ 用户名正则按**文档那版**放宽（文档说允许大小写与 `.:+ @`，实测全错）',
    file: 'src/core/localsdk.js',
    from: "const USERNAME_RE = /^[a-z][0-9a-z_-]{5,24}$/;",
    to: "const USERNAME_RE = /^[a-zA-Z][0-9a-zA-Z_.:+-]{1,47}$/;",
    expect: '⚠ 点号要拒（文档说允许，实测不允许）'
  },
  {
    name: '账号不转小写（用户把账号记成大写就永远登不上）',
    file: 'src/core/localsdk.js',
    from: "  return String(raw == null ? '' : raw).trim().toLowerCase();",
    to: "  return String(raw == null ? '' : raw).trim();",
    expect: '⭐ 大写要转小写（服务端规则只认小写）'
  },

  /* ---------- login/model.js：两个输入的清洗 ---------- */
  {
    name: '密码被顺手 trim（结尾有个空格的真密码永远登不上）',
    file: 'src/screens/login/model.js',
    from: "  return String(raw == null ? '' : raw).slice(0, INPUT_MAX);",
    to: "  return String(raw == null ? '' : raw).trim().slice(0, INPUT_MAX);",
    expect: '⚠⚠ 密码不许 trim（首尾空格是真密码的一部分）'
  },
  {
    name: '超长账号被截断成 25 位（看着合法，其实用户永远登不上）',
    file: 'src/screens/login/model.js',
    from: "  return localsdk.normalizeUsername(raw).slice(0, INPUT_MAX);",
    to: "  return localsdk.normalizeUsername(raw).slice(0, localsdk.USERNAME_MAX);",
    expect: '⚠ 超长不截断'
  },
  {
    /* 刚进页面就飘红是最讨嫌的一种设计（空输入 ≠ 输错了）。 */
    name: '空输入也飘红（刚进登录页就报「账号至少要 6 位」）',
    file: 'src/screens/login/model.js',
    from: "  if (!u) return '';",
    to: "  if (!u) return content.HINT_USERNAME_SHORT;",
    expect: '⚠⚠ 空输入不飘红（刚进页面就报错最讨嫌）'
  },

  /* ---------- login/model.js：登录按钮 ---------- */
  {
    /* 放行一个格式不对的账号 ⇒ 用户点下去只拿到一句「用户名或密码不对」。 */
    name: '登录按钮不校验账号格式（格式错的也让它点）',
    file: 'src/screens/login/model.js',
    from: "  const base = isUsername(st.username) && !!String(st.password || '');",
    to: "  const base = !!String(st.username || '') && !!String(st.password || '');",
    expect: '账号格式不合法 → 不能登录'
  },
  {
    /* done 在 submitting 之后判 ⇒ 成功后按钮回弹成「登录」，用户会再点一次。 */
    name: 'done 不压 submitting（成功后按钮回弹成「登录」）',
    file: 'src/screens/login/model.js',
    from: "  if (st.done) {\n    return {\n      disabled: true,\n      label: mode === MODE_SIGNUP ? content.SUBMIT_SIGNUP_DONE : content.SUBMIT_DONE\n    };\n  }\n  if (st.submitting) {\n    return {\n      disabled: true,\n      label: mode === MODE_SIGNUP ? content.SUBMIT_SIGNUP_BUSY : content.SUBMIT_BUSY\n    };\n  }",
    to: "  if (st.submitting) {\n    return {\n      disabled: true,\n      label: mode === MODE_SIGNUP ? content.SUBMIT_SIGNUP_BUSY : content.SUBMIT_BUSY\n    };\n  }",
    expect: '⚠ 已成功就锁在「登录成功」'
  },

  /* ---------- records/model.js：未登录必须可行动 ---------- */
  {
    name: '⚠ skip（未登录）又变成静默（空列表里没有去登录的出口）',
    file: 'src/screens/records/model.js',
    from: "  if (st === 'skip') return 'login';\n",
    to: "",
    expect: '未登录 → 去登录'
  },
  {
    name: '空态提示丢掉「未登录」那一档（未登录的人被告知「排盘后点保存」）',
    file: 'src/screens/records/model.js',
    from: "  if (st === 'skip') return '登录后即可看到云端记录';\n",
    to: "",
    expect: '未登录的空态提示指向「登录」'
  },

  /* ---------- App.tsx：会话信号与推入层 ---------- */
  {
    name: '⚠⚠ sessionRev 不递增（登录 / 退出后常驻页面全都不刷新）',
    file: 'App.tsx',
    from: "    setSessionRev((n) => n + 1);",
    to: "    setSessionRev((n) => n);",
    expect: '⚠⚠ 登录 / 退出后必须递增 sessionRev'
  },
  {
    /* boot 记着「本次冷启动已核对过」→ 换个人登录后新账号看到**上一个人的记录**。 */
    name: '⚠⚠ 换账号时忘了 boot.forget()（新账号看到上一个人的记录）',
    file: 'App.tsx',
    from: "    boot.forget();\n    setSessionRev((n) => n + 1);",
    to: "    setSessionRev((n) => n + 1);",
    expect: '⚠⚠ 换人时必须忘掉 boot 的核对结论'
  },
  {
    name: '物理返回不关登录页（压着登录页按返回直接退出 App）',
    file: 'App.tsx',
    from: "      if (showLogin) onCloseLogin();\n      else onBack();",
    to: "      onBack();",
    expect: '物理返回优先 pop 登录页'
  },
  {
    /* 推入层盖住时 tab 页仍算 active ⇒ 后台还在跑 boot / 定时器（≠ 小程序 onHide）。 */
    name: '推入层盖住时 tab 页仍置为 active（后台还在跑）',
    file: 'App.tsx',
    from: "  const activeKey = live ? tab : '';",
    to: "  const activeKey = tab;",
    expect: '推入层盖住时 tab 页置为非 active'
  },
  {
    /* 标题抄死中文 ⇒ 改一处漏一处（本项目「文案残留」踩过三次）。 */
    name: '登录页标题抄死中文（不复用 content.TITLE）',
    file: 'App.tsx',
    from: "            <NavBar title={loginContent.TITLE} onBack={onCloseLogin} />",
    to: "            <NavBar title=\"登录\" onBack={onCloseLogin} />",
    expect: '登录页标题取自 content.TITLE'
  },

  /* ---------- login/Login.tsx ---------- */
  {
    /* ⚠⚠ 漏把密码交给接口（比如随手写了个空串 / 传错了变量）⇒ 每次都是「用户名或密码不对」，
       而界面上看不出任何异常 —— 只有真机点下去才知道。 */
    name: '⚠⚠ 登录时没把密码传给接口（每次都「用户名或密码不对」）',
    file: 'src/screens/login/Login.tsx',
    from: "      : auth.signInWithPassword(username, password);",
    to: "      : auth.signInWithPassword(username, '');",
    expect: '⚠⚠ 两个框的值都要真的交出去（漏 password ⇒ 每次都「用户名或密码不对」）'
  },
  {
    /* ⚠ 密码框不遮起来 = 明文显示密码，旁边有人一眼看去就是硬伤。
       ⚠⚠ 本页有**两个**密码框（password + confirm），都带 secureTextEntry。
         第一版锚点只写 `"              secureTextEntry\n"` ⇒ 只换掉**第一个**
         （= 密码框），确认框那个还在 ⇒ 断言 /secureTextEntry/ 照样命中，
         注入等于没注（实测 trc=0）。⇒ 锚点必须带上 `ref={pwdRef}` 这一段，
         点名到"主密码框"，才真的把它的遮罩拿掉。 */
    name: '密码框没遮起来（明文显示密码）',
    file: 'src/screens/login/Login.tsx',
    from: "              ref={pwdRef}\n              style={s.input}\n              value={password}\n              onChangeText={onPasswordChange}\n              placeholder={isSignup ? content.PASSWORD_PLACEHOLDER_SIGNUP : content.PASSWORD_PLACEHOLDER}\n              placeholderTextColor=\"#c8c8c8\"\n              secureTextEntry\n",
    to: "              ref={pwdRef}\n              style={s.input}\n              value={password}\n              onChangeText={onPasswordChange}\n              placeholder={isSignup ? content.PASSWORD_PLACEHOLDER_SIGNUP : content.PASSWORD_PLACEHOLDER}\n              placeholderTextColor=\"#c8c8c8\"\n",
    expect: '⚠ 两个密码框都要遮起来（明文显示密码是硬伤）'
  },
  {
    /* ⚠ iOS 默认会把首字母大写 ⇒ 用户看着框里冒出大写字母，会以为是自己填错了。 */
    name: '账号框没关掉自动大写（iOS 默认把首字母大写）',
    file: 'src/screens/login/Login.tsx',
    from: "              autoCapitalize=\"none\"\n              autoCorrect={false}\n              textContentType=\"username\"",
    to: "              autoCapitalize=\"sentences\"\n              autoCorrect={false}\n              textContentType=\"username\"",
    expect: '⚠ 账号框关掉自动大写（服务端只认小写，iOS 默认会把首字母大写）'
  },
  {
    /* ⚠⚠ 直接在视图里 trim 密码 = 「结尾带空格的真密码」永远登不上。
       ⚠⚠ 本页有**两个** `model.passwordInput(`（密码框 line116 + 确认框 line122）。
         锚点必须带上 `setPassword(` 点名到密码框那一个；
         只写 `model.passwordInput(` 会命中第一个，而确认框那个仍在 ⇒
         断言 /model\.passwordInput\(/ 照样绿（实测 trc=0）。 */
    name: '密码在视图层被 trim（绕过 model.passwordInput）',
    file: 'src/screens/login/Login.tsx',
    from: "    setPassword(model.passwordInput(v));",
    to: "    setPassword(v.trim());",
    expect: '⚠⚠ 密码走 model.passwordInput（它只限长；直接在视图里 trim 会让「结尾带空格的真密码」永远登不上）'
  },
  {
    /* ⚠⚠ 注册入口**不能写死**。
       CloudBase 那条路平台禁死（纯用户名密码自助注册回 501），那时显示了也点不通；
       反过来「能注册却藏着入口」用户会以为 App 坏了。
       ⇒ 注入「无条件显示」= 把 canSignUp() 那道闸门拿掉，
         断言随即抓「注册入口由 canSignUp() 决定」。 */
    name: '⚠⚠ 注册入口写死成**恒显示**（CloudBase 那条路点下去必然 501 失败）',
    file: 'src/screens/login/Login.tsx',
    from: "        {CAN_SIGNUP ? (",
    to: "        {true ? (",
    expect: '⚠⚠ 注册入口**由 canSignUp() 决定**，不能写死'
  },
  {
    /* ⚠⚠ 「不能注册」时底部那句必须写明账号从哪来 ——
       用户找不到注册按钮会以为 App 坏了。删掉它 = 让人卡在登录页。 */
    name: '⚠⚠ 删掉「账号由管理员创建」那句（用户找不到注册入口又没有说明）',
    file: 'src/screens/login/Login.tsx',
    from: "          <Text style={s.tip}>{content.NO_SIGNUP_TIP}</Text>",
    to: "          <Text style={s.tip}></Text>",
    expect: '⚠⚠ 不能注册时必须说明账号从哪来'
  },

  /* ---------- paipan/Paipan.tsx ---------- */
  {
    /* ⚠ 未登录落回 fail ⇒ 界面出现「重试」，而重试一万次也不会好 —— 他就是得登录。 */
    name: '⚠ 排盘页未登录落回 fail（显示「重试」，而重试永远不会好）',
    file: 'src/screens/paipan/Paipan.tsx',
    from: "        if (res.needLogin) setLogin({ state: 'need', text: '未登录' });\n        else setLogin({ state: 'fail', text: res.error || '登录失败' });",
    to: "        setLogin({ state: 'fail', text: res.error || '登录失败' });",
    expect: '排盘页未登录走 need 态'
  },

  /* ---------- settings/Settings.tsx ---------- */
  {
    /* 本页常驻：依赖数组写空 ⇒ 登录成功后回来还显示着「登录」入口。 */
    name: '⚠ 设置页不重读登录态（依赖数组写空；登录后还显示「登录」）',
    file: 'src/screens/settings/Settings.tsx',
    from: "  }), [sessionRev]);",
    to: "  }), []);",
    expect: '设置页靠 sessionRev 重读登录态'
  },

  /* ---------- records/Records.tsx ---------- */
  {
    /* 这一支被禁用 ⇒ NEED_LOGIN 落到最后的 hideBoot()，新用户看到的是一片空白。 */
    name: '⚠ 记录页禁用 NEED_LOGIN 分支（未登录时那条提示整条消失）',
    file: 'src/screens/records/Records.tsx',
    from: "    if (stage === STAGE.NEED_LOGIN) {",
    to: "    if (false) {",
    expect: '记录页处理了 STAGE.NEED_LOGIN'
  },
  {
    /* 冷启动读盘整个没接上 ⇒ 凭证永远读不回内存（本项目真实漏过一次：函数写好了却零调用）。 */
    name: '⚠⚠ App.tsx 不再调用 loadFromDisk（冷启动读不到已登录的凭证）',
    file: 'App.tsx',
    from: "    storage.loadFromDisk().then(() => { if (alive) setBooted(true); });",
    to: "    setBooted(true);",
    expect: 'App.tsx 调用了 storage.loadFromDisk()'
  },
  {
    /* 去掉闸门 ⇒ 子组件在凭证还没读回来时就去 effect 里问登录态，冷启动必然误判成「未登录」。 */
    name: '⚠⚠ App.tsx 去掉 booted 闸门（子组件抢先问登录态）',
    file: 'App.tsx',
    from: "  if (!booted) {",
    to: "  if (false) {",
    expect: '渲染被 booted 门住'
  },

  /* ---------- 事件编辑框 × 系统键盘（2026-10-02 真机反馈）---------- */

  {
    /* 遮罩那层点一下 = 关框 ⇒ 用户「想收键盘」的那一下把未保存的正文丢光。 */
    name: '⚠⚠ 遮罩点一下直接关框（「想收键盘」变成「关框丢内容」）',
    file: 'src/screens/result/Result.tsx',
    from: "          <Pressable style={StyleSheet.absoluteFill} onPress={onMaskTap} />",
    to: "          <Pressable style={StyleSheet.absoluteFill} onPress={onNoteClose} />",
    expect: '遮罩那层挂的是 onMaskTap'
  },
  {
    /* 遮罩自己让位 ⇒ 空出来那块没有遮罩，页面从下面透上来。 */
    name: '遮罩自己加了 paddingBottom（让位时那块漏出页面）',
    file: 'src/screens/result/Result.tsx',
    from: "      left: 0, right: 0, top: 0, bottom: 0,\n      zIndex: 100,\n      backgroundColor: COLORS.scrim,",
    to: "      left: 0, right: 0, top: 0, bottom: 0,\n      zIndex: 100,\n      paddingBottom: rpx(200),\n      backgroundColor: COLORS.scrim,",
    expect: 'mask 上不许有 padding'
  },
  {
    /* 安卓那边系统已经 adjustResize 缩过窗口，再叠 padding 就是双重上移，小屏把框顶出屏幕。 */
    name: '⚠⚠ 安卓也用 padding 避让（双重上移，小屏把编辑框顶出屏幕）',
    file: 'src/screens/result/Result.tsx',
    from: "            behavior={Platform.OS === 'ios' ? 'padding' : undefined}",
    to: "            behavior={'padding'}",
    expect: "behavior 只在 iOS 给 'padding'"
  },
  {
    /* 避让层整层吃触摸 ⇒ 点空白收键盘彻底没反应。 */
    name: '避让层吃掉触摸（点空白收键盘失效）',
    file: 'src/screens/result/Result.tsx',
    from: "            pointerEvents=\"box-none\"",
    to: "            pointerEvents=\"auto\"",
    expect: '避让层是 box-none'
  },
  {
    /* 用户明确要的那个入口没了 —— 多行输入的回车是换行，iOS 上再没有别的路能收键盘。 */
    name: '⚠ 去掉「收起键盘」按钮（iOS 上没有别的入口能收键盘）',
    file: 'src/screens/result/Result.tsx',
    from: "                {kbShown ? (\n                  <Pressable style={s.kbBtn} onPress={onHideKeyboard} hitSlop={8}>\n                    <Text style={s.kbBtnText}>收起键盘</Text>\n                  </Pressable>\n                ) : null}",
    to: "                {null}",
    expect: '有「收起键盘」按钮'
  },
  {
    /* 按钮常驻 ⇒ 键盘没弹也占着标题行右侧，标题一长就被挤。 */
    name: '「收起键盘」按钮常驻（不跟键盘显隐走）',
    file: 'src/screens/result/Result.tsx',
    from: "                {kbShown ? (",
    to: "                {true ? (",
    expect: '只在键盘弹着时'
  },
  {
    /* 只用一套事件名 ⇒ iOS 上永远收不到（willShow 才是 iOS 的），让位慢半拍且不报错。 */
    name: '⚠ 键盘事件名只写一套（iOS 永远收不到，且不报错）',
    file: 'src/screens/result/Result.tsx',
    from: "    const shownEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';\n    const hiddenEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';",
    to: "    const shownEvt = 'keyboardDidShow';\n    const hiddenEvt = 'keyboardDidHide';",
    expect: 'iOS 用 willShow、安卓用 didShow'
  },
  {
    /* return false = 没接管，事件继续往下传 → App 那个「关结果页」的处理器把它关掉。 */
    name: '⚠⚠ 返回键接管后 return false（等于没接管，结果页照样被关掉）',
    file: 'src/screens/result/Result.tsx',
    from: "      onMaskTap();          // 与点遮罩同一套语义，别写第二遍\n      return true;          // 已处理，不往下传（不关结果页）",
    to: "      onMaskTap();\n      return false;",
    expect: '接管后必须 return true'
  },
  {
    /* 语义退化成一句 onClose ⇒ 丢内容的那条路又回来了（这条在 model 层，最根本）。 */
    name: '⚠⚠ maskTapAction 键盘弹着时也直接关框（丢内容的根因）',
    file: 'src/screens/result/model.js',
    from: "  if (kbShown) return 'dismiss-keyboard';",
    to: "  if (kbShown) return 'close';",
    expect: '只收键盘，不关框'
  },

  /* ================================================================
   * 记录页筛选（★ 用户要求：过滤在**服务端**，app 只负责传参）
   * ================================================================
   * ⚠⚠ 这一组守的是「app 不筛、只传参」这条线。最容易犯的错不是崩，
   *   而是**悄悄在本地筛一遍**：本地看着全对，一旦记录变多/换后端就全错，
   *   而且「后端到底有没有按参数筛」从此永远测不出来（前端已经先筛了）。
   */
  {
    /* 空类别也产出查询键 ⇒ 变成「我要筛空」⇒ 用户点开面板还没选就看到 0 条。
       ⚠ 服务端虽然把空串也当「不过滤」兜底，但**别依赖对方的兜底**（注释里写了）。 */
    name: '⚠⚠ toQuery 把空类别也拼成键（变成「我要筛空」⇒ 一条都不显示）',
    file: 'src/core/pillarFilter.js',
    from: "    const picked = Object.keys(sel[c.param] || {});\n    if (picked.length) out[c.param] = picked.join(',');",
    to: "    const picked = Object.keys(sel[c.param] || {});\n    out[c.param] = picked.join(',');",
    expect: '⚠ 没有任何选中 ⇒ 查询参数是空对象（不传 = 不过滤）'
  },
  {
    /* 同类多选拼错分隔符 ⇒ 服务端拿到一整串 '甲乙'，长度 ≠ 1 被丢弃 ⇒ 静默不筛。 */
    name: '⚠⚠ 同类多选拼错分隔符（服务端收到「甲乙」当非法值丢掉 ⇒ 静默不筛）',
    file: 'src/core/pillarFilter.js',
    from: "if (picked.length) out[c.param] = picked.join(',');",
    to: "if (picked.length) out[c.param] = picked.join('');",
    expect: '⚠ 同类多选拼成「甲,乙」（服务端按「或」解析）'
  },
  {
    /* toggleChar 原地改传进来的对象 ⇒ React 认为「没变化」不重渲染（点了没反应）。 */
    name: '⚠⚠ toggleChar 原地修改（React 不重渲染 ⇒ 点了没反应）',
    file: 'src/core/pillarFilter.js',
    from: "  const cur = (sel && sel[param]) || {};\n  const next = {};\n  Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });",
    to: "  const cur = (sel && sel[param]) || {};\n  const next = cur;",
    expect: '⚠ toggleChar 不改原对象（返回新对象，React 才认）'
  },
  {
    /* 只重建被动那一类的语义被写坏（把别的类别全丢掉）⇒ 勾一个就把面板清空。 */
    name: '⚠ toggleChar 把别的类别丢掉（勾一个就清空整个面板）',
    file: 'src/core/pillarFilter.js',
    from: "  Object.keys(base).forEach(function (k) { out[k] = k === param ? next : base[k]; });\n  if (!Object.prototype.hasOwnProperty.call(out, param)) out[param] = next;",
    to: "  out[param] = next;",
    expect: '⚠ 仍然是八个类别键（没有因为只改一个就把别的丢掉）'
  },
  {
    /* clearCat 把整份 sel 清空（而不是只清一类）⇒ 用户点「重置」和点某一行的清空长得一样。 */
    name: '⚠ clearCat 把别的类别也一起清了（清一类变成全清）',
    file: 'src/core/pillarFilter.js',
    from: "  Object.keys(base).forEach(function (k) { out[k] = k === param ? {} : base[k]; });\n  if (!Object.prototype.hasOwnProperty.call(out, param)) out[param] = {};",
    to: "  Object.keys(base).forEach(function (k) { out[k] = {}; });",
    expect: '⚠ 清一类不动另一类'
  },
  {
    /* countText 在筛选时拿「总条数」当分子 ⇒ 顶部数字**撒谎**：
       明明筛出 3 条，却显示「筛出 30 例」（用户以为筛选没生效）。
       ⚠ 上一版注入的是 `total===undefined` 那条兜底，实测**测不出来**：
         `countText(7, undefined, false)` 在正确与错误实现下都回「共 7 例」，
         两者不可区分 —— 注入等于没注。改注**筛选分支**，那才有区分度。 */
    name: '⚠⚠ countText 筛选时拿总条数当分子（顶部数字撒谎：筛出 30 例）',
    file: 'src/core/pillarFilter.js',
    from: "  if (filtered) return '筛出 ' + shown + ' 例';",
    to: "  if (filtered) return '筛出 ' + (typeof total === 'number' ? total : shown) + ' 例';",
    expect: '⚠ 筛选时显示「筛出 N 例」——绝不用筛后的数字当分母'
  },
  {
    /* 类别顺序/数量被改（少一个 ⇒ 面板少一行；顺序乱 ⇒ 与服务端对不上）。 */
    name: '⚠ 筛选类别少一个（面板少一行，与服务端 FILTER_CATS 对不上）',
    file: 'src/core/pillarFilter.js',
    from: "  { param: 'hourGan', label: '时干', chars: STEMS.split('') },\n  { param: 'hourZhi', label: '时支', chars: BRANCHES.split('') }\n];",
    to: "  { param: 'hourGan', label: '时干', chars: STEMS.split('') }\n];",
    expect: '八个筛选类别（四柱 × 干/支）'
  },
  {
    /* 干/支字符集接反：天干列出 12 个、地支列出 10 个 ⇒ 底部两个字永远选不到。 */
    name: '⚠⚠ 干/支字符集接反（天干列 12 个、地支列 10 个）',
    file: 'src/core/pillarFilter.js',
    from: "  { param: 'yearGan', label: '年干', chars: STEMS.split('') },",
    to: "  { param: 'yearGan', label: '年干', chars: BRANCHES.split('') },",
    expect: '天干第一个是「甲」'
  },
  {
    /* 后端不支持时也当作支持 ⇒ 给一个点了没反应的按钮（用户以为筛对了，只是恰好都符合）。 */
    name: '⚠⚠ 后端不支持筛选时也返回空提示（点了没反应，用户以为筛对了）',
    file: 'src/core/pillarFilter.js',
    from: "  return supported ? '' : '当前后端不支持筛选（筛选由服务端提供，切到本地后端即可用）';",
    to: "  return '';",
    expect: '⚠ 后端不支持 ⇒ 必须有一句话说明（不能给个点了没反应的按钮）'
  },

  /* ================================================================
   * 筛选弹窗（★「点击确定才筛选」）
   * ================================================================
   * ⚠⚠ 这一组守的是「取消真的能回退」与「勾选不发请求」。
   *   写坏的样子极其隐蔽 —— 勾选时「顺手」提交一下，界面看着完全正常
   *   （确定后结果一样），但取消就回不去了。
   */
  {
    /* cloneFilter 退化成浅拷 ⇒ 草稿与生效**共享内层对象**：
       弹窗里一勾，生效的那份立刻跟着变 —— 点取消也回不去。 */
    name: '⚠⚠⚠ cloneFilter 只拷一层（草稿与生效共享内层 ⇒ 取消回不去）',
    file: 'src/core/pillarFilter.js',
    from: "    const inner = src[k] || {};\n    const copy = {};\n    Object.keys(inner).forEach(function (ch) { copy[ch] = inner[ch]; });\n    out[k] = copy;",
    to: "    out[k] = src[k] || {};",
    expect: '⚠⚠ 内层是**新对象**（浅拷会共享 ⇒ 一勾两边一起变）'
  },
  {
    /* sameFilter 只比键名不比每类里的字 ⇒ 「甲」改成「乙」被当成没变，
       点确定直接 close、请求都不发 ⇒ 用户觉得「确定没反应」。 */
    name: '⚠⚠ sameFilter 只比类别键不比选中的字（换个字点确定没反应）',
    file: 'src/core/pillarFilter.js',
    from: "    const pa = Object.keys((a || {})[ca[i]] || {}).sort().join(',');\n    const pb = Object.keys((b || {})[ca[i]] || {}).sort().join(',');\n    if (pa !== pb) return false;",
    to: "    // 注入：不比每类里的字",
    expect: '同类但选了不同的字 ⇒ 不等'
  },
  {
    /* applyPlan 把「改回全部」也当成 sendsQuery ⇒ 发一次**带空参数**的请求。
       ⚠ 这条其实仍能工作（服务端把空当不过滤），但它测的是另一件事：
         真坏在「清空后不发请求」⇒ 界面永远停在上一批结果上。 */
    name: '⚠⚠ applyPlan 把「改回全部」也当作没变（清除筛选后界面停在旧结果）',
    file: 'src/core/pillarFilter.js',
    from: "  return { action: 'reload', filter: next, sendsQuery: totalPicked(next) > 0 };",
    to: "  return { action: 'close', filter: next, sendsQuery: totalPicked(next) > 0 };",
    expect: '⚠⚠ 从「有筛选」改回「全部」也是变了 ⇒ 必须 reload'
  },
  {
    /* 视图：勾选时就提交（setFilter）⇒ 取消回不去。 */
    name: '⚠⚠⚠ 弹窗勾选时顺手提交（取消回不去）',
    file: 'src/components/FilterModal.tsx',
    from: "  const onToggle = useCallback((param: string, ch: string) => {\n    setDraft((prev: any) => pf.toggleChar(prev, param, ch));\n  }, []);",
    to: "  const onToggle = useCallback((param: string, ch: string) => {\n    onConfirm(pf.toggleChar(draft, param, ch));\n  }, []);",
    expect: '它**不调 onConfirm**（勾一下就提交 = 点取消回不去，也违背「点击确定才筛选」）'
  },
  {
    /* 视图：勾选时就发请求 ⇒ 违背「点击确定才筛选」（一勾就去筛，取消也没用了）。 */
    name: '⚠⚠⚠ 勾选时读生效值 applied（草稿不再隔离 ⇒ 取消回不去）',
    file: 'src/components/FilterModal.tsx',
    from: "    setDraft((prev: any) => pf.toggleChar(prev, param, ch));",
    to: "    setDraft((prev: any) => pf.toggleChar(applied || prev, param, ch));",
    expect: '它**不碰**生效值 applied'
  },
  {
    /* 视图：打开弹窗时不深拷 ⇒ 草稿就是生效那份本身。 */
    name: '⚠⚠⚠ 打开弹窗时把生效筛选直接当草稿（草稿一勾，生效就变了）',
    file: 'src/components/FilterModal.tsx',
    from: "    if (visible) setDraft(pf.cloneFilter(applied));",
    to: "    if (visible) setDraft(applied);",
    expect: '⚠⚠⚠ 打开时把生效筛选**深拷**成草稿（直接引用 = 草稿一勾，生效就跟着变了）'
  },
  {
    /* 视图：取消时也去重拉 ⇒ 取消变成了「确认」，与确定没区别。 */
    name: '⚠⚠⚠ 取消时也重拉（取消变成了确定）',
    file: 'src/screens/records/Records.tsx',
    from: "  const onFilterCancel = useCallback(() => {\n    setFltOpen(false);",
    to: "  const onFilterCancel = useCallback(() => {\n    setFltOpen(false);\n    loadCloud({ keepTotal: true });",
    expect: '⚠⚠⚠ 取消**不发请求**（取消 = 什么都没发生）'
  },
  {
    /* 视图：弹窗渲染读**生效**那份 ⇒ 弹窗一打开就已经「提交」了，
       取消/重置全都失去意义。 */
    name: '⚠⚠ 弹窗渲染读生效筛选而不是草稿（弹窗一开就等于已提交）',
    file: 'src/components/FilterModal.tsx',
    from: "                      const on = !!(draft[cat.param] || {})[ch];",
    to: "                      const on = !!(applied[cat.param] || {})[ch];",
    expect: '⚠⚠ 弹窗里渲染的勾选态来自**草稿**（用 applied 的话就变成「已经提交了」）'
  },
  {
    /* 视图：重置顺手把窗关了 ⇒ 用户还没点确定就被提交/退出。 */
    name: '⚠⚠ 重置顺手关窗（用户被强行踢出弹窗）',
    file: 'src/components/FilterModal.tsx',
    from: "  const onReset = useCallback(() => {\n    setDraft(pf.emptyFilter());\n  }, []);",
    to: "  const onReset = useCallback(() => {\n    setDraft(pf.emptyFilter());\n    onClose();\n  }, []);",
    expect: '⚠⚠ 重置**不关窗、不筛**（还要点确定才算数）'
  },
  {
    /* 弹窗不限高 ⇒ 矮屏上八个类别把「确定」挤出屏幕，用户点不到。 */
    name: '⚠⚠⚠ 弹窗不限高（小屏上「确定」被顶出屏幕，点不到）',
    file: 'src/components/FilterModal.tsx',
    from: "      width: '100%',\n      maxHeight: '78%',          /* ⚠ 必须限高：八行 × 十几个字在小屏上会顶出屏幕 */",
    to: "      width: '100%',",
    expect: '⚠⚠ 弹窗限高（否则小屏上按钮被顶出屏幕，点不到确定）'
  },
  {
    /* 弹窗顶部计数用草稿 ⇒ 显示「筛出 5 例」而列表里躺着 30 条（当场骗人）。 */
    name: '⚠⚠ 两处计数不同源（入口说「共 30 例」、弹窗说另一个数）',
    file: 'src/screens/records/Records.tsx',
    from: "countText={model.countText(list.length, totalAll, model.hasFilter(filter, nameKw))}",
    to: "countText={model.countText(list.length, totalAll, false)}",
    expect: '⚠⚠ 入口与弹窗的计数同源且都用**生效**筛选'
  },

  /* ================================================================
   * 学堂页（书签列表）的筛选 ★ 2026-10-04
   * ================================================================
   * ⚠⚠ 与记录页同一套逻辑（core/pillarFilter.js）、同一个组件（FilterModal.tsx），
   *   但**状态与拉数据在各自页面里** —— 所以「发参数、作废旧请求」这条线
   *   得在学堂页自己身上守一遍（两页各有一份，谁改了都得红）。
   */
  {
    /* ⚠⚠⚠ 代次校验被删：换筛选时在飞的旧请求回来会把**旧筛选的数据**
       追加进新列表（偶发，且每次复现的时机都不一样，极难查）。 */
    name: '⚠⚠⚠ 学堂页不验请求代次（旧筛选的数据追加进新列表）',
    file: 'src/screens/study/Study.tsx',
    from: "      if (gen !== genRef.current) return;",
    to: "      if (false) return;",
    expect: '⚠⚠⚠ 回调第一件事是验请求代次'
  },
  {
    /* 换筛选时不 +1（上面那条的另一半：代次压根没被推进）。 */
    name: '⚠⚠ 学堂页换筛选时不 +1 作废旧请求（并发时序下混数据）',
    file: 'src/screens/study/Study.tsx',
    from: "    genRef.current += 1;\n",
    to: "",
    expect: '⚠⚠ 先作废在飞的旧请求'
  },
  {
    /* 换筛选后仍按「不带参数」拉 ⇒ 「过滤只在服务端做」这条线断了，
       界面看着就像「筛了等于没筛」（而且本地不会报任何错）。 */
    name: '⚠⚠⚠ 学堂页不带筛选参数去拉（筛了等于没筛）',
    file: 'src/screens/study/Study.tsx',
    from: "books.fetchPage(offset, model.PAGE_SIZE, pf.toQuery(filterRef.current))",
    to: "books.fetchPage(offset, model.PAGE_SIZE)",
    expect: '就在 fetchPage 的第三个参数上'
  },

  /* ---------- 结果页：标签的「改」必须藏在「修改」按钮后面（2026-10-05） ---------- */
  {
    /* ⚠ 展示态那一行被改回 Pressable ⇒ 「看标签」和「改标签」又长在同一行上。
       用户原话：「标签的修改要在修改按钮点击之后才能修改，不能分散。
                  如果没有点击修改按钮那么就只是显示标签就行了」。 */
    name: '⚠⚠⚠ 展示态的标签行被改回可点（入口又散出去了）',
    file: 'src/screens/result/Result.tsx',
    from: "                  {canTags ? (\n                    <View style={s.infoRow}>\n                      <Text style={s.infoLabel}>标签</Text>",
    to: "                  {canTags ? (\n                    <Pressable style={s.infoRow} onPress={onTagOpen}>\n                      <Text style={s.infoLabel}>标签</Text>",
    expect: '展示态那一行是普通 View'
  },
  {
    /* ⚠⚠ 归类成功却不推版本号 ⇒ 记录页 onShow 判「版本没变」不重拉，
       卡片上那枚 chip 停在归类之前（功能全对，就是「看不出来」）。 */
    name: '⚠⚠⚠ 换标签成功后不推记录页版本号（列表上的标签永远不更新）',
    file: 'src/screens/result/Result.tsx',
    from: "      loadTags();\n      /* ⚠⚠⚠ 见上面那段：让记录页下次进来时重拉列表（卡片上的 chip 才会跟着变）。\n         放在**成功分支**里 —— 失败时云端没变，推版本号只会白拉一次。 */\n      history.bumpRev();",
    to: "      loadTags();",
    expect: '归类成功后必须推一次'
  },
  {
    /* ⚠⚠ 导出没了 = 调用点是 `undefined is not a function`，
       而且是**点了标签才崩** —— tsc 看不见（history 是 any require）。 */
    name: '⚠⚠ history.js 不导出 bumpRev（点标签就崩）',
    file: 'src/core/history.js',
    from: "  bumpRev: bumpRev,",
    to: "",
    expect: 'history.js 必须导出'
  },
  {
    /* ⚠ 调用点漏传 onTagOpen ⇒ EditBlock 里那一行拿到 undefined，
       `onPress={undefined}` 静默失效（行还在、点了没反应）。 */
    name: '⚠⚠ 调用点漏传 onTagOpen（修改态那一行点了没反应）',
    file: 'src/screens/result/Result.tsx',
    from: "                  canTags={canTags}\n                  tagName={tagName}\n                  onTagOpen={onTagOpen}",
    to: "                  canTags={canTags}\n                  tagName={tagName}",
    expect: '调用点必须把这三个透传下去'
  },

  /* ================= 保存窗里也能选标签（2026-10-05 用户要求）=================
     用户原话：「点击保存到记录按钮，弹窗能不能同时有选择标签的功能」
     ⚠⚠ 这一组里最毒的一条是**顺序**：归类接口要 `records/:id`，而新记录在点「保存」
        那一刻还没有 id（id 由 push 时的 record.slim 生成）⇒ 归类只能是 push 成功
        之后的**第二次请求**。写成用 `chatRecId`（或挪到 push 之前）不会报任何错，
        界面上只表现为「选了标签但没生效」—— 正是这种错要拦。 */
  {
    name: '⚠⚠⚠ 保存窗的标签草稿被带进轻记录（tagId 只走专用接口，整行 PUT 不认它）',
    file: 'src/screens/result/model.js',
    /* ⚠ 2026-10-06 改锚点：saveAskCommit 里多了职业那两行（新增 job 字段），
       原来「desc 那行接着 return」的锚点匹配不上了 —— 锚点必须跟着源码一起搬。 */
    from: "  next.job = j || undefined;\n  return mergePatchFn(rec, next);",
    to: "  next.job = j || undefined;\n  if (a.tagId) next.tagId = a.tagId;\n  return mergePatchFn(rec, next);",
    expect: '保存窗的标签草稿不许进轻记录'
  },
  {
    name: "⚠⚠ 保存窗里 'none' 没翻成 null（会拿一个叫 none 的 id 去写库）",
    file: 'src/screens/result/model.js',
    from: "  return k === '' || k === tagsLib.TAG_NONE ? null : k;",
    to: "  return k === '' ? null : k;",
    expect: '必须翻成 null'
  },
  {
    /* ⚠⚠ 草稿是 null，而「未分类」格子的 key 是保留值 'none' ——
       直接 `it.key === cur` 会让这一格**永远不高亮**（一打开就像没选中任何标签）。
       这条断言是写代码时当场踩出来的，不是事后补的。 */
    name: '⚠⚠ 保存窗那排「未分类」永远不高亮（拿 null 去比字符串 none）',
    file: 'src/screens/result/model.js',
    from: '    const on = cur === null ? it.key === tagsLib.TAG_NONE : it.key === cur;',
    to: '    const on = it.key === cur;',
    expect: '这一格必须高亮'
  },
  {
    name: '⚠⚠⚠ 归类用 chatRecId 发（该用 push 回来的那条 id —— 新记录此刻才有 id）',
    file: 'src/screens/result/Result.tsx',
    from: '        tagsLib.setFor(hit.id, want).then((r: any) => {',
    to: '        tagsLib.setFor(chatRecId, want).then((r: any) => {',
    expect: '归类在 push 成功之后补发'
  },
  {
    name: '⚠⚠⚠ 归类成功不推版本号（回记录页不重拉，卡片上看不出刚选的标签）',
    file: 'src/screens/result/Result.tsx',
    from: "          history.bumpRev();\n          /* ⚠ 顺手重拉标签列表：count 变了（这条刚归进去）。 */\n          loadTags();",
    to: '          loadTags();',
    expect: '归类成功也要推版本号'
  },
  {
    name: '⚠⚠ 保存窗的标签块去掉了「至少建过一个标签」的条件（只剩「未分类」也显示，白占一行）',
    file: 'src/screens/result/Result.tsx',
    from: '                {canTags && saveBar.length > 1 ? (',
    to: '                {canTags ? (',
    expect: '至少建过一个标签'
  },
  {
    name: '⚠⚠ 归类失败被并进「已保存」（记录存了、标签没贴上，报成功就是撒谎）',
    file: 'src/screens/result/Result.tsx',
    from: "            showToast('已保存，但标签没贴上');",
    to: '            showToast(out.toast);',
    expect: '归类失败要说实话'
  },

  /* ================= 职业字段（2026-10-06 新增，用户：「同姓名和描述一样」）=================
     它是一条**贯穿三处契约**的字段（前端 OPTIONAL_FIELDS / 服务端 lib/record.ts /
     upsert 列清单），任何一处漏掉都不会报错，只会「静默少一个字段」。
     这里守的是前端侧最容易错的三处：patch 串字段、提示文案撒谎、恒显行被当普通字段。
     ⚠ 服务端那两处（白名单 / upsert）由 tools/smoke.ts 的第 6 节守。 */
  {
    name: '⚠⚠ editPatch 漏了职业（打在职业框里的字写不回草稿 = 那个框打不动）',
    file: 'src/screens/result/model.js',
    from: "    job: p.job !== undefined ? p.job : c.job,\n",
    to: "",
    expect: '改了职业 → patch 带 job'
  },
  {
    name: '⚠⚠ 改完职业的提示不说职业（只改职业却报「描述已保存」这种谎话）',
    file: 'src/screens/result/model.js',
    from: "  if (p.job !== undefined) names.push('职业');\n",
    to: "",
    expect: '只改职业必须说「职业」'
  },
  {
    name: '⚠⚠ 职业的恒显行被删掉（清空后就再也没有入口填回来 —— 与描述同一条规则）',
    file: 'src/screens/result/model.js',
    from: "  const jobRaw = rec.job === undefined || rec.job === null ? '' : String(rec.job);\n  rows.push({\n    label: '职业',\n    value: jobRaw,\n    multiline: false,\n    always: true,\n    empty: !jobRaw.trim()\n  });\n",
    to: "",
    expect: '「职业」这一栏**照样在**'
  }
];

/* ------------------------------------------------------------------ */

function stateFile() {
  return path.join(__dirname, '.neg-screens-state.json');
}
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch (err) {
    return [];
  }
}
function saveState() {
  const s = loadState();
  const i = parseInt(process.argv[2], 10);
  if (s.indexOf(i) < 0) s.push(i);
  fs.writeFileSync(stateFile(), JSON.stringify(s));
}
/**
 * ⚠⚠ 备份路径必须**带用例下标**（曾经只按文件名生成）。
 *   同一份源码被两个用例注入时（本项目就有一对：27 与 29 都改 Result.tsx），
 *   只按文件名生成 ⇒ 两个用例**共用同一个备份文件**。后果：
 *     · 正常一轮 inject→restore 没事（每次 restore 都会删掉备份）；
 *     · 但只要有一轮**中途被打断**（命令超时 / 被打断 / 忘了 restore），
 *       残留的备份会在下一次 inject 时因为「已存在」而**不被刷新**
 *       （见 inject 里的 existsSync 判断），restore 就会把**过期内容**
 *       写回源码 —— 静默改坏一个源文件，且测试照样全绿。
 *   实测踩过：连跑两轮 30 用例，第二轮之后 App.tsx 的组合哈希对不上，
 *   查了半天才发现是这个共享备份的坑。
 */
function backupPath(i) {
  /*
   * ⚠ 下标必须**带在文件名里**（理由见上面的长注释）。
   * ⚠ 顺序与 _neg-inject.js / _neg-cloudbase.js 保持一致：`<源文件>.nv-backup.<i>`。
   *   本脚本原来写成 `<源文件>.<i>.nv-backup`，与另两个脚本不一样 ——
   *   结果是 .gitignore 里那条 `*.nv-backup.*` 盖不住它（`foo.js.3.nv-backup`
   *   后面没有东西了），备份会**被提交进版本库**。统一成一种写法，
   *   一条 `*.nv-backup*` 就全盖住了。
   */
  return absOf(i) + '.nv-backup.' + i;
}
function absOf(i) {
  return path.join(ROOT, CASES[i].file);
}

function inject(i) {
  const c = CASES[i];
  if (!c) throw new Error('没有第 ' + i + ' 个用例');
  const abs = absOf(i);
  const orig = fs.readFileSync(abs, 'utf8');

  /*
   * ⚠⚠ 全局兜底：磁盘上只要还有**任何**备份，就拒绝注入。
   *   有备份 = 上一轮没配对的 restore（被打断 / 超时 / 抛错）。
   *   这时继续注入会把「已经脏了的当前内容」当成 pristine 存进新备份，
   *   之后 restore 就把脏内容原样写回去 —— 源码被永久改坏且测试可能仍绿。
   *   本项目就是这样被静默改坏了 6 个源文件。
   */
  if (scanOrphans().length) {
    throw new Error(
      '⚠ 磁盘上还有残留备份（上一轮没还原干净），拒绝注入。\n' +
      '  → 先跑：node tools/_neg-screens.js restore'
    );
  }

  /*
   * ⚠⚠ 「已经处于注入态」靠下面的**锚点检查**兜住就够了，别另写判据：
   *   注入态的定义就是「锚点 c.from 不在了」。曾经想用「c.to 是否已出现」来判断，
   *   但多数用例的 c.to 本身就是 c.from 的子串（注入 = 删掉 forEach 那几行），
   *   于是每次都被误判成「已经注入」，一个用例都跑不了 —— 假的守门比没有更糟。
   */

  /* ① 锚点必须存在（不在 ⇒ 要么文件已经处于注入态，要么用例写错了） */
  if (orig.indexOf(c.from) < 0) {
    throw new Error('⚠ 锚点不存在（文件可能已处于注入态，或用例写错了）：' + c.file);
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
  /*
   * ⚠⚠ 顺序至关重要：**先逐字节校验，通过之后才删备份**。
   *   早先这里是「先 unlinkSync 再比对」，一旦比对不过就抛错退出，
   *   而备份**已经被删掉**了 —— 原始内容永久丢失、源码停在注入态，
   *   而且没有任何报错留在屏幕上（异常被调用方的重定向吞了）。
   *   本项目就因此被静默改坏了 6 个源文件（靠测试才挖出来）。
   *   ⇒ 备份是唯一的救命稻草，校验没过时必须留着它。
   */
  const now = fs.readFileSync(abs, 'utf8');
  if (now !== orig) {
    throw new Error(
      '⚠ 还原不干净（备份已保留，别再动它）：' + CASES[i].file + '\n  备份：' + b
    );
  }
  stashBackup(b);
  return true;
}

/**
 * 把备份文件「删掉」—— 实际是 **renameSync 挪进 .neg-stash/**，不是 unlink。
 *
 * ⚠⚠ 为什么不用 unlinkSync：本机的删除**对下一个进程不可见**（stale FS view）。
 *   实测：`restore` 里 unlinkSync 不抛错、本进程查 `existsSync` 也 false，
 *   但紧接着**下一进程**（驱动里的 `scanOrphans()`）仍看得见这个文件 ⇒
 *   驱动把「上一轮没还原干净」当成真事，`inject` 直接拒绝
 *   （实测跑到 83 例里的第 1 例就整轮停掉，`DONE fail=1 passed=1/83`）。
 *   同一个坑 `_neg-reset-local.js` 已经用 renameSync 绕过（见它的文件头），
 *   这里照抄：**rename 不走删除路径**，对新进程立即可见。
 * ⚠ stash 必须落在**同一个盘**：项目在 D 盘、`os.tmpdir()` 在 C 盘，
 *   跨盘 rename 报 `EXDEV`。所以放项目内的 `.neg-stash/`（不进版本库）。
 */
function stashBackup(b) {
  try {
    const dir = path.join(ROOT, '.neg-stash', 'screens');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(b, path.join(dir, path.basename(b) + '.' + Date.now()));
    return;
  } catch (e) {
    /* rename 都失败了才退回删除（至少别把备份留在源码目录里） */
  }
  fs.unlinkSync(b);
}

/**
 * ⚠⚠ 快照 / 校验：把「所有会被注入的源文件」的 md5 记下来，
 *   跑完负向验证后再比一遍。这是唯一能发现「某个文件被留在注入态」的手段 ——
 *   测试全绿也**不能**排除它（被改坏的可能是测试没覆盖到的地方）。
 */
function baselineFile() {
  return path.join(__dirname, '.neg-screens-baseline.json');
}
function snapshot() {
  const fs2 = require('fs');
  const cr = require('crypto');
  const map = {};
  const seen = {};
  CASES.forEach(function (c) {
    if (seen[c.file]) return;
    seen[c.file] = true;
    const p = path.join(ROOT, c.file);
    if (fs2.existsSync(p)) {
      map[c.file] = cr.createHash('md5').update(fs2.readFileSync(p)).digest('hex');
    }
  });
  fs2.writeFileSync(baselineFile(), JSON.stringify(map, null, 2));
  return Object.keys(map).length;
}
function verify() {
  const fs2 = require('fs');
  const cr = require('crypto');
  if (!fs2.existsSync(baselineFile())) throw new Error('还没 snapshot 过');
  const base = JSON.parse(fs2.readFileSync(baselineFile(), 'utf8'));
  const bad = [];
  Object.keys(base).forEach(function (f) {
    const p = path.join(ROOT, f);
    const now = fs2.existsSync(p)
      ? cr.createHash('md5').update(fs2.readFileSync(p)).digest('hex')
      : '(文件没了)';
    if (now !== base[f]) bad.push(f + '\n    ' + base[f] + ' → ' + now);
  });
  return bad;
}

/**
 * 扫出磁盘上所有残留备份的用例下标。
 * ⚠ 为什么不能只靠 state 文件：state 文件可能先被删掉 / 写坏，
 *   而备份还在（此时按 state 恢复会一条都找不到、源码永远停在注入态）。
 *   文件名形如 `<源文件>.<index>.nv-backup`，直接从中解析下标。
 */
function scanOrphans() {
  const out = [];
  CASES.forEach((c, i) => {
    if (fs.existsSync(backupPath(i))) out.push(i);
  });
  return out;
}

function main() {
  const arg = process.argv[2];
  if (arg === 'list') {
    CASES.forEach((c, i) => console.log(i + '\t' + c.name));
    return;
  }
  if (arg === 'restore') {
    /* state 里记的 + 磁盘上扫到的，取并集（防止 state 丢了但备份还在） */
    const pending = loadState().concat(scanOrphans());
    const uniq = [];
    pending.forEach((i) => { if (uniq.indexOf(i) < 0) uniq.push(i); });
    let n = 0;
    uniq.forEach((i) => { if (restore(i)) n++; });
    /* state 文件同样走 renameSync（理由见 stashBackup 的注释：删除对新进程不可见） */
    if (fs.existsSync(stateFile())) stashBackup(stateFile());
    console.log('RESTORED ' + n + ' files' + (uniq.length ? '' : '（本来就干净）'));
    /* 最后再扫一遍：还有残的就报错，别假装成功了 */
    const left = scanOrphans();
    if (left.length) throw new Error('⚠ 仍有 ' + left.length + ' 个备份没清掉：' + left.join(','));
    return;
  }
  if (arg === 'snapshot') {
    console.log('SNAPSHOT ' + snapshot() + ' files → ' + baselineFile());
    return;
  }
  if (arg === 'check') {
    /*
     * 锚点预检：**所有**用例的 `from` 是否还在源码里。
     *
     * ⚠ 为什么需要它：只要改动源码里的用户可见文案（本项目经常发生），
     *   引用了那段文案的用例锚点就会**整批失效**。
     *   而 inject 是「撞到一个就 exit」⇒ 循环停在第 N 例，
     *   修好再跑，又停在第 N+1 例 —— 一例一撞，白跑好几轮。
     *   ⇒ 每次改完源码先跑一次 check，一次看全。
     */
    const bad = [];
    CASES.forEach(function (c, i) {
      let src = '';
      try { src = fs.readFileSync(absOf(i), 'utf8'); }
      catch (err) { bad.push(i + '  ' + c.file + '   ← (文件读不到)'); return; }
      if (src.indexOf(c.from) < 0) bad.push(i + '  ' + c.file + '   ←  ' + c.name);
    });
    if (bad.length) {
      console.error('锚点失配 ' + bad.length + ' / ' + CASES.length + ' 例：');
      bad.forEach(function (b) { console.error('  ' + b); });
      process.exit(1);
    }
    console.log('ANCHOR-OK 全部 ' + CASES.length + ' 例的锚点都在');
    return;
  }
  if (arg === 'verify') {
    const bad = verify();
    if (bad.length) {
      console.error('VERIFY-FAIL 有 ' + bad.length + ' 个源文件与快照不一致：');
      bad.forEach((b) => console.error('  ' + b));
      process.exit(1);
    }
    console.log('VERIFY-OK 所有源文件与快照逐字节一致');
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
