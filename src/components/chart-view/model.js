/**
 * 排盘结果视图 —— 纯计算层
 *
 * ⚠ 这个文件是原项目 `components/chart-view/chart-view.js` 里**所有纯函数**的逐行搬运。
 *   原来的函数体一行未改，只把 `require('../../utils/x.js')` 换成 `require('../core/x')`。
 *   所以这里的每个函数都可以在 Node 里直接跑、直接断言 —— 不需要渲染任何东西。
 *
 * 拆出来的理由：原项目把「算」和「渲染」混在一个 Component 里，
 * 搬到 RN 后如果继续混着，就没法在不启动模拟器的情况下验证联动逻辑
 * （大运 → 流年 → 流月 三级联动、事件记录落点）。现在算的部分全在这里，
 * 可以拿 `tests/chart-view-check.js` 直接对拍。
 */

// ⚠ 相对路径：本文件在 src/components/chart-view/ 下，核心层在 src/core/ ——
//   所以是「往上三级」，不是两级（`../../core` 会解析到 src/core 之外）。
//   这是本项目最容易犯的一处错，改目录结构时务必先跑一次 require 冒烟。
const baziLib = require('../../core/bazi.js');
const chartLib = require('../../core/chart.js');
const shenshaLib = require('../../core/shensha.js');
const notesLib = require('../../core/notes.js');
const timeUtil = require('../../core/time.js');
const pingqiLib = require('../../core/pingqi-bazi.js');

/*
 * ============ 口径（定气法 / 平气法）============
 * ★ 2026-10-18 用户：「平气法就用这个来排盘。排出来的 UI 要和定气法的一样。」
 *
 * ⚠⚠ 两个口径的差别**只在四柱的年月柱 + 交运起运点**；日柱、时柱、十神、藏干、
 *   纳音、星运、自坐、空亡、大运流年流月的**表结构**全部一致。
 *   所以这里不做「第二套 buildChartData」——只在需要换口径的那几处按 mode 分叉，
 *   视图层一行都不用分（用户要的「UI 一样」是结构性保证，不是照着画一遍）。
 */
const MODE_DING = 'dingqi';
const MODE_PING = 'pingqi';
function normMode(m) { return m === MODE_PING ? MODE_PING : MODE_DING; }

/** 出生时间（公历）→ { year, month, day, hour, minute } */
function birthTime(rec) {
  return baziLib.dateZhuanhuan(rec.dateText + ' ' + rec.timeText);
}

/**
 * 某口径下这条记录的「盘 + 八字包」。
 * @returns {{ chart: any, bazi: any }} 形状与 rec.chart / rec.bazi 一致
 *
 * ⚠ 平气法没有存进记录（记录里那份 chart / bazi 永远是定气法算的）——
 *   平气盘是**现场算**的，所以切开关不写盘、也不改历史记录。
 */
function boardOf(rec, mode) {
  if (normMode(mode) === MODE_DING) {
    return { chart: rec.chart, bazi: rec.bazi || {} };
  }
  const bt = birthTime(rec);
  const chart = pingqiLib.paipan(bt.year, bt.month, bt.day, bt.hour, bt.minute);
  if (!chart) return null;   // 超出节气表范围（1600–2200）→ 上层降级
  const gender = rec.gender === 1 ? 1 : 0;
  return {
    chart: chart,
    bazi: {
      siLing: pingqiLib.siLingText(bt.year, bt.month, bt.day, bt.hour, bt.minute),
      taiYuan: pingqiLib.taiYuan(bt.year, bt.month, bt.day, bt.hour, bt.minute) || '',
      jiaoYunText: pingqiLib.jiaoYunText(bt.year, bt.month, bt.day, bt.hour, bt.minute, gender),
      /*
       * ⚠⚠ birthYear 必须有：定气法的记录里它 = **立春年**（1990-01-01 生 → 1989），
       *   大运表的首列年份（小运那格）、流年的虚岁都以它为基准。
       *   平气法自己也能算出来（就是平气立春之后的那一年），别借用定气法记录里的 ——
       *   极少数卡在两次立春之间的出生（平气立春比定气早/晚一天）会取到不同的年。
       */
      birthYear: birthYearOf(bt),
      /*
       * ⚠⚠ `buildDayuns` 吃的是**数组**（定气法 rec.bazi.dayuns 就是数组），
       *   而新版平气算法返回的是整包 `{ direction, startAt, steps: [...] }`。
       *   必须在这里展开成数组，否则大运表一格没有、`_defaultIdx = -1`（首屏什么都不选中）——
       *   而且不报错，只是「表是空的」。
       * ⚠ `steps[0]` 是**童限**（ganzhi 为 null），`buildDayuns` 会自己补「小运」那一列，
       *   这里必须把它剔掉，否则左边多出一格空白、后面全体错位一位。
       */
      dayuns: (function () {
        const dz = pingqiLib.daYun(bt.year, bt.month, bt.day, bt.hour, bt.minute, gender);
        const st = (dz && dz.steps) || [];
        return st.filter(function (s) { return !s.isTongXian; });
      })()
    }
  };
}

/**
 * 交运文案。
 * 新记录直接用排盘时算好的 bazi.jiaoYunText；
 * 老记录（那一版还没落这个字段）按出生时间现场重算 —— 与参考项目
 * 「派生字段缺失就按出生信息重算」的做法一致。
 */
function buildJiaoYunText(rec) {
  if (rec.bazi && rec.bazi.jiaoYunText) return rec.bazi.jiaoYunText;
  try {
    const pd = timeUtil.parseDate(rec.dateText);
    const pt = timeUtil.parseTime(rec.timeText);
    const info = baziLib.getJiaoYunInfo(
      { year: pd.y, month: pd.m, day: pd.d, hour: pt.h, minute: pt.mi },
      rec.gender === 1 ? 1 : 0
    );
    return baziLib.jiaoYunText(info && info.jiaoYun) || '—';
  } catch (err) {
    console.warn('[paipan] 交运重算失败', err);
    return '—';
  }
}

/**
 * 出生时刻所属的**立春年**（平气口径）。
 * 与定气法记录里的 bazi.birthYear 同一含义：立春之后算本年、立春之前算上一年。
 * ⚠ 别直接用 bt.year：1990-01-01 出生的人，立春年还是 1989。
 */
function birthYearOf(bt) {
  const chart = pingqiLib.paipan(bt.year, bt.month, bt.day, bt.hour, bt.minute);
  if (!chart) return bt.year;
  const i = (((bt.year - 4) % 60) + 60) % 60;
  const thisYearGz = '甲乙丙丁戊己庚辛壬癸'[i % 10] + '子丑寅卯辰巳午未申酉戌亥'[i % 12];
  return chart.pillars.year.name === thisYearGz ? bt.year : bt.year - 1;
}

/**
 * 给展示项补上「干 / 支拆字 + 各自五行配色 class」。
 * 三张表与右侧选中卡共用同一条渲染路径（逐字着色），
 * 所以拆字只走 chart.js 的 gzClasses 一份实现，视图不再自己拆。
 */
function withGzFields(item) {
  const parts = chartLib.gzClasses(item.gz);
  item.gan = parts.gan;
  item.zhi = parts.zhi;
  item.ganCls = parts.ganCls;
  item.zhiCls = parts.zhiCls;
  return item;
}

/**
 * 大运表数据（版式参考万年历项目的「大运」区）。
 * 一列三行：公历年 / 起始虚岁 / 大运干支；首列是起运前的「小运」阶段。
 *
 * 岁数不带「岁」字：列宽 63rpx，「1~10岁」按字宽估算约 77rpx，会折行把三行结构顶乱。
 */
function buildDayuns(bz) {
  const raw = (bz && bz.dayuns) || [];
  if (!raw.length) return [];

  const list = [withGzFields({
    key: notesLib.dayunKeyOf(-1),
    year: bz.birthYear || '',
    age: '1~' + raw[0].startAge,
    gz: '小运'
  })];

  raw.forEach(function (d, i) {
    list.push(withGzFields({
      key: notesLib.dayunKeyOf(i),
      year: d.starYear,
      age: d.startAge,
      gz: d.dayunganzhi
    }));
  });

  return list;
}

/**
 * 复制一组展示项并标出选中列。
 * noRight：「选中列」自身与它左边一列都不画右分隔线 ——
 * 否则 1rpx 的竖线会把整列反白色块从中间割开（参考项目用 :has() 做同一件事，
 * 小程序不支持 :has，所以由数据算好）。RN 同样没有 :has，继续用这个字段。
 */
function withActive(list, idx) {
  return list.map(function (item, i) {
    const next = {};
    for (const k in item) {
      if (Object.prototype.hasOwnProperty.call(item, k)) next[k] = item[k];
    }
    next.active = (i === idx);
    next.noRight = (i === idx) || (i === idx - 1);
    return next;
  });
}

/**
 * 默认高亮「当前所处」的那一步大运：看今年落在哪一步的 10 年区间内。
 * 还没起运（早于第一步）→ 首列小运；已过最后一步 → 最后一步。
 */
function currentDayunIndex(dayuns, nowYear) {
  if (!dayuns.length) return -1;
  const y = nowYear == null ? new Date().getFullYear() : nowYear;
  for (let i = 1; i < dayuns.length; i++) {
    if (y >= dayuns[i].year && y < dayuns[i].year + 10) return i;
  }
  return y < dayuns[1].year ? 0 : dayuns.length - 1;
}

/**
 * 默认滚动锚点：选中列前面留两列当上下文。
 * 手机上表格一次能看到 5 列左右，把选中列锚在可视区第 3 列，
 * 左右都留有内容 —— 比把它贴到最左边缘（右边留一大片空）好看得多。
 */
function scrollAnchor(idx) {
  return idx > 2 ? idx - 2 : 0;
}

/** 某一步（含首列小运）覆盖的公历年份区间，左闭右开 */
function stageRange(dayuns, idx) {
  const d = dayuns[idx];
  if (!d) return { start: 0, end: 0 };
  if (idx === 0) return { start: d.year, end: dayuns[1] ? dayuns[1].year : d.year };
  return { start: d.year, end: d.year + 10 };
}

/** 流年行 → 展示项（一列三行：公历年 / 虚岁 / 干支；岁数同样不带单位） */
function buildLiunians(rows, idx) {
  return withActive(rows.map(function (r, i) {
    return withGzFields({
      key: 'l' + i,
      year: r.year,
      age: r.nianling,
      gz: r.yearGanZhi
    });
  }), idx);
}

/** 某一流年的流月 → 展示项（一列三行：节气 / 阳历月日 / 月干支） */
function buildLiuyues(row) {
  if (!row || !row.months || !row.months.length) return [];
  return withActive(row.months.map(function (m, i) {
    const st = m.solarDate;
    return withGzFields({
      key: 'm' + i,
      jieQi: m.JieQi,
      date: st.getMonth() + '/' + st.getDay(),
      gz: m.ganZhi
    });
  }), -1);   // 流月不默认选中（与参考项目一致）
}

/** 取表里被选中的那一项（active 标记由 withActive 写） */
function pickActive(list) {
  if (!list || !list.length) return null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].active) return list[i];
  }
  return null;
}

/** 浅拷贝：模板比对的是引用，每次换表都要给新对象 */
function copy(item) {
  const next = {};
  for (const k in item) {
    if (Object.prototype.hasOwnProperty.call(item, k)) next[k] = item[k];
  }
  return next;
}

/**
 * 把「事件记录」落到三张表上：
 *   ① 每格挂 `note`（正文）→ 视图据此在格子右上角点一枚红点；
 *   ② 取**当前选中**那一条的正文 → 给对应表格下方的内联面板。
 *
 * ⚠⚠⚠ 2026-10-21 用户：「大运流月的红点功能和显示文字的功能也移除。只留流年」
 *   ⇒ **只有流年**挂 note / 内联正文；大运、流月一律空串。
 *   那一格上还留着历史记录（老功能写过）也不显示 —— 库里的数据不删，只是不再画。
 *
 * 纯函数、不改入参：setTables 每次换表都重走一遍，所以「换选中 / 存完事件」
 * 都不会把标记弄丢，也不需要在别处补一次刷新。
 *
 * @param {Object} ctx { dk, lnIdx } 当前选中的大运 key 与流年下标
 */
function decorate(dayuns, liunians, liuyues, ctx, notes) {
  const dk = (ctx && ctx.dk) || '';
  const src = notes || {};
  const inline = { dayun: '', liunian: '', liuyue: '' };

  const dList = dayuns.map(function (it) {
    const next = copy(it);
    next.note = '';
    return next;
  });

  const lList = liunians.map(function (it, i) {
    const next = copy(it);
    /* ⚠⚠ 流年的 key 带上大运（同一张流年表在不同大运下是完全不同的年份），
       但**同一年只能有一条记录**：交运那一年会同时出现在前后两步大运的表里，
       两条 key 指同一年 ⇒ 先按年份找已存在的那条，找不到才用当前大运算 key。
       （用户 2026-10-21：「交运的流年不管是上下部分，总之长按都是用一个」） */
    const byYear = notesLib.liunianKeyByYear(src, it.year);
    next.note = notesLib.textOf(src[byYear || (dk ? notesLib.key('liunian', dk, i) : '')]);
    if (next.active) inline.liunian = next.note;
    return next;
  });

  const mList = liuyues.map(function (it) {
    const next = copy(it);
    next.note = '';
    return next;
  });

  return { dayuns: dList, liunians: lList, liuyues: mList, inline: inline };
}

/** 一张「选中运」卡的空壳（没内容时用它占位，见 buildSelCards 的说明） */
function blankCard(key, label) {
  return {
    key: key,
    label: label,
    text: '',
    gan: '',
    zhi: '',
    ganCls: '',
    zhiCls: '',
    shiShen: '',
    element: '',
    nayin: '',
    nayinCls: '',
    xingYun: '',
    ziZuo: '',
    kongWang: '',
    canggan: [],
    shensha: [],
    blank: true
  };
}

/**
 * 四柱右侧的「选中运」面板。
 * 内容完全由三张表的选中项推导，不额外维护下标：
 *   选中的大运（首列小运没有干支 → 显示「起运前」）
 *   选中的流年（跟着大运一起默认选中今年）
 *   选中的流月（默认不选，点了才出现）
 *
 * 每张卡与四柱「同构」：标签 / 十神 / 干 / 支 / 五行 / 藏干，五行照旧是「干五行 + 支五行」，
 * 十神以日干为「我」—— 这样三张卡在视图里可以直接复用四柱的那套样式，
 * 字号、配色与逐行对齐关系都跟四柱一致。
 *
 * ⚠ 卡位是**固定**的，不是「有才 push」：
 * 面板里「按余量等分」时卡数一变每张宽度就跟着变，
 * 于是「点一个流月」会让大运卡 / 流年卡突然变窄——整块盘面抽一下。
 * 所以流月**表已生成**（点过流年，liuyues 非空）时就固定留出第 3 个卡位，
 * 没选中只是填空壳（blank: true，视图里只渲染标签、不画内容），
 * 这样在同一年里来回点流月，宽度与位置完全不动。
 * 流月表都还没生成时不占位（否则会凭空多一个空框）。
 *
 * @param {string} dayStem 日干名（如「丙」），用来算十神
 */
function buildSelCards(dayuns, liunians, liuyues, dayStem, shenshaOf) {
  const cards = [];

  function make(key, label, gz, text) {
    // ⚠ 用 gzClasses 的返回值判「这两个字到底是不是干支」：
    //   它内部已经把非干支（「小运」）挡成空串，比各处再抄一遍 GAN/ZHI 判断可靠。
    const parts = chartLib.gzClasses(gz);
    const real = !!parts.gan;
    const info = gz ? chartLib.ganZhiInfo(dayStem, gz) : { shiShen: '', element: '' };
    return {
      key: key,
      label: label,
      text: text || '',
      gan: parts.gan,
      zhi: parts.zhi,
      ganCls: parts.ganCls,
      zhiCls: parts.zhiCls,
      shiShen: info.shiShen,
      element: info.element,
      // 纳音（如「癸酉」→「剑锋金」）：与四柱同源，一律由 tyme 现算，不抄表（见 chart.js）。
      // ⚠ 跟着 gzClasses 的「是不是干支」判据走 —— 硬编码 2 长度会把「小运」送进 tyme 抛异常。
      nayin: real ? chartLib.nayinOf(gz) : '',
      // 纳音五行的**配色 class**：纳音末字就是五行（剑锋**金** / 大林**木**）→ 复用单字映射
      nayinCls: real ? chartLib.elementClass(chartLib.nayinOf(gz).slice(-1)) : '',
      // 星运：日干对运支的十二长生；自坐：运干坐在运支上；空亡：运干支的旬空
      xingYun: real ? chartLib.terrainOf(dayStem, gz.charAt(1)) : '',
      ziZuo: real ? chartLib.terrainOf(gz.charAt(0), gz.charAt(1)) : '',
      kongWang: real ? chartLib.xunKongOf(gz) : '',
      // 藏干与四柱同源：以日干为「我」逐字算十神与五行配色
      canggan: gz ? chartLib.cangGanOf(gz.charAt(1), dayStem) : [],
      // 运限神煞（2026-10-08 用户：「大运流年流月也要显示神煞」）：
      // 把**这一步运的干支**放进原局一起查 ⇒ 它身上命中的星就是这步运的神煞。
      // ⚠ 口径 = 问真「岁运逢之」；实现见 core/shensha.js 的 computeForColumn。
      // ⚠ 小运（无干支）与空壳卡（未选中）一律空数组 —— 回调内部也会再挡一次两字校验。
      shensha: (shenshaOf && real) ? shenshaOf(gz) : [],
      blank: false
    };
  }

  const d = pickActive(dayuns);
  if (d) {
    if (d.gz === '小运') cards.push(make('sd', '小运', '', '起运前'));
    else cards.push(make('sd', '大运', d.gz));
  }

  const l = pickActive(liunians);
  if (l) cards.push(make('sl', '流年', l.gz));

  // 流月卡位：表已生成就固定占位（未选中时填空壳），避免点流月时整块宽度跳动
  if (liuyues && liuyues.length) {
    const m = pickActive(liuyues);
    cards.push(m ? make('sm', '流月', m.gz) : blankCard('sm', '流月'));
  }

  return cards;
}

/**
 * 行式表格数据（用户 2026-10-08 给问真截图：「就这样」）。
 *
 * 之前是「列式」：每柱一列纵向堆叠 —— 各柱藏干数不等（1~3 个），
 * 后面的行（纳音）各排各的，对齐要靠给藏干块定高来「垫」。
 * 现在照问真改成「行式」：左列行头（主星/天干/地支/藏干/星运/自坐/空亡/纳音），
 * 每行横向排**四柱 + 右侧选中运卡** —— 行是独立的一块，天然横向对齐，
 * 藏干数不等只在藏干行内部消化（行高 = 最多的那柱），不再需要任何定高垫。
 *
 * cell 四种 kind（视图按 kind 画）：
 *   value       普通文本格 { text, cls, gold }  cls=五行配色 class；gold=日柱主星金色
 *   canggan     藏干格 { items: [{stem, cls, shiShen}] }
 *   placeholder 无干支的卡（小运「起运前」）{ text }
 *   shensha     神煞格 { items: ['贵人','文昌'] }  一柱命中多颗，视图折行小字
 * 卡 cell 带 blank（空壳卡整格隐藏但照常占位，行宽不跳）。
 *
 * ⚠⚠ cells 长度**恒** = 4 柱 + 卡数（空壳也占位）：视图不做任何「有才画」的
 *   条件渲染 —— 少一个 cell，这一行的列就错位（对齐又断了）。
 *
 * @param {Array} pillars buildChartData 产出的四柱
 * @param {Array} selCards buildSelCards 产出的选中运卡（可为空数组）
 * @param {Array} shenshaByPillar 四柱各自的神煞（core/shensha.compute 的 byPillar），可缺省
 * @returns {Array<{key,label,cells}>}
 */
function buildPillarRows(pillars, selCards, shenshaByPillar) {
  const cards = selCards || [];
  const all = function (fn) { return pillars.map(fn).concat(cards.map(fn)); };
  const val = function (text, cls, gold, blank) {
    return { kind: 'value', text: text || '', cls: cls || '', gold: !!gold, blank: !!blank };
  };
  /**
   * 神煞格：一柱命中的神煞（可能多颗），**完整名**数组交给视图去排版。
   * ⚠ 用 `name`（「天乙贵人」）不用短名 —— 用户 2026-10-08：「神煞不要缩写」。
   *   宽度靠视图**竖排**（一颗一行）消化，不靠缩字。
   * ⚠ 运卡位置：现在**也有**神煞（用户 2026-10-08：「大运流年流月也要显示神煞」）——
   *   由 buildSelCards 的 `shenshaOf(gz)` 算好挂在卡上，这里直接透传。
   *   blank 跟随卡自身 ⇒ 空壳卡高度 0。
   */
  const sha = function (list, blank) {
    const items = (list || []).map(function (s) { return s.name; });
    return { kind: 'shensha', items: items, text: items.join(' '), blank: !!blank };
  };

  return [
    {
      // 列头行：年柱…/卡标签。行头格空着（问真那格写「日期」，我们出生时间已在卡片顶部）
      key: 'head', label: '',
      cells: all(function (x) { return val(x.label); })
    },
    {
      key: 'shiShen', label: '主星',
      // 日柱主星是「元男/元女」，照旧给金色；卡的主星不上金
      cells: pillars.map(function (p) { return val(p.shiShen, '', p.isDay); })
        .concat(cards.map(function (c) { return val(c.shiShen, '', false, c.blank); }))
    },
    {
      key: 'stem', label: '天干',
      // ⚠ placeholder（占位文案格）只给**真正有文案**的卡（小运「起运前」）——
      //   它带 minHeight，会把整行撑高；空壳卡（流月未选中）没有文案，
      //   必须给空 value（高度 0），否则行里出现一段看不见的空白（2026-10-08 真机踩过）。
      cells: pillars.map(function (p) { return val(p.stem, p.stemCls); })
        .concat(cards.map(function (c) {
          if (c.gan) return val(c.gan, c.ganCls, false, c.blank);
          return c.text
            ? { kind: 'placeholder', text: c.text, blank: !!c.blank }
            : val('', '', false, c.blank);
        }))
    },
    {
      key: 'branch', label: '地支',
      cells: pillars.map(function (p) { return val(p.branch, p.branchCls); })
        .concat(cards.map(function (c) { return val(c.zhi, c.zhiCls, false, c.blank); }))
    },
    {
      key: 'canggan', label: '藏干',
      cells: all(function (x) { return { kind: 'canggan', items: x.canggan || [], blank: !!x.blank }; })
    },
    { key: 'xingYun', label: '星运', cells: all(function (x) { return val(x.xingYun, '', false, x.blank); }) },
    { key: 'ziZuo', label: '自坐', cells: all(function (x) { return val(x.ziZuo, '', false, x.blank); }) },
    { key: 'kongWang', label: '空亡', cells: all(function (x) { return val(x.kongWang, '', false, x.blank); }) },
    { key: 'nayin', label: '纳音', cells: all(function (x) { return val(x.nayin, x.nayinCls, false, x.blank); }) },
    {
      // 神煞行（2026-10-08 用户：「给我的排盘结果也增加神煞显示」）。
      // 规则照《问真神煞大全》55 颗（core/shensha-rules.js），计算在 core/shensha.js。
      // ⚠ 四柱：本命神煞（compute）；运卡：运限神煞（computeForColumn，buildSelCards 里算好）。
      // ⚠ 空壳卡神煞格高度 0，不撑高行。
      key: 'shensha', label: '神煞',
      cells: pillars.map(function (p, i) { return sha((shenshaByPillar || [])[i], p.blank); })
        .concat(cards.map(function (c) { return sha(c.shensha, c.blank); }))
    }
  ];
}


/**
 * 装配整块盘面（对应原组件 load 方法里「算」的那一半）。
 * @param mode 'dingqi'（默认，读记录里存的盘）| 'pingqi'（现场按平气法算）
 * @returns {{ready:boolean, ...}} 视图直接可用的 data
 *
 * ⚠⚠ 平气法分支**只换盘面数据源**，下面的装配逻辑一行不分叉 ——
 *   四柱行、选中运卡、事件标记全部同一套代码，UI 自然一致。
 */
function buildChartData(rec, nowYear, mode = MODE_DING) {
  const ping = normMode(mode) === MODE_PING;
  const board = rec && rec.chart ? boardOf(rec, mode) : null;
  if (!rec || !rec.chart || !board || !board.chart) {
    return {
      ready: false,
      // 平气法算不出来（例如出生年超出 1600–2200 的节气表）时，
      // 视图据此说「平气法算不出这条盘」，而不是一句笼统的「还没有排盘数据」
      pingqiFailed: ping && !!rec && !!rec.chart,
      pillars: [],
      shenshaByPillar: [],
      dayuns: [],
      liunians: [],
      liuyues: [],
      selCards: [],
      inlineDayun: '',
      inlineLiunian: '',
      inlineLiuyue: ''
    };
  }

  const chart = board.chart;
  const rec2 = board.chart === rec.chart ? rec : { ...rec, chart: board.chart, bazi: board.bazi };
  // 四柱表头固定「年柱 / 月柱 / 日柱 / 时柱」—— 日柱不自论十神，
  // 所以性别称谓「元男 / 元女」落在日柱那格的十神位上：
  // 引擎给的 p.shiShen 对日柱只是「日主」占位，页面显示时换成性别称谓。
  const labels = ['年柱', '月柱', '日柱', '时柱'];
  const keys = ['year', 'month', 'day', 'hour'];
  const yuanText = rec.gender === 1 ? '元男' : '元女';

  const pillars = keys.map(function (key, i) {
    const p = chart.pillars[key];
    return {
      key: 'p' + i,
      label: labels[i],
      // 日柱的高亮不靠 label 文案判断（语义会漂），一律走标记位
      isDay: i === 2,
      shiShen: i === 2 ? yuanText : p.shiShen,
      stem: p.name.charAt(0),
      branch: p.name.charAt(1),
      // 干、支逐字按五行上色（c-mu / c-huo / c-tu / c-jin / c-shui）
      stemCls: chartLib.elementClass(p.name.charAt(0)),
      branchCls: chartLib.elementClass(p.name.charAt(1)),
      element: p.element,
      // 纳音（如「大林木」，60 甲子两两共用一个）。
      // ⚠ 老记录的 chart 是**老代码**算的、没有这个字段 ⇒ `|| ''` 降级成不画（与 canggan 同一套）。
      //   注意：轻记录打开时会 hydrate **重排**，所以正常路径上一定有值；
      //   这个兜底只防「手里拿着一份旧 chart 对象」的路径（对比页 / 分享页将来会用）。
      nayin: p.nayin || '',
      // 纳音五行的配色 class：末字即五行 → 复用单字映射。缺 nayin 时是空串，视图里回退成灰色。
      nayinCls: p.nayin ? chartLib.elementClass(p.nayin.slice(-1)) : '',
      // 星运 / 自坐 / 空亡（2026-10-08 照问真「专业细盘」加的行）；老 chart 对象没有 → 空串降级
      xingYun: p.xingYun || '',
      ziZuo: p.ziZuo || '',
      kongWang: p.kongWang || '',
      // 藏干（本气/中气/余气 + 藏干十神 + 五行配色）；老记录的 chart 没这个字段时降级
      canggan: p.canggan || []
    };
  });

  // 八字扩展（司令分野 / 胎元 / 交运 / 大运）；老记录没有 bazi 字段时降级
  // ⚠ 平气法那份 bz 是现场算的（boardOf 里给），形状与 rec.bazi 一致
  const bz = rec2.bazi || {};
  const dayuns = buildDayuns(bz);

  /*
   * 神煞（2026-10-08 新增）。规则照《问真神煞大全》54 颗，见 core/shensha-rules.js。
   * ⚠ 喂进去的必须带 **nayin**（学堂/词馆/童子煞按年柱纳音五行查）；缺了这三颗静默不出。
   * ⚠ 性别要传：元辰分「阳男阴女 / 阴男阳女」两条路。
   * ⚠ 包 try/catch 降级 —— 神煞是锦上添花，它抛错不能让整块盘面白屏。
   */
  let shenshaByPillar = [];
  try {
    shenshaByPillar = shenshaLib.compute(pillars, rec2.gender).byPillar;
  } catch (err) {
    console.warn('[paipan] 神煞计算失败', err);
  }

  return {
    ready: true,
    pillars: pillars,
    shenshaByPillar: shenshaByPillar,
    genderText: rec.gender === 1 ? '男' : '女',
    lunarFullText: rec.lunarText || '—',
    // 生肖只在有值时显示成标签（老记录没有 zodiac 字段 → 空串，视图里那枚标签自然消失）
    zodiacText: rec.zodiac ? ('属' + rec.zodiac) : '',
    siLingText: bz.siLing || '—',
    taiYuanText: bz.taiYuan || '—',
    jiaoYunText: buildJiaoYunText(rec2),
    dayuns: dayuns,
    // 视图/页面要知道这一盘是哪个口径（平气法算不出来时用来区分空态文案）
    mode: ping ? MODE_PING : MODE_DING,
    liunians: [],
    liuyues: [],
    selCards: [],
    dayunAnchor: 0,
    liunianAnchor: 0,
    _defaultIdx: dayuns.length ? currentDayunIndex(dayuns, nowYear) : -1,
  };
}

/**
 * 平气法的流年 / 流月行（形状照 core/bazi.js 的 generateLunarMonths 输出）。
 *
 * ★★ 2026-10-18 新版算法：**交运年切割已经由算法自己做了** ——
 *   `daYun().steps[i].liuNian` 每项带
 *     part（'之前' / '全年' / '之后'）、isSplitYear、shareWithPrev/Next、hasCut，
 *   每项还有 `liuYue[]`，其中交运月带 `cut`（'交运月：上一步占前半' / '交运月：本步占后半'）。
 *   所以这里**不再自己按 stageRange 拼 10 个整年**，直接透传算法给的那一份 ——
 *   两边口径必须同源，自己再拼一遍就是第二套切割规则。
 *
 * ⚠ 旧版注释里那句「平气法不做交运年切分、这是定案口径」**已作废**：
 *   那是旧算法确实不做，新算法做了。用户 2026-10-18：「算法更新了，照着新算法改」。
 *
 * ⚠⚠ `dayuns` 是 `buildDayuns` 加工过的**展示项**（只有 key / year / age / gz），
 *   `liuNian` 原样留在 `daYun()` 的原始 step 上。所以这里**按年份回原始 steps 里找**：
 *   展示项的 `year` = 该步的 starYear（起运年），两步不会撞年，可以当键。
 *
 * @param idx 大运下标（0 = 起运前的「小运」阶段，对应原始 steps 里的童限）
 */
function pingqiYearRows(rec, dayuns, idx) {
  const bt = birthTime(rec);
  const gender = rec.gender === 1 ? 1 : 0;
  const pack = pingqiLib.daYun(bt.year, bt.month, bt.day, bt.hour, bt.minute, gender);
  const steps = (pack && pack.steps) || [];
  if (!steps.length) return [];

  let raw = null;
  if (idx === 0) {
    // 「小运」那一列 = 原始 steps 里的童限（起运前）
    raw = steps[0];
  } else {
    const d = dayuns[idx];
    const y0 = d && Number(d.year);
    for (let i = 0; i < steps.length; i++) {
      if (!steps[i].isTongXian && Number(steps[i].starYear) === y0) { raw = steps[i]; break; }
    }
  }
  const list = (raw && raw.liuNian) || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const ln = list[i];
    out.push({
      // 虚岁：算法直接给了（与定气法 generateLunarMonths 的「公历年 − 立春年 + 1」同基准）
      nianling: ln.age,
      year: ln.year,
      yearGanZhi: ln.ganzhi || ln.gz || getGanZhiByYear(ln.year),
      // 交运年归属 / 切割标记 / 区间标注（算法算好，视图直接显示，不在渲染层拼字符串）
      part: ln.part || '全年',
      partNote: ln.partNote || '',
      isSplitYear: !!ln.isSplitYear,
      shareWithPrev: !!ln.shareWithPrev,
      shareWithNext: !!ln.shareWithNext,
      hasCut: !!ln.hasCut,
      months: pingqiMonths(ln)
    });
  }
  return out;
}

/**
 * 某流年内的流月（平气十二节交节时刻）。
 * ★ 月份**直接取算法给的 `liuYue[]`**（已按交运切割筛过），不再自己按节气表拼 12 个。
 */
function pingqiMonths(ln) {
  const src = (ln && ln.liuYue) || [];
  return src.map(function (m) {
    const at = pingqiLib.termAt(m.year, m.jie);
    const d = isFinite(at) ? new Date(at) : null;
    return {
      JieQi: m.jie,
      ganZhi: m.zhi === undefined ? '' : monthGzFor(m),
      // ⚠ buildLiuyues 只要 getMonth / getDay（拼成 'M/D'），给个最小对象就够。
      //   优先用算法给的 `at`（'YYYY-MM-DD HH:mm'），节气表取不到时再退回 termAt。
      solarDate: d
        ? { getMonth: function () { return d.getUTCMonth() + 1; }, getDay: function () { return d.getUTCDate(); } }
        : { getMonth: function () { return parseInt(String(m.at).slice(5, 7), 10); },
          getDay: function () { return parseInt(String(m.at).slice(8, 10), 10); } },
      // 交运月被前后两步分占时的标注（null = 正常整月）
      cut: m.cut || null,
      cutHalf: m.cutHalf || null
    };
  });
}

/**
 * 流月干支。
 * 年干取**流年所在公历年**的年柱（与定气法 generateLunarMonths 同一做法：
 * 每月月干跟着所在公历年的年干走），寅月序号由节气名在 JIE_ORDER 里的下标给出。
 */
function monthGzFor(m) {
  const yearGz = getGanZhiByYear(m.year);
  const i = pingqiLib.JIE_ORDER.indexOf(m.jie);
  if (i < 0) return '';
  return pingqiLib.monthGzOf(yearGz, i);
}

/** 流年干支（与 core/bazi.js 的 getGanZhiByYear 同口径：公历年按立春后所值） */
function getGanZhiByYear(y) {
  const GAN = '甲乙丙丁戊己庚辛壬癸';
  const ZHI = '子丑寅卯辰巳午未申酉戌亥';
  const i = (((y - 4) % 60) + 60) % 60;
  return GAN[i % 10] + ZHI[i % 12];
}

/**
 * 选中某一步大运 → 现算该步的流年（0 号位是起运前的小运阶段，走 getYearRange），
 * 并在流年中默认选中「今年」（今年不在该区间则取第一年）。
 *
 * @param mode 'dingqi' | 'pingqi' —— 平气法走 pingqiYearRows（表结构同构，不另起一套）
 * @returns {{ rows: any[], lnIdx: number }} rows 是原始数据（含流月），留在实例上不进视图状态
 */
function computeDayunRows(rec, dayuns, idx, nowYear, mode = MODE_DING) {
  let rows = [];
  try {
    if (normMode(mode) === MODE_PING) {
      rows = pingqiYearRows(rec, dayuns, idx);
    } else {
      const bt = birthTime(rec);
      const gender = rec.gender === 1 ? 1 : 0;
      rows = (idx === 0)
        ? baziLib.getYearRange(bt, gender)
        : baziLib.generateLunarMonths(bt, gender, idx - 1);
    }
  } catch (err) {
    console.warn('[paipan] 流年计算失败', err);
  }

  const stage = stageRange(dayuns, idx);
  const y = nowYear == null ? new Date().getFullYear() : nowYear;
  let lnIdx = rows.length ? 0 : -1;
  if (lnIdx === 0 && y >= stage.start && y < stage.end) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].year === y) { lnIdx = i; break; }
    }
  }
  return { rows: rows, lnIdx: lnIdx };
}

/**
 * 三张表 + 四柱右侧面板的唯一出口（对应原组件的 setTables）。
 *
 * 面板内容是从三张表的选中项推导出来的，所以必须和表格在同一次更新里写，
 * 否则会出现「表格已换、面板还是上一次的」中间态。
 * 事件记录（格子标记 + 内联正文）也在这里一起落 —— 三张表换了，
 * 挂在上面的标记就必须跟着换，分两次写会出现「格子已经翻页、红点还在原处」。
 */
function setTables(rec, dayuns, liunians, liuyues, ctx, notes) {
  const day = rec && rec.chart && rec.chart.pillars ? rec.chart.pillars.day : null;
  const marked = decorate(dayuns, liunians, liuyues, ctx, notes);

  /*
   * 运限神煞：把「这一步运的干支」放进原局一起查（口径 = 问真「岁运逢之」）。
   * ⚠ 这里就地造一个回调（而不是把性别/四柱一路透传下去）—— buildSelCards 只关心
   *   「给我个干支，还我神煞数组」，不该知道神煞怎么算。
   * ⚠⚠ 包 try/catch：神煞是锦上添花，它抛错不能让整块盘面白屏（与 buildChartData 同策）。
   */
  const shenshaOf = function (gz) {
    try {
      const ps = (rec && rec.chart && rec.chart.pillars) || null;
      if (!ps) return [];
      const arr = [ps.year, ps.month, ps.day, ps.hour];
      return shenshaLib.computeForColumn(arr, gz, rec.gender);
    } catch (err) {
      console.warn('[paipan] 运限神煞计算失败', err);
      return [];
    }
  };

  return {
    dayuns: marked.dayuns,
    liunians: marked.liunians,
    liuyues: marked.liuyues,
    selCards: buildSelCards(marked.dayuns, marked.liunians, marked.liuyues,
      day ? day.name.charAt(0) : '', shenshaOf),
    inlineDayun: marked.inline.dayun,
    inlineLiunian: marked.inline.liunian,
    inlineLiuyue: marked.inline.liuyue,
  };
}

/** 当前选中那一步大运的元信息（给子级当「祖父级快照」带上） */
function dayunMetaOf(ctx, dayuns) {
  const c = ctx || {};
  const it = (c.di != null && dayuns[c.di]) || null;
  if (!it) return null;
  return { year: it.year, ganzhi: it.gz, age: it.age };
}

/** 当前选中流年的元信息（给流月当「父级快照」带上） */
function liunianMetaOf(ctx, liunians) {
  const c = ctx || {};
  const idx = (c.lnIdx != null) ? c.lnIdx : -1;
  const it = (idx >= 0 && liunians[idx]) || null;
  if (!it) return null;
  return { year: it.year, ganzhi: it.gz, age: it.age };
}

module.exports = {
  // 内部工具（测试会直接用）
  buildJiaoYunText,
  birthTime,
  withGzFields,
  buildDayuns,
  withActive,
  currentDayunIndex,
  scrollAnchor,
  stageRange,
  buildLiunians,
  buildLiuyues,
  buildPillarRows,
  pickActive,
  copy,
  decorate,
  blankCard,
  buildSelCards,
  // 对外的装配入口
  buildChartData,
  computeDayunRows,
  setTables,
  dayunMetaOf,
  liunianMetaOf,
};
