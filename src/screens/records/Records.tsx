/**
 * 记录页（启动页 / tab 0）—— 从 paipan/pages/records/ 搬过来
 *
 * 结构上刻意与小程序一一对应：
 *   · 顶部「启动引导」状态条（登录 → 查云端 → 没文件就建，是真在等网络）
 *   · 「云端记录同步失败」可点重试条
 *   · 空态（还没有记录 + 去排盘按钮）
 *   · 列表（通栏白底直角，右侧两行四柱四字）
 *
 * ============ 两条纪律（都在 model.js 里可断言） ============
 *   ① 「变了才拉」：onShow 无条件重拉会让「下拉通知栏」变成最贵的手势。
 *      靠 history.rev() 的版本号挡（见 model.shouldReload）。
 *   ② 打开一条记录时，交给结果页的必须是 record.toStorage(它) ——
 *      剥掉 fourChars / lunarText 这些只为列表展示的派生字段，但**保留 notes**。
 *
 * ⚠ 本页**没有**删除 / 清空入口（用户 2026-10-01 要求移除）。
 *   写操作只发生在结果页（保存 / 记事件）。数据层的 drop/clear 仍在，
 *   但页面不再调用 —— 要删得去云端控制台直接改那张 records 表。
 *
 * ⚠ 本页在 tab 里是**常驻挂载**的（靠 display 切），所以没有「unmount 时退订」的
 *   天然时机 —— 退订放在 tab 切走的回调里（App 传进来的 active 变化），
 *   否则每次切 tab 都会多挂一个订阅（一个冷启动内就漏一片）。
 *
 * ============ 懒加载 / 分页（★ 2026-10-11 用户要求）============
 * 用户原话：「记录页面的懒加载做了没有？」→「现在54条，可是后面就会变多」。
 *
 * 形态：首屏只拉**第一页**（`model.PAGE_SIZE` 条），往下滚到接近底部自动续拉下一页；
 * 底部那行说清楚现在是「正在加载…」还是「没有更多了」。
 *
 * ⚠⚠⚠ 四条红线（每条都能单独造成「列表少一截」或「永远在拉同一页」）：
 *   ① **不传 limit = 全量**是服务端口径（`store/localdb.js` 文件头三段 ⚠）。
 *      本页从此**每一次**都显式给 limit；漏给一次就是一次全量，**不报错**。
 *      反过来，`history.js` / `boot.js` 那几处「读全量 → 改一条 → 整份写回」
 *      全靠这条默认值活着 —— **绝不能**顺手把它改成分页（拿一页覆写整表 = 静默丢数据）。
 *   ② 「还有没有下一页」只认服务端给的 `paged === true` + `total`（**筛后**总条数），
 *      判据在 `model.hasMore`。拿「这次是不是正好 50 条」当判据，最后一页装满时会多拉一次空页；
 *      非分页驱动（cloudbase / cloud / gitee）压根不认 limit ⇒ 一律判「没有下一页」。
 *   ③ 位次（`offsetRef`）按**服务端返回的条数**推进，**不是** `list.length`
 *      —— 列表按 id 去重过，两者会不等，去重后再回退位次 ⇒ **原地死循环**。
 *   ④ 续拉回来必须先比**代次**（`genRef`）：换筛选 / 下拉刷新会 +1，
 *      对不上就整份丢掉。不丢的话上一份列表的一页会被追加到新列表尾巴上 ——
 *      界面有数据、日志干净，最难查的一种。
 *
 * ⚠ 「共 N 例 / 筛出 N 例」的 N 也跟着变了：走 `model.countShown(list.length, pageTotal)`，
 *   **不许**再直接拿 `list.length`（首屏 50 条会说成「共 50 例」）。
 *
 * ⚠ 还有一处**不是**本页负责的：`totalAll`（不带筛选时的分母）仍然是「只在无筛选的
 *   那一次替换型拉取里更新」，续拉不碰它 —— 见 loadCloud 末尾那句的条件。
 *
 * ============ 自定义标签（★ 2026-10-05 用户要求）============
 * 卡片上多了一行「标签区」，列表上方一排**常驻**的标签栏。四个概念要分清：
 *   · **标签定义**住在一个独立的列表里（本页的 `tags` state，由 loadTags 拉），
 *     卡片上那枚 chip 的文字是**从它算出来**的（记录上只有一个只读的 tagId）——
 *     所以改个名字只动 tags 那一行，所有挂它的记录下次读到就是新名字。
 *   · **一条八字最多一个标签**（用户拍板；服务端由主键 (user_id, record_id) 保证，
 *     见 paipan-server/src/db/schema.sql 的 record_tags 段）。
 *   · **筛选的第三个维度**：标签栏点一下 = 换 `tagSel` + 重拉（过滤始终在服务端）。
 *     它与干支/姓名是「且」的关系；「未分类」是一个**保留值**（`?tagId=none`）。
 *   · **删标签 ≠ 删记录**：删标签只把记录退回「未分类」（面板里有明文说明这半句，
 *     不说的话用户会以为记录也一起删了）。
 *
 * ⚠⚠⚠ **本页只有一个标签入口：顶部标签栏右端那枚固定的「管理」**（2026-10-05 用户定）：
 *   · 卡片上那行「＋ 标签」**已经去掉** —— 列表里只**只读地**显示这条记录属于哪个标签，
 *     哪儿都不给点（「点标签行开面板」那条路整个删了，连 `tagFor` 这个 state 一起）。
 *   · **更换标签只在一个地方**：排盘结果的「详细信息 → 标签」那一行
 *     （那里也只能**换**，不能新建 / 改名 / 删除）。
 *   · 本页的「管理」只管**标签本身**（新建 / 改名 / 删除），不管某条八字归到哪儿。
 *   ⚠ 于是 TagPicker 在本页只以 `mode='manage'` 出现；`'pick'` 那一态归结果页用。
 *   ⚠ 顶部那一排是**常驻**的（一枚标签都没有也显示）—— 上一版要求「有标签才显示」，
 *     结果用户**根本不知道这页有标签功能**（2026-10-05 报障）。
 * 接口与「归类为什么不并进 PUT /records/:id」——见 core/tags.js 与
 * paipan-server/src/routes/tags.ts 的文件头。
 *
 * ============ 「未登录」是一种**可行动**的状态，不是失败 ============
 * 后端换成 CloudBase 后，新用户第一次打开 App 就是「还没登录」。
 *   ① 启动引导那条（boot 的 STAGE.NEED_LOGIN）：文案「登录后可同步云端记录」，
 *      整条可点 → 去登录。⚠ 绝不能映射成 FAILED —— 那样会显示「登录失败，点此重试」，
 *      而重试一万次也不会好，他就是得先登录（这正是 boot 里把两者分开的理由）。
 *   ② 拉记录那条（pull 的 skip）：未登录时也是可点的「去登录」，
 *      而不是「没有记录」（那会让用户以为数据没了）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useRpx } from '../../theme/rpx';
import { COLORS, FONT_WEIGHTS, LINE_HEIGHTS, RADII, SIZES } from '../../theme/tokens';
import { FilterEntry, FilterModal } from '../../components/FilterModal';
import { PullRefresh, isPulling } from '../../components/PullRefresh';
import { TagBar, TagPicker } from '../../components/TagPicker';
import model from './model';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS，TS 的 import 互操作对它不安全 */
const history: any = require('../../core/history.js');
const boot: any = require('../../core/boot.js');
const chartBus: any = require('../../core/chartBus.js');
const store: any = require('../../core/store/index.js');
const tagsLib: any = require('../../core/tags.js');
/** ⚠ 只为一件事：未登录时**别去拉标签**（见 loadTags） */
const auth: any = require('../../core/auth.js');

type Item = {
  id: string;
  name: string;
  gender: number;
  date: string;
  time: string;
  createdAt?: number;
  fourChars: string[];
  lunarText: string;
  notes?: any;
  desc?: string;
  /**
   * 这条八字归到哪个标签（**只读派生字段**，服务端 GET /records 给的）。
   * ⚠ 没有标签时这个键**不在**（不是 null）—— 视图据此决定画不画那枚 chip。
   * ⚠ 它的写入走 `PUT /records/:id/tag`，**不是**整行 PUT（见 core/tags.js 文件头）。
   */
  tagId?: string;
};

type BootState = {
  show: boolean;
  stage: string;
  text: string;
  pending: boolean;
  canRetry: boolean;
  /** 这条能不能点去登录（＝ boot 处于 NEED_LOGIN） */
  canLogin: boolean;
};

type PullState = { state: 'idle' | 'loading' | 'ok' | 'fail' | 'skip'; text: string };

/**
 * 列表滚到「离底部还有这么远」（dp）就开始续拉下一页（判据在 model.nearBottom）。
 *
 * ⚠ 用**固定 dp**而不是 rpx：它量的是「手指滑过的距离」，与屏宽无关 ——
 *   挂在 rpx 上的话大屏（rpx 更小）提前量会被压得几乎为零，
 *   用户就会看见列表**停下来等**（滑到底了圈才开始转）。
 * ⚠ 值大约半屏多一点：下一页通常在用户真正滑到底之前就已经到了。
 */
const LOAD_MORE_GAP = 420;

const BOOT_HIDDEN: BootState = {
  show: false, stage: 'idle', text: '', pending: false, canRetry: false, canLogin: false
};

export default function Records({
  active,
  sessionRev,
  onGoLogin,
  onOpenRecord,
  onGoPaipan
}: {
  /** 当前这个 tab 是不是显示中（用来决定订阅/退订） */
  active: boolean;
  /** 登录态版本号（登录成功 / 退出登录各 +1）—— 变了就强制重拉一遍 */
  sessionRev: number;
  /** 去登录（本页两处「未登录」提示都指向它） */
  onGoLogin: () => void;
  /** 打开一条记录：把轻记录交给结果页 */
  onOpenRecord: (rec: any) => void;
  /** 「去排盘」：切到排盘 tab */
  onGoPaipan: () => void;
}) {
  const rpx = useRpx();
  const [list, setList] = useState<Item[]>([]);
  const [bootState, setBootState] = useState<BootState>(BOOT_HIDDEN);
  const [pull, setPull] = useState<PullState>({ state: 'idle', text: '' });
  /**
   * 下拉刷新正在转圈。
   *
   * ⚠⚠ **必须是 state 而不是 ref**：它决定 `<PullRefresh>` 的文案与什么时候收圈，
   *   而 ref 改了不触发重渲染 ⇒ 文案不换、圈也收不回。
   * ⚠ 它和 `pull.state === 'loading'` 是**两套**东西，别混：
   *   · `pull` 驱动的是页面上那条「正在同步记录…」文案条（首屏/重试用）；
   *   · `refreshing` 驱动的是**下拉指示器**。
   *   两者同一个请求里同时为真，但收起的时机不同（下拉的圈要等 promise resolve）。
   */
  const [refreshing, setRefreshing] = useState(false);

  /* ---------------- 分页 / 懒加载（★ 2026-10-11 用户要求） ----------------
   * 用户原话：「记录页面的懒加载做了没有？」→「现在54条，可是后面就会变多」。
   * 于是首屏只拉**第一页**（model.PAGE_SIZE 条），滚到底再续拉下一页。
   *
   * ⚠⚠⚠ 但**绝不能**顺手把「全量」那条路一起改掉：core/history.js 与 boot.js 有
   *   「读全量 → 改一条 → 整份写回」的路径（改笔记 / 改标签回写 / 启动时的整表检查），
   *   它们**不传** `{limit}`（服务端口径「不传 limit = 全量」，见 store/localdb.js 文件头）。
   *   本页的分页靠的是**每一次都显式给 limit**，不是改那个默认值。
   */
  /**
   * 服务端给的「本次筛选口径下的总条数」（**筛后**）。用来：
   *   ① 判还有没有下一页（model.hasMore）；② 「共 N 例 / 筛出 N 例」里那个 N。
   * ⚠ 它与下面那个 `totalAll` **不是一回事**：`totalAll` 只在**不带筛选**的那次更新，
   *   专门留给「共 N 例」的分母（带筛选重拉时不能被筛后的数字覆盖）。
   * ⚠ 非分页驱动（cloudbase / cloud / gitee）**不回 total** ⇒ undefined，
   *   那时 model.hasMore 判「没有下一页」，行为退回「一次给全量」的老样子。
   */
  const [pageTotal, setPageTotal] = useState<number | undefined>(undefined);
  /** 还有没有下一页 —— ⚠ 只认服务端给的 `paged` + `total`（见 model.hasMore） */
  const [more, setMore] = useState(false);
  /** 正在续拉下一页（驱动底部那行「正在加载…」） */
  const [loadingMore, setLoadingMore] = useState(false);
  /** 上一次续拉失败了（底部那行变成可点重试；重试成功自动清掉） */
  const [moreErr, setMoreErr] = useState(false);
  /**
   * 下一次续拉从第几条开始（= 历次**服务端返回条数**之和）。
   * ⚠⚠ 必须在 ref 里、且按「服务端返回条数」推进 —— 见 model.js 里那条
   *   「不许拿 list.length 当位次」：界面那份列表按 id 去过重，两者会不等，
   *   一旦去重后再回退位次，就会反复拉同一条 ⇒ **原地死循环**。
   */
  const offsetRef = useRef(0);
  /** `more` / `loadingMore` 的 **ref 版**：onScroll 是高频回调，闭包里的 state 是旧的 */
  const moreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  /**
   * 请求代次 —— ⚠⚠⚠ 这是本次懒加载里**最容易漏、也最难查**的一处。
   * 「首屏 / 换筛选 / 下拉刷新」这类**替换型**请求一进来就 +1；
   * 续拉回来时代次对不上，说明它属于**上一份列表**，必须整个丢掉。
   * 不丢的话：用户点一下「标签 A」（列表清空重拉），上一轮的续拉结果随后到达，
   * 被当成「下一页」追加到新列表的尾巴上 ⇒ 标签 A 的列表里混进了别的东西，
   * 而且**界面有数据、日志没有任何报错**。
   */
  const genRef = useRef(0);

  /**
   * 筛选状态（**生效中的那一份**）。
   * ⚠ 类别的**选项表**来自 model.FILTER_CATS；这里只存「选了哪几个字」，
   *   即 `{ yearGan: { 甲: true }, … }`。空集合 = 该类「全部」。
   * ⚠⚠ 弹窗里勾的是另一份**草稿**（draft），点「确定」才会写到这里 ——
   *   见 model.applyPlan 的长注释（为什么不共用一份）。
   */
  const [filter, setFilter] = useState<any>(() => model.emptyFilter());
  /**
   * 姓名查询关键词（**已生效**的那一份）。
   *
   * ⚠⚠ 它**不在弹窗里**（用户明确要求：「输入名字查询不放在弹窗里面，
   *   放在筛选下面，不用点进去也能实现输入名字快速筛选」）。
   *   所以它没有「草稿 / 生效」两态：输入框里是什么，界面就按什么筛。
   *   ⚠ 也因此 `applyPlan` 只比八个干支类别 —— 姓名不参与那个比较，
   *     否则「只改了名字」会被判成「没变」而不发请求（名字白打）。
   */
  const [nameKw, setNameKw] = useState('');
  /** 筛选弹窗开着没有（⚠ 弹窗里的**草稿**现在由 components/FilterModal.tsx 自己管） */
  const [fltOpen, setFltOpen] = useState(false);
  /** 「不带筛选时的总条数」——只用于「共 N 例」那行，⚠ 不能拿筛过的长度当分母 */
  const [totalAll, setTotalAll] = useState<number | undefined>(undefined);
  /** 后端支不支持筛选（只有自建 local 支持，见 storeMode.supportsFilter） */
  const canFilter = store.supportsFilter();

  /* ---------------- 自定义标签（★ 记录页） ----------------
   * 「把八字归到自己定义的名目下」：一条八字最多一个标签（用户拍板），
   * 所以卡片上是**一枚** chip，不是一排。
   * ⚠ 标签与四柱筛选是**两件事、一条路**：标签栏点一下 = 换 tagSel + 重新拉数据
   *   （过滤**始终在服务端**做，见 model.tagQuery / 服务端 routes/records.ts）。
   */
  /** 我的标签（带 count）+ 未分类条数 —— 由 loadTags 拉回来 */
  const [tags, setTags] = useState<any[]>([]);
  const [untagged, setUntagged] = useState(0);
  /**
   * **生效中**的标签筛选，三种取值（⚠ 只有这三种，别再造第四种「未选」状态）：
   *   `''`     = 全部（一个标签参数都不发）
   *   `'none'` = 未分类（`?tagId=none`）
   *   其他     = 标签 id（`?tagId=<id>`）
   * ⚠ 它与 `filter`/`nameKw` 一样是**生效值**（就地生效，没有草稿态）——
   *   标签栏是一排并列的格子，「点哪格看哪格」就是它的全部语义。
   */
  const [tagSel, setTagSel] = useState('');
  /** ⚠ 与 filterRef / nameRef 同一理由：loadCloud 里要**同步**读它（setState 是异步的） */
  const tagSelRef = useRef('');
  /** 标签管理面板开着没有 */
  const [tagOpen, setTagOpen] = useState(false);
  /**
   * 标签面板的「忙 / 错」两个状态。
   * ⚠⚠ 它们**由本页持有**、喂给组件 —— 组件里不再存第二份。
   *   两条理由：① 标签列表只有一份（本页的 `tags`），组件再存副本迟早对不上；
   *   ② 组件的局部态在关闭时会被清掉，而「上一次失败的文案」不该消失得莫名其妙。
   */
  const [tagBusy, setTagBusy] = useState(false);
  const [tagErr, setTagErr] = useState('');
  /** 后端支不支持标签（只有自建 local 有 tags / record_tags 两张表） */
  const canTags = store.supportsTags();

  /** ⚠ 最新 filter 放 ref：loadCloud 里要读它，而 setState 是异步的 */
  const filterRef = useRef<any>(filter);
  filterRef.current = filter;
  /**
   * **生效中**的姓名关键词（进 query 的那个），与 `filterRef` 一同给 `loadCloud` 读。
   *
   * ⚠⚠⚠ **这一行绝不能写成 `nameRef.current = nameKw`**（别照抄上面 `filterRef` 的写法 ——
   *   两者的「草稿/生效」语义**相反**）：
   *   上面干支的 `filter` state **本身就是生效值**，所以每次渲染同步一次是对的；
   *   而 `nameKw` 是**草稿**（输入框里正在打的），生效值只在**提交时**才写。
   *   曾经写成 `nameRef.current = nameKw` ⇒ 每次渲染都把 ref 刷成草稿
   *   ⇒ `onNameSearch` 里那句「没变就不发请求」的守卫**恒为真**（草稿当然等于草稿）
   *   ⇒ **点「查询」和按回车都静默什么都不做**（用户实测报障：「并没有触发名字筛选」）。
   *   ⚠ 这类 bug 极隐蔽：UI 上按钮会正常变亮，点了却毫无反应、也没有报错。
   */
  const nameRef = useRef<string>('');
  /**
   * **草稿**姓名（输入框里正在打的）。
   *
   * ⚠ 为什么要和 `nameKw` 这个 state 存两份：`onSubmitEditing` 是键盘回调，
   *   它在某些机型/输入法下会在 **state 还没冲上来的那一帧**被调用，
   *   此时 `nameKw` 闭包里还是**上一个字符**（现象：打完「张三丰」按回车，
   *   筛的是「张三」）。ref 是同步写的，没有这个滞后。
   */
  const nameDraftRef = useRef<string>('');

  /** 上次成功拉取时记下的数据版本号（⚠ 必须在 ref 里：它不该触发重渲染） */
  const syncedRev = useRef<number | undefined>(undefined);
  /** 本轮进页面有没有看到过「正在等」——决定就绪态要不要露一下 */
  const sawPending = useRef(false);
  /** 上次生效的登录态版本号（用来识别「换了个人」） */
  const sessionSeen = useRef(sessionRev);
  const hideTimer = useRef<any>(null);
  /** ⚠ 用 ref 存最新的 pull state，供重试时判断（setState 是异步的） */
  const pullRef = useRef<PullState>(pull);
  pullRef.current = pull;

  /* ---------------- 云端记录 ---------------- */

  /**
   * 从云端拉这个用户的记录。
   *
   * ⚠ **筛选参数在这里发出去**（用户明确要求「后端筛选」）——
   *   本函数**不做**任何本地过滤，筛出来的就是服务端返回的那批。
   *
   * ⚠ **本地没有任何镜像可以铺底**（用户要求数据一点都不能在本地）——
   * 所以拉取中列表就是空的 + 一行「正在同步记录…」，拉失败就是空的 + 可点重试。
   * 别再想办法「先拿本地的顶上」，那正是被要求删掉的东西。
   *
   * 成功后记下当时的版本号，作为下次 onShow 要不要拉的依据；
   * 失败时**不记** —— 版本号对不上，下次进来会自动再试（断网恢复回来能自愈）。
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.keepTotal] 这次拉取不要更新「总条数」
   *        （带筛选重拉时用：分母要靠一次不带筛选的拉取得来）
   * @returns {Promise<void>} ⚠⚠ **一定要返回 promise**：下拉刷新的转圈要等它
   *   resolve 才能收（见 onRefresh）。不返回的话只能靠定时器蒙一个时长，
   *   网慢时转圈提前消失（用户以为刷完了，其实是还没回来）。
   */
  /**
   * 拉标签列表 + 未分类条数（标签栏那排 chip 与面板都靠它）。
   *
   * ⚠⚠ **永不 reject、也绝不往外抛**：标签拉失败**不能**把记录列表一起打成失败 ——
   *   两者是同一块界面上的两样东西，一样坏了另一样照常显示才查得清。
   *   失败时只把文案写进 `tagErr`（面板底部那一行；平时不显示）。
   *
   * ⚠ 后端不支持标签时**一个请求都不发**（core/tags.js 的 supported 兜在前面），
   *   而不是发一个必然 404 的请求再让用户看「加载失败」。
   *
   * ⚠ 它**不碰** `list` / `pull` —— 记录那条线由 loadCloud 负责，两条互不牵连。
   */
  const loadTags = useCallback(() => {
    if (!canTags) return Promise.resolve();
    /**
     * ⚠⚠ 未登录时**一个请求都不发**（与 `canTags` 那条同一个理由）。
     *
     * 不加这一条的话，退出登录后 `loadCloud` 仍会顺手拉一次标签 ⇒ 服务端 401 ⇒
     * 失败文案写进 `tagErr`。而上面那段「换人时归零」刚刚才把它清干净 ——
     * 于是用户打开「标签管理」，看到的是**一句凭空冒出来的失败**（面板里一条标签都没有）。
     * 登录态变了 loadCloud 会被重新触发，那时才该真的去拉。
     */
    if (!auth.isLoggedIn()) return Promise.resolve();
    return tagsLib.list().then((res: any) => {
      if (!res.ok) {
        setTagErr(res.error || '标签加载失败');
        return;
      }
      setTagErr('');
      setTags(Array.isArray(res.tags) ? res.tags : []);
      setUntagged(typeof res.untagged === 'number' ? res.untagged : 0);
    });
  }, [canTags]);

  const loadCloud = useCallback((opts?: { keepTotal?: boolean; append?: boolean }) => {
    /* ⚠ `append` = 续拉下一页（滚到底 / 点底部重试）。不传 = **替换型**：
       首屏、换筛选、换标签、姓名查询、下拉刷新 —— 全都是「重新来一份」。 */
    const append = !!(opts && opts.append);

    /* ⚠⚠ 替换型请求一进来就把代次 +1（在飞的续拉结果据此作废，见 genRef）。
       ⚠ 续拉自己**不动**代次 —— 它就是当前这一代的一部分。 */
    let gen = genRef.current;
    if (!append) {
      genRef.current += 1;
      gen = genRef.current;
      /* ⚠⚠⚠ 位次必须在**发请求之前**归零，不能等响应回来：那半秒里若又发了一次
         续拉，它会带着上一份列表的 offset 出去。 */
      offsetRef.current = 0;
    }

    /* ⚠ 三个维度一起拼：八干支 + 姓名 + **标签**（见 model.toQuery 的第三参）。
       替换与续拉用的是**同一份**筛选 —— 翻页不改条件。 */
    const query = model.toQuery(filterRef.current, nameRef.current, tagSelRef.current);
    const filtered = Object.keys(query).length > 0;

    /**
     * ⚠⚠ 每一次请求都**显式**给 limit（见 model.pageOpt）：
     *   服务端「不传 limit = 全量」，漏给一次就是一次全量拉取 —— 懒加载白做，
     *   而且**不会报错**（列表照样显示，只是又变成几十条一起回来）。
     */
    const opt = model.pageOpt(offsetRef.current);

    if (!append) {
      setList([]);
      setPull({ state: 'loading', text: '正在同步记录…' });
      /* ⚠ 三个分页状态**一起**归零/归假：只清一个会留下幽灵状态 ——
         新列表只有 3 条，底部却写着「正在加载…」；或者反过来，新列表有 60 条
         却不再续拉。 */
      setPageTotal(undefined);
      setMoreErr(false);
      moreRef.current = false;
      setMore(false);
    }

    /* ⚠ 标签与记录**并行**拉（替换型）：标签栏要拿它算 chip，但它拉失败不该拖垮
       记录列表（loadTags 内部自己收，永不 reject）。
       ⚠ 续拉**不拉标签** —— 标签跟翻页没关系，白跑一趟还多一次无谓重渲染。 */
    const req = append
      ? history.pull(query, opt)
      : Promise.all([history.pull(query, opt), loadTags()]).then((r: any) => r[0]);

    return req.then((res: any) => {
      /* ⚠⚠⚠ 代次对不上 ⇒ 这份结果已经过时（期间换过筛选 / 下拉刷新过），
         **一个 state 都不许写**：写了就是把上一份列表的条目塞进新列表。 */
      if (gen !== genRef.current) return;

      if (!res.ok) {
        if (res.reason !== 'no-login') {
          console.warn('[paipan] 云端记录拉取失败', res.error);
        }
        /* ⚠⚠ 续拉失败**不能**把已经显示出来的那一屏打成失败态 ——
           那一屏数据是好的，坏掉的只是「下一页没拿到」。
           ⇒ 只在底部那行说一句（可点重试），列表一个像素都不动。 */
        if (append) {
          setMoreErr(true);
          return;
        }
        setPull(model.pullStateOf(res));
        return;
      }

      syncedRev.current = history.rev();
      const items = model.withSummaries(res.records);
      if (append) {
        /* ⚠ 去重放在 model 里（`appendUnique`）——视图里**不许**出现 `.filter(`，
           那是「过滤必须在服务端」那条红线断言守着的地方（见 model 里那段注释）。 */
        setList((prev: Item[]) => model.appendUnique(prev, items));
      } else {
        setList(items);
        setPull(model.pullStateOf(res));
      }

      /* ⚠⚠ 位次按**服务端返回的条数**推进，不是 `items.length`。
         `withSummaries` 不增不减，但上面那步去重会减 —— 拿减过的数当位次
         就会反复拉同一条（死循环）。 */
      const got = Array.isArray(res.records) ? res.records.length : 0;
      offsetRef.current += got;

      const total = typeof res.total === 'number' ? res.total : undefined;
      if (!append) setPageTotal(total);
      /* ⚠ 判据只认服务端给的 `paged` + `total`（见 model.hasMore）：
         拿「这次是不是正好 50 条」当判据的话，最后一页正好装满时会多拉一次空页。 */
      const nextMore = model.hasMore(offsetRef.current, total, res.paged);
      moreRef.current = nextMore;
      setMore(nextMore);
      setMoreErr(false);

      /* ⚠ 只有「不带筛选」的拉取才能更新总条数分母，且**续拉不碰它** ——
         筛过的条数当分母会显示成「共 3 例」而其实有 30 条；拿一页的条数当分母
         会显示成「共 50 例」而其实有 200 条。两种都是明确的错误信息。 */
      if (!append && !filtered && !(opts && opts.keepTotal)) {
        setTotalAll(model.countShown(got, total));
      }
    });
  }, [loadTags]);

  /** 拉取失败后点重试 */
  const onPullRetry = useCallback(() => {
    if (pullRef.current.state !== 'fail') return;
    loadCloud();
  }, [loadCloud]);

  /* ---------------- 下拉刷新 ----------------
   * ⚠⚠⚠ 下拉刷新**必须无条件重拉**，不能走 onShow 那道「变了才拉」的闸门
   *   （见 model.shouldReload）：那道闸门存在的意义正是**避免**发请求
   *   （「下拉通知栏不该触发全量重拉」）。而下拉是用户**主动**要数据 ——
   *   闸门挡在这儿就成了「拉了一下没反应」。
   *   ⇒ 所以这里直接 loadCloud()，**不看** syncedRev。
   *
   * ⚠ 但**要带着当前的筛选**拉（见 model.refreshQuery）：下拉是「刷新我正看着的这张
   *   列表」，不是「把我勾的筛选清掉」。筛选状态一个都不动。
   *
   * ⚠ `keepTotal: false`（见 model.refreshOpts）：用户要的是「全给我最新的」，
   *   没有筛选时连「共 N 例」的分母也一起刷新。
   */
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    /* ⚠⚠ 转圈必须在**真拉完**时收（`.then`），不许用 setTimeout 蒙时长：
       网慢的时候定时器先到 ⇒ 转圈消失但数据还没回来 ⇒ 用户以为刷新完成。
       ⚠ `finally` 而不是 `then`：拉失败也必须收圈，否则圈会一直转着。 */
    return loadCloud(model.refreshOpts()).finally(() => {
      setRefreshing(false);
    });
  }, [loadCloud]);

  /* ---------------- 续拉下一页（★ 懒加载） ----------------
   * ⚠ 下拉刷新 = 回到**第一页**（走 refreshOpts 那条替换型路径，offsetRef 归零）；
   *   往下滚 = 在**当前这一份**后面接一页。两者走同一个 loadCloud，靠 `append` 分开。
   */

  /**
   * 续拉下一页。滚到底自动触发，也可由底部那行「加载失败 · 点此重试」手动触发。
   *
   * ⚠⚠ 两道闸都不能省：
   *   · `more` —— 服务端说了还有下一页才算（不然会一直拉、一直空）
   *   · `loadingMore` —— **同时只允许一个续拉在飞**。onScroll 是高频回调，
   *     一屏滑下去能触发几十次；少了这道闸就是一屏几十个重复请求。
   * ⚠ 闸门用 **ref** 判而不是 state：state 要等下一次渲染才更新，
   *   而 onScroll 在**同一帧里**可能连发好几次 —— 那时读到的 state 还是旧的，
   *   于是「同时只许一个」形同虚设（这个坑与 PullRefresh 里那个 pinnedRef 同源）。
   */
  const onLoadMore = useCallback(() => {
    if (!moreRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreErr(false);
    return loadCloud({ append: true, keepTotal: true }).finally(() => {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    });
  }, [loadCloud]);

  /**
   * 列表滚动 —— 只在「快到末尾」时续拉（判据在 model.nearBottom，纯函数可断言）。
   *
   * ⚠⚠ 这个 onScroll **不会被 PullRefresh 吞掉**：它在 cloneElement 时把
   *   `only.props.onScroll` 取出来并 `if (prev) prev(e)` **并**了上去
   *   （见 components/PullRefresh.tsx 里 `scroller` 那段的注释）——
   *   所以「松手才刷」与「滚到底续拉」能共存，不用二选一。
   *   ⚠ 前提是本组件给 ScrollView 的 onScroll 必须是个**函数**：
   *     命名成 `onScroll={...}` 才拿得到；写成别的名字它捕不到，续拉就永远不触发。
   */
  const onListScroll = useCallback((e: any) => {
    const n = e && e.nativeEvent;
    if (!n) return;
    const y = n.contentOffset && n.contentOffset.y;
    const viewH = n.layoutMeasurement && n.layoutMeasurement.height;
    const contentH = n.contentSize && n.contentSize.height;
    if (!model.nearBottom(y, viewH, contentH, LOAD_MORE_GAP)) return;
    onLoadMore();
  }, [onLoadMore]);

  /* ---------------- 启动引导 ---------------- */

  const stopWatch = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const hideBoot = useCallback(() => {
    stopWatch();
    setBootState((prev) => (prev.show ? BOOT_HIDDEN : prev));
  }, [stopWatch]);

  const scheduleHide = useCallback(() => {
    stopWatch();
    hideTimer.current = setTimeout(() => { hideBoot(); }, model.HIDE_DELAY);
  }, [hideBoot, stopWatch]);

  /** 把启动引导的阶段映射成这一行状态 */
  const renderBoot = useCallback((snap: any) => {
    const stage = snap.stage;
    const STAGE = boot.STAGE;

    if (stage === STAGE.LOGIN || stage === STAGE.CHECKING || stage === STAGE.CREATING) {
      sawPending.current = true;
      stopWatch();
      setBootState({ show: true, stage: stage, text: snap.text, pending: !!snap.pending, canRetry: false, canLogin: false });
      return;
    }
    if (stage === STAGE.READY) {
      // 快到连进度都没来得及显示 → 干脆不出现（不闪一下打扰）
      if (!sawPending.current) { hideBoot(); return; }
      sawPending.current = false;
      setBootState({ show: true, stage: stage, text: snap.text, pending: false, canRetry: false, canLogin: false });
      scheduleHide();
      return;
    }
    if (stage === STAGE.FAILED) {
      sawPending.current = true;
      stopWatch();
      setBootState({ show: true, stage: stage, text: snap.text, pending: false, canRetry: true, canLogin: false });
      return;
    }
    if (stage === STAGE.NEED_LOGIN) {
      /**
       * ⚠⚠ 这一条**绝不能**和 FAILED 合并（见文件头）：
       *   新用户第一次打开 App 就是「还没登录」—— 那是正常起点，不是故障。
       *   显示成「登录失败，点此重试」会让用户以为应用坏了，
       *   然后去点重试，而重试一万次也不会好，他就是得先登录。
       * 所以这条：金色、不自动收起、整条点去登录。
       */
      sawPending.current = true;
      stopWatch();
      setBootState({ show: true, stage: stage, text: snap.text, pending: false, canRetry: false, canLogin: true });
      return;
    }
    // idle / skip（登录态里没有可用标识，静默跳过）
    hideBoot();
  }, [hideBoot, scheduleHide, stopWatch]);

  /* ---------------- 生命周期（tab 常驻，靠 active 驱动） ---------------- */

  useEffect(() => {
    if (!active) {
      stopWatch();
      return;
    }

    /**
     * 登录态变过吗（登录成功 / 退出登录）。
     * ⚠ 必须在下面 useRef 赋值**之前**读，读完立刻记下来。
     */
    const sessionChanged = sessionSeen.current !== sessionRev;
    sessionSeen.current = sessionRev;

    // 进这个 tab：订阅启动引导阶段，并确保它跑过一次
    sawPending.current = false;
    const off = boot.observe(renderBoot);
    boot.ensureUser(false).then((res: any) => {
      if (!res.ok) {
        console.warn('[paipan] 记录页启动引导未完成：' + res.reason + ' ' + res.error);
      }
    });

    /**
     * ⚠ 「变了才拉」闸门 + 一条**必须的例外**：
     *   history.rev() 记的是「云端数据变没变」。换了个人登录时，那个版本号**当然没变**
     *   —— 它记不住「换人」这件事。不强制重拉的话，记录页会继续显示**上一个人的列表**，
     *   而用户以为自己登录成功了。所以登录态一变就无条件重拉。
     */
    if (sessionChanged || model.shouldReload(syncedRev.current, history.rev())) {
      if (sessionChanged) {
        /* 换人时把版本号打回未记录状态：即使这次拉失败，下次进来还会再试 */
        syncedRev.current = undefined;
        /**
         * ⚠⚠⚠ 2026-10-21 用户报障「退出登录后标签管理没有重置」——根因就在这里：
         *   本页是**常驻**的，换人时只有 `loadCloud()` 会重新拉数据，而**标签那一路
         *   没有任何人去清**（`tags` / `untagged` / `tagErr` / `tagOpen` 都是本页自己的
         *   state，不下线、不失效）—— 于是上一个人的标签名、甚至开着的「标签管理」面板、
         *   上一次的报错，会一直挂在新用户（或未登录）的屏幕上。
         *
         * ⚠ 五样**必须一起**归零，少一样就是「面板空了但还开着 / 报错留在底部」这种半截状态：
         *   · `tags` / `untagged` —— 面板与 chip 的数据源；
         *   · `tagErr` —— 上一个人那次失败的文案（会一直留在面板底部）；
         *   · `tagOpen` —— 面板本身（登出了还开着，看着像上一个账号的东西）；
         *   · `tagSel` + `tagSelRef` —— **生效中**的标签筛选，也要退回「全部」。
         * ⚠⚠ 顺序不能反：`loadCloud()` 是**同步**读 `tagSelRef` 拼 query 的
         *   （setState 异步），所以 ref 必须在下面那行 loadCloud **之前**清掉 ——
         *   否则这一次拉取还带着上一个人的标签 id。
         */
        setTags([]);
        setUntagged(0);
        setTagErr('');
        setTagOpen(false);
        setTagSel('');
        tagSelRef.current = '';
      }
      loadCloud();
    }

    return () => {
      off();
      stopWatch();
    };
  }, [active, sessionRev, loadCloud, renderBoot, stopWatch]);

  /* ---------------- 交互 ---------------- */

  /**
   * 打开一条记录：把**轻记录**交给结果页，由它现场重排整份盘。
   * ⚠ 走内存总线（chartBus），不写 storage —— 本地一个字节都不留。
   */
  const onOpen = useCallback((item: Item) => {
    const handoff = model.toHandoff(item);
    if (!handoff) return;
    chartBus.put(handoff);
    onOpenRecord(handoff);
  }, [onOpenRecord]);

  /** 失败后点重试：忽略本次冷启动的结论，真的重走一遍，并把记录也重拉 */
  const onBootRetry = useCallback(() => {
    if (bootState.stage !== boot.STAGE.FAILED) return;
    boot.ensureUser(true).then((res: any) => {
      if (!res.ok) {
        console.warn('[paipan] 启动引导重试仍未完成：' + res.reason + ' ' + res.error);
      }
      loadCloud();
    });
  }, [bootState.stage, loadCloud]);

  /**
   * 点启动引导那条。
   * ⚠ 按状态分派：NEED_LOGIN → 去登录；FAILED → 重试。
   *   「重试」按钮放在 NEED_LOGIN 上是本页最容易犯的错（重试不解决未登录）。
   */
  const onBootBar = useCallback(() => {
    if (bootState.canLogin) { onGoLogin(); return; }
    onBootRetry();
  }, [bootState.canLogin, onGoLogin, onBootRetry]);

  /** 拉记录那一条：fail → 重试；skip（未登录）→ 去登录 */
  const pullAction = model.pullActionOf(pull);

  /**
   * ⚠⚠ 草稿姓名与生效姓名不一样（= 「查询」那颗按钮得发亮，告诉用户「你打的还没生效」）。
   *
   * 为什么必须有这个信号：姓名输入框是个**没有取消**的草稿态 ——
   *   打了字不点查询，列表还是旧的。没有一个可见的「还没生效」提示，
   *   用户会以为**自动就筛好了**，然后对着没变的列表找自己刚打的字。
   *
   * ⚠ 比的是**归一化之后**的值：打一个尾随空格不算「待查询」，
   *   否则按钮会一直亮着，反而变成噪音。
   * ⚠⚠ 这里用 `nameKw`（state）而**不是** `nameDraftRef` —— 这是**故意的**：
   *   nameDirty 只用来决定「按钮亮不亮」，它必须跟着**渲染**走；
   *   而 ref 改了不会触发重渲染 ⇒ 用 ref 算的话按钮的亮度会慢半拍。
   */
  const nameDirty = model.normalizeName(nameKw) !== model.normalizeName(nameRef.current);

  /* ---------------- 姓名查询（★ 在弹窗**外面**，但**要点确认才筛**） ----------------
   * ⚠⚠⚠ 为什么姓名也不能「边打边筛」（第一版是即时筛，被用户否了）：
   *   用户原话 ——「输入中自动筛选很容易造成后端压力」。
   *   打「张三丰」三个字就是**三次请求**，而前两次的结果当场作废
   *   （打完第三个字，前两次的响应才刚回来，白白占着后端的连接与 CPU）。
   *   所以这里也分**两份状态**，与干支弹窗同构：
   *     · `nameKw`  = **草稿**（输入框里正在打的那个，只活在输入框里）
   *     · `nameRef` = **生效**（真正进 query 的那个，只有点了「查询」/回车才写）
   *
   * ⚠ 但两者有一处**不同**：干支弹窗有「取消」（点遮罩丢掉草稿），
   *   姓名这里**没有取消** —— 输入框里打了字却没点查询，它是草稿态，
   *   而列表还是按**上一个生效的**关键词显示的（可能是空）。
   *   这是有意的：输入框不是弹窗，没有「关掉」这个动作，
   *   硬造一个「取消」只会让人不知道点了会怎样。
   *   ⚠ 但**必须给出「草稿还没生效」的信号** → 见 nameDirty（查询按钮变成可点的金色）。
   */

  /**
   * 改姓名输入框 —— ⚠⚠ **只改草稿，绝不发请求**（这是本节的唯一纪律）。
   * 发请求在 `onNameSearch`（点「查询」/按回车）。
   */
  const onNameChange = useCallback((text: string) => {
    nameDraftRef.current = text;   // ⚠ 同步落 ref：提交时读它，不读可能滞后的 state
    setNameKw(text);
  }, []);

  /**
   * 提交姓名查询（点「查询」按钮 / 键盘回车）。
   *
   * ⚠⚠ 三处顺序都不能换：
   *   ① 草稿从 **`nameDraftRef`** 读，不从 `nameKw` 读
   *      —— 键盘回车可能赶在 state 更新之前触发（见 nameDraftRef 注释）；
   *   ② **先写 `nameRef`（生效值）再 `loadCloud`** ——
   *      loadCloud 是**同步**读 `nameRef.current` 拼 query 的，
   *      反过来的话这次请求带的就是**上一次**的关键词（现象：点了查询，结果差一轮）；
   *   ③ 「没变就不发」的守卫放在最前，但比较的是**归一化后**的值
   *      （「张三」→「张三 」不算变，否则点一下查询就白发一次往返）。
   */
  const onNameSearch = useCallback(() => {
    const draft = nameDraftRef.current;
    const next = model.normalizeName(draft);
    if (next === model.normalizeName(nameRef.current)) return;   // 没变 ⇒ 不发请求
    nameRef.current = draft;
    loadCloud({ keepTotal: true });
  }, [loadCloud]);

  /**
   * 清空姓名（输入框右侧那个 ✕）。
   *
   * ⚠ 它是**立即生效**的，不走「要点查询」——
   *   点 ✕ 的意图明确到不需要二次确认（与弹窗里的「清除筛选」同理）。
   * ⚠ 两个 ref 都要清：生效值（否则列表还按旧名字筛）与草稿
   *   （否则提交时又把它当成「刚打的字」重新筛回去）。
   */
  const onNameClear = useCallback(() => {
    nameDraftRef.current = '';
    setNameKw('');
    if (!model.normalizeName(nameRef.current)) return;   // 生效值本来就是空 ⇒ 没什么可清
    nameRef.current = '';
    loadCloud({ keepTotal: true });
  }, [loadCloud]);

  /* ---------------- 筛选（★ 过滤在服务端，这里只改参数并重拉） ---------------- */

  /**
   * 每次筛选状态一变就**重新向服务端要数据**（带参数）。
   *
   * ⚠ 这是本功能的核心约定：**不在本地过滤**。所以「勾一个地支」=
   *   发一次 `GET /records?yearZhi=辰`，而不是把当前列表筛一遍。
   *   代价是每次点击一次网络往返 —— 对本地后端（同一局域网/同一台机）可以忽略；
   *   换来的是记录上千条时首屏依然快（不用把全部拉到手机上）。
   *
   * ⚠ `keepTotal: true`：带筛选的这次拉取**不要**覆盖「总条数」——
   *   否则「共 N 例」里的 N 会变成筛后的数字，那是个会骗人的分母。
   */
  const reloadWithFilter = useCallback((next: any) => {
    setFilter(next);
    filterRef.current = next;   // ⚠ 同步落 ref：loadCloud 是异步触发的
    loadCloud({ keepTotal: true });
  }, [loadCloud]);

  /* ---------------- 筛选弹窗（★ 勾的是草稿，点「确定」才生效） ----------------
   * ⚠⚠ 弹窗里**一律不动** `filter`/`filterRef`，也**不发任何请求** ——
   *   那份草稿现在由 components/FilterModal.tsx 自己管（打开时深拷 applied）。
   *   本页只在「确定」回调里收到草稿，用 model.applyPlan 决定下一步。
   *   勾到一半点取消，界面上（角标、列表、空态）一个像素都不该变。
   */

  /** 打开弹窗（⚠ 深拷草稿在组件内部做：visible 翻真时 clone(applied)） */
  const onFilterOpen = useCallback(() => {
    if (!canFilter) return;      // 后端不支持时按钮本来就不给点
    setFltOpen(true);
  }, [canFilter]);

  /** 取消 / 点遮罩：关窗，草稿由组件直接丢弃 */
  const onFilterCancel = useCallback(() => {
    setFltOpen(false);
  }, []);

  /**
   * 「确定」：草稿 → 生效，并按 model.applyPlan 的决定去拉数据。
   *
   * ⚠⚠ `reloadWithFilter` 传入**空筛选**时，`toQuery` 会给空对象 ⇒
   *   loadCloud 发的是**不带筛选参数**的请求 ⇒ 正好是「清除筛选看全部」。
   *   所以「筛了什么」和「清除筛选」走的是同一条路，不需要单独的分支。
   */
  const onFilterConfirm = useCallback((draft: any) => {
    const plan = model.applyPlan(draft, filterRef.current);
    setFltOpen(false);
    if (plan.action === 'close') return;   // 草稿没变 ⇒ 白发一次请求，省掉
    reloadWithFilter(plan.filter);
  }, [reloadWithFilter]);

  /** 列表空态/顶部那行的「清除筛选」：把干支**和姓名一起**清掉
   *  ⚠ 只清干支而留着姓名，用户会看到「清除筛选」之后列表还是筛过的
   *    —— 那是这句话在骗人。两样都是筛选，就一起清。
   *  ⚠⚠ 姓名这里清的是**生效值**（nameRef）；`nameKw` 是输入框里的草稿，
   *    必须**一起清空** —— 不清的话输入框里还留着那个名字，
   *    看起来像「清掉了但还写着」（虽然确实没在筛了，但没人能看出来）。
   *  ⚠⚠⚠ **两个姓名 ref 都要清**：漏掉 `nameDraftRef` 的话，
   *    清除后输入框是空的、但 ref 里还躺着旧草稿 ⇒ 下次按回车会拿它重新筛回去
   *    （现象：「清除筛选」之后一按回车，旧关键词又回来了）。 */
  const onResetFilter = useCallback(() => {
    if (!model.hasFilter(filterRef.current, nameRef.current, tagSelRef.current)) return;
    setNameKw('');
    nameRef.current = '';
    nameDraftRef.current = '';
    /* ⚠⚠ 标签也要一起清 —— 它是筛选的**第三个维度**。
       只清干支和姓名而留着标签，用户点「清除筛选」之后列表还是筛过的，
       而标签栏上那一格还亮着 —— 那句话就成了骗人的（同「只清干支留着姓名」那条）。 */
    tagSelRef.current = '';
    setTagSel('');
    reloadWithFilter(model.emptyFilter());
  }, [reloadWithFilter]);

  /* ---------------- 标签栏（★ 点哪格看哪格，就地生效） ----------------
   * ⚠ 与筛选弹窗**刻意相反**：那边要点「确定」才生效（勾到一半点取消要能回得去），
   *   这边点一下立刻生效。区别在于**形态**：弹窗里是八个类别的一堆勾（半成品状态
   *   很常见，必须能取消），这里是排成一行的一格一格（点哪格＝看哪格，没有中间态）。
   */

  /**
   * 点标签栏的某一格。
   *
   * ⚠⚠ 顺序不能换：**先写 `tagSelRef` 再 `loadCloud`** ——
   *   loadCloud 是**同步**读 ref 拼 query 的，反过来的话这次请求带的是**上一格**
   *   的标签（现象：点了「客户」，列表却是「全部」或上一次的结果）。
   * ⚠ 点的就是当前那一格 ⇒ **不发请求**（否则每次手滑点一下都是白跑一趟）。
   */
  const onTagBarPick = useCallback((key: string) => {
    const next = key === undefined || key === null ? '' : String(key);
    if (next === tagSelRef.current) return;
    tagSelRef.current = next;
    setTagSel(next);
    /* ⚠ `keepTotal: true`：标签栏的计数来自 `/tags`，不是列表长度 ——
       别让一次带标签的拉取去改「共 N 例」那个分母。 */
    loadCloud({ keepTotal: true });
  }, [loadCloud]);

  /**
   * 顶部标签栏右端那枚固定的「管理」—— 开**标签管理**面板。
   *
   * ⚠⚠ 本页只做**标签本身**的事（新建 / 改名 / 删除），**不做归类**：
   *   归类只在排盘结果的「详细信息 → 标签」那一行（用户 2026-10-05 定）。
   *   ⇒ 面板固定 `mode='manage'`；「目标记录」这个概念在本页**整个不存在**
   *     （`tagFor` 这个 state、卡片上那个入口，都一起删掉了 —— 不是留着不用）。
   * ⚠ 清 tagErr：上一次失败的文案不该带进这次（那不是这次的错）。
   */
  const onTagManage = useCallback(() => {
    if (!canTags) return;
    setTagErr('');
    setTagOpen(true);
  }, [canTags]);

  /** 关面板（⚠ 忙的时候不许关：刚点「确定」就消失，用户看不到成功还是失败） */
  const onTagClose = useCallback(() => {
    if (tagBusy) return;
    setTagOpen(false);
  }, [tagBusy]);

  /**
   * 面板里「新建」（**本页唯一的标签写操作**；只管建，不归类）。
   *
   * ⚠★ 名字判定走 **model.planNewTag**（纯函数、有断言）：
   *   · 名字不合法      → 就地报错，一个请求都不发
   *   · **已经有同名的** → **如实说一句**：管理模式**没有「选中它」这回事**
   *     （「选中」是为了归类，而这一页不归类）—— 不说的话用户打完字按了新建，
   *     界面一点反应都没有，他会以为没生效
   *   · 否则真去建
   *   ⚠ 服务端的 409 仍然保留 —— 它是防并发的结构保证（UNIQUE(user_id,name)），
   *     不是这里这句本地判断的替代品。
   *
   * ⚠ 建完重拉一遍标签（并关窗）：`count` 与「全部」那一格的分母都跟着变，
   *   重拉一次口径最稳。
   */
  const onTagCreate = useCallback((name: string) => {
    const plan = model.planNewTag(tags, name);
    if (plan.action === 'none') {
      setTagErr(plan.error || '标签名不对');
      return;
    }
    if (plan.action === 'select') {
      setTagErr('已经有「' + plan.name + '」这个标签了');
      return;
    }

    setTagBusy(true);
    setTagErr('');
    /* ⚠ id 在这里生成、失败也不换 —— 重试时要沿用同一个（core/tags.js 的 newId 注释） */
    const id = tagsLib.newId();
    tagsLib.create(plan.name, { id: id }).then((r: any) => {
      if (!r.ok) {
        setTagBusy(false);
        setTagErr(r.error || '新建失败，请重试');
        return;
      }
      /** 先本地并进去：面板里的列表立刻能看到它（重拉是异步的，会慢半拍） */
      setTags((prev: any[]) => tagsLib.upsert(prev, r.tag));
      setTagBusy(false);
      setTagOpen(false);
      loadTags();
    });
  }, [tags, loadTags]);

  /**
   * 面板里改名。
   * ⚠ **不重拉记录**：改名只动 `tags` 那一行，卡片上那枚 chip 的文字是由
   *   `tags` 列表算出来的（model.tagNameOf）—— `setTags` 之后它自己就变了。
   *   重拉一次只会让列表闪一下（loadCloud 开头会 setList([])），白搭。
   */
  const onTagRename = useCallback((id: string, name: string) => {
    setTagBusy(true);
    setTagErr('');
    tagsLib.rename(id, name).then((r: any) => {
      setTagBusy(false);
      if (!r.ok) {
        setTagErr(r.error || '改名失败，请重试');
        return;
      }
      setTags((prev: any[]) => tagsLib.upsert(prev, r.tag));
    });
  }, []);

  /**
   * 面板里删除标签（⚠ **只解除归类，一条记录都不会删** —— 服务端由外键 CASCADE 保证）。
   *
   * ⚠⚠ 如果此刻正按这个标签筛着 ⇒ **必须把筛选退回「全部」**：
   *   那个标签已经没有记录了，继续按它筛只会得到一片空白，而标签栏上那一格
   *   也已经被删掉了 —— 用户会彻底不知道自己在看什么、也不知道怎么退出来。
   */
  const onTagRemove = useCallback((id: string) => {
    setTagBusy(true);
    setTagErr('');
    tagsLib.remove(id).then((r: any) => {
      setTagBusy(false);
      if (!r.ok) {
        setTagErr(r.error || '删除失败，请重试');
        return;
      }
      setTags((prev: any[]) => tagsLib.drop(prev, id));
      /* ⚠ 顺序同 onTagBarPick：先改 ref（loadCloud 同步读它），再重拉 */
      if (tagSelRef.current === id) {
        tagSelRef.current = '';
        setTagSel('');
      }
      setTagOpen(false);
      loadCloud({ keepTotal: true });
    });
  }, [loadCloud]);

  /* ---------------- 样式 ---------------- */

  const s = useMemo(() => StyleSheet.create({
    bootBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: rpx(16),
      paddingHorizontal: rpx(22),
      marginBottom: rpx(20),
      borderRadius: rpx(RADII.card),
      borderWidth: StyleSheet.hairlineWidth,
    },
    bootSpin: {
      width: rpx(24), height: rpx(24),
      borderRadius: rpx(12),
      borderWidth: rpx(3),
      borderColor: '#eadfc7',
      borderTopColor: COLORS.gold,
      marginRight: rpx(14),
    },
    bootDot: {
      width: rpx(12), height: rpx(12),
      borderRadius: rpx(6),
      backgroundColor: COLORS.goldLight,
      marginRight: rpx(14),
    },
    bootText: { flex: 1, minWidth: 0, lineHeight: rpx(24 * 1.5) },
    // 通栏白底直角：负 margin 抵消 .page 的左右留白，正好顶到屏幕两边
    page: {
      paddingTop: rpx(SIZES.pagePadTop),
      paddingBottom: rpx(SIZES.pagePadBottom),
      paddingHorizontal: rpx(SIZES.pagePadX),
      /* ⚠⚠ `flexGrow: 1` 是给**空列表**准备的：
         内容不足一屏时，它把容器撑满整屏 ⇒ 空态块下方的空白区域
         也能接住下拉手势。少了它，空列表时只有顶部那块小区域能下拉
         —— 而「空列表」恰恰是最想下拉刷新的场景之一。 */
      flexGrow: 1,
    },
    /** ⚠⚠ 工具栏**显示着**时给滚动内容补的顶部留白（见 `toolBar` 注释）。
     *  工具栏是 ScrollView 的兄弟、压在上面 ⇒ 内容会从它底下开始，
     *  不补这一段的话列表第一张卡会**钻到工具栏底下**（上半截看不见）。
     *  ⚠ 工具栏**不显示**时（列表空且无筛选）样式整体不生效 ——
     *  这时 `s.page` 原本的 `paddingTop: pagePadTop` 已经给够了。 */
    pageWithTools: { paddingTop: rpx(SIZES.toolBarGap) },
    /** 钉在列表上方的工具栏：筛选入口 + 姓名查询（两行一组）。
     *  ⚠⚠ 它**只给横向留白与顶部留白**，`paddingBottom: 0` —— 两行之间的
     *  间距已由 `fltEntry.marginBottom` 与 `nameRow.marginTop` 自己管，
     *  这里再加一段会双重留白。
     *  ⚠⚠ **不许套 `s.page`**（那里面有 pagePadTop + 左右 padding +
     *  flexGrow，flexGrow 会让它把列表挤没）。 */
    toolBar: {
      paddingTop: rpx(SIZES.pagePadTop),
      paddingHorizontal: rpx(SIZES.pagePadX),
      backgroundColor: '#f5f5f5',
    },
    /* ⚠⚠ 列表项之间**不留间隔**（2026-10-10 用户：不要间隔，仅用分割线）：
       每条通栏白底直接相接，条与条之间只画一条 hairline。
       ⚠ 共享令牌 SIZES.cardGap（排盘 / 设置 / 结果页的「独立卡片」留白）这里不适用。 */
    card: { backgroundColor: COLORS.bg },
    /** 条与条之间的分割线（⚠ 只加在**非最后一条**上 —— 末尾一条线悬在灰底上很怪） */
    cardDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: '#e5dccb',
    },
    recCard: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: rpx(26),
      /* ⚠⚠ 这两条负 margin 曾是「通栏出血」用的（抵消 .page 的左右 padding）——
         但 pagePadX 后来定为 0（「一屏 11 列」前提），负 margin 反而把卡片拉出屏幕：
         内容起点 = 0 - 26 + 26 = 0，**文字直接贴住屏幕边缘**（用户报的第一个毛病）。
         现在背景本来就是通栏的，删掉这两条即可，文字自然回到 26 内缩。 */
      borderRadius: 0,
    },
    recLeft: { flex: 1, minWidth: 0 },
    /** 名字 + 标签 chip 同一行（2026-10-10 用户：「标签应该放在名字的右侧」）。
     *  ⚠⚠ 样式名**绝不能叫 `nameRow`** —— 那是顶部姓名查询行的名字，
     *  screens-check 有断言「ScrollView 里不许出现 s.nameRow」，
     *  重名会让那条断言在干净源上假红。 */
    recNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: rpx(6),
    },
    recName: { flexShrink: 1, fontSize: rpx(30), fontWeight: FONT_WEIGHTS.semibold, color: COLORS.text },
    recSub: { fontSize: rpx(24), color: COLORS.textMuted, lineHeight: rpx(24 * LINE_HEIGHTS.loose) },
    recRight: { textAlign: 'right', marginLeft: rpx(20) },
    recChars: {
      fontSize: rpx(30), fontWeight: FONT_WEIGHTS.semibold, color: '#8a7a5c',
      lineHeight: rpx(30 * 1.5), letterSpacing: rpx(2),
    },
    empty: { paddingTop: rpx(120), paddingBottom: rpx(80), alignItems: 'center' },
    emptyIcon: {
      width: rpx(SIZES.emptyIconSize), height: rpx(SIZES.emptyIconSize),
      borderRadius: rpx(SIZES.emptyIconSize / 2),
      backgroundColor: '#f0e9dc',
      alignItems: 'center', justifyContent: 'center',
      marginBottom: rpx(24),
    },
    emptyIconText: { color: COLORS.goldLight, fontSize: rpx(SIZES.emptyIconFontSize) },
    emptyText: { fontSize: rpx(SIZES.emptyTextSize), color: COLORS.textMuted },
    emptyTip: { fontSize: rpx(SIZES.emptyTipSize), color: COLORS.textGhost, marginTop: rpx(12) },
    goBtn: {
      marginTop: rpx(32),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#d8cbb3',
      borderRadius: rpx(RADII.btn),
      paddingVertical: rpx(12),
      paddingHorizontal: rpx(36),
    },
    goBtnText: { color: COLORS.gold, fontSize: rpx(26) },

    /* ===== 筛选 =====
       ⚠ 入口行与弹窗的样式**已经搬进 components/FilterModal.tsx**（2026-10-04
          用户要求「组件封装、复用」，学堂页也要用同一套）。这里只剩下面这一条
          「后端不支持筛选」的页面级说明 —— 它说的是**这一页**的后端支不支持。 */

    /** 后端不支持时压在入口下方的那句说明 */
    fltTip: { marginTop: rpx(-8), marginBottom: rpx(20), paddingHorizontal: rpx(4), fontSize: rpx(23), color: '#b3ab99', lineHeight: rpx(23 * 1.6) },

    /* ===== 姓名查询（★ 在筛选入口**下面**，不进弹窗）===== */
    /* ⚠ 与 fltEntry 同宽同底：两者是「一类工具」的上下两行，
       所以用一样的左右位置、一样的白底方块，视觉上归属同一组。 */
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: rpx(24),
      marginTop: rpx(-8),          /* 抵掉 fltEntry 的 marginBottom，两行贴成一组 */
      marginBottom: rpx(20),
      height: rpx(84),
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.card),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: '#eee6d8',
    },
    /** ⚠ 输入框本体必须 flex:1 + 极小的 padding：中文输入法的候选栏
     *  会以光标位置定位，输入框太窄会让候选栏跑到屏幕外。 */
    nameInput: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 0,          /* ⚠ Android 上默认内边距会让文字偏下 */
      fontSize: rpx(27),
      color: COLORS.text,
    },
    /** 右侧的清空 ✕（只在草稿非空时渲染） */
    nameClear: {
      width: rpx(56),
      height: rpx(56),
      alignItems: 'center',
      justifyContent: 'center',
    },
    nameClearText: { fontSize: rpx(28), color: '#c0b7a6' },
    /** 「查询」按钮 —— ⚠ 只有 nameDirty（草稿与生效不一致）时才是金色可点的 */
    nameGo: {
      paddingHorizontal: rpx(22),
      paddingVertical: rpx(10),
      marginLeft: rpx(6),
      borderWidth: rpx(1),
      borderColor: '#e6dcc9',
      borderRadius: rpx(4),
    },
    nameGoOn: { borderColor: COLORS.gold, backgroundColor: COLORS.gold },
    nameGoText: { fontSize: rpx(25), color: '#b9b0a0' },
    nameGoTextOn: { color: '#ffffff' },

    /* ===== 自定义标签 =====
       ⚠⚠ 卡片上的 chip 是**只读**的（2026-10-05 用户要求「列表中的+标签去掉」）：
         不是 Pressable、点了没有任何反应 —— 点哪儿都是「打开这条记录」。
         改标签只有一条路：进记录 → 「详细信息 → 标签」。
       ⚠ 位置在**名字右侧**（2026-10-10 用户：标签不再自己占一行 ——
         那样卡片竖着摊成四层，太分散）。
       ⚠ chip 要 `flexShrink:0`：名字再长也不能把它压扁 —— 被压扁的 chip
         显示成「客户…」，比换行更糟。 */
    /** 那一枚小 chip（直角、淡金底 —— 全站直角是用户要求） */
    tagChip: {
      flexShrink: 0,
      marginLeft: rpx(12),
      paddingHorizontal: rpx(14),
      paddingVertical: rpx(4),
      borderWidth: rpx(1),
      borderColor: '#e0d0ab',
      backgroundColor: '#fdfaf3',
      borderRadius: 0,
    },
    tagChipText: { fontSize: rpx(22), color: '#a8863f' },

    /* ===== 分页（列表底部那行状态条）=====
       ⚠ 它是**通栏灰底上的小字**（不白底、不描边）—— 列表末尾来一个白方块
         会被当成「还有一张卡片」，用户会去点它。 */
    foot: { paddingTop: rpx(26), paddingBottom: rpx(10), alignItems: 'center' },
    footText: { fontSize: rpx(24), color: COLORS.textGhost },
    /** 续拉失败：那行变成金色可点（与页面上其它「可行动」提示同一套颜色） */
    footErr: { color: COLORS.gold },
  }), [rpx]);

  /**
   * 状态条的配色按阶段分（进行 / 就绪 / 失败）。
   * ⚠ NEED_LOGIN 走的是**金色**那一支（与「进行中」同色系）：
   *   它是正常状态不是故障，用红色会吓到新用户。
   */
  const bootStyle = bootState.stage === boot.STAGE.FAILED
    ? { color: '#c85a54', backgroundColor: '#fdf7f6', borderColor: '#f0dad8' }
    : bootState.stage === boot.STAGE.READY
      ? { color: '#b6a184', backgroundColor: '#fbfaf7', borderColor: '#f4f0e8' }
      : { color: COLORS.gold, backgroundColor: '#fdfbf6', borderColor: '#f2ead9' };

  /** 拉记录那一条的配色与动作（fail 红 / skip 金） */
  const pullStyle = pullAction === 'login'
    ? { color: COLORS.gold, backgroundColor: '#fdfbf6', borderColor: '#f2ead9' }
    : { color: '#c85a54', backgroundColor: '#fdf7f6', borderColor: '#f0dad8' };

  /**
   * 「工具区」（**标签栏 + 筛选入口 + 姓名查询**）显示不显示 —— ⚠ 整块**只有这一处判据**。
   *
   * ⚠⚠ 为什么合成一个常量：这个条件原来在 JSX 里**写了两遍**（工具栏一处、
   *   ScrollView 的 contentContainerStyle 一处），改一个忘另一个就会出现
   *   「顶部白一段 / 白一段不够」。合成一处之后那种错从结构上不可能再犯。
   *
   * ⚠⚠ 为什么把「有标签」也算进来（哪怕列表是空的）：
   *   换一格标签时会先 `setList([])` 再拉数据 —— 若判据只看列表长度，
   *   那一瞬间工具区（含标签栏）会**整块消失再冒出来**（明显闪一下）。
   *   有标签就让它一直在，闪烁从源头消失。
   *   ⚠ 冷启动时既没有标签也没有记录 ⇒ 它仍然是隐藏的（老行为一个字没变）。
   *   ⚠★ 注意区分「工具区显示不显示」（这里）与「标签栏自己显示不显示」：
   *     标签栏现在是**常驻**的（判据只有 canTags，见下面 JSX 的注释）——
   *     所以**有记录**（⇒ 工具区在）时，一枚标签都没有也会看到那一排
   *     「全部 / 未分类 ＋ 新建标签」。而**一条记录都没有**时整块工具区不显示：
   *     标签是用来归类记录的，没有记录时它是空的（那两格计数全是 0）。
   */
  const showTools =
    list.length > 0 ||
    (canTags && (tags.length > 0 || tagSel !== '')) ||
    model.hasFilter(filter, nameKw, tagSel);

  /**
   * 「共 N 例 / 筛出 N 例」里那个 N。
   *
   * ⚠⚠⚠ 分页之后**不能**再拿 `list.length`：首屏只有 50 条，
   *   而实际总共（或筛出来）有 200 条 ⇒「共 50 例」是个假数字，用户会以为记录丢了。
   *   服务端给了 total 就用它（筛后的权威值），没给才退回列表长度（见 model.countShown）。
   */
  const shownCount = model.countShown(list.length, pageTotal);

  /**
   * 列表底部那行（懒加载状态条）。四个状态互斥、判据全在 model.footText：
   *   加载失败（可点重试） > 正在加载… > 还有下一页（**不显示字**） > 没有更多了
   * ⚠ 「没有更多了」只在真的分过页时才出现（total 超过一页），
   *   一共 3 条记录还写一句「没有更多了」纯属噪音。
   */
  const footLabel = model.footText({
    loading: loadingMore,
    hasMore: more,
    total: pageTotal,
    err: moreErr
  });

  return (
    /* ⚠⚠ 外层必须是 View（不是 ScrollView 直接当根）：
       筛选弹窗的遮罩要 absolute 铺满**整屏**，而且要压在列表之上。
       把弹窗放进 ScrollView 里，它会被内容裁剪、还会跟着列表一起滚 ——
       遮罩就不再覆盖全屏了（结果页也是这个结构，见 Result.tsx）。 */
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      {/*
        ===== 工具栏：筛选入口 + 姓名查询 =====
        ⚠⚠⚠ 这两行**必须钉在列表上方**（用户要求：「筛选功能要始终在顶部，
          不能因为滑到下面就看不到了」）⇒ 它们是 ScrollView 的**兄弟**，
          不是它的内容：
            · 放进 contentContainerStyle 里 ⇒ 跟列表一起滚走（就是被报的那个毛病）
            · 两行**共用一个固定容器** ⇒ 不会出现「筛选钉着、姓名滚走」的错位
              （用户拍板「两行一起钉」）
        ⚠ 位置在 ScrollView **之上**，压着列表顶部 —— 不占列表的滚动高度。
        ⚠⚠ 它**故意不在 ScrollView 里**，所以也**不吃下拉手势**：
          下拉只能从列表区域（含它下面的整块）发起。这是钉住的必然代价。
        ⚠⚠⚠ 这一整块**绝不能**套 `s.page`（那里面有 pagePadTop / 左右 padding）：
          它只负责横向留白（`s.toolBar`），纵向的顶部留白交给下面 ScrollView
          内容容器的 `toolBarGap`（否则顶部会白出一段）。
        ⚠ 两个条件合并成一个：原来 fltEntry 与 nameRow 各写一份
          `list.length > 0 || model.hasFilter(...)`，现在整块只判一次，
          避免将来改条件时只改一行、两行行为不一致。
      */}
      {showTools ? (
        <View style={s.toolBar}>
          {/*
            ===== 标签栏（★ 最上面一排 chip）=====
            ⚠⚠ **常驻**（2026-10-05 用户反馈「记录页怎么没有标签功能」之后改的）：
              判据**只有** `canTags`（工具区可见就显示），不再要求「已经有标签」。
              上一版是「有标签才显示」，理由是「一条都没有时只有『全部 / 未分类』两格，
              纯占地方」—— 实测代价是用户**压根不知道这页有标签功能**：
              顶部一直空着，入口只剩卡片上那行小灰字（小到看不见）。
              冗余两格换功能可见，划算。
            ⚠ 右端那枚「管理」由 `onManage` 给（见 TagBar 的注释）——
              它**固定在右侧、不随左边滑动**（用户 2026-10-05 要求），
              一枚标签都没有时它是**唯一**的标签入口。
            ⚠ 它是 ScrollView 的**兄弟**（与下面两行一起钉在顶部），
              见 toolBar 的注释 —— 套进 page 里会被 flexGrow 挤没。
          */}
          {canTags ? (
            <TagBar
              items={model.tagBar(tags, untagged, tagSel)}
              onPick={onTagBarPick}
              onManage={onTagManage}
            />
          ) : null}

          {/*
            ===== 筛选入口（点开弹窗）=====
            ⚠ 面板本身是**弹窗**（用户要求：「点击确定才筛选」）——
              这一条只是个入口，显示当前生效的筛选量 + 计数，
              **不再就地展开**，也**不显示「重置」**（重置是弹窗里的动作，
              放这儿会让人以为点一下就直接生效了）。
            ⚠ 列表为空且没有筛选时**不显示**：没有记录可筛，摆个入口只会占地方。
            ⚠ 后端不支持筛选时仍显示入口，但**明确说明不支持**且不给点 ——
              给个点了没反应的按钮比不给更糟。
            ⚠ 组件在 components/FilterModal.tsx（与学堂页共用同一套外观）。
              「清除筛选」由本页决定给不给（判据与下面那个空态出口一致）。
          */}
          <FilterEntry
            picked={model.totalPicked(filter)}
            countText={model.countText(shownCount, totalAll, model.hasFilter(filter, nameKw, tagSel))}
            onPress={onFilterOpen}
            onReset={model.hasFilter(filter, nameKw, tagSel) ? onResetFilter : undefined}
            disabled={!canFilter}
          />

          {/*
            ===== 姓名查询（★ 用户要求：不进弹窗，放筛选下面）=====
            ⚠⚠⚠ **点了「查询」/ 按回车才真的筛**（用户要求，第一版边打边筛被否）：
              「输入中自动筛选很容易造成后端压力」—— 打「张三丰」三个字
              在旧版是三次请求，前两次的结果当场作废。现在打字**只改草稿**，
              只有 onNameSearch 才发请求。
            ⚠ 因此**必须有**那个「查询」按钮 + nameDirty 高亮：
              输入框是个没有取消的草稿态，不给可见的「还没生效」信号，
              用户会以为打完就自动筛好了。
            ⚠⚠⚠ 判据必须用**草稿**一起看（`nameKw`），不能只看生效值：
              搜了个查不到的名字 ⇒ 列表空 + 「生效筛选」确实非空（能显示），
              但用户接着**把输入框清成空**的那一瞬间，生效值还没变（要等提交），
              只看生效值的话这一整行会**突然消失** —— 而用户手还在输入框上打字。
              （这是「筛空了就再也改不回来」那类死角的同族。）
            ⚠ 位置在入口**下方**（用户原话「放在筛选下面」）——
              上面是「点进去选干支」，下面是「不用点进去直接打名字」，两条路并列。
          */}
          <View style={s.nameRow}>
            <TextInput
              style={s.nameInput}
              value={nameKw}
              onChangeText={onNameChange}
              onSubmitEditing={onNameSearch}
              placeholder="输入姓名查询"
              placeholderTextColor="#b9b0a0"
              returnKeyType="search"
              autoCorrect={false}
              /* ⚠ 不用 autoFocus：这一页是**启动页**，一进来就弹键盘会顶掉列表 */
            />
            {model.normalizeName(nameKw) ? (
              <Pressable style={s.nameClear} onPress={onNameClear} hitSlop={8}>
                <Text style={s.nameClearText}>✕</Text>
              </Pressable>
            ) : null}
            {/* ⚠⚠ 草稿与生效不一致时这颗按钮才「亮」（金色可点），否则是灰的。
                它是「你打的还没生效」的唯一可见信号（见 nameDirty 注释）。 */}
            <Pressable
              style={[s.nameGo, nameDirty ? s.nameGoOn : null]}
              onPress={onNameSearch}
              disabled={!nameDirty}
            >
              <Text style={[s.nameGoText, nameDirty ? s.nameGoTextOn : null]}>查询</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/*
        ===== 下拉刷新（★ 2026-10-10 二改：`PullRefresh` = **松手才刷**）=====
        ⚠⚠⚠ 为什么不用 RN 自带的 `RefreshControl`（上一版就是它）：安卓上它底层是系统
          `SwipeRefreshLayout`，**下拉一过阈值就回调 onRefresh** —— 就是「还没放手就刷了」。
          而且它一抢到手势就给 JS 发 CANCEL、此后连手指抬起都收不到
          ⇒ 「留原生控件 + 把刷新推迟到松手」这条路**在原理上不成立**。
          两处源码依据写在 `components/PullRefresh.tsx` 顶部，别再回去试。
        ⚠ 现在这版是**零依赖**的：被动听 touch（一个字的手势都不抢）+ 整块 translateY
          ⇒ 不会有前两版那种「与列表滚动抢同一个原生视图 ⇒ 拉不动且不报错」。
        ⚠⚠ 下拉**故意不带任何前置条件**：列表空、上次拉失败、未登录……
          任何状态下都要能拉。理由：下拉是用户**最后的自救手段** ——
          「数据不对 / 没出来」的第一反应就是拉一下。
          加个 `list.length > 0` 的条件，就等于在「空列表 + 拉取失败」
          那个最需要它的场景里**把唯一的出口藏起来**。
        ⚠ `refreshing` **必须是 state**（ref 改了不重渲染 ⇒ 文案与收圈都不对），
          且 `onRefresh` **必须把 promise 交出去** —— `PullRefresh` 钉到它 resolve 才收圈。
        ⚠ 它**不替代**那条「云端记录同步失败 · 重试」的可点条：
          那条说的是「**为什么**没数据」（还分 fail / 未登录两种），
          下拉只说「再试一次」。两者是不同层次的出口，都保留。
      */}
      <PullRefresh refreshing={refreshing} onRefresh={onRefresh}>
      <ScrollView
        style={{ flex: 1, backgroundColor: '#f5f5f5' }}
        contentContainerStyle={
          /* `pageWithTools` **只在工具区真的渲染时**才加（判据与上面那个**同一个**
             `showTools` 常量）：
             工具区不显示时不生效 —— 那时 `s.page` 的 `pagePadTop` 已经给够了。
             ⚠ 以前这里和工具栏各写了一份条件（「改一个忘了改另一个」就白一段），
               现在两处共用 showTools，那种错从结构上不可能再犯。 */
          showTools ? [s.page, s.pageWithTools] : s.page
        }
        keyboardShouldPersistTaps="handled"
        /* ⚠⚠ 滚到底续拉下一页（★ 懒加载）。判据在 model.nearBottom（纯函数）——
           这里只负责把 onScroll 的三个数交给它。
           ⚠ 这一行**不会被 PullRefresh 吃掉**：它 cloneElement 时会把我们这份
             `onScroll` **并**到自己那份后面（见 components/PullRefresh.tsx）。 */
        onScroll={onListScroll}
      >
      {/* 启动引导的进度（NEED_LOGIN 时整条可点 → 去登录） */}
      {bootState.show ? (
        <Pressable
          style={[s.bootBar, { backgroundColor: bootStyle.backgroundColor, borderColor: bootStyle.borderColor }]}
          onPress={onBootBar}
        >
          {bootState.pending
            ? <View style={s.bootSpin} />
            : <View style={[s.bootDot, { backgroundColor: bootStyle.color }]} />}
          <Text style={[s.bootText, { color: bootStyle.color }]}>{bootState.text}</Text>
        </Pressable>
      ) : null}

      {/*
        拉记录那一条：
          · fail（断网 / 云端不可用）→ 红色，点重试
          · skip（未登录）          → 金色，点去登录
        ⚠ skip 以前是**完全不显示**的，未登录的人只看到一个空列表 + 「去排盘」，
          根本不知道该去登录。未登录是可行动的，必须给出口。
      */}
      {pullAction !== 'none' ? (
        <Pressable
          style={[s.bootBar, { backgroundColor: pullStyle.backgroundColor, borderColor: pullStyle.borderColor }]}
          onPress={pullAction === 'login' ? onGoLogin : onPullRetry}
        >
          <View style={[s.bootDot, { backgroundColor: pullStyle.color }]} />
          <Text style={[s.bootText, { color: pullStyle.color }]}>{pull.text}</Text>
        </Pressable>
      ) : null}

      {/*
        ⚠⚠ 「筛选入口」与「姓名查询」已**整体搬到 ScrollView 外面**（钉在顶部，
          见上面的工具栏）。**别在这里再放一份** —— 会出现两个筛选入口，
          而且这一个还会跟着列表滚走（就是被报的那个毛病）。
      */}

      {!canFilter ? (
        <Text style={s.fltTip}>{model.filterUnsupportedTip(canFilter)}</Text>
      ) : null}

      {list.length === 0 ? (
        /*
          ⚠⚠ 「一条都没有」和「筛了但没有」是**两件不同的事**，
            文案与出口都必须不同（同一类坑在 boot 那边也踩过）：
              · 真没有记录 → 「还没有排盘记录」+ 去排盘
              · 筛空了     → 「没有符合条件的记录」+ 清除筛选
            否则用户会以为自己的记录丢了。
        */
        model.hasFilter(filter, nameKw, tagSel) ? (
          <View style={[s.card, s.empty]}>
            <View style={s.emptyIcon}><Text style={s.emptyIconText}>滤</Text></View>
            <Text style={s.emptyText}>没有符合条件的记录</Text>
            <Text style={s.emptyTip}>换个干支、姓名或标签再试，或清除筛选看全部</Text>
            <Pressable style={s.goBtn} onPress={onResetFilter}>
              <Text style={s.goBtnText}>清除筛选</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[s.card, s.empty]}>
            <View style={s.emptyIcon}><Text style={s.emptyIconText}>记</Text></View>
            <Text style={s.emptyText}>还没有排盘记录</Text>
            <Text style={s.emptyTip}>{model.emptyTipOf(pull)}</Text>
            <Pressable style={s.goBtn} onPress={onGoPaipan}>
              <Text style={s.goBtnText}>去排盘</Text>
            </Pressable>
          </View>
        )
      ) : (
        /* 列表 */
        list.map((item, i) => {
          /* 四柱两行（用户定稿）：第一行四个天干、第二行四个地支 —— 纯展示切分在 model.pillarRows */
          const rows = model.pillarRows(item.fourChars);
          /* ⚠ 标签名从 **tags 列表**算出来（记录上只有一个只读派生的 tagId）——
             取不到（标签刚在别处被删了）就给空串 ⇒ 不画那枚 chip，下次刷新自愈。 */
          const tagName = model.tagNameOf(tags, item.tagId);
          return (
            <Pressable
              key={item.id}
              style={[s.card, i < list.length - 1 ? s.cardDivider : null, s.recCard]}
              onPress={() => {
                /* ⚠⚠ 下拉刷新抬手那一拍不许顺带把这条记录打开 —— 标记由 PullRefresh 维护 */
                if (isPulling()) return;
                onOpen(item);
              }}
            >
              <View style={s.recLeft}>
                {/*
                  ★ 名字 + 标签同一行（2026-10-10 用户：「标签应该放在名字的右侧」）：
                    以前标签自己占一行 ⇒ 卡片竖着摊成四层，太分散。
                  ⚠ 名字要 `flexShrink:1` + `numberOfLines`：名字太长时缩的是名字、
                    不能把 chip 挤出左栏（chip 恒完整可见）。
                */}
                <View style={s.recNameRow}>
                  <Text style={s.recName} numberOfLines={1}>{item.name}</Text>
                  {canTags && tagName ? (
                    <View style={s.tagChip}>
                      <Text style={s.tagChipText}>{tagName}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={s.recSub}>
                  {(item.gender === 1 ? '男' : '女') + ' · ' + item.date + ' ' + item.time}
                </Text>
                <Text style={s.recSub}>{item.lunarText}</Text>
              </View>
              <View style={s.recRight}>
                <Text style={s.recChars}>{rows.stems}</Text>
                <Text style={s.recChars}>{rows.branches}</Text>
              </View>
            </Pressable>
          );
        })
      )}

      {/*
        ===== 列表底部那行（★ 懒加载）=====
        ⚠ 位置：在列表**之后**、ScrollView **之内**（它得跟着列表一起滚 ——
          钉在底部的话会盖住最后一条记录）。
        ⚠ 只有失败那态可点（点一下重拉这一页）；「正在加载…」和「没有更多了」
          都不该有反应 —— 给个点了没动静的东西比不给更糟。
        ⚠ 文案与「显示不显示」全由 model.footText 决定（空串 = 整行不渲染），
          视图里不写第二份判断。
      */}
      {footLabel ? (
        <Pressable
          style={s.foot}
          onPress={moreErr ? onLoadMore : undefined}
          disabled={!moreErr}
        >
          <Text style={[s.footText, moreErr ? s.footErr : null]}>{footLabel}</Text>
        </Pressable>
      ) : null}
      </ScrollView>
      </PullRefresh>

      {/*
        ===== 筛选弹窗（组件在 components/FilterModal.tsx，与学堂页共用）=====
        ⚠⚠ 弹窗里的勾选**只改组件内部的草稿**，点「确定」才通过 onFilterConfirm
          写回生效筛选并重新拉数据（见 onFilterConfirm / model.applyPlan）。
        ⚠ 这一层是 ScrollView 的**兄弟节点**，不在它里面 ——
          放进 ScrollView 会被它裁剪、也会跟着列表一起滚（遮罩就不覆盖全屏了）。
        ⚠ 计数那句必须用**生效值**（`filter` + `nameKw`）算：列表此刻显示的就是
          生效筛选的结果，拿草稿算会显示「筛出 5 例」而列表里明明躺着 30 条。
      */}
      <FilterModal
        visible={fltOpen}
        applied={filter}
        countText={model.countText(shownCount, totalAll, model.hasFilter(filter, nameKw, tagSel))}
        onConfirm={onFilterConfirm}
        onClose={onFilterCancel}
      />

      {/*
        ===== 标签管理面板（★ 顶部标签栏右端那枚固定的「管理」打开）=====
        ⚠⚠ 它也是 ScrollView 的**兄弟节点**（和筛选弹窗一样）——
          放进 ScrollView 会被裁剪、还会跟着列表滚（遮罩就不覆盖全屏了）。
        ⚠ 弹窗里**不发请求**：它只把意图交给本页（onCreate/onRename/onRemove），
          由本页统一去写、写完整理状态、并在成功后重拉列表 ——
          权威只有一份（本页的 tags），组件里不存副本。
        ⚠ `busy`/`err` 也由本页喂进去（见那两个 state 的注释）。
      */}
      <TagPicker
        visible={tagOpen}
        title="标签管理"
        /* ⚠★ 本页**只有管理形态**（`mode='manage'`）：新建 / 改名 / 删除标签，
           不归类、也不给「当前」高亮（那两件事都要有「目标记录」，本页没有）。
           ⚠ 「更换标签」是**另一个页面**的事：排盘结果 →「详细信息 → 标签」，
             那里用 `mode='pick'`（只能换，不能建/改名/删）。
           ⇒ `currentId` 不给、`onPick` 不给（给了也没意义：manage 态不会调它）。 */
        mode="manage"
        tags={tags}
        busy={tagBusy}
        err={tagErr}
        onCreate={onTagCreate}
        onRename={onTagRename}
        onRemove={onTagRemove}
        onClose={onTagClose}
      />
    </View>
  );
}
