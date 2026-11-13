/*
 * 一次性数据修复：给「外部导入」的事件补写入时快照（up / up2）+ 流月节气名 + 老 key 换新格式。
 *
 * 缺陷来源：早前批量导入 admin123 的八字案例时，事件值里没带父级快照——
 * 事件记录页的大运/流年两行标题靠子级的 up2/up 兜底（notes.js timeline），
 * 没有快照就退化成光秃秃的「【大运】【流年】」。App 自己长按写入的记录带快照，显示正常。
 *
 * 修复口径 = 与 App 写入路径完全同构：
 *   - key 归一化：notes.js normalizeLegacy（老「表序号」→ 'pre'/'dN'，幂等）；
 *   - 排盘：record.hydrate → M.buildDayuns → M.computeDayunRows（同一套算法，非重写）；
 *   - liunian 值补 up2 = {year,ganzhi,age}（所属大运）；liuyue 值补 up（所属流年）+ up2 + jieQi；
 *   - **只补缺失字段，已有值一个字节不碰**；父级排不出（下标越界）就跳过，绝不编造；
 *   - 顺带抽查：导入值自己的 year/age 若与算出的父流年不一致，只报告不改。
 *
 * 跑法：node tools/_fix-notes-up.cjs --dry   （预览，不落库）
 *       node tools/_fix-notes-up.cjs         （落库）
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APP = path.join(__dirname, '..');
const recordLib = require(path.join(APP, 'src/core/record.js'));
const notesLib = require(path.join(APP, 'src/core/notes.js'));
const M = require(path.join(APP, 'src/components/chart-view/model.js'));

const DRY = process.argv.includes('--dry');
const DB_PATH = 'D:/aiProjecct/workbuddyApp/2026-09-30-01-22-47/paipan-server/data/paipan.db';
const FOCUS_ID = 'r-mtcmxxgbfam';   // 大胃袋良子：修复前后各打印一次时间线，肉眼核对

function fixNotes(notes, rec, dayuns, report) {
  const dayunsBuilt = dayuns;
  const stageRows = {};   // 表序号 → 该阶段流年原始行（懒算）

  const dayunMeta = (idx) => {
    const d = dayunsBuilt[idx];
    return d ? { year: d.year, ganzhi: d.gz, age: d.age } : null;
  };
  const rowsOf = (idx) => {
    if (!stageRows[idx]) {
      try { stageRows[idx] = M.computeDayunRows(rec, dayunsBuilt, idx).rows; }
      catch (e) { stageRows[idx] = []; report('  [warn] 流年计算失败 idx=' + idx + ' ' + e.message); }
    }
    return stageRows[idx];
  };
  const liunianMeta = (idx, ln) => {
    const r = rowsOf(idx)[ln];
    return r ? { year: r.year, ganzhi: r.yearGanZhi, age: r.nianling } : null;
  };

  let changed = false;
  const out = {};
  Object.keys(notes).forEach((k) => {
    let v = notes[k];
    const p = k.split(':');
    if ((p[0] === 'liunian' || p[0] === 'liuyue') && v && typeof v === 'object') {
      const idx = notesLib.dayunIndexOf(p[1]) + 1;   // 'pre'→-1 ⇒ 表 0 号；'d2'→2 ⇒ 表 3 号
      const ln = parseInt(p[2], 10);
      const next = Object.assign({}, v);
      if (!next.up2) {
        const m = dayunMeta(idx);
        if (m) { next.up2 = m; changed = true; }
      }
      if (p[0] === 'liuyue') {
        if (!next.up) {
          const m = liunianMeta(idx, ln);
          if (m) { next.up = m; changed = true; }
        }
        if (!next.jieQi) {
          const mo = (rowsOf(idx)[ln] || {}).months;
          const one = mo && mo[parseInt(p[3], 10)];
          if (one && one.JieQi) { next.jieQi = one.JieQi; changed = true; }
        }
        // 一致性抽查：导入值自带的 year/age 就是父流年快照，与现算结果对一遍
        const m = liunianMeta(idx, ln);
        if (m && (String(next.year) !== String(m.year) || String(next.age) !== String(m.age))) {
          report('  [warn] 父级不一致 ' + k + ' 存 ' + next.year + '/' + next.age + ' 算 ' + m.year + '/' + m.age);
        }
      }
      v = next;
    }
    out[k] = v;
  });
  return { out, changed };
}

function showTimeline(name, notes) {
  const rows = notesLib.timeline(notes);
  console.log('  ---- ' + name + ' 事件记录时间线（修复后预期） ----');
  rows.forEach((r) => console.log('   ', r.level.padEnd(7), r.title, '|', (r.text || '').slice(0, 24)));
}

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare(
  "SELECT id, name, gender, birth_date, birth_time, created_ms, notes, \"desc\" FROM records" +
  " WHERE notes IS NOT NULL AND notes != ''"
).all();

let touched = 0;
db.exec('BEGIN');
try {
  for (const row of rows) {
    let notes;
    try { notes = JSON.parse(row.notes); } catch (e) { console.log('[skip] JSON 解析失败', row.id, row.name); continue; }
    if (!notes || typeof notes !== 'object') continue;

    // 1) 老 key 换新格式（与 hydrate 咽喉点同一份实现，幂等）
    const normalized = notesLib.normalizeLegacy(notes);

    // 2) 没有三层事件 key 的记录不用进排盘（省一次排盘计算）
    const hasTri = Object.keys(normalized).some((k) => /^liunian:|^liuyue:/.test(k));
    if (!hasTri) {
      if (JSON.stringify(normalized) !== JSON.stringify(notes)) {
        console.log('[key-only]', row.id, row.name);
        if (!DRY) db.prepare('UPDATE records SET notes = ? WHERE id = ?').run(JSON.stringify(normalized), row.id);
        touched++;
      }
      continue;
    }

    // 3) 排盘（App 同一套）；排不出就整条跳过，绝不盲改
    const rec = recordLib.hydrate({
      id: row.id, name: row.name, gender: row.gender,
      date: row.birth_date, time: row.birth_time, createdAt: row.created_ms,
      notes: normalized, desc: row.desc,
    });
    if (!rec || !rec.bazi) { console.log('[skip] 排不出盘', row.id, row.name); continue; }
    const dayuns = M.buildDayuns(rec.bazi);

    const { out, changed } = fixNotes(normalized, rec, dayuns, (s) => console.log('[rec ' + row.name + ']', s));
    const jsonSame = JSON.stringify(out) === JSON.stringify(notes);
    if (!changed && jsonSame) continue;

    console.log((DRY ? '[dry] ' : '[fix] ') + row.id + ' | ' + row.name + (changed ? '（补快照）' : '（仅 key 归一化）'));
    if (row.id === FOCUS_ID) showTimeline(row.name, out);
    if (!DRY) db.prepare('UPDATE records SET notes = ? WHERE id = ?').run(JSON.stringify(out), row.id);
    touched++;
  }
  db.exec(DRY ? 'ROLLBACK' : 'COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[abort] 已回滚：', e.message);
  process.exit(1);
}
db.close();
console.log(DRY ? '（dry 预览结束，未写库）' : '完成，更新 ' + touched + ' 条记录');
