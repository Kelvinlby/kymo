import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Project } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Shell';
import { FolderKanban, Plus, Search } from '../components/icons';
import { ProjectCard, ProjectDialog } from '../components/project';
import { Button, EmptyState, ErrorBox, SearchInput, Segmented, Skeleton } from '../components/ui';
import { NoProjects } from './Overview';
import { useProjectsData } from '../lib/data';
import { navigate, useLocation } from '../router';

type Scope = 'all' | 'mine' | 'shared';

export function Projects() {
  const { auth } = useAuth();
  const d = useProjectsData();
  const loc = useLocation();
  const [creating, setCreating] = useState(loc.query.get('new') === '1');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  useEffect(() => {
    if (loc.query.get('new') === '1') {
      setCreating(true);
      navigate('/projects', { replace: true });
    }
  }, [loc.search]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (d.projects || []).filter((p) => {
      if (scope === 'mine' && p.owner.id !== auth.user?.id) return false;
      if (scope === 'shared' && p.owner.id === auth.user?.id) return false;
      return !t || (p.name + ' ' + p.description + ' ' + p.owner.username).toLowerCase().includes(t);
    });
  }, [d.projects, q, scope, auth.user?.id]);
  const shared = (d.projects || []).filter((p) => p.owner.id !== auth.user?.id).length;

  return (
    <Page
      crumbs={[{ label: 'Projects' }]}
      actions={
        <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
          New project
        </Button>
      }
    >
      <div class="page-wrap">
        <div class="page-title-row">
          <div class="grow">
            <h1>Projects</h1>
            <p class="page-sub">Everything you own or that has been shared with you.</p>
          </div>
        </div>
        <div class="filter-bar">
          <SearchInput value={q} onInput={setQ} placeholder="Search projects" icon={Search} class="filter-search" />
          <Segmented
            ariaLabel="Show"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: `All ${d.projects ? d.projects.length : ''}` },
              { value: 'mine', label: 'Mine' },
              { value: 'shared', label: `Shared with me${shared ? ' ' + shared : ''}` },
            ]}
          />
        </div>
        <ErrorBox error={d.error} />
        {!d.projects ? (
          <div class="project-grid">
            {[0, 1, 2, 3].map((i) => (
              <div class="card project-card" key={i}>
                <Skeleton w="50%" h={16} />
                <Skeleton w="80%" />
                <Skeleton w="40%" />
              </div>
            ))}
          </div>
        ) : d.projects.length === 0 ? (
          <div class="card">
            <NoProjects onCreate={() => setCreating(true)} />
          </div>
        ) : list.length === 0 ? (
          <div class="card">
            <EmptyState icon={FolderKanban} title="No matching projects" compact action={<Button onClick={() => (setQ(''), setScope('all'))}>Clear filters</Button>} />
          </div>
        ) : (
          <div class="project-grid">
            {list.map((p) => (
              <ProjectCard key={p.id} project={p} exps={d.exps.get(p.id)} sharing={d.sharing.get(p.id)} />
            ))}
          </div>
        )}
      </div>
      {creating && <ProjectDialog onClose={() => setCreating(false)} onSaved={(p: Project) => navigate('/p/' + p.id)} />}
    </Page>
  );
}
