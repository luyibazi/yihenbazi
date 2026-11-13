/**
 * 存储后端配置 —— **自建 paipan-server**（当前）/ CloudBase（保留）/ Gitee（已停用）/ 抖音云（备用）
 *
 * ============ 为什么换到自建后端（2026-10-03 用户拍板）============
 * CloudBase 那条路是通的，但有两个绕不过去的东西：
 *   ① **注册被平台禁死**（`/auth/v1/signup` 只给 {username,password} 回 501）⇒
 *      账号只能管理员在管控面手工建，用户自己注册不了。用户要的正是「能自己注册」。
 *   ② 环境是**体验版、2027-04-02 到期**，且要按 QPS 计费。
 * ⇒ 自建 `paipan-server`（Fastify + Node 内置 `node:sqlite`）之后：
 *   注册是我们自己提供的接口，账号想开就开；数据在自己电脑上；不花一分钱。
 *
 * ⚠ 三套驱动的**数据模型不一样**，不是换个地址那么简单：
 *   · gitee（文件级）：`userData/<uid>.json`，一个用户一个文件；
 *                      改一条 = 读全量 → 改内存 → **整份写回**。
 *                      于是必须守两条纪律：写前重读 sha、读失败绝不写。
 *   · cloud（记录级）：抖音云集合 `bazi_records`，一条记录一个文档。
 *   · cloudbase（记录级）：CloudBase 表 public.records，一条记录一行，
 *                      「只返回自己的数据」由 RLS 策略在数据库里保证。
 *   · local（记录级）：本地表 records，一条记录一行，列名是 `birth_date`/`created_ms`；
 *                      「只返回自己的数据」由**服务端从 JWT 取 uid** 保证
 *                      （请求体/路径里的 uid 一律被忽略）。
 * ⇒ 所以 store/index.js **不做统一抽象**，两条路各走各的实现，
 *   由 userStore.js 按 MODE 分支。硬套成一套接口会把「整份重写」这个
 *   最需要被看见的语义藏起来。
 */

/**
 * 存储后端：
 *   'local'     —— **自建 paipan-server**（记录级，当前）
 *   'cloudbase' —— 腾讯云开发（记录级，保留；全链路已验证可用）
 *   'gitee'     —— Gitee 私有仓库（文件级，保留但已停用）
 *   'cloud'     —— 抖音云（记录级，备用；小程序侧在用）
 */
const MODE = 'local';

/**
 * 本地后端地址 —— 只在 MODE='local' 时有效。
 *
 * ⚠⚠ 这是**局域网地址**，手机必须用这个（`127.0.0.1` 指向手机自己，必然连不上）。
 *   换 WiFi / 换电脑后 IP 会变，要跟着改这里。
 *   后端 `npm start` 时会把该填的那一行直接打印出来，照着抄即可。
 *
 * ⚠ 真正的连接参数在 core/localsdk.js 的 CONFIG.base ——
 *   那层是最底层，不该反过来依赖这份业务配置。这里只给设置页一个状态位/展示用。
 */
const LOCAL_URL = 'https://provided-tribal-saver-klein.trycloudflare.com';

/** 本地后端是否配置好了（给设置页显示状态用，**不要**用它做业务判断） */
const LOCAL_READY = !!LOCAL_URL;

/**
 * Gitee 配置。⚠ 真值在 utils/gitee.js 的 CONFIG（与 mingliWEB 同一套凭据）。
 * 这里只留一个「是否已配置」的判断给设置页显示状态用。
 */
const GITEE_READY = true;

/**
 * 抖音云环境 ID —— 在抖音开放平台「抖音云 → 环境管理」里创建环境后拿到。
 * 形如 'prod-xxxxxx'。留空则任何云操作都会如实报错。
 * 只在 MODE = 'cloud' 时才有意义。
 */
const CLOUD_ENV = '';

/**
 * CloudBase 是否已配置好。
 * ⚠ 真正的连接参数在 core/cbsdk.js 的 CONFIG（域名 / 环境 ID / Publishable Key）——
 *   那层是最底层，不该反过来依赖这份业务配置。这里只给设置页一个状态位。
 */
const CLOUDBASE_READY = true;

/** 走容器（云托管）还是云函数（只在 MODE='cloud' 时有效） */
const CLOUD_KIND = 'function';

/** 云函数名（只在 MODE='cloud' 时有效） */
const CLOUD_FUNCTION = 'bazi_store';

/** 当前后端是否已具备可用条件（给设置页显示状态用，**不要**用它做业务判断） */
function ready() {
  if (module.exports.MODE === 'gitee') return GITEE_READY;
  if (module.exports.MODE === 'cloud') return !!CLOUD_ENV;
  if (module.exports.MODE === 'cloudbase') return CLOUDBASE_READY;
  if (module.exports.MODE === 'local') return LOCAL_READY;
  return false;
}

/**
 * 拦下不识别的 MODE 值 —— 「以为数据在 A、其实写在 B」是最坏的一类问题。
 *
 * ⚠⚠ 必须读 `module.exports.MODE`，**不能**读上面那个模块内常量 MODE ——
 *   这是个真踩到的坑：测试和工具都是这样改 MODE 的：
 *       const storeMode = require('.../storeMode.js');
 *       storeMode.MODE = 'cloud';
 *   这种赋值改的是**导出对象上的属性**，模块内那个 const 一个字都不会变。
 *   于是守卫形同虚设（第一版写成读 const，自检直接报红抓出来了）。
 *
 * ⚠ 既然外部能这样改，就说明这层保护只覆盖**显式覆盖**的场景。
 *   真正可靠的是「代码里别写错值」—— 下面这句只是安全网，不是主防线。
 */
function assertUsableMode() {
  const current = module.exports.MODE;
  const OK = ['gitee', 'cloud', 'cloudbase', 'local'];
  if (OK.indexOf(current) < 0) {
    throw new Error(
      '存储后端配置有误：MODE = ' + JSON.stringify(current) +
      '，有效值只有 \'local\'（自建 paipan-server，当前）、' +
      '\'cloudbase\'（CloudBase 记录级）、' +
      '\'gitee\'（文件级，一个用户一个 json）和 \'cloud\'（抖音云记录级）。' +
      '请把 core/storeMode.js 的 MODE 改成其中之一。'
    );
  }
}

/** 存储模型是文件级还是记录级 —— 上层据此选正确的读写方式 */
function isFileLevel() {
  return module.exports.MODE === 'gitee';
}

/**
 * 当前后端**支不支持服务端筛选**。
 *
 * ⚠⚠ 只有自建后端（local）实现了 `GET /records?dayGan=…` 这套参数。
 *   CloudBase / cloud / gitee 三个驱动都没有 —— 它们只能拉全量。
 *   记录页据此决定「筛选项要不要给用户点」：
 *   不支持时**必须明确说**（而不是给一个点了没反应的按钮，
 *   那会让人以为「我筛了，只是恰好都符合」）。
 *
 * ⚠ 判据是 MODE 而**不是**「驱动对象上有没有那个方法」：
 *   驱动是 require 缓存的单例，用方法探测会把「将来补齐了」变成隐式行为，
 *   而这里需要的是一个**明确的产品决定**（哪个后端支持）。
 */
function supportsFilter() {
  return module.exports.MODE === 'local';
}

/**
 * 当前后端**有没有「学堂 · 书籍」数据**（`GET /books/bookmarks`）。
 *
 * ⚠⚠ 只有自建后端（local）有 —— 书籍是「**这台电脑上的文件夹**」，
 *   登记在本地库的 folders 表里；CloudBase / 抖音云 / Gitee 三个驱动
 *   根本没有这个概念。
 *   学堂页据此决定：不支持时**如实说明**，而不是发一个必然 404 的请求
 *   再给用户看「加载失败」（那会让人以为接口坏了、反复重试）。
 *
 * ⚠ 与 supportsFilter 同一纪律：判据是 MODE，不做方法探测 ——
 *   这是一个**明确的产品决定**（哪个后端提供这个能力）。
 */
function supportsBooks() {
  return module.exports.MODE === 'local';
}

/**
 * 当前后端**有没有在线心跳 + 指令下发**（`POST /presence/ping`）。
 *
 * ⚠⚠ 同样只有自建后端（local）有 —— 那个接口要服务端**维护挂起的连接**
 *   （`paipan-server/src/lib/presence.ts` 的等待者注册表），
 *   CloudBase / 抖音云 / Gitee 三个驱动都是「请求-响应」模型，没有这个概念。
 *
 * ⚠ 与 supportsFilter / supportsBooks 同一纪律：判据是 MODE，不做方法探测；
 *   不支持时调用方（core/presence.js 的 start）**如实不启动**，
 *   而不是发一个必然 404 的请求再让用户看「心跳失败」。
 */
function supportsPresence() {
  return module.exports.MODE === 'local';
}

/**
 * 当前后端**有没有「师傅批字」**（`/records/:id/comments`）。
 *
 * ⚠⚠ 同样只有自建后端（local）有 —— 批字是挂在 records 上的一张 `comments` 表
 *   （见 paipan-server/src/db/schema.sql），会话的锚点就是那条记录本身。
 *   CloudBase / 抖音云 / Gitee 三个驱动都没有这个概念。
 *
 * ⚠ 与 supportsFilter / supportsBooks / supportsPresence 同一纪律：
 *   判据是 MODE，不做方法探测；不支持时调用方**如实说明**，
 *   而不是发一个必然 404 的请求再让用户看「加载失败」。
 */
function supportsComments() {
  return module.exports.MODE === 'local';
}

/**
 * 当前后端支不支持**求测单**（「发起求测 → 管理端接单 → 接单人会话」）。
 *
 * ⚠ 与 supportsComments 同一条判据（都只有自建后端有）——
 *   但它们**是两件事**，刻意分成两个函数：求测单是 requests 表，
 *   会话是 comments 表；将来若某一端只支持其中一个，调用方不必跟着改。
 *
 * ⚠ 「发起求测**不是**发一条聊天消息」（用户拍板）：它落的是 requests 一行，
 *   **不写 comments**。所以「支持批字」不等于「支持求测」——
 *   这正是不能把它俩合并成一个 supportsFn 的理由。
 */
function supportsRequests() {
  return module.exports.MODE === 'local';
}

/**
 * 当前后端**有没有「自定义标签」**（`/tags` + `PUT /records/:id/tag`）。
 *
 * ⚠⚠ 同样只有自建后端（local）有 —— 标签是两张表（`tags` + `record_tags`，
 *   见 paipan-server/src/db/schema.sql）加一套接口；
 *   CloudBase / 抖音云 / Gitee 三个驱动都没有这个概念。
 *
 * ⚠ 与 supportsFilter / supportsComments / supportsRequests 同一条纪律：
 *   判据是 MODE，不做方法探测；不支持时调用方**如实说明**，
 *   而不是让用户点一个必然 404 的按钮、再看一句「加载失败」。
 *
 * ⚠ 它与 supportsFilter **是两个能力**，虽然目前同真同假：
 *   标签栏的筛选（`?tagId=`）走的是 records 的筛选参数，
 *   而标签本身的增删改是另一套接口 —— 将来若某一端只支持其中一个
 *   （比如某个后端能按标签筛、但不能建标签），调用方不必跟着改。
 */
function supportsTags() {
  return module.exports.MODE === 'local';
}

module.exports = {
  MODE: MODE,
  GITEE_READY: GITEE_READY,
  CLOUD_ENV: CLOUD_ENV,
  CLOUD_KIND: CLOUD_KIND,
  CLOUD_FUNCTION: CLOUD_FUNCTION,
  CLOUDBASE_READY: CLOUDBASE_READY,
  LOCAL_URL: LOCAL_URL,
  LOCAL_READY: LOCAL_READY,
  ready: ready,
  isFileLevel: isFileLevel,
  supportsFilter: supportsFilter,
  supportsBooks: supportsBooks,
  supportsPresence: supportsPresence,
  supportsComments: supportsComments,
  supportsRequests: supportsRequests,
  supportsTags: supportsTags,
  assertUsableMode: assertUsableMode
};
