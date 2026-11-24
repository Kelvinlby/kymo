import { useState } from 'preact/hooks';
import { api, type Project } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../components/Shell';
import { ErrorBox, Modal, useAsync } from '../components/ui';
import { absTime, relTime } from '../lib/format';
import { Link, navigate } from '../router';

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function Projects() {
  const { auth } = useAuth();
  const q = useAsync(() => api.projects(), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<unknown>(null);

  const list = (q.data || []).filter((p) => !filter || (p.name + ' ' + p.description + ' ' + p.owner.username).toLowerCase().includes(filter.toLowerCase()));
  list.sort((a, b) => String(b.last_activity ?? b.created_at).localeCompare(String(a.last_activity ?? a.created_at)));
  const canEdit = (p: Project) => auth.user?.is_admin || p.owner.id === auth.user?.id;

  const toggleShare = async (p: Project) => {
    setErr(null);
    try {
      const np = await api.patchProject(p.id, { shared: !p.shared });
      q.setData((q.data || []).map((x) => (x.id === p.id ? { ...x, ...np } : x)));
    } catch (e) {
      setErr(e);
    }
  };
  const remove = async (p: Project) => {
    if (!confirm(`Delete project "${p.name}" and all ${p.experiment_count} experiments? This cannot be undone.`)) return;
    setErr(null);
    try {
      await api.deleteProject(p.id);
      q.reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <Shell crumbs={<span class="cur">Projects</span>}>
      <div class="page">
        <div class="page-head">
          <h1>Projects</h1>
          <span class="spacer" />
          <input type="search" placeholder="Filter projects" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          <button class="primary" onClick={() => setCreating(true)}>
            New project
          </button>
        </div>
        <ErrorBox error={err || q.error} />
        <div class="card">
          {q.loading && !q.data ? (
            <div class="empty">Loading…</div>
          ) : list.length === 0 ? (
            <div class="empty">
              {filter ? 'No matching projects.' : 'No projects yet. Create one, or log from the Python SDK — projects are created automatically on first ingest.'}
            </div>
          ) : (
            <table class="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Owner</th>
                  <th class="num">Experiments</th>
                  <th>Last activity</th>
                  <th>Shared</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} onDblClick={() => navigate('/p/' + p.id)}>
                    <td>
                      <Link href={'/p/' + p.id}>
                        <b>{p.name}</b>
                      </Link>
                      {p.description && <div class="hint" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.description}</div>}
                    </td>
                    <td class="muted">{p.owner.username}</td>
                    <td class="num">{p.experiment_count}</td>
                    <td class="muted" title={absTime(p.last_activity)}>
                      {relTime(p.last_activity)}
                    </td>
                    <td>
                      {canEdit(p) ? (
                        <label class="check" title="Shared projects are read-only visible to all users">
                          <input type="checkbox" checked={p.shared} onChange={() => toggleShare(p)} /> {p.shared ? 'shared' : 'private'}
                        </label>
                      ) : (
                        <span class="badge">{p.shared ? 'shared (read-only)' : 'private'}</span>
                      )}
                    </td>
                    <td class="num">
                      {canEdit(p) && (
                        <span class="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          <button class="small" onClick={() => setEditing(p)}>
                            Rename
                          </button>
                          <button class="small danger" onClick={() => remove(p)}>
                            Delete
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {creating && (
        <ProjectDialog
          onClose={() => setCreating(false)}
          onSave={async (name, description) => {
            const p = await api.createProject(name, description);
            setCreating(false);
            navigate('/p/' + p.id);
          }}
        />
      )}
      {editing && (
        <ProjectDialog
          project={editing}
          onClose={() => setEditing(null)}
          onSave={async (name, description) => {
            await api.patchProject(editing.id, { name, description });
            setEditing(null);
            q.reload();
          }}
        />
      )}
    </Shell>
  );
}

function ProjectDialog(props: { project?: Project; onClose: () => void; onSave: (name: string, description: string) => Promise<void> }) {
  const [name, setName] = useState(props.project?.name || '');
  const [desc, setDesc] = useState(props.project?.description || '');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const valid = NAME_RE.test(name);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid) return setErr(new Error('Name must be 1–64 characters of A-Z a-z 0-9 _ . -'));
    setBusy(true);
    try {
      await props.onSave(name, desc);
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };
  return (
    <Modal title={props.project ? 'Edit project' : 'New project'} onClose={props.onClose}>
      <form class="col" onSubmit={submit}>
        <label class="field">
          Name
          <input autoFocus value={name} class={name && !valid ? 'invalid' : ''} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="llm-pretrain" />
        </label>
        <label class="field">
          Description
          <input value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} />
        </label>
        <ErrorBox error={err} />
        <div class="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button class="primary" disabled={busy}>
            {props.project ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
