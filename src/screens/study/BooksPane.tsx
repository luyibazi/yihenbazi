/**
 * 学堂 ·「书籍」面板 = **书架**（★ 2026-10-11 用户要求：
 *   「书籍页面从后端获取书籍列表，显示书籍。像书架功能」）
 *
 * ============ 数据从哪来（⚠⚠ 2026-10-19 换协议，这一节整段重写）============
 * 走 `GET /books`（`core/books.js` 的 `shelf()`），每本一条：
 *   `{ bookKey, slug, title, source, chapterCount, bookmarkCount, charCount }`
 *
 * ⚠⚠⚠ 以前这里**借的是** `/books/bookmarks` 响应里那个 `books[]`（「盘上扫到的所有书」），
 *   配 `model.SHELF_LIMIT = 1` 把 items 压到最小。换协议后**不能再这么借**，两个硬伤：
 *   ① 那个数组是 `GROUP BY book_key` 出来的 ⇒ 一本**一条书签都没有**的书压根不出现
 *      （书架凭空少书，而且不报错）；
 *   ② 它每次都要连带查全馆书签 —— 而书架**一条书签都不需要**。
 *
 * ⚠ 封面里那行「共计 N 案例」现在用的是 **`bookmarkCount`**（用户 2026-10-11 原话
 *   「数量就是书签的数量」）；老字段名是 `count`，跟着协议一起改掉。
 * ⚠ 换协议后**不会再有**「读不了的书」那种灰格子：解析失败的书根本不进表
 *   （只出现在 `/books/sync` 的 errors 里）⇒ `error` 字段与它那套样式一起删除了。
 *
 * ============ 版式（2026-10-11 用户：「将书本缩小，太大了」）============
 * **一行三本**，封面 220 × 280（32 开比例）。原先两列 340 宽 ≈ 手机上半屏一本书，太大。
 * 封面里只有「书名题签 + 底部一行案例数」，没有任何「怎么做」的说明文字。
 *
 * ============ 点一本书 ============
 * 点封面 → 交给 App 的同一个 `onOpenBookmark`（阅读页推入层），
 * target 由 `model.bookTarget(book)` 生成 —— ⚠ 那里 `chapter / offset` 显式给 **null**，
 * 阅读页据此「从书架进来」⇒ 恢复**本地阅读位置**。
 * 写成 `chapter: 0` 会被当成「用户点了第一章」，本地位置永远用不上（而且不报错）。
 *
 * ============ 懒加载（与 QueryPane 同一条约定）============
 * 第一次 `active` 变 true 才去拉（不是一挂载就拉）—— 这就是「懒」；
 * 下拉刷新（松手才刷）**先清空书架再重拉**（与查询面板同一条：等新数据，不要旧的挂在屏上）。
 *
 * ⚠ 只有自建后端（local）有这份数据（core/storeMode.js 的 supportsBooks）：
 *   其他模式**如实说明**，不发一个必然 404 的请求（那只会显示成「加载失败」）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS, SIZES } from '../../theme/tokens';
import { PullRefresh, isPulling } from '../../components/PullRefresh';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const books: any = require('../../core/books.js');
const storeMode: any = require('../../core/storeMode.js');

/** `/books` 的一项（core/books.js 原样透传） */
export type ShelfBook = {
  bookKey: string;
  slug: string;
  title: string;
  source?: string | null;
  chapterCount: number;
  bookmarkCount: number;
  charCount: number;
};

/**
 * 交给阅读页的 target。
 * ⚠ 与 QueryPane 的 `Item` 走**同一个构造函数**（`model.bookmarkTarget` 那条路
 *   在 App 里 spread 一条 item，形状完全一致）—— App 只认一套形状。
 * ⚠ `chapter` / `offset` 是 `number | null`，**null 与 0 语义不同**（见 model.bookTarget）。
 */
export type ShelfTarget = {
  name: string;
  chapter: number | null;
  offset: number | null;
  book: string;
};

type Phase = 'idle' | 'loading' | 'ok' | 'fail';

/**
 * 书脊色带 —— 按格子序号循环，让一屏书看起来是**一排书**而不是一堆同色方块。
 * ⚠ 全部落在米金/赭石这一族里（与全局配色同一套语言），别换成高饱和色。
 */
const TINTS = ['#a9814e', '#b99a63', '#8c6a3f', '#c2b280', '#7d6a52'];
/* ⚠ 曾有一个 `TINT_BAD`（读不了的书：色带退成灰）+ 配套的 `coverBad` / `labelTextBad`。
   2026-10-19 换协议后**不再有**「解析失败的书」这个状态（失败的书进不了表），
   三个一起删除 —— 留着常量与样式没人用，下次有人看见名字就会把它接回去。 */

export default function BooksPane({
  active,
  onOpenBook,
}: {
  /** 学堂 tab 显示中 **且**「书籍」被选中（面板可见性判据，见 Study.tsx） */
  active: boolean;
  /** 点开一本书（App 接管 → 推入层开阅读页）。不传 = 封面不可点 */
  onOpenBook?: (target: ShelfTarget) => void;
}) {
  const rpx = useRpx();
  /** 当前后端有没有这份数据（只有自建后端有） */
  const canBooks = storeMode.supportsBooks();

  const [list, setList] = useState<ShelfBook[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errText, setErrText] = useState('');

  /** 有没有开始加载过（切走再切回不重来 —— 与 QueryPane 同一条纪律） */
  const startedRef = useRef(false);
  /**
   * 请求代次：下拉刷新 +1。旧请求回来时对不上就整个丢掉。
   * ⚠ 不丢的话，先发的那次若**失败**、后发的已经成功，会把已经画好的书架
   *   打成失败态（内容明明在屏幕上）—— 这类「偶尔闪一下失败」最难查。
   */
  const genRef = useRef(0);
  /** 卸载 / 切走后在飞的请求回来，一律不许再碰 state */
  const aliveRef = useRef(true);

  /**
   * 拉书架清单。
   * ⚠ **必须 return 这个 promise**：下拉刷新的转圈要等它 resolve 才能收
   *   （见 components/PullRefresh.tsx 的契约）。靠定时器蒙时长的话，
   *   网慢时圈提前消失（用户以为刷完了），失败路径还收不了圈。
   */
  const load = useCallback(() => {
    if (!canBooks) return;              // 没有这份数据，别发必然失败的请求
    const gen = genRef.current;         // ⚠ 捕获本次的代次，回调里拿它对比
    setPhase('loading');

    return books.shelf().then((res: any) => {
      if (!aliveRef.current) return;
      if (gen !== genRef.current) return;   // 过期结果：连 phase 都不许碰

      if (!res.ok) {
        setPhase('fail');
        setErrText(res.error || '');
        return;
      }
      setList(Array.isArray(res.items) ? res.items : []);
      setPhase('ok');
    });
  }, [canBooks]);

  /* ---------------- 懒加载的入口：切到「书籍」面板才拉 ---------------- */
  useEffect(() => {
    aliveRef.current = true;
    if (!active) return;
    if (startedRef.current) return;
    startedRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [active, load]);

  /**
   * 作废「在飞的那一次请求」。
   * ⚠⚠ 抽成一个函数、而不是在两处各写一行 `genRef.current += 1`：
   *   两处各写一遍的话，将来漏改一处**不会有任何症状**（另一处还在加），
   *   而断言也只能看到一个「文件里出现过 +1」—— 标准的假绿。
   */
  const bumpGen = useCallback(() => { genRef.current += 1; }, []);

  /* ---------------- 下拉刷新（★ 松手才刷，重拉一次清单） ---------------- */
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    if (!canBooks) return;                    // 早退返回 undefined ⇒ 指示器立刻收圈
    bumpGen();                                // 作废在飞的那次
    /* ★ 2026-10-11 用户：「学堂页面下拉刷新时，要将列表数据清空，等待新数据」——
       书架在**同一个学堂页**里，同一条规矩（两个面板别只改一个）。
       ⚠ 清空之后屏上是「正在加载…」（`renderEmpty` 按 phase 分的），失败则给「点这里重试」，
         不会把人困在空屏里 —— 这也是敢清空的底气。 */
    setList([]);
    setRefreshing(true);
    return load()?.finally(() => setRefreshing(false));
  }, [canBooks, load, bumpGen]);

  /**
   * 失败后那枚「点这里重试」。
   * ⚠ 走**自己**这条路，不复用 `onRefresh`：复用的话按一下按钮会顺手把
   *   `refreshing` 置真 ⇒ 顶上**凭空弹出一个下拉转圈**（手根本没下拉）。
   */
  const onRetry = useCallback(() => {
    bumpGen();
    load();
  }, [load, bumpGen]);

  /* ---------------- 样式 ---------------- */
  const s = useMemo(() => StyleSheet.create({
    page: {
      paddingHorizontal: rpx(24),
      paddingTop: rpx(SIZES.pagePadTop),
      paddingBottom: rpx(60),
      /* ⚠ flexGrow 给**空列表**用：内容不足一屏时撑满，空态块才有正常的上下留白 */
      flexGrow: 1,
    },
    /**
     * 三列：220 × 3 + 21 × 2 间隙 + 24 × 2 外边距 = 747 ≈ 750（设计稿宽度）。
     * ⚠ 2026-10-11 用户：「将书本缩小，太大了」—— 原先是两列 340 宽（≈ 手机上半屏一本书）。
     * ⚠⚠ 2026-10-21 用户：「最后一排有两本书，一个靠左一个靠右，中间隔了一块」——
     *   原先是 `space-between`（把不满一行的书推到两端）。改成**定宽 + 固定间隙**：
     *   未满的三本照样从左边排，右边留白，跟书架上「书从左往右摆」的直觉一致。
     *   ⚠ 间隙必须用 `columnGap` 显式给，别再靠 space-between 均分 —— 那是同一个 bug 的成因。
     */
    row: { justifyContent: 'flex-start', columnGap: rpx(21) },
    cell: { width: rpx(220), marginBottom: rpx(26) },

    /** 封面：米金纸底 + 左侧书脊色带（`overflow:'hidden'` 是让色带跟着圆角走） */
    cover: {
      width: rpx(220),
      height: rpx(280),      // 220 × 1.27 ≈ 32 开的比例
      borderRadius: rpx(6),
      backgroundColor: COLORS.goldBgSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.border,
      overflow: 'hidden',
    },
    spine: { position: 'absolute', left: 0, top: 0, bottom: 0, width: rpx(12) },

    /** 题签：古籍封面上那块贴纸，长了能折行（书名最长 14 个字） */
    label: {
      position: 'absolute',
      left: rpx(22),
      right: rpx(10),
      top: rpx(30),
      paddingVertical: rpx(10),
      paddingHorizontal: rpx(8),
      borderRadius: rpx(4),
      backgroundColor: 'rgba(255, 255, 255, 0.74)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.borderLight,
    },
    labelText: {
      fontSize: rpx(21),
      fontWeight: FONT_WEIGHTS.semibold,
      color: '#6b5a3e',
      textAlign: 'center',
      lineHeight: rpx(21 * LINE_HEIGHTS.normal),
    },
    /* ⚠ 曾有一行 `labelTextBad`（读不了的书：灰字）—— 随「解析失败的书不进表」一起删除。 */

    /**
     * ⭐ 封面**之内**的那行案例数（2026-10-11 用户：「书籍封面上要显示：共计多少案例」）。
     * 压在封面底部、与题签同宽（left/right 用同一组缩进），中间那段纸面留白正好把
     * 「书名在上、数字在下」分开；字比书名小一号、颜色同族更淡 —— 它是数字，不是标题。
     */
    count: {
      position: 'absolute',
      left: rpx(22),
      right: rpx(10),
      bottom: rpx(20),
      alignItems: 'center',
    },
    countText: {
      fontSize: rpx(19),
      color: '#8a7550',
      lineHeight: rpx(19 * LINE_HEIGHTS.normal),
    },

    /* 空态（与 QueryPane 同一套语法：圆圈 + 一个字 + 两行说明） */
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
    /** 可点的「重试」用金色 —— 与页面上其他地方的可点元素同一套语言 */
    retry: { paddingVertical: rpx(26), alignItems: 'center' },
    retryText: { fontSize: rpx(24), color: COLORS.gold },
  }), [rpx]);

  /* ---------------- 渲染 ---------------- */
  const renderItem = useCallback(({ item, index }: { item: ShelfBook; index: number }) => {
    /* ⚠ 换协议后没有「读不了的书」了（解析失败的书进不了表）⇒ 不再有 `bad` 分支、
       也不再有灰底灰字与 `disabled`。这一整条判据随 `error` 字段一起删除。 */
    const tint = TINTS[index % TINTS.length];
    return (
      <Pressable
        style={s.cell}
        onPress={() => {
          /* ⚠⚠ 下拉刷新抬手那一拍不许顺带打开这本书（封面很大，手指很容易还落在格内）——
             标记由 PullRefresh 维护，见那边的 `PULL` 注释。 */
          if (isPulling()) return;
          onOpenBook?.(model.bookTarget(item));
        }}
      >
        <View style={s.cover}>
          {/* 书脊色带：让一屏书看起来是「一排书」而不是一堆同色方块 */}
          <View style={[s.spine, { backgroundColor: tint }]} />
          <View style={s.label}>
            {/* ⚠ 最多 4 行：再长的书名截断，宁可少显示也不要撑破封面 */}
            <Text style={s.labelText} numberOfLines={4}>
              {model.bookTitle(item.title || item.slug)}
            </Text>
          </View>
          {/* ⭐ 2026-10-11 用户：「书籍封面上要显示：共计多少案例。数量就是书签的数量」
              ⇒ 直接端服务端算好的 `bookmarkCount`，**不在前端自己数**。
              ⚠ count=0 的书不显示这一行 —— 封面上写「共计 0 案例」是负面信息，不如不写。 */}
          {item.bookmarkCount > 0 ? (
            <View style={s.count}>
              <Text style={s.countText} numberOfLines={1}>
                共计 {item.bookmarkCount} 案例
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  }, [s, onOpenBook]);

  /**
   * 空列表时那一屏：不支持 / 加载中 / 失败 / 真的还没有书 —— 文案必须各不相同。
   * ⚠⚠ 2026-10-11 用户：「把 .docx 放进登记的书籍文件夹即可 —— 移除这种提示文字。
   *   以后做功能尽量不要出现这些提示文字」⇒ 空态里**只留一句「事实」**
   *   （`shelfEmptyText`：还没有 docx / 读不到的原话 / 正在加载…），
   *   下面那行「怎么做」的说明连同 `emptyTip` 样式一起删掉。
   */
  const renderEmpty = useCallback(() => {
    if (!canBooks) {
      return (
        <View style={s.empty}>
          <View style={s.emptyIcon}><Text style={s.emptyIconText}>架</Text></View>
          <Text style={s.emptyText}>当前存储后端没有书籍数据</Text>
        </View>
      );
    }
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}><Text style={s.emptyIconText}>架</Text></View>
        <Text style={s.emptyText}>{model.shelfEmptyText(phase, errText)}</Text>
        {/* ⚠ 失败必须给出口：没有「重试」的话，用户除了切走再回来没有任何办法 */}
        {phase === 'fail' ? (
          <Pressable style={s.retry} onPress={onRetry}>
            <Text style={s.retryText}>点这里重试</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }, [canBooks, phase, errText, s, onRetry]);

  return (
    /* ⚠ 外层必须是 View（FlatList 不能当根容器）—— 与其他面板同一写法 */
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      {/* ⚠ 2026-10-11 用户：「将书签等提示字移除」—— 原先这里还有一条汇总行
             （「共 13 本 · 3717 条书签」），它和每本书下面那行一起删掉了。
             现在整屏只有「封面 + 书名」，顶上不再压任何东西（顶部留白改由
             `s.page` 的 paddingTop 给 —— 面板是常驻的，少一层结构就少一处漂移）。 */}
      <PullRefresh refreshing={refreshing} onRefresh={onRefresh}>
        <FlatList
          style={{ flex: 1 }}
          data={list}
          /* ⚠ key 用 `bookKey`：它是 docx 内容哈希，书架里唯一；书名会重（两本同名书），
             拿 title 当 key 会撞 —— RN 对重复 key 直接警告 + 渲染错乱。 */
          keyExtractor={(it: ShelfBook) => it.bookKey}
          renderItem={renderItem}
          numColumns={3}
          /* ⚠ 每格宽度由 `cell.width` 定死（不是 flex:1）——
             用 flex:1 的话，最后一行只剩一本时那本会被拉成整屏宽。 */
          columnWrapperStyle={s.row}
          /* 首屏两行多一点，剩下的交给虚拟化 */
          initialNumToRender={9}
          maxToRenderPerBatch={9}
          windowSize={7}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={s.page}
        />
      </PullRefresh>
    </View>
  );
}
