import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, canEdit, projectRole, type Experiment, type MetricSummary, type Project, type Status } from '../api';
import { useAuth } from '../auth';
import { NotFound, Page } from '../components/Shell';
import { ConfigView } from '../components/ConfigView';
import { Braces, ChartLine, ChevronDown, Clock, Download, FlaskConical, Hash, Layers, Pencil, Plus, Search, Server, StickyNote, Table2, Trash, X, Activity } from '../components/icons';
import { confirmDialog, toast } from '../components/overlay';
import { Alert, Badge, Button, Dialog, EmptyState, Field, MenuItem, MenuSep, Popover, SearchInput, Skeleton, StatusPill, Tabs, cx, useTick } from '../components/ui';
import { refreshProjects } from '../lib/data';
import { absTime, compileFilter, fmtInt, fmtNum, lsGet, lsSet, relTime, toUnixSeconds } from '../lib/format';
import { paletteColor } from '../plot/colors';
import { PanelGrid, PlotToolbar, useGridState, useLayout, useLiveMetrics, usePlotHotkeys, usePlotSettings } from '../plot/Grid';
import { SeriesStore } from '../plot/store';
import type { RunInfo } from '../plot/types';
import { Link, navigate, useLocation } from '../router';

type Tab = 'charts' | 'config' | 'notes' | 'summary';
const STATUSES: Status[] = ['running', 'finished', 'failed', 'crashed'];

export function ExperimentPage({ experimentId }: { experimentId: number }) {
  const { auth } = useAuth();
  const loc = useLocation();
  const store = useMemo(() => new SeriesStore(), [experimentId]);
  const [exp, setExp] = useState<Experiment | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [metrics, setMetrics] = useState<MetricSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [settings, updateSettings] = usePlotSettings();
  const [layout, setLayout] = useLayout();
  const [live, setLiveRaw] = useState(() => lsGet('kymo:live', true));
  const setLive = (b: boolean) => {
    setLiveRaw(b);
    lsSet('kymo:live', b);
  };
  const initialTab = (loc.query.get('tab') as Tab) || 'charts';
  const [tab, setTabRaw] = useState<Tab>(['charts', 'config', 'notes', 'summary'].includes(initialTab) ? initialTab : 'charts');
  const setTab = (t: Tab) => {
    setTabRaw(t);
    navigate('/e/' + experimentId + (t === 'charts' ? '' : '?tab=' + t), { replace: true });
  };
  const [renaming, setRenaming] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  useTick(30000);

  useEffect(() => {
    Promise.all([api.experiment(experimentId), api.metrics(experimentId)]).then(([e, m]) => {
      setExp(e);
      setMetrics(m);
      if (e.project) api.project(e.project.id).then(setProject, () => {});
    }, setError);
  }, [experimentId]);

  const running = exp?.status === 'running';
  useEffect(() => {
    if (!live || !running) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') api.experiment(experimentId).then((e) => setExp((o) => ({ ...o, ...e })), () => {});
    }, 5000);
    return () => clearInterval(t);
  }, [live, running, experimentId]);
  useLiveMetrics(store, running ? [experimentId] : [], live, (_id, m) => setMetrics(m));

  const keys = useMemo(() => (metrics || []).map((m) => m.key), [metrics]);
  const grid = useGridState('e' + experimentId, keys);
  const runs = useMemo<RunInfo[]>(() => (exp ? [{ id: exp.id, name: exp.name, color: paletteColor(0), startTs: toUnixSeconds(exp.created_at) }] : []), [exp?.id, exp?.name]);
  usePlotHotkeys(settings, updateSettings, filterRef);

  const role = projectRole(project, auth.user);
  const editable = !!project && canEdit(role);

  const patch = async (b: Parameters<typeof api.patchExperiment>[1], okMsg?: string) => {
    try {
      const e = await api.patchExperiment(experimentId, b);
      setExp((old) => ({ ...old!, ...e }));
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      toast.error(e, 'Could not save');
      return false;
    }
  };
  const remove = async () => {
    if (!exp) return;
    const ok = await confirmDialog({
      title: `Delete “${exp.name}”?`,
      message: `This permanently deletes the experiment and all ${exp.metric_count} of its metrics. This cannot be undone.`,
      confirmLabel: 'Delete experiment',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteExperiment(exp.id);
      toast('Experiment deleted', { description: exp.name });
      refreshProjects();
      navigate(exp.project ? '/p/' + exp.project.id : '/');
    } catch (e) {
      toast.error(e, 'Could not delete the experiment');
    }
  };

  if (error && !exp) {
    const st = (error as { status?: number }).status;
    if (st === 404 || st === 403) return <NotFound msg="Experiment not found" body="It may have been deleted, or its project isn't shared with you." />;
  }

  const facts: { icon: typeof Server; label: string; value: string; title?: string; mono?: boolean }[] = exp
    ? [
        { icon: Server, label: 'Host', value: exp.host || '—', mono: true },
        { icon: Clock, label: 'Created', value: relTime(exp.created_at), title: absTime(exp.created_at) },
        { icon: Activity, label: 'Updated', value: relTime(exp.updated_at), title: absTime(exp.updated_at) },
        { icon: Hash, label: 'Last step', value: fmtInt(exp.last_step), mono: true },
        { icon: Layers, label: 'Metrics', value: fmtInt(exp.metric_count), mono: true },
      ]
    : [];

  return (
    <Page
      title={exp?.name}
      crumbs={[
        { label: 'Projects', href: '/projects' },
        exp?.project ? { label: exp.project.name, href: '/p/' + exp.project.id } : { label: <Skeleton w={80} /> },
        { label: exp?.name ?? <Skeleton w={120} /> },
      ]}
      actions={
        exp?.project && (
          <Link href={'/p/' + exp.project.id} class="btn btn-secondary btn-sm">
            <ChartLine size={14} /> Compare in project
          </Link>
        )
      }
    >
      <div class="exp-hero">
        <div class="exp-hero-inner">
          {!exp ? (
            <div class="col">
              <Skeleton w={280} h={28} />
              <Skeleton w={420} />
            </div>
          ) : (
            <>
              <div class="exp-title-row">
                <span class="exp-icon">
                  <FlaskConical size={18} />
                </span>
                <h1 class="exp-name">{exp.name}</h1>
                <StatusPill status={exp.status} />
                {project && !editable && <Badge>Read-only</Badge>}
                <span class="spacer" />
                {editable && (
                  <div class="exp-actions">
                    <Popover
                      menu
                      placement="bottom-end"
                      width={200}
                      trigger={(p) => (
                        <Button btnRef={p.ref as any} size="sm" iconRight={ChevronDown} onClick={p.toggle} aria-expanded={p.open} aria-haspopup="menu">
                          Set status
                        </Button>
                      )}
                    >
                      {(close) =>
                        STATUSES.map((s) => (
                          <MenuItem key={s} checked={exp.status === s} onSelect={() => (close(), s !== exp.status && patch({ status: s }, 'Status set to ' + s))}>
                            <span class="row" style={{ gap: 8 }}>
                              <span class={'status-dot solo status-' + s} />
                              {s[0].toUpperCase() + s.slice(1)}
                            </span>
                          </MenuItem>
                        ))
                      }
                    </Popover>
                    <Popover
                      menu
                      placement="bottom-end"
                      width={200}
                      trigger={(p) => (
                        <Button btnRef={p.ref as any} size="sm" variant="ghost" icon={Pencil} onClick={p.toggle} aria-expanded={p.open} aria-haspopup="menu">
                          Edit
                        </Button>
                      )}
                    >
                      {(close) => (
                        <>
                          <MenuItem icon={Pencil} onSelect={() => (close(), setRenaming(true))}>
                            Rename…
                          </MenuItem>
                          <MenuItem icon={StickyNote} onSelect={() => (close(), setTab('notes'))}>
                            Edit notes
                          </MenuItem>
                          <MenuSep />
                          <MenuItem icon={Trash} danger onSelect={() => (close(), remove())}>
                            Delete experiment
                          </MenuItem>
                        </>
                      )}
                    </Popover>
                  </div>
                )}
              </div>
              <TagsEditor tags={exp.tags} editable={editable} onChange={(tags) => patch({ tags })} />
              <dl class="facts">
                {facts.map((f) => (
                  <div class="fact" key={f.label}>
                    <dt>
                      <f.icon size={13} aria-hidden="true" />
                      {f.label}
                    </dt>
                    <dd class={cx(f.mono && 'mono')} title={f.title || f.value}>
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
        <div class="exp-tabs">
          <Tabs
            ariaLabel="Experiment sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'charts', label: 'Charts', icon: ChartLine, count: metrics?.length },
              { value: 'config', label: 'Config', icon: Braces },
              { value: 'notes', label: 'Notes', icon: StickyNote },
              { value: 'summary', label: 'Summary', icon: Table2 },
            ]}
          />
        </div>
      </div>
      {!!error && exp && (
        <div class="page-wrap" style={{ paddingBottom: 0 }}>
          <Alert tone="danger">{(error as Error).message}</Alert>
        </div>
      )}
      {exp && tab === 'charts' && (
        <div class="exp-charts">
          <PlotToolbar
            settings={settings}
            update={updateSettings}
            filter={grid.filter}
            setFilter={grid.setFilter}
            filterError={grid.filterError}
            filterRef={filterRef}
            live={live}
            setLive={setLive}
            hasRunning={running}
            shown={grid.keys.length}
            total={keys.length}
            onCollapseAll={grid.collapseAll}
            allCollapsed={grid.allCollapsed}
            layout={layout}
            setLayout={setLayout}
          />
          <PanelGrid
            keys={grid.keys}
            allKeys={keys}
            runs={runs}
            settings={settings}
            store={store}
            syncKey={'exp' + experimentId}
            collapsed={grid.collapsed}
            toggle={grid.toggle}
            pins={grid.pins}
            togglePin={grid.togglePin}
            layout={layout}
            onClearFilter={() => grid.setFilter('')}
          />
        </div>
      )}
      {exp && tab === 'config' && (
        <div class="page-wrap narrow">
          <ConfigView config={exp.config} />
        </div>
      )}
      {exp && tab === 'notes' && (
        <div class="page-wrap narrow">
          <NotesEditor notes={exp.notes || ''} editable={editable} onSave={(notes) => patch({ notes }, 'Notes saved')} />
        </div>
      )}
      {exp && tab === 'summary' && (
        <div class="page-wrap">
          <MetricsTable metrics={metrics || []} experimentId={exp.id} />
        </div>
      )}
      {renaming && exp && (
        <RenameDialog
          name={exp.name}
          onClose={() => setRenaming(false)}
          onSave={async (n) => {
            if (await patch({ name: n }, 'Experiment renamed')) setRenaming(false);
          }}
        />
      )}
    </Page>
  );
}

function RenameDialog({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (n: string) => Promise<void> }) {
  const [v, setV] = useState(name);
  const [busy, setBusy] = useState(false);
  const err = !v.trim() ? 'A name is required' : v.length > 128 ? 'At most 128 characters' : null;
  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (err || v === name) return v === name ? onClose() : undefined;
    setBusy(true);
    await onSave(v.trim());
    setBusy(false);
  };
  return (
    <Dialog
      title="Rename experiment"
      icon={Pencil}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!!err} onClick={() => submit()}>
            Rename
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Name" error={err} hint="SDK clients that log by name will create a new experiment under the old name.">
          <input class="input" data-autofocus value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} aria-invalid={!!err} />
        </Field>
      </form>
    </Dialog>
  );
}

function MetricsTable({ metrics, experimentId }: { metrics: MetricSummary[]; experimentId: number }) {
  const [q, setQ] = useState('');
  const f = useMemo(() => compileFilter(q), [q]);
  const rows = metrics.filter((m) => f.test(m.key));
  return (
    <div class="card">
      <div class="card-head">
        <SearchInput value={q} onInput={setQ} placeholder="Filter metrics (regex)" icon={Search} class="config-search" invalid={!!f.error} />
        <span class="faint tnum" style={{ fontSize: 12 }}>
          {rows.length === metrics.length ? `${metrics.length} metrics` : `${rows.length} of ${metrics.length}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState compact icon={Search} title={metrics.length ? 'No metrics match' : 'No metrics yet'} />
      ) : (
        <div class="table-wrap">
          <table class="table dense">
            <thead>
              <tr>
                <th>Key</th>
                <th class="num">Last</th>
                <th class="num">Min</th>
                <th class="num">Max</th>
                <th class="num">Points</th>
                <th class="num">Steps</th>
                <th class="num">Updated</th>
                <th class="actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.key}>
                  <td class="mono">{m.key}</td>
                  <td class="num mono">{fmtNum(m.last_value, 6)}</td>
                  <td class="num mono">{fmtNum(m.min, 6)}</td>
                  <td class="num mono">{fmtNum(m.max, 6)}</td>
                  <td class="num mono">{fmtInt(m.count)}</td>
                  <td class="num mono muted">
                    {fmtInt(m.first_step)}–{fmtInt(m.last_step)}
                  </td>
                  <td class="num muted" title={m.last_ts ? absTime(m.last_ts) : ''}>
                    {m.last_ts ? relTime(m.last_ts) : '—'}
                  </td>
                  <td class="actions">
                    <a class="btn btn-ghost btn-xs" href={api.rawUrl(experimentId, m.key, 'csv')} download data-tip="Full-resolution CSV">
                      <Download size={13} /> CSV
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TagsEditor({ tags, onChange, editable }: { tags: string[]; onChange: (t: string[]) => void; editable: boolean }) {
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState('');
  const add = () => {
    const t = v.trim();
    setV('');
    setAdding(false);
    if (t && !tags.includes(t)) onChange([...tags, t]);
  };
  if (!tags.length && !editable) return null;
  return (
    <div class="exp-tags">
      {tags.map((t) => (
        <span class="chip tag-chip" key={t}>
          {t}
          {editable && (
            <button class="chip-x" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {editable &&
        (adding ? (
          <input
            class="input tag-input"
            autoFocus
            placeholder="tag name"
            value={v}
            onInput={(e) => setV((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setAdding(false);
                setV('');
              }
            }}
            onBlur={add}
          />
        ) : (
          <button class="chip chip-add" onClick={() => setAdding(true)}>
            <Plus size={11} /> Add tag
          </button>
        ))}
    </div>
  );
}

function NotesEditor({ notes, onSave, editable }: { notes: string; onSave: (n: string) => Promise<boolean>; editable: boolean }) {
  const [v, setV] = useState(notes);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(notes), [notes]);
  const dirty = v !== notes;
  const save = async () => {
    setBusy(true);
    await onSave(v);
    setBusy(false);
  };
  if (!editable)
    return (
      <div class="card">
        {notes ? (
          <div class="card-body notes-view">{notes}</div>
        ) : (
          <EmptyState icon={StickyNote} title="No notes">
            Nobody has written notes for this experiment yet.
          </EmptyState>
        )}
      </div>
    );
  return (
    <div class="card">
      <div class="card-head">
        <div class="card-titles">
          <h2 class="card-title">Notes</h2>
          <p class="card-desc">Hypotheses, observations, links. Plain text; visible to everyone with access to the project.</p>
        </div>
      </div>
      <div class="card-body">
        <textarea
          class="input notes-input"
          rows={12}
          value={v}
          placeholder="What did you change, and what did you observe?"
          onInput={(e) => setV((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && dirty && save()}
        />
      </div>
      <div class="card-foot">
        <span>{dirty ? 'Unsaved changes · Ctrl+Enter to save' : notes ? 'Saved' : ''}</span>
        <span class="spacer" />
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setV(notes)}>
          Discard
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={save}>
          Save notes
        </Button>
      </div>
    </div>
  );
}
