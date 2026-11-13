/**
 * 排盘引擎 —— 基于 tyme4ts（MIT，https://github.com/6tail/tyme4ts）
 *
 * 对外只暴露一个 paipan()，返回结构与页面消费字段保持一致：
 *   pillars / fourChars / shiShenList / dayMaster* / hourName / zodiac / elements
 *   （pillars 每柱含 nayin：纳音 + canggan：藏干 + 藏干十神）
 *
 * 口径说明（与 tyme 默认实现一致）：
 *   - 年柱以立春为界，月柱以「节」为界，节气精确到具体时刻（非按日近似）
 *   - 晚子时（23:00-24:00）日柱按次日计算，属 tyme 默认流派
 *   - 十神以日干为「我」：dayStem.getTenStar(otherStem)
 */

const tyme = require('../vendor/tyme.js');

const PILLAR_KEYS = ['year', 'month', 'day', 'hour'];
const PILLAR_LABELS = ['年柱', '月柱', '日柱', '时柱'];
const ELEMENT_NAMES = ['木', '火', '土', '金', '水'];
const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';

/**
 * 单字 → 五行拼音码，供页面逐字上色（result.ttss 里的 .c-mu / .c-huo / .c-tu / .c-jin / .c-shui）。
 * 天干按本气五行，地支按本气五行（四土：辰戌丑未）。
 */
const STEM_ELEMENT_CODES = {
  '甲': 'mu', '乙': 'mu', '丙': 'huo', '丁': 'huo', '戊': 'tu',
  '己': 'tu', '庚': 'jin', '辛': 'jin', '壬': 'shui', '癸': 'shui'
};
const BRANCH_ELEMENT_CODES = {
  '寅': 'mu', '卯': 'mu', '巳': 'huo', '午': 'huo',
  '辰': 'tu', '戌': 'tu', '丑': 'tu', '未': 'tu',
  '申': 'jin', '酉': 'jin', '亥': 'shui', '子': 'shui'
};
/** 五行**字**本身的码（纳音末字就是五行字，不是干支） */
const ELEMENT_CHAR_CODES = { '木': 'mu', '火': 'huo', '土': 'tu', '金': 'jin', '水': 'shui' };

/**
 * 单个干 / 支字 → 五行配色 class，如「甲」→「c-mu」；非干支返回空串。
 * ⚠ 纳音末字（「大林**木**」）是**五行字**、不是干支，也走这里（第三张表）。
 * @param {string} char 单字
 */
function elementClass(char) {
  const code = STEM_ELEMENT_CODES[char] || BRANCH_ELEMENT_CODES[char] || ELEMENT_CHAR_CODES[char];
  return code ? 'c-' + code : '';
}

/**
 * 两字干支 → 干 / 支拆字 + 各自的五行配色 class（模板里逐字着色要用）。
 * 非干支（如大运首列的「小运」）或长度不对时全部返回空串，
 * 页面据此回退成「整串一个色」的渲染（见 result.ttml 的 .gz-gz）。
 * @param {string} gz 两字干支
 * @returns {{gan: string, zhi: string, ganCls: string, zhiCls: string}}
 */
function gzClasses(gz) {
  const empty = { gan: '', zhi: '', ganCls: '', zhiCls: '' };
  if (typeof gz !== 'string' || gz.length !== 2) return empty;
  const gan = gz.charAt(0);
  const zhi = gz.charAt(1);
  if (GAN.indexOf(gan) < 0 || ZHI.indexOf(zhi) < 0) return empty;
  return { gan: gan, zhi: zhi, ganCls: elementClass(gan), zhiCls: elementClass(zhi) };
}

/**
 * 地支藏干 → [{ stem, shiShen, cls }]。
 * 顺序为本气 / 中气 / 余气（与 RYSL 分日用事的用事长短同序，已与问真排盘逐支核对一致）；
 * 十神以传入的日干为「我」，cls 是该藏干的五行配色 class。
 * 四柱与右侧选中运卡共用这一份实现（页面不自己拆藏干）。
 *
 * @param {string} branchName 地支单字，如「亥」
 * @param {string} dayStemName 日干单字，如「丁」
 */
function cangGanOf(branchName, dayStemName) {
  if (ZHI.indexOf(branchName) < 0 || GAN.indexOf(dayStemName) < 0) return [];
  try {
    const branch = tyme.EarthBranch.fromName(branchName);
    const dayStem = tyme.HeavenStem.fromName(dayStemName);
    if (!branch || !dayStem) return [];
    return branch.getHideHeavenStems().map(function (hide) {
      // getHideHeavenStems 返回的是 HideHeavenStem 包装类型，
      // 要 getHeavenStem() 才是真正的 HeavenStem；直接丢给 getTenStar 会报 getIndex 不存在
      const hideStem = hide.getHeavenStem();
      const name = hideStem.getName();
      return {
        stem: name,
        shiShen: dayStem.getTenStar(hideStem).getName(),
        cls: elementClass(name)
      };
    });
  } catch (err) {
    console.warn('[paipan] 藏干计算失败', err);
    return [];
  }
}

/**
 * 公历时间 → 四柱排盘
 * @param {number} y 公历年
 * @param {number} m 公历月 1-12
 * @param {number} d 公历日
 * @param {number} hour 小时 0-23
 * @param {number} [minute] 分钟 0-59（影响节气交界与时辰边界）
 */
function paipan(y, m, d, hour, minute) {
  const solarTime = tyme.SolarTime.fromYmdHms(y, m, d, hour, minute || 0, 0);
  const lunarHour = solarTime.getLunarHour();
  const eightChar = lunarHour.getEightChar();

  const cycles = {
    year: eightChar.getYear(),
    month: eightChar.getMonth(),
    day: eightChar.getDay(),
    hour: eightChar.getHour()
  };
  const dayStem = cycles.day.getHeavenStem();

  const pillars = {};
  const elements = { '木': 0, '火': 0, '土': 0, '金': 0, '水': 0 };

  PILLAR_KEYS.forEach(function (key) {
    const cycle = cycles[key];
    const stem = cycle.getHeavenStem();
    const branch = cycle.getEarthBranch();
    const stemElement = stem.getElement().getName();
    const branchElement = branch.getElement().getName();

    pillars[key] = {
      name: cycle.getName(),
      stem: stem.getName(),
      branch: branch.getName(),
      element: stemElement + branchElement,
      // 日柱不列十神，页面显示「日主」
      shiShen: key === 'day' ? '日主' : dayStem.getTenStar(stem).getName(),
      // 纳音（如「大林木」）：**由 tyme 的 getSound() 给**，
      // 60 甲子两两共用一个纳音（30 个名目），绝不自己列表 ——
      // 自己抄一份 60 项的表，就是「同一件事两份实现」的老坑。
      nayin: cycle.getSound().getName(),
      // 星运：日干「我」在这柱地支的十二长生（与问真「专业细盘」的星运行同口径）
      xingYun: terrainOf(dayStem.getName(), branch.getName()),
      // 自坐：本柱天干坐在本柱地支上的十二长生
      ziZuo: terrainOf(stem.getName(), branch.getName()),
      // 空亡：本柱干支所在旬的两个空亡支，如「辰巳」
      kongWang: xunKongOf(cycle.getName()),
      // 藏干（本气/中气/余气）+ 藏干十神 + 五行配色（照问真「专业细盘」的藏干行）
      canggan: cangGanOf(branch.getName(), dayStem.getName())
    };

    elements[stemElement] += 1;
    elements[branchElement] += 1;
  });

  return {
    pillars: pillars,
    fourChars: PILLAR_KEYS.map(function (key) { return pillars[key].name; }),
    pillarLabels: PILLAR_LABELS,
    shiShenList: PILLAR_KEYS.map(function (key) { return pillars[key].shiShen; }),

    dayMasterName: dayStem.getName(),
    dayMasterElement: dayStem.getElement().getName(),
    // tyme 的 YinYang 是数字枚举：0 阴 / 1 阳
    dayMasterYang: dayStem.getYinYang() === tyme.YinYang.YANG,

    hourName: lunarHour.getName(),
    zodiac: cycles.year.getEarthBranch().getZodiac().getName(),
    elements: elements,

    // 供「节气交界」类展示使用（如 2024-02-04 立春当天前后年柱不同）
    termName: solarTime.getTerm().getName()
  };
}

/**
 * 任意干支的十神与五行（口径与四柱完全一致，都以日干为「我」）。
 * 给结果页四柱右侧的大运 / 流年 / 流月柱卡用 —— 那三张卡要和四柱显示同样的行，
 * 所以十神走 dayStem.getTenStar(stem)、五行走「干五行 + 支五行」，与 paipan() 同源。
 *
 * @param {string} dayStemName 日干名，如「丙」
 * @param {string} gz 两字干支，如「乙亥」；非两字（如「小运」）返回空
 * @returns {{shiShen: string, element: string}}
 */
function ganZhiInfo(dayStemName, gz) {
  if (typeof gz !== 'string' || gz.length !== 2) return { shiShen: '', element: '' };
  // 先认字：tyme 的 fromName 遇到「小运」这类非干支会直接抛（并打日志），提前挡掉
  if (GAN.indexOf(gz.charAt(0)) < 0 || ZHI.indexOf(gz.charAt(1)) < 0) return { shiShen: '', element: '' };
  if (GAN.indexOf(dayStemName) < 0) return { shiShen: '', element: '' };
  try {
    const dayStem = tyme.HeavenStem.fromName(dayStemName);
    const stem = tyme.HeavenStem.fromName(gz.charAt(0));
    const branch = tyme.EarthBranch.fromName(gz.charAt(1));
    if (!dayStem || !stem || !branch) return { shiShen: '', element: '' };
    return {
      shiShen: dayStem.getTenStar(stem).getName(),
      element: stem.getElement().getName() + branch.getElement().getName()
    };
  } catch (err) {
    console.warn('[paipan] 干支十神/五行计算失败', err);
    return { shiShen: '', element: '' };
  }
}

/**
 * 两字干支 → 纳音名（如「癸酉」→「剑锋金」）。
 * 给结果页右侧的大运 / 流年 / 流月卡用 —— 四柱那条走的是 cycle.getSound()，
 * 这里走 SixtyCycle.fromName(gz).getSound()，**同一份 tyme 实现**，不另抄对照表。
 *
 * @param {string} gz 两字干支；非干支（如「小运」）或长度不对时返回空串
 */
function nayinOf(gz) {
  if (typeof gz !== 'string' || gz.length !== 2) return '';
  if (GAN.indexOf(gz.charAt(0)) < 0 || ZHI.indexOf(gz.charAt(1)) < 0) return '';
  try {
    const cycle = tyme.SixtyCycle.fromName(gz);
    return cycle ? cycle.getSound().getName() : '';
  } catch (err) {
    console.warn('[paipan] 纳音计算失败', err);
    return '';
  }
}

/**
 * 十二长生（地势）：天干在某地支的状态（长生/沐浴/冠带/临官/帝旺/衰/病/死/墓/绝/胎/养）。
 * 「星运」= 日干对各柱（运）地支；「自坐」= 各柱（运）天干对**本柱**地支 —— 同一个 API 两处用。
 *
 * @param {string} stemName 天干单字，如「丙」
 * @param {string} branchName 地支单字，如「巳」
 * @returns {string} 如「临官」；参数非法返回空串
 */
function terrainOf(stemName, branchName) {
  if (GAN.indexOf(stemName) < 0 || ZHI.indexOf(branchName) < 0) return '';
  try {
    const stem = tyme.HeavenStem.fromName(stemName);
    const branch = tyme.EarthBranch.fromName(branchName);
    return stem && branch ? stem.getTerrain(branch).getName() : '';
  } catch (err) {
    console.warn('[paipan] 十二长生计算失败', err);
    return '';
  }
}

/**
 * 旬空（空亡）：两字地支，如「辰巳」。
 * 这版 tyme 没带旬空，但推导只有一步，**不是抄表**：
 * 六十甲子每旬 10 个、旬首必是「甲 X」，本旬 10 天走不到的就是旬首地支
 * **往前数两位**的那两个支（甲子旬 → 戌亥空、甲戌旬 → 申酉空…）。
 *
 * @param {string} gz 两字干支，如「壬寅」；非干支返回空串
 */
function xunKongOf(gz) {
  if (typeof gz !== 'string' || gz.length !== 2) return '';
  if (GAN.indexOf(gz.charAt(0)) < 0 || ZHI.indexOf(gz.charAt(1)) < 0) return '';
  try {
    const idx = tyme.SixtyCycle.fromName(gz).getIndex();
    const firstIdx = idx - (idx % 10);       // 旬首（甲 X）的下标
    const firstBranch = firstIdx % 12;       // 旬首地支的序号
    // 旬首支 + 10、+11（mod 12）= 本旬覆盖不到的两支
    return ZHI[(firstBranch + 10) % 12] + ZHI[(firstBranch + 11) % 12];
  } catch (err) {
    console.warn('[paipan] 空亡计算失败', err);
    return '';
  }
}

module.exports = {
  paipan: paipan,
  ganZhiInfo: ganZhiInfo,
  nayinOf: nayinOf,
  terrainOf: terrainOf,
  xunKongOf: xunKongOf,
  cangGanOf: cangGanOf,
  elementClass: elementClass,
  gzClasses: gzClasses,
  ELEMENT_NAMES: ELEMENT_NAMES,
  PILLAR_LABELS: PILLAR_LABELS
};
