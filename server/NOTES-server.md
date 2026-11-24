# kymo-server notes

## Running

```sh
cd server
cargo build --release
KYMO_ORIGIN=http://localhost:8080,http://localhost:5173 ./target/release/kymo-server
```

On first start (no users) the server prints
`KYMO SETUP TOKEN: <token>  open <origin>/setup?token=<token>` to stdout and writes it to
`$KYMO_DATA_DIR/setup_token` (mode 0600). The file is deleted once setup completes.

| env | default | |
|---|---|---|
| `KYMO_BIND` | `0.0.0.0:8080` | |
| `KYMO_DATA_DIR` | `./data` | `meta.sqlite`, `points-<n>.sqlite` |
| `KYMO_RP_ID` | `localhost` | WebAuthn RP id; must be the host of every origin (or a parent domain) |
| `KYMO_ORIGIN` | `http://localhost:8080` | comma separated, first is canonical (used in invite/reset links, cookie `Secure` when https) |
| `KYMO_WEB_DIR` | `../web/dist` | SPA; a missing dir just gives 404 for non-API paths |
| `KYMO_SHARDS` | `min(cores,16)` | fixed at data-dir creation (stored in meta); later changes are ignored with a warning |
| `KYMO_CACHE_MB` | `2048` | series cache budget, split evenly across shards |
| `KYMO_TRUST_PROXY` | off | `1` = use `X-Forwarded-For` for the login rate limiter |
| `RUST_LOG` | `info,tower_http=warn` | |

SIGINT/SIGTERM: stop accepting, finish in-flight requests (they wait for their commit ack), then every
shard writer drains its queue, commits, runs `wal_checkpoint(TRUNCATE)` and exits.

Tests: `cargo test` (integration tests in `tests/` start real servers on temp dirs and run full passkey
ceremonies with `webauthn-authenticator-rs` SoftPasskey).
Benchmark: `cargo run --release --bin kymo-bench -- [--exps 20 --keys 200 --steps 50000 ...]`,
or against a running server with `KYMO_HOST=... KYMO_API_KEY=kymo_... kymo-bench`.

## Decisions / deviations from SPEC (all backward compatible)

* **Timestamps**: `created_at`, `updated_at`, `expires_at`, `last_*_at` are RFC 3339 UTC strings with ms
  (`2026-11-23T10:00:00.123Z`). Point `ts` / `last_ts` are unix seconds (float) everywhere.
* **CSRF**: `X-Kymo-CSRF: 1` is required on *every* non-GET/HEAD/OPTIONS `/api` request that has no
  `Authorization` header, including the unauthenticated ones (login, setup, signup, reset, logout). This
  also blocks login CSRF. Bearer requests never need it. Missing → `403 {"code":"csrf"}`.
* **Unfinished-login 403 codes** (agreed with the web UI): `session_passkey_required`,
  `session_enroll_passkey`. Token used on a session-only endpoint: `403 token_not_allowed`.
  No/invalid credentials: `401 unauthorized`, bad bearer token: `401 invalid_token`.
* **Token scope**: bearer tokens may call `POST /ingest`, `POST /series/query` and every `GET` read
  endpoint (projects, experiments, metrics, metric-keys, series/raw, auth/state). Project/experiment
  mutations (POST/PATCH/DELETE), tokens, passkeys, password, admin are cookie-session (state `full`) only.
  A token sees what its owner sees (own + shared projects; everything for the admin).
* Login/setup/signup responses are `{state, user}` (spec: `{state}`); `auth/state` with a bearer token
  returns the token's user with `session_state: null`.
* `GET /experiments/{id}` additionally returns `project.owner` and `can_edit`; experiment objects include
  `project_id` and `notes` everywhere.
* `POST /admin/users/{id}/reset-password` → `{url, token, expires_at}` (24 h, single use, kills sessions).
* `/series/query`: unreadable or unknown `(experiment, key)` pairs return `total: 0` and empty arrays (no
  error, no existence leak). `total` = points inside the requested window. At most 2000 series/query.
  Response carries `Server-Timing: query;dur=<ms>`.
* `/series/raw?format=json` (default) streams `{"experiment_id", "key", "points": [[step, value|null, ts], ...]}`;
  `format=csv` streams `step,value,ts` with `NaN`/`Infinity`/`-Infinity` literals and a
  `Content-Disposition` filename.
* Ingest: `points` may be empty or missing — project/experiment are still resolved/created and
  `config` (shallow merge), `status`, `host` applied. Any valid status is applied in arrival order
  (`running` after `finished` is allowed). Also accepted: `deflate` bodies, `"nan"`/`"inf"`/`"-inf"`/
  `"+Infinity"` strings, integral float steps. A point without `step` is a 400; a missing `ts` = server time.
  A metric value that is `null`, an object/array or another string is dropped and counted.
  `updated_at` is written at most once per second per experiment (plus on every config/status/host change).
* Summary `count` counts all points (including NaN); `min`/`max` are over finite values only (null if none);
  `last_value` can be null (NaN/Inf).
* Passkey challenge state lives in memory (keyed by session, 5 min TTL), so the
  `danger-allow-state-serialisation` feature is not needed; a restart only voids in-flight ceremonies.
  Registered passkeys are stored as serialized `Passkey` JSON in `meta.sqlite`; sign counters are updated.
* Passkey login rotates nothing: the session row moves `passkey_required → full`. A fresh session id is
  issued at every password login and the previous one (if any) is deleted.
* Changing the password revokes all other sessions; disabling a user or resetting their passkeys revokes
  all their sessions, and their API tokens stop working immediately (cache checks `disabled`).
* Rate limits (fixed 60 s window, in memory): login 10 per IP+username, setup/signup/reset 10 per IP,
  invite lookups 60 per IP, password change 10 per user.

## Storage design

* `meta.sqlite` (WAL): users, sessions, passkeys, invites, resets, tokens, settings, projects,
  experiments, `series(id, experiment_id, key)`. Migrations via `PRAGMA user_version` at startup.
* `points-<shard>.sqlite` (WAL, `synchronous=NORMAL`, 64 MiB page cache, 1 GiB mmap):
  `points(series_id, step, value, ts) WITHOUT ROWID` + `summaries` table. Shard = splitmix64(experiment_id) % N,
  so a whole experiment lives in one shard.
* One writer thread per shard; ingest handlers send a pre-sorted (series, step), deduplicated (last wins)
  row batch over a bounded channel (async backpressure) and await a oneshot ack. The writer takes
  everything already queued (≤ 200k rows; no artificial linger — the commit time of the previous group is
  the gathering window) into one transaction. Rows with step > last step of the series use the upsert fast
  path; older steps use `INSERT OR IGNORE` then `UPDATE ... WHERE value IS NOT ? OR ts IS NOT ?` so an
  idempotent replay changes nothing and only real changes trigger a summary recompute.
  NaN is stored as SQL NULL.
* Interned series ids: per-experiment `RwLock<HashMap<Box<str>, i64>>` (foldhash), one read lock per
  request, zero allocations per value (keys are borrowed from the request body by the sonic-rs visitor).
* Series cache: per shard LRU by bytes over columnar `steps/values/ts` + one pre-aggregate
  (sum/count/min/max of finite values) per 64 points. A loading placeholder protocol guarantees writes
  committed during a cold load are merged in. Writers update cached series after each commit, before
  acking, so reads after an ack see the data.
* Downsampling: buckets of equal step width; boundaries found by galloping search from the current
  position; each bucket = raw head + block aggregates + raw tail. The aggregate loop has an all-finite
  fast path (plain SIMD sum/min/max) and a masked slow path used only when NaN/Inf are present
  (measured: masked loop 0.84 ns/value → fast path ≈0.25 ns/value; blocks cut a 1M-point series from
  0.93 ms to 0.13 ms in the micro benchmark `cargo test --release --lib perf_sample -- --ignored --nocapture`).
  Series of one query run in parallel on rayon; JSON is written by hand (ryu/itoa).
* All SQLite work runs on writer threads, `spawn_blocking` or rayon, never on tokio workers. Auth lookups
  are served from in-memory caches (sessions, tokens, users) without leaving the async worker on a hit.
* mimalloc, fat LTO, codegen-units=1, panic=abort. Response compression (gzip/br/zstd/deflate, fastest level)
  via tower-http.

## Benchmark (release, in-process, this dev box: Ryzen 5 9600X 6C/12T, NVMe, 12 shards)

`cargo run --release --bin kymo-bench` (client JSON generation + zstd compression runs on the same 12 cores,
so server-only throughput is higher than shown):

```
== ingest grid: 20 experiments x 200 keys x 50000 steps = 200.0M values, 100000 values/request, 20 concurrent clients, zstd bodies
ingest grid: 200.0M values in 25.4s = 7.88M values/s (2000 requests, request latency p50 149.8 ms, p99 490.4 ms)
query 1 series x 50000 pts: first 4.4 ms (server 4.2); warm p50 0.24 ms / p99 0.33 ms client, server p50 0.20 / p99 0.25 ms
query 20 series x 50000 pts (compare): first 22.9 ms (server 22.1); warm p50 1.42 ms / p99 1.73 ms client, server p50 0.86 / p99 1.07 ms
query 50 keys of one experiment (dashboard): first 32.1 ms; warm p50 1.88 ms / p99 2.18 ms client, server p50 1.09 / p99 1.28 ms
query 20 series zoom window 10%: warm p50 1.27 ms / p99 1.64 ms client, server p50 0.77 / p99 1.00 ms
query 1-series mixed: 32 concurrent clients, 19134 queries/s, p50 1.26 ms, p99 16.19 ms

== ingest big: 20 experiments x 1 keys x 1000000 steps = 20.0M values, 20000 values/request
ingest big: 20.0M values in 2.4s = 8.31M values/s (1000 requests, request latency p50 29.6 ms, p99 93.4 ms)
query 20 series x 1M pts: first 292.9 ms (cold load from SQLite); warm p50 3.39 ms / p99 5.09 ms client, server p50 2.85 / p99 3.26 ms
query 1 series x 1M pts: warm p50 0.36 ms / p99 0.51 ms client, server p50 0.31 / p99 0.46 ms
graceful shutdown (drain + checkpoint): 0.07s
```

Disk: ~6.5 GB for the 220M points (≈30 B/point incl. B-tree overhead).
"first" = cold cache (series loaded from SQLite at ~70M rows/s across cores); "warm" = cached.
Before the block pre-aggregates + finite fast path the 20×1M query was 7.85 ms server p50.

## Known limitations / ideas

* Ingest that races with deleting the same experiment can leave orphan points (unreachable, harmless).
* Points are one SQLite row each (~30 B on disk). A chunked/columnar on-disk format would cut disk and cold
  load time several-fold; not needed for the targets above.
* The series-query authorization check does one meta lookup per distinct experiment (sequential, ~20 µs each).
* `RUSTFLAGS="-C target-cpu=native"` made no measurable difference (memory-bound loops), so the default
  portable x86-64 build is used.
