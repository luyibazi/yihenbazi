/**
 * 排盘页（tab 1）—— 从 paipan/pages/paipan/ 搬过来
 *
 * ★ 2026-10-21：**表单本身已封装成 `components/PaipanForm.tsx`**（用户要求
 *   「排盘页面要封装，这就可以复用了」，用来给结果页详细信息里的「修改出生时间」复用）。
 *   本页只剩**页面级外壳**：
 *     · 公告条（可关）
 *     · 登录 / 云端状态那一行（截图中是「已登录 ｜ 云端已就绪」）
 *     · 表单卡（= PaipanForm：性别+历法 / 出生时间 / 农历提示 / 提交按钮）
 *   ⚠ 表单里的任何口径都**只写在 PaipanForm 里**（历法切换、四柱反查、真值永远是公历）——
 *     本页别再抄一份，抄一份就是两个口径。
 *
 * ⚠⚠ **本页不收姓名 / 描述**（用户要求：「排盘页面的描述输入去掉，输入姓名也去掉，
 *    只有点击保存到记录的时候才出现」）。理由也说得通：排盘只需要出生数据，
 *    先要名字等于给「看盘」这道纯计算多设一道没必要的卡。
 *    ⇒ 姓名 / 描述改在结果页点「保存到记录」时那个小窗里填（见 Result.tsx）。
 *
 * ============ 两条最要紧的约定 ============
 * ① **真值永远是公历** (`date` / `time`) —— 这条现在由 PaipanForm 保证（见那里的注释）。
 * ② 「开始排盘」的闸门不是「登录过」，而是**拿到此刻可用的用户标识**
 *    （`whoami({fresh:true})`）—— 因为记录要写进以 uid 命名的云端文件里，
 *    光有登录态没标识，排完盘也存不进去。
 *
 * ⚠ 传盘给结果页走**内存总线**（chartBus），不落 storage ——
 *   用户要求保存的数据一个字节都不能在本地。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import PaipanForm from '../../components/PaipanForm';
import Screen from '../Screen';
import { useRpx } from '../../theme/rpx';
import { COLORS } from '../../theme/tokens';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS */
const auth: any = require('../../core/auth.js');
const boot: any = require('../../core/boot.js');
const recordLib: any = require('../../core/record.js');
const chartBus: any = require('../../core/chartBus.js');

/**
 * ⚠ 登录态那一行有**三**种失败之外的结局，别混成一种（这是踩过的）：
 *   · fail   —— 真的登录失败了（网络 / 服务端），给「重试」
 *   · need   —— **还没登录**（新用户的正常起点），给「去登录」，**不给重试**
 *   · ok     —— 已登录
 *   把 need 显示成 fail + 重试，用户会一直点重试 —— 而重试一万次也不会好。
 */
type LineState = { state: 'idle' | 'pending' | 'ok' | 'fail' | 'need'; text: string };
type CloudState = { state: 'idle' | 'pending' | 'ok' | 'fail' | 'skip'; text: string };

export default function Paipan({
  active,
  sessionRev,
  onGoLogin,
  onLaunched,
}: {
  /** 当前这个 tab 是不是显示中 */
  active: boolean;
  /** 登录态版本号（登录成功 / 退出登录各 +1）—— 变了就重走一次登录确认 */
  sessionRev: number;
  /** 去登录（本页「未登录」时的出口） */
  onGoLogin: () => void;
  /** 排好盘了：把完整记录交给上层去切到结果页 */
  onLaunched: (rec: any) => void;
}) {
  const rpx = useRpx();

  const [banner, setBanner] = useState(true);
  const [login, setLogin] = useState<LineState>({ state: 'idle', text: '' });
  const [cloud, setCloud] = useState<CloudState>({ state: 'idle', text: '' });
  /* ⚠ 原来这里还有一个 `toast`（「开始排盘」被身份闸门拦下时说一句）——
     2026-10-21 起闸门直接开登录页，没有要说的了（见 onFormSubmit）。 */

  /** 登录态与 cloud 的最新值放 ref，供 onShow 判断（setState 异步） */
  const loginRef = useRef(login);
  loginRef.current = login;

  /* ---------------- 登录 ---------------- */

  /**
   * 走一次「静默登录 + 确认云端可访问」并把结果写进界面状态。
   * 实际动作都在 core/boot.js：它会登录，再确认这个用户的云端数据可访问。
   * 这样「打开应用」和「进本页」走的是同一条路径 —— App 启动时已发起过时，
   * 这里直接复用它那一份在飞的结果，不会重复登录、也不会重复请求云端。
   */
  const runLogin = useCallback((force: boolean) => {
    setLogin({ state: 'pending', text: '正在登录…' });
    return boot.ensureUser(false, {
      relogin: force,
      // 登录一成功就先亮登录态；云端那一步要走网络，单独显示进度
      onLogin: () => {
        setLogin({ state: 'ok', text: '已登录' });
        setCloud({ state: 'pending', text: '云端同步中…' });
      },
    }).then((res: any) => {
      if (!res.logged) {
        /**
         * ⚠⚠ 「还没登录」不是「登录失败」——
         *   新用户第一次打开 App 必然是这个状态。显示成失败 + 「重试」的话，
         *   用户会一直点重试，而重试一万次也不会好，他就是得先去登录。
         *   所以分成 need 态，出口是「去登录」。
         */
        if (res.needLogin) setLogin({ state: 'need', text: '未登录' });
        else setLogin({ state: 'fail', text: res.error || '登录失败' });
        setCloud({ state: 'idle', text: '' });
        return res;
      }
      setLogin({ state: 'ok', text: '已登录' });
      setCloud(model.cloudStateOf(res) as CloudState);
      return res;
    });
  }, []);

  /* ---------------- 生命周期：onLoad + onShow 合成一个 ---------------- */

  const inited = useRef(false);
  /** 上次生效的登录态版本号（用来识别「登录 / 退出发生过」） */
  const sessionSeen = useRef(sessionRev);
  useEffect(() => {
    if (!active) return;
    /**
     * ⚠ 登录态变过就要重走一次：本页常驻，`auth.isLoggedIn()` 从 false 变 true
     *   不会让 effect 自己重跑，界面会一直停在「未登录」。
     *   （在设置页登录 / 退出 → 切回排盘页，必须看到正确的状态。）
     */
    const sessionChanged = sessionSeen.current !== sessionRev;
    sessionSeen.current = sessionRev;

    // onLoad 的活只在第一次做
    if (!inited.current) {
      inited.current = true;
      runLogin(false);
      return;
    }
    // onShow：切回本页时登录态可能已过期或被清，这里补一次。正在登录中就不重复触发。
    if (sessionChanged || (!auth.isLoggedIn() && loginRef.current.state !== 'pending')) {
      runLogin(false);
    }
  }, [active, sessionRev, runLogin]);

  /* ---------------- 排盘 ---------------- */

  /**
   * 表单交了出生数据（`PaipanForm` 的 onSubmit）—— 这里只做「身份闸门 + 排盘」。
   *
   * ⚠ 姓名 / 描述一律传空：排盘页不再收这两项，它们由结果页「保存到记录」时的小窗去填。
   *   `record.hydrate` 会把空名兜成「未命名」（record.js），描述为空则被 `optionals` 摘掉。
   *
   * ⚠⚠ 2026-10-21 用户要求：**未登录时点「开始排盘」直接开登录页**（原来只在原地弹一句
   *   「登录后才能排盘」，用户还得自己去找登录入口 —— 那句提示本身就是多余的中间步骤）。
   *   所以闸门拦下时**不发提示、直接 `onGoLogin()`**。
   *   ⚠ 表单内容不会丢：本页是常驻的，返回后 PaipanForm 里的日期时间原样还在，
   *     登录完再点一次就排出来了。
   */
  const onFormSubmit = useCallback((v: { gender: number; date: string; time: string }) => {
    // 等的不是「登录成功」，而是**拿到可用的用户标识**（fresh 拿此刻真实有效的那个）
    boot.whoami({ fresh: true }).then((who: any) => {
      const gate = model.gateOnIdentity(who);
      if (!gate.ok) {
        onGoLogin();
        return;
      }
      const rec = recordLib.create('', v.gender, v.date, v.time, '');
      // ⚠ 走内存总线，不落 storage
      chartBus.put(rec);
      onLaunched(rec);
    });
  }, [onGoLogin, onLaunched]);

  /* ---------------- 重试 ---------------- */

  const onRetryLogin = useCallback(() => { runLogin(true); }, [runLogin]);

  const onRetryCloud = useCallback(() => {
    setCloud({ state: 'pending', text: '云端同步中…' });
    // force = 忽略本地记忆，真的去云端核对一次（登录仍复用现有登录态）
    boot.ensureUser(true).then((res: any) => setCloud(model.cloudStateOf(res) as CloudState));
  }, []);

  /* ---------------- 样式 ---------------- */

  const s = useMemoStyle(rpx);

  /** 登录行的小圆点颜色按状态分 */
  const dotColor = login.state === 'ok' ? COLORS.gold
    : login.state === 'fail' ? '#c85a54' : '#d8d8d8';
  const cloudColor = cloud.state === 'fail' ? '#c85a54'
    : cloud.state === 'ok' ? '#b6a184' : '#c4bdb2';

  return (
    <Screen>
      {/* 公告条 */}
      {banner ? (
        <View style={s.banner}>
          <View style={s.bannerBadge}><Text style={s.bannerBadgeText}>告</Text></View>
          <Text style={s.bannerText}>八字排盘学习工具，结果仅供传统文化参考</Text>
          <Pressable style={s.bannerClose} onPress={() => setBanner(false)}>
            <Text style={s.bannerCloseText}>×</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 登录态 + 云端态 */}
      {login.state !== 'idle' ? (
        <View style={s.loginLine}>
          <View style={[s.loginDot, { backgroundColor: dotColor }]} />
          <Text style={[s.loginText, login.state === 'fail' ? { color: '#c85a54' } : null]}>
            {login.text}
          </Text>
          {/* ⚠ 两个出口分开：真失败才给「重试」，「未登录」给「去登录」 */}
          {login.state === 'fail' ? (
            <Pressable onPress={onRetryLogin}>
              <Text style={s.loginRetry}>重试</Text>
            </Pressable>
          ) : null}
          {login.state === 'need' ? (
            <Pressable onPress={onGoLogin}>
              <Text style={s.loginRetry}>去登录</Text>
            </Pressable>
          ) : null}
          {cloud.state === 'fail' ? (
            <Pressable onPress={onRetryCloud}>
              <Text style={[s.cloudText, { color: cloudColor }]}>{cloud.text + ' · 重试'}</Text>
            </Pressable>
          ) : cloud.text ? (
            <Text style={[s.cloudText, { color: cloudColor }]}>{cloud.text}</Text>
          ) : null}
        </View>
      ) : null}

      {/* 表单卡（= 封装件；排盘口径全在里面） */}
      <PaipanForm onSubmit={onFormSubmit} submitText="开始排盘" />
    </Screen>
  );
}

/* ---------------- 样式（页面外壳那几块） ---------------- */

/** ⚠ 单独抽出来只为让上面的组件体读起来短一点；`rpx` 变了才重建 */
function useMemoStyle(rpx: (n: number) => number) {
  return React.useMemo(() => StyleSheet.create({
    banner: {
      backgroundColor: COLORS.bg,
      borderRadius: rpx(20),
      paddingVertical: rpx(20),
      paddingHorizontal: rpx(24),
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: rpx(24),
    },
    bannerBadge: {
      width: rpx(44), height: rpx(44), borderRadius: rpx(22),
      backgroundColor: '#f0e9dc',
      alignItems: 'center', justifyContent: 'center',
      marginRight: rpx(16),
    },
    bannerBadgeText: { color: COLORS.gold, fontSize: rpx(22) },
    bannerText: { flex: 1, minWidth: 0, fontSize: rpx(24), color: '#8a7a5c' },
    bannerClose: {
      width: rpx(44), height: rpx(44),
      alignItems: 'center', justifyContent: 'center',
    },
    bannerCloseText: { color: COLORS.textGhost, fontSize: rpx(36), lineHeight: rpx(40) },

    loginLine: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: rpx(12),
      paddingBottom: rpx(16),
    },
    loginDot: {
      width: rpx(12), height: rpx(12), borderRadius: rpx(6),
      backgroundColor: '#d8d8d8', marginRight: rpx(10),
    },
    loginText: { fontSize: rpx(22), color: COLORS.textFaint },
    loginRetry: { marginLeft: rpx(16), color: COLORS.gold, fontSize: rpx(22) },
    cloudText: {
      marginLeft: rpx(14), paddingLeft: rpx(14),
      borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#e6e0d4',
      fontSize: rpx(20), color: '#c4bdb2',
    },
  }), [rpx]);
}
