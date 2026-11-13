/**
 * 在线心跳 + 指令接收（**长轮询**）—— App 侧
 *
 * ============ 这不是 WebSocket，别按 WebSocket 的直觉读 ============
 * 就是「发一个普通 HTTP 请求 → 服务端**挂住**最多 25 秒 → 有指令就立刻回」。
 * 一个请求同时干三件事：
 *   ① 报「我在线」（服务端据此在后台把这个人显示成在线）
 *   ② 确认上次收到过的指令（服务端记 acked_at）
 *   ③ 把待处理指令捎回来
 * 合在一个请求里是**省**：拆成三个接口，手机每次唤醒要多打两个往返。
 * 空闲时的成本 = 每 25 秒一个请求；断线不用管，下一次请求自然重连（普通 HTTP）。
 *
 * ============ 为什么放在 core/ ============
 * 「游标怎么推进 / 重复的指令怎么办 / 失败了隔多久再问 / 收到不认识的 kind 怎么办」
 * 全是纯逻辑，不 import React / RN ⇒ 纯 Node 就能断言（本项目的老规矩）。
 * 视图层（App.tsx）只负责两件事：把 action 变成「跳页 / 弹提示」，以及何时 start / stop。
 *
 * ============ ⚠⚠⚠ 四条最容易写错的 ============
 * ① **请求超时必须大于服务端的挂起时间**。localsdk 的默认超时是 10 秒，
 *    而服务端最长挂 25 秒 —— 直接吃默认值的话，每次「没有指令」的正常等待
 *    都会在客户端先超时，表现成「心跳**永远**在失败」，而服务端那边一切正常。
 *    这是个只看日志永远看不出来的自相矛盾（两边各自都觉得自己对）。
 * ② **游标只能由客户端推进，而且要「处理完」再存**：
 *    收到就存 = 至多一次（存完就崩 ⇒ 那条指令永远丢了）；
 *    处理完再存 = 至少一次（服务端的重发窗口 + 本文件的 seen 去重兜住重复）。
 * ③ **不认识的 kind 不算失败**：忽略它，但**照样 ack + 照样推进游标**。
 *    否则一条老版本 App 看不懂的指令会把它**永远卡在同一个游标上**，
 *    后面所有指令都收不到（一个静默的「功能整体停摆」）。
 * ④ **失败要退避**（RETRY_MS）。服务没启动时立刻重发 = 忙循环，
 *    烧的是用户的电和流量，换来的是一串必然失败的请求。
 * ⑤ **游标要按账号分开存**（见 cursorKey）。同一个手机上换过账号的话，
 *    共用一个游标会让**后来那个账号的指令被静默跳过** ——
 *    现象是「后台发了，App 什么反应都没有」，而两边都觉得自己没错。
 * ⑥ **退场时要主动说一声「我走了」**（bye → POST /presence/offline）。
 *    服务端判在线靠的是「最后一次心跳距今 < 60 秒」，不说的话用户关掉 App
 *    之后后台还要亮一分钟灯。说了 = 立刻变离线。
 *    ⚠ 它是**加速**不是必需：App 被杀掉/断网时说不了，仍然退化回那 60 秒窗口 ——
 *      所以两边都要在，别因为有了它就以为窗口可以不要了。
 *    ⚠ 只有**真的退场**才说（退后台 / 退出登录 / 卸载）。心跳因为 401 自己停下时
 *      **不说** —— 那时凭证已经废了，说了也是一串 401（见 stop 的 opts.offline）。
 * ⑦ **被强制下线有两条路，两条都要认**：
 *    · 在线 → 服务端下发的 `logout` 指令（秒级，pump 把它交给 onAction）
 *    · 不在线 / 请求先到 → **任意接口回 401**（pump 里那条 `status === 401`）
 *    两者最终都要落到同一件事：清凭证 + 回未登录态 + **清掉本账号的游标**。
 *    ⚠ 最后那一步（clearCursor）不是可选项：那条 logout 指令**还留在服务端库里**
 *      （审计要留），游标不清的话，用户重新登录后的第一次心跳会把它当成
 *      「待处理的新指令」再收一遍 —— 现象是「刚登录就又被踢」，而两边日志都正常。
 *      清掉 = 下次心跳是「第一次心跳」，服务端从当前最大 id 开始，不补历史。
 *
 * ⚠ 本文件只管「逻辑」，**不碰 UI**：Toast 长什么样、goto 跳到哪个页面是 App 的事。
 *   连「goto 的目标页合不合法」也不在这里判 —— 那是 tabs/model.js 的 isTab 的活。
 */
const localsdk = require('./localsdk.js');
const session = require('./session.js');
const storage = require('../platform/storage.js');
const storeMode = require('./storeMode.js');

/** 心跳路径（服务端：paipan-server/src/routes/presence.ts） */
const PING_PATH = '/presence/ping';

/** 主动下线路径 —— 退场时说的那句「我走了」 */
const OFFLINE_PATH = '/presence/offline';

/**
 * 「我走了」这句话的超时。
 *
 * ⚠⚠ 必须**比 REQUEST_TIMEOUT_MS 短得多**，理由与心跳那条恰好相反：
 *   心跳等 25 秒是**业务**（等指令），而这句话只是一句通知 ——
 *   服务端要是没响应，等 40 秒才收摊会把用户按「退出」之后的流程生生拖住。
 *   5 秒足够：局域网里正常是毫秒级，发不出去就算了（60 秒窗口兜底）。
 */
const OFFLINE_TIMEOUT_MS = 5000;

/**
 * 服务端一次最多挂多久（毫秒）—— 与 paipan-server/src/lib/presence.ts 的 WAIT_MS 默认值一致。
 * ⚠ 给测试用的 `PRESENCE_WAIT_MS` 环境变量改的是**服务端**那个值；客户端这个常量
 *   只是「留余量」的参照，不必跟着变（超时给的是上限，不是等值）。
 */
const SERVER_WAIT_MS = 25000;

/**
 * 本文件单请求的超时。
 * ⚠⚠⚠ 必须**比 SERVER_WAIT_MS 大** —— 见文件头 ①。15 秒余量给的是
 * 「长轮询刚醒来 + 局域网抖一下」的缓冲，正常情况根本用不到。
 */
const REQUEST_TIMEOUT_MS = SERVER_WAIT_MS + 15000;

/** 两次心跳的**最小**间隔：成功之后也隔一下再发（见下面 pump 的注释） */
const MIN_GAP_MS = 250;

/** 失败后的退避（见文件头 ④） */
const RETRY_MS = 5000;

/** 游标存储键的**前缀**（真正的键还要拼上账号，见 cursorKey） */
const CURSOR_KEY = 'paipan_presence_cursor_v1';

/** 本进程内最多记住多少条已处理 id（去重窗口，防止长跑时无界增长） */
const SEEN_MAX = 200;

/* ------------------------------------------------------------ 游标 */

/**
 * 游标存哪个键 —— **按账号分开**。
 *
 * ⚠⚠⚠ 为什么必须分账号（这是个真会踩的坑）：
 *   指令 id 是**全局单调**的，游标的含义是「我已经处理到哪了」。同一个手机换过账号时，
 *   共用一个游标会这样：
 *     A 账号把游标推到 100 → 换 B 账号登录 → 后台给 B 发一条 **id 比 100 小**的指令
 *     （比如 B 离线期间就该收到的那条）→ 它落在游标后面，**永远收不到**。
 *     现象是「后台明明发了，App 什么都没发生」，而两边都觉得自己没错。
 *   分成两个键之后，每个账号从**自己**的进度继续，谁也不影响谁。
 *   （另一个做法是退出登录时清游标，但那会让「离线期间收到的指令」在重新登录后
 *     被当成第一次心跳而全部跳过 —— 更糟。）
 *
 * @param {string} [uid] 不传 = 现取 session.uid()（正常路径都走这个）
 */
function cursorKey(uid) {
  const u = (uid === undefined) ? session.uid() : uid;
  return CURSOR_KEY + ':' + (u || 'anon');
}

/**
 * 归一化一个游标值。
 *
 * ⚠⚠ 返回 **null** 表示「没有可用的游标」= **第一次心跳**：
 *   服务端收到这个会从「当前最大 id」开始，一条历史指令都不给。
 *   ⚠ 千万别让它落到 0 —— 0 是**合法值**（「我从头收」），
 *     把读不出来的值当成 0，等于让 App 把历史上所有广播指令重放一遍。
 */
function toCursor(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** 读本地存着的游标（当前账号的）。读不出/存坏了都回 null（第一次心跳），绝不兜成 0 */
function readCursor(uid) {
  try {
    return toCursor(storage.getStorageSync(cursorKey(uid)));
  } catch (err) {
    return null;
  }
}

/** 存游标（内存 + 异步落盘）。传 null 什么都不做 */
function writeCursor(n, uid) {
  const v = toCursor(n);
  if (v === null) return null;
  try {
    storage.setAndPersist(cursorKey(uid), String(v));
  } catch (err) {
    console.warn('[paipan] 保存心跳游标失败', err);
  }
  return v;
}

/** 忘掉当前账号的游标（下次心跳 = 第一次心跳，不补历史） */
function clearCursor(uid) {
  try {
    const k = cursorKey(uid);
    storage.removeStorageSync(k);
    storage.persistKey(k);
  } catch (err) { /* 清不掉不该崩 */ }
}

/**
 * 算下一个游标 = max(旧值, 服务端建议值, 本批最后一条 id)。
 *
 * ⚠ 只增不减：任何一条路径都不许把游标往回拨 —— 回拨意味着「历史重放」。
 * ⚠ 服务端回的那个 cursor 是**建议值**（= 本批最后一条的 id），
 *   它在这里只是候选之一；本批 id 也一起参与取最大，
 *   这样即使服务端某天不回 cursor 了，客户端照样能往前推进（不依赖单一来源）。
 */
function nextCursor(prev, wire, ids) {
  let max = toCursor(prev);
  const list = [toCursor(wire)].concat((ids || []).map(function (x) { return toCursor(x); }));
  list.forEach(function (n) {
    if (n === null) return;
    if (max === null || n > max) max = n;
  });
  return max;
}

/* -------------------------------------------------------- 指令 → 动作 */

/**
 * 把一条服务端指令翻译成「该做什么」——**纯函数**。
 *
 * 返回 null 表示「这条我不认识 / 它自己就是坏的」，调用方**忽略它但照样 ack**
 * （见文件头 ③）。别在这里抛错：一条坏指令不该让整个心跳循环停下来。
 *
 * ⚠ kind 白名单与服务端 `paipan-server/src/routes/adminCommands.ts` 的 KINDS 对齐。
 *   那边加一种新指令，这里要跟着加一条分支；不加的后果是「新指令静默无效」
 *   （不报错、也不卡住 —— 见文件头 ③ 那条为什么照样要 ack）。
 *
 * 形状：`{ type:'toast', text }` / `{ type:'goto', tab }` / `{ type:'logout', reason }`
 *   · tab 是**页面 key**（records / paipan / study / settings），
 *     合不合法由 App 用 tabs/model.js 的 isTab 判 —— 本层不认识页面。
 *   · logout 的 reason **可以为空**（管理员没写理由时）：那时它仍然是一条
 *     必须执行的指令，只是由 App 用一句默认话术。⚠ 别照 toast 的写法
 *     「空就返回 null」—— 那会让「没写理由的强制下线」**静默失效**。
 */
function action(command) {
  const c = command || {};
  const p = (c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload)) ? c.payload : {};

  if (c.kind === 'toast') {
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    return text ? { type: 'toast', text: text } : null;
  }
  if (c.kind === 'goto') {
    const tab = typeof p.tab === 'string' ? p.tab.trim() : '';
    return tab ? { type: 'goto', tab: tab } : null;
  }
  if (c.kind === 'logout') {
    /* ⚠ 被管理员强制下线。这里只**翻译**成动作，清凭证 / 回登录页是 App 的事
       （本层不碰登录态 —— 见文件头「本文件只管逻辑，不碰 UI」）。 */
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    return { type: 'logout', reason: reason };
  }
  return null;
}

/* ------------------------------------------------------------ 取令牌 */

/**
 * 默认的「发一次心跳」。
 *
 * ⚠ 令牌走 `session.getAccessToken()`，**不自己读 storage / auth** ——
 *   「令牌」这件事由 session 一层独占（见 session.js 文件头），
 *   别的层只依赖它。顺带白拿一个好处：令牌真过期时它会清掉本地凭证，
 *   这里收到的就是 `EXPIRED`，循环据此停摆而不是空转。
 */
function defaultPing(body) {
  return session.getAccessToken().then(function (t) {
    if (!t || !t.ok) {
      return {
        ok: false,
        code: (t && t.code) || 'NO_SESSION',
        error: (t && t.error) || '还没有登录'
      };
    }
    return localsdk.request(PING_PATH, {
      method: 'POST',
      token: t.token,
      body: body || {},
      /* ⚠⚠⚠ 这个字段是**必须显式给**的，见文件头 ① —— 少它就是「心跳永远在失败」。 */
      timeoutMs: REQUEST_TIMEOUT_MS
    });
  });
}

/* -------------------------------------------------------- 退场（说再见） */

/**
 * 告诉服务端「我走了」：立刻标离线 + 唤醒服务端那边挂着的 ping。
 *
 * ============ 为什么要单独说这一句 ============
 * 不说也能「最终」离线 —— 服务端的判据是「最后一次心跳距今超过 60 秒」
 * （paipan-server/src/lib/presence.ts 的 ONLINE_WINDOW_MS）。
 * 但用户关掉 App 之后后台还要亮一分钟灯，正是「后台看在线」最别扭的地方。
 * 说了，后台**立刻**变离线。
 *
 * ============ ⚠⚠ 三条纪律 ============
 * ① **永不 reject、绝不抛**：这是收摊时捎带的一句话，不是业务请求。
 *    它失败不该影响任何流程（App 该退就退、该登出就登出）。
 * ② **超时要短**（OFFLINE_TIMEOUT_MS）。理由见那个常量的注释。
 * ③ **只有真的要走了才发**：退后台 / 退出登录 / 卸载时发；
 *    心跳因 401 之类自己停下来时**不发**（凭证已经废了，发了也是一串 401）——
 *    开关在 `stop({ offline: true })`。
 *
 * ⚠ 它是**尽力而为**的：App 被系统杀掉、断网、崩溃时根本发不出去。
 *   所以服务端那个 60 秒窗口必须留着当兜底 —— 别因为有了这个接口就去调大它。
 *
 * @param {Function} [report] 打点用（收 `('bye', result)`），默认什么都不做
 * @returns {Promise<{ok:boolean, code?:string, error?:string}>} 永不 reject
 */
function bye(report) {
  const rep = report || function () {};
  return session.getAccessToken().then(function (t) {
    if (!t || !t.ok || !t.token) {
      /* ⚠ 没凭证就**不发请求**：发出去必然 401，只是白刷一屏错误日志。
         真会走到的场景：登录已过期，或者退出登录时凭证已经被清掉了。
         （后者意味着那条路径上要说的话得**在清凭证之前**说 —— 见 Settings.tsx 的退出登录。） */
      const no = { ok: false, code: (t && t.code) || 'NO_SESSION', error: (t && t.error) || '还没有登录' };
      rep('bye', no);
      return no;
    }
    return localsdk.request(OFFLINE_PATH, {
      method: 'POST',
      token: t.token,
      body: {},
      timeoutMs: OFFLINE_TIMEOUT_MS
    }).then(function (r) { rep('bye', r); return r; });
  }).catch(function (err) {
    const bad = { ok: false, code: 'THROW', error: String((err && err.message) || err) };
    rep('bye', bad);
    return bad;
  });
}

/* ------------------------------------------------------------ 循环本体 */

/**
 * 造一个心跳循环。**可注入**（`ping` 换成假的就能纯 Node 跑用例，不用起服务端）。
 *
 * @param {Object} [opts]
 * @param {Function} [opts.ping]   `(body) => Promise<{ok, cursor?, commands?}>`，默认走真接口
 * @param {Function} [opts.onAction] `(action, command) => void` —— 收到指令干什么（App 决定）
 * @param {Function} [opts.onStatus] `(kind, info) => void` —— 打点/调试用；
 *        kind ∈ start | stop | ok | error | unknown | unsupported
 * @returns {{start:Function, stop:Function, isRunning:Function, tick:Function}}
 */
function createLoop(opts) {
  const o = opts || {};
  const pingFn = o.ping || defaultPing;
  const onAction = o.onAction || function () {};
  const onStatus = o.onStatus || function () {};

  /** 已处理过的指令 id（内存去重）。⚠ 只在本进程内有意义 —— 跨进程靠游标 */
  const seen = {};
  const seenOrder = [];
  /** 已执行完、等着下次心跳上报的 id（服务端据此记 acked_at = 后台那个「已送达」） */
  let acks = [];
  let running = false;
  let inFlight = false;
  let timer = null;

  function markSeen(id) {
    if (seen[id]) return;
    seen[id] = true;
    seenOrder.push(id);
    while (seenOrder.length > SEEN_MAX) delete seen[seenOrder.shift()];
  }

  /**
   * 走一次心跳往返。**可单独调用**（用例就是这么跑的，不依赖 setTimeout）。
   * ⚠ 重入保护：上一次还挂着（长轮询本来就挂 25 秒）时直接返回 BUSY，
   *   不然「按一下就多一条挂着的连接」会悄悄攒起来。
   */
  function tick() {
    if (inFlight) return Promise.resolve({ ok: false, code: 'BUSY' });
    inFlight = true;

    /* ⚠⚠ 账号在 tick **一开始**就定下来，读和写都用它：
       长轮询要挂 25 秒，这期间用户完全可能退出登录或换账号 ——
       写游标时必须写回**发出这次请求的那个账号**，不然进度会记到别人头上
       （那个人的指令就会被静默跳过，而这里不会有任何报错）。 */
    const who = session.uid();

    const cur = readCursor(who);
    const body = {};
    if (cur !== null) body.cursor = cur;
    /* ⚠ ackIds 只上报「已经处理完」的那些（见文件头 ② 的至少一次语义） */
    if (acks.length) body.ackIds = acks.slice();

    return Promise.resolve()
      .then(function () { return pingFn(body); })
      /* ⚠ 注入的 ping 万一 reject 了也要接住：循环不能因为一次异常就死掉 */
      .catch(function (err) {
        return { ok: false, code: 'THROW', error: String((err && err.message) || err) };
      })
      .then(function (r) {
        inFlight = false;
        const res = r || { ok: false, code: 'NO_RESULT', error: '心跳没有返回结果' };

        if (!res.ok) {
          onStatus('error', res);
          return res;
        }

        const list = Array.isArray(res.commands) ? res.commands : [];
        /* 挑出「本批真正要执行的」：形状不对的丢掉、本进程处理过的丢掉。
           ⚠ 服务端是「至少一次」语义（没 ack 的会重发），去重在这里兜。 */
        const fresh = list.filter(function (c) {
          const id = toCursor(c && c.id);
          if (id === null) return false;
          if (seen[id]) return false;
          return true;
        });
        fresh.forEach(function (c) { markSeen(toCursor(c.id)); });

        /* 先执行，**再**推进游标（文件头 ②） */
        fresh.forEach(function (c) {
          const a = action(c);
          if (!a) { onStatus('unknown', c); return; }   // ④ 不认识的：忽略，但照样往下走
          try {
            onAction(a, c);
          } catch (err) {
            /* ⚠ 执行出错**也不回头**：不推进游标的话这条会被永远重发，
               变成「一个坏指令卡死整条流水线」。记一行日志，继续。 */
            console.warn('[paipan] 指令执行失败（已跳过）', err);
          }
        });

        const next = nextCursor(cur, res.cursor, fresh.map(function (c) { return c.id; }));
        writeCursor(next, who);
        /* 这一批就是下次要上报的 ack。⚠ 是**替换**而不是追加：上一批已经随
           本次请求送到服务端了（能走到这里就说明请求是 ok 的）。 */
        acks = fresh.map(function (c) { return toCursor(c.id); }).filter(function (x) { return x !== null; });

        onStatus('ok', { count: fresh.length, cursor: next });
        return res;
      });
  }

  /**
   * 连轴转。用「成功就再来一次」的链式调度而不是 setInterval ——
   * 长轮询每次耗时不定（可能 5ms 也可能 25s），定时器会叠出一堆并发连接。
   */
  function pump() {
    if (!running) return;
    tick().then(function (r) {
      if (!running) return;
      if (r && r.ok) {
        /* ⚠ 成功也隔 MIN_GAP_MS 再发。看着多余，其实是防「中间层不实现挂起」的兜底：
           万一服务端/代理遇到空请求就立刻回 200，这里不加间隔 = 变成一个死循环，
           手机在几秒内打几千个请求。250ms 对指令的体感毫无影响（对比 25s 的等待）。 */
        timer = setTimeout(pump, MIN_GAP_MS);
        return;
      }
      /* ⚠⚠ 三种「这张令牌不该再用」的情况，一律**停下来 + 叫醒上层**：
         · NO_SESSION / EXPIRED —— 本地没有凭证 / 已过期（session 层已经清掉了）
         · **status 401** —— 服务端明确说这张票不认了（被强制下线 / 账号被删 /
           凭证形状不对）。
         401 是**最关键**的一种：被管理员踢掉的那一刻，长轮询是 App 里唯一还在跑的
         请求，它必须把「你已经被踢了」变成一个界面动作（清凭证、回未登录态）。
         漏了它，用户会停在一个「看着还登录着、其实什么都做不了」的界面上。
         ⚠ 判 `status === 401` 而不是只判 code：老版本服务端不带 code 字段，
           那时也得认出来（本文件是客户端，不能假设对端一定是最新版）。
         ⚠ 这里**不传 offline**：凭证都废了，再说一句「我走了」只会换回一串 401。 */
      if (r && (r.status === 401 || r.code === 'NO_SESSION' || r.code === 'EXPIRED')) {
        onStatus('unauthorized', r);
        stop();
        return;
      }
      timer = setTimeout(pump, RETRY_MS);
    });
  }

  /** 开始（重复调用是 no-op）。返回 false 表示「这个后端没有心跳能力」或已经在跑 */
  function start() {
    if (running) return false;
    if (!storeMode.supportsPresence()) {
      /* ⚠ 只有自建后端有 /presence/ping。别的后端**如实不启动**，
         而不是发一个必然 404 的请求然后给用户看「心跳失败」。 */
      onStatus('unsupported');
      return false;
    }
    running = true;
    onStatus('start');
    pump();
    return true;
  }

  /**
   * 停止（退后台 / 退出登录 / 换账号时调）。
   *
   * ⚠ 在飞的那一次请求不打断：**不需要**打断 —— 真退出时紧跟的那一句
   *   `bye()` 会让服务端把挂着的 ping 立刻放行（服务端先标离线再 wakeUser），
   *   那条请求自己就收摊了。少写一层 AbortController，也不会漏掉任何东西。
   *   （万一服务端不可达，那条请求就在自己的超时里结束，而循环已经停了，不会续上。）
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.offline] 顺口告诉服务端一声「我走了」（见上面的 bye）。
   *   ⚠ 只有**真的要退场**才传 true。心跳循环自己因为没登录/已过期停下来时
   *     **不能**传 —— 那条路径（pump 里的 NO_SESSION 分支）发出去只有一串 401。
   *   ⚠ `running` 已经是 false 时直接返回 false、**不发**：循环都已经不在了，
   *     再来一句「我走了」是多余的（真实场景：登录态过期后循环先自停，
   *     随后退后台又触发一次 stop）。
   */
  function stop(opts) {
    if (!running) return false;
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    onStatus('stop');
    /* ⚠ 发出去就不管（不 await）：收摊流程不该被网络拖住。
       bye 自己保证永不 reject，所以不会产生 unhandledRejection。 */
    if (opts && opts.offline) bye(onStatus);
    return true;
  }

  return {
    start: start,
    stop: stop,
    isRunning: function () { return running; },
    tick: tick,
    /** 用例用：看当前攒着没上报的 ack（正常路径下不关心） */
    pendingAcks: function () { return acks.slice(); }
  };
}

module.exports = {
  PING_PATH: PING_PATH,
  OFFLINE_PATH: OFFLINE_PATH,
  SERVER_WAIT_MS: SERVER_WAIT_MS,
  REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
  OFFLINE_TIMEOUT_MS: OFFLINE_TIMEOUT_MS,
  MIN_GAP_MS: MIN_GAP_MS,
  RETRY_MS: RETRY_MS,
  CURSOR_KEY: CURSOR_KEY,
  SEEN_MAX: SEEN_MAX,
  toCursor: toCursor,
  cursorKey: cursorKey,
  readCursor: readCursor,
  writeCursor: writeCursor,
  clearCursor: clearCursor,
  nextCursor: nextCursor,
  action: action,
  bye: bye,
  createLoop: createLoop,
  defaultPing: defaultPing,
  supportsPresence: function () { return storeMode.supportsPresence(); }
};
