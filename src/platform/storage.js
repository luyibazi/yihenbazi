/**
 * 平台存储 —— 替代小程序的 tt.getStorageSync / setStorageSync / removeStorageSync
 *
 * ⚠ 只存**运行凭据**（登录态、设备码），**绝不存记录数据**。
 *   用户明确要求「保存的数据一点都不能存在本地，只允许用云端的数据」。
 *   记录一律在云端（Gitee 仓库），本地一个字节都不留。
 *   （例外：**阅读位置** `core/readPos.js` —— 2026-10-12 用户明确要求存手机本地；
 *     它只是「文件名 → 段落序号」，不含任何排盘记录，不属于上面那条红线。）
 *
 * ============ 为什么是 .js 而不是 .ts ============
 * ⚠⚠ core/ 里的文件全是 CommonJS，而**纯 Node 测试**（tests/*.js，不需要装 Expo 依赖）
 *   也要能 require 它们。Node 的 CommonJS 解析**不认 .ts** ——
 *   `require('../platform/storage')` 找不到 storage.ts 就 MODULE_NOT_FOUND。
 *   而 Metro（RN 打包）对 .js 和 .ts 都收。
 *   ⇒ 结论：**被 core/ 依赖的平台层文件必须是 .js**，否则「逻辑层纯 Node 可测」
 *     这条设计前提当场破产（本项目已因目录/扩展名问题踩过多次）。
 *
 * ============ 为什么维持同步接口 ============
 * 小程序的 storage 是同步的（getStorageSync 直接返回值），RN 的 AsyncStorage 是异步的。
 * 为了不让 auth.js / boot.js 改写成 async（那会连带改一大片调用点），
 * 这里用「**内存镜像 + 异步落盘**」实现同步签名：
 *   · 启动时 loadFromDisk() 一次，把数据读进内存
 *   · 读：同步从内存取（启动后永远命中，0 延迟）
 *   · 写：同步更新内存 + fire-and-forget 落盘
 */

/**
 * 内存镜像：key → 值（**字符串**，与 AsyncStorage 一致）
 *
 * ⚠⚠ 取值/存值都必须**字符串化**，这条踩过：
 *   小程序的 `tt.setStorageSync(k, obj)` 原生就支持对象，搬过来时若照抄
 *   `setStorageSync(KEY, { uid, path })`，而这里 `String(value)` 一裹，
 *   存进去的就是 `"[object Object]"` —— 读出来 `c.uid` 是 undefined，
 *   表现为「缓存写了却读不到」（当时看着像「读缓存坏了」，其实是写坏了）。
 *   ⇒ 这里**两种都收**：给对象就自动 JSON.stringify，读出来仍是字符串，
 *     调用方自己 JSON.parse（auth.js / boot.js 都是这么做的）。
 */
var memory = {};

/** 值 → 存起来的字符串（对象自动 JSON；已经是字符串就原样） */
function encode(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch (err) { return String(value); }
}

/** 当前生效的 store（默认就是内存镜像；测试可注入） */
var active = {
  get: function (key) {
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : '';
  },
  set: function (key, value) { memory[key] = encode(value); },
  remove: function (key) { delete memory[key]; }
};

/* ---------------------------------------------------- 对外：同步接口 */

function getStorageSync(key) {
  try { return active.get(key) || ''; } catch (err) { return ''; }
}

function setStorageSync(key, value) {
  try { active.set(key, value); } catch (err) { /* 存不上不该崩 */ }
}

function removeStorageSync(key) {
  try { active.remove(key); } catch (err) { /* 同上 */ }
}

/* ------------------------------------- 与 AsyncStorage 的桥接（RN 用） */

/**
 * 现在跑在 React Native 里吗？
 * ⚠ 用 `navigator.product` 判定（RN 的固定标记）。Node 22 也有 navigator，
 *   但 `product` 是 undefined ⇒ 纯 Node 测试里这段判定为 false（不会刷屏）。
 */
function isRN() {
  return typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
}

/**
 * ⚠⚠⚠ 「落盘其实没生效」的警告 —— 只报一次，且只在真机上报。
 *
 * 为什么要专门加它（2026-10-04 的真实事故）：
 *   `getAsyncStorage()` 是**吞异常**拿模块的（没有原生模块时要能降级到纯内存）。
 *   可这样一来「包没装 / 原生模块不在」和「一切正常」在代码里长得**一模一样** ——
 *   没有任何报错、没有任何警告，Node 测试也全绿（Node 里本来就没有原生模块）。
 *   症状只在真机上才看得见，而且看起来像别的问题：
 *   **reload 一次，登录态 / 设备码 / 记住的账号密码全没**。
 *   本次就是因为缺这个包，整套本机存储**从头到尾都是空操作**，却没人发现。
 *   ⇒ 宁可多一行警告，也不要再来一次「静默地什么都没存」。
 */
var warnedNoStore = false;
function warnNoStore(why) {
  if (warnedNoStore || !isRN()) return;
  warnedNoStore = true;
  console.warn('[paipan] ⚠ 本机存储没有真正落盘（' + why + '）：' +
    '本次运行的数据只活在内存里，App 一 reload 全没 —— ' +
    '登录态、设备码、记住的账号密码都会丢。' +
    '先查 package.json 有没有 @react-native-async-storage/async-storage' +
    '（守卫见 tests/node-resolution-check.js 第 9 节）。');
}

/** 惰性拿 AsyncStorage：没装（测试环境）就返回 null，不抛错 */
function getAsyncStorage() {
  try {
    // eslint-disable-next-line global-require
    var mod = require('@react-native-async-storage/async-storage');
    if (mod && (mod.default || mod)) return mod.default || mod;
  } catch (err) {
    warnNoStore('模块取不到：' + String((err && err.message) || err).slice(0, 80));
  }
  warnNoStore('模块里没有可用的 AsyncStorage');
  return null;
}

/**
 * 启动时调一次：把持久化的键值读进内存镜像。
 * ⚠ 必须在任何 auth / boot 调用**之前**完成 —— 见 App.tsx 的启动顺序。
 * 没有 AsyncStorage 时降级为「纯内存」—— ⚠⚠⚠ 这是**故障态，不是「不受影响」**：
 *   本次运行存的东西一个字节都没落盘，App 一 reload 全丢
 *   （登录态、设备码、记住的账号密码），而用户完全不知道为什么。
 *   ⇒ 这种降级**必须在日志里留声**（见 warnNoStore），
 *     并且由 tests/node-resolution-check.js 第 9 节守着「包还在不在」。
 *   （2026-10-04：正是因为这里「静默降级 + 无守卫」，缺包这件事
 *     躲过了整套测试，直到用户 reload 后问「记住的账号密码怎么没了」才被发现。）
 */
function loadFromDisk() {
  var AS = getAsyncStorage();
  if (!AS || typeof AS.getAllKeys !== 'function') return Promise.resolve();
  return AS.getAllKeys().then(function (keys) {
    var mine = (keys || []).filter(function (k) { return k.indexOf('paipan_') === 0; });
    return Promise.all(mine.map(function (k) {
      return AS.getItem(k).then(function (v) {
        if (typeof v === 'string') memory[k] = v;
      });
    }));
  }).catch(function (err) {
    /* 读盘失败不该崩启动 —— 但**必须留声**，否则「一条都没读到」和「本来就没存过」
       在界面上看起来完全一样（这就是 2026-10-04 那次事故的形状）。 */
    warnNoStore('读盘失败：' + String((err && err.message) || err).slice(0, 80));
  });
}

/** 把某个键落盘（fire-and-forget） */
function persistKey(key) {
  var AS = getAsyncStorage();
  if (!AS || typeof AS.setItem !== 'function') return Promise.resolve();
  var v = active.get(key) || '';
  /* ⚠ 外面这层 try 不是装饰：AsyncStorage 在**原生模块不在**时，
     有可能是**同步抛**（而不是返回一个 rejected promise）——
     那种情况下下面那个 `.catch` 根本接不住，异常会直接炸到
     session.write / auth 的调用栈上（「凭证写不进去」升级成一次崩溃）。
     同步抛与异步 reject 都要落成同一句警告，别让它们看起来不一样。 */
  try {
    return (v === '' ? AS.removeItem(key) : AS.setItem(key, v)).catch(function (err) {
      /* ⚠ 这里原本是**空的** catch —— 于是「写盘全被拒绝」也一声不响。
         不加这声警告的话，真机上表现为「明明存了、reload 就没了」，
         而日志里干干净净，只能靠人肉猜。 */
      warnNoStore('写入被拒绝：' + String((err && err.message) || err).slice(0, 80));
    });
  } catch (err) {
    warnNoStore('写入同步抛出：' + String((err && err.message) || err).slice(0, 80));
    return Promise.resolve();
  }
}

/** 包裹 setStorageSync：写内存 + 异步落盘 */
function setAndPersist(key, value) {
  setStorageSync(key, value);
  persistKey(key);
}

/* --------------------------------------------------- 测试接缝 */

/** 注入自定义 store（纯内存），返回一个「恢复默认」的函数 */
function _setStore(store) {
  var prev = active;
  active = store;
  return function () { active = prev; };
}

/** 直接拿内存镜像（给「模拟一次新的冷启动」用） */
function _snapshot() {
  var out = {};
  for (var k in memory) if (Object.prototype.hasOwnProperty.call(memory, k)) out[k] = memory[k];
  return out;
}

/** 用一份快照覆盖内存镜像 */
function _hydrate(data) {
  for (var k in memory) delete memory[k];
  if (data) for (var j in data) if (Object.prototype.hasOwnProperty.call(data, j)) memory[j] = data[j];
}

/** 清空内存镜像（模拟「全新安装」） */
function _clear() { for (var k in memory) delete memory[k]; }

module.exports = {
  getStorageSync: getStorageSync,
  setStorageSync: setStorageSync,
  removeStorageSync: removeStorageSync,
  setAndPersist: setAndPersist,
  persistKey: persistKey,
  loadFromDisk: loadFromDisk,
  // 测试接缝
  _setStore: _setStore,
  _snapshot: _snapshot,
  _hydrate: _hydrate,
  _clear: _clear
};
