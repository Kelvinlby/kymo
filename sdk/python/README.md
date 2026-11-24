# kymo — Python SDK

Logs training metrics to a [Kymo](../../SPEC.md) server without ever slowing down or crashing your training loop.

* `run.log()` costs well under a microsecond: it shallow-copies your dict and appends it to a deque. Nothing else happens on your thread.
* Tensor `.item()` calls, flattening, JSON, gzip, HTTP, retries and the disk spool all run on background daemon threads.
* Nothing in this package raises into your code. Problems are reported as warnings on the `kymo` logger.
* There are no runtime dependencies (stdlib only), and it needs Python ≥ 3.9.

```bash
pip install ./sdk/python        # or: uv pip install ./sdk/python
export KYMO_HOST=https://kymo.example.com
export KYMO_API_KEY=kymo_...    # create one in the web UI: Settings → API tokens
```

## Usage

```python
import kymo

run = kymo.init(project="llm-pretrain", experiment="7b-lr3e-4", config={"lr": 3e-4, "model": {"d": 4096}})
for step in range(1000):
    run.log({"train/loss": 2.3, "lr": 3e-4, "eval": {"acc": 0.71}}, step=step)   # eval/acc
run.finish()   # optional: also done automatically at exit
```

* If you leave out `step`, it auto-increments (one past the previous step).
* Nested dicts are flattened with `/`.
* Values can be ints, floats, bools (sent as 0/1), NaN/±Inf, or anything with a scalar `.item()` (torch / JAX / numpy).
* Strings and other non-numeric values are dropped, with one warning per key.
* Module-level shortcuts act on the most recent run: `kymo.log(...)`, `kymo.flush()`, `kymo.finish()`.
* You can use the run as a context manager: `with kymo.init(...) as run:` marks it `failed` if the block raises.

### Minimal PyTorch loop

```python
import torch, kymo

model = torch.nn.Linear(10, 1).cuda()
opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
run = kymo.init(project="demo", experiment="linear-adamw", config={"lr": 3e-4, "batch": 64})

for step in range(10_000):
    x = torch.randn(64, 10, device="cuda")
    loss = model(x).pow(2).mean()
    opt.zero_grad(set_to_none=True)
    loss.backward()
    gn = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    opt.step()
    # Pass the tensors themselves: no .item() here, so no GPU sync in the training loop.
    # kymo calls .item() later on its background thread.
    run.log({"train/loss": loss.detach(), "train/grad_norm": gn, "lr": opt.param_groups[0]["lr"]}, step=step)
```

Pass `loss.detach()`, not `loss`, so the autograd graph isn't kept alive until the background thread converts it.

### Distributed training

By default only global rank 0 logs. The rank is read from `RANK`, falling back to `SLURM_PROCID`, then `OMPI_COMM_WORLD_RANK`; unset counts as rank 0. Other ranks get a no-op run, so you can call `kymo.init` and `run.log` everywhere without `if rank == 0` guards. `kymo.init(..., all_ranks=True)` logs from every rank, prefixing keys with `rank{N}/`.

### When the server is unreachable

* Network errors, 429 and 5xx are retried with exponential backoff and full jitter (0.5 s doubling to a 60 s cap), honoring `Retry-After`.
* 400/401/403 are never retried: kymo logs one warning and drops the batch.
* On 413 the batch is split in half and resent.
* Unsent batches stay in memory up to `max_memory_bytes` (256 MiB by default); after that they spill to the disk spool.
* At exit, kymo flushes for up to `KYMO_EXIT_TIMEOUT` seconds, then writes whatever is left to the spool.
* Spooled files are replayed automatically by the next run that uses the same host and token. You can also replay them by hand:

```bash
python -m kymo sync             # uses KYMO_HOST / KYMO_API_KEY; --dry-run lists files, --all-hosts, --dir
```

Offline clusters: set `KYMO_OFFLINE=1` to write everything to the spool, then run `python -m kymo sync` from a machine that can reach the server. Make sure `KYMO_CACHE_DIR` points to the spool directory on that machine.

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
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | – | proxies, upper or lower case, same semantics as `urllib` (see below) |

`kymo.init` keyword arguments are `project`, `experiment`, `config`, `api_key`, `host`, `all_ranks`, `offline`, `flush_interval` (1.0 s), `max_batch_points` (10 000) and `max_memory_bytes` (256 MiB).

### Proxies

Proxy settings follow `urllib.request.getproxies()` and `proxy_bypass()`; `ALL_PROXY` is used as a fallback.

* **Plain http:** requests go through the proxy with an absolute-URI request line.
* **https:** kymo opens a `CONNECT` tunnel. TLS runs end to end, and the certificate is verified against the real server name.
* **Credentials:** `http://user:pass@proxy:3128` is sent as `Proxy-Authorization: Basic`. Percent-encode special characters, e.g. `@` → `%40`.
* **Connections:** both modes keep the connection alive between batches.
* **SOCKS:** SOCKS proxies are not supported. kymo connects directly and logs a warning.

### Other behavior

* **Fork safety:** after `os.fork()` the child's inherited runs turn into no-ops. The child can call `kymo.init` again to start its own run.
* **Run status:** at exit the run is marked `finished`, or `failed` if the interpreter is exiting because of an uncaught exception. kymo detects that through a chained `sys.excepthook`, and any hook you installed earlier still runs.
* **Nested dicts:** `log()` takes a *shallow* copy. If you mutate a nested dict right after logging it, the background thread may see the new values.

## Development

```bash
cd sdk/python
uv run --with pytest pytest -q        # tests (fake ingest server, proxy and hanging server are in tests/fakes.py)
uv run python bench/bench_log.py      # hot-path benchmark
```
