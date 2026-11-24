import { useState } from 'preact/hooks';
import { api } from '../api';
import { useAuth } from '../auth';
import { Shell } from '../components/Shell';
import { CopyButton, CopyField, ErrorBox, Modal, useAsync } from '../components/ui';
import { absTime, relTime } from '../lib/format';
import { defaultPasskeyName, registerPasskey } from '../lib/passkey';
import { describeWebauthnError } from '../lib/webauthn';

export function Settings() {
  return (
    <Shell crumbs={<span class="cur">Settings</span>}>
      <div class="page" style={{ maxWidth: 860 }}>
        <div class="page-head">
          <h1>Settings</h1>
        </div>
        <Tokens />
        <Passkeys />
        <Password />
      </div>
    </Shell>
  );
}

function Tokens() {
  const q = useAsync(() => api.tokens(), []);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const create = async (e: Event) => {
    e.preventDefault();
    setErr(null);
    try {
      const t = await api.createToken(name.trim() || 'token');
      setCreated({ name: t.name, token: t.token });
      setName('');
      q.reload();
    } catch (e2) {
      setErr(e2);
    }
  };
  const del = async (id: number, n: string) => {
    if (!confirm(`Revoke token "${n}"? Scripts using it will stop working.`)) return;
    try {
      await api.deleteToken(id);
      q.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div class="card section">
      <div class="card-head">
        <h2 class="grow">API tokens</h2>
        <form class="row" onSubmit={create}>
          <input placeholder="Token name, e.g. cluster-a" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button class="primary">Create token</button>
        </form>
      </div>
      <div class="card-body" style={{ padding: 0 }}>
        <div style={{ padding: '8px 12px' }} class="hint">
          Tokens authenticate the Python SDK for ingest and reads. They cannot manage your account.
        </div>
        <ErrorBox error={err || q.error} />
        {q.data && q.data.length > 0 ? (
          <table class="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td class="mono">{t.prefix}…</td>
                  <td class="muted" title={absTime(t.created_at)}>
                    {relTime(t.created_at)}
                  </td>
                  <td class="muted" title={absTime(t.last_used_at)}>
                    {t.last_used_at ? relTime(t.last_used_at) : 'never'}
                  </td>
                  <td class="num">
                    <button class="small danger" onClick={() => del(t.id, t.name)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          !q.loading && <div class="empty">No tokens yet.</div>
        )}
      </div>
      {created && <TokenCreated {...created} onClose={() => setCreated(null)} />}
    </div>
  );
}

function TokenCreated({ name, token, onClose }: { name: string; token: string; onClose: () => void }) {
  const host = location.origin;
  const snippet = `import kymo

run = kymo.init(
    project="my-project",
    experiment="run-1",
    config={"lr": 3e-4},
    api_key="${token}",   # or: export KYMO_API_KEY=...
    host="${host}",       # or: export KYMO_HOST=...
)
for step in range(1000):
    run.log({"train/loss": 1.0 / (step + 1)}, step=step)
run.finish()`;
  const env = `export KYMO_API_KEY=${token}\nexport KYMO_HOST=${host}`;
  return (
    <Modal
      title={`Token "${name}" created`}
      onClose={onClose}
      wide
      footer={
        <button class="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div class="notice">Copy the token now. It is shown only once and cannot be recovered.</div>
      <CopyField value={token} />
      <div class="row">
        <h3 class="grow">Shell</h3>
        <CopyButton text={env} class="small" />
      </div>
      <div class="codeblock">{env}</div>
      <div class="row">
        <h3 class="grow">Python</h3>
        <CopyButton text={snippet} class="small" />
      </div>
      <div class="codeblock">{snippet}</div>
    </Modal>
  );
}

function Passkeys() {
  const { auth } = useAuth();
  const q = useAsync(() => api.passkeys(), []);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(defaultPasskeyName());
  const mustKeepOne = auth.user?.is_admin || auth.policy.passkey_required_for_all;
  const add = async (e: Event) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await registerPasskey(name.trim() || defaultPasskeyName());
      q.reload();
    } catch (e2) {
      setErr(new Error(describeWebauthnError(e2)));
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: number, n: string) => {
    if (!confirm(`Delete passkey "${n}"?`)) return;
    setErr(null);
    try {
      await api.deletePasskey(id);
      q.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div class="card section">
      <div class="card-head">
        <h2 class="grow">Passkeys</h2>
        <form class="row" onSubmit={add}>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button class="primary" disabled={busy}>
            {busy ? 'Waiting…' : 'Add passkey'}
          </button>
        </form>
      </div>
      <div class="card-body" style={{ padding: 0 }}>
        <div style={{ padding: '8px 12px' }} class="hint">
          With at least one passkey, it is required at every sign-in.{mustKeepOne && ' Your account must keep at least one.'}
        </div>
        <ErrorBox error={err || q.error} />
        {q.data && q.data.length > 0 ? (
          <table class="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Added</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td class="muted" title={absTime(p.created_at)}>
                    {relTime(p.created_at)}
                  </td>
                  <td class="muted">{p.last_used_at ? relTime(p.last_used_at) : 'never'}</td>
                  <td class="num">
                    <button class="small danger" disabled={mustKeepOne && q.data!.length === 1} title={mustKeepOne && q.data!.length === 1 ? 'You must keep at least one passkey' : ''} onClick={() => del(p.id, p.name)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          !q.loading && <div class="empty">No passkeys registered.</div>
        )}
      </div>
    </div>
  );
}

function Password() {
  const [oldPw, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    try {
      if (pw.length < 10) throw new Error('New password must be at least 10 characters.');
      if (pw !== pw2) throw new Error('Passwords do not match.');
      await api.changePassword(oldPw, pw);
      setMsg('Password changed.');
      setOld('');
      setPw('');
      setPw2('');
    } catch (e2) {
      setErr(e2);
    }
  };
  return (
    <div class="card section">
      <div class="card-head">
        <h2>Password</h2>
      </div>
      <form class="card-body col" style={{ maxWidth: 360 }} onSubmit={submit}>
        <input type="text" autoComplete="username" hidden />
        <label class="field">
          Current password
          <input type="password" autoComplete="current-password" required value={oldPw} onInput={(e) => setOld((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          New password
          <input type="password" autoComplete="new-password" required minLength={10} value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          Repeat new password
          <input type="password" autoComplete="new-password" required value={pw2} class={pw2 && pw2 !== pw ? 'invalid' : ''} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
        </label>
        <ErrorBox error={err} />
        {msg && <div class="notice">{msg}</div>}
        <div>
          <button class="primary">Change password</button>
        </div>
      </form>
    </div>
  );
}
