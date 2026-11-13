/**
 * 排盘表单（**封装件**）—— 排盘页与结果页「修改出生时间」共用这一份。
 *
 * 抽出来的原因（用户 2026-10-21）：
 *   「排盘结果页面的详细信息页面的修改功能，还要提供修改出生时间的功能，
 *     点击则打开排盘页面（排盘页面要封装，这就可以复用了）」
 *   ⇒ 排盘页（tab）与结果页那个浮层**必须是同一份代码**：
 *     两处各写一遍「性别 / 历法 / 出生时间 / 四柱反查」，改一处漏一处，
 *     迟早出现「排盘页能选四柱、修改浮层不能」这种口径分叉。
 *
 * ============ 边界 ============
 * · 本组件**只管表单**：不含公告条、登录态那一行、页面外壳（Screen）——
 *   那些是排盘页的页面级外壳，复用方（结果页浮层）不要它们。
 * · **真值永远是公历** `date`/`time`：农历只换「怎么选、怎么显示」，四柱只是**输入方式**
 *   （反查出来的也写回公历）。换历法时 date/time 一个字节都不动。
 * · 提交只把 `{gender, date, time}` 交给调用方 —— **排盘/保存由调用方决定**
 *   （排盘页拿去 create + chartBus；结果页拿去改那条记录并重排）。
 *
 * ⚠ 两个浮层（DatePicker / GzPicker）由本组件自己管：它们是「选时间」这一步的一部分，
 *   留在调用方就等于把表单拆成两半。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';

import DatePicker from './DatePicker';
import GzPicker from './GzPicker';
import { useRpx } from '../theme/rpx';
import { COLORS, FONT_WEIGHTS, RADII, SIZES } from '../theme/tokens';

/* ⚠ 用 require 而不是 import：core/ 是 CommonJS */
const szLib: any = require('../core/sizhu.js');
const model: any = require('../screens/paipan/model.js');

export type BirthValue = { gender: number; date: string; time: string };

type GzpState = {
  visible: boolean;
  pillars: any;
  list: any[];
  status: 'input' | 'loading' | 'result' | 'empty';
  picked: boolean;
  pillarsText: string;
};

const EMPTY_GZP: GzpState = {
  visible: false, pillars: null, list: [], status: 'input', picked: false, pillarsText: '',
};

export default function PaipanForm({
  initial,
  submitText,
  hint,
  busy = false,
  onSubmit,
}: {
  /** 预填值（结果页「修改出生时间」用；排盘页不传 = 默认 男 / 1990-01-01 00:00） */
  initial?: Partial<BirthValue>;
  submitText?: string;
  /** 提交按钮上方的一行说明（可选） */
  hint?: string;
  /** 提交中（调用方在飞请求时传 true，按钮变灰） */
  busy?: boolean;
  onSubmit: (v: BirthValue) => void;
}) {
  const rpx = useRpx();

  const init = initial || {};
  const [gender, setGender] = useState(typeof init.gender === 'number' ? init.gender : 1);
  const [calendar, setCalendar] = useState<'solar' | 'lunar' | 'sizhu'>('solar');
  /** ⚠ 真值：永远是公历的 YYYY-MM-DD / HH:mm，换历法不动它 */
  const [date, setDate] = useState(typeof init.date === 'string' && init.date ? init.date : '1990-01-01');
  const [time, setTime] = useState(typeof init.time === 'string' && init.time ? init.time : '00:00');
  const [dt, setDt] = useState<{ text: string; hint: string }>({ text: '', hint: '' });
  const [datePicker, setDatePicker] = useState(false);
  const [gzp, setGzp] = useState<GzpState>(EMPTY_GZP);
  /** 一行轻提示（代替小程序的 tt.showToast —— RN 没有轻提示组件） */
  const [toast, setToast] = useState('');

  /* ---------------- 出生时间那一行的文案 ---------------- */

  /** 由真值 + 当前历法算出来（纯函数在 paipan/model.js，可单测） */
  const syncDt = useCallback((cal: string, d: string, t: string) => {
    setDt(model.dtOf(cal, d, t));
  }, []);

  useEffect(() => { syncDt(calendar, date, time); }, [calendar, date, time, syncDt]);

  /* ---------------- 表单 ---------------- */

  const onGender = useCallback((g: number) => {
    Keyboard.dismiss();
    setGender(g);
  }, []);

  const onCalendar = useCallback((c: string) => {
    const next = model.switchCalendar(c);
    if (!next) return;
    setCalendar(next);
  }, []);

  const onDateSelect = useCallback((v: { date: string; time: string }) => {
    setDatePicker(false);
    setDate(v.date);
    setTime(v.time);
  }, []);

  /* ---------------- 四柱反查 ---------------- */

  const onOpenGz = useCallback(() => {
    setGzp((prev) => ({ ...prev, visible: true, status: 'input' }));
  }, []);

  const onGzClose = useCallback(() => {
    setGzp((prev) => ({ ...prev, visible: false, status: 'input' }));
  }, []);

  const onGzBack = useCallback(() => {
    setGzp((prev) => ({ ...prev, status: 'input' }));
  }, []);

  const onGzSearch = useCallback((pillars: any) => {
    setGzp((prev) => ({ ...prev, status: 'loading', pillars }));
    // 先让 loading 渲染出来再占用主线程算（扫 1000~2050 年是几十毫秒）
    setTimeout(() => {
      const r = szLib.search(pillars);
      setGzp((prev) => ({ ...prev, list: r.list, status: r.ok ? 'result' : 'empty' }));
    }, 16);
  }, []);

  const onGzPick = useCallback((v: { date: string; time: string; pillars: any }) => {
    const next = model.applyGzPick(v);
    setDate(next.date);
    setTime(next.time);
    setGzp({
      visible: false, status: 'input', list: [],
      picked: true, pillars: next.pillars, pillarsText: next.pillarsText,
    });
    setToast(next.notice);
  }, []);

  /* ---------------- 提交 ---------------- */

  const onSubmitPress = useCallback(() => {
    Keyboard.dismiss();
    if (busy) return;
    onSubmit({ gender: gender, date: date, time: time });
  }, [busy, gender, date, time, onSubmit]);

  /* ---------------- 样式 ---------------- */

  const s = useMemo(() => StyleSheet.create({
    formCard: {
      backgroundColor: COLORS.bg,
      borderRadius: rpx(RADII.card),
      paddingTop: rpx(8), paddingBottom: rpx(28), paddingHorizontal: rpx(32),
      marginBottom: rpx(SIZES.cardGap),
    },
    segRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: rpx(28),
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.borderLight,
    },
    seg: {
      flexDirection: 'row',
      backgroundColor: '#f7f3ec',
      borderRadius: rpx(RADII.btn),
      padding: rpx(4),
    },
    segItem: {
      paddingVertical: rpx(8), paddingHorizontal: rpx(26),
      borderRadius: rpx(RADII.btn),
    },
    segItemText: { fontSize: rpx(26), color: '#a08c6b' },
    segItemActive: { backgroundColor: COLORS.gold },
    segItemTextActive: { color: '#ffffff' },

    row: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: rpx(28),
    },
    rowLabel: { color: COLORS.text, fontSize: rpx(28) },
    req: { fontSize: rpx(22), color: COLORS.goldPale },
    dtValue: { flexDirection: 'row', alignItems: 'center' },
    dtValueText: { color: COLORS.text, fontSize: rpx(28) },
    arrow: { color: '#d0d0d0', marginLeft: rpx(6), fontSize: rpx(28) },

    hintLine: { fontSize: rpx(24), color: COLORS.goldPale, paddingTop: rpx(16) },

    btnDark: {
      backgroundColor: '#161616',
      height: rpx(96), borderRadius: rpx(RADII.btn),
      alignItems: 'center', justifyContent: 'center',
      marginTop: rpx(32),
    },
    btnDarkOff: { opacity: 0.5 },
    btnDarkText: {
      color: '#c9a96a', fontSize: rpx(34), letterSpacing: rpx(4), fontWeight: FONT_WEIGHTS.medium,
    },

    toast: {
      marginTop: rpx(16), alignSelf: 'center',
      backgroundColor: 'rgba(22,22,22,0.86)',
      borderRadius: rpx(RADII.cell),
      paddingVertical: rpx(12), paddingHorizontal: rpx(24),
    },
    toastText: { color: '#fff', fontSize: rpx(24) },
  }), [rpx]);

  return (
    <>
      <View style={s.formCard}>
        {/* 性别 + 历法 */}
        <View style={s.segRow}>
          <View style={s.seg}>
            {[1, 0].map((g) => (
              <Pressable
                key={g}
                style={[s.segItem, gender === g ? s.segItemActive : null]}
                onPress={() => onGender(g)}
              >
                <Text style={[s.segItemText, gender === g ? s.segItemTextActive : null]}>
                  {g === 1 ? '男' : '女'}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={s.seg}>
            {([['solar', '公历'], ['lunar', '农历'], ['sizhu', '四柱']] as const).map(([c, label]) => (
              <Pressable
                key={c}
                style={[s.segItem, calendar === c ? s.segItemActive : null]}
                onPress={() => onCalendar(c)}
              >
                <Text style={[s.segItemText, calendar === c ? s.segItemTextActive : null]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* 出生时间 */}
        <View style={s.row}>
          <Text style={s.rowLabel}>
            出生时间<Text style={s.req}>（必填）</Text>
          </Text>
          {calendar === 'sizhu' ? (
            <Pressable style={s.dtValue} onPress={onOpenGz}>
              <Text style={s.dtValueText}>{gzp.picked ? dt.text : '请选择四柱'}</Text>
              <Text style={s.arrow}>›</Text>
            </Pressable>
          ) : (
            <Pressable style={s.dtValue} onPress={() => setDatePicker(true)}>
              <Text style={s.dtValueText}>{dt.text}</Text>
              <Text style={s.arrow}>›</Text>
            </Pressable>
          )}
        </View>

        {/* 农历换算结果 */}
        {calendar === 'lunar' ? <Text style={s.hintLine}>{dt.hint}</Text> : null}

        {/* 四柱反查的来路：反查是「推断」，不给来路用户没法核对 */}
        {calendar === 'sizhu' && gzp.picked ? (
          <Text style={s.hintLine}>{'按 ' + gzp.pillarsText + ' 反查填入'}</Text>
        ) : null}

        {/* 调用方给的说明（结果页浮层用来讲「保存后会发生什么」） */}
        {hint ? <Text style={s.hintLine}>{hint}</Text> : null}

        <Pressable style={[s.btnDark, busy ? s.btnDarkOff : null]} onPress={onSubmitPress} disabled={busy}>
          <Text style={s.btnDarkText}>{submitText || '开始排盘'}</Text>
        </Pressable>
      </View>

      {/* 轻提示（小程序是 tt.showToast，RN 这边用一行浮字代替） */}
      {toast ? (
        <Pressable style={s.toast} onPress={() => setToast('')}>
          <Text style={s.toastText}>{toast}</Text>
        </Pressable>
      ) : null}

      {/* 出生时间点选面板 */}
      <DatePicker
        visible={datePicker}
        calendar={calendar === 'lunar' ? 'lunar' : 'solar'}
        date={date}
        time={time}
        onSelect={onDateSelect}
        onClose={() => setDatePicker(false)}
      />

      {/* 四柱录入面板 */}
      <GzPicker
        visible={gzp.visible}
        pillars={gzp.pillars}
        list={gzp.list}
        status={gzp.status}
        onSearch={onGzSearch}
        onPick={onGzPick}
        onBack={onGzBack}
        onClose={onGzClose}
      />
    </>
  );
}
