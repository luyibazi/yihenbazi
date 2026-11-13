/**
 * 顶部导航栏 —— 复刻小程序的**原生**导航栏
 *
 * ⚠⚠ 为什么要这个组件：
 *   小程序里每页顶部那条（状态栏占位 + 居中标题）是**系统画的**
 *   （app.json 的 window.navigation* + 各页 navigationBarTitleText），
 *   RN 里没有这一层 —— 页面内容从 y=0 开始、压在状态栏 / 刘海底下。
 *   这就是用户反馈「顶部被遮住了」的根因。必须自己补一条。
 *
 * ⚠⚠ 状态栏高度绝不能写死：非刘海（20/22pt）与刘海（44/47/59pt）差一截，
 *   只能 useSafeAreaInsets() 现取。这也是引 react-native-safe-area-context 的原因：
 *   它的原生实现**已在 Expo Go 里**（expo/bundledNativeModules.json 钉了 ~5.7.0），
 *   装包只是补 JS 绑定，不用重新编译；RN 0.86 自带的 SafeAreaView 已废弃、
 *   且在 Android 上不生效，指望不上。
 *
 * ⚠ 这条栏是**系统级 chrome**，跟小程序一样**不随 rpx 缩放**（原生导航栏在任何
 *   屏宽下都是固定 44/48pt 内容行），所以这里用固定 pt，别用 useRpx()。
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** 内容行高：iOS 导航栏 44pt / Android 48pt（与原生一致） */
const BAR_HEIGHT = Platform.select({ ios: 44, android: 48, default: 44 });
const TITLE_SIZE = Platform.select({ ios: 17, android: 19, default: 17 });

export default function NavBar({
  title,
  onBack
}: {
  title: string;
  /** 传了才显示返回箭头（结果页这种推入层才有；tab 页没有） */
  onBack?: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={s.bar}>
      {/* 状态栏占位：insets.top 就是状态栏 / 刘海的真实高度 */}
      <View style={{ height: insets.top }} />
      <View style={s.row}>
        <View style={s.side}>
          {onBack ? (
            <Pressable
              style={s.back}
              onPress={onBack}
              accessibilityRole="button"
              accessibilityLabel="返回"
              hitSlop={{ left: 8, right: 8, top: 8, bottom: 8 }}
            >
              {/* ⚠ 用两段边框画箭头而不是字符「‹」：不依赖字体、粗细可控 */}
              <View style={s.chevron} />
            </Pressable>
          ) : null}
        </View>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        {/* 右侧等宽占位：让标题在视觉上严格居中（与小程序一致） */}
        <View style={s.side} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
  },
  row: {
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  side: { width: 48 },
  back: {
    width: 48,
    height: BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    width: 12,
    height: 12,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#000000',
    transform: [{ rotate: '45deg' }],
    marginLeft: 4,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: '#000000',
    fontSize: TITLE_SIZE,
    fontWeight: '600',
  },
});
