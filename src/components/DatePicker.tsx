/**
 * 出生时间点选面板
 *
 * 逻辑层 `core/datepick.js` 是**原样搬过来的**（零改动，287 条对拍断言守着）——
 * 本文件只负责「画出来 + 接手势」。所以这里没有任何历法换算，
 * 所有换算都通过 `dp.view()` / `dp.pick()` / `dp.resolve()` 拿。
 *
 * 版式照原项目 components/date-picker：
 *   底部弹层 88vh 高，flex column；
 *   头部（取消 / 步骤标题 / 确定）→ 面包屑 → 翻区条（仅选年）→ 可滚动网格 → 底部预览。
 *
 * 与原项目的差异（都是平台差异，不是设计变更）：
 *   · `tt:if` → 条件渲染；`tt:for` → .map()
 *   · `scroll-into-view` → ScrollView 的 scrollTo / 初始 contentOffset
 *   · `bindtap` → Pressable 的 onPress
 *   · 组件样式隔离 → 这里天然没有全局样式，不需要留副本
 */
import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Modal,
  useWindowDimensions,
} from 'react-native';

import * as dp from '../core/datepick';
import { COLORS, SIZES, RADII, LINE_HEIGHTS, FONT_WEIGHTS } from '../theme/tokens';
import { useRpx } from '../theme/rpx';

/** 面板占屏高比例（与原项目 .dp-panel 的 88vh 一致） */
const PANEL_HEIGHT_RATIO = 0.88;

/** 每格的高度（rpx）—— 日格更高，留给节气小字 */
const CELL_HEIGHT = 68;
const DAY_CELL_HEIGHT = 112;
const DAY_CELL_LINE_HEIGHT = 71;

export type DatePickerProps = {
  visible: boolean;
  /** solar | lunar —— 农历口径下年 / 月 / 日三格换成农历 */
  calendar?: 'solar' | 'lunar';
  /** 真值：公历 YYYY-MM-DD（两种历法对外都只认公历） */
  date?: string;
  /** 真值：HH:mm */
  time?: string;
  /** 选完「分」自动触发，或点「确定」 */
  onSelect?: (v: { date: string; time: string; text: string; hint: string }) => void;
  onClose?: () => void;
};

/** 一步的状态：原项目把 state 放在 this.state 上（不进 data），这里用 useRef */
type PickState = ReturnType<typeof dp.fromSolar>;
/** 五步（core/datepick.js 的 STEPS）—— ⚠ core 那边没导出 Step 类型，这里按它的字面量对齐 */
type Step = 'year' | 'month' | 'day' | 'hour' | 'minute';

export default function DatePicker({
  visible,
  calendar = 'solar',
  date = '1990-01-01',
  time = '00:00',
  onSelect,
  onClose,
}: DatePickerProps) {
  const rpx = useRpx();
  const { height: screenHeight } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(rpx), [rpx]);

  const stateRef = useRef<PickState | null>(null);
  const [step, setStep] = useState<Step>('year');
  /** 仅年格：强制铺哪一区（翻区按钮点的）。null = 按已选年份推导 */
  const [segIndex, setSegIndex] = useState<number | null>(null);
  /** 每次 open 递增，用来强制 ScrollView 重新应用初始滚动位置 */
  const [openSeq, setOpenSeq] = useState(0);

  const gridRef = useRef<ScrollView>(null);

  // 展开的那一刻重建状态：上一次的真值 + 当前历法，从「年」这一步起步。
  // ⚠ 原项目在 visible 的 observer 里做这件事；这里用 useEffect 等价实现。
  useEffect(() => {
    if (!visible) return;
    stateRef.current = dp.fromSolar(date, time, calendar);
    setStep('year');
    setSegIndex(null);
    setOpenSeq((n) => n + 1);
  }, [visible, date, time, calendar]);

  // 摊平成模板要的几份数据（换算全在 core/datepick 里）
  // ⚠ any 不是偷懒：core 是冻结的 JS，view 返回的对象形状在 TS 眼里缺 done/active/term
  //   这些字段（它们只在其分支里 push）。运行时一直都有，别为类型去改 core。
  const view: any = useMemo(() => {
    if (!visible || !stateRef.current) return null;
    return dp.view(stateRef.current, step, segIndex == null ? undefined : segIndex);
  }, [visible, step, segIndex, openSeq, date, time, calendar]);

  /** 点某一格：记账 → 自动进下一步；「分」点完就交回去（五步走完） */
  const onPick = useCallback(
    (v: number) => {
      if (!stateRef.current || !view) return;
      const r = dp.pick(stateRef.current, view.grid.step, v);
      stateRef.current = r.state;
      if (r.done) {
        const pr = dp.resolve(r.state);
        onSelect?.({ date: pr.date, time: pr.time, text: pr.text, hint: pr.hint });
        return;
      }
      setStep(r.step);
      setSegIndex(null);
      setOpenSeq((n) => n + 1);   // 换步后重新滚到选中格
    },
    [view, onSelect],
  );

  /**
   * 翻区：「前 120 年」= -1、「后 120 年」= +1。
   * 只换年格铺哪一区，**不动已选年份**（所以不推进步骤）；
   * 到头了直接不动 —— 按钮虽然有置灰样式，但置灰的节点在真机上照样会派发点击。
   */
  const onSegShift = useCallback(
    (d: -1 | 1) => {
      const seg = view?.grid.seg;
      if (!seg) return;
      const next = seg.index + d;
      if (next < 0 || next >= seg.total) return;
      setSegIndex(next);
    },
    [view],
  );

  const onConfirm = useCallback(() => {
    if (!stateRef.current) return;
    const pr = dp.resolve(stateRef.current);
    onSelect?.({ date: pr.date, time: pr.time, text: pr.text, hint: pr.hint });
  }, [onSelect]);

  /**
   * 首次布局 / 换步后把选中格滚进可视区。
   * 原项目用 `scroll-into-view` + id，RN 里换成「算行号 × 行高」——
   * 因为网格是固定列宽 + 固定行高的，行高可以精确算出来，比 onLayout 测量更稳
   * （长列表里 onLayout 到达时机不定，容易先滚错位置）。
   */
  const onGridLayout = useCallback(() => {
    if (!view) return;
    const g = view.grid;
    const cols = g.cols;
    // anchor 而不是 current：选中的那年不在当前区时 current 那格不存在
    const row = Math.floor(g.anchor / cols);
    const cellH = g.step === 'day' ? DAY_CELL_HEIGHT : CELL_HEIGHT;
    const y = row * rpx(cellH + 12);   // +12 = .dp-slot 的上下 padding 6+6
    gridRef.current?.scrollTo({ y: Math.max(0, y - rpx(80) * 2), animated: false });
  }, [view, rpx]);

  if (!visible || !view) return null;

  const g = view.grid;
  const panelHeight = screenHeight * PANEL_HEIGHT_RATIO;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.mask}>
        {/* 遮罩点击取消；面板本体用 Pressable 拦住（对应原项目的 catchtap） */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={[styles.panel, { height: panelHeight }]}>
          <View style={styles.head}>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.act}>取消</Text>
            </Pressable>
            <Text style={styles.title}>{g.title}</Text>
            <Pressable onPress={onConfirm} hitSlop={8}>
              <Text style={[styles.act, styles.actOn]}>确定</Text>
            </Pressable>
          </View>

          <View style={styles.crumb}>
            {view.crumb.map((c) => (
              <Pressable
                key={c.step}
                onPress={() => {
                  setStep(c.step);
                  setSegIndex(null);
                }}
              >
                <Text
                  style={[
                    styles.crumbItem,
                    c.done && styles.crumbDone,
                    c.active && styles.crumbOn,
                  ]}
                >
                  {c.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {g.step === 'year' && g.seg ? (
            <View style={styles.segbar}>
              <Pressable onPress={() => onSegShift(-1)} hitSlop={6}>
                <Text style={[styles.segbtn, !g.seg.hasPrev && styles.segbtnOff]}>
                  ‹ 前 120 年
                </Text>
              </Pressable>
              <Text style={styles.segnow}>{g.seg.label}</Text>
              <Pressable onPress={() => onSegShift(1)} hitSlop={6}>
                <Text style={[styles.segbtn, !g.seg.hasNext && styles.segbtnOff]}>
                  后 120 年 ›
                </Text>
              </Pressable>
            </View>
          ) : null}

          <ScrollView
            ref={gridRef}
            style={styles.grid}
            contentContainerStyle={styles.cells}
            onLayout={onGridLayout}
            scrollEventThrottle={16}
          >
            {g.items.map((it) => {
              const isDay = g.step === 'day';
              const on = it.v === g.current;
              return (
                <View key={it.v} style={[styles.slot, { width: `${100 / g.cols}%` }]}>
                  <Pressable
                    onPress={() => onPick(it.v)}
                    style={[
                      styles.cell,
                      isDay && styles.cellDay,
                      on && styles.cellOn,
                    ]}
                  >
                    <Text style={[styles.cellText, on && styles.cellTextOn]}>
                      {it.label}
                      {/* 年格的干支后缀（只有年格带 gz，月 / 日 / 时 / 分不带）——
                          小一号 + 浅一档，只当「我在挑哪一年」的辅助，不抢年份数字。
                          ⚠ 口径是农历年（正月初一为界），不是排盘年柱（立春为界）。 */}
                      {it.gz ? (
                        <Text style={[styles.gzText, on && styles.gzTextOn]}> {it.gz}</Text>
                      ) : null}
                    </Text>
                    {/* 节气点：只有「日」格带 term（年 / 月 / 时 / 分不带） */}
                    {it.term ? (
                      <View style={styles.term} pointerEvents="none">
                        <Text style={styles.termName}>{it.term.name}</Text>
                        <Text style={styles.termTime}>{it.term.time}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>

          <Text style={styles.foot}>{view.preview.text}</Text>
          {view.preview.hint ? <Text style={styles.footHint}>{view.preview.hint}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(rpx: (v: number) => number) {
  return StyleSheet.create({
    mask: {
      flex: 1,
      backgroundColor: COLORS.scrim,
      justifyContent: 'flex-end',
    },
    panel: {
      width: '100%',
      backgroundColor: COLORS.bg,
      borderTopLeftRadius: rpx(RADII.panel),
      borderTopRightRadius: rpx(RADII.panel),
      // 全面屏底部横条（RN 里由 SafeArea 处理，这里留出基础留白）
      paddingBottom: rpx(40),
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: rpx(26),
      paddingHorizontal: rpx(32),
      paddingBottom: rpx(10),
    },
    title: {
      fontSize: rpx(30),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.text,
    },
    act: {
      fontSize: rpx(28),
      color: COLORS.textFaint,
      paddingVertical: rpx(8),
      paddingHorizontal: rpx(4),
    },
    actOn: {
      color: COLORS.gold,
      fontWeight: FONT_WEIGHTS.semibold,
    },
    crumb: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingTop: rpx(4),
      paddingHorizontal: rpx(26),
      paddingBottom: rpx(14),
    },
    crumbItem: {
      fontSize: rpx(24),
      lineHeight: rpx(24 * LINE_HEIGHTS.compact),
      color: '#c8c8c8',
      paddingVertical: rpx(6),
      paddingHorizontal: rpx(12),
      marginRight: rpx(8),
      marginBottom: rpx(8),
      borderRadius: rpx(8),
      overflow: 'hidden',
    },
    crumbDone: {
      color: COLORS.textSub,
      backgroundColor: '#f7f7f7',
    },
    crumbOn: {
      color: COLORS.gold,
      backgroundColor: COLORS.goldBgSoft,
    },
    segbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: rpx(24),
      paddingBottom: rpx(12),
    },
    segbtn: {
      fontSize: rpx(24),
      lineHeight: rpx(24 * LINE_HEIGHTS.compact),
      color: COLORS.gold,
      backgroundColor: COLORS.bgSoft,
      paddingVertical: rpx(10),
      paddingHorizontal: rpx(24),
      borderRadius: rpx(RADII.btn),
      overflow: 'hidden',
    },
    segbtnOff: {
      color: '#d9d2c6',
      backgroundColor: '#fbfaf8',
    },
    segnow: {
      flex: 1,
      textAlign: 'center',
      fontSize: rpx(24),
      lineHeight: rpx(24 * LINE_HEIGHTS.compact),
      color: '#b3a68e',
    },
    grid: {
      flex: 1,   // 面板里唯一可伸缩的一块
    },
    cells: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingTop: rpx(6),
      paddingHorizontal: rpx(20),
      paddingBottom: rpx(20),
    },
    slot: {
      padding: rpx(6),
    },
    cell: {
      position: 'relative',
      height: rpx(CELL_HEIGHT),
      // 数字在整格里居中；节气小字绝对定位贴底，不影响它
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: rpx(RADII.cell),
      backgroundColor: COLORS.bgSoft,
    },
    cellDay: {
      height: rpx(DAY_CELL_HEIGHT),
    },
    cellOn: {
      backgroundColor: COLORS.goldBg,
    },
    cellText: {
      fontSize: rpx(26),
      lineHeight: rpx(DAY_CELL_LINE_HEIGHT),
      color: '#444444',
      textAlign: 'center',
    },
    cellTextOn: {
      color: COLORS.gold,
      fontWeight: FONT_WEIGHTS.semibold,
    },
    /**
     * 年格里的干支后缀（如「1990 庚午」里的「庚午」）。
     * 嵌在年份那段 Text 里面（RN 的嵌套 Text 可以单独改字号 / 颜色），
     * 所以宽度是跟着年份数字走的 —— 4 位数 + 干支合起来约 100rpx，
     * 而 4 列时一格内有 175rpx，放得下，不需要换行或加高。
     */
    gzText: {
      fontSize: rpx(18),
      color: '#b3a68e',
      fontWeight: 'normal',
    },
    gzTextOn: {
      color: COLORS.gold,
    },
    /**
     * 节气点：贴底两行 16/15rpx 小字（节气名 + 交节时刻，如 立春 / 16:27）。
     * ⚠ 绝对定位是必须的 —— 换成文档流里的一行，有节气的格子会把日期数字顶上去，
     *   同一列的数字就会错开。
     */
    term: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: rpx(4),
      alignItems: 'center',
    },
    termName: {
      fontSize: rpx(16),
      lineHeight: rpx(16 * LINE_HEIGHTS.tight),
      color: '#bb9256',
    },
    termTime: {
      fontSize: rpx(15),
      lineHeight: rpx(15 * LINE_HEIGHTS.tight),
      color: '#c5ab7e',
    },
    foot: {
      paddingTop: rpx(16),
      paddingHorizontal: rpx(32),
      marginTop: rpx(4),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: COLORS.borderLight,
      textAlign: 'center',
      fontSize: rpx(26),
      color: COLORS.gold,
    },
    footHint: {
      paddingTop: rpx(6),
      paddingHorizontal: rpx(32),
      textAlign: 'center',
      fontSize: rpx(22),
      color: COLORS.goldPale,
    },
  });
}
