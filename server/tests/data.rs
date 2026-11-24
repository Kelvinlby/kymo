mod common;
use common::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};

fn pts(steps: std::ops::Range<i64>, f: impl Fn(i64) -> Value) -> Value {
    Value::Array(steps.map(|s| json!({"step": s, "ts": 1000.0 + s as f64, "metrics": {"m": f(s)}})).collect())
}

async fn query(c: &mut Client, exp: &Value, key: &str, extra: Value) -> Value {
    let mut body = json!({"series": [{"experiment_id": exp, "key": key}]});
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    let (s, v) = c.post("/api/v1/series/query", body).await;
    assert_eq!(s, 200, "{v}");
    v["series"][0].clone()
}

#[tokio::test]
async fn ingest_upsert_idempotent_and_encodings() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut u = h.user(&mut admin, "alice").await;
    let mut t = u.token().await;
    let body = json!({"project": "p", "experiment": "e", "client_id": "c", "seq": 1, "points": pts(0..10, |s| json!(s as f64))});
    let (s, v) = t.ingest(body.clone()).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!((v["accepted"].as_i64(), v["dropped"].as_i64()), (Some(10), Some(0)));
    let exp = v["experiment_id"].clone();
    // exact replay (client retry) is a no-op
    let (s, _) = t.ingest(body).await;
    assert_eq!(s, 200);
    // same step twice in one request, then again in another request: last wins
    let (s, _) = t
        .ingest(json!({"project": "p", "experiment": "e", "points": [
            {"step": 5, "metrics": {"m": 50.0}}, {"step": 5, "metrics": {"m": 55.0}}]}))
        .await;
    assert_eq!(s, 200);
    let q = query(&mut t, &exp, "m", json!({})).await;
    assert_eq!(q["total"], 10);
    assert_eq!(q["downsampled"], false);
    assert_eq!(q["value"][5], 55.0);
    assert!(q.get("min").is_none());
    let (s, _) = t.ingest(json!({"project": "p", "experiment": "e", "points": [{"step": 5, "ts": 1.0, "metrics": {"m": -3.0}}]})).await;
    assert_eq!(s, 200);
    let q = query(&mut t, &exp, "m", json!({})).await;
    assert_eq!(q["value"][5], -3.0);
    assert_eq!(q["ts"][5], 1.0);
    let (_, m) = t.get(&format!("/api/v1/experiments/{exp}/metrics")).await;
    assert_eq!(m[0]["count"], 10);
    assert_eq!(m[0]["min"], -3.0);
    assert_eq!(m[0]["max"], 9.0);
    assert_eq!(m[0]["last_step"], 9);
    assert_eq!(m[0]["last_value"], 9.0);
    // out-of-order insert before the first step
    t.ingest(json!({"project": "p", "experiment": "e", "points": [{"step": -1, "metrics": {"m": 100.0}}]})).await;
    let (_, m) = t.get(&format!("/api/v1/experiments/{exp}/metrics")).await;
    assert_eq!((m[0]["count"].as_i64(), m[0]["first_step"].as_i64(), m[0]["max"].as_f64()), (Some(11), Some(-1), Some(100.0)));

    // gzip + zstd bodies
    let raw = json!({"project": "p", "experiment": "e", "points": pts(10..20, |s| json!(s))}).to_string();
    use std::io::Write;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(raw.as_bytes()).unwrap();
    let mut hm = HeaderMap::new();
    hm.insert("content-encoding", HeaderValue::from_static("gzip"));
    let (s, v) = t.send(reqwest::Method::POST, "/api/v1/ingest", Some(gz.finish().unwrap()), hm).await;
    assert_eq!(s, 200, "{v}");
    let raw = json!({"project": "p", "experiment": "e", "points": pts(20..30, |s| json!(s))}).to_string();
    let mut hm = HeaderMap::new();
    hm.insert("content-encoding", HeaderValue::from_static("zstd"));
    let (s, v) = t.send(reqwest::Method::POST, "/api/v1/ingest", Some(zstd::encode_all(raw.as_bytes(), 3).unwrap()), hm).await;
    assert_eq!(s, 200, "{v}");
    let mut hm = HeaderMap::new();
    hm.insert("content-encoding", HeaderValue::from_static("gzip"));
    let (s, _) = t.send(reqwest::Method::POST, "/api/v1/ingest", Some(b"not gzip".to_vec()), hm).await;
    assert_eq!(s, 400);
    let (s, v) = t.send(reqwest::Method::POST, "/api/v1/ingest", Some(b"{\"project\":".to_vec()), HeaderMap::new()).await;
    assert_eq!((s, v["code"].as_str()), (400, Some("malformed")));
    let q = query(&mut t, &exp, "m", json!({})).await;
    assert_eq!(q["total"], 31);

    // raw export
    let (s, v) = t.get(&format!("/api/v1/series/raw?experiment_id={exp}&key=m&format=json")).await;
    assert_eq!(s, 200);
    assert_eq!(v["points"].as_array().unwrap().len(), 31);
    assert_eq!(v["points"][0], json!([-1, 100.0, v["points"][0][2]]));
    let (s, v) = t.get(&format!("/api/v1/series/raw?experiment_id={exp}&key=m&format=csv")).await;
    assert_eq!(s, 200);
    let csv = v.as_str().unwrap();
    assert!(csv.starts_with("step,value,ts\n-1,100.0,"));
    assert_eq!(csv.lines().count(), 32);

    // survives a restart (summaries + points persisted, writer queues drained)
    let dir = h.dir.path().to_path_buf();
    let tok = t.bearer.clone();
    let Harness { server, dir: tmp, .. } = h;
    server.unwrap().shutdown().await;
    let s2 = kymo_server::start(kymo_server::config::Config::for_dir(&dir)).await.unwrap();
    let mut t = Client { base: s2.base_url(), http: reqwest::Client::new(), cookie: None, bearer: tok, csrf: false };
    let q = query(&mut t, &exp, "m", json!({})).await;
    assert_eq!(q["total"], 31);
    let (_, m) = t.get(&format!("/api/v1/experiments/{exp}/metrics")).await;
    assert_eq!(m[0]["count"], 31);
    s2.shutdown().await;
    drop(tmp);
}

#[tokio::test]
async fn nan_and_value_handling() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut t = admin.token().await;
    let (s, v) = t
        .ingest(json!({"project": "p", "experiment": "e", "points": [
            {"step": 0, "metrics": {"a": 1.5, "b": true, "c": "NaN", "d": "Infinity", "e": "-Infinity", "f": "bad", "g": null, "h": [1], "": 1}},
            {"step": 1, "metrics": {"a": "NaN", "c": 2}},
            {"step": 2, "metrics": {"a": 2.5}}]}))
        .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["accepted"], 8);
    assert_eq!(v["dropped"], 4);
    let exp = v["experiment_id"].clone();
    let q = query(&mut t, &exp, "a", json!({})).await;
    assert_eq!(q["value"], json!([1.5, null, 2.5]));
    let q = query(&mut t, &exp, "d", json!({})).await;
    assert_eq!(q["value"], json!([null]));
    let q = query(&mut t, &exp, "b", json!({})).await;
    assert_eq!(q["value"], json!([1.0]));
    let (_, m) = t.get(&format!("/api/v1/experiments/{exp}/metrics")).await;
    let keys: Vec<_> = m.as_array().unwrap().iter().map(|x| x["key"].as_str().unwrap().to_string()).collect();
    assert_eq!(keys, vec!["a", "b", "c", "d", "e"]);
    assert_eq!((m[0]["min"].as_f64(), m[0]["max"].as_f64(), m[0]["count"].as_i64()), (Some(1.5), Some(2.5), Some(3)));
    assert!(m[3]["min"].is_null() && m[3]["max"].is_null() && m[3]["last_value"].is_null());
    // replaying a NaN for a NaN is not a change; replacing NaN by a number is
    t.ingest(json!({"project": "p", "experiment": "e", "points": [{"step": 1, "metrics": {"a": "NaN"}}]})).await;
    t.ingest(json!({"project": "p", "experiment": "e", "points": [{"step": 1, "metrics": {"a": -7}}]})).await;
    let (_, m) = t.get(&format!("/api/v1/experiments/{exp}/metrics")).await;
    assert_eq!(m[0]["min"], -7.0);
    // NaN-only buckets come back as null, other buckets ignore NaN
    let mut p = vec![];
    for s in 0..1000 {
        let v = if s < 100 { json!("NaN") } else if s % 2 == 0 { json!("Infinity") } else { json!(1.0) };
        p.push(json!({"step": s, "metrics": {"z": v}}));
    }
    t.ingest(json!({"project": "p", "experiment": "e", "points": p})).await;
    let q = query(&mut t, &exp, "z", json!({"max_points": 10})).await;
    assert_eq!(q["downsampled"], true);
    assert!(q["value"][0].is_null() && q["min"][0].is_null());
    assert_eq!(q["value"][5], 1.0);
    assert_eq!(q["max"][5], 1.0);
    h.stop().await;
}

#[tokio::test]
async fn downsampling_preserves_spikes() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut t = admin.token().await;
    let n = 100_000i64;
    let mut exp = Value::Null;
    for chunk in 0..10 {
        let p = pts(chunk * 10_000..(chunk + 1) * 10_000, |s| {
            json!(if s == 77_777 { 1e6 } else if s == 12_345 { -1e6 } else { (s % 10) as f64 })
        });
        let (s, v) = t.ingest(json!({"project": "p", "experiment": "e", "points": p})).await;
        assert_eq!(s, 200);
        exp = v["experiment_id"].clone();
    }
    let q = query(&mut t, &exp, "m", json!({"max_points": 500})).await;
    assert_eq!(q["downsampled"], true);
    assert_eq!(q["total"], n);
    let steps = q["step"].as_array().unwrap();
    assert_eq!(steps.len(), 500);
    assert_eq!(steps[0], 0);
    assert_eq!(steps[1], 200);
    let max: Vec<f64> = q["max"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let min: Vec<f64> = q["min"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert_eq!(max.iter().cloned().fold(f64::MIN, f64::max), 1e6);
    assert_eq!(min.iter().cloned().fold(f64::MAX, f64::min), -1e6);
    assert_eq!(max[77_777 / 200], 1e6);
    assert_eq!(q["value"][1], 4.5);
    assert_eq!(q["ts"][0], 1000.0 + 199.0);
    // zoom window, inclusive bounds, raw when small enough
    let q = query(&mut t, &exp, "m", json!({"step_min": 77_700, "step_max": 77_799})).await;
    assert_eq!(q["downsampled"], false);
    assert_eq!(q["total"], 100);
    assert_eq!(q["step"][0], 77_700);
    assert_eq!(q["step"][99], 77_799);
    // multiple series, unknown keys are empty
    let (s, v) = t
        .post("/api/v1/series/query", json!({"series": [{"experiment_id": exp, "key": "m"}, {"experiment_id": exp, "key": "nope"}], "max_points": 100000}))
        .await;
    assert_eq!(s, 200);
    assert_eq!(v["series"][0]["step"].as_array().unwrap().len(), 20_000, "max_points clamps to 20000");
    assert_eq!(v["series"][1]["total"], 0);
    h.stop().await;
}

#[tokio::test]
async fn empty_points_init_and_status() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut u = h.user(&mut admin, "alice").await;
    let mut t = u.token().await;
    let (s, v) = t
        .ingest(json!({"project": "llm", "experiment": "run1", "status": "running", "host": "node-1",
                       "config": {"lr": 0.1, "model": {"d": 8}}, "points": []}))
        .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!((v["accepted"].as_i64(), v["dropped"].as_i64()), (Some(0), Some(0)));
    let exp = v["experiment_id"].clone();
    let (s, v2) = t.ingest(json!({"project": "llm", "experiment": "run1", "config": {"bs": 32, "lr": 0.2}})).await;
    assert_eq!(s, 200, "points may be missing entirely");
    assert_eq!(v2["experiment_id"], exp);
    let (_, e) = t.get(&format!("/api/v1/experiments/{exp}")).await;
    assert_eq!(e["status"], "running");
    assert_eq!(e["host"], "node-1");
    assert_eq!(e["config"], json!({"lr": 0.2, "model": {"d": 8}, "bs": 32}));
    assert_eq!(e["project"]["name"], "llm");
    assert_eq!(e["metric_count"], 0);
    t.ingest(json!({"project": "llm", "experiment": "run1", "status": "finished", "points": []})).await;
    assert_eq!(t.get(&format!("/api/v1/experiments/{exp}")).await.1["status"], "finished");
    t.ingest(json!({"project": "llm", "experiment": "run1", "status": "running"})).await;
    assert_eq!(t.get(&format!("/api/v1/experiments/{exp}")).await.1["status"], "running", "resumed run");
    let (s, v) = t.ingest(json!({"project": "llm", "experiment": "run1", "status": "bogus"})).await;
    assert_eq!(s, 400, "{v}");
    let (s, _) = t.ingest(json!({"project": "bad name!", "experiment": "x"})).await;
    assert_eq!(s, 400);
    h.stop().await;
}

#[tokio::test]
async fn permission_isolation() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut a = h.user(&mut admin, "alice").await;
    let mut b = h.user(&mut admin, "bob").await;
    let mut ta = a.token().await;
    let mut tb = b.token().await;
    let (_, va) = ta.ingest(json!({"project": "shared-name", "experiment": "e", "points": pts(0..5, |s| json!(s))})).await;
    let (_, vb) = tb.ingest(json!({"project": "shared-name", "experiment": "e", "points": pts(0..5, |s| json!(-s))})).await;
    assert_ne!(va["experiment_id"], vb["experiment_id"], "names are per-owner namespaces");
    let ea = va["experiment_id"].clone();

    let (_, la) = a.get("/api/v1/projects").await;
    let (_, lb) = b.get("/api/v1/projects").await;
    assert_eq!(la.as_array().unwrap().len(), 1);
    assert_eq!(lb.as_array().unwrap().len(), 1);
    assert_eq!(la[0]["owner"]["username"], "alice");
    assert_eq!(la[0]["experiment_count"], 1);
    let pa = la[0]["id"].as_i64().unwrap();

    // bob cannot see alice's project / experiment / data
    for path in [
        format!("/api/v1/projects/{pa}"),
        format!("/api/v1/projects/{pa}/experiments"),
        format!("/api/v1/projects/{pa}/metric-keys"),
        format!("/api/v1/experiments/{ea}"),
        format!("/api/v1/experiments/{ea}/metrics"),
        format!("/api/v1/series/raw?experiment_id={ea}&key=m"),
    ] {
        assert_eq!(b.get(&path).await.0, 404, "{path}");
        assert_eq!(tb.get(&path).await.0, 404, "{path}");
    }
    let q = query(&mut tb, &ea, "m", json!({})).await;
    assert_eq!(q["total"], 0);
    assert_eq!(q["step"], json!([]));
    assert_eq!(b.patch(&format!("/api/v1/projects/{pa}"), json!({"shared": true})).await.0, 404);
    assert_eq!(b.delete(&format!("/api/v1/experiments/{ea}")).await.0, 404);

    // shared → read-only for bob
    let (s, v) = a.patch(&format!("/api/v1/projects/{pa}"), json!({"shared": true, "description": "hi"})).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(b.get("/api/v1/projects").await.1.as_array().unwrap().len(), 2);
    assert_eq!(b.get(&format!("/api/v1/projects/{pa}/experiments")).await.0, 200);
    let (_, keys) = tb.get(&format!("/api/v1/projects/{pa}/metric-keys")).await;
    assert_eq!(keys, json!(["m"]));
    let q = query(&mut tb, &ea, "m", json!({})).await;
    assert_eq!(q["total"], 5);
    let (_, e) = b.get(&format!("/api/v1/experiments/{ea}")).await;
    assert_eq!(e["can_edit"], false);
    assert_eq!(b.patch(&format!("/api/v1/projects/{pa}"), json!({"description": "pwn"})).await.0, 403);
    assert_eq!(b.patch(&format!("/api/v1/experiments/{ea}"), json!({"notes": "pwn"})).await.0, 403);
    assert_eq!(b.delete(&format!("/api/v1/experiments/{ea}")).await.0, 403);
    assert_eq!(b.delete(&format!("/api/v1/projects/{pa}")).await.0, 403);

    // raw export is a plain browser GET with the cookie only
    a.csrf = false;
    let (s, v) = a.get(&format!("/api/v1/series/raw?experiment_id={ea}&key=m&format=csv")).await;
    assert_eq!(s, 200, "{v}");
    a.csrf = true;
    let (_, e) = a.get(&format!("/api/v1/experiments/{ea}")).await;
    assert_eq!(e["notes"], "");
    // owner edits; admin sees and deletes everything
    let (s, e) = a.patch(&format!("/api/v1/experiments/{ea}"), json!({"tags": ["x"], "notes": "n", "name": "e2"})).await;
    assert_eq!(s, 200);
    assert_eq!(e["tags"], json!(["x"]));
    assert_eq!(admin.get("/api/v1/projects").await.1.as_array().unwrap().len(), 2);
    let (s, _) = admin.delete(&format!("/api/v1/experiments/{ea}")).await;
    assert_eq!(s, 200);
    assert_eq!(a.get(&format!("/api/v1/experiments/{ea}")).await.0, 404);
    assert_eq!(query(&mut ta, &ea, "m", json!({})).await["total"], 0);
    // re-ingest after delete creates a fresh experiment
    let (_, v) = ta.ingest(json!({"project": "shared-name", "experiment": "e2", "points": pts(0..2, |s| json!(s))})).await;
    assert_ne!(v["experiment_id"], ea);
    h.stop().await;
}
