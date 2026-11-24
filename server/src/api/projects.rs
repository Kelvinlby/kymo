//! Projects and experiments (read: session or token; write: full session).

use super::{
    JsonBody, PROJECT_COLS, ProjectRow, experiment_project, f64_json, parse_json_text, project_from_row,
    project_json, readable_project, writable_project,
};
use crate::AppState;
use crate::auth::{FullSession, ReadAuth};
use crate::error::{ApiError, ApiResult};
use crate::store::ExpAgg;
use crate::util::{natural_cmp, now_ms, rfc3339, valid_experiment_name, valid_project_name, valid_status};
use axum::Json;
use axum::extract::{Path, State};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

type S = State<Arc<AppState>>;

/// `(experiment id, series ids)` for the experiment ids returned by `sql` (one i64 param).
pub fn series_of(c: &Connection, sql: &str, param: i64) -> ApiResult<Vec<(i64, Vec<i64>)>> {
    let exps: Vec<i64> = c.prepare(sql)?.query_map([param], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut out = Vec::with_capacity(exps.len());
    let mut st = c.prepare_cached("SELECT id FROM series WHERE experiment_id=?1")?;
    for e in exps {
        let sids: Vec<i64> = st.query_map([e], |r| r.get(0))?.collect::<Result<_, _>>()?;
        out.push((e, sids));
    }
    Ok(out)
}

fn project_stats(c: &Connection, pid: i64) -> rusqlite::Result<(i64, Option<i64>)> {
    c.prepare_cached("SELECT count(*), max(updated_at) FROM experiments WHERE project_id=?1")?
        .query_row([pid], |r| Ok((r.get(0)?, r.get(1)?)))
}

pub async fn list(State(s): S, ReadAuth(p): ReadAuth) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(move |c| {
            let mut st = c.prepare_cached(&format!(
                "SELECT {PROJECT_COLS}, (SELECT count(*) FROM experiments e WHERE e.project_id=p.id),
                        (SELECT max(updated_at) FROM experiments e WHERE e.project_id=p.id)
                 FROM projects p JOIN users u ON u.id=p.owner_id
                 WHERE ?1 OR p.owner_id=?2 OR p.shared
                 ORDER BY p.created_at DESC, p.id DESC"
            ))?;
            let rows = st.query_map(params![p.user.is_admin, p.user.id], |r| {
                let pr = project_from_row(r)?;
                Ok(project_json(&pr, r.get(7)?, r.get(8)?))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(Value::Array(v)))
}

#[derive(Deserialize)]
pub struct CreateReq {
    name: String,
    description: Option<String>,
}

fn check_description(d: &str) -> ApiResult<()> {
    if d.len() > 4096 {
        return Err(ApiError::invalid("invalid_description", "description too long (max 4096 bytes)"));
    }
    Ok(())
}

pub async fn create(State(s): S, FullSession(p): FullSession, JsonBody(req): JsonBody<CreateReq>) -> ApiResult<Json<Value>> {
    if !valid_project_name(&req.name) {
        return Err(ApiError::invalid("invalid_name", "project name must match [A-Za-z0-9_.-]{1,64}"));
    }
    let desc = req.description.unwrap_or_default();
    check_description(&desc)?;
    let uid = p.user.id;
    let pr = s
        .db
        .call(move |c| {
            let n = c.execute(
                "INSERT INTO projects(owner_id, name, description, created_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(owner_id, name) DO NOTHING",
                params![uid, req.name, desc, now_ms()],
            )?;
            if n == 0 {
                return Err(ApiError::conflict("project_exists", "you already have a project with this name"));
            }
            super::load_project(c, c.last_insert_rowid())?.ok_or_else(|| ApiError::internal("project vanished"))
        })
        .await?;
    Ok(Json(project_json(&pr, 0, None)))
}

pub async fn get_one(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(move |c| {
            let pr = readable_project(c, &p, id)?;
            let (n, last) = project_stats(c, id)?;
            Ok(project_json(&pr, n, last))
        })
        .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct PatchReq {
    name: Option<String>,
    description: Option<String>,
    shared: Option<bool>,
}

pub async fn patch(
    State(s): S,
    FullSession(p): FullSession,
    Path(id): Path<i64>,
    JsonBody(req): JsonBody<PatchReq>,
) -> ApiResult<Json<Value>> {
    if let Some(n) = &req.name {
        if !valid_project_name(n) {
            return Err(ApiError::invalid("invalid_name", "project name must match [A-Za-z0-9_.-]{1,64}"));
        }
    }
    if let Some(d) = &req.description {
        check_description(d)?;
    }
    let renamed = req.name.is_some();
    let v = s
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let pr: ProjectRow = writable_project(&tx, &p, id)?;
            if let Some(n) = &req.name {
                if *n != pr.name {
                    let taken: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM projects WHERE owner_id=?1 AND name=?2)",
                        params![pr.owner_id, n],
                        |r| r.get(0),
                    )?;
                    if taken {
                        return Err(ApiError::conflict("project_exists", "a project with this name already exists"));
                    }
                    tx.execute("UPDATE projects SET name=?1 WHERE id=?2", params![n, id])?;
                }
            }
            if let Some(d) = &req.description {
                tx.execute("UPDATE projects SET description=?1 WHERE id=?2", params![d, id])?;
            }
            if let Some(sh) = req.shared {
                tx.execute("UPDATE projects SET shared=?1 WHERE id=?2", params![sh, id])?;
            }
            let pr = super::load_project(&tx, id)?.ok_or_else(|| ApiError::not_found("project"))?;
            let (n, last) = project_stats(&tx, id)?;
            tx.commit()?;
            Ok(project_json(&pr, n, last))
        })
        .await?;
    if renamed {
        s.invalidate_names();
    }
    Ok(Json(v))
}

pub async fn delete(State(s): S, FullSession(p): FullSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let series = s
        .db
        .call(move |c| {
            writable_project(c, &p, id)?;
            let series = series_of(c, "SELECT id FROM experiments WHERE project_id=?1", id)?;
            c.execute("DELETE FROM projects WHERE id=?1", [id])?;
            Ok(series)
        })
        .await?;
    s.invalidate_names();
    s.store.delete_experiments(series).await?;
    Ok(Json(json!({"ok": true})))
}

const EXP_COLS: &str = "id, project_id, name, status, config, tags, notes, host, created_at, updated_at";

fn exp_json(r: &rusqlite::Row, agg: impl Fn(i64) -> ExpAgg) -> rusqlite::Result<Value> {
    let id: i64 = r.get(0)?;
    let a = agg(id);
    Ok(json!({
        "id": id,
        "project_id": r.get::<_, i64>(1)?,
        "name": r.get::<_, String>(2)?,
        "status": r.get::<_, String>(3)?,
        "config": parse_json_text(&r.get::<_, String>(4)?, json!({})),
        "tags": parse_json_text(&r.get::<_, String>(5)?, json!([])),
        "notes": r.get::<_, String>(6)?,
        "host": r.get::<_, Option<String>>(7)?,
        "created_at": rfc3339(r.get(8)?),
        "updated_at": rfc3339(r.get(9)?),
        "metric_count": a.metric_count,
        "last_step": a.last_step,
    }))
}

pub async fn experiments(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let st = s.clone();
    let v = s
        .db
        .call(move |c| {
            readable_project(c, &p, id)?;
            let mut q = c.prepare_cached(&format!(
                "SELECT {EXP_COLS} FROM experiments WHERE project_id=?1 ORDER BY created_at DESC, id DESC"
            ))?;
            let rows = q.query_map([id], |r| exp_json(r, |e| st.store.exp_agg(e)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(Value::Array(v)))
}

pub async fn metric_keys(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let mut keys = s
        .db
        .call(move |c| {
            readable_project(c, &p, id)?;
            let mut q = c.prepare_cached(
                "SELECT DISTINCT s.key FROM series s JOIN experiments e ON e.id=s.experiment_id WHERE e.project_id=?1",
            )?;
            let rows = q.query_map([id], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    keys.sort_by(|a, b| natural_cmp(a, b));
    Ok(Json(json!(keys)))
}

pub async fn experiment_get(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let st = s.clone();
    let v = s
        .db
        .call(move |c| {
            let pr = experiment_project(c, &p, id, false)?;
            let mut v = c
                .prepare_cached(&format!("SELECT {EXP_COLS} FROM experiments WHERE id=?1"))?
                .query_row([id], |r| exp_json(r, |e| st.store.exp_agg(e)))
                .optional()?
                .ok_or_else(|| ApiError::not_found("experiment"))?;
            v["project"] = json!({"id": pr.id, "name": pr.name, "owner": {"id": pr.owner_id, "username": pr.owner_username}});
            v["can_edit"] = json!(super::can_write(&p, &pr));
            Ok(v)
        })
        .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct ExpPatch {
    name: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    status: Option<String>,
}

pub async fn experiment_patch(
    State(s): S,
    FullSession(p): FullSession,
    Path(id): Path<i64>,
    JsonBody(req): JsonBody<ExpPatch>,
) -> ApiResult<Json<Value>> {
    if let Some(n) = &req.name {
        if !valid_experiment_name(n) {
            return Err(ApiError::invalid("invalid_name", "experiment name must be 1-128 printable characters"));
        }
    }
    if let Some(t) = &req.tags {
        if t.len() > 64 || t.iter().any(|x| x.is_empty() || x.chars().count() > 64 || x.chars().any(|c| c.is_control())) {
            return Err(ApiError::invalid("invalid_tags", "at most 64 tags of 1-64 printable characters"));
        }
    }
    if let Some(n) = &req.notes {
        if n.len() > 65536 {
            return Err(ApiError::invalid("invalid_notes", "notes too long (max 64 KiB)"));
        }
    }
    if let Some(st) = &req.status {
        if !valid_status(st) {
            return Err(ApiError::invalid("invalid_status", "status must be running|finished|failed|crashed"));
        }
    }
    let renamed = req.name.is_some();
    let st = s.clone();
    let v = s
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let pr = experiment_project(&tx, &p, id, true)?;
            if let Some(n) = &req.name {
                let taken: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM experiments WHERE project_id=?1 AND name=?2 AND id<>?3)",
                    params![pr.id, n, id],
                    |r| r.get(0),
                )?;
                if taken {
                    return Err(ApiError::conflict("experiment_exists", "an experiment with this name already exists"));
                }
                tx.execute("UPDATE experiments SET name=?1 WHERE id=?2", params![n, id])?;
            }
            if let Some(t) = &req.tags {
                tx.execute("UPDATE experiments SET tags=?1 WHERE id=?2", params![json!(t).to_string(), id])?;
            }
            if let Some(n) = &req.notes {
                tx.execute("UPDATE experiments SET notes=?1 WHERE id=?2", params![n, id])?;
            }
            if let Some(stt) = &req.status {
                tx.execute("UPDATE experiments SET status=?1 WHERE id=?2", params![stt, id])?;
            }
            let mut v = tx
                .prepare_cached(&format!("SELECT {EXP_COLS} FROM experiments WHERE id=?1"))?
                .query_row([id], |r| exp_json(r, |e| st.store.exp_agg(e)))?;
            tx.commit()?;
            v["project"] = json!({"id": pr.id, "name": pr.name});
            Ok(v)
        })
        .await?;
    if renamed {
        s.invalidate_names();
    }
    Ok(Json(v))
}

pub async fn experiment_delete(State(s): S, FullSession(p): FullSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let series = s
        .db
        .call(move |c| {
            experiment_project(c, &p, id, true)?;
            let series = series_of(c, "SELECT ?1", id)?;
            c.execute("DELETE FROM experiments WHERE id=?1", [id])?;
            Ok(series)
        })
        .await?;
    s.invalidate_names();
    s.store.delete_experiments(series).await?;
    Ok(Json(json!({"ok": true})))
}

pub async fn experiment_metrics(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let mut series = s
        .db
        .call(move |c| {
            experiment_project(c, &p, id, false)?;
            let mut q = c.prepare_cached("SELECT id, key FROM series WHERE experiment_id=?1")?;
            let rows = q.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    series.sort_by(|a, b| natural_cmp(&a.1, &b.1));
    let out: Vec<Value> = series
        .into_iter()
        .filter_map(|(sid, key)| {
            let sm = s.store.summary(id, sid)?;
            Some(json!({
                "key": key, "count": sm.count, "first_step": sm.first_step, "last_step": sm.last_step,
                "min": f64_json(sm.min), "max": f64_json(sm.max), "last_value": f64_json(sm.last_value),
                "last_ts": sm.last_ts,
            }))
        })
        .collect();
    Ok(Json(Value::Array(out)))
}
