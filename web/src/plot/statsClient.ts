// Runs computeStats inline for small inputs and in a Web Worker for big ones (> ~2 ms of work).
import { computeStats, type Stats } from '../lib/stats';
import type { StatsRequest, StatsResponse } from './stats.worker';

const INLINE_LIMIT = 40_000; // points; ~1-2 ms incl. sorting on a laptop

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (s: Stats[]) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<StatsResponse>) => {
      const cb = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      cb?.(e.data.stats);
    };
    worker.onerror = () => {
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function statsFor(runs: { x: Float64Array; y: Float64Array }[], lo: number, hi: number): Promise<Stats[]> {
  let n = 0;
  for (const r of runs) n += r.y.length;
  const w = n > INLINE_LIMIT ? getWorker() : null;
  if (!w) return Promise.resolve(runs.map((r) => computeStats(r.x, r.y, lo, hi)));
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    // copies (structured clone) so the panel keeps its arrays
    const req: StatsRequest = { id, runs: runs.map((r) => ({ x: r.x, y: r.y })), lo, hi };
    w.postMessage(req);
  });
}
