/**
 * 学堂页（tab 2）—— **壳**：顶部切换栏 + 两个常驻面板
 *
 * ============ 2026-10-11 改版：这里原来是「查询」的全部内容 ============
 * 用户要求顶部加切换栏（「查询」/「书籍」），并且**两个页面本身都要能被复用**。
 * 所以把原来这一整页的内容**原样搬到了 `QueryPane.tsx`**，这个文件只剩壳：
 *
 *        <SegTabs>                ← 查询 / 书籍
 *        ├─ QueryPane   （常驻）   ← 原来的全部内容，一行未改
 *        └─ BooksPane   （常驻）   ← 书架：登记在册的书（2026-10-11 填上内容）
 *
 * ⚠⚠⚠ 两个面板**常驻 + display 切**，绝不条件渲染。
 *   QueryPane 里装着已加载的书签、生效中的筛选、滚动位置 ——
 *   条件渲染（`pane === 'query' ? <QueryPane/> : <BooksPane/>`）会在切走的那一瞬间
 *   把它整个卸载，切回来时筛选没了、列表从第 0 条重拉、滚动回顶部。
 *   这是本项目反复踩过的坑（「三面板 / 四 tab 常驻 + display 切」同一条纪律）。
 *
 * ⚠ active 的语义**变窄了**：以前 = 「学堂 tab 显示中」，
 *   现在 = 「学堂 tab 显示中 **且** 我这个面板被选中」。于是 QueryPane 的懒加载
 *   （第一次 active 变 true 才拉第一页）自然变成「切到查询面板才拉」——
 *   一进来就点「书籍」的话，不会白发一个请求。
 *
 * ⚠ onOpenBookmark 原样透传给 QueryPane（App 接管 → 推入层开阅读页）。
 *
 * ⚠ 已知小瑕疵（先记着，本轮未处理）：QueryPane 的筛选弹窗遮罩只能铺到**面板**这一层，
 *   盖不住上面那条切换栏 —— 弹窗开着时切换栏仍可点。点了会连弹窗一起藏起来
 *   （面板被 display:none），切回来弹窗还在（state 没丢）。不算坏数据，但手感上该修；
 *   要修得把「有没有浮层打开」提到这一层来。
 *
 * ============ ⚠⚠ 2026-10-21：学堂**只限登录**才可以使用 ============
 * 用户要求「学堂模块也只限登录才可以使用」。挡在**壳**这一层，两个面板根本不挂载：
 *   · 未登录 ⇒ 只画一张说明卡 + 「去登录」（`model.GATE_LOGIN`），面板一个都不挂；
 *   · 已登录 ⇒ 正常的两面板。
 * ⚠ 为什么不是「面板照挂、只是隐藏」：书签 / 书架的数据**跟着账号走**，
 *   挂着的面板会带着**上一个人**的列表（本页常驻、state 不下线）；
 *   登出时把面板一起卸载，重新登录就是干净的一次冷加载 —— 顺带也免了未登录时的 401。
 * ⚠ 登录态靠 App 传下来的 `sessionRev` 当信号（本页常驻，`auth.isLoggedIn()`
 *   自己变了不会让 effect 重跑）—— 与设置页同一个口径。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SegTabs } from '../../components/SegTabs';
import type { SegTabItem } from '../../components/SegTabs';
import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS, RADII } from '../../theme/tokens';
import BooksPane from './BooksPane';
import QueryPane from './QueryPane';
import type { Item } from './QueryPane';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS */
const auth: any = require('../../core/auth.js');

type PaneKey = 'query' | 'books';

/**
 * ⚠ 页签文案**只写这一份**，交给 SegTabs 循环渲染 —— 别在 JSX 里再手写两个按钮
 *   （那样加一个面板要改三处：常量、按钮、面板）。
 */
const PANE_TABS: SegTabItem<PaneKey>[] = [
  { key: 'query', label: '查询' },
  { key: 'books', label: '书籍' },
];

export default function Study({
  active,
  onOpenBookmark,
  sessionRev,
  onGoLogin,
}: {
  /** 学堂这个 tab 是不是显示中（面板可见性还要再与选中项相与，见文件头） */
  active: boolean;
  /** 点开一条书签（App 接管 → 推入层开阅读页）。不传 = 条目不可点 */
  onOpenBookmark?: (item: Item) => void;
  /** 登录态版本号（登录成功 / 退出登录各 +1）—— 变了就重读登录态（本页常驻） */
  sessionRev: number;
  /** 去登录 —— 未登录时整页只留这一个出口 */
  onGoLogin: () => void;
}) {
  const rpx = useRpx();
  const [pane, setPane] = useState<PaneKey>('query');

  /**
   * 有没有登录 —— **依赖 sessionRev**（不是纯 useMemo()）。
   * ⚠ 本页常驻，登录 / 退出不会让它重新挂载；不靠这个信号就永远停在旧结论上
   *   （登出了还能继续看书签，登录了还挡在门外）。
   */
  const logged = useMemo(() => auth.isLoggedIn(), [sessionRev]);

  const s = useMemo(() => StyleSheet.create({
    /**
     * 两个面板**叠在同一个位置**。
     * ⚠ 显式写四边，不用 `StyleSheet.absoluteFillObject` —— 它在本项目里是
     *   `undefined`，会**静默不定位**（浮层直接塌成内容高度），这是踩过的坑。
     */
    pane: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    /** 没选中的那个只是藏起来，**不卸载**（见文件头那条红线） */
    hidden: { display: 'none' },
    /* ---- 未登录那张卡（见文件头「只限登录」那段）---- */
    gateWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: rpx(60) },
    gateCard: {
      width: '100%',
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.card),
      paddingVertical: rpx(40),
      paddingHorizontal: rpx(32),
      alignItems: 'center',
    },
    gateTitle: {
      fontSize: rpx(30),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.text,
      marginBottom: rpx(12),
    },
    gateBody: {
      fontSize: rpx(24),
      color: COLORS.textSub,
      lineHeight: rpx(24 * LINE_HEIGHTS.loose),
      marginBottom: rpx(26),
      textAlign: 'center',
    },
    gateBtn: { paddingVertical: rpx(10), paddingHorizontal: rpx(28) },
    gateBtnText: { fontSize: rpx(28), color: COLORS.gold, fontWeight: FONT_WEIGHTS.semibold },
  }), [rpx]);

  /* ⚠ 未登录：整页只剩这张卡（面板一个都不挂，理由见文件头） */
  if (!logged) {
    return (
      <View style={s.gateWrap}>
        <View style={s.gateCard}>
          <Text style={s.gateTitle}>{model.GATE_LOGIN.title}</Text>
          <Text style={s.gateBody}>{model.GATE_LOGIN.body}</Text>
          <Pressable style={s.gateBtn} onPress={onGoLogin}>
            <Text style={s.gateBtnText}>{model.GATE_LOGIN.action}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const showQuery = active && pane === 'query';
  const showBooks = active && pane === 'books';

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      {/* ⚠ 不要直接写 `onChange={setPane}`：Dispatch 的参数类型含函数形态，
          会把 SegTabs 的泛型 T 推断成 string（TS2322）。显式转发一下就好。 */}
      <SegTabs tabs={PANE_TABS} value={pane} onChange={(k) => setPane(k)} />

      <View style={{ flex: 1 }}>
        <View style={[s.pane, showQuery ? null : s.hidden]}>
          <QueryPane active={showQuery} onOpenBookmark={onOpenBookmark} />
        </View>
        <View style={[s.pane, showBooks ? null : s.hidden]}>
          {/* ⚠ 与「查询」面板**同一个回调**：App 那边只有一套阅读页 target，
              书签传「书 + 定位」，书传「书 + sec/para=null（整本分页）」
              —— 形状一样，只是定位不同（见 model.bookTarget）。 */}
          <BooksPane active={showBooks} onOpenBook={onOpenBookmark} />
        </View>
      </View>
    </View>
  );
}
