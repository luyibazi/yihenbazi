/**
 * 抖音云驱动 —— 记录级读写（备用后端，当前 MODE='gitee' 时不会被加载）
 *
 * ⚠ 保留它的原因：切回 Gitee 是**产品选择**，不是「抖音云这条路错了」。
 *   若哪天抖音云配好了（拿到企业主体 + CLOUD_ENV），把 storeMode.MODE 改成 'cloud'
 *   就能切回去，业务侧一行都不用动。
 *
 * ============ 契约（记录级，与 gitee 的文件级**不兼容**）============
 *   listRecords(uid)             → { ok, records?, error? }
 *   putRecord(uid, rec)          → { ok, record?, created?, error? }
 *   deleteRecord(uid, id)        → { ok, deleted?, error? }
 *   clearRecords(uid)            → { ok, deleted?, error? }
 *
 * ============ 为什么可以不做「读-改-写」============
 * Gitee 一个用户一个 json，改一条 = 整份读 → 改 → 整份写回，
 * 于是必须防「另一台设备刚存过一条，这边一覆盖就抹掉」。
 * 云数据库一条记录一个文档，改一条**就只动那一个文档**：
 *   · 新增/覆盖 → doc(uid:id).set(...)  —— 固定文档 id，天然幂等，不会长重复
 *   · 删一条     → doc(uid:id).remove()
 *   · 清空       → where({uid}).remove() —— 条件带 uid，不误伤别人
 *
 * ============ 失败语义（一个字都不能松）============
 *   · 任何函数**永不 reject** —— 网络失败是预期内的事
 *   · 读失败 → { ok:false, error }，**绝不是** { ok:true, records:[] }
 *     后者会让上层把「网络抖一下」当成「云端真没有」，然后拿空列表覆盖云端
 *   · 「这个用户没记录」才是 ok:true + 空数组（由云函数保证）
 */
const mode = require('../storeMode.js');

/** 统一入口：调云函数，永不 reject */
function invoke(action, payload) {
  return new Promise(function (resolve) {
    if (!mode.CLOUD_ENV) {
      // 见 storeMode.js：这里**故意不静默降级**，否则你会以为数据在云端，其实哪儿都没写
      resolve({
        ok: false,
        status: 0,
        error: '抖音云未配置：请在 utils/storeMode.js 填入 CLOUD_ENV（抖音开放平台 → 抖音云 → 环境管理）'
      });
      return;
    }

    const cloud = tt.createCloud({ envID: mode.CLOUD_ENV });
    if (!cloud) {
      resolve({ ok: false, status: 0, error: '当前基础库不支持 tt.createCloud（请升级抖音 App / 开发者工具）' });
      return;
    }

    const done = function (res) {
      const body = (res && (res.result || res.data)) || {};
      if (res && res.result === undefined && res.data === undefined) {
        resolve({ ok: false, status: 0, error: (res && res.errMsg) || '云函数返回为空' });
        return;
      }
      resolve(body);
    };
    const failed = function (err) {
      resolve({ ok: false, status: 0, error: (err && err.errMsg) || '云函数调用失败' });
    };

    try {
      const p = cloud.callFunction({
        name: mode.CLOUD_FUNCTION,
        data: { action: action, payload: payload || {} },
        success: done,
        fail: failed
      });
      if (p && typeof p.then === 'function') {
        p.then(function (res) { done(res); }, failed);
      }
    } catch (err) {
      resolve({ ok: false, status: 0, error: (err && err.message) || '云函数调用异常' });
    }
  });
}

/* -------------------------------------------------------------------- 读 */

function listRecords(uid) {
  return invoke('listRecords', { uid: uid }).then(function (res) {
    if (!res || res.ok !== true) {
      return { ok: false, status: (res && res.status) || 0, error: (res && res.error) || '读取失败' };
    }
    return { ok: true, records: Array.isArray(res.records) ? res.records : [] };
  });
}

/* -------------------------------------------------------------------- 写 */

function putRecord(uid, rec) {
  return invoke('putRecord', { uid: uid, record: rec }).then(function (res) {
    if (!res || res.ok !== true) {
      return { ok: false, status: (res && res.status) || 0, error: (res && res.error) || '写入失败' };
    }
    return { ok: true, record: res.record || rec, created: !!res.created };
  });
}

/**
 * ⚠ deleted:false（云端本来就没有这条）**不是**失败 —— 如实往上带，
 *   免得清单里一条已经没了的记录删两次，第二次报错把用户吓一跳。
 */
function deleteRecord(uid, id) {
  return invoke('deleteRecord', { uid: uid, id: id }).then(function (res) {
    if (!res || res.ok !== true) {
      return { ok: false, status: (res && res.status) || 0, error: (res && res.error) || '删除失败' };
    }
    return { ok: true, deleted: !!res.deleted };
  });
}

function clearRecords(uid) {
  return invoke('clearRecords', { uid: uid }).then(function (res) {
    if (!res || res.ok !== true) {
      return { ok: false, status: (res && res.status) || 0, error: (res && res.error) || '清空失败' };
    }
    return { ok: true, deleted: (res && res.deleted) || 0 };
  });
}

module.exports = {
  listRecords: listRecords,
  putRecord: putRecord,
  deleteRecord: deleteRecord,
  clearRecords: clearRecords
};
