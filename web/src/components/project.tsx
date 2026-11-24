// Project building blocks: sharing summary, share dialog, create/rename dialog, actions menu, card.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, ApiError, canManage, everyoneRole, projectRole, type Experiment, type Project, type ProjectRole, type ShareRole, type Sharing, type UserRef } from '../api';
import { useAuth } from '../auth';
import { refreshProjects, statusCounts } from '../lib/data';
import { absTime, relTime } from '../lib/format';
import { Link, navigate } from '../router';
import { Ellipsis, FolderKanban, Globe, Lock, Pencil, Search, Trash, Users } from './icons';
import { confirmDialog, toast } from './overlay';
import { Alert, Badge, Button, Dialog, Field, IconButton, MenuItem, MenuSep, Popover, SearchInput, Segmented, Skeleton, cx } from './ui';

export const ROLE_LABEL: Record<ProjectRole, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
const userName = (u: UserRef) => u.display_name || u.username;

// ------------------------------------------------------------------------------------- summary
export function SharingSummary({ project, sharing, showPrivate = true }: { project: Project; sharing?: Sharing | null; showPrivate?: boolean }) {
  const ev = everyoneRole(project);
  const members = sharing?.members || [];
  const count = sharing ? members.length : project.member_count ?? 0;
  const names = members.map((m) => `${userName(m.user)} (${m.role})`).join(', ');
  return (
    <span class="share-summary">
      {count > 0 && (
        <span class="member-count" title={names || `${count} member${count === 1 ? '' : 's'}`}>
          <Users size={13} aria-hidden="true" />
          {count}
        </span>
      )}
      {ev && (
        <Badge tone="info" title={`Everyone on this server can ${ev === 'editor' ? 'view and edit' : 'view'} this project`}>
          <Globe size={11} aria-hidden="true" />
          Everyone · {ev === 'editor' ? 'Editor' : 'Viewer'}
        </Badge>
      )}
      {!ev && count === 0 && showPrivate && (
        <Badge title="Only the owner (and the administrator) can see this project">
          <Lock size={11} aria-hidden="true" />
          Private
        </Badge>
      )}
    </span>
  );
}

// ------------------------------------------------------------------------------------- share dialog
export function ShareDialog({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved?: (s: Sharing) => void }) {
  const [users, setUsers] = useState<UserRef[] | null>(null);
  const [everyone, setEveryone] = useState<ShareRole | null>(null);
  const [members, setMembers] = useState<Map<number, ShareRole>>(new Map());
  const [initial, setInitial] = useState('');
  const [initialMembers, setInitialMembers] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.sharing(project.id), api.directory()]).then(
      ([s, us]) => {
        setEveryone(s.everyone);
        const m = new Map(s.members.map((x) => [x.user.id, x.role] as const));
        setMembers(m);
        // keep members that are not in the directory (e.g. disabled) visible
        const all = new Map(us.map((u) => [u.id, u]));
        for (const x of s.members) if (!all.has(x.user.id)) all.set(x.user.id, x.user);
        setUsers([...all.values()]);
        setInitial(key(s.everyone, m));
        setInitialMembers(new Set(m.keys()));
      },
      (e) => setErr(e),
    );
  }, [project.id]);

  const key = (ev: ShareRole | null, m: Map<number, ShareRole>) => (ev || '-') + '|' + [...m.entries()].sort((a, b) => a[0] - b[0]).map((x) => x.join(':')).join(',');
  const dirty = users !== null && key(everyone, members) !== initial;

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (users || [])
      .filter((u) => u.id !== project.owner.id)
      .filter((u) => !t || u.username.toLowerCase().includes(t) || (u.display_name || '').toLowerCase().includes(t))
      .sort((a, b) => Number(initialMembers.has(b.id)) - Number(initialMembers.has(a.id)) || userName(a).localeCompare(userName(b)));
  }, [users, q, initialMembers, project.owner.id]);

  const setRole = (id: number, r: ShareRole | null) => {
    const m = new Map(members);
    if (r) m.set(id, r);
    else m.delete(id);
    setMembers(m);
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api.putSharing(project.id, { everyone, members: [...members.entries()].map(([user_id, role]) => ({ user_id, role })) });
      toast('Sharing updated', { description: `${project.name} · ${describe(s)}` });
      onSaved?.(s);
      refreshProjects();
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };

  const unavailable = err instanceof ApiError && err.status === 404 && users === null;
  const owner = (users || []).find((u) => u.id === project.owner.id) || project.owner;

  return (
    <Dialog
      title={`Share “${project.name}”`}
      description="Viewers can open the project. Editors can also edit experiments and log runs into it with their API token."
      icon={Users}
      size="lg"
      onClose={onClose}
      class="share-dialog"
      footer={
        <>
          <span class="left faint share-foot-note">{users ? describe({ everyone, members: [...members].map(([id, role]) => ({ user: { id, username: '' }, role })) }) : ''}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>
            Save changes
          </Button>
        </>
      }
    >
      {unavailable ? (
        <Alert tone="warning" title="Sharing isn't available on this server yet">
          The server doesn't provide the project sharing API. Update the Kymo server to manage members.
        </Alert>
      ) : (
        err && <Alert tone="danger">{(err as Error).message}</Alert>
      )}
      {!unavailable && (
        <>
          <div class="share-everyone">
            <span class="share-ev-icon">
              <Globe size={17} aria-hidden="true" />
            </span>
            <div class="grow">
              <div class="share-name">Everyone on this server</div>
              <div class="share-sub">Every current and future user, unless a member role below is higher.</div>
            </div>
            {users ? (
              <select class="select select-sm" style={{ width: 128 }} value={everyone || ''} aria-label="Role for everyone" onChange={(e) => setEveryone(((e.target as HTMLSelectElement).value || null) as ShareRole | null)}>
                <option value="">No access</option>
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
            ) : (
              <Skeleton w={128} h={28} />
            )}
          </div>
          <div class="share-people">
            <div class="row" style={{ marginBottom: 8 }}>
              <SearchInput value={q} onInput={setQ} placeholder="Search people by name or username" icon={Search} class="grow" />
            </div>
            <div class="share-list" role="list">
              <div class="share-row" role="listitem">
                <span class="share-check" />
                <div class="grow share-who">
                  <div class="share-name">{userName(owner)}</div>
                  <div class="share-sub">@{owner.username}</div>
                </div>
                <Badge tone="accent">Owner</Badge>
              </div>
              {!users &&
                [0, 1, 2].map((i) => (
                  <div class="share-row" key={i}>
                    <span class="share-check" />
                    <Skeleton w="40%" />
                  </div>
                ))}
              {users && list.length === 0 && <div class="share-empty">{q ? 'Nobody matches “' + q + '”.' : 'There are no other users yet. Invite people from the admin page.'}</div>}
              {list.map((u) => {
                const r = members.get(u.id);
                const id = 'share-u' + u.id;
                return (
                  <div class={cx('share-row', r && 'on')} role="listitem" key={u.id}>
                    <input id={id} type="checkbox" class="checkbox share-check" checked={!!r} onChange={() => setRole(u.id, r ? null : 'viewer')} aria-label={`Give ${userName(u)} access`} />
                    <label class="grow share-who" for={id}>
                      <div class="share-name">{userName(u)}</div>
                      <div class="share-sub">@{u.username}</div>
                    </label>
                    {r ? (
                      <Segmented
                        ariaLabel={`Role for ${userName(u)}`}
                        value={r}
                        onChange={(v) => setRole(u.id, v)}
                        options={[
                          { value: 'viewer', label: 'Viewer' },
                          { value: 'editor', label: 'Editor' },
                        ]}
                      />
                    ) : (
                      <span class="share-noaccess">{everyone ? 'via Everyone' : 'No access'}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}

function describe(s: { everyone: ShareRole | null; members: unknown[] }) {
  const n = s.members.length;
  const parts = [];
  if (n) parts.push(`${n} ${n === 1 ? 'member' : 'members'}`);
  if (s.everyone) parts.push(`everyone can ${s.everyone === 'editor' ? 'edit' : 'view'}`);
  return parts.length ? parts.join(', ') : 'private';
}

// ------------------------------------------------------------------------------------- create / rename
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function ProjectDialog(props: { project?: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const [name, setName] = useState(props.project?.name || '');
  const [desc, setDesc] = useState(props.project?.description || '');
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const nameErr = !name ? 'A name is required' : !NAME_RE.test(name) ? 'Use 1–64 letters, digits, “_”, “.” or “-” (no spaces)' : null;
  const submit = async (e?: Event) => {
    e?.preventDefault();
    setTouched(true);
    if (nameErr) return;
    setBusy(true);
    setErr(null);
    try {
      const p = props.project ? await api.patchProject(props.project.id, { name, description: desc }) : await api.createProject(name, desc || undefined);
      refreshProjects();
      props.onSaved(p);
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={props.project ? 'Edit project' : 'New project'}
      description={props.project ? undefined : 'Projects group related experiments. They are also created automatically on the first ingest.'}
      icon={FolderKanban}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => submit()}>
            {props.project ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <form class="form" onSubmit={submit}>
        <Field label="Name" error={touched && nameErr} hint="Used in API calls, e.g. “project”: “llm-pretrain”.">
          <input class="input" data-autofocus value={name} aria-invalid={!!(touched && nameErr)} onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={() => setTouched(true)} placeholder="llm-pretrain" spellcheck={false} />
        </Field>
        <Field label="Description" optional>
          <input class="input" value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} placeholder="What is this project about?" />
        </Field>
        {!!err && <Alert tone="danger">{(err as Error).message}</Alert>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------- actions menu
export function useProjectActions(project: Project | null, opts: { onChanged?: (p: Project) => void; onSharing?: (s: Sharing) => void; afterDelete?: () => void } = {}) {
  const [dlg, setDlg] = useState<'rename' | 'share' | null>(null);
  const remove = async () => {
    if (!project) return;
    const ok = await confirmDialog({
      title: `Delete “${project.name}”?`,
      message: `This permanently deletes the project and its ${project.experiment_count} experiments with all their metrics. This cannot be undone.`,
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProject(project.id);
      toast('Project deleted', { description: project.name });
      refreshProjects();
      opts.afterDelete?.();
    } catch (e) {
      toast.error(e, 'Could not delete the project');
    }
  };
  const dialogs = project && (
    <>
      {dlg === 'rename' && (
        <ProjectDialog
          project={project}
          onClose={() => setDlg(null)}
          onSaved={(p) => {
            setDlg(null);
            toast('Project updated');
            opts.onChanged?.(p);
          }}
        />
      )}
      {dlg === 'share' && <ShareDialog project={project} onClose={() => setDlg(null)} onSaved={opts.onSharing} />}
    </>
  );
  return { openRename: () => setDlg('rename'), openShare: () => setDlg('share'), remove, dialogs };
}

export function ProjectMenu({ project, actions, variant = 'ghost' }: { project: Project; actions: ReturnType<typeof useProjectActions>; variant?: 'ghost' | 'secondary' }) {
  const { auth } = useAuth();
  const role = projectRole(project, auth.user);
  if (!canManage(role)) return null;
  return (
    <Popover
      menu
      placement="bottom-end"
      width={200}
      trigger={(p) => (
        <IconButton
          btnRef={p.ref as any}
          icon={Ellipsis}
          label="Project actions"
          variant={variant}
          size={variant === 'secondary' ? 'md' : 'sm'}
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            p.toggle();
          }}
          aria-expanded={p.open}
          aria-haspopup="menu"
        />
      )}
    >
      {(close) => (
        <>
          <MenuItem icon={Pencil} onSelect={() => (close(), actions.openRename())}>
            Rename…
          </MenuItem>
          <MenuItem icon={Users} onSelect={() => (close(), actions.openShare())}>
            Share…
          </MenuItem>
          <MenuSep />
          <MenuItem icon={Trash} danger onSelect={() => (close(), actions.remove())}>
            Delete project
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

// ------------------------------------------------------------------------------------- card
export function StatusCounts({ exps, total }: { exps?: Experiment[]; total: number }) {
  if (!exps) return <span class="status-counts faint">{total} experiments</span>;
  const c = statusCounts(exps);
  const items = (['running', 'finished', 'failed', 'crashed'] as const).filter((s) => c[s] > 0);
  return (
    <span class="status-counts">
      <span class="sc-total">
        {c.total} {c.total === 1 ? 'run' : 'runs'}
      </span>
      {items.map((s) => (
        <span class={'sc sc-' + s} key={s} title={`${c[s]} ${s}`}>
          <span class={'status-dot solo status-' + s} />
          {c[s]} {s}
        </span>
      ))}
    </span>
  );
}

export function ProjectCard({ project, exps, sharing }: { project: Project; exps?: Experiment[]; sharing?: Sharing }) {
  const { auth } = useAuth();
  const role = projectRole(project, auth.user);
  const actions = useProjectActions(project);
  const mine = project.owner.id === auth.user?.id;
  const running = project.running_count ?? statusCounts(exps).running;
  return (
    <div class="project-card card">
      <Link href={'/p/' + project.id} class="pc-link" aria-label={`Open ${project.name}`} />
      <div class="pc-top">
        <span class={cx('pc-icon', running > 0 && 'live')}>
          <FolderKanban size={17} aria-hidden="true" />
        </span>
        <div class="pc-titles">
          <div class="pc-name">{project.name}</div>
          <div class="pc-owner">{mine ? 'Owned by you' : `by ${project.owner.display_name || project.owner.username}`}</div>
        </div>
        {role !== 'owner' && <Badge tone={role === 'viewer' ? 'neutral' : 'accent'}>{ROLE_LABEL[role]}</Badge>}
        <div class="pc-menu">
          <ProjectMenu project={project} actions={actions} />
        </div>
      </div>
      <p class={cx('pc-desc', !project.description && 'faint')}>{project.description || 'No description'}</p>
      <StatusCounts exps={exps} total={project.experiment_count} />
      <div class="pc-foot">
        <span class="faint" title={absTime(project.last_activity)}>
          {project.last_activity ? 'Active ' + relTime(project.last_activity) : 'No activity yet'}
        </span>
        <SharingSummary project={project} sharing={sharing} />
      </div>
      {actions.dialogs}
    </div>
  );
}

export function goProject(p: Project) {
  navigate('/p/' + p.id);
}
