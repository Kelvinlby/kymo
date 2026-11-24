import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, canManage, projectRole, type Experiment, type Project, type Sharing, type Status } from '../api';
import { useAuth } from '../auth';
import { NotFound, Page } from '../components/Shell';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Columns3, ExternalLink, Eye, EyeOff, Funnel, PanelLeft, Pin, PinOff, Search, Users, X } from '../components/icons';
import { ProjectMenu, ROLE_LABEL, SharingSummary, useProjectActions } from '../components/project';
import { CodeTabs } from '../components/Snippets';
import { useLayer } from '../components/overlay';
import { Badge, Button, EmptyState, ErrorBox, IconButton, MenuItem, MenuLabel, MenuSep, Popover, SearchInput, Skeleton, StatusPill, cx, useTick } from '../components/ui';
import { ConfigValue } from '../components/ConfigView';
import { patchProjectLocal } from '../lib/data';
import { absTime, compileFilter, flattenConfig, fmtConfigValue, fmtInt, lsGet, lsSet, naturalCompare, relTime, toDate, toUnixSeconds } from '../lib/format';
import { PALETTE, paletteColor } from '../plot/colors';
import { PanelGrid, PlotToolbar, useGridState, useLayout, useLiveMetrics, usePlotHotkeys, usePlotSettings } from '../plot/Grid';
import { SeriesStore } from '../plot/store';
import type { RunInfo } from '../plot/types';
import { Link, navigate } from '../router';

const POLL_MS = 5000;
const NARROW = '(max-width: 960px)';

type SortKey = { col: string; dir: 1 | -1 };

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

export function Workspace({ projectId }: { projectId: number }) {
  const { auth } = useAuth();
  const store = useMemo(() => new SeriesStore(), [projectId]);
  const [project, setProject] = useState<Project | null>(null);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [exps, setExps] = useState<Experiment[] | null>(null);
  const [allKeys, setAllKeys] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [settings, updateSettings] = usePlotSettings();
  const [layout, setLayout] = useLayout();
  const [live, setLiveRaw] = useState(() => lsGet('kymo:live', true));
  const setLive = (b: boolean) => {
    setLiveRaw(b);
    lsSet('kymo:live', b);
  };
  const scope = 'p' + projectId;
  const grid = useGridState(scope, allKeys);
  const filterRef = useRef<HTMLInputElement>(null);
  const narrow = useMedia(NARROW);
  const [paneHidden, setPaneHidden] = useState(() => lsGet('kymo:runs-hidden', false));
  const [drawer, setDrawer] = useState(false);
  const togglePane = () => {
    if (narrow) setDrawer(!drawer);
    else {
      setPaneHidden(!paneHidden);
      lsSet('kymo:runs-hidden', !paneHidden);
    }
  };
  usePlotHotkeys(settings, updateSettings, filterRef, { r: togglePane });
  useLayer(narrow && drawer, () => setDrawer(false));

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
        api.sharing(projectId).then(
          (s) => alive && setSharing(s),
          () => {},
        );
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

  // ---- selection (= runs shown in charts), pins & colours
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
  const [pinnedRuns, setPinnedRuns] = useState<Set<number>>(() => new Set(lsGet<number[]>('kymo:runpins:' + projectId, [])));
  const togglePinRun = (id: number) => {
    const s = new Set(pinnedRuns);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setPinnedRuns(s);
    lsSet('kymo:runpins:' + projectId, [...s]);
  };
  const [colorOverrides, setColorOverrides] = useState<Record<number, string>>(() => lsGet('kymo:colors:' + projectId, {}));
  const colorOf = useMemo(() => {
    const byAge = [...(exps || [])].sort((a, b) => (toUnixSeconds(a.created_at) ?? 0) - (toUnixSeconds(b.created_at) ?? 0) || a.id - b.id);
    const m = new Map<number, string>();
    byAge.forEach((e, i) => m.set(e.id, colorOverrides[e.id] || paletteColor(i)));
    return m;
  }, [exps, colorOverrides]);
  const setColor = (id: number, c: string | null) => {
    const n = { ...colorOverrides };
    if (c) n[id] = c;
    else delete n[id];
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

  // ---- runs pane width
  const [paneW, setPaneW] = useState(() => lsGet('kymo:runs-w', Math.max(300, Math.min(420, Math.round(window.innerWidth * 0.28)))));
  const [dragging, setDragging] = useState(false);
  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const x0 = e.clientX;
    const w0 = paneW;
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.max(260, Math.min(Math.min(760, window.innerWidth - 520), w0 + ev.clientX - x0));
      setPaneW(w);
    };
    const up = () => {
      setDragging(false);
      lsSet('kymo:runs-w', w);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const role = projectRole(project, auth.user);
  const actions = useProjectActions(project, {
    onChanged: (p) => {
      setProject((old) => ({ ...old!, ...p }));
      patchProjectLocal(p);
    },
    onSharing: (s) => {
      setSharing(s);
      setProject((old) => old && { ...old, everyone: s.everyone, member_count: s.members.length });
    },
    afterDelete: () => navigate('/projects'),
  });

  if (error && !project) {
    const st = (error as { status?: number }).status;
    if (st === 404 || st === 403) return <NotFound msg="Project not found" body="It may have been deleted, or it isn't shared with you." />;
  }

  const paneOpen = narrow ? drawer : !paneHidden;
  const runsToggle = (
    <IconButton icon={PanelLeft} label={paneOpen ? 'Hide runs' : 'Show runs'} kbd="r" variant="secondary" size="sm" active={paneOpen && !narrow} onClick={togglePane} class="tb-runs" />
  );

  return (
    <Page
      title={project?.name}
      crumbs={[
        { label: 'Projects', href: '/projects' },
        {
          label: project ? (
            <span class="crumb-title">
              {project.name}
              {role !== 'owner' && (
                <Badge tone={role === 'viewer' ? 'neutral' : 'accent'} title={role === 'viewer' ? 'You can view this project but not change it' : undefined}>
                  {ROLE_LABEL[role]}
                  {role === 'viewer' ? ' · read-only' : ''}
                </Badge>
              )}
            </span>
          ) : (
            <Skeleton w={120} />
          ),
        },
      ]}
      actions={
        project && (
          <>
            <SharingSummary project={project} sharing={sharing} size={24} />
            {canManage(role) && (
              <Button size="sm" icon={Users} onClick={actions.openShare}>
                Share
              </Button>
            )}
            <ProjectMenu project={project} actions={actions} />
          </>
        )
      }
      class="ws-page"
    >
      <ErrorBox error={project ? error : null} />
      <div class={cx('ws', !paneOpen && 'pane-hidden', narrow && 'narrow', drawer && 'drawer-open')} style={{ '--runs-w': paneW + 'px' } as Record<string, string>}>
        {narrow && drawer && <div class="ws-scrim" onClick={() => setDrawer(false)} />}
        <aside class="ws-runs" aria-label="Runs" aria-hidden={!paneOpen}>
          {exps && selected ? (
            <RunsPane
              projectId={projectId}
              exps={exps}
              selected={selected}
              setSelected={setSelected}
              colorOf={colorOf}
              setColor={setColor}
              pinned={pinnedRuns}
              togglePin={togglePinRun}
              onClose={narrow ? () => setDrawer(false) : undefined}
            />
          ) : (
            <div class="runs-loading">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div class="run-skel" key={i}>
                  <Skeleton w={10} h={10} r={3} />
                  <Skeleton w={`${50 + ((i * 17) % 40)}%`} />
                </div>
              ))}
            </div>
          )}
        </aside>
        {!narrow && paneOpen && <div class={cx('ws-resizer', dragging && 'dragging')} onPointerDown={startDrag} role="separator" aria-orientation="vertical" aria-label="Resize runs pane" title="Drag to resize" />}
        <div class="ws-charts">
          <PlotToolbar
            settings={settings}
            update={updateSettings}
            filter={grid.filter}
            setFilter={grid.setFilter}
            filterError={grid.filterError}
            filterRef={filterRef}
            live={live}
            setLive={setLive}
            hasRunning={runningSelected.length > 0}
            shown={grid.keys.length}
            total={allKeys.length}
            onCollapseAll={grid.collapseAll}
            allCollapsed={grid.allCollapsed}
            layout={layout}
            setLayout={setLayout}
            start={runsToggle}
          />
          {exps && exps.length === 0 ? (
            <div class="groups">
              <div class="card">
                <EmptyState icon={Search} title="No experiments yet">
                  Log your first run into <b>{project?.name}</b> from any language.
                </EmptyState>
                <div style={{ padding: '0 24px 24px', maxWidth: 760, margin: '0 auto' }}>
                  <CodeTabs project={project?.name} />
                </div>
              </div>
            </div>
          ) : (
            <PanelGrid
              keys={grid.keys}
              allKeys={allKeys}
              runs={runs}
              settings={settings}
              store={store}
              syncKey={'ws' + projectId}
              collapsed={grid.collapsed}
              toggle={grid.toggle}
              pins={grid.pins}
              togglePin={grid.togglePin}
              layout={layout}
              onClearFilter={() => grid.setFilter('')}
            />
          )}
        </div>
      </div>
      {actions.dialogs}
    </Page>
  );
}

// ------------------------------------------------------------------------------------------------

const STATUSES: Status[] = ['running', 'finished', 'failed', 'crashed'];

function RunsPane(props: {
  projectId: number;
  exps: Experiment[];
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  colorOf: Map<number, string>;
  setColor: (id: number, c: string | null) => void;
  pinned: Set<number>;
  togglePin: (id: number) => void;
  onClose?: () => void;
}) {
  const { exps, selected, setSelected, colorOf, pinned } = props;
  useTick(30000);
  const pid = props.projectId;
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState<Set<Status>>(() => new Set(lsGet<Status[]>('kymo:runstatus:' + pid, [])));
  const [tagF, setTagF] = useState<Set<string>>(() => new Set(lsGet<string[]>('kymo:runtags:' + pid, [])));
  const saveStatus = (s: Set<Status>) => (setStatusF(s), lsSet('kymo:runstatus:' + pid, [...s]));
  const saveTags = (s: Set<string>) => (setTagF(s), lsSet('kymo:runtags:' + pid, [...s]));
  const [sort, setSortRaw] = useState<SortKey>(() => lsGet('kymo:sort:' + pid, { col: 'created', dir: -1 as 1 | -1 }));
  const [cols, setColsRaw] = useState<string[]>(() => lsGet('kymo:cols:' + pid, []));
  const setCols = (c: string[]) => {
    setColsRaw(c);
    lsSet('kymo:cols:' + pid, c);
  };
  const setSort = (n: SortKey) => {
    setSortRaw(n);
    lsSet('kymo:sort:' + pid, n);
  };
  const clickSort = (col: string) => setSort(sort.col === col ? { col, dir: (sort.dir * -1) as 1 | -1 } : { col, dir: col === 'name' ? 1 : -1 });

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
  const allTags = useMemo(() => [...new Set(exps.flatMap((e) => e.tags))].sort(naturalCompare), [exps]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of exps) c[e.status] = (c[e.status] || 0) + 1;
    return c;
  }, [exps]);

  const filt = useMemo(() => compileFilter(q), [q]);
  const rows = useMemo(() => {
    const list = exps.filter(
      (e) =>
        (!statusF.size || statusF.has(e.status)) &&
        (!tagF.size || e.tags.some((t) => tagF.has(t))) &&
        (!q || filt.test(e.name) || e.tags.some((t) => filt.test(t)) || (e.host ? filt.test(e.host) : false)),
    );
    const val = (e: Experiment): string | number => {
      switch (sort.col) {
        case 'name':
          return e.name;
        case 'status':
          return STATUSES.indexOf(e.status);
        case 'step':
          return e.last_step ?? -1;
        case 'updated':
          return toDate(e.updated_at)?.getTime() ?? 0;
        case 'created':
          return toDate(e.created_at)?.getTime() ?? 0;
        default: {
          const v = flat.get(e.id)?.[sort.col];
          return typeof v === 'number' ? v : v == null ? '' : fmtConfigValue(v);
        }
      }
    };
    return [...list].sort((a, b) => {
      const pa = pinned.has(a.id) ? 1 : 0;
      const pb = pinned.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : naturalCompare(String(x), String(y));
      return c * sort.dir || b.id - a.id;
    });
  }, [exps, q, filt, sort, flat, statusF, tagF, pinned]);

  const lastClicked = useRef<number | null>(null);
  const onRowClick = (e: MouseEvent, id: number) => {
    if ((e.target as Element).closest('a,button,input,.run-actions')) return;
    const s = new Set(selected);
    if (e.altKey) {
      setSelected(new Set([id]));
    } else if (e.shiftKey && lastClicked.current != null) {
      const a = rows.findIndex((r) => r.id === lastClicked.current);
      const b = rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        const on = !selected.has(id);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) on ? s.add(rows[i].id) : s.delete(rows[i].id);
        setSelected(s);
      }
      window.getSelection()?.removeAllRanges();
    } else {
      if (s.has(id)) s.delete(id);
      else s.add(id);
      setSelected(s);
    }
    lastClicked.current = id;
  };
  const toggleVis = (id: number) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };

  const shownCount = exps.filter((e) => selected.has(e.id)).length;
  const filtersOn = statusF.size + tagF.size;
  const SORTS: [string, string][] = [
    ['created', 'Created'],
    ['updated', 'Last update'],
    ['name', 'Name'],
    ['status', 'Status'],
    ['step', 'Last step'],
  ];
  const sortLabel = SORTS.find((s) => s[0] === sort.col)?.[1] || sort.col;
  const th = (col: string, label: string, cls = '') => (
    <th class={cx('th-sort', cls, sort.col === col && 'on')} onClick={() => clickSort(col)} aria-sort={sort.col === col ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}>
      {label}
      {sort.col === col && (sort.dir > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </th>
  );

  return (
    <div class="runs-pane">
      <div class="runs-head">
        <div class="runs-title">
          <span>Runs</span>
          <span class="runs-count">
            {shownCount} of {exps.length} shown
          </span>
          <span class="spacer" />
          {props.onClose && <IconButton icon={X} label="Close runs" onClick={props.onClose} />}
        </div>
        <div class="runs-tools">
          <SearchInput value={q} onInput={setQ} placeholder="Search runs" icon={Search} class="grow" />
          <Popover
            placement="bottom-end"
            width={260}
            class="pad"
            trigger={(p) => <IconButton btnRef={p.ref as any} icon={Funnel} label="Filter by tag" variant="secondary" size="md" active={tagF.size > 0} onClick={p.toggle} aria-expanded={p.open} />}
          >
            {() => (
              <>
                <div class="pop-title">Tags</div>
                <div class="pop-desc">Show runs with any of the selected tags.</div>
                {allTags.length === 0 && <div class="faint" style={{ fontSize: 13 }}>No run has tags yet.</div>}
                <div class="chips" style={{ gap: 6 }}>
                  {allTags.map((t) => (
                    <button
                      type="button"
                      key={t}
                      class={cx('chip chip-toggle', tagF.has(t) && 'on')}
                      aria-pressed={tagF.has(t)}
                      onClick={() => {
                        const s = new Set(tagF);
                        if (s.has(t)) s.delete(t);
                        else s.add(t);
                        saveTags(s);
                      }}
                    >
                      {tagF.has(t) && <Check size={11} />}
                      {t}
                    </button>
                  ))}
                </div>
                {tagF.size > 0 && (
                  <Button size="xs" variant="ghost" onClick={() => saveTags(new Set())} style={{ marginTop: 10 }}>
                    Clear tags
                  </Button>
                )}
              </>
            )}
          </Popover>
          <Popover
            menu
            placement="bottom-end"
            width={230}
            trigger={(p) => <IconButton btnRef={p.ref as any} icon={ArrowUpDown} label={`Sort: ${sortLabel}`} variant="secondary" size="md" onClick={p.toggle} aria-expanded={p.open} aria-haspopup="menu" />}
          >
            {(close) => (
              <>
                <MenuLabel>Sort by</MenuLabel>
                {SORTS.map(([c, l]) => (
                  <MenuItem key={c} checked={sort.col === c} onSelect={() => (setSort({ col: c, dir: sort.col === c ? sort.dir : c === 'name' ? 1 : -1 }), close())}>
                    {l}
                  </MenuItem>
                ))}
                {cols.length > 0 && <MenuLabel>Config</MenuLabel>}
                {cols.map((c) => (
                  <MenuItem key={c} checked={sort.col === c} onSelect={() => (setSort({ col: c, dir: sort.col === c ? sort.dir : 1 }), close())}>
                    <span class="mono">{c}</span>
                  </MenuItem>
                ))}
                <MenuSep />
                <MenuItem checked={sort.dir > 0} onSelect={() => (setSort({ ...sort, dir: 1 }), close())}>
                  Ascending
                </MenuItem>
                <MenuItem checked={sort.dir < 0} onSelect={() => (setSort({ ...sort, dir: -1 }), close())}>
                  Descending
                </MenuItem>
              </>
            )}
          </Popover>
          <Popover
            placement="bottom-end"
            width={300}
            trigger={(p) => <IconButton btnRef={p.ref as any} icon={Columns3} label={cols.length ? `Config columns (${cols.length})` : 'Config columns'} variant="secondary" size="md" active={cols.length > 0} onClick={p.toggle} aria-expanded={p.open} />}
          >
            {() => (
              <div class="cols-pop">
                <div class="cols-head">
                  <div class="pop-title">Config columns</div>
                  <div class="row" style={{ gap: 4 }}>
                    <Button size="xs" variant="secondary" onClick={() => setCols(differing)} data-tip="Keys whose value differs between runs">
                      Differing ({differing.length})
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setCols([])}>
                      None
                    </Button>
                  </div>
                </div>
                <div class="cols-list">
                  {configKeys.length === 0 && <div class="faint" style={{ padding: 10, fontSize: 13 }}>No config keys logged.</div>}
                  {configKeys.map((k) => (
                    <label class="menu-item" key={k}>
                      <input type="checkbox" class="checkbox" checked={cols.includes(k)} onChange={() => setCols(cols.includes(k) ? cols.filter((c) => c !== k) : [...cols, k])} />
                      <span class="mono ellipsis" style={{ fontSize: 12 }}>
                        {k}
                      </span>
                      {differing.includes(k) && <span class="menu-hint">varies</span>}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </Popover>
        </div>
        <div class="status-filter" role="group" aria-label="Filter by status">
          <button type="button" class={cx('sf', !statusF.size && 'on')} onClick={() => saveStatus(new Set())} aria-pressed={!statusF.size}>
            All <span class="tnum">{exps.length}</span>
          </button>
          {STATUSES.filter((s) => counts[s]).map((s) => (
            <button
              type="button"
              key={s}
              class={cx('sf', 'sf-' + s, statusF.has(s) && 'on')}
              aria-pressed={statusF.has(s)}
              onClick={(e) => {
                const n = e.shiftKey || e.metaKey || e.ctrlKey ? new Set(statusF) : new Set<Status>();
                if (statusF.has(s) && n.size) n.delete(s);
                else if (statusF.has(s) && statusF.size === 1) n.clear();
                else n.add(s);
                saveStatus(n);
              }}
            >
              <span class={'status-dot solo status-' + s} />
              {s[0].toUpperCase() + s.slice(1)} <span class="tnum">{counts[s]}</span>
            </button>
          ))}
        </div>
      </div>
      <div class="runs-table-wrap">
        <table class="runs-table">
          <thead>
            <tr>
              <th class="c-sw" />
              {th('name', 'Name')}
              {th('step', 'Step', 'num')}
              {cols.map((c) => th(c, c.length > 18 ? '…' + c.slice(-17) : c, 'num mono cfg'))}
              <th class="c-act" />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const sel = selected.has(e.id);
              const color = colorOf.get(e.id) || '#888';
              const f = flat.get(e.id) || {};
              const pin = pinned.has(e.id);
              return (
                <tr key={e.id} class={cx('run-row', sel ? 'shown' : 'hidden-run', pin && 'pinned')} onClick={(ev) => onRowClick(ev as unknown as MouseEvent, e.id)} aria-selected={sel}>
                  <td class="c-sw">
                    <ColorSwatch color={color} shown={sel} custom={false} onPick={(c) => props.setColor(e.id, c)} name={e.name} />
                  </td>
                  <td class="c-name">
                    <div class="run-name" title={e.name}>
                      {pin && <Pin size={11} class="run-pin" aria-label="Pinned" />}
                      {e.name}
                    </div>
                    <div class="run-meta">
                      <StatusPill status={e.status} />
                      {e.tags.map((t) => (
                        <span class="chip" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td class="num c-step">
                    <div class="mono">{fmtInt(e.last_step)}</div>
                    <div class="c-time" title={absTime(e.updated_at)}>
                      {shortRel(e.updated_at)}
                    </div>
                  </td>
                  {cols.map((c) => (
                    <td class="num cfg" key={c} title={c + ' = ' + fmtConfigValue(f[c])}>
                      {f[c] === undefined ? <span class="faint">—</span> : <ConfigValue v={f[c]} compact />}
                    </td>
                  ))}
                  <td class="c-act">
                    <div class="run-actions">
                      <IconButton icon={pin ? PinOff : Pin} label={pin ? 'Unpin run' : 'Pin to top'} size="xs" onClick={() => props.togglePin(e.id)} />
                      <IconButton icon={sel ? EyeOff : Eye} label={sel ? 'Hide from charts' : 'Show in charts'} size="xs" onClick={() => toggleVis(e.id)} />
                      <Link href={'/e/' + e.id} class="btn btn-ghost btn-xs btn-icon" aria-label={`Open ${e.name}`} data-tip="Open experiment">
                        <ExternalLink size={13} />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {exps.length === 0 && <div class="runs-empty faint">No runs yet</div>}
        {rows.length === 0 && exps.length > 0 && (
          <EmptyState compact icon={Search} title="No runs match" action={<Button size="sm" onClick={() => (setQ(''), saveStatus(new Set()), saveTags(new Set()))}>Clear filters</Button>}>
            {filtersOn ? 'Status or tag filters are active.' : undefined}
          </EmptyState>
        )}
      </div>
      <div class="runs-foot">
        <span class="faint" title="Click a run to show or hide it in the charts. Shift-click selects a range, Alt-click shows only that run.">Click to toggle · Shift range · Alt solo</span>
        <span class="spacer" />
        <Popover
          menu
          placement="top-end"
          width={220}
          trigger={(p) => (
            <Button btnRef={p.ref as any} size="xs" variant="ghost" onClick={p.toggle} aria-expanded={p.open}>
              Show…
            </Button>
          )}
        >
          {(close) => (
            <>
              <MenuItem onSelect={() => (setSelected(new Set([...selected, ...rows.map((r) => r.id)])), close())}>All listed ({rows.length})</MenuItem>
              <MenuItem onSelect={() => (setSelected(new Set(rows.filter((r) => r.status === 'running').map((r) => r.id))), close())}>Running only</MenuItem>
              <MenuItem onSelect={() => (setSelected(new Set(rows.slice(0, 5).map((e) => e.id))), close())}>Top 5 in this order</MenuItem>
              <MenuSep />
              <MenuItem onSelect={() => (setSelected(new Set()), close())}>Hide all</MenuItem>
            </>
          )}
        </Popover>
      </div>
    </div>
  );
}

function shortRel(t: string | number | null | undefined) {
  const s = relTime(t);
  return s.replace(' ago', '');
}

function ColorSwatch({ color, shown, onPick, name }: { color: string; shown: boolean; custom: boolean; onPick: (c: string | null) => void; name: string }) {
  return (
    <Popover
      placement="bottom-start"
      width={236}
      class="pad"
      trigger={(p) => (
        <button
          ref={p.ref as any}
          type="button"
          class={cx('run-swatch', shown && 'on')}
          style={{ '--c': color } as Record<string, string>}
          onClick={(e) => {
            e.stopPropagation();
            p.toggle();
          }}
          aria-label={`Colour of ${name}`}
          aria-expanded={p.open}
          data-tip="Change colour"
        />
      )}
    >
      {(close) => (
        <>
          <div class="pop-title">Run colour</div>
          <div class="swatch-grid">
            {PALETTE.map((c) => (
              <button
                type="button"
                key={c}
                class={cx('swatch-pick', c.toLowerCase() === color.toLowerCase() && 'on')}
                style={{ background: c }}
                aria-label={c}
                onClick={() => {
                  onPick(c);
                  close();
                }}
              />
            ))}
          </div>
          <div class="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
            <label class="btn btn-secondary btn-xs" style={{ position: 'relative', overflow: 'hidden' }}>
              Custom…
              <input type="color" value={color} onInput={(e) => onPick((e.target as HTMLInputElement).value)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
            </label>
            <Button size="xs" variant="ghost" onClick={() => (onPick(null), close())}>
              Reset
            </Button>
          </div>
        </>
      )}
    </Popover>
  );
}

