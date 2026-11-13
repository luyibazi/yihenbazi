/**
 * 学堂 · 书籍 —— 走本地后端四个接口（2026-10-19 换协议，与后端 demo 算法对齐）：
 *   · `GET /books`            书架（每本一行元信息，**不 stat 磁盘**）
 *   · `GET /books/toc`        目录（一章一条）
 *   · `GET /books/chapter`    **一章全文**（blocks + 本章书签 + prev/next）
 *   · `GET /books/bookmarks`  书签列表（分页懒加载 / 四柱筛选 / 按书过滤）
 *
 * ============ 这一版和上一版的根本差别（⚠ 调用方必须知道）============
 * 上一版：一本书 = 一条连续段落流，按字数切片，`file` + 全书段落 `seq` 定位，
 *   有 `from` / `prevFrom` / `hasMore` / `atIndex` 那一整套「在哪一片里」。
 * 这一版：**章是唯一的阅读单位**。一章一个请求给全，没有片、没有游标、没有续拉。
 *
 * | | 上一版 | 这一版 |
 * |---|---|---|
 * | 书的标识 | `file`（文件名） | `book`（`book_key`，docx 内容 sha256 前 16 位） |
 * | 章的标识 | `section`（章节实例 seq） | `chapter`（章序，0 起） |
 * | 书签位置 | `para`（全书段序） | `offset`（**章内字符偏移**） |
 *
 * ⚠⚠ 「章内字符偏移」的口径是**块文本以 `\n` 相连**（分隔符只在块之间），
 *   所以从偏移回到「第几块」不是 `offset / 段长`，必须「先找块、再在块内找字符」。
 *   等价实现见 screens/reader/model.js 的 locateInChapter。
 *
 * ⚠⚠ 为什么书的标识换成了 `book_key` 而不是文件名：文件名会变（改名、换个目录、
 *   两份同名不同内容的书），`book_key` 是内容哈希 ⇒ 换目录/改名都不影响书架和书签。
 *   ⚠ 但 `book_key` **不是稳定 id**：书的内容一改（Word 里存一次）hash 就变，
 *     所以**别把它存进本地持久化**（阅读位置存的是 book_key + chapter + offset，
 *     换版本后自然失效回落到章首 —— 见 core/readPos.js）。
 *
 * ============ ⚠⚠ 只有自建后端（local）有这些接口 ============
 * 书籍是「这台电脑上的一个文件夹」，登记在本地库的 folders 表里
 * （见 paipan-server/README 的 folders 说明）。CloudBase / 抖音云 / Gitee
 * 三个驱动都没有这个概念 —— 所以这里先问 storeMode.supportsBooks()，
 * 不支持时**如实说明**，绝不发一个必然 404 的请求让用户看到「加载失败」
 * （那会让人以为接口坏了，然后一直重试）。
 *
 * ============ 铁律（与 localsdk.js 一脉相承）============
 *   ① **永不 reject**：网络失败是预期内的事，用 `{ ok:false, error }` 表达；
 *   ② **读失败绝不降级成「没有内容」**：空列表 ≠ 读不到 —— 前者用户会以为
 *      书里的书签/章节被删了。两者在页面上是**两种**提示（同 records 的纪律）。
 */
const localsdk = require('./localsdk.js');
const storeMode = require('./storeMode.js');

/** 一页多少条（书签列表的取数节奏；服务端不传 limit 就是全量） */
const PAGE_SIZE = 50;

/** 四个接口共用的「这个后端不支持书籍」响应 —— 一份定义，措辞别分叉 */
function noSupport(what) {
  return {
    ok: false,
    code: 'NO_SUPPORT',
    error: '当前存储后端没有「学堂 · 书籍」数据（只有自建后端提供），无法' + what
  };
}

/**
 * 书架（`GET /books`）—— 学堂「书架」那一屏的数据入口。
 *
 * @returns {Promise<{ok:boolean, total?:number, items?:Array, error?:string}>}
 *   item 形状：`{ bookKey, slug, title, source, chapterCount, bookmarkCount, charCount }`
 *   ⚠ 字段名是 **`items`**（不是 `books`）—— `/books/bookmarks` 里那个 `books`
 *     是「命中书签的书 + 各自数量」，两回事，别混用。
 *   ⚠ 书架为空是**正常结果**（还没在管理端登记书籍目录）⇒ `ok + items:[]`，不是失败。
 */
function shelf() {
  if (!storeMode.supportsBooks()) return Promise.resolve(noSupport('取书架'));
  return localsdk.request('/books').then(function (r) {
    if (!r.ok) return r;
    const d = r.data || {};
    d.ok = true;
    d.status = r.status;
    if (typeof d.total !== 'number') d.total = 0;
    /* ⚠ 形状兜底：服务端承诺这些字段一定在，但**缺了就当空**而不是报错 ——
       宁可显示一个空书架，也不要把「字段名写错」变成整页崩溃。 */
    if (!Array.isArray(d.items)) d.items = [];
    return d;
  });
}

/**
 * 取一本书的**章节目录**（`GET /books/toc`）—— 阅读页「目录」面板的数据入口。
 *
 * 响应形状：`{ ok, book:{bookKey,title,source,chapterCount,bookmarkCount,charCount},
 *             total, chapters:[{ idx, title, level, charCount }] }`
 *   · `idx` 升序 = 文档顺序，`0..total-1` **连续**（可以直接当章序用）；
 *   · `charCount` = 该章正文字数（判断「这章有多长」，不做分片依据）。
 *   ⚠ `book` 是**对象**，不是字符串 —— 拿书名用 `book.title`。
 *
 * ⚠⚠ 空目录是**正常结果**（docx 里一个标题样式都没有的散文）⇒ `ok + chapters:[]`，
 *   **不是失败**。那种书整本被当成第 0 章（解析时兜住的），所以 reader 拿到的永远
 *   「至少一章」—— 除非书里一个字都没有（这时 total:0，App 显示「这本书是空的」）。
 *
 * @param {string} bookKey 书的 book_key
 */
function toc(bookKey) {
  if (!storeMode.supportsBooks()) return Promise.resolve(noSupport('取目录'));
  if (!bookKey) {
    return Promise.resolve({ ok: false, code: 'NO_BOOK', error: '缺少书的 book_key，无法取目录' });
  }
  return localsdk.request('/books/toc', { query: { book: bookKey } }).then(function (r) {
    if (!r.ok) return r;
    const d = r.data || {};
    d.ok = true;
    d.status = r.status;
    if (!Array.isArray(d.chapters)) d.chapters = [];
    return d;
  });
}

/**
 * 读**一章**（`GET /books/chapter`）—— 阅读页唯一的取数入口。
 *
 * @param {Object} params
 *   - {string} book     书的 book_key（必传）
 *   - {number} [chapter] 章序（0 起）。**不传 = 第 0 章**（服务端默认）
 * @returns {Promise<{ok:boolean, ...}>} 永不 reject。
 *   成功时原样透传：`{ bookKey, bookTitle, total, chapter:{idx,title,level,charCount},
 *   blocks:[{idx,type,text}], bookmarks:[{name,offset,text}], prev, next }`
 *   · `blocks[].type` ∈ `h1|h2|h3|p|source`（没有别的值，渲染按这五个分样式）
 *   · `bookmarks[].offset` = **章内字符偏移**（口径见文件头）
 *   · `prev` / `next` = 相邻章序，`null` = 到头了（**别自己算**：服务端按 total 判的）
 *
 * ⚠⚠ `chapter` **可能是 0**（合法值！）⇒ 用 `!= null` 判存在，别用 truthy ——
 *   写成 `if (p.chapter) q.chapter = ...` 的话第 0 章会被当成「没传」，
 *   而服务端默认又正好是 0，于是**看起来正常**、等到有书从别的章进来才炸。
 */
function chapter(params) {
  if (!storeMode.supportsBooks()) return Promise.resolve(noSupport('阅读'));
  const p = params || {};
  if (!p.book) {
    return Promise.resolve({ ok: false, code: 'NO_BOOK', error: '缺少书的 book_key，无法阅读' });
  }

  const q = { book: p.book };
  /* ⚠ 0 是合法章序 ⇒ `!= null` */
  if (p.chapter != null) q.chapter = p.chapter;

  return localsdk.request('/books/chapter', { query: q }).then(function (r) {
    if (!r.ok) return r;
    const d = r.data || {};
    d.ok = true;
    d.status = r.status;
    /* ⚠ 形状兜底与 shelf() 同款纪律：字段缺了就当空，不报错 ——
       宁可显示一章空内容，也不要把「字段名写错」变成整页崩溃。 */
    if (!Array.isArray(d.blocks)) d.blocks = [];
    if (!Array.isArray(d.bookmarks)) d.bookmarks = [];
    return d;
  });
}

/**
 * 取一页书签（`GET /books/bookmarks`）。
 *
 * @param {number} offset 从第几条开始（= 已加载条数）
 * @param {number} [limit] 这一页要几条，默认 PAGE_SIZE
 * @param {Object} [query] 额外查询参数：
 *   · 四柱筛选（如 `{ dayGan:'甲,乙' }`）—— 参数名与值与记录页**同一套**
 *     （见 core/pillarFilter.js 的 toQuery，服务端 parsePickedFilter 是同一份规则）；
 *   · `{ book: bookKey }` —— 只看这本书（阅读页/单本入口用）。
 *   ⚠ 空对象 / undefined = 不带筛选（拉全量）。**别把空集合拼成空串发出去** ——
 *     那是在说「我要筛空」，语义错了。
 * @returns {Promise<{ok:boolean, total?:number, offset?:number, items?:Array, books?:Array, error?:string}>}
 *   item 形状：`{ name, text, book, bookKey, chapter, offset }`
 *     `chapter` = 章序（0 起）、`offset` = **章内字符偏移**
 *   `total` = **当前筛选下**的总条数（分页判据用它）
 *   ⚠ 永不 reject。
 */
function fetchPage(offset, limit, query) {
  if (!storeMode.supportsBooks()) return Promise.resolve(noSupport('取书签'));

  /* ⚠ 分页参数在前、筛选参数在后：筛选键与 'offset'/'limit' 不会重名，
     但把分页放前面能保证**即使重名也不会被筛选覆盖**（分页是这一页的命根子）。 */
  const q = Object.assign({ offset: offset || 0, limit: limit || PAGE_SIZE }, query || {});

  return localsdk.request('/books/bookmarks', { query: q }).then(function (r) {
    if (!r.ok) return r;
    const d = r.data || {};
    return {
      ok: true,
      status: r.status,
      total: typeof d.total === 'number' ? d.total : 0,
      offset: typeof d.offset === 'number' ? d.offset : 0,
      items: Array.isArray(d.items) ? d.items : [],
      books: Array.isArray(d.books) ? d.books : []
    };
  });
}

module.exports = {
  PAGE_SIZE: PAGE_SIZE,
  shelf: shelf,
  toc: toc,
  chapter: chapter,
  fetchPage: fetchPage
};
