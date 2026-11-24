// Pure numeric helpers over Float64Array. NaN means "missing / non-finite".
// No DOM access: used both on the main thread and inside the stats Web Worker.

/**
 * Exponential moving average with zero-bias correction (debiased EMA).
 * weight in [0, 1): 0 = no smoothing. Non-finite inputs produce NaN and do not advance the EMA.
 * last = last*w + (1-w)*v ; out = last / (1 - w^n)  where n counts finite points seen so far.
 */
export function emaDebiased(values: ArrayLike<number>, weight: number, out?: Float64Array): Float64Array {
  const n = values.length;
  const res = out && out.length === n ? out : new Float64Array(n);
  const w = Math.min(Math.max(weight, 0), 0.9999);
  if (w === 0) {
    for (let i = 0; i < n; i++) {
      const v = values[i];
      res[i] = Number.isFinite(v) ? v : NaN;
    }
    return res;
  }
  let last = 0;
  let wPow = 1; // w^count
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      res[i] = NaN;
      continue;
    }
    last = last * w + (1 - w) * v;
    wPow *= w;
    res[i] = last / (1 - wPow);
  }
  return res;
}

/** In-place quickselect (Floyd-Rivest-free Hoare variant): after the call a[k] is the k-th smallest of a[lo..hi]. */
export function quickselect(a: Float64Array, k: number, lo = 0, hi = a.length - 1): number {
  while (hi > lo) {
    // median of three pivot
    const mid = (lo + hi) >>> 1;
    if (a[mid] < a[lo]) swap(a, mid, lo);
    if (a[hi] < a[lo]) swap(a, hi, lo);
    if (a[hi] < a[mid]) swap(a, hi, mid);
    const pivot = a[mid];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        swap(a, i, j);
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

function swap(a: Float64Array, i: number, j: number) {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/** Linear-interpolated quantile (q in [0,1]) of an ascending-sorted array (numpy 'linear' method). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < n ? sorted[i] + f * (sorted[i + 1] - sorted[i]) : sorted[i];
}

/** Copy the finite values of `y` (optionally restricted to lo <= x <= hi) into a new compact array. */
export function finiteInRange(x: ArrayLike<number> | null, y: ArrayLike<number>, lo = -Infinity, hi = Infinity): Float64Array {
  const n = y.length;
  const tmp = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    if (!Number.isFinite(v)) continue;
    if (x) {
      const xi = x[i];
      if (xi < lo || xi > hi) continue;
    }
    tmp[m++] = v;
  }
  return tmp.subarray(0, m);
}

export interface Stats {
  count: number;
  last: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  median: number;
  p5: number;
  p95: number;
  /** least-squares slope of value vs x (per x unit) */
  slope: number;
}

export const EMPTY_STATS: Stats = { count: 0, last: NaN, min: NaN, max: NaN, mean: NaN, std: NaN, median: NaN, p5: NaN, p95: NaN, slope: NaN };

/**
 * Descriptive stats of the finite points with lo <= x <= hi. std is the population std (ddof=0).
 * `last` is the value at the greatest x within range.
 */
export function computeStats(x: ArrayLike<number>, y: ArrayLike<number>, lo = -Infinity, hi = Infinity): Stats {
  const n = Math.min(x.length, y.length);
  let count = 0, sum = 0, min = Infinity, max = -Infinity, last = NaN;
  let sx = 0, sxx = 0, sxy = 0;
  // shift x for numerical stability of the regression
  let x0 = NaN;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    const xi = x[i];
    if (!Number.isFinite(v) || !(xi >= lo && xi <= hi)) continue;
    if (x0 !== x0) x0 = xi;
    const dx = xi - x0;
    count++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    last = v;
    sx += dx;
    sxx += dx * dx;
    sxy += dx * v;
  }
  if (count === 0) return { ...EMPTY_STATS };
  const mean = sum / count;
  // second pass for a stable variance
  let ss = 0;
  const vals = new Float64Array(count);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i];
    const xi = x[i];
    if (!Number.isFinite(v) || !(xi >= lo && xi <= hi)) continue;
    const d = v - mean;
    ss += d * d;
    vals[m++] = v;
  }
  const std = Math.sqrt(ss / count);
  vals.sort();
  const denom = count * sxx - sx * sx;
  const slope = count > 1 && denom !== 0 ? (count * sxy - sx * sum) / denom : NaN;
  return {
    count,
    last,
    min,
    max,
    mean,
    std,
    median: quantileSorted(vals, 0.5),
    p5: quantileSorted(vals, 0.05),
    p95: quantileSorted(vals, 0.95),
    slope,
  };
}

/** Least-squares slope (per x unit) of the finite points. */
export function slope(x: ArrayLike<number>, y: ArrayLike<number>): number {
  return computeStats(x, y).slope;
}

/**
 * y-range that ignores the bottom and top `pct` percent of the finite values across several arrays
 * restricted to lo <= x <= hi (each array paired with its own x). Returns null if there are no values.
 * pct = 0 gives the plain min/max.
 */
export function clippedRange(
  pairs: { x: ArrayLike<number>; y: ArrayLike<number> }[],
  pct: number,
  lo = -Infinity,
  hi = Infinity,
): [number, number] | null {
  let total = 0;
  for (const p of pairs) total += p.y.length;
  const buf = new Float64Array(total);
  let m = 0;
  for (const p of pairs) {
    const { x, y } = p;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      if (!Number.isFinite(v)) continue;
      const xi = x[i];
      if (xi < lo || xi > hi) continue;
      buf[m++] = v;
    }
  }
  if (m === 0) return null;
  const a = buf.subarray(0, m);
  if (!(pct > 0)) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < m; i++) {
      const v = a[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return [mn, mx];
  }
  const p = Math.min(pct, 49.9) / 100;
  const kLo = Math.floor(p * (m - 1));
  const kHi = Math.ceil((1 - p) * (m - 1));
  const vLo = quickselect(a, kLo);
  const vHi = quickselect(a, kHi, kLo, m - 1);
  return [vLo, vHi];
}

/**
 * Outer-join several runs that each have their own ascending x array onto a single x axis.
 * `cols[r]` lists the y arrays of run r (all the length of xs[r]; null = absent, all undefined). Output y arrays contain
 * `undefined` where the run has no point at that x (uPlot connects across those) and `null`
 * where the run's value is NaN (uPlot draws a gap).
 */
export function alignRuns(
  xs: ArrayLike<number>[],
  cols: (ArrayLike<number> | null)[][],
): { x: Float64Array; ys: (number | null | undefined)[][] } {
  const R = xs.length;
  if (R === 1) {
    const x = Float64Array.from(xs[0] as ArrayLike<number>);
    return { x, ys: cols[0].map((c) => (c ? toUplotArray(c) : new Array<undefined>(x.length))) };
  }
  let total = 0;
  for (const a of xs) total += a.length;
  const all = new Float64Array(total);
  let o = 0;
  for (const a of xs) {
    all.set(a as ArrayLike<number>, o);
    o += a.length;
  }
  all.sort();
  let u = 0;
  for (let i = 0; i < total; i++) {
    const v = all[i];
    if (v !== v) continue;
    if (u === 0 || all[u - 1] !== v) all[u++] = v;
  }
  const x = all.slice(0, u);
  const ys: (number | null | undefined)[][] = [];
  for (let r = 0; r < R; r++) {
    const xr = xs[r];
    const outs = cols[r].map(() => new Array<number | null | undefined>(u));
    let j = 0;
    for (let i = 0; i < u; i++) {
      const xv = x[i];
      while (j < xr.length && xr[j] < xv) j++;
      if (j < xr.length && xr[j] === xv) {
        for (let c = 0; c < outs.length; c++) {
          const col = cols[r][c];
          if (!col) continue;
          const v = col[j];
          outs[c][i] = Number.isFinite(v) ? v : null;
        }
      }
      // else stays undefined (array holes read as undefined)
    }
    for (const a of outs) ys.push(a);
  }
  return { x, ys };
}

function toUplotArray(c: ArrayLike<number>): (number | null)[] {
  const out = new Array<number | null>(c.length);
  for (let i = 0; i < c.length; i++) {
    const v = c[i];
    out[i] = Number.isFinite(v) ? v : null;
  }
  return out;
}

/** Index of the last element <= v in an ascending array (or -1). */
export function upperIndex(a: ArrayLike<number>, v: number): number {
  let lo = 0, hi = a.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Index of the first element >= v in an ascending array (or a.length). */
export function lowerIndex(a: ArrayLike<number>, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
