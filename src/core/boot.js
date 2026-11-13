/**
 * 启动引导 —— 「静默登录 + 确认能读写云端」的唯一入口。
 *
 * 要做的事：打开应用时按用户标识（优先 unionid）确认**该用户的云端数据可访问**。
 *
 * 为什么单独抽这一层，而不是挂在某个页面的 onLoad：
 *   用户的要求是「**打开应用**就建」。而启动页是记录页 —— 把这件事写在排盘页里，
 *   用户不切到「排盘」页就永远不会触发。所以改由 App 启动时调用，
 *   页面按需复用同一份结果。
 *
 * ============ ⚠⚠ 文件级模型：`ensureFile` 又变成「查 → 按需建」 ⚠⚠ ============
 * ⚠ 当前 MODE = 'cloudbase'（记录级）⇒ 下面这一节只在 **gitee 分支**上生效。
 *   文件级模型下云端是 `userData/<uid>.json`，**一个用户一个文件**。
 * 于是「建文件」这个动作**回来了**：文件不存在时要建一个空的，
 * 否则后续「整份读-改-写」的读会拿到「不存在」。
 * 所以 STAGE.CREATING（「正在创建数据文件…」）**重新启用**。
 *
 * ⚠ 但语义和记录级时代不同：那边「没有记录就是空数组」，
 *   这边「文件不存在」是真的要写一个字节上去。两个后果：
 *   ① 建文件必须在**登录成功之后**（要先有 uid 才能拼路径）；
 *   ② 建文件失败 = 云端不可用（不能装作「用户只是还没有数据」）——
 *      因为用户一旦保存就会写失败，不如在这里就说清楚、给重试入口。
 *
 * ============ ⚠ 为什么「命中本地记忆就 0 次请求」被改掉了 ⚠ ============
 * 上一版把「这个 uid 的云端文件已备好」记进 storage，下次直接跳过网络。
 * 结果踩了个真实的坑：在云端网页上把数据删掉之后再打开 App，
 * 本地记忆仍然说「已就绪」→ 一次接口都不打 → 数据永远长不回来。
 * 缓存记的是**曾经**的事实，而云端数据是**别人也能删**的东西，两者不能等价。
 *
 * 现在的口径：
 *   · 每次**冷启动**必定跟云端核对一次（读一次该用户的文件）
 *   · 同一个冷启动内多次调用（启动 + 记录页 onShow + 排盘页）合并成一次
 *   · storage 里那份 CLOUD_KEY 降级为「离线参考 / 诊断」，不参与跳过核对
 *   · 用户点重试（force）→ 忽略本次冷启动的结论，重新登录 + 重新核对
 *
 * ============ 加载状态 ============
 * 打开应用这段时间（登录 + 一跳网络 + 可能再建一次文件）在界面上要有反馈，
 * 所以这里顺带把阶段广播出去：页面 subscribe（boot.observe）就能拿到
 *   login → checking → creating → ready / failed（见 STAGE / TEXT）
 * 文案只在这里写一份，页面别再抄一遍中文。晚订阅的页面也能立刻拿到当前阶段。
 *
 * 结果形状（页面据此映射界面状态）：
 *   { ok:true,  logged:true,  uid, source, path, count, records, action:'existing'|'created', cached }
 *   { ok:false, logged:true,  uid:'',   reason:'no-identity', error }
 *   { ok:false, logged:true,  uid,      reason:'cloud-error', error }
 *   { ok:false, logged:false,           reason:'login-fail',  error }
 *   cached:true = 本次冷启动之前已经核对过，这一份是复用的（没有打云端）
 *
 * ⚠ `path`（云端文件路径）在文件级模型下**是真实有意义的**（记录级时代它已废弃），
 *   设置页要让用户看见「数据存在哪个文件」。所以这里重新返回它。
 *
 * ⚠ 现在拿不到真 unionid（无服务端 + LOGIN_API 为空），uid 会降级到设备码 ——
 *   那是设备级标识。接上服务端后 uidOf() 自动切 unionid，这里一行都不用改。
 */
const auth = require('./auth.js');
const userStore = require('./userStore.js');
const storage = require('../platform/storage.js');
const store = require('./store/index.js');

/**
 * 上一次为哪个 uid 备好了数据。
 * ⚠ 只作离线参考（网络失败时页面还能说明「上次是谁」）与诊断，**不参与跳过核对**。
 *   文件级模型下 path 是真实信息，一并记下来。
 */
const CLOUD_KEY = 'paipan_cloud_v1';

/** 启动引导的阶段。页面据此渲染加载态，文案见 TEXT */
const STAGE = {
  IDLE: 'idle',             // 还没开始 / 已重置
  LOGIN: 'login',           // 静默登录中
  CHECKING: 'checking',     // 正在查云端有没有这个用户的数据
  CREATING: 'creating',     // 正在建数据文件（文件级模型下重新启用）
  READY: 'ready',           // 就绪
  /**
   * **云端**没读成（登录是好的），可重试 —— 唯一一种「点重试真能好」的失败。
   * ⚠ 2026-10-21 起「登录失败」不再走这个阶段（见 TEXT 的注释），FAILED 只剩云端这一种。
   */
  FAILED: 'failed',
  /**
   * 还没有登录态，等用户去登录。
   * ⚠⚠ 与 FAILED **必须**分开：新用户第一次打开 App 就是「没登录」，
   *   那是**正常状态**，不是故障。混在一起会让用户看到「登录失败」，
   *   以为应用坏了 —— 然后去点「重试」，而重试一万次也不会好，他就是得先登录。
   */
  NEED_LOGIN: 'need-login',
  SKIP: 'skip'              // 登录态里没有任何可用标识，静默跳过（不报错、不打扰）
};

/** 各阶段的文案。只写一份，页面直接用 snapshot.text */
const TEXT = {
  idle: '',
  login: '正在登录…',
  checking: '正在查询云端数据…',
  creating: '正在创建数据文件…',
  ready: '云端数据已就绪',
  created: '云端数据已建好',
  failed: '云端同步失败，点此重试',
  /**
   * ⚠⚠ 2026-10-21 用户要求去掉「登录失败，点此重试」这条（`loginFailed` 已删除）。
   *   理由与本模式下登录的唯一形态有关：登录只能由用户**手输账号密码**完成
   *   （见 auth.login），所以「登录这一步没成」只有两种情况 —— 没登录，或者断网。
   *   两种都**不是点一下重试就能好的**，给重试入口只会让人一直点。
   *   ⇒ 现在登录失败一律按 NEED_LOGIN 播（整条点 → 去登录；登录页自己会说错在哪）。
   *   ⚠ FAILED 只剩「云端同步失败」一种含义：登录是好的，只是这次没读到数据。
   */
  needLogin: '登录后可同步云端记录',
  skip: ''
};

/** 「正在等」的阶段（页面据此决定要不要转圈） */
const PENDING = [STAGE.LOGIN, STAGE.CHECKING, STAGE.CREATING];

/** 在飞的「登录 + 备好数据」（同一次冷启动内的并发去重） */
let inflight = null;

/**
 * 结论代次 —— 每次 `forget()` 都 +1，存活的那次 run 记下开跑时的代次，广播前比对。
 *
 * ⚠⚠⚠ 为什么必须有（2026-10-21 用户报障「退出登录后还显示『登录失败，点此重试』」）：
 *   `forget()` 只丢掉「已核对」的**结论**，它**收不回已经在飞的那次 run**（Promise 拦不住）。
 *   那次 run 跑完后照样 publish —— 于是用户已经登出了，界面却冒出一条失败态，
 *   而那条状态描述的其实是**上一个登录态**的事（要么登录校验没了凭证，
 *   要么云端请求被 401 打回）。两种都会显示成「可重试」，而重试永远好不了。
 *   ⇒ 每次 run 记代次，publish 前比对：对不上就整段闭嘴。
 *   这不是兜底代码，是「换人」这个动作必须配套的语义。
 */
let epoch = 0;

/** 本次冷启动内已经跟云端核对过的结论：{ uid, res } */
let verified = null;

/** 当前阶段快照（晚订阅的页面靠它立刻对齐进度） */
let snapshot = { stage: STAGE.IDLE, text: TEXT.idle, pending: false, res: null, at: 0 };

const listeners = [];

/* ------------------------------------------------------------------ 阶段广播 */

function isPending(stage) {
  return PENDING.indexOf(stage) >= 0;
}

function publish(stage, text, res) {
  snapshot = {
    stage: stage,
    text: text || '',
    pending: isPending(stage),
    res: res || null,
    at: Date.now()
  };
  // 复制一份再遍历：回调里可能会退订（页面卸载），直接遍历原数组会漏。
  listeners.slice().forEach(function (fn) {
    try {
      fn(snapshot);
    } catch (err) {
      console.warn('[paipan] boot 状态订阅回调异常', err);
    }
  });
}

/**
 * 订阅启动引导的阶段变化，**立即**用当前快照回调一次（所以晚挂载的页面不会错过进度）。
 * @param {Function} fn 收 snapshot：{ stage, text, pending, res, at }
 * @returns {Function} 退订函数（页面卸载时调）
 */
function observe(fn) {
  if (typeof fn !== 'function') return function () {};
  listeners.push(fn);
  try {
    fn(snapshot);
  } catch (err) {
    console.warn('[paipan] boot 状态订阅回调异常', err);
  }
  return function () {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function getSnapshot() {
  return snapshot;
}

/* ------------------------------------------------------------------ 缓存 */

/**
 * 读回 CLOUD_KEY。
 * ⚠ storage 是**字符串**存储（与 AsyncStorage 一致，见 platform/storage.js），
 *   写进去的对象会被 JSON.stringify ⇒ 读出来必须 JSON.parse。
 *   少了这一步 `c.uid` 就是 undefined，表现为「缓存写了却读不到」。
 */
function readCache() {
  try {
    const raw = storage.getStorageSync(CLOUD_KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return null;
  }
}

function writeCache(uid, path) {
  try {
    storage.setAndPersist(CLOUD_KEY, JSON.stringify({ uid: uid, path: path || '', at: Date.now() }));
  } catch (err) {
    /* 缓存失败不影响主流程 */
  }
}

/**
 * 上次核对成功留下的记录（离线时页面可以据此说明「上次是哪个用户」），可能为 null。
 * ⚠ 判据是 uid —— 老缓存（记录级时代写的，没有 path）也要认，别因为缺 path 就丢掉。
 */
function lastKnown() {
  const c = readCache();
  return (c && c.uid) ? c : null;
}

/**
 * 清掉本机的 CLOUD_KEY 缓存（设置页「清除本机缓存」用）。
 *
 * ⚠ 只清这个诊断缓存。排盘记录、登录态都不在这儿，本模块不碰它们 ——
 * 记录只在云端，登录态归 auth 管（清了要重新登录，代价不该由「清缓存」承担）。
 */
function clearCloudMemory() {
  try {
    storage.removeStorageSync(CLOUD_KEY);
    storage.persistKey(CLOUD_KEY).catch(function () {});
  } catch (err) {
    /* 清不掉也不影响主流程 */
  }
}

/* -------------------------------------------------------------- 云端核对 */

/**
 * 确认该用户的数据可访问（文件级：「查 → 按需建」然后读出来）。
 *
 * @param {Object} session 登录态
 * @param {boolean} quiet 不广播阶段
 * @param {Function} [emit] 广播函数（默认 publish）。run() 传一个带代次校验的进来 ——
 *   见 `epoch` 那段：换了人之后这次核对的所有进度都不该再显示。
 * @returns {Promise} 见文件头的结果形状
 */
function ensureFile(session, quiet, emit) {
  const say = typeof emit === 'function' ? emit : publish;
  const who = userStore.uidOf(session);

  if (!who.uid) {
    return Promise.resolve({
      ok: false, logged: true, uid: '', source: '',
      reason: 'no-identity', error: '登录态里没有可用的用户标识'
    });
  }

  const path = store.fileLevel() ? userStore.pathOf(who.uid) : '';

  /** 读完后统一收敛成上报的形状 */
  function report(res, action) {
    return {
      ok: true, logged: true, uid: who.uid, source: who.source, path: path,
      action: action,
      count: res.records.length,
      records: res.records
    };
  }

  if (!store.fileLevel()) {
    // 记录级：只有一跳（拉记录），没有「建文件」这一步
    return userStore.listRecords(who.uid).then(function (res) {
      if (!res.ok) {
        return {
          ok: false, logged: true, uid: who.uid, source: who.source, path: path,
          reason: 'cloud-error', error: res.error || '云端记录读取失败'
        };
      }
      writeCache(who.uid, path);
      return report(res, 'existing');
    });
  }

  /* ---- 文件级：查 →（不存在则）建 → 读 ---- */
  return userStore.ensureUserFile(who.uid).then(function (e) {
    if (!e.ok) {
      return {
        ok: false, logged: true, uid: who.uid, source: who.source, path: path,
        reason: 'cloud-error', error: e.error || '云端数据文件不可用'
      };
    }
    if (e.created && !quiet) say(STAGE.CREATING, TEXT.creating);

    // ⚠ 建完还要读一次 —— 上面 ensureUserFile 只保证「文件存在」，
    //   返回给页面的 records 得是真读出来的（新文件是空的，已有文件是实数据）
    return userStore.readUserFile(who.uid).then(function (res) {
      if (!res.ok) {
        return {
          ok: false, logged: true, uid: who.uid, source: who.source, path: path,
          reason: 'cloud-error', error: res.error || '云端数据读取失败'
        };
      }
      writeCache(who.uid, path);
      return report(res, e.created ? 'created' : 'existing');
    });
  });
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 只确认登录态（有效就复用，过期就补登），**不发云端请求**。
 * 刻意不在这里广播阶段：调用方决定要不要亮进度。
 */
function ensureSession(o) {
  return auth.ensureLogin(!!o.relogin).then(function (res) {
    if (!res.ok) {
      return { ok: false, logged: false, reason: 'login-fail', error: res.error || '登录失败' };
    }
    // 登录一成功就通知调用方，界面可以先亮「已登录」，云端那一步单独显示进度
    if (typeof o.onLogin === 'function') {
      try {
        o.onLogin(res.session);
      } catch (err) {
        console.warn('[paipan] onLogin 回调异常', err);
      }
    }
    return res;
  });
}

function run(o) {
  /** 开跑时的代次 —— 中途若 `forget()` 过（退出登录 / 换账号），这次结论一律不许广播 */
  const mine = epoch;
  const say = function (stage, text, res) {
    if (mine !== epoch) return;
    publish(stage, text, res);
  };

  if (!o.quiet) say(STAGE.LOGIN, TEXT.login);

  return ensureSession(o).then(function (res) {
    if (!res.ok) {
      if (!o.quiet) {
        /**
         * ⚠⚠ 这里**只有一条路**：NEED_LOGIN。原来是「needLogin ? NEED_LOGIN : FAILED(loginFailed)」，
         *   2026-10-21 按用户要求把「登录失败，点此重试」那条去掉了（理由见 TEXT 的注释）。
         *   ⇒ 别再拆回两支：那个 FAILED 分支是「点了也永远好不了」的重试入口。
         */
        say(STAGE.NEED_LOGIN, TEXT.needLogin, res);
      }
      return res;
    }

    if (!o.quiet) say(STAGE.CHECKING, TEXT.checking);
    // ⚠ ensureFile 里的云端读取**永不 reject**（驱动那层 Promise 已经保证），
    //   所以正常路径下不需要 catch。但这里仍然收一个 —— 意外形状（比如 res 是 null）
    //   会让这条链 reject，而 reject 会把 `inflight` 卡在「永远 pending」的状态，
    //   之后所有 ensureUser 都吊死在这里。宁可让它退化成一次「云端不可用」。
    return ensureFile(res.session, o.quiet, say).catch(function (err) {
      return {
        ok: false, logged: true, uid: '', source: '',
        reason: 'cloud-error', error: (err && err.message) || '云端核对异常'
      };
    }).then(function (r) {
      r.session = res.session;
      if (o.quiet) return r;      // quiet 模式不广播，免得在别的页面上闪进度
      if (r.ok) {
        say(STAGE.READY, r.action === 'created' ? TEXT.created : TEXT.ready, r);
      } else if (r.reason === 'no-identity') {
        say(STAGE.SKIP, TEXT.skip, r);
      } else {
        say(STAGE.FAILED, TEXT.failed, r);
      }
      return r;
    });
  });
}

/** 登录态里当前的用户标识（同步读 storage）。用来判断能否复用本次冷启动的核对结论 */
function currentUid() {
  try {
    return userStore.uidOf(auth.getIdentity()).uid;
  } catch (err) {
    return '';
  }
}

function shallowCopy(obj) {
  const out = {};
  Object.keys(obj).forEach(function (k) { out[k] = obj[k]; });
  return out;
}

/**
 * 打开应用 / 进页面时调一次：保证已登录，且该用户在云端有可读的数据文件。
 *
 * **每次冷启动都会跟云端核对一次**（缓存不参与这个判断，理由见文件头）。
 * 同一个冷启动内多次调用共用一份结果；force 则忽略它、真的重走一遍。
 *
 * 两种走法：
 *   ① 本次冷启动还没核对过（或 force / 换了用户）→ 亮进度，登录 + 查云端 + 按需建
 *   ② 已经核对过、用户没变、登录态也还在 → 只悄悄确认一次登录态，不打接口、不亮进度
 *      （tab 来回切不该每次都闪一条进度，也不该重复打云端）
 * 两条路都必须确认登录态：本机登录态过期、设备侧 session 失效，都得当场补登，
 * 不能因为「云端已经备好了」就跳过后面的补登。
 *
 * @param {boolean} [force] 忽略本次冷启动的核对结论（失败后点重试用）
 * @param {Object}  [opts]
 * @param {boolean} [opts.relogin] 连登录一起强制刷新（登录失败后点重试用）
 * @param {Function} [opts.onLogin] 登录成功的即时回调，收 session
 * @param {boolean} [opts.quiet] 只确认登录、不广播阶段（不想闪进度的调用方用）
 */
function ensureUser(force, opts) {
  const o = opts || {};
  /** 进函数时的代次（见 `epoch` 那段）：途中 `forget()` 过 ⇒ 这一份结论不许落地 */
  const mine = epoch;
  if (force) {
    inflight = null;
    verified = null;
  }
  if (inflight) return inflight;   // 同一冷启动内的并发全部复用同一份结果

  // ② 本次冷启动已经核对过、用户没变、登录态还在 → 悄悄确认登录后直接复用
  if (verified && verified.uid && verified.uid === currentUid() && auth.isLoggedIn()) {
    return ensureSession(o).then(function (res) {
      if (!res.ok) {
        // 同 run()：登录这一步没成，一律按 NEED_LOGIN 播（不再有「登录失败」那条）
        if (mine === epoch) publish(STAGE.NEED_LOGIN, TEXT.needLogin, res);
        return res;
      }
      const r = shallowCopy(verified.res);
      r.cached = true;
      r.session = res.session;
      return r;
    });
  }

  // ① 真的走一遍
  const p = run(o);
  const clear = function () { if (inflight === p) inflight = null; };
  p.then(function (res) {
    /* ⚠⚠ 代次对不上 ⇒ 这份结论属于**上一个**登录态（期间用户退出 / 换人了），
       一个字节都不许写进 `verified` —— 写了，新账号下次「悄悄复用」就会拿到
       上一个人的核对结论（记录页显示别人的数据，且日志全干净）。 */
    if (mine === epoch && res && res.ok && res.uid) verified = { uid: res.uid, res: res };
    clear();
  }, clear);                       // run 永不 reject，这里只是兜住清理时机
  inflight = p;
  return p;
}

/**
 * 忘掉进程内的核对结论（不动 storage）。
 *
 * 真实世界里的等价物是「App 冷启动」—— 重启后进程内状态自然清空。
 * 自检脚本用它模拟一次又一次的冷启动；用户退出登录后也可以调。
 *
 * ⚠⚠ `epoch += 1` 不是可选项：它让**已经在飞的那一次 run** 闭嘴（见 `epoch` 那段）。
 *   少了它，退出登录后界面还会冒出上一个登录态的失败态（用户 2026-10-21 报障）。
 */
function forget() {
  epoch += 1;
  inflight = null;
  verified = null;
  publish(STAGE.IDLE, TEXT.idle);
}

/**
 * 等一个可用的用户标识。
 *
 * 打开应用那一刻正在登录，排盘 / 保存这些动作可能比它早一步（用户手快）。
 * 这时直接去拼云端路径会拿到空 uid，所以要先等引导把登录态备好 ——
 * `quiet: true` 只等登录、不亮进度条。
 *
 * `fresh: true` 表示忽略本次冷启动已核对过的结论，**只重新确认登录态**。
 * 用在需要一个「此刻真实有效」的标识的时刻（比如排盘的闸门）：登录态可能刚过期、
 * 或本机登录态里根本没有标识 —— 那时要重走一次登录才能拿到。
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.fresh] 忽略本次冷启动的核对结论，只重确认登录态（不打云端）
 * @returns {Promise<{uid:string, source:string, path:string}|null>} null = 拿不到可用标识
 */
function whoami(opts) {
  const o = opts || {};
  let p;

  if (o.fresh) {
    // 只确认登录态，不碰云端：这里要的是身份，不是数据文件是否已建好。
    // ⚠ 必须带 relogin —— 本机登录态里可能**根本没有标识**，
    // 那时「登录态有效」并不等于「拿得到 uid」。
    p = ensureSession({ relogin: true }).then(function (res) {
      return { session: res.ok ? res.session : null };
    });
  } else {
    p = ensureUser(false, { quiet: true }).then(function (res) {
      return { session: (res && res.session) || readSessionQuietly() };
    });
  }

  return p.then(function (r) {
    const who = userStore.uidOf(r.session);
    if (!who.uid) return null;
    // ⚠ 文件级模型下 path 是真实有用的（设置页要显示「数据存在哪个文件」）。
    //   记录级模型下它是空串 —— 那边没有文件这个概念。
    return {
      uid: who.uid,
      source: who.source,
      path: store.fileLevel() ? userStore.pathOf(who.uid) : ''
    };
  });
}

/**
 * 兜底读一次本地登录态（boot 不直接依赖 auth 的内部实现，这里只取需要的字段）。
 *
 * ⚠ CloudBase 模式下身份存在 core/session.js 里，**不在** auth.LOGIN_KEY 里 ——
 *   闷头读那个 key 会拿到空，表现出来就是「明明登录了，whoami 却说没有标识」。
 *   所以先问 auth.getIdentity()（它已按当前后端给出正确形状），拿不到再退回老路径。
 */
function readSessionQuietly() {
  try {
    const id = auth.getIdentity();
    if (id && (id.cloudbaseUid || id.anonymousCode || id.unionid || id.openid)) return id;
  } catch (err) {
    /* 退回老路径 */
  }
  try {
    const raw = storage.getStorageSync(auth.LOGIN_KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return null;
  }
}

module.exports = {
  ensureUser: ensureUser,
  whoami: whoami,
  observe: observe,
  getSnapshot: getSnapshot,
  lastKnown: lastKnown,
  clearCloudMemory: clearCloudMemory,
  forget: forget,
  STAGE: STAGE,
  TEXT: TEXT,
  CLOUD_KEY: CLOUD_KEY
};
