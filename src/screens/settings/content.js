/**
 * 设置页的**纯数据**（可在 Node 里断言）。
 *
 * ⚠⚠ 2026-10-21 用户要求「设置页面这些东西很多余」⇒ 一口气删掉：
 *   · 三张说明卡（`排盘引擎` / `晚子时` / `数据与隐私`）
 *   · 「清除本机缓存」那一行（连 `CLEAR_*` 文案）
 *   · 「开源组件」那一行（`tyme4ts` 的版本号）
 *   现在只剩：**版本行 + 账号那一区 + 页脚**。
 *
 * ⚠ 别再加回来。它们当初是为了解释「数据存在哪、排盘口径是什么」，
 *   但那些信息属于**真正用到它的地方**（记录页空态、结果页），
 *   堆在设置里既没人看，又得跟着后端每次换代改一遍文案（历史上已经改错三次）。
 *
 * ⚠ 账号那几行**不能删**：未登录要有「登录」入口，已登录要有账号名 + 「退出登录」。
 */
const VERSION = '1.0.0';

/** 设置卡里的信息行（账号 / 退出登录那几行不在这里 —— 它们要绑事件） */
const INFO_ROWS = [
  { id: 'version', label: '版本', value: 'v' + VERSION }
];

const FOOTER = '本工具仅用于传统历法文化学习，不构成任何建议';

/* ------------------------------------------------------------ 账号那一区 */

/** 已登录时的行标签（值显示账号名；账号本身就是小写短串且不含隐私，无需掩码） */
const ACCOUNT_LABEL = '账号';
/** 未登录时那一行的标签与右侧动作 */
const LOGIN_LABEL = '账号';
const LOGIN_ACTION = '登录';
const LOGGED_ACTION = '退出登录';

/** 退出登录的二次确认 */
const LOGOUT_TITLE = '退出登录';
const LOGOUT_BODY = '退出后需要重新用账号密码登录才能看到云端记录，云端记录本身不会被删除。';

module.exports = {
  VERSION: VERSION,
  INFO_ROWS: INFO_ROWS,
  FOOTER: FOOTER,
  ACCOUNT_LABEL: ACCOUNT_LABEL,
  LOGIN_LABEL: LOGIN_LABEL,
  LOGIN_ACTION: LOGIN_ACTION,
  LOGGED_ACTION: LOGGED_ACTION,
  LOGOUT_TITLE: LOGOUT_TITLE,
  LOGOUT_BODY: LOGOUT_BODY
};
