//! Project backup: export format, round-trip import, robustness, access control.
mod common;
use common::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;

fn gunzip(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::MultiGzDecoder::new(b).read_to_end(&mut out).unwrap();
    out
}

/// (path, contents) of every file in a tar.
fn untar(t: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut ar = tar::Archive::new(t);
    let mut out = Vec::new();
    for e in ar.entries().unwrap() {
        let mut e = e.unwrap();
        let p = e.path().unwrap().to_str().unwrap().to_string();
        let mut b = Vec::new();
        e.read_to_end(&mut b).unwrap();
        out.push((p, b));
    }
    out
}

fn retar(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    for (p, d) in files {
        let mut h = tar::Header::new_gnu();
        h.set_size(d.len() as u64);
        h.set_mode(0o644);
        b.append_data(&mut h, p, d.as_slice()).unwrap();
    }
    b.into_inner().unwrap()
}

async fn raw(c: &mut Client, exp: i64, key: &str) -> Value {
    let (s, v) = c.get(&format!("/api/v1/series/raw?experiment_id={exp}&key={}", urlenc(key))).await;
    assert_eq!(s, 200, "{v}");
    v["points"].clone()
}

fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

async fn experiments(c: &mut Client, pid: i64) -> HashMap<String, Value> {
    let (s, v) = c.get(&format!("/api/v1/projects/{pid}/experiments")).await;
    assert_eq!(s, 200, "{v}");
    v.as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().to_string(), e.clone())).collect()
}

async fn keys(c: &mut Client, exp: i64) -> Vec<String> {
    let (_, m) = c.get(&format!("/api/v1/experiments/{exp}/metrics")).await;
    let mut k: Vec<String> = m.as_array().unwrap().iter().map(|x| x["key"].as_str().unwrap().to_string()).collect();
    k.sort();
    k
}

/// Every experiment, its metadata and every point must match exactly.
async fn assert_same_project(c: &mut Client, a: i64, b: i64) {
    let ea = experiments(c, a).await;
    let eb = experiments(c, b).await;
    assert_eq!(ea.len(), eb.len());
    for (name, x) in &ea {
        let y = &eb[name];
        for f in ["status", "config", "tags", "notes", "host", "created_at", "updated_at", "metric_count", "last_step"] {
            assert_eq!(x[f], y[f], "{name}.{f}");
        }
        let (xi, yi) = (x["id"].as_i64().unwrap(), y["id"].as_i64().unwrap());
        let ka = keys(c, xi).await;
        assert_eq!(ka, keys(c, yi).await);
        for k in &ka {
            assert_eq!(raw(c, xi, k).await, raw(c, yi, k).await, "{name} {k}");
        }
    }
}

async fn project_names(c: &mut Client) -> Vec<String> {
    let (_, v) = c.get("/api/v1/projects").await;
    v.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn backup_roundtrip() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut alice = h.user(&mut admin, "alice").await;
    let mut bob = h.user(&mut admin, "bob").await;
    let mut tok = alice.token().await;

    // a long metric (2 CSV parts), awkward values, a second experiment with metadata
    for chunk in 0..3i64 {
        let pts: Vec<Value> = (chunk * 200_000..(chunk + 1) * 200_000)
            .map(|s| json!({"step": s, "ts": 1_700_000_000.0 + s as f64 * 0.125, "metrics": {"train/loss": 1.0 / (s as f64 + 1.0)}}))
            .collect();
        let (s, v) = tok.ingest(json!({"project": "p", "experiment": "long", "points": pts})).await;
        assert_eq!(s, 200, "{v}");
    }
    let (s, v) = tok
        .ingest(json!({"project": "p", "experiment": "odd ✓ name", "config": {"lr": 3e-4, "nested": {"a": [1, 2]}},
            "status": "finished", "host": "gpu-1", "points": [
            {"step": -5, "ts": 0.5, "metrics": {"x": 0.1, "eval/acc": "nan"}},
            {"step": 0, "ts": 1.0, "metrics": {"x": 1e-300, "eval/acc": "inf"}},
            {"step": 7, "ts": 2.25, "metrics": {"x": -1.7976931348623157e308, "eval/acc": "-inf", "weird, key \"q\"": 3.0}},
            {"step": 9_007_199_254_740_993i64, "ts": 3.0, "metrics": {"x": 0.30000000000000004}}]}))
        .await;
    assert_eq!(s, 200, "{v}");
    let odd = v["experiment_id"].as_i64().unwrap();
    let (s, _) = alice.patch(&format!("/api/v1/experiments/{odd}"), json!({"notes": "line1\nline2 ü", "tags": ["a", "b c"]})).await;
    assert_eq!(s, 200);
    let (_, ps) = alice.get("/api/v1/projects").await;
    let pid = ps[0]["id"].as_i64().unwrap();
    assert_eq!(ps[0]["last_backup_at"], Value::Null);

    // outsiders cannot export
    let (s, _, _) = bob.get_bytes(&format!("/api/v1/projects/{pid}/backup"), HeaderMap::new()).await;
    assert_eq!(s, 404);

    // export (token allowed); never compressed twice even when the client accepts gzip
    let mut hm = HeaderMap::new();
    hm.insert("accept-encoding", HeaderValue::from_static("gzip"));
    let (s, file, hd) = tok.get_bytes(&format!("/api/v1/projects/{pid}/backup"), hm).await;
    assert_eq!(s, 200);
    assert_eq!(hd["content-type"], "application/gzip");
    assert!(hd.get("content-encoding").is_none());
    assert!(hd["content-disposition"].to_str().unwrap().contains(".kymo.tar.gz"));
    let files = untar(&gunzip(&file));
    let get = |suffix: &str| files.iter().find(|(p, _)| p.ends_with(suffix)).map(|(_, d)| d.clone());
    let readme = String::from_utf8(get("/README.txt").unwrap()).unwrap();
    assert!(readme.contains("FORMAT VERSION 1"));
    let manifest: Value = serde_json::from_slice(&get("/manifest.json").unwrap()).unwrap();
    assert_eq!(manifest["format"], "kymo-project-backup");
    assert_eq!(manifest["format_version"], 1);
    assert_eq!(manifest["project"]["name"], "p");
    assert_eq!(manifest["project"]["owner"], "alice");
    assert_eq!(manifest["experiment_count"], 2);
    assert_eq!(manifest["point_count"], 600_000 + 4 + 3 + 1);
    let long: Value = serde_json::from_slice(&get("/experiments/000001/experiment.json").unwrap()).unwrap();
    assert_eq!(long["name"], "long");
    assert_eq!(long["metrics"][0]["files"].as_array().unwrap().len(), 2);
    let csv = String::from_utf8(get("/experiments/000002/metrics/000001-0000.csv").unwrap()).unwrap();
    assert_eq!(csv, "step,value,ts\n-5,NaN,0.5\n0,Infinity,1.0\n7,-Infinity,2.25\n");

    // the completed download is recorded
    let mut ok = false;
    for _ in 0..50 {
        let (_, p) = alice.get(&format!("/api/v1/projects/{pid}")).await;
        if p["last_backup_at"].is_string() {
            ok = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(ok, "last_backup_at not set");

    // import: tokens may not; a session may, and a taken name gets -restored
    let (s, v) = tok.post_bytes("/api/v1/projects/import", file.clone()).await;
    assert_eq!((s, v["code"].as_str()), (403, Some("token_not_allowed")));
    let (s, v) = alice.post_bytes("/api/v1/projects/import", file.clone()).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["project"]["name"], "p-restored");
    assert_eq!((v["experiments"].as_i64(), v["points"].as_i64()), (Some(2), Some(600_008)));
    let pid2 = v["project"]["id"].as_i64().unwrap();
    assert_same_project(&mut alice, pid, pid2).await;

    // a hand-repacked archive: plain tar, different top dir, files in reverse order (metrics before
    // their experiment.json, manifest first) still imports identically
    let mut rev: Vec<(String, Vec<u8>)> =
        files.iter().map(|(p, d)| (format!("restored/{}", p.split_once('/').unwrap().1), d.clone())).collect();
    rev.reverse();
    let (s, v) = alice.post_bytes("/api/v1/projects/import?name=p2", retar(&rev)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["project"]["name"], "p2");
    assert_same_project(&mut alice, pid, v["project"]["id"].as_i64().unwrap()).await;

    // another user imports it as their own project
    let (s, v) = bob.post_bytes("/api/v1/projects/import", file.clone()).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["project"]["name"], "p");
    assert_eq!(v["project"]["owner"]["username"], "bob");

    // broken uploads leave nothing behind
    let before = project_names(&mut alice).await;
    let (s, v) = alice.post_bytes("/api/v1/projects/import", b"definitely not a backup".to_vec()).await;
    assert_eq!((s, v["code"].as_str()), (400, Some("invalid_backup")), "{v}");
    let missing: Vec<(String, Vec<u8>)> = files.iter().filter(|(p, _)| !p.ends_with("000001-0001.csv")).cloned().collect();
    let (s, v) = alice.post_bytes("/api/v1/projects/import", retar(&missing)).await;
    assert_eq!((s, v["code"].as_str()), (400, Some("invalid_backup")), "{v}");
    assert!(v["error"].as_str().unwrap().contains("missing"), "{v}");
    assert_eq!(project_names(&mut alice).await, before);

    h.stop().await;
}
