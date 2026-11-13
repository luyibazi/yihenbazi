/**
 * 服务器地址的本机存取 —— 设置页里那一行「服务器地址」的落盘层。
 *
 * ============ 为什么单独一层，而不写在 Settings.tsx 里 ============
 * 与 `savedLogin.js` 同一个理由：视图只负责画和按，读写逻辑放在 core 里，
 * 就能**纯 Node 断言**（见 tests/local-check.js），不必为了验一段读写起渲染环境。
 *
 * ============ 它跟 storeMode 的分工 ============
 *   · `storeMode.js` —— **纯内存**的「当前生效地址」（`localUrl()` 读它）。
 *     那个文件被一堆 Node 测试直接 require，绝不能 import AsyncStorage。
 *   · 本文件 —— 唯一知道「存哪个键、怎么落盘」的地方，写盘后顺手把值推给 storeMode。
 *   ⇒ 顺序永远是「先写 storeMode（立刻生效）→ 再落盘（下次启动还在）」，
 *     反过来会出现「已经生效但没存住」的窗口。
 *
 * ⚠ 键名带 `paipan_` 前缀：`platform/storage.js` 的 `loadFromDisk()` 只捞这个前缀的键，
 *   不加前缀就会「存进去了、冷启动读不回来」（表现为「明明改过、又变回默认」）。
 */
const storage = require('../platform/storage.js');
const storeMode = require('./storeMode.js');

/** 落盘用的键（⚠ 必须 `paipan_` 开头，见文件头） */
const KEY = 'paipan_server_url';

/** 当前生效的地址（给设置页显示） */
function current() {
  return storeMode.localUrl();
}

/** 是不是用户自己改过的（false = 用的包里的默认值） */
function isOverridden() {
  return storeMode.hasLocalUrlOverride();
}

/**
 * 冷启动时调用一次：把上次存下来的地址读回内存。
 *
 * ⚠ 必须等 `storage.loadFromDisk()` 之后调 —— 那之前内存镜像还是空的，
 *   这里只会读到空串，等于「用户改过的地址每次冷启动都丢」。
 */
function init() {
  const saved = storage.getStorageSync(KEY);
  storeMode.setLocalUrlOverride(saved);
  return storeMode.localUrl();
}

/**
 * 保存一个新地址。空串 = 恢复成包里的默认值。
 * @returns {string} 规范化后**真正生效**的地址（非法输入会被忽略，见 storeMode.normalizeUrl）
 */
function save(raw) {
  const v = storeMode.setLocalUrlOverride(raw);
  storage.setAndPersist(KEY, v);
  return storeMode.localUrl();
}

/** 恢复默认（等价于 save('')） */
function reset() {
  return save('');
}

module.exports = {
  KEY: KEY,
  current: current,
  isOverridden: isOverridden,
  init: init,
  save: save,
  reset: reset,
};
