/**
 * 设置页（tab 3）—— 从 paipan/pages/settings/ 搬过来
 *
 * 现在只有**一张设置卡**（账号 / 退出登录 / 版本）+ 页脚。
 * 文案在 content.js 里（可断言），本文件只管画与那两个交互。
 *
 * ⚠⚠ 2026-10-21 用户要求「设置页面这些东西很多余」⇒ 删掉：
 *   三张说明卡（排盘引擎 / 晚子时 / 数据与隐私）、「清除本机缓存」、「开源组件」，
 *   以及「无限滚动（仿制）」那个临时入口（连 `screens/demo/InfiniteTop.tsx` 整个页面）。
 *   ⇒ 所以下面**没有** NOTES 渲染块、没有 onClearCache、没有 demo 入口。
 *
 * ============ ⚠⚠ 账号那一区 ============
 * 后端换到 CloudBase 后，登录态从「本机设备码」变成了**服务端签发的账号**，
 * 于是设置页必须有两个入口：
 *   · 未登录 → 「登录」（点了开登录页）
 *   · 已登录 → 显示账号名 + 「退出登录」
 *
 * ⚠ 2026-10-02 起登录方式从「手机号 + 短信验证码」换成了**账号 + 密码**
 *   （短信每条 50 资源点，是网关调用的 5000 倍；账号密码零短信费）。
 *   ⇒ 这里展示的也从「掩码手机号」变成了**账号名**。
 *   ⚠ 账号名是小写字母数字 `-` `_`、6~25 位，长度可控且不含隐私 ⇒ **不需要掩码**。
 *
 * ⚠⚠ 本页是**常驻挂载**的（四个 tab 靠 display 切，不卸载），登录态变了它不会自己知道 ——
 *   所以靠 App 传下来的 `sessionRev` 当信号：它一变，这里重新读一次登录态。
 *   这就是「常驻页面」这类设计的固有代价：所有外部状态都得有显式的失效信号。
 *
 * ⚠ App 里**没有任何删除记录的入口**了（用户 2026-10-01 要求把记录页的
 *   「删除」与「清空全部记录」一并移除）。要动云端数据只能去云端控制台直接改。
 *
 * ⚠ 「退出登录」只清**登录凭证**，不清设备码、更不碰云端数据 ——
 *   清了设备码下次会生成新的（CloudBase 下不影响 uid，但服务端的登录设备统计会失真）。
 * ⚠ 但它会**先**告诉服务端一声「我走了」（presence.bye），好让管理端立刻显示离线 ——
 *   顺序不能换，理由见 onLogout。这一句是尽力而为的，失败不拦着用户登出。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import Screen from '../Screen';
import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS, RADII, SIZES } from '../../theme/tokens';

const content: any = require('./content.js');
const auth: any = require('../../core/auth.js');
/** 退出登录时要顺口告诉服务端一声「我走了」（后台立刻显示离线），见 onLogout */
const presence: any = require('../../core/presence.js');
/** 服务器地址（运行时覆盖值）—— 只对自建后端有意义，见下面 serverRow */
const serverAddr: any = require('../../core/serverAddr.js');
const storeMode: any = require('../../core/storeMode.js');

/** 设置卡里一行的三种取值风格 */
type RowTone = 'chevron' | 'dark' | 'gold';
type Row = { id: string; label: string; value: string; tone: RowTone; onPress?: () => void };

/** 行里只显示「主机 + 端口」，去掉 scheme —— 一行放不下整条 URL，而 scheme 千篇一律 */
function prettyUrl(u: string): string {
  const s = String(u || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return s || '未设置';
}

/**
 * **本页自绘的确认框**内容（`null` = 不显示）。
 *
 * ⚠⚠⚠ 为什么不用 `Alert.alert`（2026-10-14 做网页版时改的）：
 *   `Alert` 是**原生**弹窗，而 `react-native-web` 里那个 `Alert` 是
 *   **一个空壳** —— 整个类就是 `class Alert { static alert() {} }`
 *   （见 `node_modules/react-native-web/dist/exports/Alert/index.js`）。
 *   在网页上它的表现是：**弹窗不出现、回调永不执行、控制台也一声不吭**
 *   ⇒「清除本机缓存」和「退出登录」这两个入口会直接变成**死键**。
 *   ⇒ 改成自绘（遮罩 + 卡片 + 两个按钮）：三端一套代码，原生上照样正常。
 *
 * ⚠ 与 `Notice` 分工不同，别混：`Notice` 是**不挡手、自己会消失**的提示条；
 *   这里要的是**必须由用户选**的二次确认（不选不动手）。
 */
type Ask = {
  title: string;
  body: string;
  /** 确认按钮的文案（取消按钮恒为「取消」） */
  ok: string;
  onOk: () => void;
};

export default function Settings({
  sessionRev,
  onOpenLogin,
  onSessionChanged,
}: {
  /** 登录态版本号（登录成功 / 退出登录各 +1）—— 变了就重读登录态 */
  sessionRev: number;
  /** 开登录页 */
  onOpenLogin: () => void;
  /** 登录态变了（本页退出登录后通知上层：清 boot 结论 + 各 tab 刷新） */
  onSessionChanged: () => void;
}) {
  const rpx = useRpx();

  /**
   * 确认框（**本页自绘**，理由见 `Ask` 的注释：`Alert` 在网页上是个空壳）。
   * ⚠ 状态只有「当前要问什么」，没有「在不在显示」这种第二份真相
   *   —— `ask === null` 就是不显示。
   */
  const [ask, setAsk] = useState<Ask | null>(null);

  /**
   * 服务器地址编辑框（`null` = 不显示，`string` = 正在编辑的草稿）。
   *
   * ⚠ 草稿与「当前生效值」是**两份**：输入过程中不能改生效值，
   *   否则敲到一半地址就变了，中间那几个字符会让所有请求打到不存在的域名上。
   */
  const [addrDraft, setAddrDraft] = useState<string | null>(null);

  /** 当前生效的服务器地址（每次渲染现取：它活在模块内存里，不是 React state；保存时靠 setAddrDraft 触发重渲染） */
  const effectiveUrl = serverAddr.current();
  const addrChanged = serverAddr.isOverridden();
  /** 草稿非空且没写协议头 ⇒ 明显是错的，先拦下来（空 = 恢复默认，合法） */
  const addrBad = addrDraft !== null && !!addrDraft.trim() && !/^https?:\/\//i.test(addrDraft.trim());

  /**
   * 当前账号。
   *
   * ⚠ 依赖 sessionRev：本页常驻（四个 tab 靠 display 切、不卸载），
   *   登录态变了这里不会自己知道 —— 不重读的话「登录成功后回到设置页」
   *   还显示着「登录」入口。sessionRev 就是那个显式信号。
   * ⚠ 依赖数组里写 sessionRev 而不是 auth：auth.isLoggedIn() 是**同步读 storage**
   *   的普通函数（不是 hook），没有它自己的依赖可追踪 —— 只有这个计数器能当信号。
   */
  const account = useMemo(() => ({
    logged: auth.isLoggedIn(),
    username: auth.loginUsername(),
  }), [sessionRev]);

  /**
   * 退出登录：二次确认 → **先告诉服务端我走了** → 清凭证 → 通知上层。
   *
   * ⚠⚠ 顺序不能换：`auth.logout()` 会把本地凭证清掉，清掉之后
   *   「我走了」这句话就没有令牌可带，只能静默跳过 ——
   *   服务端那边要等 60 秒窗口过期才显示离线（灯一直亮着）。
   * ⚠ 这一句是**尽力而为、发出去就不管**（presence.bye 永不 reject）：
   *   后端没开、断网都不该拦住用户退出登录。
   */
  const onLogout = useCallback(() => {
    setAsk({
      title: content.LOGOUT_TITLE,
      body: content.LOGOUT_BODY,
      ok: '退出',
      onOk: () => {
        presence.bye();
        auth.logout();
        onSessionChanged();
      },
    });
  }, [onSessionChanged]);

  /**
   * 设置卡里的行（顺序即渲染顺序）。
   * ⚠ 每行都带 tone：'chevron' = 可点的 ›，'dark' = 深色只读值，'gold' = 金色动作字。
   */
  const rows = useMemo(() => {
    const out: Row[] = [];
    if (account.logged) {
      out.push({ id: 'account', label: content.ACCOUNT_LABEL, value: account.username, tone: 'dark' });
      out.push({ id: 'logout', label: content.LOGGED_ACTION, value: '›', tone: 'chevron', onPress: onLogout });
    } else {
      out.push({ id: 'login', label: content.LOGIN_LABEL, value: content.LOGIN_ACTION, tone: 'gold', onPress: onOpenLogin });
    }
    /* ⚠ 2026-10-21 起这里只有账号那一行 + 版本行：「清除本机缓存」「开源组件」
       「无限滚动（仿制）」全部按用户要求删除（见文件头）。别再往里加。 */
    /*
     * 服务器地址 —— 2026-11-13 加。
     * ⚠ 为什么这行不属于「多余」那批（2026-10-21 删掉的那些说明卡）：
     *   它不是解释文案，是**唯一的入口** —— 地址从编译期常量挪到了运行时，
     *   手机上不填就只能用包里那个默认值（公网隧道地址每次重启都会变）。
     * ⚠ 只在自建后端（local）下显示：别的 MODE 走的是另一套地址体系。
     */
    if (storeMode.MODE === 'local') {
      out.push({
        id: 'server',
        label: content.SERVER_LABEL,
        value: prettyUrl(effectiveUrl) + (addrChanged ? '（已改）' : ''),
        tone: 'chevron',
        onPress: () => setAddrDraft(effectiveUrl),
      });
    }
    content.INFO_ROWS.forEach((r: any) => {
      out.push({ id: r.id, label: r.label, value: r.value, tone: 'dark' });
    });
    return out;
  }, [account, onLogout, onOpenLogin, effectiveUrl, addrChanged]);

  /** 保存地址：**先**推给 storeMode（立刻生效）→ 落盘 → 通知上层重新拉数据 */
  const onSaveAddr = useCallback(() => {
    const v = addrDraft == null ? '' : addrDraft;
    if (v.trim() && !/^https?:\/\//i.test(v.trim())) return;   // 非法输入不许保存（按钮已置灰）
    serverAddr.save(v);
    setAddrDraft(null);
    /* ⚠ 换服务器 = 换了一个数据源（连登录态都是别处签的）：必须让各 tab 重新拉一遍，
       否则记录页还挂着上一台服务器的列表。onSessionChanged 就是那个信号。 */
    onSessionChanged();
  }, [addrDraft, onSessionChanged]);

  const s = useMemo(() => StyleSheet.create({
    card: {
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.card),
      marginBottom: rpx(SIZES.cardGap),
    },
    /* ⚠ 说明卡（noteCard / noteTitle / noteBody）2026-10-21 随三张说明卡一起删了，
       别再补回来 —— 现在整页只有下面这张设置卡。 */
    /* ⚠ 行是通栏排的，左右内边距给在卡上（32rpx），
       行只保留纵向 padding；否则行内的分割线会顶到卡边、看着像没包进去 */
    settingCard: { paddingHorizontal: rpx(32) },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: rpx(28),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.borderLight,
    },
    rowLast: { borderBottomWidth: 0 },
    rowLabel: { color: COLORS.text, fontSize: rpx(28) },
    rowValue: { color: COLORS.textFaint, fontSize: rpx(28), textAlign: 'right' },
    rowValueDark: { color: COLORS.text, fontSize: rpx(28), textAlign: 'right' },
    rowValueGold: { color: COLORS.gold, fontSize: rpx(28), textAlign: 'right' },
    footer: {
      textAlign: 'center',
      fontSize: rpx(22),
      color: COLORS.textGhost,
      marginTop: rpx(6),
    },
    /* ---- 自绘确认框（见 `Ask` 的注释）----
       ⚠ 遮罩用 `absoluteFillObject` 铺满**整个页面**（它的父级是 return 里那层
         `flex:1` 的 View）—— 不能放进 `Screen`：那里头是个 ScrollView，
         遮罩会跟着内容一起滚。 */
    askMask: {
      /* ⚠ 四边显式写 0，**不用** `StyleSheet.absoluteFillObject` ——
         本项目 RN 0.86 的类型里没有那个属性（tsc 会红），而 `absoluteFill`
         是个注册后的 id（数字），spread 出来是空对象、会静默失效。 */
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.35)',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: rpx(60),
    },
    askCard: {
      width: '100%',
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.card),
      paddingVertical: rpx(32),
      paddingHorizontal: rpx(32),
    },
    askTitle: {
      fontSize: rpx(30),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.text,
      marginBottom: rpx(12),
    },
    askBody: {
      fontSize: rpx(26),
      color: COLORS.textSub,
      lineHeight: rpx(26 * LINE_HEIGHTS.loose),
      marginBottom: rpx(26),
    },
    askRow: { flexDirection: 'row', justifyContent: 'flex-end' },
    /* ⚠ 按钮只给左内边距：两个按钮之间的间距由「右边那个的左内边距」撑出来，
       省掉一层 margin（与设置卡里那些行的做法一致，见 settingCard 的注释）。 */
    askBtn: { paddingVertical: rpx(12), paddingLeft: rpx(36) },
    askBtnText: { fontSize: rpx(28), color: COLORS.textMuted },
    askOkText: { color: COLORS.gold, fontWeight: FONT_WEIGHTS.semibold },
    /* ---- 服务器地址输入框 ---- */
    addrInput: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: COLORS.borderLight,
      borderRadius: rpx(8),
      paddingHorizontal: rpx(20),
      paddingVertical: rpx(20),
      fontSize: rpx(26),
      color: COLORS.text,
      marginBottom: rpx(14),
    },
    addrInputBad: { borderColor: COLORS.gold },
    addrNow: { fontSize: rpx(22), color: COLORS.textGhost, marginBottom: rpx(20) },
    addrErr: { fontSize: rpx(22), color: COLORS.gold, marginTop: rpx(-6), marginBottom: rpx(16) },
  }), [rpx]);

  const toneStyle = (tone: RowTone) => (
    tone === 'dark' ? s.rowValueDark : tone === 'gold' ? s.rowValueGold : s.rowValue
  );

  return (
    /* ⚠ 外面这层 `flex: 1` 的 View 是**给确认框用的**（见 `Ask` 的注释）：
       `Screen` 里面是个 ScrollView，确认层塞进去会跟着内容一起滚
       ⇒ 它必须是 `Screen` 的**兄弟**，并且有个铺满该页的定位父级。 */
    <View style={{ flex: 1 }}>
      <Screen>
        <View style={[s.card, s.settingCard]}>
          {rows.map((row, i) => {
            const style = [s.row, i === rows.length - 1 ? s.rowLast : null];
            const body = (
              <>
                <Text style={s.rowLabel}>{row.label}</Text>
                <Text style={toneStyle(row.tone)} numberOfLines={1}>{row.value}</Text>
              </>
            );
            // 可点的行用 Pressable，只读行用 View —— 只读行不该有按压反馈
            return row.onPress ? (
              <Pressable key={row.id} style={style} onPress={row.onPress}>{body}</Pressable>
            ) : (
              <View key={row.id} style={style}>{body}</View>
            );
          })}
        </View>

        <Text style={s.footer}>{content.FOOTER}</Text>
      </Screen>

      {ask ? (
        <View style={s.askMask}>
          <View style={s.askCard}>
            <Text style={s.askTitle}>{ask.title}</Text>
            <Text style={s.askBody}>{ask.body}</Text>
            <View style={s.askRow}>
              <Pressable style={s.askBtn} onPress={() => setAsk(null)}>
                <Text style={s.askBtnText}>取消</Text>
              </Pressable>
              <Pressable
                style={s.askBtn}
                onPress={() => {
                  /* ⚠ 先收起、再执行：回调里可能又会 setAsk（比如失败后要弹别的框），
                     顺序反了会被这次的 `setAsk(null)` 盖掉。 */
                  const fn = ask.onOk;
                  setAsk(null);
                  fn();
                }}
              >
                <Text style={[s.askBtnText, s.askOkText]}>{ask.ok}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* 服务器地址编辑（与确认框同一套遮罩 / 卡片样式，见 `Ask` 的注释） */}
      {addrDraft !== null ? (
        <View style={s.askMask}>
          <View style={s.askCard}>
            <Text style={s.askTitle}>{content.SERVER_TITLE}</Text>
            <Text style={s.askBody}>{content.SERVER_BODY}</Text>
            <TextInput
              value={addrDraft}
              onChangeText={setAddrDraft}
              placeholder={content.SERVER_PHONE}
              placeholderTextColor={COLORS.textGhost}
              style={[s.addrInput, addrBad ? s.addrInputBad : null]}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
              returnKeyType="done"
              onSubmitEditing={onSaveAddr}
            />
            <Text style={s.addrNow} numberOfLines={1}>当前：{effectiveUrl}</Text>
            {addrBad ? <Text style={s.addrErr}>地址要以 http:// 或 https:// 开头</Text> : null}
            <View style={s.askRow}>
              <Pressable style={s.askBtn} onPress={() => setAddrDraft(null)}>
                <Text style={s.askBtnText}>取消</Text>
              </Pressable>
              <Pressable style={s.askBtn} onPress={onSaveAddr} disabled={addrBad}>
                <Text style={[s.askBtnText, addrBad ? null : s.askOkText]}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
