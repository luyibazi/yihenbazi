/**
 * Gitee 存储驱动 —— **文件级**读写（一个用户一个 json）
 *
 * ⚠⚠ 这一层是**文件级**，与 store/cloud.js 的**记录级**接口**不兼容**，
 *    两者不是同一个抽象。不要在 store/index.js 里强行统一 ——
 *    那会把「整份读-改-写」这个语义藏起来，而它正是文件级模型最需要被看见的地方
 *    （见 README「为什么从 Gitee 换过来」：『整份 json 重写』带来两条必须靠纪律守的后果）。
 *
 * ============ 契约 ============
 *   readFile(uid)            → { exists:true, sha, text }
 *                            | { exists:false }
 *                            | { exists:false, failed:true, error }   ← 三态，别少
 *   writeFile(uid, text, sha)→ { ok, sha?, error? }   sha 为空 = 创建，有 = 更新
 *   upsertFile(uid, text)    → { ok, sha?, raced?, error? }   读→(建|改)，自带竞态回退
 *
 * ============ 三条生命线（少一条就丢数据）============
 *   ① 读失败 **绝不**退化成 `{exists:false}` —— 那会让上层以为「云端没有」，
 *      接着拿空数据覆盖云端。断网 ≠ 数据不存在。
 *   ② 写之前**必须重新 GET 拿最新 sha** —— 否则「另一台设备刚存过一条，
 *      这边一覆盖就把它抹掉」。
 *   ③ 云端读失败时**整条失败、什么都不写**。
 */
const gitee = require('../gitee.js');

/**
 * 读一个用户的记录文件（三态）。
 * @returns {Promise<{exists:boolean, sha?:string, text?:string, failed?:boolean, error?:string}>}
 */
function readFile(uid) {
  return gitee.readRaw(uid).then(function (r) {
    if (r.failed) {
      return { exists: false, failed: true, status: r.status || 0, error: r.error || '读取失败' };
    }
    if (!r.exists) return { exists: false };
    return { exists: true, sha: r.sha, text: r.text };
  });
}

/**
 * 写文件（整体覆盖）。
 * @param {string} uid
 * @param {string} text
 * @param {string} [sha] 省略 = 创建；给了 = 更新（Gitee 的 PUT 必须带 sha）
 */
function writeFile(uid, text, sha) {
  if (!gitee.safeUid(uid)) {
    return Promise.resolve({ ok: false, status: 0, error: '用户标识为空或非法，无法写入' });
  }
  return sha ? gitee.updateFile(uid, sha, text) : gitee.createFile(uid, text);
}

/** 幂等写：自动探存在、自动带 sha、自动处理并发撞车 */
function upsertWrap(uid, text) {
  if (!gitee.safeUid(uid)) {
    return Promise.resolve({ ok: false, status: 0, error: '用户标识为空或非法，无法写入' });
  }
  return gitee.upsertFile(uid, text);
}

module.exports = {
  readFile: readFile,
  writeFile: writeFile,
  upsertFile: upsertWrap
};
