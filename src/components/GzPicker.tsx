/**
 * 四柱录入面板（八步向导）
 *
 * 逻辑层 `core/gzstep.js` 是**原样搬过来的**（零改动）。本文件只管画 + 接手势。
 *
 * ⚠ 2026-10-01 改版（原项目的历史，这里照搬）：
 *   原来是四列各滚一条 60 甲子（4 × 60 = 240 个格子），用户反馈「太过于麻烦了」——
 *   既要在长列表里翻「甲子」这种分散项，又得自己保证天干地支配得上。
 *   现在改成**一柱拆成干 / 支两步**的八步向导：
 *
 *     年干(10) → 年支(6) → 月干(10) → 月支(1~2)
 *   → 日干(10) → 日支(6) → 时干(10) → 时支(1~2)
 *
 *   支的那四步只给「配得上的」（年/日支同奇偶 6 个；月/时支按五虎遁 / 五鼠遁只剩 1~2 个），
 *   走完必定是一个历法上存在的四柱。选项怎么算是 gzstep.js 的事，组件不过问。
 *
 * ⚠ 选项区**不再常驻面板** —— 四柱表常驻，点表上任意一格弹出白色浮框，在浮框里点字写入。
 *   `pop` 只管浮框开合；选项内容仍由 render() 每次整份算好。
 *
 * 四个状态（status）：input（录入中）/ loading（推算中）/ result（列出候选）/ empty（查不到）
 */
import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Modal,
  useWindowDimensions,
} from 'react-native';

import * as gs from '../core/gzstep';
import { COLORS, RADII, LINE_HEIGHTS, FONT_WEIGHTS } from '../theme/tokens';
import { useRpx } from '../theme/rpx';

const PANEL_HEIGHT_RATIO = 0.88;

export type GzPickerProps = {
  visible: boolean;
  /** { year, month, day, hour } 已录入的四柱干支（再打开时回填） */
  pillars?: { year: string; month: string; day: string; hour: string } | null;
  /** 候选项（父级调 core/sizhu 的 search 算好传进来） */
  list?: any[];
  status?: 'input' | 'loading' | 'result' | 'empty';
  /** 点「查找出生日期」→ detail = { year, month, day, hour } */
  onSearch?: (pillars: any) => void;
  /** 选中一条候选 → detail = { date, time, pillars } */
  onPick?: (v: { date: string; time: string; pillars: any }) => void;
  /** 从结果 / 空态返回改四柱 */
  onBack?: () => void;
  /** 取消或点遮罩 */
  onClose?: () => void;
};

export default function GzPicker({
  visible,
  pillars = null,
  list = [],
  status = 'input',
  onSearch,
  onPick,
  onBack,
  onClose,
}: GzPickerProps) {
  const rpx = useRpx();
  const { height: screenHeight } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(rpx), [rpx]);

  /** 已选的八步（原项目放在 this.picks 上，不进 data） */
  const picksRef = useRef<string[]>(gs.emptyPicks());
  const [step, setStep] = useState(0);
  /**
   * picks 的「版本号」——**只用来驱动重算 view**。
   *
   * ⚠⚠⚠ 为什么必须有它：picks 存在 ref 里，改 ref **不会触发重渲染**；
   *   而 view 的 useMemo 原来只依赖 [visible, step]。
   *   前七步每次都把 step 往下推一格（0→1→…→7），依赖变了、view 顺带重算，
   *   于是看起来一切正常。但**最后一步（时支）是终点**：选完 firstEmpty 返回 -1，
   *   nextStepOf 仍停在 7 ⇒ step 没变 ⇒ 依赖没变 ⇒ view 不重算
   *   ⇒ 格子还显示「—」、ready 还是 false，「查找出生日期」也不亮 ——
   *   用户报的「时支怎么都选不上去」正是这一条（选了，但界面上没写进去）。
   * ⚠ 别改成「把 picks 也塞进 state」：那要动 onPickGZ / 回填 / 收敛一整套，
   *   而 ref + 版本号覆盖了同样的需求，且每次都**显式**宣告「picks 变了」。
   */
  const [picksRev, setPicksRev] = useState(0);
  /** 选项浮框：点四柱表的格子才弹出（2026-10-01 改版，选项区不再常驻面板） */
  const [pop, setPop] = useState(false);

  /** 展开：以上一次录入的四柱为起点 */
  useEffect(() => {
    if (!visible) return;
    picksRef.current = gs.pillarsToPicks(pillars);
    setStep(nextStepOf(picksRef.current));
    /* ⚠ 回填同样要宣告 —— 每次打开面板都是「picks 变了」，
       视图必须按新 picks 重算（否则会显示上一次打开时的格子） */
    setPicksRev((n) => n + 1);
    // ⚠ 浮框必须重置成收起 —— 上次可能没收就关了面板
    setPop(false);
  }, [visible, pillars]);

  /** 该展示哪一步：第一个没选的；全选好了停在最后一步 */
  function nextStepOf(picks: string[]) {
    const at = gs.firstEmpty(picks);
    return at < 0 ? gs.STEPS.length - 1 : at;
  }

  /**
   * 把「第几步 + 当前状态」摊平成模板要的几份数据（换算全在 gzstep.view 里）。
   * ⚠⚠⚠ 依赖里**必须**带 picksRev —— 只写 [visible, step] 的话，最后一步（时支，见上）
   *   改完 picks 而 step 不变，视图就永远停在旧值上（用户实测报障）。
   */
  const view = useMemo(() => {
    if (!visible) return null;
    return gs.view({ picks: picksRef.current }, step);
  }, [visible, step, picksRev]);

  /**
   * 点浮框里的某个值：认下来 → 收浮框 → 表格上高亮下一个空缺的格子。
   *
   * ⚠ 真机上被挡掉 / 置灰的节点照样会派发点击，光靠样式拦不住，所以这里有两道：
   *   ① 白名单：只认「这一步真的给出的那个值」；
   *   ② `gs.normalize`：把配不上的选择清掉。
   *   负向验证里实测过 —— 两道都拿掉，「点个非法值也能写进年支」立刻报红；
   *   只拿掉任一道则行为完全一致（①对②是冗余的防御）。留着①是为了让「这一步只收这些值」
   *   这件事在代码里看得见，也免得哪天有人把 normalize 去掉而没人发现。
   */
  const onPickGZ = useCallback(
    (v: string) => {
      if (!view) return;
      const picks = picksRef.current;
      const opts = view.grid.options;
      let hit = false;
      for (let k = 0; k < opts.length; k++) {
        if (opts[k].v === v) { hit = true; break; }
      }
      if (!hit) return;

      const next = picks.slice();
      next[step] = v;
      // 改前面一步时，后面配不上的选择要一起让位（只清配不上的，见 gzstep.normalize）
      picksRef.current = gs.normalize(next);
      /* ⚠⚠ 必须宣告 picks 变了 —— 最后一步时 step 不变（见 picksRev 的说明），
         不出这一下，视图不会重算、格子看着像没选上 */
      setPicksRev((n) => n + 1);
      setStep(nextStepOf(picksRef.current));
      setPop(false);
    },
    [view, step],
  );

  /**
   * 点四柱表里的某一格：把那一步的选项装进浮框、弹出来。
   * ⚠ data.i 是**八步的下标**（0~7），不是柱序号 —— 换算在 gzstep 里做过一次，
   *   这里别再除 2。
   */
  const onCrumb = useCallback((i: number) => {
    if (!(i >= 0 && i < gs.STEPS.length)) return;
    setStep(i);
    setPop(true);
  }, []);

  const onSearchTap = useCallback(() => {
    if (!view?.ready || status === 'loading') return;
    onSearch?.(gs.picksToPillars(picksRef.current));
  }, [view, status, onSearch]);

  const onChoose = useCallback(
    (i: number) => {
      const it = list[i];
      if (!it) return;
      onPick?.({
        date: it.pickDate,
        time: it.pickTime,
        pillars: gs.picksToPillars(picksRef.current),
      });
    },
    [list, onPick],
  );

  if (!visible || !view) return null;

  const g = view.grid;
  const panelHeight = screenHeight * PANEL_HEIGHT_RATIO;
  const isInput = status === 'input' || status === 'loading';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.mask}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={[styles.panel, { height: panelHeight }]}>
          <View style={styles.head}>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.act}>取消</Text>
            </Pressable>
            <Text style={styles.title}>
              {status === 'result' || status === 'empty' ? '选择出生日期' : '录入四柱'}
            </Text>
            <Text style={[styles.act, styles.actGhost]} />
          </View>

          {isInput ? (
            <View style={styles.body}>
              {/*
                四柱表：一列一根柱（年 月 日 时），**上面是干、下面是支**。
                ⚠ 干、支两个格子**必须一样高**（高由 gzpCrumbItem.height 给，字由 gzpCrumbV 给），
                  否则同一行里干格 / 支格会错位、四根柱看着不在一条水平线上。
                ⚠ 值那一格**不条件渲染**（没选时显示「—」）—— 条件渲染的话整张表的高度
                  会随选中进度变，每次弹出浮框表格都会跳一下。
                ⚠ table-zone 必须 relative + 高于 scrim：浮框才能贴着表底弹出，
                  且点表上别的格子能直接换目标，不用先收一次浮框。
              */}
              <View style={styles.tableZone}>
                <View style={styles.crumb}>
                  {view.crumbCols.map((col) => (
                    <View key={col.key} style={styles.crumbCol}>
                      <Text style={[styles.crumbH, col.active && styles.crumbHOn]}>
                        {col.title}
                      </Text>
                      {col.cells.map((cell) => (
                        <Pressable
                          key={cell.i}
                          onPress={() => onCrumb(cell.i)}
                          style={[styles.crumbItem, cell.active && styles.crumbItemOn]}
                        >
                          <Text
                            style={[styles.crumbV, !cell.done && styles.crumbVEmpty]}
                          >
                            {cell.show}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ))}
                </View>

                {/*
                  选项浮框：点格子才出现，absolute top:100%，**不占文档流** ——
                  弹出 / 收起面板其他部分纹丝不动。箭头贴在浮框顶边中央，指向四柱表。
                  ⚠ **浮框里没有任何提示文字**（用户要求「不要加入提示字」）：
                    标题、步骤号、口诀提示一律不出现 —— gzstep 仍会算出来，只是不渲染。
                  ⚠ 格子上显示的是 `item.v`（干 / 支的字本身），不是 `item.gz`：
                    选地支时只该出现地支那一个字，拼成「丁酉」是多余的。
                  ⚠ 格子下的小字 `item.sub` 不是「提示」，是选项本身的信息
                    （月建 / 时辰区间）—— 保留。
                */}
                {pop ? (
                  <View style={styles.pop}>
                    <View style={styles.popArrow} />
                    <View style={styles.cells}>
                      {g.options.map((opt) => (
                        <View
                          key={opt.v}
                          style={[
                            styles.cell,
                            { width: `${100 / g.cols}%` },
                          ]}
                        >
                          <Pressable
                            onPress={() => onPickGZ(opt.v)}
                            style={[styles.cellIn, opt.on && styles.cellInOn]}
                          >
                            <Text style={[styles.cellGz, opt.on && styles.cellGzOn]}>
                              {opt.v}
                            </Text>
                            {opt.sub ? <Text style={styles.cellSub}>{opt.sub}</Text> : null}
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}
              </View>

              {/*
                浮框的透明遮罩：盖住面板其余部分，点外面收起浮框。
                表（tableZone）和顶部「取消」的 z-index 都压在它上面，照常可点 ——
                点表 = 直接换目标，点「取消」= 整个面板关掉。
              */}
              {pop ? (
                <Pressable style={styles.popScrim} onPress={() => setPop(false)} />
              ) : null}

              {/* 弹性空白：把「查找」按钮压到底部 */}
              <View style={styles.space} />

              <View style={styles.foot}>
                <Pressable
                  onPress={onSearchTap}
                  style={[styles.btn, !(view.ready && status === 'input') && styles.btnOff]}
                >
                  <Text style={[styles.btnText, !(view.ready && status === 'input') && styles.btnTextOff]}>
                    {status === 'loading' ? '正在推算…' : '查找出生日期'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {status === 'result' ? (
            <View style={styles.body}>
              <Text style={styles.sum}>
                1000 – 2050 年之间共 <Text style={styles.sumN}>{list.length}</Text> 个可能的出生日期
              </Text>

              <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
                {list.map((it, i) => (
                  <View key={i} style={styles.card}>
                    <View style={styles.cardBody}>
                      <View style={styles.cardL1}>
                        <Text style={styles.cardDate}>{it.dateText}</Text>
                        <Text style={styles.cardWeek}>{it.weekText}</Text>
                        {it.agoText ? <Text style={styles.cardAgo}>{it.agoText}</Text> : null}
                      </View>
                      <Text style={styles.cardL2}>
                        {it.lunarText} · {it.zhiText}
                      </Text>
                      <View style={styles.cardL3}>
                        <Text style={styles.cardTime}>{it.timeText}</Text>
                        {it.narrow ? (
                          <Text style={styles.cardNarrow}>
                            交节当天，实际 {it.spanText}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    <Pressable onPress={() => onChoose(i)}>
                      <Text style={styles.cardPick}>选它</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>

              <View style={styles.foot}>
                <Pressable onPress={onBack} style={[styles.btn, styles.btnGhost]}>
                  <Text style={[styles.btnText, styles.btnTextGhost]}>返回修改四柱</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {status === 'empty' ? (
            <View style={styles.body}>
              <View style={styles.empty}>
                <Text style={styles.emptyT}>
                  这个八字在 1000 – 2050 年之间找不到出生日期
                </Text>
                <Text style={styles.emptyS}>
                  四柱本身是合法的（干支配得上、口诀也对），但这一组在那个年代范围里没有对应的日子。换一年柱看看？
                </Text>
              </View>
              <View style={styles.foot}>
                <Pressable onPress={onBack} style={[styles.btn, styles.btnGhost]}>
                  <Text style={[styles.btnText, styles.btnTextGhost]}>返回修改四柱</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(rpx: (v: number) => number) {
  return StyleSheet.create({
    mask: {
      flex: 1,
      backgroundColor: COLORS.scrim,
      justifyContent: 'flex-end',
    },
    panel: {
      position: 'relative',
      width: '100%',
      backgroundColor: COLORS.bg,
      borderTopLeftRadius: rpx(RADII.panel),
      borderTopRightRadius: rpx(RADII.panel),
      paddingBottom: rpx(40),
    },
    body: {
      flex: 1,
    },

    // ---------- 顶部 ----------
    head: {
      position: 'relative',
      zIndex: 4,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: rpx(26),
      paddingHorizontal: rpx(32),
      paddingBottom: rpx(6),
    },
    title: {
      fontSize: rpx(30),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.text,
    },
    // 左右两个操作位要等宽，标题才会真的居中；右侧那个是纯占位，不给文字
    act: {
      minWidth: rpx(88),
      fontSize: rpx(28),
      lineHeight: rpx(28 * LINE_HEIGHTS.normal),
      color: COLORS.textFaint,
    },
    actGhost: {
      textAlign: 'right',
    },

    // ---------- 四柱表 ----------
    tableZone: {
      position: 'relative',
      zIndex: 3,
    },
    crumb: {
      flexDirection: 'row',
      paddingTop: rpx(20),
      paddingHorizontal: rpx(24),
    },
    crumbCol: {
      width: '25%',
      alignItems: 'center',
      paddingTop: rpx(10),
      paddingHorizontal: rpx(8),
      paddingBottom: rpx(12),
      borderRadius: rpx(14),
    },
    crumbH: {
      fontSize: rpx(22),
      lineHeight: rpx(22 * 1.3),
      color: '#c0b8ab',
    },
    crumbHOn: {
      color: COLORS.gold,
    },
    /**
     * 可点的「格子」本体：定高 + 浅底色块。
     * ⚠ 高度是「手指好不好点」的问题：录入四柱就是**点这张表**，
     *   112rpx 高 + 44rpx 字是**下限**，别缩回去。
     */
    crumbItem: {
      marginTop: rpx(10),
      width: '100%',
      height: rpx(112),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: COLORS.bgCell,
      borderRadius: rpx(RADII.card),
    },
    crumbItemOn: {
      backgroundColor: COLORS.goldBg,
    },
    /** 字本身只管字号（下限 44rpx），高度交给上面的格子 —— 别在这里写 height */
    crumbV: {
      fontSize: rpx(44),
      lineHeight: rpx(44 * LINE_HEIGHTS.compact),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.gold,
    },
    crumbVEmpty: {
      fontWeight: FONT_WEIGHTS.normal,
      color: '#d8cfbf',
    },

    // ---------- 浮框 ----------
    /* ⚠ RN 0.86 已删掉 StyleSheet.absoluteFillObject（运行时 undefined，
       展开它 = 遮罩完全没有定位、盖不住底下内容）。显式写四边。 */
    popScrim: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      zIndex: 2,
    },
    pop: {
      position: 'absolute',
      left: rpx(24),
      right: rpx(24),
      top: '100%',
      marginTop: rpx(20),
      zIndex: 5,
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.panel),
      paddingVertical: rpx(26),
      paddingHorizontal: rpx(28),
      // 阴影（原项目 box-shadow: 0 10rpx 40rpx rgba(60,45,20,0.18)）
      shadowColor: 'rgba(60, 45, 20, 1)',
      shadowOffset: { width: 0, height: rpx(10) },
      shadowOpacity: 0.18,
      shadowRadius: rpx(40),
      elevation: 8,
    },
    /** 箭头：贴在浮框顶边中央，指向四柱表（旋转 45° 的方块） */
    popArrow: {
      position: 'absolute',
      top: rpx(-10),
      left: '50%',
      width: rpx(20),
      height: rpx(20),
      marginLeft: rpx(-10),
      backgroundColor: COLORS.bg,
      borderRadius: rpx(4),
      transform: [{ rotate: '45deg' }],
    },
    cells: {
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    /**
     * ⚠ 格子尺寸是「手指好不好点」的问题：用户反馈过旧版「太小、不好操作」，
     *   所以 128rpx 高 + 56rpx 字是**下限**，别缩回去。
     */
    cell: {
      paddingVertical: rpx(10),
      paddingHorizontal: rpx(6),
    },
    cellIn: {
      height: rpx(128),
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: rpx(RADII.card),
    },
    cellInOn: {
      backgroundColor: COLORS.goldBg,
    },
    cellGz: {
      fontSize: rpx(56),
      lineHeight: rpx(56 * LINE_HEIGHTS.compact),
      color: '#555555',
    },
    cellGzOn: {
      color: COLORS.gold,
      fontWeight: FONT_WEIGHTS.semibold,
    },
    /** 月支 / 时支的小字补充（月建名 · 起节 / 时辰区间），干与年日支没有 */
    cellSub: {
      marginTop: rpx(6),
      fontSize: rpx(24),
      lineHeight: rpx(24 * 1.3),
      color: '#b3a68e',
    },

    // ---------- 弹性空白 ----------
    space: {
      flex: 1,
    },

    // ---------- 结果：候选列表 ----------
    sum: {
      paddingTop: rpx(6),
      paddingHorizontal: rpx(32),
      paddingBottom: rpx(14),
      textAlign: 'center',
      fontSize: rpx(24),
      color: COLORS.textMuted,
    },
    sumN: {
      fontSize: rpx(28),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.gold,
    },
    list: {
      flex: 1,
    },
    listInner: {
      paddingHorizontal: rpx(24),
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: rpx(20),
      paddingHorizontal: rpx(24),
      backgroundColor: COLORS.bgSoft,
      borderRadius: rpx(RADII.card),
      marginBottom: rpx(14),
    },
    cardBody: {
      flex: 1,
    },
    cardL1: {
      flexDirection: 'row',
      alignItems: 'baseline',
    },
    cardDate: {
      fontSize: rpx(32),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.text,
    },
    cardWeek: {
      fontSize: rpx(22),
      color: COLORS.textMuted,
      marginLeft: rpx(12),
    },
    /** 推到头：把「距今多少年」贴到右边，扫一眼就知道离现在多远 */
    cardAgo: {
      marginLeft: 'auto',
      fontSize: rpx(22),
      color: COLORS.goldPale,
    },
    cardL2: {
      fontSize: rpx(24),
      lineHeight: rpx(24 * LINE_HEIGHTS.normal),
      color: '#888888',
      marginTop: rpx(8),
    },
    cardL3: {
      flexDirection: 'row',
      alignItems: 'baseline',
      marginTop: rpx(6),
    },
    cardTime: {
      fontSize: rpx(23),
      lineHeight: rpx(23 * LINE_HEIGHTS.normal),
      color: COLORS.gold,
    },
    /** 被交节切过的那一条：真实的可用时间段比标称的时辰短，要显出来 */
    cardNarrow: {
      fontSize: rpx(23),
      lineHeight: rpx(23 * LINE_HEIGHTS.normal),
      color: COLORS.warn,
      marginLeft: rpx(10),
    },
    cardPick: {
      marginLeft: rpx(20),
      paddingVertical: rpx(12),
      paddingHorizontal: rpx(26),
      borderRadius: rpx(RADII.btn),
      backgroundColor: COLORS.goldBg,
      color: COLORS.gold,
      fontSize: rpx(26),
      lineHeight: rpx(26 * 1.3),
      overflow: 'hidden',
    },

    // ---------- 查不到 ----------
    empty: {
      flex: 1,
      paddingTop: rpx(60),
      paddingHorizontal: rpx(52),
      alignItems: 'center',
    },
    emptyT: {
      fontSize: rpx(30),
      lineHeight: rpx(30 * 1.5),
      color: COLORS.textSub,
      textAlign: 'center',
    },
    emptyS: {
      fontSize: rpx(24),
      lineHeight: rpx(24 * LINE_HEIGHTS.loose),
      color: '#aaaaaa',
      marginTop: rpx(18),
      textAlign: 'center',
    },

    // ---------- 底 ----------
    foot: {
      paddingTop: rpx(22),
      paddingHorizontal: rpx(32),
    },
    btn: {
      height: rpx(88),
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: rpx(RADII.btn),
      backgroundColor: COLORS.gold,
    },
    btnOff: {
      backgroundColor: '#e8e2d8',
    },
    btnGhost: {
      backgroundColor: COLORS.bgSoft,
    },
    btnText: {
      fontSize: rpx(30),
      lineHeight: rpx(88),
      color: COLORS.bg,
    },
    btnTextOff: {
      color: '#b9b2a6',
    },
    btnTextGhost: {
      color: COLORS.gold,
    },
  });
}
