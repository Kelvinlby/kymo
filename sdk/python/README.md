# kymo — Python SDK

You hand kymo a dict of numbers and it gets them to a [Kymo](../../SPEC.md) server, without slowing down or crashing the loop that produced them.

* `run.log()` costs well under a microsecond: it shallow-copies your dict and appends it to a deque. Nothing else happens on your thread.
* Flattening, value conversion, JSON, gzip, HTTP, retries and the disk spool all run on background daemon threads.
* Nothing in this package raises into your code. Problems are reported as warnings on the `kymo` logger.
* There are no runtime dependencies (stdlib only), and it needs Python ≥ 3.9. kymo works with any framework, because it doesn't know about any of them.

```bash
pip install ./sdk/python        # or: uv pip install ./sdk/python
export KYMO_HOST=https://kymo.example.com
export KYMO_API_KEY=kymo_...    # create one in the web UI: Settings → API tokens
```

The distribution is named `kymo-logger` (the PyPI name `kymo` belongs to an unrelated project); you still `import kymo`. To depend on it from another uv project straight from GitHub:

```toml
[project]
dependencies = ["kymo-logger"]

[tool.uv.sources]
kymo-logger = { git = "https://github.com/Kelvinlby/kymo", subdirectory = "sdk/python", branch = "main" }
```

or, pip-compatible: `"kymo-logger @ git+https://github.com/Kelvinlby/kymo.git@main#subdirectory=sdk/python"`. Run `uv lock --upgrade-package kymo-logger` to pick up newer commits.

## Usage

```python
import kymo

run = kymo.init(project="llm-pretrain", experiment="lr3e-4", config={"lr": 3e-4, "model": {"d": 4096}})
for step in range(1000):
    loss = 2.3 / (step + 1)
    run.log({"train/loss": loss, "lr": 3e-4, "eval": {"acc": 0.71, "loss": 2.4}}, step=step)
run.finish()   # optional: also done automatically at exit
```

* **Keys.** Nested dicts become `/`-separated keys: the dict above logs `train/loss`, `lr`, `eval/acc` and `eval/loss`. The UI groups keys by the part before the first `/`.
* **Values.**
  * Accepted:
    * ints and floats
    * bools, sent as 0/1
    * NaN and ±Inf, sent as `"NaN"` / `"Infinity"` / `"-Infinity"`
    * any object whose `.item()` returns a number
    * any object with `__float__`
  * Conversion happens later, on the background thread, so a value that is slow to read never blocks you.
  * Strings, `None` and other non-numeric values are dropped, with one warning per key.
* **`step`** is optional. If you leave it out, it auto-increments (one past the previous step).
* **`config`** is any JSON-like dict. It is sent once at `init` and shallow-merged into the experiment's config on the server.
* **Shortcuts.** Module-level `kymo.log(...)`, `kymo.flush()` and `kymo.finish()` act on the most recent run.
* **Context manager.** `with kymo.init(...) as run:` marks the run `failed` if the block raises. Otherwise, at exit the run is marked `finished`, or `failed` when the interpreter exits because of an uncaught exception.

### Logging from just one process

Every process that calls `kymo.init` logs. kymo does not inspect any launcher environment variables. When several workers run the same script, decide yourself who logs:

```python
run = kymo.init(project="p", experiment="e", enabled=(worker_id == 0))
run.log({"loss": 1.2})   # a no-op on the other workers; no `if` needed around each call
```

To log from every worker, give each one its own experiment name or key prefix, e.g. `{f"worker{worker_id}/loss": ...}`.

After `os.fork()` the child's inherited runs turn into no-ops. The child can call `kymo.init` again to start its own run.

## Offline use and the disk spool

* **Retries.** Network errors, 429 and 5xx are retried with exponential backoff and full jitter (0.5 s doubling to a 60 s cap), honoring `Retry-After`.
* **No retry.** 400/401/403 are never retried: kymo logs one warning and drops the batch.
* **413.** The batch is split in half and resent.
* **Memory, then disk.** Unsent batches stay in memory up to `max_memory_bytes` (256 MiB by default). Beyond that, they spill to the spool directory (`KYMO_CACHE_DIR`).
* **Exit.** kymo flushes for up to `KYMO_EXIT_TIMEOUT` seconds, then writes whatever is left to the spool.
* **Replay.** Spooled files are replayed automatically by the next run that uses the same host and token. Replays are idempotent, because the server upserts by `(key, step)`.

```bash
python -m kymo sync             # replay the spool now (uses KYMO_HOST / KYMO_API_KEY)
python -m kymo sync --dry-run   # just list what would be sent; also --dir, --all-hosts, --host, --api-key
```

On a machine without network access, set `KYMO_OFFLINE=1`; everything goes to the spool. Later, copy the spool directory to a machine that can reach the server and run `python -m kymo sync` there, with `KYMO_CACHE_DIR` pointing at the copy. Without an API key, kymo also runs offline instead of losing data.

## Proxies

Proxy settings come from `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`, in upper or lower case. kymo uses the same rules as `urllib.request.getproxies()` and `proxy_bypass()`; `ALL_PROXY` is used as a fallback.

* **Plain http:** requests go through the proxy with an absolute-URI request line.
* **https:** kymo opens a `CONNECT` tunnel. TLS runs end to end, and the certificate is verified against the real server name.
* **Credentials:** `http://user:pass@proxy:3128` is sent as `Proxy-Authorization: Basic`. Percent-encode special characters, e.g. `@` → `%40`.
* **Connections:** both modes keep the connection alive between batches.
* **SOCKS:** SOCKS proxies are not supported. kymo connects directly and logs a warning.

```bash
export HTTPS_PROXY=http://alice:s3cr%40t@proxy.corp:3128
export NO_PROXY=localhost,127.0.0.1,.internal
```

## Configuration

| env var | default | meaning |
|---|---|---|
| `KYMO_API_KEY` | – | API token (`kymo_...`). Without one, the run is offline and spools to disk. |
| `KYMO_HOST` | `http://localhost:8080` | server URL; a path prefix is allowed |
| `KYMO_DISABLED` | – | `1` makes everything a no-op |
| `KYMO_OFFLINE` | – | `1` only spools to disk |
| `KYMO_CACHE_DIR` | `~/.cache/kymo/spool` | spool directory |
| `KYMO_EXIT_TIMEOUT` | `30` | seconds to flush at exit before spooling the rest |
| `KYMO_HTTP_TIMEOUT` | `60` | socket read timeout per request (the connect timeout is 10 s) |
| `KYMO_CA_BUNDLE` | – | CA file for https (`SSL_CERT_FILE` also works) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | – | proxies (see above) |

`kymo.init` takes these keyword arguments:

* `project` and `experiment` (if `experiment` is omitted, it defaults to `<hostname>-<timestamp>`)
* `config`, `api_key`, `host`
* `enabled` (default `True`)
* `offline`
* `flush_interval` (default 1.0 s)
* `max_batch_points` (default 10 000)
* `max_memory_bytes` (default 256 MiB)

`log()` takes a *shallow* copy. If you mutate a nested dict right after logging it, the background thread may see the new values.

## No SDK needed

The SDK is a convenience. Anything that can send an HTTP POST can log to the ingest endpoint directly. The single-point shorthand puts `metrics` at the top level. `step` is optional; if you leave it out, the server assigns the next step for that experiment.

```bash
curl -sS https://kymo.example.com/api/v1/ingest \
  -H "Authorization: Bearer $KYMO_API_KEY" -H "Content-Type: application/json" \
  -d '{"project":"p","experiment":"e","metrics":{"loss":1.2}}'
```

The full form sends many points per request, along with optional config and status:

```bash
curl -sS https://kymo.example.com/api/v1/ingest \
  -H "Authorization: Bearer $KYMO_API_KEY" -H "Content-Type: application/json" \
  -d '{"project":"p","experiment":"e","config":{"lr":0.0003},"status":"running",
       "points":[{"step":1,"ts":1732400000.1,"metrics":{"train/loss":2.31,"lr":0.0003}},
                 {"step":2,"metrics":{"train/loss":2.12,"grad_norm":"NaN"}}]}'
```

The project and experiment are created automatically. Values are JSON numbers, with `"NaN"` / `"Infinity"` / `"-Infinity"` as strings. You can also gzip the body and send `Content-Encoding: gzip`. A 200 response means the data is durably stored. See SPEC §3 for the details.

## Development

```bash
cd sdk/python
uv run --with pytest pytest -q        # tests (fake ingest server, proxy and hanging server are in tests/fakes.py)
uv run python bench/bench_log.py      # hot-path benchmark
```
