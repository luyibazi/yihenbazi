/**
 * PullRefresh —— **松手才刷**的下拉刷新（零依赖：只用 RN 自带的 `Animated` + touch 事件）
 *
 * ============ ⚠⚠⚠ 为什么不用 RN 自带的 `RefreshControl` ============
 * 安卓上它底层是系统 `SwipeRefreshLayout`：**下拉一过阈值就回调 `onRefresh`**（不等松手），
 * 就是用户报的「还没放手就刷了」。RN 没有开关可改。
 *
 * 而且它把别的路也堵死了：`ReactSwipeRefreshLayout.onInterceptTouchEvent` 一抢到手势就调
 * `NativeGestureUtil.notifyNativeGestureStarted` → `JSTouchDispatcher.onChildStartedNativeGesture`
 * 会给 JS 发一个 **CANCEL**，并把 `childIsHandlingNativeGesture` 置真，此后包括 ACTION_UP
 * 在内**全部直接 return**
 * （见 node_modules/react-native/ReactAndroid/.../uimanager/JSTouchDispatcher.kt:123-126）
 * ⇒ 「留原生控件 + 用 `onTouchEnd` 把真实刷新推迟到松手」这种双保险**在原理上不可能成立**
 *   （手指抬起那一拍根本到不了 JS）。所以只能整块自己做。
 *
 * ============ ⚠⚠⚠ 为什么也不用 react-native-gesture-handler ============
 * `GestureDetector` 把 handler 挂在 Wrap 里子元素的**原生视图**上，直接包住列表就是跟列表
 * 滚动抢同一个原生视图（前两版「拉不动且什么都不报」的根因）。这里一个字的手势都不抢。
 *
 * ============ 实现：被动 touch + 整块位移 ============
 * 两条已核实的源码事实撑起整个设计：
 *   ① `ReactRootView.requestDisallowInterceptTouchEvent()` 是**故意不调 super** 的
 *      （源码注释：为了别的 view 禁止拦截时仍能收到 onInterceptTouchEvent）
 *      ⇒ 列表原生滚动时，JS 侧照样收得到 MOVE / UP，不会像原生下拉那样被 CANCEL 掉；
 *   ② `topTouchMove` 在 `BaseViewConfig.android.js` 里注册的是 `bubbled: 'onTouchMove'`
 *      ⇒ 手指落在列表任意位置，事件都会冒泡到本组件这一层 View。
 *
 * 收到事件后只做两件事：位移交给 `Animated.Value` 把**整块**（指示器 + 列表）translateY 下去；
 * **松手时才决定**「刷」还是「弹回去」。位移挂在最外层、列表自己的滚动条一动不动，所以：
 *   · 列表在顶部时下拉 → 系统滚动本来就不动，不存在「双重位移」；
 *   · 列表不在顶部时下拉 → `atTop` 判否，**一个像素都不碰**，正常滚动。
 *
 * ============ 它现在也当「加载更早」用（阅读页，2026-10-13 晚·十二改）============
 * 阅读页把它套在正文流外面：**在顶端往下拽一下、松手** = 「把更早的一整片接在列表上方」
 * （`onRefresh` 里走的是**前插 + 按 seq 守位**，见 Reader 的 `onPullPrev`）。
 * 与另外三处的差别只有两样，**手感与判据一个字不改**：
 *   · 文案 —— `pullText` / `armedText` / `busyText`；
 *   · 开关 —— `enabled`（阅读页 = 上面还有没有没接上来的内容）。
 * ⚠⚠⚠ 为什么阅读页的「到顶再拽一下」**必须**用这套 touch 实现，而不是在 `onScroll` 里判
 *   `contentOffset.y < 0`：**安卓的 contentOffset 在顶部拖是恒 0**（不产生负值，系统
 *   overscroll 只是画一道辉光），靠 offset 判的手势在安卓上**根本不可能触发**；
 *   而本组件全程只被动听 touch，两端行为一致（这条与「不用 RefreshControl」同源）。
 *
 * ============ 必须守住的点 ============
 * ⚠⚠ `atTop` 靠给子列表**并一个 `onScroll`** 得来（`cloneElement` 只加 prop、不换组件）。
 *   这是本组件唯一需要知道「列表滚到哪」的地方，绝不许靠猜。
 * ⚠⚠ 子元素必须**恰好一个**，且是能滚的（`ScrollView` / `FlatList`）。
 * ⚠⚠ `onRefresh` **返回值会被 await**：指示器钉到它 resolve 为止（屏上转多久 = 真拉多久）。
 *   不返回也能用（`Promise.resolve(undefined)` 立刻收圈），但返回了才对得起来。
 * ⚠⚠ `overScrollMode='never'` / `bounces={false}` 是**必须注入**的：不注入的话安卓的边缘
 *   辉光、iOS 的橡皮筋会跟我们自己的位移叠在一起（视觉上位移变两倍）。
 * ⚠ 拖动过程**一次 setState 都没有**（位置纯走 Animated），只有跨过阈值那一拍才 setState
 *   换文案；而且 `cloneElement` 的结果被 `useMemo` 钉住 ⇒ 那一刻列表**不会**跟着重渲染。
 * ⚠ 下拉**不带任何前置条件**（空列表 / 拉失败 / 未登录都要能自救），所以这里也没有
 *   「禁用」开关 —— 越没数据的时候越需要它。
 * ⚠⚠⚠ **抬手那一拍不许顺带触发列表项的点击**（2026-10-11 用户报：下拉刷新一抬手，
 *   手指底下那本书就被打开了）。根因与修法都写在下面 `PULL` 那一段，一句话：
 *   本文件导出 `isPulling()`，列表项的 `onPress` 第一句 `if (isPulling()) return;`。
 *   ⚠ 绝不为此去抢 responder / 改手势路径（那就是前两版「拉不动」的老路）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { useRpx } from '../theme/rpx';
import { COLORS } from '../theme/tokens';

/** 指示器高度（rpx）= 刷新时钉住的位置 */
const HEAD_RPX = 88;
/** 松手触发刷新的位移阈值（rpx，**阻尼后**的位移） */
const THRESHOLD_RPX = 80;
/** 最大位移（rpx）：再拉也不动了，给一个「已经到底了」的手感 */
const MAX_RPX = 200;
/** 竖直判定阈值（rpx）：小于它只当手指抖动，不进入下拉 */
const SLOP_RPX = 12;
/** 阻尼：手指走 1px，指示器只走 0.8px（跟原生下拉一样，不是 1:1 刚体） */
const DAMPING = 0.8;
/** 松手后钉到刷新位的时长 */
const HOLD_MS = 140;
/** 弹回去的时长 */
const COLLAPSE_MS = 200;

/**
 * ⚠⚠⚠ 本次触摸是不是**下拉**？（模块级，三页共用）
 *
 * 为什么需要它：列表里那些**大块可点区域**（书籍封面 / 书签行 / 记录卡片）的高度远大于
 * `Pressability` 的 `pressRetentionOffset`（默认 20dp）⇒ 往下拽 100dp，手指**仍然落在
 * 同一格之内**、点击没被取消 ⇒ 「松手」被当成一次正常点击
 * ⇒ **下拉刷新一抬手，手指底下那本书就被打开了**
 * （2026-10-11 用户报：「我下刷新抬起手如果手在某本书籍上，这本书就会打开」）。
 *
 * ⚠ 为什么不在本组件里「抢一下手势」把点击顶掉：抢 responder（`onMoveShouldSetResponder*`）
 *   或 `setJSResponder` 都是跟列表抢同一个原生视图 —— 前两版「拉不动且什么都不报」就是这么来的，
 *   而且会顺手把「先下拉、再往上滚」这一串动作打断。**手势路径一个字节都不动**，只在旁边立个标记。
 *
 * 所以规矩是：列表项在 `onPress` 里**第一句**问一句 `if (isPulling()) return;`。
 * ⚠ 复位只有一处：`onTouchStart`（下一根手指一落下就清）。**绝不用 `setTimeout`** ——
 *   短了（抬手那一拍的事件还没派发完）会漏，长了会把紧接着的一次**真点击**吞掉。
 */
const PULL = { active: false };

/** 供列表里的可点元素自查：下拉手势进行中 ⇒ 抬手那一拍不要顺带打开东西 */
export function isPulling(): boolean {
  return PULL.active;
}

export type PullRefreshProps = {
  /** 父层是不是真在刷新（驱动文案；并与持有状态一起决定什么时候收圈） */
  refreshing: boolean;
  /** 触发刷新。⚠ 返回 promise 的话指示器会钉到它 resolve */
  onRefresh: () => any;
  /** ⚠ 必须**恰好一个**能滚的子元素（ScrollView / FlatList） */
  children: React.ReactElement<any>;
  /** 未过阈值时的文案（默认「下拉刷新」） */
  pullText?: string;
  /** 已过阈值、等松手时的文案（默认「松手刷新」） */
  armedText?: string;
  /** 钉住（正在拉）时的文案（默认「正在刷新…」） */
  busyText?: string;
  /**
   * 能不能拉。**默认 true**。
   *
   * ⚠⚠⚠ false ⇒ **一个像素都不碰**（手指全程让给列表），**也不触发** —— 与「不在顶部」
   *   走的是同一条早退。所以它必须像 `atTopRef` 一样**走 ref**（touch 回调里读 state
   *   拿到的会是上一帧的值）。
   *
   * ⚠ 它**不是**「禁用下拉刷新」那类开关：学堂页 / 书签页 / 记录页三处**都不许传 false**
   *   （那三处的契约是「下拉不带任何前置条件，空列表 / 拉失败 / 未登录都要能自救」）。
   *   目前唯一的使用者是**阅读页**：`enabled={layout.hasPrev}` —— 上面已经没有没接上来的
   *   内容时（书首），下拉不该还能「加载更多」（拉下去只会把同一片要一遍）。
   */
  enabled?: boolean;
};

export function PullRefresh({
  refreshing,
  onRefresh,
  children,
  pullText = '下拉刷新',
  armedText = '松手刷新',
  busyText = '正在刷新…',
  enabled = true,
}: PullRefreshProps) {
  const R = useRpx();
  const s = useMemo(() => makeStyles(R), [R]);

  const head = R(HEAD_RPX);
  const threshold = R(THRESHOLD_RPX);
  const maxPull = R(MAX_RPX);
  const slop = R(SLOP_RPX);

  /** 位移。⚠ 全程只用 `setValue` / `Animated.timing`，不进 state（拖动零重渲染） */
  const d = useRef(new Animated.Value(0)).current;
  /** 是否已过阈值（只用来换文案：下拉刷新 → 松手刷新） */
  const [armed, setArmed] = useState(false);
  /** 我们自己触发的刷新：指示器钉住 */
  const [holding, setHolding] = useState(false);

  /** 钉住 = 我们发起的 或 父层正在刷 */
  const pinned = holding || refreshing;
  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;

  /* ⚠ 「能不能拉」**同样走 ref**（理由与 pinnedRef 一样）：`onTouchMove` / `onTouchEnd`
     是原生事件回调，在那里读 prop 拿到的是**注册那一刻**的闭包值 —— 父层刚从 true
     变 false（阅读页：刚接完一片、正好到书首）时，这一拍还会照旧把整块拽下来。 */
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const atTopRef = useRef(true);      // ⚠ 初始必为真（挂载时就在顶部）
  const startY = useRef(0);
  const startX = useRef(0);
  const pullingRef = useRef(false);   // 本次手势是否已进入下拉
  const armedRef = useRef(false);     // armed 的 ref 版（touch 回调里读 state 会拿到旧值）
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const collapse = useCallback(() => {
    armedRef.current = false;
    setArmed(false);
    Animated.timing(d, {
      toValue: 0,
      duration: COLLAPSE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [d]);

  /* 收圈：pinned 从真落回假（父层 refreshing 归位 / 我们那个 promise 结束）。
     ⚠ `wasPinned` 是必须的：没有它，「本来就没在刷」的那一次渲染也会弹一次。 */
  const wasPinned = useRef(false);
  useEffect(() => {
    if (wasPinned.current && !pinned) collapse();
    wasPinned.current = pinned;
  }, [pinned, collapse]);

  const onTouchStart = useCallback((e: GestureResponderEvent) => {
    /* ⚠ 复位只能在这里（见上面 `PULL` 的注释：用定时器必错一头）——
       新的触摸一开始，「上一轮是不是下拉」就跟这一轮无关了。 */
    PULL.active = false;
    if (pinnedRef.current) return;
    startY.current = e.nativeEvent.pageY;
    startX.current = e.nativeEvent.pageX;
    pullingRef.current = false;
  }, []);

  const onTouchMove = useCallback(
    (e: GestureResponderEvent) => {
      /* ⚠ `!enabledRef.current` 与「不在顶部」**并成同一条早退**：不能拉时**一个像素都不碰**
         （不是在下面某处再判一次 —— 那样拖到一半才被叫停，位移已经出过一截了）。 */
      if (pinnedRef.current || !atTopRef.current || !enabledRef.current) return;
      const { pageY, pageX } = e.nativeEvent;
      const dy = pageY - startY.current;
      const dx = Math.abs(pageX - startX.current);

      if (!pullingRef.current) {
        /* ⚠⚠ 两道闸一起立：必须**往下**走（dy > slop）且**竖直优先**（dy > dx）。
           竖直不优先就不接 —— 列表里有横向能滚的东西时，「斜着划一下结果整块
           被拽下来」的错就出在这。 */
        if (dy <= slop || dx > dy) return;
        pullingRef.current = true;
        /* ⚠ 确认是下拉那一刻才立标记 —— 立早了，「斜着划一下」也会把底下的点击吞掉 */
        PULL.active = true;
        /* ⚠ 上一轮弹回如果还在飞，必须先停 —— 不停的话动画会一直盖住 setValue */
        d.stopAnimation();
      }

      const raw = Math.max(0, dy - slop);
      d.setValue(Math.min(maxPull, raw * DAMPING));

      const next = raw * DAMPING >= threshold;
      if (next !== armedRef.current) {
        armedRef.current = next;
        setArmed(next);
      }
    },
    [d, maxPull, slop, threshold],
  );

  const onTouchEnd = useCallback(() => {
    if (!pullingRef.current) return;
    pullingRef.current = false;

    /* 没钉着 + 没过阈值 → 不刷，弹回去。
       ⚠⚠ `!enabledRef.current` 也要走这一支：本轮拖到一半被禁用（父层拉到尽头了）⇒
          **弹回去就好，绝不许再触发一次**（否则「上面已经没有内容」还会去要一片）。 */
    if (pinnedRef.current || !armedRef.current || !enabledRef.current) {
      collapse();
      return;
    }

    /* ★ 松手 → 且过阈值 → **这里才开始刷**（用户要的就是这一拍） */
    armedRef.current = false;
    setArmed(false);
    setHolding(true);
    Animated.timing(d, {
      toValue: head,
      duration: HOLD_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      /* ⚠ 兜底：如果刷新已经在一帧内结束了（父层 `onRefresh` 直接 return），
         `pinned` 会被 React 批处理成「从头到尾都是假」⇒ 上面那个 effect 不会触发。
         这里再判一次，保证指示器不会永远停在刷新位。 */
      if (finished && !pinnedRef.current) collapse();
    });

    /* ⚠ `onRefresh` 可能同步抛，也可能同步 return，统一裹成 promise；
       `.catch` 吞掉 —— 刷新失败是父层的事（它自己有「重试」那条），
       这里只负责把指示器收回去，绝不能让异常把它卡住。 */
    Promise.resolve()
      .then(() => (onRefreshRef.current ? onRefreshRef.current() : undefined))
      .catch(() => {})
      .then(() => setHolding(false));
  }, [collapse, d, head]);

  /* ⚠⚠ 给子列表**并一个** onScroll（只为拿 contentOffset.y 判 atTop），
     顺手注入两个防重复位移的原生参数。`useMemo` 把结果钉住 ⇒
     本组件因为 `armed` 重渲染时，这个元素还是同一个对象，列表**不会**跟着重渲染。 */
  const only = React.Children.only(children) as React.ReactElement<any>;
  const scroller = useMemo(() => {
    const prev = (only.props as any).onScroll;
    return React.cloneElement(only, {
      onScroll: (e: any) => {
        const y = e?.nativeEvent?.contentOffset?.y ?? 0;
        atTopRef.current = !(y > 1);
        if (prev) prev(e);
      },
      /* ⚠ 16ms ≈ 一帧。默认值在安卓上不给保证，atTop 会变陈旧（该拦的没拦） */
      scrollEventThrottle: 16,
      /* ⚠⚠ 这两个是**必须**的：安卓的边缘辉光 / iOS 的橡皮筋会跟我们的位移叠加 */
      overScrollMode: 'never',
      bounces: false,
    });
  }, [only]);

  return (
    <View
      style={s.host}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <Animated.View style={[s.mover, { transform: [{ translateY: d }] }]}>
        {/* 指示器：绝对定位在可视区**上方**，位移动画把它拉进来（`host` 的 overflow 负责裁剪） */}
        <View
          style={[s.head, { top: -head, height: head }]}
          pointerEvents="none"
        >
          {pinned ? (
            <ActivityIndicator size="small" color={COLORS.gold} />
          ) : (
            <Text style={[s.arrow, armed && s.on]}>↓</Text>
          )}
          {pinned ? (
            <Text style={[s.label, s.on]}>{busyText}</Text>
          ) : (
            <Text style={[s.label, armed && s.on]}>{armed ? armedText : pullText}</Text>
          )}
        </View>
        {scroller}
      </Animated.View>
    </View>
  );
}

export default PullRefresh;

/** ⚠ 字号要跟着屏宽走 ⇒ 样式表必须在组件里用 useMemo 生成（别提到模块顶层） */
function makeStyles(R: (v: number) => number) {
  return StyleSheet.create({
    /* ⚠ `overflow: 'hidden'` 是**必须**的：指示器停在可视区外，靠它裁掉 */
    host: { flex: 1, overflow: 'hidden' },
    mover: { flex: 1 },
    head: {
      position: 'absolute',
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    arrow: { color: COLORS.textFaint, fontSize: R(30), lineHeight: R(34) },
    label: { color: COLORS.textMuted, fontSize: R(24), marginLeft: R(10) },
    /** 过阈值 / 正在刷新：整条转主题金 */
    on: { color: COLORS.gold },
  });
}
