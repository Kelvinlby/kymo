//! /api/v1/tokens — API token management (full cookie session only).

use super::JsonBody;
use crate::AppState;
use crate::auth::FullSession;
use crate::error::{ApiError, ApiResult};
use crate::util::{now_ms, opt_rfc3339, random_b62, rfc3339, sha256};
use axum::Json;
use axum::extract::{Path, State};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

type S = State<Arc<AppState>>;

#[derive(Deserialize)]
pub struct CreateReq {
    name: String,
}

pub async fn create(State(s): S, FullSession(p): FullSession, JsonBody(req): JsonBody<CreateReq>) -> ApiResult<Json<Value>> {
    let name = req.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(|c| c.is_control()) {
        return Err(ApiError::invalid("invalid_name", "token name must be 1-64 printable characters"));
    }
    let token = format!("kymo_{}", random_b62(40));
    let h = sha256(token.as_bytes());
    let prefix = token[..9].to_string();
    let uid = p.user.id;
    let now = now_ms();
    let n2 = name.clone();
    let id = s
        .db
        .call(move |c| {
            let n: i64 = c.query_row("SELECT count(*) FROM api_tokens WHERE user_id=?1", [uid], |r| r.get(0))?;
            if n >= 100 {
                return Err(ApiError::conflict("too_many_tokens", "token limit (100) reached"));
            }
            c.execute(
                "INSERT INTO api_tokens(user_id, name, token_hash, prefix, created_at) VALUES(?1,?2,?3,?4,?5)",
                params![uid, n2, &h[..], prefix, now],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    Ok(Json(json!({"id": id, "name": name, "token": token, "created_at": rfc3339(now), "disabled": false})))
}

#[derive(Deserialize)]
pub struct PatchReq {
    disabled: Option<bool>,
}

/// `PATCH /tokens/{id} {"disabled": bool}` — switch a token off (it then gets `401 token_disabled`) or back on.
pub async fn patch(
    State(s): S,
    FullSession(p): FullSession,
    Path(id): Path<i64>,
    JsonBody(req): JsonBody<PatchReq>,
) -> ApiResult<Json<Value>> {
    let uid = p.user.id;
    let (hash, v) = s
        .db
        .call(move |c| {
            if let Some(d) = req.disabled {
                c.execute("UPDATE api_tokens SET disabled=?1 WHERE id=?2 AND user_id=?3", params![d, id, uid])?;
            }
            c.prepare_cached(
                "SELECT token_hash, name, prefix, created_at, last_used_at, disabled FROM api_tokens WHERE id=?1 AND user_id=?2",
            )?
            .query_row(params![id, uid], |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    json!({"id": id, "name": r.get::<_, String>(1)?, "prefix": r.get::<_, String>(2)?,
                        "created_at": rfc3339(r.get(3)?), "last_used_at": opt_rfc3339(r.get(4)?),
                        "disabled": r.get::<_, bool>(5)?}),
                ))
            })
            .optional()?
            .ok_or_else(|| ApiError::not_found("token"))
        })
        .await?;
    if v["disabled"] == true {
        if let Ok(h) = <[u8; 32]>::try_from(hash.as_slice()) {
            s.auth.drop_token(&h);
        }
    }
    Ok(Json(v))
}

pub async fn list(State(s): S, FullSession(p): FullSession) -> ApiResult<Json<Value>> {
    let uid = p.user.id;
    let v = s
        .db
        .call(move |c| {
            let mut st = c.prepare_cached(
                "SELECT id, name, prefix, created_at, last_used_at, disabled FROM api_tokens WHERE user_id=?1 ORDER BY id",
            )?;
            let rows = st.query_map([uid], |r| {
                Ok(json!({"id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
                    "prefix": r.get::<_, String>(2)?, "created_at": rfc3339(r.get(3)?),
                    "last_used_at": opt_rfc3339(r.get(4)?), "disabled": r.get::<_, bool>(5)?}))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(Value::Array(v)))
}

pub async fn delete(State(s): S, FullSession(p): FullSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let uid = p.user.id;
    let hash = s
        .db
        .call(move |c| {
            let h: Option<Vec<u8>> = c
                .query_row("SELECT token_hash FROM api_tokens WHERE id=?1 AND user_id=?2", params![id, uid], |r| {
                    r.get(0)
                })
                .optional()?;
            let Some(h) = h else { return Err(ApiError::not_found("token")) };
            c.execute("DELETE FROM api_tokens WHERE id=?1", [id])?;
            Ok(h)
        })
        .await?;
    if let Ok(h) = <[u8; 32]>::try_from(hash.as_slice()) {
        s.auth.drop_token(&h);
    }
    Ok(Json(json!({"ok": true})))
}
