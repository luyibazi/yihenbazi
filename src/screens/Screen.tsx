/**
 * 页面外壳 —— 对应小程序的全局 `.page`（app.ttss）。
 *
 * ⚠ 为什么单独抽一个：小程序里 `.page` 是全局类，五页共享同一份左右留白
 *   （26rpx）。搬到 RN 后每个页面各写一遍 StyleSheet 的话，
 *   迟早有一页漏写/写错，而这正是「各页留白不一致」的来源。
 *
 * ⚠⚠ 结果页（chart-view）**故意不用这个外壳** ——
 *   那张盘的运程三表按「一屏 11 列」定宽（列宽 63rpx 由可用宽 698rpx 反推），
 *   四柱区也定宽 420rpx，左右一补内边距就会把预算砍掉、一屏掉到 10 列。
 *   所以结果页自己在 ChartView 里把 .page 的左右保持 0（见 tokens 的 pagePadX 注释）。
 */
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useRpx } from '../theme/rpx';
import { SIZES } from '../theme/tokens';

export default function Screen({
  children,
  contentStyle,
  scroll = true
}: {
  children: React.ReactNode;
  contentStyle?: any;
  /** 内容本身是 ScrollView（结果页那种）时传 false */
  scroll?: boolean;
}) {
  const rpx = useRpx();
  const s = StyleSheet.create({
    scroll: { flex: 1, backgroundColor: '#f5f5f5' },
    page: {
      paddingTop: rpx(SIZES.pagePadTop),
      paddingBottom: rpx(SIZES.pagePadBottom),
      paddingHorizontal: rpx(SIZES.pagePadX + 26),
    },
  });

  if (!scroll) return <>{children}</>;

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={[s.page, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
