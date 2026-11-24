import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { Popover } from '../components/ui';
import { downloadBlob, fmtInt, fmtNum } from '../lib/format';
import type { Stats } from '../lib/stats';
import { PanelController, fmtX, type PanelUiState } from './controller';
import type { SeriesStore } from './store';
import type { PanelOverrides, PlotSettings, RunInfo } from './types';
import { observeSize, observeVisibility } from './visibility';

// per-panel overrides survive collapsing a group / leaving the page within the session
const overrideMemory = new Map<string, PanelOverrides>();

interface Props {
  metricKey: string;
  runs: RunInfo[];
  settings: PlotSettings;
  store: SeriesStore;
  syncKey: string;
}

const INITIAL_UI: PanelUiState = { loading: false, zoomed: false, statsRange: null, empty: false, downsampled: false, error: null, pointCount: 0 };

export const Panel = memo(function Panel({ metricKey, runs, settings, store, syncKey }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const ctrl = useRef<PanelController | null>(null);
  const memKey = syncKey + '\u0000' + metricKey;
  const [ui, setUi] = useState<PanelUiState>(INITIAL_UI);
  const [ov, setOv] = useState<PanelOverrides>(() => overrideMemory.get(memKey) || { smoothing: null, logY: null });
  const [expanded, setExpanded] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [stats, setStats] = useState<{ stats: Stats[]; runs: RunInfo[]; ds: boolean[] } | null>(null);

  useLayoutEffect(() => {
    const c = new PanelController(plotRef.current!, store, metricKey, syncKey, settings, setUi);
    ctrl.current = c;
    c.setSettings(settings, ov);
    c.setRuns(runs);
    const unVis = observeVisibility(rootRef.current!, (v) => c.setVisible(v));
    const unSize = observeSize(plotRef.current!, (w, h) => c.resize(w, h));
    return () => {
      unVis();
      unSize();
      c.destroy();
      ctrl.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricKey, store, syncKey]);

  useEffect(() => {
    ctrl.current?.setRuns(runs);
  }, [runs]);
  useEffect(() => {
    ctrl.current?.setSettings(settings, ov);
    overrideMemory.set(memKey, ov);
  }, [settings, ov, memKey]);
  useEffect(() => {
    const c = ctrl.current;
    if (!c) return;
    c.statsWanted = showStats;
    c.onStats = showStats ? (s, r, ds) => setStats({ stats: s, runs: r, ds }) : null;
    if (showStats) c.emitStats();
  }, [showStats]);

  const smoothing = ov.smoothing ?? settings.smoothing;
  const logY = ov.logY ?? settings.logY;
  const slash = metricKey.lastIndexOf('/');
  const title = (
    <span class="panel-title" title={metricKey}>
      {slash > 0 && <span class="pfx">{metricKey.slice(0, slash + 1)}</span>}
      {metricKey.slice(slash + 1)}
    </span>
  );
  const fileBase = metricKey.replace(/[^\w.-]+/g, '_');

  return (
    <div class={'panel' + (expanded ? ' expanded' : '')} ref={rootRef}>
      <div class="panel-head">
        {title}
        <span class="panel-tags">
          {ui.loading && <span class="spinner-dot" title="Loading" />}
          {ui.downsampled && (
            <span class="badge" title="Downsampled: lines are bucket means, the band is the bucket min/max. Drag to zoom for full resolution.">
              ≈
            </span>
          )}
          {ov.smoothing != null && <span class="badge" title="Panel smoothing override">ema {ov.smoothing.toFixed(2)}</span>}
        </span>
        {ui.zoomed && (
          <button class="icon on" title="Reset zoom (double-click the chart)" onClick={() => ctrl.current?.resetZoom()}>
            ⟲
          </button>
        )}
        <button class={'icon' + (logY ? ' on' : '')} title="Log scale (y)" onClick={() => setOv({ ...ov, logY: !logY === settings.logY ? null : !logY })}>
          log
        </button>
        <button class={'icon' + (showSettings ? ' on' : '')} title="Panel smoothing" onClick={() => setShowSettings(!showSettings)}>
          ∿
        </button>
        <button class={'icon' + (showStats ? ' on' : '')} title="Statistics for the visible range (shift-drag to select a range)" onClick={() => setShowStats(!showStats)}>
          Σ
        </button>
        <button class={'icon' + (expanded ? ' on' : '')} title={expanded ? 'Shrink' : 'Expand'} onClick={() => setExpanded(!expanded)}>
          ⤢
        </button>
        <Popover
          button={(_o, toggle) => (
            <button class="icon" title="More" onClick={toggle}>
              ⋯
            </button>
          )}
        >
          {(close) => (
            <>
              <button
                class="menu-item"
                onClick={() => {
                  close();
                  const c = ctrl.current;
                  if (c) downloadBlob(fileBase + '.csv', new Blob([c.csv()], { type: 'text/csv' }));
                }}
              >
                Export CSV (as plotted)
              </button>
              <button
                class="menu-item"
                onClick={async () => {
                  close();
                  const b = await ctrl.current?.png(metricKey);
                  if (b) downloadBlob(fileBase + '.png', b);
                }}
              >
                Export PNG
              </button>
              {runs.length > 0 && <div class="menu-sep" />}
              {runs.length > 0 && <div class="menu-label">Full-resolution CSV</div>}
              {runs.slice(0, 12).map((r) => (
                <a key={r.id} class="menu-item" href={api.rawUrl(r.id, metricKey, 'csv')} download onClick={close}>
                  <span class="swatch" style={{ background: r.color }} /> {r.name}
                </a>
              ))}
            </>
          )}
        </Popover>
      </div>
      <div class="panel-plot">
        <div class="plot-host" ref={plotRef} />
        {(ui.error || ui.empty || runs.length === 0) && (
          <div class="placeholder">{runs.length === 0 ? 'No runs selected' : ui.error ? <span class="error">{ui.error}</span> : ui.loading ? '' : 'No data for the selected runs'}</div>
        )}
      </div>
      {showSettings && (
        <div class="panel-settings">
          <label class="check">
            <input type="checkbox" checked={ov.smoothing == null} onChange={(e) => setOv({ ...ov, smoothing: (e.target as HTMLInputElement).checked ? null : settings.smoothing })} />
            global smoothing
          </label>
          <input
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={smoothing}
            disabled={ov.smoothing == null}
            onInput={(e) => setOv({ ...ov, smoothing: Number((e.target as HTMLInputElement).value) })}
          />
          <span class="mono">{smoothing.toFixed(2)}</span>
          <span class="spacer" />
          <span class="faint">{fmtInt(ui.pointCount)} pts</span>
        </div>
      )}
      {showStats && <StatsTable stats={stats} ui={ui} xMode={settings.xMode} onClear={() => ctrl.current?.setStatsRange(null)} />}
    </div>
  );
});

function StatsTable({ stats, ui, xMode, onClear }: { stats: { stats: Stats[]; runs: RunInfo[]; ds: boolean[] } | null; ui: PanelUiState; xMode: PlotSettings['xMode']; onClear: () => void }) {
  if (!stats) return <div class="panel-stats"><div class="range">computing…</div></div>;
  const approx = stats.ds.some(Boolean);
  const r = ui.statsRange;
  return (
    <div class="panel-stats">
      <div class="range">
        {r ? (
          <>
            <span>
              selection: {fmtX(r[0], xMode)} – {fmtX(r[1], xMode)}
            </span>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onClear();
              }}
            >
              clear
            </a>
          </>
        ) : (
          <span>{ui.zoomed ? 'zoomed range' : 'all data'} · shift-drag on the chart to select a range</span>
        )}
        {approx && <span title="Computed over downsampled bucket means; zoom in for exact values">≈ approximate (downsampled)</span>}
      </div>
      <table class="tbl dense">
        <thead>
          <tr>
            <th>run</th>
            <th class="num">last</th>
            <th class="num">min</th>
            <th class="num">max</th>
            <th class="num">mean</th>
            <th class="num">std</th>
            <th class="num">median</th>
            <th class="num">p5</th>
            <th class="num">p95</th>
            <th class="num">count</th>
            <th class="num" title={'least-squares slope per ' + (xMode === 'step' ? 'step' : 'second')}>slope</th>
          </tr>
        </thead>
        <tbody>
          {stats.runs.map((run, i) => {
            const s = stats.stats[i];
            return (
              <tr key={run.id}>
                <td class="nowrap">
                  <span class="swatch" style={{ background: run.color, marginRight: 5 }} />
                  {run.name}
                </td>
                <td class="num">{fmtNum(s.last)}</td>
                <td class="num">{fmtNum(s.min)}</td>
                <td class="num">{fmtNum(s.max)}</td>
                <td class="num">{fmtNum(s.mean)}</td>
                <td class="num">{fmtNum(s.std)}</td>
                <td class="num">{fmtNum(s.median)}</td>
                <td class="num">{fmtNum(s.p5)}</td>
                <td class="num">{fmtNum(s.p95)}</td>
                <td class="num">{fmtInt(s.count)}</td>
                <td class="num">{fmtNum(s.slope, 3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
