//! Plot data path: batch series query (downsampled, parallel) and raw export.

use super::{JsonBody, experiment_project};
use crate::AppState;
use crate::auth::{Principal, ReadAuth};
use crate::error::{ApiError, ApiResult};
use crate::store::downsample::{Sampled, push_f64, push_json_str, sample, write_series_json};
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use rayon::prelude::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

type S = State<Arc<AppState>>;

#[derive(Deserialize)]
pub struct SeriesRef {
    experiment_id: i64,
    key: String,
}

#[derive(Deserialize)]
pub struct QueryReq {
    series: Vec<SeriesRef>,
    max_points: Option<usize>,
    step_min: Option<i64>,
    step_max: Option<i64>,
}

pub const MAX_QUERY_SERIES: usize = 2000;

fn empty() -> Sampled {
    Sampled {
        total: 0,
        downsampled: false,
        step: vec![],
        value: vec![],
        min: vec![],
        max: vec![],
        ts: vec![],
    }
}

/// Runs the whole query on the rayon pool; returns the JSON body.
pub fn run_query(s: &AppState, p: &Principal, req: &QueryReq) -> ApiResult<Vec<u8>> {
    let mut readable: HashMap<i64, bool> = HashMap::new();
    s.db.with(|c| {
        for r in &req.series {
            if !readable.contains_key(&r.experiment_id) {
                let ok = match experiment_project(c, p, r.experiment_id, false) {
                    Ok(_) => true,
                    Err(e) if e.code == "not_found" => false,
                    Err(e) => return Err(e),
                };
                readable.insert(r.experiment_id, ok);
            }
        }
        Ok(())
    })?;
    let max_points = req.max_points.unwrap_or(2000).clamp(1, 20_000);
    let parts: Vec<ApiResult<Vec<u8>>> = req
        .series
        .par_iter()
        .map(|r| {
            let mut out = Vec::new();
            let e = r.experiment_id;
            let sampled = if readable.get(&e).copied().unwrap_or(false) {
                let sid = s.store.exp_keys(e)?.map.read().get(r.key.as_str()).copied();
                match sid {
                    Some(sid) => {
                        let col = s.store.column(e, sid)?;
                        let g = col.read();
                        sample(&g, req.step_min, req.step_max, max_points)
                    }
                    None => empty(),
                }
            } else {
                empty()
            };
            write_series_json(&mut out, e, &r.key, &sampled);
            Ok(out)
        })
        .collect();
    let mut body = Vec::with_capacity(parts.iter().map(|p| p.as_ref().map_or(0, |v| v.len() + 1)).sum::<usize>() + 16);
    body.extend_from_slice(b"{\"series\":[");
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            body.push(b',');
        }
        body.extend_from_slice(&part?);
    }
    body.extend_from_slice(b"]}");
    Ok(body)
}

pub async fn query(State(s): S, ReadAuth(p): ReadAuth, JsonBody(req): JsonBody<QueryReq>) -> ApiResult<Response> {
    if req.series.len() > MAX_QUERY_SERIES {
        return Err(ApiError::invalid("too_many_series", format!("at most {MAX_QUERY_SERIES} series per query")));
    }
    let t0 = Instant::now();
    let (tx, rx) = tokio::sync::oneshot::channel();
    rayon::spawn(move || {
        let _ = tx.send(run_query(&s, &p, &req));
    });
    let body = rx.await.map_err(|_| ApiError::internal("query worker died"))??;
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    let mut r = Response::new(Body::from(body));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(v) = HeaderValue::from_str(&format!("query;dur={ms:.3}")) {
        r.headers_mut().insert("server-timing", v);
    }
    Ok(r)
}

#[derive(Deserialize)]
pub struct RawReq {
    experiment_id: i64,
    key: String,
    format: Option<String>,
}

pub async fn raw(State(s): S, ReadAuth(p): ReadAuth, Query(q): Query<RawReq>) -> ApiResult<Response> {
    let csv = match q.format.as_deref() {
        None | Some("json") => false,
        Some("csv") => true,
        Some(_) => return Err(ApiError::invalid("invalid_format", "format must be csv or json")),
    };
    let s2 = s.clone();
    let key = q.key.clone();
    let e = q.experiment_id;
    let col = tokio::task::spawn_blocking(move || -> ApiResult<_> {
        s2.db.with(|c| experiment_project(c, &p, e, false).map(|_| ()))?;
        let sid = s2.store.exp_keys(e)?.map.read().get(key.as_str()).copied();
        let Some(sid) = sid else { return Err(ApiError::not_found("series")) };
        s2.store.column(e, sid)
    })
    .await??;
    const CHUNK: usize = 16384;
    let n = col.read().len();
    let nchunks = n.div_ceil(CHUNK);
    let key = q.key.clone();
    // chunk index: 0 = header, 1..=nchunks = data, nchunks+1 = trailer
    let stream = futures_util::stream::iter(0..nchunks + 2).map(move |ci| {
        let mut out = Vec::with_capacity(CHUNK * 40);
        let mut rb = ryu::Buffer::new();
        let mut ib = itoa::Buffer::new();
        if ci == 0 {
            if csv {
                out.extend_from_slice(b"step,value,ts\n");
            } else {
                out.extend_from_slice(b"{\"experiment_id\":");
                out.extend_from_slice(ib.format(e).as_bytes());
                out.extend_from_slice(b",\"key\":");
                push_json_str(&mut out, &key);
                out.extend_from_slice(b",\"points\":[");
            }
        } else if ci <= nchunks {
            let g = col.read();
            let a = (ci - 1) * CHUNK;
            let b = (a + CHUNK).min(g.len());
            for i in a..b {
                if csv {
                    out.extend_from_slice(ib.format(g.steps[i]).as_bytes());
                    out.push(b',');
                    let v = g.values[i];
                    if v.is_nan() {
                        out.extend_from_slice(b"NaN");
                    } else if v.is_infinite() {
                        out.extend_from_slice(if v > 0.0 { b"Infinity" } else { b"-Infinity" });
                    } else {
                        out.extend_from_slice(rb.format_finite(v).as_bytes());
                    }
                    out.push(b',');
                    push_f64(&mut out, g.ts[i], &mut rb);
                    out.push(b'\n');
                } else {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.push(b'[');
                    out.extend_from_slice(ib.format(g.steps[i]).as_bytes());
                    out.push(b',');
                    push_f64(&mut out, g.values[i], &mut rb);
                    out.push(b',');
                    push_f64(&mut out, g.ts[i], &mut rb);
                    out.push(b']');
                }
            }
        } else if !csv {
            out.extend_from_slice(b"]}");
        }
        Ok::<_, std::convert::Infallible>(Bytes::from(out))
    });
    let mut r = Response::new(Body::from_stream(stream));
    let ct = if csv { "text/csv; charset=utf-8" } else { "application/json" };
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(ct));
    if csv {
        let fname: String =
            q.key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"exp{}_{fname}.csv\"", e)) {
            r.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    Ok(r.into_response())
}

use futures_util::StreamExt;
