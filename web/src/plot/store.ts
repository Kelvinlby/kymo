// Series data cache + request batcher. Every panel asks the store for series; requests made in the
// same animation frame are merged into one POST /series/query per distinct (window, max_points).
import { api, type SeriesRef, type SeriesResult } from '../api';

export interface StepWindow {
  min: number;
  max: number;
}

export interface SeriesData {
  experimentId: number;
  key: string;
  step: Float64Array;
  value: Float64Array; // NaN for null
  min: Float64Array | null;
  max: Float64Array | null;
  ts: Float64Array;
  total: number;
  downsampled: boolean;
  window: StepWindow | null;
  version: number;
}

export const sid = (experimentId: number, key: string) => experimentId + '\u0000' + key;
const winKey = (w: StepWindow | null, mp: number) => (w ? `${w.min}:${w.max}` : '*') + '@' + mp;
const cacheKey = (s: string, w: StepWindow | null, mp: number) => s + '\u0001' + winKey(w, mp);

function toF64(a: (number | null)[] | undefined): Float64Array {
  const n = a ? a.length : 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = a![i];
    out[i] = v == null ? NaN : v;
  }
  return out;
}

interface Pending {
  window: StepWindow | null;
  maxPoints: number;
  items: Map<string, { ref: SeriesRef; version: number; resolve: (d: SeriesData) => void; reject: (e: unknown) => void }[]>;
}

const MAX_SERIES_PER_REQUEST = 256;
const CACHE_POINT_BUDGET = 6_000_000;

export class SeriesStore {
  private cache = new Map<string, SeriesData>(); // LRU (Map insertion order)
  private cachedPoints = 0;
  private inflight = new Map<string, Promise<SeriesData>>();
  private pending = new Map<string, Pending>();
  private scheduled = false;
  private versions = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  /** per experiment: ts of the first point seen in an unwindowed fetch (for relative time). */
  private startTs = new Map<number, number>();
  /** last_step per series as last reported by the metrics endpoint (live mode). */
  readonly knownLastStep = new Map<string, number>();
  stats = { requests: 0, series: 0, lastMs: 0 };

  version(s: string) {
    return this.versions.get(s) || 0;
  }

  runStartTs(experimentId: number): number | undefined {
    return this.startTs.get(experimentId);
  }

  /** Cached entry (possibly stale). `fresh` tells whether it matches the current series version. */
  peek(ref: SeriesRef, w: StepWindow | null, maxPoints: number): { data: SeriesData; fresh: boolean } | undefined {
    const s = sid(ref.experiment_id, ref.key);
    const k = cacheKey(s, w, maxPoints);
    const d = this.cache.get(k);
    if (!d) return undefined;
    // touch for LRU
    this.cache.delete(k);
    this.cache.set(k, d);
    return { data: d, fresh: d.version === this.version(s) };
  }

  /** Fetch (batched) – resolves with fresh data. */
  get(ref: SeriesRef, w: StepWindow | null, maxPoints: number): Promise<SeriesData> {
    const s = sid(ref.experiment_id, ref.key);
    const k = cacheKey(s, w, maxPoints);
    const ver = this.version(s);
    const c = this.cache.get(k);
    if (c && c.version === ver) return Promise.resolve(c);
    const inf = this.inflight.get(k);
    if (inf) return inf;
    const p = new Promise<SeriesData>((resolve, reject) => {
      const wk = winKey(w, maxPoints);
      let g = this.pending.get(wk);
      if (!g) this.pending.set(wk, (g = { window: w, maxPoints, items: new Map() }));
      let arr = g.items.get(s);
      if (!arr) g.items.set(s, (arr = []));
      arr.push({ ref, version: ver, resolve, reject });
      this.schedule();
    });
    this.inflight.set(k, p);
    const clear = () => {
      if (this.inflight.get(k) === p) this.inflight.delete(k);
    };
    p.then(clear, clear);
    return p;
  }

  getMany(refs: SeriesRef[], w: StepWindow | null, maxPoints: number) {
    return Promise.all(refs.map((r) => this.get(r, w, maxPoints)));
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    // one flush per frame; the timeout covers throttled/hidden documents where rAF stalls
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      this.scheduled = false;
      this.flush();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    setTimeout(run, 32);
  }

  private flush() {
    const groups = [...this.pending.values()];
    this.pending.clear();
    for (const g of groups) {
      const entries = [...g.items.entries()];
      for (let i = 0; i < entries.length; i += MAX_SERIES_PER_REQUEST) this.send(g, entries.slice(i, i + MAX_SERIES_PER_REQUEST));
    }
  }

  private async send(g: Pending, entries: [string, Pending['items'] extends Map<string, infer V> ? V : never][]) {
    const refs = entries.map(([, a]) => a[0].ref);
    const t0 = performance.now();
    this.stats.requests++;
    this.stats.series += refs.length;
    try {
      const res = await api.query({
        series: refs.map((r) => ({ experiment_id: r.experiment_id, key: r.key })),
        max_points: g.maxPoints,
        step_min: g.window ? g.window.min : null,
        step_max: g.window ? g.window.max : null,
      });
      this.stats.lastMs = performance.now() - t0;
      const byId = new Map<string, SeriesResult>();
      for (const r of res.series) byId.set(sid(r.experiment_id, r.key), r);
      for (const [s, waiters] of entries) {
        const r = byId.get(s);
        const ref = waiters[0].ref;
        const d = this.ingest(ref, r, g.window, g.maxPoints, waiters[0].version);
        for (const w of waiters) w.resolve(d);
      }
    } catch (e) {
      for (const [, waiters] of entries) for (const w of waiters) w.reject(e);
    }
  }

  private ingest(ref: SeriesRef, r: SeriesResult | undefined, w: StepWindow | null, mp: number, version: number): SeriesData {
    const d: SeriesData = {
      experimentId: ref.experiment_id,
      key: ref.key,
      step: toF64(r?.step),
      value: toF64(r?.value),
      min: r?.downsampled && r.min ? toF64(r.min) : null,
      max: r?.downsampled && r.max ? toF64(r.max) : null,
      ts: toF64(r?.ts),
      total: r?.total ?? 0,
      downsampled: !!r?.downsampled,
      window: w,
      version,
    };
    if (!w && d.ts.length) {
      const prev = this.startTs.get(ref.experiment_id);
      const t = d.ts[0];
      if (prev === undefined || t < prev) this.startTs.set(ref.experiment_id, t);
    }
    const s = sid(ref.experiment_id, ref.key);
    const k = cacheKey(s, w, mp);
    const old = this.cache.get(k);
    if (old) {
      this.cachedPoints -= old.step.length;
      this.cache.delete(k);
    }
    this.cache.set(k, d);
    this.cachedPoints += d.step.length;
    this.evict();
    return d;
  }

  private evict() {
    if (this.cachedPoints <= CACHE_POINT_BUDGET) return;
    for (const [k, d] of this.cache) {
      if (this.cachedPoints <= CACHE_POINT_BUDGET * 0.8) break;
      this.cache.delete(k);
      this.cachedPoints -= d.step.length;
    }
  }

  /** Mark a series as changed (new points). Listeners (panels) decide whether to refetch now. */
  invalidate(experimentId: number, key: string) {
    const s = sid(experimentId, key);
    this.versions.set(s, this.version(s) + 1);
    const ls = this.listeners.get(s);
    if (ls) for (const fn of ls) fn();
  }

  subscribe(ids: string[], fn: () => void): () => void {
    for (const s of ids) {
      let set = this.listeners.get(s);
      if (!set) this.listeners.set(s, (set = new Set()));
      set.add(fn);
    }
    return () => {
      for (const s of ids) this.listeners.get(s)?.delete(fn);
    };
  }
}
