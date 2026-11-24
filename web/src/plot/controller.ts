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
  /** what is drawn: equal to main/y/min/max, or rescaled copies in normalize mode */
  plot: { main: Float64Array; y: Float64Array; min: Float64Array | null; max: Float64Array | null };
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
const tipSize = { w: 260, h: 120 };
function tooltipEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'plot-tip';
    tipEl.style.position = 'fixed';
    document.body.appendChild(tipEl);
    new ResizeObserver((es) => {
      const e = es[es.length - 1];
      const b = e.borderBoxSize?.[0];
      const w = b ? b.inlineSize : e.contentRect.width;
      const h = b ? b.blockSize : e.contentRect.height;
      if (w > 0 && h > 0) {
        // keep the last real size while hidden (display:none reports 0×0)
        tipSize.w = w;
        tipSize.h = h;
      }
    }).observe(tipEl);
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

/** min / max over sorted x arrays */
function extentOf(xs: Float64Array[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (!x.length) continue;
    if (x[0] < lo) lo = x[0];
    if (x[x.length - 1] > hi) hi = x[x.length - 1];
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/** live controllers by sync key: a drag-zoom (and its reset) applies to every chart of one grid */
const syncGroups = new Map<string, Set<PanelController>>();

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
  /** manual y window from wheel zoom/pan; null = auto-fit to the visible data */
  private zoomY: [number, number] | null = null;
  /** last auto-fit y range (zoomY is cleared when a zoom-out grows past it) */
  private autoY: [number, number] | null = null;
  /** x / step arrays of the last unzoomed data: full x extent and x->step mapping when panning outside the loaded window */
  private overview: { x: Float64Array; step: Float64Array }[] = [];
  private fullX: [number, number] | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  /** wheel animation: the drawn window eases from show* toward goal* (zoomX/zoomY already hold the goal) */
  private showX: [number, number] | null = null;
  private goalX: [number, number] | null = null;
  private showY: [number, number] | null = null;
  private goalY: [number, number] | null = null;
  private animRaf = 0;
  private animT = 0;
  /** right-button drag pan in progress */
  private panning = false;
  /** fullscreen: a plain vertical wheel over the plot zooms x (in the grid it scrolls the page) */
  wheelZoom = false;
  private statsRange: [number, number] | null = null;
  private data = new Map<string, SeriesData>(); // by sid(experiment, key)
  private prepared: Prepared[] = [];
  private aligned: uPlot.AlignedData | null = null;
  private unsub: (() => void) | null = null;
  private seq = 0;
  private hovered = false;
  private shiftDrag = false;
  private refreshQueued = false;
  private statsBand: HTMLDivElement | null = null;
  private pendingMove: MouseEvent | null = null;
  private moveRaf = 0;
  private moveHandler: ((e: MouseEvent) => unknown) | null = null;
  private tipHtml = '';
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
    let g = syncGroups.get(syncKey);
    if (!g) syncGroups.set(syncKey, (g = new Set()));
    g.add(this);
  }

  // ------------------------------------------------------------------ inputs
  get smoothing() {
    return this.ov.smoothing ?? this.settings.smoothing;
  }
  /** log y never applies while normalized (normalized values touch 0) */
  get logY() {
    return !this.normalize && (this.ov.logY ?? this.settings.logY);
  }
  /**
   * Compare view: rescale every line to [0, 1] by the min/max of its plotted (smoothed) values so
   * metrics on different scales share one axis. Only drawing changes; the tooltip, stats and CSV keep
   * the real values.
   */
  private normalize = false;
  setNormalize(b: boolean) {
    if (b === this.normalize) return;
    this.normalize = b;
    this.clearYZoomState();
    if (this.structureKey() !== this.structKey) this.recreate();
    else this.rebuild();
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
    const k = runs.map((r) => r.id + ':' + (r.key ?? '') + ':' + r.color + ':' + r.name + ':' + (r.dash ?? '')).join('|');
    if (k === this.runsKey) return;
    this.runsKey = k;
    this.runs = runs;
    this.unsub?.();
    this.unsub = this.store.subscribe(
      runs.map((r) => this.slot(r)),
      () => this.queueRefresh(),
    );
    const keep = new Set(runs.map((r) => this.slot(r)));
    for (const s of [...this.data.keys()]) if (!keep.has(s)) this.data.delete(s);
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
      this.overview = [];
      this.fullX = null;
      this.setUi({ zoomed: !!this.zoomY, statsRange: null });
      queueMicrotask(() => this.refresh());
    }
    if (prevLog !== this.logY) this.clearYZoomState();
    const sk = this.structureKey();
    if (sk !== this.structKey) {
      this.recreate();
    } else if (prevSmooth !== this.smoothing || prevLog !== this.logY || prev.clipPct !== s.clipPct) {
      this.rebuild();
    }
    if (prev.maxPoints !== s.maxPoints) this.refresh();
  }

  private structureKey() {
    return [this.runsKey, this.logY ? 'log' : 'lin', this.settings.xMode, this.normalize ? 'norm' : ''].join('#');
  }

  destroy() {
    this.destroyed = true;
    const g = syncGroups.get(this.syncKey);
    g?.delete(this);
    if (g && !g.size) syncGroups.delete(this.syncKey);
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.stopAnim(false);
    this.unsub?.();
    this.destroyPlot();
  }

  // ------------------------------------------------------------------ data
  private keyOf(r: RunInfo) {
    return r.key ?? this.key;
  }
  private slot(r: RunInfo) {
    return sid(r.id, this.keyOf(r));
  }

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
    const refs = this.runs.map((r) => ({ experiment_id: r.id, key: this.keyOf(r) }));
    let changed = false;
    let allFresh = true;
    for (const ref of refs) {
      const c = this.store.peek(ref, w, mp);
      const s = sid(ref.experiment_id, ref.key);
      if (c) {
        if (this.data.get(s) !== c.data) {
          this.data.set(s, c.data);
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
        for (const d of ds) this.data.set(sid(d.experimentId, d.key), d);
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
      const d = this.data.get(this.slot(run));
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
      const plot = this.normalize ? normalized(main, y, mn, mx) : { main, y, min: mn, max: mx };
      prepared.push({ run, d, x, y, main, min: mn, max: mx, plot });
      if (d.downsampled) downsampled = true;
      points += d.step.length;
    }
    this.prepared = prepared;
    if (!this.zoomX) {
      this.overview = prepared.map((p) => ({ x: p.x, step: p.d.step }));
      this.fullX = extentOf(prepared.map((p) => p.x));
    }
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
        cols.push([p.plot.main, w > 0 ? p.plot.y : null, p.plot.max, p.plot.min]);
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
    this.u.root.addEventListener('wheel', this.onWheel, { passive: false });
    this.u.over.addEventListener('mousedown', this.onPanStart);
    this.u.over.addEventListener('contextmenu', (e) => e.preventDefault());
    this.u.over.addEventListener('mouseenter', () => (this.hovered = true));
    this.u.over.addEventListener('mouseleave', () => {
      this.hovered = false;
      tooltipEl().style.display = 'none';
    });
    this.positionStatsBand();
  }

  /** Run the coalesced mousemove now (from the frame callback, or before mousedown/mouseup). */
  private flushMoveNow() {
    if (!this.moveRaf) return;
    cancelAnimationFrame(this.moveRaf);
    this.moveRaf = 0;
    const e = this.pendingMove;
    this.pendingMove = null;
    if (e && this.moveHandler && this.u) this.moveHandler(e);
  }

  private cancelMove() {
    if (this.moveRaf) cancelAnimationFrame(this.moveRaf);
    this.moveRaf = 0;
    this.pendingMove = null;
  }

  private destroyPlot() {
    this.cancelMove();
    this.stopAnim(false);
    this.tipHtml = '';
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
      series.push({ label: r.name, stroke: r.color, width: 1.6, spanGaps: false, points: { show: false }, ...(r.dash ? { dash: r.dash } : {}) });
      series.push({ label: r.name + ' (raw)', stroke: withAlpha(r.color, 0.28), width: 1, points: { show: false }, ...(r.dash ? { dash: r.dash } : {}) });
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
          // only the main line of each run gets a hover dot; raw/min/max series get no DOM element,
          // so a cursor move touches 1 element per run instead of 4
          show: (_u, si) => {
            if (!isMain(si)) return undefined as unknown as HTMLElement;
            const pt = document.createElement('div');
            pt.style.borderWidth = '2px';
            return pt;
          },
          size: (_u, si) => (isMain(si) ? 7 : 0),
          width: 2,
          fill: (_u, si) => (isMain(si) ? theme().surface : 'transparent'),
          stroke: (u, si) => (u.series[si].stroke as string) || 'transparent',
        },
        dataIdx: (u, si, closest) => nearestDefined(u.data[si] as unknown as ArrayLike<number | null | undefined>, closest),
        bind: {
          // Mice fire mousemove far more often than the display refreshes (often 500-1000 Hz). Coalesce
          // them to one cursor update per frame: uPlot's update, the sync fan-out to every other panel
          // and the tooltip then run at most once per frame. The latest event is used, so no position
          // is lost; mousedown/mouseup flush a pending move first so drags start and end exactly.
          mousemove: (_u, _t, handler) => {
            self.moveHandler = handler;
            return (e: MouseEvent) => {
              self.pendingMove = e;
              if (!self.moveRaf) self.moveRaf = requestAnimationFrame(() => self.flushMoveNow());
              return null;
            };
          },
          mouseleave: (_u, _t, handler) => (e: MouseEvent) => {
            self.cancelMove();
            return handler(e);
          },
          // left button only: the right button pans (onPanStart)
          mouseup: (_u, _t, handler) => (e: MouseEvent) => {
            if (e.button !== 0) return null;
            self.flushMoveNow();
            return handler(e);
          },
          mousedown: (_u, _t, handler) => (e: MouseEvent) => {
            if (e.button !== 0) return null;
            self.flushMoveNow();
            self.shiftDrag = e.shiftKey;
            self.host.parentElement?.classList.toggle('shift', e.shiftKey);
            return handler(e);
          },
          dblclick: () => (e: MouseEvent) => {
            if (e.button !== 0) return null;
            e.preventDefault();
            self.resetZoomSynced();
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
    if (this.showX) return [this.showX[0], this.showX[1]];
    if (this.zoomX) return [this.zoomX[0], this.zoomX[1]];
    if (mn == null || mx == null) return [0, 1];
    if (mn === mx) return [mn - 1, mx + 1];
    return [mn, mx];
  }

  private yRange(mn: number | null, mx: number | null): uPlot.Range.MinMax {
    if (this.showY) return [this.showY[0], this.showY[1]];
    if (this.zoomY) return [this.zoomY[0], this.zoomY[1]];
    const r = this.autoYRange(mn, mx);
    this.autoY = [r[0]!, r[1]!];
    return r;
  }

  private autoYRange(mn: number | null, mx: number | null): uPlot.Range.MinMax {
    const pct = this.settings.clipPct;
    if (pct > 0 && this.prepared.length) {
      const lo = this.zoomX ? this.zoomX[0] : -Infinity;
      const hi = this.zoomX ? this.zoomX[1] : Infinity;
      const pairs = this.prepared.map((p) => ({ x: p.x, y: this.smoothing > 0 ? p.plot.main : p.plot.y }));
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
    else for (const p of this.peers()) p.zoomTo(x0, x1);
  }

  /** this chart and every other live chart sharing its sync key */
  private peers(): Iterable<PanelController> {
    return syncGroups.get(this.syncKey) ?? [this];
  }

  /** Reset this chart, and drop the x zoom of the other charts of the grid (their stats ranges and y windows stay). */
  resetZoomSynced() {
    this.resetZoom();
    for (const p of this.peers()) if (p !== this) p.resetXZoom();
  }

  private resetXZoom() {
    if (!this.zoomX) return;
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.stopAnim(false);
    this.zoomX = null;
    this.zoomSteps = null;
    this.setUi({ zoomed: !!this.zoomY });
    this.data.clear();
    this.refresh();
  }

  /** Zoom to an x range: rescale instantly, then refetch the window at full resolution. */
  zoomTo(x0: number, x1: number) {
    if (!(x1 > x0)) return;
    this.stopAnim(false);
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.zoomX = [x0, x1];
    // a chart that never loaded has no x -> step mapping (time modes): fetch the overview, drawn zoomed
    const known = this.settings.xMode === 'step' || this.prepared.length > 0 || this.overview.length > 0;
    this.zoomSteps = known ? this.xToSteps(x0, x1) : null;
    this.setUi({ zoomed: true });
    if (this.u) this.u.setScale('x', { min: x0, max: x1 });
    this.refresh();
  }

  resetZoom() {
    const had = this.zoomX || this.statsRange;
    const hadY = this.zoomY;
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.stopAnim(false);
    this.zoomX = null;
    this.zoomSteps = null;
    this.zoomY = null;
    this.statsRange = null;
    this.setUi({ zoomed: false, statsRange: null });
    if (had) {
      this.data.clear();
      this.refresh();
    } else if (hadY && this.u) this.u.setData(this.u.data, true);
  }

  // ------------------------------------------------------------------ wheel / drag pan & zoom
  /**
   * Over the plot:   wheel zooms x at the mouse in fullscreen; in the grid a plain wheel scrolls the
   *                  page and ctrl/⌘ + wheel (or pinch) zooms x · alt + wheel zooms y
   *                  shift + wheel or a sideways wheel/swipe pans x and keeps y where it is
   *                  right-button drag pans both axes
   * Over an axis:    (fullscreen only) wheel zooms that axis · shift / sideways pans it
   * Wheel steps ease in over a few frames (so a step close to the grid spacing does not read as
   * moving backwards); the x window is refetched at full resolution once the wheel settles.
   */
  private onWheel = (e: WheelEvent) => {
    const u = this.u;
    if (!u || this.panning) return;
    const r = u.over.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const inX = px >= 0 && px <= r.width;
    const inY = py >= 0 && py <= r.height;
    // axis scrolling only in fullscreen: in the grid it would hijack page scrolling along every chart edge
    const onXAxis = this.wheelZoom && inX && py > r.height;
    const onYAxis = this.wheelZoom && inY && px < 0;
    if (!(inX && inY) && !onXAxis && !onYAxis) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    // Chrome / Firefox on Windows & Linux deliver shift+wheel as deltaX
    const sideways = Math.abs(dx) > Math.abs(dy);
    const d = sideways ? dx : dy;
    if (!d) return;
    const pan = e.shiftKey || sideways;
    let act: 'zx' | 'px' | 'zy' | 'py' | null = null;
    if (onXAxis) act = pan ? 'px' : 'zx';
    else if (onYAxis) act = pan ? 'py' : 'zy';
    else if (e.altKey) act = pan ? 'py' : 'zy';
    else if (pan) act = 'px';
    else if (this.wheelZoom || e.ctrlKey || e.metaKey) act = 'zx';
    if (!act) return; // let the page scroll
    e.preventDefault();
    // trackpad pinch arrives as ctrl+wheel with small fractional deltas: give it a steeper curve
    const pinch = e.ctrlKey && e.deltaMode === 0 && !Number.isInteger(e.deltaY);
    const zf = Math.exp(Math.max(-300, Math.min(300, d)) * (pinch ? 0.01 : 0.002));
    if (act === 'zx') this.wheelX(px, zf, 0, r.width);
    else if (act === 'px') {
      this.pinY();
      this.wheelX(px, 1, Math.max(-r.width / 3, Math.min(r.width / 3, d)), r.width);
    } else if (act === 'zy') this.wheelY(py, zf, 0, r.height);
    else this.wheelY(py, 1, -d, r.height);
  };

  /** Freeze the y axis at what is drawn now (horizontal panning must not re-fit y). */
  private pinY() {
    const u = this.u;
    if (!u || this.zoomY) return;
    const lo = u.scales.y.min;
    const hi = u.scales.y.max;
    if (lo == null || hi == null || !(hi > lo)) return;
    this.zoomY = [lo, hi];
    this.setUi({ zoomed: true });
  }

  /** x window currently aimed at: the animation goal, the zoom window, or what is drawn */
  private targetX(): [number, number] | null {
    if (this.goalX) return this.goalX;
    if (this.zoomX) return this.zoomX;
    const u = this.u;
    const a = u?.scales.x.min;
    const b = u?.scales.x.max;
    return a != null && b != null && b > a ? [a, b] : null;
  }

  private targetY(): [number, number] | null {
    if (this.goalY) return this.goalY;
    if (this.zoomY) return this.zoomY;
    const u = this.u;
    const a = u?.scales.y.min;
    const b = u?.scales.y.max;
    return a != null && b != null && b > a ? [a, b] : null;
  }

  /** Zoom x by `f` around pixel `at`, then shift by `shiftPx` (of a `w`-pixel plot). */
  private wheelX(at: number, f: number, shiftPx: number, w: number) {
    const t = this.targetX();
    if (!t) return;
    let [a, b] = t;
    const c = a + ((b - a) * Math.max(0, Math.min(w, at))) / w;
    a = c - (c - a) * f;
    b = c + (b - c) * f;
    const sh = ((b - a) * shiftPx) / w;
    this.setXWindow(a + sh, b + sh, f, true);
  }

  /** Clamp [a, b] to the data extent and make it the x window (animated or immediate). */
  private setXWindow(a: number, b: number, f: number, animate: boolean) {
    // bounds: the full extent seen unzoomed, grown by whatever newer data has arrived since
    let full = this.fullX;
    const cur = extentOf(this.prepared.map((p) => p.x));
    if (full && cur) full = [Math.min(full[0], cur[0]), Math.max(full[1], cur[1])];
    else full = full ?? cur;
    if (full && full[1] > full[0]) {
      if (b - a >= full[1] - full[0]) {
        if (this.zoomX) {
          this.zoomX = null;
          this.setUi({ zoomed: !!this.zoomY });
          this.moveX(full, animate);
          this.scheduleWindowFetch();
        }
        return;
      }
      if (a < full[0]) [a, b] = [full[0], b + full[0] - a];
      if (b > full[1]) [a, b] = [a - (b - full[1]), full[1]];
    }
    const minSpan = this.settings.xMode === 'step' ? 2 : 1e-3;
    if (b - a < minSpan) {
      if (f < 1) return;
      const m = (a + b) / 2;
      [a, b] = [m - minSpan / 2, m + minSpan / 2];
    }
    this.zoomX = [a, b];
    this.setUi({ zoomed: true });
    this.moveX([a, b], animate);
    this.scheduleWindowFetch();
  }

  private moveX(to: [number, number], animate: boolean) {
    const u = this.u;
    if (!u) return;
    if (animate) {
      if (!this.showX) {
        const a = u.scales.x.min;
        const b = u.scales.x.max;
        if (a == null || b == null) return void u.setScale('x', { min: to[0], max: to[1] });
        this.showX = [a, b];
      }
      this.goalX = to;
      this.startAnim();
    } else {
      this.showX = this.goalX = null;
      u.setScale('x', { min: to[0], max: to[1] });
    }
  }

  /** Refetch the visible x window (or the unzoomed overview) once the wheel has been still a moment. */
  private scheduleWindowFetch() {
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      if (this.destroyed) return;
      this.zoomSteps = this.zoomX ? this.xToSteps(this.zoomX[0], this.zoomX[1]) : null;
      this.refresh();
    }, 150);
  }

  /** Zoom y by `f` around pixel `at` and shift by `shiftPx` (of an `h`-pixel plot); log axes zoom in log space. */
  private wheelY(at: number, f: number, shiftPx: number, h: number) {
    const t = this.targetY();
    if (!t) return;
    const [lo, hi] = t;
    const log = this.logY;
    if (log && !(lo > 0)) return;
    const T = log ? Math.log10 : (v: number) => v;
    const iT = log ? (v: number) => 10 ** v : (v: number) => v;
    const c = T(hi) - ((T(hi) - T(lo)) * Math.max(0, Math.min(h, at))) / h;
    let a = c - (c - T(lo)) * f;
    let b = c + (T(hi) - c) * f;
    const sh = ((b - a) * shiftPx) / h;
    a += sh;
    b += sh;
    const auto = this.zoomY ? this.autoY : [lo, hi];
    // zooming out stops at the auto-fit range (and returns to auto-fit)
    if (f > 1 && auto && auto[1] > auto[0] && (!log || auto[0] > 0) && b - a >= T(auto[1]) - T(auto[0])) {
      if (this.zoomY) this.clearYZoom();
      return;
    }
    this.setYWindow(iT(a), iT(b), true);
  }

  private setYWindow(lo: number, hi: number, animate: boolean) {
    const u = this.u;
    if (!u || !Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const log = this.logY;
    const a = log ? Math.log10(lo) : lo;
    const b = log ? Math.log10(hi) : hi;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1e-300);
    if (!(b - a > scale * 1e-9) || !Number.isFinite(a) || !Number.isFinite(b)) return;
    this.zoomY = [lo, hi];
    this.setUi({ zoomed: true });
    if (animate) {
      if (!this.showY) {
        const s0 = u.scales.y.min;
        const s1 = u.scales.y.max;
        if (s0 == null || s1 == null) return void u.setScale('y', { min: lo, max: hi });
        this.showY = [s0, s1];
      }
      this.goalY = [lo, hi];
      this.startAnim();
    } else {
      this.showY = this.goalY = null;
      u.setScale('y', { min: lo, max: hi });
    }
  }

  // ------------------------------------------------------------------ animation
  private startAnim() {
    if (this.animRaf) return;
    this.animT = performance.now();
    this.animRaf = requestAnimationFrame(this.animStep);
  }

  /** Stop easing; `snap` jumps to the goal, otherwise the goal is simply dropped. */
  private stopAnim(snap: boolean) {
    if (this.animRaf) cancelAnimationFrame(this.animRaf);
    this.animRaf = 0;
    const gx = this.goalX;
    const gy = this.goalY;
    this.showX = this.goalX = this.showY = this.goalY = null;
    const u = this.u;
    if (snap && u) {
      u.batch(() => {
        if (gx) u.setScale('x', { min: gx[0], max: gx[1] });
        if (gy) u.setScale('y', { min: gy[0], max: gy[1] });
      });
    }
  }

  private animStep = (t: number) => {
    this.animRaf = 0;
    const u = this.u;
    if (!u) return this.stopAnim(false);
    const dt = Math.max(0, Math.min(50, t - this.animT));
    this.animT = t;
    // exponential ease-out, time constant ~45 ms: a wheel notch settles in ~150 ms
    const k = 1 - Math.exp(-dt / 45);
    let more = false;
    let nx: [number, number] | null = null;
    let ny: [number, number] | null = null;
    if (this.showX && this.goalX) {
      const s = approach(this.showX, this.goalX, k, false);
      nx = s ?? this.goalX;
      if (s) more = true;
      this.showX = s;
      if (!s) this.goalX = null;
    }
    if (this.showY && this.goalY) {
      const s = approach(this.showY, this.goalY, k, this.logY);
      ny = s ?? this.goalY;
      if (s) more = true;
      this.showY = s;
      if (!s) this.goalY = null;
    }
    u.batch(() => {
      if (nx) u.setScale('x', { min: nx[0], max: nx[1] });
      if (ny) u.setScale('y', { min: ny[0], max: ny[1] });
    });
    if (more) this.animRaf = requestAnimationFrame(this.animStep);
  };

  // ------------------------------------------------------------------ right-drag pan
  private onPanStart = (e: MouseEvent) => {
    const u = this.u;
    if (e.button !== 2 || !u) return;
    e.preventDefault();
    this.stopAnim(true);
    const x0 = this.zoomX ?? this.targetX();
    const y0 = this.targetY();
    if (!x0 || !y0) return;
    const log = this.logY;
    if (log && !(y0[0] > 0)) return;
    const T = log ? Math.log10 : (v: number) => v;
    const iT = log ? (v: number) => 10 ** v : (v: number) => v;
    const ty0 = T(y0[0]);
    const ty1 = T(y0[1]);
    const r = u.over.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const cls = this.host.parentElement?.classList;
    let last: MouseEvent | null = null;
    let raf = 0;
    let moved = false;
    this.panning = true;
    const apply = () => {
      raf = 0;
      const ev = last;
      if (!ev || !this.u) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < 3) return;
        moved = true;
        cls?.add('panning');
        tooltipEl().style.display = 'none';
      }
      this.u.batch(() => {
        const shx = ((x0[1] - x0[0]) * dx) / r.width;
        this.setXWindow(x0[0] - shx, x0[1] - shx, 1, false);
        const shy = ((ty1 - ty0) * dy) / r.height;
        this.setYWindow(iT(ty0 + shy), iT(ty1 + shy), false);
      });
    };
    const move = (ev: MouseEvent) => {
      last = ev;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = (ev: MouseEvent) => {
      if (ev.button !== 2) return;
      if (raf) cancelAnimationFrame(raf);
      apply();
      this.panning = false;
      cls?.remove('panning');
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  };

  private clearYZoom() {
    this.zoomY = null;
    this.showY = this.goalY = null;
    this.setUi({ zoomed: !!this.zoomX });
    if (this.u) this.u.setData(this.u.data, true);
  }

  /** y window is in the old axis units after a log/normalize switch; the chart is recreated right after */
  private clearYZoomState() {
    this.showY = this.goalY = null;
    if (!this.zoomY) return;
    this.zoomY = null;
    this.setUi({ zoomed: !!this.zoomX });
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
    // loaded data maps precisely; the unzoomed overview covers ranges panned outside it
    const srcs = [...this.prepared.map((p) => ({ x: p.x, step: p.d.step })), ...this.overview];
    for (const p of srcs) {
      if (!p.x.length) continue;
      const i0 = Math.max(0, lowerIndex(p.x, x0) - 1);
      const i1 = Math.min(p.x.length - 1, upperIndex(p.x, x1) + 1);
      if (i1 < i0) continue;
      smin = Math.min(smin, p.step[i0]);
      smax = Math.max(smax, p.step[i1]);
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
    // Rewriting identical HTML still costs a parse + style/layout pass, and moving within one data
    // point produces the same rows, so only touch the DOM when the content changed.
    if (html !== this.tipHtml || tip.style.display !== 'block') {
      this.tipHtml = html;
      tip.innerHTML = html;
      tip.style.display = 'block';
    }
    // No layout reads here: getBoundingClientRect/offsetWidth right after the cursor writes above (on
    // this and every synced panel) would force a synchronous layout of the whole page on every move.
    // uPlot keeps the overlay rect cached (refreshed on scroll/resize); the tooltip's size comes from
    // a ResizeObserver, so it is at most one frame stale when the content changes.
    const rect = u.rect;
    const tw = tipSize.w;
    const th = tipSize.h;
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
    const multi = this.runs.some((r) => r.key != null);
    const lines = [(multi ? 'metric,' : '') + 'run,experiment_id,step,ts,value' + (smooth ? ',smoothed' : '') + ',bucket_min,bucket_max'];
    const q = (s: string) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    for (const p of this.prepared) {
      const { d } = p;
      for (let i = 0; i < d.step.length; i++) {
        const v = d.value[i];
        let line = `${multi ? q(this.keyOf(p.run)) + ',' : ''}${q(p.run.name)},${p.run.id},${d.step[i]},${d.ts[i]},${Number.isFinite(v) ? v : ''}`;
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

/** Map every array of one line through v -> (v - lo) / (hi - lo), lo/hi = finite min/max of `main`. */
function normalized(main: Float64Array, y: Float64Array, mn: Float64Array | null, mx: Float64Array | null) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < main.length; i++) {
    const v = main[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi >= lo)) return { main, y, min: mn, max: mx }; // no finite values
  const span = hi - lo || 1;
  const f = (a: Float64Array) => {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] - lo) / span;
    return out;
  };
  const m = f(main);
  return { main: m, y: y === main ? m : f(y), min: mn && f(mn), max: mx && f(mx) };
}

/** One easing step from `cur` toward `goal` (in log space for log axes); null once close enough to snap. */
function approach(cur: [number, number], goal: [number, number], k: number, log: boolean): [number, number] | null {
  const T = log ? Math.log10 : (v: number) => v;
  const iT = log ? (v: number) => 10 ** v : (v: number) => v;
  const c0 = T(cur[0]);
  const c1 = T(cur[1]);
  const g0 = T(goal[0]);
  const g1 = T(goal[1]);
  const eps = Math.abs(g1 - g0) * 1e-3;
  if (!(Math.abs(g0 - c0) > eps || Math.abs(g1 - c1) > eps)) return null;
  return [iT(c0 + (g0 - c0) * k), iT(c1 + (g1 - c1) * k)];
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
