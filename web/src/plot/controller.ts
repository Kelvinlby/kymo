// Imperative owner of one panel's uPlot instance. Preact only renders the panel chrome; the
// chart is created when the panel scrolls into view, destroyed when it leaves, and updated
// with setData() on data/smoothing changes (never re-created for data updates).
import uPlot from 'uplot';
import { alignRuns, clippedRange, emaDebiased, lowerIndex, upperIndex, type Stats } from '../lib/stats';
import { fmtDuration, fmtInt, fmtNum, fmtSI } from '../lib/format';
import { onThemeChange } from '../lib/theme';
import { cssVar, withAlpha } from './colors';
import { sid, type SeriesData, type SeriesStore, type StepWindow } from './store';
import { statsFor } from './statsClient';
import type { PanelOverrides, PlotSettings, RunInfo, XMode } from './types';

export interface PanelUiState {
  loading: boolean;
  zoomed: boolean;
  statsRange: [number, number] | null;
  empty: boolean;
  downsampled: boolean;
  error: string | null;
  pointCount: number;
}

interface Prepared {
  run: RunInfo;
  d: SeriesData;
  x: Float64Array; // x in current mode
  y: Float64Array; // raw values (NaN = missing), log-sanitised
  main: Float64Array; // smoothed (or raw) values
  min: Float64Array | null;
  max: Float64Array | null;
}

const SERIES_PER_RUN = 4; // main, raw (faint), max, min

// shift state for shift-drag (stats range); tracked globally because synthetic/relayed
// mouse events do not always carry modifier flags
let shiftHeld = false;
if (typeof window !== 'undefined') {
  const upd = (e: KeyboardEvent | MouseEvent) => (shiftHeld = e.shiftKey);
  window.addEventListener('keydown', upd, true);
  window.addEventListener('keyup', upd, true);
  window.addEventListener('mousedown', upd, true);
  window.addEventListener('blur', () => (shiftHeld = false));
}

// Theme tokens are read from CSS variables once per theme change; axes/grid/cursor use functions that
// read them at draw time, so a theme switch only redraws charts (no re-creation, no refetch).
interface PlotTheme {
  axis: string;
  grid: string;
  tick: string;
  surface: string;
  text: string;
  font: string;
  mono: string;
}
const readTheme = (): PlotTheme => ({
  axis: cssVar('--plot-axis', '#777'),
  grid: cssVar('--plot-grid', 'rgba(0,0,0,.07)'),
  tick: cssVar('--plot-tick', 'rgba(0,0,0,.14)'),
  surface: cssVar('--surface', '#fff'),
  text: cssVar('--text', '#000'),
  font: cssVar('--font', 'sans-serif'),
  mono: cssVar('--mono', 'monospace'),
});
let T: PlotTheme | null = null;
const theme = () => (T ??= readTheme());
const livePlots = new Set<uPlot>();
if (typeof window !== 'undefined') {
  onThemeChange(() => {
    T = readTheme();
    for (const u of livePlots) u.redraw(false);
  });
}

let tipEl: HTMLDivElement | null = null;
function tooltipEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'plot-tip';
    tipEl.style.position = 'fixed';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function fmtX(v: number, mode: XMode): string {
  if (!Number.isFinite(v)) return '—';
  if (mode === 'step') return fmtInt(v);
  if (mode === 'rel') return fmtDuration(v);
  return new Date(v * 1000).toLocaleString();
}

export class PanelController {
  private u: uPlot | null = null;
  private visible = false;
  private destroyed = false;
  private runs: RunInfo[] = [];
  private runsKey = '';
  private settings: PlotSettings;
  private ov: PanelOverrides = { smoothing: null, logY: null };
  private structKey = '';
  private zoomX: [number, number] | null = null;
  private zoomSteps: StepWindow | null = null;
  private statsRange: [number, number] | null = null;
  private data = new Map<number, SeriesData>();
  private prepared: Prepared[] = [];
  private aligned: uPlot.AlignedData | null = null;
  private unsub: (() => void) | null = null;
  private seq = 0;
  private hovered = false;
  private shiftDrag = false;
  private refreshQueued = false;
  private statsBand: HTMLDivElement | null = null;
  private ui: PanelUiState = { loading: false, zoomed: false, statsRange: null, empty: false, downsampled: false, error: null, pointCount: 0 };
  statsWanted = false;
  /** short title shown in the tooltip header */
  label = '';
  onStats: ((s: Stats[], runs: RunInfo[], downsampled: boolean[]) => void) | null = null;

  constructor(
    private host: HTMLElement,
    private store: SeriesStore,
    readonly key: string,
    private syncKey: string,
    settings: PlotSettings,
    private onUi: (s: PanelUiState) => void,
  ) {
    this.settings = settings;
    (host as unknown as { __kymoPanel: PanelController }).__kymoPanel = this; // debugging / e2e hooks
  }

  // ------------------------------------------------------------------ inputs
  get smoothing() {
    return this.ov.smoothing ?? this.settings.smoothing;
  }
  get logY() {
    return this.ov.logY ?? this.settings.logY;
  }
  private get maxPoints() {
    return this.zoomSteps ? Math.max(2000, this.settings.maxPoints) : this.settings.maxPoints;
  }

  setVisible(v: boolean) {
    if (this.visible === v || this.destroyed) return;
    this.visible = v;
    if (v) {
      this.ensurePlot();
      this.refresh();
    } else {
      this.destroyPlot();
    }
  }

  setRuns(runs: RunInfo[]) {
    const k = runs.map((r) => r.id + ':' + r.color + ':' + r.name).join('|');
    if (k === this.runsKey) return;
    this.runsKey = k;
    this.runs = runs;
    this.unsub?.();
    this.unsub = this.store.subscribe(
      runs.map((r) => sid(r.id, this.key)),
      () => this.queueRefresh(),
    );
    for (const id of [...this.data.keys()]) if (!runs.some((r) => r.id === id)) this.data.delete(id);
    this.recreate();
    this.refresh();
  }

  setSettings(s: PlotSettings, ov: PanelOverrides) {
    const prev = this.settings;
    const prevSmooth = this.smoothing;
    const prevLog = this.logY;
    this.settings = s;
    this.ov = ov;
    if (prev.xMode !== s.xMode && (this.zoomX || this.statsRange)) {
      // x units changed: drop zoom / stats selection (they are expressed in x units)
      this.zoomX = null;
      this.zoomSteps = null;
      this.statsRange = null;
      this.data.clear();
      this.setUi({ zoomed: false, statsRange: null });
      queueMicrotask(() => this.refresh());
    }
    const sk = this.structureKey();
    if (sk !== this.structKey) {
      this.recreate();
    } else if (prevSmooth !== this.smoothing || prevLog !== this.logY || prev.clipPct !== s.clipPct) {
      this.rebuild();
    }
    if (prev.maxPoints !== s.maxPoints) this.refresh();
  }

  private structureKey() {
    return [this.runsKey, this.logY ? 'log' : 'lin', this.settings.xMode].join('#');
  }

  destroy() {
    this.destroyed = true;
    this.unsub?.();
    this.destroyPlot();
  }

  // ------------------------------------------------------------------ data
  private queueRefresh() {
    if (!this.visible || this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  /** Show whatever is cached right away, then fetch what is missing or stale. */
  refresh() {
    if (!this.visible || this.destroyed) return;
    const w = this.zoomSteps;
    const mp = this.maxPoints;
    const refs = this.runs.map((r) => ({ experiment_id: r.id, key: this.key }));
    let changed = false;
    let allFresh = true;
    for (const ref of refs) {
      const c = this.store.peek(ref, w, mp);
      if (c) {
        if (this.data.get(ref.experiment_id) !== c.data) {
          this.data.set(ref.experiment_id, c.data);
          changed = true;
        }
        if (!c.fresh) allFresh = false;
      } else allFresh = false;
    }
    if (changed || !this.aligned) this.rebuild();
    if (allFresh) {
      this.setUi({ loading: false });
      return;
    }
    const seq = ++this.seq;
    this.setUi({ loading: true, error: null });
    this.store.getMany(refs, w, mp).then(
      (ds) => {
        if (seq !== this.seq || this.destroyed) return;
        for (const d of ds) this.data.set(d.experimentId, d);
        this.setUi({ loading: false });
        this.rebuild();
      },
      (e) => {
        if (seq !== this.seq || this.destroyed) return;
        this.setUi({ loading: false, error: (e as Error).message || String(e) });
      },
    );
  }

  private xOf(d: SeriesData, run: RunInfo): Float64Array {
    const mode = this.settings.xMode;
    if (mode === 'step') return d.step;
    if (mode === 'wall') return d.ts;
    const t0 = this.store.runStartTs(run.id) ?? run.startTs ?? (d.ts.length ? d.ts[0] : 0);
    const out = new Float64Array(d.ts.length);
    for (let i = 0; i < out.length; i++) out[i] = d.ts[i] - t0;
    return out;
  }

  /** Recompute derived arrays (x mode, smoothing, log) and push them into uPlot with setData. */
  private rebuild() {
    const log = this.logY;
    const w = this.smoothing;
    const prepared: Prepared[] = [];
    let downsampled = false;
    let points = 0;
    for (const run of this.runs) {
      const d = this.data.get(run.id);
      if (!d) continue;
      const x = this.xOf(d, run);
      let y = d.value;
      let mn = d.min;
      let mx = d.max;
      if (log) {
        y = positiveOnly(y);
        mn = mn && positiveOnly(mn);
        mx = mx && positiveOnly(mx);
      }
      const main = w > 0 ? emaDebiased(y, w) : y;
      prepared.push({ run, d, x, y, main, min: mn, max: mx });
      if (d.downsampled) downsampled = true;
      points += d.step.length;
    }
    this.prepared = prepared;
    // one slot per *selected* run so series indexes are stable even when some data is missing
    const xs: Float64Array[] = [];
    const cols: (Float64Array | null)[][] = [];
    for (const run of this.runs) {
      const p = prepared.find((q) => q.run === run);
      if (!p) {
        xs.push(new Float64Array(0));
        cols.push([null, null, null, null]);
      } else {
        xs.push(p.x);
        cols.push([p.main, w > 0 ? p.y : null, p.max, p.min]);
      }
    }
    if (this.runs.length === 0) {
      this.aligned = [new Float64Array(0)] as unknown as uPlot.AlignedData;
    } else {
      const a = alignRuns(xs, cols);
      this.aligned = [a.x, ...a.ys] as unknown as uPlot.AlignedData;
    }
    this.setUi({ empty: points === 0, downsampled, pointCount: points });
    if (this.u) {
      this.u.setData(this.aligned, true);
      this.positionStatsBand();
    } else this.ensurePlot();
    this.emitStats();
  }

  // ------------------------------------------------------------------ plot lifecycle
  private recreate() {
    const had = !!this.u;
    this.destroyPlot();
    this.structKey = this.structureKey();
    // rebuild() computes data matching the new series layout and creates the chart
    if (this.aligned || had) this.rebuild();
  }

  private ensurePlot() {
    if (!this.visible || this.u || this.destroyed) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width < 10 || height < 10) return;
    if (!this.aligned) return; // created once the first data (or cache) arrives
    this.structKey = this.structureKey();
    this.u = new uPlot(this.options(width, height), this.aligned, this.host);
    livePlots.add(this.u);
    this.statsBand = document.createElement('div');
    this.statsBand.className = 'stats-band';
    this.statsBand.style.display = 'none';
    this.u.over.appendChild(this.statsBand);
    this.u.over.addEventListener('mouseenter', () => (this.hovered = true));
    this.u.over.addEventListener('mouseleave', () => {
      this.hovered = false;
      tooltipEl().style.display = 'none';
    });
    this.positionStatsBand();
  }

  private destroyPlot() {
    if (this.u) {
      if (this.hovered) tooltipEl().style.display = 'none';
      this.hovered = false;
      livePlots.delete(this.u);
      this.u.destroy();
      this.u = null;
      this.statsBand = null;
    }
  }

  resize(w: number, h: number) {
    if (!this.u) {
      this.ensurePlot();
      return;
    }
    if (w < 10 || h < 10) return;
    if (w !== this.u.width || h !== this.u.height) this.u.setSize({ width: w, height: h });
  }

  private options(width: number, height: number): uPlot.Options {
    const axis = () => theme().axis;
    const grid = () => theme().grid;
    const tick = () => theme().tick;
    const font = `11px ${theme().font}`;
    const mode = this.settings.xMode;
    const log = this.logY;
    const series: uPlot.Series[] = [{}];
    const bands: uPlot.Band[] = [];
    this.runs.forEach((r, i) => {
      const base = 1 + i * SERIES_PER_RUN;
      series.push({ label: r.name, stroke: r.color, width: 1.6, spanGaps: false, points: { show: false } });
      series.push({ label: r.name + ' (raw)', stroke: withAlpha(r.color, 0.28), width: 1, points: { show: false } });
      series.push({ label: r.name + ' max', stroke: 'transparent', width: 0, points: { show: false } });
      series.push({ label: r.name + ' min', stroke: 'transparent', width: 0, points: { show: false } });
      bands.push({ series: [base + 2, base + 3], fill: withAlpha(r.color, 0.13) });
    });
    const isMain = (si: number) => si > 0 && (si - 1) % SERIES_PER_RUN === 0;
    const self = this;
    return {
      width,
      height,
      legend: { show: false },
      pxAlign: false,
      series,
      bands,
      scales: {
        x: {
          time: mode === 'wall',
          range: (_u, mn, mx) => self.xRange(mn, mx),
        },
        y: log
          ? { distr: 3, log: 10, range: (_u, mn, mx) => self.yRange(mn, mx) }
          : { range: (_u, mn, mx) => self.yRange(mn, mx) },
      },
      axes: [
        {
          stroke: axis,
          font,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: tick, width: 1, size: 4 },
          space: 70,
          gap: 6,
          ...(mode === 'step' ? { values: (_u: uPlot, vals: number[]) => vals.map((v) => fmtSI(v)) } : {}),
          ...(mode === 'rel' ? { values: (_u: uPlot, vals: number[]) => vals.map((v) => fmtDuration(v)) } : {}),
        },
        {
          stroke: axis,
          font,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          space: 30,
          gap: 6,
          values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtTick(v))),
          size: (_u, values) => {
            if (!values) return 40;
            let m = 0;
            for (const s of values) if (s && s.length > m) m = s.length;
            return Math.max(34, Math.ceil(m * 6.6) + 12);
          },
        },
      ],
      cursor: {
        sync: {
          key: this.syncKey,
          setSeries: false,
          scales: ['x', null],
          filters: { pub: (type) => type !== 'mousedown' && type !== 'mouseup' && type !== 'dblclick' },
        },
        drag: { x: true, y: false, setScale: false, dist: 4 },
        points: {
          size: (_u, si) => (isMain(si) ? 7 : 0),
          width: 2,
          fill: (_u, si) => (isMain(si) ? theme().surface : 'transparent'),
          stroke: (u, si) => (u.series[si].stroke as string) || 'transparent',
        },
        dataIdx: (u, si, closest) => nearestDefined(u.data[si] as unknown as ArrayLike<number | null | undefined>, closest),
        bind: {
          mousedown: (_u, _t, handler) => (e: MouseEvent) => {
            self.shiftDrag = e.shiftKey;
            self.host.parentElement?.classList.toggle('shift', e.shiftKey);
            return handler(e);
          },
          dblclick: () => (e: MouseEvent) => {
            e.preventDefault();
            self.resetZoom();
            return null;
          },
        },
      },
      hooks: {
        setSelect: [(u) => self.onSelect(u)],
        setCursor: [(u) => self.onCursor(u)],
        setSize: [() => self.positionStatsBand()],
        setScale: [(_u, k) => k === 'x' && self.positionStatsBand()],
      },
    };
  }

  // ------------------------------------------------------------------ scales
  private xRange(mn: number | null, mx: number | null): uPlot.Range.MinMax {
    if (this.zoomX) return [this.zoomX[0], this.zoomX[1]];
    if (mn == null || mx == null) return [0, 1];
    if (mn === mx) return [mn - 1, mx + 1];
    return [mn, mx];
  }

  private yRange(mn: number | null, mx: number | null): uPlot.Range.MinMax {
    const pct = this.settings.clipPct;
    if (pct > 0 && this.prepared.length) {
      const lo = this.zoomX ? this.zoomX[0] : -Infinity;
      const hi = this.zoomX ? this.zoomX[1] : Infinity;
      const pairs = this.prepared.map((p) => ({ x: p.x, y: this.smoothing > 0 ? p.main : p.y }));
      const r = clippedRange(pairs, pct, lo, hi);
      if (r) [mn, mx] = r;
    }
    if (mn == null || mx == null || !Number.isFinite(mn) || !Number.isFinite(mx)) return this.logY ? [1, 10] : [0, 1];
    if (this.logY) {
      if (mn <= 0) mn = Math.max(mx / 1e6, 1e-12);
      const r = uPlot.rangeLog(mn, mx, 10, true);
      return [r[0], r[1]];
    }
    let pad = (mx - mn) * 0.05;
    if (pad === 0) pad = Math.abs(mn) * 0.1 || 1;
    return [mn - pad, mx + pad];
  }

  // ------------------------------------------------------------------ interactions
  private onSelect(u: uPlot) {
    const sel = u.select;
    if (sel.width < 4) return;
    const x0 = u.posToVal(sel.left, 'x');
    const x1 = u.posToVal(sel.left + sel.width, 'x');
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    this.host.parentElement?.classList.remove('shift');
    if (this.shiftDrag || shiftHeld) this.setStatsRange([x0, x1]);
    else this.zoomTo(x0, x1);
  }

  /** Zoom to an x range: rescale instantly, then refetch the window at full resolution. */
  zoomTo(x0: number, x1: number) {
    if (!(x1 > x0)) return;
    this.zoomX = [x0, x1];
    this.zoomSteps = this.xToSteps(x0, x1);
    this.setUi({ zoomed: true });
    if (this.u) this.u.setScale('x', { min: x0, max: x1 });
    this.refresh();
  }

  resetZoom() {
    const had = this.zoomX || this.statsRange;
    this.zoomX = null;
    this.zoomSteps = null;
    this.statsRange = null;
    this.setUi({ zoomed: false, statsRange: null });
    if (had) {
      this.data.clear();
      this.refresh();
    }
  }

  setStatsRange(r: [number, number] | null) {
    this.statsRange = r;
    this.setUi({ statsRange: r });
    this.positionStatsBand();
    this.emitStats();
  }

  private xToSteps(x0: number, x1: number): StepWindow {
    if (this.settings.xMode === 'step') return { min: Math.floor(x0), max: Math.ceil(x1) };
    let smin = Infinity;
    let smax = -Infinity;
    for (const p of this.prepared) {
      if (!p.x.length) continue;
      const i0 = Math.max(0, lowerIndex(p.x, x0) - 1);
      const i1 = Math.min(p.x.length - 1, upperIndex(p.x, x1) + 1);
      if (i1 < i0) continue;
      smin = Math.min(smin, p.d.step[i0]);
      smax = Math.max(smax, p.d.step[i1]);
    }
    if (!Number.isFinite(smin)) return { min: 0, max: 0 };
    return { min: Math.floor(smin), max: Math.ceil(smax) };
  }

  private positionStatsBand() {
    const u = this.u;
    const b = this.statsBand;
    if (!u || !b) return;
    if (!this.statsRange) {
      b.style.display = 'none';
      return;
    }
    const l = u.valToPos(this.statsRange[0], 'x');
    const r = u.valToPos(this.statsRange[1], 'x');
    b.style.display = 'block';
    b.style.left = Math.max(0, l) + 'px';
    b.style.width = Math.max(0, Math.min(u.over.clientWidth, r) - Math.max(0, l)) + 'px';
  }

  private onCursor(u: uPlot) {
    const tip = tooltipEl();
    if (!this.hovered) return;
    const left = u.cursor.left ?? -1;
    if (left < 0 || !this.prepared.length) {
      tip.style.display = 'none';
      return;
    }
    const xv = u.posToVal(left, 'x');
    const mode = this.settings.xMode;
    const smooth = this.smoothing > 0;
    const rows: { name: string; color: string; v: number; raw: number; step: number }[] = [];
    let stepAt = NaN;
    for (const p of this.prepared) {
      const n = p.x.length;
      if (!n) continue;
      let i = lowerIndex(p.x, xv);
      if (i >= n) i = n - 1;
      else if (i > 0 && xv - p.x[i - 1] < p.x[i] - xv) i--;
      // ignore runs whose data does not reach the cursor
      const span = (u.scales.x.max ?? 1) - (u.scales.x.min ?? 0);
      if (Math.abs(p.x[i] - xv) > span * 0.03) continue;
      rows.push({ name: p.run.name, color: p.run.color, v: p.main[i], raw: p.y[i], step: p.d.step[i] });
      if (stepAt !== stepAt) stepAt = p.d.step[i];
    }
    if (!rows.length) {
      tip.style.display = 'none';
      return;
    }
    rows.sort((a, b) => (Number.isNaN(b.v) ? -1 : Number.isNaN(a.v) ? 1 : b.v - a.v));
    const MAX = 16;
    const head = mode === 'step' ? `<span class="tip-k">Step</span> ${esc(fmtX(xv, mode))}` : `${esc(fmtX(xv, mode))}${Number.isFinite(stepAt) ? ` <span class="tip-k">· step</span> ${fmtInt(stepAt)}` : ''}`;
    let html = `<div class="tip-head"><span class="tip-x">${head}</span><span class="tip-key">${esc(this.label)}</span></div>`;
    for (const r of rows.slice(0, MAX)) {
      const stepCol = mode === 'step' ? '' : `<span class="st">${Number.isFinite(r.step) ? fmtInt(r.step) : ''}</span>`;
      html += `<div class="tip-row"><span class="tip-sw" style="background:${r.color}"></span><span class="n">${esc(r.name)}</span><span class="v">${esc(fmtNum(r.v, 5))}</span>${smooth ? `<span class="raw" title="raw">${esc(fmtNum(r.raw, 4))}</span>` : ''}${stepCol}</div>`;
    }
    if (rows.length > MAX) html += `<div class="tip-more">+${rows.length - MAX} more runs</div>`;
    if (smooth) html += `<div class="tip-foot">smoothed · <span class="raw">raw</span></div>`;
    tip.innerHTML = html;
    tip.style.display = 'block';
    const rect = u.over.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = rect.left + left + 14;
    if (x + tw > window.innerWidth - 8) x = rect.left + left - tw - 14;
    let y = rect.top + (u.cursor.top ?? 0) + 14;
    if (y + th > window.innerHeight - 8) y = Math.max(8, window.innerHeight - th - 8);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    tip.style.left = '0';
    tip.style.top = '0';
  }

  // ------------------------------------------------------------------ stats & export
  /** Range used for the stats table: shift-drag selection, else zoom window, else everything. */
  statsWindow(): [number, number] {
    if (this.statsRange) return this.statsRange;
    if (this.zoomX) return this.zoomX;
    return [-Infinity, Infinity];
  }

  emitStats() {
    if (!this.statsWanted || !this.onStats) return;
    const [lo, hi] = this.statsWindow();
    const prepared = this.prepared;
    const runs = prepared.map((p) => p.run);
    const ds = prepared.map((p) => p.d.downsampled);
    statsFor(
      prepared.map((p) => ({ x: p.x, y: p.y })),
      lo,
      hi,
    ).then((s) => {
      if (this.prepared === prepared) this.onStats?.(s, runs, ds);
    });
  }

  csv(): string {
    const smooth = this.smoothing > 0;
    const lines = ['run,experiment_id,step,ts,value' + (smooth ? ',smoothed' : '') + ',bucket_min,bucket_max'];
    const q = (s: string) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    for (const p of this.prepared) {
      const { d } = p;
      for (let i = 0; i < d.step.length; i++) {
        const v = d.value[i];
        let line = `${q(p.run.name)},${p.run.id},${d.step[i]},${d.ts[i]},${Number.isFinite(v) ? v : ''}`;
        if (smooth) line += ',' + (Number.isFinite(p.main[i]) ? p.main[i] : '');
        line += ',' + (d.min && Number.isFinite(d.min[i]) ? d.min[i] : '') + ',' + (d.max && Number.isFinite(d.max[i]) ? d.max[i] : '');
        lines.push(line);
      }
    }
    return lines.join('\n') + '\n';
  }

  png(title: string): Promise<Blob | null> {
    const u = this.u;
    if (!u) return Promise.resolve(null);
    const src = u.ctx.canvas;
    const dpr = src.width / u.width;
    const titleH = 24 * dpr;
    const legendRows = Math.ceil(this.prepared.length / 3);
    const legendH = (legendRows * 16 + 8) * dpr;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height + titleH + legendH;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = theme().surface;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = theme().text;
    ctx.font = `600 ${12 * dpr}px ${theme().font}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 8 * dpr, titleH / 2);
    ctx.drawImage(src, 0, titleH);
    ctx.font = `${11 * dpr}px ${theme().font}`;
    const colW = c.width / 3;
    this.prepared.forEach((p, i) => {
      const x = (i % 3) * colW + 8 * dpr;
      const y = src.height + titleH + (Math.floor(i / 3) * 16 + 12) * dpr;
      ctx.fillStyle = p.run.color;
      ctx.fillRect(x, y - 1.5 * dpr, 14 * dpr, 3 * dpr);
      ctx.fillStyle = theme().text;
      ctx.fillText(p.run.name, x + 20 * dpr, y, colW - 30 * dpr);
    });
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }

  private setUi(p: Partial<PanelUiState>) {
    let changed = false;
    for (const k in p) {
      const key = k as keyof PanelUiState;
      if (this.ui[key] !== p[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.ui = { ...this.ui, ...p };
    this.onUi(this.ui);
  }
}

function positiveOnly(a: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    out[i] = v > 0 ? v : NaN;
  }
  return out;
}

function nearestDefined(ys: ArrayLike<number | null | undefined>, i: number): number {
  if (!ys || ys[i] != null) return i;
  const n = ys.length;
  for (let k = 1; k < 512; k++) {
    const a = i - k;
    const b = i + k;
    if (a >= 0 && ys[a] != null) return a;
    if (b < n && ys[b] != null) return b;
    if (a < 0 && b >= n) break;
  }
  return i;
}

export function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) {
    const s = v.toExponential(1);
    return s.replace('.0e', 'e').replace('e+', 'e');
  }
  return String(+v.toPrecision(4));
}
