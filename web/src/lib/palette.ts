// Command palette registry: pages contribute context items (e.g. the workspace's metrics) while mounted.
import { useEffect, useRef } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';

export interface PaletteItem {
  id: string;
  group: string;
  title: string;
  sub?: string;
  icon?: LucideIcon;
  hint?: string;
  /** extra searchable text */
  keywords?: string;
  run: () => void;
}

const providers = new Set<{ current: () => PaletteItem[] }>();

export function paletteContextItems(): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const p of providers) out.push(...p.current());
  return out;
}

export function usePaletteItems(fn: () => PaletteItem[]) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    providers.add(ref);
    return () => {
      providers.delete(ref);
    };
  }, []);
}

export interface Match {
  score: number;
  idx: number[];
}

/** Case-insensitive fuzzy match: contiguous substrings score highest, then word starts, then subsequences. */
export function fuzzy(q: string, text: string): Match | null {
  if (!q) return { score: 0, idx: [] };
  const t = text.toLowerCase();
  const ql = q.toLowerCase();
  const sub = t.indexOf(ql);
  if (sub >= 0) {
    const atWord = sub === 0 || /[\s/_.\-]/.test(t[sub - 1]);
    return { score: 1000 - sub - t.length * 0.5 + (atWord ? 200 : 0), idx: Array.from({ length: ql.length }, (_, i) => sub + i) };
  }
  const idx: number[] = [];
  let j = 0;
  let gaps = 0;
  for (let i = 0; i < t.length && j < ql.length; i++) {
    if (t[i] === ql[j]) {
      if (idx.length && i !== idx[idx.length - 1] + 1) gaps++;
      idx.push(i);
      j++;
    }
  }
  if (j < ql.length) return null;
  return { score: 500 - gaps * 20 - t.length * 0.5, idx };
}
