import { describe, expect, it } from 'vitest';
import { alignRuns, clippedRange, computeStats, emaDebiased, lowerIndex, quantileSorted, quickselect, upperIndex } from './stats';

const f64 = (a: number[]) => Float64Array.from(a);

describe('emaDebiased', () => {
  it('is identity for weight 0', () => {
    expect(Array.from(emaDebiased(f64([1, 2, 3]), 0))).toEqual([1, 2, 3]);
  });
  it('first value is unbiased (equals the input)', () => {
    const r = emaDebiased(f64([5, 5, 5, 5]), 0.9);
    for (const v of r) expect(v).toBeCloseTo(5, 12);
  });
  it('matches the TensorBoard formula', () => {
    const w = 0.6;
    const xs = [1, 3, 2, 8];
    let last = 0;
    const exp: number[] = [];
    xs.forEach((v, i) => {
      last = last * w + (1 - w) * v;
      exp.push(last / (1 - Math.pow(w, i + 1)));
    });
    const r = emaDebiased(f64(xs), w);
    exp.forEach((e, i) => expect(r[i]).toBeCloseTo(e, 12));
  });
  it('skips non-finite values without advancing', () => {
    const r = emaDebiased(f64([2, NaN, 2, Infinity]), 0.5);
    expect(r[0]).toBe(2);
    expect(Number.isNaN(r[1])).toBe(true);
    expect(r[2]).toBeCloseTo(2, 12);
    expect(Number.isNaN(r[3])).toBe(true);
  });
  it('reuses the output buffer', () => {
    const out = new Float64Array(3);
    expect(emaDebiased(f64([1, 2, 3]), 0.5, out)).toBe(out);
  });
});

describe('quantiles', () => {
  it('quantileSorted interpolates like numpy', () => {
    const a = f64([1, 2, 3, 4]);
    expect(quantileSorted(a, 0.5)).toBe(2.5);
    expect(quantileSorted(a, 0)).toBe(1);
    expect(quantileSorted(a, 1)).toBe(4);
    expect(quantileSorted(a, 0.05)).toBeCloseTo(1.15, 12);
    expect(Number.isNaN(quantileSorted(f64([]), 0.5))).toBe(true);
  });
  it('quickselect finds the k-th smallest', () => {
    const vals = Array.from({ length: 1001 }, (_, i) => (i * 7919) % 1001);
    for (const k of [0, 1, 500, 999, 1000]) {
      expect(quickselect(f64(vals), k)).toBe(k);
    }
    const dup = f64([3, 3, 3, 1, 1, 2, 2, 2, 2]);
    expect(quickselect(dup, 4)).toBe(2);
  });
});

describe('computeStats', () => {
  it('computes descriptive stats and slope', () => {
    const x = f64([0, 1, 2, 3, 4]);
    const y = f64([1, 3, 5, 7, 9]);
    const s = computeStats(x, y);
    expect(s.count).toBe(5);
    expect(s.last).toBe(9);
    expect(s.min).toBe(1);
    expect(s.max).toBe(9);
    expect(s.mean).toBe(5);
    expect(s.std).toBeCloseTo(Math.sqrt(8), 12);
    expect(s.median).toBe(5);
    expect(s.p5).toBeCloseTo(1.4, 12);
    expect(s.p95).toBeCloseTo(8.6, 12);
    expect(s.slope).toBeCloseTo(2, 12);
  });
  it('respects the x range and ignores NaN', () => {
    const x = f64([0, 1, 2, 3, 4, 5]);
    const y = f64([100, 2, NaN, 4, 6, -50]);
    const s = computeStats(x, y, 1, 4);
    expect(s.count).toBe(3);
    expect(s.min).toBe(2);
    expect(s.max).toBe(6);
    expect(s.last).toBe(6);
    expect(s.slope).toBeCloseTo(9 / 7, 12);
  });
  it('slope is stable for huge x offsets', () => {
    const x = f64([1.7e9, 1.7e9 + 1, 1.7e9 + 2]);
    const y = f64([0, 0.5, 1]);
    expect(computeStats(x, y).slope).toBeCloseTo(0.5, 9);
  });
  it('returns NaNs for empty input', () => {
    const s = computeStats(f64([]), f64([]));
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.mean)).toBe(true);
  });
});

describe('clippedRange', () => {
  it('returns min/max for pct=0', () => {
    expect(clippedRange([{ x: f64([0, 1, 2]), y: f64([3, -1, 2]) }], 0)).toEqual([-1, 3]);
  });
  it('drops outliers', () => {
    const y = Array.from({ length: 100 }, (_, i) => i);
    y[50] = 1e9;
    const x = y.map((_, i) => i);
    const r = clippedRange([{ x: f64(x), y: f64(y) }], 2)!;
    expect(r[1]).toBeLessThan(1000);
    expect(r[0]).toBeGreaterThanOrEqual(1);
  });
  it('honours the x window', () => {
    const r = clippedRange([{ x: f64([0, 1, 2, 3]), y: f64([10, 1, 2, 30]) }], 0, 1, 2);
    expect(r).toEqual([1, 2]);
  });
  it('returns null without data', () => {
    expect(clippedRange([{ x: f64([0]), y: f64([NaN]) }], 5)).toBeNull();
  });
});

describe('alignRuns', () => {
  it('outer-joins runs with undefined for missing and null for NaN', () => {
    const r = alignRuns([f64([0, 2, 4]), f64([1, 2, 3])], [[f64([10, NaN, 14])], [f64([21, 22, 23])]]);
    expect(Array.from(r.x)).toEqual([0, 1, 2, 3, 4]);
    expect(r.ys[0]).toEqual([10, undefined, null, undefined, 14]);
    expect(r.ys[1]).toEqual([undefined, 21, 22, 23, undefined]);
  });
  it('single run fast path', () => {
    const r = alignRuns([f64([0, 1])], [[f64([1, NaN]), f64([2, 3])]]);
    expect(Array.from(r.x)).toEqual([0, 1]);
    expect(r.ys).toEqual([
      [1, null],
      [2, 3],
    ]);
  });
});

describe('binary search', () => {
  const a = f64([1, 3, 3, 5]);
  it('lowerIndex / upperIndex', () => {
    expect(lowerIndex(a, 3)).toBe(1);
    expect(upperIndex(a, 3)).toBe(2);
    expect(lowerIndex(a, 6)).toBe(4);
    expect(upperIndex(a, 0)).toBe(-1);
  });
});

describe('alignRuns absent columns', () => {
  it('fills absent columns with undefined', () => {
    const r = alignRuns([f64([0, 1]), f64([1])], [[f64([1, 2]), null], [f64([3]), null]]);
    expect(r.ys[1]).toEqual([undefined, undefined]);
    expect(r.ys[2]).toEqual([undefined, 3]);
    const s = alignRuns([f64([0, 1])], [[null]]);
    expect(s.ys[0].length).toBe(2);
    expect(s.ys[0][0]).toBeUndefined();
  });
});
