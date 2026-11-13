/**
 * 底部 tab 导航的**纯计算层** —— 不 import 任何 React / RN 东西，可在纯 Node 里断言。
 *
 * ============ 为什么自己写而不引 @react-navigation ============
 *   ① 不加依赖：这个 App 的依赖面被刻意压到最小（expo / react / react-native），
 *      一套导航库带十来个传递依赖，本机 safe-delete 一拦就又是一片半成品 node_modules；
 *   ② 要能纯 Node 测试：tab 切换时「谁订阅谁退订、结果页怎么被顶开」正是
 *      最容易错的联动，拆成纯函数才能在 Node 里断言，不用上模拟器；
 *   ③ 只有 4 个 tab + 1 个推入页，写全也就几十行 —— 引库是拿大炮打蚊子。
 *
 * ============ 与小程序的对应关系 ============
 *   app.json 的 tabBar.list            → TABS
 *   tt.switchTab({ url })              → switchTo(cur, key)
 *   页面 onShow / onHide               → activeTab 变化时各 Screen 的 active prop
 *   tt.navigateTo('/pages/result')     → openResult()（结果页是**推入层**，不占 tab）
 *   （小程序里结果页在 tabBar 之外，页面栈 push/pop；
 *     RN 这边没有页面栈，用「常驻挂载 + 绝对定位覆盖」达到同样的观感：
 *     盖着的时候四个 tab 全都还在（状态不丢），关掉 = pop。）
 *
 * ⚠⚠ 四个 tab Screen **常驻挂载**（不做条件渲染）—— 与结果页三面板同一个理由：
 *   ChartView 内部的「选中哪步大运 / 流年 / 流月」在 useState 里，卸载就没了。
 *   Records 的「上次同步版本号」等 ref 同理。隐藏靠 display:'none'（真·不参与布局）。
 */

/**
 * 四个 tab（顺序 = app.json 的 tabBar.list，也是渲染顺序）。
 * ⚠ 图标**不在这里 require**：本文件要能被纯 Node 的测试直接 require，
 *   而 Node 认不了 .png。图标映射放在 TabBar.tsx（视图层）里，按 key 对上。
 */
const TABS = [
  { key: 'records', label: '记录' },
  { key: 'paipan', label: '排盘' },
  { key: 'study', label: '学堂' },
  { key: 'settings', label: '设置' },
];

/** 默认落在第一个 tab（小程序 pages[0] = records，「启动页」） */
const DEFAULT_TAB = 'records';

/** key 合法吗 */
function isTab(key) {
  return TABS.some(function (t) { return t.key === key; });
}

/**
 * 点了某个 tab → 下一个 tab。
 * ⚠ 未知 key 忽略（返回 null）：宁可停在原地，也不要切出一块空白
 *   —— 与结果页 onTab、日期选择器同一纪律。
 * ⚠ 点当前 tab 也返回 null：switchTab 对当前页是 no-op，别白渲染一轮。
 *
 * @returns {string|null} null = 不切换
 */
function switchTo(cur, key) {
  if (!isTab(key)) return null;
  if (key === cur) return null;
  return key;
}

/**
 * 结果页的开关。
 *
 * ⚠ entry 用**递增计数器**而不是布尔：连续两次「排盘页 → 结果页 → 返回 → 再排盘」
 *   是两次独立的进入，每次都得让结果页真的走一遍 load()（去总线拿新盘）。
 *   布尔在「关了再开」时值不变，useEffect 不触发 —— 盘就不刷新。
 *   （这正是 chartBus 双槽 + model 两道短路设计成「可重复消费」的配套。）
 *
 * @param {number} curEntry  当前计数（0 = 结果页关着）
 * @returns {number} +1 后的计数
 */
function openResult(curEntry) {
  return (curEntry || 0) + 1;
}

/** 结果页现在开着吗 */
function resultOpen(entry) {
  return (entry || 0) > 0;
}

/**
 * 通用推入层的开关 —— 结果页与登录页共用同一套计数器语义。
 *
 * ⚠ 登录页也必须是**计数器**而不是布尔，理由与结果页完全相同：
 *   在设置页登录 → 关掉 → 退出登录 → 再进来登录，是两次独立的进入，
 *   布尔在「关了再开」时值不变 ⇒ 登录页的 useState 全停在上一轮
 *   （账号还留在输入框里、按钮还停在「登录成功」），看着像卡死。
 *
 * ⚠ 为什么不做成参数化的 `openLayer(cur, key)`：同一时刻只可能开一层，
 *   各层各持一个计数器最简单、也最不容易写错（真需要叠加时再加也不迟）。
 */
const openLayer = openResult;
const layerOpen = resultOpen;

module.exports = {
  TABS: TABS,
  DEFAULT_TAB: DEFAULT_TAB,
  isTab: isTab,
  switchTo: switchTo,
  openResult: openResult,
  resultOpen: resultOpen,
  openLayer: openLayer,
  layerOpen: layerOpen
};
