//! Min/max/mean bucket downsampling over in-memory columns + JSON emission.

use super::cache::{BLOCK, SeriesCol};

pub struct Sampled {
    /// Number of points inside the requested window.
    pub total: usize,
    pub downsampled: bool,
    pub step: Vec<i64>,
    pub value: Vec<f64>,
    pub min: Vec<f64>,
    pub max: Vec<f64>,
    pub ts: Vec<f64>,
}

/// Branch-light aggregation of one bucket; non-finite values are excluded.
/// Written as 8 independent f64 lanes with selects so LLVM emits packed SIMD.
#[inline]
pub(crate) fn agg(v: &[f64]) -> (f64, u32, f64, f64) {
    // Fast path (all finite): plain sum/min/max vectorizes ~8x better than the masked
    // version. Any NaN/±Inf makes the sum non-finite, so we then redo it masked.
    let fast = agg_unmasked(v);
    if fast.0.is_finite() {
        return fast;
    }
    agg_masked(v)
}

#[inline]
fn agg_unmasked(v: &[f64]) -> (f64, u32, f64, f64) {
    const L: usize = 8;
    let mut sum = [0.0f64; L];
    let mut mn = [f64::INFINITY; L];
    let mut mx = [f64::NEG_INFINITY; L];
    let chunks = v.chunks_exact(L);
    let rem = chunks.remainder();
    for c in chunks {
        for k in 0..L {
            let x = c[k];
            sum[k] += x;
            mn[k] = if x < mn[k] { x } else { mn[k] };
            mx[k] = if x > mx[k] { x } else { mx[k] };
        }
    }
    for (k, &x) in rem.iter().enumerate() {
        sum[k] += x;
        mn[k] = if x < mn[k] { x } else { mn[k] };
        mx[k] = if x > mx[k] { x } else { mx[k] };
    }
    let mut s = 0.0;
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for k in 0..L {
        s += sum[k];
        lo = if mn[k] < lo { mn[k] } else { lo };
        hi = if mx[k] > hi { mx[k] } else { hi };
    }
    (s, v.len() as u32, lo, hi)
}

#[cold]
fn agg_masked(v: &[f64]) -> (f64, u32, f64, f64) {
    const L: usize = 8;
    let mut sum = [0.0f64; L];
    let mut cnt = [0.0f64; L];
    let mut mn = [f64::INFINITY; L];
    let mut mx = [f64::NEG_INFINITY; L];
    #[inline(always)]
    fn lane(x: f64, sum: &mut f64, cnt: &mut f64, mn: &mut f64, mx: &mut f64) {
        let f = x.abs() < f64::INFINITY; // false for NaN and ±Inf
        let xs = if f { x } else { 0.0 };
        let xl = if f { x } else { f64::INFINITY };
        let xh = if f { x } else { f64::NEG_INFINITY };
        *sum += xs;
        *cnt += if f { 1.0 } else { 0.0 };
        *mn = if xl < *mn { xl } else { *mn };
        *mx = if xh > *mx { xh } else { *mx };
    }
    let chunks = v.chunks_exact(L);
    let rem = chunks.remainder();
    for c in chunks {
        for k in 0..L {
            lane(c[k], &mut sum[k], &mut cnt[k], &mut mn[k], &mut mx[k]);
        }
    }
    for (k, &x) in rem.iter().enumerate() {
        lane(x, &mut sum[k], &mut cnt[k], &mut mn[k], &mut mx[k]);
    }
    let mut s = 0.0;
    let mut n = 0.0;
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for k in 0..L {
        s += sum[k];
        n += cnt[k];
        lo = if mn[k] < lo { mn[k] } else { lo };
        hi = if mx[k] > hi { mx[k] } else { hi };
    }
    (s, n as u32, lo, hi)
}

#[inline]
fn combine(a: (f64, u32, f64, f64), b: (f64, u32, f64, f64)) -> (f64, u32, f64, f64) {
    (a.0 + b.0, a.1 + b.1, if b.2 < a.2 { b.2 } else { a.2 }, if b.3 > a.3 { b.3 } else { a.3 })
}

/// Aggregate of points [i, end): raw head/tail, pre-aggregated full blocks in between.
#[inline]
fn range_agg(col: &SeriesCol, i: usize, end: usize, use_blocks: bool) -> (f64, u32, f64, f64) {
    if !use_blocks || end - i < 2 * BLOCK {
        return agg(&col.values[i..end]);
    }
    let fb = i.div_ceil(BLOCK);
    let lb = end / BLOCK;
    let mut acc = agg(&col.values[i..fb * BLOCK]);
    let (mut s, mut c) = (0.0, 0.0);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for b in &col.blocks[fb..lb] {
        s += b.sum;
        c += b.cnt;
        lo = if b.min < lo { b.min } else { lo };
        hi = if b.max > hi { b.max } else { hi };
    }
    acc = combine(acc, (s, c as u32, lo, hi));
    combine(acc, agg(&col.values[lb * BLOCK..end]))
}

/// First index in `steps[from..]` (as an absolute index, ≤ `to`) with step ≥ `bound`.
/// Exponential search from `from`: touches only memory next to the bucket being scanned.
#[inline]
fn gallop(steps: &[i64], from: usize, to: usize, bound: i64) -> usize {
    let mut lo = from;
    let mut step = 1usize;
    let mut hi = from + 1;
    while hi < to && steps[hi] < bound {
        lo = hi;
        step <<= 1;
        hi = from + step;
    }
    let hi = hi.min(to);
    lo + steps[lo..hi].partition_point(|&s| s < bound)
}

pub fn sample(col: &SeriesCol, step_min: Option<i64>, step_max: Option<i64>, max_points: usize) -> Sampled {
    let steps = &col.steps[..];
    let a = match step_min {
        Some(m) => steps.partition_point(|&s| s < m),
        None => 0,
    };
    let b = match step_max {
        Some(m) => steps.partition_point(|&s| s <= m),
        None => steps.len(),
    };
    let b = b.max(a);
    let n = b - a;
    let max_points = max_points.max(1);
    if n <= max_points {
        return Sampled {
            total: n,
            downsampled: false,
            step: steps[a..b].to_vec(),
            value: col.values[a..b].to_vec(),
            min: Vec::new(),
            max: Vec::new(),
            ts: col.ts[a..b].to_vec(),
        };
    }
    let lo = steps[a] as i128;
    let span = steps[b - 1] as i128 - lo + 1;
    let nb = max_points as i128;
    let mut out = Sampled {
        total: n,
        downsampled: true,
        step: Vec::with_capacity(max_points),
        value: Vec::with_capacity(max_points),
        min: Vec::with_capacity(max_points),
        max: Vec::with_capacity(max_points),
        ts: Vec::with_capacity(max_points),
    };
    let use_blocks = col.blocks_valid();
    let ts = &col.ts[..];
    let mut i = a;
    for k in 0..nb {
        if i >= b {
            break;
        }
        let end = if k == nb - 1 {
            b
        } else {
            let bound = (lo + (k + 1) * span / nb) as i64;
            if steps[i] >= bound {
                continue; // empty bucket
            }
            gallop(steps, i, b, bound)
        };
        if end == i {
            continue;
        }
        let (s, c, mn, mx) = range_agg(col, i, end, use_blocks);
        out.step.push(steps[i]);
        if c == 0 {
            out.value.push(f64::NAN);
            out.min.push(f64::NAN);
            out.max.push(f64::NAN);
        } else {
            out.value.push(s / c as f64);
            out.min.push(mn);
            out.max.push(mx);
        }
        out.ts.push(ts[end - 1]);
        i = end;
    }
    out
}

// ---- JSON helpers -------------------------------------------------------------

pub fn push_json_str(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for &c in s.as_bytes() {
        match c {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            0..=0x1f => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                out.extend_from_slice(b"\\u00");
                out.push(HEX[(c >> 4) as usize]);
                out.push(HEX[(c & 15) as usize]);
            }
            _ => out.push(c),
        }
    }
    out.push(b'"');
}

pub fn push_f64(out: &mut Vec<u8>, v: f64, buf: &mut ryu::Buffer) {
    if v.is_finite() {
        out.extend_from_slice(buf.format_finite(v).as_bytes());
    } else {
        out.extend_from_slice(b"null");
    }
}

pub fn push_f64_arr(out: &mut Vec<u8>, vals: &[f64]) {
    let mut buf = ryu::Buffer::new();
    out.push(b'[');
    for (i, &v) in vals.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        push_f64(out, v, &mut buf);
    }
    out.push(b']');
}

pub fn push_i64_arr(out: &mut Vec<u8>, vals: &[i64]) {
    let mut buf = itoa::Buffer::new();
    out.push(b'[');
    for (i, &v) in vals.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(buf.format(v).as_bytes());
    }
    out.push(b']');
}

/// One element of the `series` array of `/series/query`.
pub fn write_series_json(out: &mut Vec<u8>, exp_id: i64, key: &str, s: &Sampled) {
    out.reserve(s.step.len() * (if s.downsampled { 60 } else { 36 }) + 128);
    out.extend_from_slice(b"{\"experiment_id\":");
    out.extend_from_slice(itoa::Buffer::new().format(exp_id).as_bytes());
    out.extend_from_slice(b",\"key\":");
    push_json_str(out, key);
    out.extend_from_slice(b",\"total\":");
    out.extend_from_slice(itoa::Buffer::new().format(s.total).as_bytes());
    out.extend_from_slice(if s.downsampled { b",\"downsampled\":true" } else { b",\"downsampled\":false" });
    out.extend_from_slice(b",\"step\":");
    push_i64_arr(out, &s.step);
    out.extend_from_slice(b",\"value\":");
    push_f64_arr(out, &s.value);
    if s.downsampled {
        out.extend_from_slice(b",\"min\":");
        push_f64_arr(out, &s.min);
        out.extend_from_slice(b",\"max\":");
        push_f64_arr(out, &s.max);
    }
    out.extend_from_slice(b",\"ts\":");
    push_f64_arr(out, &s.ts);
    out.push(b'}');
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spikes_survive() {
        let n = 100_000;
        let mut c = SeriesCol::with_capacity(n);
        for i in 0..n {
            c.steps.push(i as i64);
            c.values.push(if i == 54_321 { 1000.0 } else if i == 7777 { -50.0 } else { 1.0 });
            c.ts.push(i as f64);
        }
        c.values[10] = f64::NAN;
        c.rebuild_blocks(0);
        let raw = { let mut r = c.clone(); r.blocks.clear(); r };
        let (a, b) = (sample(&c, Some(3), None, 77), sample(&raw, Some(3), None, 77));
        assert_eq!(a.value, b.value);
        assert_eq!(a.min, b.min);
        assert_eq!(a.max, b.max);
        let s = sample(&c, None, None, 100);
        assert!(s.downsampled);
        assert_eq!(s.step.len(), 100);
        assert_eq!(s.step[0], 0);
        assert!(s.max.iter().any(|&m| m == 1000.0));
        assert!(s.min.iter().any(|&m| m == -50.0));
        assert!(s.value.iter().all(|v| v.is_finite()));
        let s2 = sample(&c, Some(54_000), Some(54_999), 2000);
        assert!(!s2.downsampled);
        assert_eq!(s2.total, 1000);
    }
}

#[cfg(test)]
mod perf {
    use super::*;
    #[test]
    #[ignore]
    fn perf_sample_1m() {
        let n = 1_000_000;
        let mut c = SeriesCol::with_capacity(n);
        for i in 0..n {
            c.steps.push(i as i64);
            c.values.push((i as f64).sin());
            c.ts.push(i as f64);
        }
        c.rebuild_blocks(0);
        for _ in 0..3 {
            let t = std::time::Instant::now();
            let s = sample(&c, None, None, 2000);
            let t1 = t.elapsed();
            let mut out = Vec::new();
            write_series_json(&mut out, 1, "k", &s);
            println!("sample {:?} json {:?} ({} bytes)", t1, t.elapsed() - t1, out.len());
        }
        let mut best = std::time::Duration::MAX;
        let mut tot = 0.0;
        for _ in 0..30 {
            let t = std::time::Instant::now();
            for ch in c.values.chunks(500) {
                tot += agg(ch).0;
            }
            best = best.min(t.elapsed());
        }
        println!("agg only best {:?} {tot}", best);
        let mut best = std::time::Duration::MAX;
        for _ in 0..30 {
            let t = std::time::Instant::now();
            std::hint::black_box(sample(&c, None, None, 2000));
            best = best.min(t.elapsed());
        }
        println!("sample best {:?}", best);
    }
}
