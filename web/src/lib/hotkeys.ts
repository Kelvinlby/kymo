// Keyboard shortcuts: a single window listener dispatching to registered handlers, plus a
// static catalogue for the "?" help sheet.
import { useEffect, useRef } from 'preact/hooks';
import { modalOpen } from '../components/overlay';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';
export const ALT = isMac ? '⌥' : 'Alt';

export interface ShortcutDoc {
  keys: string[];
  label: string;
}
export const SHORTCUTS: { group: string; items: ShortcutDoc[] }[] = [
  {
    group: 'General',
    items: [
      { keys: [MOD, 'K'], label: 'Open command palette' },
      { keys: ['?'], label: 'Show keyboard shortcuts' },
      { keys: ['['], label: 'Collapse / expand sidebar' },
      { keys: ['g', 'o'], label: 'Go to overview' },
      { keys: ['g', 'p'], label: 'Go to projects' },
      { keys: ['g', 's'], label: 'Go to settings' },
      { keys: ['Esc'], label: 'Close dialog, popover or drawer' },
    ],
  },
  {
    group: 'Charts',
    items: [
      { keys: ['/'], label: 'Focus metric filter' },
      { keys: ['s'], label: 'Toggle smoothing' },
      { keys: ['l'], label: 'Toggle log y-axis' },
      { keys: ['x'], label: 'Cycle x-axis (step / time / relative)' },
      { keys: ['f'], label: 'Fullscreen the hovered chart (or click its title)' },
      { keys: ['Shift', 'click'], label: 'Pick charts to compare; release Shift to open them in one chart' },
      { keys: ['r'], label: 'Show / hide runs pane' },
      { keys: ['Drag'], label: 'Zoom x-axis on every chart' },
      { keys: ['Shift', 'drag'], label: 'Select a range for statistics' },
      { keys: ['Scroll'], label: 'Zoom x-axis at the mouse in fullscreen (in the grid: ' + MOD + ' + scroll or pinch)' },
      { keys: ['Scroll on an axis'], label: 'Zoom that axis in fullscreen (Shift to pan it)' },
      { keys: ['Right-drag'], label: 'Pan the chart' },
      { keys: ['Shift', 'scroll'], label: 'Pan x-axis, keeping the y-axis fixed (or scroll sideways)' },
      { keys: [ALT, 'scroll'], label: 'Zoom y-axis at the mouse' },
      { keys: ['Double-click'], label: 'Reset zoom (every chart’s x-axis)' },
    ],
  },
];

type Handler = (e: KeyboardEvent) => void;
type Map_ = Record<string, Handler>;
const scopes: { current: Map_ }[] = [];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

let pendingG = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    let key: string;
    if (mod && e.key.toLowerCase() === 'k') key = 'mod+k';
    else if (mod || e.altKey) return;
    else if (isTyping(e)) return;
    else if (modalOpen()) return;
    else {
      key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (e.key === '?') key = '?';
      if (pendingG && performance.now() - pendingG < 1200 && key.length === 1) {
        key = 'g ' + key;
        pendingG = 0;
      } else if (key === 'g') {
        pendingG = performance.now();
        return;
      }
    }
    // innermost scope wins
    for (let i = scopes.length - 1; i >= 0; i--) {
      const h = scopes[i].current[key];
      if (h) {
        e.preventDefault();
        h(e);
        return;
      }
    }
  });
}

/** Register shortcuts while mounted. Keys: 'mod+k', '?', 's', 'g o', 'Escape', ... */
export function useHotkeys(map: Map_) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    scopes.push(ref);
    return () => {
      const i = scopes.indexOf(ref);
      if (i >= 0) scopes.splice(i, 1);
    };
  }, []);
}
