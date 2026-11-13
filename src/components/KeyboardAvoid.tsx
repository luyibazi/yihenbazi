/**
 * 全局键盘避让 —— 键盘一弹，**整个 App 的可视高度就减去键盘高度**。
 *
 * ============ 这是「App 常用的防遮挡」，所以只做一次 ============
 * 之前每个页面各写一遍 `KeyboardAvoidingView`（登录页一遍、结果页三个弹框三遍），
 * 结果是：① 谁忘了写谁就被盖住（结果页的「详细信息」页签当时就是漏的）；
 * ② 到处贴 `behavior={Platform.OS === 'ios' ? … : …}` 这种样板；
 * ③ 两层同时生效时**双重上移**（框被顶出屏幕顶）。
 * ⇒ 改成在 `App.tsx` 根节点包**一层**，全 App 一次性生效。
 *
 * ============ ⚠⚠ 为什么不用 RN 自带的 KeyboardAvoidingView ============
 * 它只认「**自己**在布局树里的位置」和键盘高度，做法是给自己加 `paddingBottom`
 * 或减自己的 `height`。放在最外层包整页时有两个具体毛病：
 *   ① 它不知道**状态栏 + 导航栏**的存在，要靠 `keyboardVerticalOffset` 手工补；
 *   ② 页面顶部那两块（NavBar）本就不该跟着动，
 *      键盘要吃掉的是**内容区**的高度。
 * 自己算就没这些问题：饿掉多少 = **键盘真正挡住的高度**，扣在**内容容器**上。
 *
 * ============ ⚠⚠ 安卓必须走 `resize`，不能走 `pan` ============
 * Expo 默认 `softwareKeyboardLayoutMode: 'pan'` —— 那是「整页往上平移」，
 * 不是「减去高度」。平移的后果：顶部的 NavBar 被推出屏幕、内容跟着飘。
 * `app.json` 改成 `'resize'` 后，安卓由系统直接缩窗口，
 * 这时候 JS 侧**一帧都不用动**（再动一次就是双重上移，小屏上框会被顶出屏幕顶）。
 * ⇒ 所以本组件在安卓上恒返回 `0`（不饿），只负责「补上 resize 没覆盖的那部分」。
 *
 * ============ ⚠ 事件名两端不同，用错 = 一端**静默**失效 ============
 *   iOS 用 willShow / willHide（跟动画同步，来得及让位、不闪），
 *   安卓只有 didShow / didHide。写死一套不报错，只是有一端永远收不到。
 *
 * ============ ⚠⚠ iOS 上「减去高度」不能只饿内容层一轮 ============
 * 键盘高度从 `keyboardWillShow` 拿到（跟动画同步），但它给的是**预估**值；
 * `keyboardDidShow` 之后才是最终值（切换输入法、外接键盘、候选栏都会变）。
 * ⇒ 两个事件都接，didShow 到了就**再对一次账**（只在真的变了才 setState）。
 *
 * ============ ⚠⚠⚠ 但 show / didShow 这两个是「主力」，不是「全部」 ============
 * **第三方输入法**（百度 / 搜狗 / 讯飞这类）弹出时，iOS 经常只发
 * `keyboardWillChangeFrame` 而**不发** `keyboardWillShow` —— 同一个 App，
 * 用系统键盘的人一切正常、装第三方输入法的人「避让永远不生效」，
 * 表现就是底部输入框/按钮被键盘整个盖住（且不报错、日志里什么都没有）。
 * RN 自带的 `KeyboardAvoidingView` 在 iOS 上认的正是 `changeFrame`，
 * 所以它「在谁那儿都好使」—— 我们要的效果就是它那个效果，事件也得照它接。
 * ⇒ `changeFrame` / `didChangeFrame` 一起接：它们同时覆盖
 *   ①第三方键盘的一次性弹出 ②打字过程中长出来的候选栏/工具条（那时 show 不会再发）。
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Dimensions, Keyboard, Platform, StyleSheet, View } from 'react-native';

/** 当前键盘**真正吃掉**多少高度（上下都夹在 [0, 屏高]）。 */
const KeyboardHeightCtx = createContext(0);

/**
 * 键盘当前吃掉了多少高度。
 * 给「自己需要知道键盘状态」的地方用（如点遮罩的分派、在某处显示「收起键盘」）。
 * ⚠ 只想避让的地方**不需要**调它 —— 根节点那层已经让过位了。
 */
export function useKeyboardEaten(): number {
  return useContext(KeyboardHeightCtx);
}

/**
 * 键盘是不是弹着（`useKeyboardEaten() > 0` 的语义化写法）。
 * ⚠ 用「吃掉的高度 > 0」而不是「收到过 show 事件」：外接键盘 / 悬浮键盘
 *   会把高度报成 0，那时候按「弹着」处理是错的（没有东西需要避让）。
 */
export function useKeyboardShown(): boolean {
  return useKeyboardEaten() > 0;
}

export default function KeyboardAvoid({ children }: { children: React.ReactNode }) {
  const [eaten, setEaten] = useState(0);

  useEffect(() => {
    /**
     * ⚠ 安卓：系统 `adjustResize` 已经缩过窗口了，JS 侧再饿一次 = 双重上移。
     *   所以直接恒 0（`softwareKeyboardLayoutMode: 'resize'` 见 app.json）。
     */
    if (Platform.OS !== 'ios') return;

    const showEvt = 'keyboardWillShow';   // ⚠ iOS 有 will*；安卓没有，别混用
    const hideEvt = 'keyboardWillHide';
    const didEvt = 'keyboardDidShow';     // ⚠ will 给的是预估值，did 才是最终值
    /* ⚠⚠⚠ 这两个才是「第三方输入法 / 候选栏长出来」的兜底事件（见文件头）：
       只接 show/didShow 的话，换一个第三方键盘整层避让就静默失效。 */
    const frameEvt = 'keyboardWillChangeFrame';
    const frameDidEvt = 'keyboardDidChangeFrame';

    /**
     * ⚠⚠⚠ 把 endCoordinates 换算成「要饿掉的高度」—— 唯一的换算处，别在别处再算。
     * **用 `screenY`（键盘 frame 顶边）直接算遮挡，不要用 `height − 底部安全区`**：
     * iOS 报上来的键盘 frame 是**一直顶到屏幕最底下**的（Home 指示条那块也是键盘
     * 的一部分），所以「挡住的内容」= 屏高 − screenY = 整个 height，**一分别扣**。
     * 2026-10-04 用户报障：批字输入框底部被键盘**候选栏**盖住 —— 就是按
     * 「高度 − 安全区」少让了 34pt，输入框正好沉进键盘最顶上那条候选栏底下。
     * ⚠ 用 screenY 还自带一个好处：悬浮键盘 / 将来 frame 不顶底的情况也算得对。
     */
    const fromEnd = (ec: any) => {
      if (!ec) return 0;
      const screenH = Dimensions.get('screen').height;
      const h = Number(ec.height) || 0;
      const y = typeof ec.screenY === 'number' ? Number(ec.screenY) : screenH - h;
      return Math.max(0, Math.min(Math.round(screenH - y), Math.round(screenH)));
    };

    /**
     * ⚠⚠⚠ `changeFrame` **收起键盘时也会发**（键盘滑回屏幕外，但 height 仍是整个键盘高）——
     *   不判这一下，收起键盘反而会把页面顶上去。
     *   判据：`endCoordinates.screenY` 落到屏幕下缘之外 = 键盘不在屏幕上
     *   （`fromEnd` 里 `screenH - y ≤ 0` 自动归 0，不用单独再判）。
     */
    const fromFrame = (e: any) => fromEnd(e && e.endCoordinates);

    const subs = [
      Keyboard.addListener(showEvt, (e: any) => {
        setEaten(fromEnd(e && e.endCoordinates));
      }),
      /* ⚠ 只在**真的变了**才 setState：didShow 在 willShow 之后必然再来一次，
         无条件 set 会白跑一轮渲染（内容多的页面上会看到一次多余的布局） */
      Keyboard.addListener(didEvt, (e: any) => {
        const next = fromEnd(e && e.endCoordinates);
        setEaten((cur) => (cur === next ? cur : next));
      }),
      /* ⚠⚠ 兜底的那两个：第三方键盘只发这一个，候选栏/工具条长出来也只发这一个 */
      Keyboard.addListener(frameEvt, (e: any) => {
        const next = fromFrame(e);
        setEaten((cur) => (cur === next ? cur : next));
      }),
      Keyboard.addListener(frameDidEvt, (e: any) => {
        const next = fromFrame(e);
        setEaten((cur) => (cur === next ? cur : next));
      }),
      Keyboard.addListener(hideEvt, () => setEaten(0)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  /**
   * ⚠⚠ 这一层**自己不承担避让**，只是把「键盘吃掉多少」下发给内容容器。
   *
   *   为什么不让它直接 `paddingBottom: eaten`：
   *   这里是个 `flex:1` 的容器，加 padding 只会把子项**压扁** ——
   *   超出部分不会变成可滚动的溢出，用户照样看不到底下的东西。
   *   正确的做法是让**内容容器**（`App.tsx` 的 `s.stage`，里面是各页的 ScrollView）
   *   自己变矮：ScrollView 拿到更小的视口，于是能滚到底。
   *   这也正是「页面长度减去键盘高度」这句话的字面实现。
   */
  const value = useMemo(() => eaten, [eaten]);

  return (
    <KeyboardHeightCtx.Provider value={value}>
      <View style={s.wrap}>{children}</View>
    </KeyboardHeightCtx.Provider>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1 },
});
