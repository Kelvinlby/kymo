import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { Download, Ellipsis, Image, Maximize2, Pin, PinOff, RotateCcw, Sigma, Table2, WavesHorizontal } from '../components/icons';
import { Badge, Button, IconButton, MenuItem, MenuLabel, MenuSep, Popover, Skeleton, Switch, cx } from '../components/ui';
import { downloadBlob, fmtInt, fmtNum } from '../lib/format';
import type { Stats } from '../lib/stats';
import { PanelController, fmtX, type PanelUiState } from './controller';
import type { SeriesStore } from './store';
import type { PanelOverrides, PlotSettings, RunInfo } from './types';
import { observeSize, observeVisibility } from './visibility';

// per-panel overrides survive collapsing a group / leaving the page within the session
const overrideMemory = new Map<string, PanelOverrides>();

/** The chart under the mouse (for the "f" fullscreen shortcut). */
let hovered: { key: string; open: () => void } | null = null;
export const hoveredPanel = () => hovered;

export interface StatsData {
  stats: Stats[];
  runs: RunInfo[];
  ds: boolean[];
}

interface Props {
  metricKey: string;
  /** display title: the key without its group prefix */
  title: string;
  /** shown as a small chip (pinned section) */
  group?: string;
  runs: RunInfo[];
  settings: PlotSettings;
  store: SeriesStore;
  syncKey: string;
  pinned?: boolean;
  onTogglePin?: (key: string) => void;
  onFullscreen?: (key: string) => void;
  /** fullscreen variant: stats are always computed and handed to the parent */
  full?: boolean;
  statsSink?: (s: StatsData | null, ui: PanelUiState) => void;
  ctrlRef?: { current: PanelController | null };
  /** position in the compare selection (shift-click), or -1 */
  compareIdx?: number;
  onCompareClick?: (key: string) => void;
  /** compare view: rescale each line to [0, 1] (drawing only) */
  normalize?: boolean;
}

const INITIAL_UI: PanelUiState = { loading: false, zoomed: false, statsRange: null, empty: false, downsampled: false, error: null, pointCount: 0 };

export const Panel = memo(function Panel({ metricKey, title, group, runs, settings, store, syncKey, pinned, onTogglePin, onFullscreen, full, statsSink, ctrlRef, compareIdx = -1, onCompareClick, normalize = false }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const ctrl = useRef<PanelController | null>(null);
  const memKey = syncKey.replace(/:fs$/, '') + '\u0000' + metricKey;
  const [ui, setUi] = useState<PanelUiState>(INITIAL_UI);
  const [ov, setOv] = useState<PanelOverrides>(() => overrideMemory.get(memKey) || { smoothing: null, logY: null });
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const wantStats = showStats || !!statsSink;

  useLayoutEffect(() => {
    const c = new PanelController(plotRef.current!, store, metricKey, syncKey, settings, setUi);
    c.label = group ? group + '/' + title : title;
    ctrl.current = c;
    if (ctrlRef) ctrlRef.current = c;
    c.setNormalize(normalize);
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
    ctrl.current?.setNormalize(normalize);
  }, [normalize]);
  useEffect(() => {
    ctrl.current?.setSettings(settings, ov);
    overrideMemory.set(memKey, ov);
  }, [settings, ov, memKey]);
  useEffect(() => {
    const c = ctrl.current;
    if (!c) return;
    c.statsWanted = wantStats;
    c.onStats = wantStats ? (s, r, ds) => setStats({ stats: s, runs: r, ds }) : null;
    if (wantStats) c.emitStats();
  }, [wantStats]);
  useEffect(() => {
    statsSink?.(stats, ui);
  }, [stats, ui, statsSink]);

  const smoothing = ov.smoothing ?? settings.smoothing;
  const logY = ov.logY ?? settings.logY;
  const fileBase = metricKey.replace(/[^\w.-]+/g, '_');
  const noRuns = runs.length === 0;
  const downAt = useRef<[number, number] | null>(null);
  const openFull = onFullscreen && !full ? () => onFullscreen(metricKey) : undefined;

  return (
    <div
      class={cx('panel', full && 'full', compareIdx >= 0 && 'compare-sel')}
      ref={rootRef}
      onMouseDown={(e) => {
        downAt.current = [e.clientX, e.clientY];
        // shift-click would otherwise extend a text selection (the chart itself needs its mousedown)
        if (e.shiftKey && onCompareClick && !(e.target as Element).closest('.u-over')) e.preventDefault();
      }}
      onClick={(e) => {
        if (!e.shiftKey || !onCompareClick) return;
        if ((e.target as Element).closest('button, a, input, [role="menu"]')) return;
        const d = downAt.current;
        // a shift-drag on the chart selects a stats range; only a click (no movement) adds to the comparison
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;
        onCompareClick(metricKey);
      }}
      onMouseEnter={() => onFullscreen && (hovered = { key: metricKey, open: () => onFullscreen(metricKey) })}
      onMouseLeave={() => hovered?.key === metricKey && (hovered = null)}
    >
      <div class="panel-head">
        {group && <span class="panel-group">{group}</span>}
        {full ? (
          <span class="panel-title faint" title={metricKey}>
            {metricKey}
          </span>
        ) : (
          <span
            class={cx('panel-title', openFull && 'clickable')}
            title={openFull ? metricKey + ' · click for fullscreen, shift-click to compare' : metricKey}
            role={openFull ? 'button' : undefined}
            tabIndex={openFull ? 0 : undefined}
            onClick={(e) => !e.shiftKey && openFull?.()}
            onKeyDown={(e) => openFull && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openFull())}
          >
            {title}
          </span>
        )}
        {compareIdx >= 0 && (
          <span class="compare-num" aria-label={'Compare selection ' + (compareIdx + 1)}>
            {compareIdx + 1}
          </span>
        )}
        <span class="panel-tags">
          {ui.loading && <span class="spinner-dot" title="Loading" />}
          {ui.downsampled && (
            <Badge title="Downsampled: lines are bucket means, the band is each bucket's min/max. Drag across the chart to zoom to full resolution.">≈</Badge>
          )}
          {ov.smoothing != null && <Badge tone="accent">EMA {ov.smoothing.toFixed(2)}</Badge>}
        </span>
        <div class={cx('panel-tools', (menuOpen || ui.zoomed) && 'keep')}>
          {ui.zoomed && <IconButton icon={RotateCcw} label="Reset zoom" kbd="double-click" onClick={() => ctrl.current?.resetZoom()} active />}
          {!normalize && (
            <Button
              size="xs"
              variant="ghost"
              class={cx('log-btn', logY && 'active')}
              data-tip="Log scale (y)"
              aria-pressed={logY}
              onClick={() => setOv({ ...ov, logY: !logY === settings.logY ? null : !logY })}
            >
              log
            </Button>
          )}
          <Popover
            placement="bottom-end"
            width={260}
            class="pad"
            onOpenChange={setMenuOpen}
            trigger={(p) => <IconButton btnRef={p.ref as any} icon={WavesHorizontal} label="Smoothing for this chart" active={ov.smoothing != null || p.open} onClick={p.toggle} aria-expanded={p.open} />}
          >
            {() => (
              <>
                <div class="pop-title">Smoothing (EMA)</div>
                <div class="pop-desc">Override the toolbar setting for this chart only.</div>
                <Switch label="Use toolbar setting" checked={ov.smoothing == null} onChange={(b) => setOv({ ...ov, smoothing: b ? null : settings.smoothing || 0.6 })} />
                <div class="pop-section" style={{ opacity: ov.smoothing == null ? 0.5 : 1 }}>
                  <div class="pop-label">
                    <span>Weight</span>
                    <span class="mono">{smoothing.toFixed(2)}</span>
                  </div>
                  <Range value={smoothing} disabled={ov.smoothing == null} onInput={(v) => setOv({ ...ov, smoothing: v })} />
                </div>
                <div class="pop-section faint" style={{ fontSize: 12 }}>
                  {fmtInt(ui.pointCount)} points plotted
                </div>
              </>
            )}
          </Popover>
          {!full && <IconButton icon={Sigma} label="Statistics" active={showStats} onClick={() => setShowStats(!showStats)} />}
          {onTogglePin && <IconButton icon={pinned ? PinOff : Pin} label={pinned ? 'Unpin' : 'Pin to top'} active={pinned} onClick={() => onTogglePin(metricKey)} />}
          {onFullscreen && !full && <IconButton icon={Maximize2} label="Fullscreen" kbd="f" onClick={() => onFullscreen(metricKey)} />}
          <Popover
            menu
            placement="bottom-end"
            width={260}
            onOpenChange={setMenuOpen}
            trigger={(p) => <IconButton btnRef={p.ref as any} icon={Ellipsis} label="More" onClick={p.toggle} aria-expanded={p.open} aria-haspopup="menu" />}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={Table2}
                  onSelect={() => {
                    close();
                    const c = ctrl.current;
                    if (c) downloadBlob(fileBase + '.csv', new Blob([c.csv()], { type: 'text/csv' }));
                  }}
                >
                  Export CSV (as plotted)
                </MenuItem>
                <MenuItem
                  icon={Image}
                  onSelect={async () => {
                    close();
                    const b = await ctrl.current?.png(metricKey);
                    if (b) downloadBlob(fileBase + '.png', b);
                  }}
                >
                  Export PNG
                </MenuItem>
                {runs.length > 0 && (
                  <>
                    <MenuSep />
                    <MenuLabel>Full-resolution CSV</MenuLabel>
                    {runs.slice(0, 12).map((r) => (
                      <MenuItem key={r.id + ':' + (r.key ?? '')} icon={Download} href={api.rawUrl(r.id, r.key ?? metricKey, 'csv')} download onSelect={close}>
                        <span class="row" style={{ gap: 7 }}>
                          <span class="swatch" style={{ background: r.color }} />
                          <span class="ellipsis">{r.name}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </>
                )}
              </>
            )}
          </Popover>
        </div>
      </div>
      <div class={cx('panel-plot', ui.pointCount === 0 && 'no-points')}>
        <div class="plot-host" ref={plotRef} />
        {ui.loading && ui.pointCount === 0 && !noRuns && (
          <div class="panel-loading">
            <Skeleton w="100%" h="100%" />
          </div>
        )}
        {(ui.error || (ui.empty && !ui.loading) || noRuns) && (
          <div class="placeholder">{noRuns ? 'No runs selected' : ui.error ? <span class="error">{ui.error}</span> : 'No data for the selected runs'}</div>
        )}
      </div>
      {showStats && !full && <StatsTable stats={stats} ui={ui} xMode={settings.xMode} onClear={() => ctrl.current?.setStatsRange(null)} />}
    </div>
  );
});

export function Range({ value, onInput, disabled, min = 0, max = 0.99, step = 0.01 }: { value: number; onInput: (v: number) => void; disabled?: boolean; min?: number; max?: number; step?: number }) {
  return (
    <input
      type="range"
      class="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label="Smoothing weight"
      style={{ '--pct': ((value - min) / (max - min)) * 100 + '%' } as Record<string, string>}
      onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))}
    />
  );
}

export function StatsRangeLine({ ui, xMode, approx, onClear }: { ui: PanelUiState; xMode: PlotSettings['xMode']; approx: boolean; onClear: () => void }) {
  const r = ui.statsRange;
  return (
    <div class="stats-range">
      {r ? (
        <>
          <span>
            Selection {fmtX(r[0], xMode)} – {fmtX(r[1], xMode)}
          </span>
          <Button size="xs" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </>
      ) : (
        <span>{ui.zoomed ? 'Zoomed range' : 'All data'} · shift-drag on the chart to select a range</span>
      )}
      {approx && (
        <span class="approx" title="Computed over downsampled bucket means; zoom in for exact values">
          ≈ approximate
        </span>
      )}
    </div>
  );
}

function StatsTable({ stats, ui, xMode, onClear }: { stats: StatsData | null; ui: PanelUiState; xMode: PlotSettings['xMode']; onClear: () => void }) {
  if (!stats)
    return (
      <div class="panel-stats">
        <div class="stats-range">Computing…</div>
      </div>
    );
  return (
    <div class="panel-stats">
      <StatsRangeLine ui={ui} xMode={xMode} approx={stats.ds.some(Boolean)} onClear={onClear} />
      <div class="stats-table-wrap">
        <table class="stats-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Last</th>
              <th>Min</th>
              <th>Max</th>
              <th>Mean</th>
              <th>Std</th>
              <th>Median</th>
              <th>p5</th>
              <th>p95</th>
              <th>Count</th>
              <th title={'Least-squares slope per ' + (xMode === 'step' ? 'step' : 'second')}>Slope</th>
            </tr>
          </thead>
          <tbody>
            {stats.runs.map((run, i) => {
              const s = stats.stats[i];
              return (
                <tr key={run.id + ':' + (run.key ?? '')}>
                  <td>
                    <span class="run-cell">
                      <span class="swatch" style={{ background: run.color }} />
                      <span class="ellipsis">{run.name}</span>
                    </span>
                  </td>
                  <td>{fmtNum(s.last)}</td>
                  <td>{fmtNum(s.min)}</td>
                  <td>{fmtNum(s.max)}</td>
                  <td>{fmtNum(s.mean)}</td>
                  <td>{fmtNum(s.std)}</td>
                  <td>{fmtNum(s.median)}</td>
                  <td>{fmtNum(s.p5)}</td>
                  <td>{fmtNum(s.p95)}</td>
                  <td>{fmtInt(s.count)}</td>
                  <td>{fmtNum(s.slope, 3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
