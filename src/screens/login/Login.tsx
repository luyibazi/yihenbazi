/**
 * 登录 / 注册页（账号 + 密码）
 *
 * ============ 为什么是账号密码 ============
 * ① 微信登录那道资质门过不去（微信开放平台的「移动应用」登录能力只对企业 / 个体户开放）；
 * ② 短信登录**每条 50 资源点**，是网关调用（100 点/万次）的 5000 倍 ——
 *    免费额度只有 3000 点，换算下来 60 条短信就见了底，几十个用户必然超；
 * ③ 账号密码**完全不产生短信费**。
 *
 * ============ ⚠⚠ 注册入口是**有条件**显示的 ============
 * 当前后端是自建 paipan-server ⇒ 支持自助注册，所以有「去注册」。
 * 但 CloudBase 那条路**平台禁死**（实测 `/auth/v1/signup` 只带 {username,password}
 *   回 501 UNIMPLEMENTED）⇒ 那时**不能**显示注册入口，且底部要写明账号从哪来
 *   （用户找不到注册按钮会以为 App 坏了）。
 * ⇒ 由 `auth.canSignUp()` 决定，**不能**写死。见 canSignUp 变量。
 *
 * ============ 一个页面，两个面貌 ============
 * 「登录」和「注册」的字段几乎相同（注册多一个确认密码），
 * 拆成两个页面会让用户在两页之间跳来跳去 —— 同一个页面切形态更顺。
 * 形态相关的文案 / 校验 / 按钮脸都在 model.js + content.js 里，本文件只管画。
 *
 * ============ 「记住密码」这一格 ============
 * 打开本页时把上次登录成功的账号密码**填好**，用户点一下就能登回来
 * （被管理员强制下线、令牌过期之后就靠这个少打一遍）。
 *   · 存取在 `core/savedLogin.js`（纯 JS，见那边的文件头三条红线）；
 *   · 本页只干三件事：**初值**来自它、**登录成功**时写它、**勾选框**点一下告诉它；
 *   · ⚠⚠ **退出登录时不清它** —— 那正是用户要的（退出后账号密码还在，
 *     点一下登录就回来）。`auth.logout()` 只清登录凭证，碰不到这个键。
 *
 * ⚠ 本页是**推入层**（对应小程序 navigateTo），由 App.tsx 条件渲染 ——
 *   关掉即卸载，所以不用手动复位状态；但卸载时必须清掉「成功后延迟关闭」那个 timer。
 *   ⚠ 也正因为「关掉即卸载」，每次打开都会**重新**读一次记住的账号密码
 *     （`useState(() => savedLogin.load())` 的惰性初值只在挂载那一次求值）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import Screen from '../Screen';
import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS, RADII } from '../../theme/tokens';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const auth: any = require('../../core/auth.js');
const savedLogin: any = require('../../core/savedLogin.js');
const content: any = require('./content.js');

/** 登录 / 注册成功后停一拍再关页 —— 立刻关掉的话用户看不到「成功」，会怀疑到底成没成 */
const DONE_HOLD_MS = 700;

/**
 * ⚠ 后端是否支持自助注册 —— **模块级**求值一次即可：
 *   它读的是静态配置（storeMode.MODE），运行期不会变。
 *   放在组件里求值反而要担心重渲染时值不稳。
 */
const CAN_SIGNUP: boolean = (() => {
  try { return !!auth.canSignUp(); } catch (e) { return false; }
})();

export default function Login({
  onClose,
  onLoggedIn,
  /**
   * 键盘当前吃掉了多少高度（由根节点的 KeyboardAvoid 下发）。
   * ⚠⚠ 本页是**绝对定位的推入层**，不占 App 里那份 `s.stage` 的高度 ——
   *   所以避让得自己再减一次。别在页面里重新监听键盘：那是两份真相，必然漂。
   */
  eaten = 0,
}: {
  /** 关掉本页（返回 / 取消） */
  onClose: () => void;
  /** 登录 / 注册成功：上层据此关页 + 通知各 tab 刷新 */
  onLoggedIn: () => void;
  eaten?: number;
}) {
  const rpx = useRpx();

  /**
   * 上次登录成功的账号密码 + 勾选框状态，挂载时**只读一次**。
   *
   * ⚠ 用惰性初值（传函数给 useState）而不是直接求值：本页每敲一个字都会重渲染，
   *   写在渲染路径上等于每次按键都读一遍存储。
   * ⚠ 也不能提成模块级常量 —— 那样「退出登录 → 再打开登录页」拿到的还是
   *   进程第一次加载时的那份。本页是推入层（关掉即卸载），重开时该读到最新的。
   */
  const [boot] = useState(() => savedLogin.load());

  /* ⚠ 初始形态恒为「登录」：不确定用户是新人还是老用户时，默认他已有账号
     （老用户远多于第一次打开的人；新人点一下「去注册」即可） */
  const [mode, setMode] = useState<string>(model.MODE_LOGIN);
  const [username, setUsername] = useState(boot.username);
  const [password, setPassword] = useState(boot.password);
  /** 「记住密码」勾选框（默认勾上 —— 没记过时 savedLogin.load() 给的也是 true） */
  const [remember, setRemember] = useState(boot.remember);
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const closeTimer = useRef<any>(null);
  /** 密码框引用：在账号框按「下一步」时把焦点递过去，「输完账号顺手往下」 */
  const pwdRef = useRef<any>(null);
  /** 确认密码框引用：在密码框按「下一步」时递过去（只在注册态用） */
  const confirmRef = useRef<any>(null);

  const isSignup = mode === model.MODE_SIGNUP;

  /** 卸载时清掉「成功后延迟关闭」的 timer（清不掉会在已卸载的组件上 setState） */
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  /* ---------------- 交互 ---------------- */

  const clearMsg = useCallback(() => {
    setError('');
    setNotice('');
  }, []);

  /**
   * 改账号。
   * ⚠ 改动即清掉上一次的错误 —— 不然用户改完看到「用户名或密码不对」还挂着，
   *   会以为改了也没用（其实只是提示没跟着刷新）。
   * ⚠ 用 `username` 遮住 state 名（参数也叫 username，重名会让闭包拿到旧的）
   */
  const onUsernameChange = useCallback((v: string) => {
    setUsername(model.usernameInput(v));
    clearMsg();
  }, [clearMsg]);

  /**
   * 改密码。
   * ⚠ 清洗走 model.passwordInput —— 它**只限长**，不 trim 不改大小写。
   *   密码是逐字有效的，顺手 trim 会让「结尾带空格的真密码」永远登不上。
   */
  const onPasswordChange = useCallback((v: string) => {
    setPassword(model.passwordInput(v));
    clearMsg();
  }, [clearMsg]);

  /** 改确认密码（只注册态有）。同样只限长 */
  const onConfirmChange = useCallback((v: string) => {
    setConfirm(model.passwordInput(v));
    clearMsg();
  }, [clearMsg]);

  /**
   * 点「记住密码」。
   *
   * ⚠ 关掉时**立刻**让存储忘掉密码（`savedLogin.setRemember` 负责擦掉），
   *   不是等下次登录成功才生效 —— 「不记住」按下就该算数，
   *   否则这段时间里密码还躺在手机上，而界面已经告诉他不记了。
   * ⚠ 输入框里的字**一个字都不动**：他刚打的密码还在，这次登录照样能用。
   *   改的是「以后还记不记得」，不是「这一次算不算数」。
   * ⚠ 完成态（正在关页）时不让点，与各输入框的 `editable={!done}` 同一纪律。
   */
  const onToggleRemember = useCallback(() => {
    if (done) return;
    const next = !remember;
    setRemember(next);
    savedLogin.setRemember(next);
  }, [remember, done]);

  /**
   * 切换登录 / 注册。
   * ⚠ 必须把上一个形态的**错误提示和密码**清掉（见 model.switchState 的注释）——
   *   不然用户会以为刚点的这次切换「失败了」。
   *   账号名刻意留着：那个多半是对的。
   */
  const onSwitch = useCallback(() => {
    const next = isSignup ? model.MODE_LOGIN : model.MODE_SIGNUP;
    const st = model.switchState(next);
    setMode(st.mode);
    setPassword(st.password);
    setConfirm(st.confirm);
    setSubmitting(st.submitting);
    setDone(st.done);
    setError(st.error);
    setNotice(st.notice);
  }, [isSignup]);

  /** 提交（登录或注册，按当前形态分流） */
  const onSubmit = useCallback(() => {
    const st = model.submitStateOf({ mode, username, password, confirm, submitting, done });
    if (st.disabled) return;
    setSubmitting(true);
    clearMsg();

    const call = isSignup
      ? auth.signUpWithPassword(username, password)
      : auth.signInWithPassword(username, password);

    call.then((res: any) => {
      const r = model.resultOf(res, mode);
      if (!r.ok) {
        setSubmitting(false);
        setError(r.error);
        return;
      }
      setSubmitting(false);
      setDone(true);
      /**
       * ⚠⚠ **唯一**的写入口，且必须在 `r.ok` 之后 —— 见 core/savedLogin.js 红线二：
       *   边输边存会把打错的密码记下来，下次点登录直接撞「用户名或密码不对」，
       *   而用户确信自己什么都没改过（输入框里的字是上次留下的）。
       * ⚠ 传的是 state 里**清洗过**的值（账号已归一化成小写），不是输入框原始文本。
       * ⚠ 未勾选时 core 那边会把密码擦成空串 —— 这里照样传，规则只有一处。
       * ⚠ 注册态也走这条：注册成功即是登录态，此时记住它下次才不用重打。
       */
      savedLogin.save({ username, password, remember });
      setNotice(isSignup ? content.SUBMIT_SIGNUP_DONE : content.SUBMIT_DONE);
      closeTimer.current = setTimeout(() => {
        onLoggedIn();
      }, DONE_HOLD_MS);
    }).catch((err: any) => {
      // SDK 承诺永不 reject，这里只是兜底：卡在「提交中」比报个错更糟
      setSubmitting(false);
      setError((err && err.message) ||
        (isSignup ? content.SIGNUP_FAIL : content.LOGIN_FAIL));
    });
  }, [mode, isSignup, username, password, confirm, remember, submitting, done, onLoggedIn, clearMsg]);

  /* ---------------- 样式 ---------------- */

  const s = useMemo(() => StyleSheet.create({
    /**
     * ⚠ 页面自己的壳：flex:1。
     *   避让靠根节点下发的 `paddingBottom`（见下面的注释），这里不给任何键盘逻辑 ——
     *   页面自己再监听一次键盘就是两份真相，必然漂。
     */
    wrap: { flex: 1 },
    head: { paddingTop: rpx(36), paddingBottom: rpx(30), paddingHorizontal: rpx(8) },
    headTitle: {
      fontSize: rpx(38),
      fontWeight: FONT_WEIGHTS.semibold,
      color: COLORS.text,
      marginBottom: rpx(14),
    },
    headSub: {
      fontSize: rpx(25),
      lineHeight: rpx(25 * LINE_HEIGHTS.loose),
      color: COLORS.textMuted,
    },

    /* ⚠ 行是通栏排的，左右内边距给在卡上（与设置页同一套做法）——
       分割线才会被包在卡里，不至于顶到卡边 */
    card: {
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.card),
      paddingHorizontal: rpx(32),
      marginBottom: rpx(24),
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: rpx(22),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: COLORS.borderLight,
    },
    rowLast: { borderBottomWidth: 0 },
    label: { width: rpx(120), color: COLORS.text, fontSize: rpx(28) },
    input: {
      flex: 1,
      minWidth: 0,
      fontSize: rpx(30),
      color: COLORS.text,
      // ⚠ 定高：不然 Android 上输入框会随字体度量抖动，整行跟着跳
      height: rpx(56),
      padding: 0,
    },

    /* 字段级的实时提示（贴在对应行下面，克制一点，别抢主提示的视觉） */
    fieldHint: {
      paddingHorizontal: rpx(8),
      paddingBottom: rpx(16),
      marginTop: -rpx(6),
    },
    fieldHintText: { fontSize: rpx(23), lineHeight: rpx(23 * LINE_HEIGHTS.normal), color: COLORS.textGhost },

    /* 一行提示：出错红、成功金 */
    msg: { paddingHorizontal: rpx(8), marginBottom: rpx(14) },
    msgText: { fontSize: rpx(25), lineHeight: rpx(25 * LINE_HEIGHTS.normal) },
    msgErr: { color: '#c85a54' },
    msgOk: { color: COLORS.gold },

    /* 「记住密码」——
       ⚠ 靠左（alignSelf），不要跟着表单居中：它是个开关，不是一句说明。
       ⚠ 点区按最小 40pt 给（32 的方框 + 上下各 6 的 padding），
         指头点得中，也不至于把下面主按钮挤下去。 */
    rememberRow: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      paddingHorizontal: rpx(8),
      paddingVertical: rpx(10),
      marginTop: -rpx(8),
      marginBottom: rpx(18),
    },
    box: {
      width: rpx(32),
      height: rpx(32),
      borderRadius: rpx(6),
      borderWidth: 1,
      borderColor: COLORS.border,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: rpx(14),
    },
    /* 选中：金底金边（与主按钮同色系）。那个 ✓ 用 bg 白，压在金底上才看得清 */
    boxOn: { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
    tick: {
      color: COLORS.bg,
      fontSize: rpx(20),
      lineHeight: rpx(24),
      fontWeight: FONT_WEIGHTS.semibold,
    },
    rememberText: { fontSize: rpx(25), color: COLORS.textMuted },
    /* 完成态（正在关页）变灰，与「去注册」那颗的 switchTextOff 同一处理 */
    rememberTextOff: { color: COLORS.textGhost },

    submit: {
      height: rpx(88),
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: rpx(RADII.btn),
      backgroundColor: COLORS.gold,
    },
    submitOff: { backgroundColor: '#e8e2d8' },
    submitText: { fontSize: rpx(30), lineHeight: rpx(88), color: COLORS.bg },
    submitTextOff: { color: '#b9b2a6' },

    /* 「去注册 / 去登录」—— 必须**可点**且看得出可点（用金色，与主按钮同色系） */
    switchRow: {
      marginTop: rpx(20),
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: rpx(8),
    },
    switchText: { fontSize: rpx(25), lineHeight: rpx(25 * LINE_HEIGHTS.normal), color: COLORS.gold },
    /* ⚠ 完成态不再让人点切换（正在关页了），用一个安静的灰 */
    switchTextOff: { color: '#c9c2b6' },

    tip: {
      marginTop: rpx(18),
      textAlign: 'center',
      fontSize: rpx(23),
      lineHeight: rpx(23 * LINE_HEIGHTS.normal),
      color: COLORS.textGhost,
    },
    footer: {
      marginTop: rpx(6),
      textAlign: 'center',
      fontSize: rpx(22),
      color: COLORS.textGhost,
    },
  }), [rpx]);

  const submit = model.submitStateOf({ mode, username, password, confirm, submitting, done });
  /** 字段级的实时提示；有服务端结果时让位给它（同屏两条提示太吵） */
  const fieldHintUsername = (error || notice) ? '' : model.usernameHint(username);
  const fieldHintPassword = (error || notice) ? '' : model.passwordHint(mode, password, confirm);
  const msg = error || notice;

  return (
    /* ⚠⚠ 这里**不再**自己套 KeyboardAvoidingView：避让由根节点统一做
       （components/KeyboardAvoid），本页只是绝对定位的推入层，
       所以只需把「键盘吃掉多少」再减一次自己的高度。
       ⚠ 两层都避让 = 双重上移，小屏上表单会被顶出屏幕顶。 */
    <View style={[s.wrap, { paddingBottom: eaten }]}>
      <Screen>
        <View style={s.head}>
          <Text style={s.headTitle}>
            {isSignup ? content.HEAD_TITLE_SIGNUP : content.HEAD_TITLE}
          </Text>
          <Text style={s.headSub}>
            {isSignup ? content.HEAD_SUB_SIGNUP : content.HEAD_SUB}
          </Text>
        </View>

        <View style={s.card}>
          <View style={[s.row, (fieldHintUsername || isSignup || fieldHintPassword) ? null : s.rowLast]}>
            <Text style={s.label}>{content.USERNAME_LABEL}</Text>
            <TextInput
              style={s.input}
              value={username}
              onChangeText={onUsernameChange}
              placeholder={isSignup ? content.USERNAME_PLACEHOLDER_SIGNUP : content.USERNAME_PLACEHOLDER}
              placeholderTextColor="#c8c8c8"
              /* ⚠ 关掉自动大写与自动纠正：账号是小写的，iOS 默认会把首字母大写，
                 用户看着输入框里冒出大写字母会以为填错了 */
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              maxLength={model.INPUT_MAX}
              editable={!done}
              returnKeyType="next"
              onSubmitEditing={() => {
                if (pwdRef.current && pwdRef.current.focus) pwdRef.current.focus();
              }}
            />
          </View>

          {fieldHintUsername ? (
            <View style={s.fieldHint}>
              <Text style={s.fieldHintText}>{fieldHintUsername}</Text>
            </View>
          ) : null}

          {/* ⚠ 密码是最后一行**只在登录态**（注册态下面还有确认框） */}
          <View style={[s.row, (isSignup || fieldHintPassword) ? null : s.rowLast]}>
            <Text style={s.label}>{content.PASSWORD_LABEL}</Text>
            <TextInput
              ref={pwdRef}
              style={s.input}
              value={password}
              onChangeText={onPasswordChange}
              placeholder={isSignup ? content.PASSWORD_PLACEHOLDER_SIGNUP : content.PASSWORD_PLACEHOLDER}
              placeholderTextColor="#c8c8c8"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType={isSignup ? 'newPassword' : 'password'}
              maxLength={model.INPUT_MAX}
              editable={!done}
              /* ⚠ 注册态这里不是最后一项 ⇒ 回车该去确认框，而不是直接提交
                 （密码只输了一遍就提交，是手滑打错最常见的那一刻） */
              returnKeyType={isSignup ? 'next' : 'done'}
              onSubmitEditing={() => {
                if (isSignup) {
                  if (confirmRef.current && confirmRef.current.focus) confirmRef.current.focus();
                } else {
                  onSubmit();
                }
              }}
            />
          </View>

          {fieldHintPassword ? (
            <View style={s.fieldHint}>
              <Text style={s.fieldHintText}>{fieldHintPassword}</Text>
            </View>
          ) : null}

          {/* 确认密码 —— 只在注册态 */}
          {isSignup ? (
            <View style={[s.row, s.rowLast]}>
              <Text style={s.label}>{content.CONFIRM_LABEL}</Text>
              <TextInput
                ref={confirmRef}
                style={s.input}
                value={confirm}
                onChangeText={onConfirmChange}
                placeholder={content.CONFIRM_PLACEHOLDER}
                placeholderTextColor="#c8c8c8"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                maxLength={model.INPUT_MAX}
                editable={!done}
                returnKeyType="done"
                onSubmitEditing={onSubmit}
              />
            </View>
          ) : null}
        </View>

        {msg ? (
          <View style={s.msg}>
            <Text style={[s.msgText, error ? s.msgErr : s.msgOk]}>{msg}</Text>
          </View>
        ) : null}

        {/* 「记住密码」——
            ⚠ 位置：**卡外、主按钮正上方**。它是「这次登录的选项」，
              不是第三个输入项（塞进卡里会和「账号 / 密码」看起来同级）；
              也不放在错误提示上面 —— 出错时那句提示要贴着它说的那个表单。
            ⚠ 两个形态（登录 / 注册）都显示，理由见 content.REMEMBER_LABEL。
            ⚠ 自己画（View + ✓）而不是用 RN 的 Switch：全站只有这一处要开关，
              为它引一个控件类不划算；也不用 pressed 态 —— 点一下就翻面，
              翻面本身就是即时反馈。 */}
        <Pressable
          style={s.rememberRow}
          onPress={onToggleRemember}
          disabled={done}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: remember }}
          accessibilityLabel={content.REMEMBER_LABEL}
        >
          <View style={[s.box, remember ? s.boxOn : null]}>
            {remember ? <Text style={s.tick}>✓</Text> : null}
          </View>
          <Text style={[s.rememberText, done ? s.rememberTextOff : null]}>
            {content.REMEMBER_LABEL}
          </Text>
        </Pressable>

        <Pressable
          style={[s.submit, submit.disabled ? s.submitOff : null]}
          onPress={onSubmit}
          disabled={submit.disabled}
          accessibilityRole="button"
        >
          <Text style={[s.submitText, submit.disabled ? s.submitTextOff : null]}>
            {submit.label}
          </Text>
        </Pressable>

        {/* ⚠ 切换入口：只在**后端支持注册**时显示（CloudBase 那条路平台禁死）。
            提交中 / 已完成时也不让点 —— 那时正在关页，点了会切走又立刻被关掉，很怪。 */}
        {CAN_SIGNUP ? (
          <Pressable
            style={s.switchRow}
            onPress={onSwitch}
            disabled={submitting || done}
            accessibilityRole="button"
          >
            <Text style={[s.switchText, (submitting || done) ? s.switchTextOff : null]}>
              {isSignup ? content.TO_LOGIN_TIP : content.TO_SIGNUP_TIP}
            </Text>
          </Pressable>
        ) : (
          /* ⚠ 不能自助注册时，**必须**告诉用户账号从哪来（否则他会以为 App 坏了） */
          <Text style={s.tip}>{content.NO_SIGNUP_TIP}</Text>
        )}

        <Text style={s.footer}>{content.FOOTER}</Text>
      </Screen>
    </View>
  );
}
