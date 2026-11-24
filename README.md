# Kymo

Self-hosted ML experiment tracking: **Project › Experiment › Metric**, a non-blocking Python logger,
a sharded Rust backend built for many-core / low-clock servers, and a uPlot web UI.

| Part | Path | Docs |
|---|---|---|
| Server (Rust, axum, sharded SQLite + in-memory columnar cache) | `server/` | [server/NOTES-server.md](server/NOTES-server.md) |
| Python SDK `kymo` (stdlib only) | `sdk/python/` | [sdk/python/README.md](sdk/python/README.md), [NOTES-sdk.md](sdk/python/NOTES-sdk.md) |
| Web UI (Preact + uPlot) | `web/` | [web/NOTES-web.md](web/NOTES-web.md) |
| API contract | | [SPEC.md](SPEC.md) |
| End-to-end test | `e2e/` | below |

## Run it

```bash
cd web && npm install && npm run build && cd ..
cd server && cargo build --release && cd ..
KYMO_DATA_DIR=./data KYMO_WEB_DIR=./web/dist KYMO_ORIGIN=http://localhost:8080 ./server/target/release/kymo-server
```

On first start the server prints `KYMO SETUP TOKEN: … open http://localhost:8080/setup?token=…`
(also in `data/setup_token`). Open it, create the admin, and register a passkey (mandatory for the admin).
For a real deployment put it behind HTTPS and set `KYMO_RP_ID=kymo.example.com`,
`KYMO_ORIGIN=https://kymo.example.com`; passkeys only work on `localhost` or HTTPS.

* Users join only through invite links the admin creates under **Admin → Invites**; there is no public signup.
* **Admin → Policy** can require passkeys for every user; otherwise they are optional, and anyone who has one must use it.
* Each user creates API tokens under **Settings → API tokens**.

## Log from training

```python
import kymo  # pip install ./sdk/python
run = kymo.init(project="llm-pretrain", experiment="7b-lr3e-4", config={"lr": 3e-4})  # KYMO_API_KEY, KYMO_HOST from env
for step in range(steps):
    run.log({"train": {"loss": loss}, "lr": lr}, step=step)   # ~0.3–1 µs, never blocks or raises
```

Nested dicts become `train/loss`. GPU tensors are converted on the background thread, so `log()` never forces a CUDA sync.
Failed sends retry with backoff, then spill to `~/.cache/kymo/spool` and replay later (`python -m kymo sync`).
`HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY` are honored. Only rank 0 logs by default.

## Tests

```bash
cd server && cargo test
```

```bash
cd sdk/python && uv run --with pytest pytest -q
```

```bash
cd web && npx tsc --noEmit && npx vitest run
```

The end-to-end test needs a **fresh** server. It runs real passkey ceremonies with a software authenticator,
4 concurrent SDK training processes, permission checks and the site policy:

```bash
uv run --with requests,cbor2,cryptography python e2e/e2e.py --setup-token-file ./data/setup_token
```

## Measured performance (dev box: Ryzen 9600X, 12 threads)

| | |
|---|---|
| Server ingest | ~8M values/s (200M values, 20 runs × 200 keys) |
| Plot query, 20 series × 1M points, downsampled | p50 2.9 ms, p99 3.3 ms |
| Concurrent plot queries | 19k queries/s |
| SDK `log()` (10 keys) | p50 0.2 µs, p99.9 ~5 µs |
| Worst training-thread stall from the SDK | ≈ Python's 5 ms GIL switch interval |
