import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, onAuthError, type AuthState } from './api';
import { AuthContext, useAuth } from './auth';
import { Link, Redirect, match, useLocation } from './router';
import { Shell } from './components/Shell';
import { EnrollPasskey, Login, PasskeyPrompt, Setup, Signup } from './pages/Auth';
import { Projects } from './pages/Projects';
import { Workspace } from './pages/Workspace';
import { ExperimentPage } from './pages/Experiment';
import { Settings } from './pages/Settings';
import { Admin } from './pages/Admin';

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      setAuth(s);
      setFatal(null);
      return s;
    } catch (e) {
      setFatal((e as Error).message);
      throw e;
    }
  }, []);
  useEffect(() => {
    refresh().catch(() => {});
    return onAuthError(() => {
      refresh().catch(() => {});
    });
  }, [refresh]);

  if (!auth) {
    return (
      <div class="auth-wrap">
        {fatal ? (
          <div class="col" style={{ alignItems: 'center' }}>
            <div class="error">{fatal}</div>
            <button onClick={() => refresh().catch(() => {})}>Retry</button>
          </div>
        ) : (
          <span class="faint">Loading…</span>
        )}
      </div>
    );
  }
  return (
    <AuthContext.Provider value={{ auth, refresh }}>
      <Guard />
    </AuthContext.Provider>
  );
}

const PUBLIC_PATHS = ['/login', '/signup', '/setup'];

/** Route guard driven by GET /auth/state. */
function Guard() {
  const { auth } = useAuth();
  const loc = useLocation();
  const path = loc.path.replace(/\/+$/, '') || '/';

  if (auth.setup_required) {
    if (path !== '/setup') return <Redirect to={'/setup' + loc.search} />;
    return <Setup />;
  }
  if (path === '/setup') return <Redirect to="/" />;

  const st = auth.session_state;
  if (st === null) {
    if (path === '/signup') return <Signup />;
    if (path === '/login') return <Login />;
    const next = path === '/' ? '' : '?next=' + encodeURIComponent(loc.path + loc.search);
    return <Redirect to={'/login' + next} />;
  }
  if (st === 'passkey_required') return <PasskeyPrompt />;
  if (st === 'enroll_passkey') return <EnrollPasskey />;

  // full session
  if (PUBLIC_PATHS.includes(path)) {
    if (path === '/signup' && loc.query.get('reset')) return <Signup />;
    const next = loc.query.get('next');
    return <Redirect to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/'} />;
  }

  let page: ComponentChildren;
  let m: Record<string, string> | null;
  if (path === '/') page = <Projects />;
  else if ((m = match('/p/:id', path))) page = <Workspace key={m.id} projectId={Number(m.id)} />;
  else if ((m = match('/e/:id', path))) page = <ExperimentPage key={m.id} experimentId={Number(m.id)} />;
  else if (path === '/settings') page = <Settings />;
  else if (path === '/admin') page = auth.user?.is_admin ? <Admin /> : <NotFound msg="Admin only." />;
  else page = <NotFound />;
  return page;
}

function NotFound({ msg }: { msg?: string }) {
  return (
    <Shell>
      <div class="page">
        <div class="empty">
          <h2>{msg || 'Page not found'}</h2>
          <p>
            <Link href="/">Back to projects</Link>
          </p>
        </div>
      </div>
    </Shell>
  );
}

