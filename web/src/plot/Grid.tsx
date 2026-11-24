import type { ComponentChildren, Ref } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type MetricSummary } from '../api';
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Columns2, Columns3, LayoutGrid, Pin, RectangleHorizontal, Search, SlidersHorizontal, WavesHorizontal } from '../components/icons';
import { Button, Dialog, EmptyState, IconButton, Popover, SearchInput, Segmented, Switch, cx, type SegOption } from '../components/ui';
import { compileFilter, fmtInt, fmtNum, groupKeys, lsGet, lsSet } from '../lib/format';
import { useHotkeys } from '../lib/hotkeys';
import { usePaletteItems } from '../lib/palette';
import { ChartLine } from '../components/icons';
import type { PanelController, PanelUiState } from './controller';
import { Panel, Range, StatsRangeLine, hoveredPanel, type StatsData } from './Panel';
import { paletteColor } from './colors';
import { sid, type SeriesStore } from './store';
import type { PlotSettings, RunInfo, XMode } from './types';

export const DEFAULT_SETTINGS: PlotSettings = { smoothing: 0, xMode: 'step', logY: false, clipPct: 0, maxPoints: 1000 };

/** Card title: the key without its first-level group prefix (`train/loss` -> `loss`). */
export function shortKey(key: string): string {
  const i = key.indexOf('/');
  return i > 0 ? key.slice(i + 1) : key;
}
export function groupOf(key: string): string {
  const i = key.indexOf('/');
  return i > 0 ? key.slice(0, i) : '';
}

/** Global plot settings persisted in localStorage. */
export function usePlotSettings(): [PlotSettings, (p: Partial<PlotSettings>) => void] {
  const [s, setS] = useState<PlotSettings>(() => {
    const { theme: _t, ...saved } = lsGet<Partial<PlotSettings> & { theme?: number }>('kymo:plot', {});
    return { ...DEFAULT_SETTINGS, ...saved };
  });
  const update = useCallback(
    (p: Partial<PlotSettings>) =>
      setS((x) => {
        const n = { ...x, ...p };
        lsSet('kymo:plot', n);
        if (n.smoothing > 0) lsSet('kymo:lastSmooth', n.smoothing);
        return n;
      }),
    [],
  );
  return [s, update];
}

export type Layout = 'auto' | 1 | 2 | 3;
export function useLayout(): [Layout, (l: Layout) => void] {
  const [l, setL] = useState<Layout>(() => lsGet<Layout>('kymo:layout', 'auto'));
  return [
    l,
    (n: Layout) => {
      setL(n);
      lsSet('kymo:layout', n);
    },
  ];
}

const X_OPTIONS: SegOption<XMode>[] = [
  { value: 'step', label: 'Step' },
  { value: 'wall', label: 'Time' },
  { value: 'rel', label: 'Relative' },
];
const LAYOUT_OPTIONS: SegOption<Layout>[] = [
  { value: 'auto', icon: LayoutGrid, tip: 'Auto columns' },
  { value: 1, icon: RectangleHorizontal, tip: '1 column' },
  { value: 2, icon: Columns2, tip: '2 columns' },
  { value: 3, icon: Columns3, tip: '3 columns' },
];

/** Apply slider values at most once per frame. */
function useThrottled(apply: (v: number) => void) {
  const pending = useRef<number | null>(null);
  return (v: number) => {
    const first = pending.current === null;
    pending.current = v;
    if (!first) return;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      const val = pending.current!;
      pending.current = null;
      apply(val);
    };
    requestAnimationFrame(go);
    setTimeout(go, 50); // rAF stalls in background tabs
  };
}

export function SmoothingControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const push = useThrottled(onChange);
  const set = (x: number) => {
    const c = Math.max(0, Math.min(0.99, Math.round(x * 100) / 100));
    setV(c);
    push(c);
  };
  return (
    <Popover
      placement="bottom-start"
      width={280}
      class="pad"
      trigger={(p) => (
        <Button btnRef={p.ref as Ref<HTMLButtonElement>} size="sm" variant="secondary" class="tb-btn" icon={WavesHorizontal} onClick={p.toggle} aria-expanded={p.open} data-tip="Smoothing (EMA)" data-kbd="s">
          <span class={cx('tb-val', v === 0 && 'off')}>{v === 0 ? 'Off' : v.toFixed(2)}</span>
        </Button>
      )}
    >
      {() => (
        <>
          <div class="pop-title">Smoothing (EMA)</div>
          <div class="pop-desc">Debiased exponential moving average. Raw values stay visible as a faint line.</div>
          <div class="row" style={{ gap: 12 }}>
            <Range value={v} onInput={set} />
            <input
              class="input input-sm mono"
              style={{ width: 70, textAlign: 'right' }}
              type="number"
              min={0}
              max={0.99}
              step={0.01}
              value={v}
              aria-label="Smoothing weight"
              data-autofocus
              onChange={(e) => set(Number((e.target as HTMLInputElement).value) || 0)}
            />
          </div>
          <div class="row" style={{ marginTop: 12, gap: 6 }}>
            {[0, 0.6, 0.8, 0.9, 0.95].map((x) => (
              <Button key={x} size="xs" variant={v === x ? 'primary' : 'secondary'} onClick={() => set(x)}>
                {x === 0 ? 'Off' : x}
              </Button>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}

export function PlotToolbar(props: {
  settings: PlotSettings;
  update: (p: Partial<PlotSettings>) => void;
  filter: string;
  setFilter: (s: string) => void;
  filterError?: string;
  filterRef?: Ref<HTMLInputElement>;
  live: boolean;
  setLive: (b: boolean) => void;
  hasRunning: boolean;
  shown: number;
  total: number;
  onCollapseAll?: (c: boolean) => void;
  allCollapsed?: boolean;
  layout: Layout;
  setLayout: (l: Layout) => void;
  start?: ComponentChildren;
}) {
  const { settings: s, update } = props;
  const displayCount = (s.logY ? 1 : 0) + (s.clipPct > 0 ? 1 : 0) + (s.maxPoints !== 1000 ? 1 : 0);
  return (
    <div class="plot-toolbar" role="toolbar" aria-label="Chart controls">
      {props.start}
      <SearchInput
        class="tb-search"
        icon={Search}
        value={props.filter}
        onInput={props.setFilter}
        placeholder="Filter metrics (regex)"
        kbd="/"
        invalid={!!props.filterError}
        title={props.filterError ? 'Invalid regex (matching as plain text): ' + props.filterError : 'Regular expression, case-insensitive. /pattern/flags also works.'}
        inputRef={props.filterRef}
        onKeyDown={(e) => e.key === 'Escape' && props.filter && (e.stopPropagation(), props.setFilter(''))}
      />
      <Segmented ariaLabel="X axis" value={s.xMode} options={X_OPTIONS} onChange={(v) => update({ xMode: v })} />
      <SmoothingControl value={s.smoothing} onChange={(v) => update({ smoothing: v })} />
      <Popover
        placement="bottom-start"
        width={300}
        class="pad"
        trigger={(p) => (
          <Button btnRef={p.ref as Ref<HTMLButtonElement>} size="sm" variant="secondary" class="tb-btn tb-display" icon={SlidersHorizontal} iconRight={ChevronDown} onClick={p.toggle} aria-expanded={p.open} aria-label="Display options" data-tip="Log scale, outliers, resolution, layout">
            Display{displayCount > 0 && <span class="tb-val"> · {displayCount}</span>}
          </Button>
        )}
      >
        {() => (
          <>
            <Switch label="Log scale (y)" description="Values ≤ 0 are hidden on a log axis." checked={s.logY} onChange={(b) => update({ logY: b })} />
            <div class="pop-section">
              <div class="pop-label">
                <span>Clip outliers</span>
                <span class="faint">ignore top &amp; bottom %</span>
              </div>
              <Segmented
                ariaLabel="Clip outliers"
                value={s.clipPct}
                onChange={(v) => update({ clipPct: v })}
                options={[0, 0.5, 1, 2, 5].map((v) => ({ value: v, label: v === 0 ? 'Off' : v + '%' }))}
              />
            </div>
            <div class="pop-section">
              <div class="pop-label">
                <span>Resolution</span>
                <span class="faint">points per series</span>
              </div>
              <Segmented
                ariaLabel="Resolution"
                value={s.maxPoints}
                onChange={(v) => update({ maxPoints: v })}
                options={[500, 1000, 2000, 5000].map((v) => ({ value: v, label: v >= 1000 ? v / 1000 + 'k' : String(v) }))}
              />
            </div>
            <div class="pop-section">
              <div class="pop-label">
                <span>Layout</span>
              </div>
              <Segmented ariaLabel="Layout" value={props.layout} onChange={props.setLayout} options={LAYOUT_OPTIONS.map((o) => ({ ...o, label: o.value === 'auto' ? 'Auto' : String(o.value), icon: undefined }))} />
            </div>
          </>
        )}
      </Popover>
      <span class="spacer" />
      <span class="tb-count">{props.shown === props.total ? `${fmtInt(props.total)} metrics` : `${fmtInt(props.shown)} of ${fmtInt(props.total)} metrics`}</span>
      <Segmented class="tb-layout" ariaLabel="Layout" value={props.layout} onChange={props.setLayout} options={LAYOUT_OPTIONS} />
      {props.onCollapseAll && (
        <IconButton
          icon={props.allCollapsed ? ChevronsUpDown : ChevronsDownUp}
          label={props.allCollapsed ? 'Expand all groups' : 'Collapse all groups'}
          onClick={() => props.onCollapseAll!(!props.allCollapsed)}
        />
      )}
      <button
        type="button"
        class={cx('live-pill', props.live && 'on', props.live && props.hasRunning && 'active')}
        aria-pressed={props.live}
        onClick={() => props.setLive(!props.live)}
        data-tip={props.live ? (props.hasRunning ? 'Live: polling running experiments every 5 s. Click to pause.' : 'Live is on; no running experiments are shown') : 'Live updates paused. Click to resume.'}
      >
        <span class="live-dot" aria-hidden="true" />
        {props.live ? 'Live' : 'Paused'}
      </button>
    </div>
  );
}

/** Workspace / experiment chart hotkeys: / s l x f. */
export function usePlotHotkeys(settings: PlotSettings, update: (p: Partial<PlotSettings>) => void, filterRef: { current: HTMLInputElement | null }, extra: Record<string, () => void> = {}) {
  useHotkeys({
    '/': () => {
      filterRef.current?.focus();
      filterRef.current?.select();
    },
    s: () => update({ smoothing: settings.smoothing > 0 ? 0 : lsGet('kymo:lastSmooth', 0.6) || 0.6 }),
    l: () => update({ logY: !settings.logY }),
    x: () => update({ xMode: settings.xMode === 'step' ? 'wall' : settings.xMode === 'wall' ? 'rel' : 'step' }),
    f: () => hoveredPanel()?.open(),
    ...extra,
  });
}

export function PanelGrid(props: {
  keys: string[];
  runs: RunInfo[];
  settings: PlotSettings;
  store: SeriesStore;
  syncKey: string;
  collapsed: Set<string>;
  toggle: (g: string) => void;
  pins: string[];
  togglePin: (k: string) => void;
  layout: Layout;
  allKeys: string[];
  onClearFilter?: () => void;
}) {
  const groups = useMemo(() => groupKeys(props.keys), [props.keys]);
  const [fs, setFs] = useState<string[] | null>(null);
  const openFs = useCallback((k: string) => setFs([k]), []);
  const compare = useCompareSelection(setFs);
  const pinned = useMemo(() => props.pins.filter((k) => props.allKeys.includes(k)), [props.pins, props.allKeys]);
  const gridCls = cx('panel-grid', props.layout !== 'auto' && 'cols-' + props.layout);

  usePaletteItems(() =>
    props.allKeys.map((k) => ({
      id: 'm' + k,
      group: 'Metrics',
      title: shortKey(k),
      sub: k,
      icon: ChartLine,
      run: () => setFs([k]),
    })),
  );

  const card = (k: string, inPinned: boolean) => (
    <Panel
      key={(inPinned ? 'pin:' : '') + k}
      metricKey={k}
      title={shortKey(k)}
      group={inPinned ? groupOf(k) || undefined : undefined}
      runs={props.runs}
      settings={props.settings}
      store={props.store}
      syncKey={props.syncKey}
      pinned={props.pins.includes(k)}
      onTogglePin={props.togglePin}
      onFullscreen={openFs}
      compareIdx={compare.keys.indexOf(k)}
      onCompareClick={compare.toggle}
    />
  );

  return (
    <div class="groups">
      {pinned.length > 0 && (
        <section>
          <button type="button" class={cx('group-head', props.collapsed.has('\u0000pinned') && 'collapsed')} onClick={() => props.toggle('\u0000pinned')} aria-expanded={!props.collapsed.has('\u0000pinned')}>
            <ChevronDown size={15} class="chev" aria-hidden="true" />
            <Pin size={13} class="g-icon" aria-hidden="true" />
            <span>Pinned</span>
            <span class="g-count">{pinned.length}</span>
            <span class="g-line" />
          </button>
          {!props.collapsed.has('\u0000pinned') && <div class="group-body"><div class={gridCls}>{pinned.map((k) => card(k, true))}</div></div>}
        </section>
      )}
      {!props.keys.length && (
        <div class="card">
          <EmptyState
            icon={Search}
            title={props.allKeys.length ? 'No metrics match the filter' : 'No metrics yet'}
            action={props.allKeys.length && props.onClearFilter ? <Button onClick={props.onClearFilter}>Clear filter</Button> : undefined}
            compact
          >
            {props.allKeys.length ? 'Try a broader regular expression.' : 'Metrics appear here as soon as the first points are logged.'}
          </EmptyState>
        </div>
      )}
      {groups.map((g) => {
        const name = g.name || 'General';
        const collapsed = props.collapsed.has(g.name);
        return (
          <section key={g.name}>
            <button type="button" class={cx('group-head', collapsed && 'collapsed')} onClick={() => props.toggle(g.name)} aria-expanded={!collapsed}>
              <ChevronDown size={15} class="chev" aria-hidden="true" />
              <span>{name}</span>
              <span class="g-count">{g.keys.length}</span>
              <span class="g-line" />
            </button>
            {!collapsed && (
              <div class="group-body">
                <div class={gridCls}>{g.keys.map((k) => card(k, false))}</div>
              </div>
            )}
          </section>
        );
      })}
      {compare.keys.length > 0 && (
        <div class="compare-hint" role="status">
          <b>{compare.keys.length}</b> {compare.keys.length === 1 ? 'chart' : 'charts'} picked · release <kbd class="kbd">Shift</kbd> to compare
        </div>
      )}
      {fs &&
        (fs.length === 1 ? (
          <FullscreenChart metricKey={fs[0]} runs={props.runs} settings={props.settings} store={props.store} syncKey={props.syncKey + ':fs'} onClose={() => setFs(null)} pinned={props.pins.includes(fs[0])} togglePin={props.togglePin} />
        ) : (
          <FullscreenChart metricKeys={fs} runs={props.runs} settings={props.settings} store={props.store} syncKey={props.syncKey + ':fs'} onClose={() => setFs(null)} />
        ))}
    </div>
  );
}

/**
 * Shift-click cards to pick them (in click order); releasing Shift opens the picked charts together.
 * Losing focus while Shift is down (alt-tab) drops the selection instead of opening it.
 */
function useCompareSelection(open: (keys: string[]) => void) {
  const [keys, setKeys] = useState<string[]>([]);
  const ref = useRef(keys);
  ref.current = keys;
  const toggle = useCallback((k: string) => setKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k])), []);
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || !ref.current.length) return;
      open(ref.current);
      setKeys([]);
    };
    const blur = () => setKeys([]);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, [open]);
  return { keys, toggle };
}

/** Dash patterns that tell metrics apart when lines are coloured by run (first metric solid). */
const DASHES: (number[] | undefined)[] = [undefined, [7, 4], [2, 3], [12, 4, 2, 4], [4, 4], [1, 5]];

/** One line per metric × run: coloured by run and dashed per metric; with a single run, coloured per metric. */
function compareLines(keys: string[], runs: RunInfo[]): RunInfo[] {
  const out: RunInfo[] = [];
  const byMetric = runs.length === 1;
  keys.forEach((k, i) => {
    for (const r of runs) {
      out.push(
        byMetric
          ? { ...r, key: k, name: k, color: paletteColor(i) }
          : { ...r, key: k, name: `${r.name} · ${k}`, dash: DASHES[i % DASHES.length] },
      );
    }
  });
  return out;
}

function DashSample({ dash, color }: { dash?: number[]; color: string }) {
  return (
    <svg width="26" height="8" aria-hidden="true">
      <line x1="1" y1="4" x2="25" y2="4" stroke={color} stroke-width="2" stroke-dasharray={dash?.join(' ')} />
    </svg>
  );
}

function FullscreenChart(
  props: { runs: RunInfo[]; settings: PlotSettings; store: SeriesStore; syncKey: string; onClose: () => void } & (
    | { metricKey: string; metricKeys?: undefined; pinned: boolean; togglePin: (k: string) => void }
    | { metricKeys: string[]; metricKey?: undefined; pinned?: undefined; togglePin?: undefined }
  ),
) {
  const [st, setSt] = useState<{ s: StatsData | null; ui: PanelUiState } | null>(null);
  const sink = useCallback((s: StatsData | null, ui: PanelUiState) => setSt({ s, ui }), []);
  const ctrlRef = useRef<PanelController | null>(null);
  const keys = props.metricKeys;
  const lines = useMemo(() => (keys ? compareLines(keys, props.runs) : props.runs), [keys, props.runs]);
  const panelKey = keys ? keys.join(' + ') : props.metricKey!;
  const g = keys ? '' : groupOf(props.metricKey!);
  const nRuns = props.runs.length;
  const runsLabel = `${nRuns} ${nRuns === 1 ? 'run' : 'runs'}`;
  return (
    <Dialog
      size="full"
      class="fs-dialog"
      title={keys ? `Compare ${keys.length} metrics` : shortKey(props.metricKey!)}
      description={
        keys ? (
          <span class="compare-legend">
            {keys.map((k, i) => (
              <span class="cl-item" key={k}>
                <DashSample dash={nRuns === 1 ? undefined : DASHES[i % DASHES.length]} color={nRuns === 1 ? paletteColor(i) : 'currentColor'} />
                <span class="mono">{k}</span>
              </span>
            ))}
            <span>· {runsLabel}</span>
          </span>
        ) : (
          <>
            {g ? <span class="mono">{g}</span> : 'General'} · {runsLabel} · drag to zoom, shift-drag to select a range
          </>
        )
      }
      onClose={props.onClose}
    >
      <Panel
        metricKey={panelKey}
        title={keys ? panelKey : shortKey(props.metricKey!)}
        runs={lines}
        settings={props.settings}
        store={props.store}
        syncKey={props.syncKey}
        pinned={props.pinned}
        onTogglePin={props.togglePin}
        full
        statsSink={sink}
        ctrlRef={ctrlRef}
      />
      <aside class="fs-side" aria-label="Statistics">
        <div class="fs-side-head">
          <b>Statistics</b>
        </div>
        {st?.ui && <StatsRangeLine ui={st.ui} xMode={props.settings.xMode} approx={!!st.s?.ds.some(Boolean)} onClear={() => ctrlRef.current?.setStatsRange(null)} />}
        {!st?.s && <div class="fs-stat faint">Computing…</div>}
        {st?.s?.runs.map((run, i) => {
          const s = st.s!.stats[i];
          const cells: [string, string][] = [
            ['last', fmtNum(s.last)],
            ['min', fmtNum(s.min)],
            ['max', fmtNum(s.max)],
            ['mean', fmtNum(s.mean)],
            ['std', fmtNum(s.std)],
            ['median', fmtNum(s.median)],
            ['p5', fmtNum(s.p5)],
            ['p95', fmtNum(s.p95)],
            ['count', fmtInt(s.count)],
          ];
          return (
            <div class="fs-stat" key={run.id + ':' + (run.key ?? '')}>
              <div class="fs-stat-name">
                <span class="swatch" style={{ background: run.color }} />
                <span>{run.name}</span>
              </div>
              <div class="fs-stat-grid">
                {cells.map(([k, v]) => (
                  <div key={k}>
                    <span class="k">{k}</span>
                    <span class="v" title={v}>
                      {v}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </aside>
    </Dialog>
  );
}

/** Metric-key filter, collapsed groups, pinned metrics; persisted per scope. */
export function useGridState(scope: string, allKeys: string[]) {
  const [filter, setFilterRaw] = useState<string>(() => lsGet('kymo:filter:' + scope, ''));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(lsGet<string[]>('kymo:collapsed:' + scope, [])));
  const [pins, setPins] = useState<string[]>(() => lsGet<string[]>('kymo:pins:' + scope, []));
  const setFilter = (f: string) => {
    setFilterRaw(f);
    lsSet('kymo:filter:' + scope, f);
  };
  const saveCollapsed = (s: Set<string>) => {
    setCollapsed(s);
    lsSet('kymo:collapsed:' + scope, [...s]);
  };
  const toggle = (g: string) => {
    const s = new Set(collapsed);
    if (s.has(g)) s.delete(g);
    else s.add(g);
    saveCollapsed(s);
  };
  const togglePin = useCallback(
    (k: string) =>
      setPins((p) => {
        const n = p.includes(k) ? p.filter((x) => x !== k) : [...p, k];
        lsSet('kymo:pins:' + scope, n);
        return n;
      }),
    [scope],
  );
  const compiled = useMemo(() => compileFilter(filter), [filter]);
  const keys = useMemo(() => allKeys.filter((k) => compiled.test(k)), [allKeys, compiled]);
  const groupNames = useMemo(() => groupKeys(keys).map((g) => g.name), [keys]);
  const allCollapsed = groupNames.length > 0 && groupNames.every((g) => collapsed.has(g));
  const collapseAll = (c: boolean) => saveCollapsed(c ? new Set(groupNames) : new Set());
  return { filter, setFilter, filterError: compiled.error, collapsed, toggle, keys, collapseAll, allCollapsed, pins, togglePin };
}

/**
 * Live mode: every `intervalMs` poll GET /experiments/{id}/metrics for the given running
 * experiments and invalidate only the series whose last_step changed. Panels showing them
 * refetch (batched); everything else stays untouched.
 */
export function useLiveMetrics(
  store: SeriesStore,
  experimentIds: number[],
  enabled: boolean,
  onSummaries?: (id: number, m: MetricSummary[]) => void,
  intervalMs = 5000,
) {
  const idsKey = experimentIds.join(',');
  const cb = useRef(onSummaries);
  cb.current = onSummaries;
  useEffect(() => {
    if (!enabled || !experimentIds.length) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ctrl = new AbortController();
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        await Promise.all(
          experimentIds.map(async (id) => {
            try {
              const ms = await api.metrics(id, ctrl.signal);
              if (stopped) return;
              for (const m of ms) {
                const s = sid(id, m.key);
                const prev = store.knownLastStep.get(s);
                if (prev !== m.last_step) {
                  store.knownLastStep.set(s, m.last_step);
                  store.invalidate(id, m.key);
                }
              }
              cb.current?.(id, ms);
            } catch {
              /* transient; retry next tick */
            }
          }),
        );
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, idsKey, enabled, intervalMs]);
}
