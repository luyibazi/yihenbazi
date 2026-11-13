/**
 * 顶部提示条 —— 服务端下发 `toast` 指令时飘出来的那条。
 *
 * ============ 为什么不用 Alert.alert ============
 * Alert 是**模态**的：会打断用户正在做的事，还得点一下「确定」才能继续。
 * 服务端下发的一句话不该有这种分量（何况它可能只是「今天多喝点水」）。
 * 所以用一条**不挡手**的浮层：看一眼、自己会消失、点一下就提前收掉。
 *
 * ============ ⚠⚠ 为什么要靠外部 key 重挂载 ============
 * 「连着收到两条一样的提示」是真实存在的（管理员手抖点了两次），
 * 而同一个 text 重新渲染**不会**重跑 effect ⇒ 第二条会一直挂着不消失。
 * ⇒ 调用方用 `<Notice key={notice.id} …>`：id 一变就重挂载，计时器自然重来。
 *   这是最省事的正确做法（比在组件里自己 diff 上一次的 text 可靠）。
 *
 * ⚠ 自动消失的时间到点就回调 onDone，**由调用方清状态** ——
 *   组件自己不许持有「我还在不在」的状态（同一份状态两处存迟早会漂）。
 */
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** 停留多久（毫秒）。⚠ 太短看不清（一句话 20 字要看 3~4 秒），太长挡视线 */
const SHOW_MS = 6000;

export default function Notice({
  text,
  onDone
}: {
  /** 提示正文（服务端 payload.text，后端已挡掉空串与超长） */
  text: string;
  /** 到点 / 被点掉时调它，由父组件把提示清掉 */
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!text) return;
    const t = setTimeout(onDone, SHOW_MS);
    /* ⚠ 必须清计时器：提示提前被点掉、或连着来第二条（重挂载）时，
       旧计时器还会再调一次 onDone —— 那会在「第二条正显示」时把它关掉。 */
    return () => clearTimeout(t);
  }, [text, onDone]);

  if (!text) return null;

  return (
    <Pressable
      style={[s.wrap, { paddingTop: insets.top + 8 }]}
      onPress={onDone}
      accessibilityRole="button"
      accessibilityLabel="关闭提示"
    >
      <Text style={s.text}>{text}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  /**
   * ⚠ 用**绝对定位**盖在最上面（不进 flex 流）：它飘在四个 tab、结果页、登录页之上，
   *   不能把任何页面的布局挤动一点点。zIndex 30 比登录层(20)还高 ——
   *   「后台发来的话」在任何页面上都该看得见。
   */
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 30,
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  text: {
    maxWidth: 560,
    backgroundColor: '#161616',
    color: '#f3ead9',
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 12,
    overflow: 'hidden',
    textAlign: 'center',
  },
});
