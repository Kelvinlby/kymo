# Kymo

Self-hosted ML experiment tracking platform. See [README.md](README.md) for layout and [SPEC.md](SPEC.md) for the API contract.

## Workflow

- Commit and push whenever you think it is necessary (e.g. after a coherent, working change). No need to ask first.

## Product goals

Every change should serve these goals:

- **Framework-neutral.** Kymo is not part of the PyTorch ecosystem. It must work the same with any ML framework (PyTorch, JAX, TensorFlow, MLX, plain NumPy, …). The SDK must not depend on or assume any framework.

- **Modern look.** The web UI should look clean and current.
- **High performance.**
  - The Python SDK logs without blocking: `log()` must never stall the training loop.
  - It must scale to tera-scale LLM training runs (huge metric volumes, many steps, many experiments).
  - The web UI renders charts very fast, even for large series.
  - Logged data shows up live in the UI.
- **Efficiency.** The whole stack should run comfortably on a modest server. Reference point: a normal 4-core / 8 GB VPS with 1st/2nd-gen Xeon CPUs. This shows the efficiency we expect; don't tune specifically for that hardware.
- **Security for a multi-user system.**
  - User management.
  - Project sharing between users, with proper access control.
  - API tokens to authenticate the logging SDK.

## Releasing

Releases are one click: GitHub → Actions → **publish** → Run workflow on `main`, enter the version `X.Y.Z` (optionally Highlights markdown; empty = commit list since the last tag). Or:

```bash
gh workflow run publish.yml -f version=X.Y.Z -f highlights="- **Thing.** What changed."
```

`.github/workflows/publish.yml` then bumps the version in all 7 files (`sdk/python/pyproject.toml`, `sdk/python/src/kymo/_version.py`, `sdk/python/uv.lock`, `server/Cargo.toml`, `server/Cargo.lock`, `web/package.json`, `web/package-lock.json`). It tests the SDK, builds the web UI and builds the server in `rust:1.100-bookworm` (so it needs only glibc ≥ 2.34, no musl). It packages `kymo-X.Y.Z-x86_64-linux.tar.gz` + `.sha256`, then commits `Release X.Y.Z`, tags `vX.Y.Z` and pushes. Last, it publishes `kymo-logger` to PyPI (Trusted Publishing, bound to this file name and the `pypi` environment) and creates the GitHub release with notes (Highlights + Assets) and every file attached. Nothing is pushed until all builds pass. Do not bump versions or tag by hand; after the run, `git pull`.

To build the server locally the same way (mount the repo root, since `backup.rs` does `include_str!` on `BACKUP-FORMAT.md`):
```bash
docker run --rm -u $(id -u):$(id -g) -e CARGO_HOME=/cargo -v $HOME/.cargo/registry:/cargo/registry \
  -v $PWD:/repo -e CARGO_TARGET_DIR=/repo/server/target/bookworm -w /repo/server \
  rust:1.100-bookworm cargo build --release --locked
```
