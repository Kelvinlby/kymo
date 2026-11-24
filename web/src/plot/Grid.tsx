import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type MetricSummary } from '../api';
import { compileFilter, groupKeys, lsGet, lsSet } from '../lib/format';
import { Panel } from './Panel';
import { sid, type SeriesStore } from './store';
import type { PlotSettings, RunInfo, XMode } from './types';

export const DEFAULT_SETTINGS: PlotSettings = { smoothing: 0, xMode: 'step', logY: false, clipPct: 0, maxPoints: 1000, theme: 0 };

/** Global plot settings persisted in localStorage; theme bumps on prefers-color-scheme changes. */
export function usePlotSettings(): [PlotSettings, (p: Partial<PlotSettings>) => void] {
  const [s, setS] = useState<PlotSettings>(() => ({ ...DEFAULT_SETTINGS, ...lsGet<Partial<PlotSettings>>('kymo:plot', {}), theme: 0 }));
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setS((x) => ({ ...x, theme: x.theme + 1 }));
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const update = (p: Partial<PlotSettings>) =>
    setS((x) => {
      const n = { ...x, ...p };
      const { theme: _t, ...persist } = n;
      lsSet('kymo:plot', persist);
      return n;
    });
  return [s, update];
}

export function PlotToolbar(props: {
  settings: PlotSettings;
  update: (p: Partial<PlotSettings>) => void;
  filter: string;
  setFilter: (s: string) => void;
  filterError?: string;
  live: boolean;
  setLive: (b: boolean) => void;
  hasRunning: boolean;
  shown: number;
  total: number;
  onCollapseAll?: (c: boolean) => void;
  extra?: ComponentChildren;
}) {
  const { settings: s, update } = props;
  // smooth the slider: apply at most once per frame
  const pendingSmooth = useRef<number | null>(null);
  const [smooth, setSmooth] = useState(s.smoothing);
  useEffect(() => setSmooth(s.smoothing), [s.smoothing]);
  const onSmooth = (v: number) => {
    setSmooth(v);
    const first = pendingSmooth.current === null;
    pendingSmooth.current = v;
    if (!first) return;
    let done = false;
    const apply = () => {
      if (done) return;
      done = true;
      const val = pendingSmooth.current!;
      pendingSmooth.current = null;
      update({ smoothing: val });
    };
    requestAnimationFrame(apply);
    setTimeout(apply, 50); // rAF stalls in background tabs
  };
  return (
    <div class="ws-toolbar">
      <input
        type="search"
        class={'filter-input' + (props.filterError ? ' invalid' : '')}
        placeholder="Filter metrics (regex)"
        title={props.filterError || 'Regex, case-insensitive. /pattern/flags also works.'}
        value={props.filter}
        onInput={(e) => props.setFilter((e.target as HTMLInputElement).value)}
      />
      <span class="ctl" title="EMA smoothing weight (debiased, like TensorBoard)">
        smoothing
        <input type="range" min={0} max={0.99} step={0.01} value={smooth} onInput={(e) => onSmooth(Number((e.target as HTMLInputElement).value))} />
        <span class="val mono">{smooth.toFixed(2)}</span>
      </span>
      <span class="ctl">
        x
        <select value={s.xMode} onChange={(e) => update({ xMode: (e.target as HTMLSelectElement).value as XMode })}>
          <option value="step">step</option>
          <option value="wall">wall time</option>
          <option value="rel">relative time</option>
        </select>
      </span>
      <label class="ctl check">
        <input type="checkbox" checked={s.logY} onChange={(e) => update({ logY: (e.target as HTMLInputElement).checked })} /> log y
      </label>
      <span class="ctl" title="Ignore the top and bottom p% of values when computing the y range">
        clip outliers
        <select value={s.clipPct} onChange={(e) => update({ clipPct: Number((e.target as HTMLSelectElement).value) })}>
          <option value={0}>off</option>
          <option value={0.1}>0.1%</option>
          <option value={0.5}>0.5%</option>
          <option value={1}>1%</option>
          <option value={2}>2%</option>
          <option value={5}>5%</option>
        </select>
      </span>
      <span class="ctl" title="Points per series (server-side downsampling)">
        res
        <select value={s.maxPoints} onChange={(e) => update({ maxPoints: Number((e.target as HTMLSelectElement).value) })}>
          <option value={500}>500</option>
          <option value={1000}>1k</option>
          <option value={2000}>2k</option>
          <option value={5000}>5k</option>
        </select>
      </span>
      <label class="ctl check" title={props.hasRunning ? 'Poll running experiments every 5 s' : 'No running experiments selected'}>
        <input type="checkbox" checked={props.live} onChange={(e) => props.setLive((e.target as HTMLInputElement).checked)} /> live
        {props.live && props.hasRunning && <span class="badge running">on</span>}
      </label>
      {props.extra}
      <span class="spacer" />
      <span class="faint" style={{ fontSize: 12 }}>
        {props.shown === props.total ? `${props.total} metrics` : `${props.shown} / ${props.total} metrics`}
      </span>
      {props.onCollapseAll && (
        <>
          <button class="small ghost" onClick={() => props.onCollapseAll!(false)}>
            expand all
          </button>
          <button class="small ghost" onClick={() => props.onCollapseAll!(true)}>
            collapse all
          </button>
        </>
      )}
    </div>
  );
}

export function PanelGrid(props: {
  keys: string[];
  runs: RunInfo[];
  settings: PlotSettings;
  store: SeriesStore;
  syncKey: string;
  collapsed: Set<string>;
  toggle: (g: string) => void;
}) {
  const groups = useMemo(() => groupKeys(props.keys), [props.keys]);
  if (!props.keys.length) return <div class="empty">No metrics match.</div>;
  return (
    <div>
      {groups.map((g) => {
        const collapsed = props.collapsed.has(g.name);
        return (
          <section class="group" key={g.name}>
            <div class={'group-head' + (collapsed ? ' collapsed' : '')} onClick={() => props.toggle(g.name)}>
              <span class="chev">▾</span>
              <span>{g.name || 'ungrouped'}</span>
              <span class="count">{g.keys.length}</span>
            </div>
            {!collapsed && (
              <div class="panel-grid">
                {g.keys.map((k) => (
                  <Panel key={k} metricKey={k} runs={props.runs} settings={props.settings} store={props.store} syncKey={props.syncKey} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Metric-key filter + collapsed groups, persisted per scope. */
export function useGridState(scope: string, allKeys: string[]) {
  const [filter, setFilterRaw] = useState<string>(() => lsGet('kymo:filter:' + scope, ''));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(lsGet<string[]>('kymo:collapsed:' + scope, [])));
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
  const compiled = useMemo(() => compileFilter(filter), [filter]);
  const keys = useMemo(() => allKeys.filter((k) => compiled.test(k)), [allKeys, compiled]);
  const collapseAll = (c: boolean) => saveCollapsed(c ? new Set(groupKeys(keys).map((g) => g.name)) : new Set());
  return { filter, setFilter, filterError: compiled.error, collapsed, toggle, keys, collapseAll };
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
