// Formatting / small utilities shared by pages.

/** Accepts RFC3339 strings, unix seconds or unix milliseconds. */
export function toDate(t: string | number | null | undefined): Date | null {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return new Date(t > 1e12 ? t : t * 1000);
  if (/^\d+(\.\d+)?$/.test(t)) return toDate(Number(t));
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

export function toUnixSeconds(t: string | number | null | undefined): number | null {
  const d = toDate(t);
  return d ? d.getTime() / 1000 : null;
}

export function relTime(t: string | number | null | undefined, now = Date.now()): string {
  const d = toDate(t);
  if (!d) return '—';
  const s = Math.round((now - d.getTime()) / 1000);
  const a = Math.abs(s);
  const suf = s >= 0 ? ' ago' : ' from now';
  if (a < 10) return 'just now';
  if (a < 60) return a + 's' + suf;
  if (a < 3600) return Math.floor(a / 60) + 'm' + suf;
  if (a < 86400) return Math.floor(a / 3600) + 'h' + suf;
  if (a < 86400 * 30) return Math.floor(a / 86400) + 'd' + suf;
  return d.toLocaleDateString();
}

export function absTime(t: string | number | null | undefined): string {
  const d = toDate(t);
  return d ? d.toLocaleString() : '—';
}

/** Compact number for tables / tooltips. */
export function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v == null || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(Math.max(1, digits - 2));
  if (Number.isInteger(v) && a < 1e6) return v.toString();
  return Number(v.toPrecision(digits)).toString();
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

/** 1234567 -> "1.23M" for axis ticks. */
export function fmtSI(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return +(v / 1e9).toPrecision(3) + 'B';
  if (a >= 1e6) return +(v / 1e6).toPrecision(3) + 'M';
  if (a >= 1e4) return +(v / 1e3).toPrecision(3) + 'k';
  return String(+v.toPrecision(4));
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  const s = Math.abs(sec);
  const sign = sec < 0 ? '-' : '';
  if (s < 60) return sign + s.toFixed(s < 10 ? 1 : 0) + 's';
  if (s < 3600) return sign + Math.floor(s / 60) + 'm' + (Math.floor(s % 60) ? Math.floor(s % 60) + 's' : '');
  if (s < 86400) return sign + Math.floor(s / 3600) + 'h' + (Math.floor((s % 3600) / 60) ? Math.floor((s % 3600) / 60) + 'm' : '');
  return sign + Math.floor(s / 86400) + 'd' + (Math.floor((s % 86400) / 3600) ? Math.floor((s % 86400) / 3600) + 'h' : '');
}

const chunkRe = /(\d+)|(\D+)/g;
/** Natural order: layer2 < layer10. */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(chunkRe) || [];
  const bx = b.match(chunkRe) || [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i], y = bx[i];
    if (x === y) continue;
    const dx = x.charCodeAt(0), dy = y.charCodeAt(0);
    const nx = dx >= 48 && dx <= 57, ny = dy >= 48 && dy <= 57;
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      if (x.length !== y.length) return x.length - y.length;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}

export interface KeyGroup {
  name: string; // '' for keys without '/'
  keys: string[];
}
/** Group metric keys by the prefix before the first '/'. Ungrouped keys come first. Keeps input order inside groups. */
export function groupKeys(keys: string[]): KeyGroup[] {
  const m = new Map<string, string[]>();
  for (const k of keys) {
    const i = k.indexOf('/');
    const g = i > 0 ? k.slice(0, i) : '';
    let a = m.get(g);
    if (!a) m.set(g, (a = []));
    a.push(k);
  }
  const out = [...m.entries()].map(([name, ks]) => ({ name, keys: ks }));
  out.sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : naturalCompare(a.name, b.name)));
  return out;
}

/** Compile a user filter: /regex/flags, or a plain string treated as a case-insensitive regex (falls back to substring). */
export function compileFilter(q: string): { test: (s: string) => boolean; error?: string } {
  const t = q.trim();
  if (!t) return { test: () => true };
  const m = t.match(/^\/(.*)\/([a-z]*)$/);
  try {
    const re = m ? new RegExp(m[1], m[2]) : new RegExp(t, 'i');
    return { test: (s) => re.test(s) };
  } catch (e) {
    const low = t.toLowerCase();
    return { test: (s) => s.toLowerCase().includes(low), error: (e as Error).message };
  }
}

const isPlainObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Flatten nested config into dotted paths: {model:{d:1}} -> {"model.d": 1}. Arrays of primitives stay
 * values (shown as chips); arrays containing objects are flattened by index (`layers.0.dim`).
 */
export function flattenConfig(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isPlainObj(obj)) {
    const entries = Object.entries(obj);
    if (!entries.length && prefix) out[prefix] = {};
    for (const [k, v] of entries) {
      const p = prefix ? prefix + '.' + k : k;
      if (isPlainObj(v) || (Array.isArray(v) && v.some((x) => isPlainObj(x) || Array.isArray(x)))) flattenConfig(v, p, out);
      else out[p] = v;
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      const p = prefix + '.' + i;
      if (isPlainObj(v) || Array.isArray(v)) flattenConfig(v, p, out);
      else out[p] = v;
    });
  }
  return out;
}

/** Config number: 3e-4, 4,194,304, 0.95, 1.5e+9 — compact but exact enough to recognise a value. */
export function fmtConfigNumber(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? '∞' : '-∞';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (Number.isInteger(v) && a < 1e15) return v.toLocaleString('en-US');
  if (a < 1e-3 || a >= 1e9) {
    const [m, e] = v.toExponential().split('e');
    const mant = String(Number(Number(m).toPrecision(6)));
    return mant + 'e' + (e.startsWith('+') ? e.slice(1) : e);
  }
  return String(Number(v.toPrecision(8)));
}

export type ConfigKind = 'number' | 'boolean' | 'string' | 'null' | 'array' | 'object';
export function configKind(v: unknown): ConfigKind {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return t;
  return 'object';
}

/** One-line text form of a config value (tables, copy-to-clipboard, search). */
export function fmtConfigValue(v: unknown): string {
  switch (configKind(v)) {
    case 'null':
      return v === null ? 'null' : '';
    case 'number':
      return fmtConfigNumber(v as number);
    case 'string':
      return v as string;
    case 'boolean':
      return String(v);
    case 'array':
      return (v as unknown[]).map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : fmtConfigValue(x))).join(', ');
    default:
      return Object.keys(v as object).length ? JSON.stringify(v) : '{}';
  }
}

/** Raw value for copying: numbers in full precision, strings as-is. */
export function rawConfigValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function downloadBlob(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s == null ? fallback : (JSON.parse(s) as T);
  } catch {
    return fallback;
  }
}
export function lsSet(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
