# NOTES — Python SDK (`sdk/python`, package `kymo`)

## Layout

| path | what it does |
|---|---|
| `src/kymo/__init__.py` | public API: `init`, `log`, `flush`, `finish`. Also the atexit hook, chained excepthook, fork handler and the `enabled=` switch. |
| `src/kymo/_run.py` | `Run` (hot-path `log()`, plus the `kymo-collector` thread that converts and batches) and `NoopRun` |
| `src/kymo/_sender.py` | `Batch`, the memory-capped `Outbox`, and the `kymo-sender` thread (retry, backoff, 413 split, spool replay) |
| `src/kymo/_transport.py` | keep-alive `http.client` connection, proxy resolution, CONNECT tunnel, proxy basic auth |
| `src/kymo/_spool.py` | disk spool: atomic writes, claim-by-rename, replay matching |
| `src/kymo/_encode.py` | flattening, value conversion, JSON/gzip |
| `src/kymo/__main__.py` | `python -m kymo sync` |
| `tests/` | pytest suite. `tests/fakes.py` has the fake ingest server, the forwarding/CONNECT proxy and the hanging server. |
| `bench/bench_log.py` | hot-path benchmark |

## Data flow

1. **Training thread.** `run.log(d, step)` runs `self._push((step, time(), d.copy()))`, where `_push` is the bound `deque.append`. Nothing else happens there. When the run finishes, or in a forked child, `_push` is swapped for a no-op, so the hot path has no flag checks.
2. **`kymo-collector`.** Every 50 ms it drains the deque. For each entry it flattens the dict, converts values generically (plain numbers and bools, then `.item()` returning a number, then `__float__`) and validates keys, then appends a point to the current batch. A batch is closed at `flush_interval` (1 s), at `max_batch_points` (10 000 points) or at 250 000 values. Closing a batch JSON-encodes it, gzips it if it is over 4 KiB, and puts it into the outbox. The collector calls `sleep(0)` every 512 entries to release the GIL. `flush()` and `finish()` only *ask* the collector to drain, so `.item()` / `__float__` never run on the caller's thread.
3. **Outbox.** A FIFO of encoded batches, capped at `max_memory_bytes` of wire bytes. Batches that overflow the cap go to the spool.
4. **`kymo-sender`.**
   * Posts batches one at a time over a single keep-alive connection.
   * If a reused connection turns out to be stale, it reconnects once immediately.
   * When the outbox is empty, it claims spool files that match this host and token and replays them.

## Benchmark (`uv run python bench/bench_log.py`, AMD Ryzen 5 9600X, Linux)

Per-call cost of `run.log(d)` for a 10-key flat dict. The fake ingest server runs in a separate process, so the background threads really encode and POST while the loop runs and compete for the GIL. Each figure is the median and minimum over 7 rounds of 200 000 calls.

| case | Python 3.14.8 median / min (µs) | Python 3.9.25 median / min (µs) |
|---|---|---|
| empty loop | 0.004 / 0.004 | 0.007 / 0.007 |
| baseline `deque.append((i, time(), d.copy()))` | 0.33 / 0.31 | 0.37 / 0.33 |
| `run.log(d10, step=i)` | **0.93 / 0.39** | 0.83 / 0.50 |
| `run.log(d10)` | 0.79 / 0.33 | 0.82 / 0.50 |
| `run.log(nested, 10 values)` | 0.88 / 0.32 | 1.43 / 0.60 |
| `kymo.log(d10)` | 1.02 / 0.21 | 0.92 / 0.37 |

The target was ≤ 2 µs per call, and it is met.

* **Median vs. minimum.** The minimum is the uncontended cost. The gap up to the median is the GIL being held by the background thread while it converts the 200 000 entries just queued.
* **Background throughput.** About 165k points/s of 10-key points through convert, JSON, gzip, POST and ack on 3.14, and about 67k/s on 3.9.
* **Hanging server.** In `test_training_thread_never_waits_on_hanging_server`, 100 000 `log()` calls against a server that accepts and never answers take about 0.04 s (0.4 µs per call). `finish(timeout=1)` then returns in about 1 s, and all 100 000 points end up in the spool.

## Deviations and additions to SPEC §3 and §5

All of these are backward compatible.

### What the server must accept

1. **Hello request.** `init()` immediately sends a request with `points: []` that carries `status: "running"`, `host` and `config`, so the experiment shows up before the first metric. The final status (`finished` or `failed`) also goes out as its own request with `points: []`. **The server must accept an empty `points` array.**
2. **`seq`.** `seq` is per request. When a batch is split after a 413, both halves keep the original `seq` (the field is informational).

### Status codes

3. **Not retried.** 400, 401, 403 and every other 4xx except 407, 408, 413, 425 and 429 cause one warning, and the batch is dropped.
   * After a 401 or 403, the sender stops replaying the spool for the rest of that process. The spool files are kept.
   * 3xx responses are dropped too.
4. **Retried.** 407 (proxy auth) is retried with backoff and a warning. It is a proxy problem, not the server rejecting the data.
5. **413 split.** A 413 on a single point with many metrics splits the point's metrics dict. A single value that still gets 413 is dropped.
6. **Client-side size cap.** Requests are capped at 10 000 points or 250 000 values, well under the server's 1M values / 64 MiB limit, so a 413 should be rare.

### Exit and finishing

7. **Early give-up.** While finishing, the sender gives up after 3 consecutive failures, or as soon as the next backoff would pass the deadline. It then spools the rest instead of always waiting the full `KYMO_EXIT_TIMEOUT` when the server is plainly down.
   * If a request is stuck on a hanging socket, `finish()` returns at the deadline and shuts the socket down.
   * A batch that was still in flight is spooled as well. If the server later commits it, the replay is a harmless duplicate because ingest upserts.
8. **Exit status.** `failed` is set only through `sys.excepthook` (uncaught exceptions, including `KeyboardInterrupt`). `sys.exit(1)` does not call the excepthook, so the run is marked `finished`. `Run` can also be used as a context manager (`failed` if the block raises) and has `finish(status=...)`.

### Disk spool

9. **File format.** Each spool file is JSON: `{"kymo_spool":1,"host":…,"token":<sha256(api_key)[:16] | "anon">,"created":…,"body":<ingest body>}`.
   * The file name encodes host and token hashes, so replayers pick their own files without opening them.
   * The token itself is never written to disk.
   * Files from a run without an API key (`anon`) are replayed with whichever key the replayer has.
   * Claiming works by atomic rename to `*.claimed.<pid>`. Claims left by dead PIDs are recovered.
10. **No resurrected runs.** A `"status":"running"` is removed from any spooled body. Otherwise a late replay could flip an experiment that has finished back to running.

### Init defaults and validation

* **Multi-process: no launcher detection.** No environment variables are inspected to decide who logs; every process that calls `init()` logs. `kymo.init(..., enabled=False)` returns a `NoopRun`. There is no per-process key prefix (updated SPEC §5).

11. **No API key.** If no key is found, kymo warns and runs **offline**, so data goes to the spool instead of being rejected with 401 and lost. An invalid `KYMO_HOST` also forces offline mode.
12. **Bad names.** Invalid project names are sanitized (characters outside `[A-Za-z0-9_.-]` become `-`, truncated to 64) with a warning instead of raising. A job that has waited hours in a queue should not die on a typo.
13. **Experiment name.** `experiment` is optional and defaults to `<hostname>-<YYYYmmdd-HHMMSS>`. Names are truncated to 128 characters.

### Proxies

14. **`ALL_PROXY` fallback.** `ALL_PROXY` is used when `<scheme>_proxy` is unset. That matches curl and requests; urllib's own `ProxyHandler` ignores it.
15. **Proxy schemes.**
    * The connection to the proxy is always plaintext, even for `https://` proxy URLs. This matches urllib.
    * A scheme-less value such as `host:3128` is accepted.
    * SOCKS proxies are unsupported. kymo warns and connects directly.

### Extra environment variables and API

16. **Environment variables.** `KYMO_HTTP_TIMEOUT` (60 s read timeout; connect is 10 s) and `KYMO_CA_BUNDLE` (a custom CA for https; `SSL_CERT_FILE` also works through OpenSSL's defaults).
17. **API additions.**
    * `run.flush(timeout) -> bool` and `kymo.flush()` block until everything logged so far is acknowledged.
    * `log()` after `finish()` is a silent no-op.
    * `step` may be any object with `.item()` or `__int__`; it is converted on the background thread.
18. **Value conversion.**
    * Ints outside the i64 range are sent as floats.
    * Subclasses of `int`/`float`, objects whose `.item()` returns a number, and anything with `__float__` (`Fraction`, `Decimal`, ...) are accepted. The SDK imports and names no third-party library.
    * Values in `config` that are not finite are encoded as `"NaN"` / `"Infinity"` strings, and objects that can't be serialized are encoded with `str()`.

### Known limits

19. **Memory cap.** The cap counts encoded wire bytes in the outbox, not the raw dicts still waiting in the deque. The deque is unbounded, but the collector drains it every 50 ms.
20. **Shallow copy.** `log()` copies only the top-level dict, as the spec says. If a nested dict is mutated after `log()`, the background thread may see the new values.
21. **GIL.** The collector holds the GIL while it converts values. It yields every 512 entries, and zlib releases the GIL while compressing. At realistic logging rates (≤ 1000 calls/s) its CPU share is negligible.

## Integration fix: chunked JSON encoding (added during end-to-end testing)

`json.dumps` of a whole batch (up to 250k values) is one C call that holds the GIL ~35 ms, which
stalled a pure-Python training loop by up to 76 ms in the e2e run. `encode_body` now encodes points
64 at a time (same total CPU, ~0.2 ms per call, byte-identical output) and feeds gzip in 64 KiB pieces.
Worst training-thread stall is now ≈ the 5 ms GIL switch interval. Covered by `tests/test_encode_chunked.py`.
