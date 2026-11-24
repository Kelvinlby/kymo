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

/// Caller's role on a project. Ordered: viewer < editor < admin < owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Editor,
    Admin,
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Admin => "admin",
            Role::Owner => "owner",
        }
    }
    /// Parse a *share* role (only viewer/editor can be granted).
    pub fn parse_share(s: &str) -> Option<Role> {
        match s {
            "viewer" => Some(Role::Viewer),
            "editor" => Some(Role::Editor),
            _ => None,
        }
    }
    /// Read + edit/delete experiments + ingest.
    pub fn can_edit(self) -> bool {
        self >= Role::Editor
    }
    /// Rename/delete the project, change its sharing.
    pub fn can_manage(self) -> bool {
        self >= Role::Admin
    }
}

#[derive(Clone, Debug)]
pub struct ProjectRow {
    pub id: i64,
    pub owner_id: i64,
    pub owner_username: String,
    pub owner_display_name: String,
    pub name: String,
    pub description: String,
    pub everyone: Option<String>,
    pub created_at: i64,
    /// The caller's explicit member role, if any.
    pub member_role: Option<String>,
    pub member_count: i64,
    pub experiment_count: i64,
    pub running_count: i64,
    pub last_activity: Option<i64>,
}

const PROJECT_BASE: &str = "p.id, p.owner_id, u.username, u.display_name, p.name, p.description, p.everyone, p.created_at,
    (SELECT role FROM project_members m WHERE m.project_id=p.id AND m.user_id=:uid)";

/// Full project select (with stats); bind `:uid` = caller id. Append WHERE/ORDER.
pub fn project_select() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        format!(
            "SELECT {PROJECT_BASE},
                (SELECT count(*) FROM project_members m WHERE m.project_id=p.id),
                (SELECT count(*) FROM experiments e WHERE e.project_id=p.id),
                (SELECT count(*) FROM experiments e WHERE e.project_id=p.id AND e.status='running'),
                (SELECT max(updated_at) FROM experiments e WHERE e.project_id=p.id)
             FROM projects p JOIN users u ON u.id=p.owner_id"
        )
    })
}

pub fn project_from_row(r: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    let n = r.as_ref().column_count();
    let opt = |i: usize| -> rusqlite::Result<i64> { if i < n { r.get(i) } else { Ok(0) } };
    Ok(ProjectRow {
        id: r.get(0)?,
        owner_id: r.get(1)?,
        owner_username: r.get(2)?,
        owner_display_name: r.get(3)?,
        name: r.get(4)?,
        description: r.get(5)?,
        everyone: r.get(6)?,
        created_at: r.get(7)?,
        member_role: r.get(8)?,
        member_count: opt(9)?,
        experiment_count: opt(10)?,
        running_count: opt(11)?,
        last_activity: if 12 < n { r.get(12)? } else { None },
    })
}

/// Project with stats, as seen by user `uid`.
pub fn load_project(c: &Connection, id: i64, uid: i64) -> rusqlite::Result<Option<ProjectRow>> {
    c.prepare_cached(&format!("{} WHERE p.id=:id", project_select()))?
        .query_row(rusqlite::named_params! {":uid": uid, ":id": id}, project_from_row)
        .optional()
}

/// Project without stats (permission checks on hot-ish paths).
pub fn load_project_acl(c: &Connection, id: i64, uid: i64) -> rusqlite::Result<Option<ProjectRow>> {
    c.prepare_cached(&format!("SELECT {PROJECT_BASE} FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=:id"))?
        .query_row(rusqlite::named_params! {":uid": uid, ":id": id}, project_from_row)
        .optional()
}

/// The caller's effective role: owner > admin > max(member role, everyone role).
pub fn role_of(p: &Principal, pr: &ProjectRow) -> Option<Role> {
    if pr.owner_id == p.user.id {
        return Some(Role::Owner);
    }
    if p.user.is_admin {
        return Some(Role::Admin);
    }
    let m = pr.member_role.as_deref().and_then(Role::parse_share);
    let e = pr.everyone.as_deref().and_then(Role::parse_share);
    m.max(e)
}

fn check_role(p: &Principal, pr: ProjectRow, need: Role) -> ApiResult<(ProjectRow, Role)> {
    match role_of(p, &pr) {
        Some(r) if r >= need || (need == Role::Admin && r.can_manage()) => Ok((pr, r)),
        Some(_) if need == Role::Editor => Err(ApiError::forbidden("project is read-only for you")),
        Some(_) => Err(ApiError::forbidden("only the project owner or the admin can do this")),
        None => Err(ApiError::not_found("project")),
    }
}

/// Project readable by `p`, else 404 (existence is not leaked).
pub fn readable_project(c: &Connection, p: &Principal, id: i64) -> ApiResult<(ProjectRow, Role)> {
    let pr = load_project(c, id, p.user.id)?.ok_or_else(|| ApiError::not_found("project"))?;
    check_role(p, pr, Role::Viewer)
}

/// Owner/admin only (rename, delete, sharing).
pub fn managed_project(c: &Connection, p: &Principal, id: i64) -> ApiResult<(ProjectRow, Role)> {
    let pr = load_project(c, id, p.user.id)?.ok_or_else(|| ApiError::not_found("project"))?;
    check_role(p, pr, Role::Admin)
}

/// Project of an experiment, checked for read (`edit=false`) or editor (`edit=true`) access.
pub fn experiment_project(c: &Connection, p: &Principal, exp_id: i64, edit: bool) -> ApiResult<(ProjectRow, Role)> {
    let pid: Option<i64> = c
        .prepare_cached("SELECT project_id FROM experiments WHERE id=?1")?
        .query_row([exp_id], |r| r.get(0))
        .optional()?;
    let Some(pid) = pid else { return Err(ApiError::not_found("experiment")) };
    let pr = load_project_acl(c, pid, p.user.id)?.ok_or_else(|| ApiError::not_found("experiment"))?;
    check_role(p, pr, if edit { Role::Editor } else { Role::Viewer })
        .map_err(|e| if e.code == "not_found" { ApiError::not_found("experiment") } else { e })
}

pub fn project_json(p: &ProjectRow, role: Role) -> Value {
    json!({
        "id": p.id, "name": p.name, "description": p.description,
        "everyone": p.everyone, "shared": p.everyone.is_some(),
        "member_count": p.member_count, "role": role.as_str(),
        "owner": {"id": p.owner_id, "username": p.owner_username, "display_name": p.owner_display_name},
        "created_at": rfc3339(p.created_at),
        "experiment_count": p.experiment_count,
        "running_count": p.running_count,
        "last_activity": rfc3339(p.last_activity.unwrap_or(p.created_at).max(p.created_at)),
    })
}

pub fn f64_json(v: f64) -> Value {
    if v.is_finite() { json!(v) } else { Value::Null }
}

pub fn parse_json_text(s: &str, default: Value) -> Value {
    serde_json::from_str(s).unwrap_or(default)
}
