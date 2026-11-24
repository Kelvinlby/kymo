//! Per-shard LRU (by bytes) cache of full columnar series.
//!
//! Consistency with the writer uses a *loading placeholder*: a reader inserts
//! `Loading` before it opens its SQLite read snapshot; the writer, after each commit,
//! appends committed rows to `Ready` entries and queues them on `Loading` entries.
//! When the load finishes the queued rows are merged (upsert semantics make the
//! overlap with the snapshot harmless), so no committed write is ever lost.

use super::Row;
use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// Pre-aggregated block of `BLOCK` consecutive points (finite values only).
#[derive(Clone, Copy, Debug)]
pub struct Blk {
    pub sum: f64,
    pub cnt: f64,
    pub min: f64,
    pub max: f64,
}

pub const BLOCK: usize = 64;

#[derive(Default, Debug, Clone)]
pub struct SeriesCol {
    pub steps: Vec<i64>,
    pub values: Vec<f64>,
    pub ts: Vec<f64>,
    /// One aggregate per BLOCK points (last one may be partial); lets downsampling read
    /// ~4-16x less memory on large series. Kept current by `merge`.
    pub blocks: Vec<Blk>,
}

impl SeriesCol {
    pub fn with_capacity(n: usize) -> Self {
        SeriesCol {
            steps: Vec::with_capacity(n),
            values: Vec::with_capacity(n),
            ts: Vec::with_capacity(n),
            blocks: Vec::with_capacity(n / BLOCK + 1),
        }
    }

    /// Recompute block aggregates from the block containing point `from` onwards.
    pub fn rebuild_blocks(&mut self, from: usize) {
        let b0 = (from / BLOCK).min(self.blocks.len());
        self.blocks.truncate(b0);
        let mut i = b0 * BLOCK;
        while i < self.values.len() {
            let e = (i + BLOCK).min(self.values.len());
            let (sum, cnt, min, max) = super::downsample::agg(&self.values[i..e]);
            self.blocks.push(Blk { sum, cnt: cnt as f64, min, max });
            i = e;
        }
    }

    pub fn blocks_valid(&self) -> bool {
        self.blocks.len() == self.values.len().div_ceil(BLOCK)
    }
    pub fn len(&self) -> usize {
        self.steps.len()
    }
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
    pub fn bytes(&self) -> usize {
        self.steps.capacity() * 8 + self.values.capacity() * 8 + self.ts.capacity() * 8 + self.blocks.capacity() * 32 + 96
    }

    /// Upsert a run of rows sorted by step (no duplicate steps). Last write wins.
    pub fn merge(&mut self, rows: &[Row]) {
        if rows.is_empty() {
            return;
        }
        if self.steps.last().is_none_or(|&l| rows[0].step > l) {
            let old = self.steps.len();
            self.steps.extend(rows.iter().map(|r| r.step));
            self.values.extend(rows.iter().map(|r| r.value));
            self.ts.extend(rows.iter().map(|r| r.ts));
            self.rebuild_blocks(old);
            return;
        }
        // Rare path (retries / out-of-order steps): find the first affected index, merge the tail.
        let start = self.steps.partition_point(|&s| s < rows[0].step);
        let tail_len = self.steps.len() - start;
        let mut s = Vec::with_capacity(tail_len + rows.len());
        let mut v = Vec::with_capacity(tail_len + rows.len());
        let mut t = Vec::with_capacity(tail_len + rows.len());
        let (mut i, mut j) = (start, 0);
        while i < self.steps.len() || j < rows.len() {
            let take_new = if i >= self.steps.len() {
                true
            } else if j >= rows.len() {
                false
            } else {
                rows[j].step <= self.steps[i]
            };
            if take_new {
                if i < self.steps.len() && self.steps[i] == rows[j].step {
                    i += 1; // replaced
                }
                s.push(rows[j].step);
                v.push(rows[j].value);
                t.push(rows[j].ts);
                j += 1;
            } else {
                s.push(self.steps[i]);
                v.push(self.values[i]);
                t.push(self.ts[i]);
                i += 1;
            }
        }
        self.steps.truncate(start);
        self.values.truncate(start);
        self.ts.truncate(start);
        self.steps.extend_from_slice(&s);
        self.values.extend_from_slice(&v);
        self.ts.extend_from_slice(&t);
        self.rebuild_blocks(start);
    }
}

pub type ColRef = Arc<RwLock<SeriesCol>>;

enum Slot {
    Loading { id: u64, pending: Vec<Vec<Row>> },
    Ready(ColRef),
}

struct Entry {
    slot: Slot,
    tick: u64,
    bytes: usize,
}

#[derive(Default)]
struct Inner {
    map: HashMap<i64, Entry>,
    lru: BTreeMap<u64, i64>,
    tick: u64,
    bytes: usize,
    load_id: u64,
}

impl Inner {
    fn next_tick(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }
    fn touch(&mut self, sid: i64) {
        let t = self.next_tick();
        if let Some(e) = self.map.get_mut(&sid) {
            if matches!(e.slot, Slot::Ready(_)) {
                self.lru.remove(&e.tick);
                self.lru.insert(t, sid);
            }
            e.tick = t;
        }
    }
    fn evict(&mut self, budget: usize) {
        while self.bytes > budget {
            let Some((_, sid)) = self.lru.pop_first() else { break };
            if let Some(e) = self.map.remove(&sid) {
                self.bytes -= e.bytes;
            }
        }
    }
}

pub struct ShardCache {
    inner: Mutex<Inner>,
    budget: usize,
}

pub struct CacheStats {
    pub entries: usize,
    pub bytes: usize,
}

impl ShardCache {
    pub fn new(budget: usize) -> Self {
        ShardCache { inner: Mutex::new(Inner::default()), budget }
    }

    pub fn stats(&self) -> CacheStats {
        let g = self.inner.lock();
        CacheStats { entries: g.map.len(), bytes: g.bytes }
    }

    /// Returns the cached series, or loads it with `loader` (outside the lock) and caches it.
    pub fn get_or_load<E>(
        &self,
        sid: i64,
        loader: impl FnOnce() -> Result<SeriesCol, E>,
    ) -> Result<ColRef, E> {
        let id = {
            let mut g = self.inner.lock();
            match g.map.get(&sid).map(|e| &e.slot) {
                Some(Slot::Ready(c)) => {
                    let c = c.clone();
                    g.touch(sid);
                    return Ok(c);
                }
                Some(Slot::Loading { .. }) => None,
                None => {
                    g.load_id += 1;
                    let id = g.load_id;
                    let t = g.next_tick();
                    g.map.insert(sid, Entry { slot: Slot::Loading { id, pending: Vec::new() }, tick: t, bytes: 0 });
                    Some(id)
                }
            }
        };
        let Some(id) = id else {
            // Someone else is loading it: serve an uncached copy.
            return loader().map(|c| Arc::new(RwLock::new(c)));
        };
        let mut col = match loader() {
            Ok(c) => c,
            Err(e) => {
                let mut g = self.inner.lock();
                if matches!(g.map.get(&sid), Some(Entry { slot: Slot::Loading { id: i, .. }, .. }) if *i == id) {
                    g.map.remove(&sid);
                }
                return Err(e);
            }
        };
        let mut guard = self.inner.lock();
        let g = &mut *guard;
        let ours = matches!(g.map.get(&sid), Some(Entry { slot: Slot::Loading { id: i, .. }, .. }) if *i == id);
        if !ours {
            return Ok(Arc::new(RwLock::new(col)));
        }
        let e = g.map.get_mut(&sid).unwrap();
        if let Slot::Loading { pending, .. } = &mut e.slot {
            for run in pending.drain(..) {
                col.merge(&run);
            }
        }
        let bytes = col.bytes();
        let c = Arc::new(RwLock::new(col));
        e.slot = Slot::Ready(c.clone());
        e.bytes = bytes;
        let old_tick = e.tick;
        g.lru.remove(&old_tick);
        g.bytes += bytes;
        g.touch(sid);
        let budget = self.budget;
        g.evict(budget);
        Ok(c)
    }

    /// Called by the shard writer after a commit with `rows` sorted by (sid, step).
    pub fn apply(&self, rows: &[Row]) {
        if rows.is_empty() {
            return;
        }
        let mut ready: Vec<(i64, ColRef, std::ops::Range<usize>)> = Vec::new();
        {
            let mut g = self.inner.lock();
            if g.map.is_empty() {
                return;
            }
            let mut i = 0;
            while i < rows.len() {
                let sid = rows[i].sid;
                let mut j = i + 1;
                while j < rows.len() && rows[j].sid == sid {
                    j += 1;
                }
                if let Some(e) = g.map.get_mut(&sid) {
                    match &mut e.slot {
                        Slot::Ready(c) => ready.push((sid, c.clone(), i..j)),
                        Slot::Loading { pending, .. } => pending.push(rows[i..j].to_vec()),
                    }
                }
                i = j;
            }
        }
        if ready.is_empty() {
            return;
        }
        let mut deltas = Vec::with_capacity(ready.len());
        for (sid, c, r) in &ready {
            let mut w = c.write();
            w.merge(&rows[r.clone()]);
            deltas.push((*sid, w.bytes()));
        }
        let mut guard = self.inner.lock();
        let g = &mut *guard;
        for (sid, nb) in deltas {
            if let Some(e) = g.map.get_mut(&sid) {
                let ob = e.bytes;
                e.bytes = nb;
                g.bytes = g.bytes + nb - ob;
            }
        }
        let budget = self.budget;
        g.evict(budget);
    }

    pub fn remove(&self, sids: &[i64]) {
        let mut g = self.inner.lock();
        for sid in sids {
            if let Some(e) = g.map.remove(sid) {
                g.bytes -= e.bytes;
                g.lru.remove(&e.tick);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(step: i64, value: f64) -> Row {
        Row { sid: 1, step, value, ts: step as f64 }
    }
    #[test]
    fn merge_paths() {
        let mut c = SeriesCol::default();
        c.merge(&[r(1, 1.0), r(3, 3.0)]);
        c.merge(&[r(5, 5.0)]);
        c.merge(&[r(0, 0.0), r(3, 33.0), r(4, 4.0)]);
        assert_eq!(c.steps, vec![0, 1, 3, 4, 5]);
        assert_eq!(c.values, vec![0.0, 1.0, 33.0, 4.0, 5.0]);
    }
}
