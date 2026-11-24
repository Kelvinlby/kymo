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

### Sharing (meta schema v2)

* Migration v2 adds `projects.everyone` (`NULL|'viewer'|'editor'`) and `project_members(project_id, user_id, role)`;
  `shared=1` rows become `everyone='viewer'`. The old `shared` column is kept but ignored. Verified on a
  `VACUUM INTO` snapshot of `demo/data` (v1 → v2, `integrity_check` ok); restarting a migrated dir is a no-op.
* Effective role: `owner` (owner) > `admin` (admin user) > max(member role, everyone role). No role → 404 everywhere
  (existence is not leaked). Viewer: read. Editor: read + PATCH/DELETE experiments + ingest. Owner/admin only:
  PATCH/DELETE project, PUT sharing. Editor/viewer trying a forbidden write → 403.
* Project objects (`GET /projects`, `GET/POST/PATCH /projects/{id}`):
  `{id, name, description, everyone, shared (= everyone != null, deprecated), member_count, role,
  owner: {id, username, display_name}, created_at, experiment_count, running_count, last_activity}`.
  `PATCH` still accepts the deprecated `shared: bool` (true → everyone=viewer if unset, false → everyone=null).
* `GET /api/v1/users` (full cookie session only; token → `403 token_not_allowed`) →
  `[{id, username, display_name}]`, active (non-disabled) users, sorted by username.
* `GET /api/v1/projects/{id}/sharing` (anyone who can read the project, incl. tokens) and
  `PUT /api/v1/projects/{id}/sharing {"everyone": null|"viewer"|"editor", "members": [{"user_id", "role"}]}`
  (owner/admin, replaces everything) both return
  `{"everyone": ..., "members": [{"user": {id, username, display_name}, "role": "viewer"|"editor"}]}` (sorted by username).
  PUT errors (400): `invalid_role`, `duplicate_member`, `owner_not_member`, `unknown_user`, `too_many_members` (>10000).
  Omitted fields mean null / no members.
* `GET /experiments/{id}` also returns `role` (caller's project role) next to `can_edit`.
* Ingest `"project": "owner/name"`: needs editor+ on that project (admin always), else
  `403 project_forbidden` — also when it doesn't exist (never auto-created). Experiments inside it are auto-created.
  `"<own username>/name"` is the same as `"name"`. The ingest name→experiment cache is cleared on every sharing
  change, project/experiment rename/delete and user deletion, so revocations apply to the next request.

### Hand-written ingest

* Nested metric objects are flattened with `/` (depth ≤ 16), keys borrowed when not nested.
* Steps may be omitted per point (or in the top-level shorthand). Such requests travel to the shard writer with
  point indices; the writer (single thread per shard, so serialized per experiment) assigns `last_step + 1` of the
  experiment in request order, where explicit steps earlier in the same request also advance `last_step`.
  The first auto step of an empty experiment is 0. Points that end up with no accepted value consume no step.
  The flat SDK path is unchanged (explicit steps; one `any()` check per commit group in the writer).
* Single-point shorthand: top-level `metrics` (+ optional `step`, `ts`), may be combined with `points`
  (it then counts as one more point). A second top-level `metrics` key is a 400. `step: null` = missing.
* Response: `{"ok", "experiment_id", "accepted", "dropped", "dropped_keys": [up to 20 distinct example keys]}`
  (always present, possibly empty). Dropped = strings other than NaN/±Infinity, null, arrays, invalid keys.
* Any `Content-Type` is accepted (so `curl -d '{...}'` works); bearer requests need no CSRF header.

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
  `"+Infinity"` strings, integral float steps (a fractional step is a 400); a missing `ts` = server time.
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

### Token on/off switch (meta schema v4: `api_tokens.disabled`)

* `PATCH /tokens/{id} {"disabled"}` (owner, full session). Disabling drops the token's auth-cache entry; disabled tokens
  are never cached, so re-enabling needs no cache work. They get `401 token_disabled` (vs `invalid_token` for unknown or
  deleted ones). A revocation generation counter (`AuthState.token_gen`, bumped by every disable/delete/user revocation)
  stops a lookup that raced with a revocation from re-caching the token as valid — this also closed the same window
  for `DELETE /tokens/{id}`.
* The Python SDK treats any 401 as a rejected key: it warns once and drops live batches (training is never blocked);
  batches already spooled to disk stay there and `python -m kymo sync` can send them after the token is enabled again.

### Backup & restore (meta schema v3: `projects.last_backup_at`)

* Format: `BACKUP-FORMAT.md` at the repo root (embedded into every archive as `README.txt` via `include_str!`).
  CSV values use ryu's shortest round-trip form, so export → import is bit-exact (`tests/backup.rs` checks every point).
* Export (`api/backup.rs`) runs on a blocking thread: points are read straight from the shard SQLite file
  (`Store::scan_points`, not via the series cache, so a backup doesn't evict what the UI is using), written as CSV parts
  of ≤ 500k rows (the tar header needs each file's size, so one part is buffered), into tar → gzip level 1 (cheap on a
  small VPS) → 256 KiB chunks over a bounded channel (backpressure = the client's download speed). `experiment.json`
  follows its metric files and `manifest.json` comes last, since they carry exact counts. The response compression
  layer skips `application/gzip`. `last_backup_at` is written only after the final chunk was handed to the body.
* Import streams the upload to `$KYMO_DATA_DIR/tmp/import-*.part` (deleted afterwards), then reads it twice: pass 1
  collects `manifest.json` + every `experiment.json` (so hand-repacked archives in any order work), validates them and
  creates project/experiments/series; pass 2 streams the CSVs into the shard writers in 200k-row batches. On error the
  half-imported project is deleted.

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

## Benchmark after the sharing / hand-written-ingest change (same box, same command)

```
ingest grid: 200.0M values in 25.8s = 7.76M values/s (request p50 151 ms, p99 503 ms)   # 2nd run 7.75M/s
query 1 series x 50000 pts: server p50 0.20 / p99 0.24 ms
query 20 series x 50000 pts (compare): server p50 0.96 / p99 1.20 ms
query 50 keys of one experiment (dashboard): server p50 1.13 / p99 1.31 ms
query 1-series mixed: 32 concurrent clients, 16448 queries/s, p50 1.52 ms, p99 12.56 ms
ingest big: 20.0M values = 7.90M values/s
query 20 series x 1M pts: server p50 3.03 / p99 4.11 ms
query 1 series x 1M pts: server p50 0.32 / p99 0.48 ms
```
Ingest is within run-to-run noise of the earlier 7.77–7.88M values/s (a first run before trimming the hot path
showed 7.6–7.7M/s; the per-request max-step pass was then moved into the writer and only runs when a commit group
contains a server-assigned-step request, and the metric key check became a byte scan). Parser micro benchmark:
25.6 ns/value for a 100k-value SDK-style body (`cargo test --release --lib perf_parse -- --ignored --nocapture`).

## Benchmark (initial version, release, in-process, this dev box: Ryzen 5 9600X 6C/12T, NVMe, 12 shards)

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
