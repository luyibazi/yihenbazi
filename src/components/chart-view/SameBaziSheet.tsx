/**
 * 「同八字」结果弹层 —— 点结果页那个「同」按钮弹出来。
 *
 * ============ 它只干一件事 ============
 * 把 `core/sameBazi.js` 检索到的两组结果**显示出来**，并把「点某一条」这件事
 * 交回给调用方（`onOpenRecord` / `onOpenBookmark`）。它自己不发请求、也不做转换 ——
 * 转换（轻记录 handoff、阅读页 target）是**页面**的职责：
 *   · 记录 → `screens/records/model.js` 的 toHandoff
 *   · 书签 → `screens/study/model.js` 的 bookmarkTarget
 * 在这里各 require 一次会把两个页面的口径复制进组件，改一处忘了另一处就会漂。
 *
 * ============ 为什么用 RN 的 Modal 而不是自己铺一层 absolute 遮罩 ============
 * 结果页是**裸 ScrollView**（见 Result.tsx 文件头），ChartView 的根节点还带
 * `overflow: hidden` —— 在里面 absolute 铺满会被裁掉、而且会跟着内容一起滚。
 * `components/DatePicker.tsx` / `GzPicker.tsx` 已经是 Modal 这一套，跟着走。
 *
 * ============ 空态 ============
 * 只说事实（`sameBazi.emptyText` 给的那一句），不写「怎么做」；
 * 两组里**只要有一组读失败**就一个空态字都不说 —— 读失败不是「没有」。
 */
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';

import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS } from '../../theme/tokens';

/* ⚠ 用 require 而不是 import：core/ 与 screens 各页的 model.js 都是 CommonJS */
const sameBazi: any = require('../../core/sameBazi.js');
const studyModel: any = require('../../screens/study/model.js');

export type SameBaziSheetProps = {
  visible: boolean;
  loading: boolean;
  /** `sameBazi.find()` 的返回；null = 还没查 */
  data: any;
  /** 条件（**定气法**的四柱，如 ['甲子','乙丑','丙寅','丁卯']）—— 只用于标题下那行展示 */
  chars: string[];
  onClose: () => void;
  /** 点一条记录（收到的是服务端原始记录，转换由页面做） */
  onOpenRecord?: (rec: any) => void;
  /** 点一条书签（收到的是 `/books/bookmarks` 的 item） */
  onOpenBookmark?: (item: any) => void;
};

export default function SameBaziSheet({
  visible,
  loading,
  data,
  chars,
  onClose,
  onOpenRecord,
  onOpenBookmark
}: SameBaziSheetProps) {
  const rpx = useRpx();
  const s = useMemo(() => makeStyles(rpx), [rpx]);

  const cond = (chars || []).filter(Boolean).join(' ');
  const empty = sameBazi.emptyText(data);
  const rec = data && data.records;
  const bk = data && data.bookmarks;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.mask}>
        {/* 点遮罩 = 关闭；面板本体用 Pressable 拦住点击（同 DatePicker） */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={s.panel}>
          <View style={s.head}>
            <View style={s.headMain}>
              <Text style={s.title}>同八字</Text>
              {cond ? <Text style={s.cond}>{cond}</Text> : null}
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={s.close}>关闭</Text>
            </Pressable>
          </View>

          <ScrollView style={s.body} contentContainerStyle={s.bodyInner}>
            {loading ? (
              <View style={s.loading}>
                <ActivityIndicator size="small" color={COLORS.gold} />
                <Text style={s.loadingText}>检索中…</Text>
              </View>
            ) : null}

            {/* 四柱不全之类的硬错误（`ok:false` 只有这一种情况） */}
            {!loading && data && !data.ok ? <Text style={s.err}>{data.error}</Text> : null}

            {!loading && data && data.ok && rec ? (
              <View style={s.group}>
                <View style={s.groupHead}>
                  <Text style={s.groupTitle}>记录</Text>
                  <Text style={s.groupCount}>
                    {rec.ok ? rec.total + ' 条' : '读不到'}
                  </Text>
                </View>
                {rec.ok && rec.items.length === 0 ? <Text style={s.none}>没有</Text> : null}
                {!rec.ok ? <Text style={s.err}>{rec.error}</Text> : null}
                {rec.items.map((item: any, i: number) => (
                  <Pressable
                    key={'r' + (item && item.id ? item.id : i)}
                    style={s.row}
                    onPress={() => onOpenRecord && onOpenRecord(item)}
                  >
                    <Text style={s.rowName} numberOfLines={1}>
                      {item && item.name ? item.name : '未命名'}
                    </Text>
                    <Text style={s.rowSub} numberOfLines={1}>
                      {[item && item.dateText, item && item.timeText].filter(Boolean).join(' ')}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {!loading && data && data.ok && bk ? (
              <View style={s.group}>
                <View style={s.groupHead}>
                  <Text style={s.groupTitle}>学堂书签</Text>
                  <Text style={s.groupCount}>
                    {bk.ok ? bk.total + ' 个' : '读不到'}
                  </Text>
                </View>
                {bk.ok && bk.items.length === 0 ? <Text style={s.none}>没有</Text> : null}
                {!bk.ok ? <Text style={s.err}>{bk.error}</Text> : null}
                {bk.items.map((item: any, i: number) => (
                  <Pressable
                    key={'b' + i}
                    style={s.row}
                    onPress={() => onOpenBookmark && onOpenBookmark(item)}
                  >
                    {/* 书签的 `name` 本身就是那四柱：按干支逐字排（与学堂页同一种排法） */}
                    <Text style={s.rowGz} numberOfLines={1}>
                      {studyModel.pillarRows(item && item.name).plain
                        ? String((item && item.name) || '')
                        : studyModel.pillarRows(item && item.name).stems + '   ' +
                          studyModel.pillarRows(item && item.name).branches}
                    </Text>
                    <Text style={s.rowSub} numberOfLines={2}>
                      {studyModel.sourceText(item)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {!loading && empty ? <Text style={s.none}>{empty}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(rpx: (v: number) => number) {
  return StyleSheet.create({
    mask: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: COLORS.scrim,
      paddingHorizontal: rpx(44),
      paddingBottom: rpx(40)
    },
    /* ⚠ 全站直角（用户要求）——弹层与它的按钮都不给圆角 */
    panel: {
      width: '100%',
      maxHeight: '78%',
      backgroundColor: COLORS.bg
    },
    head: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: rpx(28),
      paddingTop: rpx(24),
      paddingBottom: rpx(20),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#f0e9db'
    },
    headMain: { flex: 1 },
    title: {
      fontSize: rpx(30),
      lineHeight: rpx(30) * LINE_HEIGHTS.tight,
      color: COLORS.text,
      fontWeight: FONT_WEIGHTS.semibold
    },
    /** 条件那行（定气法的四柱）—— 金一点，让它看起来像「输入的词」而不是标题 */
    cond: { marginTop: rpx(8), fontSize: rpx(24), color: COLORS.gold, letterSpacing: rpx(2) },
    close: { fontSize: rpx(26), color: COLORS.gold, paddingTop: rpx(2) },

    body: { flexGrow: 0, flexShrink: 1 },
    bodyInner: { paddingHorizontal: rpx(28), paddingVertical: rpx(8) },

    loading: { flexDirection: 'row', alignItems: 'center', paddingVertical: rpx(40) },
    loadingText: { marginLeft: rpx(14), fontSize: rpx(24), color: COLORS.textMuted },

    group: { paddingTop: rpx(18) },
    groupHead: {
      flexDirection: 'row',
      alignItems: 'baseline',
      paddingBottom: rpx(10)
    },
    groupTitle: {
      flex: 1,
      fontSize: rpx(25),
      color: COLORS.text,
      fontWeight: FONT_WEIGHTS.semibold
    },
    groupCount: { fontSize: rpx(23), color: COLORS.textMuted },

    row: {
      paddingVertical: rpx(18),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#f4efe6'
    },
    rowName: { fontSize: rpx(27), color: COLORS.text },
    /** 书签那一行的四柱：字距拉开一点，四个字看得出是四柱 */
    rowGz: { fontSize: rpx(27), color: COLORS.text, letterSpacing: rpx(2) },
    rowSub: { marginTop: rpx(6), fontSize: rpx(23), color: COLORS.textMuted },

    none: { paddingVertical: rpx(14), fontSize: rpx(24), color: COLORS.textMuted },
    err: { paddingVertical: rpx(14), fontSize: rpx(24), color: COLORS.warn }
  });
}
