/**
 * 排盘记录 —— **只在云端**，本地一个字节都不留
 *
 * ⚠ 这里没有任何本地镜像 / 缓存兜底，是刻意的：
 * 用户明确要求「保存的数据一点都不能存在本地，只允许用云端的数据」。
 * 所以 read 失败就是失败、write 失败就是失败，**不要**再退回 storage ——
 * 一旦退回，界面就会显示出云端其实没有的记录，变成「本地说有、云端是空的」。
 *
 * 于是所有函数的语义都是「读不到 = 空 / 失败」，调用方必须自己处理这两态：
 *   · 拉不到云端 → pull.reason = 'cloud-error'，不要假装有数据
 *   · 保存失败   → 如实报错让用户重试（result 的 save 失败态）
 *
 * 顺带一提：登录态（paipan_login_v1）与设备码（paipan_anon_v1）仍然在本地，
 * 但那是**运行凭据不是记录数据** —— 没有它连 uid 都拿不到。
 *
 * ============ 存的是「轻记录」，不是算好的盘 ============
 * 上云一律过 record.toStorage()：只留
 *   { id, name, gender, date, time, createdAt } + 可选 { notes }
 * 打开记录时用 record.hydrate() 现场重排（盘是纯函数，只依赖出生时间 + 性别），
 * 所以不需要维护「哪些重字段该剥掉」。
 *
 * ============ ⚠⚠ 文件级模型：每个写操作都是「读-改-写」 ⚠⚠ ============
 * ⚠ 当前 MODE = 'cloudbase'（记录级，一条记录一行）⇒ 本节纪律**不在生效路径上**。
 *   保留它有两个理由：gitee 仍是可切换的分支（见 storeMode.js），
 *   而且它把「整份重写」这个最容易被忽视的语义写在了明处。
 * 文件级模型下：云端是 `userData/<uid>.json`（一个用户一个文件）。
 * 于是本文件里**每一个写操作**（push / saveNotes / drop / clear）都必须：
 *   ① 先把整份读出来（读失败 → 整条失败，什么都不写）
 *   ② 在内存里改
 *   ③ **重读拿最新 sha 后整份写回**（这一步在 userStore.writeUserFile 里做）
 *
 * ⚠ 第 ③ 步的「重读」不能省、也不能把 sha 缓存起来跨调用用 ——
 *   那正是「另一台设备刚存过一条、这边一覆盖就全没」的成因。
 *   ⚠ 也正因为如此，「读-改-写」这三步必须**串在一条 promise 链**上，
 *     中间不能 await 别的东西（比如重新走一次 whoami 会多一个快照点，
 *     但不会造成错写 —— 真正要防的是「拿到列表后隔了很久才写」）。
 *
 * ⚠ 记录级（MODE='cloud'）那条路留着：见 userStore.js 文件头。
 *   它「一条记录一个文档」，上面这套纪律结构性不存在。分支写在下面各函数里。
 *
 * ============ ⚠ 现在这个 uid 还是设备级的 ⚠ ============
 * 见 core/userStore.js 文件头：拿不到真 unionid，uid 落到设备码。
 */
const boot = require('./boot.js');
const userStore = require('./userStore.js');
const record = require('./record.js');
const store = require('./store/index.js');

const MAX = userStore.MAX;

/* ---------------- 数据版本号（内存） ----------------
 * 给页面判断「云端数据变没变」用，解决一个问题：
 * 手机上拉一下系统通知栏也会触发一次「后台 → 前台」的页面 onShow，
 * 记录页原来是 onShow 就无条件全量重新拉 —— 通知栏成了最贵的手势。
 *
 * 契约：push / saveNotes / drop / clear **成功**时版本 +1（失败不算 —— 云端没变），
 * pull 不动它。页面记下「上次同步时的版本号」，onShow 时不一样才重新拉。
 *   · 结果页保存 / 记录页删除 / 清空 → 版本变 → 回记录页必刷
 *   · 通知栏 / 切别的 App 再回来     → 版本没变 → 列表原地不动、0 次请求
 *
 * ⚠ 它只活在本生命周期内：换一台设备改了云端，这边检测不到
 *   （要覆盖那类场景得做定期兜底刷新，用户拍板先不做）。
 */
let rev = 0;

function getRev() {
  return rev;
}

/**
 * 云端写入成功后调用。
 *
 * ⚠ 上面那四个写操作（push / saveNotes / drop / clear）内部自己调；
 *   **外部只有一个正当调用点**：标签归类（`PUT /records/:id/tag`）。
 *   理由：那条路改的是 `record_tags`，不在上面四个里 —— 但它同样让
 *   **记录页列表上显示的东西变了**（那条记录的 tagId、以及标签栏的计数）。
 *   不 +1 的话：结果页换完标签返回记录页，`shouldReload` 判「版本没变」⇒ 不重拉
 *   ⇒ 卡片上那枚 chip 还是旧的（用户看到的现象就是「换了标签，列表上看不出来」）。
 *
 * ⚠⚠ 别在别的场合顺手调它：它是「为了避免一次全量重拉」而存在的，
 *   滥用等于把记录页的闸门拆掉（下拉通知栏也会重拉）。
 */
function bumpRev() {
  rev += 1;
}

/* ==================================================== 内部：一次读-改-写 */

/**
 * 文件级模型下的通用写操作。
 *
 * @param {string} uid
 * @param {(records:Array) => {records?:Array, result?:Object, abort?:Object}} mutator
 *        拿到当前列表，返回 { records } 表示要写回的新列表；
 *        返回 { abort } 表示不写、直接把 abort 当结果返回（比如「找不到这条」）。
 * @returns {Promise<{ok:boolean, records?:Array, reason?:string, error?:string}>}
 */
function mutateFile(uid, mutator) {
  return userStore.readUserFile(uid).then(function (res) {
    // 生命线③：读失败整条失败、什么都不写
    if (!res.ok) {
      return { ok: false, reason: 'cloud-error', error: res.error };
    }
    const out = mutator(res.records) || {};
    if (out.abort) return out.abort;
    const next = Array.isArray(out.records) ? out.records : res.records;
    return userStore.writeUserFile(uid, next).then(function (w) {
      if (!w.ok) return { ok: false, reason: 'cloud-error', error: w.error };
      bumpRev();
      // 回一份「本地已经改好的列表」，供调用方立刻刷新界面。
      // ⚠ 它只是给界面用的即时结果 —— 权威列表仍以 pull() 为准。
      const r = { ok: true, records: next.slice(0, MAX) };
      if (out.result) Object.keys(out.result).forEach(function (k) { r[k] = out.result[k]; });
      return r;
    });
  });
}

/* ------------------------------------------------------------------ 读 */

/**
 * 拉云端记录。
 *
 * ⚠ `filter` 是**可选的筛选参数**（筛选在服务端做，见 store/localdb.js）。
 *   不传 = 拉全部（首屏那条路）。
 *
 * @param {Object} [filter] 形如 { dayGan:'甲,乙', yearZhi:'辰' }；空 / 不传 = 全部
 * @returns {Promise<{ok:boolean, records?:Array, reason?:'no-login'|'cloud-error'}>}
 */
/**
 * 拉记录列表。
 *
 * @param {Object|null} filter 四柱筛选（透传服务端；⚠ 只有 local 驱动认它）
 * @param {Object|null} opt 分页 `{ limit, offset }`（2026-10-11 加）
 *   ⚠⚠⚠ **不传 = 全量**。这条必须保住 —— 本文件下面几处「读全量 → 改一条 → 整份写回」
 *     的路径（改笔记 / 改标签回写）靠它活着；默认改成分页 ⇒ 拿一页覆盖整张表 = 静默丢数据。
 * @returns {Promise<{ok:boolean, records?:Array, total?:number, paged?:boolean, ...}>}
 *   `total` = **筛后**总条数（服务端给）。「还有没有下一页」用
 *   `offset + records.length < total` 判断。
 *   ⚠ 非 local 驱动（gitee 的 readUserFile / cloudbase）**不回 total** ⇒ 上层要按
 *     「这次拿到几条」自己兜底（当成分页驱动用会永远以为还有下一页）。
 */
function pull(filter, opt) {
  return boot.whoami().then(function (who) {
    if (!who) {
      return { ok: false, reason: 'no-login', error: '还没有可用的用户标识，无法定位云端记录' };
    }
    const read = store.fileLevel()
      ? userStore.readUserFile(who.uid)
      /* ⚠ 文件级（gitee）没有筛选/分页接口 —— 传了也只会被忽略；
         这正是 records 页在「非 local 驱动」下要提示用户的原因。 */
      : userStore.listRecords(who.uid, filter, opt);

    return read.then(function (res) {
      if (!res.ok) {
        // ⚠ 这里**不能**降级成 { ok:true, records:[] } —— 断网说成「你没有记录」
        //   会让用户以为数据没了，或让上层拿空列表覆盖云端
        return { ok: false, reason: 'cloud-error', error: res.error };
      }
      return { ok: true, records: res.records, total: res.total, paged: res.paged };
    });
  });
}

/* ------------------------------------------------------------------ 写 */

/**
 * 保存一条记录 —— 新增或覆盖（按 id 定位）。
 *
 * ⚠ 文件级模型下这里必须「读全量 → 头部插入/同 id 替换 → 整份写回」。
 *   置顶：列表按 createdAt 倒序表达，所以新记录放最前；
 *   **同一条记录被覆盖保存时 createdAt 不变**，位置按原 createdAt 重新排 ——
 *   重存不该让它在列表里跳来跳去。
 *
 * @param {Object} rec 新增的记录（完整或轻的都行）
 */
function push(rec) {
  return boot.whoami().then(function (who) {
    if (!who) {
      return { ok: false, reason: 'no-login', error: '还没登录 / 没有可用的用户标识，无法保存到云端' };
    }

    const slim = record.toStorage(rec);
    if (!slim) {
      return { ok: false, reason: 'bad-record', error: '这条记录的出生信息不全，存不进去' };
    }

    if (!store.fileLevel()) {
      // 记录级：只动那一条文档，天然幂等
      return userStore.putRecord(who.uid, slim).then(function (w) {
        if (!w.ok) return { ok: false, reason: 'cloud-error', error: w.error };
        bumpRev();
        return userStore.listRecords(who.uid).then(function (after) {
          return { ok: true, records: after.ok ? after.records : [slim], created: !!w.created };
        });
      });
    }

    return mutateFile(who.uid, function (rows) {
      let created = true;
      const kept = rows.filter(function (r) {
        if (r.id === slim.id) { created = false; return false; }
        return true;
      });
      // createdAt 倒序：新的排最前；覆盖已有那条时它带着原 createdAt 回到正确位置
      const merged = kept.concat([slim]).sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return { records: merged, result: { created: created } };
    });
  });
}

/**
 * 把「事件记录」写回云端**某一条**记录。
 *
 * ⚠ 刻意不走 push()：push 的语义是「保存这条记录」，记个事件不该动它的其它字段，
 *   也不该在列表里跳位置。所以这里先取到那条、只换 notes 再整份写回。
 *   （这次「取」是为了拿到那条记录的**当前**字段做合并 —— 事件记录只换 notes，
 *    其它字段原样带过去。）
 *
 * notes 传空对象（或 null）＝ 把这条记录上的事件全部清掉
 * （字段一并删掉，免得云端留一堆 `notes: {}`）。
 *
 * @param {string} id 记录 id
 * @param {Object} notes key → { text, year, ganzhi, age, md?, jieQi? }，见 core/notes.js
 */
function saveNotes(id, notes) {
  if (!id) return Promise.resolve({ ok: false, reason: 'bad-record', error: '没有记录 id' });

  return boot.whoami().then(function (who) {
    if (!who) {
      return { ok: false, reason: 'no-login', error: '还没登录 / 没有可用的用户标识，无法保存到云端' };
    }

    /** 命中那条 → 换掉 notes；没命中要如实报错，绝不偷偷补一条 */
    function patch(rows) {
      const hit = rows.filter(function (r) { return r.id === id; })[0];
      // 云端没有这条 → 说明记录页那份列表是过期的，如实报错让用户重进，别偷偷补一条
      // （补一条只有一个 notes、其它字段空着，会在列表里显示成一条坏记录）
      if (!hit) {
        return {
          abort: { ok: false, reason: 'not-found', error: '云端没有这条记录（列表可能已过期）' }
        };
      }
      const next = Object.assign({}, hit);
      if (notes && Object.keys(notes).length) next.notes = notes;
      else delete next.notes;
      return rows.map(function (r) { return r.id === id ? next : r; });
    }

    if (!store.fileLevel()) {
      // 记录级：合并与校验都在**云端函数**里做（见 store/cbdb.js 的 saveNotes）。
      // ⚠ 这里原来是「listRecords 拉全表 → 找到那条 → 改 notes → putRecord 整行写回」——
      //   除了白拉一次全量，两台设备同时改**不同**记录时还会互相覆盖
      //   （后写的整行把先写的抹掉）。现在一次 RPC 只动那一行，问题结构性消失。
      return userStore.saveNotes(who.uid, id, notes).then(function (w) {
        if (w.ok) {
          bumpRev();
          return { ok: true };
        }
        // 「记录不存在」要与网络失败**分开**：页面据此提示「回记录页重进一次」，
        // 而不是笼统的「保存失败，请重试」—— 那件事重试多少次都不会好。
        if (w.notFound) {
          return { ok: false, reason: 'not-found', error: w.error || '云端没有这条记录（列表可能已过期）' };
        }
        return { ok: false, reason: 'cloud-error', error: w.error };
      });
    }

    return mutateFile(who.uid, function (rows) {
      const patched = patch(rows);
      if (patched.abort) return patched;
      // ⚠ 只换 notes，位置保持原样（saveNotes 不该让记录在列表里移动）——
      //   所以直接顺着原顺序 map，不重新排序
      return { records: patched };
    }).then(function (r) {
      // mutateFile 会把整份 records 也带回来，这里只需要成功与否
      return r.ok ? { ok: true } : r;
    });
  });
}

/**
 * 从云端删掉一条记录。
 */
function drop(id) {
  if (!id) return Promise.resolve({ ok: false, reason: 'bad-record', error: '没有记录 id' });

  return boot.whoami().then(function (who) {
    if (!who) return { ok: false, reason: 'no-login', error: '还没有可用的用户标识' };

    if (!store.fileLevel()) {
      return userStore.deleteRecord(who.uid, id).then(function (w) {
        if (!w.ok) return { ok: false, reason: 'cloud-error', error: w.error };
        bumpRev();
        // deleted:false（云端本来就没有）也算成功 —— 目标是「删掉」，结果状态已达成
        return userStore.listRecords(who.uid).then(function (after) {
          return { ok: true, records: after.ok ? after.records : [], deleted: !!w.deleted };
        });
      });
    }

    return mutateFile(who.uid, function (rows) {
      const before = rows.length;
      const next = rows.filter(function (r) { return r.id !== id; });
      // deleted:false（本来就没有）**不算失败**
      return { records: next, result: { deleted: next.length < before } };
    });
  });
}

/**
 * 清空云端记录。
 * @returns {Promise<{ok:boolean, reason?:string, error?:string}>}
 */
function clear() {
  return boot.whoami().then(function (who) {
    if (!who) return { ok: false, reason: 'no-login', error: '还没有可用的用户标识' };

    if (!store.fileLevel()) {
      return userStore.clearRecords(who.uid).then(function (w) {
        if (!w.ok) return { ok: false, reason: 'cloud-error', error: w.error };
        bumpRev();
        return { ok: true, deleted: w.deleted || 0 };
      });
    }

    return mutateFile(who.uid, function (rows) {
      return { records: [], result: { deleted: rows.length } };
    }).then(function (r) {
      return r.ok ? { ok: true, deleted: r.deleted || 0 } : r;
    });
  });
}

module.exports = {
  MAX: MAX,
  rev: getRev,
  /* ⚠ 只给「标签归类」那一条路用（见上面 bumpRev 的注释）——
     `tags.js` 的 setFor 成功后调它，记录页回来自动重拉。 */
  bumpRev: bumpRev,
  pull: pull,
  push: push,
  saveNotes: saveNotes,
  drop: drop,
  clear: clear
};
