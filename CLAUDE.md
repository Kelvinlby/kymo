# Kymo

Self-hosted ML experiment tracking platform. See [README.md](README.md) for layout and [SPEC.md](SPEC.md) for the API contract.

## Workflow

- Commit and push whenever you think it is necessary (e.g. after a coherent, working change). No need to ask first.

## Product goals

Every change should serve these goals:

- **Modern look.** The web UI should look clean and current.
- **High performance.**
  - The Python SDK logs without blocking: `log()` must never stall the training loop.
  - It must scale to terabyte-size LLM training runs (huge metric volumes, many steps, many experiments).
  - The web UI renders charts very fast, even for large series.
  - Logged data shows up live in the UI.
- **Efficiency.** The whole stack should run comfortably on a modest server. Reference point: a normal 4-core / 8 GB VPS with 1st/2nd-gen Xeon CPUs. This shows the efficiency we expect; don't tune specifically for that hardware.
- **Security for a multi-user system.**
  - User management.
  - Project sharing between users, with proper access control.
  - API tokens to authenticate the logging SDK.
