/**
 * 排盘结果页 = 壳（推入页，不是 tab）
 *
 * 页面做三件事：拿到记录 → **现场重排成完整盘** → 交给 chart-view 渲染，
 * 外加一个「保存到记录」动作。
 * 盘面本身（四柱 / 藏干 / 选中运 / 三张表及其联动）全在 components/chart-view 里。
 *
 * 保存按钮刻意放在页面而不是组件里：以后从记录里点开某条记录的详情页，
 * 复用同一块盘面但不需要「保存到记录」这个动作。
 *
 * ============ 与小程序 result.js 的对应关系 ============
 *   小程序                 →  这里
 *   onLoad / onShow       →  useEffect([entry]) 里的 load()（见 model.loadPlanOf 的两道短路）
 *   onUnload              →  **空依赖**那个 effect 的 cleanup 里 chartBus.clear()
 *                            （⚠ 必须与 [entry] 那条分开，理由见下面 load 前的长注释）
 *   data.rec / saved / …  →  useState 的一组字段（panel）
 *   setData(...)          →  setPanel(...)
 *   tt.showToast          →  页内一行浮字 toast（RN 没有轻提示组件）
 *   tt.switchTab(去排盘)  →  props.onGoPaipan
 *
 * ⚠⚠ 三个面板**常驻挂载、靠 display 切**（`styles.panelHidden`），
 *   绝不改成条件渲染 —— 那会重建 ChartView，
 *   把「选中哪步大运 / 流年 / 流月」的内部状态清掉，切换也会多花一次装配。
 *   （chart-view 的 model 是纯函数，但组件的选中态在 useState 里，重建就没了。）
 *
 * ⚠⚠ 本页的左右内边距**必须保持 0** ——
 *   ChartView 内部那张盘的运程三表按「一屏 11 列」定宽（列宽 63rpx 由可用宽 698rpx 反推）。
 *   这一层只要补上左右内边距（哪怕 20rpx），可用宽就会掉到 646rpx、一屏掉到 10 列。
 *   所以外层不用 Screen（它带 26rpx 左右留白），改用裸 ScrollView + contentContainerStyle
 *   只给纵向内边距。切换栏 / 面板 / 按钮的留白各自在内部给。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import ChartView from '../../components/chart-view/ChartView';
/* ★ 排盘表单**封装件**（2026-10-21）—— 与排盘页共用同一份，
   本页用它实现「修改出生时间」（用户：「排盘页面要封装，这就可以复用了」）。 */
import PaipanForm from '../../components/PaipanForm';
import { TagBar, TagPicker } from '../../components/TagPicker';
import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, RADII, SIZES } from '../../theme/tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const history: any = require('../../core/history.js');
const recordLib: any = require('../../core/record.js');
const chartBus: any = require('../../core/chartBus.js');
const notesLib: any = require('../../core/notes.js');
const commentsLib: any = require('../../core/comments.js');
/* 求测单（工单层）—— 与 comments 是**两层**：它是「有人在等师傅看这个八字」，
   comments 是「师傅和这个八字说过的话」。发起求测只落单、不写消息。 */
const requestsLib: any = require('../../core/requests.js');
/* 自定义标签 —— ★ 本页是**唯一**能「更换标签」的地方（详细信息 → 标签）
   （用户 2026-10-05 定：列表卡片上的标签入口去掉，管理只管标签本身）。
   ⚠⚠⚠ 而且**必须先按底部的「修改」**：展示态那一行是只读的，
   可点的那一份在修改态里 —— 「标签的修改不能分散」是用户的原话。 */
const tagsLib: any = require('../../core/tags.js');
const store: any = require('../../core/store/index.js');

type Panel = {
  rec: any;
  hydrating: boolean;
  saved: boolean;
  save: { state: 'idle' | 'pending' | 'fail'; text: string; disabled: boolean };
};

const INIT: Panel = { rec: null, hydrating: false, saved: false, save: model.saveIdle(false) };

/**
 * 「修改」态的那块内容（姓名 + 职业 + 描述三个输入框 + 取消/保存）。
 *
 * ⚠ 为什么单独抽一个组件：它拿着五个 props，直接摊在 Result 的 JSX 里
 *   会把那一大段再撑长一截；抽出来后 `onEditFocus` 还能直接从滚动层透传下来
 *   （点击任一输入框 ⇒ 重新挂上「跟到底」）。
 * ⚠ 样式对象是父子分别 useMemo 出来的**两个不同对象**，靠 props 传下去。
 */
function EditBlock({
  s, rpx, edit, onEditName, onEditJob, onEditDesc, onEditCancel, onEditCommit, onEditFocus,
  /* ★ 标签：**修改态才给**（用户 2026-10-05：「标签的修改要在修改按钮点击之后才能修改，
     不能分散。如果没有点击修改按钮那么就只是显示标签就行了」）——
     展示态那一份是只读的（在下面 Result 的展示态里），可点的**只有这里一处**。 */
  canTags, tagName, onTagOpen,
  /* ★ 出生时间（用户 2026-10-21）：修改态里点它 ⇒ 开**排盘表单**（`components/PaipanForm`
     的复用），选完回来改同一条记录并重排盘。展示态那一行是只读的（同标签那一行的纪律）。
     ⚠ 两段：`birthText` = 阳历 + 时刻，`birthSub` = 农历 + 性别 —— 用户在排盘页能改到的
       就是这三样（阳历 / 农历 / 性别），所以这里三样都得看得见，否则选完不知道该不该信。 */
  birthText, birthSub, onBirthOpen,
}: any) {
  return (
    <View>
      <View style={s.infoRowEdit}>
        <Text style={s.infoLabel}>姓名</Text>
        <View style={s.infoEditRight}>
          <TextInput
            style={s.infoInput}
            value={edit.name}
            onChangeText={onEditName}
            onFocus={onEditFocus}
            placeholder="姓名"
            placeholderTextColor="#c8c8c8"
            maxLength={40}
            // ⚠ 不给 autoFocus：点「修改」只是想改内容，不代表要打字 ⇒ 别弹键盘（2026-10-05）
            editable={!edit.saving}
          />
        </View>
      </View>

      {/* ⚠ 职业：单行（2026-10-06 新增字段，「同姓名和描述一样」——
          三处都跟着走：保存窗、这里、轻记录白名单） */}
      <View style={s.infoRowEdit}>
        <Text style={s.infoLabel}>职业</Text>
        <View style={s.infoEditRight}>
          <TextInput
            style={s.infoInput}
            value={edit.job}
            onChangeText={onEditJob}
            onFocus={onEditFocus}
            placeholder="职业"
            placeholderTextColor="#c8c8c8"
            maxLength={40}
            editable={!edit.saving}
          />
        </View>
      </View>

      <View style={s.infoRowEdit}>
        <Text style={s.infoLabel}>描述</Text>
        <View style={s.infoEditRight}>
          <TextInput
            style={[s.infoInput, s.infoInputMulti]}
            value={edit.desc}
            onChangeText={onEditDesc}
            onFocus={onEditFocus}
            placeholder="这条八字是干什么的"
            placeholderTextColor="#c8c8c8"
            maxLength={500}
            multiline
            textAlignVertical="top"
            editable={!edit.saving}
          />
        </View>
      </View>

      {/* ⚠ 提示「留空 = 清空」：不然用户以为空着就是「不改」 */}
      <Text style={s.infoEditHint}>职业 / 描述留空即清空；姓名不能为空</Text>

      {/*
        ★ 出生时间（用户 2026-10-21）—— 修改态**专属**的可点行。
        点它 ⇒ 开**排盘表单**（`components/PaipanForm`，与排盘页是同一份代码），
        预填现在是哪一天哪一刻；选完点「确定」⇒ **只把它记进修改态的草稿**，
        这一行立刻显示新时间，但盘面不动 —— 真要重排得按底部「保存」。
        ⚠⚠ 所以这行读的是 `birthOf()`（草稿优先），不是 `rec.dateText`：
           「确定」不写后端，读记录就永远显示旧时间（2026-10-21 踩过）。
        ⚠⚠ 两行：阳历+时刻 / 农历+性别。用户在排盘页还能改**农历和性别**，
           所以这两样也得当场看得见 —— 只显示阳历，改完性别根本无从确认。
        ⚠ 展示态那一行是只读的（同「标签」那一行的纪律：改什么都得先按「修改」）。
        ⚠ 行样式沿用 `s.infoRow`：与上下几行同高、同下边框，进出修改态不跳。
      */}
      <Pressable style={s.infoRow} onPress={onBirthOpen} disabled={edit.saving}>
        <Text style={s.infoLabel}>出生时间</Text>
        <View style={s.infoTagRight}>
          <View style={s.birthStack}>
            <Text style={[s.birthMain, birthText ? null : s.birthMainEmpty]}>
              {birthText || '未填写'}
            </Text>
            <Text style={s.birthSub}>{birthSub}</Text>
          </View>
          <Text style={s.infoTagArrow}>›</Text>
        </View>
      </Pressable>

      {/*
        ★ 标签行 —— **修改态专属**（本页唯一可点的标签行）。
        ⚠⚠ 展示态那一行是只读的（点不动、也没有 `›`）：用户要求
          「标签的修改要在修改按钮点击之后才能修改，不能分散」——
          所以「点得动」这件事本身就是「已经进了修改态」的记号。
        ⚠ 行样式沿用 `s.infoRow`（与 `s.infoRowEdit` 的 paddingVertical /
          下边框逐字相同）：进出修改态时那一行不会跳高度。
        ⚠ 保存中不给点（`edit.saving`）：提交正飞着再改标签，回来是两个结果打架。
        ⚠ 值那段用 `infoTagRight`（flex:1 + 横排）撑开，`›` 自然被推到最右。
        ⚠ 未分类时照样画灰字「未分类」且有 `›` —— 这一行是可操作入口，
          不是「描述」那种可以被清空的字段：没有值也得有个能点的东西。
      */}
      {canTags ? (
        <Pressable style={s.infoRow} onPress={onTagOpen} disabled={edit.saving}>
          <Text style={s.infoLabel}>标签</Text>
          <View style={s.infoTagRight}>
            <Text style={[s.infoValue, tagName ? null : s.infoValueEmpty]}>
              {tagName || '未分类'}
            </Text>
            <Text style={s.infoTagArrow}>›</Text>
          </View>
        </Pressable>
      ) : null}

      <View style={s.infoEditBtns}>
        <Pressable style={s.infoEditBtn} onPress={onEditCancel} disabled={edit.saving}>
          <Text style={s.infoEditBtnText}>取消</Text>
        </Pressable>
        <Pressable
          style={[s.infoEditBtn, edit.saving ? s.infoEditBtnOff : s.infoEditBtnPrimary]}
          onPress={onEditCommit}
          disabled={edit.saving}
        >
          <Text style={[s.infoEditBtnText, s.infoEditBtnTextPrimary]}>
            {edit.saving ? '保存中…' : '保存'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function Result({
  /** 计数器：每 +1 表示「又有人投了一份盘进来」→ 走一次 load()（对应 onLoad / onShow） */
  entry,
  /** 空态里「去排盘」 */
  onGoPaipan,
  /**
   * 键盘当前吃掉了多少高度（由根节点的 KeyboardAvoid 下发）。
   * ⚠⚠ 本页是**绝对定位的推入层**，不占 App 里那份 `s.stage` 的高度 ——
   *   所以避让得自己再减一次。别在页面里重新监听键盘：那是两份真相，
   *   必然跟根节点那份漂（而且两个事件源会让动画闪）。
   */
  eaten = 0
}: {
  entry: number;
  onGoPaipan: () => void;
  eaten?: number;
}) {
  const rpx = useRpx();

  const [panel, setPanel] = useState<Panel>(INIT);
  /** ⚠ 最新 panel 放 ref：load() 的短路要读它，而 setState 是异步的 */
  const panelRef = useRef<Panel>(INIT);
  panelRef.current = panel;

  const [activeTab, setActiveTab] = useState('chart');
  /** 事件记录（key → { text, … }）—— 与 panel.rec.notes 是同一份，传给 ChartView 画红点与内联正文 */
  const [notes, setNotes] = useState<any>({});
  /** 摊平后的三层时间线（大运 → 流年 → 流月）；⚠ 与 notes **永远一起换**（见 applyNotes） */
  const [timeline, setTimeline] = useState<any[]>([]);

  const [editor, setEditor] = useState<any>(model.editorOf());
  /**
   * 「详细信息」页签的**就地编辑**状态（改名 / 改描述）。
   * 与上面的 editor（事件记录弹框）刻意分开：那个是**弹框**、这个**就在本页**改，
   * 交互形态不同，硬合成一个只会让两边的分支互相污染。
   */
  const [edit, setEdit] = useState<any>(model.editOf());
  /**
   * 「修改出生时间」浮层（用户 2026-10-21）。
   * `birthOn` = 浮层开着没。
   * ⚠ 浮层里的表单是 `components/PaipanForm` —— **与排盘页同一份代码**
   *   （用户原话「排盘页面要封装，这就可以复用了」），这里不再抄一份表单。
   * ⚠⚠ 浮层提交（「确定」）**只改修改态的草稿**，不写后端：
   *   写库只在底部「保存」那一下（见 `onBirthCommit` 的注释）。
   *   ⚠ 所以「出生时间」那一行必须读草稿（`birthText`），否则点完「确定」什么都不变。
   */
  const [birthOn, setBirthOn] = useState(false);
  /**
   * 点「保存到记录」时的小窗（★ 排盘页不再收姓名/描述，改到这一刻问）。
   * ⚠ 与 edit 分开：edit 改的是**已保存**的记录（详细信息页里就地改），
   *   这个窗是给**还没保存**的盘填名字，时机与前提都不一样。
   */
  const [saveAsk, setSaveAsk] = useState<any>(model.saveAskOf());
  /** 删除二次确认弹框的显隐 */
  const [confirmDel, setConfirmDel] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  /**
   * 删除的口令（随机数字）与用户输入。
   * ⚠ 口令**每次开窗重新生成**（见 onDeleteAsk）—— 绝不复用上一次的。
   * ⚠ 输入是**受控**的（才能在输入不对时把按钮画灰），且**不 trim 用户看到的值**
   *   （比对时才 trim，见 model.deleteCodeCheck）。
   */
  const [delCode, setDelCode] = useState('');
  const [delInput, setDelInput] = useState('');
  const [toast, setToast] = useState('');
  /**
   * 系统键盘是不是弹着。
   * ⚠ 要**监听**而不是猜（别用「点了输入框所以大概弹了」）：它驱动两件事 ——
   *   ① 编辑框往上让位（见下面的 kav）
   *   ② 点遮罩到底是「收键盘」还是「关框」（见 model.maskTapAction）
   */
  const [kbShown, setKbShown] = useState(false);
  const toastTimer = useRef<any>(null);

  /* ==================== 师傅批字（一份八字一个会话）==================== */

  /**
   * 会话状态：`{ state:'idle'|'loading'|'ready'|'fail', list, lastSeq, error }`。
   * ⚠ 形状**全部由 model 决定**（chatIdle / chatLoading / chatLoaded / chatAppend）——
   *   视图里不要自己拼一个 `{ list: [] }` 当初始值，那样 chatAppend 的入参就有两份定义。
   */
  const [chat, setChat] = useState<any>(model.chatIdle());
  /**
   * **求测单**那个游标（与上面那个消息游标是两样东西）。
   * 形状：`{ state:'idle'|'loading'|'ready'|'fail', req: Object|null, error }`，
   * 全部由 model 决定（reqIdle / reqLoading / reqLoaded）—— 视图里别自己拼。
   * ⚠⚠⚠ 界面的**三种形态**就是按它分的（`model.chatPhase`）：
   *   req=null → 出「发起求测」按钮；pending → 出「等师傅接单」；taken → 出输入框。
   */
  const [req, setReq] = useState<any>(model.reqIdle());
  /** 输入框里的草稿 */
  const [chatDraft, setChatDraft] = useState('');
  /** 正在发送（挡连点） */
  const [chatBusy, setChatBusy] = useState(false);
  /**
   * 上一次发送失败时用过的消息 id。
   * ⚠⚠ 重试必须**沿用它**：服务端靠 id 做幂等（INSERT OR IGNORE）。
   *   换一个新 id 重发，「超时了但其实已经写进去」就会变成两条一模一样的消息。
   */
  const chatRetryId = useRef('');
  /** 已经拉过的是哪条记录的会话（切走再切回来不重复拉） */
  const chatRecRef = useRef('');
  /**
   * 当前会话挂在哪条记录上 —— 只有**已保存**的八字才有。
   * 未保存的盘没有 id，也就没有会话可挂：与「事件记录」共用同一道 gate
   * （gateOf），这不是巧合 —— 服务端的锚点就是 record.id。
   * ⚠ 取 id 的**字符串**、不取 panel.rec 对象：hydrate 每次都换引用，
   *   拿对象当依赖会在无关的重渲染上白拉一次。
   */
  const chatRecId = panel.saved && panel.rec ? String(panel.rec.id || '') : '';

  /* ==================== 自定义标签（★ 本页是**唯一**能换标签的地方）==================== */

  /**
   * 这条八字现在的标签 id（`null` = 未分类）。
   *
   * ⚠⚠ 它**不能放在 `panel.rec` 上**：`recordLib.hydrate()` 是**白名单构造**，
   *   `tagId` 根本不在它的产物里（它不属于「能上云的轻字段」）。
   *   所以单独一个 state，来源只有两处：
   *     · **从记录页进来** —— handoff（`screens/records/model.js` 的 toHandoff）
   *       把列表里那条的 tagId 贴上了（**只走内存总线**，永远不会被写进记录行）；
   *     · **保存成功** —— `push()` 带回的全量列表里那条带着服务端给的 tagId。
   *   ⚠ 另一条来路（**从排盘页新排的盘**）必然没有 id，这个 state 也就恒为 null ——
   *     但那时「详细信息」整块都不显示（`panel.saved` 为假），标签行根本不存在。
   */
  const [tagId, setTagId] = useState<string | null>(null);
  /** 我的标签（带 count）—— 面板里从中选一个，那一行也用它把 id 翻成名字 */
  const [tags, setTags] = useState<any[]>([]);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagBusy, setTagBusy] = useState(false);
  const [tagErr, setTagErr] = useState('');
  /**
   * 后端支不支持标签（只有自建 local 有 `tags` / `record_tags` 两张表）。
   * ⚠ 不支持时**整行不显示** —— 给一个点了没反应的入口比不给更糟。
   */
  const canTags = store.supportsTags();

  /* ---------------- 轻提示 ---------------- */

  const showToast = useCallback((text: string) => {
    setToast(text || '');
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (text) {
      toastTimer.current = setTimeout(() => setToast(''), 2000);
    }
  }, []);

  /* ---------------- 自定义标签：拉列表 / 换标签 ---------------- */

  /** 拉我的标签列表（只为把 id 翻成名字 + 面板里给选项；失败静默，不打扰用户） */
  const loadTags = useCallback(() => {
    if (!canTags) return;
    /* ⚠ core/tags.js 的这几个函数**永不 reject**（约定），失败给 `ok:false` */
    tagsLib.list().then((res: any) => {
      if (res && res.ok) setTags(Array.isArray(res.tags) ? res.tags : []);
    });
  }, [canTags]);

  /** 这条记录现在挂的标签叫什么；取不到（未分类 / 标签刚被删）→ **空串** */
  const tagName = canTags ? tagsLib.nameOf(tags, tagId) : '';

  /**
   * 换标签（`null` = 取消归类）—— ★ **本页唯一的标签写操作**。
   *
   * ⚠⚠ 成功之后**什么都不写回 `panel.rec`**：记录行里根本没有 `tagId` 这个字段
   *   （它是 `GET /records` 的**只读派生字段**），所以「先改本地再重拉」那套
   *   在这里不适用。改的只有本页这个 `tagId` state —— 它只影响本页那行显示。
   * ⚠⚠⚠ 但**记录页不会自己知道**：它的 onShow 闸门（model.shouldReload）只认
   *   `history.rev()`，而归类走的是 `PUT /records/:id/tag`，**不是** push / drop
   *   那些会 +1 的写操作。所以这里必须**手动 push 一次版本号** ——
   *   不推的话：换完标签返回记录页，列表不重拉，卡片上那枚 chip 还是旧的，
   *   用户的现象就是「标签换了，可列表上看不出来」（2026-10-05 用户报障）。
   * ⚠ 顺手重拉标签列表：`count` 变了（这条从「客户」挪到了「重点」）。
   * ⚠ 点的是**这条记录现在就在的那个标签** ⇒ 什么都不做（只关窗）：
   *   不判的话，每次打开随手点一下当前那一格都会白跑一次写请求。
   */
  const onTagPick = useCallback((next: string | null) => {
    const want = next === undefined || next === null || next === '' ? null : String(next);
    if (!chatRecId) return;
    if ((tagId || null) === want) {
      setTagOpen(false);
      return;
    }
    setTagBusy(true);
    setTagErr('');
    tagsLib.setFor(chatRecId, want).then((r: any) => {
      setTagBusy(false);
      if (!r.ok) {
        setTagErr(r.error || '更换失败，请重试');
        return;
      }
      setTagId(want);
      setTagOpen(false);
      loadTags();
      /* ⚠⚠⚠ 见上面那段：让记录页下次进来时重拉列表（卡片上的 chip 才会跟着变）。
         放在**成功分支**里 —— 失败时云端没变，推版本号只会白拉一次。 */
      history.bumpRev();
    });
  }, [chatRecId, tagId, loadTags]);

  /** 关标签面板（⚠ 忙的时候不许关：刚点一下就消失，用户看不到成功还是失败） */
  const onTagClose = useCallback(() => {
    if (tagBusy) return;
    setTagOpen(false);
  }, [tagBusy]);

  /** 点「详细信息 → 标签」那一行 → 开选标签面板（⚠ 清上一次的错误文案） */
  const onTagOpen = useCallback(() => {
    setTagErr('');
    setTagOpen(true);
  }, []);

  /**
   * 已保存的记录 ⇒ 拉一次标签列表。
   * ⚠ 依赖只有 `chatRecId`（那条记录的 id）：它一变就重拉。
   *   别把 `panel.rec` 对象放进依赖 —— hydrate 每次都换引用，会在无关的重渲染上白拉。
   */
  useEffect(() => {
    if (!chatRecId) return;
    loadTags();
  }, [chatRecId, loadTags]);

  /* ---------------- 师傅批字 ---------------- */

  /**
   * 拉这个会话的消息。
   * ⚠⚠ 回来时先确认「还是这条记录的会话」：中途切了记录的话，
   *   这批消息属于上一份八字 —— 塞进去就是把两个人的话混在同一个页签里。
   */
  /**
   * 拉这条记录的两样东西：**求测单**（工单）和**消息**（会话）。
   *
   * ⚠⚠ 两个请求**并行发**，各自独立判「还是这条记录的」：求测单慢一点不该
   *   拖着消息不显示，反过来也一样。
   * ⚠⚠ 回来时先确认「还是这条记录的会话」：中途切了记录的话，
   *   这批数据属于上一份八字 —— 塞进去就是把两个人的话混在同一个页签里。
   *   （两份数据用**同一个** recId 校验，别各写各的。）
   */
  const onChatLoad = useCallback((recId: string) => {
    if (!recId) return;
    setChat(model.chatLoading());
    setReq(model.reqLoading());
    requestsLib.get(recId).then((rr: any) => {
      if (chatRecRef.current !== recId) return;
      setReq(model.reqLoaded(rr));
    });
    commentsLib.list(recId).then((res: any) => {
      if (chatRecRef.current !== recId) return;
      setChat(model.chatLoaded(res));
    });
  }, []);

  /** 手动重拉（列表底部那个「刷新」）。⚠ 它绕过 chatRecRef 的短路 —— 那正是它的意思 */
  const onChatReload = useCallback(() => {
    if (chatRecId) onChatLoad(chatRecId);
  }, [chatRecId, onChatLoad]);

  /**
   * 切到「师傅批字」页签（且这条盘已保存）→ 拉一次。
   *
   * ⚠ 一条记录只拉一次：`chatRecRef` 记住「已经拉过的是哪条记录的会话」，
   *   切走再回来直接用手上那份（骨架阶段还没有推送，不做轮询 ——
   *   要看新的就点列表底部那个「刷新」）。
   * ⚠ 换记录时 ref 里是旧 id ⇒ 会重新拉，上一份的内容被换成新的。
   */
  useEffect(() => {
    if (activeTab !== 'notes' || !chatRecId) return;
    if (chatRecRef.current === chatRecId) return;
    chatRecRef.current = chatRecId;
    onChatLoad(chatRecId);
  }, [activeTab, chatRecId, onChatLoad]);

  const onChatDraft = useCallback((v: string) => {
    setChatDraft(v);
  }, []);

  /**
   * 真正发一条**消息**（只有输入条那颗「发送」会调它）。
   * ⚠⚠ 失败时把**用过的那个 id**留在 chatRetryId 里，重试原样传回去（见那个 ref 的注释）。
   * ⚠ 成功后把服务端返回的那条**并进列表**，不重拉整条会话 —— 省一个来回，
   *   也避开「刚发的那条在网络回程里还没落库」的竞态。
   * ⚠⚠ 2026-10-05 起它**不再**被「发起求测」复用：那个动作不发消息（见 onChatRequest）。
   *   以前两者共用一个 `chatPost(text, clearDraft)`，「发起」还得特意传
   *   `clearDraft=false` 以免抹掉用户打了一半的草稿 —— 那条分支现在根本不存在了。
   */
  const chatPost = useCallback((text: string) => {
    if (chatBusy || !chatRecId) return;
    const g = model.chatCanSend(text);
    if (!g.ok) return;
    setChatBusy(true);
    commentsLib.send(chatRecId, g.text, { id: chatRetryId.current }).then((res: any) => {
      setChatBusy(false);
      if (!res.ok) {
        chatRetryId.current = res.id || '';
        showToast(model.chatSendFail(res));
        return;
      }
      chatRetryId.current = '';
      setChatDraft('');
      if (chatRecRef.current !== chatRecId) return;
      setChat((cur: any) => model.chatAppend(cur, res.comment));
    });
  }, [chatBusy, chatRecId, showToast]);

  const onChatSend = useCallback(() => {
    chatPost(chatDraft);
  }, [chatPost, chatDraft]);

  /**
   * 那颗「发起求测」= **下一张单**（不是发消息，见 core/requests.js 文件头）。
   *
   * ⚠⚠ 不需要「失败了留着 id 重试」那套（对比 chatPost）：服务端
   *   `UNIQUE(user_id, record_id)` 让「同一个八字只能有一张单」成为**结构保证**，
   *   换一个新 id 重发也只会复用已有那张。少一套状态 = 少一处会写错的地方。
   * ⚠ 成功后**用服务端回的那张单**替换本地状态（不是自己拼一个 `{status:'pending'}`）：
   *   如果这个八字其实早就下过单（比如刚才那次「断网」其实写成功了），
   *   服务端回的是**已有那张**、可能是 `taken` —— 界面会直接跳到「已接单」，
   *   而不是留下一个假的「等待接单」。
   */
  const onChatRequest = useCallback(() => {
    if (chatBusy || !chatRecId) return;
    setChatBusy(true);
    requestsLib.create(chatRecId).then((r: any) => {
      setChatBusy(false);
      if (!r.ok) {
        showToast(r.error || model.CHAT_TEXT.reqFail);
        return;
      }
      if (chatRecRef.current !== chatRecId) return;
      setReq(model.reqLoaded({ ok: true, req: r.req }));
    });
  }, [chatBusy, chatRecId, showToast]);

  /** 能不能发（驱动按钮的灰/亮；顺带把「纯空白」挡在点击之前） */
  const chatSendable = model.chatCanSend(chatDraft);

  /**
   * 界面处于哪一态（loading / fail / none / pending / taken）。
   * ⚠⚠⚠ 它是这一屏**唯一**的形态判据：「发起求测」按钮、等待条、输入条三者互斥，
   *   全靠同一个 phase 分出来 —— 各自写一套条件，迟早会出现两个同时露在屏幕上。
   */
  const chatPhase = model.chatPhase(req);
  /** 能不能聊 —— 即「师傅已经接下这张单」（只有 taken 为真） */
  const chatStarted = chatPhase === 'taken';

  /* ---------------- 事件记录：notes 与时间线一起换 ---------------- */

  /**
   * ⚠ 这两个 state **必须一起写**：分开写迟早出现
   *   「格子上有红点、事件记录页却是空的」这种半截状态。
   */
  const applyNotes = useCallback((n: any) => {
    const src = n || {};
    setNotes(src);
    setTimeline(notesLib.timeline(src));
  }, []);

  /* ---------------- 来路：三道分支 + 两道短路 ---------------- */

  /**
   * 拿到要展示的记录并铺界面（对应小程序的 load()）。
   * ⚠ 短路判定全在 model.loadPlanOf 里（有测试守着），这里只负责副作用：
   *   ① 排盘那几十毫秒要**延后一拍**再算，先让「正在排盘…」渲染出来；
   *   ② 已渲染的盘不许被 null 冲掉。
   */
  const load = useCallback(() => {
    const raw = chartBus.take();
    const plan = model.loadPlanOf(raw, panelRef.current.rec, panelRef.current.hydrating);

    if (plan.action === 'keep') return;

    if (plan.action === 'empty') {
      setPanel(model.emptyPanel());
      applyNotes({});
      setActiveTab('chart');
      /* ⚠ 换盘就把标签清掉：留着上一条的 id，标签行会显示「别人的标签」 */
      setTagId(null);
      return;
    }

    if (plan.action === 'full') {
      // 刚从排盘页过来（完整盘）→ **必未保存**（没有 id，也就不可能有标签）
      const loaded = model.panelForLoaded(plan.rec, model.savedOf('paipan'));
      setPanel(loaded);
      applyNotes(plan.rec.notes || {});
      setTagId(null);
      return;
    }

    // 从记录页过来的轻记录 → 现场重排
    setPanel(model.panelForLoading() as Panel);
    const src = plan.rec;
    /* ⚠★ 标签跟着**这条记录**换：它就在 handoff 上（`model.toHandoff` 贴的，
       只走内存总线、永远不会被写进记录行）。不放这儿的话，切到另一条记录时
       标签行会继续显示上一条的标签 —— 那是一条会让人误操作一辈子的假信息。 */
    setTagId(src && src.tagId ? String(src.tagId) : null);

    // 交给下一轮事件循环：让「正在排盘…」先渲染出来，
    // 否则同步算完这两次 setState 会被合并，用户看不到任何反馈
    setTimeout(() => {
      let rec = null;
      try {
        rec = recordLib.hydrate(src, { id: src.id });
      } catch (err) {
        console.warn('[paipan] 记录重排失败', err);
      }
      // 记录页点进来的：它本来就是云端列表里的一条，**必已保存**
      const loaded = model.panelForLoaded(rec, model.savedOf('records'));
      setPanel(loaded);
      applyNotes((rec && rec.notes) || {});
    }, 0);
  }, [applyNotes]);

  /**
   * entry 每变一次就走一次 load（对应小程序的 onLoad / onShow）。
   * ⚠ 为什么**不在这里 clear()**（曾经这么写过，是错的）：
   *   React 的 effect cleanup 在**依赖变化时也会跑**，而 entry 变化 = 「有一份新盘投进来了」。
   *   于是 cleanup 会抢在 load() 之前把刚 put 进来的新盘清掉 —— load() 拿到 null，
   *   再被 model 的短路①兜成 'keep'，**界面就停在上一份盘上**（比空态更糟：
   *   显示的是错的盘，还不报错）。
   *   小程序那边 onUnload 只在**页面真的销毁**时触发，语义完全不同，照搬会踩坑。
   *
   * ⇒ 作废的唯一时机是「关掉本页」这个**显式动作**（见 onLeave / App 的卸载路径），
   *   不是「组件重渲染」。本组件是条件渲染，关页 = 卸载，那里的 clear() 才是对的。
   */
  useEffect(() => {
    load();
  }, [entry, load]);

  /**
   * 本页被卸载（= 小程序 onUnload）时作废总线里的盘，
   * 免得下一次进入拿到上一轮残留的盘。
   * ⚠ 独立成一个空依赖的 effect：它只在**真卸载**时跑一次，
   *   不会因为 entry 变化（重进）而误清 —— 这正是上一版的错。
   */
  useEffect(() => () => { chartBus.clear(); }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  /* ---------------- 保存 ---------------- */

  /**
   * 点「保存到记录」→ **先开小窗**填姓名/描述，不直接发请求。
   *
   * ⚠⚠ 用户要求：「排盘页面的描述输入去掉，输入姓名也去掉，只有点击保存到记录的时候才出现」。
   *   所以保存这一刻分两步：① 问名字 ② 真写。
   *   ⚠ 按钮此刻的可用性判据**不变**（还是 `save.disabled`）——
   *     开窗不是「保存成功」，别在这里动 panel.save，否则按钮文案会先说「正在保存」。
   */
  const onSave = useCallback(() => {
    const cur = panelRef.current;
    const btn = cur.save;
    if (!cur.rec || btn.disabled || btn.state === 'pending') return;
    /* ⚠★ 开窗前顺手重拉一次标签：这窗里现在有「选标签」那一排，而标签是**别处**
       （记录页顶部的「管理」）建的 —— 不重拉的话，刚在「管理」里建完标签、
       回到排盘页保存，这一排看到的还是上一轮的旧列表（少一个刚建的）。
       ⚠ 失败静默（loadTags 内部就这么定的）：拉不到标签不该挡住保存这一步。 */
    loadTags();
    setSaveAsk(model.saveAskOpen(cur.rec));
  }, [loadTags]);

  /** 小窗里点「取消」：关窗，什么都没发生（⚠ 清草稿，下次开窗重新预填） */
  const onSaveAskCancel = useCallback(() => {
    Keyboard.dismiss();
    setSaveAsk(model.saveAskClose());
  }, []);

  const onSaveAskName = useCallback((v: string) => {
    setSaveAsk((cur: any) => model.saveAskPatch(cur, { name: v }));
  }, []);

  const onSaveAskJob = useCallback((v: string) => {
    setSaveAsk((cur: any) => model.saveAskPatch(cur, { job: v }));
  }, []);

  const onSaveAskDesc = useCallback((v: string) => {
    setSaveAsk((cur: any) => model.saveAskPatch(cur, { desc: v }));
  }, []);

  /**
   * ★ 保存窗里点了某一格标签 → 只改**草稿**（`'none'` 翻成 null）。
   *
   * ⚠⚠ 这里**不发请求**：记录这会儿还没有 id（归类接口要 `PUT /records/:id/tag`），
   *   真归类在保存成功之后补（见 onSaveAskConfirm）。
   *   提前发只会拿到一个 BAD_ID，而用户看到的是「点了没反应」。
   * ⚠ 翻译用 model.saveAskTag（保留值 'none' 只有那一处翻译）。
   */
  const onSaveAskTag = useCallback((key: string) => {
    setSaveAsk((cur: any) => model.saveAskPatch(cur, { tagId: model.saveAskTag(key) }));
  }, []);

  /**
   * 保存窗里那排标签格子（`TagBar` 吃它）。
   * ⚠ 一条标签都没建时只有「未分类」一格 ⇒ 下面那段整块不渲染
   *   （选「未分类」等于什么都没做，白占一行地方）。
   */
  const saveBar = useMemo(
    () => (canTags ? model.saveAskBar(tags, saveAsk.tagId) : []),
    [canTags, tags, saveAsk.tagId]
  );

  /**
   * 小窗里点「确定」→ 把姓名/描述并进记录，再走原来那条保存链路。
   *
   * ⚠⚠ 必须 `model.saveAskCommit` 出**轻记录**（内部走 mergePatch）：保存是整行覆盖，
   *   直接交出 hydrate 过的整条 rec 会把 chart / bazi / lunarText 一起塞进请求体（几百 KB）。
   * ⚠ 落列表时用「拿到的这条」，不是原始 rec —— 否则刚填的名字会显示成空的。
   */
  const onSaveAskConfirm = useCallback(() => {
    const cur = panelRef.current;
    const rec = cur.rec;
    if (!rec || saveAsk.saving) return;

    const light = model.saveAskCommit(saveAsk, rec, model.mergePatch);
    /* ★ 窗里选好的标签草稿（null = 未分类）。⚠⚠ 记录此刻**还没有 id**，
       所以归类不能在点「保存」时发 —— 它是 push 成功之后的**第二次请求**。
       ⚠ 先取出来存成局部量：下面 setSaveAsk 会把窗关掉/清草稿，之后就读不到了。 */
    const want = saveAsk.tagId == null ? null : String(saveAsk.tagId);
    /* ⚠ 关窗前先记住要提交的那条 —— setSaveAsk 之后闭包里的 saveAsk 还是旧值 */
    setSaveAsk((a: any) => model.saveAskPatch(a, { saving: true }));

    history.push(light).then((res: any) => {
      // 保存期间用户可能已经离开或换了盘 —— 别把结果写到别的盘上。
      // ⚠ 新排的盘 rec 还没有 id（两把 undefined 会相等），所以这里比**对象本身**
      //   而不是比 id —— 身份判定更严，换盘（新对象）一定拦得住。
      const now = panelRef.current;
      if (!now.rec || now.rec !== rec) return;

      const out = model.saveStateOf(res);
      if (!out.ok && res && res.reason !== 'no-login' && res.reason !== 'bad-record') {
        console.warn('[paipan] 云端保存失败', res && res.error);
      }

      if (out.ok) {
        /* ⚠⚠ 保存成功 = 这条八字已经「在记录里」了 —— 就地切换成**打开这条记录**的形态
            （用户建议：「保存成功之后相当于直接打开了这个八字」）。
            push() 会带回服务端的全量列表，从中取出刚存的那条权威数据
            （姓名/职业/描述/notes/id/createdAt），整条重排铺回本页 ——
            跟「从记录页点进来」走完全同一条路（panelForLoaded + savedOf('records')）。
            ⚠ 不能只把 saved 翻成 true：排盘进来的 rec 没有姓名/职业/描述/id，
              详细信息页签会立刻露出一片空字段，后面的「修改 / 删除 / 记事件」
              也全都挂在 rec.id 上（此刻是 undefined，点了就是坏路径）。
            ⚠ hydrate 是纯函数（几十毫秒），与 onEditCommit 同一个套路：
              整条重排，别只改 rec 上那几个键。 */
        const list = (res && res.records) || [];
        const hit = list.filter((r: any) => r && r.id === light.id)[0] || light;
        /* ⚠★ 刚存下来的这条**必然未分类**（`light` 兜底那一路连 tagId 键都没有），
           所以这里同时是「保存后标签行从无到有」的初始化点。 */
        setTagId(hit && hit.tagId ? String(hit.tagId) : null);
        let next = null;
        try {
          next = recordLib.hydrate(hit, { id: hit.id });
        } catch (err) {
          console.warn('[paipan] 保存后重排失败', err);
        }
        if (next) {
          setPanel(model.panelForLoaded(next, model.savedOf('records')) as Panel);
          applyNotes(next.notes || {});
        } else {
          /* 兜底：重排万一失败就只翻保存态（姓名/描述刷不出来，但状态别撒谎） */
          setPanel({ ...now, saved: out.saved, save: out.save as any });
        }
        setSaveAsk(model.saveAskClose());

        /* ===== ★ 归类：窗里选过标签才有这一步 =====
           ⚠⚠⚠ **必须等 push 成功**：归类接口是 `PUT /records/:id/tag`，
             新记录在这一刻才有 id（id 由 record.slim 生成，见 core/record.js）。
           ⚠⚠ **失败不能并进「已保存」那句话**：记录确实存进去了，但标签没贴上 ——
             报成功就是撒谎。如实说，用户还能去「详细信息 → 修改 → 标签」再选一次。
           ⚠ 没选标签（want 为 null）时**不发这次请求**：默认就是未分类，白跑一趟。 */
        if (!want) {
          showToast(out.toast);
          return;
        }
        tagsLib.setFor(hit.id, want).then((r: any) => {
          if (!(r && r.ok)) {
            showToast('已保存，但标签没贴上');
            return;
          }
          /* ⚠ 归类期间用户可能已经离开 / 换了盘（那次往返是异步的）——
             只有「屏上这条还是刚存的那条」时才改本页 state，否则会把新盘的标签行写错。 */
          const now2 = panelRef.current;
          if (now2 && now2.rec && now2.rec.id === hit.id) setTagId(want);
          /* ⚠⚠⚠ 见 onTagPick 那段：归类**不在** push / drop 那四个会 +1 的写操作里 ——
             不推版本号的话，回记录页 `shouldReload` 判「版本没变」⇒ 不重拉
             ⇒ 卡片上那枚 chip 还是空的（现象＝「保存时选了标签，列表上看不出来」）。 */
          history.bumpRev();
          /* ⚠ 顺手重拉标签列表：count 变了（这条刚归进去）。 */
          loadTags();
          showToast(out.toast);
        });
      } else {
        setPanel({ ...now, saved: out.saved, save: out.save as any });
        setSaveAsk(model.saveAskClose());
        showToast(out.toast);
      }
    });
  }, [saveAsk, showToast, applyNotes, loadTags]);

  /* ---------------- 详细信息：修改（姓名 + 职业 + 描述一起改） ---------------- */

  /**
   * 点底部的「修改」按钮 → 整块进入修改态（姓名 / 职业 / 描述**同时**变输入框）。
   * ⚠ 未保存的盘没有可改的记录，门已经挡在外面。
   */
  const onEditStart = useCallback(() => {
    const rec = panelRef.current.rec;
    if (!rec || !panelRef.current.saved) return;
    setEdit(model.editStart(rec));
    /* ⚠ 刚进修改态不滚、也不聚焦（姓名框已无 autoFocus）：让用户自己点要改的那格 */
  }, []);

  /** 三个输入框共用：只改传进来的那个字段，其余保持不动 */
  const onEditName = useCallback((v: string) => {
    setEdit((cur: any) => model.editPatch(cur, { name: v }));
  }, []);
  const onEditJob = useCallback((v: string) => {
    setEdit((cur: any) => model.editPatch(cur, { job: v }));
  }, []);
  const onEditDesc = useCallback((v: string) => {
    setEdit((cur: any) => model.editPatch(cur, { desc: v }));
  }, []);

  /** 取消：退出修改态，丢掉没提交的内容（⚠ 保存中不给取消） */
  const onEditCancel = useCallback(() => {
    Keyboard.dismiss();
    setEdit((cur: any) => model.editClose(cur));
  }, []);

  /**
   * 提交修改。
   *
   * ⚠⚠ 走的是「取回整条 → 改字段 → PUT 整条」这条**整行覆盖**的路，
   *   所以必须用 `model.mergePatch()` 把原记录**原样带上**（含 notes / desc / job），
   *   漏带任何一个字段 = 下次保存把它抹掉（服务端那句注释警告的就是这件事）。
   * ⚠ 三个字段都没变（patch 为空）就直接退出，不发无谓的请求。
   * ⚠ 只把**真变了的**字段并进去（`editCommit` 已经算好），免得白写一次 + 白排一次盘。
   */
  const onEditCommit = useCallback(() => {
    const cur = panelRef.current;
    const rec = cur.rec;
    if (!rec || !cur.saved) return;

    const out = model.editCommit(edit, rec);
    if (!out.ok) {
      showToast(out.error || '改不了');
      return;
    }
    if (!Object.keys(out.patch).length) {
      Keyboard.dismiss();
      setEdit(model.editOf());
      return;
    }

    setEdit((e: any) => model.editPatch(e, { saving: true }));

    const light = model.mergePatch(rec, out.patch);
    history.push(light).then((res: any) => {
      const now = panelRef.current;
      // 保存期间用户可能已经离开或换了盘 —— 别把结果落到别的盘上
      if (!now.rec || now.rec.id !== rec.id) return;

      if (res && res.ok) {
        Keyboard.dismiss();
        setEdit(model.editOf());
        /* ⚠⚠ 改了字段要**重排一次整条记录**（hydrate），不能只改 rec 上那几个键 ——
           desc / job 变了界面上那两行要跟着变，而姓名还牵动别处（结果页标题等）。
           hydrate 是纯函数，代价是几十毫秒，这里值。 */
        let next = null;
        try {
          next = recordLib.hydrate(light, { id: light.id });
        } catch (err) {
          console.warn('[paipan] 改名后重排失败', err);
        }
        if (next) {
          setPanel((p: Panel) => ({ ...p, rec: next }));
          applyNotes(next.notes || {});
        }
        /* ⚠ 改了哪几个就说哪几个 —— 别再拿「改了名字就一律报姓名已改」。
           文案在 model.editToast 里算（纯函数、有断言）：三个字段的任意组合都得说对。 */
        showToast(model.editToast(out.patch));
        return;
      }

      setEdit((e: any) => model.editPatch(e, { saving: false }));
      showToast('保存失败，请重试');
      console.warn('[paipan] 改名/改职业/改描述保存失败', res && res.error);
    });
  }, [edit, applyNotes, showToast]);

  /* ---------------- 详细信息：修改**出生时间**（用户 2026-10-21） ---------------- */

  /**
   * 打开排盘表单（浮层）。预填 = **修改态的草稿**（进入修改态时取自记录）。
   * ⚠ 只在已保存的记录上有意义（未保存的盘没有 id，改了也没地方存）——
   *   入口本身就在修改态里，门已由「修改」按钮挡在外面。
   */
  const onBirthOpen = useCallback(() => {
    const cur = panelRef.current;
    if (!cur.rec || !cur.saved) return;
    Keyboard.dismiss();
    setBirthOn(true);
  }, []);

  const onBirthClose = useCallback(() => { setBirthOn(false); }, []);

  /**
   * 排盘表单交了新的出生数据 —— **只改草稿，不碰后端**（用户原话：
   *   「只是点更新排盘的话，只是选中性别和时间，不触及更改后端的数据」
   *   「只有点保存，才会更新排盘信息」）。
   *
   * ⚠⚠ 所以这里**没有** history.push、没有 hydrate、盘面也不动 ——
   *   把 gender/date/time 写进 `edit` 草稿就收工；真正的写库 + 重排发生在
   *   `onEditCommit`（底部「保存」）那一下，与姓名 / 职业 / 描述**同一次** PUT 出去。
   * ⚠ 草稿里的值会立刻回显在「出生时间」那一行（`birthText` 读的就是草稿），
   *   用户能确认自己选的是不是那一组。
   */
  const onBirthCommit = useCallback((v: any) => {
    const cur = panelRef.current;
    if (!cur.rec || !cur.saved) return;
    const d = v || {};
    setEdit((e: any) => model.editPatch(e, {
      gender: d.gender === 0 ? 0 : 1,
      date: typeof d.date === 'string' ? d.date : '',
      time: typeof d.time === 'string' ? d.time : '',
    }));
    setBirthOn(false);
    showToast('已选中新的出生时间，点「保存」后生效');
  }, [showToast]);

  /* ---------------- 详细信息：删除这条八字 ---------------- */

  const onDeleteAsk = useCallback(() => {
    if (!panelRef.current.rec || !panelRef.current.saved) return;
    /* ⚠⚠ 每次开窗都**重新生成**一串随机数字，并清空上一次的输入。
       绝不复用上一次的码：复用等于把一个已经被人看过的口令留在那儿，
       而且用户可能记得上一个码、直接盲打进去（那就退化成「点两下」了）。 */
    setDelCode(model.deleteCodeNew());
    setDelInput('');
    setConfirmDel(true);
  }, []);

  const onDeleteCancel = useCallback(() => {
    if (delBusy) return;              // 删除中不给取消（请求回来没地方落结果）
    setConfirmDel(false);
    setDelInput('');
  }, [delBusy]);

  /**
   * 真删。
   * ⚠ 删成功后**整页退回空态**：这条记录已经不在云端了，留着它的盘面
   *   只会让用户以为「还在」，再点保存又会把它写回去（看起来像「删不掉」）。
   */
  const onDeleteDo = useCallback(() => {
    const rec = panelRef.current.rec;
    if (!rec || delBusy) return;

    /* ⚠⚠⚠ 口令在**这里**再校验一次（不能只靠按钮 disabled）：
       disabled 是「视觉上不让点」，而这个回调还能被别的路径触发
       （回车提交、自动化、将来的快捷键）—— 危险操作必须**在动手那一刻**
       自己确认前提，不能依赖 UI 层替它把关。 */
    const gate = model.deleteCodeCheck(delCode, delInput);
    if (!gate.ok) {
      showToast(gate.error || '数字不对');
      return;
    }

    setDelBusy(true);
    history.drop(rec.id).then((res: any) => {
      setDelBusy(false);
      if (res && res.ok) {
        setConfirmDel(false);
        setDelInput('');
        setPanel(model.emptyPanel() as Panel);
        applyNotes({});
        setEdit(model.editOf());
        setActiveTab('chart');
        showToast('已删除');
        return;
      }
      // 没登录 / 网络失败：如实说，别假装删掉了
      showToast(res && res.reason === 'no-login' ? '请先登录再删除' : '删除失败，请重试');
      console.warn('[paipan] 删除失败', res && res.error);
    });
  }, [delBusy, delCode, delInput, applyNotes, showToast]);

  /* ---------------- 事件编辑框 ---------------- */

  /**
   * 盯住键盘的显隐。
   * ⚠⚠ 两个平台的**事件名不一样**，用错的表现是「iOS 上永远收不到事件」：
   *   iOS 用 willShow / willHide（跟动画同步，来得及让位），
   *   安卓只有 didShow / didHide。用错不报错，只是让位慢半拍、按钮不出现。
   */
  useEffect(() => {
    const shownEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hiddenEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(shownEvt, () => setKbShown(true));
    const b = Keyboard.addListener(hiddenEvt, () => setKbShown(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  /**
   * 盘上某一格被**长按**了（ChartView 抛上来的 { key, title, meta }）。
   * ⚠ 未保存的盘直接拒绝：事件是挂在**云端那条记录**上的，
   *   记录还不存在时写下去无处可放 —— 这也正是「事件记录」页签那道门的由来。
   */
  const onNoteEdit = useCallback(
    (v: any) => {
      if (!panelRef.current.saved) {
        showToast('先保存到记录，才能记事件');
        return;
      }
      const r = model.editorForNote(v, notes);
      if (!r.ok) return;
      setEditor(r.editor);
    },
    [notes, showToast]
  );

  const onNoteInput = useCallback((text: string) => {
    setEditor((cur: any) => model.editorPatch(cur, { text: text || '' }));
  }, []);

  /**
   * 关掉编辑框（点遮罩 / 取消都走它）。
   * ⚠ 顺带 `Keyboard.dismiss()`：框没了而键盘还挂着，会直接压住下面刚露出来的盘，
   *   看起来像「点了一下什么都没发生」。
   * ⚠ 保存中不给关（见 model.maskTapAction 的 'none'）—— 请求回来会没地方落结果。
   */
  const onNoteClose = useCallback(() => {
    Keyboard.dismiss();
    setEditor((cur: any) => (cur && cur.saving ? cur : model.editorOf()));
  }, []);

  /** 标题行右侧那个「收起键盘」—— 用户明确要的入口（iOS 的多行输入没有回车键可收） */
  const onHideKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  /**
   * 点编辑框**外面**那块遮罩。
   * ⚠⚠ 两段式（先收键盘、再点才关框），不是一句 onClose ——
   *   否则「想收键盘」的那一下会连带把框关掉，**未保存的正文当场丢光**。
   *   分派规则在 model.maskTapAction 里（纯函数，有断言守着）。
   */
  const onMaskTap = useCallback(() => {
    const act = model.maskTapAction(!!(editor && editor.saving), kbShown);
    if (act === 'dismiss-keyboard') Keyboard.dismiss();
    else if (act === 'close') onNoteClose();
  }, [editor, kbShown, onNoteClose]);

  /**
   * 确认：写回云端那一条记录的 notes。
   * ⚠ 清空正文 = 删除这条事件（见 model.noteItemOf）。
   * ⚠ 失败时编辑框与内容都留着，让用户直接再点一次确认（不丢他刚写的东西）。
   */
  const onNoteSave = useCallback(() => {
    const ed = editor;
    const rec = panelRef.current.rec;
    if (!ed || !ed.show || ed.saving || !rec || !ed.key) return;

    const item = model.noteItemOf(notes, ed);
    if (!item.ok) return;

    setEditor(model.editorPatch(ed, { saving: true }));

    history.saveNotes(rec.id, item.notes).then((res: any) => {
      const now = panelRef.current;
      if (!now.rec || now.rec.id !== rec.id) return;

      if (res && res.ok) {
        Keyboard.dismiss();
        setEditor(model.editorOf());
        applyNotes(item.notes);
        showToast(item.toast);
        return;
      }
      setEditor(model.editorPatch(ed, { saving: false }));
      const msg = model.noteSaveToast(res);
      if (msg === '保存失败，请重试') console.warn('[paipan] 事件保存失败', res && res.error);
      showToast(msg);
    });
  }, [applyNotes, editor, notes, showToast]);

  /**
   * 安卓物理返回键：编辑框开着时**先管编辑框**，别让它把整个结果页关掉
   * （那样用户刚排的盘一起没了）。
   * ⚠ RN 的 BackHandler 是**后注册先响应**：App 那边为结果页也注册了一个，
   *   但本 effect 只在框打开时才注册（更晚）⇒ 它排在栈顶，先拿到事件。
   * ⚠ 键盘弹着时安卓系统会自己吃掉返回键去收键盘，事件根本不会到 JS ——
   *   所以这里只需要处理「键盘已收、框还开着」那一段。
   */
  useEffect(() => {
    if (!editor.show) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onMaskTap();          // 与点遮罩同一套语义，别写第二遍
      return true;          // 已处理，不往下传（不关结果页）
    });
    return () => sub.remove();
  }, [editor.show, onMaskTap]);

  /* ---------------- 页签 ---------------- */

  const onTab = useCallback((k: string) => {
    const next = model.nextTab(activeTab, k);
    if (!next) return;
    setActiveTab(next);
  }, [activeTab]);

  /* ---------------- 样式 ---------------- */

  /* ⚠ 本页盖满全屏（App 的推入层从 y=0 到屏底），底部没有 tab 栏兜着 ——
     纵向留白必须把 home indicator 的高度算进去，否则最后一颗按钮贴在屏底被压住。 */
  const insets = useSafeAreaInsets();

  const s = useMemo(() => StyleSheet.create({
    /**
     * ⚠ 结果页这层**不许有左右内边距**（见文件头）：
     *   上下给设计稿的纵向留白，左右交还给 ChartView 自己排（组件里是满宽）。
     */
    scroll: { flex: 1, backgroundColor: COLORS.bg },
    page: { paddingBottom: rpx(SIZES.pagePadBottom) + insets.bottom },

    /* ===== 顶部切换栏：通栏三等分 ===== */
    tabs: {
      flexDirection: 'row',
      backgroundColor: COLORS.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.borderLight,
    },
    tab: { position: 'relative', flex: 1, paddingTop: rpx(22), paddingBottom: rpx(18), alignItems: 'center' },
    tabText: { fontSize: rpx(30), color: '#8d8d8d' },
    tabTextOn: { color: COLORS.gold, fontWeight: FONT_WEIGHTS.semibold },
    /** 短金线：**绝对定位贴底**，不进文档流 —— 否则选中那一刻文字会被顶上去、整条栏跳一下 */
    tabLine: {
      position: 'absolute',
      left: '50%',
      bottom: 0,
      width: rpx(48),
      height: rpx(4),
      marginLeft: -rpx(24),
      backgroundColor: COLORS.gold,
    },

    /* ===== 门（事件记录 / 师傅批字共用）===== */
    gate: { paddingTop: rpx(120), alignItems: 'center' },
    gateTitle: { fontSize: rpx(32), color: COLORS.gold, fontWeight: FONT_WEIGHTS.semibold },
    gateHint: {
      marginTop: rpx(14),
      marginHorizontal: rpx(60),
      fontSize: rpx(24),
      lineHeight: rpx(24 * 1.6),
      color: '#b3ab99',
      textAlign: 'center',
    },

    /* ===== 三个面板 ===== */
    panelOn: { display: 'flex' },
    /** ⚠ display:'none' 是**真·不参与布局** —— 收起时面板里的横向 ScrollView 不会留测量残值 */
    panelOff: { display: 'none' },

    hydrating: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: rpx(120),
    },
    hydratingText: { color: COLORS.gold, fontSize: rpx(28), marginLeft: rpx(14) },

    noteHint: {
      marginTop: rpx(22),
      marginHorizontal: rpx(26),
      fontSize: rpx(23),
      lineHeight: rpx(23 * 1.6),
      color: '#b3ab99',
      textAlign: 'center',
    },

    /**
     * 保存按钮：形状交给全局那一套（胶囊），
     * 「结果页一律直角」那条只管卡片 / 面板这类背景块，按钮不算。
     * ⚠ 左右外边距自己给（本页 .page 左右为 0），跟盘面同宽。
     */
    btnDark: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      /* ⚠ alignSelf:stretch：门的容器（s.gate）是 alignItems:'center'（标题要居中），
         不写这条的话按钮会缩成「按文字宽度」的小胶囊，跟排盘结果页签底部那颗
         通栏按钮长得不一样（用户实测报障）。写在这份样式里 = 门里/底部两处共用同一种形状。 */
      alignSelf: 'stretch',
      marginTop: rpx(32),
      marginHorizontal: rpx(24),
      height: rpx(96),
      borderRadius: rpx(RADII.btn),
      backgroundColor: '#161616',
    },
    btnSaved: { backgroundColor: '#d8cbb3' },
    btnFail: { backgroundColor: '#b8443d' },
    btnLabel: { color: '#c9a96a', fontSize: rpx(34), letterSpacing: rpx(4), fontWeight: FONT_WEIGHTS.medium },
    btnLabelSaved: { color: '#ffffff' },
    btnLabelFail: { color: '#ffe7e5' },
    btnLabelBefore: { color: '#ffffff' },
    spin: { marginRight: rpx(14) },

    /* ===== 详细信息：标签 + 值两列 ===== */
    /* ⚠ 左右留白跟盘面一样自己给（本页 .page 左右为 0） */
    infoWrap: { paddingTop: rpx(36), paddingBottom: rpx(48), paddingHorizontal: rpx(26) },
    infoRow: {
      flexDirection: 'row',
      paddingVertical: rpx(20),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.borderLight,
    },
    /** 标签定宽，值才能对齐成一列（不定宽的话每行值都从不同位置开始，很难扫读） */
    infoLabel: { width: rpx(120), fontSize: rpx(27), color: '#8d8d8d' },
    /* ⚠ flex:1 让值占满右侧、并在超长时自动换行；少了他长文本会顶破整行 */
    infoValue: { flex: 1, fontSize: rpx(28), lineHeight: rpx(28 * 1.6), color: '#3d3a34' },
    /** 描述是多行文本：行高再松一点，读起来不挤 */
    infoValueMulti: { lineHeight: rpx(28 * 1.85), color: '#3d3a34' },

    /* ===== 标签那一行：**只给修改态用**（展示态那份是只读的，不用这两个样式）=====
       ⚠⚠ 它们的作用就是「让人看出这里点得动」—— 展示态不进修改态就画不出它，
         这正合用户的要求（标签的修改必须藏在「修改」按钮后面，不能分散）。
       ⚠ 箭头不能挤着文字：`marginLeft` 留一点，长标签名换行时也不会顶上去。 */
    infoTagRight: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    infoTagArrow: { marginLeft: rpx(10), fontSize: rpx(32), color: '#c0b8a8' },

    /* ===== 「出生时间」那一行的两段字（修改态专属）=====
       ⚠ 主行 = 阳历 + 时刻（用户来这儿就是要核对这个）；副行 = 农历 + 性别。
         副行字号小一档、颜色浅一档：它是「顺带确认」，不该和主行抢。
       ⚠ 纵向容器要有 `flex: 1`，否则长文案会把 `›` 顶出屏幕边。 */
    birthStack: { flex: 1 },
    birthMain: { fontSize: rpx(28), lineHeight: rpx(28 * 1.55), color: '#3d3a34' },
    birthMainEmpty: { color: '#c0b8a8' },
    birthSub: { marginTop: rpx(2), fontSize: rpx(23), lineHeight: rpx(23 * 1.5), color: '#9b958a' },

    /**
     * ⚠ 编辑态**不换行高**（沿用 infoRow 的 paddingVertical / 下边框），否则点进去那一刻
     * 整个列表会往下跳一截 —— 视觉上像点错了。
     */
    infoRowEdit: {
      flexDirection: 'row',
      paddingVertical: rpx(20),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.borderLight,
    },
    /** 输入框 + 按钮组竖排在右侧 */
    infoEditRight: { flex: 1 },
    infoInput: {
      borderWidth: rpx(1),
      borderColor: '#e2d9c6',
      backgroundColor: '#fbf8f2',
      paddingHorizontal: rpx(18),
      paddingVertical: rpx(14),
      fontSize: rpx(28),
      color: '#3d3a34',
      borderRadius: rpx(4),
    },
    /** 描述是多行框：给个最小高度 + 靠上对齐，不然只露一行看不清写了什么 */
    infoInputMulti: { minHeight: rpx(180), lineHeight: rpx(28 * 1.6), paddingTop: rpx(16) },
    infoEditBtns: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: rpx(14),
    },
    infoEditBtn: {
      marginLeft: rpx(14),
      paddingHorizontal: rpx(26),
      paddingVertical: rpx(12),
      borderWidth: rpx(1),
      borderColor: '#e2d9c6',
      borderRadius: rpx(4),
    },
    /** 保存中：禁用态用灰底灰边，跟「取消」区分不大但明确不可点 */
    infoEditBtnOff: { borderColor: '#ddd4c2', backgroundColor: '#f4efe6' },
    infoEditBtnPrimary: { borderColor: COLORS.gold, backgroundColor: COLORS.gold },
    infoEditBtnText: { fontSize: rpx(26), color: '#8d8d8d' },
    infoEditBtnTextPrimary: { color: '#ffffff' },
    /**
     * ⚠⚠ 「描述」为空时的占位灰字（用户要求这一栏**永远显示**）。
     *   用比正文更淡的灰，让人一眼区分「没填」和「填了」——
     *   ⚠ 但别淡到看不见：它是唯一提示「这里可以填」的东西。
     */
    infoValueEmpty: { color: '#c0b8a8' },
    /** 修改态底下那行小字（说明「描述留空即清空」） */
    infoEditHint: {
      marginTop: rpx(14),
      paddingHorizontal: rpx(2),
      fontSize: rpx(23),
      lineHeight: rpx(23 * 1.6),
      color: '#b3ab99',
    },

    /* ===== 详情页底部两颗按钮：修改（主）+ 删除（危险）===== */
    infoActions: { marginTop: rpx(40), flexDirection: 'row' },
    /** 「修改」走金色描边（本页主操作），与实心红的删除刻意区分 */
    infoModifyBtn: {
      flex: 1,
      marginRight: rpx(16),
      paddingVertical: rpx(24),
      alignItems: 'center',
      borderWidth: rpx(1),
      borderColor: COLORS.gold,
      borderRadius: rpx(4),
    },
    infoModifyBtnText: { fontSize: rpx(28), color: '#a8863f' },

    /* ===== 删除这条八字（危险操作：红字描边，跟金色主色刻意区分开）===== */
    delBtn: {
      flex: 1,
      paddingVertical: rpx(24),
      alignItems: 'center',
      borderWidth: rpx(1),
      borderColor: '#e6b8b8',
      borderRadius: rpx(4),
    },
    delBtnText: { fontSize: rpx(28), color: '#c0504d' },
    delBody: {
      marginTop: rpx(18),
      fontSize: rpx(26),
      lineHeight: rpx(26 * 1.7),
      color: '#8d8d8d',
    },
    /** 确认删除那颗按钮：实心红，比编辑态的金色更「重」，防误触的最后一层 */
    delBtnDanger: { borderColor: '#c0504d', backgroundColor: '#c0504d' },

    /* ===== 删除的随机数字口令 ===== */
    delCodeBox: {
      marginTop: rpx(22),
      paddingVertical: rpx(20),
      paddingHorizontal: rpx(20),
      backgroundColor: '#faf6ee',
      borderWidth: rpx(1),
      borderColor: '#ece2cd',
      borderRadius: rpx(4),
      alignItems: 'center',
    },
    delCodeLabel: { fontSize: rpx(23), color: '#a89c86' },
    /** ⚠ 口令要**足够大**并且字距拉开 —— 一串数字挤在一起极易看错一位 */
    delCodeText: {
      marginTop: rpx(12),
      fontSize: rpx(44),
      letterSpacing: rpx(8),
      fontWeight: '600',
      color: '#3d3a34',
    },
    delCodeInput: {
      marginTop: rpx(16),
      borderWidth: rpx(1),
      borderColor: '#e2d9c6',
      backgroundColor: '#fbf8f2',
      paddingHorizontal: rpx(18),
      paddingVertical: rpx(14),
      fontSize: rpx(30),
      letterSpacing: rpx(4),
      color: '#3d3a34',
      borderRadius: rpx(4),
    },
    /** 输入不对的即时提示（红色，跟危险操作的语义一致） */
    delCodeErr: { marginTop: rpx(10), fontSize: rpx(23), color: '#c0504d' },

    /* ===== 事件记录：只读全量时间线 ===== */
    tlWrap: { paddingTop: rpx(26), paddingBottom: rpx(48), paddingHorizontal: rpx(26) },
    tlEmpty: {
      paddingVertical: rpx(120),
      paddingHorizontal: rpx(40),
      textAlign: 'center',
      fontSize: rpx(26),
      lineHeight: rpx(26 * 1.8),
      color: '#b3ab99',
    },
    /** 左侧那一条竖线用容器的 borderLeft 画（ttss 对伪元素支持不稳，RN 也没有伪元素） */
    tlList: { marginLeft: rpx(6), paddingLeft: rpx(20), borderLeftWidth: rpx(2), borderLeftColor: '#f0e7d6' },
    tlItem: { paddingBottom: rpx(22) },
    /** 缩进是**累加**的（流月要落在流年里面），所以写的是绝对左边距，不是相对父级 */
    tlLiunian: { marginLeft: rpx(20), paddingLeft: rpx(16), borderLeftWidth: rpx(1), borderLeftColor: '#ece2cc' },
    tlLiuyue: {
      marginLeft: rpx(40),
      paddingLeft: rpx(16),
      borderLeftWidth: rpx(1),
      borderLeftColor: '#ece2cc',
      borderStyle: 'dashed',
    },
    tlTitle: { fontSize: rpx(25), fontWeight: FONT_WEIGHTS.semibold, lineHeight: rpx(25 * 1.5), color: '#8a6d3f' },
    tlTitleDayun: { fontSize: rpx(27), color: COLORS.gold },
    tlText: { marginTop: rpx(6), fontSize: rpx(27), lineHeight: rpx(27 * 1.75), color: '#3d3a34' },

    /* ===== 师傅批字占位 ===== */
    /* ===== 师傅批字：气泡列表 + 底部输入条 ===== */
    chatWrap: { paddingTop: rpx(26), paddingBottom: rpx(40), paddingHorizontal: rpx(26) },
    chatCenter: { paddingVertical: rpx(70), alignItems: 'center' },
    chatCenterText: { marginTop: rpx(12), fontSize: rpx(24), color: COLORS.textMuted },
    chatFailText: { fontSize: rpx(25), color: COLORS.danger, textAlign: 'center' },
    chatRetry: {
      marginTop: rpx(20),
      paddingVertical: rpx(12),
      paddingHorizontal: rpx(40),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.gold,
    },
    chatRetryText: { fontSize: rpx(25), color: COLORS.gold },
    chatEmpty: {
      /* ⚠ 只留一点：外面那层 chatCenter 已经有 paddingVertical —— 这里再要 90 就悬空了 */
      paddingTop: rpx(20),
      alignSelf: 'stretch',
      paddingHorizontal: rpx(30),
      textAlign: 'center',
      fontSize: rpx(26),
      lineHeight: rpx(26 * 1.8),
      color: '#b3ab99',
    },
    /** 空态那颗「发起求测」——⚠ 直角（本页一律不给圆角），尺寸对齐输入条的发送键 */
    chatReq: {
      marginTop: rpx(46),
      minWidth: rpx(220),
      height: rpx(76),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: COLORS.gold,
    },
    chatReqOff: { backgroundColor: '#d8cbb3' },
    chatReqText: { fontSize: rpx(27), color: '#ffffff' },
    chatReqTextBusy: { marginLeft: rpx(8) },
    /** 一行气泡：靠 alignItems 分左右（我的靠右、师傅的靠左） */
    bubbleRow: { marginBottom: rpx(20), alignItems: 'flex-start' },
    bubbleRowMine: { alignItems: 'flex-end' },
    /**
     * ⚠ 气泡**也不给圆角** —— 本页一律直角（用户要求），与编辑框 / 按钮同一条。
     * maxWidth 用百分比：屏宽一变气泡跟着变，不用重算。
     */
    bubble: { maxWidth: '82%', paddingVertical: rpx(16), paddingHorizontal: rpx(20) },
    bubbleTheirs: {
      backgroundColor: COLORS.goldBgSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.borderLight,
    },
    bubbleMine: { backgroundColor: COLORS.gold },
    bubbleText: { fontSize: rpx(27), lineHeight: rpx(27 * 1.7), color: '#3d3a34' },
    bubbleTextMine: { color: '#ffffff' },
    bubbleTime: { marginTop: rpx(8), fontSize: rpx(20), color: COLORS.textGhost },
    bubbleTimeMine: { color: 'rgba(255,255,255,0.78)' },
    chatFoot: {
      marginTop: rpx(24),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    chatFootText: {
      flex: 1,
      fontSize: rpx(22),
      lineHeight: rpx(22 * 1.6),
      color: COLORS.textGhost,
    },
    chatFootBtn: { marginLeft: rpx(20), paddingVertical: rpx(8), paddingHorizontal: rpx(24) },
    chatFootBtnText: { fontSize: rpx(23), color: COLORS.gold },

    /* 输入条：⚠ 外层 View 只用 display 切显隐（不条件渲染），里面这层管布局 */
    composerOn: { display: 'flex' },
    composerOff: { display: 'none' },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: rpx(26),
      paddingTop: rpx(16),
      /* ⚠ 没有 paddingBottom —— 它随「键盘在不在」变，在 JSX 里补（见输入条处） */
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: COLORS.border,
      backgroundColor: COLORS.bgSoft,
    },
    composerInput: {
      flex: 1,
      minHeight: rpx(76),
      maxHeight: rpx(220),
      paddingHorizontal: rpx(20),
      paddingVertical: rpx(14),
      fontSize: rpx(27),
      lineHeight: rpx(27 * 1.6),
      color: '#3d3a34',
      backgroundColor: COLORS.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.border,
      textAlignVertical: 'top',
    },
    /** ⚠ 直角（本页一律不给圆角） */
    composerBtn: {
      marginLeft: rpx(16),
      minWidth: rpx(132),
      height: rpx(76),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: COLORS.gold,
    },
    composerBtnOff: { backgroundColor: '#d8cbb3' },
    composerBtnText: { fontSize: rpx(27), color: '#ffffff' },
    composerBtnTextBusy: { marginLeft: rpx(8) },

    /* ===== 事件编辑框（长按某一格弹出）===== */
    /* ⚠ textarea 是原生组件、层级在普通元素之上，所以遮罩必须真·悬浮（absolute 覆盖全屏）压在它上面 */
    mask: {
      position: 'absolute',
      left: 0, right: 0, top: 0, bottom: 0,
      zIndex: 100,
      backgroundColor: COLORS.scrim,
    },
    /**
     * 避让层：撑满遮罩。⚠ 键盘避让由**根节点**统一做（components/KeyboardAvoid），这里不再叠。
     * ⚠ 居中/左右留白放在**这一层**而不是 mask 上 —— mask 得保持"纯遮罩"，
     *   它一旦有 padding，空出来的那块就漏出页面了。
     * ⚠ pointerEvents 是 'box-none'：这一层的空白处要能穿透到下面的遮罩 Pressable，
     *   否则点空白收键盘会失效。
     * ⚠⚠ 这里是 `justifyContent:'center'`，而**纵向居中 + 弹性子项**在 RN 里会让
     *   子项**溢出屏幕**（flexbox 里居中比 flex-start 更早溢出）——
     */
    kav: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: rpx(48),
    },
    /**
     * ⚠⚠ `maxHeight: '100%'` 是弹框**不被键盘盖住**的那一半解法（另一半是 kav 的让位）：
     *   不给的话，内容超屏时框会一直长下去、底部的「保存」被压到键盘下面 ——
     *   这正是用户报的那个问题（「输入的太多，保存按钮会移动到下面，然后被键盘所遮挡」）。
     *   钉住高度之后，里面那层可滚内容才有确定的视口可以滚。
     */
    box: {
      width: '100%',
      maxHeight: '100%',
      paddingTop: rpx(28),
      paddingHorizontal: rpx(28),
      paddingBottom: rpx(24),
      backgroundColor: COLORS.bg,
    },
    /* 标题 + 右侧「收起键盘」：底边框挂在这一行上（挂标题上的话，按钮会跑到线下面） */
    boxHead: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      paddingBottom: rpx(18),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.borderLight,
    },
    /* ⚠ flexShrink：长标题（如「2026年 丙午 流年」）不许把右边的按钮挤出框外 */
    boxTitle: {
      flexShrink: 1,
      fontSize: rpx(28),
      fontWeight: FONT_WEIGHTS.semibold,
      lineHeight: rpx(28 * 1.5),
      color: COLORS.gold,
    },
    /* 「收起键盘」：只在键盘弹着时出现，所以它不占平时的版面 */
    kbBtn: {
      marginLeft: rpx(20),
      paddingVertical: rpx(6),
      paddingHorizontal: rpx(16),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#e6e0d4',
    },
    /* ⚠ 直角（本页除圆形指示器外一律不给圆角）*/
    kbBtnText: { fontSize: rpx(24), color: '#8d8d8d' },
    ta: {
      height: rpx(240),
      marginTop: rpx(20),
      padding: rpx(16),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#ece4d6',
      backgroundColor: COLORS.bgSoft,
      fontSize: rpx(26),
      lineHeight: rpx(26 * 1.7),
      color: '#3d3a34',
      textAlignVertical: 'top',
    },
    boxBtns: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: rpx(24) },
    /* ===== 保存前的小窗：姓名（单行）+ 描述（多行）===== */
    askName: {
      height: rpx(80),
      marginTop: rpx(20),
      paddingHorizontal: rpx(16),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#ece4d6',
      backgroundColor: COLORS.bgSoft,
      fontSize: rpx(28),
      color: '#3d3a34',
    },
    /** ⚠ 描述框比事件框矮一些：事件要写一大段，描述通常就一两句 */
    askDesc: { height: rpx(180) },
    /** ★ 保存窗里那排标签的小标题。
        ⚠ 这一行「标签」两个字不能省：下面那排 chip 与**记录页顶部的筛选栏**长得几乎一样，
          不写标题就会被当成「又一个筛选」（筛选是改列表的，这里是给这条记录归类）。
        ⚠ `marginBottom` 只留一点点：`TagBar` 自带的内边距已经把它和 chip 撑开了。 */
    askTagLabel: { marginTop: rpx(20), marginBottom: rpx(6), fontSize: rpx(24), color: '#8d8d8d' },

    noteBtn: {
      minWidth: rpx(140),
      marginLeft: rpx(20),
      paddingVertical: rpx(16),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#e6e0d4',
      alignItems: 'center',
    },
    noteBtnPrimary: { borderColor: COLORS.gold, backgroundColor: COLORS.gold },
    noteBtnOff: { borderColor: '#d8cbb3', backgroundColor: '#d8cbb3' },
    /** ⚠ 本页一律直角（用户要求）：编辑框与它的按钮都不给圆角 */
    noteBtnText: { fontSize: rpx(27), color: '#8d8d8d' },
    noteBtnTextPrimary: { color: '#ffffff' },

    /* ===== 一行轻提示（代替 tt.showToast）===== */
    toast: {
      position: 'absolute',
      left: rpx(60), right: rpx(60), bottom: rpx(60),
      backgroundColor: 'rgba(22,22,22,0.86)',
      borderRadius: rpx(RADII.cell),
      paddingVertical: rpx(14),
      paddingHorizontal: rpx(24),
      alignItems: 'center',
    },
    toastText: { color: '#ffffff', fontSize: rpx(24) },

    /* ---- 「修改出生时间」整屏浮层（2026-10-21）----
       ⚠ 它是**整屏**：铺满本页、盖住导航条以上的一切（zIndex 高于本页其它浮层）——
         里面装的是一整张排盘表单，半屏小窗放不下。 */
    birthPage: {
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: '#f5f5f5',
      zIndex: 60,
    },
    birthHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: rpx(30),
      paddingBottom: rpx(16),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#e6e0d4',
      backgroundColor: '#ffffff',
    },
    birthTitle: { color: COLORS.text, fontSize: rpx(32), fontWeight: FONT_WEIGHTS.medium },
    birthCancel: { color: COLORS.gold, fontSize: rpx(28), paddingVertical: rpx(10) },
    /* 表单卡自己的左右留白由 PaipanForm 内部给；这里只给页面级上下留白 */
    birthBody: {
      paddingTop: rpx(24),
      paddingBottom: rpx(60),
      paddingHorizontal: rpx(26),
    },
  }), [rpx, insets.bottom]);

  /* ---------------- 派生 ---------------- */

  const gate = model.gateOf(activeTab, panel.saved, !!panel.rec, panel.hydrating);

  /** 「详细信息」页签的字段行（纯展示，取数逻辑在 model.detailRowsOf） */
  const infoRows = useMemo(() => model.detailRowsOf(panel.rec), [panel.rec]);

  /**
   * 修改态里「出生时间」那一行显示什么：**阳历+时刻** 与 **农历+性别** 两段。
   *
   * ⚠⚠⚠ 取数在 `model.birthOf(rec, edit)` 里（纯函数、有断言），这里只是 memo。
   *   ① **草稿优先**：点「确定」只写草稿不写后端，读记录就永远显示旧值（踩过）。
   *   ② **农历按草稿日期重算**：不能拿 `rec.lunarText` 充数 —— 日期换了农历不换，
   *      两行字自己打架。
   *   ③ 用户要求（2026-10-21）：「除了阳历还要显示农历和性别，因为这些都是在排盘页面
   *      可以改到的数据」—— 排盘页能改的三样，这里都要能核对。
   */
  const birth = useMemo(() => model.birthOf(panel.rec, edit), [edit, panel.rec]);

  /** 删除确认弹窗的文案（标题 / 正文 / 两个按钮；正文里带这条八字的名字） */
  const delAsk = model.deleteConfirmText(panel.rec);

  /** 删除口令当前的校验结果（驱动「删除」按钮的可用性） */
  const delGate = model.deleteCodeCheck(delCode, delInput);

  const btnStyle = panel.saved
    ? s.btnSaved
    : panel.save.state === 'fail'
      ? s.btnFail
      : null;
  const btnLabelStyle = panel.saved
    ? s.btnLabelSaved
    : panel.save.state === 'fail'
      ? s.btnLabelFail
      : s.btnLabel;

  /** 保存按钮（页面 + 门里共用同一份状态，见 model.gateOf 的说明） */
  const saveButton = () => (
    <Pressable style={[s.btnDark, btnStyle]} onPress={onSave} disabled={panel.save.disabled}>
      {panel.save.state === 'pending' ? (
        <ActivityIndicator size="small" color="#c9a96a" style={s.spin} />
      ) : null}
      <Text style={[s.btnLabel, btnLabelStyle]}>{panel.save.text}</Text>
    </Pressable>
  );

  return (
    /* ⚠⚠ 键盘高度（eaten）压**这一层**，不压在 ScrollView 上：
        输入条是 ScrollView 的**兄弟节点**、排在它下面 ——
        只给 ScrollView 减高度的话，输入条会正好落在键盘底下被遮住。
        压在这一层 = 整页（含输入条）一起上移。
        ⚠ 输入条也不能塞进 ScrollView 里：套进滚动容器会被内容高度挤没
          （工具栏那次踩过同一个坑）。 */
    <View style={{ flex: 1, backgroundColor: COLORS.bg, marginBottom: eaten }}>
      {/* ===== 页签（⚠ 顺序 / 文案都来自 model，别在这里另抄一份）=====
          ⚠⚠⚠ 2026-10-21 用户要求「师傅批字隐藏，按钮也隐藏不许出现」——
             做法是 model.TAB_KEYS 里摘掉了 'notes'，所以这一栏**只有三格**。
             下面「面板四」与输入条都还在，但判据是 `activeTab === 'notes'`，
             这个 key 进不了 activeTab ⇒ **永远不可达**（连 发起求测 / 发送 / 刷新
             那些按钮一起，一个都渲染不出来）。要恢复只改 model 那一处。 */}
      <View style={s.tabs}>
        {model.TAB_KEYS.map((k: string) => (
          <Pressable key={k} style={s.tab} onPress={() => onTab(k)}>
            <Text style={[s.tabText, activeTab === k ? s.tabTextOn : null]}>
              {(model.TAB_LABELS as any)[k]}
            </Text>
            {activeTab === k ? <View style={s.tabLine} /> : null}
          </Pressable>
        ))}
      </View>

      {/* ⚠⚠ 本层不许有左右内边距（见文件头）—— 留白由下面各块自己给
          ⚠⚠ 键盘避让（eaten）**不在这里**，在外层那个 View 上（见上面的说明）：
             本页是绝对定位的推入层，不占 App 里那份内容区的高度，
             所以避让得自己再减一次 —— 减在**外层**，输入条才能跟着一起让。
             ScrollView 随之拿到更小的视口 ⇒ 能滚到底，底部按钮不再被键盘压住。
             ⚠ 别在页面里重新监听键盘：那是两份真相，必然跟根节点那份漂。 */}
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.page}
        keyboardShouldPersistTaps="handled"
      >
        {/*
          ===== 事件记录 / 师傅批字 **共用**的那道门 =====
          刻意放在面板区**外面、三块面板之前**，写一份就够：两个页签天然一致。
          ⚠ 门里的保存按钮跟「排盘结果」那颗共用同一份 save 状态（文案 / 转圈 / 变红），
            别再拿一套「保存」字样另起炉灶 —— 两份文案必然对不齐。
        */}
        {gate.show ? (
          <View style={s.gate}>
            <Text style={s.gateTitle}>保存才可使用</Text>
            <Text style={s.gateHint}>{gate.hint}</Text>
            {gate.mode === 'save' ? saveButton() : null}
            {gate.mode === 'hydrating' ? (
              <View style={[s.btnDark, s.btnSaved]}>
                <ActivityIndicator size="small" color="#ffffff" style={s.spin} />
                <Text style={[s.btnLabel, s.btnLabelBefore]}>正在排盘…</Text>
              </View>
            ) : null}
            {gate.mode === 'gap' ? (
              <Pressable style={s.btnDark} onPress={onGoPaipan}>
                <Text style={[s.btnLabel, s.btnLabelBefore]}>去排盘</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* ===== 面板一：详细信息（姓名 / 性别 / 职业 / 出生 / 描述；底部「修改」+「删除」）===== */}
        <View style={activeTab === 'info' ? s.panelOn : s.panelOff}>
          {/* 与另两个页签一致：整块等 saved，未保存时门下面不露空态 */}
          {panel.saved ? (
            <View style={s.infoWrap}>
              {/*
                ⚠⚠ 展示态 / 修改态是**整块**切的（不再是一行一行点着改）：
                  修改态下姓名 / 职业 / 描述**同时**是输入框，改完点一次「保存」一起提交。
                  用户要求「点击修改按钮才能进入修改姓名和描述的状态」。
              */}
              {edit.on ? (
                /* ============ 修改态：姓名 / 职业 / 描述都是输入框 ============ */
                <EditBlock
                  s={s}
                  rpx={rpx}
                  edit={edit}
                  onEditName={onEditName}
                  onEditJob={onEditJob}
                  onEditDesc={onEditDesc}
                  onEditCancel={onEditCancel}
                  onEditCommit={onEditCommit}
                  canTags={canTags}
                  tagName={tagName}
                  onTagOpen={onTagOpen}
                  birthText={birth.solar}
                  birthSub={birth.sub}
                  onBirthOpen={onBirthOpen}
                />
              ) : (
                /* ============ 展示态：纯展示，不可点（要改请按底部的「修改」）============ */
                <View>
                  {infoRows.map((row: any) => (
                    <View key={row.label} style={s.infoRow}>
                      <Text style={s.infoLabel}>{row.label}</Text>
                      {/*
                        ⚠⚠ 「职业」「描述」这两栏**永远是存在的**（用户要求；职业 2026-10-06
                          加字段时定的「同姓名和描述一样」），空的时候显示灰字占位 ——
                          它们都是「可以被主动清空」的字段，清空后整行消失的话，
                          用户就没有入口再把它填回来了。
                         ⚠ 占位文案只在这里给（model 只回答「有没有值」）。
                      */}
                      <Text
                        style={[
                          s.infoValue,
                          row.multiline ? s.infoValueMulti : null,
                          row.empty ? s.infoValueEmpty : null,
                        ]}
                      >
                        {row.empty ? '未填写' : row.value}
                      </Text>
                    </View>
                  ))}

                  {/*
                    ★ 标签行 —— **展示态 = 只读**（2026-10-05 用户要求）。
                    ⚠⚠⚠ 它**不是** Pressable、也**没有** `›`：用户原话
                      「标签的修改要在修改按钮点击之后才能修改，不能分散。
                        如果没有点击修改按钮那么就只是显示标签就行了」。
                      ⇒ 点得动的那一份在**修改态**里（EditBlock 里那一行）。
                      ⚠ 别在这里「顺手加个 onPress」—— 那就又把入口散出去了，
                        而且这一行和上面几行长得一模一样，用户根本分不清哪个能点。
                    ⚠ 整行只在后端支持标签时出现（canTags）—— 没这功能就别露痕迹。
                    ⚠ 未分类时照样画（灰字「未分类」）：先让人知道「这条还没归类」，
                      要改就按底部的「修改」。
                    ⚠ 结构与上面 `infoRows.map` 那几行**逐字一致**（label + infoValue），
                      这样它看着就是普通信息行 —— 这正是这次要的效果。
                  */}
                  {canTags ? (
                    <View style={s.infoRow}>
                      <Text style={s.infoLabel}>标签</Text>
                      <Text style={[s.infoValue, tagName ? null : s.infoValueEmpty]}>
                        {tagName || '未分类'}
                      </Text>
                    </View>
                  ) : null}
                </View>
              )}

              {/* ===== 底部两颗按钮：修改（主）+ 删除（危险）===== */}
              {!edit.on ? (
                <View style={s.infoActions}>
                  <Pressable style={s.infoModifyBtn} onPress={onEditStart}>
                    <Text style={s.infoModifyBtnText}>修改</Text>
                  </Pressable>
                  <Pressable style={s.delBtn} onPress={onDeleteAsk}>
                    <Text style={s.delBtnText}>删除这条八字</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* ===== 面板二：排盘结果（原来那一屏）===== */}
        <View style={activeTab === 'chart' ? s.panelOn : s.panelOff}>
          {panel.hydrating ? (
            /* 现场排盘那几十毫秒给一行反馈：组件的空态说的是「还没排盘」，跟「正在排」是两件事 */
            <View style={s.hydrating}>
              <ActivityIndicator size="small" color={COLORS.gold} />
              <Text style={s.hydratingText}>正在排盘…</Text>
            </View>
          ) : (
            /* ⚠ ChartView 内部自带整块盘面（含它自己的空态），这里不再套页壳 */
            <ChartView
              record={panel.rec}
              notes={notes}
              saved={panel.saved}
              onNote={onNoteEdit}
              onEmpty={onGoPaipan}
            />
          )}

          {/* 事件怎么录：只在已保存时提示（未保存时长按会被拒，提示了反而是误导） */}
          {panel.rec && panel.saved ? (
            <Text style={s.noteHint}>长按流年的格子，可记下那一年发生的事</Text>
          ) : null}

          {panel.rec ? saveButton() : null}
        </View>

        {/* ===== 面板三：事件记录（全量时间线，只读）===== */}
        <View style={activeTab === 'events' ? s.panelOn : s.panelOff}>
          {/* 整块等 saved：未保存时这里必须是空的，否则门下面还会再露一条空态文案 */}
          {panel.saved ? (
            <View style={s.tlWrap}>
              {timeline.length === 0 ? (
                <Text style={s.tlEmpty}>还没有记过事。在「排盘结果」页长按流年就能添加</Text>
              ) : (
                <View style={s.tlList}>
                  {timeline.map((item: any) => (
                    <View
                      key={item.key}
                      style={[
                        s.tlItem,
                        item.level === 'liunian' ? s.tlLiunian : null,
                        item.level === 'liuyue' ? s.tlLiuyue : null,
                      ]}
                    >
                      <Text style={[s.tlTitle, item.level === 'dayun' ? s.tlTitleDayun : null]}>
                        {item.title}
                      </Text>
                      {item.text ? <Text style={s.tlText}>{item.text}</Text> : null}
                    </View>
                  ))}
                </View>
              )}
            </View>
          ) : null}
        </View>

        {/* ===== 面板四：师傅批字（⚠⚠ 2026-10-21 起**不可达**：'notes' 已不在 TAB_KEYS）=====
            ⚠ 整块等 saved：未保存的八字**没有 id**，也就没有会话可挂 ——
              服务端的锚点就是 record.id，所以它与「事件记录」共用同一道 gate。 */}
        <View style={activeTab === 'notes' ? s.panelOn : s.panelOff}>
          {panel.saved ? (
            <View style={s.chatWrap}>
              {/* ⚠⚠ 两个游标**一起**判：求测单和消息是**并行**发的两个请求，
                  只要还有一个没回来就是「正在拉」—— 只判其中一个会出现
                  「消息已经画出来了、形态却还没定」的一帧（会闪一下按钮）。 */}
              {chatPhase === 'loading' ? (
                <View style={s.chatCenter}>
                  <ActivityIndicator size="small" color={COLORS.gold} />
                  <Text style={s.chatCenterText}>正在拉消息…</Text>
                </View>
              ) : null}

              {/* ⚠ 失败分支**也合成一个**：两个请求谁挂了都走这里（都出「重试」）。
                  文案优先取求测单那句 —— 它挂了时 chat.error 是空的。 */}
              {chatPhase === 'fail' ? (
                <View style={s.chatCenter}>
                  <Text style={s.chatFailText}>{req.error || chat.error}</Text>
                  <Pressable style={s.chatRetry} onPress={onChatReload}>
                    <Text style={s.chatRetryText}>重试</Text>
                  </Pressable>
                </View>
              ) : null}

              {/* ===== 第 1 态：还没发起求测 =====
                  ⚠⚠⚠ 点它**不是**发消息，是**下一张单**（用户拍板：
                  「App 上点击发起求测并不是发送一个聊天」）。
                  ⚠ 它与输入条、与下面那条「等接单」**三者互斥** —— 同一根判据
                  （chatPhase）的三个分支，所以不可能有两个同时露在屏幕上。 */}
              {chatPhase === 'none' ? (
                <View style={s.chatCenter}>
                  <Text style={s.chatEmpty}>{model.CHAT_TEXT.empty}</Text>
                  {/* ⚠ 沿用 chatBusy：提交中不能再点第二下（服务端幂等，但连点两下
                      会白打两次请求、还可能弹两次 toast）。 */}
                  <Pressable
                    style={[s.chatReq, chatBusy ? s.chatReqOff : null]}
                    disabled={chatBusy}
                    onPress={onChatRequest}
                  >
                    {chatBusy ? <ActivityIndicator size="small" color="#ffffff" /> : null}
                    <Text style={[s.chatReqText, chatBusy ? s.chatReqTextBusy : null]}>
                      {chatBusy ? model.CHAT_TEXT.sending : model.CHAT_TEXT.reqBtn}
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {/* ===== 第 2 态：单子递出去了，等师傅接单 =====
                  ⚠⚠ 这一态**没有输入框**（输入条的条件是 chatStarted = taken）——
                  会话还没建立，用户对着谁说话？「等待」在这里是唯一正确的界面。 */}
              {chatPhase === 'pending' ? (
                <View style={s.chatCenter}>
                  <ActivityIndicator size="small" color={COLORS.gold} />
                  <Text style={s.chatEmpty}>{model.CHAT_TEXT.waiting}</Text>
                </View>
              ) : null}

              {/* ===== 第 3 态：师傅已经接了单，可以聊了（提示只在还没说话时出） ===== */}
              {chatPhase === 'taken' && chat.list.length === 0 ? (
                <View style={s.chatCenter}>
                  <Text style={s.chatEmpty}>{model.CHAT_TEXT.takenEmpty}</Text>
                </View>
              ) : null}

              {/* ⚠ 用 map 而不是 FlatList：一个会话就几十条，与「事件记录」那条时间线
                  同一套写法。真要长到几百条再换 FlatList —— 那时才值得动这一块的结构。 */}
              {chat.list.map((m: any) => (
                <View key={m.id} style={[s.bubbleRow, m.mine ? s.bubbleRowMine : null]}>
                  <View style={[s.bubble, m.mine ? s.bubbleMine : s.bubbleTheirs]}>
                    <Text style={[s.bubbleText, m.mine ? s.bubbleTextMine : null]}>{m.text}</Text>
                    <Text style={[s.bubbleTime, m.mine ? s.bubbleTimeMine : null]}>
                      {m.timeText}
                    </Text>
                  </View>
                </View>
              ))}

              {/* 底部一行：一句说明 + 手动刷新（骨架阶段没有推送，得留一个刷新的出口） */}
              <View style={s.chatFoot}>
                <Text style={s.chatFootText}>{model.CHAT_TEXT.hint}</Text>
                <Pressable style={s.chatFootBtn} onPress={onChatReload}>
                  <Text style={s.chatFootBtnText}>刷新</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* ===== 师傅批字的输入条（⚠⚠ 2026-10-21 起**不可达**：'notes' 已不在 TAB_KEYS）=====
          ⚠⚠ 它是 ScrollView 的**兄弟节点**（不是子节点）—— 套进滚动容器里会被挤没。
          ⚠ 用 display 切、不做条件渲染：与四个面板同一条纪律（常驻 + display:'none'）。
          ⚠⚠ 露出条件 = 「批字页签 + 已保存 + **师傅已接单**」：
              `chatStarted` 就是 `chatPhase === 'taken'`（见上面那三个分支）。
              没发起求测 → 出按钮；发起了没人接 → 出「等接单」；**两种情况都没有输入框**。 */}
      <View style={activeTab === 'notes' && panel.saved && chatStarted ? s.composerOn : s.composerOff}>
        {/* ⚠⚠ 底部安全区只在**键盘收起时**补（`eaten === 0`）：键盘弹起时外层已让位、
            容器底边正好贴在键盘顶边，这时再补安全区反而多出一条 34pt 的缝。
            不补的话（原来写死 paddingBottom）收起键盘时输入条贴在屏幕最下沿、
            压在 Home 指示条上 —— 看着「太靠下」。 */}
        <View style={[s.composer, { paddingBottom: rpx(16) + (eaten > 0 ? 0 : insets.bottom) }]}>
          <TextInput
            style={s.composerInput}
            value={chatDraft}
            onChangeText={onChatDraft}
            placeholder={model.CHAT_TEXT.placeholder}
            placeholderTextColor={COLORS.textGhost}
            multiline
            maxLength={model.CHAT_INPUT_MAX}
            editable={!chatBusy}
          />
          <Pressable
            style={[s.composerBtn, !chatSendable.ok || chatBusy ? s.composerBtnOff : null]}
            onPress={onChatSend}
            disabled={!chatSendable.ok || chatBusy}
          >
            {chatBusy ? <ActivityIndicator size="small" color="#ffffff" /> : null}
            <Text style={[s.composerBtnText, chatBusy ? s.composerBtnTextBusy : null]}>
              {chatBusy ? model.CHAT_TEXT.sending : model.CHAT_TEXT.send}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* ===== 事件编辑框 ===== */}
      {editor.show ? (
        /* ⚠⚠⚠ 避让**不要再减一次**：mask 是上面那个 View（已带 `marginBottom: eaten`）的
            绝对定位子节点，跟着它一起让位就够了。
            这里再写一次 `marginBottom: eaten` = 同一个键盘高度扣两遍 ⇒ 弹框飘到屏幕上半截
            （原来那行是「减高度挂在 ScrollView 上」时代的写法；避让改挂外层 View 后它就成了双份）。 */
        <View style={s.mask}>
          {/* 点遮罩：两段式（键盘弹着时只收键盘，收了再点才关框）。
              点框内**不冒泡** —— 它是兄弟节点，不会被这个 Pressable 接走。 */}
          <Pressable style={StyleSheet.absoluteFill} onPress={onMaskTap} />

          {/* ⚠ 这层只负责「撑满遮罩 + 居中」：避让靠外层 View 的 marginBottom:eaten
              （根节点只下发数值，见 components/KeyboardAvoid）—— 这里**不要再叠** KAV。 */}
          <View style={s.kav} pointerEvents="box-none">
            <View style={s.box}>
              <View style={s.boxHead}>
                <Text style={s.boxTitle}>{editor.title}</Text>
                {/* 多行输入框的回车是换行、不是「完成」，iOS 上没有任何系统入口能收键盘；
                    没这个按钮，用户只能去点遮罩（那一步现在会被理解成「收键盘」，安全） */}
                {kbShown ? (
                  <Pressable style={s.kbBtn} onPress={onHideKeyboard} hitSlop={8}>
                    <Text style={s.kbBtnText}>收起键盘</Text>
                  </Pressable>
                ) : null}
              </View>
              <TextInput
                style={s.ta}
                value={editor.text}
                onChangeText={onNoteInput}
                placeholder="记录这段时间发生的事…"
                placeholderTextColor="#c8c8c8"
                maxLength={500}
                multiline
                editable={!editor.saving}
              />
              <View style={s.boxBtns}>
                <Pressable style={s.noteBtn} onPress={onNoteClose}>
                  <Text style={s.noteBtnText}>取消</Text>
                </Pressable>
                <Pressable
                  style={[s.noteBtn, editor.saving ? s.noteBtnOff : s.noteBtnPrimary]}
                  onPress={onNoteSave}
                >
                  <Text style={[s.noteBtnText, s.noteBtnTextPrimary]}>
                    {editor.saving ? '保存中…' : '确认'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      ) : null}

      {/* ===== 保存到记录：先问姓名 / 职业 / 描述（★ 排盘页不再收这几项）===== */}
      {saveAsk.show ? (
        /* ⚠ 避让同编辑框：**不在这里减**，靠外层 View 的 marginBottom:eaten（再减就是双份）。 */
        <View style={s.mask}>
          {/* ⚠ 提交中不给点遮罩关窗（请求回来没地方落结果）。
              非提交态点遮罩 = 取消（跟「取消」按钮同义）。 */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={saveAsk.saving ? undefined : onSaveAskCancel}
          />
          <View style={s.kav} pointerEvents="box-none">
            <View style={s.box}>
              <View style={s.boxHead}>
                <Text style={s.boxTitle}>保存到记录</Text>
                {kbShown ? (
                  <Pressable style={s.kbBtn} onPress={onHideKeyboard} hitSlop={8}>
                    <Text style={s.kbBtnText}>收起键盘</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* ⚠ 避让靠外层 View 的 marginBottom:eaten —— 这层里别再叠 KAV。 */}
              <>
                {/* ⚠ 姓名：单行。不填也存得下去（record 层兜成「未命名」），
                    所以这里**不做非空校验**、不给「必填」的红字 —— 别拦用户。 */}
                <TextInput
                  style={s.askName}
                  value={saveAsk.name}
                  onChangeText={onSaveAskName}
                        placeholder="姓名（选填）"
                  placeholderTextColor="#c8c8c8"
                  maxLength={30}
                  returnKeyType="done"
                  editable={!saveAsk.saving}
                />
                {/* ⚠ 职业：单行，与姓名同一套（trim；留空即不写）。2026-10-06 新增 */}
                <TextInput
                  style={s.askName}
                  value={saveAsk.job}
                  onChangeText={onSaveAskJob}
                        placeholder="职业（选填）"
                  placeholderTextColor="#c8c8c8"
                  maxLength={40}
                  returnKeyType="done"
                  editable={!saveAsk.saving}
                />
                {/* ⚠ 描述：多行，前后空白**不 trim**（与姓名/职业语义相反，见 model.saveAskCommit） */}
                <TextInput
                  style={[s.ta, s.askDesc]}
                  value={saveAsk.desc}
                  onChangeText={onSaveAskDesc}
                        placeholder="描述（选填）：这条八字是干什么的"
                  placeholderTextColor="#c8c8c8"
                  maxLength={500}
                  multiline
                  editable={!saveAsk.saving}
                />

                {/* ★ 选标签（用户 2026-10-05：「点击保存到记录按钮，弹窗能不能同时有选择标签的功能」）
                    ⚠⚠ 这里**只能选，不能建 / 改名 / 删**：标签本身只在记录页顶部的「管理」里管
                       （上一刀刚定的分工）。在这儿再开一个编辑入口，同一件事就有两个地方做了。
                    ⚠ 一条标签都没建时 `saveBar` 只有「未分类」一格 ⇒ 整块不渲染
                       （选了等于没选，白占一行；用户要建标签，去记录页的「管理」）。
                    ⚠ 保存中把这一块设成不吃点击：`TagBar` 自己没有 disabled 概念，
                       而这会儿再改草稿已经不影响本次提交（`want` 早在提交前就取走了）——
                       让它看起来还能点，是个谎话。 */}
                {canTags && saveBar.length > 1 ? (
                  <View pointerEvents={saveAsk.saving ? 'none' : 'auto'}>
                    <Text style={s.askTagLabel}>标签</Text>
                    <TagBar items={saveBar} onPick={onSaveAskTag} />
                  </View>
                ) : null}

                <View style={s.boxBtns}>
                  <Pressable
                    style={s.noteBtn}
                    onPress={onSaveAskCancel}
                    disabled={saveAsk.saving}
                  >
                    <Text style={s.noteBtnText}>取消</Text>
                  </Pressable>
                  <Pressable
                    style={[s.noteBtn, saveAsk.saving ? s.noteBtnOff : s.noteBtnPrimary]}
                    onPress={onSaveAskConfirm}
                    disabled={saveAsk.saving}
                  >
                    <Text style={[s.noteBtnText, s.noteBtnTextPrimary]}>
                      {saveAsk.saving ? '保存中…' : '保存'}
                    </Text>
                  </Pressable>
                </View>
              </>
            </View>
          </View>
        </View>
      ) : null}

      {/* ===== 删除二次确认（⚠⚠ 必须键入随机数字才能删）===== */}
      {confirmDel ? (
        /* ⚠ 避让同编辑框：**不在这里减**，靠外层 View 的 marginBottom:eaten（再减就是双份）。 */
        <View style={s.mask}>
          {/* ⚠ 删除中不给点遮罩关框（请求回来没地方落结果） */}
          <Pressable style={StyleSheet.absoluteFill} onPress={onDeleteCancel} />
          <View style={s.kav} pointerEvents="box-none">
            <View style={s.box}>
              <View style={s.boxHead}>
                <Text style={s.boxTitle}>{delAsk.title}</Text>
              </View>
              {/* ⚠ 避让同上：靠外层 View 的 marginBottom:eaten。 */}
              <>
                <Text style={s.delBody}>{delAsk.body}</Text>

                {/*
                  ⚠⚠ 随机数字口令（用户要求「弹出一个随机数字，用户输入后才能成功删除」）。
                    为什么要这个：删除**不可逆**，而「再点一次确认」是肌肉记忆就能过的 ——
                    手指连着点两下就删掉了。要求**照着键入**一串随机数，
                    强制眼睛和手都参与，误触基本不可能。
                */}
                <View style={s.delCodeBox}>
                  <Text style={s.delCodeLabel}>请输入下面这串数字以确认删除</Text>
                  <Text style={s.delCodeText} selectable>{delCode}</Text>
                </View>
                <TextInput
                  style={s.delCodeInput}
                  value={delInput}
                  onChangeText={setDelInput}
                        placeholder="在此输入上面的数字"
                  placeholderTextColor="#c8c8c8"
                  keyboardType="number-pad"
                  maxLength={8}
                  editable={!delBusy}
                  /* ⚠ 回车直接提交（数字键盘上那颗箭头/完成），省一次伸手去点按钮 */
                  onSubmitEditing={onDeleteDo}
                  returnKeyType="done"
                />
                {/* ⚠ 输入不对就当下说清，别等点了按钮才报（按钮那会儿是灰的，点不动） */}
                {!delGate.ok && !delGate.empty ? (
                  <Text style={s.delCodeErr}>{delGate.error}</Text>
                ) : null}

                <View style={s.boxBtns}>
                  <Pressable style={s.noteBtn} onPress={onDeleteCancel} disabled={delBusy}>
                    <Text style={s.noteBtnText}>{delAsk.cancel}</Text>
                  </Pressable>
                  <Pressable
                    style={[
                      s.noteBtn,
                      delBusy || !delGate.ok ? s.noteBtnOff : s.delBtnDanger,
                    ]}
                    onPress={onDeleteDo}
                    disabled={delBusy || !delGate.ok}
                  >
                    <Text style={[s.noteBtnText, s.noteBtnTextPrimary]}>
                      {delBusy ? '删除中…' : delAsk.ok}
                    </Text>
                  </Pressable>
                </View>
              </>
            </View>
          </View>
        </View>
      ) : null}

      {/* ===== 选标签面板（★ 全 App **唯一**能换标签的地方）=====
          ⚠⚠ `mode='pick'`：**只能换 / 取消归类** —— 面板里不给新建输入框，
            也不给每一行的「改名 / 删除」按钮
            （用户 2026-10-05 原话：「只能更换标签，不能删除和改名标签」）。
            新建 / 改名 / 删除在**记录页顶部的「管理」**里。
          ⚠ 它是 ScrollView 的**兄弟节点**（同下面那个删除确认框）：套进滚动容器里
            遮罩盖不住全屏，而且会跟着内容一起滚。
          ⚠ `busy` / `err` 由本页喂进去（权威只有一份，组件里不存副本）。 */}
      {canTags ? (
        <TagPicker
          visible={tagOpen}
          title={'「' + ((panel.rec && panel.rec.name) || '这条') + '」的标签'}
          currentId={tagId}
          mode="pick"
          tags={tags}
          busy={tagBusy}
          err={tagErr}
          onPick={onTagPick}
          onClose={onTagClose}
        />
      ) : null}

      {/* ===== 「修改出生时间」整屏浮层（用户 2026-10-21）=====
          ⚠⚠⚠ 表单是 `components/PaipanForm` —— **与排盘页同一份代码**
             （用户原话「排盘页面要封装，这就可以复用了」）。这里只给它：
             预填值（这条记录现在的性别 / 公历日期 / 时间）、按钮文案、一行说明。
             ⚠ 别把表单再抄一遍到本页：抄一份就是两个口径，改一处漏一处。
          ⚠ 它是**整屏**的（不是半屏小窗）：里面就是排盘页那张表单卡 + 两个选时浮层，
             半屏放不下；而且「改出生时间」和「首次排盘」在用户眼里本来就该长得一样。
          ⚠⚠ 这里的「确定」**不发请求、不写后端**（用户 2026-10-21 纠正：
             「只是点更新排盘的话，只是选中性别和时间，不触及更改后端的数据」）。
             它只把 gender/date/time 塞进修改态草稿然后关掉浮层；
             真正的重排与写库只在底部「保存」那一下（`onEditCommit` → `editCommit`）。
             所以这里没有 busy：没有在飞的请求，也不该有「提交中」的样子。
             ⚠ 按钮就写「确定」而不是「更新排盘」：它此刻**没有**排盘、也没有更新记录，
               叫「更新排盘」是在承诺一件没发生的事（用户 2026-10-21 指出并改的口径）。
          ⚠ 排在「轻提示」**之前**：提示要能浮在最上面。 */}
      {birthOn ? (
        /* ⚠⚠ 用 `Modal` 而不是本页内的绝对定位层：结果页上面还有 App 那条 NavBar
           （标题「排盘结果」+ 返回键），绝对定位层盖不住它 ——
           改出生时间时顶上却挂着「排盘结果 / 返回」，用户会当它是一条独立页面而误触。
           `DatePicker` / `GzPicker` 用的也是 Modal，这条路在本项目验证过（含 RNW）。 */
        <Modal visible transparent={false} animationType="slide" onRequestClose={onBirthClose}>
          <View style={s.birthPage}>
            <View style={[s.birthHead, { paddingTop: (insets && insets.top ? insets.top : 0) + rpx(8) }]}>
              <Text style={s.birthTitle}>修改出生时间</Text>
              <Pressable onPress={onBirthClose} hitSlop={10}>
                <Text style={s.birthCancel}>取消</Text>
              </Pressable>
            </View>
            <ScrollView
              style={{ flex: 1, backgroundColor: '#f5f5f5' }}
              contentContainerStyle={s.birthBody}
              keyboardShouldPersistTaps="handled"
            >
              <PaipanForm
                /* ⚠⚠ 预填读的是 **`birth`（草稿优先）**，不是 `panel.rec`：
                   选完「确定」但不保存、再点开这一行时，表单必须停在上次选的那一刻；
                   读记录就会「回退」到旧时间，用户会以为自己白选了一遍。 */
                initial={{
                  gender: birth.gender,
                  date: birth.date,
                  time: birth.time,
                }}
                submitText="确定"
                hint="点「确定」只是选中新的出生时间，还要点底部「保存」才会按新时间重排"
                busy={false}
                onSubmit={onBirthCommit}
              />
            </ScrollView>
          </View>
        </Modal>
      ) : null}

      {/* ===== 一行轻提示 ===== */}
      {toast ? (
        <Pressable style={s.toast} onPress={() => showToast('')}>
          <Text style={s.toastText}>{toast}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
