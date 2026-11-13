/**
 * 顶部切换栏（分段控件）—— 一行**等宽**按钮，选中的那个高亮（金字 + 金下划线）。
 *
 * ⚠ 为什么单独抽出来：学堂页要用它切「查询 / 书籍」，别处（记录页的子页、
 *   排行、设置…）以后大概率也要同款。抽出来才有**唯一一份**外观与手感，
 *   改一次全都变 —— 各页各写一份迟早漂。
 *
 * ⚠⚠ 这是**受控**组件：它自己**不存**选中值（`value` + `onChange` 都由调用方给）。
 *   因为「选中谁」决定的是**哪个面板在显示**，那属于页面状态；组件内部若再存
 *   一份，就会出现「组件以为选中 A、页面在显示 B」的不同步。
 *
 * ⚠⚠ 配套纪律（在调用方那边，不在这里）：被切换的两个面板要**常驻 + display 切**，
 *   **绝不条件渲染** —— 条件渲染会把另一个面板的状态（筛选、已加载列表、
 *   滚动位置）连同组件一起丢掉。用法见 `screens/study/Study.tsx`。
 *
 * ⚠ 标签文案**必须在调用方一处定义**、循环渲染出来（`tabs` 数组），
 *   不许在 JSX 里手写两个按钮 —— 那样加一个面板就要改三处。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRpx } from '../theme/rpx';
import { COLORS, FONT_WEIGHTS } from '../theme/tokens';

/** 一个页签：`key` 是喂给 onChange 的稳定标识，`label` 是给人看的字 */
export type SegTabItem<T extends string> = { key: T; label: string };

export function SegTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  /** 页签定义（顺序 = 显示顺序）。⚠ 唯一一份，别在 JSX 里另写一遍文案 */
  tabs: SegTabItem<T>[];
  /** 当前选中项 */
  value: T;
  /** 点选回调（传回 `key`）。⚠ 受控：组件不自己记选中值 */
  onChange: (key: T) => void;
}) {
  const rpx = useRpx();

  const s = useMemo(() => StyleSheet.create({
    /** 白底 + 一条 hairline 下边，从灰底页面里浮出来 */
    bar: {
      flexDirection: 'row',
      backgroundColor: '#ffffff',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#e6e6e6',
    },
    /** 等宽：两个页签各占一半，切换时文字不会左右跳 */
    item: {
      flex: 1,
      alignItems: 'center',
      paddingTop: rpx(22),
      paddingBottom: rpx(14),
    },
    label: { fontSize: rpx(28), color: COLORS.textMuted },
    labelOn: { color: COLORS.gold, fontWeight: FONT_WEIGHTS.semibold },
    /**
     * 下划线常驻、只改颜色（不用条件渲染）—— 否则选中项的高度会多出几 rpx，
     * 整条栏在切换时抖一下。
     */
    underline: {
      marginTop: rpx(10),
      height: rpx(4),
      width: rpx(56),
      borderRadius: rpx(2),
      backgroundColor: 'transparent',
    },
    underlineOn: { backgroundColor: COLORS.gold },
  }), [rpx]);

  return (
    <View style={s.bar}>
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <Pressable
            key={t.key}
            style={s.item}
            onPress={() => onChange(t.key)}
            /* 无障碍：读屏能念出「已选中」 */
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <Text style={on ? [s.label, s.labelOn] : s.label}>{t.label}</Text>
            <View style={on ? [s.underline, s.underlineOn] : s.underline} />
          </Pressable>
        );
      })}
    </View>
  );
}

export default SegTabs;
