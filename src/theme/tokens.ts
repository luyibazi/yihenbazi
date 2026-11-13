/**
 * 设计令牌（单一来源）
 *
 * 原项目是抖音小程序，尺寸单位一律 `rpx`（750rpx = 屏幕宽）。RN 没有 rpx，
 * 所以这里把「设计稿上的 rpx 值」原样保留成数字，由 `rpx()` / `useRpx()` 在运行时
 * 按当前屏宽换算成 dp —— 好处是：
 *   ① 迁移对照时可以逐值核对，不用心算（1rpx 在 375pt 屏上 = 0.5pt）；
 *   ② 屏宽变化（折叠屏 / 平板）时整块盘按比例缩放，与小程序的行为一致。
 *
 * ⚠ 原项目 chart-view.ttss 里有一笔「可用宽 698rpx = 一屏 11 列」的预算，
 *   那是靠 `.page` / `.card` 左右 padding **保持 0** 才成立的。
 *   这里同样把 pagePadX / cardPadX 显式写出来，改它们就必须重算运程表的列宽。
 */

/** 设计稿基准宽（与小程序一致） */
export const DESIGN_WIDTH = 750;

export const COLORS = {
  // ---- 文字 ----
  text: '#333333',
  textSub: '#666666',
  textMuted: '#999999',
  textFaint: '#b5b5b5',
  textGhost: '#c2c2c2',

  // ---- 主题米金 ----
  gold: '#a9814e',
  goldLight: '#c9b68f',
  goldPale: '#c2b280',
  goldBg: '#f3ead9',
  goldBgSoft: '#f6f1e7',
  goldBgFaint: '#faf8f4',

  // ---- 背景 / 描边 ----
  bg: '#ffffff',
  bgSoft: '#faf8f4',
  bgCell: '#f7f4ee',
  border: '#ece4d6',
  borderLight: '#f2ede4',

  // ---- 语义色 ----
  danger: '#e5342b',       // 事件记录红点（结果页唯一的强调色）
  dangerOn: '#ff5b4d',     // 黑底选中列上的红点，提亮一档
  warn: '#c2764a',         // 交节切过的候选条目
  scrim: 'rgba(0, 0, 0, 0.35)',

  // ---- 五行配色（照问真「天干地支按五行着色」）----
  mu: '#2e9e63',
  huo: '#d33a2c',
  tu: '#a9743a',
  jin: '#c09a2c',
  shui: '#2a6fb0',

  // ---- 五行：黑底选中列上的提亮版 ----
  muOn: '#56cf90',
  huoOn: '#ff8474',
  tuOn: '#e0aa62',
  jinOn: '#eccb62',
  shuiOn: '#74b6ee',

  // ---- 结果页选中列（黑底反白）----
  onBg: '#161616',
  onTextYear: '#c2b280',
  onTextGz: '#c9a96a',
};

/**
 * 字号 / 行高 / 间距 —— 全部是**设计稿 rpx 原值**，用 rpx() 换算。
 * 注释里的「为什么」是从原项目源码搬过来的，别当废话删掉：
 * 这些值大多是「抠过的」，改一个要连带改别处。
 */
export const SIZES = {
  // 页面
  pagePadTop: 20,
  pagePadBottom: 40,
  pagePadX: 0,        // ⚠ 必须 0 —— 「一屏 11 列」的推导前提
  cardPadX: 0,        // ⚠ 同上
  cardGap: 24,
  /**
   * ⚠ 记录页工具栏（筛选 + 姓名查询，钉在列表上方）之下、列表第一张卡之上
   * 的那段留白。工具栏是 ScrollView 的**兄弟**、压在上面 ⇒ 不补这段的话
   * 列表第一张卡会钻到工具栏底下（上半截被盖住）。
   * 值取 `cardGap` 稍小一档，看起来是「工具栏 → 间隔 → 第一张卡」，
   * 而不是两张卡之间那么宽。
   */
  toolBarGap: 16,

  // 基本信息卡
  headCardPadTop: 16,
  headCardPadBottom: 14,
  headCardPadX: 24,
  headNameSize: 38,
  headTagSize: 19,
  headKeySize: 19,
  headKeyWidth: 56,
  headValSize: 23,

  // 四柱（行式表格，2026-10-08 照问真「专业细盘」改：左行头 + 值列）
  pillarCardPadTop: 10,
  pillarCardPadBottom: 8,
  pillarColWidth: 96,
  rowHeadWidth: 80,       // 行头列（主星/天干/…两字）⚠ 80 + 行头右间隙 8 = 88 = 旧行头宽
  rowHeadPadLeft: 24,     // 行头文字离屏幕左边缘（在 80 内部 ⇒ 总占位不变、四柱不动）；与 headCardPadX 同值对齐
  rowHeadTextSize: 21,
  pillarLabelSize: 22,    // 列头行（年柱/月柱/…）
  pillarShiShenSize: 24,  // 主星行
  pillarCharSize: 54,     // 天干/地支行 ⚠ 改它必须同步 selTextMinHeight
  pillarCharLineHeight: 1.2,
  smallCellSize: 21,      // 星运/自坐/空亡行 ⚠ 神煞行也用它（竖排完整名要放得下「天乙贵人」5 字）
  /**
   * 小运「起运前」占位格的最小高度 = **一行**大字（54 × 1.2）。
   * ⚠⚠ 行式版式下天干行只有一行大字，占位格与同行柱 cell 等高即可；
   *   列式时代的 130（= 两行）会把整行撑出一段**两倍高**的透明空白
   *   （2026-10-08 真机：流月未选中的天干格走了占位格，地支与藏干之间多出一大段空隙）。
   */
  selTextMinHeight: 65,   // = 54 × 1.2（一行大字）
  selTextSize: 26,

  // 藏干
  cgItemSize: 19,
  cgStemSize: 22,
  cgLineHeight: 1.25,

  // 纳音行
  // ⚠ 不能跟着 cgStemSize 走：纳音是三个字，柱宽定死 96rpx
  pillarNayinSize: 19,

  // 补充信息（司令 / 胎元 / 交运）
  infoPadX: 24,
  infoLabelSize: 19,
  infoValSize: 21,

  // 运程表
  gzCardPadTop: 16,
  gzCardPadBottom: 12,
  gzRowMarginTop: 16,
  gzLabelWidth: 40,
  gzLabelMarginRight: 12,
  gzLabelSize: 26,
  gzColWidth: 63,         // ⚠ 按可用宽 698rpx 反推，一屏 11 列
  gzColPadY: 6,
  gzYearSize: 24,
  gzYearLineHeight: 30,
  gzAgeSize: 22,
  gzAgeLineHeight: 28,
  gzGzSize: 26,
  gzGzLineHeight: 32,
  // = 2×列内上下 padding + 三行行高之和
  gzScrollHeight: 102,
  gzDotSize: 12,

  // 事件正文内联
  noteMarginX: 24,
  noteTextSize: 24,
  noteBadgeSize: 30,

  // 空态
  emptyIconSize: 120,
  emptyIconFontSize: 48,
  emptyTextSize: 28,
  emptyTipSize: 24,
};

/** 圆角：结果页一律直角，按钮 / 弹层除外 */
export const RADII = {
  none: 0,
  btn: 9999,
  panel: 24,
  card: 16,
  cell: 12,
};

/**
 * 行高倍数（RN 的 lineHeight 要绝对值，这里存倍数供换算）。
 * ⚠ `as const` 不是装饰：没有它 TS 会把 '600' 放宽成 string，
 *   赋给 TextStyle['fontWeight'] 就是一整片类型错（运行时没事，但 tsc 全红）。
 */
export const LINE_HEIGHTS = {
  body: 1.6,
  tight: 1.15,
  snug: 1.25,
  compact: 1.2,
  normal: 1.4,
  loose: 1.7,
} as const;

export const FONT_WEIGHTS = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;
