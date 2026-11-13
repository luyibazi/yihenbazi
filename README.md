# paipan-app —— 跨平台 App（React Native + Expo）

> 由抖音小程序 `paipan/` 迁移而来。技术方案见 `../paipan/docs/app-migration-plan.md`。
> 当前进度：**阶段 0（风险验证）✅ / 阶段 1（三个核心组件）✅ / 阶段 2（4 个页面 + tab）✅ /
> 阶段 3（接本地后端 + 登录注册 + 阅读页 + 师傅批字骨架）✅**；下一步见文末「下一步」。
> 目标运行时：**Expo SDK 57 / RN 0.86 / React 19.2.3**（2026-10-02 从 SDK 51 升级，为对齐 iOS Expo Go）。

---

## 现在能跑的

```bash
cd paipan-app

npm test                      # 全部十个套件（全绿：0 失败）
# 或分开跑：
node tools/run.js tests/test.js              # 算法套件（从原项目移植，只改了 require 路径）
node tools/run.js tests/logic-check.js       # 阶段 0 逻辑自检
node tools/run.js tests/chart-view-check.js  # ChartView 计算层（三级联动 / 事件记录落点）
node tools/run.js tests/wiring-check.js      # 组件接线（三个组件的调用序列）
node tools/run.js tests/gitee-check.js       # Gitee 存储驱动（休眠中，仍守着契约）
node tools/run.js tests/session-check.js     # 会话 / 登录态 / 记住账号密码
node tools/run.js tests/screens-check.js     # 页面与组件（含源码级结构断言）
node tools/run.js tests/cloudbase-check.js   # CloudBase 驱动（休眠中，仍守着契约）
node tools/run.js tests/local-check.js       # 本地后端驱动（store 层 + 师傅批字）
node tools/run.js tests/node-resolution-check.js  # 依赖 / 脚本 / 存储落盘的守卫
```

⚠ **这些都是纯 Node 跑的，不需要装 Expo 依赖** —— 这是有意设计的：
把「能算对」和「能画对」拆开验，前者不需要模拟器。

| 套件 | 结果 |
|---|---|
| `tests/test.js` | **307 PASS / 0 FAIL** |
| `tests/logic-check.js` | **16 PASS / 0 FAIL** |
| `tests/chart-view-check.js` | **108 PASS / 0 FAIL** |
| `tests/wiring-check.js` | **300 PASS / 0 FAIL** |
| `tests/gitee-check.js` | **50 PASS / 0 FAIL** |
| `tests/session-check.js` | **177 PASS / 0 FAIL** |
| `tests/screens-check.js` | **1211 PASS / 0 FAIL** |
| `tests/cloudbase-check.js` | **254 PASS / 0 FAIL** |
| `tests/local-check.js` | **521 PASS / 0 FAIL** |
| `tests/node-resolution-check.js` | **34 PASS / 0 FAIL** |

（后端另有冒烟套件，是 `paipan-server/tools/smoke.ts`，跑法见它的 README。）

---

## 阶段 0 的结论：算法层**零改动**可用

`src/core/` 的 11 个文件是从 `paipan/utils/` **直接拷过来的，一个字节都没改**：

```
src/core/bazi.js  chart.js  lunar.js  terms.js  time.js
        sizhu.js record.js notes.js  datepick.js gzstep.js
src/vendor/tyme.js
```

`tests/test.js` 的移植也**只改了 require 路径**（11 行），断言一条没动。
对拍结果：两侧均 287 PASS / 0 FAIL，**断言集合完全相同**。

```diff
- const chart = require('../utils/chart.js');
+ const chart = require('../src/core/chart.js');
- const tymeLib = require('../vendor/tyme.js');
+ const tymeLib = require('../src/vendor/tyme.js');
```

上面这个结论可以用工具重跑（`~/.workbuddy/skills/cross-platform-logic-migration/`）：

```bash
python <skill>/scripts/migrate.py verify ../paipan . --tests tests/test.js
```

---

## 阶段 1：三个核心组件

| 组件 | 原项目 | 本项目的做法 |
|---|---|---|
| `DatePicker` | 137 行 JS + 64 行 ttml + 234 行 ttss | `src/components/DatePicker.tsx`，逻辑全调 `core/datepick` |
| `GzPicker` | 177 + 120 + 391 | `src/components/GzPicker.tsx`，逻辑全调 `core/gzstep` |
| `ChartView` | 647 + 197 + 665 | `src/components/chart-view/` —— **拆成 model.js + ChartView.tsx** |

### ⭐ ChartView 为什么要拆

原项目把「算」和「渲染」混在一个 `Component` 里。搬到 RN 后如果继续混着，
**就没法在不启动模拟器的情况下验证联动逻辑** —— 而恰恰是联动逻辑最容易错：

- 大运 → 流年 → 流月 三级联动（哪一步选哪一列）
- 事件记录的 key 形状（流年/流月必须带父级下标，否则会串到别的十年）
- 选中运面板的「卡位固定」规则（流月未选中要填空壳，否则点一下整块宽度会抽）

所以：

```
src/components/chart-view/
├── model.js         ⭐ 原组件**所有纯函数**的逐行搬运（可 Node 直接跑）
└── ChartView.tsx    只管画 + 接手势
```

于是 `tests/chart-view-check.js` 能把这些语义全钉住（108 条断言）。

### 版式上的硬约束（改之前先读 `ChartView.tsx` 文件头）

| 约束 | 为什么 |
|---|---|
| `.page` / `.card` 左右 padding **必须 0** | 运程表可用宽 698rpx 是列宽 63rpx（一屏 11 列）的推导前提 |
| `.card` **直角无圆角** | 用户要求「结果页的背景都不要有圆角」（按钮除外） |
| `.pillar-cols` 定宽 420rpx | 给右侧选中面板留出确定余量 |
| `.sel-text` minHeight = 2 × 干支字号 × 行高 | 否则「起运前」占位卡与邻居不等高 |
| 三张表列宽**同一个 63rpx** | «大运 = 流年 = 流月» 的单项宽度必须完全一致 |
| 红点 `#e5342b` | 整屏米金/浅米色系里，红色是唯一跳得出来的强调色 |

### rpx 怎么办的

小程序 `750rpx` = 屏宽。RN 没有 rpx，所以：

```
src/theme/tokens.ts   设计稿的 rpx 原值（逐值可核对，不用心算）
src/theme/rpx.ts      rpx() / useRpx() 按当前屏宽运行时换算
```

好处：迁移对照可以逐值核对；屏宽变化（折叠屏 / 平板）时整块盘按比例缩放，
与小程序行为一致。⚠ 别把 `rpx()` 结果存进模块级常量 —— 屏宽在旋转时会变。

---

## 目录结构

```
paipan-app/
├── start.bat                   ⭐ 双击这个：一键启动 + 弹出二维码
├── App.tsx                     根组件：常驻 tab 页 + 推入层（登录 / 阅读 / 结果）+ 键盘避让
├── index.ts                    Expo 入口
├── src/
│   ├── core/                   ⭐ 算法层 + 数据层（**CommonJS**，禁 import React/RN）
│   │   ├── bazi/chart/lunar/sizhu/datepick/gzstep/terms/time.js   排盘与历法
│   │   ├── record.js/notes.js/history.js/boot.js                  轻记录 / 批注 / 启动装配
│   │   ├── auth.js/session.js/savedLogin.js/userStore.js          登录态与「记住账号密码」
│   │   ├── presence.js                                            心跳长轮询（收指令 / 强制下线）
│   │   ├── comments.js                                            师傅批字门面（newId/sorted/list/send）
│   │   ├── books.js/pillarFilter.js                               学堂与四柱筛选（纯逻辑）
│   │   ├── storeMode.js                                           网络分支唯一判据
│   │   └── store/                                                 localdb.js（本地后端）/ 其它驱动
│   ├── vendor/tyme.js          ⭐ tyme4ts v1.5.2（为何与 core 平级见下）
│   ├── platform/shim.ts        唯一的适配代码：给 Hermes 补 window
│   ├── theme/                  tokens.ts（rpx 原值）+ rpx.ts（换算）
│   ├── components/
│   │   ├── DatePicker.tsx / GzPicker.tsx      日期 / 四柱录入
│   │   ├── FilterModal.tsx                    四柱筛选弹层（记录页与学堂页共用）
│   │   ├── NavBar.tsx / KeyboardAvoid.tsx / Notice.tsx   系统 chrome / 键盘避让 / 通知条
│   │   └── chart-view/
│   │       ├── model.js        ⭐ 纯计算层（Node 可跑）
│   │       └── ChartView.tsx   渲染层
│   └── screens/                每页 = content/model（纯逻辑）+ 视图
│       ├── tabs/               底部 tab（排盘 / 记录 / 学堂 / 设置）
│       ├── paipan/ results/…   排盘页 / 结果页（结果页含**师傅批字**页签）
│       ├── records/ study/     记录页（筛选）/ 学堂页（查询=书签列表 · 书籍=书架）
│       ├── reader/             阅读推入层（**只有正文一条连续段落流**，按字数分片 + 上下双向懒加载；⚠ 2026-10-12 目录整块移除）
│       ├── login/ settings/    登录推入层 / 设置页
│       └── Screen.tsx          页面骨架
├── tools/
│   ├── run.js                 ⭐ 统一 Node 入口：绕过 PATH 顺序，挑对的 Node 跑目标
│   ├── setup-node.js          探测并写 .node-path（只读 process.version，零 spawn）
│   ├── check-node.js          启动前 Node 版本守卫
│   ├── qr.js                  生成可扫描的 SVG 二维码（浏览器打开）
│   ├── verify-qr.js           校验二维码结构（寻像图形 + 黑格占比）
│   ├── diagnose.js            ⭐ 真机连不上时跑这个：逐项体检并定位断在哪
│   ├── tunnel-qr.js           走公网隧道启动（绕开同 Wi-Fi 要求）
│   ├── fix-metro.js           修 metro 空壳包
│   ├── repair-modules.js      修 safe-delete 造成的残骸 / 嵌套包
│   └── _neg-*.js / _run-neg.sh ⭐ 负向验证注入器与驱动（改坏源码 → 确认断言真的会红）
├── .node-path                 由 npm run setup:node 生成（记录合格 node.exe 路径）
└── tests/                     见下一节「测试资产说明」（10 个套件，全走 tools/run.js）
```

### ⚠ 三个目录陷阱（都实际踩到了）

**1. `vendor/` 必须和 `core/` 平级，不能放在 `core/` 里面**

`core/*.js` 里写的是 `require('../vendor/tyme.js')`，这个路径是**从 core/ 往上跳一级**。

```
❌ 错：src/core/vendor/tyme.js   → require 解析到 src/vendor（不存在）
✅ 对：src/vendor/tyme.js        → require 解析到 src/vendor（存在）
```

**2. 相对路径要数清「往上几级」**

`src/components/chart-view/model.js` 要 require `src/core/` 下的东西：

```
❌ 错：require('../../src/core/x.js')   → src/components/src/core（不存在）
✅ 对：require('../../core/x.js')        → 从 chart-view 往上两级 = src/ → core/
```

（第一版就是错的，一 require 就 MODULE_NOT_FOUND。）

**3. 年份选项的「索引 ≠ 值」**

`core/time.js` 的标签函数返回**纯字符串数组**，索引到值的换算分两种：

| 函数 | 第 0 项 | 值 = |
|---|---|---|
| `solarMonthLabels(y)` | `'1月'` | 索引 |
| `solarDayLabels(y,m)` | `'1日'` | 索引 |
| `hourLabels()` | `'0时'` | 索引 |
| `minuteLabels()` | `'0分'` | 索引 |
| **`solarYearLabels()`** | **`'1000'`** | **索引 + `SOLAR_YEAR_MIN`(1000)** |

⚠ 这个坑被抓过**两次**：`logic-check.js`（年份算成 988）和 `wiring-check.js`（`pick()` 传了字面年份 1990 → 解出 2050）。

**规矩：绝不要自己算索引 —— 一律从 `view()` 给出的 `item.v` 里取。**

---

## 上真机（需要装依赖）

### ⚠ 先解决 Node 版本（最容易卡住的一步）

本机装了**两个 Node**，而 PATH 里排第一的是旧的那个：

| 路径 | 版本 | 能用吗 |
|---|---|---|
| `E:\nodejs\node` | **v18.19.0** | ❌ 太老 |
| `C:\Users\luerse\.workbuddy\binaries\node\versions\22.22.2-3\node.exe` | **v22.22.2** | ✅ |

用 v18 启动会崩，报错是这样的（**完全没提 Node 版本**，所以特别难查）：

```
Node.js (v18.19.0) is outdated and unsupported.
Please update to a newer Node.js LTS version (required: >=20.19.4)
...
TypeError: configs.toReversed is not a function
    at mergeConfig (.../metro-config/src/loadConfig.js:202:35)
```

**根因**：`Array.prototype.toReversed` 是 Node 20 才加的，v18 没有 → Metro 加载配置就炸。

**为什么「明明装了 v22 还是报 v18」**：报错判的是**启动 CLI 的那个 node**，
而 `npm start` 里的裸 `node` 走 PATH ⇒ 你终端里 `E:\nodejs` 排在前面 ⇒ 解析到 v18。
（我在自己的工作目录里跑没问题，因为那边 PATH 顺序相反 —— 所以「我这儿好的」不能证明「你那儿也好」。）

**已经修好了吗**：修好了，三层都堵上了：

| 层 | 做法 |
|---|---|
| `package.json` 所有脚本 | 由裸 `node` 改成走 `node tools/run.js`，由它挑合格的 Node |
| `start.bat` | 显式硬编码 v22（先读 `.node-path`，读不到用内置路径） |
| `prestart` 钩子 | 版本不对**提前拦下**并给出人话指引，不会走到 `toReversed` |

**推荐用法 —— 双击 `start.bat`**（唯一不依赖 PATH 顺序的入口）：

```bash
# 双击项目根目录的 start.bat
#   它显式用 v22 跑，不动系统设置，还会先跑一遍健康检查
```

想用命令行也可以，但要留意 **`npm` 本身也是走 PATH 的**：

```bash
npm run check:node     # 先体检：当前 node 够不够
npm run setup:node     # 自动探测并写 .node-path（之后 run.js 会读它）
npm start              # 脚本内部已改走 tools/run.js，不受 PATH 顺序影响
```

如果你确实想用 `npm start`，**根上的修法还是把 v22 提到 PATH 最前面**：
把 `C:\Users\luerse\.workbuddy\binaries\node\versions\22.22.2-3`
加到「系统环境变量 PATH」，并确保它排在 `E:\nodejs` 之前，改完重开终端。

> ⚠ 顺带一提：本机的沙箱**禁止 Node 去 spawn 子进程**（`spawnSync` 一律 `EBUSY`，
> 而且没有任何报错信息）。所以 `tools/setup-node.js` 和 `tools/diagnose.js`
> 都**只读 `process.version`、绝不探测别的 exe** —— 「另一个 node 是多少」
> 只能由外层 shell 拿那个 exe 去跑。这条约束在 `tools/run.js` 文件头有完整说明。

### 最简单：双击 `start.bat`

不需要懂命令，**双击项目根目录的 `start.bat`** 就行。它会依次：

1. 用正确的 Node（v22）启动
2. 检查 metro
3. 检查模块完整性
4. **在浏览器里打开一张二维码页面** ← 扫这个
5. 启动 Metro

⚠ **那个黑窗口不要关**，关了服务就停了。测完再关。

### 或者手动跑（在**你自己的终端**里，不要在 AI 环境里跑）

```bash
cd D:\aiProjecct\workbuddyApp\2026-09-30-01-22-47\paipan-app

npm install              # ① 装依赖（可能反复失败，见下）
npm run fix:metro        # ② 必跑：补 metro 空壳包
npm run fix:modules      # ③ 必跑：修 safe-delete 留下的残骸
npm run qr               # ④ 生成二维码并在浏览器打开
npm start                # ⑤ 启动 Metro
```

### ⚠ 为什么不用终端里的二维码

Expo 在终端打印的二维码是**用 `▀ ▄ █` 和空格拼的方块图**（见 expo CLI 的
`createHalfblockOutput`）。它假设「一个方块字符宽 == 一个空格宽」——
但终端字体**不是等宽方块**，半角空格比全角方块窄。
结果整个码被横向压缩、模块不再是正方形，**手机扫不出来**。

所以 `tools/qr.js` 改成：
- 拿 Expo 自带的 `toqr` 算出二维码矩阵（`toqr` 是 expo CLI 的依赖，本来就在）
- 画成**真正的 SVG**，每个模块都是严格正方形
- 用 `shape-rendering="crispEdges"` 保证边缘不模糊
- **纯离线**，不依赖任何 CDN 或在线接口

用法：

```bash
npm run qr              # 默认端口 8081，自动打开浏览器
node tools/qr.js 8090   # 指定端口
node tools/qr.js --no-open   # 只生成文件
```

生成的文件是项目根目录的 `.qr.html`（已加进 `.gitignore`）。
每换一次网络就要重跑（局域网 IP 会变）。

**怀疑二维码不对时，先自检**（不用拿手机试）：

```bash
npm run qr:verify
# → extent 25x25 / black 49.3% / finder TL·TR·BL 全 OK / ALL OK
```

它会把三个**寻像图形**（二维码三角上那三个 7×7 方框）逐格比对，
再检查黑模块占比（应落在 40~60%）和 `crispEdges`。**这比「看着像二维码」可靠得多。**

**扫码方式**：
- 手机装 **Expo Go**（App Store 搜）
- **iPhone**：用系统「相机」对准浏览器里的二维码 → 自动跳进 Expo Go
- **安卓**：打开 Expo Go，用里面的扫码功能

⚠ **手机和电脑必须连同一个 Wi-Fi**。本机局域网 IP 是 `192.168.0.103`，
二维码对应的地址形如 `exp://192.168.0.103:8081`。

### ⭐ 手机报「连不上服务器」怎么办

先跑这一条，它会逐项体检并**指出是哪一环断了**：

```bash
npm run diagnose
```

它检查：Node 版本 → 网卡 → Metro 监听 → 局域网可达 → **Expo 登录态**
→ manifest 可解析 → bundle 能编译 → 业务代码进包 → 防火墙。
**全过就说明服务端没问题**，故障在「手机 → 电脑」这一段。

> 实测结论（2026-10-02）：本机跑 `npm run diagnose`，
> bundle 4.1MB 正常编译、业务代码进包 —— 唯一 FAIL 是 **Expo 未登录**。
> 也就是说「连不上」几乎一定是网络段或登录态的问题，与代码无关。

#### 报错 → 病因对照

| 手机上的报错 | 含义 | 修复 |
|---|---|---|
| `could not connect to the server` | 手机到电脑这一段不通 | 看下面「网络不通」 |
| `there was a problem running the requested project` | 同上（bundle 请求没成功） | 同上 |
| **`You need to be signed in to Expo Go and Expo CLI`** | **网络已经通了**（好事），只是没登录 | `npm run login:browser` |

### ⭐ 登录（只需做一次）

```bash
npm run login:browser     # 推荐：浏览器登录，不用在终端敲密码
# 或
npm run login             # 命令行输入账号密码（支持 --otp 两步验证）

npm run whoami            # 确认登录成功
```

⚠ **电脑和手机要登录同一个 Expo 账号**：
- 电脑端：上面的命令
- 手机端：打开 Expo Go → 底部 **Account / Settings** → 登录同一账号

⚠ 登录态存在 `~/.expo/state.json` 的 `auth` 字段。
只有 `uuid` 没有 `auth` = 未登录（`npm run whoami` 会显示 `Not logged in`）。

### 如果查完是「网络不通」

**先做这个 10 秒判断**：用**手机浏览器**打开

```
http://192.168.0.103:8081
```

| 结果 | 含义 | 下一步 |
|---|---|---|
| 显示 `packager-status:running` | 网络通 ✅ | 问题在 Expo Go 本身（多半是登录态） |
| 打不开 / 转圈 / 报错 | 网络不通 ❌ | 按下面顺序排查 |

**按顺序排查**：

1. **手机和电脑不在同一个 Wi-Fi** —— 电脑连的是 `FAST_03B3`，
   手机去「设置 → WLAN」确认是**同一个**（注意 2.4G / 5G 可能是不同 SSID）。
2. **路由器开了「AP 隔离 / 客户端隔离」** —— 同一 Wi-Fi 下设备互不可见。
   家用路由一般在「无线设置」里，关掉即可。**公司/访客网络这个几乎必开。**
3. **手机开着 VPN**，或开了「无线局域网助理」（iOS：设置 → 蜂窝网络 → 最下方），
   它会偷偷把 Wi-Fi 切回流量。
4. **实在不行，走 tunnel 模式**（见下）—— 完全不需要同一个 Wi-Fi。

### ⭐ 网络怎么都不通？用 tunnel 模式（最省事）

```bash
npm run tunnel
```

它用 `--tunnel`（走 ngrok 公网隧道）启动服务，并自动生成对应的二维码。
**手机用流量都能连上**，彻底绕开 Wi-Fi、AP 隔离、双频分离这些问题。

代价：比局域网慢一些，且**每次启动 tunnel 地址都会变**（必须重扫）。

⚠ 需要 `@expo/ngrok`。若报找不到，装一下：

```bash
npm i -D @expo/ngrok@^4.1.0
npm run fix:modules     # 本机 safe-delete 可能拦 npm 的删除，装坏了就用这条修
```

**如果网络通、但 Expo Go 报「there was a problem running the requested project」**：

那说明 bundle 已经下载成功（服务端日志会显示 `metro:bundling:done`），
问题在**手机端执行 bundle 时崩了**。此时：

- 看 Expo Go 的**红屏错误**，把最上面几行发出来（关键信息在那里）
- 或者摇一摇手机 → 打开 Dev Menu → 看 Logs
- 服务端日志在 `paipan-app/.expo/dev/logs/start.log`，只有 `undef` 说明错误没回传

⚠⚠ **不要在 AI 会话里启动 Expo**：这个环境不允许后台常驻进程，
命令一结束服务就被回收（表现为打印 `Waiting on http://localhost:8081`
之后立刻连不上，`netstat` 也查不到监听）。**必须在你自己的终端窗口里跑**，
它才能一直活着。

⚠ **本机 `curl` 走代理**（环境变量 `http_proxy=http://127.0.0.1:63307`），
所以 `curl http://localhost:8081` 会返回
`502 upstream connect failed`。那**不代表服务有问题** ——
用浏览器打开 `http://localhost:8081` 才准。

### 启动前自检（可选，出问题时先跑这两条）

```bash
npm run fix:metro        # 打印 metro 版本与完整性
npm run check:modules    # 只体检不改动，逐项 ✅/❌
```

正常输出应类似：

```
=== fix-metro ===
metro 现状: 正常
✅ metro@0.84.5 完整，无需修复

--- ③ 关键包体检 ---
  ✅ expo/package.json
  ✅ babel-preset-expo/build/index.js
  ✅ expo/bin/cli
✅ 全部正常。可以启动：node node_modules/expo/bin/cli start
```

### ⚠⚠ iOS 上的 Expo Go 只支持最新 SDK —— 版本必须对齐

iPhone 的 Expo Go **只能装最新版**（App Store 不允许装旧版），
所以**项目 SDK 必须等于 Expo Go 的 SDK**，否则扫码后报：

```
Project is incompatible with this version of Expo Go
• The installed version of Expo Go is for SDK 57.0.0.
• The project you opened uses SDK 51.
```

**本项目的 SDK 版本（2026-10-02 已升到 57）**：

| | 版本 |
|---|---|
| expo | `~57.0.1`（实际 57.0.26） |
| react-native | `0.86.0` |
| react | `19.2.3` |
| Node 最低 | 22.13.x（本机 22.22.2 ✅） |

⚠ **安卓不受此限**：Android 可以装旧 SDK 对应的 Expo Go。
只有 iOS 被迫「永远跟着最新」。

⚠ 如果以后再报这个错，说明 Expo Go 又升级了 —— 按同样方式升：

```bash
npx expo install expo@latest --fix     # 让 Expo 自己算版本组合，别手写
npx expo-doctor                        # 检查依赖一致性
```

**别用 `--force` / `--legacy-peer-deps` 掩盖 peer 冲突** —— 那是把问题藏起来，
不是解决。

### 为什么升级是安全的（本项目特例）

盘点过业务代码，只用了 **6 个 RN 基础原语**：

```
View  Text  Pressable  ScrollView  StyleSheet  useWindowDimensions
```

这些从 RN 0.74 到 0.86 完全没变；也没用 `propTypes` / `ViewPropTypes` /
`setNativeProps` 等已移除 API。
算法层更是纯 JS（零平台依赖）—— 升级后 **704 条断言依然全绿**。

### 本机已验证到哪一步（2026-10-02，SDK 57）

| 环节 | 结果 |
|---|---|
| `npm install` | ✅（但需补跑 `fix:metro` + `fix:modules`） |
| Metro 启动 | ✅ `Waiting on http://localhost:8091` |
| **打包 bundle** | ✅ `HTTP 200`，4,744,591 字节，**无编译错误** |
| 三个组件是否进包 | ✅ `ChartView` 12 处 / `GzPicker` 15 处 / `DatePicker` 17 处 |
| 计算层是否进包 | ✅ `buildChartData` 4 处 / `currentDayunIndex` 3 处 / `computeDayunRows` 5 处 |
| 算法测试 | ✅ 704 断言全绿（RN 0.86 下） |

⇒ **「能不能编译过」已证完**。
⇒ ❓ **唯一没验的是「长什么样」** —— 没有模拟器 / 真机截图，版式只能上机看。

### ⚠ 本机装依赖的坑（重装时照着绕）

本机的**删除守护（safe-delete）会拦截 npm 的删除动作**，导致安装反复半途而废。
两个脚本分别处理：

**`npm run fix:metro`** —— 补 `metro` 空壳包
`node_modules/metro/` 只剩 `src/`、**没有 `package.json`** → 报
`Cannot find module 'metro/src/lib/TerminalReporter'`。
npm 认为它「已安装」所以重装/`--force`/换 `--cache` 全无效 → 直接下 tarball 铺进去。

**`npm run fix:modules`** —— 修 safe-delete 造成的两种残骸

| 形态 | 现象 | 修法 |
|---|---|---|
| `*.DELETE.<hash>` 残骸 | `index.js` 被改名成 `index.js.DELETE.51f1...` 却没删掉 → 入口消失 | **改名还原**（不删除，绕开守护） |
| 嵌套包解析不到 | `babel-preset-expo` 装在 `expo/node_modules/`，Babel 从根解析失败 | 建**目录联接**（junction，无需管理员） |

```bash
npm run check:modules    # 只体检，不改动
node tools/repair-modules.js   # 自动修
```

**症状速查**：

| 报错 | 病因 | 处理 |
|---|---|---|
| `Cannot find module 'metro/src/lib/TerminalReporter'` | metro 空壳 | `npm run fix:metro` |
| `Error during a 'trash' operation` | safe-delete 拦截 | `npm run fix:modules` |
| `Cannot find module '<pkg>/dist/index.js'` | `*.DELETE.*` 残骸 | `npm run fix:modules` |
| `Cannot find module 'babel-preset-expo'` | 嵌套包未联接 | `npm run fix:modules` |

⚠ **`.bin/` 里的可执行文件可能没生成**（install 被中断的连带后果）。
故 `package.json` 的 `start` 改成了 `node node_modules/expo/bin/cli start`
（直接走包内 CLI，不依赖 `.bin` 链接）。

### ⚠⚠⚠ 本机存储只有一个开关：`@react-native-async-storage/async-storage`

`src/platform/storage.js` 是「内存镜像 + 异步落盘」的同步外壳 ——
**落盘这件事完全押在这一个包上**。而它是 `try { require(...) } catch { return null }` 拿的：
包不在就返回 null，`loadFromDisk()` / `persistKey()` **双双静默变成空操作**
（不报错、不警告、Node 侧测试全绿，因为 Node 里本来就没有原生模块）。

症状只在真机上，而且看起来像别的问题：**reload 一次，登录态 / 设备码 / 记住的账号密码全丢。**
2026-10-04 就是这么被发现的 —— 用户问「为什么 reload 后记住的账号密码都没了」，
一查 `package.json` 里**根本没有这个包**（即整套本机存储从头到尾都是空操作）。

三道闸（缺一不可）：

| 闸 | 在哪 |
|---|---|
| 静态断言「声明了 + 版本对 + 真装了」 | `tests/node-resolution-check.js` 第 9 节 |
| 真机上拿不到 / 写不进时**吼一声**（Node 里不响，免得刷屏） | `storage.js` 的 `warnNoStore()` |
| 装依赖前先看这一节 | 就是这里 |

| 记 | 值 |
|---|---|
| 包名 / 版本 | `@react-native-async-storage/async-storage` = **2.2.0**（= `node_modules/expo/bundledNativeModules.json` 给的那个） |
| 要重建原生吗 | **不要** —— 它是 **Expo Go 内置**模块（Expo 官方文档标 "Included in Expo Go"），装 JS 包即可 |
| 装完做什么 | **重启 Metro**（新依赖不进旧的模块表）+ 手机 reload |

### 下拉刷新：`components/PullRefresh` —— **松手才刷**（2026-10-10 二改定稿）

两个列表页（记录页 `ScrollView`、学堂页 `FlatList`）都**包一层**同一个组件：

```tsx
<PullRefresh refreshing={refreshing} onRefresh={onRefresh}>
  <FlatList style={{ flex: 1 }} ... />
</PullRefresh>
```

它**零依赖**：只用 RN 自带的 `Animated` + touch 事件，**一个字的手势都不抢**。
`onRefresh` 要**把 promise 交出去** —— 指示器钉到它 resolve 才收圈。

| 记 | 值 |
|---|---|
| ⚠⚠⚠ 为什么**不能**用 RN 自带的 `RefreshControl` | 安卓上它底层是系统 `SwipeRefreshLayout`：**下拉一过阈值就回调 `onRefresh`**（不等松手）—— 就是用户报的「还没放手就刷了」，RN 没有开关可改。**更要命的是它把后路也堵了**：一抢到手势就调 `NativeGestureUtil.notifyNativeGestureStarted` → `JSTouchDispatcher.onChildStartedNativeGesture` 给 JS 发一个 **CANCEL**、并置 `childIsHandlingNativeGesture`，此后**连 ACTION_UP 都直接 return**（`JSTouchDispatcher.kt:123-126`）⇒ 「留着原生控件、只把真实刷新推迟到松手」这条双保险**在原理上不成立** |
| ⚠⚠⚠ 为什么**不能**用 `react-native-gesture-handler` | `GestureDetector` 把 handler 挂在 Wrap 里子元素的**原生视图**上 ⇒ 直接包列表就是跟列表滚动抢同一个原生视图，症状永远是「**拉不动且什么都不报**」（前两版死在这）。`PanResponder` / 抢 responder 同理 |
| ⭐ 那它凭什么拉得动 | 两条源码事实：① `ReactRootView.requestDisallowInterceptTouchEvent()` **故意不调 super**（源码注释写明了）⇒ 列表原生滚动时 JS 侧照样收得到 MOVE / UP；② `topTouchMove` 在 `BaseViewConfig.android.js` 里注册的是 `bubbled: 'onTouchMove'` ⇒ 手指落在列表任意位置，事件都冒泡到外层那一层 View |
| 位移怎么做的 | 一个 `Animated.Value` 把**整块**（指示器 + 列表）一起 `translateY`；**松手那一拍**才决定「刷」还是「弹回去」。拖动过程**零 setState**（只有跨阈值时换一次文案），位移走 `useNativeDriver: true` |
| ⚠⚠ 必须注入 `overScrollMode:"never"` + `bounces:false` | 不注入的话安卓的边缘辉光 / iOS 的橡皮筋会跟我们的位移**叠加**（视觉位移变两倍）。这两个与 `onScroll` / `scrollEventThrottle` 一起由 `cloneElement` 并给子列表；`VirtualizedList` 是 `{...this.props}` 透传，不会被吞 |
| ⚠⚠ `atTop` 只能来自子列表的 `onScroll` | 拿 `contentOffset.y` 判断；猜错 = 「列表滚在中间也会整块被拽下来」。⚠ **只查「文件里有 `contentOffset` 这个词」是假绿**（负向探针 M4 实测过），断言必须查到「算出来**并写回** `atTopRef`」 |
| ⚠⚠ `refreshing` 必须是 **state** | 用 `ref` 的话不重渲染 ⇒ 文案与收圈都不对 |
| ⚠⚠ 收圈必须 `loadCloud(...).finally(() => setRefreshing(false))` | 用定时器蒙时长的话，网慢时圈先消失，用户以为刷完了 |
| ⚠⚠ 下拉**不许**走 onShow 那道「版本号变了才拉」的闸门 | 下拉是用户主动要数据；加闸门 = 「拉了没反应」 |
| ⚠ 下拉**不带任何前置条件** | 列表空 / 上次失败 / 未登录都必须能拉 —— 它是用户最后的自救手段 |
| ⚠⚠ 手势库现在**零引用** | `App.tsx` 的 `GestureHandlerRootView` 也一起撤了。**将来若再上 RNGH 手势，必须把它加回最外层**，否则安卓上手势全哑且不报错（这个坑踩过两次）。`package.json` 里那个包还装着（Expo Go 内置，留着不占运行成本） |
| 两次走弯路的留档 | ① 用 `RefreshControl`（安卓过阈值即刷）② 用 RNGH 自写（拉不动）—— 都写成源码注释里的负面教材。旧代码备份在仓库外 `_rollback-2026-10-10-pullrefresh/` |
| 守卫 | `tests/screens-check.js` ⑬ / ⑬-b / ⑬-c / ⑬-d；负向验证 `tests/_neg-probe-pullrefresh.py`（10 个探针，每个都必须报红） |

### `App.tsx` 的验收标准

- 排出 1990-01-01 11:04 → 盘面完整（基本信息 / 四柱 + 藏干 / 选中运面板 / 运程三张表）
- 改出生时间（点「出生时间」开 DatePicker）→ 整块盘重排
- 点大运列 → 流年表与右侧大运卡跟着换（三级联动的观感）
- 长按某一格 → 页脚出现「最近长按：<标题>」，格子上出现红点

---

## 师傅批字（结果页第 4 个页签）

「一个和师傅聊天回复的页面」，**这个会话只属于这份八字**。

### 会话就是这条记录

- 一份八字 ↔ 一个会话**一一对应**：不建「会话」表、不要「新建会话」动作，
  锚点直接用记录 id。
- 所以在这个页面里**结构上不可能给别的八字发消息** —— 页面拿到的记录是哪个，
  会话就是哪个。返回列表时记住 `chatRecRef`，**回来先确认还是同一条记录**再落数据。
- 后端接口 `GET/POST /records/:id/comments`（细节见 `../paipan-server/API.md`）。

### 会话的诞生点：空态那颗「发起求测」

**八字保存了，会话还不存在** —— 用户要先点一下「发起求测」，会话才出现。

- 那颗按钮做的事是**发一条求测消息**（`CHAT_TEXT.reqText`），所以
  **「会话存在」与「有消息」是同一件事**，判据 `chatStarted()` 只是看有没有消息
  （`lastSeq > 0` 优先，增量只装了「这一段」时也算已出现）。
- ⚠⚠⚠ 因此**不需要**另设一个「已发起」的键值：不加表、也不在 `records` 上加列。
  用户点按钮与「第一条消息落库」是同一个动作，不存在「已发起但还没消息」的中间态。
- ⚠ 判据与「拉成功了吗」是两件事：读失败要出「重试」，不是出「发起求测」
  —— 视图必须先判 `state === 'fail'`。
- 输入条的露出条件是「批字页签 + 已保存 + **会话已出现**」：没发起之前不给输入框
  （否则用户能对着一个不存在的会话说话）。
- 发起与发送走**同一个函数** `chatPost(text, clearDraft)`；发起那条
  `clearDraft = false` —— 它发的是替你写好的那句，**不许顺手抹掉用户打了一半的草稿**。

### ⭐ `role` 由**服务端**裁定

- 用户写的一律落 `ask`（客户端就算传 `master` 也**静默降级**，不是报错）。
- 只有**现查库**确认的管理员才能写 `master`。
- 为什么一步都不能省：这个功能的价值全在「这是**师傅**说的」——
  只要客户端能自己声明 `role=master`，谁都能伪造一条批字，那就一文不值。
- ⚠ 界面上「谁是『我』」**只看 `role`，不比对 uid**（role 是服务端裁定的权威值；
  而且管理员给自己批字时 uid 本来就一样，用 uid 判会把师傅的话画到右边去）。

### 数据层

| 层 | 文件 | 干什么 |
|---|---|---|
| 门面 | `src/core/comments.js` | `supported` / `newId` / `sorted` / `list` / `send`。⚠ `send` **失败时也返回用过的 `id`**，调用方重试原样传回 ⇒ 不会「超时了但其实写进去了」变成两条 |
| store 门面 | `src/core/store/index.js` | 驱动缺方法就**当场抛 TypeError**（不做降级兜底） |
| 本地驱动 | `src/core/store/localdb.js` | `listComments` / `addComment`。⚠ 任何函数**永不 reject**；**读失败 → `ok:false`**，绝不是 `ok:true + 空数组`（那会把「拉不到」说成「没有」，用户就再也不会重试）；「这个会话没消息」才是 `ok:true + []` |
| 可用性 | `src/core/storeMode.js` | `supportsComments()` 判据是 **MODE 而非方法探测**（明确的产品决定）；不支持时调用方**如实说明**，不发一个必然 404 的请求 |
| 纯逻辑 | `src/screens/result/model.js` | `CHAT_*` 一族：`chatMsgOf`（`mine: role === 'ask'`）/ `chatAppend`（按 id 去重、按 seq 排序、`lastSeq = Math.max(...)`）/ `chatCanSend` / **`chatStarted`（会话出现了没有 = 有没有消息）** |
| 视图 | `src/screens/result/Result.tsx` | 第 4 个页签 `notes`（原「功能待接入」占位）换成**空态「发起求测」按钮** + 消息列表 + 底部输入条 |

### 版式上的两个硬约束（改 `Result.tsx` 之前先读）

1. **输入条是外层 `ScrollView` 的兄弟节点**，不是它的子节点
   —— 项目已有先例（工具栏踩过这个坑：套进 `page` 会把列表挤没）。
2. **键盘避让（`eaten`）压在最外层 `View` 上**，不是压在 `ScrollView` 上
   —— 压在里层的话输入条会落到键盘底下被遮住。
3. 输入条用 `display` 切显隐，**不做条件渲染**（与四个面板同一条纪律）。

### 现状（「先立骨架」阶段）

- ✅ 页面 + 接口 + 表 + 级联（删记录 ⇒ 会话清空）都已就位。
- ✅ 一个人自己给自己批字可用；**管理员账号调同一个接口**即可灌一条 `master` 批语
  （不必另开脚本）。
- ⏳ **师傅给别人的八字批字**还没开：那需要先定「谁有权限读别人的记录」，
  属于师傅侧**另一条独立通道**的事。表结构与读接口都已就位，
  那时只需加一个写入方，不用改表。

---

## 自定义标签 —— 把八字归到自己定义的名目下（**换在结果页、管在记录页**）

用户需求原话：「**在记录页面增加一个自定义标签功能，将八字归类到自定义的标签内**」。

> 当前分工（2026-10-05 定稿）：**改一条八字归到哪个标签** → 排盘结果的「详细信息 → 标签」，
> 而且**要先按底部那颗「修改」**（没点修改时那一行只是显示标签，点不动）；
> **新保存一条时** → 「保存到记录」的小窗里直接选（第四刀，只能选）；
> **标签本身的新建 / 改名 / 删除** → 记录页顶部标签栏右端那枚固定的「管理」。
> 记录页列表只**只读**显示这条属于哪个标签。

### 交互（2026-10-05 用户拍板，当天又改过三次 → 见下面「四刀」）

| 决定 | 结果 |
|---|---|
| **在哪儿给一条八字打标签** | ⚠⚠ **只在排盘结果的「详细信息 → 标签」那一行**，**且必须先按底部的「修改」**（展示态那一行是只读的、连 `›` 都不画）。而且那一处**只能换 / 取消归类** —— 不能新建、不能改名、不能删除（用户原话：「只能更换标签，不能删除和改名标签」） |
| **在哪儿管理标签本身** | **记录页顶部标签栏右端那枚固定的「管理」**（不随左边滑动）：新建 / 重命名 / 删除。⚠ 删除只解除归类，**不删记录** |
| 一条八字能挂几个标签 | **只能有一个** ← 这条决定了结构（`record_tags` 复合主键 `(user_id, record_id)`，**不是**中间表的多对多） |
| 记录页列表长什么样 | 卡片**只读**显示所属标签（一枚 chip；没有标签就整行不渲染）+ 列表上方一条**常驻**标签栏（点某格只看该类，再点取消） |
| **保存新记录时怎么归类** | 点「保存到记录」的小窗里**直接选**（`TagBar`，与记录页同一枚组件）。⚠ 那里**只能选** —— 不能新建 / 改名 / 删（那三件事仍然只在记录页的「管理」里）；一条标签都还没建时这一块**整块不显示**（只有「未分类」一格，选了等于没选） |

⚠⚠ **同一天改的「四刀」（都是「功能在、但用户找不着 / 找错了地方 / 太容易误碰」）**：

1. **第一刀 —— 标签栏改常驻**：标签栏最初写成「**有标签才显示**」（理由：一枚标签都没有时只有
   「全部 / 未分类」两格，纯占地方）。上线后用户直接问「**记录页怎么没有标签功能？**」——
   顶部一直空着，入口只剩卡片上那行小灰字，小到看不见。⇒ 改成**常驻**（判据只有 `canTags`）。
2. **第二刀 —— 入口重排**（用户原话：「新建标签名字改成管理，并且固定在右侧不许滑动。
   列表中的 + 标签去掉。**只能在排盘结果的详细信息里面更换标签**（只能更换标签，不能删除和改名标签）；
   记录页面的列表只显示这条数据是哪条标签」）：
   · 那一枚从「＋ 新建标签」改名 **「管理」**，并且从滚动区末尾**挪到行尾固定位**（标签再多也不滑走）；
   · `TagBar` 结构改成**两段**：左 `ScrollView`（`flex:1, minWidth:0`）+ 右固定 chip；
   · 卡片上那行标签**改成只读**（`Pressable` → `View`），`tagFor` / `onTagOpen` / `onTagPick` /
     `applyTag` 四条代码**连根删掉**（留着就是一条能从列表改标签的暗路）；
   · 「换标签」整体搬到**结果页的「详细信息 → 标签」**（`TagPicker` 以 `mode='pick'` 出现）；
   · `TagPicker` 因此从「manage 一个开关」拆成 **`mode: 'pick' | 'manage'` 两态**。
3. **第三刀 —— 改标签要藏在「修改」按钮后面**（用户原话：「排盘结果的详细信息，标签的修改要在
   修改按钮点击之后才能修改，**不能分散**。如果没有点击修改按钮那么就只是显示标签就行了」）：
   · 展示态那一行从 `Pressable` 改回 **`View`**（只读，连 `›` 都不画）；
   · 可点的那一份搬进**修改态**（`EditBlock`，在「描述」下面、取消/保存按钮上面），
     靠 `canTags / tagName / onTagOpen` 三个 props 透传进去；
   · ⇒ `onPress={onTagOpen}` 全页**只出现 1 次**（断言钉死）；出现两次 = 又有一个没被「修改」管住的入口。
4. **第四刀 —— 保存时就让你选标签**（用户原话：「**点击保存到记录按钮，弹窗能不能同时有选择标签的功能**」）：
   · 「保存到记录」的小窗（本来只问姓名 / 描述）里加一排 `TagBar`（「未分类」+ 各标签）；
   · ⚠ 那里**只能选** —— 新建 / 改名 / 删仍然只在记录页的「管理」里（不给第二个做同一件事的地方）；
   · ⚠⚠⚠ **归类是保存成功之后的第二次请求**：归类接口要 `records/:id`，
     而新记录在点「保存」那一刻**还没有 id**（id 由 `push` 时的 `record.slim` 生成）。
     写成「点保存时就发」不会报任何错，界面上只表现为「选了标签但没生效」。详见下面第 6 条。

**同时修掉的一处真 bug（用户第 1 条报障）**：**换完标签回记录页，列表上的标签不更新**。
根因不在标签代码，在**版本号**：记录页的 onShow 闸门（`model.shouldReload`）只认 `history.rev()`，
而归类走的是 `PUT /records/:id/tag` —— **不在** `push / saveNotes / drop / clear` 那四个会 `+1`
的写操作里。⇒ 换标签成功后**手动推一次** `history.bumpRev()`（`core/history.js` 导出，
只有这一个正当调用点）。不推的话现象就是「标签明明换了，列表上看不出来」。

**教训（比改动本身值钱）**：一个「放哪儿都不太合适」的功能入口，先做成**看得见的那个版本**；
而且「改一条八字归到哪」和「管标签本身（增删改名）」是**两件事**，塞进同一个入口迟早有一头做不好 ——
用户最后把它们分到了两个页面，各自只保留一件事。⇒ 组件上就体现为 `mode` 两态，
**不许**再用一个 `manage` 布尔把两件事绑在一起。
第三刀补的是另一半：**「看」和「改」也要分开** —— 一行长得像信息行的东西如果能点，
用户根本分不清哪个能点；把它挂到既有的「修改」按钮上，「能点」本身就变成了「我已经进了修改态」的记号。
第四刀是同一个逻辑的第三次应用：**「保存」那一刻是用户唯一一次明确表态「我要这条了」** ——
问名字最有意义的时刻，也就是问归类最有意义的时刻（他此刻脑子里正想着「这是张三的盘」）；
事后再让他去「详细信息」里补，就是让他把同一件事想两遍。

### 代码落点

| 文件 | 干什么 |
|---|---|
| `src/core/tags.js` | ⭐ 数据层：`list/create/rename/remove/setFor` + `newId/pickName/byId/nameOf/upsert/drop/totalOf`。**永不 reject**，`ok:false` = 读写失败、「一个都没有」= `ok:true + tags:[]` |
| `src/core/store/localdb.js` | 5 个转发函数（`listTags/createTag/renameTag/deleteTag/setRecordTag`），⚠ 打的是 `/tags` 与 `PUT /records/:id/tag` |
| `src/components/TagPicker.tsx` | `TagBar`（左可滑 chips + **右固定**「管理」）+ `TagPicker`（**两种形态**：`mode='pick'` 只换标签 / `mode='manage'` 只管标签本身） |
| `src/screens/records/model.js` | 纯计算：`tagQuery / tagBar / tagNameOf / planNewTag` + 三参的 `toQuery/hasFilter/refreshQuery`；⚠ `toHandoff` 顺手把 `tagId` 贴上（结果页要用） |
| `src/screens/records/Records.tsx` | 接线：标签栏 + **只读**卡片 chip + 「管理」面板（新建 / 改名 / 删） |
| `src/screens/result/Result.tsx` | ★ **换标签的两个入口都在这一页**：① 「详细信息 → 标签」那一行（**展示态只读，修改态那一份在 `EditBlock` 里才可点**）+ `mode='pick'` 面板；② 「保存到记录」的小窗里那排 `TagBar`（只选，不建/不改/不删）。`tagId` 是本页的**独立 state**（记录行里没这个字段）；两处写完都推一次 `history.bumpRev()` |
| `src/screens/result/model.js` | 保存窗的纯计算：`saveAskOf/Patch/Open/Close/Commit`（姓名 trim、描述不 trim、**tagId 只当草稿不带进轻记录**）+ `saveAskBar`（那排 chips，头一格是「未分类」）+ `saveAskTag`（保留值 `'none'` → `null` 的唯一翻译点） |
| `src/core/history.js` | 导出的 `bumpRev()` 是**给标签归类这一条路专用的**（归类改的是 `record_tags`，不在会 `+1` 的四个写操作里）—— 不推它，记录页回来不重拉 |

### ⚠⚠⚠ 六条最容易踩的

1. **归类走专用接口** `PUT /records/:id/tag`，**不是**整行 `PUT /records/:id`。
   后者是整行覆盖，前端所有编辑路径都「取整条 → 只改一个字段 → PUT 整条」；
   把 tag 塞进去 ⇒ 漏带一处就**静默抹掉标签**。⇒ `records` 的 upsert **一个字节都不碰** tag。
2. **`tagId` 是只读派生字段**：只出现在 `GET /records` 的响应里，**不进** `core/record.js` 的字段白名单
   （`slim` / `toStorage` / upsert 列清单里都没有它）。⇒ 两个后果：
   · **列表**那条记录用的是服务端给的 tagId；归类成功就得**重新拉记录** —— 本地改不了它，
     自己拼一个假的会造成「列表显示的」和「下次筛选的」对不上；
   · **结果页**那一行用的是它**自己的 `tagId` state**（值来自 `toHandoff` 贴的 / 保存成功时那条取的），
     换完**只改这个 state**、不碰 `panel.rec`（那里根本没这个字段，也没有「改本地再重拉」这回事）。
   ⚠ `toHandoff` 贴的那一下**只走内存总线**（`chartBus`）—— 保存路径不经过它，
   所以 tagId 永远写不进记录行（服务端 upsert 也不接受它）。
   ⚠⚠⚠ **「重新拉记录」这件事不会自动发生**：记录页的 onShow 闸门只认 `history.rev()`，
   而归类的写操作不推它 ⇒ 前面那句「归类成功就得重新拉记录」必须**手动兑现**：
   结果页换标签成功后调一次 `history.bumpRev()`。漏了它，功能全对、就是「看不出来」。
   ⚠⚠⚠ **「读回来」的那条路也必须接住它**（2026-10-05 用户报障：「排盘结果的详细信息
   显示未分类，但八字已经分类了，甚至在记录页都能通过标签筛选出来」）：
   `core/userStore.js` 的 `listRecords` 读回来时对每一行做 `record.toStorage` ——
   那是**写入**白名单，而 tagId **故意不在**里面 ⇒ 它被**静默剥掉**：
   卡片没 chip、结果页写「未分类」，**而按标签筛选照样筛得到**
   （筛选是服务端做的，根本不经过这条路）⇒ 看起来像「数据是好的、只是界面不显示」，
   是最难查的一类。修法＝读路径单独贴回（`userStore.js` 的 `lightOf`），
   ⚠ 这条**只能**在 local-check 那种「走真实读路径」的套件里钉住：
   纯函数层的断言（`withSummary` / `toHandoff`）**必然测不出** —— 喂进去的 rec 本来就有 tagId。
3. **改名不重拉记录**：名字只存在 `tags` 那一行，卡片那枚 chip 由 `tags` 列表算出来（`model.tagNameOf`），
   `setTags` 之后自己就变了；重拉只会让列表闪一下（`loadCloud` 开头会 `setList([])`）。
4. **删除标签时必须把筛选退回「全部」**（如果正按它筛着）：那个标签已经没有记录了，
   继续按它筛只会一片空白，而标签栏上那一格也没了 —— 用户会彻底不知道自己在看什么、也不知道怎么退出来。
5. **标签栏的计数不拿 `list.length` 当分母**：列表此刻已经是筛过的。
   「全部」那一格 = `untagged + Σcount`（来自 `/tags` 的 `model.tagBar`）。
6. **保存时的归类是「先存、再归」两步**（第四刀）：
   · 归类接口是 `PUT /records/:id/tag` —— **要 id**；而新记录在点「保存」那一刻还没有 id
     （`record.slim` 在 push 里生成）⇒ 只能等 `history.push` 成功、从回来的列表里取到那条
     （`hit.id`）再补发一次请求；
   · ⚠⚠ **用 `chatRecId` 代替 `hit.id` 是最像对、也最毒的写法**：新排的盘 `chatRecId` 是 `null`，
     请求会被拦成 `BAD_ID`，而界面上只表现为「选了标签但没生效」（没有任何报错）；
   · ⚠⚠ **失败不能并进「已保存」那句话**：记录确实存进去了、标签没贴上 ——
     报成功就是撒谎。文案单独给「已保存，但标签没贴上」，用户还能去「详细信息 → 修改 → 标签」再选；
   · ⚠ 归类成功照样要 `history.bumpRev()`（否则回记录页看不到那枚 chip）+ 重拉 `loadTags()`
     （`count` 变了）；
   · ⚠ 归类那次往返是异步的：回来后先确认**屏上这条还是刚存的那条**（比对 id）再改本页 state，
     否则会把「已经换到别的盘」的标签行写错。

### ⚠⚠ 三个静默失效的坑（都做了断言）

- **`TAG_NONE` 两端必须逐字相同**（`'none'`）：对不上 ⇒ 服务端把它当成「一个叫 none 的标签 id」去查 ⇒
  **0 条**，而界面写着「未分类」。`''`（全部）与 `'none'`（未分类）语义不同，由 `model.tagQuery()` 一步定死。
- **`TAG_NAME_MAX = 20` 两端必须相等**：前端宽后端窄 ⇒ 打完提交才被拒；前端窄后端宽 ⇒ 前端**静默截断**。
- **`model.exports` 的顺序**：`toQuery` / `hasFilter` 与 `core/pillarFilter.js` **重名**，
  必须写在 `...pillarFilter` **之后** —— 写前面会被 spread 静默盖回只认两维的旧版
  （标签那一维永远不生效，界面照样画得出来，最难发现）。源码级断言守着这一点。

### 服务端契约

见 `../paipan-server/API.md` 的「自定义标签」一节与 `README.md` 的表结构。
⚠ **新增了两张表**（`tags` / `record_tags`）与新路由文件 ⇒ 改完后端**必须重启 `启动.cmd`**；
App 刷新即可（没有新增原生依赖）。

---

## 测试资产说明

| 套件 | 覆盖 | 特点 |
|---|---|---|
| `test.js` | 算法正确性 | **原样移植**，与小程序对拍一致 |
| `logic-check.js` | 端到端已知答案 | 不依赖测试框架理解，换任何框架都能跑 |
| `chart-view-check.js` | 盘面的计算语义 | 三级联动 / 事件记录落点 / 卡位规则 |
| `wiring-check.js` | 三个组件的调用序列 | 验「字段名对不对、返回结构当没当数组用」 |
| `gitee-check.js` / `cloudbase-check.js` | 两套**休眠**驱动 | 「休眠 ≠ 可以烂」：契约仍被断言守着，将来切回去不会一脚踩空 |
| `session-check.js` | 登录态 / 会话版本号 / 记住账号密码 | 含「退出登录不许清掉记住的密码」这类反向断言 |
| `screens-check.js` | 页面与组件 | 除行为外还有**源码级结构断言**（输入条必须是 ScrollView 的兄弟、`eaten` 必须在外层…） |
| `local-check.js` | 本地后端驱动 + **师傅批字** + **自定义标签** | 覆盖「非 local 后端 **0 请求**」「重试沿用同一个 id」「失败时也返回 id」「取消归类时 `tagId:null` 必须判成功（用真值判会误报成形状错误）」「**读路径不许把只读的 tagId 剥掉**（十六.21）」 |
| `node-resolution-check.js` | 依赖 / 脚本 / 存储落盘 | 守着「所有 npm 脚本必须走 `tools/run.js`」「存储包版本必须与 Expo 对齐」 |

⚠ **每个套件都做过负向验证**（把源码逐个改坏 → 确认报出的 FAIL 正中要害 → 还原）。
⚠⚠ 负向验证**抓到过一条假断言**：`screens-check.js` 里「旧写法必须已删」的正则
末尾把 `}]}` 写成了 `}}]`，导致它**永远匹配不上** —— 把 `marginBottom: eaten`
挪回 `ScrollView` 时它**没红**。教训：**新写的断言必须做负向验证**，
否则它可能只是「看起来在守」。

---

## 下一步

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 风险验证 + 算法层搬运 | ✅ |
| 1 | 三个核心组件 | ✅ |
| 2 | 4 个页面 + tab 导航（记录 / 排盘 / 学堂 / 设置） | ✅ |
| 3 | 接后端 + 登录/注册 + 阅读页 + 师傅批字骨架 | ✅ |
| 4 | 师傅侧通道（谁有权读别人的记录） | ⏳ 待定口径 |
| 5 | EAS Build 打包 | |

⚠ **`src/core/` 设为只读约定**：这层的价值在于「它是已验证的」。
要改它，先加/改测试，改完把 `tests/test.js` 跑绿。

---

## 与原项目的关系

```
paipan/         抖音小程序（tt）—— 保留，作为参考实现与设计来源
paipan-app/     跨平台 App（RN + Expo）—— 新主力
```

两边**共享算法层**（同一份代码的两个副本）。
⚠ 改算法时两边都要同步改，否则会漂。

原项目里可继承的**设计资产**（换框架不用重新试错）见方案书 2.3 节：
结果页布局预算、八步向导、四柱表等高规则、红点色值 `#e5342b` 等。
