/**
 * 事件记录 —— 挂在大运 / 流年 / 流月上的批注
 *
 * 用户 2026-10-01：「事件记录页面请参考 mingliWEB 项目的案例详情的事件记录」，
 * 以及「排盘结果，如果保存了，就可以像 mingliWEB 案例详情的基本信息的大运流年流月一样的功能」。
 * 对应的参考实现是 mingliWEB 的 modules/detail.js（「事件记录」Tab 与基本信息页的双击录入）
 * 加 bazi.js 的 cellNoteKey / applyNoteMarks / renderNotePanels。
 *
 * ============ key 的形状（与参考项目同构）============
 *   dayun:<大运 key>
 *   liunian:<大运 key>:<流年下标>
 *   liuyue:<大运 key>:<流年下标>:<流月下标>
 * 例：dayun:d3 / liunian:d3:2 / liuyue:d3:2:5
 *
 * 「大运 key」就是 chart-view 里 dayuns 的 item.key：'pre'（起运前小运）或 'd0'..'d11'。
 * 也就是说 key 里的下标是**表里的位置**（0 起），不是岁数、也不是年份 ——
 * 大运表首列是「起运前」，所以 d0 是第一步真正的大运，与参考项目的 1 起下标差一位。
 * 换算法口径只要表的结构不变，老事件的落点就不会漂。
 *
 * ============ 存的是「正文 + 元信息」============
 * 一条事件：{ text, year, ganzhi, age, md?, jieQi?, up?, up2? }
 * ⚠ 元信息是**写入时快照**的，读的时候不回算。
 *   参考项目那边会回算（它有一整套 generateLunarMonths 链路），我们刻意不回算：
 *   ① 「事件记录」页签只读 notes 就能渲染，不需要先排一遍盘；
 *   ② 事件是历史事实，不该因为算法升级而跟着变。
 *   代价是元信息可能带一点点当时的算法痕迹 —— 可接受，比"事件跟着算法漂"好。
 *   `up` / `up2` 是**父级 / 祖父级**的快照，同样在写入时带回来（见 upOf 的说明）：
 *   父级那一行自己没写正文时，就靠它才有标题可显示。
 *
 * ============ 「事件记录」页签是只读的 ============
 * 与参考项目的「编辑事件」页一致：整页只做全量时间线（大运 → 流年 → 流月三层），
 * 加 / 改 / 删统一在「排盘结果」里**长按**某格做（参考项目是双击，桌面上没有「长按」）。
 * 同一个动作只有一个入口，不会两处逻辑打架。
 */
const LEVELS = ['dayun', 'liunian', 'liuyue'];

/** 一条事件里会被写进标题的字段（顺序即 titleOf 的取用顺序） */
const META_FIELDS = ['year', 'ganzhi', 'age', 'md', 'jieQi'];

/** 拼一条事件的 key */
function key(level, dayunKey, lnIdx, lyIdx) {
  if (level === 'dayun') return 'dayun:' + dayunKey;
  if (level === 'liunian') return 'liunian:' + dayunKey + ':' + lnIdx;
  return 'liuyue:' + dayunKey + ':' + lnIdx + ':' + lyIdx;
}

/** 取正文（老数据可能直接是字符串，不带元信息） */
function textOf(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.text || '';
  return '';
}

/** 真有正文吗（只有空白等于没写 —— 用户把内容删空就是在删这条事件） */
function hasText(val) {
  return !!String(textOf(val)).trim();
}

/** 取元信息；不是对象（老数据）时给一份空壳，调用方不用判空 */
function metaOf(val) {
  const out = { year: '', ganzhi: '', age: '', md: '', jieQi: '' };
  if (!val || typeof val !== 'object') return out;
  META_FIELDS.forEach(function (f) {
    if (val[f] !== undefined && val[f] !== null) out[f] = val[f];
  });
  return out;
}

/**
 * 父级信息：写更细的一层时，组件会把**上一级 / 上两级**的快照一并带上。
 *
 * 为什么需要它 —— 「事件记录」页是三层时间线，父级那一行即使自己没写正文也得出
 * 现（否则看不出这条流年属于哪一步大运），而它自己没写就没有元信息可显示，
 * 标题会退化成光秃秃一个「【大运】」。
 * 参考项目是**回算**（detail.js 的 dyMetaOf / liuniansOfDayun，要跑
 * generateLunarMonths）；这里改成写入时把父级一起快照下来，
 * 读的时候一个字节都不用算 —— 与「元信息是写入时快照」是同一条原则。
 * 旧数据（还没有 up / up2）只会退化成只有层级名的标题，不影响正文。
 */
function upOf(val) {
  if (!val || typeof val !== 'object') return null;
  return (val.up && typeof val.up === 'object') ? val.up : null;
}

function up2Of(val) {
  if (!val || typeof val !== 'object') return null;
  return (val.up2 && typeof val.up2 === 'object') ? val.up2 : null;
}

/** 自己的元信息优先，缺的项用 fallback 补（只有自己没写正文时才走 fallback） */
function metaWithFallback(own, fallback) {
  const m = metaOf(own);
  if (hasText(own)) return m;
  const f = metaOf(fallback);
  META_FIELDS.forEach(function (k) {
    if ((m[k] === '' || m[k] == null) && f[k] !== '') m[k] = f[k];
  });
  return m;
}

/** 大运 key('pre' | 'd3') → bazi.dayuns 的下标（'pre' 没有下标，返回 -1） */
function dayunIndexOf(key) {
  if (key === 'pre') return -1;
  const n = parseInt(String(key).slice(1), 10);
  return isNaN(n) ? -2 : n;
}

/** bazi.dayuns 的下标 → 大运 key（与 chart-view 的 buildDayuns 同源，别在别处再算一遍） */
function dayunKeyOf(index) {
  return index < 0 ? 'pre' : 'd' + index;
}

/**
 * ⚠⚠ 旧版 key 兼容（2026-10-03 实测抓到）：外部导入的老数据，大运那一段是
 * **含「起运前」占位的表内序号**——`liunian:3:3` 的「3」指的是表格第 3 格
 * （0 格 = 起运前小运，1 格 = 第一步大运 d0）。现行 key 用 `dayunKeyOf`（'pre'/'d0'…），
 * 两套对不上 ⇒ `decorate` 按 'd2' 找不到 '3'，**红点与内联正文全部静默失联**
 * （「事件记录」页签不受影响 —— 它只读值、不看 key，所以看起来「事件都在、点没了」）。
 *
 * 改写规则（**只动 key，值一个字节不碰**；已用真实数据验证过映射：
 * 老库 `liunian:3:3 → year 2017 丁酉`，按此规则落在新表 d2 的下标 3 = 2014+3 ✓）：
 *   dayun:N / liunian:N:i / liuyue:N:i:j
 *     N=0 → 'pre'；N≥1 → 'd' + (N-1)
 * 幂等：现行格式的 key 原样通过；不认识的 key **也原样通过** —— 绝不丢数据。
 */
function normalizeLegacy(notes) {
  if (!notes || typeof notes !== 'object') return notes;
  const out = {};
  Object.keys(notes).forEach(function (k) {
    const m = /^(dayun|liunian|liuyue):(\d+)((?::\d+)*)$/.exec(k);
    if (!m) { out[k] = notes[k]; return; }
    out[m[1] + ':' + dayunKeyOf(Number(m[2]) - 1) + m[3]] = notes[k];
  });
  return out;
}

/**
 * 事件标题 —— 弹窗标题与时间线**共用这一份**，保证「录的时候看到的」和
 * 「记录页里显示出来的」是同一句话（两处各拼一次必然对不齐）。
 */
function titleOf(level, meta) {
  const m = metaOf(meta);
  const age = (m.age === '' || m.age == null) ? '' : (m.age + '岁');
  if (level === 'dayun') {
    const head = (m.ganzhi === '小运') ? '起运前小运' : (m.ganzhi ? m.ganzhi + '大运' : '大运');
    return '【大运】' + [head, m.year, age].filter(joinable).join(' ');
  }
  if (level === 'liunian') {
    return '【流年】' + [[m.year, m.ganzhi].filter(joinable).join(' '), age].filter(joinable).join(' · ');
  }
  return '【流月】' + [[m.jieQi, m.md].filter(joinable).join(' '), m.ganzhi].filter(joinable).join(' ');
}

function joinable(s) {
  return !!s;
}

/** 大运 key 的排序权重：起运前小运最前，其余按 d 后面的数字 */
function cmpDayunKey(a, b) {
  if (a === b) return 0;
  if (a === 'pre') return -1;
  if (b === 'pre') return 1;
  return (parseInt(String(a).slice(1), 10) || 0) - (parseInt(String(b).slice(1), 10) || 0);
}

/**
 * 把 notes 摊成「事件记录」页签要渲染的**扁平行**（大运 → 流年 → 流月 三层）。
 *
 * 为什么摊平：三层嵌套在 ttml 里要写三层 tt:for，还要为「大运自己没写、但它下面的
 * 流年写了」这种半空的分组单独判空；摊平之后模板只有一个 tt:for，
 * 层级只体现在缩进 class 上（.tl-dayun / .tl-liunian / .tl-liuyue），
 * 与参考项目那条 dt-timeline 的视觉结构一一对应。
 *
 * ⚠ 只有写了正文的才算一条：清空正文 = 删除事件（参考项目的做法也是这个）。
 *   但**整组**的行要照留 —— 大运那行即使自己没写，只要下面的流年写了就还是要出现，
 *   否则时间线会缺一层，看不出这条流年属于哪一步大运。
 *
 * @returns {Array<{key:string, level:string, title:string, text:string}>}
 */
function timeline(notes) {
  const src = notes || {};
  const groups = {};

  function group(dk) {
    if (!groups[dk]) groups[dk] = { dayun: null, liunians: {}, up2: null };
    return groups[dk];
  }
  function liunianGroup(dk, ln) {
    const g = group(dk);
    if (!g.liunians[ln]) g.liunians[ln] = { note: null, liuyues: {}, up: null };
    return g.liunians[ln];
  }

  Object.keys(src).forEach(function (k) {
    const val = src[k];
    if (!hasText(val)) return;
    const p = String(k).split(':');
    if (p[0] === 'dayun') {
      group(p[1]).dayun = val;
    } else if (p[0] === 'liunian') {
      const lg = liunianGroup(p[1], p[2]);
      lg.note = val;
      // 流年的上一级就是大运，父级快照落在 up2 上 —— 拿它补「大运自己没写」时那一行的标题
      if (!group(p[1]).up2 && up2Of(val)) group(p[1]).up2 = up2Of(val);
    } else if (p[0] === 'liuyue') {
      const lg = liunianGroup(p[1], p[2]);
      lg.liuyues[p[3]] = val;
      // 流月的上一级是流年（up）、上两级是大运（up2）
      if (!lg.up && upOf(val)) lg.up = upOf(val);
      if (!group(p[1]).up2 && up2Of(val)) group(p[1]).up2 = up2Of(val);
    }
  });

  const rows = [];
  Object.keys(groups).sort(cmpDayunKey).forEach(function (dk) {
    const g = groups[dk];
    // 大运那一行：自己写了用自己的元信息，没写就用子级带回来的大运快照
    rows.push({
      key: 'dayun:' + dk,
      level: 'dayun',
      title: titleOf('dayun', metaWithFallback(g.dayun, g.up2)),
      text: textOf(g.dayun)
    });

    Object.keys(g.liunians).sort(numAsc).forEach(function (ln) {
      const lg = g.liunians[ln];
      rows.push({
        key: 'liunian:' + dk + ':' + ln,
        level: 'liunian',
        title: titleOf('liunian', metaWithFallback(lg.note, lg.up)),
        text: textOf(lg.note)
      });

      Object.keys(lg.liuyues).sort(numAsc).forEach(function (ly) {
        const v = lg.liuyues[ly];
        rows.push({
          key: 'liuyue:' + dk + ':' + ln + ':' + ly,
          level: 'liuyue',
          title: titleOf('liuyue', metaOf(v)),
          text: textOf(v)
        });
      });
    });
  });

  /* ⚠⚠ 2026-10-21 用户：「长按只有流年可以输入记录。大运，流月长按功能都移除掉。
     事件记录也只显示流年的就行了」⇒ **这里只放流年那一行**。
     · 大运行仍要先建出来：流年的标题靠 `up2`（大运快照）兜底，但**不进结果**；
     · 流月同理：历史数据里可能还留着 `liuyue:` 的键，读的时候直接丢掉
       （不删库里的数据 —— 只是不再显示，用户没要求清理）。
     ⚠ 别改成「渲染时再 filter」：那样每多一层就有第二个口径，
       而且 `timeline` 的唯一消费者就是「事件记录」那一栏。 */
  return rows.filter(function (r) { return r.level === 'liunian'; });
}

/**
 * ★★★ 「这一年的流年记录」用的是哪个 key —— **不分交运切割**（用户 2026-10-21：
 *   「交运的流年不管是上下部分，总之长按都是用一个」）。
 *
 * 为什么会有两个 key：交运那一年会同时出现在**前后两步大运**的流年表里，
 * 而流年的 key 带着大运（`liunian:<大运key>:<表内下标>`）⇒ 同一年有两个合法 key。
 * 各存一份的后果：同一件事记了两遍；而且长按另一半时回填不到（看着像丢记录）。
 *
 * ⚠ 判据是**公历年份**（note 里的 `year` 快照），不是表内下标 —— 下标随大运变。
 * @param {Object} notes 这条记录的全部事件
 * @param {number|string} year 公历年
 * @returns {string} 已存在那条的 key；没有 → ''（调用方退回按大运算的 key）
 */
function liunianKeyByYear(notes, year) {
  const src = notes || {};
  const y = String(year == null ? '' : year);
  if (!y) return '';
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (String(k).split(':')[0] !== 'liunian') continue;
    if (!hasText(src[k])) continue;
    if (String(metaOf(src[k]).year) === y) return k;
  }
  return '';
}

function numAsc(a, b) {
  return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
}

/** 有几条非空事件（给「事件记录」页签做角标 / 空态判断用） */
function count(notes) {
  const src = notes || {};
  return Object.keys(src).filter(function (k) { return hasText(src[k]); }).length;
}

module.exports = {
  LEVELS: LEVELS,
  key: key,
  textOf: textOf,
  hasText: hasText,
  metaOf: metaOf,
  titleOf: titleOf,
  timeline: timeline,
  liunianKeyByYear: liunianKeyByYear,
  count: count,
  dayunIndexOf: dayunIndexOf,
  dayunKeyOf: dayunKeyOf,
  normalizeLegacy: normalizeLegacy
};
