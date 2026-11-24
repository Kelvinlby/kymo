//! Projects and experiments (read: session or token; write: full session).

use super::{
    JsonBody, Role, experiment_project, f64_json, managed_project, parse_json_text, project_from_row, project_json,
    project_select, readable_project, role_of,
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


pub async fn list(State(s): S, ReadAuth(p): ReadAuth) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(move |c| {
            let mut st = c.prepare_cached(&format!(
                "{} WHERE :admin OR p.owner_id=:uid OR p.everyone IS NOT NULL
                    OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=:uid)
                 ORDER BY p.created_at DESC, p.id DESC",
                project_select()
            ))?;
            let rows = st.query_map(rusqlite::named_params! {":admin": p.user.is_admin, ":uid": p.user.id}, |r| {
                project_from_row(r)
            })?;
            let mut out = Vec::new();
            for pr in rows {
                let pr = pr?;
                if let Some(role) = role_of(&p, &pr) {
                    out.push(project_json(&pr, role));
                }
            }
            Ok(out)
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
            super::load_project(c, c.last_insert_rowid(), uid)?.ok_or_else(|| ApiError::internal("project vanished"))
        })
        .await?;
    Ok(Json(project_json(&pr, Role::Owner)))
}

pub async fn get_one(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(move |c| {
            let (pr, role) = readable_project(c, &p, id)?;
            Ok(project_json(&pr, role))
        })
        .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct PatchReq {
    name: Option<String>,
    description: Option<String>,
    /// Deprecated: `true` = everyone viewer (if no everyone role yet), `false` = no everyone role.
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
    let renamed = req.name.is_some() || req.shared.is_some();
    let v = s
        .db
        .call(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let (pr, _) = managed_project(&tx, &p, id)?;
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
                if sh {
                    tx.execute("UPDATE projects SET everyone='viewer' WHERE id=?1 AND everyone IS NULL", [id])?;
                } else {
                    tx.execute("UPDATE projects SET everyone=NULL WHERE id=?1", [id])?;
                }
            }
            let pr = super::load_project(&tx, id, p.user.id)?.ok_or_else(|| ApiError::not_found("project"))?;
            let role = role_of(&p, &pr).unwrap_or(Role::Viewer);
            tx.commit()?;
            Ok(project_json(&pr, role))
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
            managed_project(c, &p, id)?;
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
            let (pr, role) = experiment_project(c, &p, id, false)?;
            let mut v = c
                .prepare_cached(&format!("SELECT {EXP_COLS} FROM experiments WHERE id=?1"))?
                .query_row([id], |r| exp_json(r, |e| st.store.exp_agg(e)))
                .optional()?
                .ok_or_else(|| ApiError::not_found("experiment"))?;
            v["project"] = json!({"id": pr.id, "name": pr.name, "owner": {"id": pr.owner_id, "username": pr.owner_username}});
            v["can_edit"] = json!(role.can_edit());
            v["role"] = json!(role.as_str());
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
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let (pr, _) = experiment_project(&tx, &p, id, true)?;
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

// ---- sharing / user directory -----------------------------------------------------------

/// `GET /users` — active users for the share picker (full session; not API tokens).
pub async fn users_directory(State(s): S, FullSession(_): FullSession) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(|c| {
            let mut q = c.prepare_cached("SELECT id, username, display_name FROM users WHERE disabled=0 ORDER BY username")?;
            let rows = q.query_map([], |r| {
                Ok(json!({"id": r.get::<_, i64>(0)?, "username": r.get::<_, String>(1)?,
                    "display_name": r.get::<_, String>(2)?}))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(Value::Array(v)))
}

fn sharing_json(c: &Connection, pid: i64, everyone: Option<String>) -> ApiResult<Value> {
    let mut q = c.prepare_cached(
        "SELECT u.id, u.username, u.display_name, m.role FROM project_members m JOIN users u ON u.id=m.user_id
         WHERE m.project_id=?1 ORDER BY u.username",
    )?;
    let rows = q.query_map([pid], |r| {
        Ok(json!({"user": {"id": r.get::<_, i64>(0)?, "username": r.get::<_, String>(1)?,
            "display_name": r.get::<_, String>(2)?}, "role": r.get::<_, String>(3)?}))
    })?;
    let members = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"everyone": everyone, "members": members}))
}

/// `GET /projects/{id}/sharing` — anyone who can read the project.
pub async fn sharing_get(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(move |c| {
            let (pr, _) = readable_project(c, &p, id)?;
            sharing_json(c, id, pr.everyone)
        })
        .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct MemberReq {
    user_id: i64,
    role: String,
}

#[derive(Deserialize)]
pub struct SharingReq {
    #[serde(default)]
    everyone: Option<String>,
    #[serde(default)]
    members: Vec<MemberReq>,
}

/// `PUT /projects/{id}/sharing` — replaces the whole sharing state (owner/admin only).
pub async fn sharing_put(
    State(s): S,
    FullSession(p): FullSession,
    Path(id): Path<i64>,
    JsonBody(req): JsonBody<SharingReq>,
) -> ApiResult<Json<Value>> {
    if let Some(e) = &req.everyone {
        if Role::parse_share(e).is_none() {
            return Err(ApiError::invalid("invalid_role", "everyone must be null, \"viewer\" or \"editor\""));
        }
    }
    if req.members.len() > 10_000 {
        return Err(ApiError::invalid("too_many_members", "at most 10000 members"));
    }
    let mut seen = std::collections::HashSet::new();
    for m in &req.members {
        if Role::parse_share(&m.role).is_none() {
            return Err(ApiError::invalid("invalid_role", "member role must be \"viewer\" or \"editor\""));
        }
        if !seen.insert(m.user_id) {
            return Err(ApiError::invalid("duplicate_member", format!("user {} listed twice", m.user_id)));
        }
    }
    let v = s
        .db
        .call(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let (pr, _) = managed_project(&tx, &p, id)?;
            for m in &req.members {
                if m.user_id == pr.owner_id {
                    return Err(ApiError::invalid("owner_not_member", "the owner can't be a member of their own project"));
                }
                let ok: bool =
                    tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id=?1)", [m.user_id], |r| r.get(0))?;
                if !ok {
                    return Err(ApiError::invalid("unknown_user", format!("no user with id {}", m.user_id)));
                }
            }
            tx.execute("UPDATE projects SET everyone=?1 WHERE id=?2", params![req.everyone, id])?;
            tx.execute("DELETE FROM project_members WHERE project_id=?1", [id])?;
            {
                let mut ins = tx.prepare_cached("INSERT INTO project_members(project_id, user_id, role) VALUES(?1,?2,?3)")?;
                for m in &req.members {
                    ins.execute(params![id, m.user_id, m.role])?;
                }
            }
            let v = sharing_json(&tx, id, req.everyone.clone())?;
            tx.commit()?;
            Ok(v)
        })
        .await?;
    // Ingest name→experiment resolutions embed permission decisions: drop them.
    s.invalidate_names();
    Ok(Json(v))
}
