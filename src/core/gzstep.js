/**
 * 四柱录入的「八步向导」步骤模型（纯函数）
 *
 * ── 为什么要这么改 ──────────────────────────────────────────────────
 * 最初的面板是**四列各滚一条 60 甲子**（4 × 60 = 240 个格子）：
 * 用户得在四条长列表里分别翻到「甲子」「丙寅」…，还得自己保证天干地支配得上
 * （「甲丑」这种根本不存在，但列表里照样能滚到）。用户原话：「太过于麻烦了」。
 *
 * 改成**按柱拆成干 / 支两步**，每一步只给「配得上的那几个」：
 *
 *     年干(10) → 年支(6) → 月干(10) → 月支(1~2)
 *   → 日干(10) → 日支(6) → 时干(10) → 时支(1~2)
 *
 * 支的选项不是随便给的，两条口径（都在 utils/sizhu.js 里，**只有一份**）：
 *   · **年支 / 日支** —— 60 甲子要求天干与地支**同奇偶**，所以每个干只配得上 6 个支
 *     （甲配 子寅辰午申戌）；
 *   · **月支** —— 年上起月（五虎遁）：甲己之年丙作首、乙庚之岁戊为头、丙辛必定寻庚起、
 *     丁壬壬位顺行流、戊癸之年甲寅求。年干定了，12 个月建各落一个干，
 *     所以给定「年干 + 月干」只剩 **1~2 个**月支（丙 会同时落在 寅 和 子 上）；
 *   · **时支** —— 日上起时（五鼠遁）：甲己还加甲、乙庚丙作初、丙辛从戊起、
 *     丁壬庚子居、戊癸壬子。同理，给定「日干 + 时干」只剩 1~2 个时支。
 *
 * 三条结论（也是这套模型敢这么写的依据）：
 *   ① 四个「干」步永远给满 10 个 —— 每个干都配得出支，所以**走不到死胡同**，
 *      不会出现「选完干之后无路可走」；
 *   ② 8 步走完必定是一个**历法上可能存在**的四柱（干支同奇偶 + 两句口诀都满足）；
 *   ③ 剩下的「这个八字在 1000~2050 里到底有没有」，才交给 utils/sizhu.js 的 search。
 *
 * ── 分工 ────────────────────────────────────────────────────────────
 * 与 date-picker / utils/datepick.js 完全一致：
 *   组件只管「点哪一格、现在第几步」+ 样式；步骤模型与选项换算全在这里，Node 里能直接跑。
 *
 * ── 状态 ────────────────────────────────────────────────────────────
 *   { picks: [8] }   picks[k] 是第 k 步选中的**干或支单字**，没选就是 ''
 *   第 k 步 ←→ 柱：柱序号 = floor(k / 2)（0 年 / 1 月 / 2 日 / 3 时），
 *                  part = k % 2（0 干 / 1 支）
 *   这套「下标即步骤」的约定只在 STEPS 里写一次，别在别处再推一遍。
 */

const sz = require('./sizhu.js');

const GAN = sz.GAN;
const ZHI = sz.ZHI;

/** 八步。顺序就是用户走下来的顺序：年干 → 年支 → 月干 → 月支 → 日干 → 日支 → 时干 → 时支 */
const STEPS = [
  { key: 'year', part: 'gan', label: '年干' },
  { key: 'year', part: 'zhi', label: '年支' },
  { key: 'month', part: 'gan', label: '月干' },
  { key: 'month', part: 'zhi', label: '月支' },
  { key: 'day', part: 'gan', label: '日干' },
  { key: 'day', part: 'zhi', label: '日支' },
  { key: 'hour', part: 'gan', label: '时干' },
  { key: 'hour', part: 'zhi', label: '时支' }
];

const PILLAR_KEYS = ['year', 'month', 'day', 'hour'];

/** 四柱表每列的列标题（一列 = 一根柱，从左到右 年月日时） */
const PILLAR_TITLES = ['年柱', '月柱', '日柱', '时柱'];

/**
 * 12 个月建，按「正月(寅)」起的顺序 —— 月支的选项按这个次序给（不是 子丑寅…）。
 * ⚠ 月建的顺序和 ZHI 的顺序**不一样**，所以这里必须显式列出来，
 *   不能拿 ZHI 的下标当「第几个月」用。
 */
const MONTH_ZHI = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1];
const MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '冬月', '腊月'];
/** 每个月建从哪个「节」开始（月柱以节的时刻为界，反查里交节那天要收窄就靠它） */
const MONTH_JIE = ['立春', '惊蛰', '清明', '立夏', '芒种', '小暑',
  '立秋', '白露', '寒露', '立冬', '大雪', '小寒'];

/**
 * 两句口诀的原文，按 (干序号 % 5) 分组 —— 与 sizhu.js 里
 * fiveTigerStart / fiveRatStart 的分组完全一致，所以下标可以直接拿来用。
 */
const TIGER_RULE = ['甲己之年丙作首', '乙庚之岁戊为头', '丙辛必定寻庚起',
  '丁壬壬位顺行流', '戊癸之年甲寅求'];
const RAT_RULE = ['甲己还加甲', '乙庚丙作初', '丙辛从戊起',
  '丁壬庚子居', '戊癸壬子'];

/** 八步都没选 */
function emptyPicks() {
  const out = [];
  for (let i = 0; i < STEPS.length; i++) out.push('');
  return out;
}

/**
 * 第 i 步的合法选项。
 *
 * @param {number} i     步骤下标 0~7
 * @param {Array}  picks 当前已选（前几步没选全时，靠后的步骤会返回空数组）
 * @returns {Array} [{ v, gz, sub }]
 *   v   这一格代表的值（干或支的单字）
 *   gz  选下之后那根柱会变成什么（如「丙寅」），直接当格子上的大字用
 *   sub 小字补充（月建名 + 起节 / 时辰区间），没有就是 ''
 */
function optionsAt(i, picks) {
  const p = picks || [];
  const s = STEPS[i];
  if (!s) return [];

  // 四个「干」步：10 个干都给。
  // 不做过滤是有依据的：任何干都能找到配得上的支（年/日支 6 个、月/时支 1~2 个），
  // 所以这里不会把用户带进「选完就没路走」的死胡同。
  if (s.part === 'gan') {
    return GAN.map(function (g) {
      return { v: g, gz: g, sub: '' };
    });
  }

  // 年支：与年干同奇偶
  if (i === 1) {
    if (!p[0]) return [];
    return sz.zhiPartnersOfGan(p[0]).map(function (z) {
      return { v: z, gz: p[0] + z, sub: '' };
    });
  }

  // 月支：年上起月（五虎遁）—— 年干 + 月干 一定，只剩 1~2 个
  if (i === 3) {
    if (!p[0] || !p[2]) return [];
    const start = sz.fiveTigerStart(p[0]);
    if (start < 0) return [];
    const out = [];
    for (let k = 0; k < 12; k++) {
      if (GAN[(start + k) % 10] !== p[2]) continue;
      const z = ZHI[MONTH_ZHI[k]];
      out.push({
        v: z,
        gz: p[2] + z,
        sub: MONTH_NAMES[k] + ' · ' + MONTH_JIE[k] + '起'
      });
    }
    return out;
  }

  // 日支：与日干同奇偶
  if (i === 5) {
    if (!p[4]) return [];
    return sz.zhiPartnersOfGan(p[4]).map(function (z) {
      return { v: z, gz: p[4] + z, sub: '' };
    });
  }

  // 时支：日上起时（五鼠遁）—— 日干 + 时干 一定，只剩 1~2 个
  if (i === 7) {
    if (!p[4] || !p[6]) return [];
    const start = sz.fiveRatStart(p[4]);
    if (start < 0) return [];
    const out = [];
    for (let zi = 0; zi < 12; zi++) {
      if (GAN[(start + zi) % 10] !== p[6]) continue;
      out.push({ v: ZHI[zi], gz: p[6] + ZHI[zi], sub: sz.hourText(zi) });
    }
    return out;
  }

  return [];
}

/** 这一步顶上的口诀提示。干的那四步没有提示（选项就是全给） */
function hintAt(i, picks) {
  const p = picks || [];
  if (i === 3 && p[0]) {
    return '年上起月（五虎遁）：' + TIGER_RULE[GAN.indexOf(p[0]) % 5];
  }
  if (i === 7 && p[4]) {
    return '日上起时（五鼠遁）：' + RAT_RULE[GAN.indexOf(p[4]) % 5];
  }
  if (i === 1 || i === 5) {
    return '干支同奇偶才配得成对，所以每个干只配 6 个支。';
  }
  return '';
}

/**
 * 收敛：**只清掉配不上的那些**，其余原样留着。
 *
 * 改前面某一步时（比如把年干从「甲」换成「乙」），后面几步可能就不再合法了 ——
 * 不清的话会留下一个历法上不存在的干支，查出来永远为空，用户还以为是程序坏了。
 * 但也不能「一改就把后面全清空」：换年干并不影响月干，把用户已经选好的月干也抹掉很烦人。
 *
 * ⚠ 一趟就够：每一步的依赖**只指向它左边**，而这里是从左往右扫的 ——
 *   轮到第 i 步时，它依赖的那几步已经收敛过了。
 */
function normalize(picks) {
  const p = (picks || []).slice(0, STEPS.length);
  while (p.length < STEPS.length) p.push('');

  for (let i = 0; i < STEPS.length; i++) {
    if (!p[i]) continue;
    const opts = optionsAt(i, p);
    let hit = false;
    for (let k = 0; k < opts.length; k++) {
      if (opts[k].v === p[i]) { hit = true; break; }
    }
    // 依赖还没选全（opts 为空）或值不在选项里 → 这一步作废
    if (!hit) p[i] = '';
  }
  return p;
}

/** 第一个没选的步骤；八步都选好了返回 -1 */
function firstEmpty(picks) {
  const p = picks || [];
  for (let i = 0; i < STEPS.length; i++) {
    if (!p[i]) return i;
  }
  return -1;
}

/** 已录入的四柱 → picks（不合法/没录入的步骤留空，并顺手收敛） */
function pillarsToPicks(pillars) {
  const src = pillars || {};
  const out = emptyPicks();
  PILLAR_KEYS.forEach(function (k, ci) {
    const gz = String(src[k] == null ? '' : src[k]);
    if (gz.length !== 2) return;
    out[ci * 2] = gz.charAt(0);
    out[ci * 2 + 1] = gz.charAt(1);
  });
  return normalize(out);
}

/** picks → 四柱（没选全的柱给空串） */
function picksToPillars(picks) {
  const p = picks || [];
  const out = {};
  PILLAR_KEYS.forEach(function (k, ci) {
    const g = p[ci * 2] || '';
    const z = p[ci * 2 + 1] || '';
    out[k] = (g && z) ? g + z : '';
  });
  return out;
}

/**
 * 把「第几步 + 状态」摊平成模板要的几份数据 —— 组件里不做任何换算。
 * 与 datepick.view() 是同一个套路。
 *
 * @param {Object} state   { picks }
 * @param {number} stepIdx 要展示第几步（点四柱表就是改这个）
 * @returns {Object} { step, stepNo, stepTotal, grid, crumb, crumbCols, pickedText, ready }
 */
function view(state, stepIdx) {
  const picks = (state && state.picks) || emptyPicks();
  const n = STEPS.length;

  let i = parseInt(stepIdx, 10);
  if (!(i >= 0)) i = 0;
  if (i > n - 1) i = n - 1;

  const s = STEPS[i];
  const opts = optionsAt(i, picks).map(function (o) {
    return { v: o.v, gz: o.gz, sub: o.sub, on: o.v === picks[i] };
  });

  const crumb = STEPS.map(function (st, k) {
    return {
      i: k,
      label: st.label,
      text: picks[k] || '',
      // 模板里显示用：没选也要占住同一格（挂 tt:if 的话，整块表的高度会随进度变，
      // 每选一步面板都会弹一下 —— 与口诀提示那一行同一个坑）
      show: picks[k] || '—',
      done: !!picks[k],
      active: k === i
    };
  });

  // 四柱表：一列一根柱，**上面是干、下面是支**（年柱在左、时柱在右）。
  // 「第 k 步属于哪一柱」只在 crumb 那边推过一次，这里直接按 2 个一组切，
  // 别在模板里再写一遍 floor(i/2) —— 两处迟早会漂。
  const crumbCols = PILLAR_KEYS.map(function (k, ci) {
    const cells = [crumb[ci * 2], crumb[ci * 2 + 1]];
    return {
      key: k,
      title: PILLAR_TITLES[ci],
      // 整列高亮：当前这一步落在这根柱上（模板拿它给列标题也上色）
      active: cells[0].active || cells[1].active,
      cells: cells
    };
  });

  // 「已选：甲子 · 丙寅 · — · —」
  const shown = PILLAR_KEYS.map(function (k, ci) {
    const g = picks[ci * 2] || '';
    const z = picks[ci * 2 + 1] || '';
    return (g && z) ? g + z : '—';
  });

  return {
    step: i,
    stepNo: i + 1,
    stepTotal: n,
    grid: {
      title: '选择' + s.label,
      hint: hintAt(i, picks),
      part: s.part,
      // 干 10 个铺 5 列两行；支 6 个铺 3 列两行（月/时支只剩 1~2 个，一行放得下）
      cols: s.part === 'gan' ? 5 : 3,
      options: opts
    },
    crumb: crumb,
    crumbCols: crumbCols,
    pickedText: shown.join(' · '),
    ready: firstEmpty(picks) < 0
  };
}

module.exports = {
  STEPS: STEPS,
  MONTH_ZHI: MONTH_ZHI,
  emptyPicks: emptyPicks,
  optionsAt: optionsAt,
  hintAt: hintAt,
  normalize: normalize,
  firstEmpty: firstEmpty,
  pillarsToPicks: pillarsToPicks,
  picksToPillars: picksToPillars,
  view: view
};
