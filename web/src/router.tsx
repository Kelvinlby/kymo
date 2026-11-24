// Tiny history-API router.
import type { AnchorHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

type Loc = { path: string; search: string };
const listeners = new Set<(l: Loc) => void>();
const cur = (): Loc => ({ path: location.pathname, search: location.search });

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const now = location.pathname + location.search + location.hash;
  if (to !== now) {
    if (opts.replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
  }
  const l = cur();
  for (const fn of listeners) fn(l);
  if (!opts.replace) window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => {
  const l = cur();
  for (const fn of listeners) fn(l);
});

export function useLocation(): Loc & { query: URLSearchParams } {
  const [loc, setLoc] = useState(cur);
  useEffect(() => {
    const fn = (l: Loc) => setLoc(l);
    listeners.add(fn);
    // a child <Redirect> may have navigated before this effect subscribed
    const now = cur();
    setLoc((l) => (l.path === now.path && l.search === now.search ? l : now));
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return { ...loc, query: new URLSearchParams(loc.search) };
}

/** Match "/p/:id" against a path; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) out[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return out;
}

export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ComponentChildren }) {
  const { href, onClick, ...rest } = props;
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (onClick) (onClick as (e: MouseEvent) => void)(e as unknown as MouseEvent);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if ((rest as { target?: string }).target === '_blank') return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}
