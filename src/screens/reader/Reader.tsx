/**
 * 阅读页 —— 2026-10-19 照 demo `docx-book/demo/index.html` **清空重做**
 *
 * ============ demo 那一页是什么 ============
 * 一个「阅读器」：左边一条侧栏（**目录 / 书签** 两个页签 + 一个搜索框），
 * 右边是正文，顶上一条常驻头部（**上一章 / 章名 + 位置 / 下一章**）。
 *  · 侧栏点目录某一行 ⇒ 打开那一章；
 *  · 侧栏点书签某一条 ⇒ 打开它所在的那一章，**按章内字符偏移**滚过去并高亮；
 *  · 搜索框同时筛目录（按标题）与书签（按名字）；
 *  · `#cN` 深链 = 打开第 N 章。
 * 数据只走一个接口层（demo 的 `data/api.js`）—— 本项目的同一层是 `core/books.js`。
 *
 * | demo | 本项目 |
 * |---|---|
 * | `DataApi.listBooks()` | `core/books.js` 的 `shelf()`（在书架那一屏，不在本页） |
 * | `DataApi.getBook(key)` → toc | `books.toc(bookKey)` |
 * | `DataApi.getChapter(key, i)` | `books.chapter({book, chapter})` |
 * | `DataApi.getBookmarks(key)` | `books.fetchPage(0, BM_PAGE, {book})` |
 * | `location.hash = '#c' + i` | `core/readPos.js`（本地阅读位置，见下） |
 *
 * ============ 三处**刻意偏离** demo（都有理由，别"修正"回去）============
 * ① **侧栏是左侧抽屉，不是常驻**：demo 是桌面版（270px 侧栏 + 宽正文）。
 *    750rpx 的手机上常驻侧栏会把正文压到 480rpx（一行 12 个字），没法读。
 *    ⇒ 头部留一枚「目录」按钮，点开是左抽屉 + 背面遮罩（点遮罩即关）。
 * ② **高亮不自动消失**：demo 是 1.8s 后把 `<mark>` 还原（`mark.flash` + setTimeout）。
 *    用户 2026-10-11 明确要求「**让这个高亮一直存在啊**」—— 那之后本项目所有
 *    「自动播完就没」的动效一律先问再做。⇒ 常亮，纯 state，**没有任何定时器**。
 * ③ **二级标题（h2）在正文里保留**：demo 把 `h1`/`h2` 都跳过（它自己画一个 h1）。
 *    我们的书里「第一篇 / 第二篇」是有效信息，跳过等于丢内容。
 *    ⇒ h1 由头部那一行承担（不重复画），h2/h3 照常渲染。
 *
 * ============ 一次一章（与 demo 同一条，2026-10-16 用户拍板）============
 * 「阅读页面我不要懒加载了，直接一个章节一个章节展示就行了，一次展示一个章节的全部内容」
 * ⇒ 一章一个请求给全（`/books/chapter` 一次给 blocks + 本章书签 + prev/next），
 *   滑到底就是**本章的底**，下面不摆空白、不续拉；换内容只有三种来路：
 *   进书 / 上一章下一章 / 侧栏点一行（都走 `load` 整份换）。
 * ⚠ 老那套「下侧空白自动加载 / 到顶弹框 / MVCP / 像素补偿」**别搬回来**
 *   （代码里对应位置都留了墓碑注释，tests 里有反向断言守着）。
 *
 * ============ 定位：RN 没有 Range/TreeWalker ============
 * demo 用 DOM 的 `Range` + `TreeWalker` 在**已经渲染好的文本**里找那个偏移
 * （约 15 行，不需要预计算块偏移）。RN 没有这套 API，等价物是：
 *   章内偏移 →（`model.locateInChapter`）块下标 →（**实测行高**累加）y → `scrollToOffset`
 * 即「**量**而不是**估**」（`model.rowLayoutH` / `model.seekStep`，2026-10-17 定案）：
 * 虚拟列表没量过的行一个像素都不许算进去，所以定位是「滚到缺处 → 量到 → 再滚」有限轮推进。
 * ⚠⛔ `scrollToIndex` / `initialScrollIndex` 禁回（估算 + 跨章不归零，见 model 里那段）。
 *
 * ============ 阅读位置：关书就记，开书就回（core/readPos.js）============
 * 用户 2026-10-12：「能不能记住阅读位置？存在手机本地？」⇒ 恢复方式选了「直接跳回」。
 *   · ⚠⚠⚠ 2026-10-19 换代：存的从「一个全书 seq」变成 **`{chapter, offset}`**
 *     （章序 + 章内字符偏移）。`chapter = 0` / `offset = 0` 都是**合法值** ——
 *     读写两侧都按「是不是 null」判，truthy 会把「读到第一章第一个字」吃成「没读过」。
 *   · **记**：视口最上面那一**块**的首偏移实时进 `readPosRef`，**退场**一次写入本地；
 *   · **回**：点**封面**进书（`chapter`/`offset` 都 null）时同步读本地，有就跳回去
 *     （不是书签 ⇒ 不高亮）；**点书签进来不吃它**（明确点了位置，本地那条要让位）；
 *   · ⚠ 只有「从书架点封面」那一趟才记（用户 2026-10-16 原话，见下面入口分流）。
 *   · ⚠⚠⚠ 书的内容**不许存本地**（用户：「书的数据不要往本地存，因为我会更新书籍的内容的」）。
 *
 * ============ 状态与并发 ============
 *   · loadingRef（ref 不 state）：连点时挡住重复请求（setState 异步）；
 *   · aliveRef：推入层关掉时在飞的请求回来，不许再碰已卸载的页；
 *   · lastParamsRef / lastJumpRef / lastHlRef：失败重试用**上一次的参数与意图**重发。
 *
 * ⚠⚠ 段落列表必须 FlatList（一章可上百块 —— 实测最多 **1704** 块，ScrollView+map
 *   会把每块都渲染成真实节点，与学堂页 3000+ 书签同一个坑）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS } from '../../theme/tokens';
import { SegTabs } from '../../components/SegTabs';
import type { SegTabItem } from '../../components/SegTabs';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const books: any = require('../../core/books.js');
/* 阅读位置（手机本地，platform/storage）：入口恢复 + 退场保存，见 readPos.js 文件头 */
const readPos: any = require('../../core/readPos.js');

/**
 * 阅读页的定位目标（App 传来的 Study 条目 / 书架点封面）。
 *
 * ⚠⚠⚠ 2026-10-19 换协议：字段从「`sec` / `para`（全书段序）」换成
 *   「`chapter`（章序 0 起）/ `offset`（章内字符偏移）」，`book` 也从**文件名**
 *   换成了 **`book_key`**。三处全是"名字像、语义不同"的改动：
 *   · `chapter` 现在是**数字**（以前 `sec` 是数字、但 `chapter` 是 `string[]`）——
 *     照旧按数组用会静默得到「没有章」；
 *   · `book` 现在是内容哈希 —— 拿文件名去 `/books/chapter?book=` 只会 404。
 *
 * ⚠ `chapter` / `offset` 都是 `number | null`，**null 与 0 语义不同**：
 *   · 两个都 null ⇒ 「从书架点封面」⇒ 恢复本地阅读位置；
 *   · `chapter = 0` ⇒ 第一章（合法）⇒ 写成 null 会让「点第 0 章的书签」变成「从书架进来」。
 *   （判据集中在 `model.fromShelf` / `model.openParams`，别在视图里另写一份。）
 */
type Target = {
  name: string;
  chapter: number | null;
  offset: number | null;
  book: string;
  /**
   * 书名（App 导航栏标题用）。
   * ⚠⚠⚠ 必须有：`book` 是 `book_key`（内容哈希），拿它当书名会把哈希显示出来。
   *   由 `study/model.js` 的 `bookTarget` / `bookmarkTarget` 填；缺省时退回响应里的书名。
   */
  title?: string;
};
type Phase = 'loading' | 'ok' | 'fail';
/** 侧栏两个页签（照 demo 的 aside.tabs：目录 / 书签） */
type SideTab = 'ch' | 'bm';

/**
 * 定位的**兜底收摊**时限（ms）。
 * ⚠⚠ 「一切自动的等待都要有上限」：判据万一永远不成立（某行就是不报高度），
 *   没有上限就是**永远卡在加载框里**（框是禁操作的）—— 用户除了杀进程没有任何办法。
 * ⚠ 700ms 是「一次一章」下实测够用的量级：一章几百块、目标行通常在首屏之后几屏内。
 */
const SEEK_MAX_MS = 2500;   // 整章全量挂载 ⇒ 行高一阵全报完，通常一两轮就到位；上限只是兜底
/**
 * 定位的**轮次上限**（发）。
 * ⚠ 只兜「某行永远量不出来」这种病态：到顶就滚到当时最好的估计再收摊 ——
 *   宁可差一点，也不要停在半路（半路 = 用户看到别人的段落）。
 */
const SEEK_ROUNDS_MAX = 16;

/**
 * 侧栏「书签」那一栏一次取多少条。
 * ⚠ 服务端 `limit` 没有上限（`i >= 1` 就要多少给多少，见 lib/paging.ts），
 *   而真实数据里单本书最多 **736** 条（三命通会，2026-10-19 实测）⇒ 1000 一条拿全，
 *   搜索才能像 demo 那样在**全量**里筛（只筛「已加载的那一页」是半个搜索，会漏）。
 * ⚠ 万一将来某本书超过这个数：`bmTotal > bms.length` 时侧栏底部会如实说「仅加载前 N 条」。
 */
const BM_PAGE = 1000;

/* ⚠⚠⚠ **墓碑（2026-10-17）**：「下方几屏空白」整族常量已删除（PAD_SCREENS_INIT / PAD_SCREENS_MAX）。
   用户 2026-10-17：「阅读页面向下滑动就不要做懒加载了」⇒ 一次一章、一章给全，
   滑到底就是本章的底。**别再往回加**：空白行会让「本章到底」和「还在加载」看起来一样，
   还会把虚拟列表的平均行高抬歪（定位估算的帮凶）。
   ⚠ 上侧那对（PAD_UP_SCREENS_*）更早删；「到顶弹加载框」也删了 —— 向上回看走「上一章」。 */

/* ⚠⚠⚠ **墓碑（2026-10-14 十六改·8）**：「上侧无限空白 + 到顶弹框」整族删除。
   用户原话：「也不做空白了。往上翻到顶后，直接一个弹出加载框…」—— 那一版后来也删了：
   一次一章之后，向上回看就是「上一章」这一颗按钮，没有"接一片"这件事。 */

/* ⚠⚠ **墓碑（2026-10-17）**：`PREV_TIMEOUT_MS = 8000`（「到顶加载」那发的安全超时）已删。 */

/* ⚠⚠⚠ **墓碑（2026-10-19，本页重做）**：「点屏幕呼出工具栏」整族删除：
   `barOn` / `barOnRef` / `onTapStart` / `onTapMove` / `onTapEnd` / `TAP_SLOP_RPX` /
   `tapRef` / 底部那枚「目录」按钮 / `s.barTop` / `s.barBottom` / `s.barBtn` /
   全屏目录面板（`s.tocHost` / `tocHead` / `tocRow` 一族）。
   原因：demo 的头部是**常驻**的（上一章 / 章名+位置 / 下一章），侧栏是常驻抽屉 ——
   没有什么要"呼出"的，那一套没有触发点了。
   ⚠ 别按 10-14 那次的要求把它加回来：那一版的形态已经被这次重做取代
     （见 model.js 顶部那段「形态改向，两次都记在这里」）。 */

export default function Reader({
  entry,
  target,
  onBack: _onBack,
}: {
  /** 打开计数：每次进来自 +1 ⇒ effect 必然重跑一遍 load（同结果页的 entry 语义） */
  entry: number;
  /** 要读的书签条目（⚠ book=book_key 必带；chapter/offset 可能是 null） */
  target: Target;
  /**
   * 导航栏返回（App 接管 = pop 这一层）。
   * ⚠⚠ **本页不调它**：返回由 App 那条 NavBar 负责（用户 2026-10-14 明确选了「保留它」）——
   *   阅读页顶部再放一个返回，点上错一次就退出去。留着这个 prop 是 App 的接线契约
   *   （`<Reader entry target onBack>`），不是漏接。
   */
  onBack: () => void;
}) {
  const rpx = useRpx();
  /* ⚠ 底部安全区（home indicator / 安卓手势条那一带）：系统物理值，**不缩放**。
     Expo 57 的安卓默认 edge-to-edge ⇒ `bottom: 0` 的浮层会**压进系统导航栏底下**
     （看着就是「太靠下」）。底栏必须自己补这段，和 TabBar.tsx 一个写法。 */
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>('loading');
  const [err, setErr] = useState('');
  const [data, setData] = useState<any>(null);
  /**
   * ★★★ **这次定位的目标块下标**（`null` = 不定位 ⇒ 列表停在顶部）。
   *
   * ⚠⚠⚠ 2026-10-19 换协议：这里从 `seekSeq`（全书段落 seq）改成了 **`seekRow`（块下标）**。
   *   为什么要改名而不是留着旧名字：两者都是"数字"，编译器拦不住拿错的
   *   —— 老字段叫 `seq`、新的是**数组下标**，混用会滚到一个"看起来合理"的错位置。
   *
   * 来路：`model.locateInChapter(blocks, offset)` ⇒ 命中块下标；
   *   命中不了就 `model.matchBlock(blocks, 书签名)`；都不行 ⇒ null（停在章首）。
   */
  const [seekRow, setSeekRow] = useState<number | null>(null);
  /**
   * ★★★ 列表的**重挂计数器**：每 `load()` 成功一次就 +1（`key={'L' + listId}`）。
   *
   * ⚠⚠⚠ 为什么必须重挂（而不只是在 props 里改 `initialScrollIndex`）：
   *   `initialScrollIndex` 只在 VirtualizedList **挂载时**决定首批渲染窗口
   *   （`_initialRenderRegion`），之后 data 变了它**不会**重新起窗口 ——
   *   不重挂就等于什么都没发生。
   * ⚠ 重挂的代价：滚动位置归零、列表实例重建。在「一次一章」里这**正是要的**
   *   （每一章都是一份全新内容，本来就该从头/从定位行开始），而且这一拍是盖着
   *   加载框的（见 `loadingBox`），用户看不到中间态。
   */
  const [listId, setListId] = useState(0);
  /**
   * ★ 定位**落位了没**（`false` ⇒ 加载框盖着不放）。
   *
   * ⚠⚠ 为什么需要它：重挂之后原生侧先按 offset 0 画一帧，再在
   *   `onContentSizeChange` 里滚到目标行 ⇒ 中间那 1~2 帧会看到
   *   **本章开头**。用户对「闪」很敏感（这半个月修的一半都是这类），
   *   所以让加载框一直盖到「目标行真的出现在视口里」为止。
   * ⚠ 判据在 `pushSeek` 第 ③ 关；⚠ **有上限** `SEEK_MAX_MS`
   *   —— 到点无条件落位放框（「一切自动的等待都要有上限」）。
   */
  const [settled, setSettled] = useState(true);
  /**
   * 视口高（外层容器 `onLayout` 测到的那一屏）。
   * ⚠ 它是 **state** 而不是只放 ref：定位的「居中」口径要它（见 `pushSeek`）。
   */
  const [vh, setVh] = useState(0);
  /**
   * ⚠⚠⚠ **墓碑（2026-10-17）**：这里原来有 `padDown`（下方额外留几屏空白…）——
   *   它是「往下永远滑不到底、滑进空白就等于在等下一片」那套的底座，整块删除。
   */
  /**
   * 段内高亮：书签圈住的那**一段字** ⇒ `{bi, start, end}`（2026-10-20 定案：
   * 用户原话「有标记的八字高亮就行了」⇒ **只亮段内那几个字**，行底（`s.hlPara`）那层已删）。
   * ⚠ 开了就**不再撤**（用户 2026-10-11「一直存在」）—— 纯 state，无动画无定时器。
   * ⚠ 高亮样式只许底色/圆角（不许 padding/margin/字号）⇒ 不影响行高、定位照旧准。
   * ⚠⚠ 2026-10-21 起是**数组**（最多两段）：巾箱补编那类书，书签文字是竖排拆块拼法
   *   （`"癸 甲 癸 甲\n亥 寅 酉 寅"`——第一行四个天干、第二行四个地支），
   *   正文对应**两个相邻块**，一段 `hlSeg` 装不下 ⇒ 两块各亮一行。
   *   绝大多数书签仍然只有一段（数组长度 1），渲染按 Map 取，零成本。
   */
  const [hlSegs, setHlSegs] = useState<Array<{ bi: number; start: number; end: number }>>([]);
  /** renderItem 按 `bi` 取高亮段：Map 一次建好，别在每行渲染里扫数组 */
  const hlMap = useMemo(() => {
    const m = new Map<number, { start: number; end: number }>();
    for (const seg of hlSegs) m.set(seg.bi, { start: seg.start, end: seg.end });
    return m;
  }, [hlSegs]);

  /* ---------------- ★★★ 侧栏抽屉（2026-10-19 照 demo 重做） ---------------- */

  /** 抽屉开着没（照 demo 的 aside；手机上它是浮层，见文件头偏离①） */
  const [sideOn, setSideOn] = useState(false);
  /** 侧栏当前页签：目录 / 书签 */
  const [sideTab, setSideTab] = useState<SideTab>('ch');
  /** 侧栏搜索框（同时筛目录标题与书签名，照 demo 的 `#search`） */
  const [q, setQ] = useState('');
  /** 目录数据（`GET /books/toc` 的 chapters：`{idx, title, level, charCount}`） */
  const [tocList, setTocList] = useState<any[]>([]);
  const [tocPhase, setTocPhase] = useState<'loading' | 'ok' | 'fail'>('loading');
  const [tocErr, setTocErr] = useState('');
  /**
   * 这本书的**全部书签**（侧栏「书签」那一栏；`GET /books/bookmarks?book=`）。
   * ⚠ 与目录一样是「一本书取一次」，但**懒**：只有用户切到「书签」页签才取 ——
   *   只读书不翻书签的人（大多数）不该为这一栏多发一个请求。
   *   （demo 是一启动就取，因为它的数据本来就是一个 bundle 文件，没有请求成本。）
   */
  const [bms, setBms] = useState<any[]>([]);
  const [bmPhase, setBmPhase] = useState<'idle' | 'loading' | 'ok' | 'fail'>('idle');
  const [bmErr, setBmErr] = useState('');
  const [bmTotal, setBmTotal] = useState(0);

  /**
   * 当前章（头部那行章名 / 侧栏目录里高亮哪一行）。
   *
   * ⚠⚠⚠ 2026-10-19：不再「跟着视口变」了 —— 一次只加载一章，**这次加载的是哪章就是哪章**。
   *   所以它由 `load` 成功时直接写 `data.chapter`，不依赖任何滚动回调。
   * ⚠ 取不到时（还没加载完 / 章序缺失）是 null，此时头部退回显示书名。
   */
  const [curCh, setCurCh] = useState<{ idx: number | null; title: string } | null>(null);
  /**
   * 书名（头部退回显示用；App 外面那条 NavBar 也读 target.title）。
   *
   * ⚠⚠⚠ 2026-10-19 换协议后**不能**再从 `target.book` 推：那现在是 `book_key`
   *   （docx 内容 sha256 前 16 位），`bookTitle('3f9a…')` 会把哈希当书名显示出来。
   *   书名由两个响应给（都能拿到，谁先到用谁）：
   *   · `/books/chapter` 的 `bookTitle`（正文加载成功时）
   *   · `/books/toc` 的 `book.title`（目录加载成功时）
   */
  const [bookName, setBookName] = useState('');
  /* ⚠ target.title 是「点进来那一刻」的书名（书架/书签列表上都带着），先顶上，
     响应回来了再用更准的那份覆盖（见 load / loadToc 里对 bookName 的写入）。 */
  useEffect(() => {
    if (target && typeof target.title === 'string' && target.title) setBookName(target.title);
  }, [target]);

  /* ---------------- 代次 / 在飞 ---------------- */

  const aliveRef = useRef(true);
  const listRef = useRef<any>(null);
  /** 侧栏目录那个列表（「打开抽屉就滚到当前那一章」要用它） */
  const tocRef = useRef<any>(null);
  /* ⚠ 墓碑（2026-10-17）：目录的 `scrollToIndex` 失败重试计数已删除 —— 目录改走实测行高（见 tocHit）。 */
  /**
   * `seekRow` / `settled` 的 **ref 镜像**。
   * ⚠⚠ 必须有：`onScroll` 是 `useCallback([])` / `onViewRef` 是 `useRef` 建的、
   *   **一辈子只建一次**（读 state 恒是首帧那份），而「到位了没」就判在它们里面。
   * ⚠⚠⚠ 2026-10-19 换协议：`seekSeq`（全书段落 seq）→ `seekRow`（**块下标**）。
   *   两个都是数字，编译器拦不住拿错的 —— 老字段是「段在全书里的序号」，
   *   新的是「块在本章数组里的下标」，混用会滚到一个"看起来合理"的错位置。
   */
  const seekRowRef = useRef<number | null>(null);
  const settledRef = useRef(true);
  /** 定位的**兜底收摊**定时器（`SEEK_MAX_MS`，见 `settled` 的注释）。换一章要重排、退场要撤。 */
  const seekTimerRef = useRef<any>(null);
  /** 失败重试要重发**上一次**的参数与意图（从哪失败回哪，不从头再来） */
  const lastParamsRef = useRef<any>(null);
  const lastJumpRef = useRef(true);
  const lastHlRef = useRef(true);
  /** 「正在路子上」的忙锁：连点上一章下一章只认最后一发 */
  const loadingRef = useRef(false);
  /** 请求代次：每次 `load` +1，旧请求回来时对不上就整个丢掉 */
  const genRef = useRef(0);
  /** 当前滚动位置（`onScroll` 记，`pushSeek` 判「到位了没」用它） */
  const offsetRef = useRef(0);
  /** 内容总高（`onContentSizeChange` 记；⚠ 虚拟列表里它只算渲染窗口那一段，别拿来算位移） */
  const contentHRef = useRef(0);
  /** `vh` 的 ref 镜像（`onScroll` / `runSeek` 都是只建一次的回调，读 state 拿到的是旧值） */
  const vhRef = useRef(0);
  useEffect(() => { vhRef.current = vh; }, [vh]);

  /**
   * 高亮行里的那**一段字** ⇒ `{bi, start, end}`。
   *
   * ⚠⚠⚠ 2026-10-20 定案：**只亮书签圈住的那几个字**（= Word 里插入书签的范围）。
   *   不再退到「亮到块尾」—— 那是 demo `Range.setEnd(n, 段尾)` 的口径，
   *   同段有两条书签时会把另一条也罩进去（用户报的「整句被亮」就是这个）。
   *
   * 找那几个字，两步：
   *   ① `seek.text`（书签圈住的原文字）在块里 `indexOf` —— 精确命中就亮它；
   *   ② 没命中 ⇒ **去标点再找**（书签名带全角逗号 / 原文带顿号这类差异全被这一步吃掉），
   *      映射回原字符位置再亮 —— 因为文字连续（只是夹了标点），映射是一一对应的。
   *   两步都落空 ⇒ **null**（不亮），绝不拿段尾凑数。
   */
  const segOf = useCallback((blocks: any, bi: number, seek: { offset: number; text: string }) => {
    const b = blocks && blocks[bi];
    if (!b) return null;
    const s = String(b.text == null ? '' : b.text);
    const t = String(seek && seek.text ? seek.text : '');
    if (!t) return null;
    const at = s.indexOf(t);
    if (at >= 0) return { bi: bi, start: at, end: at + t.length };
    /* ② 去标点匹配：把块文本与书签文字都剥掉标点/空白，各记一张「剥后下标 → 原下标」表，
        在剥后的串里 indexOf，再把 [start, end) 映射回原串。 */
    const PUNCT = /[、，。；：！？「」『』（）""''\s]/;
    const bs: string[] = [], bmap: number[] = [], ts: string[] = [], tmap: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (PUNCT.test(s[i])) continue;
      bs.push(s[i]); bmap.push(i);
    }
    for (let i = 0; i < t.length; i++) {
      if (PUNCT.test(t[i])) continue;
      ts.push(t[i]); tmap.push(i);
    }
    if (ts.length === 0) return null;
    const at2 = bs.join('').indexOf(ts.join(''));
    if (at2 < 0) return null;
    const start = bmap[at2];
    const end = bmap[Math.min(at2 + ts.length - 1, bmap.length - 1)] + 1;
    return { bi: bi, start: start, end: end };
  }, []);

  /* ---------------- 视口跟踪（只服务阅读位置） ---------------- */
  /** ⚠ 必须放 ref：RN 只在首次挂载读它 */
  const viewConfigRef = useRef({ itemVisiblePercentThreshold: 10 });
  /**
   * 当前读到的位置 = **`{chapter, offset}`**（退场时由 readPos 存本地）。
   * ⚠ ref 而不是 state：它一秒要被视口回调改几十次，进 state 就是整页重渲染。
   * ⚠ `null` = 还没读到过任何一行 ⇒ 退场时**不写**（老位置原样保留，
   *   绝不拿 null 把已存的位置冲掉）。
   */
  const readPosRef = useRef<{ chapter: number; offset: number } | null>(null);
  /** `data` 的 ref 镜像：`onViewRef` 是 `useRef` 建的，读 state 永远是首帧那份（null） */
  const dataNowRef = useRef<any>(null);
  /** 行数组的 ref 镜像（同理，`onScroll` / `pushSeek` 里要读"现在的行"） */
  const rowsNowRef = useRef<any[]>([]);
  /** 目录列表的 ref 镜像（`onTocRowLayout` 要读） */
  const tocListRef = useRef<any[]>([]);

  const onViewRef = useRef((info: any) => {
    const items = info && info.viewableItems;
    if (!Array.isArray(items) || items.length === 0) return;
    const it = items.find((v: any) => v && v.isViewable) || items[0];
    if (!it || typeof it.index !== 'number') return;
    const row = it.item;
    if (!row || row.kind !== 'block' || typeof row.bi !== 'number') return;
    const ch = model.curChapter(dataNowRef.current);
    /* ⚠ 章序 0 是合法值 ⇒ 判 `typeof`，别 truthy（写成 `if (ch)` 时第 0 章永远不记位置） */
    if (typeof ch !== 'number') return;
    const starts = model.blockStarts(dataNowRef.current && dataNowRef.current.blocks);
    readPosRef.current = { chapter: ch, offset: typeof starts[row.bi] === 'number' ? starts[row.bi] : 0 };
  });

  /**
   * 列表的**行**（一行一块：标题块 / 正文块 / 源码块…）。
   *
   * ⚠⚠ 章标题不再是「插进来的行」，它本身就是第一块（`type: 'h1'`）——
   *   老那套 `buildRows(paras, secMap)` 里「按 firstPara 判要不要插标题行」整块作废。
   * ⚠ 行全部由 `model.buildRows` 造（**行**，不是 ListHeader/FooterComponent）。
   */
  const layout = useMemo(() => {
    return {
      rows: model.buildRows(data && data.blocks),
    };
  }, [data]);

  /* ⚠ `onViewRef` / `onScroll` 都是在 `useRef` 那一刻建的，闭包里的 `layout` 永远是首帧那份
     ⇒ 要读「现在的行数组」只能走 ref 镜像。 */
  useEffect(() => { rowsNowRef.current = layout.rows; }, [layout.rows]);
  /* ⚠⚠ 目录同理要镜像一份（`onTocRowLayout` 是 `useCallback`，读 state 恒是首帧那份） */
  useEffect(() => { tocListRef.current = tocList; }, [tocList]);

  /**
   * 拉内容。
   * @param params 发给 /books/chapter 的参数（`model.openParams` / `model.chapterParams` 的产物）
   * @param jump true = 要定位（滚到服务端指出的那一段）；false = 回顶部
   * @param hl   true = 高亮书签那一段。⚠ 与 jump **分开**：只定位不高亮的场景还在用
   */
  const RENDER_FIRST = 12;
  const [rendered, setRendered] = useState(false);
  const renderedRef = useRef(false);
  /** 换内容 ⇒ 渲染这一关重新来过（在 `load` 里调，见那边） */
  const armRender = useCallback(() => {
    renderedRef.current = false;
    setRendered(false);
  }, []);
  /* ⚠ `load` 定义在它**之后**、且 `load` 的 deps 里不放它（放了每次重建都会换身份）⇒ 走 ref */
  const armRenderRef = useRef<() => void>(() => {});
  useEffect(() => { armRenderRef.current = armRender; }, [armRender]);
  /* ⚠⚠⚠ **墓碑（2026-10-19）**：`hopRef`（「目标段不在本章 ⇒ 换章重取，只许一次」）已删。
     它存在的前提是「书签只记了一个全书段号 seq，章要反查」—— 换协议后
     `chapter` 是**请求时就明确指定的**，这一章里没有就是没有，再猜一章只会跳错地方。
     ⇒ 定位退路只剩一条：`matchBlock`（按书签文字在本章里找）。
     ⚠ 别把它加回来：那等于「服务端说第 3 章，我们偏去第 7 章找」—— 用户看到的是「点了一条
       书签，结果翻到了另一章」，而且一处都不报错。 */

  const load = useCallback((params: any, jump: boolean, hl: boolean) => {
    if (loadingRef.current) return;     // 已经在路上了（连点挡这里）
    loadingRef.current = true;
    genRef.current += 1;                // ★ 换了内容 ⇒ 在飞的那一次全部作废（见 genRef 注释）
    /* ★ 换了内容 ⇒ 「上一章的记忆」全部作废：offset / 内容总高都要重测
       （不清的话，定位判据用的是**上一章**的数）。
       ⚠ 行高表 `rowHRef` 也要清：换章后行 key 从 `B0` 重新编号，
         留着上一章的旧高度会让 `rowLayoutH` 算出**别人的** y（而且不报错）。 */
    offsetRef.current = 0;
    contentHRef.current = 0;
    rowHRef.current = {};
    setPhase('loading');
    lastParamsRef.current = params;
    lastJumpRef.current = jump;
    lastHlRef.current = hl;

    /* ★★★ 2026-10-19：**一次一章**（用户：「阅读页面我不要懒加载了，直接一个章节一个章节
       展示就行了，一次展示一个章节的全部内容」）。
       `GET /books/chapter?book=<key>&chapter=<idx>` 一次给全：
       `{ chapter, blocks, bookmarks, prev, next }`。
       ⚠ 参数只有两个（`book` / `chapter`），**没有** `whole` / `at` / `from` 了 ——
         那些是「一条连续段落流」时代的开关，接口已经不认。
       ⚠ `params` 由 `model.openParams` / `model.chapterParams` 给出（唯一两个出口）。 */
    books.chapter(params).then((res: any) => {
      if (!aliveRef.current) return;    // 层已关 / 已换次：扔掉
      loadingRef.current = false;

      if (!res.ok) {
        /* ⚠ 失败停在原地：data 不清空的话上一份内容还在（换内容失败不闪屏） */
        setPhase('fail');
        setErr(res.error || '');
        return;
      }
      /* ★★★ 2026-10-19：定位这一段的逻辑**整份重写**（协议换了，判据也得换）。
       *
       * ============ 新协议下「滚到哪」只看两样东西 ============
       *   ① 请求时带来的 `seek.offset`（= 书签的**章内字符偏移**，服务端量好的事实）
       *      ⇒ `model.locateInChapter(blocks, offset)` 换算成**块下标**；
       *   ② 换不出来（offset 越界 / 书在 Word 里重存过导致偏移整体错位）
       *      ⇒ `model.matchBlock(blocks, 书签名)` **按文字再找一次**。
       *   ⚠ 顺序不能倒（见 model.bookmarkBlock 的注释）。
       *   ⚠ 两样都失败 ⇒ **不定位**（停在章首）—— 不再有「换一章重取」这条路：
       *     章序是请求时**明确指定的**，这一章里没有就是没有；再猜一章只会跳错地方。
       *    老那套 `hopSec`（拿着全书 seq 反查章）随协议一起作废了。
       *
       * ⚠⚠ `jump` 与 `hl` 仍然是两件事：`jump` 决定**滚不滚**，`hl` 决定**亮不亮**。
       *   侧栏目录跳章 / 点上一章下一章是 `jump=true, hl=false`（滚到章首、不亮）；
       *   从书架恢复位置是 `jump=true, hl=false`；侧栏点书签是 `jump=true, hl=true`。 */
      const want = jump && params && params.seek ? params.seek : null;
      /* ⚠ 「先 offset 再文字」的顺序**只此一处**：走 model.bookmarkBlock（纯函数、可断言），
         别在视图里再写一遍 —— 同一判据散两处迟早有一处忘了改（假绿的老来源）。 */
      const bi = want ? model.bookmarkBlock(res.blocks, want.offset, want.text) : -1;
      /* ⚠ 数据整份换掉（不是合并）。换章时 `chapter` / `blocks` / `bookmarks` 全都是新的，
         合并只会把上一章残留的东西混进来。 */
      setData(res);
      /* ★ 当前章由**这次加载**直接决定（不再跟视口走）—— 头部那一行与侧栏高亮都读它。
         ⚠ `dataNowRef` 必须和 `setData` 同时写：`onViewRef` 是 ref 建的，
           读 `data` state 永远拿到首帧那份（`null`）⇒ 阅读位置一条都记不上。 */
      const chIdx = model.curChapter(res);
      dataNowRef.current = res;
      setCurCh({
        idx: chIdx,
        title: (res.chapter && res.chapter.title) || ''
      });
      /* ⚠ 书名也在这时落一份（见 bookName 的注释）—— `target.book` 是 book_key，推不出书名 */
      if (typeof res.bookTitle === 'string' && res.bookTitle) setBookName(res.bookTitle);
      setPhase('ok');
      const seek = bi >= 0 ? bi : null;
      /* ★ 定位的办法照旧：**列表整份重挂 + 实测行高累加**（见 seekIdx / pushSeek）。
      ⚠ `seekRow` / `setListId` **同一个 then 里连着调** —— React 合并成一次渲染
      ⇒ FlatList 重挂时算出的行下标已经是**新数据**上的（不是上一章的行数）。 */
      seekRowRef.current = seek;
      settledRef.current = seek == null;    // ⚠ ref 要**立刻**写：`onScroll` 里是拿它判的
      setSeekRow(seek);
      setListId((n) => n + 1);
      /* ⚠ 定过位就先盖住加载框（`settled = false`）：重挂那一拍原生先按 offset 0 画一帧、
         再滚到目标行 ⇒ 中间会闪一下**本章开头**（用户对「闪」很敏感）。
         等真到位了再放框（判据在 `pushSeek` 第 ③ 关）。
         ⚠⚠ 必须有上限（`SEEK_MAX_MS`）：那条判据万一永远不成立，没有上限就是
           **永远卡在框里**（框是禁操作的）。 */
      setSettled(seek == null);
      /* ★ 换内容 ⇒ 渲染这一关重新来过：首批行没报完高度之前，`pushSeek` 一行都不滚 */
      if (seek != null) armRenderRef.current();
      if (seekTimerRef.current) { clearTimeout(seekTimerRef.current); seekTimerRef.current = null; }
      if (seek != null) {
        seekTimerRef.current = setTimeout(() => {
          seekTimerRef.current = null;
          settledRef.current = true;
          setSettled(true);
        }, SEEK_MAX_MS);
      }
      /* 书签那一段一直亮着，随时能认出「就是这里」。点侧栏目录 / 翻章不亮。
         ⚠ 亮的是**定到的那一块**（`seek`），不是书签自带的偏移：
           偏移换成块之后才是屏幕上那一行（标题块 / 分隔符上都要归到相邻块）。 */
      /* 书签那**一段字**一直亮着（用户 2026-10-20「有标记的八字高亮就行了」）。
         ⚠ 只有「打开书签」(hl=true) 才亮；点侧栏目录 / 翻章不亮。
         ⚠⚠ 三条路（巾箱补编 2026-10-21，934 条书签实测：68 / 646 / 216 / 4）：
           ① offset 定位块里就有书签文字 ⇒ 直接亮（多数书）；
           ② offset 块里没有（巾箱：offset 落在八字后面的叙述块，八字是独立短块）
              ⇒ `matchBlock` 按文字全章再找一次，亮到文字真正的块；
           ③ 还没有（216 条：书签 text 是竖排拆块拼法 `"癸 甲 癸 甲\n亥 寅 酉 寅"`，
              正文是干、支两个相邻块）⇒ 按 `\n` 拆行，在定位块邻近 ±3 块里逐行找，
              **两块各亮一行**（行顺序 = 干上支下，跟纸书长得一样）。
           都失败 ⇒ 不亮（宁可少亮，不给一个对不上的位置）。 */
      const segs: Array<{ bi: number; start: number; end: number }> = [];
      if (hl && seek != null && want) {
        const first = segOf(res.blocks, seek, want);
        if (first) {
          segs.push(first);
        } else {
          const bi2 = model.matchBlock(res.blocks, want.text);
          const second = bi2 >= 0 ? segOf(res.blocks, bi2, want) : null;
          if (second) {
            segs.push(second);
          } else {
            /* ③ 竖排拆块的书（巾箱补编 216 条实测）：书签 text 是
               `"癸 甲 癸 甲\n亥 寅 酉 寅"`（第一行四个天干、第二行四个地支），
               正文是**干行块紧跟支行块**两个相邻短块 ⇒ 全章找「连续两块分别
               匹配两行」的那一对，两块各亮一行。真库 220 条竖排书签验证：
               全部唯一命中、零撞车 —— 单看一行会撞（同干支的命例不止一个），
               **必须两行成对判**。 */
            const lines = String(want.text || '').split('\n').map((x: string) => x.trim()).filter(Boolean);
            if (lines.length >= 2) {
              for (let k = 0; k + 1 < res.blocks.length && segs.length === 0; k++) {
                const s1 = segOf(res.blocks, k, { offset: 0, text: lines[0] });
                const s2 = s1 ? segOf(res.blocks, k + 1, { offset: 0, text: lines[1] }) : null;
                if (s1 && s2) {
                  segs.push({ bi: k, start: s1.start, end: s1.end });
                  segs.push({ bi: k + 1, start: s2.start, end: s2.end });
                }
              }
            }
          }
        }
      }
      setHlSegs(segs);
    });
  }, [segOf]);

  /* ⚠⚠⚠ **墓碑（2026-10-17）**：这里原有 `endMore`（续拉收尾：解锁 + 收起提示）、
     `isStale`（「这一片过期了吗」—— 比对 `genRef`）、`isMusting`（守位收摊时刻）、
     `commitSlice` / `loadMore` / `checkBlank`（下方续拉三件套）—— 全部随「向下不做懒加载」删除。
     ⚠ 「一次一章」之后下面再没有可拉的东西 ⇒ 锁、游标、过期判据、空白判据都没有读者了。
     ⚠ **别再往回加**：`genRef` 仍在（换章会 +1），但它现在只服务「重挂列表」这一件事。 */

  /* ⚠⚠⚠ **墓碑（2026-10-17）**：这里原来有 `checkBlank` —— 「下面那块空白进视口 ⇒ 去要下一片」
     加「下方不足一屏 ⇒ 再添一屏空白」/「滚到顶 ⇒ 弹模态框要上一片」三个几何判据。
     用户 2026-10-17：「**阅读页面向下滑动就不要做懒加载了**」
     ⇒ 一次只给一章，`buildRows` 也不再产空白行 ⇒ 三个判据全部失去落脚点，整块删除。
     ⚠ 别往回加：向下要内容只在**翻章**时发生（头部「下一章」/ 侧栏目录），**不在滑动时**。 */

  /* ⚠ 2026-10-14：这里原有 `shootPrepend`（把「按内容总高差算出来的补偿」发出去 ——
     全文唯一一处算 target、唯一一处发这一发滚动）与 `clearShots`（撤掉所有待发的补偿）
     两个回调 —— 随像素补偿那套**整块删除**。
     它们当年存在的理由：`scrollToOffset` 发出去之后可能被随后的布局盖掉，所以要按时刻表
     连打好几发、且每一发的目标都按同一个锚重算。**别再往回加**：现在位置**只由实测行高**负责。 */

  /* ⚠⚠⚠ **墓碑（2026-10-17）：「前插守位」整族已删除**（`verifyPrepend` / `scheduleVerify` /
     `isMusting` / `MUST_MS` / `VERIFY_MS` / `prependSeqRef` / `mustUntilRef` / `verifyTimersRef`）。
     ⚠ 为什么可以删干净：守位存在的唯一理由是「**往上接更早一片**时列表会前插、位置会被顶下去」，
       而那条路 2026-10-16「一次一章」落地时就**没有触发点**了（向上回看改走上一章），
       现在向下也不续拉了 ⇒ 列表内容**只在翻章时整体换掉** ⇒ 没有「前插」这件事。
     ⚠ 别再往回加：翻章是**重挂列表** + 实测行高定位（`pushSeek`），不是前插。 */

  /**
   * 滚动：记 offset / 视口高，再推一发定位。
   * ⚠ 记 offset 必须在**最前面**（程序性滚动也要记）—— `pushSeek` 判「到位了没」用的就是它。
   */
  const onScroll = useCallback((e: any) => {
    const ev = e && e.nativeEvent ? e.nativeEvent : null;
    if (ev) {
      offsetRef.current = ev.contentOffset ? ev.contentOffset.y : 0;
      const h = ev.layoutMeasurement ? ev.layoutMeasurement.height : 0;
      if (h > 0) vhRef.current = h;
    }
    /* ★ 2026-10-17：定位期间**也靠滚动事件推一发** —— `scrollToOffset` 落到哪、还有没有偏差，
       只有滚动事件知道（`onContentSizeChange` 只在内容总高变了才来）。
       ⚠ 只在「目标之前全量到了」时才推：否则 `gaps` 非空，每一帧都会再发一发同样的滚动。
       ⚠ `pushSeek` 自己判「到位了就收手」（差值 ≤ 2px），不会死循环。 */
    if (!settledRef.current && seekRowRef.current != null) {
      const idx = seekIdxRef.current;
      if (idx >= 0 && model.rowLayoutH(rowsNowRef.current, rowHRef.current, idx).gaps.length === 0) {
        pushSeekRef.current();
      }
    }
  }, []);

  /**
   * 内容尺寸变了 ⇒ 把新总高记下来，然后叫 `pushSeek()` 推一发定位。
   *
   * ⚠⚠⚠ 这个「总高」在虚拟化列表里**只算渲染窗口内那一段**（2026-10-14 真机证伪过）
   *   ⇒ 它**不能**用来算位移（那一整套已删，别往回加）。它现在唯一的作用是：
   *   「原生把这一批格子挂上去了」—— 是个**时机信号**，定位就靠它推进（见 pushSeek）。
   * ⚠ 2026-10-14：这里原有「按 `新总高 − 旧总高` 补 offset」那一整套（连同一个「锚」和
   *   重试时刻表）**已整块删除** —— 两重原因：① 被真机证伪；② 它和实测行高定位并存就是
   *   **两个控制者各动一次 offset = 跳**。**别再往回加**。
   */
  /* ⚠⚠⚠ **墓碑（2026-10-17）**：`onContentSizeChange` 的实现在这里挪到了 `pushSeek` 之后
     （它要用 `pushSeek`，而 `pushSeek` 依赖 `runSeek` → `seekIdx`）；见 `pushSeek` 下面那一段。 */

  /* ⚠⚠⚠ 这里**没有** `onEndReached` / `onEndReachedThreshold`（2026-10-13 按用户要求删掉）：
     「滚到底自动拉」是阈值型预加载，和「滑进空白才加载」是两套时机 ——
     两套并存就是「还没看见空白，内容已经插进来了」，正是之前那些跳/闪的来源。 */

  /* ---------------- 打开：按书签定位分流（entry 驱动，同 Result 页） ---------------- */
  useEffect(() => {
    aliveRef.current = true;
    const book = target && target.book;
    if (!book) return;

    /* ⚠⚠⚠ 分流判据 = `model.fromShelf`（`chapter` / `offset` 都 null 才是「从书架点封面」）：
       · 不是从书架来 ⇒ **冲着某一段来**（书签 / 查询页）：直达那一章那块，**不吃**本地阅读位置
         —— 用户明确点了某个位置，本地记的那条要让位。
       · 是从书架来 ⇒ 恢复本地阅读位置，没记过就从头。
       ⚠⚠ 判据必须是 `== null`（不是 truthy）：第 0 章、章内第 0 个字都是**合法值**。
       ⚠⚠ `readPos.get` 是**同步**的（storage 的内存镜像），不用 await。
       ⚠ 「怎么换算成请求参数」已**全部**搬进 `model.openParams`（见那个函数的注释）。
       ⚠⚠ 2026-10-19：`readPos.get` 的入参从**文件名**换成了 **book_key**，
         `set` 也从 `(file, seq)` 变成 `(bookKey, chapter, offset)` —— 见 core/readPos.js。 */
    const params = model.openParams(target, readPos.get(book));
    if (params) load(params, true, !model.fromShelf(target));
    /* 退场存位置：⚠ 只认视口报上来的那一块（见 readPosRef）；没读到过（秒开秒关）就不写，
       老位置原样保留 —— 绝不拿 null 把已存的位置冲掉。storage 同步写 + fire-and-forget 落盘。 */
    return () => {
      aliveRef.current = false;
      /* ★★★ 2026-10-16 十七改：**只有「从书架点封面」那一次才记阅读位置**。
         用户原话：「从查询页面进入到阅读页面，再退出就不要保存阅读位置了。
         只有从书籍进入阅读页面退出才保存阅读位置。」
         ⚠⚠ 判据与上面那条分流**同一句**（`model.fromShelf`）：他来这一趟如果是**冲着某一段**
           （书签 / 查询结果），那「我读到哪」就不是「我刚查的那一条」——
           真记下去，下次点封面会跳到一个他根本没读过的位置。
         ⚠ 不记 = **什么都不写**，老位置原样保留（不是写 null 把它冲掉）。 */
      if (model.fromShelf(target) && readPosRef.current) {
        readPos.set(book, readPosRef.current.chapter, readPosRef.current.offset);
      }
      /* ⚠ 定位的兜底定时器必须撤：层关了还滚一下，就是对着已卸载的列表发指令。
         ⚠⚠ 加载框必须收：它是**绝对定位的浮层**，留在原地就会盖到下一本书上。
         （框由 `phase` / `settled` 驱动 ⇒ 两个都复位。） */
      if (seekTimerRef.current) { clearTimeout(seekTimerRef.current); seekTimerRef.current = null; }
      settledRef.current = true;
      setSettled(true);
      seekRowRef.current = null;
      setSeekRow(null);
      /* ⚠ 侧栏抽屉也一起收：层都关了，浮层不能留在下一本书上面。 */
      setSideOn(false);
    };
  }, [entry, load]);

  /* ---------------- ★★★ 定位：seekRow（块下标）⇒ 行下标 ----------------
     ⚠⚠⚠ 这里**没有** effect、也**没有** `scrollToIndex` / `initialScrollIndex` ——
       位置由「**列表重挂 + `runSeek` 按实测行高 `scrollToOffset`**」滚过去（见下面那一节）。
     ⚠⚠⚠ 2026-10-19 换代：目标从「全书段落 seq」换成「**块下标**」（`seekRow`），
       而且 `model.seekRowIndex`（按 seq 反查行、还要为章标题行退一行）**已删** ——
       章标题自己是块，那一层换算不再需要。 */
  /**
   * ★★★ 定位目标（**块下标**）⇒ **行下标**。
   *
   * ⚠⚠ 这两个下标**今天数值相同但语义不同**：`seekRow` 是 `blocks` 的数组下标，
   *   行是 `model.buildRows(blocks)` 的产物（一行一块、空块也成行）。
   *   ⇒ 用户态上「块下标 = 行下标」成立，但**必须经过 buildRows 这一层**
   *     才算行下标 —— 将来只要那一层多出/少掉一种行（比如给标题块插一行间距），
   *     直接拿块下标当行下标就会滚错一行，而且不报错。
   */
  const seekIdx = useMemo(() => {
    if (seekRow == null) return -1;
    const i = layout.rows.findIndex((r: any) => r && r.bi === seekRow);
    return i;
  }, [seekRow, layout.rows]);
  /* ⚠ `onScroll` 是 `useCallback([])`（只建一次）⇒ 它读 `seekIdx` 永远是首帧那份 ⇒ 走 ref 镜像 */
  const seekIdxRef = useRef(-1);
  useEffect(() => { seekIdxRef.current = seekIdx; }, [seekIdx]);
  /* 同理 `pushSeek` 定义在 `onScroll` **之后**：`onScroll` 只经由这个 ref 叫它 */
  const pushSeekRef = useRef<() => void>(() => {});

  /* ★★★ 2026-10-17 重做定位：每行实测高度（`key → h`，由 renderItem 的 onLayout 写）。
     ⚠ 用 ref 不用 state：`onLayout` 一秒能来几十次，进 state 就是整页重渲染。
       它只在 runSeek 里被读（滚动过程中随时可能新增），**不需要**触发渲染。 */
  const rowHRef = useRef<Record<string, number>>({});
  /**
   * ★★★ **按实测行高定位**（2026-10-17 「重做」）。
   *
   * ============ 为什么换（旧的两版都不行）============
   * · `scrollToIndex(idx)`：没有 `getItemLayout` 时按 `averageCellLength × idx` **估** ——
   *   中文段落折行、标题深浅各不相同，估出来能差一两屏；换一章 `_highestMeasuredCellIndex`
   *   也不归零 ⇒ 连失败回调都不来。**这就是「定位的位置是错的」**。
   * · `initialScrollIndex`（十六改）：它要求目标行在**首批渲染窗口**里才拿得到实测位置，
   *   而首批窗口前面通常还夹着一大段没渲染的行 ⇒ 仍然靠估。
   * ★ 现在：**行高全部实测**（renderItem 的 onLayout）⇒ 第 k 行的 y = 前面所有行高度之和，
   *   是**真值**，不估、不算平均。
   *
   * ============ 怎么推进 ============
   * 目标之前还有没量到的行（`plan.gaps`）⇒ 先滚到**最近那个缺处**，让虚拟列表把它渲染出来；
   * 它一报高度，`onLayout` 就再来一轮（见下面那个 effect）。全部量到 ⇒ 直接滚到 `y` 收摊。
   * ⚠ 每发都 `scrollEnabled=false` 挡着（`loadingBox`），用户不会看到中间过程。
   * ⚠⚠ **不碰 MVCP**：定位是「换内容之后的第一次落位」，那时没有任何前插在进行。
   */
  const roundRef = useRef(0);
  /** ⚠ `settledRef` 与 state 必须**同时**写 —— 散着写迟早对不上（回调里读的是 ref） */
  const setSettledNow = useCallback((v: boolean) => {
    settledRef.current = v;
    setSettled(v);
  }, []);

  /**
   * ★ 打一**发**定位：算好「这一发该滚到哪」→ 真滚。
   *   两种发法（都由 `model.seekStep` 决定，视图不自己算）：
   *   · 目标之前还有没量到的行 ⇒ 滚到**最近那个缺处**（把它推进视口去被量）；
   *   · 全量到了 ⇒ 滚到真值 `y`（目标行顶边贴视口顶部）。
   */
  const runSeek = useCallback(() => {
    const ref = listRef.current;
    const idx = seekIdx;
    if (!ref || idx < 0) return;
    const plan = model.rowLayoutH(layout.rows, rowHRef.current, idx, vhRef.current);
    const y = plan.gaps.length === 0
      ? plan.y
      : model.seekStep(plan, layout.rows, rowHRef.current);
    roundRef.current += 1;
    try { ref.scrollToOffset({ offset: y, animated: false }); } catch (e) { /* 列表已卸 */ }
  }, [seekIdx, layout.rows]);

  /**
   * ★★★ **定位的唯一推进口**（`onContentSizeChange` / 每次落行高 / `onScroll` 都叫它）。
   *
   * 三关，**按顺序过**：
   *   ① **渲染完整**：首批 `RENDER_FIRST` 行都量到了高度（或它们根本不存在 —— 章很短）。
   *      没过这一关 ⇒ 直接返回，**一行都不滚**。
   *   ② **量齐目标之前的所有行**：没齐 ⇒ 打一发「滚到缺处」，让它被量，下一次回调再来。
   *   ③ **真到位**：`|当前 offset − y| ≤ 2` 才算落位；不等 ⇒ 再打一发把它顶上去。
   * 只有走到 ③ 才 `settled = true`（= 揭加载框）。
   * ⚠ 轮次上限 `SEEK_ROUNDS_MAX` 只兜「某行永远量不出来」这种病态：到顶就滚到最好估计再收摊，
   *   宁可差一点，也不要停在半路（半路 = 用户看到别人的段落）。
   */
  const pushSeek = useCallback(() => {
    if (settledRef.current) return;
    const idx = seekIdx;
    if (idx < 0) { setSettledNow(true); return; }
    const rows = layout.rows;
    if (!renderedRef.current) {
      /* ① 渲染完整了没：首批那几行都在 `heights` 里（章比首批还短 ⇒ 全部行都到齐也算） */
      const head = Math.min(RENDER_FIRST, rows.length);
      let ok = true;
      for (let i = 0; i < head; i++) {
        if (!model.hasRowH(rowHRef.current, rows[i] && rows[i].key)) { ok = false; break; }
      }
      if (!ok) return;                 // ← 渲染还没完成：不滚、不放框
      renderedRef.current = true;
      setRendered(true);
    }
    /* ⚠ 居中口径（照 docx-viewer：`block:'center'`）⇒ 目标行落在**屏幕中间**，而不是贴顶。
       判据、真值、跑的那一发都用**同一个** `vh`（`vhRef`），否则「量齐了」和「到位了」永远差半屏。 */
    const plan = model.rowLayoutH(rows, rowHRef.current, idx, vhRef.current);
    const measured = plan.gaps.length === 0;
    const outOfRounds = roundRef.current >= SEEK_ROUNDS_MAX;
    runSeek();                          // ② 滚到缺处 / ③ 滚到真值
    if (!measured && !outOfRounds) return;
    if (outOfRounds) { setSettledNow(true); return; }
    /* ③ 真到位了没：只认**当前 offset** 与真值 `y` 的差（可见 ≠ 到位） */
    const off = offsetRef.current;
    if (Math.abs(off - plan.y) <= 2) setSettledNow(true);
  }, [seekIdx, layout.rows, runSeek, setSettledNow]);

  useEffect(() => { pushSeekRef.current = pushSeek; }, [pushSeek]);

  const onContentSizeChange = useCallback((_w: number, h: number) => {
    /* ⚠⚠ 这个「总高」在虚拟化列表里**只算渲染窗口内那一段**（2026-10-14 真机证伪过）
       ⇒ 它**不能**用来算位移（那一整套已删，别往回加）。它现在唯一的作用是：
       「原生把这一批格子挂上去了」—— 是个**时机信号**，定位就靠它推进（见 pushSeek）。 */
    contentHRef.current = h;
    pushSeek();
  }, [pushSeek]);

  /* ---------------- ★★★ 侧栏抽屉：目录 / 书签（2026-10-19 照 demo 重做） ---------------- */

  /**
   * ★★★ **侧栏的目录列表也走「实测行高」定位**（2026-10-17 定下，与正文同一套）。
   *
   * 为什么（用户 2026-10-16：「打开目录，滚动条最好滚动到，选中状态高亮状态的章节名那儿」）：
   *   目录动辄几百章（三命通会 329 章），打开时若从头列起，得自己往下滑几百行。
   *
   * ⚠⚠⚠ 这里**不再用** `initialScrollIndex` / `scrollToIndex`：
   *   目录行高不定（`numberOfLines={2}`，长标题两行），没有 `getItemLayout` 时
   *   RN 按 `平均行高 × 下标` 估 —— 329 行累积下来能错好几行，而且滚过去之后
   *   还要靠 `onScrollToIndexFailed` 再纠一次（那一整套已经在目录里跳来跳过）。
   *   ⇒ 和正文一样：**每行 `onLayout` 记实测高度**，累加就是精确的 y（见 model.rowLayoutH）。
   * ⚠ `tocList` 很小（几百行文本），**提前把高度全量出来**也不贵 ——
   *   所以这里用「打开抽屉就量（`initialNumToRender` 给大）」+「量到多少滚多少」，
   *   不做正文那套「逐段推进」，因为目录不需要精确到「某一行第一个字贴顶」。
   */
  const tocHRef = useRef<Record<string, number>>({});
  /**
   * 侧栏目录要滚到的那一行 = **当前章的 idx**。
   *
   * ⚠⚠⚠ 2026-10-19 换协议：不再有 `model.chapterIndex(tocList, curSec)` 这一层了 ——
   *   服务端 `chapters[].idx` 是 **0..total-1 连续**的章序，而目录 FlatList 就是按
   *   这个顺序一维铺开 ⇒ 「第 idx 章」**就是**「第 idx 行」，中间不需要任何换算。
   *   （老口径要先拿章 seq 在目录里 findIndex，是因为那时目录项带的是 firstPara 段号。）
   * ⚠ 章序取不到（还没加载完）⇒ 不滚、从头列（`tocCurIdx = -1`）。
   */
  const tocCurIdx = curCh && typeof curCh.idx === 'number' ? curCh.idx : -1;
  const tocHit = useCallback(() => {
    const ref = tocRef.current;
    const idx = tocCurIdx;
    if (!ref || idx < 0 || tocList.length === 0) return;
    const plan = model.rowLayoutH(
      tocList.map((it: any) => ({ key: 'S' + it.idx })),
      tocHRef.current,
      idx
    );
    try { ref.scrollToOffset({ offset: plan.y > 0 ? plan.y : 0, animated: false }); } catch (e) { /* 抽屉已关 */ }
  }, [tocList, tocCurIdx]);
  /**
   * ⚠ 「量到新的一行」就把目录再对一次 —— 只在**抽屉开着、且这一发还没落定**时做。
   *   判据用 `tocDoneRef`：一旦「目标之前的行全量到了」就置真，之后用户自己滚目录，
   *   我们**一次都不许再抢**（同正文那条纪律）。
   */
  const tocDoneRef = useRef(false);
  const onTocRowLayout = useCallback((key: string, h: number) => {
    if (!(h > 0)) return;
    if (tocHRef.current[key] === h) return;
    tocHRef.current[key] = h;
    if (!sideOn || tocDoneRef.current) return;
    const idx = tocCurIdx;
    if (idx < 0) { tocDoneRef.current = true; return; }
    const plan = model.rowLayoutH(
      tocList.map((it: any) => ({ key: 'S' + it.idx })),
      tocHRef.current,
      idx
    );
    if (plan.gaps.length === 0) tocDoneRef.current = true;
    tocHit();
  }, [sideOn, tocList, tocHit, tocCurIdx]);

  /**
   * 取这本书的**章节目录**（`GET /books/toc`）—— 侧栏这条路上**唯一**的取数。
   *
   * ⚠⚠ 它与 `load`（读正文）是**两件独立的事**，各走各的：
   *   · 目录**在书打开时取一次**（几百章也就几十 KB），不是每翻一片都背着它；
   *   · 它**失败不影响阅读** —— 正文照读，只是「上一章 / 下一章 / 侧栏目录」
   *     取不到目标而置灰（⚠ 宁可置灰，也不要猜一个目标跳过去）。
   *
   * ⚠ 形状兜底在 `core/books.js` 的 `toc()` 里做（永不 reject）；这里只认 `res.ok`。
   * ⚠ 空目录（`chapters: []`）是**正常结果**，不是失败：这本书没有章节标题。
   * ⚠⚠⚠ 2026-10-19：字段名 `sections` → `chapters`（`[{idx,title,level,charCount}]`，
   *   `idx` 就是章序）。写成 `sections` 会**静默**拿到 undefined ⇒ 目录一片空白、一处不报错。
   */
  const loadToc = useCallback(() => {
    const book = target && target.book;
    if (!book) return;
    setTocPhase('loading');
    setTocErr('');
    books.toc(book).then((res: any) => {
      if (!aliveRef.current) return;          // 层已关 ⇒ 扔掉（同 load 的纪律）
      if (!res.ok) {
        setTocPhase('fail');
        setTocErr(res.error || '');
        return;
      }
      setTocList(res.chapters);
      /* ⚠ 书名也在这时落一份（正文那一发可能还没回来，见 bookName 的注释） */
      if (res.book && typeof res.book.title === 'string' && res.book.title) setBookName(res.book.title);
      setTocPhase('ok');
    });
  }, [target]);

  /**
   * 侧栏「书签」那一栏：这本书的**全部**书签（`GET /books/bookmarks?book=`）。
   *
   * ⚠⚠ 懒加载：只有用户切到那个页签才取（见 `bmPhase` 初始 'idle'）——
   *   只读书不翻书签的人不该为这一栏多发一个请求。
   * ⚠ `BM_PAGE` 一次拿全（真实数据单本最多 736 条，见那个常量的注释）⇒
   *   搜索是在**全量**里筛，与 demo 的客户端筛选同一口径。
   * ⚠ 拿不全（`total > items.length`）时侧栏底部如实说一句，不假装搜过了。
   */
  const loadBookmarks = useCallback(() => {
    const book = target && target.book;
    if (!book) return;
    setBmPhase('loading');
    setBmErr('');
    books.fetchPage(0, BM_PAGE, { book: book }).then((res: any) => {
      if (!aliveRef.current) return;
      if (!res.ok) {
        setBmPhase('fail');
        setBmErr(res.error || '');
        return;
      }
      setBms(Array.isArray(res.items) ? res.items : []);
      setBmTotal(typeof res.total === 'number' ? res.total : 0);
      setBmPhase('ok');
    });
  }, [target]);

  /**
   * ★ 目录：**一本书取一次**。
   *
   * ⚠⚠ 它**单独一个 effect**，不塞进上面那个「打开」的入口 effect 里 —— 那边要用到
   *   `load`，而 `load` 的邻居们定义在 `loadToc` **后面**；在 effect 里引用一个
   *   还没声明的 const 是 TDZ 报错（tsc 会当场拦下，`loadToc` 正是这么被拦出来的）。
   * ⚠ deps 带 `entry`：同一本书被**重新打开**一次（entry 变了）也该重取 ——
   *   书在服务端可能已经换过版本（目录跟着变，`/books/toc` 自己会重新解析）。
   * ⚠ 与正文的取数**完全解耦**：它失败不拦正文（见 loadToc）。
   */
  useEffect(() => { loadToc(); }, [entry, loadToc]);

  /**
   * ★★★ **跳到某一章的开头** —— 头部「上一章 / 下一章」与「侧栏目录里点某一行」
   *   **共用这一条**。
   *
   * ⚠⚠⚠ 它**故意**走 `load(chapter=章序)` —— 也就是「**换掉整章数据**」：
   *   · 用户这回要的就是**跳过去**；
   *   · 与「滚到顶接更早」（前插 + 守位、当前行不动）是**两条完全不同的路**，
   *     别拿一条去改另一条 —— 那正是 2026-10-13 那个 bug 的来源（见 model.js 顶部那段）。
   *
   * ⚠⚠⚠ 2026-10-19 换协议：参数从「目录项对象（拿它的 `seq`）」换成**章序数字**。
   *   · 目录项现在给的是 `idx`（0 起、连续），它**就是**章序，不需要再换算一层；
   *   · 「上一章 / 下一章」的目标来自服务端的 `data.prev` / `data.next`
   *     （`model.prevChapter(data)` / `model.nextChapter(data)`），**不是**自己 `idx ± 1`。
   * ⚠ 目标一定是**数字**：`null`（首章 / 末章 / 数据还没到）时置灰不点，
   *    宁可点不动，也不要发一个 `chapter=null` 的请求。
   * ⚠ 抽屉**在换内容之前**收：换章之后视口要跳，浮层留在上面会跟着一起晃。
   */
  const jumpTo = useCallback((chapter: number | null) => {
    const book = target && target.book;
    setSideOn(false);
    if (!book || typeof chapter !== 'number') return;
    load(model.chapterParams(book, chapter), true, false);
  }, [target, load]);

  /**
   * ★ 侧栏点**一条书签** ⇒ 打开它所在的那一章，按章内字符偏移滚过去**并高亮**。
   *
   * ⚠⚠⚠ `params` 也走 `model.openParams`（与入口分流**同一个函数**）——
   *   书签 item 的形状 `{name, chapter, offset}` 正好是它认的 target 形状，
   *   于是「这一趟从哪一章哪一块开始」全库只有一处算法（入口 / 侧栏共用）。
   * ⚠ `hl = true`（与「目录跳章」「恢复位置」相反）：用户是**冲着这一段**来的，
   *   要亮起来给他认（用户 2026-10-11：「让这个高亮一直存在啊」）。
   * ⚠ 书签没有偏移时 `openParams` 会给 `offset: -1` + 书签名 ⇒ `bookmarkBlock`
   *   退到「按文字找」（书在 Word 里重存过就靠它）。
   */
  const openBookmark = useCallback((bm: any) => {
    const book = target && target.book;
    setSideOn(false);
    if (!book || !bm) return;
    const p = model.openParams(
      { book: book, chapter: bm.chapter, offset: bm.offset, text: bm.text, name: bm.name },
      null
    );
    if (p) load(p, true, true);
  }, [target, load]);

  /** 头部「目录」：开抽屉。⚠ 只有**失败过**才顺手重取（正在取就别再发一次） */
  const onOpenSide = useCallback(() => {
    /* ★ 每次开都是新挂载 ⇒ 高度要重新量、落定标记要复位（否则第二次打开不滚了） */
    tocHRef.current = {};
    tocDoneRef.current = false;
    setSideOn(true);
    if (tocPhase === 'fail') loadToc();
  }, [tocPhase, loadToc]);

  /** 切侧栏页签：切到「书签」且还没取过 ⇒ 顺手取（懒加载，见 loadBookmarks） */
  const onSideTab = useCallback((k: SideTab) => {
    setSideTab(k);
    if (k === 'bm' && bmPhase === 'idle') loadBookmarks();
  }, [bmPhase, loadBookmarks]);

  /** 失败重试：用**上一次**的参数与定位/高亮意图重发 */
  const onRetry = useCallback(() => {
    if (phase !== 'fail') return;
    const p = lastParamsRef.current;
    if (!p) return;
    load(p, lastJumpRef.current, lastHlRef.current);
  }, [phase, load]);

  /* ⚠⚠⚠ **墓碑（2026-10-17）**：这里原来有一大块「往上游接更早一片」（`onPullPrev` /
     `pullPrevRef` / `verifyPrepend` / `scheduleVerify` / `isMusting` / `MUST_MS` / `VERIFY_MS`
     / `prevPhase` 模态框）。2026-10-16 整章模式落地时它就已经**没有触发点**（向上回看改走
     「上一章」），2026-10-17 用户再说「**阅读页面向下滑动就不要做懒加载了**」
     ⇒ 向下这一条也一起清掉：阅读页现在**完全没有「滚动触发加载」**这回事，
       换内容只有三种来路：进书 / 上一章下一章 / 侧栏点一行（都走 `load` 整份换）。
     ⚠ 别把「到顶弹加载框」「滑进空白续拉」搬回来 —— 它们是同一个旧模型的零件。 */

  /* ---------------- 样式 ---------------- */

  const s = useMemo(() => StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: rpx(120) },
    centerText: { marginTop: rpx(20), fontSize: rpx(26), color: COLORS.textMuted },
    retryText: { color: COLORS.gold },

    /**
     * 正文行的**外壳**（被测高度的那一层）。
     *
     * ⚠⚠⚠ 段距必须是这里的 **paddingBottom**，不能是 `para` 的 `marginBottom`：
     *   `rowLayoutH` 累加的是「`onLayout` 量到的高度」，而 **`onLayout` 只报自己的
     *    border-box，不含自己的 margin** —— 但 VirtualizedList 的 cell 是一层裸
     *   `<View>`（见 @react-native/virtualized-lists 的 VirtualizedListCellRenderer），
     *   子节点的 margin **算进 cell 的占位**。于是「量的」与「占的」差一个 marginBottom，
     *   每差一行就多 18rpx：实测第 582 块的书签能早滚 **7.85 屏**（用户 2026-10-19 报的
     *   「点击书签没滚到相应位置」根因就是它）。
     * ⇒ 把段距放进外壳的 padding：padding 在元素**自己的盒子里**，`onLayout` 一定报它，
     *   两遍（量的 / 占的）永远是同一个数。
     * ⚠ 别把这层"简化"掉、回到 `<Text onLayout>`：那正是这个 bug 的形态。
     */
    paraRow: { paddingBottom: rpx(18) },
    /** 出处小字行的外壳（同一道理，见 `paraRow`） */
    srcRow: { paddingBottom: rpx(18) },
    para: {
      fontSize: rpx(30),
      lineHeight: rpx(30 * LINE_HEIGHTS.normal),
      color: COLORS.text,
      paddingHorizontal: rpx(40),
      textAlign: 'justify'
    },
    srcPara: {
      fontSize: rpx(24),
      lineHeight: rpx(24 * LINE_HEIGHTS.normal),
      color: COLORS.textMuted,
      paddingHorizontal: rpx(40)
    },
    /**
     * 高亮那一**行**的底（用户 2026-10-11：「让这个高亮一直存在啊」）。
     * ⚠⚠ 只许放**不影响尺寸**的属性（底色 + 圆角）—— padding / margin / fontSize 一动，
     *   高亮行的高度就与普通行不同 ⇒ 行高对不上、定位算错（这是实测过的坑）。
     */
    /** 段内高亮那**一段字**（书签圈住的原文字，2026-10-20 用户定的唯一一层高亮）——
        ⚠ 只许底色/圆角这类不影响尺寸的属性：高亮块尺寸一变，定位当场算错 */
    hlText: { backgroundColor: COLORS.goldPale, borderRadius: rpx(4) },

    secWrap: { paddingHorizontal: rpx(40), paddingTop: rpx(56), paddingBottom: rpx(14) },
    secTitle: {
      fontSize: rpx(34),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.text,
      lineHeight: rpx(34 * LINE_HEIGHTS.normal)
    },

    /* ---------------- 头部（照 demo 的 header：常驻，上一章 / 章名+位置 / 下一章）---------------- */
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: rpx(16),
      paddingVertical: rpx(12),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.border,
      backgroundColor: COLORS.bgSoft
    },
    headMid: { flex: 1, paddingHorizontal: rpx(8) },
    headTitle: {
      fontSize: rpx(26),
      color: COLORS.text,
      fontWeight: FONT_WEIGHTS.semibold
    },
    headPos: { fontSize: rpx(20), color: COLORS.textMuted, marginTop: rpx(2) },
    /** 头部两枚导航按钮（上一章 / 下一章）—— 目标算不出来时**真的** disabled */
    navBtn: {
      paddingHorizontal: rpx(14),
      paddingVertical: rpx(10),
      borderRadius: rpx(8),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.border,
      backgroundColor: COLORS.bg
    },
    navBtnText: { fontSize: rpx(24), color: COLORS.gold },
    navBtnOff: { color: COLORS.textGhost },
    /** 头部「目录」那一枚（开侧栏抽屉）*/
    sideBtn: {
      paddingHorizontal: rpx(14),
      paddingVertical: rpx(10),
      borderRadius: rpx(8),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.border,
      backgroundColor: COLORS.bg
    },
    sideBtnText: { fontSize: rpx(24), color: COLORS.gold },

    /* ---------------- 侧栏抽屉（照 demo 的 aside：目录 / 书签 + 搜索）---------------- */
    sideHost: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row'
    },
    /** 背面遮罩：点它即关（抽屉的标准出口；另在抽屉里留一枚「关闭」） */
    scrim: { flex: 1, backgroundColor: COLORS.scrim },
    drawer: {
      width: rpx(560),
      backgroundColor: COLORS.bg,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: COLORS.border,
      paddingTop: insets.top,
      paddingBottom: insets.bottom
    },
    drawerHead: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingRight: rpx(8)
    },
    drawerClose: {
      fontSize: rpx(26),
      color: COLORS.gold,
      paddingHorizontal: rpx(14),
      paddingVertical: rpx(10)
    },
    search: {
      margin: rpx(12),
      paddingHorizontal: rpx(16),
      paddingVertical: rpx(10),
      fontSize: rpx(24),
      color: COLORS.text,
      backgroundColor: COLORS.bgCell,
      borderRadius: rpx(8),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.border
    },
    sideRow: {
      paddingHorizontal: rpx(20),
      paddingVertical: rpx(14),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.borderLight
    },
    sideRowText: { fontSize: rpx(26), color: COLORS.text },
    sideRowTextOn: { color: COLORS.gold, fontWeight: FONT_WEIGHTS.semibold },
    sideRowSub: { fontSize: rpx(20), color: COLORS.textMuted, marginTop: rpx(4) },
    sideEmpty: {
      paddingVertical: rpx(80),
      paddingHorizontal: rpx(24),
      textAlign: 'center',
      fontSize: rpx(24),
      color: COLORS.textMuted
    },
    sideRetry: { color: COLORS.gold },
    /** 书签那一栏取不全时的如实说明（`total > 已加载`） */
    sideFoot: {
      paddingVertical: rpx(20),
      textAlign: 'center',
      fontSize: rpx(22),
      color: COLORS.textGhost
    },

    /* ⚠⚠⚠ **墓碑（2026-10-19，本页重做）**：`barTop` / `barBottom` / `barBtn` / `barBtnOff` /
       `tocHost` / `tocHead` / `tocHeadText` / `tocRow` / `tocRowText` / `tocRowTextOn` /
       `tocRowTextOff` 一整族随「点屏幕呼出工具栏 + 全屏目录面板」删除，换成上面的
       `head` / `navBtn` / `sideBtn` / `sideHost` / `drawer` / `sideRow` 一族。
       ⚠ 别按 10-14 那套名字把它们加回来：形态已经换了（见文件头与 model.js 顶部那段）。 */

    prevMask: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255, 255, 255, 0.6)'
    },
    prevCard: {
      paddingHorizontal: rpx(36),
      paddingVertical: rpx(28),
      borderRadius: rpx(12),
      backgroundColor: COLORS.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.border,
      alignItems: 'center'
    },
    prevCardText: { fontSize: rpx(28), color: COLORS.textMuted },
  }), [rpx, insets.top, insets.bottom]);

  /* ---------------- 派生 ---------------- */

  /** 「上一章 / 下一章」的目标：一律来自服务端（`data.prev` / `data.next`），不自己 idx ± 1 */
  const prevSec = model.prevChapter(data);
  const nextSec = model.nextChapter(data);

  /** 头部那一行位置：「第 3/12 章 · 4200 字」（章序取不到时不显示） */
  const posLine = model.posText(
    curCh && typeof curCh.idx === 'number' ? curCh.idx : null,
    data && typeof data.total === 'number' ? data.total : (tocList.length || 0),
    data && data.chapter && typeof data.chapter.charCount === 'number' ? data.chapter.charCount : 0
  );
  /** 头部标题：本章章名；章名为空（无标题书）显示「（卷首）」；还没加载完退回书名 */
  const headTitle = curCh && curCh.title
    ? curCh.title
    : (curCh ? model.UNTITLED_TEXT : (bookName || (target && target.title) || ''));

  /** 侧栏当前页签要列的东西（搜索在这里筛，照 demo 的 `renderList`） */
  const chTitleOf = useCallback((idx: any) => {
    const it = tocList.find((c: any) => c && c.idx === idx);
    return it && it.title ? String(it.title) : '';
  }, [tocList]);
  const qq = q.trim();
  const tocArr = useMemo(() => {
    if (!qq) return tocList;
    return tocList.filter((c: any) => String((c && c.title) || '').includes(qq));
  }, [tocList, qq]);
  const bmArr = useMemo(() => {
    if (!qq) return bms;
    return bms.filter((b: any) =>
      String((b && b.name) || '').includes(qq) || chTitleOf(b && b.chapter).includes(qq)
    );
  }, [bms, qq, chTitleOf]);

  /* ---------------- 行渲染 ---------------- */

  /**
   * 块文本 + 段内高亮：切成「前 / 高亮 / 后」三个 `<Text>`（demo 的 `Range` 在 RN 里的画法）。
   * ⚠ 只有**高亮行里、且算得出区间**时才切；否则原样一个字符串（少一层节点）。
   * ⚠⚠ 拆 Text **不影响行高**（同一份文字、同一个字号行高，样式只给底色）⇒ 定位照旧准。
   */
  const segText = useCallback((text: string, seg: { start: number; end: number } | null) => {
    const t = String(text == null ? '' : text);
    if (!seg) return t;
    return (
      <>
        <Text>{t.slice(0, seg.start)}</Text>
        <Text style={s.hlText}>{t.slice(seg.start, seg.end)}</Text>
        <Text>{t.slice(seg.end)}</Text>
      </>
    );
  }, [s]);

  /**
   * 正文的一行。
   *
   * ⚠⚠⚠ 段内高亮判据：`hlMap`（`bi → {start, end}`）按行的 `bi` 取。
   *   · 2026-10-21 起最多**两段**（竖排拆块的书：干行块 + 支行块各亮一行），
   *     Map 一次建好，这里不许再扫数组；
   *   · 判据就在这一处 —— 同一个意思在 renderItem 里只写一次，别在样式里再抄一份。
   */
  const renderItem = useCallback(({ item }: { item: any }) => {
    const onRowLayout = (e: any) => {
      const h = e && e.nativeEvent && e.nativeEvent.layout
        ? e.nativeEvent.layout.height
        : 0;
      if (h > 0) rowHRef.current[item.key] = h;
    };

    /* 段内高亮：只有**这一行**在高亮表里、且算得出区间时才给（2026-10-20 只留这一层） */
    const seg = item && typeof item.bi === 'number' ? hlMap.get(item.bi) || null : null;

    /* 标题块（书里的小标题，`h1` / `h2` / `h3`）—— 缩进层级走 model.blockDepth
       ⚠ `secWrap` 自己就是被测的那一层，且它的上下留白是**padding**（在盒子里）⇒ 量到即占位。 */
    if (item && model.isHeading(item.type)) {
      return (
        <View style={s.secWrap} onLayout={onRowLayout}>
          <Text style={[s.secTitle, { paddingLeft: rpx(model.blockDepth(item.type) * 14) }]}>
            {segText(item.text, seg)}
          </Text>
        </View>
      );
    }
    /* 正文块 / 出处小字块（`p` / `source`）—— 其余类型一律按正文渲染（形状兜底）
       ⚠⚠ 外壳 `paraRow` / `srcRow` 是被测高度的那一层（段距在它里面，见那边的注释）——
         把 `onLayout` 挪回内层 `<Text>` 就是这个 bug 的复活形态。 */
    return (
      <View
        style={item && item.type === 'source' ? s.srcRow : s.paraRow}
        onLayout={onRowLayout}
      >
        <Text style={item && item.type === 'source' ? s.srcPara : s.para}>
          {segText(item.text, seg)}
        </Text>
      </View>
    );
  }, [s, hlMap, rpx, segText]);

  /**
   * 侧栏**目录**里的一行。
   * ⚠ 缩进与正文里的**标题块**同一套口径（`model.blockDepth`）——
   *   侧栏与正文看起来是同一个层级结构，用户在两边来回看不会错位。
   * ⚠⚠⚠ 2026-10-19：目录项带的是 `level`（数字）而不是块的 `type`（字符串）——
   *   `blockDepth` 只认 `'h1'|'h2'|'h3'`，喂数字会**全部落到 0 档**（缩进全没，
   *   而且不报错）⇒ 这里先把 level 翻成块类型再喂（见 `levelToType`）。
   */
  const levelToType = (lv: any): string => {
    const n = typeof lv === 'number' ? lv : 1;
    if (n <= 1) return 'h1';
    if (n === 2) return 'h2';
    return 'h3';
  };
  const renderTocItem = useCallback(({ item }: { item: any }) => {
    const onRowLayout = (e: LayoutChangeEvent) => {
      const h = e && e.nativeEvent && e.nativeEvent.layout ? e.nativeEvent.layout.height : 0;
      onTocRowLayout('S' + (item && item.idx), h);
    };
    /* ⚠⚠ 目录高亮判据：两侧都是数字，且 `curCh.idx` 可能是 null（章还没加载完）——
       写成 `item.idx === curCh.idx` 时 null 会把**第 0 章**也一起点亮。 */
    const on = curCh != null && typeof curCh.idx === 'number' && item && item.idx === curCh.idx;
    return (
      <Pressable
        style={s.sideRow}
        onLayout={onRowLayout}
        onPress={() => jumpTo(item ? item.idx : null)}
      >
        <Text
          style={[s.sideRowText, { paddingLeft: rpx(model.blockDepth(levelToType(item && item.level)) * 12) }, on ? s.sideRowTextOn : null]}
          numberOfLines={2}
        >
          {(item && typeof item.idx === 'number' && item.idx > 0 ? item.idx + 1 + '. ' : '') +
            (item && item.title ? item.title : model.UNTITLED_TEXT)}
        </Text>
      </Pressable>
    );
  }, [s, rpx, curCh, jumpTo, onTocRowLayout]);

  /**
   * 侧栏**书签**里的一行：书名（四柱）+ 它在第几章（小字）。
   * ⚠ key 用书签名：`bookmarks` 的主键就是 `(book_key, name)` ⇒ 一本书里不会重。
   */
  const renderBmItem = useCallback(({ item }: { item: any }) => {
    const sub = chTitleOf(item && item.chapter);
    return (
      <Pressable style={s.sideRow} onPress={() => openBookmark(item)}>
        <Text style={s.sideRowText} numberOfLines={1}>{item && item.name ? item.name : ''}</Text>
        {sub ? <Text style={s.sideRowSub} numberOfLines={1}>{sub}</Text> : null}
      </Pressable>
    );
  }, [s, openBookmark, chTitleOf]);

  /** 侧栏列表的空态 / 失败态（四个页签状态四种文案，都不教用户怎么做） */
  const renderSideEmpty = useCallback(() => {
    if (sideTab === 'ch') {
      if (tocPhase === 'fail') {
        return (
          <View style={{ alignItems: 'center' }}>
            <Text style={s.sideEmpty}>{tocErr || model.FAIL_TEXT}</Text>
            <Pressable onPress={loadToc}><Text style={[s.sideEmpty, s.sideRetry]}>{model.RETRY_TEXT}</Text></Pressable>
          </View>
        );
      }
      if (tocPhase !== 'ok') return <Text style={s.sideEmpty}>{model.LOADING_TEXT}</Text>;
      if (tocList.length === 0) return <Text style={s.sideEmpty}>{model.TOC_EMPTY_TEXT}</Text>;
      if (tocArr.length === 0) return <Text style={s.sideEmpty}>{model.NOMATCH_CH_TEXT}</Text>;
      return null;
    }
    if (bmPhase === 'fail') {
      return (
        <View style={{ alignItems: 'center' }}>
          <Text style={s.sideEmpty}>{bmErr || model.FAIL_TEXT}</Text>
          <Pressable onPress={loadBookmarks}><Text style={[s.sideEmpty, s.sideRetry]}>{model.RETRY_TEXT}</Text></Pressable>
        </View>
      );
    }
    if (bmPhase === 'idle' || bmPhase === 'loading') return <Text style={s.sideEmpty}>{model.LOADING_TEXT}</Text>;
    if (bms.length === 0) return <Text style={s.sideEmpty}>{model.BM_EMPTY_TEXT}</Text>;
    if (bmArr.length === 0) return <Text style={s.sideEmpty}>{model.NOMATCH_BM_TEXT}</Text>;
    return null;
  }, [sideTab, tocPhase, tocErr, tocList.length, tocArr.length, bmPhase, bmErr, bms.length, bmArr.length, s, loadToc, loadBookmarks]);

  /* ---------------- 渲染 ---------------- */

  const loadingBox = phase === 'loading' || !settled;

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.bg }}>
      {/* ================= 头部（照 demo 的 header）=================
          ⚠⚠ 顶部**不放返回**：App 的 NavBar（返回 + 书名）一直显示在阅读页外面，
             顶上两个返回按钮，点错一次就退出去（用户 2026-10-14 明确选了保留它）。
          ⚠ 「夜间」本轮**不做**（用户选「以后单独做」）⇒ 别先摆一个点了没反应的假按钮。 */}
      <View style={s.head}>
        <Pressable style={s.sideBtn} onPress={onOpenSide}>
          <Text style={s.sideBtnText}>{model.TOC_TEXT}</Text>
        </Pressable>
        <View style={s.headMid}>
          <Text style={s.headTitle} numberOfLines={1}>{headTitle}</Text>
          {posLine ? <Text style={s.headPos}>{posLine}</Text> : null}
        </View>
        <Pressable
          style={[s.navBtn, !prevSec ? { opacity: 0.4 } : null]}
          disabled={!prevSec}
          onPress={() => { if (typeof prevSec === 'number') jumpTo(prevSec); }}
        >
          <Text style={[s.navBtnText, !prevSec ? s.navBtnOff : null]}>{model.PREV_CH_TEXT}</Text>
        </Pressable>
        <View style={{ width: rpx(8) }} />
        <Pressable
          style={[s.navBtn, !nextSec ? { opacity: 0.4 } : null]}
          disabled={!nextSec}
          onPress={() => { if (typeof nextSec === 'number') jumpTo(nextSec); }}
        >
          <Text style={[s.navBtnText, !nextSec ? s.navBtnOff : null]}>{model.NEXT_CH_TEXT}</Text>
        </Pressable>
      </View>

      {/* ================= 正文：一章给全（一次一章，不懒加载）================= */}
      {phase !== 'fail' ? (
        <View
          style={{ flex: 1 }}
          onLayout={(e: LayoutChangeEvent) => {
            const h = e && e.nativeEvent && e.nativeEvent.layout ? e.nativeEvent.layout.height : 0;
            if (h > 0) { vhRef.current = h; setVh(h); }
          }}
        >
          <FlatList
            ref={listRef}
            /* ★ 换一章就**整份重挂**（不是改 initialScrollIndex —— 那只在挂载时起作用） */
            key={'L' + listId}
            data={layout.rows}
            renderItem={renderItem}
            keyExtractor={(item: any) => item.key}
            /* ⚠ 定位期间禁滚：`scrollToOffset` 与用户手势抢同一个 offset 就是跳 */
            scrollEnabled={!loadingBox}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onContentSizeChange={onContentSizeChange}
            onViewableItemsChanged={onViewRef.current}
            viewabilityConfig={viewConfigRef.current}
            /* ★★★ **整章全量挂载**（2026-10-20 定案）：
               定位靠「实测行高累加」，而行高只有行被挂载才报得上来。老那套
               `initialNumToRender=12 + windowSize=21` 是虚拟化挂载 —— 目标行在几十行之外时，
               得靠「滚到缺处 → 量到 → 再滚」循环推进十几轮，`SEEK_MAX_MS` 早就超时收摊
               ⇒ 页面停在章首，看起来就是「点了书签没跳」（用户 2026-10-20 报的就是这个）。
               demo 为什么百分百准：整章全在 DOM 里，所有位置天然已知。RN 的等价物就是
               把整章一次全挂上 —— 「一次一章」之后章节本来就是最小的内容单位，
               挂全章（几百行 Text）代价可以接受，换来的是**所有行一次报完高度、
               一发滚到精确 y**，不再有任何推进循环。 */
            initialNumToRender={layout.rows.length || RENDER_FIRST}
            /* ⚠⚠⚠ **不许给这个列表加 `contentContainerStyle` 的上下 padding**：
                 定位算的 y 是「行高累加」（`model.rowLayoutH`），而 padding 在滚动内容**里面** ⇒
                 同样的 offset 会把目标行顶下去一个 padding 的距离（「怎么滚都差一截」，且不报错）。
                 顶部留白由第一块自己的 `secWrap.paddingTop` 给，底部由每行的 `paraRow` 给 ——
                 都在**行内**，量得到。
               ⚠⚠ **不开 `removeClippedSubviews`**：它会把视口外的 cell 卸掉，整章挂载之后
                 行高全靠每个 cell 的 `onLayout` 报上来，卸掉就是白量（官方文档自己都写着
                 "May have bugs (missing content)"）。 */
            style={{ flex: 1 }}
          />
        </View>
      ) : (
        /* 失败态：**可点的出口**必须留（没有「重试」的话，用户除了退出去重进没有任何办法） */
        <View style={s.center}>
          <Text style={s.centerText}>{err || model.FAIL_TEXT}</Text>
          <Pressable onPress={onRetry}><Text style={s.retryText}>{model.RETRY_TEXT}</Text></Pressable>
        </View>
      )}

      {/* ================= ★★★ 加载章节内容的加载框（2026-10-16 十七改）=================
          用户原话：「**加载章节内容要有一个加载框提示才行**」。
          ⇒ 正文在飞（`phase === 'loading'`：进书 / 点上一章下一章 / 侧栏跳章 / 重试）
            **或** 定位还没落位（`!settled`）时，盖一块全屏遮罩 + 一句「正在加载…」。
          ⚠⚠ 它同时是「定位那一下的遮羞布」：重挂之后的前几帧，
            列表先按 offset 0 画（那几格还没渲染 ⇒ 看着像从头开始），
            实测行高攒够、滚到真位置之后内容才对齐 —— 盖着就完全看不到这一下。
          ⚠ 禁操作由两处保证：遮罩自己吃触摸，列表 `scrollEnabled={!loadingBox}`。
          ⚠ 必须排在**侧栏抽屉之后**：遮罩是绝对定位铺满的，先声明会被它压住。
          ⚠ 不做任何动效（用户两次否掉自动消失类动效）：静态一块 + 一句话。 */}
      {loadingBox ? (
        <View style={s.prevMask}>
          <View style={s.prevCard}>
            <Text style={s.prevCardText}>{model.LOADING_TEXT}</Text>
          </View>
        </View>
      ) : null}

      {/* ================= ★★★ 侧栏抽屉（2026-10-19 照 demo 的 aside 重做）=================
          demo 的侧栏是常驻的（桌面 270px）；手机上改成左抽屉 + 背面遮罩（见文件头偏离①）。
          ⚠ 它是**根层的兄弟**（不是正文那层的子节点）⇒ 它在上面点，正文那层收不到。
          ⚠ 两个出口：点背面遮罩、点抽屉里那枚「关闭」—— 不能只靠系统返回键。 */}
      {sideOn ? (
        <View style={s.sideHost}>
          <View style={s.drawer}>
            <View style={s.drawerHead}>
              <View style={{ flex: 1 }}>
                <SegTabs
                  tabs={SIDE_TABS}
                  value={sideTab}
                  onChange={(k) => onSideTab(k)}
                />
              </View>
              <Pressable onPress={() => setSideOn(false)}>
                <Text style={s.drawerClose}>{model.TOC_CLOSE_TEXT}</Text>
              </Pressable>
            </View>
            <TextInput
              style={s.search}
              value={q}
              onChangeText={setQ}
              placeholder={model.SEARCH_PLACEHOLDER}
              placeholderTextColor={COLORS.textGhost}
            />
            {sideTab === 'ch' ? (
              <FlatList
                ref={tocRef}
                data={tocArr}
                renderItem={renderTocItem}
                keyExtractor={(it: any) => 'S' + it.idx}
                /* ⚠ `flex: 1` 不能省：抽屉是绝对定位铺满的，列表不撑满就没法滚 */
                style={{ flex: 1 }}
                initialNumToRender={40}
                onContentSizeChange={() => { if (!tocDoneRef.current) tocHit(); }}
                ListEmptyComponent={renderSideEmpty}
              />
            ) : (
              <FlatList
                data={bmArr}
                renderItem={renderBmItem}
                keyExtractor={(it: any, i: number) => 'M' + ((it && it.name) || i)}
                style={{ flex: 1 }}
                ListEmptyComponent={renderSideEmpty}
                ListFooterComponent={
                  bmTotal > bms.length ? (
                    <Text style={s.sideFoot}>仅加载前 {bms.length} 条（共 {bmTotal} 条）</Text>
                  ) : null
                }
              />
            )}
          </View>
          <Pressable style={s.scrim} onPress={() => setSideOn(false)} />
        </View>
      ) : null}
    </View>
  );
}

/** 侧栏两个页签（照 demo 的 aside.tabs：目录 / 书签） */
const SIDE_TABS: SegTabItem<SideTab>[] = [
  { key: 'ch', label: '目录' },
  { key: 'bm', label: '书签' }
];
