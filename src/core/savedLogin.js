/**
 * 「记住账号密码」—— 本机记住**上一次登录成功**的那一对，下次打开登录页自动填上。
 *
 * ============ 为什么值得单独一层 ============
 * 两个理由，都不是「好看」：
 *   ① 登录页要用它（读 + 写），但登录页是 .tsx、被 React 包着 ——
 *      存取逻辑留在这里就能**纯 Node 断言**（tests/local-check.js），
 *      不用为了验一段读写去起一个渲染环境。
 *   ② 它跟 `session.js` 长得像但**职责完全不同**，见下面那条红线。
 *
 * ============ ⚠⚠⚠ 红线一：账号名必须**自己存一份**，不能指望 session ============
 * `session` 里也有一份 username，但那是**登录态的一部分**：
 * `auth.logout()` → `session.clear()` ⇒ 退出登录那一瞬间它就没了。
 *
 * 而用户明确要的恰恰是「**退出登录之后**，登录页上的账号密码还在，
 * 点一下登录就能登回来」—— 靠 session 那份必然做不到（退出即丢）。
 * ⇒ 这个键**独立于登录态**：登录态清了它也不动，只有用户**取消勾选**才清密码。
 *
 * ============ ⚠⚠ 红线二：只在**登录成功**之后写 ============
 * 绝不能在用户敲键盘时顺手存 —— 输错密码是家常便饭，
 * 把错密码存下来，下次他点「登录」会撞一句「用户名或密码不对」，
 * 而他**确信自己没改过任何东西**（因为输入框里的字是他上次留的）。
 * 那种 bug 排查起来极其熬人：两边日志都正常，密码就是不对。
 * ⇒ 写入口只有 `save()` 一处，调用点只有登录页 `.then(r.ok)` 那一个分支。
 *
 * ============ ⚠ 红线三：不勾 = 删掉，不是「留着不给看」 ============
 * `remember === false` 时会把存储里的密码**擦成空串**。
 * 留着它只是「读的时候不返回」，那叫藏，不叫不记 —— 手机上多躺一份明文密码，
 * 而用户以为自己已经关掉了这个功能。
 *
 * ============ 默认值：**默认勾上** ============
 * 没记过（首次安装 / 勾选框被关掉过）时 `remember` 回 **true**。
 * 这是用户明确要的行为：「手机要有记录账号密码的功能」。
 *
 * ============ 明文存储的边界（知情选择，不是疏忽）============
 * 这里存的是**明文**（与本项目其它凭据同一条路：`platform/storage.js`
 * → AsyncStorage / 本机文件）。安全模型是一致的：**能解锁这台手机的人，
 * 本来也能拿到同一目录里的登录令牌**，藏住密码并不会让局面变好。
 * 要真加密得引入 `expo-secure-store`（Keychain / Keystore）—— **现在不引**：
 * 为一个自用 App 多背一个原生依赖不划算。哪天要给别人用，第一件事是换掉这里。
 *
 * ============ 坏数据不许把启动路径搞崩 ============
 * 登录页在**启动路径**上（未登录是常态）。这里任何异常都必须吞掉并退回默认值 ——
 * 抛出去就是白屏，而原因只是某次写入被打断留下半截 JSON。
 * （同一条纪律见 session.js 的 read()。）
 */
const storage = require('../platform/storage.js');

/** 本机存储键 —— 与 session / anon 各自独立，互不覆盖 */
const KEY = 'paipan_saved_login_v1';

/**
 * 防御性长度上限。
 * ⚠ 正常路径上的值**已经被截过**了（登录页的 model.INPUT_MAX = 64 先清洗过一遍），
 *   这里再限一次是防「存储被手改 / 被将来的代码写歪」。两者同值，但**不是同一个常量**：
 *   core 不能 require 页面层（依赖方向是页面 → core，反过来会成环）。
 */
const MAX = 64;

/** 任意值 → 干净字符串（非字符串一律当空） */
function str(v) {
  return typeof v === 'string' ? v.slice(0, MAX) : '';
}

/** 读原始记录。任何异常 → null（绝不抛，见文件头） */
function readRaw() {
  try {
    const raw = storage.getStorageSync(KEY);
    if (!raw) return null;
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch (err) {
    console.warn('[paipan] 读取记住的账号密码失败', err);
    return null;
  }
}

/**
 * 写回一条记录（内部统一出口，顺带把不变量钉死）。
 * ⚠⚠ 不变量：**`remember === false` ⇒ `password` 一定是空串**。
 *   放在这里而不是各个调用点，是为了「新加一个写入口时自动守规矩」。
 */
function write(username, password, remember) {
  const on = remember !== false;
  const next = {
    username: str(username),
    password: on ? str(password) : '',
    remember: on
  };
  try {
    storage.setAndPersist(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[paipan] 写入记住的账号密码失败', err);
  }
  return next;
}

/**
 * 登录页打开时读一次，拿它当三个输入框 / 勾选框的**初始值**。
 *
 * @returns {{username:string, password:string, remember:boolean}}
 *          没记过 → `{ username:'', password:'', remember:true }`（默认勾上）
 */
function load() {
  const o = readRaw();
  if (!o) return { username: '', password: '', remember: true };
  const remember = o.remember !== false;
  return {
    username: str(o.username),
    /* ⚠ 读的时候也把不变量守一道（与 write 同一份规则）。
       存储是本机文件，可能被手改、也可能被将来的代码写歪 ——
       那时候**读**是最后一道闸，光靠写侧守不住历史数据。
       这不算「两套真相」：两边判的是同一条不变量，且都是往「更安全」的方向归一。 */
    password: remember ? str(o.password) : '',
    remember: remember
  };
}

/**
 * 登录 / 注册**成功之后**调（见文件头红线二）。
 * 未勾选时不写密码，**并且把以前存过的那份擦掉**。
 *
 * @param {{username:string, password:string, remember:boolean}} o
 * @returns {{username:string, password:string, remember:boolean}} 实际落盘的内容
 */
function save(o) {
  const d = o || {};
  return write(d.username, d.password, d.remember);
}

/**
 * 勾选框被点了一下。
 * ⚠ 关掉时**立刻擦掉已存的密码**（用户按下「不记住」的当刻就该生效，
 *   而不是等他下次登录成功才生效 —— 那中间这段时间密码还躺在手机里）。
 * ⚠ 开的时候**只改标志**，不动密码：此刻多半还没有新密码要存，
 *   真正写入要等登录成功。
 */
function setRemember(on) {
  const prev = readRaw() || {};
  const flag = on !== false;
  return write(prev.username, flag ? prev.password : '', flag);
}

module.exports = {
  KEY: KEY,
  MAX: MAX,
  load: load,
  save: save,
  setRemember: setRemember
};
