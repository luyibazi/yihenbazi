/**
 * 阅读页（推入层）的**纯计算层** —— 不 import 任何 React / RN 东西，可在纯 Node 里断言。
 *
 * ============ 这一页的取数模型（与 core/books.js、服务端五个口同源，2026-10-19 换协议）============
 * **章是唯一的阅读单位**。一章 = 一次请求给全（`GET /books/chapter`）：
 *   `{ chapter:{idx,title,level,charCount}, blocks:[{idx,type,text}], bookmarks:[{name,offset,text}],
 *      prev, next }`
 *   · 没有「片」、没有游标、没有续拉 —— 滑到底就是本章的底；
 *   · 换内容只有三种来路：进书 / 上一章下一章 / 目录点一章（都走 `load` 整章换）；
 *   · 章标题是**块**（`type: 'h1'|'h2'|'h3'`），跟着正文一起下来 ⇒ 不用再自己插标题行。
 *
 * | | 上一版（作废） | 这一版 |
 * |---|---|---|
 * | 段落标识 | 全书 `seq` | 块下标 `blocks[i].idx` |
 * | 书签定位 | `para`（全书段序） | `offset`（**章内字符偏移**） |
 * | 章的标识 | `section`（章节实例 seq） | `chapter`（章序，0 起） |
 *
 * ⚠⚠⚠ **「章内字符偏移」的口径是「块文本以 `\\n` 相连」**（分隔符只在块之间）：
 *   块序列 `["甲乙", "丙丁"]` ⇒ 章文本 `"甲乙\\n丙丁"`，`offset = 3` 指的是「丙」。
 *   ⇒ 从偏移回到「第几块」**不能**用 `offset / 段长` 这种字数下标去猜，
 *     必须「**先找块、再在块内找字符**」—— 那是 `locateInChapter`，本文件唯一一处实现。
 *     （服务端 lib/booksSchema.ts 写入时用的是同一口径，两边必须一致。）
 *
 * ============ 两条墓碑（用户 2026-10-17 明确否掉的形态，别再往回加）============
 *   · 「往下滑进空白 ⇒ 自动续拉下一片」：用户原话「阅读页面向下滑动就不要做懒加载了」。
 *     一章已经给全了，再往下要就是**下一章** —— 那是工具栏按钮的活，不是滑动的活。
 *   · 「滚到顶 ⇒ 弹模态加载框接更早一片」：一次一章没有「更早一片」，
 *     往上看就是**上一章**（工具栏 / 目录）。
 *   ⇒ 于是 `splitAt` / `nextFrom` / `hasMoreDown` / `appendParas` / `prependParas` /
 *     `mergeParas` / `atSeqOf` / `rowIndexOfSeq` / `seekRowIndex` / `chapterAt` 这一族
 *     **全部删除了**（它们全都在说「这本书是一条连续的流」）。别按名字把老的实现找回来。
 *
 * ============ 保留下来并且**照旧用**的那套：按实测行高定位 ============
 * 换协议**没有**动「怎么滚到某一行」这件事，那是渲染层的问题、与取数协议无关：
 *   · `scrollToIndex` 没有 `getItemLayout` 时按「平均行高 × 下标」**估** ⇒ 中文折行、标题深浅
 *     各不相同，能差一两屏，而且不触发失败回调（没有第二次机会）；
 *   · 现在：每行 `onLayout` 报**实测高度** ⇒ 第 k 行的 y = 前面所有行高度之和，是**真值**。
 *   ⇒ `rowLayoutH` / `seekStep` / `hasRowH` 原样保留（2026-10-17 定的，仍在用）。
 *     ⚠ 新增的只有一件事：**目标行（块下标）怎么变**（`locateInChapter`），怎么滚没变。
 *
 * ============ 为什么这些小函数值得单独一层 ============
 * 「块首的偏移恰好落在分隔符上」「书签落在第 0 块、offset 恰好是 0」
 * 这类**边界语义**正是最容易写错、又最值得用断言守住的 —— 抽出来才能在
 * Node 里直接断言（与 study/model.js、tabs/model.js 同一套纪律）。
 */

/* ------------------------------------------------------------ 文案（只写一份） */

const LOADING_TEXT = '正在加载…';
const FAIL_TEXT = '加载失败';
const RETRY_TEXT = '点这里重试';

/* ------------------------------------------------------------ 工具栏 */

/**
 * 阅读页**头部**的文案（2026-10-19 照 demo `docx-book/demo/index.html` 重做后的形态）。
 *
 * ============ 形态改向，两次都记在这里，别再互相打脸 ============
 * · 10-14 用户：「像那些阅读小说软件一样点击屏幕出现上一章 下一章 目录 夜间等这些
 *   底部和头顶的工具栏出现」⇒ **点屏幕才呼出**的工具栏（顶栏章名 + 底栏三枚按钮）。
 * · 10-19 用户：「学堂页面的书籍页面清空重做，参照demo方式做」⇒ demo 的头部是
 *   **常驻**的（上一章 / 标题 / 位置 / 下一章），侧栏（目录 + 书签）也是常驻的。
 *   ⇒ 这一版改成：**常驻头部**（目录按钮 + 章名/位置 + 上一章下一章），
 *     侧栏改成**左侧抽屉**（手机上 750rpx 常驻会把正文压到一行 12 个字）。
 *   ⚠ 「点屏幕呼出」那一套（`barOn` / `onTapStart` / `onTapEnd`）整族删除 ——
 *     不是改个值，是**没有触发点了**：头部常驻，没有什么要呼出的。
 *   ⚠ 也别把「夜间」摆进来（本轮不做，假按钮比没有更糟）。
 *
 * ⚠⚠ 上一章 / 下一章 = **跳到相邻章的开头**（换整章内容、视口跟着跳），
 *   与「沿着同一条流往上游接一片、当前行不动」是**完全不同的两件事**（后者已作废，见文件头）。
 */
const TOC_TEXT = '目录';
const PREV_CH_TEXT = '上一章';
const NEXT_CH_TEXT = '下一章';
/** 侧栏（抽屉）的第二个页签：这本书的全部书签（demo 侧栏的「书签」那一栏） */
const BM_TEXT = '书签';
/** 侧栏搜索框的占位（demo 的 `placeholder="搜索标题 / 书签"`，一字不改） */
const SEARCH_PLACEHOLDER = '搜索标题 / 书签';
/** 目录面板：一个章节都没有（**说事实**，不教用户怎么办） */
const TOC_EMPTY_TEXT = '这本书没有章节';
/** 书签页签：这本书一条书签都没有（同上，只说事实） */
const BM_EMPTY_TEXT = '这本书没有书签';
/** 搜索没有命中（两栏各一句 —— 「没有匹配的章节」/「没有匹配的书签」） */
const NOMATCH_CH_TEXT = '没有匹配的章节';
const NOMATCH_BM_TEXT = '没有匹配的书签';
/** 目录面板的关闭（抽屉除了点背面遮罩，还要有一个明确出口） */
const TOC_CLOSE_TEXT = '关闭';
/** 章名为空时头部显示它（demo 的 `（卷首）`：无标题书整本是一章） */
const UNTITLED_TEXT = '（卷首）';

/**
 * 头部那一行位置：「第 3/12 章 · 4200 字」。
 *
 * ⚠ 从**响应**里取数，不从目录推：`total` 是 `/books/chapter` 一起回来的
 *   （服务端按总章数判的，和 prev/next 同一份真相）⇒ 目录还没取到时这一行也准。
 * ⚠ 章序 0 是合法值 ⇒ `chIdx` 传不进来时（数据还没到）整行**不显示**（返回 ''），
 *   别显示「第 1/0 章」这种自己吓自己的东西。
 */
function posText(chIdx, total, charCount) {
  if (typeof chIdx !== 'number') return '';
  const t = typeof total === 'number' && total > 0 ? total : 0;
  const n = typeof charCount === 'number' && charCount > 0 ? charCount : 0;
  return '第 ' + (chIdx + 1) + '/' + t + ' 章 · ' + n + ' 字';
}

/* ------------------------------------------------------------ 展示口径 */

/**
 * 书名 —— 去掉 `.docx` 后缀。
 * ⚠ 新协议下行标题已经是 `book.title`（服务端把文件名去后缀存进 slug/title，
 *   见 lib/booksSchema.ts 的 `title: opt.title || slug`）⇒ 这里再兜一道是给
 *   「服务端换了实现、title 里又带上后缀」留的余地，不是主路径。
 * ⚠ 与 study/model.js 的 bookTitle 同款口径，但**刻意不跨屏 require**：
 *   阅读页是独立页面，不为这一行去背学堂列表的包。
 */
function bookTitle(book) {
  return String(book == null ? '' : book).replace(/\.docx$/i, '');
}

/* ================================================================
 * 章内字符偏移 ⇄ 块下标（★ 这一版新增的唯一一处「定位换算」）
 * ================================================================
 * ⚠⚠⚠ 口径（与服务端写入时逐字同一套）：
 *   章文本 = 各块 `text` 用 **`\n`** 连起来（分隔符只在块之间，最后一块后面没有）。
 *   ⇒ 第 0 块从 0 开始；第 k 块从 `sum(len(text[0..k-1]) + k)` 开始
 *     （k 个分隔符：块 0 与块 1 之间有 1 个，块 0..k-1 一共 k-1 个，再加本块前面的那一个）。
 * ⚠ 所以**不能**拿 `offset - 已累计字数` 当「块内第几个字」：那样每过一块就少减一个分隔符，
 *   累积下来能偏出几十个字（而且**不报错**，只是定位到附近的段落）。
 */

/**
 * 各块的**起始偏移**表（与服务端口径一致）。
 *
 * @param {Array<{idx,type,text}>} blocks 服务端给的块（顺序即渲染顺序）
 * @returns {Array<number>} 与 blocks 等长的数组：`starts[i]` = 第 i 块第一个字符的章内偏移
 */
function blockStarts(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const out = [];
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    out.push(at);
    const b = list[i];
    const len = b && typeof b.text === 'string' ? b.text.length : 0;
    /* ⚠ 最后一块后面那个 `\n` 不存在，但多算一个没人读（下一轮循环不进来）⇒ 不加特判 */
    at += len + 1;
  }
  return out;
}

/**
 * ★★★ **章内字符偏移 ⇒ 块下标**（书签定位、阅读位置恢复都走这里）。
 *
 * 规则（用户 2026-10-10 的直觉 + 这一版的口径）：
 *   · `offset` 落在第 i 块的 `[starts[i], starts[i] + len)` 区间 ⇒ 就是 i；
 *   · `offset` **恰好落在分隔符上**（= `starts[i+1] - 1`）⇒ 归**前一块的末尾**
 *     （那个 `\n` 属于「第 i 块后面」，读者的视觉落点还在第 i 块的字上，
 *      归到下一块会让他看到「定位到下一段的第一个字」——差一个自然段，观感完全不同）；
 *   · `offset` 越过章尾 / 负数 / 非数字 ⇒ **-1**（调用方据此不滚，别猜一个位置）。
 *
 * ⚠⚠ 越界返回 -1 而不是「夹到最后一块」：夹过去会把读者送到一个**错误的段落**上，
 *   而且一处都不报错。宁可不动（停在章首），也不要动错 —— 与 `matchBlock` 的纪律同源。
 *
 * @param {Array<{idx,type,text}>} blocks 章里的块
 * @param {number|null|undefined} offset 章内字符偏移（`0` 是**合法值**）
 * @returns {number} 块下标；定位不出来 → -1
 */
function locateInChapter(blocks, offset) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) return -1;
  if (typeof offset !== 'number' || !isFinite(offset) || offset < 0) return -1;
  const starts = blockStarts(list);
  const end = starts[list.length - 1] +
    (typeof list[list.length - 1].text === 'string' ? list[list.length - 1].text.length : 0);
  /* ⚠⚠⚠ 判据是 `offset >= end`（**不是** `>`）：`end` = 章文本的**总长度**，
     合法偏移只到 `end - 1`（最后一个字）。写成 `>` 时「恰好落在章尾」那一个偏移
     （= 长度本身，一个字符都不指）会溜进来，被下面的循环判成「落在分隔符上」
     ⇒ 归到**倒数第二块**—— 用户看到的是「定位到上一段」，而且一处都不报错。 */
  if (offset >= end) return -1;
  /* 从后往前找第一个 `starts[i] <= offset`：块数通常几十到几百，倒序找让「靠近末尾的书签」
     少走几轮；用倒序而不是二分是因为 `starts` 单调递增但**不严格**（空块会重号），
     二分在重号处落到哪一块是不确定的。 */
  for (let i = list.length - 1; i >= 0; i--) {
    if (starts[i] <= offset) {
      const b = list[i];
      const len = b && typeof b.text === 'string' ? b.text.length : 0;
      /* 落在分隔符上 ⇒ 归前一块（见函数头） */
      if (offset >= starts[i] + len && i > 0) return i - 1;
      return i;
    }
  }
  return -1;
}

/**
 * ★★★ **按书签文字找那一块**（`locateInChapter` 的退路，2026-10-17 照 docx-viewer 定下的）。
 *
 * 思路只有三句（参考项目 https://github.com/luyibazi/docx-viewer 的 `pages/read.js`）：
 *   ① 在**本章**里找「包含书签文字」的那一块；
 *   ② 找的是**文字**，不是块号 —— 块号会随排版变，文字不会；
 *   ③ 整段找不到就**取前 8 个字**再找一次。
 *
 * 为什么需要退路：`offset` 是**这本书这一版**量的位置，书在 Word 里重存一次、
 * 或者库被 force 重解析一遍，偏移就可能整体错位 ⇒ 按偏移定位会落到附近的某一段。
 * 文字比数字稳。
 *
 * ⚠⚠ 书签文字与正文**不是逐字相同**：实测书签名是「丙寅，丁酉，己酉，丙寅」，
 *   正文那一段却是「戊子己丑，霹雳火」这样（三命通会）或「八字：辛卯 丁酉 庚午 丙子」
 *   （滴天髓）—— 标点/空格/前缀/异体字全不一样。⇒ 比之前两边都**只留汉字**，
 *   再比「年月两柱共 8 个字」。真库 1200 条抽样：前 8 字对 1144 / 错 10，
 *   前 4 字对 996 / 错 170 ⇒ **少一个字就多 10 倍错段，别「简化」回前 4 字**。
 *
 * @param {Array<{idx,type,text}>} blocks 章里的块
 * @param {string} text 书签文字（可空）
 * @returns {number} 块下标；找不到 → -1
 */
function matchBlock(blocks, text) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) return -1;
  const han = function (s) {
    return String(s == null ? '' : s).replace(/_[0-9]+$/, '').replace(/[^\u4e00-\u9fff]/g, '');
  };
  const full = han(text);
  /* ⚠ **长 → 短**逐档试，第一档命中就返回：先试 8 个字（年月两柱）宁可漏、不可错；
     漏了再用 4 个字（年柱）补。**不许反过来**（先 4 字会先撞上眉批/目录那种旁注段），
     也不许只留一档：三命通会那类正文只写「甲辰乙巳，覆灯火」的段落，8 个字永远比不上，
     只留 8 字就等于**这本书整本定不了位**。 */
  const tries = [8, 4];
  for (let t = 0; t < tries.length; t++) {
    const want = full.slice(0, tries[t]);
    if (want.length < 4) continue;          // 不足一柱（空串 / 男 / 2）不当锚点
    const i = list.findIndex(function (b) { return b && han(b.text).indexOf(want) >= 0; });
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * ★★★ **书签落在第几块**（唯一一处算「这一趟该滚到哪」）。
 *
 * 顺序**不可颠倒**：
 *   ① `offset`（服务端量好的、这一版的事实，最硬）；
 *   ② 文字（书重存过 ⇒ 偏移错位时的退路）；
 *   ③ 都没有 ⇒ -1（调用方不滚，别猜）。
 * ⚠ 反过来（先文字再 offset）会让一次正确的请求白跑：文字可能撞到眉批/目录那种旁注块。
 *
 * @param {Array} blocks 章里的块
 * @param {number|null|undefined} offset 书签的章内字符偏移
 * @param {string} [text] 书签文字
 * @returns {number} 块下标；-1 = 这一章里定不出来
 */
function bookmarkBlock(blocks, offset, text) {
  const byOffset = locateInChapter(blocks, offset);
  if (byOffset >= 0) return byOffset;
  return matchBlock(blocks, text);
}

/* ------------------------------------------------------------ 高亮哪一段字（2026-10-19 照 demo 补） */

/**
 * 块内要高亮的那一段字 → `[start, end)`（相对**块文本**的下标）。
 *
 * ============ 这是 demo `jumpTo` 里 `Range` 的 RN 对应物 ============
 * demo 用 DOM 的 `Range.setStart(n, off)` + `surroundContents(mark)` 把偏移那个字
 * 一直到段尾包起来；RN 没有 Range，等价物是把块文本切成三段
 * （前 / 高亮 / 后）用三个嵌套 `<Text>` 画 —— 所以必须先算出这个区间。
 *
 * ============ 口径 ============
 * ① `local` 是**块内**偏移（= 章内偏移 − 块起始偏移，由调用方减，见 Reader）；
 * ② 有书签文字（`bmText`）且它**正好从 local 起**出现在块里 ⇒ 就高亮它自己
 *    （真实数据里书签圈住的就是那四柱，长段落里只亮四柱才对得上用户点的东西）；
 * ③ 否则高亮到**块尾**（照 demo：`setEnd(n, nodeValue.length)`）。
 *
 * ⚠⚠ `start` 必须夹在 `[0, len]` 里、`end >= start`：`local` 越界时（书重存过）
 *   宁可少亮一段，也不要算出负数区间把 `<Text>` 搞崩。
 * ⚠ 返回 `null` = 这一块没有可亮的东西（空块 / 全空），调用方不画高亮。
 *
 * @param {string} blockText 块文本
 * @param {number} local     块内字符偏移
 * @param {string} [bmText]  书签圈住的原文字（可空）
 * @returns {{start:number, end:number}|null}
 */
function highlightRange(blockText, local, bmText) {
  const s = String(blockText == null ? '' : blockText);
  if (!s) return null;
  const len = s.length;
  /* ② 有书签文字且正好从 local 起 ⇒ 亮它自己 */
  const t = String(bmText == null ? '' : bmText);
  if (t && typeof local === 'number' && local >= 0 && local + t.length <= len) {
    if (s.slice(local, local + t.length) === t) {
      return { start: local, end: local + t.length };
    }
  }
  /* ③ 退到块尾（demo 的口径）*/
  const start = typeof local === 'number' && local >= 0 ? Math.min(local, len) : len;
  if (start >= len) return null;
  return { start: start, end: len };
}

/* ------------------------------------------------------------ 列表行 */

/**
 * 章内容 → **列表行**（一行一块，顺序即渲染顺序）。
 *
 * ⚠⚠ 行上的 `key` 用 **`'B' + 块下标`**：块下标在本章内唯一且稳定 ⇒ 同一章内不会撞 key
 *   （RN 对重复 key 直接警告 + 渲染错乱）。换章时整份换数据、列表重挂，前缀不用带章号。
 * ⚠ 行上带 `type`（`h1|h2|h3|p|source`），渲染层按它分样式 ——
 *   **不在这里**把 type 翻成「标题层级 / 段落样式」那种语义，一份数据和一份映射别混。
 * ⚠ `text` 可能为空串（docx 里的空段）：**照样成行** —— 它是排版里的空行，
 *   丢掉会让段间距消失，而且会让行下标与块下标对不上（定位要多绕一层）。
 *
 * @param {Array<{idx,type,text}>} blocks 服务端给的块
 * @returns {Array<{key:string, kind:'block', bi:number, type:string, text:string}>}
 */
function buildRows(blocks) {
  const rows = [];
  const list = Array.isArray(blocks) ? blocks : [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b) continue;
    rows.push({
      key: 'B' + i,
      kind: 'block',
      /** 块下标（**不是**服务端的 `b.idx`，是**数组下标** —— 两者在今天一致，
       *  但定位、`locateInChapter` 全按数组下标算，混用迟早错位） */
      bi: i,
      type: typeof b.type === 'string' ? b.type : 'p',
      text: typeof b.text === 'string' ? b.text : ''
    });
  }
  return rows;
}

/* ------------------------------------------------------------ 按实测行高定位（2026-10-17 定案，照旧） */

/**
 * ★★★ **一行的位置只认「实测高度」**：第 `index` 行的 y = 前面所有行 `heights[key]` 之和。
 *
 * ============ 为什么（2026-10-16/17 两次踩坑之后定下来的）============
 * 虚拟列表在没有 `getItemLayout` 时，`scrollToIndex(index)` 算出来的是
 * `averageCellLength × index` —— **估算**。实测那一章 184 段、目标在第 122 行，
 * 估算位置能差一两屏；而且 `getHighestMeasuredCellIndex()` 是**跨数据累积**的，
 * 换一章也不归零 ⇒ 连 `onScrollToIndexFailed` 都不触发、没有第二次机会。
 * ★ 反过来，官方那道题的正确答案早就写在那里：**`getItemLayout`** ——
 * 它能给出「第 k 行的精确 offset」，`scrollToIndex` 于是不再需要量、也不会偏。
 * 我们给不出解析式（中文段落折行、标题深浅、字号），但**「量」比「估」准**：
 * 每行 `onLayout` 报一次真实高度，拿它累加就是精确的 y。
 *
 * @param {Array} rows  列表行（model.buildRows 的产物，**顺序即渲染顺序**）
 * @param {Object} heights  行 key → 实测高度（视图形如 `{[key]: h}`，只装量到过的）
 * @param {number} index  目标行下标
 * @param {number} [vh]  视口高：给了就按参考项目那样**居中**（目标行中心 ≈ 视口中心），
 *                       不给 = 顶边对齐（老口径）
 * @returns {{ y: number, gaps: string[] }}
 *   · `y`    —— 目标行**顶边**相对内容顶部的偏移（量到过的那部分是真值）；
 *   · `gaps` —— 目标行**之前还没量到**那些行的 key（**按渲染顺序**）。
 *     ⚠⚠⚠ 它非空就说明 `y` 只是**下界**（缺的那几行还当 0 高）——
 *     所以「滚一次就算完」是错的：要先滚到最近的那个缺处，让虚拟列表把那几行渲染出来、
 *     报出高度，再算一次。调用方按这个顺序**有限轮**推进（见 Reader 的 runSeek）。
 * ⚠ 越界 / 负数一律当 0（宁可停在顶部，也不要抛异常把整页搞崩）。
 */
function rowLayoutH(rows, heights, index, vh) {
  const list = Array.isArray(rows) ? rows : [];
  const map = heights || {};
  const n = list.length;
  const want = typeof index === 'number' && index > 0 ? Math.floor(index) : 0;
  const end = Math.max(0, Math.min(n, want));
  let y = 0;
  const gaps = [];
  for (let i = 0; i < end; i++) {
    const r = list[i];
    const k = r && r.key;
    if (hasRowH(map, k)) y += map[k];
    else gaps.push(k);
  }
  /* 居中（照 docx-viewer 的 `scrollIntoView({block:'center'})`）：目标行中心落在视口中心。
     ⚠ 目标行本身可能还没量到（`map[key]` 缺失）⇒ 按 0 算，此时只把它抬到「视口正中」，
       偏一点无所谓：它一旦进视口就会报高度，下一发用真值重算。
     ⚠ 负 offset 一律夹到 0（靠近章开头时滚不过去，这很正常）。 */
  if (typeof vh === 'number' && vh > 0) {
    const r = want < n ? list[want] : null;
    const k = r && r.key;
    const h = hasRowH(map, k) ? map[k] : 0;
    const c = y + h / 2 - vh / 2;
    y = c > 0 ? c : 0;
  }
  return { y: y, gaps: gaps };
}

/**
 * ★★★ 定位的**下一发**：往目标行逼近多少（返回要滚到的绝对 offset）。
 *
 * 规则（**不用任何「平均行高」**，只用实测）：
 *   · 目标行之前还有没量到的行 ⇒ 滚到**第一个缺处**，并且**只走这一段距离**
 *     （不趁机冲到 `y`：那时的 `y` 是下界，冲过头就越过目标了）；
 *   · 全部量到了 ⇒ 直接给 `y`（精确值），这一发就是最后一发。
 * ⚠ `y` 是目标行的**顶边**：把它放到视口顶部 = 该段第一个字贴顶。
 * ⚠⚠ 返回值单调不减（缺处的 y 一定 ≤ 目标的 y）⇒ 不会来回跳；相同的值 = 这一轮白滚了
 *   （那一带的行始终没报高度）—— 调用方据此**提前停手**，不必等轮次用完。
 *
 * @param {{ y: number, gaps: string[] }} plan  rowLayoutH 的产物
 * @param {Array} rows
 * @param {Object} heights  只为给缺处求 y（与 rowLayoutH 同一口径）
 * @returns {number} 下一发的 `offset`（非负）
 */
function seekStep(plan, rows, heights) {
  const y = plan && typeof plan.y === 'number' ? plan.y : 0;
  const gaps = plan && Array.isArray(plan.gaps) ? plan.gaps : [];
  if (gaps.length === 0) return y > 0 ? y : 0;
  const first = gaps[0];
  const idx = (Array.isArray(rows) ? rows : []).findIndex(function (r) { return r && r.key === first; });
  if (idx < 0) return y > 0 ? y : 0;
  const at = rowLayoutH(rows, heights, idx);
  return at.y > 0 ? at.y : 0;
}

/**
 * 某一行的实测高度量到了没（`false` ⇒ 要等它 `onLayout` 报上来）。
 * ⚠ 单独成函数而不在视图里写 `heights[key] > 0`：这条判据**同一个意思**在
 *   「算 y」和「决定停不停」两处都要用，写两遍迟早一处忘了改（假绿的老来源）。
 */
function hasRowH(heights, key) {
  const m = heights || {};
  return typeof m[key] === 'number' && m[key] > 0;
}

/* ------------------------------------------------------------ 打开 / 定位的目标 */

/**
 * ★★★ **这本书这一趟该从哪一章、哪一块开始**（唯一一处算「定位目标」的函数）。
 *
 * 用户原话（2026-10-17）：「从查询页面选择八字进入阅读页面定位标签的位置，这个似乎有问题。
 *   **你删掉原有的跳转到标签代码，重新写吧**」—— 所以这不是一次次调参，是把「目标」重算一遍。
 *
 * 三种来路，都归这一个函数：
 *   · **点书签 / 查询页那一条**（`target.chapter` / `target.offset` 至少有一个不是 null）
 *     ⇒ 直奔那一章那一块，**不吃**本地阅读位置（他明确点了某个位置，本地记的要让位）；
 *   · **从书架点封面**（两个都是 null）⇒ 恢复本地阅读位置，没记过就从头（`chapter 0`、不定位）；
 *   · 什么都没有 ⇒ `null`（调用方直接不加载）。
 *
 * ⚠⚠⚠ 判据必须是 `== null`（不是 truthy）：`chapter = 0` 是**第一章**、
 *   `offset = 0` 是**章首那个字**，都是合法值 —— 写成 truthy 会把「书签落在第一章」
 *   误判成「从书架进来」，于是去读本地位置、跳到**上一次读到的地方**（而且不报错）。
 * ⚠ 返回值**只带** `{ book, chapter, seek }`：
 *   · `chapter` 发给服务端（`/books/chapter?book=&chapter=`）；
 *   · `seek` = 进了这一章之后要不要滚、滚到哪（`null` = 停在章首，不滚）。
 *     ⚠ 它不是请求参数 —— 块下标是**拿到这一章的 blocks 之后**才算得出来的。
 *
 * @param {Object|null} target  App 传下来的那一条
 * @param {{chapter:number,offset:number}|null} pos 本地阅读位置（`core/readPos.js` 的产物）
 * @returns {{book:string, chapter:number, seek:{offset:number, text:string}|null}|null}
 */
function openParams(target, pos) {
  const book = target && target.book;
  if (!book) return null;

  const shelf = fromShelf(target);
  if (shelf) {
    /* 从书架点封面：有记过就读回去，没有就从头（章 0、不定位）。
       ⚠ `pos.chapter = 0` 是**合法位置**，判据必须 `!= null`（`typeof` 更稳） */
    const ch = pos && typeof pos.chapter === 'number' ? pos.chapter : 0;
    const off = pos && typeof pos.offset === 'number' ? pos.offset : null;
    return {
      book: book,
      chapter: ch,
      seek: off != null ? { offset: off, text: '' } : null
    };
  }

  /* 冲着某一段来（书签 / 查询页）：章与偏移都按它给。
     ⚠ 缺章（老数据）⇒ 章 0；缺偏移 ⇒ 不定位（停在章首）——
       宁可回到章首，也不要发一个猜出来的偏移。 */
  const ch = typeof target.chapter === 'number' ? target.chapter : 0;
  const off = typeof target.offset === 'number' ? target.offset : null;
  /* ⚠⚠⚠ 高亮用的文字：**优先书签圈住的原文字**（`target.text`，Word 书签范围那几个字，
     如「甲午癸酉丙子壬辰」，没有标点），没有就用 `target.name`（四柱书签名 /
     查询页的四柱，带全角逗号）。
     ⚠ 2026-10-20 踩过又改回来：早先拿 name 当文字 + 「亮到块尾」的旧口径 ⇒ 整句被亮；
       现在 `segOf`（Reader）已经改成**只亮匹配到的那几个字、亮不到就不亮**，
       且它自带**去标点匹配**——name 带逗号也能精确亮出那几个字，
       所以 name 兜底是安全的，还顺带解决了「查询页进来没有 text ⇒ 不亮」
       （用户 2026-10-20 报的）。 */
  const text =
    typeof target.text === 'string' && target.text ? target.text
    : typeof target.name === 'string' ? target.name
    : '';
  return {
    book: book,
    chapter: ch,
    seek: off != null || text ? { offset: off != null ? off : -1, text: text } : null
  };
}

/**
 * ★★★ 这次进阅读页**是不是「从书架点封面」进来的**（= **唯一一种该记阅读位置的来路**）。
 *
 * 用户 2026-10-16 原话：
 *   「从查询页面进入到阅读页面，再退出就不要保存阅读位置了。只有从书籍进入阅读页面退出才保存阅读位置。」
 *
 * ⚠⚠⚠ 判据 = **这次有没有定位目标**，不另加参数：
 *   · 书架点封面 → `study/model.js` 的 `bookTarget` 给的 `chapter/offset` **都是 null**
 *     ⇒ 这是「随便打开一本书接着读」⇒ **记位置**，下次点封面跳回；
 *   · 点书签 / 从查询页那一条进来 → 至少有一个不是 null ⇒ 他是**冲着某一段**来的
 *     ⇒ **不记**（记了会把「我读到哪」改成「我刚查的那一条」，下一次点封面就跳错地方）。
 * ⚠⚠ 判据必须是 `== null`（覆盖 null 与 undefined）：`chapter = 0` 是**第一章**、
 *   `offset = 0` 是**章首**，都是合法值 —— 写成 truthy 会把「书签落在第一章」误判成
 *   「从书架进来」。
 * ⚠ 它同时也是**恢复位置**的判据（`Reader` 的入口分流：不是从书架来就不吃本地位置）
 *   —— 两条**必须同一句**，否则会出现「从不该记的来路恢复出别人的位置」。
 *
 * @param {Object|null|undefined} target 阅读页的 target（`{book, chapter, offset, ...}`）
 * @returns {boolean}
 */
function fromShelf(target) {
  if (!target) return false;
  return target.chapter == null && target.offset == null;
}

/** 「跳到第 `chapter` 章开头」要发的请求参数（工具栏 / 目录共用这一条，别的什么都不带） */
function chapterParams(book, chapter) {
  return { book: book, chapter: typeof chapter === 'number' ? chapter : 0 };
}

/* ------------------------------------------------------------ 块类型 → 样式层级 */

/**
 * **标题块**的缩进层级：`h1` → 0、`h2` → 1、`h3` → 2；非标题 → 0。
 *
 * ⚠ 名字里的 depth 说的就是缩进。⚠ 它以前叫 `titleDepth(level)`（拿数字 level 算，
 *   服务端那时给的是 `heading 1..8` 的层级数）；这一版块类型只有 `h1|h2|h3` 三档，
 *   封顶本来就在 2 ⇒ 函数体里再夹一道 `Math.min(..., 3)` 是防「将来多出 h4」时缩到底。
 * ⚠ 从类型算而**不是**从 `numberingLvl` 那种数字算：数字缺失 / 是 `0` 时
 *   会静默变成「顶级标题」，那种错没人看得出（标题只是缩进少了一点）。
 */
function blockDepth(type) {
  const t = String(type == null ? '' : type);
  if (t === 'h2') return 1;
  if (t === 'h3') return 2;
  return 0;
}

/** 这一块是不是标题块（`h1|h2|h3`）—— 渲染层据此换字号，别在视图里内联比字符串 */
function isHeading(type) {
  const t = String(type == null ? '' : type);
  return t === 'h1' || t === 'h2' || t === 'h3';
}

/**
 * 当前正读到**第几章** —— 目录列表里高亮 + 工具栏「上一章 / 下一章」要用。
 *
 * ⚠⚠ 这一版**不需要**再「按 seq 反查章」（`chapterAt` / `chapterRowAt` 那一族已删）：
 *   一次只加载一章，`data.chapter.idx` 就是**唯一**答案 —— 视口滚到哪、章都是这一章。
 *   ⇒ 函数只剩一个哨兵：数据没到 / 章序缺失 ⇒ `null`（调用方据此把两个按钮置灰，
 *     宁可置灰，也不要猜一个目标跳过去）。
 *
 * @param {Object|null} data `/books/chapter` 的响应（`Reader` 的 `data`）
 * @returns {number|null}
 */
function curChapter(data) {
  const c = data && data.chapter;
  if (!c || typeof c.idx !== 'number') return null;
  return c.idx;
}

/**
 * **上一个 / 下一个**能跳的章序（工具栏用）。
 *
 * ⚠⚠ 判据是**响应里服务端给的 `prev` / `next`**，不是自己拿 `idx ± 1` 算：
 *   · 服务端按 `total` 判过边界（`idx > 0` / `idx + 1 < total`），自己再算一遍是**第二份判据**，
 *     只要有一处口径不同（比如某天改了「章序不连续」），两边就会不一致；
 *   · 而且 `null` 的语义是「到头了」—— 自己算出来的 `-1` / `total` 还得再翻译一次。
 * ⚠ 没有 `prev`/`next` 字段（老服务端 / 形状兜底）⇒ 当**没有**（置灰）：
 *   宁可点不动，也不要跳到一个 404 的章序上去。
 */
function prevChapter(data) {
  const n = data && data.prev;
  return typeof n === 'number' ? n : null;
}

function nextChapter(data) {
  const n = data && data.next;
  return typeof n === 'number' ? n : null;
}

module.exports = {
  LOADING_TEXT: LOADING_TEXT,
  posText: posText,
  FAIL_TEXT: FAIL_TEXT,
  RETRY_TEXT: RETRY_TEXT,
  TOC_TEXT: TOC_TEXT,
  PREV_CH_TEXT: PREV_CH_TEXT,
  NEXT_CH_TEXT: NEXT_CH_TEXT,
  TOC_EMPTY_TEXT: TOC_EMPTY_TEXT,
  TOC_CLOSE_TEXT: TOC_CLOSE_TEXT,
  UNTITLED_TEXT: UNTITLED_TEXT,
  NOMATCH_BM_TEXT: NOMATCH_BM_TEXT,
  NOMATCH_CH_TEXT: NOMATCH_CH_TEXT,
  BM_EMPTY_TEXT: BM_EMPTY_TEXT,
  SEARCH_PLACEHOLDER: SEARCH_PLACEHOLDER,
  BM_TEXT: BM_TEXT,
  bookTitle: bookTitle,
  /* 定位换算（这一版新增） */
  blockStarts: blockStarts,
  locateInChapter: locateInChapter,
  matchBlock: matchBlock,
  bookmarkBlock: bookmarkBlock,
  highlightRange: highlightRange,
  buildRows: buildRows,
  /* 按实测行高定位（照旧） */
  rowLayoutH: rowLayoutH,
  seekStep: seekStep,
  hasRowH: hasRowH,
  /* 入口 / 分流 */
  openParams: openParams,
  fromShelf: fromShelf,
  chapterParams: chapterParams,
  /* 块类型 / 章 */
  blockDepth: blockDepth,
  isHeading: isHeading,
  curChapter: curChapter,
  prevChapter: prevChapter,
  nextChapter: nextChapter
};
