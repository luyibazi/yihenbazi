/**
 * 神煞计算引擎 —— 纯数据、不 import React/RN，Node 里可直接断言。
 *
 * 输入：四柱（年月日时，每柱含 gan/zhi 或 gz 两字干支）+ 性别
 * 输出：每柱命中的神煞列表（按柱分桶），供 chart-view 的「神煞」行渲染。
 *
 * ⚠⚠ 口径全部来自 ./shensha-rules.js（照《问真神煞大全》录入），本文件只负责**执行规则**。
 *     要改神煞含义 / 换流派，改规则表，不改这里。
 *
 * ⚠ 设计要点：
 *   ① 「查余三支」是问真的一贯措辞 —— 以某支为准查**其余三支**，**不含它自己**。
 *      实现上统一走 `others()`：把「参考支自己那一柱」排除掉。所以桃花「子见子」不算。
 *   ② 输出的 label 是**2 字短名**（「贵人」「文昌」），因为四柱每格只有 96rpx。
 *   ③ 同一柱同一神煞只出一遍（用 Set 去重）；不同柱各自独立记录。
 */

const R = require('./shensha-rules.js');
/**
 * ⚠ 空亡**不自算** —— 转发到 chart.js 的 xunKongOf（四柱表里那行用的同一份实现）。
 *   这里 require 的是「引擎」而不是「规则表」，是本文件唯一的跨层依赖，理由是
 *   空亡的推法（旬首下标 → 两支）跟排盘引擎绑得很紧，抄一份必分叉。
 */
const chartLib = require('./chart.js');
const kongWangOf = (gz) => chartLib.xunKongOf(gz);

const PILLAR_KEYS = ['year', 'month', 'day', 'hour'];
/** 柱位短名（渲染时不需要，nayin 行已有；这里留作调试） */
const PILLAR_NAMES = { year: '年', month: '月', day: '日', hour: '时' };

/** 取某支所在柱之外的三柱下标（旧版；现由 computeCore 的 applyHits 内联处理，保留注释备查） */

/**
 * 归一化输入：把「四柱」规范成 [{g, z, gz, nayin}, ...]，兼容几种喂法。
 * ⚠ 认得的字段名：gb 对（gan/zhi）、两字（gz）、单字（g/z）、
 *   **以及 chart-view/model.js 产出的 {stem, branch, nayin}**（四柱行数据）。
 *   ⚠ 后者是最常走的一条路 —— 漏了它神煞会**全静默为空**（不报错、只是空数组），
 *     2026-10-08 首次接入时就踩过（视图上什么都没有，控制台也干净）。
 * ⚠ nayin 必须带上：学堂/词馆/童子煞三颗要按**年柱纳音五行**查
 *   （问真注明「本软件采用第一种纳音查法」）。缺 nayin ⇒ 这三颗静默不输出。
 * @param {Array|Object} pillars 数组（{gan,zhi} / {gz} / {stem,branch} / '甲子'）或 {year:{...},...}
 */
function normalize(pillars) {
  const arr = Array.isArray(pillars)
    ? pillars
    : PILLAR_KEYS.map((k) => (pillars || {})[k]);
  return arr.slice(0, 4).map((p) => {
    if (typeof p === 'string') return { g: p.charAt(0), z: p.charAt(1), gz: p, nayin: '' };
    if (!p) return { g: '', z: '', gz: '', nayin: '' };
    const g = p.gan || p.g || p.stem || p.gz?.charAt(0) || '';
    const z = p.zhi || p.z || p.branch || p.gz?.charAt(1) || '';
    return { g, z, gz: (p.gz || g + z || ''), nayin: p.nayin || '' };
  });
}

/** 年干阴阳 → 阳/阴（用于元辰：阳男阴女 / 阴男阳女） */
function isYangGan(g) {
  return R.GAN.indexOf(g) % 2 === 0;
}

/**
 * 三合局取象（驿马/桃花/华盖/将星/劫煞/灾煞/亡神共用）。
 * @param {string} refZhi 参考支（年支或日支）
 * @param {string} pick   SAN_HE_KEY 上的字段名
 * @returns {string[]} 命中支集合
 */
function sanHePick(refZhi, pick) {
  const g = R.sanHeOf(refZhi);
  if (!g || !g[pick]) return [];
  return [g[pick]];
}

/**
 * 核心执行器：给定一组「柱」，算每柱命中的神煞。
 *
 * ⚠⚠ 这里把「柱集」参数化（而不是写死四柱），是为了一件事：**运限神煞**。
 *   问真的运限神煞口径 = 「把这一步运（大运/流年/流月）当成一根柱，
 *   和原局四柱**放在一起**查」——所以运那根柱能命中的星，就是它这一步的运限神煞。
 *   原文里到处写「岁运逢之」「流年岁运碰到也一样会犯」，就是这个意思。
 *
 * ⚠⚠⚠ 参考位（年干/月支/日支…）**永远取前 4 柱**：
 *   神煞的「年干」「日支」指的是**命局**的年干日支，运柱不参与当参考位
 *   （否则一个大运就会把全局的驿马/桃花参考位改掉，四柱那行的神煞会跟着变 —— 绝对不能）。
 *
 * ⚠ 参考位**排除范围**（`applyHits` 的其余支）覆盖**全部柱**（含运柱）：
 *   「以年、日支查余三支」在带运的盘里就是「查余**若干**支」（原局余三 + 运柱），
 *   所以运支**能被**原局的年支/日支查到 —— 这正是运限神煞的意义所在。
 *
 * @param {Array} P 归一化后的柱数组（前 4 个是命局，其后是运柱）
 * @param {number} G 性别 1=男 0=女
 * @param {number} refCount 参与当「参考位」的柱数（恒为 4；运柱只当靶子不当参考）
 */
function computeCore(P, G, refCount) {
  const N = P.length;
  const REF = refCount || 4;
  /** 每柱一个 Map（key → 神煞对象），天然去重且保序 */
  const buckets = P.map(() => new Map());

  const hit = (idx, rule, viaChar) => {
    if (idx < 0 || idx >= N) return;
    const b = buckets[idx];
    if (b.has(rule.key)) return;
    b.set(rule.key, {
      key: rule.key,
      name: rule.name,
      fortune: rule.fortune,
      // viaChar：这一颗是「哪一柱的哪个字」触发到的（比如「日干甲」→ 命中丑未）。
      // 渲染不需要，但自检断言、给用户解释「为什么是这颗」时非常有用。
      via: viaChar || '',
    });
  };

  /**
   * 「以 X 干/支 查四地支」的通用执行器。
   * @param {string} refChar 参考字（干或支）
   * @param {string[]} targets 命中的字集合
   * @param {number} refIdx 参考字所在柱下标
   * @param {object} rule
   * @param {'gan'|'zhi'|'both'} valueType 命中值比的是哪种字
   *
   * ⚠⚠ 「查余三支」vs「查余支」是问真原文里的**两种不同措辞**，含义不同：
   *   · 「查余三支」= 排除参考支自己所在的柱（驿马/桃花/劫煞/亡神…）
   *   · 「查余支」   = **包含**参考支自己（华盖/将星 —— 它们的取象就是三合局内的墓库/四正，
   *                    比如「寅午戌见戌」，戌自己就在局里；排除自己会让年柱戌、日柱戌全漏掉）
   *   判据用 `rule.includeSelf`。
   * ⚠ 靶子范围是**全部柱**（含运柱）：运支可以被原局的年/日支查到（运限神煞）。
   */
  const applyHits = (refChar, targets, refIdx, rule, valueType) => {
    if (!targets || !targets.length) return;
    const all = [];
    for (let i = 0; i < N; i++) all.push(i);
    const idxs = (refIdx >= 0 && !rule.includeSelf)
      ? all.filter((i) => i !== refIdx)
      : all;
    idxs.forEach((i) => {
      const p = P[i];
      const chars = valueType === 'gan' ? [p.g] : valueType === 'zhi' ? [p.z] : [p.g, p.z];
      if (chars.some((c) => c && targets.indexOf(c) >= 0)) hit(i, rule, refChar);
    });
  };

  /* ---------- 逐条执行规则 ---------- */
  R.RULES.forEach((rule) => {
    // 参考角色只从**命局**（前 REF 柱）取值 —— 运柱不当参考位（见函数头注释）
    const refs = {
      yearGan: { ch: P[0].g, idx: 0 },
      dayGan: { ch: P[2].g, idx: 2 },
      monthGan: { ch: P[1].g, idx: 1 },
      yearZhi: { ch: P[0].z, idx: 0 },
      dayZhi: { ch: P[2].z, idx: 2 },
      monthZhi: { ch: P[1].z, idx: 1 },
    };

    switch (rule.kind) {
      /* ---- 干查支 ---- */
      case 'yGanOrDGan': {
        [refs.dayGan, refs.yearGan].forEach((ref) => {
          if (!ref.ch) return;
          applyHits(ref.ch, rule.map[ref.ch], ref.idx, rule, 'zhi');
        });
        break;
      }
      case 'dayGan': {
        const ref = refs.dayGan;
        if (ref.ch) applyHits(ref.ch, rule.map[ref.ch], ref.idx, rule, 'zhi');
        break;
      }
      case 'yearGan': {
        const ref = refs.yearGan;
        if (ref.ch) applyHits(ref.ch, rule.map[ref.ch], ref.idx, rule, 'zhi');
        break;
      }

      /* ---- 支查支 ---- */
      case 'yZhiOrDZhi': {
        [refs.dayZhi, refs.yearZhi].forEach((ref) => {
          if (!ref.ch) return;
          const targets = rule.pick ? sanHePick(ref.ch, rule.pick) : (rule.map || {})[ref.ch];
          applyHits(ref.ch, targets, ref.idx, rule, 'zhi');
        });
        break;
      }
      /* yearZhi / dayZhi：值可直接来自 rule.map，也可经三合局取象 rule.pick（如灾煞）
         ⚠⚠ 漏了 pick 分支 ⇒ 灾煞这类「年支查三合局某位」的规则**静默不命中**（不报错、只是查不到） */
      case 'yearZhi': {
        const ref = refs.yearZhi;
        if (ref.ch) {
          const targets = rule.pick ? sanHePick(ref.ch, rule.pick) : (rule.map || {})[ref.ch];
          applyHits(ref.ch, targets, ref.idx, rule, 'zhi');
        }
        break;
      }
      case 'dayZhi': {
        const ref = refs.dayZhi;
        if (ref.ch) {
          const targets = rule.pick ? sanHePick(ref.ch, rule.pick) : (rule.map || {})[ref.ch];
          applyHits(ref.ch, targets, ref.idx, rule, 'zhi');
        }
        break;
      }

      /* ---- 月支查（值是干或支） ---- */
      case 'monthZhi': {
        const ref = refs.monthZhi;
        if (!ref.ch) break;
        let targets = rule.map ? rule.map[ref.ch] : null;
        if (rule.derive === 'tianDeHe') {
          // 天德合 = 天德的**天干**之五合。天德在卯/午/酉/子四个月是地支 ⇒ 无天干可合（该月无天德合）
          const tianDe = R.RULES.find((r) => r.key === 'tianDe');
          const td = tianDe.map[ref.ch] || [];
          targets = td
            .filter((c) => R.GAN.indexOf(c) >= 0 && R.GAN_HE[c])
            .map((c) => R.GAN_HE[c]);
        }
        applyHits(ref.ch, targets, ref.idx, rule, rule.valueType || 'both');
        break;
      }

      /* ---- 日柱 / 时柱固定列表 ---- */
      case 'dayPillar': {
        // ⚠ 「日柱固定列表」类的星（魁罡/十恶/九丑…）**只看本命日柱**，运柱不算 ——
        //   「某日生人才是魁罡」是出生决定的，不能靠走一步运补上。
        if (rule.list.indexOf(P[2].gz) >= 0) hit(2, rule, '日柱');
        break;
      }

      /* ---- custom ---- */
      case 'custom':
        runCustom(rule, P, hit, G, N);
        break;

      default:
        break;
    }
  });

  const byPillar = buckets.map((m) => Array.from(m.values()));
  const flat = [];
  byPillar.forEach((list) => list.forEach((s) => { if (flat.indexOf(s.key) < 0) flat.push(s.key); }));
  return { byPillar, flat };
}

/**
 * 主入口：算**四柱**每柱命中的神煞。
 * @param {Array|Object} pillars 四柱（年月日时）
 * @param {number} gender 1=男 0=女
 * @returns {{byPillar: Array<Array<{key,name,fortune}>>, flat: string[]}}
 *          byPillar[i] = 第 i 柱的神煞数组；flat = 全部命中 key（去重、调试用）
 */
function compute(pillars, gender) {
  const G = gender === 1 ? 1 : 0;
  return computeCore(normalize(pillars), G, 4);
}

/**
 * 运限神煞：把一根「运柱」（大运/流年/流月的干支）放进原局一起查，
 * 返回**这根运柱**上命中的神煞。
 *
 * 口径：问真原文的「岁运逢之」「流年岁运碰到也一样会犯」——
 *   运柱既当**靶子**（可被原局年/日支查到），也**不影响**原局当参考位。
 * ⚠ 运柱**不参与**「日柱固定列表」类（魁罡/十恶/九丑…）：那是出生日决定的，见 computeCore。
 * ⚠ 空亡不适用运柱（`xunKongOf` 要的是完整干支的旬，运柱单独一根不构成旬）——
 *   custom 分支里已经判掉了（只看原局日/年柱）。
 *
 * @param {Array|Object} pillars 原局四柱
 * @param {string} gz 运柱干支（两字，如「甲子」）；非干支（空/「小运」）→ 返回 []
 * @param {number} gender 1=男 0=女
 * @returns {Array<{key,name,fortune}>} 该运柱上的神煞
 */
function computeForColumn(pillars, gz, gender) {
  const base = normalize(pillars);
  // ⚠ 只认**两字真干支** —— 大运首列是「小运」（无干支），流月未选中是空壳，
  //   直接喂进 tyme 会抛异常（对照 chart.js 的 gzClasses 判据）。
  if (!gz || gz.length !== 2) return [];
  const G = gender === 1 ? 1 : 0;
  const col = { g: gz.charAt(0), z: gz.charAt(1), gz: gz, nayin: '' };
  const res = computeCore(base.concat([col]), G, 4);
  return res.byPillar[4] || [];
}


/* ===================== custom 规则的实现 ===================== */

/** 三合局四库（用于童子煞的「金木马卯合」等，见下） */
const SANHE_GROUP = { 申: 0, 子: 0, 辰: 0, 寅: 1, 午: 1, 戌: 1, 巳: 2, 酉: 2, 丑: 2, 亥: 3, 卯: 3, 未: 3 };

/** 纳音五行（由 chart.js 的 nayinOf 结果取末字；这里只认「金木水火土」五个字） */
function hangOfNayin(nayin) {
  const last = (nayin || '').slice(-1);
  return '金木水火土'.indexOf(last) >= 0 ? last : '';
}

function runCustom(rule, P, hit, gender, N) {
  const dayGan = P[2].g;
  const dayZhi = P[2].z;
  const dayGz = P[2].gz;
  const yearGan = P[0].g;
  const yearZhi = P[0].z;
  const monthZhi = P[1].z;

  switch (rule.custom) {
    /*
     * 元辰：古诀「阳男阴女★子年未（+7）；阴男阳女★子年巳（+5）」
     * ⚠⚠ 「阳男阴女 / 阴男阳女」里的阳阴指的是**年干的阴阳**，不是性别：
     *   · 阳男 = 年干阳 + 男 → +7
     *   · 阴女 = 年干**阴** + 女 → +7
     *   · 阴男 = 年干阴 + 男 → +5
     *   · 阳女 = 年干**阳** + 女 → +5
     *   所以「甲子年（甲=阳）+ 女」是**阳女** ⇒ 走 +5 ⇒ 见巳（不是未）。
     *   2026-10-08 第一次写自检时把这条理解反了（以为「阴女」= 女就行），
     *   是断言先报红才发现的 —— 故留此长注释。
     */
    case 'yuanChen': {
      const yang = isYangGan(yearGan);
      const plusSeven = (yang && gender === 1) || (!yang && gender === 0);
      const step = plusSeven ? 7 : 5;
      const i = R.ZHI.indexOf(yearZhi);
      if (i >= 0) {
        const target = R.ZHI[(i + step) % 12];
        for (let k = 1; k < N; k++) if (P[k].z === target) hit(k, rule, yearZhi);
      }
      break;
    }

    /* 金神：乙丑 / 己巳 / 癸酉 —— 查**日柱或时柱** */
    case 'jinShen': {
      if (['乙丑', '己巳', '癸酉'].indexOf(dayGz) >= 0) hit(2, rule, '日柱');
      if (['乙丑', '己巳', '癸酉'].indexOf(P[3].gz) >= 0) hit(3, rule, '时柱');
      break;
    }

    /* 天转/地转：以**月支所属季节**查日柱 */
    case 'tianZhuan':
    case 'diZhuan': {
      const table = {
        tianZhuan: { 春: '乙卯', 夏: '丙午', 秋: '辛酉', 冬: '壬子' },
        diZhuan: { 春: '辛卯', 夏: '戊午', 秋: '癸酉', 冬: '丙子' },
      }[rule.custom];
      const season = seasonOfMonthZhi(monthZhi);
      if (season && table[season] === dayGz) hit(2, rule, '日柱');
      break;
    }

    /* 四废日：春庚申辛酉，夏壬子癸亥，秋甲寅乙卯，冬丙午丁巳（按季节查日柱） */
    case 'siFei': {
      const table = {
        春: ['庚申', '辛酉'], 夏: ['壬子', '癸亥'],
        秋: ['甲寅', '乙卯'], 冬: ['丙午', '丁巳'],
      };
      const season = seasonOfMonthZhi(monthZhi);
      if (season && table[season] && table[season].indexOf(dayGz) >= 0) hit(2, rule, '日柱');
      break;
    }

    /* 天赦日：寅卯辰月见戊寅日、巳午未月见甲午日、申酉戌月见戊申日、亥子丑月见甲子日 */
    case 'tianShe': {
      const table = {
        春: '戊寅', 夏: '甲午', 秋: '戊申', 冬: '甲子',
      };
      const season = seasonOfMonthZhi(monthZhi);
      if (season && table[season] === dayGz) hit(2, rule, '日柱');
      break;
    }

    /* 学堂 / 词馆：以**年柱纳音**查月日时支（问真注明「本软件采用第一种纳音查法」） */
    case 'xueTang':
    case 'ciGuan': {
      const hang = hangOfNayin(P[0].nayin || '');
      if (!hang) break;
      // 学堂 = 纳音之长生；词馆 = 纳音之临官（问真原文两张对照）
      const map = {
        学堂: { 金: '巳', 木: '亥', 水: '申', 土: '申', 火: '寅' },
        词馆: { 金: '申', 木: '寅', 水: '亥', 土: '亥', 火: '巳' },
      }[rule.custom === 'xueTang' ? '学堂' : '词馆'];
      const target = map[hang];
      if (!target) break;
      // 月日时（k≥1）+ 运柱；⚠ 不含年柱自己（问真「查月日时支」）
      for (let k = 1; k < N; k++) if (P[k].z === target) hit(k, rule, '年纳音' + hang);
      break;
    }

    /* 天厨贵人：丙见巳、丁见午、戊见申、己见酉、庚见亥、辛见子、壬见寅、癸见卯（甲乙未列）
       ⚠ 以年干、日干查余四支 */
    case 'tianChu': {
      const map = { 丙: '巳', 丁: '午', 戊: '申', 己: '酉', 庚: '亥', 辛: '子', 壬: '寅', 癸: '卯' };
      [[yearGan, 0], [dayGan, 2]].forEach(([g, ri]) => {
        const t = map[g];
        if (!t) return;
        for (let k = 0; k < N; k++) if (k !== ri && P[k].z === t) hit(k, rule, g);
      });
      break;
    }

    /* 福星贵人：以年/月干查地支。甲丙见寅或子，乙癸见卯或丑，戊见申，己见未，丁见亥，庚见午，辛见巳，壬见辰 */
    case 'fuXing': {
      const map = {
        甲: ['寅', '子'], 丙: ['寅', '子'],
        乙: ['卯', '丑'], 癸: ['卯', '丑'],
        戊: ['申'], 己: ['未'], 丁: ['亥'], 庚: ['午'], 辛: ['巳'], 壬: ['辰'],
      };
      [[yearGan, 0], [P[1].g, 1]].forEach(([g, ri]) => {
        const ts = map[g];
        if (!ts) return;
        for (let k = 0; k < N; k++) if (k !== ri && ts.indexOf(P[k].z) >= 0) hit(k, rule, g);
      });
      break;
    }

    /* 三奇贵人：四柱天干**顺连**成组（甲戊庚 / 乙丙丁 / 壬癸辛） */
    case 'sanQi': {
      const groups = [['甲', '戊', '庚'], ['乙', '丙', '丁'], ['壬', '癸', '辛']];
      const gans = P.map((p) => p.g);
      const windows = [gans.slice(0, 3), gans.slice(1, 4)]; // 年月日 / 月日时
      windows.forEach((w) => {
        groups.forEach((grp) => {
          if (grp.every((c, i) => w[i] === c)) {
            // 三奇落在参与的三个柱上，全部标记
            const isFirst = w === windows[0];
            [isFirst ? 0 : 1, isFirst ? 1 : 2, isFirst ? 2 : 3].forEach((i) => hit(i, rule, grp.join('')));
          }
        });
      });
      break;
    }

    /* 天罗地网（问真查法一）：戌见亥、亥见戌 = 天罗；辰见巳、巳见辰 = 地网 */
    case 'tianLuoDiWang': {
      const pairs = [['戌', '亥'], ['辰', '巳']];
      pairs.forEach(([a, b]) => {
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            if (i === j) continue;
            if (P[i].z === a && P[j].z === b) {
              hit(i, rule, a + b);
              hit(j, rule, a + b);
            }
          }
        }
      });
      break;
    }

    /* 童子煞：
       ⚠⚠ 这是验证过、修正过的版本（自检 §童子煞「双锚点互斥」小节）。规则来自问真古诀原文：
         「春秋寅子贵，冬夏卯未辰；金木马卯合，水火鸡犬多；土命逢辰巳，童子定不错。」
       与判定表：
         ① 季（春/秋）→ 日支或时支见 寅 / 子
         ② 季（冬/夏）→ 日支或时支见 卯 / 未 / 辰
         ③ 年纳音 金/木 → 日支或时支见 午 / 卯
         ④ 年纳音 水/火 → 日支或时支见 酉 / 戌
         ⑤ 年纳音 土    → 日支或时支见 辰 / 巳
       ⚠ 必须**同时**满足「季节/纳音」条件与「地支」条件才算命中；且只要任一条命中即算。
       ⚠ 古诀第 ① 条的「春」指寅卯辰月、「秋」指申酉戌月；第 ② 条的「夏」巳午未、「冬」亥子丑。
     */
    case 'tongZi': {
      const season = seasonOfMonthZhi(monthZhi); // 春/夏/秋/冬
      const hang = hangOfNayin(P[0].nayin || '');
      const targets = { 日: dayZhi, 时: P[3].z };
      const checks = [];
      // ①
      if (season === '春' || season === '秋') checks.push(['寅', '子']);
      // ②
      if (season === '夏' || season === '冬') checks.push(['卯', '未', '辰']);
      // ③④⑤ 依赖年纳音
      if (hang === '金' || hang === '木') checks.push(['午', '卯']);
      if (hang === '水' || hang === '火') checks.push(['酉', '戌']);
      if (hang === '土') checks.push(['辰', '巳']);
      checks.forEach((ts) => {
        Object.keys(targets).forEach((pos) => {
          if (ts.indexOf(targets[pos]) >= 0) hit(pos === '日' ? 2 : 3, rule, season + '/' + hang);
        });
      });
      break;
    }

    /* 拱禄：以**日柱配合时柱**（虚拱出禄位）
       古诀五组：癸亥日癸丑时 / 癸丑日癸亥时（拱子禄）；丁巳日丁未时 / 己未日己巳时（拱午禄）；
                戊辰日戊午时（拱巳禄）。 */
    case 'gongLu': {
      const pairs = [
        ['癸亥', '癸丑'], ['癸丑', '癸亥'],
        ['丁巳', '丁未'], ['己未', '己巳'],
        ['戊辰', '戊午'],
      ];
      if (pairs.some(([d, h]) => d === dayGz && h === P[3].gz)) {
        hit(2, rule, '日时');
        hit(3, rule, '日时');
      }
      break;
    }

    /* 空亡（旬空）：以**日柱**的旬首推两支（问真：「以日/年柱，见余三地支」）。
       ⚠⚠ 复用 chart.js 的 xunKongOf（同一份实现），**绝不自己再推一遍** —— 两份必然分叉。
       ⚠ 四柱表里「空亡」本就单独占一行（显示每柱的旬空两支）。这里注册进神煞表是为了
         55 颗名目齐全，所以**神煞行只在「本柱那个字正好落进旬空两支」时才标**；
         否则 4 柱会各挂一个「空亡」，神煞行全是噪声、反而看不出重点。
         判据：本柱地支 ∈ 日柱的旬空两支。 */
    case 'kongWang': {
      const kw = kongWangOf(dayGz);
      if (!kw || kw.length < 2) break;
      // ⚠ 只查**本命四柱**（前 4 柱）：旬空是「日柱那一旬」的属性，运柱不改变旬空；
      //   而且运柱落进旬空 ≠ 命带空亡（那是「运逢空亡」另一回事，问真不列在神煞表里）。
      for (let k = 0; k < 4; k++) {
        if (kw.indexOf(P[k].z) >= 0) hit(k, rule, '日柱旬空');
      }
      break;
    }

    default:
      break;
  }
}

/** 月支 → 季节（寅卯辰春、巳午未夏、申酉戌秋、亥子丑冬） */
function seasonOfMonthZhi(z) {
  if ('寅卯辰'.indexOf(z) >= 0) return '春';
  if ('巳午未'.indexOf(z) >= 0) return '夏';
  if ('申酉戌'.indexOf(z) >= 0) return '秋';
  if ('亥子丑'.indexOf(z) >= 0) return '冬';
  return '';
}

module.exports = { compute, computeForColumn, normalize, sanHePick, seasonOfMonthZhi, hangOfNayin };
