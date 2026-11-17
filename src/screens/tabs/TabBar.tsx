/**
 * 底部 tab 栏 —— 照小程序 app.json 的 tabBar（四个等分，图标 + 文字）。
 *
 * ⚠ 图标用小程序 assets/tabbar/ 的那 8 张 PNG（已按统一光学占比重排：字形一律占
 *   画布 76%）。原始素材里「记录」的字形只占 48%、其他三个占 73–80%，
 *   同一个盒子里画出来「记录」比别的图标小一半 —— 用户反馈「底部菜单太小」
 *   有它一份。没有引图标库：与「不加依赖」同一个决定。
 * ⚠ 选中色 #a9814e / 未选中 #9b9b9b 直接取自 app.json 的 tabBar 配置。
 *
 * ⚠⚠ 尺寸**刻意比小程序原生 tabBar 大**（原生：50pt 高 / 图标 27pt / 字 10pt）：
 *   2026-10-02 用户真机反馈「底部菜单太小」。放大后图标盒 32pt / 字 12pt / 高约 61pt，
 *   另加 insets.bottom —— 不加的话整条栏贴着屏幕最下沿，被 iPhone 的 home
 *   indicator 压住，看起来又挤又小（这半句也是那次反馈的一部分）。
 *   ⚠ insets 是**系统给的物理值**，别用 rpx() 缩放它。
 */
import React, { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRpx } from '../../theme/rpx';
import model from './model';

const GRAY = '#9b9b9b';
const GOLD = '#a9814e';

/**
 * 图标映射（已按统一光学占比重排过的 8 张 PNG，96×96、字形占 76%）。
 * ⚠ 放在视图层而不是 model.js：model 要能被纯 Node 测试 require，Node 认不了 .png。
 */
const ICONS: Record<string, { icon: number; iconActive: number }> = {
  records: {
    icon: require('../../../assets/tabbar/records.png'),
    iconActive: require('../../../assets/tabbar/records-active.png'),
  },
  paipan: {
    icon: require('../../../assets/tabbar/paipan.png'),
    iconActive: require('../../../assets/tabbar/paipan-active.png'),
  },
  study: {
    icon: require('../../../assets/tabbar/study.png'),
    iconActive: require('../../../assets/tabbar/study-active.png'),
  },
  settings: {
    icon: require('../../../assets/tabbar/settings.png'),
    iconActive: require('../../../assets/tabbar/settings-active.png'),
  },
};

type IconPair = { icon: number; iconActive: number };
const iconPairOf = (key: string): IconPair =>
  ICONS[key] || { icon: 0, iconActive: 0 };

export default function TabBar({
  active,
  onPress
}: {
  active: string;
  onPress: (key: string) => void;
}) {
  const rpx = useRpx();
  const insets = useSafeAreaInsets();

  const s = useMemo(() => StyleSheet.create({
    bar: {
      flexDirection: 'row',
      backgroundColor: '#ffffff',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#e5e5e5',
      /* ⚠ 底部安全区（iPhone 的 home indicator 一带）：系统物理值，不缩放 */
      paddingBottom: insets.bottom,
    },
    item: { flex: 1, alignItems: 'center', paddingTop: rpx(14), paddingBottom: rpx(8) },
    /* 图标盒：定尺寸，两张图层（灰/金）都 absolute 铺在它里面 —— 见 return 里的注释 */
    iconBox: { width: rpx(64), height: rpx(64) },
    iconLayer: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: rpx(64),
      height: rpx(64),
      resizeMode: 'contain',
    },
    /** 隐藏的那一层只动透明度：不 display:none，保证浏览器一开始就把 8 张图都拉齐 */
    iconOff: { opacity: 0 },
    label: { fontSize: rpx(24), lineHeight: rpx(24 * 1.4), color: GRAY, marginTop: rpx(2) },
    labelOn: { color: GOLD },
  }), [rpx, insets.bottom]);

  return (
    <View style={s.bar} accessibilityRole="tablist">
      {model.TABS.map((t: any) => {
        const on = t.key === active;
        const icons = iconPairOf(t.key);
        return (
          <Pressable
            key={t.key}
            style={s.item}
            onPress={() => onPress(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={t.label}
          >
            {/*
              ★ 2026-11-17 用户：「图标老是点击后消失，很久不出现」。
              ⚠⚠ 病根是**换 source**：选中/未选中是两张不同的 PNG，
                `source={on ? iconActive : icon}` 每次点 tab 都要重新加载一遍
                —— 网页版下那是一次真的网络请求（还**必须**过隧道，连 304 再验证
                也要往返一趟），隧道一慢图标就空白好几秒。
              ⚠ 修法：两张图**都常驻**、absolute 叠在同一个盒子里，只用透明度切。
                src 永远不变 ⇒ 不发任何请求、不重新解码，切换是纯样式变化，瞬时。
                8 张 96×96 的小 PNG 常驻的内存代价可以忽略；代价换来的是首次进 app
                就把全部图标加载齐（之后怎么切都不再有网络）。
              ⚠ `fadeDuration={0}`：Android 的 Image 自带 150~300ms 淡入，
                叠两层时首次显示会闪一下白，一并关掉。
            */}
            <View style={s.iconBox}>
              <Image
                source={icons.icon}
                style={[s.iconLayer, on ? s.iconOff : null]}
                fadeDuration={0}
              />
              <Image
                source={icons.iconActive}
                style={[s.iconLayer, on ? null : s.iconOff]}
                fadeDuration={0}
              />
            </View>
            <Text style={[s.label, on ? s.labelOn : null]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
