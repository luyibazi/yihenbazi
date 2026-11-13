/**
 * rpx → dp 换算
 *
 * 小程序里 `750rpx` 恒等于屏幕宽，所以 1rpx = 屏宽 / 750。RN 的 dp 就是这个比例下的
 * 自然结果 —— 375pt 屏上 1rpx = 0.5dp，与小程序像素级一致。
 *
 * 用法（两种，按场景选）：
 *   ① 组件内部要跟着屏宽变 → `const rpx = useRpx()`
 *   ② 模块级常量（样式表）→ `rpx` 会用到当前捕获的屏宽，
 *      所以样式表必须在组件里用 useMemo 生成，不能写在模块顶层
 *
 * ⚠ 别把 `rpx()` 的结果存进模块级常量 —— 屏宽在旋转 / 分屏时会变，
 *   存下来的值会停在首次渲染的屏宽上（在平板上就是错的）。
 */
import { useMemo } from 'react';
import { useWindowDimensions, PixelRatio } from 'react-native';
import { DESIGN_WIDTH } from './tokens';

/** 不依赖 Hook 的换算（给工具函数 / 非渲染路径用） */
let _cachedWidth = DESIGN_WIDTH / 2;   // 兜底：按 375pt 屏算

export function setDesignWidth(width: number) {
  if (width > 0) _cachedWidth = width;
}

export function rpx(v: number): number {
  return (v * _cachedWidth) / DESIGN_WIDTH;
}

/** 取整到物理像素，避免 RN 上的半像素模糊（细边框尤其明显） */
export function rpxRound(v: number): number {
  const dp = rpx(v);
  return Math.round(dp * PixelRatio.get()) / PixelRatio.get();
}

/** 组件里用这个：拿到一个绑定当前屏宽的 rpx() */
export function useRpx(): (v: number) => number {
  const { width } = useWindowDimensions();
  return useMemo(() => {
    const fn = (v: number) => (v * width) / DESIGN_WIDTH;
    // 顺手更新模块级缓存，让同帧内非 Hook 路径也能拿到正确值
    setDesignWidth(width);
    return fn;
  }, [width]);
}

/**
 * 把一串 rpx 值批量换算成 dp，用于生成样式表。
 * `rpxMap({ padX: 24, size: 38 })` → `{ padX: 12, size: 19 }`（375pt 屏）
 */
export function rpxMap<T extends Record<string, number>>(
  values: T,
  convert: (v: number) => number,
): { [K in keyof T]: number } {
  const out = {} as { [K in keyof T]: number };
  (Object.keys(values) as Array<keyof T>).forEach((k) => {
    out[k] = convert(values[k]);
  });
  return out;
}

/**
 * 行高换算：设计稿写的是「倍数 × 字号」，RN 要绝对 dp。
 * `lh(54, 1.2, rpx)` → 54rpx × 1.2 换算成 dp
 */
export function lh(fontSizeRpx: number, multiple: number, convert: (v: number) => number): number {
  return convert(fontSizeRpx * multiple);
}
