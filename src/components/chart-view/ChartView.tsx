/**
 * 排盘结果视图
 *
 * 「盘长什么样」全部收在这里：四柱/藏干、右侧选中运面板、大运/流年/流月三张表
 * 以及它们之间的联动。页面只负责「拿数据 + 传进来」，不碰版式 —— 这样以后
 * 记录详情、对比页、分享页都直接 <ChartView record={rec} /> 复用同一份盘面，
 * 不会出现「第二份四柱代码」。
 *
 * ⚠ 计算全部在 ./model.js 里（原组件纯函数的逐行搬运），本文件只画 + 接手势。
 *   这样联动逻辑可以在 Node 里直接断言，不必启动模拟器。
 *
 * ⚠ 版式上的硬约束（都来自原项目 chart-view.ttss 的注释，改动前先读）：
 *   · .page / .card 左右 padding **必须保持 0** ——
 *     运程三张表的可用宽 = 750 − 2×0 − 2×0 − 竖排标题 52 = 698rpx，
 *     列宽 63rpx 就是拿这个 698 反推的（一屏 11 列）。
 *     一旦左右补上内边距（哪怕 20rpx），可用宽掉到 646rpx：
 *       运程表 ÷ 63 = 10 列，「一屏 11 列」不成立；四柱右侧面板从 330 掉到 282rpx，
 *       三张选中卡各 74rpx，藏干放不下。
 *   · .card 必须**直角，无圆角**（用户要求「结果页的背景都不要有圆角」）。
 *     按钮不在管辖内（.btn-outline 仍是胶囊）。
 *   · .pillar-cols 定宽 420rpx = 4 列 96rpx + 3 个间隙 12rpx。
 *   · 行式表格（2026-10-08 照问真「专业细盘」改）的横向预算 = **行头 80 + 间隙 8 + 4×96 = 472rpx**。
 *     ⚠ 行头 80 是从 88 让出来的 8rpx —— 给行头右侧留出间隙，让行头与第 1 柱别贴死；
 *       让出的正好是这 8rpx，所以四柱总宽没变、不会右溢出。
 *   · 干支字号 54rpx × 行高 1.2 —— 行式下天干/地支各占一行，占位格等高即 65rpx。
 *     ⚠ 列式时代的 130rpx（= 两行）在行式下是**幽灵高度**，见 tokens 的 selTextMinHeight。
 *   · 三张表列宽写死同一个 63rpx —— «大运 = 流年 = 流月» 的单项宽度必须完全一致。
 */
import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Switch } from 'react-native';

import * as M from './model';
import QiDingPage, { makeStyles as makeDingStyles } from './QiDingPage';
import QiPingPage, { makeStyles as makePingStyles } from './QiPingPage';
import SameBaziSheet from './SameBaziSheet';
import { COLORS, SIZES, RADII, LINE_HEIGHTS, FONT_WEIGHTS } from '../../theme/tokens';
import { useRpx } from '../../theme/rpx';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const sameBazi: any = require('../../core/sameBazi.js');

export type ChartViewProps = {
  /** 排盘记录；传 null 或没有 chart 字段时渲染空态 */
  record?: any;
  /** 事件记录（key → { text, … }）；传空对象 = 这块功能没开（不画任何标记） */
  notes?: Record<string, any>;
  /** 某格被**长按**了 → detail: { key, title, meta } */
  onNote?: (v: { key: string; title: string; meta: any }) => void;
  /** 空态里的按钮被点了 */
  onEmpty?: () => void;
  /** 这条盘是否已保存在记录里 —— 只影响头部姓名的兜底文案（未保存显示「未保存」） */
  saved?: boolean;
  /** 测试用：固定「今年」，让默认选中项可复现 */
  nowYear?: number;
  /**
   * 「同」检索到的一条**记录**被点了。
   * ⚠ 拿到的是服务端原始记录，**转换（toHandoff）由页面做** ——
   *   这个组件不该知道结果页/记录页的数据口径（见 SameBaziSheet 文件头）。
   */
  onOpenSameRecord?: (rec: any) => void;
  /** 「同」检索到的一条**书签**被点了（`/books/bookmarks` 的 item，转换由页面做） */
  onOpenSameBookmark?: (item: any) => void;
};

export default function ChartView({
  record = null,
  notes = {},
  onNote,
  onEmpty,
  saved = false,
  nowYear,
  onOpenSameRecord,
  onOpenSameBookmark,
}: ChartViewProps) {
  const rpx = useRpx();
  const styles = useMemo(() => makeStyles(rpx), [rpx]);
  /** 两个「页」各自的样式表（都走同一份 tokens，主题改一处两边一起变） */
  const ding = useMemo(() => makeDingStyles(rpx), [rpx]);
  const ping = useMemo(() => makePingStyles(rpx), [rpx]);

  /**
   * ★ 2026-10-18：「定气法 / 平气法」开关 = **选哪一页**。
   * false = 定气法（左边，用户自己做的四柱 + 大运流年流月）
   * true  = 平气法（右边，UI 照抄定气法，数据和算法走 pingqi-bazi.js）
   * ⚠ 语义写在名字里：别退回 `headOn` 这种不知道哪一头是啥的名字。
   */
  const [pingQi, setPingQi] = useState(false);
  /** 平气法那一份盘面：第一次切过去才现算（不在首屏付平气法的计算成本） */
  const [pingState, setPingState] = useState<any>(null);

  /**
   * ★ 2026-11-15：「同」= 按这张盘的八字去自己的记录 + 学堂书签里找同样的。
   *
   * ⚠⚠ 检索条件是**定气法**的四柱（下面 handler 里读 `state.pillars`），
   *   **不是** `pingState.pillars` —— 用户原话「排盘结果页面的定气法的八字作为条件」。
   *   哪怕页面上正显示着平气法，条件也不变（理由见 core/sameBazi.js 文件头）。
   * ⚠ 结果不缓存：每次点都重新问一遍服务端 —— 记录可能刚存、书签可能刚加，
   *   留一份旧结果比多一次往返更糟。
   */
  const [sameOn, setSameOn] = useState(false);
  const [sameLoading, setSameLoading] = useState(false);
  const [sameData, setSameData] = useState<any>(null);
  const [sameChars, setSameChars] = useState<string[]>([]);

  const [state, setState] = useState<any>(() => M.buildChartData(record, nowYear));  /** 当前上下文（dk / di / lnIdx）—— 供 notes 变化时重算标记、以及长按取 meta 用 */

  /**
   * 点「同」：先开弹层（立刻给反馈，不等网络），再取条件并发检索。
   * ⚠ 条件必须在**点击那一刻**从 `state.pillars` 里取（而不是从 sameChars 取）——
   *   `sameChars` 只是上一次的展示残留，用它会让条件慢一拍。
   */
  const onSamePress = useCallback(() => {
    setSameOn(true);
    setSameLoading(true);
    setSameData(null);
    const chars = sameBazi.charsOf(state.pillars);
    setSameChars(chars);
    sameBazi.find(state.pillars).then((r: any) => {
      setSameData(r);
      setSameLoading(false);
    });
  }, [state.pillars]);

  const closeSame = useCallback(() => setSameOn(false), []);
  /**
   * 行式表格数据：model.buildPillarRows 组装（纯数据、可断言），视图只画。
   * 四柱 + 选中运卡在**同一批行**里 —— 两块区域天然共行对齐。
   */
  const pillarRows = useMemo(
    () => M.buildPillarRows(state.pillars, state.selCards, state.shenshaByPillar),
    [state.pillars, state.selCards, state.shenshaByPillar],
  );
  /** 平气法的行式表格数据（结构与定气法完全相同，视图那一边照抄的就是同一套） */
  const pingRows = useMemo(
    () => M.buildPillarRows(
      (pingState && pingState.pillars) || [],
      (pingState && pingState.selCards) || [],
      (pingState && pingState.shenshaByPillar) || [],
    ),
    [pingState],
  );
  const ctxRef = useRef<any>({});
  /** 原始流年行（含流月），不进渲染状态 */
  const rowsRef = useRef<any[]>([]);
  const recRef = useRef<any>(record);
  recRef.current = record;

  /**
   * 装配整块盘面。
   * 首帧直接是完整盘面（不会先闪一下空态）—— 原项目靠 attached 早于首帧渲染，
   * 这里靠 useState 的惰性初始化达到同样效果。
   */
  useEffect(() => {
    // ⚠ any：core 是冻结的 JS，buildChartData 两个分支返回的形状不同，
    //   TS 只按字面量推断会把 dayuns/_defaultIdx 当成「不存在」。运行时一直都有。
    const base: any = M.buildChartData(record, nowYear);
    if (!base.ready) {
      setState(base);
      ctxRef.current = {};
      return;
    }
    setState(base);

    // 大运 / 流年 / 流月三级联动：默认落在当前所处的大运与今年的流年上
    if (base.dayuns.length) {
      selectDayun(base.dayuns, base._defaultIdx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, nowYear]);

  /**
   * ★ 平气法那一份盘面（与上面那段**完全独立**，互不放依赖）。
   * ⚠ 只在开关切到平气法时才现算；算一次就留住，来回切不重排、不丢选中态。
   * ⚠ 不许碰 state / ctxRef / rowsRef —— 那些是定气法的，混用就是「切页签把状态带走」。
   */
  useEffect(() => {
    if (!pingQi) return;
    if (pingState) return;
    const base: any = M.buildChartData(record, nowYear, 'pingqi');
    if (!base.ready || !base.dayuns.length) {
      setPingState(base);
      return;
    }
    /*
     * 默认选中「当前所处的那一步」+「今年的流年」——与定气法同一套口径，
     * 只是算法换成平气法（computeDayunRows 走平气分支）。
     * ⚠ setTables 吃的是**原始行**（含流月），所以先算 rows 再交给它。
     */
    const idx = base._defaultIdx;
    const { rows, lnIdx } = M.computeDayunRows(record, base.dayuns, idx, nowYear, 'pingqi');
    const list = M.withActive(base.dayuns, idx);
    const dk = (list[idx] && list[idx].key) || '';
    const ctx = { dk, di: idx, lnIdx };
    // ⚠ 给点击回调用的两份「当前值」——没有它们，点流年 / 流月都找不到父级
    pingRowsRef.current = rows;
    pingCtxRef.current = ctx;
    const out = M.setTables(
      record,
      list,
      M.buildLiunians(rows, lnIdx),
      lnIdx >= 0 ? M.buildLiuyues(rows[lnIdx]) : [],
      ctx,
      notes,
    );
    setPingState({ ...base, ...out });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pingQi, record, nowYear]);

  /**
   * 三张表 + 四柱右侧面板的唯一出口。
   * 面板内容是从三张表的选中项推导出来的，所以必须和表格在同一次 setState 里写，
   * 否则会出现「表格已换、面板还是上一次的」中间态。
   * 事件记录（格子标记 + 内联正文）也在这里一起落 —— 三张表换了，
   * 挂在上面的标记就必须跟着换，分两次写会出现「格子已经翻页、红点还在原处」。
   */
  const setTables = useCallback((dayuns, liunians, liuyues, ctx) => {
    const nextCtx = ctx || ctxRef.current;
    ctxRef.current = nextCtx;
    const out = M.setTables(recRef.current, dayuns, liunians, liuyues, nextCtx, notes);
    setState((s: any) => ({ ...s, ...out }));
  }, [notes]);

  /**
   * notes 变了（页面刚存完一条事件）→ 只用现有三张表重算一遍标记。
   * 不重排盘：三张表的选中项没变，变的只有「哪几格有事件」。
   */
  useEffect(() => {
    setState((s: any) => {
      if (!s.ready) return s;
      const out = M.setTables(recRef.current, s.dayuns, s.liunians, s.liuyues, ctxRef.current, notes);
      return { ...s, ...out };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  /**
   * 选中某一步大运 → 现算该步的流年（0 号位是起运前的小运阶段），
   * 并在流年中默认选中「今年」（今年不在该区间则取第一年）。
   */
  const selectDayun = useCallback(
    (dayuns: any[], idx: number) => {
      const rec = recRef.current;
      if (!rec) return -1;

      const { rows, lnIdx } = M.computeDayunRows(rec, dayuns, idx, nowYear);
      rowsRef.current = rows;

      const list = M.withActive(dayuns, idx);
      // 大运 key 直接取表项的 key（'pre' 或 'd0'..'d11'）—— 事件记录的 key 里就用它，
      // 别在别处再算一遍「下标换算」，那种两处推导必然会漂
      const dk = (list[idx] && list[idx].key) || '';

      setTables(
        list,
        M.buildLiunians(rows, lnIdx),
        lnIdx >= 0 ? M.buildLiuyues(rows[lnIdx]) : [],
        { dk, di: idx, lnIdx },
      );
      return lnIdx;
    },
    [nowYear, setTables],
  );

  // 点大运列 → 该步的流年 + 默认选中今年
  const onPickDayun = useCallback(
    (idx: number) => {
      selectDayun(state.dayuns, idx);
    },
    [state.dayuns, selectDayun],
  );

  // 点流年列 → 该年的流月
  const onPickLiunian = useCallback(
    (idx: number) => {
      const row = rowsRef.current[idx];
      if (!row) return;
      const dk = ctxRef.current.dk || '';
      setTables(
        state.dayuns,
        M.withActive(state.liunians, idx),
        M.buildLiuyues(row),
        { dk, di: ctxRef.current.di, lnIdx: idx },
      );
    },
    [state.dayuns, state.liunians, setTables],
  );

  // 点流月列 → 仅切换高亮（ctx 传 undefined = 沿用当前的大运 / 流年选择）
  const onPickLiuyue = useCallback(
    (idx: number) => {
      setTables(state.dayuns, state.liunians, M.withActive(state.liuyues, idx), undefined);
    },
    [state.dayuns, state.liunians, state.liuyues, setTables],
  );

  /* ============ 事件记录：长按某一格 → 请页面弹编辑框 ============
     组件只负责「这一格是哪一格」+ 这句话该叫什么，**不碰存储、不碰弹窗**。
     页面拿着 key 去读写这条记录的 notes。
     ⚠⚠ 2026-10-21 用户：「长按只有流年可以输入记录。大运，流月长按功能都移除掉」
       ⇒ **只留流年**。大运 / 流月两路传下面这个空函数把它关掉 ——
         页面那张表（QiDingPage / QiPingPage）里长按是 `onNote?.(idx)`，
         传空函数即「按下去了，但什么都不发生」，**不必改那个组件一个字符**
         （QiDingPage 是用户自己做的，只读）。 */

  const noNote = useCallback(() => {}, []);

  const askNote = useCallback(
    (level: string, dk: string, lnIdx: number | null, lyIdx: number | null, meta: any, keyOverride?: string) => {
      const notesLib = require('../../core/notes.js');
      onNote?.({
        key: keyOverride || notesLib.key(level, dk, lnIdx, lyIdx),
        title: notesLib.titleOf(level, meta),
        meta,
      });
    },
    [onNote],
  );

  /* ⚠ 大运长按（`onNoteDayun`）已删：2026-10-21 用户要求「只留流年」。 */

  const onNoteLiunian = useCallback(
    (idx: number) => {
      const notesLib = require('../../core/notes.js');
      const it = state.liunians[idx];
      const dk = ctxRef.current.dk || '';
      if (!it || !dk) return;
      const meta: any = { year: it.year, ganzhi: it.gz, age: it.age };
      const up2 = M.dayunMetaOf(ctxRef.current, state.dayuns);
      if (up2) meta.up2 = up2;   // 大运那一行自己没写正文时，靠它才有标题
      /* ⚠⚠⚠ 交运那一年在**前后两步大运**的表里各出现一次（上下两半），
         长按必须落到**同一条记录**（用户 2026-10-21：「不分交运切割…总之长按都是用一个」）：
         先按公历年份找已存在的那条，复用它；没有才按当前大运算新 key。 */
      askNote('liunian', dk, idx, null, meta, notesLib.liunianKeyByYear(notes, it.year));
    },
    [state.dayuns, state.liunians, notes, askNote],
  );

  /* ⚠ 流月长按（`onNoteLiuyue`）已删：2026-10-21 用户要求「只留流年」。
     它原来要连父流年的年份 / 虚岁一起带上（事件记录页没有「父流年」这个概念），
     这段 meta 拼装随功能一起删掉 —— 别只把入口藏起来还留着死代码。 */

  /* ============ 平气法那一套回调（**独立的一份**，与上面 6 个互不相干） ============
     用户 2026-10-18：「平气法的大运流年流月为什么不可以点击切换呢？」
     根因：上面 6 个回调写死读 `state` / `ctxRef` / `rowsRef`（全是定气法的），
     递给平气法页就等于「点了改的是定气法」—— 平气法自己那份永远不动 ⇒ 看着像点不动。
     ⚠ 规则与定气法逐条一致（点大运→换流年并默认选今年；点流年→换流月；点流月→只切高亮），
       只是操作对象换成 pingState / pingCtxRef / pingRowsRef。
     ⚠ 不许复用上面那几个 —— 那会把两边的选中态串在一起。 */
  const pingCtxRef = useRef<any>({});
  const pingRowsRef = useRef<any[]>([]);

  const onPingPickDayun = useCallback((idx: number) => {
    setPingState((s: any) => {
      if (!s || !s.ready) return s;
      const { rows, lnIdx } = M.computeDayunRows(record, s.dayuns, idx, nowYear, 'pingqi');
      pingRowsRef.current = rows;
      const list = M.withActive(s.dayuns, idx);
      const dk = (list[idx] && list[idx].key) || '';
      pingCtxRef.current = { dk, di: idx, lnIdx };
      const out = M.setTables(
        record, list,
        M.buildLiunians(rows, lnIdx),
        lnIdx >= 0 ? M.buildLiuyues(rows[lnIdx]) : [],
        { dk, di: idx, lnIdx }, notes,
      );
      return { ...s, ...out };
    });
  }, [record, nowYear, notes]);

  const onPingPickLiunian = useCallback((idx: number) => {
    setPingState((s: any) => {
      if (!s || !s.ready) return s;
      const row = pingRowsRef.current[idx];
      if (!row) return s;
      const c = pingCtxRef.current;
      const ctx = { dk: c.dk || '', di: c.di, lnIdx: idx };
      pingCtxRef.current = ctx;
      const out = M.setTables(
        record, s.dayuns, M.withActive(s.liunians, idx), M.buildLiuyues(row), ctx, notes,
      );
      return { ...s, ...out };
    });
  }, [record, notes]);

  const onPingPickLiuyue = useCallback((idx: number) => {
    setPingState((s: any) => {
      if (!s || !s.ready) return s;
      const out = M.setTables(
        record, s.dayuns, s.liunians, M.withActive(s.liuyues, idx), undefined, notes,
      );
      return { ...s, ...out };
    });
  }, [record, notes]);

  /* ================= 渲染 ================= */

  if (!state.ready) {
    return (
      <View style={styles.page}>
        <View style={[styles.card, styles.empty]}>
          <View style={styles.emptyIcon}>
            <Text style={styles.emptyIconText}>盘</Text>
          </View>
          <Text style={styles.emptyText}>还没有排盘数据</Text>
          <Text style={styles.emptyTip}>回到「排盘」页填写出生时间开始</Text>
          <Pressable onPress={onEmpty} style={styles.backBtn}>
            <Text style={styles.backBtnText}>去排盘</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      {/* ===== 基本信息：身份区 + 出生时间区 ===== */}
      <View style={[styles.card, styles.headCard]}>
        <View style={styles.headId}>
          <Text style={styles.headName}>
            {/* ⚠ 未保存的盘，record 层会把空名兜成「未命名」（core/record.js slim）。
                用户 2026-10-03 指出：还没保存就说「未命名」有误导 ——
                应该说「未保存」（它强调的是状态，不是身份）。 */}
            {record?.name === '未命名' && !saved ? '未保存' : record?.name}
          </Text>
          <Text style={styles.headTag}>{state.genderText}</Text>
          {state.zodiacText ? <Text style={styles.headTag}>{state.zodiacText}</Text> : null}
        </View>
        <View style={styles.headTimes}>
          <View style={styles.headTime}>
            <Text style={styles.headKey}>农历</Text>
            <Text style={styles.headVal}>{state.lunarFullText}</Text>
            {/*
              ★ 2026-10-18：定气法 / 平气法 开关。
              ⚠⚠ 放在**农历这一行的右端**（用户：「将按钮的位置放到和农历公历同行」）。
              ⚠ 两侧文字各 `flexShrink: 0`、农历那串 `flex:1` 可缩 —— 名称再长也只会折农历，
                不会把「定气法/平气法」挤成两行或顶出去。
              ⚠ 它切的是下面那一整块「页」（见 renderQiPage），不是只改个字段。
            */}
            <View style={styles.qiWrap}>
              {/* 使用中的那一侧金色高亮，另一侧灰色（2026-10-19 用户要求） */}
              <Text style={[styles.qiLabel, !pingQi && styles.qiLabelActive]}>定气法</Text>
              <Switch
                value={pingQi}
                onValueChange={setPingQi}
                trackColor={{ false: COLORS.border, true: COLORS.gold }}
                thumbColor={COLORS.bg}
                style={styles.qiSwitch}
              />
              <Text style={[styles.qiLabel, pingQi && styles.qiLabelActive]}>平气法</Text>
            </View>
          </View>
          <View style={styles.headTime}>
            <Text style={styles.headKey}>公历</Text>
            <Text style={styles.headVal}>
              {record?.dateText} {record?.timeText}
            </Text>
            {/*
              ★ 2026-11-15 用户：「在定气法平气法切换按钮下面增加一个按钮，名称为 同」，
                后改为「最好和公历同一排」⇒ 挂在公历行的右端。
              ⚠ 位置约束：它是这一行的第三个孩子，`headVal` 是 flex:1、它自己 flexShrink:0
                ⇒ 公历再长也只会让文字折行，不会把按钮挤出去、也不会撑破卡片。
              ⚠ `marginRight` 那 6rpx 是对齐用的：上面那颗 Switch 被 scaleX(0.72) 缩过，
                layout 还是 51，视觉只占中间 36.7 ⇒ 右端天然比容器边缘缩进约 7rpx，
                按钮跟着缩进一点，两行的右端才落在同一条竖线上。
              ⚠ 高度跟着这一行走（padding 4 + 21×1.15 的行高）—— 它是行内的一颗小胶囊，
                不是独立的一行，别加 minHeight / marginTop 之类把它撑出去。
            */}
            <Pressable
              style={[styles.sameBtn, sameLoading ? styles.sameBtnOff : null]}
              onPress={onSamePress}
              disabled={sameLoading}
              hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.sameBtnText}>同</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/*
        ★ 2026-10-18 用户：「你做平气法的内容吧，ui 就抄定气法的。」
        ⚠⚠ **两块都挂、用 display 切**，不是三元运算符二选一 —— 同 Result 的页签写法：
          每一页里都有三张横向 ScrollView 和一个选中态，卸载再挂会丢掉
          「正在看哪一步大运 / 滚到第几列」（GzTable 的锚点只在挂载时滚一次）。
        ⚠⚠ 定气法那一块的 props / 数据源**一个字都没动**（用户：不要改动定气法任何代码）。
          平气法那块吃自己那一份 pingState / pingRows。
      */}
      <View style={pingQi ? styles.pianOff : undefined}>
        <QiDingPage
          state={state}
          pillarRows={pillarRows}
          ctx={ctxRef.current}
          rpx={rpx}
          styles={ding}
          onPickDayun={onPickDayun}
          onPickLiunian={onPickLiunian}
          onPickLiuyue={onPickLiuyue}
          /* ⚠ 大运 / 流月传空函数 = **长按无效**（只留流年，用户 2026-10-21）；
             那张表里是 `onNote?.(idx)`，给不了回调就只有「按了没反应」。 */
          onNoteDayun={noNote}
          onNoteLiunian={onNoteLiunian}
          onNoteLiuyue={noNote}
        />
      </View>
      <View style={pingQi ? undefined : styles.pianOff}>
        <QiPingPage
          state={pingState}
          pillarRows={pingRows}
          ctx={pingCtxRef.current}
          rpx={rpx}
          styles={ping}
          onPickDayun={onPingPickDayun}
          onPickLiunian={onPingPickLiunian}
          onPickLiuyue={onPingPickLiuyue}
          /* ⚠ 大运 / 流月传空函数 = **长按无效**（只留流年，用户 2026-10-21）；
             那张表里是 `onNote?.(idx)`，给不了回调就只有「按了没反应」。 */
          onNoteDayun={noNote}
          onNoteLiunian={onNoteLiunian}
          onNoteLiuyue={noNote}
        />
      </View>

      {/*
        「同」检索结果弹层。
        ⚠ 放在**两页之外**（不带 pianOff）：它是全屏 Modal，与「当前看哪一页」无关。
        ⚠ 点某一条后先关弹层再跳 —— 否则从记录页重新进来时它会盖在新盘上面。
      */}
      <SameBaziSheet
        visible={sameOn}
        loading={sameLoading}
        data={sameData}
        chars={sameChars}
        /* ⚠ 条件永远来自**定气法**（用户明确要求），所以这里写死「定气法」。
           平气法那一页看到这张弹层时，这行小字就是「为什么结果和当前这张盘对不上」的答案。 */
        source="定气法"
        onClose={closeSame}
        onOpenRecord={(rec: any) => {
          setSameOn(false);
          if (onOpenSameRecord) onOpenSameRecord(rec);
        }}
        onOpenBookmark={(item: any) => {
          setSameOn(false);
          if (onOpenSameBookmark) onOpenSameBookmark(item);
        }}
      />
    </View>
  );
}

function makeStyles(rpx: (v: number) => number) {
  return StyleSheet.create({
    // ===== 页面 =====
    page: {
      // ⚠⚠ 左右内边距**必须保持 0** —— 见文件头「一屏 11 列」的预算说明
      paddingTop: rpx(SIZES.pagePadTop),
      paddingBottom: rpx(SIZES.pagePadBottom),
      paddingHorizontal: rpx(SIZES.pagePadX),
      backgroundColor: '#f5f2ec',
      overflow: 'hidden',
    },
    card: {
      backgroundColor: COLORS.bg,
      borderRadius: RADII.none,   // 用户要求：结果页背景一律直角
      marginBottom: rpx(SIZES.cardGap),
    },

    // ===== 空态 =====
    empty: {
      paddingTop: rpx(120),
      paddingBottom: rpx(80),
      alignItems: 'center',
    },
    emptyIcon: {
      width: rpx(SIZES.emptyIconSize),
      height: rpx(SIZES.emptyIconSize),
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: rpx(24),
      backgroundColor: '#f0e9dc',
    },
    emptyIconText: {
      fontSize: rpx(SIZES.emptyIconFontSize),
      color: COLORS.goldLight,
    },
    emptyText: {
      fontSize: rpx(SIZES.emptyTextSize),
      color: COLORS.textMuted,
    },
    emptyTip: {
      fontSize: rpx(SIZES.emptyTipSize),
      color: COLORS.textGhost,
      marginTop: rpx(12),
    },
    // 空态按钮：**跟随全局的胶囊形状**，别按成直角
    //（「结果页一律直角」只管卡片 / 面板这类背景块，按钮不算）
    backBtn: {
      marginTop: rpx(32),
      paddingVertical: rpx(12),
      paddingHorizontal: rpx(36),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#d8cbb3',
      borderRadius: rpx(RADII.btn),
    },
    backBtnText: {
      fontSize: rpx(26),
      color: COLORS.gold,
    },

    // ===== 基本信息卡 =====
    headCard: {
      paddingTop: rpx(SIZES.headCardPadTop),
      paddingHorizontal: rpx(SIZES.headCardPadX),
      paddingBottom: rpx(SIZES.headCardPadBottom),
    },
    headId: {
      flexDirection: 'row',
      alignItems: 'baseline',
      paddingBottom: rpx(10),
    },
    qiWrap: {
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: rpx(8),
    },
    qiLabel: {
      flexShrink: 0,
      color: COLORS.textMuted,
      fontSize: rpx(SIZES.headKeySize),
    },
    /* 使用中的一侧：金色（qiLabel 默认灰，只有 active 才上金） */
    qiLabelActive: {
      color: COLORS.gold,
    },
    /* ⚠ iOS 的 Switch 自带 51×31 的点数尺寸，缩放会连命中区一起缩 —— 但仍比撑破一行好 */
    qiSwitch: {
      marginHorizontal: rpx(4),
      transform: [{ scaleX: 0.72 }, { scaleY: 0.72 }],
    },
    headName: {
      flexShrink: 0,
      fontSize: rpx(SIZES.headNameSize),
      fontWeight: FONT_WEIGHTS.semibold,
      lineHeight: rpx(SIZES.headNameSize * 1.3),
      color: COLORS.text,
      marginRight: rpx(12),
    },
    headTag: {
      flexShrink: 0,
      marginRight: rpx(10),
      paddingVertical: rpx(4),
      paddingHorizontal: rpx(12),
      backgroundColor: COLORS.goldBgSoft,
      color: '#8a7a5c',
      fontSize: rpx(SIZES.headTagSize),
      lineHeight: rpx(SIZES.headTagSize * LINE_HEIGHTS.compact),
      overflow: 'hidden',
    },
    headTimes: {},
    headTime: {
      flexDirection: 'row',
      /* ⚠ `center` 不是 `baseline`：右边那颗 Switch 没有文字基线，baseline 会让整行错位 */
      alignItems: 'center',
      marginTop: rpx(2),
    },
    headKey: {
      flexShrink: 0,
      width: rpx(SIZES.headKeyWidth),
      color: COLORS.gold,
      fontSize: rpx(SIZES.headKeySize),
      lineHeight: rpx(SIZES.headKeySize * LINE_HEIGHTS.normal),
    },
    headVal: {
      flex: 1,
      color: '#777777',
      fontSize: rpx(SIZES.headValSize),
      lineHeight: rpx(SIZES.headValSize * LINE_HEIGHTS.normal),
    },

    /* ===== 「同」按钮（2026-11-15）=====
       ⚠ 挂在**公历行右端**（用户：「最好和公历同一排」），行内的一颗小胶囊，
         不是独立的一行 —— 所以这里没有 marginTop / minWidth 那一套「占位」写法。
       ⚠ 尺寸刻意做小：它旁边是 23rpx 的公历正文，胶囊高度不越过一行的行高，
         否则整张信息卡会被它顶出一条空白。
       ⚠ 底色用 goldBgSoft（与姓名旁的标签同一档淡金）：描边单独存在时在纯白卡上
         太像一段普通文字，加了这层才看得出是「可以点的」。 */
    sameBtn: {
      flexShrink: 0,
      minWidth: rpx(52),
      marginLeft: rpx(12),
      marginRight: rpx(6),
      paddingVertical: rpx(4),
      paddingHorizontal: rpx(14),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.gold,
      borderRadius: rpx(RADII.btn),
      backgroundColor: COLORS.goldBgSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** 检索进行中：描边转灰、底色拿掉（⚠ 文字不动颜色 —— 它还在一行里，改色会跳） */
    sameBtnOff: { borderColor: COLORS.border, backgroundColor: 'transparent' },
    sameBtnText: {
      fontSize: rpx(21),
      lineHeight: rpx(21) * LINE_HEIGHTS.tight,
      color: COLORS.gold,
    },

    // ===== 页：定气法 / 平气法 由开关切 =====
    /**
     * 切走的那一页**不卸载**，只收起来（display none 的等价物）。
     * ⚠⚠ 别改成三元运算符二选一：定气法那一页有三张横向 ScrollView + 选中态，
     *   卸载再挂会丢掉「正在看哪一步大运 / 滚到第几列」（GzTable 的锚点只在挂载时滚一次）。
     * ⚠ 也不能用 opacity/height 之类：收起的那页仍会吃手势、撑高度。
     */
    pianOff: {
      display: 'none',
    },
  });
}


