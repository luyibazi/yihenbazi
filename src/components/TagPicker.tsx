/**
 * 自定义标签的两个可复用件：**标签栏** + **归类面板**（记录页在用）
 *
 * ============ 两个件的分工 ============
 *   · `TagBar`    —— 列表上方那一行：「全部 / 未分类 / 各标签」（**可滑**）
 *                    + 右端一枚**固定**的「管理」
 *   · `TagPicker` —— 标签面板，**两种形态**（见 `mode`，由调用方选）：
 *                    · `'pick'`（结果页「详细信息 → 标签」）= **只换标签**（选 / 取消归类）
 *                    · `'manage'`（记录页「管理」）      = **只管标签本身**（建 / 改名 / 删）
 *
 * ============ 组件边界（哪些东西刻意留在调用方）============
 *   · **筛选项与计数**：`TagBar` 只吃 `items`（由 screens/records/model.js 的
 *     `tagBar()` 算好，带 on/count）—— 计数口径是页面的事，组件不猜。
 *   · **标签数据与请求**：面板不自己发请求，只把意图（选中/新建/改名/删除）交给
 *     调用方去执行。所以它拿得到 `busy` / `err` 两个由调用方喂进来的状态。
 *     ⚠ 这条分工是为了让「谁是权威」唯一：标签列表只有一份（页面持有），
 *       组件里再存一份副本 ⇒ 迟早出现「面板里显示的和列表里的不一样」。
 *   · **谁被归类**：面板只知道 `currentId`；它不关心是哪个八字
 *     （所以它天然可以复用到别的页面去做「按标签筛」）。
 *
 * ============ 局部态（只在面板存活期间有意义）============
 *   `newName`（正在打的新名字）/ `editingId`+`editingName`（正在改哪一条）/
 *   `confirmId`（正在确认删哪一条）。
 *   ⚠ 这几个都在 `visible` 翻真时**清空**：面板是常驻挂载的（不条件渲染），
 *     不清的话，「上次打了一半的新名字」会在下次打开时还躺在输入框里 ——
 *     看起来像是面板自己记住了什么，而用户完全不知道那是哪来的。
 *
 * ============ 删除必须是「两段式」 ============
 *   ⚠⚠ 删标签是一个**不可逆**的动作，而且它牵扯到「分类里的东西会怎样」。
 *   所以不给一按就删：先在那一行就地摊开一句
 *   「删除「客户」？3 条记录会回到未分类」+ 确定/取消。
 *   ⚠ 那句话里**必须**有「记录会回到未分类」这半句 ——
 *     不说的话用户会以为**记录也一起删了**（这是最容易做错、也最吓人的一种误解）。
 *   与结果页的编辑框、管理端的自绘确认框同一套路（不用系统 Alert：
 *   它的按钮文案、位置都不可控，也没法断言）。
 *
 * ============ 键盘避让 ============
 * 遮罩用 `absolute` 铺满**所在的容器**，而调用方是 tab 页面 ——
 * 页面容器本身就在 App 根节点的 KeyboardAvoid 里（见 App.tsx），
 * 所以这里**别再叠一层**（红线：全局只有一层），也**不用**自己减 eaten：
 * 容器已经矮了一截，absolute 铺满即正确。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useRpx } from '../theme/rpx';
import { COLORS, FONT_WEIGHTS, RADII } from '../theme/tokens';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const tagsLib: any = require('../core/tags.js');

/** 标签 id 的保留值（「未分类」）—— 从 core/tags.js 取，别在这儿抄一份常量 */
const TAG_NONE: string = tagsLib.TAG_NONE;

function useStyles() {
  const rpx = useRpx();
  return useMemo(() => StyleSheet.create({
    /* ===== 标签栏（横向一排 chip，钉在列表上方）===== */
    /* ⚠ 它**不吃**纵向空间上的额外留白：上下只留一点点，
       因为它要和「筛选入口 / 姓名查询」一起钉在顶部（三行一起占屏幕是奢侈的）。 */
    barWrap: { paddingBottom: rpx(16) },
    /** ⚠★ 一行两段：左边是可滑的筛选项（`flex: 1` + `minWidth: 0`），右边是固定的「管理」。
        ⚠ 左段只写 `flex: 1`、不写 `minWidth: 0`：RN 里内容宽度会把左段顶出屏幕，
          右侧那颗固定 chip 就被挤没了 —— 而「固定在右侧」正是它存在的理由。
          （它上一版的毛病正相反：塞在滚动容器的尾巴上，标签一多就滑出屏幕看不见。） */
    barRow: { flexDirection: 'row', alignItems: 'center' },
    barScroll: { flex: 1, minWidth: 0 },
    /** ⚠ 横向滚动的内容容器：`paddingRight` 让最后一个 chip 不贴边 */
    barInner: { paddingRight: rpx(24), alignItems: 'center' },
    chip: {
      paddingHorizontal: rpx(20),
      paddingVertical: rpx(10),
      marginRight: rpx(12),
      borderWidth: rpx(1),
      borderColor: '#e6dcc9',
      /* ⚠ 全站直角（用户要求）：chip 也不给圆角 */
      borderRadius: 0,
      backgroundColor: COLORS.bg
    },
    chipOn: { borderColor: COLORS.gold, backgroundColor: COLORS.gold },
    chipText: { fontSize: rpx(24), color: '#6f675a' },
    chipTextOn: { color: '#ffffff' },
    /** 计数比名字再小一号、颜色更淡：它是附注，不是主角 */
    chipNum: { fontSize: rpx(21), color: '#b3ab99' },
    chipNumOn: { color: '#f6ecd8' },
    /** ★ 右端那枚固定的「管理」：虚框 + 淡金字，与筛选项（实框）一眼可分。
        ⚠ 它**不跟着某一格高亮**（它没有「选中」这个概念），也**不随左边一起滑**。
        ⚠ `marginRight: 0` + `marginLeft`：它在行的最右边，右边那份间距由 barWrap 的
          右留白负责；给它 marginRight 会在屏幕右边多出一条缝。 */
    chipManage: {
      borderStyle: 'dashed',
      borderColor: '#d8c9a6',
      backgroundColor: 'transparent',
      marginRight: 0,
      marginLeft: rpx(12)
    },
    chipManageText: { fontSize: rpx(24), color: '#a8863f' },

    /* ===== 面板 ===== */
    mask: {
      position: 'absolute',
      left: 0, right: 0, top: 0, bottom: 0,
      zIndex: 100,
      backgroundColor: COLORS.scrim
    },
    kav: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: rpx(44) },
    modal: { width: '100%', maxHeight: '78%', backgroundColor: COLORS.bg },
    modalHead: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: rpx(28),
      paddingVertical: rpx(24),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#f0e9db'
    },
    modalTitle: { flex: 1, fontSize: rpx(30), color: COLORS.text, fontWeight: FONT_WEIGHTS.semibold },
    modalClose: { fontSize: rpx(28), color: COLORS.textMuted, paddingLeft: rpx(20) },
    modalBody: { flexGrow: 0, flexShrink: 1 },
    modalBodyInner: { paddingHorizontal: rpx(28), paddingBottom: rpx(8) },

    /** 一行 = 一个可选标签（左边名字+计数，右边改名/删除） */
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: rpx(18),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#f4efe6'
    },
    rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
    /** 选中的那个：左边一道金色竖条（比整行反白更轻，也不会盖住后面两个按钮） */
    rowBar: { width: rpx(6), height: rpx(30), marginRight: rpx(14), backgroundColor: COLORS.gold },
    rowBarOff: { backgroundColor: 'transparent' },
    rowName: { flex: 1, minWidth: 0, fontSize: rpx(27), color: COLORS.text },
    rowNum: { fontSize: rpx(22), color: COLORS.textMuted, marginLeft: rpx(10) },
    rowAct: { fontSize: rpx(23), color: COLORS.gold, paddingLeft: rpx(22), paddingVertical: rpx(6) },
    rowActMuted: { color: '#b3ab99' },

    /** 就地摊开的那一块（改名输入 / 删除确认） */
    inline: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: rpx(16),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#f4efe6'
    },
    inlineText: { flex: 1, minWidth: 0, fontSize: rpx(24), color: '#c85a54', lineHeight: rpx(24 * 1.5) },
    inlineInput: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 0,
      fontSize: rpx(26),
      color: COLORS.text,
      borderBottomWidth: rpx(1),
      borderBottomColor: '#e6dcc9'
    },
    inlineBtn: {
      marginLeft: rpx(16),
      paddingHorizontal: rpx(16),
      paddingVertical: rpx(8),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#e6e0d4'
    },
    inlineBtnPrimary: { borderColor: COLORS.gold, backgroundColor: COLORS.gold },
    inlineBtnDanger: { borderColor: '#c85a54' },
    inlineBtnText: { fontSize: rpx(24), color: '#8d8d8d' },
    inlineBtnTextPrimary: { color: '#ffffff' },
    inlineBtnTextDanger: { color: '#c85a54' },

    /* 新建一条（输入框 + 按钮），钉在面板底部 */
    newRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: rpx(28),
      paddingTop: rpx(20),
      paddingBottom: rpx(24),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: '#f0e9db'
    },
    newInput: {
      flex: 1,
      minWidth: 0,
      height: rpx(64),
      paddingVertical: 0,
      paddingHorizontal: rpx(16),
      fontSize: rpx(26),
      color: COLORS.text,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#e6dcc9'
    },
    /** ⚠ 用**灰字说明**而不是禁用按钮（禁用按钮没有任何解释，用户只会以为坏了） */
    hint: {
      paddingHorizontal: rpx(28),
      paddingBottom: rpx(16),
      fontSize: rpx(22),
      color: '#b3ab99',
      lineHeight: rpx(22 * 1.6)
    },
    /** ★ 一条标签都没有时的空态提示（面板里空一片 + 底部一个输入框，太没方向感） */
    emptyHint: {
      paddingVertical: rpx(28),
      fontSize: rpx(24),
      color: '#b3ab99',
      textAlign: 'center'
    },
    err: {
      paddingHorizontal: rpx(28),
      paddingBottom: rpx(16),
      fontSize: rpx(23),
      color: '#c85a54',
      lineHeight: rpx(23 * 1.6)
    }
  }), [rpx]);
}

/**
 * 标签**栏**（横向一排 chip + 右端一枚固定的「管理」）。
 *
 * @param {Array} items    `model.tagBar()` 的产物：`[{key,label,count,on}]`
 * @param {function} onPick 点了某一格 → 把它的 `key` 交出去
 *                          （`''` = 全部 / `'none'` = 未分类 / 其余 = 标签 id）
 * @param {function} [onManage] 右端那枚「管理」—— **可选**：
 *                          不传就没有这一格（别的页只拿它做筛选时不必给）。
 *                          ⚠ 它和前面那些格子**不是一类东西**：那些是「筛选项」（点了换筛选），
 *                          它是「动作」（点了开标签管理面板）—— 所以它**不在 `items` 里**
 *                          （不进 model.tagBar 的产物），样式也不同（虚框、无计数）。
 *                          ⚠⚠ 它**固定在右侧、不随左边滑动**（用户 2026-10-05 明确要求）——
 *                          上一版塞在 ScrollView 的末尾，标签一多就滑出屏幕看不见了。
 *
 * ⚠⚠ **标签栏是常驻的**（2026-10-05 用户反馈后改的）：一枚标签都没建时也显示这一排。
 *   上一版是「有标签才显示」，理由是「只有『全部 / 未分类』两格纯占地方」——
 *   实测结果是用户**根本不知道这页有标签功能**。冗余一格换功能可见，划算。
 */
export function TagBar({
  items,
  onPick,
  onManage
}: {
  items: Array<{ key: string; label: string; count: number; on: boolean }>;
  onPick: (key: string) => void;
  onManage?: () => void;
}) {
  const s = useStyles();
  return (
    <View style={s.barWrap}>
      {/* ⚠★ **两段**，不是「一格塞在滚动尾巴上」：
          左段是可滑的筛选项（`flex: 1`，标签多了就在这里面滑），
          右段是**固定**的「管理」（新建 / 改名 / 删除标签）。
          用户 2026-10-05 明确要求「管理固定在右侧不许滑动」——
          上一版把它放进 ScrollView 的末尾，标签一多就滑出屏幕看不见了。 */}
      <View style={s.barRow}>
        {/* ⚠ 横向滚动：标签可能很多，竖着排会把列表挤没。
            `showsHorizontalScrollIndicator={false}`：一排 chip 下面挂个滚动条太吵。 */}
        <ScrollView
          horizontal
          style={s.barScroll}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.barInner}
          keyboardShouldPersistTaps="handled"
        >
          {items.map((it) => (
            <Pressable
              key={it.key === '' ? '__all__' : it.key}
              style={[s.chip, it.on ? s.chipOn : null]}
              onPress={() => onPick(it.key)}
            >
              {/* 嵌套 Text：名字正常大小、计数小一号 —— 一个 chip 里两种字号 */}
              <Text style={[s.chipText, it.on ? s.chipTextOn : null]}>
                {it.label}
                <Text style={[s.chipNum, it.on ? s.chipNumOn : null]}>{' ' + it.count}</Text>
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {/* ★ 固定的「管理」：只做**标签本身**的事（新建 / 改名 / 删除），
            **不**在这里归类 —— 「把某条八字归到某个标签」只在排盘结果的详细信息里做
            （用户 2026-10-05 定：列表卡片上不再有标签入口）。
            ⚠ 虚框 = 一眼看出「这是动作，不是筛选项」。 */}
        {onManage ? (
          <Pressable style={[s.chip, s.chipManage]} onPress={() => onManage()}>
            <Text style={s.chipManageText}>管理</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * 归类**面板**。
 *
 * @param {boolean} visible   开不开
 * @param {string}  title     标题里那句话（调用方给，一般是「把「张三」归到」）
 * @param {string|null} currentId 这条八字现在的标签 id（null = 未分类）
 * @param {Array}   tags      标签列表（带 count）
 * @param {boolean} busy      调用方正在跑一个请求（新建/改名/删除/归类）
 * @param {string}  err       调用方最近一次失败的文案（'' = 没有）
 * @param {function} [onPick]   (tagIdOrNull) => void   选中某一格（null = 取消归类）
 *                              ⚠ 只有 `mode='pick'` 会用到它
 * @param {function} [onCreate] (name) => void          新建（只有 `mode='manage'` 会用到）
 * @param {function} [onRename] (id, name) => void      改名（同上）
 * @param {function} [onRemove] (id) => void            删除（**只解归类，不删记录**；同上）
 * @param {function} onClose  关窗
 * @param {'pick'|'manage'} [mode] ★ **两种形态，只由它决定**（默认 `'pick'`）：
 *   · `'pick'`（**结果页**「详细信息 → 标签」用）—— **只能选 / 取消归类**：
 *       「未分类」那一格在（它就是「取消归类」）、各标签行可点且**当前那格高亮**；
 *       **不给**新建输入框、**不给**改名 / 删除按钮
 *       （用户原话：「只能更换标签，不能删除和改名标签」）。
 *   · `'manage'`（**记录页**顶部固定的「管理」用）—— **只管标签本身**：
 *       新建 / 改名 / 删除；「未分类」格不显示、各标签行不给高亮也不归类
 *       （那里没有目标记录，归类无从谈起）；
 *       底部追加一句「归类在『排盘结果 → 详细信息 → 标签』里改」——
 *       列表卡片上已经没有归类入口了，不说他就会在这一页里一直找。
 *   ⚠ 别把这两件事合成一个开关（上一版只有 `manage`）：那样「不给编辑」与「不给归类」
 *     会被绑成同一个方向，结果页要的「能选、但不能改」根本表达不出来。
 */
export function TagPicker({
  visible,
  title = '归到标签',
  currentId = null,
  tags = [],
  busy = false,
  err = '',
  onPick,
  onCreate,
  onRename,
  onRemove,
  onClose,
  mode = 'pick'
}: {
  visible: boolean;
  title?: string;
  currentId?: string | null;
  tags?: any[];
  busy?: boolean;
  err?: string;
  onPick?: (tagId: string | null) => void;
  onCreate?: (name: string) => void;
  onRename?: (id: string, name: string) => void;
  onRemove?: (id: string) => void;
  onClose: () => void;
  mode?: 'pick' | 'manage';
}) {
  const s = useStyles();
  /* ⚠★ 两种形态**只由这一个参数决定**（用户 2026-10-05 定的分工）：
     · `'pick'`   —— 结果页「详细信息 → 标签」用：**只能选 / 取消归类**，
                     不给新建、不给改名、不给删除
                     （用户原话：「只能更换标签，不能删除和改名标签」）。
     · `'manage'` —— 记录页顶部那枚固定的「管理」用：**只能建 / 改名 / 删**，
                     不做归类（那里根本没有目标记录）。
     ⚠ 别把这两件事合成一个开关（上一版只有 `manage`）：那样「不给编辑」与「不给归类」
       会被绑成同一个方向，结果页要的「能选、但不能改」根本表达不出来。 */
  const isManage = mode === 'manage';
  const canPick = !isManage;
  const canEdit = isManage;
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  /* ⚠ 每次**打开**都清干净（见文件头「局部态」那段）：
     依赖数组只有 visible —— 带上 tags 之类的话，调用方每次重渲染
     （比如后台刷新回来了）都会把用户正在打的名字清掉。 */
  useEffect(() => {
    if (visible) {
      setNewName('');
      setEditingId(null);
      setEditingName('');
      setConfirmId(null);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = useCallback((t: any) => {
    setConfirmId(null);
    setEditingId(t.id);
    setEditingName(String(t.name || ''));
  }, []);
  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingName('');
  }, []);
  const submitEdit = useCallback(() => {
    if (!editingId) return;
    const nm = String(editingName || '').trim();
    /* ⚠ 没改动 / 改成空名 ⇒ 直接收起来，**不发请求**：
       发出去只会换来一句「标签名不能为空」或一次白跑的往返。 */
    const cur = (tags || []).filter((t: any) => t && t.id === editingId)[0];
    if (!nm || (cur && cur.name === nm)) {
      cancelEdit();
      return;
    }
    onRename(editingId, nm);
  }, [editingId, editingName, tags, onRename, cancelEdit]);

  const submitNew = useCallback(() => {
    const nm = String(newName || '').trim();
    if (!nm) return;
    onCreate(nm);
  }, [newName, onCreate]);

  if (!visible) return null;

  const list = Array.isArray(tags) ? tags.filter((t) => t && t.id) : [];

  return (
    <View style={s.mask}>
      {/* 点遮罩 = 关窗（⚠ 忙的时候不关：免得「刚点确定就消失」，看不到成功还是失败） */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={busy ? undefined : onClose}
      />
      <View style={s.kav} pointerEvents="box-none">
        <View style={s.modal}>
          <View style={s.modalHead}>
            <Text style={s.modalTitle} numberOfLines={1}>{title}</Text>
            <Pressable onPress={onClose} disabled={busy} hitSlop={8}>
              <Text style={s.modalClose}>关闭</Text>
            </Pressable>
          </View>

          <ScrollView
            style={s.modalBody}
            contentContainerStyle={s.modalBodyInner}
            keyboardShouldPersistTaps="handled"
          >
            {/* ===== 「未分类」那一格（＝取消归类）=====
                ⚠ 它必须**一直在**（哪怕一条未分类的都没有）：
                  否则「取消了归类想再取消一次」就找不到入口了。
                ⚠ 它的 key 是保留值 'none'，交出去时翻译成 **null**（见 onPress）。
                ⚠★ **管理模式下一律不显示**：没有目标记录，「取消归类」不成立 ——
                  显示出来会让人以为点一下就生效（点了其实什么都不会发生）。 */}
            {canPick && editingId !== 'none' ? (
              <Pressable
                style={s.row}
                onPress={() => { if (!busy) onPick(null); }}
                disabled={busy}
              >
                <View style={s.rowMain}>
                  <View style={[s.rowBar, currentId ? s.rowBarOff : null]} />
                  <Text style={s.rowName}>未分类</Text>
                </View>
                {currentId ? <Text style={s.rowActMuted}>取消归类</Text> : <Text style={s.rowAct}>当前</Text>}
              </Pressable>
            ) : null}

            {/* ===== 各标签 ===== */}
            {/* ⚠★ 列表空时（尤其管理模式下「未分类」格也不显示）整个面板会是一片空白 ——
                空白 + 底部一个输入框，用户不知道这里是干嘛的。给一句明确的下一步。 */}
            {list.length === 0 ? (
              <Text style={s.emptyHint}>
                {isManage
                  ? '还没有标签 —— 在下面输入名字新建一个'
                  : '还没有标签 —— 去记录页顶部的「管理」里新建'}
              </Text>
            ) : null}
            {list.map((t) => {
              /* ⚠★ 管理模式：没有目标记录 ⇒ **不给「当前」高亮**（那是指「这条八字现在在哪个标签下」） */
              const on = canPick && t.id === currentId;
              /* 删除确认：就地摊开（见文件头「两段式」那段） */
              if (confirmId === t.id) {
                return (
                  <View key={t.id} style={s.inline}>
                    <Text style={s.inlineText}>
                      {'删除「' + t.name + '」？' +
                        (t.count > 0 ? t.count + ' 条记录会回到未分类' : '它下面还没有记录') +
                        '（记录本身不会被删）'}
                    </Text>
                    <Pressable
                      style={[s.inlineBtn, s.inlineBtnDanger]}
                      onPress={() => { setConfirmId(null); onRemove(t.id); }}
                      disabled={busy}
                    >
                      <Text style={[s.inlineBtnText, s.inlineBtnTextDanger]}>删除</Text>
                    </Pressable>
                    <Pressable style={s.inlineBtn} onPress={() => setConfirmId(null)} disabled={busy}>
                      <Text style={s.inlineBtnText}>取消</Text>
                    </Pressable>
                  </View>
                );
              }
              /* 改名：同一行就地变成输入框 */
              if (editingId === t.id) {
                return (
                  <View key={t.id} style={s.inline}>
                    <TextInput
                      style={s.inlineInput}
                      value={editingName}
                      onChangeText={setEditingName}
                      onSubmitEditing={submitEdit}
                      maxLength={tagsLib.TAG_NAME_MAX}
                      autoFocus
                      autoCorrect={false}
                    />
                    <Pressable
                      style={[s.inlineBtn, s.inlineBtnPrimary]}
                      onPress={submitEdit}
                      disabled={busy}
                    >
                      <Text style={[s.inlineBtnText, s.inlineBtnTextPrimary]}>保存</Text>
                    </Pressable>
                    <Pressable style={s.inlineBtn} onPress={cancelEdit} disabled={busy}>
                      <Text style={s.inlineBtnText}>取消</Text>
                    </Pressable>
                  </View>
                );
              }
              return (
                <View key={t.id} style={s.row}>
                  <Pressable
                    style={s.rowMain}
                    onPress={() => { if (!busy && canPick) onPick(t.id); }}
                    disabled={busy || !canPick}
                  >
                    <View style={[s.rowBar, on ? null : s.rowBarOff]} />
                    <Text style={s.rowName} numberOfLines={1}>{t.name}</Text>
                    <Text style={s.rowNum}>{typeof t.count === 'number' ? t.count : 0}</Text>
                  </Pressable>
                  {/* ⚠★ 改名 / 删除**只在管理模式**出现：结果页要的是「只能更换标签，
                      不能删除和改名标签」（用户 2026-10-05）—— 在那儿露出这两个按钮，
                      就是给了用户一条他明确不想开放的路。 */}
                  {canEdit ? (
                    <>
                      <Pressable onPress={() => startEdit(t)} disabled={busy} hitSlop={6}>
                        <Text style={s.rowAct}>改名</Text>
                      </Pressable>
                      <Pressable onPress={() => { setEditingId(null); setConfirmId(t.id); }} disabled={busy} hitSlop={6}>
                        <Text style={[s.rowAct, s.rowActMuted]}>删除</Text>
                      </Pressable>
                    </>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>

          {/* ===== 新建（⚠★ 只在管理模式：结果页那一路「只能换，不能建」）=====
              ⚠ 重名**不在这儿判**：判据在 model.planNewTag（本地先查一遍，
                命中就直接选中它，省一次必然 409 的往返）。这里只负责把名字交出去。 */}
          {canEdit ? (
            <View style={s.newRow}>
              <TextInput
                style={s.newInput}
                value={newName}
                onChangeText={setNewName}
                onSubmitEditing={submitNew}
                placeholder="新建一个标签…"
                placeholderTextColor="#b9b0a0"
                maxLength={tagsLib.TAG_NAME_MAX}
                returnKeyType="done"
                autoCorrect={false}
                editable={!busy}
              />
              <Pressable
                style={[s.inlineBtn, String(newName || '').trim() ? s.inlineBtnPrimary : null]}
                onPress={submitNew}
                disabled={busy}
              >
                <Text
                  style={[
                    s.inlineBtnText,
                    String(newName || '').trim() ? s.inlineBtnTextPrimary : null
                  ]}
                >
                  新建
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* 说明 / 报错：⚠ 常驻那一句说明**必须**在 ——
              它告诉用户「删标签不会删记录」这件事，而不是等他删完才说。
              ⚠★ 末尾半句按形态给：管理模式要告诉用户**去哪儿归类**（列表卡片上已经
                没有入口了，不说他就会一直在这一页里找）；选择模式要告诉他
                **去哪儿建/改/删**（这一页刻意不提供这三个动作）。 */}
          <Text style={s.hint}>
            {'一条八字只能有一个标签 · 删标签只解除归类，不会删记录 · 名字最多 ' +
              tagsLib.TAG_NAME_MAX + ' 个字' +
              (isManage
                ? '\n归类在「排盘结果 → 详细信息 → 标签」里改'
                : '\n要新建 / 改名 / 删除，去记录页顶部的「管理」')}
          </Text>
          {err ? <Text style={s.err}>{err}</Text> : null}
        </View>
      </View>
    </View>
  );
}
