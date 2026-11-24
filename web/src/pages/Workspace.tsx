import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type Experiment, type Project } from '../api';
import { Shell } from '../components/Shell';
import { ErrorBox, Popover, StatusBadge } from '../components/ui';
import { absTime, compileFilter, flattenConfig, fmtConfigValue, fmtInt, lsGet, lsSet, naturalCompare, relTime, toDate, toUnixSeconds } from '../lib/format';
import { paletteColor } from '../plot/colors';
import { PanelGrid, PlotToolbar, useGridState, useLiveMetrics, usePlotSettings } from '../plot/Grid';
import { SeriesStore } from '../plot/store';
import type { RunInfo } from '../plot/types';
import { Link } from '../router';

const POLL_MS = 5000;

type SortKey = { col: string; dir: 1 | -1 };

export function Workspace({ projectId }: { projectId: number }) {
  const store = useMemo(() => new SeriesStore(), [projectId]);
  const [project, setProject] = useState<Project | null>(null);
  const [exps, setExps] = useState<Experiment[] | null>(null);
  const [allKeys, setAllKeys] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [settings, updateSettings] = usePlotSettings();
  const [live, setLiveRaw] = useState(() => lsGet('kymo:live', true));
  const setLive = (b: boolean) => {
    setLiveRaw(b);
    lsSet('kymo:live', b);
  };
  const scope = 'p' + projectId;
  const grid = useGridState(scope, allKeys);

  // ---- loading & polling the experiment list
  const loadExps = useCallback(async () => {
    const list = await api.experiments(projectId);
    setExps(list);
    return list;
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    Promise.all([api.project(projectId), loadExps(), api.metricKeys(projectId)]).then(
      ([p, , keys]) => {
        if (!alive) return;
        setProject(p);
        setAllKeys(keys);
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [projectId, loadExps]);

  const hasRunning = !!exps?.some((e) => e.status === 'running');
  useEffect(() => {
    if (!live || !hasRunning) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadExps().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [live, hasRunning, loadExps]);

  // ---- selection & colors
  const [selected, setSelectedRaw] = useState<Set<number> | null>(() => {
    const s = lsGet<number[] | null>('kymo:sel:' + projectId, null);
    return s ? new Set(s) : null;
  });
  const setSelected = (s: Set<number>) => {
    setSelectedRaw(s);
    lsSet('kymo:sel:' + projectId, [...s]);
  };
  useEffect(() => {
    if (exps && selected === null) setSelectedRaw(new Set(exps.slice(0, 8).map((e) => e.id)));
  }, [exps, selected]);
  const [colorOverrides, setColorOverrides] = useState<Record<number, string>>(() => lsGet('kymo:colors:' + projectId, {}));
  const colorOf = useMemo(() => {
    const byAge = [...(exps || [])].sort((a, b) => (toUnixSeconds(a.created_at) ?? 0) - (toUnixSeconds(b.created_at) ?? 0) || a.id - b.id);
    const m = new Map<number, string>();
    byAge.forEach((e, i) => m.set(e.id, colorOverrides[e.id] || paletteColor(i)));
    return m;
  }, [exps, colorOverrides]);
  const setColor = (id: number, c: string) => {
    const n = { ...colorOverrides, [id]: c };
    setColorOverrides(n);
    lsSet('kymo:colors:' + projectId, n);
  };

  // runs passed to panels: identity only changes when the selection / names / colors change
  const runsKeyRef = useRef('');
  const runsRef = useRef<RunInfo[]>([]);
  const runs = useMemo(() => {
    const list = (exps || []).filter((e) => selected?.has(e.id));
    const r: RunInfo[] = list.map((e) => ({ id: e.id, name: e.name, color: colorOf.get(e.id) || '#888', startTs: toUnixSeconds(e.created_at) }));
    const k = r.map((x) => x.id + x.name + x.color).join('|');
    if (k !== runsKeyRef.current) {
      runsKeyRef.current = k;
      runsRef.current = r;
    }
    return runsRef.current;
  }, [exps, selected, colorOf]);

  const runningSelected = useMemo(() => (exps || []).filter((e) => e.status === 'running' && selected?.has(e.id)).map((e) => e.id), [exps, selected]);
  // also poll once more right after a run stops running, to pick up its final points
  const prevRunning = useRef<number[]>([]);
  const pollIds = useMemo(() => {
    const ids = new Set([...runningSelected, ...prevRunning.current.filter((id) => selected?.has(id))]);
    prevRunning.current = runningSelected;
    return [...ids].sort((a, b) => a - b);
  }, [runningSelected.join(','), selected]);
  useLiveMetrics(store, pollIds, live, undefined, POLL_MS);
  // new metric keys appear while runs are live
  useEffect(() => {
    if (!live || !hasRunning) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') api.metricKeys(projectId).then((k) => setAllKeys((old) => (old.join('\n') === k.join('\n') ? old : k)), () => {});
    }, POLL_MS * 6);
    return () => clearInterval(t);
  }, [live, hasRunning, projectId]);

  // ---- side panel width
  const [sideW, setSideW] = useState(() => lsGet('kymo:sidew', 420));
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startDrag = (e: MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const x0 = e.clientX;
    const w0 = sideW;
    let w = w0;
    const move = (ev: MouseEvent) => {
      w = Math.max(240, Math.min(window.innerWidth - 400, w0 + ev.clientX - x0));
      setSideW(w);
    };
    const up = () => {
      setDragging(false);
      lsSet('kymo:sidew', w);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <Shell
      crumbs={
        <>
          <Link href="/">Projects</Link>
          <span class="sep">/</span>
          <span class="cur">{project?.name ?? '…'}</span>
          {project?.shared && <span class="badge">shared</span>}
        </>
      }
    >
      <ErrorBox error={error} />
      <div class={'ws' + (sideCollapsed ? ' side-collapsed' : '')} style={{ '--side-w': sideW + 'px' } as Record<string, string>}>
        <aside class="ws-side">
          {!sideCollapsed && exps && selected && (
            <RunsTable projectId={projectId} exps={exps} selected={selected} setSelected={setSelected} colorOf={colorOf} setColor={setColor} />
          )}
          {!exps && <div class="empty">Loading…</div>}
        </aside>
        <div class={'ws-split' + (dragging ? ' dragging' : '')} onMouseDown={startDrag} onDblClick={() => setSideCollapsed(true)} title="Drag to resize, double-click to hide" />
        <main class="ws-main">
          <PlotToolbar
            settings={settings}
            update={updateSettings}
            filter={grid.filter}
            setFilter={grid.setFilter}
            filterError={grid.filterError}
            live={live}
            setLive={setLive}
            hasRunning={runningSelected.length > 0}
            shown={grid.keys.length}
            total={allKeys.length}
            onCollapseAll={grid.collapseAll}
            extra={
              sideCollapsed ? (
                <button class="small" onClick={() => setSideCollapsed(false)}>
                  show runs
                </button>
              ) : null
            }
          />
          {exps && exps.length === 0 ? (
            <div class="empty">
              No experiments yet. Log one with the Python SDK: <code>kymo.init(project="{project?.name}", experiment="run-1")</code>
            </div>
          ) : (
            <PanelGrid keys={grid.keys} runs={runs} settings={settings} store={store} syncKey={'ws' + projectId} collapsed={grid.collapsed} toggle={grid.toggle} />
          )}
        </main>
      </div>
    </Shell>
  );
}

// ------------------------------------------------------------------------------------------------

function RunsTable(props: {
  projectId: number;
  exps: Experiment[];
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  colorOf: Map<number, string>;
  setColor: (id: number, c: string) => void;
}) {
  const { exps, selected, setSelected, colorOf } = props;
  const [q, setQ] = useState('');
  const [sort, setSortRaw] = useState<SortKey>(() => lsGet('kymo:sort:' + props.projectId, { col: 'created', dir: -1 as 1 | -1 }));
  const [cols, setColsRaw] = useState<string[]>(() => lsGet('kymo:cols:' + props.projectId, []));
  const setCols = (c: string[]) => {
    setColsRaw(c);
    lsSet('kymo:cols:' + props.projectId, c);
  };
  const setSort = (col: string) => {
    const n: SortKey = sort.col === col ? { col, dir: (sort.dir * -1) as 1 | -1 } : { col, dir: col === 'name' ? 1 : -1 };
    setSortRaw(n);
    lsSet('kymo:sort:' + props.projectId, n);
  };

  const flat = useMemo(() => new Map(exps.map((e) => [e.id, flattenConfig(e.config)])), [exps]);
  const configKeys = useMemo(() => {
    const s = new Set<string>();
    for (const f of flat.values()) for (const k of Object.keys(f)) s.add(k);
    return [...s].sort(naturalCompare);
  }, [flat]);
  const differing = useMemo(
    () =>
      configKeys.filter((k) => {
        const vals = new Set<string>();
        for (const f of flat.values()) vals.add(JSON.stringify(f[k]));
        return vals.size > 1;
      }),
    [configKeys, flat],
  );

  const filt = useMemo(() => compileFilter(q), [q]);
  const rows = useMemo(() => {
    const list = exps.filter((e) => !q || filt.test(e.name) || e.tags.some((t) => filt.test(t)) || filt.test(e.status) || (e.host ? filt.test(e.host) : false));
    const val = (e: Experiment): string | number => {
      switch (sort.col) {
        case 'name':
          return e.name;
        case 'status':
          return e.status;
        case 'step':
          return e.last_step ?? -1;
        case 'updated':
          return toDate(e.updated_at)?.getTime() ?? 0;
        case 'created':
          return toDate(e.created_at)?.getTime() ?? 0;
        case 'tags':
          return e.tags.join(',');
        default: {
          const v = flat.get(e.id)?.[sort.col];
          return typeof v === 'number' ? v : v == null ? '' : String(v);
        }
      }
    };
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : naturalCompare(String(x), String(y));
      return c * sort.dir || b.id - a.id;
    });
  }, [exps, q, filt, sort, flat]);

  const toggle = (id: number) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const th = (col: string, label: string, cls = '') => (
    <th class={'sortable ' + cls} onClick={() => setSort(col)}>
      {label}
      {sort.col === col ? (sort.dir > 0 ? ' ▴' : ' ▾') : ''}
    </th>
  );

  return (
    <>
      <div class="side-head">
        <input type="search" placeholder="Filter runs (name, tag, status)" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <Popover
          button={(_o, t) => (
            <button class="small" onClick={t}>
              Select
            </button>
          )}
        >
          {(close) => (
            <>
              <button class="menu-item" onClick={() => (setSelected(new Set([...selected, ...rows.map((r) => r.id)])), close())}>
                All {q ? 'filtered' : ''} ({rows.length})
              </button>
              <button class="menu-item" onClick={() => (setSelected(new Set()), close())}>
                None
              </button>
              <button class="menu-item" onClick={() => (setSelected(new Set(exps.filter((e) => e.status === 'running').map((e) => e.id))), close())}>
                Running only
              </button>
              <button class="menu-item" onClick={() => (setSelected(new Set(rows.slice(0, 5).map((e) => e.id))), close())}>
                Top 5 (current sort)
              </button>
            </>
          )}
        </Popover>
        <Popover
          button={(_o, t) => (
            <button class="small" onClick={t} title="Config columns">
              Columns{cols.length ? ` (${cols.length})` : ''}
            </button>
          )}
        >
          {() => (
            <div style={{ maxHeight: 360, overflow: 'auto', minWidth: 220 }}>
              <div class="row" style={{ padding: '2px 4px 6px' }}>
                <button class="small" onClick={() => setCols(differing)} title="Config keys whose value differs between experiments">
                  differing ({differing.length})
                </button>
                <button class="small" onClick={() => setCols([])}>
                  none
                </button>
              </div>
              {configKeys.length === 0 && <div class="hint" style={{ padding: 6 }}>No config keys.</div>}
              {configKeys.map((k) => (
                <label class="menu-item check" key={k}>
                  <input type="checkbox" checked={cols.includes(k)} onChange={() => setCols(cols.includes(k) ? cols.filter((c) => c !== k) : [...cols, k])} />
                  <span class="mono">{k}</span>
                </label>
              ))}
            </div>
          )}
        </Popover>
      </div>
      <div class="side-table">
        <table class="tbl dense">
          <thead>
            <tr>
              <th style={{ width: 20 }}>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  title="Select all shown"
                  onChange={() => {
                    const s = new Set(selected);
                    for (const r of rows) allVisibleSelected ? s.delete(r.id) : s.add(r.id);
                    setSelected(s);
                  }}
                />
              </th>
              {th('name', 'Name')}
              {th('status', 'Status')}
              {th('step', 'Step', 'num')}
              {th('updated', 'Updated')}
              {th('tags', 'Tags')}
              {cols.map((c) => th(c, c, 'mono'))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const sel = selected.has(e.id);
              const color = colorOf.get(e.id) || '#888';
              const f = flat.get(e.id) || {};
              return (
                <tr key={e.id} class={sel ? 'sel' : ''} onClick={() => toggle(e.id)}>
                  <td>
                    <span class="row" style={{ gap: 5 }}>
                      <input type="checkbox" checked={sel} onClick={(ev) => ev.stopPropagation()} onChange={() => toggle(e.id)} />
                      <span class="swatch" style={{ background: sel ? color : 'transparent', border: '1.5px solid ' + color }} onClick={(ev) => ev.stopPropagation()} title="Change color">
                        <input type="color" value={color} onInput={(ev) => props.setColor(e.id, (ev.target as HTMLInputElement).value)} />
                      </span>
                    </span>
                  </td>
                  <td class="name" title={e.name}>
                    <Link href={'/e/' + e.id} onClick={(ev: MouseEvent) => ev.stopPropagation()}>
                      {e.name}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td class="num">{fmtInt(e.last_step)}</td>
                  <td class="muted" title={absTime(e.updated_at)}>
                    {relTime(e.updated_at)}
                  </td>
                  <td>
                    {e.tags.map((t) => (
                      <span class="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </td>
                  {cols.map((c) => (
                    <td class={typeof f[c] === 'number' ? 'num mono' : 'mono'} key={c}>
                      {fmtConfigValue(f[c])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div class="empty">No runs.</div>}
      </div>
      <div class="side-foot">
        <span>
          {selected.size} selected / {exps.length} runs
        </span>
        <span class="spacer" />
        <span>{exps.filter((e) => e.status === 'running').length} running</span>
      </div>
    </>
  );
}
