//! kymo-bench: ingest throughput + series query latency.
//!
//! In-process (default): starts a server on a temp data dir.
//! External: `KYMO_HOST=http://host:8080 KYMO_API_KEY=kymo_... kymo-bench`.
//!
//! Flags (all optional): --exps 20 --keys 200 --steps 50000 --steps-per-req 500
//!   --clients 20 --queries 200 --big-steps 1000000 (0 disables the 20×1M phase)
//!   --encoding zstd|gzip|none --shards N --dir PATH

use kymo_server::config::Config;
use kymo_server::util::{now_ms, random_b62, sha256};
use serde_json::{Value, json};
use std::fmt::Write as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

struct Opts {
    exps: usize,
    keys: usize,
    steps: usize,
    steps_per_req: usize,
    clients: usize,
    queries: usize,
    big_steps: usize,
    encoding: String,
    shards: Option<usize>,
    dir: Option<String>,
}

fn opts() -> Opts {
    let mut o = Opts {
        exps: 20,
        keys: 200,
        steps: 50_000,
        steps_per_req: 500,
        clients: 20,
        queries: 200,
        big_steps: 1_000_000,
        encoding: "zstd".into(),
        shards: None,
        dir: None,
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let v = args.get(i + 1).cloned().unwrap_or_default();
        let n = || v.parse::<usize>().unwrap_or_else(|_| panic!("bad value for {}", args[i]));
        match args[i].as_str() {
            "--exps" => o.exps = n(),
            "--keys" => o.keys = n(),
            "--steps" => o.steps = n(),
            "--steps-per-req" => o.steps_per_req = n(),
            "--clients" => o.clients = n(),
            "--queries" => o.queries = n(),
            "--big-steps" => o.big_steps = n(),
            "--encoding" => o.encoding = v.clone(),
            "--shards" => o.shards = Some(n()),
            "--dir" => o.dir = Some(v.clone()),
            a => panic!("unknown flag {a}"),
        }
        i += 2;
    }
    o
}

fn body(project: &str, exp: &str, keys: &[String], from: usize, to: usize, enc: &str) -> Vec<u8> {
    let mut s = String::with_capacity((to - from) * keys.len() * 24 + 256);
    write!(s, "{{\"project\":\"{project}\",\"experiment\":\"{exp}\",\"client_id\":\"bench\",\"seq\":{from},\"points\":[").unwrap();
    let mut rb = ryu::Buffer::new();
    for step in from..to {
        if step > from {
            s.push(',');
        }
        write!(s, "{{\"step\":{step},\"ts\":{},\"metrics\":{{", 1.7e9 + step as f64 * 0.01).unwrap();
        for (ki, k) in keys.iter().enumerate() {
            if ki > 0 {
                s.push(',');
            }
            // deterministic, noisy-ish values; a few spikes
            let x = (step as f64 * 0.001 + ki as f64).sin() * 0.5 + 1.0 / (1.0 + step as f64 * 1e-4);
            let x = if step % 9973 == 0 { x * 100.0 } else { x };
            s.push('"');
            s.push_str(k);
            s.push_str("\":");
            s.push_str(rb.format(x));
        }
        s.push_str("}}");
    }
    s.push_str("]}");
    match enc {
        "zstd" => zstd::encode_all(s.as_bytes(), 1).unwrap(),
        "gzip" => {
            use std::io::Write;
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(s.as_bytes()).unwrap();
            e.finish().unwrap()
        }
        _ => s.into_bytes(),
    }
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return f64::NAN;
    }
    v[((v.len() - 1) as f64 * p).round() as usize]
}

struct Ctx {
    http: reqwest::Client,
    host: String,
    token: String,
}

impl Ctx {
    async fn ingest(&self, b: Vec<u8>, enc: &str) -> Value {
        let mut delay = 50u64;
        loop {
            let mut rq = self
                .http
                .post(format!("{}/api/v1/ingest", self.host))
                .bearer_auth(&self.token)
                .header("content-type", "application/json")
                .body(b.clone());
            if enc != "none" {
                rq = rq.header("content-encoding", enc);
            }
            match rq.send().await {
                Ok(r) if r.status().is_success() => return serde_json::from_slice(&r.bytes().await.unwrap()).unwrap(),
                Ok(r) if r.status().as_u16() == 429 || r.status().is_server_error() => {}
                Ok(r) => panic!("ingest failed: {} {}", r.status(), r.text().await.unwrap_or_default()),
                Err(e) => eprintln!("ingest error (retrying): {e}"),
            }
            tokio::time::sleep(Duration::from_millis(delay)).await;
            delay = (delay * 2).min(2000);
        }
    }

    /// Returns (client ms, server ms from Server-Timing).
    async fn query(&self, q: &Value) -> (f64, f64, usize) {
        let t = Instant::now();
        let r = self
            .http
            .post(format!("{}/api/v1/series/query", self.host))
            .bearer_auth(&self.token)
            .header("accept-encoding", "identity")
            .header("content-type", "application/json")
            .body(serde_json::to_vec(q).unwrap())
            .send()
            .await
            .unwrap();
        assert!(r.status().is_success(), "query failed: {}", r.status());
        let srv = r
            .headers()
            .get("server-timing")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split("dur=").nth(1))
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(f64::NAN);
        let b = r.bytes().await.unwrap();
        (t.elapsed().as_secs_f64() * 1e3, srv, b.len())
    }
}

async fn ingest_phase(ctx: Arc<Ctx>, o: &Opts, exps: usize, keys: usize, steps: usize, per_req: usize, tag: &str) -> Vec<i64> {
    let keys: Arc<Vec<String>> = Arc::new(
        (0..keys).map(|k| format!("{}/metric_{k}", ["train", "eval", "grad", "layer"][k % 4])).collect(),
    );
    let total_values = (exps * keys.len() * steps) as f64;
    println!("\n== ingest {tag}: {exps} experiments x {} keys x {steps} steps = {:.1}M values, {} values/request, {} concurrent clients, {} bodies",
        keys.len(), total_values / 1e6, per_req * keys.len(), o.clients.min(exps), o.encoding);
    let sent = Arc::new(AtomicU64::new(0));
    let exp_ids = Arc::new(parking_lot::Mutex::new(vec![0i64; exps]));
    let t0 = Instant::now();
    let next = Arc::new(AtomicU64::new(0));
    let mut lat = Vec::new();
    let mut handles = Vec::new();
    for _ in 0..o.clients.min(exps) {
        let (ctx, keys, next, sent, exp_ids, enc) =
            (ctx.clone(), keys.clone(), next.clone(), sent.clone(), exp_ids.clone(), o.encoding.clone());
        let tag = tag.to_string();
        handles.push(tokio::spawn(async move {
            let mut lats = Vec::new();
            loop {
                let e = next.fetch_add(1, Ordering::Relaxed) as usize;
                if e >= exps {
                    break;
                }
                let name = format!("{tag}-exp-{e}");
                // pipeline: build next body while the current request is in flight
                let mut from = 0;
                let mk = |from: usize| {
                    let (keys, name, enc) = (keys.clone(), name.clone(), enc.clone());
                    let to = (from + per_req).min(steps);
                    tokio::task::spawn_blocking(move || body("bench", &name, &keys, from, to, &enc))
                };
                let mut pending = Some(mk(0));
                while let Some(p) = pending.take() {
                    let b = p.await.unwrap();
                    let to = (from + per_req).min(steps);
                    if to < steps {
                        pending = Some(mk(to));
                    }
                    let t = Instant::now();
                    let r = ctx.ingest(b, &enc).await;
                    lats.push(t.elapsed().as_secs_f64() * 1e3);
                    exp_ids.lock()[e] = r["experiment_id"].as_i64().unwrap();
                    sent.fetch_add(r["accepted"].as_u64().unwrap(), Ordering::Relaxed);
                    from = to;
                }
            }
            lats
        }));
    }
    let progress = {
        let sent = sent.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let s = sent.load(Ordering::Relaxed) as f64;
                println!("  ... {:.1}M values, {:.2}M values/s", s / 1e6, s / t0.elapsed().as_secs_f64() / 1e6);
            }
        })
    };
    for h in handles {
        lat.extend(h.await.unwrap());
    }
    progress.abort();
    let dt = t0.elapsed().as_secs_f64();
    let n = sent.load(Ordering::Relaxed) as f64;
    println!(
        "ingest {tag}: {:.1}M values in {dt:.1}s = {:.2}M values/s ({} requests, request latency p50 {:.1} ms, p99 {:.1} ms)",
        n / 1e6,
        n / dt / 1e6,
        lat.len(),
        pct(&mut lat.clone(), 0.5),
        pct(&mut lat, 0.99)
    );
    let v = exp_ids.lock().clone();
    v
}

async fn query_phase(ctx: &Ctx, name: &str, q: Value, n: usize) {
    // first call (may be a cold cache load)
    let (c0, s0, bytes) = ctx.query(&q).await;
    let mut cl = Vec::with_capacity(n);
    let mut sv = Vec::with_capacity(n);
    for _ in 0..n {
        let (c, s, _) = ctx.query(&q).await;
        cl.push(c);
        sv.push(s);
    }
    println!(
        "query {name}: first {c0:.1} ms (server {s0:.1}); warm p50 {:.2} ms / p99 {:.2} ms client, server p50 {:.2} / p99 {:.2} ms; {:.0} KiB",
        pct(&mut cl.clone(), 0.5),
        pct(&mut cl, 0.99),
        pct(&mut sv.clone(), 0.5),
        pct(&mut sv, 0.99),
        bytes as f64 / 1024.0
    );
}

async fn concurrent_queries(ctx: Arc<Ctx>, name: &str, qs: Vec<Value>, conc: usize, per: usize) {
    let t0 = Instant::now();
    let mut hs = Vec::new();
    for i in 0..conc {
        let ctx = ctx.clone();
        let q = qs[i % qs.len()].clone();
        hs.push(tokio::spawn(async move {
            let mut v = Vec::new();
            for _ in 0..per {
                v.push(ctx.query(&q).await.0);
            }
            v
        }));
    }
    let mut all = Vec::new();
    for h in hs {
        all.extend(h.await.unwrap());
    }
    let dt = t0.elapsed().as_secs_f64();
    println!(
        "query {name}: {conc} concurrent clients, {:.0} queries/s, p50 {:.2} ms, p99 {:.2} ms",
        all.len() as f64 / dt,
        pct(&mut all.clone(), 0.5),
        pct(&mut all, 0.99)
    );
}

#[tokio::main]
async fn main() {
    let o = opts();
    let mut _tmp = None;
    let mut server = None;
    let (host, token) = match std::env::var("KYMO_HOST") {
        Ok(h) => (h.trim_end_matches('/').to_string(), std::env::var("KYMO_API_KEY").expect("KYMO_API_KEY required with KYMO_HOST")),
        Err(_) => {
            let dir = match &o.dir {
                Some(d) => std::path::PathBuf::from(d),
                None => {
                    let d = std::env::temp_dir().join(format!("kymo-bench-{}", random_b62(8)));
                    _tmp = Some(d.clone());
                    d
                }
            };
            let mut cfg = Config::for_dir(&dir);
            cfg.shards = o.shards.unwrap_or_else(|| Config::from_env().shards);
            cfg.cache_mb = Config::from_env().cache_mb;
            let s = kymo_server::start(cfg).await.expect("start server");
            // trusted in-process shortcut: create a user + API token directly in the meta DB
            let tok = format!("kymo_{}", random_b62(40));
            let h = sha256(tok.as_bytes());
            let st = s.state.clone();
            tokio::task::spawn_blocking(move || {
                st.db
                    .with(|c| {
                        c.execute(
                            "INSERT INTO users(username, display_name, password_hash, is_admin, webauthn_id, created_at)
                             VALUES('bench','bench','!',0,x'00000000000000000000000000000000',?1)",
                            [now_ms()],
                        )?;
                        let uid = c.last_insert_rowid();
                        c.execute(
                            "INSERT INTO api_tokens(user_id,name,token_hash,prefix,created_at) VALUES(?1,'bench',?2,'kymo_xxxx',?3)",
                            rusqlite::params![uid, &h[..], now_ms()],
                        )?;
                        Ok(())
                    })
                    .map_err(|e| e.message)
                    .unwrap()
            })
            .await
            .unwrap();
            println!(
                "in-process server at {} (data {}), {} shards, {} cores",
                s.base_url(),
                dir.display(),
                s.state.store.shards.len(),
                std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0)
            );
            let url = s.base_url();
            server = Some(s);
            (url, tok)
        }
    };
    let http = reqwest::Client::builder().pool_max_idle_per_host(256).build().unwrap();
    let ctx = Arc::new(Ctx { http, host, token });

    let ids = ingest_phase(ctx.clone(), &o, o.exps, o.keys, o.steps, o.steps_per_req, "grid").await;
    let mp = 2000;
    query_phase(&ctx, &format!("1 series x {} pts", o.steps), json!({"series": [{"experiment_id": ids[0], "key": "train/metric_0"}], "max_points": mp}), o.queries).await;
    let compare: Vec<Value> = ids.iter().map(|&e| json!({"experiment_id": e, "key": "eval/metric_1"})).collect();
    query_phase(&ctx, &format!("{} series x {} pts (compare)", ids.len(), o.steps), json!({"series": compare, "max_points": mp}), o.queries).await;
    let panel: Vec<Value> = (0..o.keys.min(50)).map(|k| json!({"experiment_id": ids[1 % ids.len()], "key": format!("{}/metric_{k}", ["train", "eval", "grad", "layer"][k % 4])})).collect();
    query_phase(&ctx, &format!("{} keys of one experiment (dashboard)", panel.len()), json!({"series": panel, "max_points": 1000}), o.queries / 4).await;
    query_phase(&ctx, "20 series zoom window 10%", json!({"series": compare, "max_points": mp, "step_min": o.steps / 2, "step_max": o.steps / 2 + o.steps / 10}), o.queries).await;
    let qs: Vec<Value> = ids.iter().map(|&e| json!({"series": [{"experiment_id": e, "key": "train/metric_4"}], "max_points": mp})).collect();
    concurrent_queries(ctx.clone(), "1-series mixed", qs, 32, 50).await;

    if o.big_steps > 0 {
        let ids = ingest_phase(ctx.clone(), &o, 20, 1, o.big_steps, 20_000, "big").await;
        let s: Vec<Value> = ids.iter().map(|&e| json!({"experiment_id": e, "key": "train/metric_0"})).collect();
        query_phase(&ctx, &format!("20 series x {}M pts", o.big_steps / 1_000_000), json!({"series": s, "max_points": 2000}), o.queries).await;
        query_phase(&ctx, &format!("1 series x {}M pts", o.big_steps / 1_000_000), json!({"series": [s[0]], "max_points": 2000}), o.queries).await;
    }
    if let Some(s) = server {
        println!("cache: {:.0} MiB resident", s.state.store.cache_bytes() as f64 / 1048576.0);
        let t = Instant::now();
        s.shutdown().await;
        println!("graceful shutdown (drain + checkpoint): {:.2}s", t.elapsed().as_secs_f64());
    }
    if let Some(d) = _tmp {
        let _ = std::fs::remove_dir_all(d);
    }
}
