import { useState } from 'preact/hooks';
import { api, type AdminUser } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../components/Shell';
import { CopyField, ErrorBox, Modal, useAsync } from '../components/ui';
import { absTime, relTime, toDate } from '../lib/format';

export function Admin() {
  return (
    <Shell crumbs={<span class="cur">Admin</span>}>
      <div class="page">
        <div class="page-head">
          <h1>Administration</h1>
        </div>
        <Policy />
        <Users />
        <Invites />
      </div>
    </Shell>
  );
}

function Policy() {
  const { refresh } = useAuth();
  const q = useAsync(() => api.settings(), []);
  const [err, setErr] = useState<unknown>(null);
  const toggle = async () => {
    if (!q.data) return;
    const next = !q.data.passkey_required_for_all;
    if (next && !confirm('Require a passkey for all users? Users without one must register a passkey at their next request.')) return;
    try {
      q.setData(await api.putSettings({ passkey_required_for_all: next }));
      refresh().catch(() => {});
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div class="card section">
      <div class="card-head">
        <h2>Site policy</h2>
      </div>
      <div class="card-body col">
        <ErrorBox error={err || q.error} />
        <label class="check">
          <input type="checkbox" checked={!!q.data?.passkey_required_for_all} disabled={!q.data} onChange={toggle} />
          Require passkey for all users
        </label>
        <div class="hint">The administrator always needs a passkey. Users who have registered a passkey always need it at sign-in, regardless of this setting.</div>
      </div>
    </div>
  );
}

function Users() {
  const { auth } = useAuth();
  const q = useAsync(() => api.users(), []);
  const [err, setErr] = useState<unknown>(null);
  const [link, setLink] = useState<{ user: string; url: string } | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      q.reload();
    } catch (e) {
      setErr(e);
    }
  };
  const self = (u: AdminUser) => u.id === auth.user?.id;
  return (
    <div class="card section">
      <div class="card-head">
        <h2 class="grow">Users</h2>
        <span class="hint">{q.data?.length ?? 0} users</span>
      </div>
      <ErrorBox error={err || q.error} />
      <div style={{ overflowX: 'auto' }}>
        <table class="tbl">
          <thead>
            <tr>
              <th>User</th>
              <th>Status</th>
              <th class="num">Passkeys</th>
              <th>Created</th>
              <th>Last login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(q.data || []).map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.username}</b> {u.display_name && u.display_name !== u.username && <span class="muted">{u.display_name}</span>} {u.is_admin && <span class="badge admin">admin</span>}
                </td>
                <td>{u.disabled ? <span class="badge failed">disabled</span> : <span class="badge finished">active</span>}</td>
                <td class="num">{u.passkey_count}</td>
                <td class="muted" title={absTime(u.created_at)}>
                  {relTime(u.created_at)}
                </td>
                <td class="muted" title={absTime(u.last_login_at)}>
                  {u.last_login_at ? relTime(u.last_login_at) : 'never'}
                </td>
                <td class="num">
                  <span class="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                    {!self(u) && (
                      <button class="small" onClick={() => act(() => api.patchUser(u.id, { disabled: !u.disabled }))}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    )}
                    <button
                      class="small"
                      disabled={u.passkey_count === 0}
                      onClick={() => confirm(`Remove all passkeys of ${u.username}?`) && act(() => api.patchUser(u.id, { reset_passkeys: true }))}
                    >
                      Reset passkeys
                    </button>
                    <button
                      class="small"
                      onClick={() =>
                        act(async () => {
                          const r = await api.resetPasswordLink(u.id);
                          setLink({ user: u.username, url: r.url });
                        })
                      }
                    >
                      Reset password
                    </button>
                    {!self(u) && (
                      <button
                        class="small danger"
                        onClick={() => confirm(`Delete user ${u.username} and all their projects? This cannot be undone.`) && act(() => api.deleteUser(u.id))}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {link && (
        <Modal title={`Password reset link for ${link.user}`} onClose={() => setLink(null)}>
          <div class="hint">Send this one-time link to the user. It lets them set a new password.</div>
          <CopyField value={link.url} />
        </Modal>
      )}
    </div>
  );
}

function Invites() {
  const q = useAsync(() => api.invites(), []);
  const [username, setUsername] = useState('');
  const [hours, setHours] = useState(72);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const create = async (e: Event) => {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api.createInvite({ username: username.trim() || undefined, expires_hours: hours });
      setCreated(r.url);
      setUsername('');
      q.reload();
    } catch (e2) {
      setErr(e2);
    }
  };
  const now = Date.now();
  const state = (i: { used_at: unknown; expires_at: string | number }) => {
    if (i.used_at) return <span class="badge">used</span>;
    const d = toDate(i.expires_at);
    if (d && d.getTime() < now) return <span class="badge failed">expired</span>;
    return <span class="badge running">open</span>;
  };
  return (
    <div class="card section">
      <div class="card-head">
        <h2 class="grow">Invites</h2>
        <form class="row" onSubmit={create}>
          <input placeholder="username (optional)" value={username} pattern="[a-z0-9_.\-]{2,32}" onInput={(e) => setUsername((e.target as HTMLInputElement).value.toLowerCase())} />
          <select value={hours} onChange={(e) => setHours(Number((e.target as HTMLSelectElement).value))}>
            <option value={24}>1 day</option>
            <option value={72}>3 days</option>
            <option value={168}>7 days</option>
            <option value={720}>30 days</option>
          </select>
          <button class="primary">Create invite</button>
        </form>
      </div>
      <ErrorBox error={err || q.error} />
      {created && (
        <div class="card-body col" style={{ borderBottom: '1px solid var(--border)' }}>
          <div class="hint">Invite link (shown once — copy it now):</div>
          <CopyField value={created} />
        </div>
      )}
      {q.data && q.data.length > 0 ? (
        <table class="tbl">
          <thead>
            <tr>
              <th>For</th>
              <th>State</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((i) => (
              <tr key={i.id}>
                <td>{i.username || <span class="faint">anyone</span>}</td>
                <td>{state(i)}</td>
                <td class="muted" title={absTime(i.created_at)}>
                  {relTime(i.created_at)}
                </td>
                <td class="muted" title={absTime(i.expires_at)}>
                  {relTime(i.expires_at)}
                </td>
                <td class="muted">{i.used_at ? relTime(i.used_at) : '—'}</td>
                <td class="num">
                  {!i.used_at && (
                    <button
                      class="small danger"
                      onClick={async () => {
                        try {
                          await api.deleteInvite(i.id);
                          q.reload();
                        } catch (e) {
                          setErr(e);
                        }
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !q.loading && <div class="empty">No invites.</div>
      )}
    </div>
  );
}
