/**
 * 四柱 → 出生日期（反查）
 *
 * 用户需求：在排盘页直接输入四柱，由程序反推出这个八字可能的出生日期
 * ——「不同年份的都要列出来」，用户挑一个。
 *
 * ── 为什么反查是可行的 ──────────────────────────────────────────────
 * 四柱不是 60^4 种自由组合，它被历法死死约束：
 *   · 年柱 60 年一轮（以立春为界）→ 1000~2050 里同一个年柱只有约 17~18 个年份
 *   · 月柱（以「节」为界）在一年里只对应一个月区 → 候选被压到 17~18 个「年月」
 *   · 日柱 60 天一轮，而一个月区约 30 天 → 每个「年月」里通常只有 0~1 天对上
 *   · 时柱由日干按五鼠遁推出 → 日干与时干不相容的组合**直接无解**，可以提前否决
 * 所以最终候选是**十个上下**，不是几万个。
 *
 * ── 上面这些约束也是「录入面板」的选项来源 ──────────────────────────
 * 录入四柱时不该让用户去 4 条 60 甲子里翻（还要自己保证干支配得上）。
 * 这些约束反过来用就是**选项过滤器**：每个干只配 6 个支；年干 + 该年干的口诀
 * 又把月支压到 1~2 个。所以面板按「一柱拆成干 / 支两步」走八步，
 * 每一步只给合法的那几个（见 utils/gzstep.js）。
 * 这里导出的 zhiPartnersOfGan / fiveTigerStart / fiveRatStart 就是那套过滤器的底。
 *
 * ── 两步走：粗筛 + 精验 ─────────────────────────────────────────────
 * 粗筛用 tyme 的 SixtyCycleYear / SixtyCycleMonth：它们直接给出干支年和 12 个
 * 干支月，以及每个月区里的每一天，把范围从 38 万天压到几十天。
 * 精验一律走 SolarTime → LunarHour → EightChar，**与 utils/chart.js 的 paipan()
 * 是同一个入口** —— 反查出来的日期拿去排盘，四柱必定与输入的完全一致，
 * 不会出现「这里查得到、那边排不出」。
 *
 * ⚠ 为什么必须精验、不能只信 SixtyCycleDay：**晚子时**。
 *   SixtyCycleDay 按自然日算日柱，而项目口径（tyme 默认流派）是
 *   「23:00-24:00 属次日」—— 2026-09-30 23:30 的八字，日柱是 10-01 那天的。
 *   两套口径在 23 点这一小时上必然差一天，所以 SixtyCycleDay 只能当**初筛**，
 *   到底要不要由 EightChar 说了算。
 *
 * ⚠ 交节边界：月柱以「节」的**时刻**为界，不是整天。生在交节当天的人，
 *   同一个时辰里可能前半小时还算上个月柱。所以候选项给的是**实测出来的有效时间段**
 *   （用二分找边界），不是想当然的「午时 = 11:00-13:00」。
 *
 * ⚠ 扫描范围比公历可选范围各宽一年：干支年以立春分界，所以要铺 999~2050，
 *   才盖得住「1000 年 1 月」（属 999 干支年的丑月）和「2051 年 1 月」（属 2050 干支年）。
 *   与 `record.hydrate` 的年份校验（`time.YEAR_FLOOR / YEAR_CEIL`）是同一个口径。
 */

const tyme = require('../vendor/tyme.js');
const lunar = require('./lunar.js');
const timeLib = require('./time.js');

const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

/** 干支年的扫描范围（含两端）—— 比公历可选范围各宽一年，见文件头 */
const GZ_YEAR_FROM = timeLib.YEAR_FLOOR;        // 999
const GZ_YEAR_TO = timeLib.SOLAR_YEAR_MAX;      // 2050

let gzCache = null;

/**
 * 60 甲子表（'甲子' → '癸亥'）。
 * 交给 tyme 生成而不是手拼 —— 手拼一次顺序错了，肉眼很难看出来。
 */
function gzList() {
  if (!gzCache) {
    gzCache = [];
    for (let i = 0; i < 60; i++) gzCache.push(tyme.SixtyCycle.fromIndex(i).getName());
  }
  return gzCache;
}

/**
 * 这个干支是否入表。
 * ⚠ 天干地支各取一个共有 10×12 = 120 种拼法，但**只有 60 种存在**
 *   （天干与地支必须同奇偶，所以「甲丑」「乙子」这类排不出来）。
 *   要在这里拦掉，否则用户会拿到一个永远查不到结果的输入，还以为是程序坏了。
 */
function isValidGZ(gz) {
  return typeof gz === 'string' && gz.length === 2 && gzList().indexOf(gz) >= 0;
}

/**
 * 这个天干能配出的地支。
 * ⚠ 天干地支各取一个共有 10×12 = 120 种拼法，但**只有 60 种存在**
 *   （天干与地支必须同奇偶，所以「甲丑」「乙子」这类排不出来）——
 *   于是每个干只配得上 **6 个**支。四柱录入面板就是靠这条把选项从 12 压到 6。
 */
function zhiPartnersOfGan(gan) {
  const gi = GAN.indexOf(gan);
  if (gi < 0) return [];
  const out = [];
  for (let zi = 0; zi < 12; zi++) {
    if ((gi + zi) % 2 === 0) out.push(ZHI[zi]);
  }
  return out;
}

/**
 * 年上起月（五虎遁）：年干 → **正月（寅月）** 的天干序号。
 *   甲己之年丙作首、乙庚之岁戊为头、丙辛必定寻庚起、
 *   丁壬壬位顺行流、戊癸之年甲寅求。
 * 月序 k（0 = 正月/寅）对应的月干 = GAN[(start + k) % 10]。
 * ⚠ 戊 / 癸 那一组算出来是 10，必须取模 —— 戊癸之年是 **甲**寅，不是「第 11 个干」。
 */
function fiveTigerStart(yearGan) {
  const gi = GAN.indexOf(yearGan);
  return gi < 0 ? -1 : ((gi % 5) * 2 + 2) % 10;
}

/**
 * 日上起时（五鼠遁）：日干 → **子时** 的天干序号。
 *   甲己还加甲、乙庚丙作初、丙辛从戊起、丁壬庚子居、戊癸壬子。
 * 时支序号 zi 对应的时干 = GAN[(start + zi) % 10]。
 */
function fiveRatStart(dayGan) {
  const gi = GAN.indexOf(dayGan);
  return gi < 0 ? -1 : (gi % 5) * 2;
}

/**
 * 时柱能不能由这个日干推出来（五鼠遁）：
 * 不满足就一定查不到（日干与时干是绑死的），提前否决，省掉整轮扫描。
 *
 * @param {string} dayGZ  日柱，如 '庚子'
 * @param {string} hourGZ 时柱，如 '丙子'
 */
function hourMatchesDay(dayGZ, hourGZ) {
  if (!isValidGZ(dayGZ) || !isValidGZ(hourGZ)) return false;
  const start = fiveRatStart(dayGZ.charAt(0));
  const hz = ZHI.indexOf(hourGZ.charAt(1));
  return GAN[(start + hz) % 10] === hourGZ.charAt(0);
}

/**
 * 时支序号 → 该时辰在**当天之内**的分钟区间 [起, 止)。
 * ⚠ 子时（0）这里只给「早子」的 00:00-01:00；「晚子」的 23:00-24:00 属另一天，
 *   由 collect() 单独铺（见那里对晚子时的处理）。
 */
function hourSpan(idx) {
  if (idx === 0) return [0, 60];
  return [(idx * 2 - 1) * 60, (idx * 2 + 1) * 60];
}

/** 时辰的标称说法：子时是跨日的「23:00-01:00」，其余就是那两小时 */
function nominalText(idx) {
  if (idx === 0) return '23:00-01:00';
  const s = hourSpan(idx);
  return hhmm(s[0]) + '-' + hhmm(s[1]);
}

/** 一天内的分钟数 → 'HH:mm'（1440 会给出 '24:00'，正是「当晚到午夜」的意思） */
function hhmm(min) {
  const h = Math.floor(min / 60);
  const mi = min - h * 60;
  return (h < 10 ? '0' + h : '' + h) + ':' + (mi < 10 ? '0' + mi : '' + mi);
}

function d2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 公历日 → 四柱干支名（与 utils/chart.js 的 paipan 走同一个入口） */
function eightCharAt(y, m, d, h, mi) {
  const lh = tyme.SolarTime.fromYmdHms(y, m, d, h, mi, 0).getLunarHour();
  const e = lh.getEightChar();
  return [e.getYear(), e.getMonth(), e.getDay(), e.getHour()].map(function (c) {
    return c.getName();
  });
}

/** 这一天这一分钟的四柱，是不是就是输入的那个 */
function matchAt(sd, min, want) {
  const over = Math.floor(min / 1440);
  const rem = min - over * 1440;
  const day = over ? sd.next(over) : sd;
  const got = eightCharAt(day.getYear(), day.getMonth(), day.getDay(),
    Math.floor(rem / 60), rem - Math.floor(rem / 60) * 60);
  return got[0] === want[0] && got[1] === want[1] && got[2] === want[2] && got[3] === want[3];
}

/**
 * 二分找「匹配状态翻转」的分界点。
 * 前提：lo 处状态为 fromOk，且 hi 处状态与它相反（调用点保证）。
 */
function flip(sd, lo, hi, fromOk, want) {
  let a = lo;
  let b = hi;
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (matchAt(sd, mid, want) === fromOk) a = mid;
    else b = mid;
  }
  return b;
}

/**
 * 在 [from, to) 这一小时里，找出**真正**满足四柱的那一段。
 * 绝大多数情况整段都对（交节不在这一小时里）—— 两端各验一次即可；
 * 只有一端对得上时才二分找边界（两小时内最多交节一次，所以至多切一刀）。
 *
 * @returns {Object|null} { from, to } 分钟区间；整段都不对返回 null
 */
function matchSpan(sd, from, to, want) {
  const last = to - 1;
  const a = matchAt(sd, from, want);
  const b = matchAt(sd, last, want);
  if (a && b) return { from: from, to: to };
  if (a) return { from: from, to: flip(sd, from, last, true, want) };
  if (b) return { from: flip(sd, from, last, false, want), to: to };
  return null;
}

/** '距今 N 年' —— 让用户一眼看出这个候选离现在多远 */
function agoText(y, now) {
  const n = now.getFullYear() - y;
  if (n === 0) return '今年';
  if (n > 0) return '距今 ' + n + ' 年';
  return -n + ' 年后';
}

/** 把一个「日 + 时间窗」验成候选项；验不过返回 null */
function makeItem(sd, win, idx, late, want, now) {
  const seg = matchSpan(sd, win[0], win[1], want);
  if (!seg) return null;

  const y = sd.getYear();
  const m = sd.getMonth();
  const d = sd.getDay();
  const pick = Math.floor((seg.from + seg.to) / 2);
  // 实际时间段比标称的短 → 说明这一小时被交节切过，要给用户看真实的那一段
  const narrow = seg.from > win[0] || seg.to < win[1];
  const dateText = y + '-' + d2(m) + '-' + d2(d);

  return {
    key: dateText + '-' + ZHI[idx] + (late ? 'L' : ''),
    year: y,
    dateText: dateText,
    weekText: '星期' + sd.getWeek().getName(),
    lunarText: lunar.solarToLunar(y, m, d).text,
    zhi: ZHI[idx],
    // 时辰名。子时要分早晚：23:00-24:00 那一小时日柱按次日算，是另一个说法，
    // 不分开的话用户会以为列表里那条和自己手上的日期对不上
    zhiText: late ? '晚子时' : ZHI[idx] + '时',
    // 标称时辰区间（子时是跨日的 23:00-01:00）
    timeText: nominalText(idx),
    // 晚子时：23:00-24:00，日柱按次日算 —— 参考项目没有这个区分，但历法上它是真的
    lateZi: late,
    narrow: narrow,
    // 只有被交节切过时才给，模板据此多显示一行「实际……」
    spanText: narrow ? (hhmm(seg.from) + '-' + hhmm(seg.to)) : '',
    // 回填表单用：有效时间段的中间点（同一时辰内四柱相同，取哪一分钟都行）
    pickDate: dateText,
    pickTime: hhmm(pick),
    agoText: agoText(y, now)
  };
}

/**
 * 在一个干支月区里挑出日柱对得上的那些天，逐天验。
 *
 * ⚠ 子时要铺**两个窗口**，因为「子时」在历法上跨日：
 *   · 早子 00:00-01:00 —— 这一天的日柱就是输入的日柱
 *   · 晚子 23:00-24:00 —— 这一天的日柱是输入的日柱**减去一格**
 *     （23 点后的八字按次日算，所以那天的干支日是「次日日柱的前一天」）
 *   两个窗口互不重叠，也不会互相误判。
 *
 * ⚠⚠⚠ `nextMonth` 那一段（2026-10-22 修的 bug，别删）：
 *   `tyme` 的 `getDays()` 是**按整日归属**的 —— 交节落在 X 日，X 日整天被划给
 *   **新**节气月。可是 X 日 00:00 到交节时刻那一小段，月柱还是**上一个月**。
 *   只扫 `month.getDays()` 的话，那一段永远没人验：
 *     · 旧月的 days 里根本没有 X 日；
 *     · 扫新月时它虽然在，却因为「月柱名字不等于输入的月柱」被这里跳过。
 *   ⇒ 现象就是**交节当天的凌晨查不出来**。真实报障（2026-10-22，用户）：
 *     「戊戌 辛酉 己未 乙丑」漏了 1958-10-09 —— 那年寒露在 10-09 凌晨交节，
 *     10-09 整天被划进壬戌月，而 01:00-03:00 仍是辛酉月。
 *   ⇒ 所以每个干支月区**额外把下一个月的首日也扫一遍**（那一日的前一段属本单位）。
 *   ⚠ 不会因此重复：下月首日按归属属**下一个月区**，不在本月的 days 里（见 search 末尾）。
 */
function collect(out, month, idx, prevDayGZ, want, now, nextMonth) {
  let days;
  try {
    days = month.getDays();
  } catch (err) {
    return;
  }
  try {
    const nx = nextMonth.getDays();
    if (nx.length) days = days.concat([nx[0]]);
  } catch (err) {
    /* 拿不到下一个月的首日就只扫本月（少这一天，好过整轮扫描炸掉） */
  }

  for (let k = 0; k < days.length; k++) {
    const scd = days[k];
    const name = scd.getSixtyCycle().getName();
    let win = null;
    let late = false;

    if (idx === 0) {
      if (name === want[2]) {
        win = [0, 60];
      } else if (name === prevDayGZ) {
        win = [23 * 60, 24 * 60];
        late = true;
      }
    } else if (name === want[2]) {
      win = hourSpan(idx);
    }
    if (!win) continue;

    const item = makeItem(scd.getSolarDay(), win, idx, late, want, now);
    if (item) out.push(item);
  }
}

/**
 * 反查：四柱 → 候选出生日期
 *
 * @param {Object} p 四柱干支 { year, month, day, hour }，如 { hour: '丙子', … }
 * @param {Object} [opts] { now: Date } 只给测试注入「今天」用
 * @returns {Object}
 *   ok      Boolean 有没有查到
 *   reason  String  'invalid'（干支本身不合法，如「甲丑」）/ 'nomatch'（历法上不存在）
 *   list    Array   候选项，**由近及远**（越接近现在的年份排越前）
 */
function search(p, opts) {
  const src = p || {};
  const want = ['year', 'month', 'day', 'hour'].map(function (k) {
    return String(src[k] == null ? '' : src[k]);
  });

  for (let i = 0; i < 4; i++) {
    if (!isValidGZ(want[i])) return { ok: false, reason: 'invalid', list: [] };
  }
  // 日干与时干绑死，不相容的输入不必扫
  if (!hourMatchesDay(want[2], want[3])) return { ok: false, reason: 'nomatch', list: [] };

  const idx = ZHI.indexOf(want[3].charAt(1));
  // 晚子时窗口要用到的「前一天日柱」
  const prevDayGZ = idx === 0 ? tyme.SixtyCycle.fromName(want[2]).next(-1).getName() : '';
  const now = (opts && opts.now) || new Date();

  const list = [];
  for (let y = GZ_YEAR_FROM; y <= GZ_YEAR_TO; y++) {
    let cy;
    try {
      cy = tyme.SixtyCycleYear.fromYear(y);
    } catch (err) {
      continue;   // 超出台库覆盖范围：跳过，不打断整轮扫描
    }
    if (cy.getSixtyCycle().getName() !== want[0]) continue;

    let mo = cy.getFirstMonth();
    for (let i = 0; i < 12; i++) {
      const nextMo = mo.next(1);
      if (mo.getSixtyCycle().getName() === want[1]) {
        /* ⚠ 必须把「下个月」也传进去：交节当天的前一段属本月，见 collect 的注释 */
        collect(list, mo, idx, prevDayGZ, want, now, nextMo);
      }
      mo = nextMo;
    }
  }

  /**
   * 由近及远：大多数人查的是自己或近代的人，从天亮的那一头开始看更顺。
   *
   * ⚠ 这里**不需要去重**（曾经加过一遍，2026-10-22 验证后撤掉）：
   *   `getDays()` 是按整日连续铺的、相邻月区**互不重叠**（辛酉 9/8-10/8，壬戌 10/9-11/7），
   *   而被追加的「下月首日」按归属属于**下一个月区**，不可能同时出现在本月的 days 里
   *   ⇒ 同一个日期不会被同一个 collect 扫两次；而不同 collect 只服务不同的 want[1]。
   *   （如果将来把扫描改成「上月末日 + 本月 + 下月首日」三段，就会重复，那时再加。）
   */
  list.sort(function (a, b) { return b.year - a.year; });

  return {
    ok: list.length > 0,
    reason: list.length ? '' : 'nomatch',
    list: list
  };
}

module.exports = {
  search: search,
  gzList: gzList,
  isValidGZ: isValidGZ,
  hourMatchesDay: hourMatchesDay,
  // 下面这几个是「干支之间的硬约束」，四柱录入面板（utils/gzstep.js）也吃同一份
  zhiPartnersOfGan: zhiPartnersOfGan,
  fiveTigerStart: fiveTigerStart,
  fiveRatStart: fiveRatStart,
  // 时辰的标称区间文案（子时是跨日的 23:00-01:00）
  hourText: nominalText,
  ZHI: ZHI,
  GAN: GAN
};
