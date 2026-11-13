/**
 * 排盘数据在页面之间的传递 —— **纯内存**，一行都不落 storage。
 *
 * ⚠ 为什么不用 tt.setStorageSync('current_chart', ...)：
 * 用户要求「保存的数据一点都不能存在本地」。上一版是
 *   排盘页 / 记录页 → setStorageSync('current_chart') → 结果页 getStorageSync
 * 这条路会把整份盘（几十 KB，含 70 年逐年小运）写进本机，
 * 用户退出时还在那儿躺着 —— 与要求直接冲突。
 *
 * 现在改成模块级变量：
 *   · 生命周期 = 这次小程序运行期间，杀进程就没了（正是我们要的）
 *   · 模块在 JS 引擎里是单例，页面之间天然共享，不需要 globalData 也能传
 *   · 冷启动直接进结果页（比如从分享卡片 / 历史栈恢复）拿不到东西 ——
 *     这时结果页走自己的空态，不会显示一条来路不明的盘
 *
 * 记录页「打开一条记录」走的是另一条路：它只有轻记录（出生信息），
 * 结果页会现场重排（record.hydrate），所以**不必**经过这里。
 * 这里只服务「刚排完盘、手上已经是完整盘」的那条快路径。
 *
 * ============ ⚠⚠ 「投递」与「消费」是两件事，别混 ⚠⚠ ============
 * 结果页的 onLoad 与 onShow **都会**读一次（小程序进页面时这两个钩子是连着触发的）。
 * 早先这里只有一个槽 + take() 取完即清，于是：
 *   onLoad  take() → 拿到记录、槽清空
 *   onShow  take() → null → 界面被重置成空态（「还没有排盘数据」）
 * 表现就是「一进结果页就闪一下空态」——这正是被用户报上来的那个 bug。
 *
 * 现在的模型：
 *   pending  = 待投递（谁先读谁拿走）
 *   current  = 已经投出去的这一份（读取方反复读都拿到同一个，直到被替换或清掉）
 * take() 把 pending 提升为 current 并返回；之后再 take() 拿的是同一个 current。
 * 于是 onLoad / onShow 读到的永远是同一份，界面不会被重置。
 *
 * ⚠ 离开页面时要 clear()（result.js 的 onUnload 里做了）——
 *   否则下次冷启动进结果页会拿到上一轮残留的盘。
 *   clear() 同时清 pending 和 current，是唯一的「作废」入口。
 */

/** 待投递的那一份；null = 没有 */
let pending = null;
/** 已经投出去的这一份；读取方反复调用 take() 拿到的是它 */
let current = null;

/**
 * 放一份盘进去（完整盘，带 chart）。投递即成为「待读取」。
 * @param {Object} payload
 */
function put(payload) {
  pending = payload || null;
  current = null;          // 新投递作废上一个已被读走的——避免新旧混着用
  return pending;
}

/**
 * 取一份盘。
 * 第一次调用会把 pending 提升为 current；之后重复调用返回同一个 current。
 * 所以 onLoad / onShow 连着调也拿到同一份，不会第二次变 null。
 */
function take() {
  if (pending) {
    current = pending;
    pending = null;
  }
  return current;
}

/** 只看一眼，不消费（调试 / 测试用） */
function peek() {
  return pending || current;
}

/** 作废：pending 与 current 都清掉（离开结果页时调用） */
function clear() {
  pending = null;
  current = null;
}

module.exports = {
  put: put,
  take: take,
  peek: peek,
  clear: clear
};
