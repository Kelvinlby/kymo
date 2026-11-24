import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../components/Shell';
import { Check, CircleCheck, FingerprintPattern, KeyRound, LogOut, Mail, Moon, Sun } from '../components/icons';
import { Alert, Button, Field, cx } from '../components/ui';
import { defaultPasskeyName, loginWithPasskey, registerPasskey } from '../lib/passkey';
import { setThemePref, useTheme } from '../lib/theme';
import { describeWebauthnError } from '../lib/webauthn';
import { navigate, useLocation } from '../router';

type StepState = 'todo' | 'on' | 'done';

function Steps({ steps }: { steps: [string, StepState][] }) {
  return (
    <ol class="steps auth-steps" aria-label="Sign-in steps">
      {steps.map(([label, st], i) => (
        <>
          {i > 0 && <span class="step-line" aria-hidden="true" />}
          <li class={cx('step', st)} key={label} aria-current={st === 'on' ? 'step' : undefined}>
            <span class="step-n">{st === 'done' ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
            {label}
          </li>
        </>
      ))}
    </ol>
  );
}

function AuthCard(props: { title: string; sub?: ComponentChildren; children: ComponentChildren; steps?: [string, StepState][]; icon?: typeof KeyRound; foot?: ComponentChildren }) {
  const { theme } = useTheme();
  useEffect(() => {
    document.title = props.title + ' · Kymo';
  }, [props.title]);
  const Icon = props.icon;
  return (
    <div class="auth-wrap">
      <button class="auth-theme btn btn-ghost btn-sm btn-icon" aria-label="Toggle theme" data-tip="Toggle theme" onClick={() => setThemePref(theme === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <main class="auth-main">
        <div class="auth-brand">
          <Logo size={30} />
          <span>Kymo</span>
        </div>
        <div class="auth-card card">
          {props.steps && <Steps steps={props.steps} />}
          {Icon && (
            <span class="auth-icon">
              <Icon size={20} aria-hidden="true" />
            </span>
          )}
          <h1 class="auth-title">{props.title}</h1>
          {props.sub && <p class="auth-sub">{props.sub}</p>}
          <div class="auth-body">{props.children}</div>
        </div>
        {props.foot && <div class="auth-foot">{props.foot}</div>}
      </main>
    </div>
  );
}

/** Turn API errors into sentences a person can act on. */
function friendly(e: unknown, ctx: 'login' | 'signup' | 'setup' | 'other' = 'other'): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return "Can't reach the Kymo server. Check your connection and try again.";
    if (e.status === 429) return 'Too many attempts. Wait a minute, then try again.';
    if (ctx === 'login' && (e.status === 401 || e.status === 400)) return "That username and password don't match. Check for typos and try again.";
    if (/disabled/.test(e.code)) return 'This account is disabled. Ask your administrator to enable it.';
    if (ctx === 'setup' && (e.status === 401 || e.status === 403)) return 'That setup token is not valid. Copy it again from the server log or the setup_token file.';
    if (e.status === 409 && /username/.test(e.code + e.message)) return 'That username is already taken. Try another one.';
    if (e.status >= 500) return 'The server ran into a problem. Try again in a moment.';
  }
  return (e as Error)?.message || String(e);
}

function useSubmit(ctx: 'login' | 'signup' | 'setup' | 'other' = 'other') {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendly(e, ctx));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/;

function PasswordFields(p: { pw: string; setPw: (s: string) => void; pw2: string; setPw2: (s: string) => void; label?: string; touched: boolean }) {
  const e1 = p.pw && p.pw.length < 10 ? 'Use at least 10 characters' : p.touched && !p.pw ? 'Required' : null;
  const e2 = p.pw2 && p.pw2 !== p.pw ? "Passwords don't match" : null;
  return (
    <>
      <Field label={p.label || 'Password'} error={e1} hint="At least 10 characters">
        <input class="input" type="password" autoComplete="new-password" value={p.pw} aria-invalid={!!e1} onInput={(e) => p.setPw((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="Repeat password" error={e2}>
        <input class="input" type="password" autoComplete="new-password" value={p.pw2} aria-invalid={!!e2} onInput={(e) => p.setPw2((e.target as HTMLInputElement).value)} />
      </Field>
    </>
  );
}

function AccountFields(p: {
  username: string;
  setUsername?: (s: string) => void;
  lockedUsername?: boolean;
  display: string;
  setDisplay: (s: string) => void;
  pw: string;
  setPw: (s: string) => void;
  pw2: string;
  setPw2: (s: string) => void;
  touched: boolean;
}) {
  const uErr = p.username && !USERNAME_RE.test(p.username) ? '2–32 characters: a–z, 0–9, “_”, “.”, “-”' : p.touched && !p.username ? 'Required' : null;
  return (
    <>
      <Field label="Username" error={uErr} hint={p.lockedUsername ? 'Reserved for you by the invite' : undefined}>
        <input
          class="input"
          name="username"
          autoComplete="username"
          value={p.username}
          readOnly={p.lockedUsername}
          aria-invalid={!!uErr}
          spellcheck={false}
          onInput={(e) => p.setUsername?.((e.target as HTMLInputElement).value.toLowerCase())}
        />
      </Field>
      <Field label="Display name" optional>
        <input class="input" name="display_name" value={p.display} placeholder="How others see you" onInput={(e) => p.setDisplay((e.target as HTMLInputElement).value)} />
      </Field>
      <PasswordFields pw={p.pw} setPw={p.setPw} pw2={p.pw2} setPw2={p.setPw2} touched={p.touched} />
    </>
  );
}

function validate(username: string | null, pw: string, pw2: string) {
  if (username !== null && !USERNAME_RE.test(username)) throw new Error('Choose a username of 2–32 characters: a–z, 0–9, “_”, “.”, “-”.');
  if (pw.length < 10) throw new Error('Your password needs at least 10 characters.');
  if (pw !== pw2) throw new Error("The two passwords don't match.");
}

export function Setup() {
  const { refresh } = useAuth();
  const loc = useLocation();
  const [token, setToken] = useState(loc.query.get('token') || '');
  const [username, setUsername] = useState('admin');
  const [display, setDisplay] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [touched, setTouched] = useState(false);
  const s = useSubmit('setup');
  return (
    <AuthCard
      title="Set up Kymo"
      sub="Create the administrator account. You'll register a passkey right after."
      steps={[
        ['Admin account', 'on'],
        ['Passkey', 'todo'],
      ]}
    >
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          s.run(async () => {
            validate(username, pw, pw2);
            await api.setup({ setup_token: token.trim(), username, password: pw, display_name: display || undefined });
            navigate('/', { replace: true });
            await refresh();
          });
        }}
      >
        <Field label="Setup token" hint="Printed by the server on first start, also in <data_dir>/setup_token.">
          <input class="input mono" required value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} spellcheck={false} />
        </Field>
        <AccountFields username={username} setUsername={setUsername} display={display} setDisplay={setDisplay} pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} touched={touched} />
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Button type="submit" variant="primary" size="lg" class="btn-block" loading={s.busy}>
          Create admin account
        </Button>
      </form>
    </AuthCard>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const s = useSubmit('login');
  return (
    <AuthCard title="Welcome back" sub="Sign in to your Kymo workspace." foot={<span>No account? Accounts are created by invitation from your administrator.</span>}>
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          s.run(async () => {
            if (!username.trim() || !pw) throw new Error('Enter your username and password.');
            await api.login(username.trim(), pw);
            await refresh(); // guard decides: full / passkey prompt / enrollment
          });
        }}
      >
        <Field label="Username">
          <input class="input" name="username" autoComplete="username webauthn" autoFocus value={username} spellcheck={false} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Password">
          <input class="input" name="password" type="password" autoComplete="current-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        </Field>
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Button type="submit" variant="primary" size="lg" class="btn-block" loading={s.busy}>
          {s.busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p class="auth-note">
          <FingerprintPattern size={13} aria-hidden="true" />
          If your account has a passkey, you'll confirm with it next.
        </p>
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
  const [touched, setTouched] = useState(false);
  const [done, setDone] = useState(false);
  const s = useSubmit('signup');

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
      <AuthCard title={done ? 'Password updated' : 'Choose a new password'} icon={done ? CircleCheck : KeyRound} sub={done ? 'You can now sign in with your new password.' : undefined}>
        {done ? (
          <Button
            variant="primary"
            size="lg"
            class="btn-block"
            onClick={async () => {
              await refresh();
              navigate(auth.session_state === 'full' ? '/' : '/login', { replace: true });
            }}
          >
            Continue
          </Button>
        ) : (
          <form
            class="form"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              s.run(async () => {
                validate(null, pw, pw2);
                await api.reset(reset, pw);
                setDone(true);
              });
            }}
          >
            <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} label="New password" touched={touched} />
            {s.error && <Alert tone="danger">{s.error}</Alert>}
            <Button type="submit" variant="primary" size="lg" class="btn-block" loading={s.busy}>
              Set password
            </Button>
          </form>
        )}
      </AuthCard>
    );
  }

  if (!invite) {
    return (
      <AuthCard title="Invitation required" icon={Mail} sub="Accounts on this server are created by invitation only. Ask your administrator for an invite link.">
        <Button size="lg" class="btn-block" onClick={() => navigate('/login')}>
          Back to sign in
        </Button>
      </AuthCard>
    );
  }
  if (!check)
    return (
      <AuthCard title="Checking your invite…">
        <div class="skeleton" style={{ height: 34, width: '100%' }} />
      </AuthCard>
    );
  if (!check.valid) {
    return (
      <AuthCard title="This invite can't be used" icon={Mail} sub="The link is invalid, has expired, or was already used. Ask your administrator for a new one.">
        <Button size="lg" class="btn-block" onClick={() => navigate('/login')}>
          Back to sign in
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Create your account" sub="You've been invited to Kymo. Choose your sign-in details.">
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
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
          touched={touched}
        />
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Button type="submit" variant="primary" size="lg" class="btn-block" loading={s.busy}>
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}

function SignOut() {
  const { refresh } = useAuth();
  return (
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      onClick={async () => {
        await api.logout().catch(() => {});
        await refresh().catch(() => {});
        navigate('/login', { replace: true });
      }}
    >
      <LogOut size={14} /> Sign out
    </button>
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
        if ((e as Error)?.name && !(e instanceof ApiError)) throw new Error(describeWebauthnError(e));
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
    <AuthCard
      title="Confirm it's you"
      icon={FingerprintPattern}
      sub={
        <>
          Signed in as <b>{auth.user?.display_name || auth.user?.username}</b>. Use your passkey to finish signing in.
        </>
      }
      steps={[
        ['Password', 'done'],
        ['Passkey', 'on'],
      ]}
      foot={<SignOut />}
    >
      <div class="form">
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Button variant="primary" size="lg" class="btn-block" icon={FingerprintPattern} loading={s.busy} onClick={go}>
          {s.busy ? 'Waiting for your passkey…' : s.error ? 'Try again' : 'Use passkey'}
        </Button>
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
      title="Add a passkey"
      icon={FingerprintPattern}
      sub={
        auth.user?.is_admin
          ? 'The administrator account requires a passkey as a second factor. Register one to continue.'
          : 'This server requires a passkey for every account. Register one to continue.'
      }
      steps={[
        ['Password', 'done'],
        ['Passkey', 'on'],
      ]}
      foot={
        <>
          <span class="faint">Signed in as {auth.user?.username}</span>
          <SignOut />
        </>
      }
    >
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          s.run(async () => {
            try {
              await registerPasskey(name.trim() || defaultPasskeyName());
            } catch (e) {
              if ((e as Error)?.name && !(e instanceof ApiError)) throw new Error(describeWebauthnError(e));
              throw e;
            }
            await refresh();
          });
        }}
      >
        <Field label="Passkey name" hint="Helps you recognise this device later.">
          <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        {s.error && <Alert tone="danger">{s.error}</Alert>}
        <Button type="submit" variant="primary" size="lg" class="btn-block" icon={FingerprintPattern} loading={s.busy}>
          {s.busy ? 'Waiting for your device…' : 'Register passkey'}
        </Button>
      </form>
    </AuthCard>
  );
}
