/// <reference lib="webworker" />
import { computeStats, type Stats } from '../lib/stats';

export interface StatsRequest {
  id: number;
  runs: { x: Float64Array; y: Float64Array }[];
  lo: number;
  hi: number;
}
export interface StatsResponse {
  id: number;
  stats: Stats[];
}

self.onmessage = (e: MessageEvent<StatsRequest>) => {
  const { id, runs, lo, hi } = e.data;
  const stats = runs.map((r) => computeStats(r.x, r.y, lo, hi));
  (self as unknown as Worker).postMessage({ id, stats } satisfies StatsResponse);
};
