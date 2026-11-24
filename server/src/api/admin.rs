//! /api/v1/admin/* — users, invites, site policy (admin full session only).

use super::{JsonBody, OptJsonBody};
use super::projects::series_of;
use crate::AppState;
use crate::auth::Admin;
use crate::error::{ApiError, ApiResult};
use crate::util::{now_ms, opt_rfc3339, random_b62, rfc3339, sha256, valid_username};
use axum::Json;
use axum::extract::{Path, State};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;

type S = State<Arc<AppState>>;

pub async fn users_list(State(s): S, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, username, display_name, is_admin, disabled, created_at, last_login_at,
                        (SELECT count(*) FROM passkeys p WHERE p.user_id=users.id)
                 FROM users ORDER BY id",
            )?;
            let rows = st.query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "username": r.get::<_, String>(1)?,
                    "display_name": r.get::<_, String>(2)?, "is_admin": r.get::<_, bool>(3)?,
                    "disabled": r.get::<_, bool>(4)?, "created_at": rfc3339(r.get(5)?),
                    "last_login_at": opt_rfc3339(r.get(6)?), "passkey_count": r.get::<_, i64>(7)?,
                }))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(Value::Array(v)))
}

#[derive(Deserialize)]
pub struct UserPatch {
    disabled: Option<bool>,
    reset_passkeys: Option<bool>,
    display_name: Option<String>,
}

pub async fn user_patch(
    State(s): S,
    Admin(a): Admin,
    Path(id): Path<i64>,
    JsonBody(req): JsonBody<UserPatch>,
) -> ApiResult<Json<Value>> {
    if id == a.user.id && req.disabled == Some(true) {
        return Err(ApiError::conflict("cannot_disable_self", "you cannot disable your own account"));
    }
    if let Some(d) = &req.display_name {
        if d.trim().is_empty() || d.chars().count() > 64 || d.chars().any(|c| c.is_control()) {
            return Err(ApiError::invalid("invalid_display_name", "display name must be 1-64 printable characters"));
        }
    }
    s.db
        .call(move |c| {
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id=?1)", [id], |r| r.get(0))?;
            if !exists {
                return Err(ApiError::not_found("user"));
            }
            if let Some(d) = &req.display_name {
                tx.execute("UPDATE users SET display_name=?1 WHERE id=?2", params![d.trim(), id])?;
            }
            if let Some(dis) = req.disabled {
                tx.execute("UPDATE users SET disabled=?1 WHERE id=?2", params![dis, id])?;
                if dis {
                    tx.execute("DELETE FROM sessions WHERE user_id=?1", [id])?;
                }
            }
            if req.reset_passkeys == Some(true) {
                tx.execute("DELETE FROM passkeys WHERE user_id=?1", [id])?;
                tx.execute("DELETE FROM sessions WHERE user_id=?1", [id])?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    s.auth.drop_user_creds(id);
    Ok(Json(json!({"ok": true})))
}

pub async fn user_delete(State(s): S, Admin(a): Admin, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    if id == a.user.id {
        return Err(ApiError::conflict("cannot_delete_self", "you cannot delete your own account"));
    }
    let series = s
        .db
        .call(move |c| {
            let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id=?1)", [id], |r| r.get(0))?;
            if !exists {
                return Err(ApiError::not_found("user"));
            }
            series_of(
                c,
                "SELECT e.id FROM experiments e JOIN projects p ON p.id=e.project_id WHERE p.owner_id=?1",
                id,
            )
        })
        .await?;
    s.store.delete_experiments(series).await?;
    s.db.call(move |c| Ok(c.execute("DELETE FROM users WHERE id=?1", [id])?)).await?;
    s.auth.drop_user_creds(id);
    s.invalidate_names();
    Ok(Json(json!({"ok": true})))
}

pub async fn user_reset_password(State(s): S, Admin(_): Admin, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let tok = random_b62(40);
    let h = sha256(tok.as_bytes());
    let now = now_ms();
    let exp = now + 24 * 3600 * 1000;
    s.db
        .call(move |c| {
            let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id=?1)", [id], |r| r.get(0))?;
            if !exists {
                return Err(ApiError::not_found("user"));
            }
            c.execute(
                "INSERT INTO password_resets(token_hash, user_id, created_at, expires_at) VALUES(?1,?2,?3,?4)",
                params![&h[..], id, now, exp],
            )?;
            Ok(())
        })
        .await?;
    let url = format!("{}/signup?reset={tok}", s.cfg.canonical_origin());
    Ok(Json(json!({"url": url, "token": tok, "expires_at": rfc3339(exp)})))
}

#[derive(Deserialize)]
pub struct InviteReq {
    username: Option<String>,
    expires_hours: Option<f64>,
}

pub async fn invite_create(State(s): S, Admin(a): Admin, OptJsonBody(body): OptJsonBody<InviteReq>) -> ApiResult<Json<Value>> {
    let req = body.unwrap_or(InviteReq { username: None, expires_hours: None });
    let username = req.username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    if let Some(u) = &username {
        if !valid_username(u) {
            return Err(ApiError::invalid("invalid_username", "username must match [a-z0-9_.-]{2,32}"));
        }
    }
    let hours = req.expires_hours.unwrap_or(72.0);
    if !(hours > 0.0 && hours <= 24.0 * 365.0) {
        return Err(ApiError::invalid("invalid_expiry", "expires_hours must be in (0, 8760]"));
    }
    let tok = random_b62(32);
    let h = sha256(tok.as_bytes());
    let now = now_ms();
    let exp = now + (hours * 3600.0 * 1000.0) as i64;
    let uid = a.user.id;
    let u2 = username.clone();
    let id = s
        .db
        .call(move |c| {
            if let Some(u) = &u2 {
                let taken: bool =
                    c.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE username=?1)", [u], |r| r.get(0))?;
                if taken {
                    return Err(ApiError::conflict("username_taken", "username is already taken"));
                }
            }
            c.execute(
                "INSERT INTO invites(token_hash, username, created_by, created_at, expires_at) VALUES(?1,?2,?3,?4,?5)",
                params![&h[..], u2, uid, now, exp],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    let url = format!("{}/signup?invite={tok}", s.cfg.canonical_origin());
    Ok(Json(json!({"id": id, "token": tok, "url": url, "username": username, "expires_at": rfc3339(exp)})))
}

pub async fn invites_list(State(s): S, Admin(_): Admin) -> ApiResult<Json<Value>> {
    let v = s
        .db
        .call(|c| {
            let mut st = c.prepare_cached(
                "SELECT id, username, expires_at, used_at, created_at FROM invites ORDER BY id DESC",
            )?;
            let rows = st.query_map([], |r| {
                Ok(json!({"id": r.get::<_, i64>(0)?, "username": r.get::<_, Option<String>>(1)?,
                    "expires_at": rfc3339(r.get(2)?), "used_at": opt_rfc3339(r.get(3)?),
                    "created_at": rfc3339(r.get(4)?)}))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(Value::Array(v)))
}

pub async fn invite_delete(State(s): S, Admin(_): Admin, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let n = s.db.call(move |c| Ok(c.execute("DELETE FROM invites WHERE id=?1", [id])?)).await?;
    if n == 0 {
        return Err(ApiError::not_found("invite"));
    }
    Ok(Json(json!({"ok": true})))
}

pub async fn settings_get(State(s): S, Admin(_): Admin) -> Json<Value> {
    Json(json!({"passkey_required_for_all": s.auth.policy()}))
}

#[derive(Deserialize)]
pub struct SettingsReq {
    passkey_required_for_all: bool,
}

pub async fn settings_put(State(s): S, Admin(_): Admin, JsonBody(req): JsonBody<SettingsReq>) -> ApiResult<Json<Value>> {
    let v = req.passkey_required_for_all;
    s.db
        .call(move |c| {
            c.execute(
                "INSERT INTO settings(key, value) VALUES('passkey_required_for_all', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [if v { "true" } else { "false" }],
            )?;
            Ok(())
        })
        .await?;
    s.auth.policy_all.store(v, Ordering::Relaxed);
    Ok(Json(json!({"passkey_required_for_all": v})))
}

