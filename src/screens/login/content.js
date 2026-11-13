/**
 * 登录 / 注册页的**纯数据**（文案 / 常量）—— 与 model.js 一样不依赖 React / RN，
 * 所以纯 Node 的 screens-check 能直接 require 它并逐字断言。
 *
 * ⚠ 为什么文案要单独放一份：本项目已经吃过「重构扫尾没扫用户可见文案」的亏
 *   （设置页 n3 一度还在说「抖音云数据库」，而数据早在别处）。
 *   文案集中在这里，改后端 / 改口径时一眼能看到全部要跟着改的句子。
 *
 * ⚠ 这里**没有**任何「用户协议 / 隐私政策」链接 —— 本 App 没有这些页面，
 *   写一句「登录即表示同意《用户协议》」而点不开，比不写更糟。
 *
 * ============ ⚠⚠ 注册入口是**有条件**的，不是恒有 ============
 * 当前后端是**自建 paipan-server** ⇒ **支持**自助注册，所以有注册入口。
 * 但 CloudBase 那条路**平台禁死**（实测 `/auth/v1/signup` 只带 `{username,password}`
 *   回 `501 UNIMPLEMENTED: you can not signup just by username and password`）。
 * ⇒ 是否显示注册入口由 `auth.canSignUp()` 决定，**不能**写死。
 *   显示了而点不通，比不显示更糟；不显示而其实能用，用户会找不到入口。
 *   底部那句 `NO_SIGNUP_TIP` 与注册入口**互斥**：能注册时不说那句，
 *   不能注册时才必须说（用户找不到注册按钮时得有人告诉他账号从哪来）。
 */

/** 导航栏标题（App.tsx 用；与各页 json 的 navigationBarTitleText 同级） */
const TITLE = '登录';

const HEAD_TITLE = '账号登录';
const HEAD_SUB = '登录后，换手机或重装 App 依然能看到你的排盘记录。';

/** 注册态下的标题（同一个页面，两个面貌） */
const HEAD_TITLE_SIGNUP = '注册新账号';
const HEAD_SUB_SIGNUP = '注册后记录会存在你自己的账号里，换手机登录同一个账号就能看到。';

const USERNAME_LABEL = '账号';
const USERNAME_PLACEHOLDER = '请输入账号';
/** 注册态下账号框的占位 —— 明确告诉他规则，省得提交后被拒 */
const USERNAME_PLACEHOLDER_SIGNUP = '字母开头，6~25 位';

const PASSWORD_LABEL = '密码';
const PASSWORD_PLACEHOLDER = '请输入密码';
/** 注册态下密码框的占位 —— 必须写清最短长度，否则用户会拿 3 位密码撞一次 400 */
const PASSWORD_PLACEHOLDER_SIGNUP = '至少 6 位';

/** 注册态下的确认密码（防手滑打错，打错了下次登不上且谁都查不出来） */
const CONFIRM_LABEL = '确认密码';
const CONFIRM_PLACEHOLDER = '再输一次';

/**
 * 「记住密码」勾选框的文案。
 *
 * ⚠ 它只管**密码**：账号名永远留着（那半句本来就该省掉用户的事）。
 *   所以别写成「记住账号密码」—— 那样用户取消勾选时会以为账号名也会被忘掉。
 *
 * ⚠ 两个形态（登录 / 注册）**都显示**它，别只在登录态显示：
 *   注册成功即是登录态，那时同样会写这份记录；勾选框藏起来 = 用户
 *   在不知情的情况下被存了密码（他明明没勾过任何东西）。
 */
const REMEMBER_LABEL = '记住密码';

/** 「登录」按钮的三种面孔 */
const SUBMIT = '登录';
const SUBMIT_BUSY = '登录中…';
const SUBMIT_DONE = '登录成功';

/** 「注册」按钮的三种面孔 */
const SUBMIT_SIGNUP = '注册';
const SUBMIT_SIGNUP_BUSY = '注册中…';
const SUBMIT_SIGNUP_DONE = '注册成功';

/**
 * 账号格式的实时提示（用户还在输入时就告诉他哪里不对，别等点了登录才报）。
 * ⚠ 三条覆盖三种不同的错法 —— 合成一句「账号格式不对」的话，
 *   用户不知道该往哪个方向改。
 */
const HINT_USERNAME_SHORT = '账号至少要 6 位';
const HINT_USERNAME_LONG = '账号最多 25 位';
const HINT_USERNAME_CHARS = '账号只能用字母、数字、- 和 _，且要以字母开头';

/** 密码太短的提示（只在**注册**态给 —— 登录态下密码长度是既有事实，提示它没意义） */
const HINT_PASSWORD_SHORT = '密码至少要 6 位';

/**
 * 两次密码不一致的提示。
 * ⚠ 必须**实时**给：等到点了注册才说，用户已经白填一遍了（而且服务端只关心第一个框）。
 */
const HINT_CONFIRM_MISMATCH = '两次输入的密码不一样';

/**
 * 失败兜底文案 —— 正常情况下 auth / sdk 已经给出中文错误，
 * 这句只在「连错误对象都没有」时用（比如调用方漏传结果）。
 */
const LOGIN_FAIL = '登录失败，请稍后重试';
const SIGNUP_FAIL = '注册失败，请稍后重试';

/**
 * 底部的账号来源说明。
 * ⚠⚠ 这句只在**不能自助注册**时才显示（CloudBase 那条路），与注册入口互斥。
 *   见文件头。
 */
const NO_SIGNUP_TIP = '账号由管理员创建，本 App 暂不支持自助注册';

/** 注册态底部的切换提示（可点，切回登录） */
const TO_SIGNUP_TIP = '还没有账号？去注册';
const TO_LOGIN_TIP = '已有账号？去登录';

/**
 * 页脚免责声明。
 * ⚠⚠ **从设置页取，别在这儿再抄一遍** —— 抄一份的下场是两页文案慢慢漂移，
 *   而 screens-check 恰好有一条「登录页与设置页的页脚一致」在守它
 *   （重写本文件时就踩过：手抄成「传统历法学习」，少了「文化」两个字）。
 */
const FOOTER = require('../settings/content.js').FOOTER;

module.exports = {
  TITLE: TITLE,
  HEAD_TITLE: HEAD_TITLE,
  HEAD_SUB: HEAD_SUB,
  HEAD_TITLE_SIGNUP: HEAD_TITLE_SIGNUP,
  HEAD_SUB_SIGNUP: HEAD_SUB_SIGNUP,
  USERNAME_LABEL: USERNAME_LABEL,
  USERNAME_PLACEHOLDER: USERNAME_PLACEHOLDER,
  USERNAME_PLACEHOLDER_SIGNUP: USERNAME_PLACEHOLDER_SIGNUP,
  PASSWORD_LABEL: PASSWORD_LABEL,
  PASSWORD_PLACEHOLDER: PASSWORD_PLACEHOLDER,
  PASSWORD_PLACEHOLDER_SIGNUP: PASSWORD_PLACEHOLDER_SIGNUP,
  CONFIRM_LABEL: CONFIRM_LABEL,
  CONFIRM_PLACEHOLDER: CONFIRM_PLACEHOLDER,
  REMEMBER_LABEL: REMEMBER_LABEL,
  SUBMIT: SUBMIT,
  SUBMIT_BUSY: SUBMIT_BUSY,
  SUBMIT_DONE: SUBMIT_DONE,
  SUBMIT_SIGNUP: SUBMIT_SIGNUP,
  SUBMIT_SIGNUP_BUSY: SUBMIT_SIGNUP_BUSY,
  SUBMIT_SIGNUP_DONE: SUBMIT_SIGNUP_DONE,
  HINT_USERNAME_SHORT: HINT_USERNAME_SHORT,
  HINT_USERNAME_LONG: HINT_USERNAME_LONG,
  HINT_USERNAME_CHARS: HINT_USERNAME_CHARS,
  HINT_PASSWORD_SHORT: HINT_PASSWORD_SHORT,
  HINT_CONFIRM_MISMATCH: HINT_CONFIRM_MISMATCH,
  LOGIN_FAIL: LOGIN_FAIL,
  SIGNUP_FAIL: SIGNUP_FAIL,
  NO_SIGNUP_TIP: NO_SIGNUP_TIP,
  TO_SIGNUP_TIP: TO_SIGNUP_TIP,
  TO_LOGIN_TIP: TO_LOGIN_TIP,
  FOOTER: FOOTER
};
