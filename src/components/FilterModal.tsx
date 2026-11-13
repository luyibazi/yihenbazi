/**
 * 四柱筛选的两个**可复用件**：入口行 + 弹窗。
 *
 * ============ 为什么抽出来 ============
 * 2026-10-04 用户要求「这个页面也加上筛选功能吧，最好是将筛选功能的组件封装，复用」。
 * 于是界面（本文件）与逻辑（core/pillarFilter.js）各一份，两处**共用**：
 *   · 记录页（screens/records/Records.tsx）—— 筛用户的排盘记录
 *   · 学堂页（screens/study/Study.tsx）—— 筛古籍里的八字书签
 * 两个页面各自持有自己的筛选状态（学堂里筛的字不该影响记录页看到的东西）。
 *
 * ============ 组件边界（哪些东西刻意留在调用方）============
 *   · **计数文案**（「共 30 例」/「共 3731 个 · 已加载 50 个」）—— 只有调用方
 *     知道自己在数什么。两页的计数口径本来就不同（见 pillarFilter.countText 的注释）。
 *   · **筛选数据本身**（生效值 `applied`、变更后要做什么）—— 由各自的
 *     model.applyPlan 决定，本组件只把**草稿**交出去。
 *   · **后端支不支持**（`disabled` / 那句说明）—— 两页的判据不同。
 *
 * ============ 草稿态（★ 用户要求「点击确定才筛选」）============
 * 草稿**只活在本组件里**：`visible` 翻真的那一刻把 `applied` 深拷一份。
 * ⚠⚠ 依赖数组只有 `visible`，**故意不带 `applied`**：
 *   带上它的话，调用方每次重渲染传下来的对象身份一变（哪怕内容相同），
 *   草稿就会被重置 —— 用户正勾着的一半选择会当场消失。
 *   （打开弹窗时闭包里的 `applied` 已经是最新一次渲染的值，够用。）
 * ⚠ **取消/点遮罩 = 丢弃草稿**，一个像素都不该变 —— 这是「点了确定才筛选」
 *   的字面实现（逻辑侧的对应物是 pillarFilter.applyPlan）。
 *
 * ============ 键盘避让 ============
 * 遮罩用 `absolute` 铺满**所在的容器**，而两个调用方都是 tab 页面，
 * 页面容器本身就在 App 根节点的 `paddingBottom: eaten` 里（见 App.tsx 的 stage）
 * —— 所以这里**别再叠 KeyboardAvoid**（红线：全局只有一层，页内不许再套），
 * 也**不用**自己减 eaten：容器已经矮了一截，absolute 铺满即正确。
 * （结果页那种**推入层**不占容器高度，才需要自己内联 marginBottom。）
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useRpx } from '../theme/rpx';
import { COLORS, FONT_WEIGHTS, RADII } from '../theme/tokens';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const pf: any = require('../core/pillarFilter.js');

/** 两个组件共用的一张样式表（都只用 rpx 算尺寸） */
function useStyles() {
  const rpx = useRpx();
  return useMemo(() => StyleSheet.create({
    /* ===== 入口行 ===== */
    /* 入口压在页面左右留白**里面**（不通栏）：它是个工具入口，
       通栏会显得像一块内容，跟下面的内容卡片抢视觉。 */
    fltEntry: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: rpx(22),
      paddingHorizontal: rpx(24),
      marginBottom: rpx(20),
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.card),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#eee6d8'
    },
    fltTitle: { flex: 1, fontSize: rpx(28), color: COLORS.text, fontWeight: FONT_WEIGHTS.semibold },
    /** 角标：生效中的筛选个数（0 时不渲染） */
    fltBadge: {
      minWidth: rpx(34), height: rpx(34),
      paddingHorizontal: rpx(9),
      borderRadius: rpx(17),
      backgroundColor: COLORS.gold,
      alignItems: 'center', justifyContent: 'center',
      marginRight: rpx(14)
    },
    fltBadgeText: { color: '#ffffff', fontSize: rpx(22) },
    /** 「共 N 例」/「筛出 N 例」/「共 3731 个 · 已加载 50 个」—— 文案由调用方给 */
    fltCount: { fontSize: rpx(24), color: COLORS.textMuted, marginRight: rpx(18) },
    fltReset: { fontSize: rpx(24), color: COLORS.gold },
    fltArrow: { fontSize: rpx(24), color: COLORS.textMuted, marginLeft: rpx(14) },

    /* ===== 弹窗 ===== */
    /* ⚠ 遮罩必须 absolute 铺满并压在列表之上（与结果页编辑框同一套路） */
    mask: {
      position: 'absolute',
      left: 0, right: 0, top: 0, bottom: 0,
      zIndex: 100,
      backgroundColor: COLORS.scrim
    },
    /* 让位层：把弹窗居中。⚠ 居中/留白放这一层，mask 保持"纯遮罩" */
    kav: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: rpx(44)
    },
    modal: {
      width: '100%',
      maxHeight: '78%',          /* ⚠ 必须限高：八行 × 十几个字在小屏上会顶出屏幕 */
      backgroundColor: COLORS.bg
    },
    modalHead: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: rpx(28),
      paddingVertical: rpx(24),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#f0e9db'
    },
    modalTitle: { flex: 1, fontSize: rpx(30), color: COLORS.text, fontWeight: FONT_WEIGHTS.semibold },
    modalSub: { fontSize: rpx(24), color: COLORS.textMuted },
    /* ⚠ 八个类别要能滚：矮屏幕上「确定」必须始终可达，不能被内容挤出屏幕 */
    modalBody: { flexGrow: 0, flexShrink: 1 },
    modalBodyInner: { paddingHorizontal: rpx(28), paddingBottom: rpx(8) },
    modalBtns: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: rpx(28),
      paddingTop: rpx(20),
      paddingBottom: rpx(24),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#f0e9db'
    },
    modalBtn: {
      minWidth: rpx(130),
      marginLeft: rpx(18),
      paddingVertical: rpx(16),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#e6e0d4',
      alignItems: 'center'
    },
    modalBtnPrimary: { borderColor: COLORS.gold, backgroundColor: COLORS.gold },
    /** ⚠ 全站一律直角（用户要求）：弹窗与它的按钮都不给圆角 */
    modalBtnText: { fontSize: rpx(27), color: '#8d8d8d' },
    modalBtnTextPrimary: { color: '#ffffff' },

    /* 八个类别（一行 = 一个类别：左边标签定宽，右边字块换行排） */
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingTop: rpx(16),
      paddingBottom: rpx(16),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#f4efe6'
    },
    cat: { width: rpx(76), paddingTop: rpx(10), fontSize: rpx(25), color: '#8d8d8d' },
    opts: { flex: 1, flexDirection: 'row', flexWrap: 'wrap' },
    /** 一个「字」的方块（天干 / 地支 / 全部） */
    opt: {
      minWidth: rpx(48),
      paddingHorizontal: rpx(10),
      paddingVertical: rpx(8),
      marginRight: rpx(10),
      marginBottom: rpx(10),
      borderWidth: rpx(1),
      borderColor: '#e6dcc9',
      borderRadius: rpx(4),
      alignItems: 'center'
    },
    optOn: { borderColor: COLORS.gold, backgroundColor: COLORS.gold },
    optText: { fontSize: rpx(25), color: '#6f675a' },
    optTextOn: { color: '#ffffff' }
  }), [rpx]);
}

/**
 * 筛选**入口行**（点开弹窗）。
 *
 * ⚠ 它只是个按钮：**不显示「重置」以外的任何即时动作**。重置是弹窗里的动作，
 *   放这儿会让人以为点一下就直接生效了 —— 那违背「点击确定才筛选」。
 *
 * @param {number} picked      生效中的筛选个数（0 = 不显示角标）
 * @param {string} countText   右侧那句计数（由调用方给，见文件头）
 * @param {function} onPress   点整行 → 打开弹窗
 * @param {function} [onReset] 给了才渲染「清除筛选」（判据由调用方决定）
 * @param {boolean} [disabled] 后端不支持时置灰（⚠ 仍要显示：见 Records 的注释）
 */
export function FilterEntry({
  title = '筛选',
  picked = 0,
  countText = '',
  onPress,
  onReset,
  disabled = false
}: {
  title?: string;
  picked?: number;
  countText?: string;
  onPress: () => void;
  onReset?: () => void;
  disabled?: boolean;
}) {
  const s = useStyles();
  return (
    <Pressable style={s.fltEntry} onPress={onPress} disabled={disabled}>
      <Text style={s.fltTitle}>{title}</Text>
      {picked > 0 ? (
        <View style={s.fltBadge}>
          <Text style={s.fltBadgeText}>{picked}</Text>
        </View>
      ) : null}
      {countText ? <Text style={s.fltCount}>{countText}</Text> : null}
      {onReset ? (
        <Pressable onPress={onReset} hitSlop={8}>
          <Text style={s.fltReset}>清除筛选</Text>
        </Pressable>
      ) : null}
      <Text style={s.fltArrow}>▸</Text>
    </Pressable>
  );
}

/**
 * 筛选**弹窗**（八个类别 + 重置 / 取消 / 确定）。
 *
 * @param {boolean} visible    开不开
 * @param {Object} applied     生效中的筛选（打开时深拷成草稿）
 * @param {string} [countText] 标题右侧那句计数 —— ⚠ 调用方必须用**生效值**算
 *                             （列表此刻显示的就是生效筛选的结果，用草稿算会当场骗人）
 * @param {function} onConfirm 点「确定」→ 交出**草稿**（怎么处理由调用方定）
 * @param {function} onClose   取消 / 点遮罩 → 丢弃草稿
 */
export function FilterModal({
  visible,
  applied,
  countText = '',
  onConfirm,
  onClose
}: {
  visible: boolean;
  applied: any;
  countText?: string;
  onConfirm: (draft: any) => void;
  onClose: () => void;
}) {
  const s = useStyles();
  /** 弹窗里的草稿：只在弹窗存活期间有意义（见文件头的草稿态说明） */
  const [draft, setDraft] = useState<any>(() => pf.emptyFilter());

  useEffect(() => {
    if (visible) setDraft(pf.cloneFilter(applied));
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const onToggle = useCallback((param: string, ch: string) => {
    setDraft((prev: any) => pf.toggleChar(prev, param, ch));
  }, []);
  /** 某一类点「全部」：清空该类（⚠ 不关窗、不筛 —— 还要点确定才算数） */
  const onClearCat = useCallback((param: string) => {
    setDraft((prev: any) => pf.clearCat(prev, param));
  }, []);
  /** 「重置」：清空**草稿**的全部类别（同样不关窗、不筛） */
  const onReset = useCallback(() => {
    setDraft(pf.emptyFilter());
  }, []);

  if (!visible) return null;

  return (
    <View style={s.mask}>
      {/* 点遮罩 = 取消（丢弃草稿）。⚠ 点框内不会冒泡到这里 —— 它是兄弟节点 */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={s.kav} pointerEvents="box-none">
        <View style={s.modal}>
          <View style={s.modalHead}>
            <Text style={s.modalTitle}>筛选</Text>
            {countText ? <Text style={s.modalSub}>{countText}</Text> : null}
          </View>

          {/* 八个类别：⚠ 读/写都是**草稿**（draft），不是生效中的 applied */}
          <ScrollView style={s.modalBody} contentContainerStyle={s.modalBodyInner}>
            {pf.FILTER_CATS.map((cat: any) => {
              const all = pf.isAll(draft, cat.param);
              return (
                <View key={cat.param} style={s.row}>
                  <Text style={s.cat}>{cat.label}</Text>
                  <View style={s.opts}>
                    {/* 「全部」= 清空该类（等价于不过滤） */}
                    <Pressable
                      style={[s.opt, all ? s.optOn : null]}
                      onPress={() => onClearCat(cat.param)}
                    >
                      <Text style={[s.optText, all ? s.optTextOn : null]}>全部</Text>
                    </Pressable>
                    {cat.chars.map((ch: string) => {
                      const on = !!(draft[cat.param] || {})[ch];
                      return (
                        <Pressable
                          key={ch}
                          style={[s.opt, on ? s.optOn : null]}
                          onPress={() => onToggle(cat.param, ch)}
                        >
                          <Text style={[s.optText, on ? s.optTextOn : null]}>{ch}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </ScrollView>

          {/* 三个按钮：重置（只清草稿）/ 取消（丢草稿关窗）/ 确定（提交并筛） */}
          <View style={s.modalBtns}>
            <Pressable style={s.modalBtn} onPress={onReset}>
              <Text style={s.modalBtnText}>重置</Text>
            </Pressable>
            <Pressable style={s.modalBtn} onPress={onClose}>
              <Text style={s.modalBtnText}>取消</Text>
            </Pressable>
            <Pressable
              style={[s.modalBtn, s.modalBtnPrimary]}
              onPress={() => onConfirm(draft)}
            >
              <Text style={[s.modalBtnText, s.modalBtnTextPrimary]}>
                {pf.confirmText(draft)}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
