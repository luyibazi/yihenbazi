/**
 * 阅读位置 —— 每本书在**手机本地**记一条「读到哪一章的哪个字」，下次打开直接跳回去。
 * （2026-10-12 用户：「能不能记住阅读位置？存在手机本地？」→ 恢复方式选了「直接跳回，
 *   不弹窗不打扰」。）
 *
 * ============ 为什么单独一层（与 savedLogin.js 同一套理由）============
 *   ① 阅读页要用它（读 + 写），但阅读页是 .tsx、被 React 包着 ——
 *      存取逻辑留在这里就能**纯 Node 断言**（tests/screens-check.js），
 *      不用为了验一段读写去起一个渲染环境。
 *   ② 「位置」的边界语义全是坑，见下面两条红线 —— 抽出来才守得住。
 *
 * ============ 2026-10-19 换协议：键从「文件名」变成「book_key」，位置从 seq 变成 chapter+offset ============
 * 存储键升到 **v2**（`paipan_read_pos_v2`）而不是就地改 v1 的形状：
 *   v1 里装的是 `{ 文件名 → {seq} }`，新形状装 `{ book_key → {chapter, offset} }`。
 *   两者**键和值都不同**，就地改会把每个老值都读成坏数据（`seq` 字段不存在）
 *   ⇒ 全都当「没记过」扔掉，跟换键的效果一样，却多了一段看不出在干什么的兼容代码。
 *   ⚠ 代价：升级后**第一次**打开书会回到章首（老位置不迁移）—— 这是刻意的：
 *     book_key 是内容哈希，老位置记的文件名根本对不到新书上去（而且那时正文按
 *     `whole=1` 切过，seq 与新的块下标也不是一个坐标系）。
 *
 * ============ ⚠⚠⚠ 红线一：`chapter: 0` 与 `offset: 0` 都是**合法值** ============
 * 第一章 / 章首第一个字。判「有没有记过」只能看它**是不是 null/undefined**，绝不许 truthy：
 * 写成 `if (pos && pos.chapter)`，读到第一章的人下次打开会被当成「没记过」扔回书首
 * —— 看起来就像「这功能时灵时不灵」，最难查。
 *
 * ============ ⚠ 红线二：任何异常都吞掉，绝不抛 ============
 * 阅读位置丢了**不要紧**（顶多回到章首），把它抛出去把退场路径搞崩才要紧。
 * 存储可能被手改 / 半截 JSON / 将来的代码写歪 —— 读写两侧都按「坏了就当没有」归一。
 *
 * ============ 存储的边界（知情选择，不是疏忽）============
 * 存在 `platform/storage.js`（AsyncStorage / 本机文件）里 —— 那个文件头写着
 * 「只存运行凭据，绝不存记录数据」，**这里的阅读位置不是排盘记录**（用户 2026-10-12
 * 明确要求存本地），不属于那条红线管的对象。它也不含任何命理内容，只是
 * `book_key → 章序 + 字符偏移`，换手机 / 卸载即消失。
 *
 * ============ 键的形状 ============
 * 一把钥匙 `paipan_read_pos_v2` 装一张 `{ book_key → {chapter, offset, ts} }` 的表
 * （书就十来本，一条几十字节，不值得一把书一把钥匙）；写 = 改表 + 整份落盘（与 savedLogin 同款）。
 * 惰性解析进内存缓存：读 0 延迟（storage 本身就是内存镜像），写才重新序列化。
 */
const storage = require('../platform/storage.js');

/** 本机存储键 —— 独立的键，与登录态 / 设备码 / **v1 的老位置**互不覆盖 */
const KEY = 'paipan_read_pos_v2';

/** 坏数据防御：一张表的条数上限（正常书架远到不了；防手改 / 写歪撑爆存储） */
const MAX_BOOKS = 300;

/** 惰性缓存：null = 还没解析过（读写都会先走 all()） */
let cache = null;

/** 读原始表。任何异常 / 形状不对 → 空表（绝不抛，见红线二） */
function all() {
  if (cache !== null) return cache;
  cache = {};
  try {
    const raw = storage.getStorageSync(KEY);
    if (!raw) return cache;
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (o && typeof o === 'object' && !Array.isArray(o)) cache = o;
  } catch (err) {
    console.warn('[paipan] 读取阅读位置失败', err);
  }
  return cache;
}

/** 一个数是不是「合法的非负整数位置」（`0` 合法，见红线一） */
function isPos(n) {
  return typeof n === 'number' && isFinite(n) && n >= 0;
}

/**
 * 某本书读到哪一章的哪个字。
 *
 * @param {string} bookKey 书的 book_key
 * @returns {{chapter:number, offset:number, ts:number}|null} 没记过 / 数据坏了 → **null**
 *   ⚠⚠ `chapter: 0` / `offset: 0` 会**如实返回**（红线一：第一章、章首都是合法位置）。
 */
function get(bookKey) {
  if (!bookKey) return null;
  const o = all()[String(bookKey)];
  if (!o || typeof o !== 'object') return null;
  /* ⚠ 两个都要是合法数字：只记了章、没记偏移（半截数据）就当坏的 ——
     重建成 `offset: 0` 会把人送到章首，而他自己读到的是章末，
     那比「回到章首」更让人困惑（明明跳了，却跳到了错的地方）。 */
  if (!isPos(o.chapter) || !isPos(o.offset)) return null;
  return { chapter: o.chapter, offset: o.offset, ts: typeof o.ts === 'number' ? o.ts : 0 };
}

/**
 * 记下「这本书读到第 `chapter` 章、章内第 `offset` 个字」。
 *
 * ⚠ 调用方是阅读页**退场**那一下（卸载清理里），一次开书只写一次 ——
 *   别在滚动里高频调（每次都整份序列化落盘）。
 * ⚠ 任一个不是非负数字 → 直接不写（老位置原样保留：写进一个坏值
 *   下次 get 会返回 null，等于把位置弄丢）。
 * @param {string} bookKey 书的 book_key
 * @param {number} chapter 章序（0 起）
 * @param {number} offset 章内字符偏移（0 = 章首）
 */
function set(bookKey, chapter, offset) {
  if (!bookKey || !isPos(chapter) || !isPos(offset)) return;
  const map = all();
  map[String(bookKey)] = { chapter: chapter, offset: offset, ts: Date.now() };
  /* 超上限挤最旧的（按 ts；没写过 ts 的当 0 = 最旧）—— 正常一辈子到不了这 */
  const keys = Object.keys(map);
  if (keys.length > MAX_BOOKS) {
    keys.sort(function (a, b) {
      const ta = map[a] && map[a].ts ? map[a].ts : 0;
      const tb = map[b] && map[b].ts ? map[b].ts : 0;
      return ta - tb;
    });
    while (keys.length > MAX_BOOKS) delete map[keys.shift()];
  }
  cache = map;
  try {
    storage.setAndPersist(KEY, JSON.stringify(map));
  } catch (err) {
    console.warn('[paipan] 写入阅读位置失败', err);
  }
}

module.exports = {
  KEY: KEY,
  MAX_BOOKS: MAX_BOOKS,
  get: get,
  set: set
};
