import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Experiment, type Project } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Shell';
import { ArrowRight, FlaskConical, KeyRound, Plus, Activity } from '../components/icons';
import { ProjectCard, ProjectDialog } from '../components/project';
import { CodeTabs } from '../components/Snippets';
import { Sparkline } from '../components/Sparkline';
import { toast } from '../components/overlay';
import { Button, CopyField, EmptyState, Skeleton, StatusPill, useTick } from '../components/ui';
import { useProjectsData } from '../lib/data';
import { absTime, fmtInt, fmtNum, relTime, toDate } from '../lib/format';
import { Link, navigate } from '../router';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

type ExpRow = Experiment & { project: { id: number; name: string } };

export function Overview() {
  const { auth } = useAuth();
  const d = useProjectsData();
  const [creating, setCreating] = useState(false);
  useTick(30000);
  const name = auth.user?.display_name || auth.user?.username || '';
  const first = name.split(/\s+/)[0];

  const all = useMemo<ExpRow[]>(() => {
    const out: ExpRow[] = [];
    const byId = new Map((d.projects || []).map((p) => [p.id, p]));
    for (const [pid, list] of d.exps) {
      const p = byId.get(pid);
      if (!p) continue;
      for (const e of list) out.push({ ...e, project: { id: p.id, name: p.name } });
    }
    out.sort((a, b) => (toDate(b.updated_at)?.getTime() ?? 0) - (toDate(a.updated_at)?.getTime() ?? 0));
    return out;
  }, [d.exps, d.projects]);
  const running = all.filter((e) => e.status === 'running');
  const recent = all.slice(0, 8);
  const projects = d.projects;
  const loading = !projects;
  const empty = projects && projects.length === 0;
  const runningProjects = new Set(running.map((e) => e.project.id)).size;

  return (
    <Page
      crumbs={[{ label: 'Overview' }]}
      actions={
        <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
          New project
        </Button>
      }
    >
      <div class="page-wrap">
        <div class="page-title-row">
          <div class="grow">
            <h1>
              {greeting()}
              {first ? `, ${first}` : ''}
            </h1>
            <p class="page-sub">
              {loading
                ? 'Loading your workspace…'
                : empty
                  ? 'Welcome to Kymo. Log your first metrics in two steps.'
                  : running.length
                    ? `${running.length} ${running.length === 1 ? 'experiment is' : 'experiments are'} running in ${runningProjects} ${runningProjects === 1 ? 'project' : 'projects'}.`
                    : `Nothing is running right now · ${projects!.length} ${projects!.length === 1 ? 'project' : 'projects'}, ${fmtInt(all.length)} experiments.`}
            </p>
          </div>
        </div>

        {empty && <Onboarding />}

        {running.length > 0 && (
          <section class="section first">
            <div class="section-head">
              <span class="status-dot solo status-running" />
              <h2>Running now</h2>
              <span class="count">{running.length}</span>
            </div>
            <div class="running-grid">
              {running.slice(0, 6).map((e) => (
                <RunningCard key={e.id} e={e} />
              ))}
            </div>
          </section>
        )}

        {(loading || (projects && projects.length > 0)) && (
          <section class="section">
            <div class="section-head">
              <h2>Projects</h2>
              {projects && <span class="count">{projects.length}</span>}
              <span class="spacer" />
              <Link href="/projects" class="btn btn-ghost btn-sm">
                All projects <ArrowRight size={14} />
              </Link>
            </div>
            <div class="project-grid">
              {loading
                ? [0, 1, 2].map((i) => (
                    <div class="card project-card" key={i}>
                      <Skeleton w="50%" h={16} />
                      <Skeleton w="80%" />
                      <Skeleton w="40%" />
                    </div>
                  ))
                : projects!.slice(0, 6).map((p) => <ProjectCard key={p.id} project={p} exps={d.exps.get(p.id)} sharing={d.sharing.get(p.id)} />)}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section class="section">
            <div class="section-head">
              <h2>Recent experiments</h2>
            </div>
            <div class="card">
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Experiment</th>
                      <th>Project</th>
                      <th>Status</th>
                      <th class="num">Last step</th>
                      <th class="num">Metrics</th>
                      <th class="num">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((e) => (
                      <tr key={e.id} class="clickable" onClick={(ev) => !(ev.target as Element).closest('a') && navigate('/e/' + e.id)}>
                        <td>
                          <Link href={'/e/' + e.id} class="strong-link">
                            {e.name}
                          </Link>
                        </td>
                        <td>
                          <Link href={'/p/' + e.project.id} class="muted-link">
                            {e.project.name}
                          </Link>
                        </td>
                        <td>
                          <StatusPill status={e.status} />
                        </td>
                        <td class="num mono">{fmtInt(e.last_step)}</td>
                        <td class="num">{e.metric_count}</td>
                        <td class="num muted" title={absTime(e.updated_at)}>
                          {relTime(e.updated_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
      {creating && <ProjectDialog onClose={() => setCreating(false)} onSaved={(p: Project) => navigate('/p/' + p.id)} />}
    </Page>
  );
}

const firstKeyCache = new Map<number, string | null>();

function RunningCard({ e }: { e: ExpRow }) {
  const [series, setSeries] = useState<{ key: string; values: number[]; last: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        let key = firstKeyCache.get(e.id);
        if (key === undefined) {
          const ms = await api.metrics(e.id);
          key = ms[0]?.key ?? null;
          firstKeyCache.set(e.id, key);
        }
        if (key && document.visibilityState === 'visible') {
          const r = await api.query({ series: [{ experiment_id: e.id, key }], max_points: 120 });
          const s = r.series[0];
          const values = (s?.value || []).map((v) => (v == null ? NaN : v));
          if (alive) setSeries({ key, values, last: values.length ? values[values.length - 1] : null });
        } else if (alive && !key) setSeries({ key: '', values: [], last: null });
      } catch {
        /* keep the previous sparkline */
      }
      if (alive) timer = setTimeout(load, 10000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [e.id]);
  return (
    <Link href={'/e/' + e.id} class="card running-card">
      <div class="rc-top">
        <div class="grow" style={{ minWidth: 0 }}>
          <div class="rc-name">{e.name}</div>
          <div class="rc-proj">{e.project.name}</div>
        </div>
        <StatusPill status="running" />
      </div>
      <div class="rc-spark">{series ? <Sparkline values={series.values} color="var(--running)" /> : <Skeleton w="100%" h={44} />}</div>
      <div class="rc-foot">
        <span class="rc-metric" title={series?.key}>
          {series?.key ? (
            <>
              <span class="faint">{series.key}</span> <span class="mono">{fmtNum(series.last)}</span>
            </>
          ) : (
            <span class="faint">waiting for metrics</span>
          )}
        </span>
        <span class="faint tnum">step {fmtInt(e.last_step)}</span>
      </div>
    </Link>
  );
}

function Onboarding() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const t = await api.createToken('first-token');
      setToken(t.token);
      toast('API token created', { description: 'Copy it now: it is shown only once.' });
    } catch (e) {
      toast.error(e, 'Could not create a token');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="onboarding">
      <div class="card ob-step">
        <div class="ob-num">1</div>
        <div class="grow">
          <h3>Create an API token</h3>
          <p class="muted">Scripts authenticate with a token. It can log and read metrics, but cannot manage your account.</p>
          {token ? (
            <div style={{ marginTop: 12 }}>
              <CopyField value={token} />
              <p class="field-hint" style={{ marginTop: 6 }}>
                Shown only once. Manage tokens in <Link href="/settings?s=tokens">Settings</Link>.
              </p>
            </div>
          ) : (
            <Button variant="primary" icon={KeyRound} loading={busy} onClick={create} class="ob-btn">
              Create API token
            </Button>
          )}
        </div>
      </div>
      <div class="card ob-step">
        <div class="ob-num">2</div>
        <div class="grow" style={{ minWidth: 0 }}>
          <h3>Log your first metrics</h3>
          <p class="muted">Use the Python client with a plain dict, or send JSON from anything that speaks HTTP. Projects and experiments are created on first use.</p>
          <div style={{ marginTop: 12 }}>
            <CodeTabs token={token || undefined} />
          </div>
        </div>
      </div>
      <div class="card ob-step ob-wait">
        <div class="ob-num">
          <Activity size={14} />
        </div>
        <div class="grow">
          <h3>Watch it live</h3>
          <p class="muted">Your project appears here as soon as the first points arrive. This page refreshes on its own.</p>
        </div>
      </div>
    </div>
  );
}

export function NoProjects({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState icon={FlaskConical} title="No projects yet" action={<Button variant="primary" icon={Plus} onClick={onCreate}>New project</Button>}>
      Create one here, or just start logging: projects are created automatically on the first ingest.
    </EmptyState>
  );
}
