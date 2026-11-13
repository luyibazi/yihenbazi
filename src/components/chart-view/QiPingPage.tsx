/**
 * 排盘「页」之二：**平气法**（四柱行式表格 + 大运 / 流年 / 流月）
 *
 * ★ 2026-10-18 用户（最终口径）：「你做平气法的内容吧，ui 就抄定气法的。
 *   定气法页面的任何代码你都不要改动。平气法算法就用 …\pingqi」
 *   ⇒ 本文件是 QiDingPage.tsx 的**副本**（UI 照抄），**单向依赖**：
 *     本文件 import 定气法页，定气法页永远不认识本文件。
 *     所以「改本文件」不可能影响到定气法 —— 那是用户唯一在意的约束。
 *
 * ⚠⚠⚠ 定气法那一页是用户自己做的，**只许读、不许改**（2026-10-18 被整体回退过一次）。
 *   本文件抄的是它 15:57 那版（`QiDingPage.tsx` 696 行）。
 *   UI 要跟着定气法变时，**重新抄一遍**，不要反过来去动它。
 *
 * ⚠ 数据侧：state / pillarRows 全部来自 model.buildChartData(rec, nowYear, 'pingqi')，
 *   即 pingqi-bazi.js（用户提供的算法：平气立春换年、平气节换月、司令 / 胎元 / 交运 / 大运）。
 *   日柱 / 时柱 / 十神 / 藏干 / 纳音 / 星运 / 自坐 / 空亡 仍走 chart.js（与口径无关，本来就一致）。
 *
 * ⚠ 页面本身**不带 page 容器**（padding / 背景）：那是外层的事。
 *
 * ⚠ 版式硬约束（从定气法那份原样继承，改前先读）：
 *   · 横向预算 = 行头 80 + 间隙 8 + 4×96 = 472rpx（cell 按**位置**分流宽度，不做「有才画」）。
 *   · 行头 + 间隙总占位必须恒为 88（= 改前行头宽），加间隙必须同步减宽度。
 *   · 三张运程表列宽写死同一个 63rpx —— «大运 = 流年 = 流月» 的单项宽度必须完全一致。
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';

import * as M from './model';
import { COLORS, SIZES, RADII, LINE_HEIGHTS, FONT_WEIGHTS } from '../../theme/tokens';

/** 五行 class → 颜色（原项目靠 ttss 里的 .c-mu 等类，RN 里必须显式映射） */
const ELEMENT_COLORS: Record<string, string> = {
  'c-mu': COLORS.mu,
  'c-huo': COLORS.huo,
  'c-tu': COLORS.tu,
  'c-jin': COLORS.jin,
  'c-shui': COLORS.shui,
};

/** 黑底选中列上的提亮版（原项目 .gz-col.on .c-mu 等） */
const ELEMENT_COLORS_ON: Record<string, string> = {
  'c-mu': COLORS.muOn,
  'c-huo': COLORS.huoOn,
  'c-tu': COLORS.tuOn,
  'c-jin': COLORS.jinOn,
  'c-shui': COLORS.shuiOn,
};

/** 四柱定数：行式表格里前 4 个 cell 是柱、其后是选中运卡（cellPillar / cellCard 的分流判据） */
const PILLAR_COUNT = 4;
/**
 * 行头与第 1 柱之间的小间隙（8rpx）。
 * ⚠ 行头总占位必须 = 88：80 宽 + 8 右间隙。加间隙必须同步减宽度，
 *   否则 4 柱整体右移、最后一列越出 750 可用宽。
 */
const ROW_HEAD_GAP = 8;

export type QiPingPageProps = {
  /** model.buildChartData(rec, nowYear, 'pingqi') 那一份 */
  state: any;
  /** 行式表格数据：M.buildPillarRows 的产物（外层 useMemo 出来，别在这里重算） */
  pillarRows: any[];
  /** 当前上下文（dk / di / lnIdx）—— 只用于三张表的初始横向锚点 */
  ctx: any;
  rpx: (v: number) => number;
  styles: any;
  onPickDayun: (idx: number) => void;
  onPickLiunian: (idx: number) => void;
  onPickLiuyue: (idx: number) => void;
  onNoteDayun: (idx: number) => void;
  onNoteLiunian: (idx: number) => void;
  onNoteLiuyue: (idx: number) => void;
};

export default function QiPingPage({
  state,
  pillarRows,
  ctx,
  rpx,
  styles,
  onPickDayun,
  onPickLiunian,
  onPickLiuyue,
  onNoteDayun,
  onNoteLiunian,
  onNoteLiuyue,
}: QiPingPageProps) {
  /** 各行的字号差异（head=列头 / 干支=大字 / 星运自坐空亡=小字 / 纳音=最小） */
  const CELL_TEXT: Record<string, any> = {
    head: styles.headCellText,
    shiShen: styles.shiShenCellText,
    stem: styles.pillarChar,
    branch: styles.pillarChar,
    xingYun: styles.smallCellText,
    ziZuo: styles.smallCellText,
    kongWang: styles.smallCellText,
    nayin: styles.pillarNayin,
  };

  const renderCell = (rowKey: string, cell: any, i: number) => {
    const box = [i < PILLAR_COUNT ? styles.cellPillar : styles.cellCard, cell.blank && styles.hidden];
    if (cell.kind === 'canggan') {
      return (
        <View style={[...box, styles.pillarCanggan]}>
          {(cell.items || []).map((cg: any) => (
            <View key={cg.stem} style={styles.cgItem}>
              <Text style={[styles.cgStem, { color: ELEMENT_COLORS[cg.cls] }]}>{cg.stem}</Text>
              <Text style={styles.cgShiShen}>{cg.shiShen}</Text>
            </View>
          ))}
        </View>
      );
    }
    /*
     * 神煞格：一柱命中的神煞（可能多颗）。**竖排，一颗一行**。
     * ⚠⚠ 用户 2026-10-08 两条定调：「神煞不要缩写」+「也不要两个并列」
     *   ⇒ 显示完整名（「天乙贵人」），且**不许并排**（并排会挤成 96rpx 里两列小字，读不出边界）。
     *   高度靠整行自动撑开（行式表格里每行独立成块，不会错位）。
     * ⚠ 颜色统一（用户定「统一灰色小字」），不用五行色、不按吉凶分色。
     */
    if (cell.kind === 'shensha') {
      return (
        <View style={[...box, styles.shaWrap]}>
          {(cell.items || []).map((name: string, k: number) => (
            <Text key={name + k} style={styles.shaChip} numberOfLines={1}>{name}</Text>
          ))}
        </View>
      );
    }
    if (cell.kind === 'placeholder') {
      return (
        <View style={[...box, styles.selTextWrap]}>
          <Text style={styles.selText}>{cell.text}</Text>
        </View>
      );
    }
    return (
      <View style={box}>
        <Text
          style={[
            CELL_TEXT[rowKey],
            cell.cls ? { color: ELEMENT_COLORS[cell.cls] } : null,
            cell.gold && styles.cellGold,
          ]}
        >
          {cell.text}
        </Text>
      </View>
    );
  };

  /*
   * ★ 平气法专有（定气法没有这一支）：**算不出这条盘**。
   *   出生年超出节气表覆盖的 1600–2200 ⇒ model.buildChartData 给回
   *   ready:false + pingqiFailed:true。
   *   ⚠ 只陈述事实、不教用户怎么做（本项目空态口径）。
   */
  if (!state || !state.ready) {
    return (
      <View style={[styles.card, styles.pingEmptyCard]}>
        <Text style={styles.pingEmptyText}>
          {state && state.pingqiFailed ? '这条盘超出平气法节气表的范围（1600–2200 年）' : '平气法算不出这条盘'}
        </Text>
      </View>
    );
  }

  return (
    <>
      {/* ===== 四柱 + 右侧「选中运」—— 行式表格（问真「专业细盘」版式，用户 2026-10-08） ===== */}
      <View style={[styles.card, styles.pillarCard]}>
        {pillarRows.map((row: any) => (
          <View key={row.key} style={styles.pLine}>
            <View style={[styles.rowHead, { marginRight: rpx(ROW_HEAD_GAP) }]}>
              <Text style={styles.rowHeadText}>{row.label}</Text>
            </View>
            {row.cells.map((cell: any, i: number) => (
              <React.Fragment key={i}>
                {/*
                  **只有一条**垂直分隔线：四柱 | 运限（用户 2026-10-08：
                  「分割线只限于四柱和大运之间，将原局和运限分开。年月日之间不需要分割线」）。
                  ⚠ 位置判据是 PILLAR_COUNT（第 5 个 cell 之前）—— 也就是第 4 柱与第 1 张卡之间。
                    没有运卡时（cells 只有 4 个）这条线整条不出现，四柱自己不带任何竖线。
                  ⚠ 独立一根 View 而非 cell 的 borderRight：柱是定宽 96rpx，
                    边框会吃掉内容宽度把干支挤歪。
                  ⚠ 用深一档的 COLORS.border（块分界），不再是柱间那种浅色细线。
                */}
                {i === PILLAR_COUNT ? <View style={styles.blockDivider} /> : null}
                {renderCell(row.key, cell, i)}
              </React.Fragment>
            ))}
          </View>
        ))}

        {/* 补充信息。⚠ 司令独占一行，胎元 + 交运共一行（2026-10-03 用户报 UI 问题）：
            司令的值最长（「癸司令（大雪第24.5天，距小寒4.9天）」），三项等分时
            它被挤成一行只能放五六个字的小窄条、竖着堆成四五行的「柱子」，
            与旁边两项的行数差得远，看起来像排错了。拆两行是结构性解。 */}
        <View style={styles.infoRow}>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>司令</Text>
            <Text style={styles.infoVal}>{state.siLingText}</Text>
          </View>
        </View>
        <View style={styles.infoRowSub}>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>胎元</Text>
            <Text style={styles.infoVal}>{state.taiYuanText}</Text>
          </View>
          <View style={styles.infoItem}>
            <Text style={styles.infoLabel}>交运</Text>
            <Text style={styles.infoVal}>{state.jiaoYunText}</Text>
          </View>
        </View>
      </View>

      {/* ===== 运程：大运 / 流年 / 流月 ===== */}
      {state.dayuns.length ? (
        <View style={[styles.card, styles.gzCard]}>
          <GzTable
            styles={styles}
            rpx={rpx}
            label="大运"
            list={state.dayuns}
            rowKeyOf={(it: any) => it.year}
            colKeyOf={(it: any) => it.jieQi}
            onPick={onPickDayun}
            onNote={onNoteDayun}
            anchor={M.scrollAnchor(ctx.di == null ? 0 : ctx.di)}
          />
          {state.inlineDayun ? (
            <NoteInline styles={styles} text={state.inlineDayun} />
          ) : null}

          {state.liunians.length ? (
            <GzTable
              styles={styles}
              rpx={rpx}
              label="流年"
              list={state.liunians}
              rowKeyOf={(it: any) => it.year}
              colKeyOf={(it: any) => it.jieQi}
              onPick={onPickLiunian}
              onNote={onNoteLiunian}
              anchor={M.scrollAnchor(ctx.lnIdx == null ? 0 : ctx.lnIdx)}
            />
          ) : null}
          {state.inlineLiunian ? (
            <NoteInline styles={styles} text={state.inlineLiunian} />
          ) : null}

          {state.liuyues.length ? (
            <GzTable
              styles={styles}
              rpx={rpx}
              label="流月"
              list={state.liuyues}
              rowKeyOf={(it: any) => it.jieQi}
              colKeyOf={(it: any) => it.date}
              onPick={onPickLiuyue}
              onNote={onNoteLiuyue}
              anchor={0}
            />
          ) : null}
          {state.inlineLiuyue ? (
            <NoteInline styles={styles} text={state.inlineLiuyue} />
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/**
 * 运程表（大运 / 流年 / 流月共用）。
 * 一列三行：标题行 / 副行（虚岁或月日） / 干支；干支那行两个字各自上五行色。
 * 「小运」不是干支 → 没有拆字，回退成整串一个颜色。
 *
 * ⚠ 三张表共用同一套尺寸，所以任何一张表都不能中途改列宽。
 * ⚠ 选中列是**整列**贯穿三行的色块，直角无圆角 ——
 *   一旦圆角，列与列并排时四角会露出卡片底色、看着像一格一格的胶囊。
 * ⚠ 红点是绝对定位（列高被写死），进文档流会把三行结构顶下去。
 */
function GzTable({
  styles,
  rpx,
  label,
  list,
  rowKeyOf,
  colKeyOf,
  onPick,
  onNote,
  anchor,
}: any) {
  const ref = React.useRef<ScrollView>(null);

  /**
   * 首次装配时把默认选中的列滚进可视区（大运 13 列 / 流月 12 列都超出一屏）。
   * 之后点选不再改 —— 原项目靠「scroll-into-view 只在值变化时生效」避免「点哪跳哪」，
   * 这里等价地用「只在挂载时滚一次」实现。
   */
  React.useEffect(() => {
    if (!list.length) return;
    const y = anchor * rpx(SIZES.gzColWidth);
    ref.current?.scrollTo({ x: Math.max(0, y), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.gzRow}>
      <Text style={styles.gzLabel}>{label}</Text>
      <ScrollView
        ref={ref}
        horizontal
        style={styles.gzScroll}
        contentContainerStyle={styles.gzInner}
        showsHorizontalScrollIndicator={false}
      >
        {list.map((it: any, idx: number) => (
          <Pressable
            key={it.key || idx}
            onPress={() => onPick?.(idx)}
            onLongPress={() => onNote?.(idx)}
            style={[
              styles.gzCol,
              // 选中列自身与它左边一列都不画右分隔线 ——
              // 否则细竖线会把整列反白色块从中间割开
              it.noRight && styles.gzColNoLine,
              it.active && styles.gzColOn,
            ]}
          >
            {it.note ? (
              <View style={[styles.gzDot, it.active && styles.gzDotOn]} />
            ) : null}
            <Text style={[styles.gzYear, it.active && styles.gzYearOn]}>{rowKeyOf(it)}</Text>
            {/* 第二行：大运/流年是虚岁，流月没有虚岁 → 回退画阳历月日（buildLiuyues 的 date，
                即本行设计上的「节气 / 阳历月日 / 月干支」三行结构；只写 it.age 时流月这行永远是空的） */}
            <Text style={[styles.gzAge, it.active && styles.gzAgeOn]}>
              {it.age != null ? it.age : it.date}
            </Text>
            <View style={styles.gzGzLine}>
              {it.gan ? (
                <Text
                  style={[
                    styles.gzGz,
                    { color: it.active ? ELEMENT_COLORS_ON[it.ganCls] : ELEMENT_COLORS[it.ganCls] },
                  ]}
                >
                  {it.gan}
                </Text>
              ) : null}
              {it.zhi ? (
                <Text
                  style={[
                    styles.gzGz,
                    { color: it.active ? ELEMENT_COLORS_ON[it.zhiCls] : ELEMENT_COLORS[it.zhiCls] },
                  ]}
                >
                  {it.zhi}
                </Text>
              ) : null}
              {!it.gan ? (
                <Text style={[styles.gzGz, it.active && styles.gzGzOn]}>{it.gz || colKeyOf(it)}</Text>
              ) : null}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** 选中条目写的事件正文，内联显示在对应表格下方（三层各一处） */
function NoteInline({ styles, text }: any) {
  return (
    <View style={styles.noteInline}>
      <Text style={styles.noteBadge}>记</Text>
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );
}

export function makeStyles(rpx: (v: number) => number) {
  return StyleSheet.create({
    card: {
      backgroundColor: COLORS.bg,
      borderRadius: RADII.none,   // 用户要求：结果页背景一律直角
      marginBottom: rpx(SIZES.cardGap),
    },

    // ===== 平气法专有：算不出这条盘（定气法没有这一种） =====
    pingEmptyCard: {
      paddingVertical: rpx(80),
      alignItems: 'center',
    },
    pingEmptyText: {
      fontSize: rpx(SIZES.smallCellSize),
      color: COLORS.textGhost,
    },

    // ===== 四柱 =====
    pillarCard: {
      paddingTop: rpx(SIZES.pillarCardPadTop),
      paddingBottom: rpx(SIZES.pillarCardPadBottom),
    },
    /**
     * 行式表格的一行（主星/天干/地支/藏干/星运/自坐/空亡/纳音，2026-10-08 照问真改）。
     * alignItems 用 stretch：行头与分隔线要撑满行高（藏干行最高）。
     */
    pLine: {
      flexDirection: 'row',
      alignItems: 'stretch',
      marginTop: rpx(2),
    },
    /**
     * 行头（主星/天干/…）：宽定死；文字在该行内垂直居中（藏干行时对齐三行藏干的中缝）。
     * ⚠ paddingLeft 让文字离开屏幕**左边缘**（用户 2026-10-08：「左侧加上的字直接和
     *   屏幕边缘挨在一起了」）—— 在 80 宽度**内部**，行头总占位（80+8=88）不变、四柱不动。
     *   24 与上方信息卡 headCardPadX 同值，左缘视觉一条线。
     */
    rowHead: {
      width: rpx(SIZES.rowHeadWidth),
      paddingLeft: rpx(SIZES.rowHeadPadLeft),
      justifyContent: 'center',
    },
    rowHeadText: {
      fontSize: rpx(SIZES.rowHeadTextSize),
      color: COLORS.textGhost,
    },
    /**
     * 柱 cell：定宽 96。⚠ cell 是 View 包字，不是裸 Text ——
     * 分隔线与藏干块都要撑行高，得有盒子承载。
     */
    cellPillar: {
      width: rpx(SIZES.pillarColWidth),
      alignItems: 'center',
    },
    /** 卡 cell（大运/流年/流月）：吃四柱之外的剩余宽度，均分 */
    cellCard: {
      flex: 1,
      minWidth: 0,
      alignItems: 'center',
    },
    /**
     * **唯一**一条垂直分隔线：四柱（原局）| 运限（大运/流年/流月）。
     * 用户 2026-10-08：「分割线只限于四柱和大运之间，将原局和运限分开。年月日之间不需要分割线」
     * —— 所以柱间不再有任何竖线，这条线只在**有运卡**时出现在第 4 柱之后。
     *
     * ⚠ 独立一根 View，不是 cell 的 borderRight：列定宽 96rpx，
     *   边框会吃掉内容宽度、把干支字挤歪。
     * ⚠ alignSelf: 'stretch' 撑满整行高（藏干行最高，线要跟着最长那一行）。
     * ⚠ 线宽必须 hairline：粗线会挤占列间空间把四柱撑开。
     * ⚠ 颜色用 COLORS.border（比原来的柱间浅线深一档）—— 它现在承担「分区」语义。
     */
    blockDivider: {
      alignSelf: 'stretch',
      width: StyleSheet.hairlineWidth,
      backgroundColor: COLORS.border,
    },
    /** 列头行文字（年柱/月柱/…） */
    headCellText: {
      fontSize: rpx(SIZES.pillarLabelSize),
      lineHeight: rpx(SIZES.pillarLabelSize * LINE_HEIGHTS.tight),
      color: COLORS.textGhost,
    },
    /** 主星行文字（正官/比肩/…） */
    shiShenCellText: {
      fontSize: rpx(SIZES.pillarShiShenSize),
      lineHeight: rpx(SIZES.pillarShiShenSize * LINE_HEIGHTS.snug),
      color: '#8a7a5c',
    },
    /** 日柱主星（元男/元女）给金色 */
    cellGold: {
      color: COLORS.gold,
      fontWeight: FONT_WEIGHTS.semibold,
    },
    /** 星运 / 自坐 / 空亡：小一号常规字 */
    smallCellText: {
      fontSize: rpx(SIZES.smallCellSize),
      lineHeight: rpx(SIZES.smallCellSize * LINE_HEIGHTS.snug),
      color: '#8a7a5c',
    },
    /**
     * 神煞格（行式表格最后一行）：**竖排，一颗一行**。
     * ⚠⚠ 用户 2026-10-08：「神煞不要缩写，也不要两个并列」——
     *   所以这里**不用 flexWrap 横向排**（那会并排），改成 column 竖着列。
     *   宽度不够时完整名也读得全（一列永远放得下，不需要缩字）。
     * ⚠ 颜色统一浅灰（用户定「统一灰色小字」）—— 不按吉凶/五行分色，
     *   因为 55 颗里吉凶界定的流派分歧比查法还大，分色等于把争议画进界面。
     */
    shaWrap: {
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: rpx(3),
    },
    shaChip: {
      fontSize: rpx(SIZES.smallCellSize),
      lineHeight: rpx(SIZES.smallCellSize * LINE_HEIGHTS.snug),
      color: COLORS.textGhost,
    },
    // ⚠ 改字号必须同步 selTextWrap 的 minHeight（= 字号 × 行高 × 2）
    pillarChar: {
      fontSize: rpx(SIZES.pillarCharSize),
      fontWeight: FONT_WEIGHTS.semibold,
      lineHeight: rpx(SIZES.pillarCharSize * SIZES.pillarCharLineHeight),
    },
    /**
     * 藏干块（cell 内部的堆叠）。
     * 行式布局下**不再需要**旧的 minHeight「对齐垫」：藏干数不等只在
     * 藏干行内部消化（行高 = 最多的那柱），下一行天然从新行开始。
     */
    pillarCanggan: {
      paddingTop: rpx(4),
    },
    cgItem: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'center',
    },
    cgStem: {
      fontSize: rpx(SIZES.cgStemSize),
      lineHeight: rpx(SIZES.cgStemSize * SIZES.cgLineHeight),
      fontWeight: FONT_WEIGHTS.semibold,
      marginRight: rpx(2),
    },
    cgShiShen: {
      fontSize: rpx(SIZES.cgItemSize),
      lineHeight: rpx(SIZES.cgItemSize * SIZES.cgLineHeight),
      color: COLORS.textMuted,
    },
    /**
     * 纳音行文字。
     * ⚠ 字号比藏干再小一号：柱宽定死 96rpx，纳音是三个字，
     *   22rpx 时「大林木」已经 66rpx，长纳音会换行。
     * ⚠ 颜色跟着纳音五行走（大林木 → 木色）；取不到 class 时回退成补充信息的灰。
     */
    pillarNayin: {
      fontSize: rpx(SIZES.pillarNayinSize),
      lineHeight: rpx(SIZES.pillarNayinSize * SIZES.cgLineHeight),
      color: COLORS.textMuted,
    },
    /**
     * 没有干支的卡（大运首列的「小运 / 起运前」）：占位文案顶掉干、支两行，
     * minHeight = 2 × 干支字号 × 行高 = 130rpx，保证与同行其他 cell 等高。
     * ⚠ 干支字号或行高一变，这里必须跟着改。
     */
    selTextWrap: {
      minHeight: rpx(SIZES.selTextMinHeight),
      alignItems: 'center',
      justifyContent: 'center',
    },
    selText: {
      fontSize: rpx(SIZES.selTextSize),
      fontWeight: FONT_WEIGHTS.semibold,
      color: '#8a7a5c',
      textAlign: 'center',
    },
    /** 空壳卡的内容：占位但不显示（对应原项目的 visibility: hidden） */
    hidden: {
      opacity: 0,
    },

    // ===== 补充信息 =====
    infoRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginTop: rpx(12),
      paddingTop: rpx(14),
      paddingHorizontal: rpx(SIZES.infoPadX),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: COLORS.border,
    },
    infoItem: {
      flexDirection: 'row',
      flex: 1,
      paddingRight: rpx(12),
    },
    /** 第二行（胎元 + 交运）：与 infoRow 同构，但不带分隔线、上间距收紧 ——
        分隔线只在第一行上沿画一次，画两次就是两条平行线。 */
    infoRowSub: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginTop: rpx(8),
      paddingHorizontal: rpx(SIZES.infoPadX),
    },
    infoLabel: {
      flexShrink: 0,
      paddingVertical: rpx(2),
      paddingHorizontal: rpx(10),
      marginRight: rpx(8),
      backgroundColor: COLORS.goldBgSoft,
      color: COLORS.gold,
      fontSize: rpx(SIZES.infoLabelSize),
      lineHeight: rpx(SIZES.infoLabelSize * LINE_HEIGHTS.compact),
      overflow: 'hidden',
    },
    infoVal: {
      flex: 1,
      color: COLORS.textSub,
      fontSize: rpx(SIZES.infoValSize),
      lineHeight: rpx(SIZES.infoValSize * 1.35),
    },

    // ===== 运程卡 =====
    gzCard: {
      paddingTop: rpx(SIZES.gzCardPadTop),
      paddingBottom: rpx(SIZES.gzCardPadBottom),
    },
    gzRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: rpx(SIZES.gzRowMarginTop),
    },
    gzLabel: {
      flexShrink: 0,
      width: rpx(SIZES.gzLabelWidth),
      marginRight: rpx(SIZES.gzLabelMarginRight),
      fontSize: rpx(SIZES.gzLabelSize),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.gold,
      textAlign: 'center',
      lineHeight: rpx(SIZES.gzLabelSize * LINE_HEIGHTS.tight),
    },
    // scroll-view 必须有确定高度才能横向滚动
    gzScroll: {
      flex: 1,
      height: rpx(SIZES.gzScrollHeight),
    },
    gzInner: {
      flexDirection: 'row',
    },
    gzCol: {
      width: rpx(SIZES.gzColWidth),   // ⚠ 三张表写死同一个值
      flexShrink: 0,
      position: 'relative',           // 红点的定位参照
      paddingVertical: rpx(SIZES.gzColPadY),
      alignItems: 'center',
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: COLORS.borderLight,
    },
    gzColNoLine: {
      borderRightColor: 'transparent',
    },
    gzColOn: {
      backgroundColor: COLORS.onBg,
    },
    gzYear: {
      fontSize: rpx(SIZES.gzYearSize),
      lineHeight: rpx(SIZES.gzYearLineHeight),
      color: COLORS.textMuted,
    },
    gzYearOn: {
      color: COLORS.onTextYear,
    },
    gzAge: {
      fontSize: rpx(SIZES.gzAgeSize),
      lineHeight: rpx(SIZES.gzAgeLineHeight),
      color: COLORS.textFaint,
    },
    gzAgeOn: {
      color: COLORS.onTextYear,
    },
    gzGzLine: {
      flexDirection: 'row',
    },
    gzGz: {
      fontSize: rpx(SIZES.gzGzSize),
      fontWeight: FONT_WEIGHTS.semibold,
      lineHeight: rpx(SIZES.gzGzLineHeight),
    },
    gzGzOn: {
      color: COLORS.onTextGz,
    },
    /**
     * 红点：有事件的格子右上角一枚。
     * ⚠ 必须绝对定位 —— 列高被 gzScroll 的写死高度卡住，进文档流会把三行结构顶下去。
     * ⚠ 颜色是**红**不是主题金：整屏就是米金/浅米色系，同色系的点几乎看不出来。
     */
    gzDot: {
      position: 'absolute',
      top: rpx(3),
      right: rpx(3),
      width: rpx(SIZES.gzDotSize),
      height: rpx(SIZES.gzDotSize),
      borderRadius: rpx(SIZES.gzDotSize / 2),
      backgroundColor: COLORS.danger,
    },
    gzDotOn: {
      backgroundColor: COLORS.dangerOn,
    },

    // ===== 事件正文内联 =====
    noteInline: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginTop: rpx(12),
      marginHorizontal: rpx(SIZES.noteMarginX),
      marginBottom: rpx(4),
      paddingVertical: rpx(12),
      paddingHorizontal: rpx(16),
      backgroundColor: '#fbf6ec',
      // 左侧一道金线代替圆角框：与本页「一律直角」一致
      borderLeftWidth: rpx(4),
      borderLeftColor: '#d9c286',
    },
    noteBadge: {
      flexShrink: 0,
      width: rpx(SIZES.noteBadgeSize),
      height: rpx(SIZES.noteBadgeSize),
      lineHeight: rpx(SIZES.noteBadgeSize),
      textAlign: 'center',
      fontSize: rpx(20),
      color: COLORS.bg,
      backgroundColor: COLORS.gold,
      marginRight: rpx(12),
      overflow: 'hidden',
    },
    noteText: {
      flex: 1,
      fontSize: rpx(SIZES.noteTextSize),
      lineHeight: rpx(SIZES.noteTextSize * LINE_HEIGHTS.body),
      color: '#6b5a3e',
    },
  });
}
