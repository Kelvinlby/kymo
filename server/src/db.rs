//! Metadata database (`meta.sqlite`): a small connection pool + schema migrations.

use crate::error::{ApiError, ApiResult};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const META_MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE users(
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        webauthn_id BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
    );
    CREATE UNIQUE INDEX users_one_admin ON users(is_admin) WHERE is_admin = 1;
    CREATE TABLE sessions(
        id_hash BLOB PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE passkeys(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cred_id BLOB NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );
    CREATE INDEX passkeys_user ON passkeys(user_id);
    CREATE TABLE invites(
        id INTEGER PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        username TEXT,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by INTEGER
    );
    CREATE TABLE password_resets(
        id INTEGER PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
    );
    CREATE TABLE api_tokens(
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash BLOB NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );
    CREATE INDEX api_tokens_user ON api_tokens(user_id);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects(
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        shared INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(owner_id, name)
    );
    CREATE TABLE experiments(
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        config TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        host TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, name)
    );
    CREATE TABLE series(
        id INTEGER PRIMARY KEY,
        experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        UNIQUE(experiment_id, key)
    );
    "#,
    // v2: per-user sharing replaces projects.shared (kept, ignored)
    r#"
    ALTER TABLE projects ADD COLUMN everyone TEXT CHECK(everyone IN ('viewer', 'editor'));
    UPDATE projects SET everyone = 'viewer' WHERE shared = 1;
    CREATE TABLE project_members(
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('viewer', 'editor')),
        PRIMARY KEY(project_id, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX project_members_user ON project_members(user_id);
    CREATE INDEX experiments_project_status ON experiments(project_id, status);
    "#,
    // v3: time of the last completed backup download (unix ms)
    r#"
    ALTER TABLE projects ADD COLUMN last_backup_at INTEGER;
    "#,
];

pub const SHARD_MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE points(
        series_id INTEGER NOT NULL,
        step INTEGER NOT NULL,
        value REAL,
        ts REAL NOT NULL,
        PRIMARY KEY(series_id, step)
    ) WITHOUT ROWID;
    CREATE TABLE summaries(
        series_id INTEGER PRIMARY KEY,
        experiment_id INTEGER NOT NULL,
        count INTEGER NOT NULL,
        first_step INTEGER NOT NULL,
        last_step INTEGER NOT NULL,
        min REAL,
        max REAL,
        last_value REAL,
        last_ts REAL NOT NULL
    );
    "#,
];

/// Apply pending migrations tracked with `PRAGMA user_version`.
pub fn migrate(conn: &mut Connection, migrations: &[&str]) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in migrations.iter().enumerate().skip(v as usize) {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
        tracing::info!("applied migration v{}", i + 1);
    }
    Ok(())
}

pub fn open_meta(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open(path)?;
    c.busy_timeout(Duration::from_secs(10))?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
         PRAGMA cache_size=-32768; PRAGMA temp_store=MEMORY;",
    )?;
    c.set_prepared_statement_cache_capacity(64);
    Ok(c)
}

pub struct Db {
    path: PathBuf,
    pool: Mutex<Vec<Connection>>,
}

impl Db {
    pub fn open(path: PathBuf) -> rusqlite::Result<Arc<Db>> {
        let mut c = open_meta(&path)?;
        migrate(&mut c, META_MIGRATIONS)?;
        Ok(Arc::new(Db { path, pool: Mutex::new(vec![c]) }))
    }

    /// Run `f` with a pooled connection on the current (blocking-allowed) thread.
    pub fn with<R>(&self, f: impl FnOnce(&mut Connection) -> ApiResult<R>) -> ApiResult<R> {
        let conn = self.pool.lock().pop();
        let mut conn = match conn {
            Some(c) => c,
            None => open_meta(&self.path)?,
        };
        let r = f(&mut conn);
        let mut p = self.pool.lock();
        if p.len() < 32 {
            p.push(conn);
        }
        r
    }

    /// Run `f` on tokio's blocking pool (never on an async worker).
    pub async fn call<R: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&mut Connection) -> ApiResult<R> + Send + 'static,
    ) -> ApiResult<R> {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.with(f)).await.map_err(ApiError::from)?
    }
}
