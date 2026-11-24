//! /api/v1/auth/* — setup, signup, login, sessions, passwords, passkeys.

use super::{JsonBody, OptJsonBody};
use crate::AppState;
use crate::auth::{
    AnySession, Challenge, ClientIp, FullSession, MaybeAuth, Principal, SessState, check_password_policy,
    dummy_verify, hash_password, verify_password,
};
use crate::error::{ApiError, ApiResult};
use crate::util::{ct_eq, now_ms, opt_rfc3339, rfc3339, sha256, valid_username};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use webauthn_rs::prelude::{Passkey, PublicKeyCredential, RegisterPublicKeyCredential, Uuid};

type S = State<Arc<AppState>>;

fn with_cookie(state: &AppState, tok: &str, body: Value) -> Response {
    let mut r = Json(body).into_response();
    r.headers_mut().insert(header::SET_COOKIE, state.session_cookie(tok));
    r
}

pub async fn state(State(s): S, MaybeAuth(p): MaybeAuth) -> Json<Value> {
    Json(json!({
        "setup_required": s.auth.setup_required.load(Ordering::Relaxed),
        "session_state": p.as_ref().and_then(|p| p.session_state()).map(|s| s.as_str()),
        "user": p.as_ref().map(|p| p.user.public_json()),
        "policy": {"passkey_required_for_all": s.auth.policy()},
        "version": crate::VERSION,
    }))
}

fn clean_display_name(d: Option<String>, username: &str) -> ApiResult<String> {
    let d = d.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| username.to_string());
    if d.chars().count() > 64 || d.chars().any(|c| c.is_control()) {
        return Err(ApiError::invalid("invalid_display_name", "display name must be ≤ 64 printable characters"));
    }
    Ok(d)
}

fn check_username(u: &str) -> ApiResult<()> {
    if !valid_username(u) {
        return Err(ApiError::invalid("invalid_username", "username must match [a-z0-9_.-]{2,32}"));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct SetupReq {
    setup_token: String,
    username: String,
    password: String,
    display_name: Option<String>,
}

pub async fn setup(State(s): S, ClientIp(ip): ClientIp, JsonBody(req): JsonBody<SetupReq>) -> ApiResult<Response> {
    s.auth.rate_check(format!("setup:{ip}"), 10)?;
    if !s.auth.setup_required.load(Ordering::Relaxed) {
        return Err(ApiError::conflict("already_setup", "setup has already been completed"));
    }
    let ok = s.auth.setup_token.lock().as_deref().is_some_and(|t| ct_eq(t.as_bytes(), req.setup_token.as_bytes()));
    if !ok {
        return Err(ApiError::forbidden("invalid setup token"));
    }
    check_username(&req.username)?;
    check_password_policy(&req.password)?;
    let display = clean_display_name(req.display_name, &req.username)?;
    let pw = req.password;
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await??;
    let username = req.username.clone();
    let (uid, tok) = s
        .db
        .call(move |c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let n: i64 = tx.query_row("SELECT count(*) FROM users", [], |r| r.get(0))?;
            if n > 0 {
                return Err(ApiError::conflict("already_setup", "setup has already been completed"));
            }
            let wid = Uuid::new_v4();
            tx.execute(
                "INSERT INTO users(username, display_name, password_hash, is_admin, webauthn_id, created_at)
                 VALUES(?1, ?2, ?3, 1, ?4, ?5)",
                params![username, display, hash, &wid.as_bytes()[..], now_ms()],
            )?;
            let uid = tx.last_insert_rowid();
            let tok = AppState::create_session(&tx, uid, SessState::EnrollPasskey)?;
            tx.commit()?;
            Ok((uid, tok))
        })
        .await?;
    s.auth.setup_required.store(false, Ordering::Relaxed);
    *s.auth.setup_token.lock() = None;
    let _ = std::fs::remove_file(s.cfg.data_dir.join("setup_token"));
    tracing::info!("admin '{}' created via setup", req.username);
    let user = s.user_blocking_async(uid).await?;
    Ok(with_cookie(&s, &tok, json!({"state": "enroll_passkey", "user": user.public_json()})))
}

impl AppState {
    pub async fn user_blocking_async(self: &Arc<Self>, id: i64) -> ApiResult<crate::auth::UserInfo> {
        let s = self.clone();
        tokio::task::spawn_blocking(move || s.user_blocking(id)).await??.ok_or_else(|| ApiError::not_found("user"))
    }
}

pub async fn invite_info(State(s): S, ClientIp(ip): ClientIp, Path(token): Path<String>) -> ApiResult<Json<Value>> {
    s.auth.rate_check(format!("invite:{ip}"), 60)?;
    let h = sha256(token.as_bytes());
    let row = s
        .db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT username FROM invites WHERE token_hash=?1 AND used_at IS NULL AND expires_at > ?2",
                params![&h[..], now_ms()],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?)
        })
        .await?;
    Ok(Json(match row {
        Some(u) => json!({"valid": true, "username": u}),
        None => json!({"valid": false}),
    }))
}

#[derive(Deserialize)]
pub struct SignupReq {
    invite_token: String,
    username: String,
    password: String,
    display_name: Option<String>,
}

pub async fn signup(State(s): S, ClientIp(ip): ClientIp, JsonBody(req): JsonBody<SignupReq>) -> ApiResult<Response> {
    s.auth.rate_check(format!("signup:{ip}"), 10)?;
    check_username(&req.username)?;
    check_password_policy(&req.password)?;
    let display = clean_display_name(req.display_name, &req.username)?;
    let pw = req.password;
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await??;
    let st = if s.auth.policy() { SessState::EnrollPasskey } else { SessState::Full };
    let h = sha256(req.invite_token.as_bytes());
    let username = req.username;
    let (uid, tok) = s
        .db
        .call(move |c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_ms();
            let inv: Option<(i64, Option<String>)> = tx
                .query_row(
                    "SELECT id, username FROM invites WHERE token_hash=?1 AND used_at IS NULL AND expires_at > ?2",
                    params![&h[..], now],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((inv_id, inv_user)) = inv else {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "invalid_invite", "invite is invalid, used or expired"));
            };
            if inv_user.as_ref().is_some_and(|u| u != &username) {
                return Err(ApiError::invalid("username_mismatch", "this invite is for a different username"));
            }
            let taken: bool =
                tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE username=?1)", [&username], |r| r.get(0))?;
            if taken {
                return Err(ApiError::conflict("username_taken", "username is already taken"));
            }
            let wid = Uuid::new_v4();
            tx.execute(
                "INSERT INTO users(username, display_name, password_hash, is_admin, webauthn_id, created_at)
                 VALUES(?1, ?2, ?3, 0, ?4, ?5)",
                params![username, display, hash, &wid.as_bytes()[..], now],
            )?;
            let uid = tx.last_insert_rowid();
            let n = tx.execute(
                "UPDATE invites SET used_at=?1, used_by=?2 WHERE id=?3 AND used_at IS NULL",
                params![now, uid, inv_id],
            )?;
            if n != 1 {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "invalid_invite", "invite already used"));
            }
            let tok = AppState::create_session(&tx, uid, st)?;
            tx.commit()?;
            Ok((uid, tok))
        })
        .await?;
    let user = s.user_blocking_async(uid).await?;
    Ok(with_cookie(&s, &tok, json!({"state": st.as_str(), "user": user.public_json()})))
}

#[derive(Deserialize)]
pub struct LoginReq {
    username: String,
    password: String,
}

pub async fn login(
    State(s): S,
    ClientIp(ip): ClientIp,
    MaybeAuth(prev): MaybeAuth,
    JsonBody(req): JsonBody<LoginReq>,
) -> ApiResult<Response> {
    let uname = req.username.trim().to_lowercase();
    let rl_key = format!("login:{ip}:{uname}");
    s.auth.rate_check(rl_key.clone(), 10)?;
    let s2 = s.clone();
    let pw = req.password;
    let uid = tokio::task::spawn_blocking(move || -> ApiResult<Option<(i64, bool)>> {
        let row = s2.db.with(|c| {
            Ok(c.query_row("SELECT id, password_hash, disabled FROM users WHERE username=?1", [&uname], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?))
            })
            .optional()?)
        })?;
        match row {
            Some((id, hash, disabled)) => Ok(verify_password(&pw, &hash).then_some((id, disabled))),
            None => {
                dummy_verify(&pw);
                Ok(None)
            }
        }
    })
    .await??;
    let Some((uid, disabled)) = uid else {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "invalid username or password"));
    };
    if disabled {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "account_disabled", "this account is disabled"));
    }
    s.auth.rate_reset(&rl_key);
    s.auth.invalidate_user(uid);
    let user = s.user_blocking_async(uid).await?;
    let st = if user.passkey_count > 0 {
        SessState::PasskeyRequired
    } else if s.auth.requires_passkey(&user) {
        SessState::EnrollPasskey
    } else {
        SessState::Full
    };
    let old = prev.and_then(|p| p.session_hash());
    let tok = s
        .db
        .call(move |c| {
            if let Some(h) = old {
                c.execute("DELETE FROM sessions WHERE id_hash=?1", [&h[..]])?;
            }
            Ok(AppState::create_session(c, uid, st)?)
        })
        .await?;
    if let Some(h) = old {
        s.auth.drop_session(&h);
    }
    Ok(with_cookie(&s, &tok, json!({"state": st.as_str(), "user": user.public_json()})))
}

pub async fn logout(State(s): S, MaybeAuth(p): MaybeAuth) -> ApiResult<Response> {
    if let Some(h) = p.and_then(|p| p.session_hash()) {
        s.db.call(move |c| Ok(c.execute("DELETE FROM sessions WHERE id_hash=?1", [&h[..]])?)).await?;
        s.auth.drop_session(&h);
    }
    let mut r = Json(json!({"ok": true})).into_response();
    r.headers_mut().insert(header::SET_COOKIE, s.clear_cookie());
    Ok(r)
}

#[derive(Deserialize)]
pub struct PasswordReq {
    old_password: String,
    new_password: String,
}

pub async fn change_password(
    State(s): S,
    FullSession(p): FullSession,
    JsonBody(req): JsonBody<PasswordReq>,
) -> ApiResult<Json<Value>> {
    s.auth.rate_check(format!("password:{}", p.user.id), 10)?;
    check_password_policy(&req.new_password)?;
    let uid = p.user.id;
    let keep = p.session_hash().unwrap_or_default();
    let s2 = s.clone();
    tokio::task::spawn_blocking(move || -> ApiResult<()> {
        let hash: String =
            s2.db.with(|c| Ok(c.query_row("SELECT password_hash FROM users WHERE id=?1", [uid], |r| r.get(0))?))?;
        if !verify_password(&req.old_password, &hash) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "invalid_credentials", "current password is wrong"));
        }
        let nh = hash_password(&req.new_password)?;
        s2.db.with(|c| {
            c.execute("UPDATE users SET password_hash=?1 WHERE id=?2", params![nh, uid])?;
            c.execute("DELETE FROM sessions WHERE user_id=?1 AND id_hash<>?2", params![uid, &keep[..]])?;
            Ok(())
        })
    })
    .await??;
    s.auth.drop_user_creds(uid);
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct ResetReq {
    reset_token: String,
    password: String,
}

pub async fn reset_password(
    State(s): S,
    ClientIp(ip): ClientIp,
    JsonBody(req): JsonBody<ResetReq>,
) -> ApiResult<Json<Value>> {
    s.auth.rate_check(format!("reset:{ip}"), 10)?;
    check_password_policy(&req.password)?;
    let pw = req.password;
    let nh = tokio::task::spawn_blocking(move || hash_password(&pw)).await??;
    let h = sha256(req.reset_token.as_bytes());
    let uid = s
        .db
        .call(move |c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let now = now_ms();
            let row: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT id, user_id FROM password_resets WHERE token_hash=?1 AND used_at IS NULL AND expires_at > ?2",
                    params![&h[..], now],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((rid, uid)) = row else {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "invalid_reset", "reset link is invalid or expired"));
            };
            tx.execute("UPDATE password_resets SET used_at=?1 WHERE id=?2", params![now, rid])?;
            tx.execute("UPDATE users SET password_hash=?1 WHERE id=?2", params![nh, uid])?;
            tx.execute("DELETE FROM sessions WHERE user_id=?1", [uid])?;
            tx.commit()?;
            Ok(uid)
        })
        .await?;
    s.auth.drop_user_creds(uid);
    Ok(Json(json!({"ok": true})))
}

// ---- passkeys -----------------------------------------------------------------------

fn load_passkeys(c: &rusqlite::Connection, uid: i64) -> ApiResult<Vec<(i64, Passkey)>> {
    let mut st = c.prepare_cached("SELECT id, data FROM passkeys WHERE user_id=?1")?;
    let rows = st.query_map([uid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for r in rows {
        let (id, data) = r?;
        match serde_json::from_str::<Passkey>(&data) {
            Ok(pk) => out.push((id, pk)),
            Err(e) => tracing::error!("passkey {id} unreadable: {e}"),
        }
    }
    Ok(out)
}

fn session_hash(p: &Principal) -> ApiResult<[u8; 32]> {
    p.session_hash().ok_or_else(ApiError::unauthorized)
}

#[derive(Deserialize, Default)]
pub struct RegStartReq {
    name: Option<String>,
}

fn clean_passkey_name(n: Option<String>) -> ApiResult<String> {
    let n = n.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Passkey".into());
    if n.chars().count() > 64 || n.chars().any(|c| c.is_control()) {
        return Err(ApiError::invalid("invalid_name", "passkey name must be ≤ 64 printable characters"));
    }
    Ok(n)
}

pub async fn passkey_register_start(
    State(s): S,
    AnySession(p): AnySession,
    OptJsonBody(body): OptJsonBody<RegStartReq>,
) -> ApiResult<Json<Value>> {
    if p.session_state() == Some(SessState::PasskeyRequired) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "session_passkey_required", "verify your passkey first"));
    }
    let name = clean_passkey_name(body.and_then(|b| b.name))?;
    let hash = session_hash(&p)?;
    let uid = p.user.id;
    let (wid, existing) = s
        .db
        .call(move |c| {
            let wid: Vec<u8> = c.query_row("SELECT webauthn_id FROM users WHERE id=?1", [uid], |r| r.get(0))?;
            let ex = load_passkeys(c, uid)?;
            Ok((wid, ex))
        })
        .await?;
    let wid = Uuid::from_slice(&wid).map_err(ApiError::internal)?;
    let exclude: Vec<_> = existing.iter().map(|(_, pk)| pk.cred_id().clone()).collect();
    let (ccr, reg) = s
        .webauthn
        .start_passkey_registration(wid, &p.user.username, &p.user.display_name, Some(exclude))
        .map_err(|e| ApiError::internal(format!("webauthn start: {e:?}")))?;
    s.auth.put_challenge(hash, Challenge::Register { reg, name });
    Ok(Json(serde_json::to_value(ccr).map_err(ApiError::internal)?))
}

#[derive(Deserialize)]
pub struct RegFinishReq {
    name: Option<String>,
    credential: RegisterPublicKeyCredential,
}

pub async fn passkey_register_finish(
    State(s): S,
    AnySession(p): AnySession,
    JsonBody(req): JsonBody<RegFinishReq>,
) -> ApiResult<Json<Value>> {
    let st = p.session_state();
    if st == Some(SessState::PasskeyRequired) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "session_passkey_required", "verify your passkey first"));
    }
    let hash = session_hash(&p)?;
    let Some(Challenge::Register { reg, name }) = s.auth.take_challenge(&hash) else {
        return Err(ApiError::invalid("no_challenge", "no pending passkey registration (expired?)"));
    };
    let name = match req.name {
        Some(n) if !n.trim().is_empty() => clean_passkey_name(Some(n))?,
        _ => name,
    };
    let pk = s.webauthn.finish_passkey_registration(&req.credential, &reg).map_err(|e| {
        ApiError::invalid("passkey_invalid", format!("passkey registration failed: {e:?}"))
    })?;
    let data = serde_json::to_string(&pk).map_err(ApiError::internal)?;
    let cred_id = pk.cred_id().clone();
    let uid = p.user.id;
    let now = now_ms();
    let name2 = name.clone();
    let id = s
        .db
        .call(move |c| {
            let exists: bool =
                c.query_row("SELECT EXISTS(SELECT 1 FROM passkeys WHERE cred_id=?1)", [&cred_id], |r| r.get(0))?;
            if exists {
                return Err(ApiError::conflict("passkey_exists", "this passkey is already registered"));
            }
            c.execute(
                "INSERT INTO passkeys(user_id, name, cred_id, data, created_at) VALUES(?1,?2,?3,?4,?5)",
                params![uid, name2, cred_id, data, now],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await?;
    s.auth.invalidate_user(uid);
    if st == Some(SessState::EnrollPasskey) {
        s.set_session_state(hash, SessState::Full).await?;
    }
    Ok(Json(json!({"id": id, "name": name, "created_at": rfc3339(now)})))
}

pub async fn passkey_login_start(State(s): S, AnySession(p): AnySession) -> ApiResult<Json<Value>> {
    if p.session_state() != Some(SessState::PasskeyRequired) {
        return Err(ApiError::conflict("not_required", "this session does not need passkey verification"));
    }
    let hash = session_hash(&p)?;
    let uid = p.user.id;
    let keys = s.db.call(move |c| load_passkeys(c, uid)).await?;
    if keys.is_empty() {
        return Err(ApiError::conflict("no_passkeys", "no passkeys registered"));
    }
    let pks: Vec<Passkey> = keys.into_iter().map(|(_, k)| k).collect();
    let (rcr, auth) = s
        .webauthn
        .start_passkey_authentication(&pks)
        .map_err(|e| ApiError::internal(format!("webauthn start: {e:?}")))?;
    s.auth.put_challenge(hash, Challenge::Login { auth });
    Ok(Json(serde_json::to_value(rcr).map_err(ApiError::internal)?))
}

#[derive(Deserialize)]
pub struct LoginFinishReq {
    credential: PublicKeyCredential,
}

pub async fn passkey_login_finish(
    State(s): S,
    AnySession(p): AnySession,
    JsonBody(req): JsonBody<LoginFinishReq>,
) -> ApiResult<Json<Value>> {
    if p.session_state() != Some(SessState::PasskeyRequired) {
        return Err(ApiError::conflict("not_required", "this session does not need passkey verification"));
    }
    let hash = session_hash(&p)?;
    let Some(Challenge::Login { auth }) = s.auth.take_challenge(&hash) else {
        return Err(ApiError::invalid("no_challenge", "no pending passkey login (expired?)"));
    };
    let res = s.webauthn.finish_passkey_authentication(&req.credential, &auth).map_err(|e| {
        ApiError::new(StatusCode::UNAUTHORIZED, "passkey_failed", format!("passkey verification failed: {e:?}"))
    })?;
    let uid = p.user.id;
    let cred_id = res.cred_id().clone();
    s.db
        .call(move |c| {
            let row: Option<(i64, String)> = c
                .query_row(
                    "SELECT id, data FROM passkeys WHERE cred_id=?1 AND user_id=?2",
                    params![cred_id, uid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((id, data)) = row else {
                return Err(ApiError::new(StatusCode::UNAUTHORIZED, "passkey_failed", "unknown passkey"));
            };
            let now = now_ms();
            let mut pk: Passkey = serde_json::from_str(&data).map_err(ApiError::internal)?;
            if pk.update_credential(&res) == Some(true) {
                let d = serde_json::to_string(&pk).map_err(ApiError::internal)?;
                c.execute("UPDATE passkeys SET data=?1, last_used_at=?2 WHERE id=?3", params![d, now, id])?;
            } else {
                c.execute("UPDATE passkeys SET last_used_at=?1 WHERE id=?2", params![now, id])?;
            }
            c.execute("UPDATE users SET last_login_at=?1 WHERE id=?2", params![now, uid])?;
            Ok(())
        })
        .await?;
    s.set_session_state(hash, SessState::Full).await?;
    Ok(Json(json!({"state": "full"})))
}

pub async fn passkeys_list(State(s): S, FullSession(p): FullSession) -> ApiResult<Json<Value>> {
    let uid = p.user.id;
    let v = s
        .db
        .call(move |c| {
            let mut st = c.prepare_cached(
                "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id=?1 ORDER BY id",
            )?;
            let rows = st.query_map([uid], |r| {
                Ok(json!({"id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
                    "created_at": rfc3339(r.get(2)?), "last_used_at": opt_rfc3339(r.get(3)?)}))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(Value::Array(v)))
}

pub async fn passkey_delete(State(s): S, FullSession(p): FullSession, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let uid = p.user.id;
    let must = s.auth.requires_passkey(&p.user);
    s.db
        .call(move |c| {
            let owner: Option<i64> =
                c.query_row("SELECT user_id FROM passkeys WHERE id=?1", [id], |r| r.get(0)).optional()?;
            if owner != Some(uid) {
                return Err(ApiError::not_found("passkey"));
            }
            let n: i64 = c.query_row("SELECT count(*) FROM passkeys WHERE user_id=?1", [uid], |r| r.get(0))?;
            if n <= 1 && must {
                return Err(ApiError::conflict("last_passkey", "you must keep at least one passkey"));
            }
            c.execute("DELETE FROM passkeys WHERE id=?1", [id])?;
            Ok(())
        })
        .await?;
    s.auth.invalidate_user(uid);
    Ok(Json(json!({"ok": true})))
}
