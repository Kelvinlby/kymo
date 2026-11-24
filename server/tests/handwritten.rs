//! Hand-written (curl-style) ingest bodies.
mod common;
use common::*;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};

async fn series(t: &mut Client, exp: &Value, key: &str) -> Value {
    let (s, v) = t.post("/api/v1/series/query", json!({"series": [{"experiment_id": exp, "key": key}]})).await;
    assert_eq!(s, 200);
    v["series"][0].clone()
}

/// Send a raw string body exactly like `curl -d` would (form content type, no CSRF header).
async fn curl(t: &mut Client, body: &str) -> (u16, Value) {
    let mut h = HeaderMap::new();
    h.insert("content-type", HeaderValue::from_static("application/x-www-form-urlencoded"));
    t.send(reqwest::Method::POST, "/api/v1/ingest", Some(body.as_bytes().to_vec()), h).await
}

#[tokio::test]
async fn curl_style_bodies() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let mut t = admin.token().await;

    // single-point shorthand, no step, no ts
    let before = kymo_server::util::now_ms() as f64 / 1000.0;
    let (s, v) = curl(&mut t, r#"{"project": "p", "experiment": "e", "metrics": {"loss": 1.5}}"#).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!((v["accepted"].as_i64(), v["dropped"].as_i64()), (Some(1), Some(0)));
    assert_eq!(v["dropped_keys"], json!([]));
    let exp = v["experiment_id"].clone();
    for x in [1.4, 1.3] {
        curl(&mut t, &format!(r#"{{"project":"p","experiment":"e","metrics":{{"loss":{x}}}}}"#)).await;
    }
    let q = series(&mut t, &exp, "loss").await;
    assert_eq!(q["step"], json!([0, 1, 2]));
    assert_eq!(q["value"], json!([1.5, 1.4, 1.3]));
    let ts = q["ts"][0].as_f64().unwrap();
    assert!(ts >= before - 1.0 && ts <= before + 60.0, "server time ts: {ts}");

    // nested objects flatten with '/'; explicit step and ts in the shorthand
    let (s, v) = curl(&mut t, r#"{"project":"p","experiment":"e","step":10,"ts":123.5,
        "metrics":{"train":{"loss":2.3,"acc":{"top1":0.5}},"lr":0.1,"note":"hi","tags":["a"],"x":null}}"#).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!((v["accepted"].as_i64(), v["dropped"].as_i64()), (Some(3), Some(3)));
    assert_eq!(v["dropped_keys"], json!(["note", "tags", "x"]));
    let q = series(&mut t, &exp, "train/acc/top1").await;
    assert_eq!((q["step"].clone(), q["ts"].clone()), (json!([10]), json!([123.5])));
    assert_eq!(series(&mut t, &exp, "train/loss").await["value"], json!([2.3]));
    // next step after an explicit one = last_step + 1 of the experiment (any key)
    curl(&mut t, r#"{"project":"p","experiment":"e","metrics":{"loss":1.0}}"#).await;
    assert_eq!(series(&mut t, &exp, "loss").await["step"], json!([0, 1, 2, 11]));

    // points without steps, mixed with explicit ones, in request order
    let (s, v) = curl(&mut t, r#"{"project":"p","experiment":"e","points":[
        {"metrics":{"loss":0.9}}, {"metrics":{"loss":0.8}}, {"step":20,"metrics":{"loss":0.7}}, {"metrics":{"eval":{"acc":0.6}}}]}"#).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(series(&mut t, &exp, "loss").await["step"], json!([0, 1, 2, 11, 12, 13, 20]));
    assert_eq!(series(&mut t, &exp, "eval/acc").await["step"], json!([21]));
    let (_, e) = t.get(&format!("/api/v1/experiments/{exp}")).await;
    assert_eq!(e["last_step"], 21);

    // config/status-only body; dropped keys capped at 20
    let (s, _) = curl(&mut t, r#"{"project":"p","experiment":"e","status":"finished","config":{"a":1}}"#).await;
    assert_eq!(s, 200);
    let many: String = (0..30).map(|i| format!("\"k{i}\":\"bad\"")).collect::<Vec<_>>().join(",");
    let (_, v) = curl(&mut t, &format!(r#"{{"project":"p","experiment":"e","metrics":{{{many}}}}}"#)).await;
    assert_eq!(v["dropped"], 30);
    assert_eq!(v["dropped_keys"].as_array().unwrap().len(), 20);
    // still malformed: invalid JSON, metrics not an object, bad step
    assert_eq!(curl(&mut t, r#"{"project":"p","experiment":"e","metrics":5}"#).await.0, 400);
    assert_eq!(curl(&mut t, r#"{"project":"p","experiment":"e","step":1.5,"metrics":{"a":1}}"#).await.0, 400);
    assert_eq!(curl(&mut t, "project=p&experiment=e").await.0, 400);
    h.stop().await;
}

#[tokio::test]
async fn concurrent_auto_steps_are_serialized() {
    let h = Harness::new().await;
    let (mut admin, _pk) = h.admin().await;
    let t = admin.token().await;
    let (s, v) = {
        let mut t0 = Client { base: t.base.clone(), http: reqwest::Client::new(), cookie: None, bearer: t.bearer.clone(), csrf: false };
        t0.ingest(json!({"project": "p", "experiment": "race", "points": [{"step": 99, "metrics": {"a": 0}}]})).await
    };
    assert_eq!(s, 200);
    let exp = v["experiment_id"].clone();
    let n = 64;
    let mut tasks = Vec::new();
    for i in 0..n {
        let mut c = Client { base: t.base.clone(), http: reqwest::Client::new(), cookie: None, bearer: t.bearer.clone(), csrf: false };
        tasks.push(tokio::spawn(async move {
            // alternate shorthand and points-without-step forms, two keys per point
            let body = if i % 2 == 0 {
                json!({"project": "p", "experiment": "race", "metrics": {"a": i, "b": {"c": i}}})
            } else {
                json!({"project": "p", "experiment": "race", "points": [{"metrics": {"a": i, "b/c": i}}]})
            };
            c.ingest(body).await.0
        }));
    }
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    let mut c = Client { base: t.base.clone(), http: reqwest::Client::new(), cookie: None, bearer: t.bearer.clone(), csrf: false };
    let a = series(&mut c, &exp, "a").await;
    let b = series(&mut c, &exp, "b/c").await;
    let expect: Vec<i64> = std::iter::once(99).chain(100..100 + n).collect();
    assert_eq!(a["step"], json!(expect), "every request got its own step");
    assert_eq!(b["step"], json!(expect[1..]));
    let av = a["value"].as_array().unwrap();
    let bv = b["value"].as_array().unwrap();
    assert_eq!(&av[1..], &bv[..], "a and b/c of the same request share a step");
    let mut vals: Vec<i64> = av[1..].iter().map(|v| v.as_f64().unwrap() as i64).collect();
    vals.sort();
    assert_eq!(vals, (0..n).collect::<Vec<_>>());
    h.stop().await;
}
