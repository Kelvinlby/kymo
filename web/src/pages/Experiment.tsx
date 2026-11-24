import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Experiment, type MetricSummary, type Status } from '../api';
import { Shell } from '../components/Shell';
import { ErrorBox, StatusBadge } from '../components/ui';
import { JsonView } from '../components/JsonView';
import { absTime, fmtInt, fmtNum, lsGet, lsSet, relTime, toUnixSeconds } from '../lib/format';
import { paletteColor } from '../plot/colors';
import { PanelGrid, PlotToolbar, useGridState, useLiveMetrics, usePlotSettings } from '../plot/Grid';
import { SeriesStore } from '../plot/store';
import type { RunInfo } from '../plot/types';
import { Link, navigate } from '../router';

export function ExperimentPage({ experimentId }: { experimentId: number }) {
  const store = useMemo(() => new SeriesStore(), [experimentId]);
  const [exp, setExp] = useState<Experiment | null>(null);
  const [metrics, setMetrics] = useState<MetricSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [settings, updateSettings] = usePlotSettings();
  const [live, setLiveRaw] = useState(() => lsGet('kymo:live', true));
  const setLive = (b: boolean) => {
    setLiveRaw(b);
    lsSet('kymo:live', b);
  };
  const [tab, setTab] = useState<'charts' | 'table'>('charts');

  useEffect(() => {
    Promise.all([api.experiment(experimentId), api.metrics(experimentId)]).then(
      ([e, m]) => {
        setExp(e);
        setMetrics(m);
      },
      setError,
    );
  }, [experimentId]);

  const running = exp?.status === 'running';
  useEffect(() => {
    if (!live || !running) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') api.experiment(experimentId).then(setExp, () => {});
    }, 5000);
    return () => clearInterval(t);
  }, [live, running, experimentId]);
  useLiveMetrics(store, running ? [experimentId] : [], live, (_id, m) => setMetrics(m));

  const keys = useMemo(() => (metrics || []).map((m) => m.key), [metrics]);
  const grid = useGridState('e' + experimentId, keys);
  const runs = useMemo<RunInfo[]>(() => (exp ? [{ id: exp.id, name: exp.name, color: paletteColor(0), startTs: toUnixSeconds(exp.created_at) }] : []), [exp?.id, exp?.name]);

  const patch = async (b: Parameters<typeof api.patchExperiment>[1]) => {
    setError(null);
    try {
      const e = await api.patchExperiment(experimentId, b);
      setExp((old) => ({ ...old!, ...e }));
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Shell
      crumbs={
        <>
          <Link href="/">Projects</Link>
          <span class="sep">/</span>
          {exp?.project ? <Link href={'/p/' + exp.project.id}>{exp.project.name}</Link> : <span>…</span>}
          <span class="sep">/</span>
          <span class="cur">{exp?.name ?? '…'}</span>
        </>
      }
    >
      <div class="page wide">
        <ErrorBox error={error} />
        {exp && (
          <>
            <div class="page-head">
              <h1 class="mono">{exp.name}</h1>
              <StatusBadge status={exp.status} />
              <span class="spacer" />
              <select value={exp.status} title="Set status" onChange={(e) => patch({ status: (e.target as HTMLSelectElement).value as Status })}>
                {['running', 'finished', 'failed', 'crashed'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  const n = prompt('Rename experiment', exp.name);
                  if (n && n !== exp.name) patch({ name: n });
                }}
              >
                Rename
              </button>
              <button
                class="danger"
                onClick={async () => {
                  if (!confirm(`Delete experiment "${exp.name}" and all its metrics? This cannot be undone.`)) return;
                  try {
                    await api.deleteExperiment(exp.id);
                    navigate(exp.project ? '/p/' + exp.project.id : '/');
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Delete
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(300px, 1.3fr) minmax(300px, 1.5fr)', gap: 12, marginBottom: 14 }} class="exp-top">
              <div class="card">
                <div class="card-head">
                  <h2>Overview</h2>
                </div>
                <div class="card-body kv">
                  <span>ID</span>
                  <span class="mono">{exp.id}</span>
                  <span>Host</span>
                  <span class="mono">{exp.host || '—'}</span>
                  <span>Created</span>
                  <span title={absTime(exp.created_at)}>{absTime(exp.created_at)}</span>
                  <span>Updated</span>
                  <span title={absTime(exp.updated_at)}>{relTime(exp.updated_at)}</span>
                  <span>Last step</span>
                  <span class="mono">{fmtInt(exp.last_step)}</span>
                  <span>Metrics</span>
                  <span>{exp.metric_count}</span>
                  <span>Tags</span>
                  <TagsEditor tags={exp.tags} onChange={(tags) => patch({ tags })} />
                </div>
              </div>
              <div class="card">
                <div class="card-head">
                  <h2>Notes</h2>
                </div>
                <div class="card-body">
                  <NotesEditor notes={exp.notes || ''} onSave={(notes) => patch({ notes })} />
                </div>
              </div>
              <div class="card">
                <div class="card-head">
                  <h2 class="grow">Config</h2>
                  <button class="small" onClick={() => navigator.clipboard?.writeText(JSON.stringify(exp.config, null, 2))}>
                    Copy JSON
                  </button>
                </div>
                <div class="card-body" style={{ maxHeight: 300, overflow: 'auto' }}>
                  <JsonView value={exp.config} />
                </div>
              </div>
            </div>
            <div class="row" style={{ marginBottom: 6 }}>
              <h2>Metrics</h2>
              <button class={'small' + (tab === 'charts' ? ' primary' : '')} onClick={() => setTab('charts')}>
                Charts
              </button>
              <button class={'small' + (tab === 'table' ? ' primary' : '')} onClick={() => setTab('table')}>
                Summary table
              </button>
            </div>
            {tab === 'charts' ? (
              <>
                <PlotToolbar
                  settings={settings}
                  update={updateSettings}
                  filter={grid.filter}
                  setFilter={grid.setFilter}
                  filterError={grid.filterError}
                  live={live}
                  setLive={setLive}
                  hasRunning={running}
                  shown={grid.keys.length}
                  total={keys.length}
                  onCollapseAll={grid.collapseAll}
                />
                <PanelGrid keys={grid.keys} runs={runs} settings={settings} store={store} syncKey={'exp' + experimentId} collapsed={grid.collapsed} toggle={grid.toggle} />
              </>
            ) : (
              <MetricsTable metrics={(metrics || []).filter((m) => grid.keys.includes(m.key))} filter={grid.filter} setFilter={grid.setFilter} experimentId={exp.id} />
            )}
          </>
        )}
        {!exp && !error && <div class="empty">Loading…</div>}
      </div>
    </Shell>
  );
}

function MetricsTable({ metrics, filter, setFilter, experimentId }: { metrics: MetricSummary[]; filter: string; setFilter: (s: string) => void; experimentId: number }) {
  return (
    <div class="card">
      <div class="card-head">
        <input type="search" class="filter-input" placeholder="Filter metrics (regex)" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <span class="hint">{metrics.length} metrics</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table class="tbl dense">
          <thead>
            <tr>
              <th>key</th>
              <th class="num">last</th>
              <th class="num">min</th>
              <th class="num">max</th>
              <th class="num">count</th>
              <th class="num">first step</th>
              <th class="num">last step</th>
              <th>last update</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.key}>
                <td class="mono">{m.key}</td>
                <td class="num mono">{fmtNum(m.last_value, 6)}</td>
                <td class="num mono">{fmtNum(m.min, 6)}</td>
                <td class="num mono">{fmtNum(m.max, 6)}</td>
                <td class="num">{fmtInt(m.count)}</td>
                <td class="num">{fmtInt(m.first_step)}</td>
                <td class="num">{fmtInt(m.last_step)}</td>
                <td class="muted">{m.last_ts ? relTime(m.last_ts) : '—'}</td>
                <td>
                  <a href={api.rawUrl(experimentId, m.key, 'csv')} download>
                    csv
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState('');
  const add = () => {
    const t = v.trim();
    setV('');
    if (t && !tags.includes(t)) onChange([...tags, t]);
  };
  return (
    <div class="row wrap" style={{ gap: 4 }}>
      {tags.map((t) => (
        <span class="tag" key={t}>
          {t}
          <button title="Remove tag" onClick={() => onChange(tags.filter((x) => x !== t))}>
            ✕
          </button>
        </span>
      ))}
      <input
        style={{ width: 90, minHeight: 20, padding: '0 5px', fontSize: 12 }}
        placeholder="+ tag"
        value={v}
        onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

function NotesEditor({ notes, onSave }: { notes: string; onSave: (n: string) => void }) {
  const [v, setV] = useState(notes);
  useEffect(() => setV(notes), [notes]);
  const dirty = v !== notes;
  return (
    <div class="col">
      <textarea rows={7} value={v} placeholder="Notes about this run…" onInput={(e) => setV((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && dirty && onSave(v)} />
      <div class="row">
        <span class="hint">{dirty ? 'Unsaved changes (Ctrl+Enter to save)' : ''}</span>
        <span class="spacer" />
        <button class="small" disabled={!dirty} onClick={() => setV(notes)}>
          Revert
        </button>
        <button class="small primary" disabled={!dirty} onClick={() => onSave(v)}>
          Save
        </button>
      </div>
    </div>
  );
}
