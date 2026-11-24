//! Project backups: a self-describing `.tar.gz` per project (format: BACKUP-FORMAT.md, embedded in every
//! archive as README.txt), streamed on download, and imported back as a new project.

use super::{Role, load_project, parse_json_text, project_json, readable_project};
use crate::AppState;
use crate::auth::{FullSession, Principal, ReadAuth};
use crate::error::{ApiError, ApiResult};
use crate::store::{Row, prepare_rows};
use crate::util::{
    now_ms, parse_rfc3339, random_b62, rfc3339, valid_experiment_name, valid_metric_key, valid_project_name, valid_status,
};
use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use futures_util::StreamExt;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

type S = State<Arc<AppState>>;

pub const FORMAT: &str = "kymo-project-backup";
pub const FORMAT_VERSION: i64 = 1;
const README: &str = include_str!("../../../BACKUP-FORMAT.md");
/// Points per CSV part file (bounds the per-export buffer to a few tens of MB).
const PART_ROWS: usize = 500_000;
/// Rows per store write during import.
const IMPORT_BATCH: usize = 200_000;

// ------------------------------------------------------------------------------------------------ export

struct ExpMeta {
    id: i64,
    name: String,
    status: String,
    config: String,
    tags: String,
    notes: String,
    host: Option<String>,
    created_at: i64,
    updated_at: i64,
    /// (key, series id), sorted by key
    series: Vec<(String, i64)>,
}

struct ProjectMeta {
    name: String,
    description: String,
    created_at: i64,
    owner: String,
    everyone: Option<String>,
    members: Vec<(String, String)>,
    exps: Vec<ExpMeta>,
}

fn load_meta(c: &rusqlite::Connection, p: &Principal, id: i64) -> ApiResult<ProjectMeta> {
    let (pr, _) = readable_project(c, p, id)?;
    let members = c
        .prepare_cached(
            "SELECT u.username, m.role FROM project_members m JOIN users u ON u.id=m.user_id
             WHERE m.project_id=?1 ORDER BY u.username",
        )?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut exps = c
        .prepare_cached(
            "SELECT id, name, status, config, tags, notes, host, created_at, updated_at
             FROM experiments WHERE project_id=?1 ORDER BY created_at, id",
        )?
        .query_map([id], |r| {
            Ok(ExpMeta {
                id: r.get(0)?,
                name: r.get(1)?,
                status: r.get(2)?,
                config: r.get(3)?,
                tags: r.get(4)?,
                notes: r.get(5)?,
                host: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                series: vec![],
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut st = c.prepare_cached("SELECT key, id FROM series WHERE experiment_id=?1 ORDER BY key")?;
    for e in &mut exps {
        e.series = st.query_map([e.id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    }
    Ok(ProjectMeta {
        name: pr.name,
        description: pr.description,
        created_at: pr.created_at,
        owner: pr.owner_username,
        everyone: pr.everyone,
        members,
        exps,
    })
}

enum Msg {
    Data(Bytes),
    /// The archive is complete; everything before it is the whole file.
    Done,
}

/// `Write` that hands 256 KiB chunks to the response body. Fails (ending the export) once the client is gone.
struct ChanWriter {
    tx: mpsc::Sender<Msg>,
    buf: Vec<u8>,
}

impl ChanWriter {
    const CHUNK: usize = 256 << 10;
    fn send(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let b = std::mem::replace(&mut self.buf, Vec::with_capacity(Self::CHUNK));
        self.tx
            .blocking_send(Msg::Data(Bytes::from(b)))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "client went away"))
    }
}

impl Write for ChanWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= Self::CHUNK {
            self.send()?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

fn push_num(out: &mut Vec<u8>, v: f64, rb: &mut ryu::Buffer) {
    if v.is_nan() {
        out.extend_from_slice(b"NaN");
    } else if v.is_infinite() {
        out.extend_from_slice(if v > 0.0 { b"Infinity" } else { b"-Infinity" });
    } else {
        out.extend_from_slice(rb.format_finite(v).as_bytes());
    }
}

fn append<W: Write>(tar: &mut tar::Builder<W>, path: &str, data: &[u8], mtime: u64) -> std::io::Result<()> {
    let mut h = tar::Header::new_ustar();
    h.set_size(data.len() as u64);
    h.set_mode(0o644);
    h.set_mtime(mtime);
    h.set_entry_type(tar::EntryType::Regular);
    tar.append_data(&mut h, path, data)
}

/// Top-level directory / file stem: project name + UTC time, e.g. `llm-pretrain-20261124-093000`.
fn stem(name: &str, ms: i64) -> String {
    let t = rfc3339(ms);
    let compact: String = t[..19].chars().filter(|c| c.is_ascii_digit() || *c == 'T').collect::<String>().replace('T', "-");
    format!("{name}-{compact}")
}

/// Write the whole archive. Returns (metrics, points).
fn write_archive(s: &AppState, m: &ProjectMeta, w: ChanWriter, now: i64) -> std::io::Result<(u64, u64)> {
    let gz = flate2::write::GzEncoder::new(w, flate2::Compression::new(1));
    let mut tar = tar::Builder::new(gz);
    let mtime = (now / 1000).max(0) as u64;
    let top = stem(&m.name, now);
    append(&mut tar, &format!("{top}/README.txt"), README.as_bytes(), mtime)?;
    let (mut n_metrics, mut n_points) = (0u64, 0u64);
    let mut rb = ryu::Buffer::new();
    let mut ib = itoa::Buffer::new();
    let mut buf: Vec<u8> = Vec::with_capacity(8 << 20);
    for (ei, e) in m.exps.iter().enumerate() {
        let dir = format!("{top}/experiments/{:06}", ei + 1);
        let mut metrics = Vec::with_capacity(e.series.len());
        for (mi, (key, sid)) in e.series.iter().enumerate() {
            let mut files: Vec<String> = Vec::new();
            let mut count = 0u64;
            let mut part_rows = 0usize;
            let mut io_err: Option<std::io::Error> = None;
            let flush = |buf: &mut Vec<u8>, files: &mut Vec<String>, tar: &mut tar::Builder<flate2::write::GzEncoder<ChanWriter>>| -> std::io::Result<()> {
                let rel = format!("metrics/{:06}-{:04}.csv", mi + 1, files.len());
                append(tar, &format!("{dir}/{rel}"), buf, mtime)?;
                files.push(rel);
                buf.clear();
                Ok(())
            };
            buf.clear();
            buf.extend_from_slice(b"step,value,ts\n");
            s.store
                .scan_points(e.id, *sid, |step, value, ts| {
                    buf.extend_from_slice(ib.format(step).as_bytes());
                    buf.push(b',');
                    push_num(&mut buf, value, &mut rb);
                    buf.push(b',');
                    push_num(&mut buf, ts, &mut rb);
                    buf.push(b'\n');
                    count += 1;
                    part_rows += 1;
                    if part_rows == PART_ROWS {
                        part_rows = 0;
                        if let Err(err) = flush(&mut buf, &mut files, &mut tar) {
                            io_err = Some(err);
                            return false;
                        }
                        buf.extend_from_slice(b"step,value,ts\n");
                    }
                    true
                })
                .map_err(|e| std::io::Error::other(e.message))?;
            if let Some(err) = io_err {
                return Err(err);
            }
            if part_rows > 0 || files.is_empty() {
                flush(&mut buf, &mut files, &mut tar)?;
            }
            n_metrics += 1;
            n_points += count;
            metrics.push(json!({"key": key, "points": count, "files": files}));
        }
        let ej = json!({
            "name": e.name,
            "status": e.status,
            "config": parse_json_text(&e.config, json!({})),
            "tags": parse_json_text(&e.tags, json!([])),
            "notes": e.notes,
            "host": e.host,
            "created_at": rfc3339(e.created_at),
            "updated_at": rfc3339(e.updated_at),
            "metrics": metrics,
        });
        append(&mut tar, &format!("{dir}/experiment.json"), &serde_json::to_vec_pretty(&ej)?, mtime)?;
    }
    let manifest = json!({
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "created_at": rfc3339(now),
        "generator": format!("kymo-server {}", crate::VERSION),
        "project": {
            "name": m.name,
            "description": m.description,
            "created_at": rfc3339(m.created_at),
            "owner": m.owner,
            "everyone": m.everyone,
            "members": m.members.iter().map(|(u, r)| json!({"username": u, "role": r})).collect::<Vec<_>>(),
        },
        "experiment_count": m.exps.len(),
        "metric_count": n_metrics,
        "point_count": n_points,
    });
    append(&mut tar, &format!("{top}/manifest.json"), &serde_json::to_vec_pretty(&manifest)?, mtime)?;
    let gz = tar.into_inner()?;
    let mut w = gz.finish()?;
    w.flush()?;
    Ok((n_metrics, n_points))
}

/// `GET /projects/{id}/backup` — stream the project as `.kymo.tar.gz`. Readable by anyone who can read
/// the project (API tokens too, for scripted backups). A complete download sets `last_backup_at`.
pub async fn export(State(s): S, ReadAuth(p): ReadAuth, Path(id): Path<i64>) -> ApiResult<Response> {
    let meta = s.db.call(move |c| load_meta(c, &p, id)).await?;
    let now = now_ms();
    let fname = format!("{}.kymo.tar.gz", stem(&meta.name, now));
    let (tx, mut rx) = mpsc::channel::<Msg>(8);
    let s2 = s.clone();
    tokio::task::spawn_blocking(move || {
        let w = ChanWriter { tx: tx.clone(), buf: Vec::with_capacity(ChanWriter::CHUNK) };
        match write_archive(&s2, &meta, w, now) {
            Ok((metrics, points)) => {
                tracing::info!("backup of project {id} ({}): {metrics} metrics, {points} points", meta.name);
                let _ = tx.blocking_send(Msg::Done);
            }
            Err(e) => tracing::warn!("backup of project {id} aborted: {e}"),
        }
    });
    // The body ends after the last chunk; a missing Done (writer failed or client left) ends it with an
    // error so the client sees a broken download rather than a truncated "complete" file.
    let stream = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx)).scan(Some(s.clone()), move |st, m| {
        let item = match m {
            Msg::Data(b) => Some(Ok::<_, std::io::Error>(b)),
            Msg::Done => {
                if let Some(s) = st.take() {
                    tokio::spawn(async move {
                        let r = s
                            .db
                            .call(move |c| {
                                c.execute("UPDATE projects SET last_backup_at=?1 WHERE id=?2", params![now, id])?;
                                Ok(())
                            })
                            .await;
                        if let Err(e) = r {
                            tracing::warn!("recording backup time of project {id}: {}", e.message);
                        }
                    });
                }
                None
            }
        };
        std::future::ready(item)
    });
    let mut r = Response::new(Body::from_stream(stream));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/gzip"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{fname}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(r)
}

// ------------------------------------------------------------------------------------------------ import

struct TempFile(std::path::PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::invalid("invalid_backup", msg)
}

/// Archive reader over the saved upload: gzip (detected by magic bytes) or a plain tar.
fn open_archive(path: &std::path::Path) -> ApiResult<tar::Archive<Box<dyn Read>>> {
    let mut f = std::fs::File::open(path)?;
    let mut magic = [0u8; 2];
    let n = f.read(&mut magic)?;
    drop(f);
    let f = BufReader::with_capacity(1 << 20, std::fs::File::open(path)?);
    let r: Box<dyn Read> = if n == 2 && magic == [0x1f, 0x8b] { Box::new(flate2::bufread::MultiGzDecoder::new(f)) } else { Box::new(f) };
    Ok(tar::Archive::new(r))
}

fn entry_path<R: Read>(e: &tar::Entry<R>) -> Option<String> {
    let p = e.path().ok()?;
    let s = p.to_str()?.replace('\\', "/");
    Some(s.trim_start_matches("./").to_string())
}

/// Join a path relative to `dir`, rejecting anything that escapes it.
fn join_rel(dir: &str, rel: &str) -> Option<String> {
    if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|c| c == ".." || c.is_empty() || c == ".") {
        return None;
    }
    Some(if dir.is_empty() { rel.to_string() } else { format!("{dir}/{rel}") })
}

fn dirname(p: &str) -> &str {
    p.rfind('/').map_or("", |i| &p[..i])
}

fn read_json<R: Read>(e: &mut tar::Entry<R>, path: &str) -> ApiResult<Value> {
    if e.header().size().unwrap_or(0) > 256 << 20 {
        return Err(bad(format!("{path} is too large")));
    }
    let mut b = Vec::new();
    e.read_to_end(&mut b).map_err(|err| bad(format!("reading {path}: {err}")))?;
    serde_json::from_slice(&b).map_err(|err| bad(format!("{path} is not valid JSON: {err}")))
}

struct ImpMetric {
    key: String,
    files: Vec<String>,
}

struct ImpExp {
    name: String,
    status: String,
    config: String,
    tags: String,
    notes: String,
    host: Option<String>,
    created_at: i64,
    updated_at: i64,
    metrics: Vec<ImpMetric>,
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn parse_exp(v: &Value, path: &str, now: i64) -> ApiResult<ImpExp> {
    let name = str_field(v, "name").ok_or_else(|| bad(format!("{path}: missing \"name\"")))?.to_string();
    if !valid_experiment_name(&name) {
        return Err(bad(format!("{path}: invalid experiment name {name:?}")));
    }
    let status = str_field(v, "status").filter(|s| valid_status(s)).unwrap_or("finished").to_string();
    let config = match v.get("config") {
        Some(c @ Value::Object(_)) => c.to_string(),
        _ => "{}".into(),
    };
    let tags = match v.get("tags") {
        Some(Value::Array(a)) => Value::Array(a.iter().filter(|t| t.is_string()).cloned().collect()).to_string(),
        _ => "[]".into(),
    };
    let created_at = str_field(v, "created_at").and_then(parse_rfc3339).unwrap_or(now);
    let updated_at = str_field(v, "updated_at").and_then(parse_rfc3339).unwrap_or(created_at);
    let dir = dirname(path);
    let mut metrics = Vec::new();
    let mut keys = HashSet::new();
    for m in v.get("metrics").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let key = str_field(m, "key").ok_or_else(|| bad(format!("{path}: metric without \"key\"")))?.to_string();
        if !valid_metric_key(&key) {
            return Err(bad(format!("{path}: invalid metric key {key:?}")));
        }
        if !keys.insert(key.clone()) {
            return Err(bad(format!("{path}: metric {key:?} listed twice")));
        }
        let mut files = Vec::new();
        for f in m.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            let rel = f.as_str().ok_or_else(|| bad(format!("{path}: file names must be strings")))?;
            files.push(join_rel(dir, rel).ok_or_else(|| bad(format!("{path}: bad file path {rel:?}")))?);
        }
        metrics.push(ImpMetric { key, files });
    }
    Ok(ImpExp {
        name,
        status,
        config,
        tags,
        notes: str_field(v, "notes").unwrap_or("").to_string(),
        host: str_field(v, "host").map(str::to_string),
        created_at,
        updated_at,
        metrics,
    })
}

/// Parse one CSV value: decimal, NaN, ±Infinity/inf (any case), or empty (= NaN).
fn parse_val(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(f64::NAN);
    }
    t.parse::<f64>().ok()
}

/// Read one metric CSV file into the batch, flushing full batches to the store.
fn read_csv<R: Read>(
    r: R,
    path: &str,
    sid: i64,
    batch: &mut Vec<Row>,
    flush: &mut dyn FnMut(&mut Vec<Row>) -> ApiResult<()>,
) -> ApiResult<u64> {
    let mut rd = BufReader::with_capacity(1 << 20, r);
    let mut line = String::new();
    let mut lineno = 0u64;
    let mut cols: Option<(usize, usize, usize)> = None;
    let mut n = 0u64;
    loop {
        line.clear();
        let got = rd.read_line(&mut line).map_err(|e| bad(format!("{path}: {e}")))?;
        if got == 0 {
            break;
        }
        lineno += 1;
        let l = line.trim_end_matches(['\n', '\r']);
        let l = if lineno == 1 { l.trim_start_matches('\u{feff}') } else { l };
        if l.is_empty() {
            continue;
        }
        let Some((si, vi, ti)) = cols else {
            let hdr: Vec<&str> = l.split(',').map(str::trim).collect();
            let pos = |k: &str| hdr.iter().position(|h| h.eq_ignore_ascii_case(k));
            match (pos("step"), pos("value"), pos("ts")) {
                (Some(a), Some(b), Some(c)) => cols = Some((a, b, c)),
                _ => return Err(bad(format!("{path}: header must name the columns step, value, ts"))),
            }
            continue;
        };
        let f: Vec<&str> = l.split(',').collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("");
        let err = || bad(format!("{path}:{lineno}: cannot read {l:?}"));
        let step: i64 = match get(si).trim().parse::<i64>() {
            Ok(v) => v,
            // tolerate "12.0"
            Err(_) => match get(si).trim().parse::<f64>() {
                Ok(v) if v.fract() == 0.0 && v.abs() < 9.0e18 => v as i64,
                _ => return Err(err()),
            },
        };
        let value = parse_val(get(vi)).ok_or_else(err)?;
        let ts = parse_val(get(ti)).filter(|t| t.is_finite()).ok_or_else(err)?;
        batch.push(Row { sid, step, value, ts });
        n += 1;
        if batch.len() >= IMPORT_BATCH {
            flush(batch)?;
        }
    }
    if cols.is_none() && n == 0 && lineno > 0 {
        return Err(bad(format!("{path}: no header")));
    }
    Ok(n)
}

/// Project name for the import: the requested/original name, or `<name>-restored[-N]` if taken.
fn free_name(c: &rusqlite::Connection, uid: i64, wanted: &str) -> ApiResult<String> {
    let mut base: String = wanted.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')).take(52).collect();
    if base.is_empty() {
        base = "restored".into();
    }
    let taken = |n: &str| -> ApiResult<bool> {
        Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE owner_id=?1 AND name=?2)", params![uid, n], |r| r.get(0))?)
    };
    if valid_project_name(wanted) && !taken(wanted)? {
        return Ok(wanted.to_string());
    }
    for i in 1..10_000 {
        let n = if i == 1 { format!("{base}-restored") } else { format!("{base}-restored-{i}") };
        if !taken(&n)? {
            return Ok(n);
        }
    }
    Err(ApiError::conflict("project_exists", "could not find a free project name"))
}

struct ImportResult {
    project_id: i64,
    experiments: usize,
    metrics: usize,
    points: u64,
}

fn import_file(
    s: &Arc<AppState>,
    p: &Principal,
    path: &std::path::Path,
    name: Option<String>,
    rt: &tokio::runtime::Handle,
    created: &mut Option<i64>,
) -> ApiResult<ImportResult> {
    let now = now_ms();
    // ---- pass 1: manifest + experiment descriptions (file order inside the archive does not matter)
    let mut manifest: Option<(String, Value)> = None;
    let mut exp_docs: Vec<(String, Value)> = Vec::new();
    let mut ar = open_archive(path)?;
    for e in ar.entries().map_err(|e| bad(format!("this file is not a .tar.gz backup ({e})")))? {
        let mut e = e.map_err(|e| bad(format!("this file is not a valid .tar.gz backup, or it is damaged or incomplete ({e})")))?;
        if !e.header().entry_type().is_file() {
            continue;
        }
        let Some(ep) = entry_path(&e) else { continue };
        match ep.rsplit('/').next() {
            Some("manifest.json") => {
                if manifest.is_some() {
                    return Err(bad("more than one manifest.json (one backup file holds one project)"));
                }
                manifest = Some((ep.clone(), read_json(&mut e, &ep)?));
            }
            Some("experiment.json") => {
                let v = read_json(&mut e, &ep)?;
                exp_docs.push((ep, v));
            }
            _ => {}
        }
    }
    let Some((mpath, m)) = manifest else { return Err(bad("no manifest.json: this is not a Kymo backup")) };
    if str_field(&m, "format") != Some(FORMAT) {
        return Err(bad(format!("manifest.json: \"format\" is not \"{FORMAT}\"")));
    }
    let ver = m.get("format_version").and_then(Value::as_i64).unwrap_or(0);
    if !(1..=FORMAT_VERSION).contains(&ver) {
        return Err(bad(format!("backup format version {ver} is not supported (this server reads 1..={FORMAT_VERSION})")));
    }
    let root = dirname(&mpath).to_string();
    let exp_prefix = if root.is_empty() { "experiments/".to_string() } else { format!("{root}/experiments/") };
    let proj = m.get("project").cloned().unwrap_or(json!({}));
    let mut exps = Vec::new();
    let mut names = HashSet::new();
    exp_docs.sort_by(|a, b| a.0.cmp(&b.0));
    for (ep, v) in &exp_docs {
        if !ep.starts_with(&exp_prefix) {
            continue;
        }
        let x = parse_exp(v, ep, now)?;
        if !names.insert(x.name.clone()) {
            return Err(bad(format!("experiment name {:?} appears twice", x.name)));
        }
        exps.push(x);
    }
    // file path -> (experiment index, metric index, part index)
    let mut file_map: HashMap<String, (usize, usize)> = HashMap::new();
    for (ei, x) in exps.iter().enumerate() {
        for (mi, mt) in x.metrics.iter().enumerate() {
            for f in &mt.files {
                if file_map.insert(f.clone(), (ei, mi)).is_some() {
                    return Err(bad(format!("{f} is listed for more than one metric")));
                }
            }
        }
    }

    // ---- create the project and its experiments
    let uid = p.user.id;
    let wanted = name.or_else(|| str_field(&proj, "name").map(str::to_string)).unwrap_or_else(|| "restored".into());
    let desc: String = str_field(&proj, "description").unwrap_or("").chars().take(4096).collect();
    let pcreated = str_field(&proj, "created_at").and_then(parse_rfc3339).unwrap_or(now);
    let (pid, exp_ids) = s.db.with(|c| {
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let pname = free_name(&tx, uid, &wanted)?;
        tx.execute(
            "INSERT INTO projects(owner_id, name, description, created_at) VALUES(?1,?2,?3,?4)",
            params![uid, pname, desc, pcreated],
        )?;
        let pid = tx.last_insert_rowid();
        let mut ids = Vec::with_capacity(exps.len());
        {
            let mut ins = tx.prepare(
                "INSERT INTO experiments(project_id, name, status, config, tags, notes, host, created_at, updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            )?;
            for x in &exps {
                ins.execute(params![pid, x.name, x.status, x.config, x.tags, x.notes, x.host, x.created_at, x.updated_at])?;
                ids.push(tx.last_insert_rowid());
            }
        }
        tx.commit()?;
        Ok((pid, ids))
    })?;
    *created = Some(pid);
    let mut sids: Vec<Vec<i64>> = Vec::with_capacity(exps.len());
    for (x, &eid) in exps.iter().zip(&exp_ids) {
        let keys: Vec<&str> = x.metrics.iter().map(|m| m.key.as_str()).collect();
        if !keys.is_empty() {
            s.store.create_series(eid, &keys)?;
        }
        let ek = s.store.exp_keys(eid)?;
        let map = ek.map.read();
        sids.push(keys.iter().map(|k| map.get(*k).copied().unwrap_or(0)).collect());
    }

    // ---- pass 2: points
    let mut seen: HashSet<String> = HashSet::new();
    let mut points = 0u64;
    let mut batch: Vec<Row> = Vec::with_capacity(IMPORT_BATCH);
    let mut batch_exp: Option<i64> = None;
    let mut ar = open_archive(path)?;
    for e in ar.entries().map_err(|e| bad(format!("this file is not a .tar.gz backup ({e})")))? {
        let e = e.map_err(|e| bad(format!("this file is not a valid .tar.gz backup, or it is damaged or incomplete ({e})")))?;
        if !e.header().entry_type().is_file() {
            continue;
        }
        let Some(ep) = entry_path(&e) else { continue };
        let Some(&(ei, mi)) = file_map.get(&ep) else { continue };
        if !seen.insert(ep.clone()) {
            return Err(bad(format!("{ep} appears twice in the archive")));
        }
        let eid = exp_ids[ei];
        let mut flush = |b: &mut Vec<Row>| -> ApiResult<()> {
            if b.is_empty() {
                return Ok(());
            }
            let mut rows = std::mem::replace(b, Vec::with_capacity(IMPORT_BATCH));
            prepare_rows(&mut rows);
            rt.block_on(s.store.write(eid, rows, None, None))
        };
        if batch_exp != Some(eid) {
            if let Some(prev) = batch_exp {
                let mut rows = std::mem::replace(&mut batch, Vec::with_capacity(IMPORT_BATCH));
                if !rows.is_empty() {
                    prepare_rows(&mut rows);
                    rt.block_on(s.store.write(prev, rows, None, None))?;
                }
            }
            batch_exp = Some(eid);
        }
        points += read_csv(e, &ep, sids[ei][mi], &mut batch, &mut flush)?;
    }
    if let Some(eid) = batch_exp {
        if !batch.is_empty() {
            prepare_rows(&mut batch);
            rt.block_on(s.store.write(eid, std::mem::take(&mut batch), None, None))?;
        }
    }
    if let Some(missing) = file_map.keys().find(|f| !seen.contains(*f)) {
        return Err(bad(format!("{missing} is listed in experiment.json but missing from the archive")));
    }
    Ok(ImportResult { project_id: pid, experiments: exps.len(), metrics: sids.iter().map(Vec::len).sum(), points })
}

async fn delete_project(s: &Arc<AppState>, pid: i64) {
    let r = s
        .db
        .call(move |c| {
            let series = super::projects::series_of(c, "SELECT id FROM experiments WHERE project_id=?1", pid)?;
            c.execute("DELETE FROM projects WHERE id=?1", [pid])?;
            Ok(series)
        })
        .await;
    s.invalidate_names();
    match r {
        Ok(series) => {
            let _ = s.store.delete_experiments(series).await;
        }
        Err(e) => tracing::warn!("cleaning up failed import (project {pid}): {}", e.message),
    }
}

#[derive(Deserialize)]
pub struct ImportQuery {
    /// Project name to use instead of the one in the backup.
    name: Option<String>,
}

/// `POST /projects/import` — body: a backup file (any content type). Creates a new project owned by the
/// caller (never merges into an existing one); `?name=` overrides the name, a taken name gets `-restored`.
pub async fn import(
    State(s): S,
    FullSession(p): FullSession,
    Query(q): Query<ImportQuery>,
    body: Body,
) -> ApiResult<Json<Value>> {
    if let Some(n) = &q.name {
        if !valid_project_name(n) {
            return Err(ApiError::invalid("invalid_name", "project name must match [A-Za-z0-9_.-]{1,64}"));
        }
    }
    let dir = s.cfg.data_dir.join("tmp");
    tokio::fs::create_dir_all(&dir).await?;
    let tmp = TempFile(dir.join(format!("import-{}.part", random_b62(16))));
    {
        let mut f = tokio::fs::File::create(&tmp.0).await?;
        let mut stream = body.into_data_stream();
        let mut size = 0usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| ApiError::bad_request(format!("upload interrupted: {e}")))?;
            size += chunk.len();
            f.write_all(&chunk).await?;
        }
        f.flush().await?;
        if size == 0 {
            return Err(bad("empty upload"));
        }
    }
    let rt = tokio::runtime::Handle::current();
    let s2 = s.clone();
    let p2 = p.clone();
    let (res, created) = tokio::task::spawn_blocking(move || {
        let mut created = None;
        let r = import_file(&s2, &p2, &tmp.0, q.name, &rt, &mut created);
        drop(tmp);
        (r, created)
    })
    .await
    .map_err(ApiError::from)?;
    let r = match res {
        Ok(r) => r,
        Err(e) => {
            if let Some(pid) = created {
                delete_project(&s, pid).await;
            }
            return Err(e);
        }
    };
    let uid = p.user.id;
    let pid = r.project_id;
    let pr = s
        .db
        .call(move |c| load_project(c, pid, uid)?.ok_or_else(|| ApiError::internal("imported project vanished")))
        .await?;
    tracing::info!("imported project {} ({}): {} experiments, {} metrics, {} points", pid, pr.name, r.experiments, r.metrics, r.points);
    Ok(Json(json!({
        "project": project_json(&pr, Role::Owner),
        "experiments": r.experiments,
        "metrics": r.metrics,
        "points": r.points,
    })))
}
