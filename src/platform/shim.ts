/* 平台适配：整个 App 只在这里设置一次全局 shim。
 *
 * 为什么需要：
 *   vendor/tyme.js 是从 tyme4ts 降级编译来的，里面**引用全局 window**。
 *   小程序里 window 是天然存在的；Node 里跑测试要先 `globalThis.window = globalThis`。
 *   RN 的 Hermes 引擎里没有 window —— 不 shim 就会在加载 core/ 时直接崩。
 *
 * ⚠ 这是本项目**唯一**一处为「让 core/ 能跑」而写的代码。
 *   core/ 那 11 个文件本身一个字都不用改（这是刻意的设计）。
 *
 * ⚠ 必须在任何 core/ 模块被 require 之前执行 —— 所以放在 index.ts 的最顶上。
 */
declare const globalThis: any;

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

export {};
