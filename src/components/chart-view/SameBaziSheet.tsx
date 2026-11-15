/**
 * 「同八字」结果弹层 —— 点结果页那个「同」按钮弹出来。
 *
 * ============ 它只干一件事 ============
 * 把 `core/sameBazi.js` 检索到的两组结果**显示出来**，并把「点某一条」这件事
 * 交回给调用方（`onOpenRecord` / `onOpenBookmark`）。它自己不发请求、也不做转换 ——
 * 转换（轻记录 handoff、阅读页 target）是**页面**的职责：
 *   · 记录 → screens/records 的 model.js 里的 toHandoff
 *   · 书签 → screens/study 的 model.js 里的 bookmarkTarget
 * 在这里各 require 一次会把两个页面的口径复制进组件，改一处忘了另一处就会漂。
 *
 * ============ 为什么用 RN 的 Modal 而不是自己铺一层 absolute 遮罩 ============
 * 结果页是**裸 ScrollView**（见 Result.tsx 文件头），ChartView 的根节点还带
 * `overflow: hidden` —— 在里面 absolute 铺满会被裁掉、而且会跟着内容一起滚。
 * `components/DatePicker.tsx` / `GzPicker.tsx` 已经是 Modal 这一套，跟着走。
 *
 * ============ 版式（2026-11-15 用户：「弹窗也要优化」）============
 * 从「居中浮起的小框」改成**贴底、通栏的列表页**，理由有三条：
 *   ① 这里的内容是**一列条目**（记录 / 书签），不是一段短文案 ——
 *      通栏之后每行左右能舒展到 28rpx 内边距，横线也贯穿整屏，读起来是列表而不是表格；
 *   ② 贴底 = 从底部滑上来（`animationType="slide"`）与它的落点一致，
 *      否则面板从下面滑进来、却停在屏幕中间，看着像没停稳；
 *   ③ 贴底就把「最后一行被 Home 横条压住」变成了必然，所以底部吃 `insets.bottom`
 *      —— 这一层是**全屏 Modal**，不在 App 根节点那层 `paddingBottom: eaten` 里。
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  /**
   * 条件是按哪一法取的（如 '定气法'）。
   * ⚠ 由调用方给、组件不写死：这行字是「为什么结果和我眼前这张盘对不上」的答案，
   *   而「哪一法是条件」是调用方的规矩，不是这个显示组件该知道的事。
   */
  source?: string;
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
  source = '',
  onClose,
  onOpenRecord,
  onOpenBookmark
}: SameBaziSheetProps) {
  const rpx = useRpx();
  const insets = useSafeAreaInsets();
  const s = useMemo(() => makeStyles(rpx), [rpx]);

  const cond = (chars || []).filter(Boolean).join(' ');
  const empty = sameBazi.emptyText(data);
  const rec = data && data.records;
  const bk = data && data.bookmarks;
  /* ⚠ 读失败的那一组 items 可能是空的、甚至没有 items 字段 —— 下面 map 之前先兜住 */
  const recItems: any[] = rec && Array.isArray(rec.items) ? rec.items : [];
  const bkItems: any[] = bk && Array.isArray(bk.items) ? bk.items : [];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.mask}>
        {/* 点遮罩 = 关闭；面板本体用 Pressable 拦住点击（同 DatePicker） */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        {/* ⚠ 底部留白取 insets.bottom 与 24rpx 的较大者：没有 Home 横条的机器上
            也得有一口气的余量，不能让最后一条贴着屏幕边 */}
        <View style={[s.panel, loading ? s.panelLoading : null, { paddingBottom: Math.max(insets.bottom, rpx(24)) }]}>
          <View style={s.head}>
            <View style={s.headMain}>
              <Text style={s.title}>同八字</Text>
              {cond ? (
                <View style={s.condRow}>
                  <Text style={s.cond}>{cond}</Text>
                  {source ? <Text style={s.condSource}>{source}</Text> : null}
                </View>
              ) : null}
            </View>
            <Pressable onPress={onClose} hitSlop={12} style={s.closeHit}>
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
                  <View style={s.groupBar} />
                  <Text style={s.groupTitle}>记录</Text>
                  <Text style={s.groupCount}>{groupCountText(rec, '条')}</Text>
                </View>
                {rec.ok && recItems.length === 0 ? (
                  <Text style={s.none}>没有相同的记录</Text>
                ) : null}
                {!rec.ok ? <Text style={s.err}>{rec.error}</Text> : null}
                {recItems.map((item: any, i: number) => (
                  <Pressable
                    key={'r' + (item && item.id ? item.id : i)}
                    style={({ pressed }) => [s.row, pressed ? s.rowOn : null]}
                    onPress={() => onOpenRecord && onOpenRecord(item)}
                  >
                    <View style={s.rowMain}>
                      <Text style={s.rowName} numberOfLines={1}>
                        {item && item.name ? item.name : '未命名'}
                      </Text>
                      <Text style={s.rowSub} numberOfLines={1}>
                        {[item && item.dateText, item && item.timeText].filter(Boolean).join(' ')}
                      </Text>
                    </View>
                    <Text style={s.rowArrow}>›</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {/* 两组之间的浅色隔条（iOS 分节那种）——比一条横线更能说明「这是另一类东西」。
                ⚠ 只有**两组都真的列出条目**时才加：否则会在「没有相同的书签」上面
                  凭空多出一条凸起的色块，看着像内容被切断了 */}
            {!loading && recItems.length > 0 && bkItems.length > 0 ? <View style={s.sep} /> : null}

            {!loading && data && data.ok && bk ? (
              <View style={s.group}>
                <View style={s.groupHead}>
                  <View style={s.groupBar} />
                  <Text style={s.groupTitle}>学堂书签</Text>
                  <Text style={s.groupCount}>{groupCountText(bk, '个')}</Text>
                </View>
                {bk.ok && bkItems.length === 0 ? (
                  <Text style={s.none}>没有相同的书签</Text>
                ) : null}
                {!bk.ok ? <Text style={s.err}>{bk.error}</Text> : null}
                {bkItems.map((item: any, i: number) => (
                  <Pressable
                    key={'b' + i}
                    style={({ pressed }) => [s.row, pressed ? s.rowOn : null]}
                    onPress={() => onOpenBookmark && onOpenBookmark(item)}
                  >
                    <View style={s.rowMain}>
                      {/* 书签的 `name` 本身就是那四柱：按干支逐字排（与学堂页同一种排法） */}
                      <Text style={s.rowGz} numberOfLines={1}>
                        {gzText(item)}
                      </Text>
                      <Text style={s.rowSub} numberOfLines={2}>
                        {studyModel.sourceText(item)}
                      </Text>
                    </View>
                    <Text style={s.rowArrow}>›</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {!loading && empty ? <Text style={s.noneBig}>{empty}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * 书签那一行的主标题（四柱）。
 *
 * ⚠⚠ 原来是内联的**三次** `studyModel.pillarRows(item.name)`（三元里连算三遍），
 *   一条书签就要跑三趟 string 处理；列表一长纯属白烧。这里算一次。
 * ⚠ `plain` 为真说明这串不是「四柱」的形状（见 study/model.js），原样显示。
 */
function gzText(item: any) {
  const name = String((item && item.name) || '');
  const rows = studyModel.pillarRows(name);
  if (!rows || rows.plain) return name;
  return rows.stems + '   ' + rows.branches;
}

/**
 * 分组标题右侧的计数。
 *
 * ⚠⚠ 只取了 LIMIT 条却报总数会**骗人**（「120 条」下面只列了 50 条，
 *   用户会以为剩下的丢了）。所以「总数 > 实际列出」时把两件事都写出来。
 *   这与 core/pillarFilter.js 的 countText「带筛选时不许显示分母」是同一条纪律：
 *   计数只能说自己确实知道的那个数。
 */
function groupCountText(g: any, unit: string) {
  if (!g) return '';
  if (!g.ok) return '读不到';
  const total = typeof g.total === 'number' ? g.total : 0;
  const shown = Array.isArray(g.items) ? g.items.length : 0;
  if (shown < total) return total + ' ' + unit + ' · 列出前 ' + shown;
  return total + ' ' + unit;
}

function makeStyles(rpx: (v: number) => number) {
  return StyleSheet.create({
    /* 遮罩：面板贴底 ⇒ 这里只管压暗 + 把面板推到底，左右不留白（通栏） */
    mask: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: COLORS.scrim
    },
    /* ⚠ 全站直角（用户要求）——弹层与它的按钮都不给圆角。
       顶部那条淡金细线是它和页面之间唯一的分界（白面板压在压暗的页面上） */
    panel: {
      width: '100%',
      maxHeight: '82%',
      backgroundColor: COLORS.bg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#e8dcc6'
    },
    /* 加载中先占住一块高度：否则「一行转圈」的面板会在结果回来的瞬间突然长高一大截 */
    panelLoading: { minHeight: rpx(300) },

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
      fontSize: rpx(32),
      lineHeight: rpx(32) * LINE_HEIGHTS.tight,
      color: COLORS.text,
      fontWeight: FONT_WEIGHTS.semibold
    },
    /** 条件那行（定气法的四柱）—— 金一点，让它看起来像「输入的词」而不是标题 */
    condRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: rpx(10) },
    cond: { fontSize: rpx(24), color: COLORS.gold, letterSpacing: rpx(2) },
    /** 条件取自哪一法：淡灰、小一号，贴在四柱右边（不是标题，是注解） */
    condSource: { marginLeft: rpx(12), fontSize: rpx(21), color: COLORS.textFaint },
    closeHit: { paddingLeft: rpx(24) },
    close: { fontSize: rpx(26), color: COLORS.gold, paddingTop: rpx(2) },

    body: { flexGrow: 0, flexShrink: 1 },
    /* ⚠ 左右内边距挪到 groupHead / row 自己身上（通栏列表的横线才能贯穿整屏） */
    bodyInner: { paddingBottom: rpx(8) },

    loading: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: rpx(60)
    },
    loadingText: { marginLeft: rpx(14), fontSize: rpx(24), color: COLORS.textMuted },

    group: { paddingTop: rpx(20) },
    groupHead: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: rpx(28),
      paddingBottom: rpx(12)
    },
    /** 分组标题前的金色小竖条（比加粗字更省地方，也压得住下面那一列条目） */
    groupBar: {
      width: rpx(3),
      height: rpx(22),
      marginRight: rpx(12),
      backgroundColor: COLORS.gold
    },
    groupTitle: {
      flex: 1,
      fontSize: rpx(25),
      color: COLORS.text,
      fontWeight: FONT_WEIGHTS.semibold
    },
    groupCount: { fontSize: rpx(23), color: COLORS.textMuted },
    /** 两组之间的浅色隔条 */
    sep: { height: rpx(8), backgroundColor: COLORS.bgSoft, marginTop: rpx(16) },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: rpx(28),
      paddingVertical: rpx(20),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#f4efe6'
    },
    /** 按下时整行浅金（⚠ 只做底色，不做缩放/位移动效 —— 用户要「点得下去」的手感，不要花活） */
    rowOn: { backgroundColor: COLORS.goldBgFaint },
    rowMain: { flex: 1 },
    rowName: { fontSize: rpx(28), color: COLORS.text },
    /** 书签那一行的四柱：字距拉开一点，四个字看得出是四柱 */
    rowGz: { fontSize: rpx(28), color: COLORS.text, letterSpacing: rpx(2) },
    rowSub: { marginTop: rpx(6), fontSize: rpx(23), color: COLORS.textMuted },
    /** 「可以点开」的指示：淡金，够看见但不抢名字 */
    rowArrow: { marginLeft: rpx(16), fontSize: rpx(32), color: COLORS.goldLight },

    none: {
      paddingHorizontal: rpx(28),
      paddingVertical: rpx(18),
      fontSize: rpx(24),
      color: COLORS.textMuted
    },
    /** 两组都为 0 的那一句（全局空态）：居中、下方留白，与分组里的「没有」区分开 */
    noneBig: {
      paddingHorizontal: rpx(28),
      paddingTop: rpx(40),
      paddingBottom: rpx(52),
      fontSize: rpx(25),
      color: COLORS.textMuted,
      textAlign: 'center'
    },
    err: {
      paddingHorizontal: rpx(28),
      paddingVertical: rpx(18),
      fontSize: rpx(24),
      color: COLORS.warn
    }
  });
}
