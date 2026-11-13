/**
 * 排盘记录：**只存出生信息，不存算出来的盘**
 *
 * 记录里落盘的字段（就叫它「轻记录」）：
 *   { id, name, gender, date, time, createdAt }
 *     · date / time 是**公历**真值（'1990-01-01' / '11:04'）
 *     · 没有 chart，没有 bazi，没有大运流年
 * 外加几个**可选**字段：
 *   { notes }   事件记录（挂在大运 / 流年 / 流月上的批注，见 utils/notes.js）
 *   { desc }    文字描述（这条八字是干什么的）
 *   { job }     职业
 *   它们都不是排盘必需的，用户后来才添、没有就完全不出现 —— 所以不算进那 6 个必填字段，
 *   但要跟着记录上云（见 OPTIONAL_FIELDS 的说明）。
 *
 * ============ 为什么改（上一版的教训）============
 * 上一版把整份盘塞进记录：单条约 5KB，其中逐年小运一个人就占 3.5KB，
 * 上限 50 条 ⇒ 整个用户的记录约 250KB。而当时用的 Gitee contents 接口是
 * 「整个文件 base64 后一次性提交」，每次保存全量重写 —— 又大又慢，
 * 还要专门写个 stripForCloud() 把重字段剥掉，纯属自找麻烦。
 * （现在换成了记录级写入，一次只动一条文档，但「只存轻记录」这个决定照样成立：
 *  省流量、省存储，也让每次保存都只提交真正变了的那点东西。）
 *
 * 盘是**纯函数算出来的**：四柱、藏干、十神、大运、流年、流月，
 * 全部只依赖「出生时间 + 性别」，同一个输入永远同一个输出。
 * 存一份算好的结果，等于存了一份可以随时重算的缓存 ——
 * 而且还会因为「算法升级了」而变成陈旧数据。
 *
 * 所以现在：**存 4 个字段，打开时现场重排一遍**。
 *   · 单条 ≈ 120 字节（原来 5KB，小 40 倍；50 条约 6KB）
 *   · 算法改进后老记录自动跟着变新（不再有「老记录字段缺失」的降级分支）
 *   · 不用再维护 HEAVY_FIELDS / stripForCloud 那套剥字段逻辑
 *
 * ⚠ 唯一要注意的：重排要花一点时间（tyme4ts 算一次盘约几十毫秒，
 *   含 70 年逐年小运），所以打开记录的页面要给个「正在排盘…」的短暂反馈，
 *   不能在冷启动的首帧同步里硬算。
 */
const chartLib = require('./chart.js');
const baziLib = require('./bazi.js');
const lunar = require('./lunar.js');
const timeUtil = require('./time.js');
const notesLib = require('./notes.js');

/** 轻记录的字段白名单 —— 写入云端 / 本地镜像前一律过一遍，防止又混进重字段 */
const LIGHT_FIELDS = ['id', 'name', 'gender', 'date', 'time', 'createdAt'];

/**
 * 记录上可以挂的**可选字段**：有就跟着走，没有就完全不出现。
 * ⚠ 不能塞进 LIGHT_FIELDS —— 那是「必填的 6 个字段」，
 *   而事件是用户后来一条条添上去的，绝大多数记录一辈子都没有。
 * ⚠ 但它**必须**跟着记录上云：history.push() 会把已有的每条都过一遍 toStorage，
 *   漏了它 → 保存任何一条新记录都会顺手把别人的事件记录抹掉。
 *
 * ⚠⚠ desc（文字描述）/ job（职业）也在这张表里 —— 它们走的是**同一条**
 *   「取整条 → 只换一个字段 → PUT 整条」的保存路径，所以漏掉的后果和漏 notes
 *   一模一样：静默抹掉（尤其「改职业」时把描述一起抹了）。
 *   往这张表里加字段时，后端 `lib/record.ts` 的 OPTIONAL_FIELDS 与
 *   `routes/records.ts` 的 upsert 列清单都要同步改 —— **三处漏一处就丢数据**。
 */
const OPTIONAL_FIELDS = ['notes', 'desc', 'job'];

/**
 * 上面那张表里属于**文本**的字段（notes 是对象，判空口径不同，别混）。
 *
 * ⚠ 判空规则：**纯空白一律不要**（`'   '` 不算有内容）。
 *   只按 `!v` 判的话，"  " 会被当成有内容存上去，然后界面上什么都不显示，
 *   看起来像「明明存了却没出来」。
 * ⚠ 这里**只判断、不改写原文**：多行描述里的换行是有意义的内容，
 *   到底要不要 trim 由提交那一层决定（desc 不 trim，job 单行 → trim）。
 */
const TEXT_OPTIONAL_FIELDS = ['desc', 'job'];

/**
 * 摘出可选字段（空对象 / 空数组 / 纯空白字符串一律不要，
 * 省得云端多出 `notes: {}`、`desc: ''`、`job: ''` 这种「有字段但没内容」的行）。
 *
 * ⚠ 两种类型两种判空，别统一成一句 `!v`（判定规则见 TEXT_OPTIONAL_FIELDS 的注释）。
 */
function optionals(rec) {
  const out = {};
  OPTIONAL_FIELDS.forEach(function (k) {
    const v = rec ? rec[k] : null;
    if (TEXT_OPTIONAL_FIELDS.indexOf(k) >= 0) {
      if (typeof v !== 'string' || !v.trim()) return;
      out[k] = v;
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    if (!Object.keys(v).length) return;
    out[k] = v;
  });
  return out;
}

/**
 * 把任意记录（新的轻记录 / 老的重记录）压成轻记录。
 * 老数据里那些 chart / bazi / lunarText 会被丢掉 —— 它们都能重算，留着没用。
 *
 * ⚠ 缺出生时间时**不补默认值**，返回 null。
 *   补一个 1990-01-01 出去，用户看到的就是一份看起来正常、其实完全不相干的盘 ——
 *   比直接显示空态糟糕得多。调用方拿到 null 就渲染空态。
 *   兼容点：上一版存的字段叫 dateText / timeText（那时候 date 只在派生对象里），
 *   所以这两个名字也认。
 *
 * @param {Object} rec
 * @returns {{id:string, name:string, gender:number, date:string, time:string, createdAt:number}|null}
 */
function slim(rec) {
  const r = rec || {};
  const date = r.date || r.dateText || '';
  const time = r.time || r.timeText || '';
  if (!date || !time) return null;

  const out = {
    id: r.id || ('c' + Date.now()),
    name: r.name || '未命名',
    // 老记录的 gender 可能就是 1 / 0；统一成 1 男 0 女
    gender: r.gender === 0 || r.gender === '0' ? 0 : 1,
    date: date,
    time: time,
    createdAt: r.createdAt || Date.now()
  };
  const opt = optionals(r);
  for (const k in opt) {
    if (Object.prototype.hasOwnProperty.call(opt, k)) out[k] = opt[k];
  }
  return out;
}

/** 只保留轻字段（写盘 / 上云前调用）；出生信息不全时返回 null，调用方负责跳过 */
function toStorage(rec) {
  const s = slim(rec);
  if (!s) return null;
  const out = {};
  LIGHT_FIELDS.forEach(function (k) { out[k] = s[k]; });
  // 可选字段（事件记录 / 描述 / 职业）跟着记录走，见 OPTIONAL_FIELDS 的说明
  OPTIONAL_FIELDS.forEach(function (k) {
    if (s[k]) out[k] = s[k];
  });
  return out;
}

/**
 * 从轻记录**现场重排**出完整的一份盘（结构与旧记录一致，chart-view 直接用）。
 *
 * 这是「存 4 个字段」能成立的前提：盘是可以纯函数重算的。
 * 排盘口径统一由 utils/chart.js + utils/bazi.js 决定，这里不引入第二套算法。
 *
 * @param {Object} rec 轻记录（也接受老的重记录，会先 slim 一遍）
 * @param {Object} [o]
 * @param {string} [o.id] 指定 id（从记录页打开时沿用原 id，保证「已保存」判定能对上）
 * @returns {Object|null} 完整记录；时间非法时返回 null
 */
function hydrate(rec, o) {
  const opts = o || {};
  const s = slim(rec);
  if (!s) return null;      // 出生信息不全 → 不猜、不补默认值，让调用方走空态

  const pd = timeUtil.parseDate(s.date);
  const pt = timeUtil.parseTime(s.time);

  // 解析不出合理时间就别硬排（年份越界）
  // ⚠ 用 YEAR_FLOOR / YEAR_CEIL（比可选范围各宽一年），不是 SOLAR_YEAR_MIN/MAX：
  //   农历 2050 年腊月换算出来是公历 2051 年初，是该让用户排的合法日期。
  if (!pd.y || pd.y < timeUtil.YEAR_FLOOR || pd.y > timeUtil.YEAR_CEIL) {
    return null;
  }

  let chart = null;
  let l = null;
  let bazi = null;
  try {
    chart = chartLib.paipan(pd.y, pd.m, pd.d, pt.h, pt.mi);
    l = lunar.solarToLunar(pd.y, pd.m, pd.d);
    bazi = baziLib.calculate({
      year: pd.y, month: pd.m, day: pd.d, hour: pt.h, minute: pt.mi, gender: s.gender
    });
  } catch (err) {
    console.warn('[paipan] 记录重排失败', err);
    return null;
  }
  if (!chart) return null;

  return {
    id: opts.id || s.id,
    name: s.name,
    gender: s.gender,
    date: s.date,
    time: s.time,
    // 事件记录（可选）：跟着记录走，空的时候给一个干净的空对象，
    // 这样页面 / 组件里不用到处判 null
    // ⚠⚠ 进来先过一遍 normalizeLegacy：外部导入的老数据 key 是「含起运前占位的
    //     数字序号」（liunian:3:3），现行 key 是 'pre'/'d0'…—— 不改写的话
    //     红点与内联正文全部静默失联（见 notes.js normalizeLegacy 的说明）。
    //     在 hydrate 这一个咽喉点做：之后任何保存都会把新 key 自然写回云端。
    notes: notesLib.normalizeLegacy(s.notes) || {},
    // 文字描述（可选）：**这里是 undefined，不是 ''** —— 让「有没有描述」这件事
    // 在界面上是一个明确的判断（`rec.desc ? 显示 : 显示占位`），
    // 而不是靠「空字符串也算假值」这种隐式行为。空串走不到这里（slim 里已被 optionals 摘掉）。
    desc: s.desc,
    /* 职业（可选，2026-10-06 新增）：**与 desc 同一套** —— 没填时是 undefined。
       ⚠⚠ 漏了这一行就是最坏的那种 bug：记录页读回来的 rec 上没有 job
         ⇒ 详细信息显示「未填写」、修改时预填空的，
         而**修改任意别的字段再保存**（走 toStorage(rec) 整行 PUT）正好把库里的职业抹掉。
         读路径必须把每个能写的字段都搬过来。 */
    job: s.job,
    dateText: timeUtil.fmtDate(pd.y, pd.m, pd.d),
    timeText: timeUtil.fmtTime(pt.h, pt.mi),
    lunarText: l ? l.text : '—',
    zodiac: chart.zodiac,
    chart: chart,
    lunar: l,
    bazi: {
      siLing: bazi.siLing,
      taiYuan: bazi.taiYuan,
      qiYunText: bazi.qiYunTime ? bazi.qiYunTime.dateText + ' ' + bazi.qiYunTime.timeText : '',
      jiaoYunText: baziLib.jiaoYunText(bazi.jiaoYun),
      dayunDirection: bazi.dayunDirection,
      dayuns: bazi.dayuns,
      yearlyFortunes: bazi.yearlyFortunes,
      birthYear: bazi.birthYear
    },
    createdAt: s.createdAt
  };
}

/**
 * 造一条新记录（排盘页用）。
 *
 * @param {string} name   姓名
 * @param {number} gender 1 男 / 0 女
 * @param {string} dateStr 公历 YYYY-MM-DD
 * @param {string} timeStr HH:mm
 * @param {string} [desc] 描述（可选；空 / 空白会被 optionals 摘掉，不带上云）
 * @returns {Object} 完整记录（可以直接交给结果页渲染）
 */
function create(name, gender, dateStr, timeStr, desc) {
  return hydrate({
    id: 'c' + Date.now(),
    name: name,
    gender: gender,
    date: dateStr,
    time: timeStr,
    desc: desc,
    createdAt: Date.now()
  });
}

module.exports = {
  LIGHT_FIELDS: LIGHT_FIELDS,
  OPTIONAL_FIELDS: OPTIONAL_FIELDS,
  slim: slim,
  toStorage: toStorage,
  hydrate: hydrate,
  create: create
};
