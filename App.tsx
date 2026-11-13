/**
 * 八字排盘 App —— 壳
 *
 * 结构与小程序一一对应：
 *   · 四个 tab Screen **常驻挂载**、靠 display 切（对应 app.json 的 tabBar 四页）——
 *     卸载会丢 ChartView 的选中态与 Records 的同步版本号，绝不条件渲染；
 *   · 结果页是**推入层**（对应 tt.navigateTo）：盖在四个 tab 之上（绝对定位全屏），
 *     关掉 = pop。它不在 tab 里，四个 tab 的状态原封不动；
 *   · 传盘走内存总线（chartBus，本地一个字节都不留）。
 *
 * ============ 导航为什么不引 @react-navigation ============
 * 见 src/screens/tabs/model.js 文件头（不加依赖 / 要能纯 Node 测试 / 只有 4 个 tab）。
 *
 * ============ 「进入结果页」为什么是计数器而不是布尔 ============
 * 见 tabs/model.js 的 openResult：布尔在「关了再开」时值不变，useEffect 不触发，
 * 盘就不刷新。计数器每次进入都 +1，结果页的 effect 必然重跑一遍 load()。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import Records from './src/screens/records/Records';
import Paipan from './src/screens/paipan/Paipan';
import Study from './src/screens/study/Study';
import Settings from './src/screens/settings/Settings';
import Result from './src/screens/result/Result';
import Login from './src/screens/login/Login';
import Reader from './src/screens/reader/Reader';
import TabBar from './src/screens/tabs/TabBar';
import NavBar from './src/components/NavBar';
import Notice from './src/components/Notice';
import KeyboardAvoid, { useKeyboardEaten } from './src/components/KeyboardAvoid';
import tabsModel from './src/screens/tabs/model';
/* ⚠⚠⚠ 2026-10-19 换协议后 App 不再需要 readerModel：导航栏书名改读 `readerTarget.title`
   （`book` 是 book_key，推不出书名）。import 留着就是「没人用的一份依赖」，删掉。 */
import { COLORS } from './src/theme/tokens';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS */
const chartBus: any = require('./src/core/chartBus.js');
const boot: any = require('./src/core/boot.js');
const auth: any = require('./src/core/auth.js');
/** 在线心跳 + 指令接收（长轮询）。⚠ 它只产「动作」，跳页/弹提示由这个壳决定 */
const presence: any = require('./src/core/presence.js');
/** ⚠ 冷启动必须先把持久化的凭证读进内存 —— 见下面 booted 闸门的注释 */
const storage: any = require('./src/platform/storage.js');
/** 服务器地址的本地覆盖值（设置页填的），也要和凭证一起在冷启动读回来 */
const serverAddr: any = require('./src/core/serverAddr.js');
/** 登录页的标题与文案在 content.js 里（可断言，且只写一份） */
const loginContent: any = require('./src/screens/login/content.js');

/**
 * 各页标题 —— 逐字对应小程序各页 json 的 navigationBarTitleText
 * （records.json「记录」/ paipan.json「八字排盘」/ study「学堂」/ settings「设置」）。
 * ⚠ 排盘 tab 的标题是「八字排盘」不是「排盘」，别顺手改短。
 */
const TAB_TITLES: Record<string, string> = {
  records: '记录',
  paipan: '八字排盘',
  study: '学堂',
  settings: '设置',
};
/** 结果页标题（result.json） */
const RESULT_TITLE = '排盘结果';

/**
 * 被管理员强制下线时、服务端**没给理由**时的兜底提示。
 *
 * ⚠ 为什么写在这儿而不是某个页面的 content.js：它是**壳**层面的提示
 *   （可能发生在任何页面、任何时刻），不属于任何一页。
 * ⚠ 服务端给了 reason 就用服务端那句（管理员写的话更有解释力），
 *   这里只是「他没写理由」时的兜底 —— 不能因为没理由就一声不吭地把人踢出去
 *   （用户看到的是「突然回到未登录」，会以为 App 坏了）。
 */
const KICKED_TEXT = '你已被管理员强制下线，请重新登录';

/** 凭证已废（过期 / 账号被删）而**不是**被踢时的兜底提示 */
const SESSION_DEAD_TEXT = '登录已失效，请重新登录';

export default function App() {
  const [tab, setTab] = useState<string>(tabsModel.DEFAULT_TAB);
  /** 结果页进入计数：0 = 关着；>0 = 开着（值本身只是计数，没别的含义） */
  const [resultEntry, setResultEntry] = useState(0);
  /** 登录页进入计数，语义同上 */
  const [loginEntry, setLoginEntry] = useState(0);
  /**
   * 会话版本号：登录成功 / 退出登录各 +1。
   *
   * ⚠⚠ 为什么不靠「各页自己去查 auth.isLoggedIn()」：
   *   四个 tab 是**常驻挂载**的（只在 App 里 display 切），它们不会因为
   *   「登录态变了」而重新挂载、effect 也不会重跑 —— 记录页会继续显示上一个人的列表、
   *   设置页会继续显示「登录」入口。必须有一个显式的信号把它们叫醒。
   *   递增计数器而不是布尔：登出再登入要能触发两次。
   */
  const [sessionRev, setSessionRev] = useState(0);
  /** ⚠ 必须在下面 BackHandler 的 effect **之前**声明 —— 那个 effect 依赖它（const 的 TDZ） */
  const showResult = tabsModel.resultOpen(resultEntry);
  const showLogin = tabsModel.layerOpen(loginEntry);

  /**
   * ⚠⚠ 启动闸门：登录凭证是**异步**从磁盘读进内存镜像的，而 auth / boot 全是
   *   同步读内存。所以必须等读完了再挂载子组件 —— 否则冷启动时内存里空空的，
   *   用户会「明明登录过、却显示未登录」；而且它只在冷启动那一瞬是错的，
   *   本次运行内登录一次之后就正常了 —— 属于最难排查的那种竞态。
   *   （这条曾经真的漏了：loadFromDisk 早就写好了，却**从来没有被调用过**。）
   */
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    let alive = true;
    storage.loadFromDisk().then(() => {
      /*
       * ⚠ 地址覆盖值也必须在这里读回来（它在同一份盘里）：晚一步的话，
       *   冷启动开头那几秒用的是包里的默认地址 —— 用户改过地址的场景下，
       *   这几秒会去连一台不该连的服务器（报错文案都指向错的地方）。
       */
      serverAddr.init();
      if (alive) setBooted(true);
    });
    return () => { alive = false; };
  }, []);

  const onTab = useCallback((key: string) => {
    const next = tabsModel.switchTo(tab, key);
    if (!next) return;
    setTab(next);
  }, [tab]);

  /* 排盘页排完 → 投递 + 进结果页 */
  const onLaunched = useCallback((rec: any) => {
    chartBus.put(rec);
    setResultEntry(tabsModel.openResult);
  }, []);

  /* 记录页点开一条 → 投递轻记录 + 进结果页 */
  const onOpenRecord = useCallback((handoff: any) => {
    chartBus.put(handoff);
    setResultEntry(tabsModel.openResult);
  }, []);

  /* 结果页里的「去排盘」= pop 当前层 + 切 tab（对应 tt.switchTab） */
  const onGoPaipan = useCallback(() => {
    setResultEntry(0);
    setTab('paipan');
  }, []);

  /**
   * 结果页导航栏的返回 = **只 pop，不切 tab**（对应 tt.navigateBack：
   * 回到进来的那一页，也就是原来的 tab）。
   * ⚠ 别复用 onGoPaipan —— 那会顺手把 tab 切成「排盘」，从记录页点开的用户
   *   按返回却落在排盘页，跟小程序的行为对不上。
   */
  const onBack = useCallback(() => {
    setResultEntry(0);
  }, []);

  /* ---------------- 登录页 ---------------- */

  /**
   * 打开登录页（设置页的入口 / 记录页与排盘页的「去登录」都走这里）。
   * ⚠ 用计数器，不是布尔 —— 理由见 tabs/model.js 的 openLayer。
   */
  const onOpenLogin = useCallback(() => {
    setLoginEntry(tabsModel.openLayer);
  }, []);

  const onCloseLogin = useCallback(() => {
    setLoginEntry(0);
  }, []);

  /**
   * 登录态发生了变化（登录成功 / 退出登录）。
   *
   * ⚠ 必须先 `boot.forget()`：boot 会把「本次冷启动已经跟云端核对过」的结论
   *   缓存在进程里，换了个人还复用结论 → 新账号看到的是**上一个人的记录**。
   *   忘掉它，各页下次进来自会重新登录 + 重新核对。
   */
  const onSessionChanged = useCallback(() => {
    boot.forget();
    setSessionRev((n) => n + 1);
  }, []);

  const onLoggedIn = useCallback(() => {
    setLoginEntry(0);
    onSessionChanged();
  }, [onSessionChanged]);

  /**
   * Android 物理返回键：开着推入层时 = pop 那一层（对应 navigateBack），
   * **不能让它走默认行为** —— 默认是退出整个 App。
   * 小程序里 navigateTo 进的页面，物理返回天然就是 navigateBack。
   *
   * ⚠ 登录页优先于结果页：两层同时开着时（理论上不会），先关最上面那层。
   */
  useEffect(() => {
    if (!showResult && !showLogin) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showLogin) onCloseLogin();
      else onBack();
      return true;   // 已处理，不往下传（不退出 App）
    });
    return () => sub.remove();
  }, [showResult, showLogin, onBack, onCloseLogin]);

  /**
   * 四个 tab 的 body：常驻挂载、display 切（⚠ 别改成条件渲染，理由见文件头）。
   * ⚠ 推入层（结果页 / 登录页）盖上来时要把 active 置 false：
   *   那就是小程序的 onHide —— 页面据此退订 boot、停掉计时器，
   *   不然盖上来的那一刻后台还在跑东西。
   * ⚠ 用一个 `activeKey` 同时喂给「hidden 判定」和「各页的 active prop」，
   *   两处各写一遍 `tab === b.key && !showResult && !showLogin` 迟早会漂。
   */
  const live = !showResult && !showLogin;
  const activeKey = live ? tab : '';
  const tabBodies = useMemo(() => [
    {
      key: 'records',
      node: (
        <Records
          active={activeKey === 'records'}
          sessionRev={sessionRev}
          onGoLogin={onOpenLogin}
          onOpenRecord={onOpenRecord}
          onGoPaipan={onGoPaipan}
        />
      ),
    },
    {
      key: 'paipan',
      node: (
        <Paipan
          active={activeKey === 'paipan'}
          sessionRev={sessionRev}
          onGoLogin={onOpenLogin}
          onLaunched={onLaunched}
        />
      ),
    },
    {
      key: 'study',
      node: (
        <Study
          active={activeKey === 'study'}
          sessionRev={sessionRev}
          onGoLogin={onOpenLogin}
        />
      ),
    },
    {
      key: 'settings',
      node: (
        <Settings
          sessionRev={sessionRev}
          onOpenLogin={onOpenLogin}
          onSessionChanged={onSessionChanged}
        />
      ),
    },
  ], [activeKey, sessionRev, onOpenLogin, onOpenRecord, onGoPaipan, onLaunched, onSessionChanged]);

  /**
   * ⚠ 凭证没读回来之前**不渲染任何页面**：
   *   四个 tab 一挂载就会在 effect 里去问登录态（记录页 boot.ensureUser、
   *   排盘页 runLogin），那时读到的必然是「未登录」，而且这个错误结论
   *   会被它们记进 state 里。必须等存储就绪再放它们出来。
   */
  if (!booted) {
    return (
      <SafeAreaProvider>
        <View style={s.root}>
          <StatusBar style="dark" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    /* ⚠ SafeAreaProvider 必须在最外层：NavBar / TabBar / KeyboardAvoid 的 useSafeAreaInsets 靠它供数
       ⚠ 2026-10-10 深夜：这里原先还包着一层 `GestureHandlerRootView`（自研下拉刷新要靠手势库），
          下拉刷新改成 `components/PullRefresh`（**被动听 touch**，一个字的手势都不抢）之后，
          整个 App **不再有任何手势库用法**
          ⇒ 连根容器一起去掉（零手势代码 = 少一层会影响触摸分发的原生容器）。
          将来若真要再上 RNGH 的手势，**必须**把它加回最外层，否则安卓上手势全哑且不报错。 */
    <SafeAreaProvider>
      <KeyboardAvoid>
        <Root/>
      </KeyboardAvoid>
    </SafeAreaProvider>
  );
}

/**
 * App 的实际布局（在 KeyboardAvoid 里面）。
 *
 * ⚠⚠ 为什么要拆成独立组件、而不是把 `useKeyboardEaten()` 直接写在 App 里：
 *   这个 hook 读的是 `KeyboardAvoid` 提供的 Context，
 *   而**消费方必须在 Provider 的子树里** —— 写在 App 本体里读到的是默认值 0，
 *   表现为「避让永远不生效、且不报错」。拆一层是最省事也最不会写错的写法。
 */
function Root() {
  const [tab, setTab] = useState<string>(tabsModel.DEFAULT_TAB);
  /** 结果页进入计数：0 = 关着；>0 = 开着（值本身只是计数，没别的含义） */
  const [resultEntry, setResultEntry] = useState(0);
  /** 登录页进入计数，语义同上 */
  const [loginEntry, setLoginEntry] = useState(0);
  /**
   * 阅读页（学堂 → 点书签）进入计数，语义同上。
   * ⚠ target 与 entry 分开存：entry 只驱动 Reader 重跑 load，
   *   target 是「读哪本书哪个位置」的数据本体。
   */
  const [readerEntry, setReaderEntry] = useState(0);
  const [readerTarget, setReaderTarget] = useState<any>(null);
  /**
   * 会话版本号：登录成功 / 退出登录各 +1。
   *
   * ⚠⚠ 为什么不靠「各页自己去查 auth.isLoggedIn()」：
   *   四个 tab 是**常驻挂载**的（只在 App 里 display 切），它们不会因为
   *   「登录态变了」而重新挂载、effect 也不会重跑 —— 记录页会继续显示上一个人的列表、
   *   设置页会继续显示「登录」入口。必须有一个显式的信号把它们叫醒。
   *   递增计数器而不是布尔：登出再登入要能触发两次。
   */
  const [sessionRev, setSessionRev] = useState(0);
  /** ⚠ 必须在下面 BackHandler 的 effect **之前**声明 —— 那个 effect 依赖它（const 的 TDZ） */
  const showResult = tabsModel.resultOpen(resultEntry);
  const showLogin = tabsModel.layerOpen(loginEntry);
  const showReader = tabsModel.layerOpen(readerEntry);

  /**
   * 键盘当前吃掉了多少高度 —— 由根节点的 KeyboardAvoid 下发。
   * ⚠⚠ **「页面长度减去键盘高度」就落在这里**：扣在内容容器（s.stage）上，
   *   它里面的 ScrollView 于是拿到更小的视口、能滚到底。
   *   扣在更外层（整个 root）会让 NavBar 一起变矮，那是错的 ——
   *   键盘吃掉的本来就是**内容区**的高度，顶部导航栏该原位不动。
   */
  const eaten = useKeyboardEaten();

  const onTab = useCallback((key: string) => {
    const next = tabsModel.switchTo(tab, key);
    if (!next) return;
    setTab(next);
  }, [tab]);

  /* 排盘页排完 → 投递 + 进结果页 */
  const onLaunched = useCallback((rec: any) => {
    chartBus.put(rec);
    setResultEntry(tabsModel.openResult);
  }, []);

  /* 记录页点开一条 → 投递轻记录 + 进结果页 */
  const onOpenRecord = useCallback((handoff: any) => {
    chartBus.put(handoff);
    setResultEntry(tabsModel.openResult);
  }, []);

  /* 结果页里的「去排盘」= pop 当前层 + 切 tab（对应 tt.switchTab） */
  const onGoPaipan = useCallback(() => {
    setResultEntry(0);
    setTab('paipan');
  }, []);

  /**
   * 结果页导航栏的返回 = **只 pop，不切 tab**（对应 tt.navigateBack：
   * 回到进来的那一页，也就是原来的 tab）。
   * ⚠ 别复用 onGoPaipan —— 那会顺手把 tab 切成「排盘」，从记录页点开的用户
   *   按返回却落在排盘页，跟小程序的行为对不上。
   */
  const onBack = useCallback(() => {
    setResultEntry(0);
  }, []);

  /* ---------------- 登录页 ---------------- */

  /**
   * 打开登录页（设置页的入口 / 记录页与排盘页的「去登录」都走这里）。
   * ⚠ 用计数器，不是布尔 —— 理由见 tabs/model.js 的 openLayer。
   */
  const onOpenLogin = useCallback(() => {
    setLoginEntry(tabsModel.openLayer);
  }, []);

  const onCloseLogin = useCallback(() => {
    setLoginEntry(0);
  }, []);

  /**
   * 登录态发生了变化（登录成功 / 退出登录）。
   *
   * ⚠ 必须先 `boot.forget()`：boot 会把「本次冷启动已经跟云端核对过」的结论
   *   缓存在进程里，换了个人还复用结论 → 新账号看到的是**上一个人的记录**。
   *   忘掉它，各页下次进来自会重新登录 + 重新核对。
   */
  const onSessionChanged = useCallback(() => {
    boot.forget();
    setSessionRev((n) => n + 1);
  }, []);

  const onLoggedIn = useCallback(() => {
    setLoginEntry(0);
    /**
     * ⚠⚠ **每次登录成功都清掉这个账号的指令游标**（下次心跳 = 第一次心跳）。
     *
     * 这是「强制下线」的必要配套，不是顺手加的：
     * 踢人是靠下发一条 `logout` 指令实现的，而那条指令**会留在服务端库里**
     * （后台要看「踢过谁」）。被踢的人重新登录后如果还带着旧游标，
     * 服务端会把那条 logout 当成「他还没收到过」**再发一次** ——
     * 现象是「刚登录就又被踢出去」，而两边日志全都正常（最难查的一类）。
     *
     * ⚠ 代价（**明确接受**）：「离线期间服务端发的指令」在重新登录后不再补发。
     *   这与服务端「第一次心跳不补历史」本来就是同一个口径 ——
     *   那些指令（弹个提示、跳个页面）都是**即时**的东西，
     *   隔一天再弹出来只会让人困惑，不是「补上了信息」。
     *   ⚠ 反过来（登录时不清、退出登录时清）更糟：那样离线期间那条 logout
     *     照样会被重放（它正是「离线期间收到的」），而真正无害的提示反而被跳过。
     */
    presence.clearCursor();
    onSessionChanged();
  }, [onSessionChanged]);

  /* ---------------- 在线心跳 + 服务端指令（长轮询） ---------------- */

  /**
   * 服务端下发的提示条（toast 指令）。
   * ⚠ 带一个自增 id：连着两条**一模一样**的提示也要能重新计时 ——
   *   Notice 拿它当 key 重挂载（同一个 text 重新渲染不会重跑 effect）。
   */
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const noticeSeq = useRef(0);

  const onCloseNotice = useCallback(() => { setNotice(null); }, []);

  /**
   * 会话已经不作数了（**被管理员强制下线** / 账号被删 / 凭证过期）——
   * 收摊回未登录态，并把原因告诉用户。
   *
   * ⚠⚠ 两条路都汇到这里，别再各写一份（否则两边行为迟早会漂）：
   *   · `logout` 指令 —— 人**在线**时服务端推过来的（秒级）
   *   · 任意请求回 401 —— 人不在线、或请求先到（见 core/presence.js 文件头 ⑦）
   *
   * ⚠ 三条顺序是有讲究的：
   *   ① `presence.clearCursor()`：让**下次登录**是「第一次心跳」。
   *      见 onLoggedIn 里那段说明 —— 不清的话重新登录会重放那条 logout，
   *      用户会「刚登录就又被踢」。
   *   ② `auth.logout()`：清本地凭证（这一步之后 isLoggedIn() 就是 false 了）。
   *   ③ `onSessionChanged()`：boot.forget + sessionRev+1 ⇒ 四个常驻 tab 重新加载，
   *      记录页会显示「未登录」的常态（而不是上一个人的列表）。
   *   ⚠ 别在这里补一句 `bye()`（告诉服务端「我走了」）：凭证都废了，
   *     发出去只会换回一串 401。服务端那边靠「踢人时顺手标离线」解决（见 adminUsers）。
   */
  const forceLogout = useCallback((text: string) => {
    presence.clearCursor();
    auth.logout();
    onSessionChanged();
    /* ⚠ 提示放最后。用 Notice（顶部浮条）而不是 Alert：弹窗会打断用户手上的事，
       而这件事**不需要他立刻做任何决定** —— 他只是被请出去重新登录。 */
    noticeSeq.current += 1;
    setNotice({ id: noticeSeq.current, text: text });
  }, [onSessionChanged]);

  /** App 在前台吗 —— 退了后台就停心跳（不然锁屏后还在每 25 秒发一次请求） */
  const [appActive, setAppActive] = useState(true);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st: string) => {
      setAppActive(st === 'active');
    });
    return () => sub.remove();
  }, []);

  /**
   * 登录后启动心跳（长轮询）；退后台 / 退出登录时停 —— **并且主动告诉服务端「我走了」**，
   * 好让后台立刻把这个人显示成离线（不告知的话要等 60 秒窗口过期，灯一直亮着）。
   *
   * ⚠⚠ 依赖数组里那两个都不是「用到的值」，而是**重启信号**，别顺手删掉：
   *   · `sessionRev` —— 登录 / 退出登录各 +1（与四个 tab 用的是同一个信号）。
   *     少它 ⇒ 换账号后心跳还挂在老账号上（后台看到的是**错的人在线上**）。
   *   · `appActive` —— 回前台必须重新 start（退后台时已经 stop 了）。
   *
   * ⚠ 这个 effect **只管发请求**，不管界面：收回来的指令交给 onAction，
   *   「跳页 / 弹提示」在这里判。core 那层因此不依赖 React，能纯 Node 断言。
   */
  useEffect(() => {
    if (!appActive) return;
    /**
     * ⚠ 本机**没有登录凭证**就别起循环 —— 发了也是个 NO_SESSION，白跑一趟。
     *   ⚠ 注意 `isLoggedIn()` 判的是「本机有没有凭证」，**不是**「凭证还有效」：
     *     被强制下线的人，凭证在本地仍然「有」（App 还不知道自己已经被踢了），
     *     所以循环照样会起 —— 而它下一次心跳拿到的 401 正是**发现被踢**的那条路。
     *     别把这里改成「先跟服务端核对一次再说」，那会在冷启动时多加一个往返。
     */
    if (!auth.isLoggedIn()) return;
    const loop = presence.createLoop({
      onAction: (a: any) => {
        if (a.type === 'toast') {
          noticeSeq.current += 1;
          setNotice({ id: noticeSeq.current, text: a.text });
          return;
        }
        if (a.type === 'goto') {
          /* ⚠ 目标页不合法就**忽略**：宁可停在原地，也别切出一块空白
             （与 tabs/model.js 的 switchTo 同一纪律）。合不合法只有它知道。 */
          if (!tabsModel.isTab(a.tab)) return;
          /* ⚠ 先收推入层再切 tab：结果页 / 阅读页 / 登录页是盖在 tab 之上的，
             不收掉的话用户落在一个「被盖住的页面」上，看起来像什么都没发生。 */
          setResultEntry(0);
          setReaderEntry(0);
          setLoginEntry(0);
          setTab(a.tab);
          return;
        }
        if (a.type === 'logout') {
          /* **被管理员强制下线**（在线的那一半）。
             ⚠ 服务端没写理由时用 KICKED_TEXT 兜底 —— 不能一声不吭地把人踢出去，
                用户看到「突然回到未登录」只会以为 App 坏了。 */
          forceLogout(a.reason || KICKED_TEXT);
        }
      },
      onStatus: (kind: string, info: any) => {
        /* ⚠ 默认只打日志、**不弹提示**：心跳失败是家常便饭（后端没开、换了 WiFi），
           每次都弹一下会让用户以为 App 坏了。 */
        console.log('[paipan] presence ' + kind, info || '');
        if (kind === 'unauthorized') {
          /* 服务端说这张凭证不认了（被强制下线 / 账号被删 / 已过期）。
             ⚠ 本机**本来就没登录**时什么都不做：没有东西可清，
                弹一句「登录已失效」纯属噪音（未登录是这台设备的正常状态之一）。
             ⚠ 文案优先用服务端那句 —— 它分得清「你已被管理员强制下线」
                和「这个账号已经不存在了」，比一句笼统的兜底有用得多。 */
          if (!auth.isLoggedIn()) return;
          forceLogout((info && info.error) || SESSION_DEAD_TEXT);
        }
      },
    });
    loop.start();
    /**
     * ⚠⚠ 清理函数 = **退场**，所以它带 `offline: true`：停掉循环，同时告诉服务端
     *   「我走了」，后台立刻变离线（不然还要亮一分钟灯）。
     *
     *   ⚠ 哪些情况会走到这里（都会说这一句）：
     *     · 退到后台 / 锁屏（appActive 变 false）
     *     · 退出登录 / 换账号（sessionRev 变了，旧循环在这里收摊）
     *     · 整个 App 卸载（热重载、进程退出）
     *   ⚠ 在飞的那一次请求**不打断**：bye 会让服务端把挂着的 ping 立刻放行，
     *     它自己就收摊了（见 core/presence.js 的 stop / bye）。
     *   ⚠ 退出登录那条路径上，凭证是先被 Settings 清掉的（signOut 在前、sessionRev 在后），
     *     所以这里那次 bye 拿不到令牌、静默跳过 —— 真正的「我走了」由设置页在
     *     清凭证**之前**发（见 screens/settings/Settings.tsx）。两处都留着是有意的：
     *     谁也说不准哪条路径先到，而多说一次是无害的、漏说一次才是 bug。
     *   ⚠ **被强制下线**那条路径同样跳过（forceLogout 里先清了凭证）——
     *     这是**对的**：人都被踢了，再报一次离线没有任何意义，而且必然 401。
     */
    return () => { loop.stop({ offline: true }); };
    /* ⚠ forceLogout 是 useCallback（只依赖 onSessionChanged），身份稳定 ——
       放进依赖不会让这个循环被无谓地重启。 */
  }, [appActive, sessionRev, forceLogout]);

  /* ---------------- 阅读页（学堂 → 点书签） ---------------- */

  /**
   * 打开阅读层：先记下要读的书签，再 +1 进层计数（同 onOpenLogin 的语义）。
   * ⚠ 两个 set 同一批渲染，Reader 的 effect 读到的 target 一定是这一条的。
   */
  const onOpenBookmark = useCallback((item: any) => {
    setReaderTarget(item);
    setReaderEntry(tabsModel.openLayer);
  }, []);

  const onCloseReader = useCallback(() => {
    setReaderEntry(0);
  }, []);

  /**
   * Android 物理返回键：开着推入层时 = pop 那一层（对应 navigateBack），
   * **不能让它走默认行为** —— 默认是退出整个 App。
   * 小程序里 navigateTo 进的页面，物理返回天然就是 navigateBack。
   *
   * ⚠ 优先级 = 层的叠放顺序：登录(20) > 阅读(15) > 结果(10) —— 先关最上面那层。
   */
  useEffect(() => {
    if (!showResult && !showLogin && !showReader) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showLogin) onCloseLogin();
      else if (showReader) onCloseReader();
      else onBack();
      return true;   // 已处理，不往下传（不退出 App）
    });
    return () => sub.remove();
  }, [showResult, showLogin, showReader, onBack, onCloseLogin, onCloseReader]);

  /**
   * 四个 tab 的 body：常驻挂载、display 切（⚠ 别改成条件渲染，理由见文件头）。
   * ⚠ 推入层（结果页 / 阅读页 / 登录页）盖上来时要把 active 置 false：
   *   那就是小程序的 onHide —— 页面据此退订 boot、停掉计时器，
   *   不然盖上来的那一刻后台还在跑东西。
   * ⚠ 用一个 `activeKey` 同时喂给「hidden 判定」和「各页的 active prop」，
   *   两处各写一遍 `tab === b.key && !showResult && !showLogin` 迟早会漂。
   */
  const live = !showResult && !showLogin && !showReader;
  const activeKey = live ? tab : '';
  const tabBodies = useMemo(() => [
    {
      key: 'records',
      node: (
        <Records
          active={activeKey === 'records'}
          sessionRev={sessionRev}
          onGoLogin={onOpenLogin}
          onOpenRecord={onOpenRecord}
          onGoPaipan={onGoPaipan}
        />
      ),
    },
    {
      key: 'paipan',
      node: (
        <Paipan
          active={activeKey === 'paipan'}
          sessionRev={sessionRev}
          onGoLogin={onOpenLogin}
          onLaunched={onLaunched}
        />
      ),
    },
    {
      /* ⚠ 学堂**只限登录**才可以使用（2026-10-21）：它自己要 sessionRev 才知道
         「刚刚登出 / 刚登录」，光靠 active 变不动（本页常驻）。见 study/Study.tsx 文件头。 */
      key: 'study',
      node: (
        <Study
          active={activeKey === 'study'}
          sessionRev={sessionRev}
          onGoLogin={onOpenLogin}
          onOpenBookmark={onOpenBookmark}
        />
      ),
    },
    {
      key: 'settings',
      node: (
        <Settings
          sessionRev={sessionRev}
          onOpenLogin={onOpenLogin}
          onSessionChanged={onSessionChanged}
        />
      ),
    },
  ], [activeKey, sessionRev, onOpenLogin, onOpenRecord, onGoPaipan, onLaunched, onSessionChanged, onOpenBookmark]);

  return (
    <View style={s.root}>
      <StatusBar style="dark" />

      {/* ===== 顶部导航栏（复刻小程序的原生导航栏）=====
          小程序里每一页都有自己的原生导航栏，所以这里 tab 层一条、
          推入层里再一条 —— 推入层盖上来时自然只剩它自己那条，
          正好对应 navigateTo 的页面栈，别想着「共享一条」省事。
          ⚠⚠ 它**不参与**键盘避让：键盘吃掉的是内容区的高度。 */}
      <NavBar title={TAB_TITLES[tab] || ''} />

      {/* ===== 四个 tab 页（常驻） =====
          ⚠⚠ 这里就是「页面长度减去键盘高度」的落点：`paddingBottom: eaten`。
             RN 的 flex 布局里，这个容器的可用高度随之变小，
             各页内部的 ScrollView 拿到更小的视口 ⇒ 能滚到底、按钮不再被压住。 */}
      <View style={[s.stage, { paddingBottom: eaten }]}>
        {tabBodies.map((b: any) => (
          <View
            key={b.key}
            style={b.key === activeKey ? s.pageOn : s.pageOff}
            /* ⚠ pointerEvents 跟着显隐走：藏起来的页不接触摸，
               否则透明度虽为 0 但命中测试还在（两层 ScrollView 抢手势） */
            pointerEvents={b.key === activeKey ? 'auto' : 'none'}
          >
            {b.node}
          </View>
        ))}
      </View>

      {/* ===== 底部 tab 栏 =====
          ⚠ 键盘弹着时**藏起来**：它已经被键盘盖住了，留着只是白占那几十像素；
             藏掉之后「减掉的高度」才真的全给内容用。 */}
      {eaten > 0 ? null : <TabBar active={tab} onPress={onTab} />}

      {/* ===== 结果页：推入层，盖住整个（含 tab 栏）=====
           小程序里 navigateTo 进的页面是全屏的，tabBar 在那一页根本不存在；
           这里同样盖满全屏，视觉与小程序一致。
           ⚠ 这是绝对定位层，**不占** s.stage 的高度 ⇒ 里面的内容也得自己减。 */}
      {showResult ? (
        <View style={s.overlay}>
          <NavBar title={RESULT_TITLE} onBack={onBack} />
          <Result entry={resultEntry} onGoPaipan={onGoPaipan} eaten={eaten} />
        </View>
      ) : null}

      {/* ===== 阅读页：同为推入层（学堂点书签进来）=====
           ⚠ 自己一条 NavBar（标题=书名，去 .docx）；zIndex 15 夹在结果(10)/登录(20)之间，
              返回键的关闭优先级与这个叠放顺序一致（见上面 BackHandler）。 */}
      {showReader ? (
        <View style={s.overlayReader}>
          {/* ⚠⚠⚠ 2026-10-19：书名读 target.title，**不是** `readerModel.bookTitle(readerTarget.book)`
             —— `book` 现在是 book_key（内容哈希），那样写会让导航栏显示一串哈希。 */}
          <NavBar title={readerTarget ? (readerTarget.title || '') : ''} onBack={onCloseReader} />
          <Reader entry={readerEntry} target={readerTarget} onBack={onCloseReader} />
        </View>
      ) : null}

      {/* ===== 登录页：同为推入层 =====
           ⚠ 与结果页各一条 NavBar（理由同上）；zIndex 更高一层，
              万一两层同时开着，保证先关的是最上面那个。 */}
      {showLogin ? (
        <View style={s.overlayTop}>
          <NavBar title={loginContent.TITLE} onBack={onCloseLogin} />
          <Login onClose={onCloseLogin} onLoggedIn={onLoggedIn} eaten={eaten} />
        </View>
      ) : null}

      {/* ===== 服务端下发的提示条（长轮询收回来的 toast）=====
           ⚠ 放在**最后**、zIndex 30：四个 tab、结果页、阅读页、登录页都盖得住 ——
             「后台发来的话」不该被任何一层挡住。
           ⚠ key={notice.id}：连着两条同样的提示也要重新计时（见 Notice.tsx 文件头）。 */}
      {notice ? (
        <Notice key={notice.id} text={notice.text} onDone={onCloseNotice} />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f5f5f5' },
  /** tab 区：tab 栏之上的全部空间；⚠ 键盘弹起时由 App 现算的 paddingBottom 再压一层 */
  stage: { flex: 1 },
  pageOn: { flex: 1, display: 'flex' },
  /** ⚠ display:'none' —— 真·不参与布局，藏起来的页不留任何测量残值 */
  pageOff: { flex: 1, display: 'none' },
  /** 结果页推入层：盖满全屏（对应小程序 navigateTo 的全屏页面栈）
   *  ⚠ RN 0.86 已把 StyleSheet.absoluteFillObject 整个删掉（运行时是 undefined，
   *    展开它 = 什么都没写、浮层不定位）。这里显式写四边，别用那个常量。 */
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: COLORS.bg,
  },
  /** 阅读页推入层：显式定位理由同上；zIndex 15 夹在结果页(10)与登录页(20)之间 */
  overlayReader: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 15,
    backgroundColor: COLORS.bg,
  },
  /** 登录页推入层：显式定位理由同上；zIndex 比结果页高，保证它在最上面 */
  overlayTop: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 20,
    backgroundColor: COLORS.bg,
  },
});
