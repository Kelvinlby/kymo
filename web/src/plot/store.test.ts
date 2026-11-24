import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeriesStore } from './store';

function mockFetch() {
  const calls: any[] = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const series = body.series.map((s: any) => ({ ...s, total: 3, downsampled: false, step: [0, 1, 2], value: [1, null, 3], ts: [10, 11, 12] }));
    return new Response(JSON.stringify({ series }), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

describe('SeriesStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('batches requests made in the same tick into one POST per window', async () => {
    const calls = mockFetch();
    const st = new SeriesStore();
    const a = st.get({ experiment_id: 1, key: 'a' }, null, 1000);
    const b = st.get({ experiment_id: 2, key: 'a' }, null, 1000);
    const a2 = st.get({ experiment_id: 1, key: 'a' }, null, 1000); // deduped
    const z = st.get({ experiment_id: 1, key: 'a' }, { min: 0, max: 1 }, 2000);
    const [da, db, da2, dz] = await Promise.all([a, b, a2, z]);
    expect(calls.length).toBe(2);
    expect(calls[0].series.length).toBe(2);
    expect(calls[1].step_min).toBe(0);
    expect(da).toBe(da2);
    expect(db.experimentId).toBe(2);
    expect(Number.isNaN(da.value[1])).toBe(true);
    expect(dz.window).toEqual({ min: 0, max: 1 });
  });

  it('serves fresh cache without fetching and refetches after invalidate', async () => {
    const calls = mockFetch();
    const st = new SeriesStore();
    const ref = { experiment_id: 1, key: 'a' };
    await st.get(ref, null, 1000);
    await st.get(ref, null, 1000);
    expect(calls.length).toBe(1);
    let notified = 0;
    st.subscribe(['1\u0000a'], () => notified++);
    st.invalidate(1, 'a');
    expect(notified).toBe(1);
    expect(st.peek(ref, null, 1000)!.fresh).toBe(false);
    await st.get(ref, null, 1000);
    expect(calls.length).toBe(2);
    expect(st.peek(ref, null, 1000)!.fresh).toBe(true);
    expect(st.runStartTs(1)).toBe(10);
  });
});
