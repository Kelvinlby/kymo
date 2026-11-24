// Ctrl/⌘K command palette: jump to projects / experiments / page items, run app actions.
import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useAuth } from '../auth';
import { useProjectsData } from '../lib/data';
import { fuzzy, paletteContextItems, type PaletteItem } from '../lib/palette';
import { setThemePref, useTheme } from '../lib/theme';
import { navigate } from '../router';
import { FlaskConical, FolderKanban, KeyRound, Keyboard, LayoutDashboard, LogOut, Monitor, Moon, Plus, Search, Settings, Shield, Sun, CornerDownLeft, ArrowUp, ArrowDown } from './icons';
import { Dialog, cx } from './ui';

export function CommandPalette({ onClose, onShortcuts, onLogout }: { onClose: () => void; onShortcuts: () => void; onLogout: () => void }) {
  const { auth } = useAuth();
  const d = useProjectsData();
  const { theme } = useTheme();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    items.push(...paletteContextItems());
    const projName = new Map<number, string>();
    for (const p of d.projects || []) {
      projName.set(p.id, p.name);
      items.push({ id: 'p' + p.id, group: 'Projects', title: p.name, sub: p.description || `${p.experiment_count} experiments`, icon: FolderKanban, run: () => navigate('/p/' + p.id) });
    }
    for (const [pid, list] of d.exps) {
      for (const e of list) {
        items.push({ id: 'e' + e.id, group: 'Experiments', title: e.name, sub: projName.get(pid), icon: FlaskConical, keywords: e.tags.join(' '), run: () => navigate('/e/' + e.id) });
      }
    }
    const A = 'Actions';
    items.push({ id: 'a-newp', group: A, title: 'Create project', icon: Plus, run: () => navigate('/projects?new=1') });
    items.push({ id: 'a-token', group: A, title: 'Create API token', icon: KeyRound, keywords: 'key ingest', run: () => navigate('/settings?s=tokens&new=1') });
    items.push({
      id: 'a-theme',
      group: A,
      title: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      keywords: 'theme appearance toggle',
      run: () => setThemePref(theme === 'dark' ? 'light' : 'dark'),
    });
    items.push({ id: 'a-system', group: A, title: 'Use system theme', icon: Monitor, keywords: 'theme appearance', run: () => setThemePref('system') });
    items.push({ id: 'a-keys', group: A, title: 'Keyboard shortcuts', icon: Keyboard, hint: '?', run: onShortcuts });
    items.push({ id: 'g-home', group: 'Navigation', title: 'Go to Overview', icon: LayoutDashboard, hint: 'g o', run: () => navigate('/') });
    items.push({ id: 'g-proj', group: 'Navigation', title: 'Go to Projects', icon: FolderKanban, hint: 'g p', run: () => navigate('/projects') });
    items.push({ id: 'g-set', group: 'Navigation', title: 'Go to Settings', icon: Settings, hint: 'g s', run: () => navigate('/settings') });
    if (auth.user?.is_admin) items.push({ id: 'g-admin', group: 'Navigation', title: 'Go to Admin', icon: Shield, run: () => navigate('/admin') });
    items.push({ id: 'a-logout', group: A, title: 'Log out', icon: LogOut, run: onLogout });
    return items;
  }, [d.projects, d.exps, theme, auth.user?.is_admin]);

  const results = useMemo(() => {
    const query = q.trim();
    const order = ['Metrics', 'Projects', 'Experiments', 'Actions', 'Navigation'];
    const gi = (g: string) => (order.indexOf(g) + 1 || 99);
    if (!query) {
      // a calm default: context items first, a few projects, then actions
      const ctx = all.filter((i) => !['Projects', 'Experiments', 'Actions', 'Navigation'].includes(i.group)).slice(0, 5);
      const projs = all.filter((i) => i.group === 'Projects').slice(0, 5);
      const acts = all.filter((i) => i.group === 'Actions' || i.group === 'Navigation');
      return [...ctx, ...projs, ...acts].map((item) => ({ item, idx: [] as number[] }));
    }
    const scored: { item: PaletteItem; idx: number[]; score: number }[] = [];
    for (const item of all) {
      const m = fuzzy(query, item.title);
      const m2 = !m ? fuzzy(query, (item.sub || '') + ' ' + (item.keywords || '')) : null;
      if (m) scored.push({ item, idx: m.idx, score: m.score });
      else if (m2) scored.push({ item, idx: [], score: m2.score - 400 });
    }
    scored.sort((a, b) => b.score - a.score);
    // keep groups together, ordered by their best hit
    const perGroup = new Map<string, typeof scored>();
    for (const s of scored) {
      const l = perGroup.get(s.item.group) || [];
      if (l.length < 8) l.push(s);
      perGroup.set(s.item.group, l);
    }
    return [...perGroup.entries()].sort((a, b) => b[1][0].score - a[1][0].score || gi(a[0]) - gi(b[0])).flatMap(([, l]) => l);
  }, [q, all]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    // after the dialog unmounts and focus is restored
    setTimeout(() => r.item.run(), 0);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(sel);
    }
  };

  let lastGroup = '';
  return (
    <Dialog onClose={onClose} ariaLabel="Command palette" class="palette" backdropClass="palette-backdrop" bodyClass="palette-body-reset">
      <div class="palette-input-row">
        <Search size={18} aria-hidden="true" />
        <input
          class="palette-input"
          data-autofocus
          placeholder="Search projects, experiments, metrics and commands…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[sel] ? 'pi-' + results[sel].item.id : undefined}
          aria-label="Search"
        />
      </div>
      <div class="palette-list" id="palette-list" role="listbox" ref={listRef}>
        {results.length === 0 && <div class="palette-empty">No results for “{q}”</div>}
        {results.map((r, i) => {
          const head = r.item.group !== lastGroup ? r.item.group : null;
          lastGroup = r.item.group;
          const Icon = r.item.icon;
          return (
            <div key={r.item.id}>
              {head && <div class="palette-group">{head}</div>}
              <button
                id={'pi-' + r.item.id}
                type="button"
                role="option"
                aria-selected={i === sel}
                tabIndex={-1}
                class={cx('palette-item', i === sel && 'on')}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => run(i)}
              >
                <span class="pi-icon">{Icon && <Icon size={15} aria-hidden="true" />}</span>
                <span class="pi-text">
                  <span class="pi-title">{highlight(r.item.title, r.idx)}</span>
                  {r.item.sub && <span class="pi-sub">{r.item.sub}</span>}
                </span>
                {r.item.hint && <kbd class="kbd">{r.item.hint}</kbd>}
                {i === sel && <CornerDownLeft size={14} class="pi-hint" aria-hidden="true" />}
              </button>
            </div>
          );
        })}
      </div>
      <div class="palette-foot" aria-hidden="true">
        <span>
          <ArrowUp size={12} />
          <ArrowDown size={12} /> navigate
        </span>
        <span>
          <CornerDownLeft size={12} /> open
        </span>
        <span>
          <kbd class="kbd">Esc</kbd> close
        </span>
      </div>
    </Dialog>
  );
}

function highlight(s: string, idx: number[]) {
  if (!idx.length) return s;
  const set = new Set(idx);
  const out: (string | VNode)[] = [];
  let buf = '';
  let inMark = false;
  for (let i = 0; i <= s.length; i++) {
    const m = i < s.length && set.has(i);
    if (i === s.length || m !== inMark) {
      if (buf) out.push(inMark ? <mark key={i}>{buf}</mark> : buf);
      buf = '';
      inMark = m;
    }
    if (i < s.length) buf += s[i];
  }
  return out;
}
