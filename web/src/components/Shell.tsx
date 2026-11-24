// App chrome: collapsible sidebar (nav, projects, user menu), per-page breadcrumb header,
// command palette and keyboard-shortcut sheet.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { useAuth } from '../auth';
import { statusCounts, useProjectsData } from '../lib/data';
import { lsGet, lsSet } from '../lib/format';
import { MOD, useHotkeys } from '../lib/hotkeys';
import { cycleTheme, setThemePref, useTheme } from '../lib/theme';
import { Link, navigate, useLocation } from '../router';
import { CommandPalette } from './CommandPalette';
import { ChevronRight, ChevronsUpDown, FolderKanban, Keyboard, LayoutDashboard, LogOut, Monitor, Moon, PanelLeft, Plus, Search, Settings, Shield, Sun, User } from './icons';
import { ShortcutsHelp } from './ShortcutsHelp';
import { EmptyState, IconButton, MenuItem, MenuSep, Popover, Segmented, Skeleton, cx } from './ui';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" class="logo">
      <defs>
        <linearGradient id="kymo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--logo-a)" />
          <stop offset="1" stop-color="var(--logo-b)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#kymo-g)" />
      <path d="M6 22.5 L11.5 14 L16 18.5 L21.5 9 L26 13" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------- global UI state
type Overlay = 'palette' | 'shortcuts' | null;
let overlay: Overlay = null;
const overlaySubs = new Set<() => void>();
export function openOverlay(o: Overlay) {
  overlay = o;
  overlaySubs.forEach((f) => f());
}

export async function logout(refresh: () => Promise<unknown>) {
  try {
    await api.logout();
  } finally {
    await refresh().catch(() => {});
    navigate('/login');
  }
}

const NARROW = '(max-width: 1100px)';
function useSidebar(): [boolean, (b: boolean) => void] {
  const [pref, setPref] = useState<boolean | null>(() => lsGet<boolean | null>('kymo:sidebar-collapsed', null));
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const f = () => {
      setNarrow(mq.matches);
      setPref(null); // crossing the breakpoint resets to the responsive default
    };
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  const collapsed = pref ?? narrow;
  return [
    collapsed,
    (b: boolean) => {
      setPref(b);
      lsSet('kymo:sidebar-collapsed', narrow ? null : b);
    },
  ];
}

/** Logged-in app frame; mounted once so the sidebar keeps its state across pages. */
export function AppFrame({ children }: { children: ComponentChildren }) {
  const { refresh } = useAuth();
  const [collapsed, setCollapsed] = useSidebar();
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    overlaySubs.add(f);
    return () => overlaySubs.delete(f);
  }, []);
  useHotkeys({
    'mod+k': () => openOverlay(overlay === 'palette' ? null : 'palette'),
    '?': () => openOverlay('shortcuts'),
    '[': () => setCollapsed(!collapsed),
    'g o': () => navigate('/'),
    'g p': () => navigate('/projects'),
    'g s': () => navigate('/settings'),
  });
  return (
    <div class={cx('app', collapsed && 'sb-collapsed')}>
      <Sidebar collapsed={collapsed} setCollapsed={setCollapsed} />
      <div class="app-main">{children}</div>
      {overlay === 'palette' && <CommandPalette onClose={() => openOverlay(null)} onShortcuts={() => openOverlay('shortcuts')} onLogout={() => logout(refresh)} />}
      {overlay === 'shortcuts' && <ShortcutsHelp onClose={() => openOverlay(null)} />}
    </div>
  );
}

function NavItem(props: { href: string; icon: typeof Settings; label: string; active: boolean; collapsed: boolean; kbd?: string }) {
  const Icon = props.icon;
  return (
    <Link
      href={props.href}
      class={cx('nav-item', props.active && 'active')}
      aria-current={props.active ? 'page' : undefined}
      data-tip={props.collapsed ? props.label : undefined}
      data-tip-pos="right"
      aria-label={props.collapsed ? props.label : undefined}
    >
      <Icon size={17} aria-hidden="true" />
      <span class="nav-label">{props.label}</span>
    </Link>
  );
}

function Sidebar({ collapsed, setCollapsed }: { collapsed: boolean; setCollapsed: (b: boolean) => void }) {
  const { auth } = useAuth();
  const loc = useLocation();
  const d = useProjectsData();
  const path = loc.path;
  const activeProject = /^\/p\/(\d+)/.exec(path)?.[1];
  const projects = d.projects?.slice(0, 14) || null;
  return (
    <aside class="sidebar" aria-label="Main navigation">
      <div class="sb-top">
        <Link href="/" class="sb-brand" aria-label="Kymo home">
          <Logo />
          <span class="sb-brand-name">Kymo</span>
        </Link>
        <IconButton icon={PanelLeft} label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} kbd="[" class="sb-toggle" onClick={() => setCollapsed(!collapsed)} tipPos={collapsed ? 'right' : 'bottom'} />
      </div>
      <button class="sb-search" onClick={() => openOverlay('palette')} aria-label="Search and commands" data-tip={collapsed ? 'Search' : undefined} data-kbd={collapsed ? MOD + ' K' : undefined} data-tip-pos="right">
        <Search size={15} aria-hidden="true" />
        <span class="sb-search-text">Search…</span>
        <kbd class="kbd">{MOD} K</kbd>
      </button>
      <nav class="sb-nav">
        <NavItem href="/" icon={LayoutDashboard} label="Overview" active={path === '/'} collapsed={collapsed} />
        <NavItem href="/projects" icon={FolderKanban} label="Projects" active={path === '/projects'} collapsed={collapsed} />
        <NavItem href="/settings" icon={Settings} label="Settings" active={path === '/settings'} collapsed={collapsed} />
        {auth.user?.is_admin && <NavItem href="/admin" icon={Shield} label="Admin" active={path === '/admin'} collapsed={collapsed} />}
      </nav>
      <div class="sb-section">
        <div class="sb-section-head">
          <span>Projects</span>
          <IconButton icon={Plus} label="New project" size="xs" onClick={() => navigate('/projects?new=1')} />
        </div>
        <div class="sb-projects">
          {!projects &&
            [0, 1, 2].map((i) => (
              <div class="sb-proj" key={i}>
                <Skeleton w={8} h={8} r={4} />
                <Skeleton w={'60%'} h={10} />
              </div>
            ))}
          {projects?.length === 0 && <div class="sb-empty">No projects yet</div>}
          {projects?.map((p) => {
            const c = { running: p.running_count ?? statusCounts(d.exps.get(p.id)).running };
            const active = activeProject === String(p.id);
            return (
              <Link
                key={p.id}
                href={'/p/' + p.id}
                class={cx('sb-proj', active && 'active')}
                aria-current={active ? 'page' : undefined}
                data-tip={collapsed ? `${p.name} · ${p.experiment_count} runs${c.running ? ` · ${c.running} running` : ''}` : undefined}
                data-tip-pos="right"
              >
                <span class={cx('sb-dot', c.running > 0 && 'live')} aria-hidden="true" />
                <span class="sb-proj-name">{p.name}</span>
                <span class="sb-proj-count" aria-label={`${p.experiment_count} runs${c.running ? `, ${c.running} running` : ''}`}>
                  {c.running > 0 && <span class="sb-running">{c.running}</span>}
                  {p.experiment_count}
                </span>
                {collapsed && <span class="sb-proj-initial" aria-hidden="true">{p.name.slice(0, 2)}</span>}
              </Link>
            );
          })}
          {d.projects && d.projects.length > 14 && (
            <Link href="/projects" class="sb-proj sb-more">
              <span class="sb-proj-name">All {d.projects.length} projects</span>
              <ChevronRight size={14} />
            </Link>
          )}
        </div>
      </div>
      <UserMenu collapsed={collapsed} />
    </aside>
  );
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { auth, refresh } = useAuth();
  const { pref } = useTheme();
  const u = auth.user!;
  const name = u.display_name || u.username;
  return (
    <div class="sb-user">
      <Popover
        placement={collapsed ? 'right-end' : 'top-start'}
        menu
        width={248}
        trigger={(p) => (
          <button ref={p.ref as any} class="sb-user-btn" onClick={p.toggle} aria-expanded={p['aria-expanded']} aria-haspopup="menu" aria-label="Account menu">
            <User size={16} class="sb-user-ico" aria-hidden="true" />
            <span class="sb-user-text">
              <span class="sb-user-name">{name}</span>
              <span class="sb-user-sub">
                @{u.username}
                {u.is_admin ? ' · admin' : ''}
              </span>
            </span>
            <ChevronsUpDown size={14} class="sb-user-chev" aria-hidden="true" />
          </button>
        )}
      >
        {(close) => (
          <>
            <div class="menu-user">
              <div>
                <div class="menu-user-name">{name}</div>
                <div class="menu-user-sub">@{u.username}</div>
              </div>
            </div>
            <MenuSep />
            <div class="menu-theme">
              <span>Theme</span>
              <Segmented
                ariaLabel="Theme"
                value={pref}
                onChange={setThemePref}
                options={[
                  { value: 'light', icon: Sun, tip: 'Light' },
                  { value: 'dark', icon: Moon, tip: 'Dark' },
                  { value: 'system', icon: Monitor, tip: 'System' },
                ]}
              />
            </div>
            <MenuSep />
            <MenuItem icon={Settings} onSelect={() => (close(), navigate('/settings'))} kbd="g s">
              Settings
            </MenuItem>
            <MenuItem icon={Keyboard} onSelect={() => (close(), openOverlay('shortcuts'))} kbd="?">
              Keyboard shortcuts
            </MenuItem>
            <MenuSep />
            <MenuItem icon={LogOut} onSelect={() => (close(), logout(refresh))}>
              Log out
            </MenuItem>
          </>
        )}
      </Popover>
    </div>
  );
}

// ------------------------------------------------------------------------------------- page header
export interface Crumb {
  label: ComponentChildren;
  href?: string;
}

/** Page = sticky breadcrumb header + content. */
export function Page(props: { crumbs: Crumb[]; actions?: ComponentChildren; children: ComponentChildren; class?: string; flush?: boolean; title?: string }) {
  const last = props.crumbs[props.crumbs.length - 1];
  useEffect(() => {
    const t = props.title ?? (typeof last?.label === 'string' ? last.label : '');
    document.title = t ? `${t} · Kymo` : 'Kymo';
  }, [props.title, typeof last?.label === 'string' ? last.label : '']);
  return (
    <>
      <header class="page-header">
        <nav class="crumbs" aria-label="Breadcrumb">
          <ol>
            {props.crumbs.map((c, i) => {
              const isLast = i === props.crumbs.length - 1;
              return (
                <li key={i} class={isLast ? 'cur' : ''}>
                  {c.href && !isLast ? <Link href={c.href}>{c.label}</Link> : <span aria-current={isLast ? 'page' : undefined}>{c.label}</span>}
                  {!isLast && <ChevronRight size={14} class="crumb-sep" aria-hidden="true" />}
                </li>
              );
            })}
          </ol>
        </nav>
        <div class="page-actions">{props.actions}</div>
      </header>
      <main class={cx('page-body', props.flush && 'flush', props.class)} id="main">
        {props.children}
      </main>
    </>
  );
}

export function ThemeToggleButton() {
  const { theme } = useTheme();
  return <IconButton icon={theme === 'dark' ? Moon : Sun} label="Cycle theme (light / dark / system)" onClick={cycleTheme} />;
}

export function NotFound({ msg, body }: { msg?: string; body?: ComponentChildren }) {
  return (
    <Page crumbs={[{ label: 'Not found' }]}>
      <div class="page-wrap">
        <div class="card">
          <EmptyState
            icon={Search}
            title={msg || 'Page not found'}
            action={
              <Link href="/" class="btn btn-secondary btn-md">
                Back to overview
              </Link>
            }
          >
            {body || 'The page you are looking for does not exist or you do not have access to it.'}
          </EmptyState>
        </div>
      </div>
    </Page>
  );
}
