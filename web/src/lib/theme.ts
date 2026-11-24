// Theme preference (light / dark / system), applied as <html data-theme="...">.
// index.html sets the attribute before first paint to avoid a flash.
import { useEffect, useState } from 'preact/hooks';

export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const KEY = 'kymo:theme';
const listeners = new Set<() => void>();
let pref: ThemePref = readPref();
let version = 0;

function readPref(): ThemePref {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '"system"');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolvedTheme(): Theme {
  if (pref === 'system') return mq?.matches ? 'dark' : 'light';
  return pref;
}

function apply() {
  const t = resolvedTheme();
  const el = document.documentElement;
  if (el.dataset.theme !== t) el.dataset.theme = t;
  el.style.colorScheme = t;
  version++;
  for (const fn of listeners) fn();
}

export function themePref(): ThemePref {
  return pref;
}
export function themeVersion(): number {
  return version;
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
  apply();
}

/** Cycle light -> dark -> system. */
export function cycleTheme() {
  setThemePref(pref === 'light' ? 'dark' : pref === 'dark' ? 'system' : 'light');
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme() {
  mq?.addEventListener('change', () => pref === 'system' && apply());
  apply();
  // canvases measure text: redraw once web fonts are in
  document.fonts?.ready.then(() => {
    version++;
    for (const fn of listeners) fn();
  });
}

export function useTheme(): { pref: ThemePref; theme: Theme; version: number } {
  const [, set] = useState(0);
  useEffect(() => onThemeChange(() => set((n) => n + 1)), []);
  return { pref, theme: resolvedTheme(), version };
}
