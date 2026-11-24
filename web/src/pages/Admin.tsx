import { useState } from 'preact/hooks';
import { api, type AdminUser } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Shell';
import { Ban, KeyRound, Link2, Mail, Plus, Shield, ShieldCheck, Trash, UserCheck, UserPlus, Users as UsersIcon, FingerprintPattern } from '../components/icons';
import { confirmDialog, toast } from '../components/overlay';
import { Alert, Badge, Button, Card, CopyField, Dialog, EmptyState, ErrorBox, Field, MenuItem, MenuSep, Segmented, Skeleton, Switch, useAsync } from '../components/ui';
import { absTime, relTime, toDate } from '../lib/format';
import { navigate, useLocation } from '../router';
import { RowMenu, SubNav } from './Settings';

type Section = 'users' | 'invites' | 'policy';
const SECTIONS: { id: Section; label: string; icon: typeof Shield }[] = [
  { id: 'users', label: 'Users', icon: UsersIcon },
  { id: 'invites', label: 'Invites', icon: Mail },
  { id: 'policy', label: 'Security policy', icon: ShieldCheck },
];

export function Admin() {
  const loc = useLocation();
  const s = (loc.query.get('s') as Section) || 'users';
  const section = SECTIONS.some((x) => x.id === s) ? s : 'users';
  return (
    <Page crumbs={[{ label: 'Admin' }]}>
      <div class="page-wrap narrow">
        <div class="page-title-row">
          <div class="grow">
            <h1>Administration</h1>
            <p class="page-sub">Manage who can use this Kymo server and how they sign in.</p>
          </div>
        </div>
        <div class="subnav-layout">
          <SubNav label="Admin sections" items={SECTIONS} value={section} onChange={(v) => navigate('/admin?s=' + v, { replace: true })} />
          <div class="subnav-content">
            {section === 'users' && <Users />}
            {section === 'invites' && <Invites />}
            {section === 'policy' && <Policy />}
          </div>
        </div>
      </div>
    </Page>
  );
}

// ------------------------------------------------------------------------------------- policy
function Policy() {
  const { refresh } = useAuth();
  const q = useAsync(() => api.settings(), []);
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    if (next) {
      const ok = await confirmDialog({
        title: 'Require passkeys for everyone?',
        message: 'Users without a passkey will be asked to register one on their next request before they can continue.',
        confirmLabel: 'Require passkeys',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      q.setData(await api.putSettings({ passkey_required_for_all: next }));
      toast(next ? 'Passkeys are now required for everyone' : 'Passkeys are now optional for users');
      refresh().catch(() => {});
    } catch (e) {
      toast.error(e, 'Could not update the policy');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Sign-in security" description="Passkeys add a second factor (device screen lock or security key) after the password.">
      <ErrorBox error={q.error} />
      {!q.data ? (
        <Skeleton w="60%" h={20} />
      ) : (
        <Switch
          label="Require a passkey for every user"
          description="When off, users choose for themselves. The administrator always needs a passkey, and anyone who has registered one is always asked for it."
          checked={q.data.passkey_required_for_all}
          disabled={busy}
          onChange={toggle}
        />
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------------- users
function Users() {
  const { auth } = useAuth();
  const q = useAsync(() => api.users(), []);
  const [link, setLink] = useState<{ user: string; url: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      q.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const self = (u: AdminUser) => u.id === auth.user?.id;
  const active = (q.data || []).filter((u) => !u.disabled).length;
  return (
    <>
      <Card
        title="Users"
        description={q.data ? `${q.data.length} accounts · ${active} active` : undefined}
        actions={
          <Button size="sm" icon={UserPlus} onClick={() => navigate('/admin?s=invites&new=1', { replace: true })}>
            Invite user
          </Button>
        }
        flush
      >
        <ErrorBox error={q.error} />
        {!q.data ? (
          <div class="card-body col">
            <Skeleton w="70%" />
            <Skeleton w="50%" />
          </div>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Status</th>
                  <th class="num">Passkeys</th>
                  <th>Created</th>
                  <th>Last sign-in</th>
                  <th class="actions" />
                </tr>
              </thead>
              <tbody>
                {q.data.map((u) => (
                  <tr key={u.id} class={u.disabled ? 'row-dim' : ''}>
                    <td>
                      <div class="cell-user">
                        <div style={{ minWidth: 0 }}>
                          <div class="cell-user-name">
                            {u.display_name || u.username} {u.is_admin && <Badge tone="accent">Admin</Badge>} {self(u) && <Badge>You</Badge>}
                          </div>
                          <div class="cell-user-sub">@{u.username}</div>
                        </div>
                      </div>
                    </td>
                    <td>{u.disabled ? <Badge tone="danger">Disabled</Badge> : <Badge tone="success">Active</Badge>}</td>
                    <td class="num">{u.passkey_count}</td>
                    <td class="muted" title={absTime(u.created_at)}>
                      {relTime(u.created_at)}
                    </td>
                    <td class="muted" title={absTime(u.last_login_at)}>
                      {u.last_login_at ? relTime(u.last_login_at) : 'Never'}
                    </td>
                    <td class="actions">
                      <RowMenu label={`Actions for ${u.username}`}>
                        {(close) => (
                          <>
                            <MenuItem
                              icon={Link2}
                              onSelect={() => {
                                close();
                                api.resetPasswordLink(u.id).then(
                                  (r) => setLink({ user: u.username, url: r.url }),
                                  (e) => toast.error(e),
                                );
                              }}
                            >
                              Password reset link
                            </MenuItem>
                            <MenuItem
                              icon={FingerprintPattern}
                              disabled={u.passkey_count === 0}
                              onSelect={async () => {
                                close();
                                if (await confirmDialog({ title: `Remove all passkeys of ${u.username}?`, message: 'They will need to register a new passkey if one is required.', confirmLabel: 'Remove passkeys', danger: true }))
                                  run(() => api.patchUser(u.id, { reset_passkeys: true }), 'Passkeys removed');
                              }}
                            >
                              Reset passkeys
                            </MenuItem>
                            {!self(u) && (
                              <>
                                <MenuItem
                                  icon={u.disabled ? UserCheck : Ban}
                                  onSelect={async () => {
                                    close();
                                    if (!u.disabled && !(await confirmDialog({ title: `Disable ${u.username}?`, message: 'They are signed out and their API tokens stop working until you enable the account again.', confirmLabel: 'Disable account', danger: true })))
                                      return;
                                    run(() => api.patchUser(u.id, { disabled: !u.disabled }), u.disabled ? 'Account enabled' : 'Account disabled');
                                  }}
                                >
                                  {u.disabled ? 'Enable account' : 'Disable account'}
                                </MenuItem>
                                <MenuSep />
                                <MenuItem
                                  icon={Trash}
                                  danger
                                  onSelect={async () => {
                                    close();
                                    if (await confirmDialog({ title: `Delete ${u.username}?`, message: 'This deletes the account and all projects it owns, with every experiment and metric. This cannot be undone.', confirmLabel: 'Delete user', danger: true }))
                                      run(() => api.deleteUser(u.id), 'User deleted');
                                  }}
                                >
                                  Delete user
                                </MenuItem>
                              </>
                            )}
                          </>
                        )}
                      </RowMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {link && (
        <Dialog title={`Password reset link for ${link.user}`} description="Send this one-time link to the user. It lets them choose a new password." icon={KeyRound} onClose={() => setLink(null)} footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
          <CopyField value={link.url} />
        </Dialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------- invites
function Invites() {
  const loc = useLocation();
  const q = useAsync(() => api.invites(), []);
  const [creating, setCreating] = useState(loc.query.get('new') === '1');
  const [created, setCreated] = useState<{ url: string; username: string | null; expires_at: string | number } | null>(null);
  const now = Date.now();
  const state = (i: { used_at: unknown; expires_at: string | number }) => {
    if (i.used_at) return <Badge>Used</Badge>;
    const d = toDate(i.expires_at);
    if (d && d.getTime() < now) return <Badge tone="danger">Expired</Badge>;
    return <Badge tone="success">Open</Badge>;
  };
  return (
    <>
      <Card
        title="Invites"
        description="Accounts are created by invitation only. Each link works once."
        actions={
          <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
            Create invite
          </Button>
        }
        flush
      >
        <ErrorBox error={q.error} />
        {!q.data ? (
          <div class="card-body col">
            <Skeleton w="60%" />
          </div>
        ) : q.data.length === 0 ? (
          <EmptyState icon={Mail} title="No invites yet" compact action={<Button icon={Plus} onClick={() => setCreating(true)}>Create invite</Button>}>
            Create an invite link and send it to a teammate.
          </EmptyState>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>For</th>
                  <th>State</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Used</th>
                  <th class="actions" />
                </tr>
              </thead>
              <tbody>
                {q.data.map((i) => (
                  <tr key={i.id}>
                    <td>{i.username ? <b class="cell-strong">@{i.username}</b> : <span class="muted">Anyone with the link</span>}</td>
                    <td>{state(i)}</td>
                    <td class="muted" title={absTime(i.created_at)}>
                      {relTime(i.created_at)}
                    </td>
                    <td class="muted" title={absTime(i.expires_at)}>
                      {relTime(i.expires_at)}
                    </td>
                    <td class="muted">{i.used_at ? relTime(i.used_at) : '—'}</td>
                    <td class="actions">
                      {!i.used_at && (
                        <RowMenu label="Invite actions">
                          {(close) => (
                            <MenuItem
                              icon={Trash}
                              danger
                              onSelect={async () => {
                                close();
                                if (!(await confirmDialog({ title: 'Revoke this invite?', message: 'The link stops working immediately.', confirmLabel: 'Revoke invite', danger: true }))) return;
                                try {
                                  await api.deleteInvite(i.id);
                                  toast('Invite revoked');
                                  q.reload();
                                } catch (e) {
                                  toast.error(e);
                                }
                              }}
                            >
                              Revoke invite
                            </MenuItem>
                          )}
                        </RowMenu>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && (
        <CreateInviteDialog
          onClose={() => {
            setCreating(false);
            if (loc.query.get('new')) navigate('/admin?s=invites', { replace: true });
          }}
          onCreated={(r) => {
            setCreating(false);
            setCreated(r);
            q.reload();
          }}
        />
      )}
      {created && (
        <Dialog
          title="Invite link created"
          description={created.username ? `For @${created.username}. It works once and expires ${relTime(created.expires_at)}.` : `Anyone with the link can create one account. It expires ${relTime(created.expires_at)}.`}
          icon={Link2}
          onClose={() => setCreated(null)}
          footer={
            <Button variant="primary" onClick={() => setCreated(null)}>
              Done
            </Button>
          }
        >
          <Alert tone="info">This link is shown only once. Copy it now and send it to the person you're inviting.</Alert>
          <CopyField value={created.url} />
        </Dialog>
      )}
    </>
  );
}

function CreateInviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { url: string; username: string | null; expires_at: string | number }) => void }) {
  const [username, setUsername] = useState('');
  const [hours, setHours] = useState(72);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const uErr = username && !/^[a-z0-9_.-]{2,32}$/.test(username) ? '2–32 characters: a–z, 0–9, “_”, “.”, “-”' : null;
  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (uErr) return;
    setBusy(true);
    setErr(null);
    try {
      onCreated(await api.createInvite({ username: username.trim() || undefined, expires_hours: hours }));
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Create invite"
      icon={UserPlus}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => submit()} disabled={!!uErr}>
            Create link
          </Button>
        </>
      }
    >
      <form class="form" onSubmit={submit}>
        <Field label="Username" optional error={uErr} hint="Reserve a username, or leave empty to let the person choose.">
          <input class="input" data-autofocus value={username} placeholder="alice" aria-invalid={!!uErr} onInput={(e) => setUsername((e.target as HTMLInputElement).value.toLowerCase())} spellcheck={false} />
        </Field>
        <div class="field">
          <span class="field-label">Expires after</span>
          <Segmented
            size="md"
            ariaLabel="Expiry"
            value={hours}
            onChange={setHours}
            options={[
              { value: 24, label: '1 day' },
              { value: 72, label: '3 days' },
              { value: 168, label: '7 days' },
              { value: 720, label: '30 days' },
            ]}
          />
        </div>
        {!!err && <Alert tone="danger">{(err as Error).message}</Alert>}
      </form>
    </Dialog>
  );
}
