//! Static SPA serving from KYMO_WEB_DIR with index.html fallback.

use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use std::convert::Infallible;
use std::path::Path;
use tower::ServiceExt;
use tower::util::BoxCloneSyncService;
use tower_http::services::{ServeDir, ServeFile};

pub fn static_service(dir: &Path) -> BoxCloneSyncService<Request, Response, Infallible> {
    let index = dir.join("index.html");
    let serve = ServeDir::new(dir).append_index_html_on_directories(true).fallback(ServeFile::new(index));
    let svc = tower::service_fn(move |req: Request| {
        let serve = serve.clone();
        async move {
            let hashed = req.uri().path().starts_with("/assets/");
            let mut resp = match serve.oneshot(req).await {
                Ok(r) => r.map(axum::body::Body::new),
                Err(e) => match e {},
            };
            if resp.status() == StatusCode::NOT_FOUND {
                return Ok((StatusCode::NOT_FOUND, "web UI not built (KYMO_WEB_DIR)").into_response());
            }
            let cc = if hashed && resp.status().is_success() {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
            Ok::<_, Infallible>(resp)
        }
    });
    BoxCloneSyncService::new(svc)
}
