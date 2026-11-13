/**
 * 登录 / 注册页的**纯计算层** —— 不 import 任何 React / RN 东西，可在纯 Node 里断言。
 *
 * ============ 为什么要拆出来 ============
 * 这一页真正的难点不是画得对不对，而是几件**埋在 setState 里的分支**：
 *   ① 用户粘进来的账号名五花八门（带首尾空格、手输了大写），必须先清洗；
 *   ② 按钮什么时候禁用 —— 两个框都填了吗？账号格式合法吗？正在提交吗？
 *      **注册态还多一条：两次密码必须一致**；
 *   ③ 用户**还在输入的时候**该给哪一句提示（太短 / 太长 / 字符不对 / 两次不一致），
 *      而且**空输入不算错**（刚进页面就飘红是最讨嫌的一种设计）；
 *   ④ 服务端错误 → 界面文案。
 *
 * ============ ⚠⚠ 两个形态（登录 / 注册），规则刻意不同 ============
 *   · **登录**：密码长度**不做前端校验**。它是既有事实 —— 服务端怎么存的就怎么验。
 *     在这里加一条「至少 6 位」，会把「早期用短密码注册的老账号」永久锁在门外，
 *     而报出来的错是「密码太短」（前端拦的），用户永远想不到是 App 变了。
 *   · **注册**：必须校验密码长度（服务端 PASSWORD_MIN=6）、且必须**两次一致**。
 *     不一致要在**提交前**就告诉他，否则白填一遍。
 *
 * ⚠⚠ 用户名 / 密码规则**只认 SDK 那一份**（`localsdk.USERNAME_RE` / `PASSWORD_MIN`）。
 *   千万别在这里重写一遍正则 —— 两套规则一旦漂移，
 *   表现就是「前端放行、服务端 400」，用户拿到一句他永远改不动的提示。
 */
const localsdk = require('../../core/localsdk.js');
const content = require('./content.js');

/** 两种形态 */
const MODE_LOGIN = 'login';
const MODE_SIGNUP = 'signup';

/**
 * 输入框的防呆上限。
 * ⚠ 它**不是业务规则**（业务规则是 6~25 位，由 SDK 判），
 *   只是拦住「用户误粘贴一整篇文章」这种极端情况。
 *   ⇒ 故意取得比 25 大得多，这样正常的「超长」输入仍会走到
 *     HINT_USERNAME_LONG 那条提示，而不是被悄悄截断成“看起来合法”的值。
 */
const INPUT_MAX = 64;

/**
 * 清洗账号输入：去首尾空格 + 转小写。
 * ⚠ 转小写是**故意**的：服务端的规则只认小写（见 localsdk.normalizeUsername），
 *   用户把账号记成大写输入时，与其让他撞一次「用户名或密码不对」，
 *   不如直接归一化 —— 账号本来就是它。
 * ⚠ **不截断到 25 位**（理由见 INPUT_MAX）。
 */
function usernameInput(raw) {
  return localsdk.normalizeUsername(raw).slice(0, INPUT_MAX);
}

/**
 * 清洗密码输入：**只限长，绝不 trim / 不改大小写 / 不过滤字符**。
 * ⚠⚠ 密码是逐字有效的 —— 顺手 `.trim()` 会把「用户密码结尾真有个空格」
 *   变成永远登不上，而且报的是「用户名或密码不对」，谁都查不出来。
 *   确认密码框走**同一个**函数，否则两次输入会被清洗成不同的值。
 */
function passwordInput(raw) {
  return String(raw == null ? '' : raw).slice(0, INPUT_MAX);
}

/** 账号是否合法（规则只问 SDK） */
function isUsername(raw) {
  return localsdk.usernameOk(raw);
}

/** 密码是否够长（**只用于注册**；登录态下不校验长度，理由见文件头） */
function passwordLongEnough(raw) {
  return passwordInput(raw).length >= localsdk.PASSWORD_MIN;
}

/** 两次密码是否一致（**只用于注册**） */
function passwordConfirmed(pw, confirm) {
  return passwordInput(pw) === passwordInput(confirm);
}

/**
 * 账号框下面那一行提示；没有问题（或还没开始输）时返回**空串**。
 *
 * ⚠ 三种错法分开说，别合成一句「账号格式不对」—— 那样用户不知道该往哪改。
 * ⚠ 空输入返回空串，不是错误提示。
 */
function usernameHint(raw) {
  const u = usernameInput(raw);
  if (!u) return '';
  if (u.length < localsdk.USERNAME_MIN) return content.HINT_USERNAME_SHORT;
  if (u.length > localsdk.USERNAME_MAX) return content.HINT_USERNAME_LONG;
  if (!localsdk.usernameOk(u)) return content.HINT_USERNAME_CHARS;
  return '';
}

/**
 * 密码相关的实时提示；没有问题（或还没开始输）时返回**空串**。
 *
 * ⚠ 只在**注册**态给提示。登录态下密码长度是既有事实 ——
 *   在那儿提示「至少 6 位」等于告诉一个用老密码的人「你的密码不合规」，
 *   而他改不了（他不知道服务端存的是什么）。
 *
 * @param {string} mode MODE_LOGIN | MODE_SIGNUP
 */
function passwordHint(mode, password, confirm) {
  if (mode !== MODE_SIGNUP) return '';
  const p = passwordInput(password);
  if (!p) return '';
  if (p.length < localsdk.PASSWORD_MIN) return content.HINT_PASSWORD_SHORT;
  /* ⚠ 确认框为空时不报「不一致」—— 他还没输到那儿 */
  if (confirm && !passwordConfirmed(password, confirm)) return content.HINT_CONFIRM_MISMATCH;
  return '';
}

/**
 * 提交按钮这一帧的样子。
 *
 * ⚠ 提交中 / 已完成都要禁用 —— 只禁一个的话，用户能在请求还没回来时连点。
 *   登录是幂等的（顶多多一条会话），但**注册不是**：连点两次会撞
 *   服务端的重名检查（第二次 409），用户看到一句莫名其妙的「用户名已被占用」——
 *   而那正是他自己刚注册的。所以这个禁用对注册尤其重要。
 *
 * @param {Object} o { mode, username, password, confirm, submitting, done }
 * @returns {{disabled:boolean, label:string}}
 */
function submitStateOf(o) {
  const st = o || {};
  const mode = st.mode === MODE_SIGNUP ? MODE_SIGNUP : MODE_LOGIN;

  if (st.done) {
    return {
      disabled: true,
      label: mode === MODE_SIGNUP ? content.SUBMIT_SIGNUP_DONE : content.SUBMIT_DONE
    };
  }
  if (st.submitting) {
    return {
      disabled: true,
      label: mode === MODE_SIGNUP ? content.SUBMIT_SIGNUP_BUSY : content.SUBMIT_BUSY
    };
  }

  const base = isUsername(st.username) && !!String(st.password || '');
  let ready = base;
  if (mode === MODE_SIGNUP) {
    /* ⚠ 注册多两条：密码够长、两次一致。少一条都会让用户提交后被服务端拒，
       而那本该在按下按钮之前就拦住。 */
    ready = base && passwordLongEnough(st.password) && passwordConfirmed(st.password, st.confirm);
  }

  return {
    disabled: !ready,
    label: mode === MODE_SIGNUP ? content.SUBMIT_SIGNUP : content.SUBMIT
  };
}

/**
 * 提交结果 → 视图要用的形状。
 * ⚠ 失败时把服务端给的**中文**文案原样带出去
 *   （本地后端的错误本来就是中文，它比我们编的更具体，比如「这个用户名已经有人用了，换一个吧」），
 *   这里只在「连错误对象都没有」时才用兜底句。
 */
function resultOf(res, mode) {
  const isSignup = (mode === MODE_SIGNUP);
  if (!res || !res.ok) {
    const fallback = isSignup ? content.SIGNUP_FAIL : content.LOGIN_FAIL;
    return { ok: false, error: (res && res.error) || fallback };
  }
  return { ok: true };
}

/**
 * 切换形态时要清掉的东西。
 *
 * ⚠⚠ 为什么必须清：从「登录」切到「注册」时，上一个形态的**错误提示**还挂在屏幕上
 *   （比如「用户名或密码不对」），用户会以为**这次注册**也失败了 ——
 *   而其实他只是刚点了切换。切换是「换一件事做」，不是「把刚才那件做失败了」。
 * ⇒ 返回一份「该清空的字段」，由视图 setState（保持这里不碰 React）。
 *
 * ⚠ 密码**一并清掉**：登录失败多半是密码不对，带进注册态只会让他带着错密码去注册。
 *   账号名**留着** —— 那个多半是对的，让他重打一遍是纯粹的折磨。
 */
function switchState(to) {
  const mode = to === MODE_SIGNUP ? MODE_SIGNUP : MODE_LOGIN;
  return {
    mode: mode,
    password: '',
    confirm: '',
    submitting: false,
    done: false,
    error: '',
    notice: ''
  };
}

module.exports = {
  MODE_LOGIN: MODE_LOGIN,
  MODE_SIGNUP: MODE_SIGNUP,
  INPUT_MAX: INPUT_MAX,
  usernameInput: usernameInput,
  passwordInput: passwordInput,
  isUsername: isUsername,
  passwordLongEnough: passwordLongEnough,
  passwordConfirmed: passwordConfirmed,
  usernameHint: usernameHint,
  passwordHint: passwordHint,
  submitStateOf: submitStateOf,
  resultOf: resultOf,
  switchState: switchState
};
