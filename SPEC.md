# Kymo — ML experiment tracking platform: shared spec / contract

This file is the **single source of truth** shared by the three components. If you need to deviate,
keep the deviation backward compatible and write it down in `NOTES-<component>.md` in your own directory.

```
kymo/
  SPEC.md            <- this file
  server/            <- Rust (axum + tokio) backend, single binary `kymo-server`
  sdk/python/        <- Python package `kymo` (zero runtime deps, stdlib only)
  web/               <- Vite + Preact + TypeScript + uPlot SPA, built to web/dist, served by server
```

Toolchain on this machine: Rust 1.100, Node 24 / npm 11, Python 3.14 + uv, Docker. No Go, no pnpm.
12 cores / 30 GB RAM in dev. Target production: many-core, **low clock** server CPUs (e.g. 64–128 cores @ 2–3 GHz).

---

## 1. Domain model

* **User** — `id, username (unique, [a-z0-9_.-]{2,32}), display_name, is_admin, disabled, created_at`.
  Exactly **one admin** (created via bootstrap). Admin has super power: sees/edits/deletes everything, manages users,
  invites, site policy.
* **Project** — `id, owner_id, name ([A-Za-z0-9_.-]{1,64}, unique per owner), description, created_at`, plus sharing:
  * **members**: a list of `(user, role)` picked from the user list, role `viewer` (read) or `editor` (read + edit
    experiments + log into it via the SDK/API). Only the owner and the admin can change members, rename or delete the project.
  * **everyone**: `null | "viewer" | "editor"` — a role for all users, including ones created later. An explicit member
    role wins over `everyone` when it is higher.
  The admin can do everything. Each project object returned to a user carries `role`: `owner|admin|editor|viewer`.
  (Replaces the old `shared: bool`; migrate `shared=true` → `everyone="viewer"`.)
* **Experiment** — `id, project_id, name (1–128 chars, unique per project), status (running|finished|failed|crashed),
  config (JSON object), tags (string[]), notes (string), created_at, updated_at (last ingest), host?`
* **Metric (series)** — `id, experiment_id, key` (e.g. `train/loss`). Points are `(step: i64, value: f64, ts: f64 unix seconds)`.
  `(experiment, key, step)` is unique — **last write wins** (makes client retries idempotent).
  The server keeps a per-series summary: `count, first_step, last_step, min, max, last_value, last_ts`.

The 3 levels: Project > Experiment > Metric. Keys containing `/` are groups (`train/loss` → group `train`).
Server returns keys in **natural sort order** (`layer2` < `layer10`); UI groups by prefix before the first `/`.

---

## 2. Auth

### 2.1 Bootstrap (one admin)
* On startup, if no users exist, the server generates a random setup token, prints it to stdout
  (`KYMO SETUP TOKEN: ...  open <origin>/setup?token=...`) and writes it to `<data_dir>/setup_token` (0600).
* `POST /api/v1/auth/setup {setup_token, username, password, display_name?}` → creates the admin and returns a session
  with state `enroll_passkey`. **Passkey 2FA is enforced for the admin**: until a passkey is registered the admin can
  only call the passkey-registration endpoints, `auth/state` and `logout`. After setup the token file is deleted and
  the endpoint returns 409 forever.

### 2.2 Signup only by invite (no public signup page)
* Admin creates invites: `POST /api/v1/admin/invites {username?: string, expires_hours?: number (default 72)}`
  → `{id, token, url, username, expires_at}`. `url` = `<origin>/signup?invite=<token>`.
* `GET /api/v1/admin/invites` → list (no tokens, only id/username/expires_at/used_at/created_at). `DELETE /api/v1/admin/invites/{id}`.
* `GET /api/v1/auth/invite/{token}` → `{valid: bool, username?: string}` (unauthenticated).
* `POST /api/v1/auth/signup {invite_token, username, password, display_name?}` → creates user (non-admin), marks invite used,
  returns session. If site policy requires passkeys for everyone → state `enroll_passkey`, else `full`.
* Login page never shows a “sign up” link.

### 2.3 Login & sessions
* Passwords: argon2id (`argon2` crate). Min length 10. Login rate limited per IP+username (e.g. 10/min).
* `POST /api/v1/auth/login {username, password}` → `{state}` where state ∈
  * `full` — logged in,
  * `passkey_required` — user has ≥1 passkey: must call passkey login,
  * `enroll_passkey` — user must register a passkey (admin always; others if policy says so) before full access.
  Every user with at least one registered passkey must pass it at login, whatever the policy.
* Session cookie `kymo_session` (random 256-bit, server stores sha256), `HttpOnly; SameSite=Strict; Path=/`, `Secure` when
  origin is https. Lifetime 14 days sliding. Session row has `state` (`passkey_required|enroll_passkey|full`).
* **CSRF**: every state-changing request authenticated by cookie must carry header `X-Kymo-CSRF: 1` (else 403).
  Bearer-token requests don't need it.
* `POST /api/v1/auth/logout`. `POST /api/v1/auth/password {old_password, new_password}`.
* `GET /api/v1/auth/state` (works without auth) →
  ```json
  {"setup_required": false, "session_state": "full" | "passkey_required" | "enroll_passkey" | null,
   "user": {"id":1,"username":"alice","display_name":"Alice","is_admin":false} | null,
   "policy": {"passkey_required_for_all": false}, "version": "0.1.0"}
  ```

### 2.4 Passkeys (WebAuthn, `webauthn-rs` crate)
Config: `KYMO_RP_ID` (default `localhost`), `KYMO_ORIGIN` (default `http://localhost:8080`, comma separated list allowed;
the first one is canonical, e.g. `http://localhost:8080,http://localhost:5173` for Vite dev).
* `POST /api/v1/auth/passkey/register/start {name}` → `{"publicKey": {...}}` (webauthn-rs `CreationChallengeResponse` JSON,
  binary fields base64url **without padding**). Allowed in states `enroll_passkey` and `full`.
* `POST /api/v1/auth/passkey/register/finish {name, credential}` where `credential` is the `RegisterPublicKeyCredential` JSON:
  `{id, rawId, type:"public-key", response:{attestationObject, clientDataJSON, transports?}, extensions:{}}` (base64url).
  On success a session in state `enroll_passkey` becomes `full`. → `{id, name, created_at}`
* `POST /api/v1/auth/passkey/login/start` → `{"publicKey": {...}}` (`RequestChallengeResponse`). Only in state `passkey_required`.
* `POST /api/v1/auth/passkey/login/finish {credential}` with `PublicKeyCredential` JSON
  `{id, rawId, type, response:{authenticatorData, clientDataJSON, signature, userHandle}, extensions:{}}` → `{state:"full"}`.
* `GET /api/v1/auth/passkeys` → `[{id, name, created_at, last_used_at}]`; `DELETE /api/v1/auth/passkeys/{id}`
  (refused with 409 if it's the last one and the user must have one: admin always, others when policy on).
* Challenge state is kept server-side keyed by session, expires after 5 min.

### 2.5 Admin
* `GET /api/v1/admin/users` → `[{id, username, display_name, is_admin, disabled, created_at, passkey_count, last_login_at}]`
* `PATCH /api/v1/admin/users/{id} {disabled?: bool, reset_passkeys?: bool, display_name?: string}` (disabling kills sessions/tokens use)
* `DELETE /api/v1/admin/users/{id}` (not self). Their projects are deleted too.
* `POST /api/v1/admin/users/{id}/reset-password` → `{invite-like url}` — creates a one-time reset link `<origin>/signup?reset=<token>`;
  `POST /api/v1/auth/reset {reset_token, password}` sets it. (Nice to have.)
* `GET /api/v1/admin/settings` → `{passkey_required_for_all: bool}`; `PUT` same shape. When turned on, users without a passkey get
  state `enroll_passkey` at their next request/login.

### 2.6 API tokens (for the Python SDK)
* `POST /api/v1/tokens {name}` → `{id, name, token, created_at}`; token = `kymo_` + 40 base62 chars, shown once; stored as sha256.
* `GET /api/v1/tokens` → `[{id, name, prefix ("kymo_abcd"), created_at, last_used_at, disabled}]`; `DELETE /api/v1/tokens/{id}`.
* `PATCH /api/v1/tokens/{id} {"disabled": true|false}` → the token object. A disabled token is kept (same secret) but every
  request with it gets `401 {"code": "token_disabled"}` until it is enabled again; takes effect on the next request.
* Usage: `Authorization: Bearer kymo_...`. Bearer tokens may call **ingest** and **all read endpoints** of their owner's
  scope, never auth/admin/token-management endpoints. Token lookups must be cached in memory (sha256 → user, invalidated on
  delete/disable); `last_used_at` updated at most once per minute.

---

## 3. Ingestion API (the hot path)

`POST /api/v1/ingest`
* Headers: `Authorization: Bearer kymo_...`, `Content-Type: application/json`, optional `Content-Encoding: gzip` or `zstd`.
* Body:
```json
{
  "project": "llm-pretrain",
  "experiment": "7b-lr3e-4",
  "client_id": "8f0c...uuid",          // per SDK run, informational
  "seq": 42,                            // monotonically increasing per client batch, informational
  "config": {"lr": 0.0003, "model": {"d": 4096}},   // optional, shallow-merged into experiment.config
  "status": "running",                  // optional: running | finished | failed | crashed
  "host": "node-17",                    // optional
  "points": [
    {"step": 1200, "ts": 1732400000.123, "metrics": {"train/loss": 2.31, "lr": 3e-4, "grad_norm": "NaN"}}
  ]
}
```
* Project and experiment are **auto-created** by name under the token owner. `"project": "alice/llm-pretrain"` refers
  to another user's project; the token owner must be an `editor` there (403 otherwise; such projects are never auto-created).
* **Hand-written JSON is a first-class client** (curl, any language, any framework — the SDK is just a convenience).
  The server therefore also accepts:
  * **Nested metric objects**, flattened with `/`: `{"train": {"loss": 2.3}}` ≡ `{"train/loss": 2.3}`.
  * **Missing `step`**: the server assigns `last_step + 1` of that experiment, in request order. Missing `ts`: server time.
  * **Single-point shorthand**: top-level `metrics` (+ optional `step`, `ts`) instead of `points`:
    `{"project": "p", "experiment": "e", "metrics": {"loss": 1.2}}`.
  * Missing `points`/`metrics` (config/status-only update) is valid.
* Values: JSON numbers; bools are 0/1; strings `"NaN"`, `"Infinity"`, `"-Infinity"` → those floats. Anything else
  (other strings, arrays, null) is dropped and counted in `dropped`; the response also lists up to 20 example
  `dropped_keys` so hand-written clients can see what was ignored. Metric keys: 1–256 bytes UTF-8, no control chars.
* Response `200 {"ok": true, "experiment_id": 7, "accepted": 123, "dropped": 0}` **only after the data is durably committed**.
  `400` malformed (client must NOT retry), `401/403` auth (don't retry), `413` too large (client should split),
  `429`/`5xx` (client retries with backoff; server may send `Retry-After`).
* Limits: body ≤ 64 MiB decompressed; ≤ 1,000,000 values per request.

---

## 4. Read API (cookie session or bearer token)

* `GET /api/v1/projects` → `[{id, name, description, everyone, member_count, role, owner: {id, username, display_name}, created_at, experiment_count, running_count, last_activity, last_backup_at}]`
  (owned + shared with me; admin sees all)
* `POST /api/v1/projects {name, description?}` · `PATCH /api/v1/projects/{id} {name?, description?}` · `DELETE /api/v1/projects/{id}`
* `GET /api/v1/users` → `[{id, username, display_name}]` — the user directory (active users, for the share picker).
  Any full session; not API tokens.
* `GET /api/v1/projects/{id}/sharing` → `{"everyone": null|"viewer"|"editor", "members": [{"user": {id, username, display_name}, "role": "viewer"|"editor"}]}`
* `PUT /api/v1/projects/{id}/sharing {"everyone": ..., "members": [{"user_id": 2, "role": "editor"}]}` — replaces the
  whole sharing state; owner/admin only; the owner can't be a member of their own project.
* `GET /api/v1/projects/{id}` → project object
* `GET /api/v1/projects/{id}/experiments` → `[{id, name, status, tags, created_at, updated_at, host, config, metric_count, last_step}]`
  sorted by `created_at desc`.
* `GET /api/v1/projects/{id}/metric-keys` → `["eval/acc", "train/loss", ...]` union over experiments, natural sort.
* `GET /api/v1/experiments/{id}` → experiment object + `project: {id, name}`
* `PATCH /api/v1/experiments/{id} {name?, tags?, notes?, status?}` · `DELETE /api/v1/experiments/{id}`
* `GET /api/v1/experiments/{id}/metrics` → `[{key, count, first_step, last_step, min, max, last_value, last_ts}]` natural sort.
* `POST /api/v1/series/query` — batch fetch, the plot data path:
```json
{"series": [{"experiment_id": 7, "key": "train/loss"}, {"experiment_id": 9, "key": "train/loss"}],
 "max_points": 2000,                 // per series, default 2000, max 20000
 "step_min": null, "step_max": null  // optional zoom window (inclusive)
}
```
→
```json
{"series": [{"experiment_id": 7, "key": "train/loss", "total": 1048576, "downsampled": true,
             "step": [0, 512, ...], "value": [2.3, 2.1, ...], "min": [2.2, ...], "max": [2.5, ...], "ts": [1732400000.1, ...]}]}
```
  * If the window has ≤ `max_points` points: raw points, `downsampled=false`, `min`/`max` omitted.
  * Else bucket the window into `max_points` equal step-width buckets and return per bucket: `step` = first step in bucket,
    `value` = mean, `min`, `max`, `ts` = ts of last point in bucket (M4/min-max style so spikes are never lost).
  * NaN / ±Inf are encoded in JSON as `null` (value arrays may contain null); non-finite values are excluded from min/max/mean.
  * Must be fast: target < 5 ms server time for 20 series × 1M points each (see §6).
* `GET /api/v1/series/raw?experiment_id=7&key=train/loss&format=csv|json` — full-resolution export (streamed).
* Project objects also carry `last_backup_at` (RFC 3339 or `null`): when a backup of the project was last downloaded completely.

### 4.1 Backup & restore (format: [BACKUP-FORMAT.md](BACKUP-FORMAT.md))

* `GET /api/v1/projects/{id}/backup` — streams the project as one self-describing `.kymo.tar.gz` (gzip'd tar of a
  README with the format spec, `manifest.json`, one `experiment.json` per experiment, metric points as CSV at full
  precision). Anyone who can read the project, API tokens included (scripted backups). `Content-Type: application/gzip`,
  `Content-Disposition` names the file `<project>-<YYYYMMDD-HHMMSS>.kymo.tar.gz` (UTC). A download that completes sets
  the project's `last_backup_at`; an aborted one does not (the body then ends with an error, never a short "complete" file).
* `POST /api/v1/projects/import[?name=<project name>]` — body: a backup file (`.tar.gz` or plain `.tar`, any
  `Content-Type`, no size limit, streamed to disk). Full session only. Always creates a **new** project owned by the
  caller (sharing is not restored; it is listed in the manifest for reference); a name the caller already uses gets
  `-restored`, `-restored-2`, …. Archive file order does not matter. Any error rolls the import back completely.
  → `{"project": <project object>, "experiments", "metrics", "points"}`; `400 invalid_backup` with a readable message
  for anything that is not a valid backup.

Errors everywhere: `{"error": "human readable", "code": "snake_case_code"}` with proper HTTP status.

---

## 5. Python SDK (`sdk/python`, import name `kymo`)

```python
import kymo
run = kymo.init(project="llm-pretrain", experiment="7b-lr3e-4",
                config={"lr": 3e-4},          # optional
                api_key=None,                 # default env KYMO_API_KEY
                host=None)                    # default env KYMO_HOST, else http://localhost:8080
for step in range(N):
    run.log({"train/loss": loss, "lr": lr, "eval": {"acc": acc}}, step=step)   # step optional (auto-increment)
run.finish()           # optional; also done at exit
# module-level shortcuts: kymo.log(...), kymo.finish() operate on the last run
```
Hard requirements:
* **Never block the training loop, never raise into it.** `log()` must only snapshot the dict (shallow copy) and append to a
  `collections.deque` — target ≤ 2 µs/call. All flattening (`{"eval":{"acc":1}}` → `eval/acc`), value conversion, JSON,
  compression and HTTP happen on a background daemon thread.
* **Framework-neutral.** The SDK knows nothing about any ML framework, launcher or cluster: input is a JSON-like dict of
  numbers. Values that are not plain Python numbers are converted generically on the background thread (anything with
  `__float__`, or an `.item()` returning a number — covers numpy and array-library scalars without importing them or
  naming them in docs). Converting on the background thread also means the caller never waits on a device sync.
* Batching: flush every `flush_interval` (default 1.0 s) or when ≥ `max_batch_points` buffered; gzip when body > 4 KiB.
* Retry with exponential backoff + full jitter (0.5 s → 60 s cap) on network errors / 429 / 5xx, honoring `Retry-After`;
  never retry 400/401/403 (log one warning, drop). On 413 split the batch.
* **Cache**: unsent batches stay in memory up to `max_memory_bytes` (default 256 MiB); beyond that, or when the process
  exits with unsent data, spill to disk spool `$KYMO_CACHE_DIR` (default `~/.cache/kymo/spool/`) as JSON files. Spooled
  files are replayed by any later run/process (or `python -m kymo sync`). Server upserts make replays idempotent.
* **Proxy**: honor `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (upper and lower case), like `urllib`/`requests`
  (use `urllib.request.getproxies()` / `proxy_bypass()` semantics; support CONNECT tunneling for https via proxy, and proxy
  basic-auth in the URL). Keep persistent connections (keep-alive) when possible.
* Exit: `atexit` flush with timeout `KYMO_EXIT_TIMEOUT` (default 30 s), then spool the rest; marks experiment `finished`
  (or `failed` if exiting due to an uncaught exception — use `sys.excepthook` chaining).
* Multi-process: no auto-detection of launcher env vars. Every process that calls `init()` logs. Users decide who logs
  (e.g. `kymo.init(..., enabled=(my_rank == 0))`); `enabled=False` returns a no-op run.
* Fork safety (`os.register_at_fork`): child gets a fresh, disabled-by-default background state (no deadlocked locks).
* `KYMO_DISABLED=1` → everything is a no-op. `KYMO_OFFLINE=1` → only spool to disk.
* Zero runtime dependencies (stdlib only). Python ≥ 3.9. Packaged with `pyproject.toml` (hatchling), tests with pytest.

---

## 6. Server (`server/`, Rust) — efficiency requirements

Target: tracking runs of 100B+ param LLMs — thousands of metric keys, millions of steps, many concurrent runs, each POST
maybe 100k values. Production machines are **many-core, low clock** CPUs, so:
* **No single-core bottleneck on the hot path.** Point storage is **sharded**: N shard stores (default `min(cores, 16)`,
  `KYMO_SHARDS`), shard = hash(experiment_id) % N, each with its own dedicated writer thread doing **group commit**
  (gather everything queued in ≤ 5 ms / ≤ 200k rows into one transaction), and ingest handlers await a oneshot ack.
* Suggested layout (agent may improve if it measures better): metadata in `data/meta.sqlite` (rusqlite, bundled, WAL);
  points in `data/points-<shard>.sqlite` WAL, table `points(series_id INTEGER, step INTEGER, value REAL, ts REAL,
  PRIMARY KEY(series_id, step)) WITHOUT ROWID`, `INSERT ... ON CONFLICT DO UPDATE`. `synchronous=NORMAL`, big page cache,
  `mmap_size`, prepared/cached statements.
* **In-memory series cache** for reads: columnar `Vec<i64>` steps / `Vec<f64>` values / `Vec<f64>` ts per series, LRU by
  bytes (`KYMO_CACHE_MB`, default 2048), lazily loaded from the shard, kept up to date by the writer on append (append-fast
  path when step > last step, else sorted insert/replace). Downsampling runs over memory with tight, branch-light,
  auto-vectorizable loops; multiple series in one query are processed in parallel (rayon).
* Fast JSON (`sonic-rs` or `simd-json`) on ingest, avoid per-value allocations (borrow keys, intern series ids in a
  concurrent map `(experiment_id, key) → series_id`), gzip (`flate2` w/ zlib-rs or miniz) + `zstd` request decoding.
* `mimalloc` global allocator; release profile `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`; tokio multi-thread runtime.
  Blocking SQLite work never on async worker threads (dedicated threads / `spawn_blocking`).
* Response compression (gzip/br/zstd) via `tower-http` for JSON reads; serve `KYMO_WEB_DIR` (default `../web/dist`)
  static files with SPA fallback to `index.html` for non-`/api` paths, long cache for hashed assets.
* Config by env: `KYMO_BIND` (default `0.0.0.0:8080`), `KYMO_DATA_DIR` (default `./data`), `KYMO_RP_ID`, `KYMO_ORIGIN`,
  `KYMO_WEB_DIR`, `KYMO_SHARDS`, `KYMO_CACHE_MB`, `RUST_LOG`.
* Include a load-test / benchmark binary or test (`cargo run --release --bin kymo-bench`) that reports ingest values/s and
  query latency.

## 7. Web UI (`web/`)
Vite + Preact + TypeScript + **uPlot** (canvas, fastest). Dev server on 5173 proxies `/api` → `http://localhost:8080`.
Pages: `/setup`, `/login`, `/signup?invite=`, passkey prompt/enrollment screens, `/` projects, `/p/:projectId` (experiment
table + metric grid + compare), `/e/:experimentId`, `/settings` (API tokens, passkeys, password), `/admin` (users, invites,
policy). All mutating fetches send `X-Kymo-CSRF: 1` and `credentials: "same-origin"`. Details in the web agent brief.
