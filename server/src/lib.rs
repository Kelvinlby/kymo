//! Kymo server: ML experiment tracking backend.

pub mod api;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod ingest;
pub mod store;
pub mod util;
mod web;

use auth::AuthState;
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post};
use config::Config;
use dashmap::DashMap;
use db::Db;
use rusqlite::OptionalExtension;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use store::Store;
use store::anyhow_like::{Error as StartError, Result as StartResult};
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use webauthn_rs::prelude::{Url, Webauthn, WebauthnBuilder};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_INGEST_BODY: usize = 64 << 20;
pub const MAX_INGEST_VALUES: usize = 1_000_000;

pub struct AppState {
    pub cfg: Config,
    pub db: Arc<Db>,
    pub store: Arc<Store>,
    pub webauthn: Webauthn,
    pub auth: AuthState,
    /// "user\0project\0experiment" -> experiment id (ingest resolution cache).
    pub exp_cache: DashMap<String, i64>,
    /// experiment id -> last time `updated_at` was written (ms), to throttle meta writes.
    pub exp_touch: DashMap<i64, i64>,
}

impl AppState {
    pub fn invalidate_names(&self) {
        self.exp_cache.clear();
    }
}

fn build_webauthn(cfg: &Config) -> StartResult<Webauthn> {
    let first = Url::parse(cfg.canonical_origin())
        .map_err(|e| StartError(format!("KYMO_ORIGIN '{}' invalid: {e}", cfg.canonical_origin())))?;
    let mut b = WebauthnBuilder::new(&cfg.rp_id, &first)
        .map_err(|e| StartError(format!("webauthn config (KYMO_RP_ID={}, origin {first}): {e:?}", cfg.rp_id)))?
        .rp_name("Kymo");
    for o in cfg.origins.iter().skip(1) {
        let u = Url::parse(o).map_err(|e| StartError(format!("KYMO_ORIGIN entry '{o}' invalid: {e}")))?;
        b = b.append_allowed_origin(&u);
    }
    b.build().map_err(|e| StartError(format!("webauthn build failed: {e:?}")))
}

pub fn build_state(cfg: Config) -> StartResult<Arc<AppState>> {
    std::fs::create_dir_all(&cfg.data_dir)?;
    let db = Db::open(cfg.data_dir.join("meta.sqlite"))?;
    let (users, policy): (i64, bool) = db
        .with(|c| {
            let n: i64 = c.query_row("SELECT count(*) FROM users", [], |r| r.get(0))?;
            let p: Option<String> = c
                .query_row("SELECT value FROM settings WHERE key='passkey_required_for_all'", [], |r| r.get(0))
                .optional()?;
            Ok((n, p.as_deref() == Some("true")))
        })
        .map_err(|e| StartError(e.message))?;
    let store = Store::open(&cfg, db.clone())?;
    let webauthn = build_webauthn(&cfg)?;
    let auth = AuthState::new(policy, users == 0);
    let token_path = cfg.data_dir.join("setup_token");
    if users == 0 {
        let tok = util::random_b62(32);
        write_secret_file(&token_path, &tok)?;
        let msg = format!(
            "KYMO SETUP TOKEN: {tok}  open {}/setup?token={tok}",
            cfg.canonical_origin()
        );
        if cfg.print_setup_token {
            println!("{msg}");
        }
        tracing::warn!("no users yet: setup token written to {}", token_path.display());
        *auth.setup_token.lock() = Some(tok);
    } else if token_path.exists() {
        let _ = std::fs::remove_file(&token_path);
    }
    Ok(Arc::new(AppState {
        cfg,
        db,
        store,
        webauthn,
        auth,
        exp_cache: DashMap::new(),
        exp_touch: DashMap::new(),
    }))
}

fn write_secret_file(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let _ = std::fs::remove_file(path);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(path)?;
    f.write_all(content.as_bytes())?;
    f.write_all(b"\n")
}

pub fn router(state: Arc<AppState>) -> Router {
    use api::{admin, auth as a, backup as b, ingest as ing, projects as p, series as s, tokens as t};
    let v1 = Router::new()
        // auth (public / session)
        .route("/auth/state", get(a::state))
        .route("/auth/setup", post(a::setup))
        .route("/auth/invite/{token}", get(a::invite_info))
        .route("/auth/signup", post(a::signup))
        .route("/auth/login", post(a::login))
        .route("/auth/logout", post(a::logout))
        .route("/auth/password", post(a::change_password))
        .route("/auth/reset", post(a::reset_password))
        .route("/auth/passkey/register/start", post(a::passkey_register_start))
        .route("/auth/passkey/register/finish", post(a::passkey_register_finish))
        .route("/auth/passkey/login/start", post(a::passkey_login_start))
        .route("/auth/passkey/login/finish", post(a::passkey_login_finish))
        .route("/auth/passkeys", get(a::passkeys_list))
        .route("/auth/passkeys/{id}", delete(a::passkey_delete))
        // admin
        .route("/admin/users", get(admin::users_list))
        .route("/admin/users/{id}", patch(admin::user_patch).delete(admin::user_delete))
        .route("/admin/users/{id}/reset-password", post(admin::user_reset_password))
        .route("/admin/invites", get(admin::invites_list).post(admin::invite_create))
        .route("/admin/invites/{id}", delete(admin::invite_delete))
        .route("/admin/settings", get(admin::settings_get).put(admin::settings_put))
        // tokens
        .route("/tokens", get(t::list).post(t::create))
        .route("/tokens/{id}", delete(t::delete))
        // projects / experiments
        .route("/projects", get(p::list).post(p::create))
        .route("/projects/import", post(b::import).layer(DefaultBodyLimit::disable()))
        .route("/projects/{id}/backup", get(b::export))
        .route("/projects/{id}", get(p::get_one).patch(p::patch).delete(p::delete))
        .route("/projects/{id}/experiments", get(p::experiments))
        .route("/projects/{id}/sharing", get(p::sharing_get).put(p::sharing_put))
        .route("/users", get(p::users_directory))
        .route("/projects/{id}/metric-keys", get(p::metric_keys))
        .route("/experiments/{id}", get(p::experiment_get).patch(p::experiment_patch).delete(p::experiment_delete))
        .route("/experiments/{id}/metrics", get(p::experiment_metrics))
        // series
        .route("/series/query", post(s::query))
        .route("/series/raw", get(s::raw))
        // ingest
        .route("/ingest", post(ing::ingest).layer(DefaultBodyLimit::max(MAX_INGEST_BODY)));
    let api = Router::new()
        .nest("/v1", v1)
        .fallback(api::not_found)
        .layer(DefaultBodyLimit::max(4 << 20))
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth::api_middleware));
    Router::new()
        .nest("/api", api)
        .fallback_service(web::static_service(&state.cfg.web_dir))
        .layer(
            CompressionLayer::new()
                .quality(tower_http::CompressionLevel::Fastest)
                // backups are already gzip
                .compress_when(DefaultPredicate::new().and(NotForContentType::const_new("application/gzip"))),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// A running server (used by `main`, the integration tests and the benchmark).
pub struct RunningServer {
    pub addr: SocketAddr,
    pub state: Arc<AppState>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl RunningServer {
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Graceful shutdown: stop accepting, finish in-flight requests, drain writer queues.
    pub async fn shutdown(mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        if let Some(j) = self.join.take() {
            let _ = j.await;
        }
        self.state.store.shutdown().await;
    }

    pub fn setup_token(&self) -> Option<String> {
        self.state.auth.setup_token.lock().clone()
    }

    pub fn setup_required(&self) -> bool {
        self.state.auth.setup_required.load(Ordering::Relaxed)
    }
}

pub async fn start(cfg: Config) -> StartResult<RunningServer> {
    let bind = cfg.bind.clone();
    let state = tokio::task::spawn_blocking(move || build_state(cfg))
        .await
        .map_err(|e| StartError(e.to_string()))??;
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let addr = listener.local_addr()?;
    let app = router(state.clone());
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let r = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        if let Err(e) = r {
            tracing::error!("server error: {e}");
        }
    });
    tracing::info!("kymo-server {VERSION} listening on http://{addr}");
    Ok(RunningServer { addr, state, stop: Some(tx), join: Some(join) })
}
