//! POST /api/v1/ingest — the hot path.

use crate::auth::{Principal, ReadAuth};
use crate::error::{ApiError, ApiResult};
use crate::ingest::{ParseError, parse};
use crate::store::{Row, prepare_rows};
use crate::util::{now_ms, valid_experiment_name, valid_project_name, valid_status};
use crate::{AppState, MAX_INGEST_BODY, MAX_INGEST_VALUES};
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::io::Read;
use std::sync::Arc;

fn decode_body(headers: &HeaderMap, body: Bytes) -> ApiResult<Bytes> {
    let enc = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let limit = MAX_INGEST_BODY as u64 + 1;
    let mut out = Vec::new();
    let res = match enc.as_str() {
        "" | "identity" => return Ok(body),
        "gzip" | "x-gzip" => flate2::read::MultiGzDecoder::new(&body[..]).take(limit).read_to_end(&mut out),
        "zstd" => match zstd::stream::read::Decoder::new(&body[..]) {
            Ok(d) => d.take(limit).read_to_end(&mut out),
            Err(e) => Err(e),
        },
        "deflate" => flate2::read::ZlibDecoder::new(&body[..]).take(limit).read_to_end(&mut out),
        other => {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_encoding",
                format!("unsupported Content-Encoding '{other}'"),
            ));
        }
    };
    if let Err(e) = res {
        return Err(ApiError::invalid("bad_encoding", format!("could not decompress body: {e}")));
    }
    if out.len() > MAX_INGEST_BODY {
        return Err(ApiError::too_large("decompressed body exceeds 64 MiB"));
    }
    Ok(Bytes::from(out))
}

struct Prepared {
    exp_id: i64,
    rows: Vec<Row>,
    accepted: usize,
    dropped: usize,
    dropped_keys: Vec<String>,
    /// Per-point explicit steps when the server must assign some (`rows[i].step` = point index).
    auto: Option<Vec<Option<i64>>>,
    max_step: Option<i64>,
}

/// CPU part of ingest (decode, parse, resolve ids, build rows). Runs on the blocking pool.
fn prepare(s: &AppState, principal: &Principal, headers: &HeaderMap, body: Bytes) -> ApiResult<Prepared> {
    let user_id = principal.user.id;
    let body = decode_body(headers, body)?;
    let mut p = match parse(&body, MAX_INGEST_VALUES) {
        Ok(p) => p,
        Err(ParseError::TooMany) => {
            return Err(ApiError::too_large(format!("more than {MAX_INGEST_VALUES} values in one request")));
        }
        Err(ParseError::Malformed(m)) => return Err(ApiError::invalid("malformed", format!("invalid ingest body: {m}"))),
    };
    let project = p.project.as_deref().ok_or_else(|| ApiError::invalid("malformed", "missing 'project'"))?;
    let experiment = p.experiment.as_deref().ok_or_else(|| ApiError::invalid("malformed", "missing 'experiment'"))?;
    // "owner/name" addresses another user's project (requires the editor role there).
    let (foreign_owner, pname) = match project.split_once('/') {
        Some((o, n)) if o != principal.user.username => (Some(o), n),
        Some((_, n)) => (None, n),
        None => (None, project),
    };
    if !valid_project_name(pname) || foreign_owner.is_some_and(|o| !crate::util::valid_username(o)) {
        return Err(ApiError::invalid(
            "invalid_name",
            "project must be 'name' or 'owner/name' with name matching [A-Za-z0-9_.-]{1,64}",
        ));
    }
    if !valid_experiment_name(experiment) {
        return Err(ApiError::invalid("invalid_name", "experiment name must be 1-128 printable characters"));
    }
    if let Some(st) = &p.status {
        if !valid_status(st) {
            return Err(ApiError::invalid("invalid_status", "status must be running|finished|failed|crashed"));
        }
    }
    if p.host.as_ref().is_some_and(|h| h.len() > 256) {
        return Err(ApiError::invalid("invalid_host", "host too long"));
    }

    // Resolve (and auto-create) project + experiment in the caller's namespace.
    let ckey = format!("{user_id}\0{project}\0{experiment}");
    let now = now_ms();
    let has_meta = p.config.is_some() || p.status.is_some() || p.host.is_some();
    let cached = s.exp_cache.get(&ckey).map(|v| *v);
    let touch_due = cached.is_none_or(|id| s.exp_touch.get(&id).is_none_or(|t| now - *t >= 1000));
    let exp_id = if cached.is_some() && !has_meta && !touch_due {
        cached.unwrap()
    } else {
        let id = s.db.with(|c| {
            let tx = c.transaction()?;
            let id = match cached {
                Some(id) => id,
                None => {
                    let pid: i64 = match foreign_owner {
                        Some(owner) => {
                            let pid: Option<i64> = tx
                                .query_row(
                                    "SELECT p.id FROM projects p JOIN users u ON u.id=p.owner_id
                                     WHERE u.username=?1 AND p.name=?2",
                                    params![owner, pname],
                                    |r| r.get(0),
                                )
                                .optional()?;
                            let role = match pid {
                                Some(pid) => super::load_project_acl(&tx, pid, user_id)?
                                    .and_then(|pr| super::role_of(principal, &pr)),
                                None => None,
                            };
                            match (pid, role) {
                                (Some(pid), Some(r)) if r.can_edit() => pid,
                                _ => {
                                    return Err(ApiError::new(
                                        StatusCode::FORBIDDEN,
                                        "project_forbidden",
                                        format!("you need the editor role on project '{owner}/{pname}' (or it does not exist)"),
                                    ));
                                }
                            }
                        }
                        None => {
                            tx.execute(
                                "INSERT INTO projects(owner_id, name, created_at) VALUES(?1,?2,?3)
                                 ON CONFLICT(owner_id, name) DO NOTHING",
                                params![user_id, pname, now],
                            )?;
                            tx.query_row(
                                "SELECT id FROM projects WHERE owner_id=?1 AND name=?2",
                                params![user_id, pname],
                                |r| r.get(0),
                            )?
                        }
                    };
                    tx.execute(
                        "INSERT INTO experiments(project_id, name, created_at, updated_at) VALUES(?1,?2,?3,?3)
                         ON CONFLICT(project_id, name) DO NOTHING",
                        params![pid, experiment, now],
                    )?;
                    tx.query_row(
                        "SELECT id FROM experiments WHERE project_id=?1 AND name=?2",
                        params![pid, experiment],
                        |r| r.get(0),
                    )?
                }
            };
            if let Some(cfg) = &p.config {
                let cur: Option<String> =
                    tx.query_row("SELECT config FROM experiments WHERE id=?1", [id], |r| r.get(0)).optional()?;
                let mut obj = cur
                    .and_then(|c| serde_json::from_str::<serde_json::Map<String, Value>>(&c).ok())
                    .unwrap_or_default();
                for (k, v) in cfg {
                    obj.insert(k.clone(), v.clone());
                }
                let txt = Value::Object(obj).to_string();
                if txt.len() > 1 << 20 {
                    return Err(ApiError::too_large("experiment config exceeds 1 MiB"));
                }
                tx.execute("UPDATE experiments SET config=?1 WHERE id=?2", params![txt, id])?;
            }
            if let Some(st) = &p.status {
                tx.execute("UPDATE experiments SET status=?1 WHERE id=?2", params![st.as_ref(), id])?;
            }
            if let Some(h) = &p.host {
                tx.execute("UPDATE experiments SET host=?1 WHERE id=?2", params![h.as_ref(), id])?;
            }
            tx.execute("UPDATE experiments SET updated_at=?1 WHERE id=?2", params![now, id])?;
            tx.commit()?;
            Ok(id)
        })?;
        s.exp_cache.insert(ckey, id);
        s.exp_touch.insert(id, now);
        id
    };

    // Intern series ids: one read lock for the whole request, create the missing ones.
    let keys = s.store.exp_keys(exp_id)?;
    let auto = p.auto_steps;
    // With server-assigned steps, rows carry the point index until the shard writer assigns steps.
    let row_of = |v: &crate::ingest::PVal, sid: i64| Row {
        sid,
        step: if auto { v.point as i64 } else { v.step },
        value: v.value,
        ts: v.ts,
    };
    let mut rows = Vec::with_capacity(p.values.len());
    let mut missing: Vec<&str> = Vec::new();
    {
        let m = keys.map.read();
        let mut last: (&str, i64) = ("\u{0}\u{0}", 0);
        for v in &p.values {
            let k: &str = &v.key;
            let sid = if k == last.0 {
                last.1
            } else if let Some(&sid) = m.get(k) {
                last = (k, sid);
                sid
            } else {
                missing.push(k);
                continue;
            };
            rows.push(row_of(v, sid));
        }
    }
    if !missing.is_empty() {
        missing.sort_unstable();
        missing.dedup();
        if missing.len() > 100_000 {
            return Err(ApiError::invalid("too_many_keys", "too many distinct metric keys in one request"));
        }
        s.store.create_series(exp_id, &missing)?;
        let m = keys.map.read();
        // Second pass only over values whose key was missing (keeps arrival order per key).
        rows.clear();
        for v in &p.values {
            if let Some(&sid) = m.get(&*v.key) {
                rows.push(row_of(v, sid));
            }
        }
    }
    let accepted = rows.len();
    let dropped = p.dropped + (p.values.len() - accepted);
    let (auto, max_step) = if auto {
        (Some(std::mem::take(&mut p.point_steps)), None)
    } else {
        prepare_rows(&mut rows);
        (None, rows.iter().map(|r| r.step).max())
    };
    Ok(Prepared { exp_id, rows, accepted, dropped, dropped_keys: std::mem::take(&mut p.dropped_keys), auto, max_step })
}

pub async fn ingest(
    State(s): State<Arc<AppState>>,
    ReadAuth(p): ReadAuth,
    headers: HeaderMap,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> ApiResult<Json<Value>> {
    let body = body.map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::too_large("request body exceeds 64 MiB")
        } else {
            ApiError::bad_request(e.body_text())
        }
    })?;
    let s2 = s.clone();
    let prep = tokio::task::spawn_blocking(move || prepare(&s2, &p, &headers, body)).await??;
    if !prep.rows.is_empty() {
        s.store.write(prep.exp_id, prep.rows, prep.auto, prep.max_step).await?;
    }
    Ok(Json(json!({"ok": true, "experiment_id": prep.exp_id, "accepted": prep.accepted, "dropped": prep.dropped,
        "dropped_keys": prep.dropped_keys})))
}
