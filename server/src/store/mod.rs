//! Sharded point storage. Each shard = one SQLite file + one dedicated writer thread
//! doing group commit, plus an in-memory columnar LRU cache kept current by the writer.

pub mod cache;
pub mod downsample;
mod writer;

use crate::config::Config;
use crate::db::{Db, SHARD_MIGRATIONS, migrate};
use crate::error::{ApiError, ApiResult};
use cache::{ColRef, SeriesCol, ShardCache};
use dashmap::DashMap;
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub type FastMap<K, V> = HashMap<K, V, foldhash::fast::RandomState>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Row {
    pub sid: i64,
    pub step: i64,
    pub value: f64,
    pub ts: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Summary {
    pub exp_id: i64,
    pub count: i64,
    pub first_step: i64,
    pub last_step: i64,
    /// Finite min / max (NaN when the series has no finite value).
    pub min: f64,
    pub max: f64,
    pub last_value: f64,
    pub last_ts: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ExpAgg {
    pub metric_count: i64,
    pub last_step: Option<i64>,
}

#[derive(Default)]
pub struct ShardShared {
    pub summaries: RwLock<FastMap<i64, Summary>>,
    pub exps: RwLock<FastMap<i64, ExpAgg>>,
}

pub(crate) type Ack = oneshot::Sender<Result<(), String>>;

pub(crate) enum Cmd {
    Write { exp_id: i64, rows: Vec<Row>, ack: Ack },
    Delete { exp_ids: Vec<i64>, sids: Vec<i64>, ack: Ack },
    Shutdown,
}

pub struct Shard {
    pub idx: usize,
    tx: mpsc::Sender<Cmd>,
    pub shared: Arc<ShardShared>,
    pub cache: Arc<ShardCache>,
    path: PathBuf,
    readers: Mutex<Vec<Connection>>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

/// Interned series ids of one experiment: key -> series id.
#[derive(Default)]
pub struct ExpKeys {
    pub map: RwLock<FastMap<Box<str>, i64>>,
}

pub struct Store {
    pub shards: Vec<Shard>,
    db: Arc<Db>,
    intern: DashMap<i64, Arc<ExpKeys>>,
}

/// Sort rows by (series, step), keeping the *last* occurrence of duplicate steps.
pub fn prepare_rows(rows: &mut Vec<Row>) {
    let sorted = rows.windows(2).all(|w| (w[0].sid, w[0].step) < (w[1].sid, w[1].step));
    if sorted {
        return;
    }
    rows.sort_by_key(|r| (r.sid, r.step)); // stable: arrival order kept for equal keys
    let mut w = 0usize;
    for i in 0..rows.len() {
        let r = rows[i];
        if w > 0 && rows[w - 1].sid == r.sid && rows[w - 1].step == r.step {
            rows[w - 1] = r;
        } else {
            rows[w] = r;
            w += 1;
        }
    }
    rows.truncate(w);
}

fn mix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E3779B97F4A7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

pub(crate) fn open_shard_conn(path: &PathBuf, readonly: bool) -> rusqlite::Result<Connection> {
    let c = if readonly {
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?
    } else {
        Connection::open(path)?
    };
    c.busy_timeout(Duration::from_secs(10))?;
    if !readonly {
        c.execute_batch("PRAGMA journal_mode=WAL;")?;
    }
    c.execute_batch(
        "PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY;
         PRAGMA mmap_size=1073741824; PRAGMA wal_autocheckpoint=8192;",
    )?;
    Ok(c)
}

impl Store {
    pub fn open(cfg: &Config, db: Arc<Db>) -> anyhow_like::Result<Arc<Store>> {
        // The shard count is fixed at first start (hash routing depends on it).
        let wanted = cfg.shards as i64;
        let n = db
            .with(|c| {
                let cur: Option<String> = c
                    .query_row("SELECT value FROM settings WHERE key='shards'", [], |r| r.get(0))
                    .optional()?;
                match cur.and_then(|v| v.parse::<i64>().ok()) {
                    Some(n) => Ok(n),
                    None => {
                        c.execute("INSERT INTO settings(key,value) VALUES('shards',?1)", [wanted.to_string()])?;
                        Ok(wanted)
                    }
                }
            })
            .map_err(|e| anyhow_like::Error(format!("reading shard count: {}", e.message)))?;
        if n != wanted && std::env::var("KYMO_SHARDS").is_ok() {
            tracing::warn!("KYMO_SHARDS={wanted} ignored: data dir was created with {n} shards");
        }
        let n = n as usize;
        let per_shard_budget = cfg.cache_mb.saturating_mul(1 << 20) / n;
        let mut shards = Vec::with_capacity(n);
        for idx in 0..n {
            let path = cfg.data_dir.join(format!("points-{idx}.sqlite"));
            let mut conn = open_shard_conn(&path, false)?;
            migrate(&mut conn, SHARD_MIGRATIONS)?;
            let shared = Arc::new(ShardShared::default());
            let cache = Arc::new(ShardCache::new(per_shard_budget));
            let (tx, rx) = mpsc::channel(64);
            let w = writer::Writer::new(conn, shared.clone(), cache.clone())?;
            let handle = std::thread::Builder::new()
                .name(format!("kymo-writer-{idx}"))
                .spawn(move || w.run(rx))
                .map_err(|e| anyhow_like::Error(e.to_string()))?;
            shards.push(Shard {
                idx,
                tx,
                shared,
                cache,
                path,
                readers: Mutex::new(Vec::new()),
                handle: Mutex::new(Some(handle)),
            });
        }
        tracing::info!("point store: {n} shards, cache {} MiB", cfg.cache_mb);
        Ok(Arc::new(Store { shards, db, intern: DashMap::new() }))
    }

    pub fn shard_for(&self, exp_id: i64) -> &Shard {
        &self.shards[(mix(exp_id as u64) % self.shards.len() as u64) as usize]
    }

    /// Interned key map for an experiment (loaded from meta on first use). Blocking.
    pub fn exp_keys(&self, exp_id: i64) -> ApiResult<Arc<ExpKeys>> {
        if let Some(k) = self.intern.get(&exp_id) {
            return Ok(k.clone());
        }
        let ek = Arc::new(ExpKeys::default());
        self.db.with(|c| {
            let mut st = c.prepare_cached("SELECT key, id FROM series WHERE experiment_id=?1")?;
            let mut m = ek.map.write();
            let mut rows = st.query([exp_id])?;
            while let Some(r) = rows.next()? {
                let k: String = r.get(0)?;
                m.insert(k.into_boxed_str(), r.get(1)?);
            }
            Ok(())
        })?;
        Ok(self.intern.entry(exp_id).or_insert(ek).clone())
    }

    /// Create (or fetch) series rows for `keys`, updating the intern map. Blocking.
    pub fn create_series(&self, exp_id: i64, keys: &[&str]) -> ApiResult<()> {
        let ek = self.exp_keys(exp_id)?;
        let created = self.db.with(|c| {
            let tx = c.transaction()?;
            let mut out = Vec::with_capacity(keys.len());
            {
                let mut ins = tx.prepare_cached(
                    "INSERT INTO series(experiment_id, key) VALUES(?1, ?2)
                     ON CONFLICT(experiment_id, key) DO UPDATE SET key=excluded.key RETURNING id",
                )?;
                for k in keys {
                    let id: i64 = ins.query_row(params![exp_id, k], |r| r.get(0))?;
                    out.push((*k, id));
                }
            }
            tx.commit()?;
            Ok(out)
        })?;
        let mut m = ek.map.write();
        for (k, id) in created {
            m.insert(k.into(), id);
        }
        Ok(())
    }

    pub fn forget_experiment(&self, exp_id: i64) {
        self.intern.remove(&exp_id);
    }

    /// Queue rows (already `prepare_rows`-ed) and wait for the durable commit.
    pub async fn write(&self, exp_id: i64, rows: Vec<Row>) -> ApiResult<()> {
        let (ack, rx) = oneshot::channel();
        let shard = self.shard_for(exp_id);
        shard
            .tx
            .send(Cmd::Write { exp_id, rows, ack })
            .await
            .map_err(|_| ApiError::unavailable("server is shutting down"))?;
        match rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(ApiError::internal(format!("shard {} commit failed: {e}", shard.idx))),
            Err(_) => Err(ApiError::unavailable("writer stopped")),
        }
    }

    /// Delete all points/summaries of the given experiments (`(exp_id, series ids)`).
    pub async fn delete_experiments(&self, list: Vec<(i64, Vec<i64>)>) -> ApiResult<()> {
        let mut by_shard: HashMap<usize, (Vec<i64>, Vec<i64>)> = HashMap::new();
        for (e, sids) in list {
            self.forget_experiment(e);
            let s = by_shard.entry(self.shard_for(e).idx).or_default();
            s.0.push(e);
            s.1.extend(sids);
        }
        for (idx, (exp_ids, sids)) in by_shard {
            let (ack, rx) = oneshot::channel();
            self.shards[idx]
                .tx
                .send(Cmd::Delete { exp_ids, sids, ack })
                .await
                .map_err(|_| ApiError::unavailable("server is shutting down"))?;
            rx.await
                .map_err(|_| ApiError::unavailable("writer stopped"))?
                .map_err(|e| ApiError::internal(format!("delete failed: {e}")))?;
        }
        Ok(())
    }

    fn load(&self, shard: &Shard, sid: i64) -> rusqlite::Result<SeriesCol> {
        let hint = shard.shared.summaries.read().get(&sid).map(|s| s.count as usize).unwrap_or(0);
        let conn = shard.readers.lock().pop();
        let conn = match conn {
            Some(c) => c,
            None => open_shard_conn(&shard.path, true)?,
        };
        let res = (|| {
            let mut st = conn.prepare_cached("SELECT step, value, ts FROM points WHERE series_id=?1 ORDER BY step")?;
            let mut col = SeriesCol::with_capacity(hint);
            let mut rows = st.query([sid])?;
            while let Some(r) = rows.next()? {
                col.steps.push(r.get(0)?);
                col.values.push(r.get::<_, Option<f64>>(1)?.unwrap_or(f64::NAN));
                col.ts.push(r.get(2)?);
            }
            col.steps.shrink_to_fit();
            col.values.shrink_to_fit();
            col.ts.shrink_to_fit();
            col.rebuild_blocks(0);
            Ok(col)
        })();
        let mut p = shard.readers.lock();
        if p.len() < 16 {
            p.push(conn);
        }
        res
    }

    /// Columnar data of a series, from the cache or loaded from SQLite. Blocking.
    pub fn column(&self, exp_id: i64, sid: i64) -> ApiResult<ColRef> {
        let shard = self.shard_for(exp_id);
        shard.cache.get_or_load(sid, || self.load(shard, sid)).map_err(ApiError::from)
    }

    pub fn summary(&self, exp_id: i64, sid: i64) -> Option<Summary> {
        self.shard_for(exp_id).shared.summaries.read().get(&sid).copied()
    }

    pub fn exp_agg(&self, exp_id: i64) -> ExpAgg {
        self.shard_for(exp_id).shared.exps.read().get(&exp_id).copied().unwrap_or_default()
    }

    pub fn cache_bytes(&self) -> usize {
        self.shards.iter().map(|s| s.cache.stats().bytes).sum()
    }

    /// Drain every writer queue, commit, checkpoint and join the writer threads.
    pub async fn shutdown(&self) {
        for s in &self.shards {
            let _ = s.tx.send(Cmd::Shutdown).await;
        }
        for s in &self.shards {
            let h = s.handle.lock().take();
            if let Some(h) = h {
                let _ = tokio::task::spawn_blocking(move || h.join()).await;
            }
        }
        tracing::info!("point store flushed and closed");
    }
}

/// Tiny error type for startup paths (keeps us free of an `anyhow` dependency).
pub mod anyhow_like {
    #[derive(Debug)]
    pub struct Error(pub String);
    impl std::fmt::Display for Error {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.0)
        }
    }
    impl std::error::Error for Error {}
    impl From<rusqlite::Error> for Error {
        fn from(e: rusqlite::Error) -> Self {
            Error(e.to_string())
        }
    }
    impl From<std::io::Error> for Error {
        fn from(e: std::io::Error) -> Self {
            Error(e.to_string())
        }
    }
    pub type Result<T> = std::result::Result<T, Error>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepare_dedup_last_wins() {
        let r = |sid, step, value| Row { sid, step, value, ts: 0.0 };
        let mut v = vec![r(2, 1, 1.0), r(1, 5, 1.0), r(1, 5, 2.0), r(1, 3, 0.0), r(2, 1, 9.0)];
        prepare_rows(&mut v);
        assert_eq!(v, vec![r(1, 3, 0.0), r(1, 5, 2.0), r(2, 1, 9.0)]);
    }
}
