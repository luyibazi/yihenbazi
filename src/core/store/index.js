/**
 * 存储驱动派发 —— 业务侧**唯一**入口
 *
 * 业务代码（userStore / history）只 require 这个文件，
 * **绝不**直接 require store/gitee.js / store/cbdb.js / store/cloud.js。
 * 这样换后端时业务侧一行都不用改。
 *
 * ⚠⚠ 两个驱动的接口**故意不统一**（文件级 vs 记录级，见 storeMode.js 文件头与 README）：
 *   · gitee：readFile / writeFile / upsertFile     —— 整份读、整份写
 *   · cloudbase / cloud：listRecords / putRecord / deleteRecord / clearRecords —— 单条读写
 *   这里**不做**适配层去抹平差别，而是把「当前是哪一级」明明白白暴露出去
 *   （fileLevel()），让 userStore 按模式分支 —— 差异可见，比差异被藏起来安全。
 *
 * ⚠ 文件级的三个函数（readFile / writeFile / upsertFile）只在 MODE='gitee' 时可用。
 *   记录级模式下调用它们会抛 TypeError（驱动上压根没有这个方法）——
 *   这是**刻意**的：上层该先问 fileLevel()，问错了就应该当场炸，
 *   而不是被一个安静的兜底返回值糊过去。
 *
 * ============ 为什么每次调用都现取驱动 ============
 * 不用「模块加载时选一次」的写法：那样测试里改 storeMode.MODE 就换不动了
 * （模块已被 require 缓存，pick() 的结果定死）。
 * 每次调用现取，代价只是一次 require（Node / RN 都走缓存表，可忽略）。
 */
const mode = require('../storeMode.js');

/** 取当前驱动。MODE 不合法时立刻抛出一句能看懂的话（不静默乱走） */
function pick() {
  mode.assertUsableMode();
  if (mode.MODE === 'gitee') return require('./gitee.js');
  if (mode.MODE === 'cloudbase') return require('./cbdb.js');
  if (mode.MODE === 'local') return require('./localdb.js');
  return require('./cloud.js');
}

/** 当前是不是文件级模型（上层据此选 readFile 还是 listRecords） */
function fileLevel() {
  return mode.isFileLevel();
}

/** 当前后端支不支持「服务端筛选」（只有自建 local 支持，见 storeMode.supportsFilter） */
function supportsFilter() {
  return mode.supportsFilter();
}

/**
 * 当前后端支不支持「自定义标签」（`/tags` + `PUT /records/:id/tag`）。
 *
 * ⚠⚠ 这里**必须**和 supportsFilter 一样转一手 —— 记录页是从 `store` 上问能力的
 *   （`store.supportsTags()`），只写在 storeMode.js 里的话，页面上那句会变成
 *   `undefined is not a function`，**首屏即崩**（2026-10-05 用户报障的真实原因）。
 *   ⚠ 静态自检抓不到它：tsc 看不见（`store` 是 `any`）、源码断言只查「有没有调」，
 *   而「调的那个名字在不在导出表里」得**跑起来**才知道。
 *   ⇒ 现在 wiring-check 里有一条**扫描式断言**专门守这件事（对所有 supportsX 生效）。
 *
 * ⚠ 与 filter 是**两个能力**（虽然目前同真同假）：标签栏筛选走 records 的
 *   `?tagId=`，标签本身的增删改是另一套接口 —— 将来某一端只支持其中一个时，
 *   调用方不必跟着改。
 */
function supportsTags() {
  return mode.supportsTags();
}

/* 文件级接口 —— 只在 MODE='gitee' 时可用 */
function readFile(uid) { return pick().readFile(uid); }
function writeFile(uid, text, sha) { return pick().writeFile(uid, text, sha); }
function upsertFile(uid, text) { return pick().upsertFile(uid, text); }

/* 记录级接口 —— 只在 MODE='cloud' 时可用 */
/**
 * 读记录列表。
 *
 * ⚠ `filter` 是**可选的筛选参数**，形如 `{ dayGan:'甲,乙', yearZhi:'辰' }`
 *   —— 由**服务端**执行过滤（用户明确要求），本地不过滤。
 *   · local（自建后端）：完整支持（GET /records?dayGan=…）
 *   · cloudbase / cloud / gitee：**带 filter 时会被忽略**（它们没有这套接口参数），
 *     这是有意的降级 —— 而不是「看起来筛了其实没筛」的静默 bug。
 *     ⚠ 记录页在「筛选参数非空 + 驱动不支持」时会自己提示用户（见 records/model.js），
 *       所以这里不用抛错。
 *
 * ⚠ `opt` 是**可选的分页参数** `{ limit, offset }`（2026-10-11 加）。
 *   ⚠⚠⚠ **不传 = 全量**（服务端口径），上层「读全量→改一条→整份写回」的路径靠它活着。
 *   ⚠ 分页只有 local 驱动吃得到（它的 `/records` 才认 `?limit&offset`）——
 *     所以「给了分页参数」本身就构成走 `listRecordsFiltered` 的理由，
 *     **即使 filter 是空的**（原来只按「有没有 filter」分支，会把 opt 悄悄吞掉）。
 */
function listRecords(uid, filter, opt) {
  const d = pick();
  const hasFilter = !!(filter && Object.keys(filter).length);
  const hasPage = !!(opt && opt.limit != null);
  /* 只有实现了筛选/分页的那个驱动才把参数透下去 —— 其余驱动忽略它，行为退回「读全部」 */
  if ((hasFilter || hasPage) && typeof d.listRecordsFiltered === 'function') {
    return d.listRecordsFiltered(uid, filter, opt);
  }
  return d.listRecords(uid);
}
function putRecord(uid, rec) { return pick().putRecord(uid, rec); }
function deleteRecord(uid, id) { return pick().deleteRecord(uid, id); }
function clearRecords(uid) { return pick().clearRecords(uid); }

/**
 * 事件记录 —— CloudBase 驱动走数据库函数；本地驱动走「先读回来再整条写」。
 *
 * ⚠ 这里刻意**不**做「驱动缺这个方法就降级成 putRecord」的兜底：
 *   那会把「云端函数没接上」伪装成一次正常保存，而两者语义并不相同 ——
 *   putRecord 是整行覆盖，会把并发写进来的 notes 一起盖掉。
 *   驱动没有这个方法就当场抛出来，与「文件级三个函数只在 gitee 模式可用」同一态度。
 */
function saveNotes(uid, id, notes) {
  const d = pick();
  if (typeof d.saveNotes !== 'function') {
    throw new TypeError(
      '当前存储驱动（' + mode.MODE + '）没有 saveNotes —— ' +
      '事件记录要驱动自己实现一份（见 store/cbdb.js / store/localdb.js）。'
    );
  }
  return d.saveNotes(uid, id, notes);
}

/**
 * 师傅批字 —— 一份八字一个会话，两个接口（读 / 写）。
 *
 * ⚠ 与 saveNotes 同一态度：驱动没有这个方法就**当场抛**，
 *   不做「降级成别的接口」的兜底 —— 那会把「这个后端还不支持批字」
 *   伪装成一次成功的读写。
 * ⚠ 上层（screens/result）会先用 `storeMode.supportsComments()` 问一句，
 *   所以正常路径走不到抛错这行；它存在只是为了让「忘了问」当场炸，
 *   而不是安静地干点什么。
 */
function listComments(uid, recordId, since) {
  const d = pick();
  if (typeof d.listComments !== 'function') {
    throw new TypeError(
      '当前存储驱动（' + mode.MODE + '）没有 listComments —— ' +
      '师傅批字目前只有自建本地后端（local）支持。'
    );
  }
  return d.listComments(uid, recordId, since);
}

function addComment(uid, recordId, msg) {
  const d = pick();
  if (typeof d.addComment !== 'function') {
    throw new TypeError(
      '当前存储驱动（' + mode.MODE + '）没有 addComment —— ' +
      '师傅批字目前只有自建本地后端（local）支持。'
    );
  }
  return d.addComment(uid, recordId, msg);
}

/**
 * 查一个八字的**求测单**（工单层）。
 *
 * ⚠ 与 comments 是**两层**：requests 是「有人在等师傅看这个八字」，
 *   comments 是「师傅和这个八字说过的话」。发起求测只落单、不写消息。
 *
 * ⚠ 「还没有单子」是 `ok:true + request:null`（那是常态），
 *   「读失败」是 `ok:false` —— 两者必须分开，否则界面会把断网显示成「你还没发起求测」。
 */
function getRequest(uid, recordId) {
  const d = pick();
  if (typeof d.getRequest !== 'function') {
    throw new TypeError(
      '当前存储驱动（' + mode.MODE + '）没有 getRequest —— ' +
      '求测只有自建本地后端（local）支持。'
    );
  }
  return d.getRequest(uid, recordId);
}

/** 发起求测（幂等：已有单子就返回已有那张） */
function createRequest(uid, recordId, id) {
  const d = pick();
  if (typeof d.createRequest !== 'function') {
    throw new TypeError(
      '当前存储驱动（' + mode.MODE + '）没有 createRequest —— ' +
      '求测只有自建本地后端（local）支持。'
    );
  }
  return d.createRequest(uid, recordId, id);
}

/**
 * 自定义标签 —— 五个接口（读列表 / 建 / 改名 / 删 / 归类）。
 *
 * ⚠ 与 saveNotes / listComments 同一态度：驱动没有这些方法就**当场抛**，
 *   不做「降级成别的接口」的兜底 —— 那会把「这个后端还不支持标签」
 *   伪装成一次成功的读写（用户会以为归类存上了，其实哪儿都没写）。
 * ⚠ 上层（screens/records）会先用 `storeMode.supportsTags()` 问一句，
 *   所以正常路径走不到这些抛错；它们存在只是为了让「忘了问」当场炸。
 *
 * ⚠ 五个函数**逐个**检查，不用一个循环去反射方法名：
 *   TypeError 里那句话要能指出**具体缺哪个方法**（排查时靠它定位）。
 */
function tagDriver(fn) {
  const d = pick();
  if (typeof d[fn] !== 'function') {
    throw new TypeError(
      '当前存储驱动（' + mode.MODE + '）没有 ' + fn + ' —— ' +
      '自定义标签目前只有自建本地后端（local）支持。'
    );
  }
  return d;
}

function listTags(uid) {
  return tagDriver('listTags').listTags(uid);
}

function createTag(uid, id, name) {
  return tagDriver('createTag').createTag(uid, id, name);
}

function renameTag(uid, id, name) {
  return tagDriver('renameTag').renameTag(uid, id, name);
}

function deleteTag(uid, id) {
  return tagDriver('deleteTag').deleteTag(uid, id);
}

/** 归类 / 取消归类（`tagId` 传 null 表示取消）—— 走专用接口，不是整行 PUT */
function setRecordTag(uid, recordId, tagId) {
  return tagDriver('setRecordTag').setRecordTag(uid, recordId, tagId);
}

module.exports = {
  name: function () { return mode.MODE; },
  fileLevel: fileLevel,
  supportsFilter: supportsFilter,
  supportsTags: supportsTags,
  pick: pick,
  // 文件级
  readFile: readFile,
  writeFile: writeFile,
  upsertFile: upsertFile,
  // 记录级
  listRecords: listRecords,
  putRecord: putRecord,
  deleteRecord: deleteRecord,
  clearRecords: clearRecords,
  saveNotes: saveNotes,
  // 师傅批字
  listComments: listComments,
  addComment: addComment,
  // 求测单（工单层，不是会话层）
  getRequest: getRequest,
  createRequest: createRequest,
  // 自定义标签
  listTags: listTags,
  createTag: createTag,
  renameTag: renameTag,
  deleteTag: deleteTag,
  setRecordTag: setRecordTag
};
