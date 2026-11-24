//! Shard writer thread: group commit of everything queued (≤ MAX_GROUP_ROWS rows) in
//! one transaction, summary maintenance, cache update, then oneshot acks.

use super::cache::ShardCache;
use super::{Ack, Cmd, ExpAgg, FastMap, ShardShared, Summary};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

const MAX_GROUP_ROWS: usize = 200_000;

const SQL_UPSERT: &str = "INSERT INTO points(series_id, step, value, ts) VALUES(?1, ?2, ?3, ?4)
     ON CONFLICT(series_id, step) DO UPDATE SET value=excluded.value, ts=excluded.ts";
const SQL_INSERT_IGNORE: &str = "INSERT OR IGNORE INTO points(series_id, step, value, ts) VALUES(?1, ?2, ?3, ?4)";
const SQL_UPDATE_CHANGED: &str = "UPDATE points SET value=?3, ts=?4
     WHERE series_id=?1 AND step=?2 AND (value IS NOT ?3 OR ts IS NOT ?4)";
const SQL_SUMMARY_PUT: &str = "INSERT OR REPLACE INTO summaries(series_id, experiment_id, count, first_step,
     last_step, min, max, last_value, last_ts) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)";

pub(crate) struct Writer {
    conn: Connection,
    sums: FastMap<i64, Summary>,
    exps: FastMap<i64, ExpAgg>,
    shared: Arc<ShardShared>,
    cache: Arc<ShardCache>,
}

#[inline]
fn fin(v: f64) -> bool {
    v.is_finite()
}

fn nan_none(v: f64) -> Option<f64> {
    if v.is_nan() { None } else { Some(v) }
}

impl Writer {
    pub fn new(conn: Connection, shared: Arc<ShardShared>, cache: Arc<ShardCache>) -> rusqlite::Result<Self> {
        let mut w = Writer { conn, sums: FastMap::default(), exps: FastMap::default(), shared, cache };
        w.reload()?;
        Ok(w)
    }

    /// (Re)load summaries from disk and publish them.
    fn reload(&mut self) -> rusqlite::Result<()> {
        self.sums.clear();
        self.exps.clear();
        {
            let mut st = self.conn.prepare(
                "SELECT series_id, experiment_id, count, first_step, last_step, min, max, last_value, last_ts FROM summaries",
            )?;
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let s = Summary {
                    exp_id: r.get(1)?,
                    count: r.get(2)?,
                    first_step: r.get(3)?,
                    last_step: r.get(4)?,
                    min: r.get::<_, Option<f64>>(5)?.unwrap_or(f64::NAN),
                    max: r.get::<_, Option<f64>>(6)?.unwrap_or(f64::NAN),
                    last_value: r.get::<_, Option<f64>>(7)?.unwrap_or(f64::NAN),
                    last_ts: r.get(8)?,
                };
                self.sums.insert(r.get(0)?, s);
            }
        }
        for s in self.sums.values() {
            let e = self.exps.entry(s.exp_id).or_default();
            e.metric_count += 1;
            e.last_step = Some(e.last_step.map_or(s.last_step, |l| l.max(s.last_step)));
        }
        *self.shared.summaries.write() = self.sums.clone();
        *self.shared.exps.write() = self.exps.clone();
        Ok(())
    }

    pub fn run(mut self, mut rx: mpsc::Receiver<Cmd>) {
        let mut stop = false;
        let mut batch: Vec<Cmd> = Vec::new();
        while !stop {
            let Some(first) = rx.blocking_recv() else { break };
            let mut rows = 0usize;
            let push = |c: Cmd, batch: &mut Vec<Cmd>, stop: &mut bool| -> usize {
                let n = if let Cmd::Write { rows: r, .. } = &c { r.len() } else { 0 };
                if matches!(c, Cmd::Shutdown) {
                    *stop = true;
                } else {
                    batch.push(c);
                }
                n
            };
            rows += push(first, &mut batch, &mut stop);
            // Group commit: take whatever else is already queued.
            while !stop && rows < MAX_GROUP_ROWS {
                match rx.try_recv() {
                    Ok(c) => rows += push(c, &mut batch, &mut stop),
                    Err(_) => break,
                }
            }
            if !batch.is_empty() {
                self.process(std::mem::take(&mut batch));
            }
        }
        // Drain anything still queued (shutdown path) so no acked-later write is lost.
        rx.close();
        let mut rest = Vec::new();
        while let Ok(c) = rx.try_recv() {
            if !matches!(c, Cmd::Shutdown) {
                rest.push(c);
            }
        }
        if !rest.is_empty() {
            self.process(rest);
        }
        if let Err(e) = self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
            tracing::warn!("checkpoint at shutdown failed: {e}");
        }
    }

    fn process(&mut self, batch: Vec<Cmd>) {
        let t0 = Instant::now();
        let mut touched: HashSet<i64, foldhash::fast::RandomState> = HashSet::default();
        let mut touched_exps: HashSet<i64, foldhash::fast::RandomState> = HashSet::default();
        let mut deleted_sids: Vec<i64> = Vec::new();
        let mut deleted_exps: Vec<i64> = Vec::new();
        let res = (|| -> rusqlite::Result<usize> {
            let tx = self.conn.transaction()?;
            let mut nrows = 0usize;
            let mut dirty: HashSet<i64, foldhash::fast::RandomState> = HashSet::default();
            {
                let mut upsert = tx.prepare_cached(SQL_UPSERT)?;
                let mut ins_ignore = tx.prepare_cached(SQL_INSERT_IGNORE)?;
                let mut upd = tx.prepare_cached(SQL_UPDATE_CHANGED)?;
                for cmd in &batch {
                    match cmd {
                        Cmd::Write { exp_id, rows, .. } => {
                            nrows += rows.len();
                            touched_exps.insert(*exp_id);
                            let mut last_sid = i64::MIN;
                            for r in rows {
                                if r.sid != last_sid {
                                    touched.insert(r.sid);
                                    last_sid = r.sid;
                                }
                                let val = nan_none(r.value);
                                match self.sums.get_mut(&r.sid) {
                                    Some(s) if r.step > s.last_step => {
                                        upsert.execute(params![r.sid, r.step, val, r.ts])?;
                                        s.count += 1;
                                        s.last_step = r.step;
                                        s.last_value = r.value;
                                        s.last_ts = r.ts;
                                        if fin(r.value) {
                                            if !(s.min <= r.value) {
                                                s.min = r.value;
                                            }
                                            if !(s.max >= r.value) {
                                                s.max = r.value;
                                            }
                                        }
                                    }
                                    Some(s) => {
                                        if ins_ignore.execute(params![r.sid, r.step, val, r.ts])? == 1 {
                                            s.count += 1;
                                            s.first_step = s.first_step.min(r.step);
                                            if r.step == s.last_step {
                                                s.last_value = r.value;
                                                s.last_ts = r.ts;
                                            }
                                            if fin(r.value) {
                                                if !(s.min <= r.value) {
                                                    s.min = r.value;
                                                }
                                                if !(s.max >= r.value) {
                                                    s.max = r.value;
                                                }
                                            }
                                        } else if upd.execute(params![r.sid, r.step, val, r.ts])? == 1 {
                                            dirty.insert(r.sid);
                                        }
                                    }
                                    None => {
                                        upsert.execute(params![r.sid, r.step, val, r.ts])?;
                                        let f = fin(r.value);
                                        self.sums.insert(
                                            r.sid,
                                            Summary {
                                                exp_id: *exp_id,
                                                count: 1,
                                                first_step: r.step,
                                                last_step: r.step,
                                                min: if f { r.value } else { f64::NAN },
                                                max: if f { r.value } else { f64::NAN },
                                                last_value: r.value,
                                                last_ts: r.ts,
                                            },
                                        );
                                        self.exps.entry(*exp_id).or_default().metric_count += 1;
                                    }
                                }
                            }
                        }
                        Cmd::Delete { exp_ids, sids, .. } => {
                            let mut dp = tx.prepare_cached("DELETE FROM points WHERE series_id=?1")?;
                            let mut ds = tx.prepare_cached("DELETE FROM summaries WHERE series_id=?1")?;
                            for &sid in sids {
                                dp.execute([sid])?;
                                ds.execute([sid])?;
                                self.sums.remove(&sid);
                                touched.remove(&sid);
                                dirty.remove(&sid);
                                deleted_sids.push(sid);
                            }
                            let mut de = tx.prepare_cached("DELETE FROM summaries WHERE experiment_id=?1")?;
                            for &e in exp_ids {
                                de.execute([e])?;
                                self.exps.remove(&e);
                                touched_exps.remove(&e);
                                deleted_exps.push(e);
                            }
                        }
                        Cmd::Shutdown => {}
                    }
                }
            }
            for sid in dirty {
                recompute(&tx, sid, &mut self.sums)?;
            }
            {
                let mut put = tx.prepare_cached(SQL_SUMMARY_PUT)?;
                for sid in &touched {
                    if let Some(s) = self.sums.get(sid) {
                        put.execute(params![
                            sid,
                            s.exp_id,
                            s.count,
                            s.first_step,
                            s.last_step,
                            nan_none(s.min),
                            nan_none(s.max),
                            nan_none(s.last_value),
                            s.last_ts
                        ])?;
                        let e = self.exps.entry(s.exp_id).or_default();
                        e.last_step = Some(e.last_step.map_or(s.last_step, |l| l.max(s.last_step)));
                    }
                }
            }
            tx.commit()?;
            Ok(nrows)
        })();

        match res {
            Ok(nrows) => {
                {
                    let mut w = self.shared.summaries.write();
                    for sid in &touched {
                        if let Some(s) = self.sums.get(sid) {
                            w.insert(*sid, *s);
                        }
                    }
                    for sid in &deleted_sids {
                        w.remove(sid);
                    }
                }
                {
                    let mut w = self.shared.exps.write();
                    for e in &touched_exps {
                        if let Some(a) = self.exps.get(e) {
                            w.insert(*e, *a);
                        }
                    }
                    for e in &deleted_exps {
                        w.remove(e);
                    }
                }
                if !deleted_sids.is_empty() {
                    self.cache.remove(&deleted_sids);
                }
                for cmd in batch {
                    match cmd {
                        Cmd::Write { rows, ack, .. } => {
                            self.cache.apply(&rows);
                            let _ = ack.send(Ok(()));
                        }
                        Cmd::Delete { ack, .. } => {
                            let _ = ack.send(Ok(()));
                        }
                        Cmd::Shutdown => {}
                    }
                }
                tracing::trace!(rows = nrows, ms = t0.elapsed().as_secs_f64() * 1e3, "group commit");
            }
            Err(e) => {
                tracing::error!("group commit failed: {e}");
                if let Err(e2) = self.reload() {
                    tracing::error!("summary reload failed: {e2}");
                }
                let msg = e.to_string();
                for cmd in batch {
                    let ack: Option<Ack> = match cmd {
                        Cmd::Write { ack, .. } | Cmd::Delete { ack, .. } => Some(ack),
                        Cmd::Shutdown => None,
                    };
                    if let Some(a) = ack {
                        let _ = a.send(Err(msg.clone()));
                    }
                }
            }
        }
    }
}

/// Full recomputation of a series summary (only after an existing value changed).
fn recompute(tx: &Transaction, sid: i64, sums: &mut FastMap<i64, Summary>) -> rusqlite::Result<()> {
    let agg = tx
        .prepare_cached(
            "SELECT count(*), min(step), max(step),
                    min(CASE WHEN value > -9e999 AND value < 9e999 THEN value END),
                    max(CASE WHEN value > -9e999 AND value < 9e999 THEN value END)
             FROM points WHERE series_id=?1",
        )?
        .query_row([sid], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<f64>>(3)?,
                r.get::<_, Option<f64>>(4)?,
            ))
        })?;
    let last = tx
        .prepare_cached("SELECT value, ts FROM points WHERE series_id=?1 ORDER BY step DESC LIMIT 1")?
        .query_row([sid], |r| Ok((r.get::<_, Option<f64>>(0)?, r.get::<_, f64>(1)?)))
        .optional()?;
    if let (Some(s), Some(first), Some(lastp), Some((lv, lts))) = (sums.get_mut(&sid), agg.1, agg.2, last) {
        s.count = agg.0;
        s.first_step = first;
        s.last_step = lastp;
        s.min = agg.3.unwrap_or(f64::NAN);
        s.max = agg.4.unwrap_or(f64::NAN);
        s.last_value = lv.unwrap_or(f64::NAN);
        s.last_ts = lts;
    }
    Ok(())
}
