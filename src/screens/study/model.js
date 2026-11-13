/**
 * 学堂页（tab 2）的**纯计算层** —— 不 import 任何 React / RN 东西，可在纯 Node 里断言。
 *
 * 现在服务**两个面板**（2026-10-11 拆壳之后）：
 *   · 「查询」（`QueryPane.tsx`）—— 全馆书签按页拉回来、滚到底接着拉；
 *   · 「书籍」（`BooksPane.tsx`）—— 书架：把登记在册的书列出来（见下面那节）。
 * 拆出这一层的理由与其他页一致 —— 分页状态机（什么时候该要下一页、
 * 什么时候算到底了）是最容易写错、也最值得用断言守住的部分。
 *
 * ============ 书签名长什么样 ============
 * 「丙寅，丁酉，己酉，丙寅」—— 四组干支用**全角逗号**分隔（docx 标注脚本的格式）。
 * ⚠ Word 对**重名书签**会自动加 `_2` 后缀（实测渊海子平里有
 *   「己未，戊辰，甲寅，癸酉_2」）—— 展示时剥掉，别让它混进格子里。
 * ⚠ 万一某个名字不是四组（手工改过），**原样一行显示**，不硬拆四格
 *   （硬拆出来的「—」会让人以为数据坏了）。
 */

/** 一页多少条 —— 与 core/books.js 的 PAGE_SIZE、服务端默认值三者一致 */
const PAGE_SIZE = 50;

/** 四组干支之间的显示分隔（与记录页的列表一致：空格拉开，不是逗号） */
const CHAR_GAP = ' ';

/** 剥掉 Word 给重名书签加的 `_2` / `_3` 后缀 */
function stripSuffix(p) {
  return String(p == null ? '' : p).replace(/_[0-9]+$/, '');
}

/** 书签名 → 四组干支（不是四组时返回空数组） */
function pillarsOf(name) {
  const parts = String(name == null ? '' : name)
    .split('，')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  return parts.length === 4 ? parts.map(stripSuffix) : [];
}

/**
 * 列表项 → 两行干支（天干一行、地支一行）。
 * ⚠ 与记录页 model.pillarRows 的输出格式**刻意相同**（空格分隔的两行字符串），
 *   让「记录列表」与「书签列表」上的八字长得一模一样。
 *
 * @returns {{stems:string, branches:string, plain:boolean}}
 *   plain = true 表示不是标准四柱，`stems` 里放的是原文（界面按一行显示）
 */
function pillarRows(name) {
  const parts = pillarsOf(name);
  if (parts.length !== 4) {
    return { stems: String(name == null ? '' : name), branches: '', plain: true };
  }
  return {
    stems: parts.map(function (p) { return p.charAt(0) || '—'; }).join(CHAR_GAP),
    branches: parts.map(function (p) { return p.charAt(1) || '—'; }).join(CHAR_GAP),
    plain: false
  };
}

/** 书名 —— 去掉 `.docx` 后缀（列表里显示「滴天髓」而不是「滴天髓.docx」） */
function bookTitle(file) {
  return String(file == null ? '' : file).replace(/\.docx$/i, '');
}

/**
 * 一条书签的出处：「书名 · 第 12 章」。
 *
 * ⚠⚠⚠ 2026-10-19 换协议时这里**必须跟着改**：`item.chapter` 从
 *   「章节层级路径的数组」（`['卷一','原造化之始']`，老 bookmark_docs 口径）
 *   变成了「**章序数字**」（`chapter_idx`，0 起）—— 形状完全不同，不是名字变了而已。
 *   照着老写法 `Array.isArray(ch)` 判会恒假 ⇒ 出处永远只剩书名，
 *   而且**一处都不报错**（列表看起来"干净"，但用户失去了「这条书签在哪一章」）。
 * ⚠ 章序是 0 起的**技术编号**，直接给用户看要做成 1 起（「第 1 章」），
 *   否则「第 0 章」像坏数据。⚠ `chapter` 缺失（老数据 / 服务端没给）⇒ 不显示那一段。
 * ⚠ 这一整条**只是书签列表里的一行出处**，不承担定位职责 ——
 *   点它进阅读页用的是 `chapter` + `offset` 两个数字（见 bookTargetOf / openParams）。
 */
function sourceText(item) {
  const parts = [];
  const book = item && item.book ? bookTitle(item.book) : '';
  if (book) parts.push(book);
  const ch = item ? item.chapter : null;
  if (typeof ch === 'number' && isFinite(ch) && ch >= 0) parts.push('第 ' + (ch + 1) + ' 章');
  return parts.join(' · ');
}

/**
 * 要不要去要下一页（挂在 FlatList 的 `onEndReached` 上）。
 *
 * ⚠⚠ 判据里 `phase !== 'ok'` 是**并发与重复的闸门**：
 *   loading（已经在要了）/ fail（等用户点重试）/ end（真到底了）/ idle
 *   四种情况都**不发**。少这一条，快速滑动会连着发好几次同一个 offset
 *   —— 列表里出现重复条目，而且看起来像「数据重复」不是「代码 bug」。
 *
 * ⚠ 这里不自己算「距底部多少像素」：`onEndReached` 就是 FlatList 给的
 *   「快到底了」信号，自己再算一遍（Records 页那种 ScrollView 写法）
 *   反而要维护阈值常量。用虚拟化列表就顺着它的语义走。
 *
 * @param {number} loaded 已经拿到的条数
 * @param {number} total  全馆总条数（服务端 authoritative）
 * @param {string} phase  'idle' | 'loading' | 'ok' | 'fail' | 'end'
 */
function shouldLoadMore(loaded, total, phase) {
  if (phase !== 'ok') return false;
  return loaded > 0 && loaded < total;
}

/**
 * 一次成功响应之后进入哪个阶段。
 * ⚠ 「到底」的判据是 **loaded >= total**（服务端给的权威总数），
 *   不是「这一页没装满」—— 后者在服务端 total 被截断时会误判。
 * ⚠⚠ `gotInPage === 0` 是**防死循环**的兜底：服务端一条都没给、
 *   而 total 却说还有（数据在两次请求之间被改小，或 offset 越界）时，
 *   用户还停在底部 ⇒ onEndReached 会一直触发 ⇒ 一直要同一个 offset。
 *   直接判「到底」收手，比转圈转到天荒地老好。
 */
function phaseAfter(loaded, total, gotInPage) {
  if (total > 0 && loaded >= total) return 'end';
  if (gotInPage === 0) return 'end';
  return 'ok';
}

/**
 * 计数文案：「共 3731 个 · 已加载 50 个」。
 *
 * ⚠ **列表里那行已经不显示了**（用户 2026-10-10 要求移除，见 Study.tsx 里 `card` 样式上的注释
 *   —— 工具栏的筛选入口右侧本来就显示同一句，列表里再来一遍是重复）
 *   ⇒ 现在只剩两处调用：**筛选入口**（钉在顶部那行）与**筛选弹窗**的标题右侧。
 *   别以为没人用了就把这个函数删了。
 *
 * ⚠ 带筛选时说的是「筛出 N 个」—— 服务端给的 `total` **本来就是筛后总数**，
 *   所以这里的 N 是诚实的；绝不用筛后的数字冒充全馆总数（记录页同一纪律，
 *   见 core/pillarFilter.js 的 countText）。
 *
 * @param {number} loaded 已加载条数
 * @param {number} total  当前筛选下的总条数（服务端权威）
 * @param {boolean} [filtered] 这一批是不是筛选的结果
 */
function countText(loaded, total, filtered) {
  if (!(total > 0)) return '';
  const head = filtered ? '筛出 ' + total + ' 个' : '共 ' + total + ' 个';
  return head + ' · 已加载 ' + Math.min(loaded, total) + ' 个';
}

/**
 * 列表底部那条：文案 + 能不能点。
 * ⚠ 「加载失败」必须**可点重试**：失败后如果不给出口，用户除了切走再回来
 *   没有任何办法（而切走再回来因为「已经加载过」也不会重来）。
 */
function footOf(phase, loaded, total) {
  if (phase === 'fail') return { text: '加载失败 · 点这里重试', retry: true };
  if (phase === 'end' && total > 0) return { text: '没有更多了', retry: false };
  if (phase === 'loading' && loaded > 0) return { text: '正在加载…', retry: false };
  return { text: '', retry: false };
}

/**
 * 空列表时的提示 —— 三种情况必须分开（同记录页的纪律）：
 *   · 读不到（失败）      → 说失败，可重试
 *   · **被筛空**          → 「没有符合条件的书签」（⚠⚠ 说成「还没有书籍书签」
 *                           会让用户以为馆里的书签没了；跟记录页同一类坑）
 *   · 这条馆里确实没有    → 「还没有书籍书签」
 */
function emptyText(phase, errText, filtered) {
  if (phase === 'loading') return '正在加载…';
  if (phase === 'fail') return errText || '加载失败';
  if (filtered) return '没有符合条件的书签';
  return '还没有书籍书签';
}

/* ================================================================
 * 书籍面板 = **书架**（★ 2026-10-11 用户要求：
 *   「书籍页面从后端获取书籍列表，显示书籍。像书架功能」）
 * ================================================================
 * ⚠⚠⚠ 2026-10-19 换协议：书架**不再借** `/books/bookmarks` 的 `books[]`，
 *   改走 `/books`（`core/books.js` 的 `shelf()`）。两个原因：
 *   ① 那个 `books[]` 是「**命中书签**的书 + 各自数量」—— 一本**一条书签都没有**的书
 *      在它里面压根不出现（`GROUP BY` 出来的），书架会凭空少书；
 *   ② 它要连带查全馆书签，而书架**一条书签都不需要**。
 *   ⇒ 老的 `SHELF_LIMIT`（用 limit=1 把 items 压到最小）也一并删除：没有要压的东西了。
 *
 * ⚠ 服务端 `/books` 的字段是 `{ bookKey, slug, title, source, chapterCount,
 *   bookmarkCount, charCount }`。书架上「共计 N 案例」用的是 **`bookmarkCount`**
 *   （= 书签数，用户 2026-10-11 原话「数量就是书签的数量」）。
 * ⚠ 解析失败的书在新协议下**根本进不了表**（服务端只把成功的写进四张表，
 *   失败的只出现在 sync 的 errors 里）⇒ 这里**没有** `error` 字段可判，
 *   书架上也就不会再出现「读不了的书」那种灰格子。那是换协议顺带的效果，不是漏了。
 */

/**
 * ⚠ 2026-10-11 用户要求「将书签等提示字移除，将书本缩小」⇒ 原先把「共 N 本 · M 条书签」
 *   与每本书下面那行（「750 条书签」/「还没有书签」/「这本书读不了」）算出来的两个纯函数
 *   (`shelfSummaryText` / `bookMetaText`) **一起删掉了** —— 不留在 model 里当死代码：
 *   文案没了、调用点没了，函数还留着的话，下次有人看见名字就会把它接回去。
 *   现在书架只剩「封面 + 书名」，坏文件靠**颜色**表达。
 */

/** 书架空着时那一屏（读不到 / 加载中 / 真的没有书 —— 三种必须分开） */
function shelfEmptyText(phase, errText) {
  if (phase === 'loading') return '正在加载…';
  if (phase === 'fail') return errText || '加载失败';
  return '书籍目录里还没有 docx';
}

/* ------------------------------------------------------------ 阅读页 target（两条来路共用一种形状） */

/**
 * ★★★ 阅读页的 target —— **只有一种形状**，两条来路都产出它：
 *
 * | 来路 | `chapter` | `offset` | `name` |
 * |---|---|---|---|
 * | 书架点封面 | **null** | **null** | `''` |
 * | 点书签 / 查询页那一条 | 章序数字 | 章内字符偏移 | 书签名（定位退路） |
 *
 * ⚠⚠⚠ `null` 与 `0` 在这里是**完全不同**的两件事，写错就会「打开到别的地方、而且不报错」：
 *   · `chapter = null, offset = null` ⇒ 阅读页判为「从书架进来」⇒ 恢复本地阅读位置；
 *   · `chapter = 0`  ⇒ 「第一章」—— 写成 0 就等于「每次都从头开始读」，本地位置永远用不上。
 *   （判据在 `reader/model.js` 的 `fromShelf`，用的是 `== null`。）
 *
 * ⚠ `book` 放的是 **`book_key`**（docx 内容 sha256 前 16 位），不再是文件名：
 *   改文件名 / 换目录都不影响书架与书签；⚠ 但内容一改 hash 就变 ⇒ 别把它当稳定 id 存起来。
 * ⚠⚠⚠ 正因为 `book` 是哈希，**书名必须另带一个 `title`**：App 的导航栏标题读它
 *   （`readerTarget.title`）。少了这个字段，导航栏会显示一串哈希 —— 而且**不报错**。
 * ⚠ `name` / `chapter` 这两个字段名与书签列表 item 上的一样，但**这里 `chapter` 是数字**、
 *   item 上的 `chapter` 也是数字（新协议）⇒ 直接 spread 一条 item 也是对的形状。
 *
 * @param {Object} b 一本书（`/books` 的 item：`{ bookKey, title, bookmarkCount, ... }`）
 */
function bookTarget(b) {
  const key = b && b.bookKey ? String(b.bookKey) : '';
  const t = b && typeof b.title === 'string' ? b.title : '';
  return { name: '', chapter: null, offset: null, book: key, title: t };
}

/**
 * 一条书签 → 阅读页 target（点列表里那一行）。
 *
 * ⚠ 两个字段都可能是 **0**（第 0 章 / 章内第 0 个字），都是合法值 ——
 *   这里用 `typeof === 'number'` 而不是 `|| 0`：`||` 会把「恰好是 0」当成缺失再补一个 0，
 *   今天结果一样，但一旦将来默认值不是 0（比如改回「上次读到的章」）就会静默错。
 * ⚠ `offset` 缺失时给 **null**（不是 0）：「不知道在哪」与「就在章首」是两件事 ——
 *   前者应当**不定位**（停在章首给人看见全章），后者要**滚到第一个字**。
 * ⚠ `name` 带上：偏移若因书重存而错位，阅读页会拿书签名**按文字再找一次**
 *   （见 reader/model.js 的 `matchBlock`）。
 * ⚠⚠⚠ `title` 从 item 的 `book` 字段带过来（书签 item 上 `book` 是**书名**、
 *   `bookKey` 才是哈希）—— 导航栏标题读它，别让哈希显示给用户。
 *
 * @param {Object} item `/books/bookmarks` 的 item：`{ name, text, book, bookKey, chapter, offset }`
 */
function bookmarkTarget(item) {
  const it = item || {};
  return {
    name: typeof it.name === 'string' ? it.name : '',
    chapter: typeof it.chapter === 'number' ? it.chapter : 0,
    offset: typeof it.offset === 'number' ? it.offset : null,
    book: it.bookKey ? String(it.bookKey) : '',
    title: typeof it.book === 'string' ? it.book : ''
  };
}

/**
 * 未登录时整页挡住的说明与唯一出口（★ 2026-10-21 用户要求「学堂模块只限登录才可以使用」）。
 *
 * ⚠ 为什么挡在**壳**这一层（Study.tsx）而不是两个面板各挡一次：
 *   面板里的数据（书签 / 书架）全在服务端、跟着账号走，未登录时它们只会回 401 ——
 *   让两个面板各写一遍「没登录就别请求」就是两个口径，迟早漂。
 *   壳挡住 ⇒ 面板根本不挂载（也就不会白发请求、更不会残留上一个人的书签）。
 * ⚠ 文案只写事实 + 留一个能点的出口（去登录），不要在这里教用户怎么做。
 */
const GATE_LOGIN = {
  title: '登录后才能使用学堂',
  body: '书签与书籍存在云端，跟着账号走。',
  action: '去登录'
};

module.exports = {
  PAGE_SIZE: PAGE_SIZE,
  pillarsOf: pillarsOf,
  pillarRows: pillarRows,
  bookTitle: bookTitle,
  sourceText: sourceText,
  shouldLoadMore: shouldLoadMore,
  phaseAfter: phaseAfter,
  countText: countText,
  footOf: footOf,
  emptyText: emptyText,
  /* ===== 书籍面板 = 书架 ===== */
  shelfEmptyText: shelfEmptyText,
  bookTarget: bookTarget,
  bookmarkTarget: bookmarkTarget,
  /* ===== 未登录闸门（见 GATE_LOGIN） ===== */
  GATE_LOGIN: GATE_LOGIN
};
