//! Authentication core: users/sessions/tokens caches, principal resolution, CSRF,
//! guard extractors, password hashing, login rate limiting, passkey challenges.

use crate::error::{ApiError, ApiResult};
use crate::util::{now_ms, random_b62, sha256};
use crate::AppState;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header, request::Parts};
use axum::middleware::Next;
use axum::response::Response;
use dashmap::DashMap;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use webauthn_rs::prelude::{PasskeyAuthentication, PasskeyRegistration};

pub const SESSION_COOKIE: &str = "kymo_session";
pub const SESSION_TTL_MS: i64 = 14 * 24 * 3600 * 1000;
const SESSION_EXTEND_EVERY_MS: i64 = 10 * 60 * 1000;
const TOKEN_TOUCH_EVERY_MS: i64 = 60 * 1000;
pub const CHALLENGE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessState {
    PasskeyRequired,
    EnrollPasskey,
    Full,
}

impl SessState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessState::PasskeyRequired => "passkey_required",
            SessState::EnrollPasskey => "enroll_passkey",
            SessState::Full => "full",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "passkey_required" => SessState::PasskeyRequired,
            "enroll_passkey" => SessState::EnrollPasskey,
            "full" => SessState::Full,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug)]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub passkey_count: i64,
}

impl UserInfo {
    pub fn public_json(&self) -> serde_json::Value {
        serde_json::json!({"id": self.id, "username": self.username,
            "display_name": self.display_name, "is_admin": self.is_admin})
    }
}

#[derive(Clone, Debug)]
pub enum Via {
    Session { hash: [u8; 32], state: SessState },
    Token { id: i64 },
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub user: UserInfo,
    pub via: Via,
}

impl Principal {
    pub fn session_hash(&self) -> Option<[u8; 32]> {
        match self.via {
            Via::Session { hash, .. } => Some(hash),
            Via::Token { .. } => None,
        }
    }
    pub fn session_state(&self) -> Option<SessState> {
        match self.via {
            Via::Session { state, .. } => Some(state),
            Via::Token { .. } => None,
        }
    }
}

/// Request extension holding the (optional) authenticated principal.
#[derive(Clone)]
pub struct AuthCtx(pub Option<Principal>);

#[derive(Clone, Copy)]
struct SessEntry {
    user_id: i64,
    state: SessState,
    expires_at: i64,
}

struct TokEntry {
    id: i64,
    user_id: i64,
    last_touch: AtomicI64,
}

pub enum Challenge {
    Register { reg: PasskeyRegistration, name: String },
    Login { auth: PasskeyAuthentication },
}

pub struct AuthState {
    users: DashMap<i64, UserInfo>,
    sessions: DashMap<[u8; 32], SessEntry>,
    tokens: DashMap<[u8; 32], Arc<TokEntry>>,
    /// Bumped whenever a token is revoked (disabled/deleted). A cache-miss lookup only caches its result
    /// if no revocation happened while it read the database, so a token disabled mid-lookup can't stick.
    token_gen: AtomicU64,
    pub policy_all: AtomicBool,
    pub setup_token: Mutex<Option<String>>,
    pub setup_required: AtomicBool,
    pub challenges: Mutex<HashMap<[u8; 32], (Instant, Challenge)>>,
    rate: Mutex<HashMap<String, (Instant, u32)>>,
}

impl AuthState {
    pub fn new(policy_all: bool, setup_required: bool) -> Self {
        AuthState {
            users: DashMap::new(),
            sessions: DashMap::new(),
            tokens: DashMap::new(),
            token_gen: AtomicU64::new(0),
            policy_all: AtomicBool::new(policy_all),
            setup_token: Mutex::new(None),
            setup_required: AtomicBool::new(setup_required),
            challenges: Mutex::new(HashMap::new()),
            rate: Mutex::new(HashMap::new()),
        }
    }

    pub fn policy(&self) -> bool {
        self.policy_all.load(Ordering::Relaxed)
    }

    /// Whether this user must hold a passkey (admin always; others when the policy is on).
    pub fn requires_passkey(&self, u: &UserInfo) -> bool {
        u.is_admin || self.policy()
    }

    pub fn invalidate_user(&self, id: i64) {
        self.users.remove(&id);
    }

    /// Forget all cached sessions/tokens of a user (after disable/delete/reset).
    pub fn drop_user_creds(&self, id: i64) {
        self.users.remove(&id);
        self.sessions.retain(|_, s| s.user_id != id);
        self.token_gen.fetch_add(1, Ordering::SeqCst);
        self.tokens.retain(|_, t| t.user_id != id);
    }

    pub fn drop_session(&self, hash: &[u8; 32]) {
        self.sessions.remove(hash);
        self.challenges.lock().remove(hash);
    }

    /// Revoke the cached entry of a token (after it was disabled or deleted in the database).
    pub fn drop_token(&self, hash: &[u8; 32]) {
        self.token_gen.fetch_add(1, Ordering::SeqCst);
        self.tokens.remove(hash);
    }

    pub fn set_session_state_cached(&self, hash: &[u8; 32], st: SessState) {
        if let Some(mut s) = self.sessions.get_mut(hash) {
            s.state = st;
        }
    }

    /// Fixed-window limiter; returns Err(429) when `key` exceeded `max` hits in 60 s.
    pub fn rate_check(&self, key: String, max: u32) -> ApiResult<()> {
        let mut g = self.rate.lock();
        let now = Instant::now();
        if g.len() > 50_000 {
            g.retain(|_, (t, _)| now.duration_since(*t).as_secs() < 60);
        }
        let e = g.entry(key).or_insert((now, 0));
        if now.duration_since(e.0).as_secs() >= 60 {
            *e = (now, 0);
        }
        e.1 += 1;
        if e.1 > max {
            let wait = 60u64.saturating_sub(now.duration_since(e.0).as_secs()).max(1);
            return Err(ApiError::rate_limited(wait as u32));
        }
        Ok(())
    }

    pub fn rate_reset(&self, key: &str) {
        self.rate.lock().remove(key);
    }

    pub fn put_challenge(&self, session: [u8; 32], c: Challenge) {
        let mut g = self.challenges.lock();
        g.retain(|_, (t, _)| t.elapsed() < CHALLENGE_TTL);
        g.insert(session, (Instant::now(), c));
    }

    pub fn take_challenge(&self, session: &[u8; 32]) -> Option<Challenge> {
        let (t, c) = self.challenges.lock().remove(session)?;
        (t.elapsed() < CHALLENGE_TTL).then_some(c)
    }
}

// ---- DB helpers -----------------------------------------------------------------

pub fn load_user(c: &Connection, id: i64) -> rusqlite::Result<Option<UserInfo>> {
    c.prepare_cached(
        "SELECT id, username, display_name, is_admin, disabled,
                (SELECT count(*) FROM passkeys p WHERE p.user_id = users.id)
         FROM users WHERE id=?1",
    )?
    .query_row([id], |r| {
        Ok(UserInfo {
            id: r.get(0)?,
            username: r.get(1)?,
            display_name: r.get(2)?,
            is_admin: r.get(3)?,
            disabled: r.get(4)?,
            passkey_count: r.get(5)?,
        })
    })
    .optional()
}

impl AppState {
    /// Cached user lookup. Blocking on miss.
    pub fn user_blocking(&self, id: i64) -> ApiResult<Option<UserInfo>> {
        if let Some(u) = self.auth.users.get(&id) {
            return Ok(Some(u.clone()));
        }
        let u = self.db.with(|c| Ok(load_user(c, id)?))?;
        if let Some(u) = &u {
            self.auth.users.insert(id, u.clone());
        }
        Ok(u)
    }

    /// Create a session row; returns the raw cookie token.
    pub fn create_session(c: &Connection, user_id: i64, st: SessState) -> rusqlite::Result<String> {
        let tok = random_b62(43);
        let h = sha256(tok.as_bytes());
        let now = now_ms();
        c.execute(
            "INSERT INTO sessions(id_hash, user_id, state, created_at, expires_at) VALUES(?1,?2,?3,?4,?5)",
            params![&h[..], user_id, st.as_str(), now, now + SESSION_TTL_MS],
        )?;
        c.execute("UPDATE users SET last_login_at=?1 WHERE id=?2", params![now, user_id])?;
        Ok(tok)
    }

    pub fn session_cookie(&self, tok: &str) -> HeaderValue {
        let secure = if self.cfg.secure_cookies() { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{SESSION_COOKIE}={tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{secure}",
            SESSION_TTL_MS / 1000
        ))
        .expect("valid cookie")
    }

    pub fn clear_cookie(&self) -> HeaderValue {
        let secure = if self.cfg.secure_cookies() { "; Secure" } else { "" };
        HeaderValue::from_str(&format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}"))
            .expect("valid cookie")
    }

    /// Persist a new session state (DB + cache).
    pub async fn set_session_state(self: &Arc<Self>, hash: [u8; 32], st: SessState) -> ApiResult<()> {
        self.db
            .call(move |c| {
                c.execute("UPDATE sessions SET state=?1 WHERE id_hash=?2", params![st.as_str(), &hash[..]])?;
                Ok(())
            })
            .await?;
        self.auth.set_session_state_cached(&hash, st);
        Ok(())
    }

    /// In-memory-only resolution (no DB): Some(principal) on a complete cache hit.
    fn token_fast(&self, tok: &str) -> Option<Principal> {
        let hash = sha256(tok.as_bytes());
        let e = self.auth.tokens.get(&hash)?.clone();
        let user = self.auth.users.get(&e.user_id)?.clone();
        if user.disabled || now_ms() - e.last_touch.load(Ordering::Relaxed) > TOKEN_TOUCH_EVERY_MS {
            return None;
        }
        Some(Principal { user, via: Via::Token { id: e.id } })
    }

    fn session_fast(&self, tok: &str) -> Option<Principal> {
        let hash = sha256(tok.as_bytes());
        let e = *self.auth.sessions.get(&hash)?;
        let now = now_ms();
        if e.expires_at <= now || e.expires_at - now < SESSION_TTL_MS - SESSION_EXTEND_EVERY_MS {
            return None;
        }
        let user = self.auth.users.get(&e.user_id)?.clone();
        if user.disabled
            || (e.state == SessState::Full && self.auth.requires_passkey(&user) && user.passkey_count == 0)
        {
            return None;
        }
        Some(Principal { user, via: Via::Session { hash, state: e.state } })
    }

    /// Resolve a session cookie. Returns (principal, extended?) . Blocking on cache miss.
    fn resolve_session(&self, tok: &str) -> ApiResult<Option<(Principal, bool)>> {
        let hash = sha256(tok.as_bytes());
        let now = now_ms();
        let entry = match self.auth.sessions.get(&hash).map(|e| *e) {
            Some(e) => Some(e),
            None => {
                let row = self.db.with(|c| {
                    Ok(c.prepare_cached("SELECT user_id, state, expires_at FROM sessions WHERE id_hash=?1")?
                        .query_row([&hash[..]], |r| {
                            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
                        })
                        .optional()?)
                })?;
                match row {
                    Some((user_id, st, expires_at)) => {
                        let e = SessEntry {
                            user_id,
                            state: SessState::parse(&st).unwrap_or(SessState::PasskeyRequired),
                            expires_at,
                        };
                        self.auth.sessions.insert(hash, e);
                        Some(e)
                    }
                    None => None,
                }
            }
        };
        let Some(mut e) = entry else { return Ok(None) };
        if e.expires_at <= now {
            self.auth.sessions.remove(&hash);
            let _ = self.db.with(|c| Ok(c.execute("DELETE FROM sessions WHERE id_hash=?1", [&hash[..]])?));
            return Ok(None);
        }
        let Some(user) = self.user_blocking(e.user_id)? else { return Ok(None) };
        if user.disabled {
            return Ok(None);
        }
        // Policy enforcement: a full session of a user that must hold a passkey but has none
        // drops to enroll_passkey.
        if e.state == SessState::Full && self.auth.requires_passkey(&user) && user.passkey_count == 0 {
            e.state = SessState::EnrollPasskey;
            self.db.with(|c| {
                Ok(c.execute("UPDATE sessions SET state='enroll_passkey' WHERE id_hash=?1", [&hash[..]])?)
            })?;
            self.auth.set_session_state_cached(&hash, e.state);
        }
        let mut extended = false;
        if e.expires_at - now < SESSION_TTL_MS - SESSION_EXTEND_EVERY_MS {
            let exp = now + SESSION_TTL_MS;
            self.db.with(|c| {
                Ok(c.execute("UPDATE sessions SET expires_at=?1 WHERE id_hash=?2", params![exp, &hash[..]])?)
            })?;
            if let Some(mut s) = self.auth.sessions.get_mut(&hash) {
                s.expires_at = exp;
            }
            extended = true;
        }
        Ok(Some((Principal { user, via: Via::Session { hash, state: e.state } }, extended)))
    }

    /// Resolve a bearer API token. Blocking on cache miss.
    fn resolve_token(&self, tok: &str) -> ApiResult<Option<Principal>> {
        if !tok.starts_with("kymo_") || tok.len() > 128 {
            return Ok(None);
        }
        let hash = sha256(tok.as_bytes());
        let entry = match self.auth.tokens.get(&hash).map(|e| e.clone()) {
            Some(e) => e,
            None => {
                let generation = self.auth.token_gen.load(Ordering::SeqCst);
                let row = self.db.with(|c| {
                    Ok(c.prepare_cached("SELECT id, user_id, disabled FROM api_tokens WHERE token_hash=?1")?
                        .query_row([&hash[..]], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, bool>(2)?)))
                        .optional()?)
                })?;
                let Some((id, user_id, disabled)) = row else { return Ok(None) };
                if disabled {
                    // never cached, so re-enabling takes effect on the next request
                    return Err(ApiError::new(
                        StatusCode::UNAUTHORIZED,
                        "token_disabled",
                        "this API token is disabled; its owner can re-enable it under Settings → API tokens",
                    ));
                }
                let e = Arc::new(TokEntry { id, user_id, last_touch: AtomicI64::new(0) });
                if self.auth.token_gen.load(Ordering::SeqCst) == generation {
                    self.auth.tokens.insert(hash, e.clone());
                    // a revocation that raced with the insert above wins
                    if self.auth.token_gen.load(Ordering::SeqCst) != generation {
                        self.auth.tokens.remove(&hash);
                    }
                }
                e
            }
        };
        let Some(user) = self.user_blocking(entry.user_id)? else { return Ok(None) };
        if user.disabled {
            return Ok(None);
        }
        let now = now_ms();
        let last = entry.last_touch.load(Ordering::Relaxed);
        if now - last > TOKEN_TOUCH_EVERY_MS
            && entry.last_touch.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
        {
            let id = entry.id;
            let db = self.db.clone();
            std::thread::spawn(move || {
                let _ = db.with(|c| Ok(c.execute("UPDATE api_tokens SET last_used_at=?1 WHERE id=?2", params![now, id])?));
            });
        }
        Ok(Some(Principal { user, via: Via::Token { id: entry.id } }))
    }
}

pub fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    for v in headers.get_all(header::COOKIE) {
        let Ok(s) = v.to_str() else { continue };
        for part in s.split(';') {
            let part = part.trim();
            if let Some(rest) = part.strip_prefix(name) {
                if let Some(val) = rest.strip_prefix('=') {
                    return Some(val);
                }
            }
        }
    }
    None
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, rest) = v.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| rest.trim())
}

pub fn client_ip(state: &AppState, parts_ext: &axum::http::Extensions, headers: &HeaderMap) -> String {
    if state.cfg.trust_proxy {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
        {
            return ip.trim().to_string();
        }
    }
    parts_ext
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

/// Global /api middleware: CSRF check for cookie-authenticated mutations, principal resolution.
pub async fn api_middleware(State(state): State<Arc<AppState>>, mut req: Request, next: Next) -> Response {
    use axum::response::IntoResponse;
    let headers = req.headers();
    let has_bearer = headers.contains_key(header::AUTHORIZATION);
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe && !has_bearer && headers.get("x-kymo-csrf").and_then(|v| v.to_str().ok()) != Some("1") {
        return ApiError::new(StatusCode::FORBIDDEN, "csrf", "missing X-Kymo-CSRF header").into_response();
    }
    let bearer_tok = bearer(headers).map(|s| s.to_string());
    let cookie_tok = if has_bearer { None } else { cookie_value(headers, SESSION_COOKIE).map(|s| s.to_string()) };
    if has_bearer && bearer_tok.is_none() {
        return ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "malformed Authorization header")
            .into_response();
    }
    let fast = match (&bearer_tok, &cookie_tok) {
        (Some(t), _) => state.token_fast(t).map(|p| (Some(p), false, false)),
        (None, Some(t)) => state.session_fast(t).map(|p| (Some(p), false, false)),
        (None, None) => Some((None, false, false)),
    };
    let (principal, extended, bad_token) = match fast {
        Some(x) => x,
        None => {
            let st = state.clone();
            let resolved = tokio::task::spawn_blocking(move || -> ApiResult<(Option<Principal>, bool, bool)> {
                if let Some(t) = bearer_tok {
                    let p = st.resolve_token(&t)?;
                    let bad = p.is_none();
                    return Ok((p, false, bad));
                }
                if let Some(t) = cookie_tok {
                    return Ok(match st.resolve_session(&t)? {
                        Some((p, ext)) => (Some(p), ext, false),
                        None => (None, false, false),
                    });
                }
                Ok((None, false, false))
            });
            match resolved.await {
                Ok(Ok(x)) => x,
                Ok(Err(e)) => return e.into_response(),
                Err(e) => return ApiError::from(e).into_response(),
            }
        }
    };
    if bad_token {
        return ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", "invalid or revoked API token")
            .into_response();
    }
    let cookie_tok = if extended { cookie_value(req.headers(), SESSION_COOKIE).map(|s| s.to_string()) } else { None };
    req.extensions_mut().insert(AuthCtx(principal));
    let mut resp = next.run(req).await;
    if let Some(t) = cookie_tok {
        // Sliding expiry: refresh the browser cookie, unless the handler set/cleared it.
        if !resp.headers().contains_key(header::SET_COOKIE) {
            resp.headers_mut().insert(header::SET_COOKIE, state.session_cookie(&t));
        }
    }
    resp
}

// ---- guard extractors -------------------------------------------------------------

fn ctx(parts: &Parts) -> Option<Principal> {
    parts.extensions.get::<AuthCtx>().and_then(|c| c.0.clone())
}

fn state_error(st: SessState) -> ApiError {
    match st {
        SessState::PasskeyRequired => {
            ApiError::new(StatusCode::FORBIDDEN, "session_passkey_required", "passkey verification required")
        }
        SessState::EnrollPasskey => {
            ApiError::new(StatusCode::FORBIDDEN, "session_enroll_passkey", "a passkey must be registered first")
        }
        SessState::Full => ApiError::forbidden("forbidden"),
    }
}

/// Any principal allowed on read + ingest endpoints: full session or API token.
pub struct ReadAuth(pub Principal);
/// Full cookie session only (no API tokens).
pub struct FullSession(pub Principal);
/// Any cookie session, whatever its state (passkey ceremonies).
pub struct AnySession(pub Principal);
/// Full session of the admin.
pub struct Admin(pub Principal);
/// Optional principal (public endpoints).
pub struct MaybeAuth(pub Option<Principal>);

impl<S: Send + Sync> FromRequestParts<S> for ReadAuth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        let p = ctx(parts).ok_or_else(ApiError::unauthorized)?;
        match p.session_state() {
            None | Some(SessState::Full) => Ok(ReadAuth(p)),
            Some(st) => Err(state_error(st)),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for FullSession {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        let p = ctx(parts).ok_or_else(ApiError::unauthorized)?;
        match p.session_state() {
            None => Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "token_not_allowed",
                "API tokens cannot call this endpoint",
            )),
            Some(SessState::Full) => Ok(FullSession(p)),
            Some(st) => Err(state_error(st)),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for AnySession {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        let p = ctx(parts).ok_or_else(ApiError::unauthorized)?;
        match p.session_state() {
            None => Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "token_not_allowed",
                "API tokens cannot call this endpoint",
            )),
            Some(_) => Ok(AnySession(p)),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Admin {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, s: &S) -> Result<Self, ApiError> {
        let FullSession(p) = FullSession::from_request_parts(parts, s).await?;
        if !p.user.is_admin {
            return Err(ApiError::forbidden("admin only"));
        }
        Ok(Admin(p))
    }
}

impl<S: Send + Sync> FromRequestParts<S> for MaybeAuth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        Ok(MaybeAuth(ctx(parts)))
    }
}

// ---- passwords --------------------------------------------------------------------

pub const MIN_PASSWORD: usize = 10;

pub fn check_password_policy(pw: &str) -> ApiResult<()> {
    if pw.chars().count() < MIN_PASSWORD {
        return Err(ApiError::invalid("weak_password", format!("password must be at least {MIN_PASSWORD} characters")));
    }
    if pw.len() > 1024 {
        return Err(ApiError::invalid("weak_password", "password too long"));
    }
    Ok(())
}

pub fn hash_password(pw: &str) -> ApiResult<String> {
    let salt: [u8; 16] = crate::util::random_bytes();
    Argon2::default()
        .hash_password_with_salt(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(ApiError::internal)
}

pub fn verify_password(pw: &str, hash: &str) -> bool {
    Argon2::default().verify_password(pw.as_bytes(), hash).is_ok()
}

/// Burn the same time as a real verification (for unknown usernames).
pub fn dummy_verify(pw: &str) {
    static DUMMY: OnceLock<String> = OnceLock::new();
    let h = DUMMY.get_or_init(|| hash_password(&random_b62(24)).unwrap_or_default());
    let _ = verify_password(pw, h);
}

/// Client IP (for rate limiting).
pub struct ClientIp(pub String);

impl FromRequestParts<Arc<AppState>> for ClientIp {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, s: &Arc<AppState>) -> Result<Self, ApiError> {
        Ok(ClientIp(client_ip(s, &parts.extensions, &parts.headers)))
    }
}
