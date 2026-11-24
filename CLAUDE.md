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

Version `X.Y.Z`, tag `vX.Y.Z`:

1. Bump the version everywhere (same 7 files each release):
   - `sdk/python/pyproject.toml`, `sdk/python/src/kymo/_version.py`, `server/Cargo.toml`
   - `cd web && npm version X.Y.Z --no-git-tag-version` (package.json + lock)
   - `cd server && cargo update -p kymo-server --offline`; `cd sdk/python && uv lock`
2. Build the web UI: `cd web && npm run build`.
3. Build the server in Docker on bookworm so it needs only glibc ≥ 2.34 (no musl). Mount the repo root, since `backup.rs` does `include_str!` on `BACKUP-FORMAT.md`:
   ```bash
   docker run --rm -u $(id -u):$(id -g) -e CARGO_HOME=/cargo -v $HOME/.cargo/registry:/cargo/registry \
     -v $PWD:/repo -e CARGO_TARGET_DIR=/repo/server/target/bookworm -w /repo/server \
     rust:1.100-bookworm cargo build --release --locked
   ```
4. Package `kymo-X.Y.Z-x86_64-linux.tar.gz` holding a top-level `kymo-X.Y.Z-x86_64-linux/` dir with: `kymo-server` (stripped), `web/` (= `web/dist`), `README.md`, `SPEC.md`, `BACKUP-FORMAT.md`. Write `sha256sum` output to `<tarball>.sha256`.
5. Commit `Release X.Y.Z`, tag `vX.Y.Z`, push the commit and the tag.
6. `gh release create vX.Y.Z --verify-tag --title vX.Y.Z` with notes (Highlights + Assets, as in earlier releases), uploading the tarball and its `.sha256`.
   The tag push also runs `.github/workflows/publish.yml`: it tests the SDK, publishes `kymo-logger` to PyPI, and attaches the wheel and sdist to the same release. If the tag doesn't match `pyproject.toml`, it fails.
