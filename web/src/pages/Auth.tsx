import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../components/Shell';
import { ErrorBox } from '../components/ui';
import { defaultPasskeyName, loginWithPasskey, registerPasskey } from '../lib/passkey';
import { describeWebauthnError } from '../lib/webauthn';
import { navigate, useLocation } from '../router';

function AuthCard(props: { title: string; sub?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand">
          <Logo /> Kymo
        </div>
        <div class="card">
          <div class="card-body">
            <h1>{props.title}</h1>
            {props.sub && <p class="hint" style={{ marginTop: 0 }}>{props.sub}</p>}
            {props.children}
          </div>
        </div>
      </div>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/;

function AccountFields(p: { username: string; setUsername?: (s: string) => void; lockedUsername?: boolean; display: string; setDisplay: (s: string) => void; pw: string; setPw: (s: string) => void; pw2: string; setPw2: (s: string) => void }) {
  return (
    <>
      <label class="field">
        Username
        <input
          name="username"
          autoComplete="username"
          required
          value={p.username}
          readOnly={p.lockedUsername}
          pattern="[a-z0-9_.\-]{2,32}"
          title="2–32 chars: a-z 0-9 _ . -"
          onInput={(e) => p.setUsername?.((e.target as HTMLInputElement).value.toLowerCase())}
        />
      </label>
      <label class="field">
        Display name <span class="faint">(optional)</span>
        <input name="display_name" value={p.display} onInput={(e) => p.setDisplay((e.target as HTMLInputElement).value)} />
      </label>
      <PasswordPair pw={p.pw} setPw={p.setPw} pw2={p.pw2} setPw2={p.setPw2} />
    </>
  );
}

function PasswordPair(p: { pw: string; setPw: (s: string) => void; pw2: string; setPw2: (s: string) => void; label?: string }) {
  return (
    <>
      <label class="field">
        {p.label || 'Password'} <span class="faint">(min. 10 characters)</span>
        <input type="password" autoComplete="new-password" required minLength={10} value={p.pw} onInput={(e) => p.setPw((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        Repeat password
        <input
          type="password"
          autoComplete="new-password"
          required
          value={p.pw2}
          class={p.pw2 && p.pw2 !== p.pw ? 'invalid' : ''}
          onInput={(e) => p.setPw2((e.target as HTMLInputElement).value)}
        />
      </label>
    </>
  );
}

function validate(username: string | null, pw: string, pw2: string) {
  if (username !== null && !USERNAME_RE.test(username)) throw new Error('Username must be 2–32 characters of a-z, 0-9, _ . -');
  if (pw.length < 10) throw new Error('Password must be at least 10 characters.');
  if (pw !== pw2) throw new Error('Passwords do not match.');
}

export function Setup() {
  const { refresh } = useAuth();
  const loc = useLocation();
  const [token, setToken] = useState(loc.query.get('token') || '');
  const [username, setUsername] = useState('admin');
  const [display, setDisplay] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const s = useSubmit();
  return (
    <AuthCard title="Set up Kymo" sub="Create the administrator account. You will register a passkey right after.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.run(async () => {
            validate(username, pw, pw2);
            await api.setup({ setup_token: token.trim(), username, password: pw, display_name: display || undefined });
            navigate('/', { replace: true });
            await refresh();
          });
        }}
      >
        <label class="field">
          Setup token <span class="faint">(printed by the server on first start)</span>
          <input class="mono" required value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
        </label>
        <AccountFields username={username} setUsername={setUsername} display={display} setDisplay={setDisplay} pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        <ErrorBox error={s.error} />
        <button class="primary" disabled={s.busy}>
          {s.busy ? 'Creating…' : 'Create admin'}
        </button>
      </form>
    </AuthCard>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const s = useSubmit();
  return (
    <AuthCard title="Sign in">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.run(async () => {
            await api.login(username.trim(), pw);
            await refresh(); // guard decides: full / passkey prompt / enrollment
          });
        }}
      >
        <label class="field">
          Username
          <input name="username" autoComplete="username webauthn" autoFocus required value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          Password
          <input name="password" type="password" autoComplete="current-password" required value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        </label>
        <ErrorBox error={s.error} />
        <button class="primary" disabled={s.busy}>
          {s.busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  );
}

export function Signup() {
  const { auth, refresh } = useAuth();
  const loc = useLocation();
  const invite = loc.query.get('invite');
  const reset = loc.query.get('reset');
  const [check, setCheck] = useState<{ valid: boolean; username?: string } | null>(null);
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [done, setDone] = useState(false);
  const s = useSubmit();

  useEffect(() => {
    if (!invite) return;
    api.invite(invite).then(
      (r) => {
        setCheck(r);
        if (r.username) setUsername(r.username);
      },
      () => setCheck({ valid: false }),
    );
  }, [invite]);

  if (reset) {
    return (
      <AuthCard title="Set a new password">
        {done ? (
          <div class="col">
            <div class="notice">Password updated.</div>
            <button
              class="primary"
              onClick={async () => {
                await refresh();
                navigate(auth.session_state === 'full' ? '/' : '/login', { replace: true });
              }}
            >
              Continue
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              s.run(async () => {
                validate(null, pw, pw2);
                await api.reset(reset, pw);
                setDone(true);
              });
            }}
          >
            <PasswordPair pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} label="New password" />
            <ErrorBox error={s.error} />
            <button class="primary" disabled={s.busy}>
              Set password
            </button>
          </form>
        )}
      </AuthCard>
    );
  }

  if (!invite) {
    return (
      <AuthCard title="Invitation required">
        <p class="hint">Accounts are created by invitation only. Ask your administrator for an invite link.</p>
      </AuthCard>
    );
  }
  if (!check) return <AuthCard title="Create your account">Checking invite…</AuthCard>;
  if (!check.valid) {
    return (
      <AuthCard title="Invite not valid">
        <p class="hint">This invite link is invalid, expired or has already been used.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Create your account">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.run(async () => {
            validate(username, pw, pw2);
            await api.signup({ invite_token: invite, username, password: pw, display_name: display || undefined });
            navigate('/', { replace: true });
            await refresh();
          });
        }}
      >
        <AccountFields
          username={username}
          setUsername={check.username ? undefined : setUsername}
          lockedUsername={!!check.username}
          display={display}
          setDisplay={setDisplay}
          pw={pw}
          setPw={setPw}
          pw2={pw2}
          setPw2={setPw2}
        />
        <ErrorBox error={s.error} />
        <button class="primary" disabled={s.busy}>
          Create account
        </button>
      </form>
    </AuthCard>
  );
}

function LogoutLink() {
  const { refresh } = useAuth();
  return (
    <a
      href="#"
      class="hint"
      onClick={async (e) => {
        e.preventDefault();
        await api.logout().catch(() => {});
        await refresh().catch(() => {});
        navigate('/login', { replace: true });
      }}
    >
      Sign out
    </a>
  );
}

export function PasskeyPrompt() {
  const { auth, refresh } = useAuth();
  const s = useSubmit();
  const tried = useRef(false);
  const go = () =>
    s.run(async () => {
      try {
        await loginWithPasskey();
      } catch (e) {
        if ((e as Error)?.name) throw new Error(describeWebauthnError(e));
        throw e;
      }
      await refresh();
    });
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <AuthCard title="Verify with your passkey" sub={<>Signed in as <b>{auth.user?.username}</b>. Your account requires a passkey.</>}>
      <div class="col">
        <ErrorBox error={s.error} />
        <button class="primary" disabled={s.busy} onClick={go} style={{ height: 30, justifyContent: 'center' }}>
          {s.busy ? 'Waiting for passkey…' : 'Use passkey'}
        </button>
        <div class="row">
          <span class="spacer" />
          <LogoutLink />
        </div>
      </div>
    </AuthCard>
  );
}

export function EnrollPasskey() {
  const { auth, refresh } = useAuth();
  const [name, setName] = useState(defaultPasskeyName());
  const s = useSubmit();
  return (
    <AuthCard
      title="Register a passkey"
      sub={
        auth.user?.is_admin
          ? 'Passkey two-factor authentication is required for the administrator. Register one to continue.'
          : 'This server requires a passkey for every account. Register one to continue.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.run(async () => {
            try {
              await registerPasskey(name.trim() || defaultPasskeyName());
            } catch (e) {
              if ((e as Error)?.name && !(e as { status?: number }).status) throw new Error(describeWebauthnError(e));
              throw e;
            }
            await refresh();
          });
        }}
      >
        <label class="field">
          Passkey name
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <ErrorBox error={s.error} />
        <button class="primary" disabled={s.busy}>
          {s.busy ? 'Waiting for authenticator…' : 'Register passkey'}
        </button>
        <div class="row">
          <span class="hint">Signed in as {auth.user?.username}</span>
          <span class="spacer" />
          <LogoutLink />
        </div>
      </form>
    </AuthCard>
  );
}
