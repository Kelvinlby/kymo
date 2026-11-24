import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, onAuthError, type AuthState } from './api';
import { AuthContext, useAuth } from './auth';
import { Redirect, match, useLocation } from './router';
import { AppFrame, Logo, NotFound } from './components/Shell';
import { OverlayHost } from './components/overlay';
import { Button, Spinner } from './components/ui';
import { CircleExclamationPoint, RefreshCw } from './components/icons';
import { EnrollPasskey, Login, PasskeyPrompt, Setup, Signup } from './pages/Auth';
import { Overview } from './pages/Overview';
import { Projects } from './pages/Projects';
import { Suspense, lazy } from 'preact/compat';

// chart pages (uPlot) and the account pages load on demand; the overview stays in the main bundle
const Workspace = lazy(() => import('./pages/Workspace').then((m) => m.Workspace));
const ExperimentPage = lazy(() => import('./pages/Experiment').then((m) => m.ExperimentPage));
const Settings = lazy(() => import('./pages/Settings').then((m) => m.Settings));
const Admin = lazy(() => import('./pages/Admin').then((m) => m.Admin));

function PageLoading() {
  return (
    <div class="page-loading" aria-busy="true">
      <Spinner size={18} />
    </div>
  );
}

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

  return (
    <>
      {!auth ? (
        <div class="boot">
          <Logo size={36} />
          {fatal ? (
            <div class="boot-error">
              <CircleExclamationPoint size={16} aria-hidden="true" />
              <span>{fatal}</span>
              <Button size="sm" icon={RefreshCw} onClick={() => refresh().catch(() => {})}>
                Retry
              </Button>
            </div>
          ) : (
            <Spinner size={18} />
          )}
        </div>
      ) : (
        <AuthContext.Provider value={{ auth, refresh }}>
          <Guard />
        </AuthContext.Provider>
      )}
      <OverlayHost />
    </>
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
  if (path === '/') page = <Overview />;
  else if (path === '/projects') page = <Projects />;
  else if ((m = match('/p/:id', path))) page = <Workspace key={m.id} projectId={Number(m.id)} />;
  else if ((m = match('/e/:id', path))) page = <ExperimentPage key={m.id} experimentId={Number(m.id)} />;
  else if (path === '/settings') page = <Settings />;
  else if (path === '/admin') page = auth.user?.is_admin ? <Admin /> : <NotFound msg="This page is for administrators" />;
  else page = <NotFound />;
  return (
    <AppFrame>
      <Suspense fallback={<PageLoading />}>{page}</Suspense>
    </AppFrame>
  );
}

