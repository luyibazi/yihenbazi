/**
 * 排盘页的**纯计算层** —— 不 import 任何 React / RN 东西，可在纯 Node 里断言。
 *
 * ============ 从 paipan/pages/paipan/paipan.js 拆出来的三件事 ============
 *   ① `applyCloud` —— boot 的结果 → 「云端」那一行的界面状态（四态映射）
 *   ② `syncDt`     —— 真值 (date, time) + 当前历法 → 出生时间那一行的文案 + 提示
 *   ③ `applyGzPick`—— 反查候选 → 写回真值 + 四柱显示文本
 *
 * ⚠ 这三件都是「纯映射」，正是最容易写成『if 漏一档 / 文案抄错』的地方，
 *   而它们本来被埋在 setData 调用里，不上模拟器根本验不了。拆出来就能断言。
 *
 * ⚠⚠ 「四柱」是**输入方式**，不是一种历法口径：反查出来的仍然是公历日期，
 *   所以 syncDt 里要把它降级成 'solar' 再算文案。
 */
const dp = require('../../core/datepick.js');

/** 三种历法 / 输入方式 */
const CALENDARS = ['solar', 'lunar', 'sizhu'];

/**
 * boot 的结果 → 「云端」那一行的界面状态。
 * @returns {{state:'ok'|'skip'|'fail', text:string}}
 */
function cloudStateOf(res) {
  if (res && res.ok) return { state: 'ok', text: '云端已就绪' };
  if (res && res.reason === 'no-identity') {
    // 登录是好的，只是这个登录态里没有任何能当标识的凭证 → 静默跳过
    return { state: 'skip', text: '' };
  }
  return { state: 'fail', text: '云端同步失败' };
}

/**
 * 出生时间那一行 + 农历换算提示（由真值 + 当前历法算出来）。
 *
 * ⚠ 「四柱」降级成公历算文案（见文件头）：反查回来就是公历日期，文案按公历算才对得上。
 *
 * ⚠⚠ 这行 `sizhu → solar` 今天是**行为上的等价改写**，不是防崩（实测过）：
 *   core/datepick.js 的 resolve / clampIndex / dayValues 都显式写成
 *   `cal === 'lunar' ? 'lunar' : 'solar'`，任何非 'lunar' 的值都自然落进公历那一支 ——
 *   所以直接传 'sizhu' 进去，出来的也是公历文案。
 *   留着它的理由是「别让未知值继续往里传」：datepick 只认两种口径（这是它的契约），
 *   这里先把第三档收敛掉，将来 datepick 加校验抛错时也不会被误伤。
 *   ⇒ 别把「去掉它」当成**能测出来**的 bug —— 测不出来（负向验证里这条漏过，已记录）。
 *
 * @param {string} calendar solar | lunar | sizhu
 * @param {string} date 公历日期 YYYY-MM-DD（**永远**是公历真值）
 * @param {string} time HH:mm
 * @returns {{text:string, hint:string}}
 */
function dtOf(calendar, date, time) {
  const cal = calendar === 'sizhu' ? 'solar' : calendar;
  const pr = dp.resolve(dp.fromSolar(date, time, cal));
  return { text: pr.text, hint: pr.hint };
}

/** 换了历法只换「怎么选、怎么显示」——真值 date/time 一个字节都不动 */
function switchCalendar(calendar) {
  return CALENDARS.indexOf(calendar) >= 0 ? calendar : null;
}

/**
 * 反查候选被选中 → 写回真值 + 四柱显示文本。
 *
 * 之后走的就是普通排盘那条路：反查里精验用的就是排盘同一个入口
 * （SolarTime → LunarHour → EightChar），所以「查得到」必定「排得出同样的四柱」。
 *
 * @param {{date:string, time:string, pillars:Object}} pick
 * @returns {{date:string, time:string, pillars:Object, pillarsText:string, notice:string}}
 */
function applyGzPick(pick) {
  const d = pick || {};
  const p = d.pillars || {};
  const date = d.date || '';
  const time = d.time || '';
  return {
    date: date,
    time: time,
    pillars: p,
    // ⚠ 顺序是年 月 日 时（与四柱表的列序一致），别写成 day month year
    pillarsText: [p.year, p.month, p.day, p.hour].join(' '),
    notice: '已填入 ' + date + ' ' + time
  };
}

/**
 * 排盘前的闸门：拿不到可用用户标识就不该排。
 *
 * 排盘本身是纯计算、不需要网络，但**保存记录**要写云端文件，
 * 而文件名由 uid 决定 —— 所以这里要的是「此刻真实有效的标识」，
 * 不是「登录过」。本机登录态可能刚过期、或只有 code 还没设备码。
 *
 * @param {Object|null} who boot.whoami({fresh:true}) 的结果
 * @returns {{ok:boolean, notice:string}}
 */
function gateOnIdentity(who) {
  // ⚠ 要的是「此刻真实有效的标识」，不是「登录过」——
  //   光有 who 对象、但里面没有可用的 uid，照样不许排（文件名由 uid 决定）。
  if (!who || !who.uid) {
    return { ok: false, notice: '登录后才能排盘' };
  }
  return { ok: true, notice: '' };
}

module.exports = {
  CALENDARS: CALENDARS,
  cloudStateOf: cloudStateOf,
  dtOf: dtOf,
  switchCalendar: switchCalendar,
  applyGzPick: applyGzPick,
  gateOnIdentity: gateOnIdentity
};
