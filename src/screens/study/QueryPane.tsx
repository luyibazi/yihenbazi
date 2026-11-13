/**
 * 学堂 ·「查询」面板 —— 书籍书签列表（懒加载 + 四柱筛选）
 *
 * ⚠ 2026-10-11 从 `Study.tsx` **原样搬出来**（现在 Study 只是「顶部切换栏 + 两个常驻面板」
 *   的壳，见那边的注释）。搬出来是为了能独立复用：别处要这块东西时，
 *   直接挂 `<QueryPane active onOpenBookmark={...} />` 即可，不必背整个学堂页。
 *   搬动时**只动了组件名和这个文件头，其余一行未改** —— 所以原来那些纪律
 *   （FlatList 虚拟化、工具栏必须是列表的兄弟、换筛选要 genRef 清列表…）全部照旧适用。
 *
 * ============ 这一块做什么 ============
 * 把「书籍目录里所有 docx 的八字书签」列出来，每项两行：
 *   两行干支（与记录页的八字长得一模一样）+ 出处（`书名 · 卷一 · 篇名`）。
 * 数据来自本地后端的 `GET /books/bookmarks`（分页，见 core/books.js）。
 *
 * ============ 筛选（★ 2026-10-04 用户要求：与记录页同一套、组件复用）============
 * 面板与入口是公用件 components/FilterModal.tsx，八个类别 + 拼参数是
 * core/pillarFilter.js —— 与记录页**同一份逻辑、同一个外观**。
 * ⚠⚠ 过滤**在服务端做**（`?dayGan=甲,乙`）：所以「换筛选」= 清空列表 +
 *   从第 0 条重拉，而不是在本地筛已加载的那些。
 *   ⚠ 这也是为什么必须有 `genRef`（代次）：换筛选时可能有一页还在路上，
 *     它回来时数据已经是「旧筛选」的 —— 不丢掉就会混进新列表（见那边的注释）。
 *
 * ============ ⚠⚠⚠ 用 FlatList，不是 ScrollView + map ============
 * 全馆 3000+ 条书签，ScrollView 会把**已加载的每一条**都渲染成真实节点
 *   —— 加载到几百条就开始掉帧、上千条直接卡死。那正是用户要求懒加载的原因，
 *   光把**请求**分页、渲染不分页，等于白做。
 *   FlatList 只渲染视口附近那几屏，滚多远都稳。
 *
 * ============ 懒加载的三个约定 ============
 *   ① **切到学堂 tab 才加载第一页**（不是一挂载就加载）—— 这就是「懒」；
 *   ② 滚到底（FlatList 的 onEndReached）再要下一页，一页 50 条；
 *   ③ 失败**停在原地**并给一条可点的重试（从断点**续拉**，不从头再来）。
 *
 * ⚠ 「一条都没有」「被筛空」「读不到」是**三件**事，空态文案必须分开 ——
 *   混成一句会让用户以为书签丢了，而其实只是换了筛选或没连上。
 *
 * ⚠ 只有自建后端（local）有这份数据（见 core/storeMode.js 的 supportsBooks）：
 *   其他模式**如实说明**，不发请求（发了一定 404，用户只会看到「加载失败」）。
 *
 * ============ 知识卡：已彻底删除（别再找 content.js）============
 * 页面上原来的 5 条命理知识卡按用户要求（2026-10-04）先下线，2026-10-21
 * 用户又说「学堂模块之前那个老的，没用，废弃的代码都移除」⇒ 连
 * `screens/study/content.js` 那份数据一起删了（它已经**没有任何 import**）。
 * ⚠ 要恢复只能凭记忆重写一遍，这里刻意不留副本 —— 留着就是「看起来还在用」的死代码。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
/* ⚠⚠⚠ 列表就用 **RN 原版的 `FlatList`**（2026-10-10 深夜定稿）。
   中间那版要换成自研的 `components/GestureFlatList`（`createNativeWrapper` 包过的），
   是为了给自研下拉刷新的手势让路；那套手势已整条撤掉，列表这边回到原版 ——
   现在的下拉刷新（`components/PullRefresh.tsx`）**一个字的手势都不抢**，
   也不需要包装列表（包了反而会与列表滚动抢同一个原生视图）。
   详见下面 `<FlatList>` 上方那段注释与 README 的「下拉刷新」一节。 */

import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS, SIZES } from '../../theme/tokens';
import { FilterEntry, FilterModal } from '../../components/FilterModal';
import { PullRefresh, isPulling } from '../../components/PullRefresh';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const books: any = require('../../core/books.js');
const storeMode: any = require('../../core/storeMode.js');
const pf: any = require('../../core/pillarFilter.js');

/**
 * 条目形状 = 服务端 `items` 的字段（books.js 原样透传）。
 *
 * ⚠⚠⚠ 2026-10-19 换协议，**三个字段的形状全变了**：
 *   · `chapter`：`string[]`（章节层级路径）→ **`number`（章序，0 起）**；
 *   · `para`（全书段序）→ **`offset`（章内字符偏移）**；
 *   · `book`：书名；**新增 `bookKey`**（阅读页要的是它，不是书名）。
 *   ⇒ 点开书签不再「原样把 item 交给阅读页」，而是走 `model.bookmarkTarget(item)`
 *     组装成 target（一条 item 上多出来的 `text` / `book` 字段不该带进阅读页）。
 */
export type Item = {
  name: string;
  /** 书签圈住的原文字（阅读页按它做「按文字找段落」的退路） */
  text: string;
  /** 书名（只用来显示出处，**不是**书的标识） */
  book: string;
  /** 书的 book_key（docx 内容 sha256 前 16 位） */
  bookKey: string;
  /** 章序（0 起） */
  chapter: number;
  /** 章内字符偏移（块文本以 \n 相连的口径，见 reader/model.js 的 locateInChapter） */
  offset: number;
};
type Phase = 'idle' | 'loading' | 'ok' | 'fail' | 'end';

export default function QueryPane({
  active,
  onOpenBookmark,
}: {
  /** 当前这个 tab 是不是显示中（第一次变成 true 时才去拉第一页 —— 「懒」的落点） */
  active: boolean;
  /** 点开一条书签（App 接管 → 推入层开阅读页）。不传 = 条目不可点（无副作用） */
  onOpenBookmark?: (item: Item) => void;
}) {
  const rpx = useRpx();
  /** 当前后端有没有这份数据（只有自建后端有） */
  const canBooks = storeMode.supportsBooks();
  /**
   * 后端支不支持筛选 —— 与 `canBooks` 都是「只认 local」，但要分开问：
   * 将来若出现「有书但不能筛」的后端，这里各自给出正确答案，不必回来改逻辑。
   */
  const canFilter = storeMode.supportsFilter();

  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errText, setErrText] = useState('');
  /**
   * **生效中的**四柱筛选（`{ dayGan: { 甲: true } }` 这份形状）。
   * ⚠ 弹窗里的草稿由 components/FilterModal.tsx 自己管 —— 这一页只在
   *   「确定」回调里拿到草稿，用 pf.applyPlan 决定要不要重拉。
   */
  const [filter, setFilter] = useState<any>(() => pf.emptyFilter());
  /** 弹窗开着没有 */
  const [fltOpen, setFltOpen] = useState(false);
  /**
   * ⚠ 最新 filter 放 ref：`loadPage` 里要读它，而 setState 是异步的
   *   （照记录页 `filterRef` 的写法 —— 它是**生效值**，不是草稿）。
   */
  const filterRef = useRef<any>(filter);
  filterRef.current = filter;
  /** 有没有生效中的筛选（空集合 = 全部）—— 角标、空态、计数都用它 */
  const filtered = pf.hasFilter(filter);

  /**
   * ⚠⚠ **同步锁**（ref 而不是 state）：onEndReached 在一次快速滑动里能连着触发
   *   好几次，而 `setPhase('loading')` 是异步的、要下一帧才生效 ——
   *   只靠 phase 挡不住并发，会发出好几个重复请求（列表里出现重复条目）。
   */
  const loadingRef = useRef(false);
  /**
   * 已加载的条数。
   * ⚠ 必须用 ref 同步读：`loadPage` 里要拿它算 offset，而它是在
   *   `useCallback` 里读的 —— 直接读 state 会拿到**上一次渲染**的旧值
   *   （现象：翻页翻来翻去都是同一页）。
   */
  const itemsRef = useRef<Item[]>([]);
  /** 有没有开始加载过第一页（切走再切回不重来，状态都还在） */
  const startedRef = useRef(false);
  /**
   * ⚠⚠ **请求代次**：换筛选时 +1。在飞的旧请求回来时会发现代次变了 ⇒ 直接扔掉。
   *
   *   不加这个会出现这样一种偶发（而且极难查，要看网络时序）：
   *   用户滚到一半（有一页在路上）→ 打开筛选点确定 ⇒ 我们清空列表、按新条件重拉
   *   → 旧请求晚一步返回，把**旧筛选的数据**追加进新列表里。
   *   结果：列表里混着不符合当前筛选的条目，而每一次复现的时机都不一样。
   */
  const genRef = useRef(0);

  /**
   * 下拉刷新正在转圈。
   * ⚠⚠ **必须是 state 而不是 ref**：它决定 `<PullRefresh>` 的文案与什么时候收圈，
   *   ref 改了不触发重渲染 ⇒ 文案不换、圈也收不回（记录页踩过的坑③前置条件）。
   */
  const [refreshing, setRefreshing] = useState(false);

  /**
   * 拉一页。
   *
   * @param {number} offset 从第几条开始（= 已加载条数）
   * @param {boolean} replace true = 用它替换现有列表（首屏/换筛选/首屏重试），false = 追加（翻页）
   */
  const loadPage = useCallback((offset: number, replace: boolean) => {
    if (!canBooks) return;              // 没有这份数据，别发必然失败的请求
    if (loadingRef.current) return;     // 已经在路上了

    const gen = genRef.current;         // ⚠ 捕获**本次请求**的代次，回调里要拿它对比
    loadingRef.current = true;
    setPhase('loading');

    /* ⚠ 筛选参数在这里发出去（过滤在服务端）：空对象 = 不带参数 = 拉全部
       ⚠⚠ **必须 return 这个 promise**：下拉刷新的转圈要等它 resolve 才能收
       （见 onRefresh）。不返回的话只能靠定时器蒙一个时长 —— 网慢时转圈提前
       消失（用户以为刷完了），且失败路径收不了圈。 */
    return books.fetchPage(offset, model.PAGE_SIZE, pf.toQuery(filterRef.current)).then((res: any) => {
      /* ⚠⚠ 代次变了 ⇒ 这批数据属于「上一次筛选」，一律扔掉（连 phase 都不许碰） */
      if (gen !== genRef.current) return;

      loadingRef.current = false;

      if (!res.ok) {
        /* ⚠ 失败**不动**已加载的列表（翻页失败时前面的内容不该消失），
           只把底部那条变成「加载失败 · 点这里重试」。 */
        setPhase('fail');
        setErrText(res.error || '');
        return;
      }

      const page: Item[] = Array.isArray(res.items) ? res.items : [];
      const next = replace ? page : itemsRef.current.concat(page);
      const totalNext = typeof res.total === 'number' ? res.total : 0;

      itemsRef.current = next;
      setItems(next);
      setTotal(totalNext);
      setPhase(model.phaseAfter(next.length, totalNext, page.length));
    });
  }, [canBooks]);

  /* ---------------- 懒加载的入口：切到这个 tab 才拉第一页 ---------------- */
  useEffect(() => {
    if (!active) return;
    if (startedRef.current) return;
    startedRef.current = true;
    loadPage(0, true);
  }, [active, loadPage]);

  /** 滚到底：还要不要下一页（判断逻辑在 model 里，可断言） */
  const onEndReached = useCallback(() => {
    const loaded = itemsRef.current.length;
    if (!model.shouldLoadMore(loaded, total, phase)) return;
    loadPage(loaded, false);
  }, [total, phase, loadPage]);

  /**
   * 底部那条「加载失败 · 点这里重试」。
   * ⚠ 从**断点续拉**（offset = 已加载条数），不是从头来 ——
   *   翻到第 500 条时失败，重试却回到第一条，用户会以为数据丢了。
   * ⚠ 只有列表还是空的（首屏就失败）才用 replace。
   */
  const onRetry = useCallback(() => {
    if (phase !== 'fail') return;
    const loaded = itemsRef.current.length;
    loadPage(loaded, loaded === 0);
  }, [phase, loadPage]);

  /* ---------------- 下拉刷新（★ 重拉当前这份列表：沿用当前筛选，从第 0 条替换） ---------------- */

  /**
   * 下拉 = 用户**主动**要最新数据 ⇒ 绕过一切「别乱发请求」的闸门，直接重拉第一页。
   *
   * ⚠⚠ 「三件」少一件就「拉了没反应」：
   *   ① `genRef++` —— 作废在飞的首屏/翻页请求（它回来会往这份**即将被替换**的
   *      列表追加旧数据；且它的回调因代次不符会直接返回，不会再碰闸门）；
   *   ② 放开 `loadingRef` —— 旧请求占着闸门时，新请求被自己的
   *      「已经在路上了」挡回去，表现为**拉了纹丝不动**；
   *   ③ ★ **清列表**（2026-10-11 用户：「学堂页面下拉刷新时，要将列表数据清空，等待新数据」）。
   *      ⚠ 旧版这里刻意**不清**（怕刷新失败时闪成空屏）—— 但那样屏幕上的旧列表跟
   *        刷新前长得一模一样，**看不出刷新到底有没有生效**。现在清成空屏 +「正在加载…」，
   *        成功与否都看得见（失败那条路会给「点这里重试」，不会把人困在空屏里）。
   * ⚠ 清空必须写在 `loadPage` **之前**：`loadPage` 会同步 `setPhase('loading')`，
   *   两件事在同一批里生效 ⇒ 一次渲染就是「空列表 + 正在加载」。
   * ⚠ 沿用当前筛选（`loadPage` 自己读 `filterRef`）：下拉刷的是「你正在看的
   *   这份列表」，**不是**清空筛选。
   * ⚠ 转圈必须在**真拉完**时收（`.finally`），不许 setTimeout 蒙时长：
   *   网慢时定时器先到 ⇒ 圈消失但数据没回来；且**失败也必须收圈**。
   */
  const onRefresh = useCallback(() => {
    if (!canBooks) return;
    genRef.current += 1;
    loadingRef.current = false;
    itemsRef.current = [];
    setItems([]);
    setTotal(0);        // ⚠ 不清的话工具栏那句「共 N 个 · 已加载 M 个」会挂着上一份的旧数字
    setRefreshing(true);
    /* ⚠⚠ **必须把 promise 交出去**：`PullRefresh` 就钉到它 resolve 才收圈。
       早退那条（`!canBooks`）故意返回 undefined ⇒ 立刻收圈，不会空挂着。
       详见 components/PullRefresh.tsx 顶部的契约。 */
    return loadPage(0, true)?.finally(() => setRefreshing(false));
  }, [canBooks, loadPage]);

  /* ---------------- 筛选（★ 过滤在服务端：换筛选 = 清列表 + 从第 0 条重拉） ---------------- */

  /**
   * 换一份筛选条件，并把列表**整个重置**后重拉。
   *
   * ⚠⚠ 三件事必须一起做，少一件就出鬼：
   *   ① `genRef++` 作废在飞的旧请求（否则旧数据会追加进新列表）；
   *   ② 清 `itemsRef` / `items` / `total` —— 不清的话「已加载 300 条」会被
   *      当成新筛选下的条数，分页 offset 从此整个错位；
   *   ③ 放开 `loadingRef` 闸门再拉 —— 旧请求占着闸门时，新请求会被自己的
   *      「已经在路上了」挡回去，表现为**点了确定列表一动不动**。
   *      （旧请求的回调因为代次不符会直接返回，不会再碰这个闸门。）
   * ⚠ 传到 `loadPage` 的 replace=true：新筛选的第一页是**替换**不是追加。
   */
  const reloadWithFilter = useCallback((next: any) => {
    setFilter(next);
    filterRef.current = next;   // ⚠ 同步落 ref：loadPage 是异步触发的
    genRef.current += 1;
    loadingRef.current = false;
    itemsRef.current = [];
    setItems([]);
    setTotal(0);
    loadPage(0, true);
  }, [loadPage]);

  /** 打开弹窗（⚠ 深拷草稿在组件内部做：visible 翻真时 clone(applied)） */
  const onFilterOpen = useCallback(() => {
    if (!canFilter) return;      // 后端不支持时入口本来就不给点
    setFltOpen(true);
  }, [canFilter]);

  /** 取消 / 点遮罩：关窗，草稿由组件丢弃（界面一个像素都不变） */
  const onFilterCancel = useCallback(() => {
    setFltOpen(false);
  }, []);

  /**
   * 「确定」：草稿 → 生效。⚠ 决策抽在 pf.applyPlan（可断言）：
   * 草稿没变 ⇒ 什么都不做（省一次往返）；变了（含「改回全部」）⇒ 重拉。
   */
  const onFilterConfirm = useCallback((draft: any) => {
    const plan = pf.applyPlan(draft, filterRef.current);
    setFltOpen(false);
    if (plan.action === 'close') return;
    reloadWithFilter(plan.filter);
  }, [reloadWithFilter]);

  /** 空态里那个「清除筛选」：回到不过滤（= 重拉全量） */
  const onResetFilter = useCallback(() => {
    if (!pf.hasFilter(filterRef.current)) return;
    reloadWithFilter(pf.emptyFilter());
  }, [reloadWithFilter]);

  /* ---------------- 样式 ---------------- */

  const s = useMemo(() => StyleSheet.create({
    page: {
      paddingTop: rpx(SIZES.pagePadTop),
      paddingBottom: rpx(SIZES.pagePadBottom),
      paddingHorizontal: rpx(SIZES.pagePadX),
      /* ⚠ flexGrow 给**空列表**用：内容不足一屏时撑满，空态块才有正常的上下留白 */
      flexGrow: 1,
    },
    /** ⚠⚠ 工具栏**显示着**时给滚动内容补的顶部留白（见 `toolBar` 注释）：
     *  工具栏是 FlatList 的兄弟、压在上面 ⇒ 不补这一段，第一条会钻到它底下。 */
    pageWithTools: { paddingTop: rpx(SIZES.toolBarGap) },
    /** 钉在列表上方的工具栏（目前只有筛选入口）。
     *  ⚠⚠ 它**只给横向留白与顶部留白**；**不许套 `s.page`**
     *  （那里面有 flexGrow，会把列表挤没 —— 记录页踩过同一个坑）。 */
    toolBar: {
      paddingTop: rpx(SIZES.pagePadTop),
      paddingHorizontal: rpx(SIZES.pagePadX),
      backgroundColor: '#f5f5f5',
    },
    /** ⚠ 列表内那行「共 3731 个 · 已加载 50 个」**已按用户要求移除**（2026-10-10）：
     *  工具栏的筛选入口右侧已经显示了同一句话，列表里再来一遍纯属重复。
     *  计数文案本身还在（`model.countText`，筛选入口 + 筛选弹窗两处仍在用）
     *  ⇒ **别把这一行加回来**。 */
    card: { backgroundColor: COLORS.bg },
    /** 一条书签：通栏白底 + 一条细缝分隔（3000+ 条的列表，卡片间距会拖得很长） */
    bmCard: {
      paddingVertical: rpx(20),
      paddingHorizontal: rpx(26),
      marginBottom: rpx(2),
    },
    /** 两行干支（⚠ 与记录页 recChars 同色同字重：同一份数据在两页长得一样） */
    bmChars: {
      fontSize: rpx(30),
      fontWeight: FONT_WEIGHTS.semibold,
      color: '#8a7a5c',
      lineHeight: rpx(30 * 1.5),
      letterSpacing: rpx(2),
    },
    /** 不是标准四柱时的兜底一行（原文显示，不硬拆格子） */
    bmPlain: { fontSize: rpx(28), color: COLORS.text },
    /** 出处：书名 · 卷一 · 篇名 */
    bmSrc: {
      marginTop: rpx(8),
      fontSize: rpx(22),
      color: COLORS.textGhost,
      lineHeight: rpx(22 * LINE_HEIGHTS.loose),
    },
    empty: { paddingTop: rpx(120), paddingBottom: rpx(80), alignItems: 'center' },
    emptyIcon: {
      width: rpx(SIZES.emptyIconSize),
      height: rpx(SIZES.emptyIconSize),
      borderRadius: rpx(SIZES.emptyIconSize / 2),
      backgroundColor: '#f0e9dc',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: rpx(24),
    },
    emptyIconText: { color: COLORS.goldLight, fontSize: rpx(SIZES.emptyIconFontSize) },
    emptyText: { fontSize: rpx(SIZES.emptyTextSize), color: COLORS.textMuted, textAlign: 'center' },
    /* ⚠ 2026-10-11 起没有 `emptyTip` 了：空态**只说事实、不教怎么做**（用户要求） */
    /** 底部状态条（加载中 / 没有更多了 / 失败重试） */
    foot: { paddingVertical: rpx(28), alignItems: 'center' },
    footText: { fontSize: rpx(22), color: COLORS.textGhost },
    /** 可点的「重试」「清除筛选」用金色 —— 与页面上其他地方的可点元素同一套语言 */
    footRetry: { color: COLORS.gold },
  }), [rpx]);

  /* ---------------- 渲染 ---------------- */

  const renderItem = useCallback(({ item }: { item: Item }) => {
    const rows = model.pillarRows(item.name);
    return (
      /* ⚠ 必须是 Pressable：书签条目可点（→ 阅读页）。原先是不带事件的 View，
         点了没反应 —— 用户 2026-10-04 报的就是这个。 */
      <Pressable
        style={[s.card, s.bmCard]}
        onPress={() => {
          /* ⚠⚠ 下拉刷新抬手那一拍不许顺带打开这条书签 —— 标记由 PullRefresh 维护 */
          if (isPulling()) return;
          /* ⚠ 不直接交 item：阅读页认的是 target（`{book, chapter, offset, name}`），
             而 item 上还挂着 `text` / `book`（书名）这些**不是定位信息**的字段。
             两者形状不同就该转一手（见 study/model.js 的 bookmarkTarget）。 */
          onOpenBookmark?.(model.bookmarkTarget(item) as any);
        }}
      >
        {rows.plain ? (
          <Text style={s.bmPlain}>{rows.stems}</Text>
        ) : (
          <View>
            <Text style={s.bmChars}>{rows.stems}</Text>
            <Text style={s.bmChars}>{rows.branches}</Text>
          </View>
        )}
        <Text style={s.bmSrc}>{model.sourceText(item)}</Text>
      </Pressable>
    );
  }, [s, onOpenBookmark]);

  const foot = model.footOf(phase, items.length, total);
  /**
   * 工具栏那两处（显示条件 / 内容留白）**必须**用同一个判据，改一处就得改另一处。
   * ⚠⚠ 判据里带 `phase === 'loading'`（★ 2026-10-11）：下拉刷新会把列表清空，
   *   这一瞬间若判否，整屏会往上跳一下、数据回来再跳回去 —— 看着像闪屏。
   *   而且「正在加载」本来就该能看见筛选入口（同一个 tab 里没换过筛选）。
   */
  const showTools = canBooks && (items.length > 0 || filtered || phase === 'loading');

  /**
   * 空列表时那一屏：不支持 / 加载中 / 失败 / **被筛空** / 真没有 —— 文案必须各不相同。
   * ⚠⚠ 2026-10-11 用户：「移除这种提示文字。以后做功能尽量不要出现这些提示文字」
   *   ⇒ 每屏**只留一句「事实」**，那几行「怎么做」的说明（去哪个文件夹放 docx /
   *   换个干支再试 / 切到学堂页会自动加载）连同 `emptyTip` 样式一起删掉。
   *   ⚠ 「被筛空」那一屏的出口**留着**（「清除筛选」是个按钮，不是说明文字）。
   */
  const renderEmpty = useCallback(() => {
    if (!canBooks) {
      return (
        <View style={s.empty}>
          <View style={s.emptyIcon}><Text style={s.emptyIconText}>籍</Text></View>
          <Text style={s.emptyText}>当前存储后端没有书籍数据</Text>
        </View>
      );
    }
    if (phase === 'fail') {
      return (
        <View style={s.empty}>
          <View style={s.emptyIcon}><Text style={s.emptyIconText}>籍</Text></View>
          <Text style={s.emptyText}>{model.emptyText(phase, errText, filtered)}</Text>
          <Pressable style={s.foot} onPress={onRetry}>
            <Text style={[s.footText, s.footRetry]}>点这里重试</Text>
          </Pressable>
        </View>
      );
    }
    /* ⚠⚠ 「被筛空」必须与「真的没有」分开：说成「还没有书籍书签」会让用户
       以为馆里的书签没了（同记录页的纪律）。给出口 —— 清除筛选看全部。 */
    if (filtered && phase !== 'loading') {
      return (
        <View style={s.empty}>
          <View style={s.emptyIcon}><Text style={s.emptyIconText}>滤</Text></View>
          <Text style={s.emptyText}>{model.emptyText(phase, errText, filtered)}</Text>
          <Pressable style={s.foot} onPress={onResetFilter}>
            <Text style={[s.footText, s.footRetry]}>清除筛选</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}><Text style={s.emptyIconText}>籍</Text></View>
        <Text style={s.emptyText}>{model.emptyText(phase, errText, filtered)}</Text>
      </View>
    );
  }, [canBooks, phase, errText, filtered, s, onRetry, onResetFilter]);

  return (
    /* ⚠⚠ 外层必须是 View（FlatList 不能当根容器把弹窗也装进去）：
       筛选弹窗的遮罩要 absolute 铺满**整屏**并压在列表之上，
       放进 FlatList 的 ListHeader 里会被裁剪、还会跟着列表滚（遮罩就不覆盖全屏了）。 */
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      {/*
        ===== 工具栏（筛选入口）=====
        ⚠⚠⚠ 必须是 FlatList 的**兄弟**、钉在它上方（同记录页那条红线：
          用户要求筛选始终可见）。放进 contentContainerStyle 里 ⇒ 跟着列表滚走；
          套 `s.page` ⇒ 里面的 flexGrow 会把列表挤没。
        ⚠ 列表为空且没有筛选、**也不在加载中**时才不显示：没有书签可筛，摆个入口只会占地方。
          （加载中要显示 —— 下拉刷新会先把列表清空，这时藏起来会让整屏跳一下。）
      */}
      {showTools ? (
        <View style={s.toolBar}>
          <FilterEntry
            picked={pf.totalPicked(filter)}
            countText={model.countText(items.length, total, filtered)}
            onPress={onFilterOpen}
            onReset={filtered ? onResetFilter : undefined}
            disabled={!canFilter}
          />
        </View>
      ) : null}

      {/*
        ===== 下拉刷新（★ 2026-10-10 二改：`PullRefresh` = **松手才刷**）=====
        ⚠⚠⚠ 为什么不用 RN 自带的 `RefreshControl`（上一版就是它）：安卓上它底层是系统
          `SwipeRefreshLayout`，**下拉一过阈值就回调 onRefresh**（不等松手）；
          而且它一抢到手势就给 JS 发 CANCEL、此后连手指抬起都收不到
          ⇒ 「留原生控件 + 把刷新推迟到松手」在原理上不成立。
          源码依据见 `components/PullRefresh.tsx` 顶部，别再回去试。
        ⚠ 现在是**零依赖**版（被动听 touch + 整块 translateY，不抢手势），
          与记录页**同一个组件**、同一套接法。
        ⚠ `onRefresh` 把 promise 交出去（刷新 = 重拉第一页、沿用当前筛选），
          `PullRefresh` 钉到它 resolve 才收圈；`!canBooks` 那条早退返回 undefined
          ⇒ 立刻收圈，不会把指示器空挂在上面。
      */}
      <PullRefresh refreshing={refreshing} onRefresh={onRefresh}>
      <FlatList
        style={{ flex: 1 }}
        data={items}
        keyExtractor={(_: Item, i: number) => String(i)}
        renderItem={renderItem}
        /* ⚠ 0.4 = 距底部还有 40% 视口高时就开始预取：等到真触底才要，
           用户会先滑到底、再干等一个网络往返（滚动手感一顿一顿的）。 */
        onEndReachedThreshold={0.4}
        onEndReached={onEndReached}
        /* 首屏只渲染一屏多一点，剩下的交给虚拟化按需来 */
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={9}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={
          foot.text ? (
            <Pressable style={s.foot} onPress={foot.retry ? onRetry : undefined} disabled={!foot.retry}>
              <Text style={[s.footText, foot.retry ? s.footRetry : null]}>{foot.text}</Text>
            </Pressable>
          ) : null
        }
        /* ⚠ 工具栏显示时才补顶部留白（判据与上面 `showTools` **同一份**） */
        contentContainerStyle={showTools ? [s.page, s.pageWithTools] : s.page}
      />
      </PullRefresh>

      {/*
        ===== 筛选弹窗（组件在 components/FilterModal.tsx，与记录页共用）=====
        ⚠ 计数那句用**生效**筛选算（列表此刻显示的就是它的结果），且与入口**同源** ——
          拿草稿算会显示「筛出 5 个」而列表里明明躺着 30 条。
      */}
      <FilterModal
        visible={fltOpen}
        applied={filter}
        countText={model.countText(items.length, total, filtered)}
        onConfirm={onFilterConfirm}
        onClose={onFilterCancel}
      />
    </View>
  );
}
