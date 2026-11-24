pub mod admin;
pub mod auth;
pub mod ingest;
pub mod projects;
pub mod series;
pub mod tokens;

use crate::auth::Principal;
use crate::error::{ApiError, ApiResult};
use crate::util::rfc3339;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use rusqlite::{Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub async fn not_found() -> ApiError {
    ApiError::new(axum::http::StatusCode::NOT_FOUND, "not_found", "no such API endpoint")
}

/// JSON body extractor whose rejections use the API error format.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(v)) => Ok(JsonBody(v)),
            Err(JsonRejection::BytesRejection(e)) => Err(ApiError::too_large(e.body_text())),
            Err(e) => Err(ApiError::bad_request(e.body_text())),
        }
    }
}

/// Optional JSON body: an empty body yields `None`.
pub struct OptJsonBody<T>(pub Option<T>);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for OptJsonBody<T> {
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        let b = axum::body::Bytes::from_request(req, state)
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?;
        if b.iter().all(|c| c.is_ascii_whitespace()) {
            return Ok(OptJsonBody(None));
        }
        serde_json::from_slice(&b).map(|v| OptJsonBody(Some(v))).map_err(|e| ApiError::bad_request(e.to_string()))
    }
}

#[derive(Clone, Debug)]
pub struct ProjectRow {
    pub id: i64,
    pub owner_id: i64,
    pub owner_username: String,
    pub name: String,
    pub description: String,
    pub shared: bool,
    pub created_at: i64,
}

pub const PROJECT_COLS: &str = "p.id, p.owner_id, u.username, p.name, p.description, p.shared, p.created_at";

pub fn project_from_row(r: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: r.get(0)?,
        owner_id: r.get(1)?,
        owner_username: r.get(2)?,
        name: r.get(3)?,
        description: r.get(4)?,
        shared: r.get(5)?,
        created_at: r.get(6)?,
    })
}

pub fn load_project(c: &Connection, id: i64) -> rusqlite::Result<Option<ProjectRow>> {
    c.prepare_cached(&format!("SELECT {PROJECT_COLS} FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=?1"))?
        .query_row([id], project_from_row)
        .optional()
}

pub fn can_read(p: &Principal, proj: &ProjectRow) -> bool {
    p.user.is_admin || proj.owner_id == p.user.id || proj.shared
}

pub fn can_write(p: &Principal, proj: &ProjectRow) -> bool {
    p.user.is_admin || proj.owner_id == p.user.id
}

/// Project readable by `p`, else 404 (existence is not leaked).
pub fn readable_project(c: &Connection, p: &Principal, id: i64) -> ApiResult<ProjectRow> {
    match load_project(c, id)? {
        Some(pr) if can_read(p, &pr) => Ok(pr),
        _ => Err(ApiError::not_found("project")),
    }
}

pub fn writable_project(c: &Connection, p: &Principal, id: i64) -> ApiResult<ProjectRow> {
    match load_project(c, id)? {
        Some(pr) if can_write(p, &pr) => Ok(pr),
        Some(pr) if can_read(p, &pr) => Err(ApiError::forbidden("project is read-only for you")),
        _ => Err(ApiError::not_found("project")),
    }
}

/// Project of an experiment, checked for read access.
pub fn experiment_project(c: &Connection, p: &Principal, exp_id: i64, write: bool) -> ApiResult<ProjectRow> {
    let pid: Option<i64> = c
        .prepare_cached("SELECT project_id FROM experiments WHERE id=?1")?
        .query_row([exp_id], |r| r.get(0))
        .optional()?;
    let Some(pid) = pid else { return Err(ApiError::not_found("experiment")) };
    let r = if write { writable_project(c, p, pid) } else { readable_project(c, p, pid) };
    r.map_err(|e| if e.code == "not_found" { ApiError::not_found("experiment") } else { e })
}

pub fn project_json(p: &ProjectRow, experiment_count: i64, last_activity: Option<i64>) -> Value {
    json!({
        "id": p.id, "name": p.name, "description": p.description, "shared": p.shared,
        "owner": {"id": p.owner_id, "username": p.owner_username},
        "created_at": rfc3339(p.created_at),
        "experiment_count": experiment_count,
        "last_activity": rfc3339(last_activity.unwrap_or(p.created_at).max(p.created_at)),
    })
}

pub fn f64_json(v: f64) -> Value {
    if v.is_finite() { json!(v) } else { Value::Null }
}

pub fn parse_json_text(s: &str, default: Value) -> Value {
    serde_json::from_str(s).unwrap_or(default)
}
