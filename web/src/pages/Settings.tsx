import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Shell';
import { Ellipsis, FingerprintPattern, KeyRound, Lock, Monitor, Moon, Palette, Plus, Sun, Trash } from '../components/icons';
import { confirmDialog, toast } from '../components/overlay';
import { CodeTabs } from '../components/Snippets';
import { Alert, Avatar, Button, Card, CopyField, Dialog, EmptyState, ErrorBox, Field, IconButton, MenuItem, Popover, Skeleton, cx, useAsync, type TriggerProps } from '../components/ui';
import { absTime, relTime } from '../lib/format';
import { defaultPasskeyName, registerPasskey } from '../lib/passkey';
import { MOD } from '../lib/hotkeys';
import { setThemePref, useTheme, type ThemePref } from '../lib/theme';
import { describeWebauthnError } from '../lib/webauthn';
import { navigate, useLocation } from '../router';

type Section = 'tokens' | 'passkeys' | 'password' | 'appearance';
const SECTIONS: { id: Section; label: string; icon: typeof KeyRound }[] = [
  { id: 'tokens', label: 'API tokens', icon: KeyRound },
  { id: 'passkeys', label: 'Passkeys', icon: FingerprintPattern },
  { id: 'password', label: 'Password', icon: Lock },
  { id: 'appearance', label: 'Appearance', icon: Palette },
];

export function SubNav<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string; icon: typeof KeyRound }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <nav class="subnav" aria-label={label}>
      {items.map((s) => (
        <button key={s.id} type="button" class={cx('subnav-item', value === s.id && 'on')} aria-current={value === s.id ? 'page' : undefined} onClick={() => onChange(s.id)}>
          <s.icon size={16} aria-hidden="true" />
          {s.label}
        </button>
      ))}
    </nav>
  );
}

export function RowMenu({ children, label = 'Actions' }: { children: (close: () => void) => ComponentChildren; label?: string }) {
  return (
    <Popover menu placement="bottom-end" width={210} trigger={(p: TriggerProps) => <IconButton btnRef={p.ref as any} icon={Ellipsis} label={label} onClick={p.toggle} aria-expanded={p.open} aria-haspopup="menu" />}>
      {children}
    </Popover>
  );
}

export function Settings() {
  const { auth } = useAuth();
  const loc = useLocation();
  const s = (loc.query.get('s') as Section) || 'tokens';
  const section = SECTIONS.some((x) => x.id === s) ? s : 'tokens';
  const u = auth.user!;
  return (
    <Page crumbs={[{ label: 'Settings' }]}>
      <div class="page-wrap narrow">
        <div class="page-title-row">
          <div class="row grow" style={{ gap: 14 }}>
            <Avatar name={u.display_name || u.username} size={44} />
            <div>
              <h1>Settings</h1>
              <p class="page-sub" style={{ marginTop: 0 }}>
                {u.display_name || u.username} · @{u.username}
                {u.is_admin ? ' · administrator' : ''}
              </p>
            </div>
          </div>
        </div>
        <div class="subnav-layout">
          <SubNav label="Settings sections" items={SECTIONS} value={section} onChange={(v) => navigate('/settings?s=' + v, { replace: true })} />
          <div class="subnav-content">
            {section === 'tokens' && <Tokens autoNew={loc.query.get('new') === '1'} />}
            {section === 'passkeys' && <Passkeys />}
            {section === 'password' && <Password />}
            {section === 'appearance' && <Appearance />}
          </div>
        </div>
      </div>
    </Page>
  );
}

// ------------------------------------------------------------------------------------- tokens
function Tokens({ autoNew }: { autoNew: boolean }) {
  const q = useAsync(() => api.tokens(), []);
  const [creating, setCreating] = useState(autoNew);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  useEffect(() => {
    if (autoNew) {
      setCreating(true);
      navigate('/settings?s=tokens', { replace: true });
    }
  }, [autoNew]);
  const revoke = async (id: number, n: string) => {
    const ok = await confirmDialog({ title: `Revoke “${n}”?`, message: 'Scripts and clients using this token will immediately get 401 errors. This cannot be undone.', confirmLabel: 'Revoke token', danger: true });
    if (!ok) return;
    try {
      await api.deleteToken(id);
      toast('Token revoked', { description: n });
      q.reload();
    } catch (e) {
      toast.error(e, 'Could not revoke the token');
    }
  };
  return (
    <>
      <Card
        title="API tokens"
        description="Tokens let scripts log metrics and read data as you. They can't sign in to the web UI or manage your account."
        actions={
          <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
            Create token
          </Button>
        }
        flush
      >
        <ErrorBox error={q.error} />
        {!q.data ? (
          <div class="card-body col">
            <Skeleton w="60%" />
            <Skeleton w="40%" />
          </div>
        ) : q.data.length === 0 ? (
          <EmptyState icon={KeyRound} title="No tokens yet" compact action={<Button icon={Plus} onClick={() => setCreating(true)}>Create your first token</Button>}>
            Create a token to send metrics from a script, a notebook or <code>curl</code>.
          </EmptyState>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Token</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th class="actions" />
                </tr>
              </thead>
              <tbody>
                {q.data.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span class="row" style={{ gap: 10 }}>
                        <span class="row-icon">
                          <KeyRound size={14} />
                        </span>
                        <b class="cell-strong">{t.name}</b>
                      </span>
                    </td>
                    <td class="mono muted">{t.prefix}…</td>
                    <td class="muted" title={absTime(t.created_at)}>
                      {relTime(t.created_at)}
                    </td>
                    <td class="muted" title={absTime(t.last_used_at)}>
                      {t.last_used_at ? relTime(t.last_used_at) : 'Never'}
                    </td>
                    <td class="actions">
                      <RowMenu label={`Actions for ${t.name}`}>
                        {(close) => (
                          <MenuItem icon={Trash} danger onSelect={() => (close(), revoke(t.id, t.name))}>
                            Revoke token
                          </MenuItem>
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
      <Card title="Using a token" description="Set the two environment variables, then log from Python or plain HTTP.">
        <CodeTabs />
      </Card>
      {creating && (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setCreated(t);
            q.reload();
          }}
        />
      )}
      {created && <TokenCreatedDialog {...created} onClose={() => setCreated(null)} />}
    </>
  );
}

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: { name: string; token: string }) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e?: Event) => {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const t = await api.createToken(name.trim() || 'token');
      onCreated({ name: t.name, token: t.token });
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Create API token"
      icon={KeyRound}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => submit()}>
            Create token
          </Button>
        </>
      }
    >
      <form onSubmit={submit} class="form">
        <Field label="Name" hint="Something that tells you where it's used, e.g. “cluster-a” or “laptop”.">
          <input class="input" data-autofocus value={name} placeholder="cluster-a" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        {!!err && <Alert tone="danger">{(err as Error).message}</Alert>}
      </form>
    </Dialog>
  );
}

function TokenCreatedDialog({ name, token, onClose }: { name: string; token: string; onClose: () => void }) {
  return (
    <Dialog
      title={`Token “${name}” created`}
      description="Copy it now. For your security it is shown only once and can't be recovered."
      icon={KeyRound}
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Alert tone="warning" title="Store it somewhere safe">
        Anyone with this token can log and read metrics as you.
      </Alert>
      <CopyField value={token} />
      <div>
        <div class="field-label" style={{ marginBottom: 8 }}>
          Quick start
        </div>
        <CodeTabs token={token} initial="env" />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------- passkeys
function Passkeys() {
  const { auth } = useAuth();
  const q = useAsync(() => api.passkeys(), []);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(defaultPasskeyName());
  const [err, setErr] = useState<string | null>(null);
  const mustKeepOne = auth.user?.is_admin || auth.policy.passkey_required_for_all;
  const add = async (e?: Event) => {
    e?.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await registerPasskey(name.trim() || defaultPasskeyName());
      toast('Passkey added', { description: name });
      setAdding(false);
      q.reload();
    } catch (e2) {
      setErr(describeWebauthnError(e2));
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: number, n: string) => {
    const ok = await confirmDialog({ title: `Remove “${n}”?`, message: 'You will no longer be able to sign in with this passkey.', confirmLabel: 'Remove passkey', danger: true });
    if (!ok) return;
    try {
      await api.deletePasskey(id);
      toast('Passkey removed');
      q.reload();
    } catch (e) {
      toast.error(e, 'Could not remove the passkey');
    }
  };
  const last = q.data?.length === 1;
  return (
    <>
      <Card
        title="Passkeys"
        description={
          <>
            Once you add a passkey, every sign-in asks for it after your password.
            {mustKeepOne && ' Your account must keep at least one.'}
          </>
        }
        actions={
          <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
            Add passkey
          </Button>
        }
        flush
      >
        <ErrorBox error={q.error} />
        {!q.data ? (
          <div class="card-body col">
            <Skeleton w="50%" />
          </div>
        ) : q.data.length === 0 ? (
          <EmptyState icon={FingerprintPattern} title="No passkeys" compact action={<Button icon={Plus} onClick={() => setAdding(true)}>Add a passkey</Button>}>
            Passkeys use your device's screen lock or a security key as a second factor.
          </EmptyState>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Added</th>
                  <th>Last used</th>
                  <th class="actions" />
                </tr>
              </thead>
              <tbody>
                {q.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span class="row" style={{ gap: 10 }}>
                        <span class="row-icon">
                          <FingerprintPattern size={14} />
                        </span>
                        <b class="cell-strong">{p.name}</b>
                      </span>
                    </td>
                    <td class="muted" title={absTime(p.created_at)}>
                      {relTime(p.created_at)}
                    </td>
                    <td class="muted">{p.last_used_at ? relTime(p.last_used_at) : 'Never'}</td>
                    <td class="actions">
                      <RowMenu label={`Actions for ${p.name}`}>
                        {(close) => (
                          <MenuItem icon={Trash} danger disabled={mustKeepOne && last} onSelect={() => (close(), del(p.id, p.name))} hint={mustKeepOne && last ? 'required' : undefined}>
                            Remove passkey
                          </MenuItem>
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
      {adding && (
        <Dialog
          title="Add a passkey"
          description="Your browser will ask you to confirm with your device or security key."
          icon={FingerprintPattern}
          onClose={() => !busy && setAdding(false)}
          footer={
            <>
              <Button onClick={() => setAdding(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} onClick={() => add()}>
                {busy ? 'Waiting for your device…' : 'Continue'}
              </Button>
            </>
          }
        >
          <form onSubmit={add} class="form">
            <Field label="Name" hint="Helps you recognise it later.">
              <input class="input" data-autofocus value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </Field>
            {err && <Alert tone="danger">{err}</Alert>}
          </form>
        </Dialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------- password
function Password() {
  const [oldPw, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const e1 = pw && pw.length < 10 ? 'At least 10 characters' : null;
  const e2 = pw2 && pw2 !== pw ? 'Passwords do not match' : null;
  const submit = async (e: Event) => {
    e.preventDefault();
    setTouched(true);
    setErr(null);
    if (!oldPw || !pw || e1 || e2 || pw !== pw2) return;
    setBusy(true);
    try {
      await api.changePassword(oldPw, pw);
      toast('Password changed');
      setOld('');
      setPw('');
      setPw2('');
      setTouched(false);
    } catch (e3) {
      setErr(e3);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Password" description="Use at least 10 characters. Other sessions stay signed in.">
      <form class="form" style={{ maxWidth: 400 }} onSubmit={submit}>
        <input type="text" autoComplete="username" hidden />
        <Field label="Current password" error={touched && !oldPw ? 'Required' : null}>
          <input class="input" type="password" autoComplete="current-password" value={oldPw} onInput={(e) => setOld((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="New password" error={e1 || (touched && !pw ? 'Required' : null)}>
          <input class="input" type="password" autoComplete="new-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Repeat new password" error={e2}>
          <input class="input" type="password" autoComplete="new-password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
        </Field>
        {!!err && <Alert tone="danger">{friendlyPasswordError(err)}</Alert>}
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function friendlyPasswordError(e: unknown) {
  const st = (e as { status?: number }).status;
  if (st === 401 || st === 403) return 'Your current password is not correct.';
  return (e as Error).message;
}

// ------------------------------------------------------------------------------------- appearance
function Appearance() {
  const { pref } = useTheme();
  const opts: { v: ThemePref; label: string; icon: typeof Sun }[] = [
    { v: 'light', label: 'Light', icon: Sun },
    { v: 'dark', label: 'Dark', icon: Moon },
    { v: 'system', label: 'System', icon: Monitor },
  ];
  return (
    <Card title="Appearance" description="Applies to this browser. System follows your operating system setting.">
      <div class="theme-tiles" role="radiogroup" aria-label="Theme">
        {opts.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={pref === o.v} class={cx('theme-tile', pref === o.v && 'on')} onClick={() => setThemePref(o.v)}>
            <span class={'theme-preview tp-' + o.v} aria-hidden="true">
              <span class="tp-side" />
              <span class="tp-main">
                <span class="tp-line" />
                <span class="tp-line short" />
                <span class="tp-chart" />
              </span>
            </span>
            <span class="theme-label">
              <o.icon size={14} aria-hidden="true" />
              {o.label}
            </span>
          </button>
        ))}
      </div>
      <p class="field-hint" style={{ marginTop: 14 }}>
        Tip: press <kbd class="kbd">{MOD}</kbd> <kbd class="kbd">K</kbd> and type “theme” to switch from anywhere.
      </p>
    </Card>
  );
}
