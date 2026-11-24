// Shared, polled cache of the user's projects and their experiment lists. Used by the sidebar,
// overview, projects page and the command palette so they agree and don't refetch separately.
import { useEffect, useState } from 'preact/hooks';
import { api, type Experiment, type Project } from '../api';
import { toDate } from './format';

export interface ProjectsData {
  projects: Project[] | null;
  exps: Map<number, Experiment[]>;
  error: unknown;
  loading: boolean;
}

const MAX_PROJECTS_WITH_RUNS = 40;
const POLL_MS = 15000;
const POLL_RUNNING_MS = 6000;

let data: ProjectsData = { projects: null, exps: new Map(), error: null, loading: false };
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

const emit = () => subs.forEach((f) => f());

export const lastActivity = (p: Project) => toDate(p.last_activity ?? p.created_at)?.getTime() ?? 0;

async function load(): Promise<void> {
  if (inflight) return inflight;
  data = { ...data, loading: true };
  inflight = (async () => {
    try {
      const projects = await api.projects();
      projects.sort((a, b) => lastActivity(b) - lastActivity(a));
      const exps = new Map<number, Experiment[]>();
      await Promise.all(
        projects.slice(0, MAX_PROJECTS_WITH_RUNS).map(async (p) => {
          try {
            exps.set(p.id, await api.experiments(p.id));
          } catch {
            const old = data.exps.get(p.id);
            if (old) exps.set(p.id, old);
          }
        }),
      );
      data = { projects, exps, error: null, loading: false };
    } catch (e) {
      data = { ...data, error: e, loading: false };
    } finally {
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

function schedule() {
  if (timer) clearTimeout(timer);
  if (!subs.size) return;
  const anyRunning = [...data.exps.values()].some((l) => l.some((e) => e.status === 'running'));
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await load();
    schedule();
  }, anyRunning ? POLL_RUNNING_MS : POLL_MS);
}

/** Force a reload (after creating / renaming / deleting things). */
export function refreshProjects(): Promise<void> {
  return load().then(schedule);
}

/** Patch a project locally (optimistic). */
export function patchProjectLocal(p: Project) {
  if (!data.projects) return;
  data = { ...data, projects: data.projects.map((x) => (x.id === p.id ? { ...x, ...p } : x)) };
  emit();
}

export function useProjectsData(): ProjectsData {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    subs.add(f);
    if (!data.projects && !inflight) load().then(schedule);
    else if (subs.size === 1) schedule();
    return () => {
      subs.delete(f);
      if (!subs.size && timer) clearTimeout(timer);
    };
  }, []);
  return data;
}

export function statusCounts(list: Experiment[] | undefined) {
  const c = { running: 0, finished: 0, failed: 0, crashed: 0, total: 0 };
  for (const e of list || []) {
    c[e.status]++;
    c.total++;
  }
  return c;
}
