# Kymo web UI — notes

Vite + Preact + TypeScript + uPlot. Runtime deps: `preact`, `uplot` only. Hand-rolled router (`src/router.tsx`).

## Run

```sh
cd web
npm install
npm run mock          # mock API on :8080 (no deps). Flags: --strict (admin passkey enforced), --fresh (setup token flow), --latency=MS
npm run dev           # Vite on :5173, proxies /api -> http://localhost:8080 (mock or the real kymo-server)
npm run build         # tsc --noEmit + vite build -> web/dist (served by kymo-server with SPA fallback)
npx vitest run        # unit tests (stats/smoothing, base64url/WebAuthn conversion, store batching, formatting)
```

The mock also serves `web/dist` with SPA fallback, so `npm run build && npm run mock` and opening
http://localhost:8080 tests the production bundle. Mock test accounts: `admin / adminadmin123`, `alice / alicealice123`
(in default mode the admin is not forced to enroll a passkey so the UI can be driven by a browser without an
authenticator; `--strict` follows the spec). The mock accepts any passkey but checks that `clientDataJSON` carries the
issued challenge and the right `type`, which validates the browser-side conversion.

For the real server in dev, start it with `KYMO_ORIGIN=http://localhost:8080,http://localhost:5173` so WebAuthn accepts
the Vite origin.

## Layout

- `src/api.ts` — typed client. Every request: `credentials: "same-origin"`; non-GET requests send `X-Kymo-CSRF: 1`.
- `src/app.tsx` — route guard driven by `GET /api/v1/auth/state` (setup → `/setup`; no session → `/login?next=`;
  `passkey_required` → passkey prompt; `enroll_passkey` → forced enrollment; admin-only `/admin`). Any 401 or 403 with a
  `session_*` code re-fetches the auth state.
- `src/lib/webauthn.ts` — own base64url ⇄ ArrayBuffer conversion of webauthn-rs JSON (`{publicKey: …}`), null members are
  stripped before calling `navigator.credentials.create/get`.
- `src/lib/stats.ts` — pure numeric code over Float64Array: debiased EMA (TensorBoard formula), quickselect, quantiles,
  descriptive stats + least-squares slope, outlier-clipped range, k-way outer join of runs (`alignRuns`).
- `src/plot/store.ts` — series cache + batcher: all `get()` calls in one frame become one `POST /series/query` per
  distinct `(step window, max_points)` (≤256 series per request); in-flight dedup; LRU by point count; per-series
  versions for live invalidation.
- `src/plot/controller.ts` — owns one uPlot per panel: created when the panel is within 300 px of the viewport
  (shared IntersectionObserver), destroyed when it leaves; data/smoothing/clip changes use `setData`; only structural
  changes (run set/colours, log-y, x mode, theme) re-create it. Resizes go through a shared, debounced ResizeObserver.
- `src/plot/stats.worker.ts` + `statsClient.ts` — stats are computed inline below ~40k points, in a Web Worker above.

## Plot features

Drag = zoom (instant rescale, then refetch of the step window at ≥2000 points, i.e. full resolution for narrow
windows); double-click or ⟲ = reset. Shift-drag = stats range (highlighted band; stats table Σ uses it, else the zoom
window, else everything). Cursors are synced across panels (by x value); the hovered panel shows a tooltip with every
run's value (nearest point per run, sorted by value; raw value next to the smoothed one). Downsampled series draw the
min/max envelope as a faint band. Global toolbar: regex key filter, EMA smoothing, x = step / wall time / relative
time, log-y, outlier clipping (top/bottom p%), resolution (max_points), live. Per panel: log-y, smoothing override,
stats table, expand, CSV (as plotted) / PNG export, links to full-resolution `/series/raw` CSV per run.

Live mode (default on, persisted): every 5 s, for the selected *running* experiments (plus one extra poll after a run
stops) the UI calls `GET /experiments/{id}/metrics` and invalidates only series whose `last_step` changed; visible
panels refetch those series (batched into one request), off-screen panels refetch when they scroll into view. The
experiment list is polled at the same interval while any experiment is running; metric keys every 30 s.

Per-browser state in localStorage: selection, colours, sort, config columns, filter, collapsed groups, plot settings,
sidebar width.

## Assumptions about the server beyond SPEC.md

- Timestamps (`created_at`, `updated_at`, `last_activity`, `expires_at`, …) may be RFC3339 strings or unix seconds;
  both are handled. `ts`/`last_ts` in series are unix seconds (float).
- `GET /experiments/{id}` includes `notes` (the UI edits it via PATCH). The list endpoint may omit it.
- `POST /admin/users/{id}/reset-password` returns at least `{url}`.
- Passkey finish payloads send `extensions: {}` (as in the spec) rather than `getClientExtensionResults()`; `transports`
  is sent when the browser provides it. `userHandle` is base64url or `null`.
- 403 responses caused by an incomplete session use a `code` starting with `session_` (e.g. `session_enroll_passkey`)
  — the UI then re-reads `/auth/state`. Any 401 does the same. (Not required: the guard already routes by state.)
- In downsampled responses `step` is the first step of a bucket and `ts` the last ts; zooming in wall/relative-time mode
  maps the selected time range back to steps using those arrays (with one bucket of padding).
- Relative time uses the first `ts` of an unzoomed series per run (fallback: experiment `created_at`).
- `ts` is assumed non-decreasing with step (needed for the wall/relative time axes).
- Runs that do not have a metric key simply return `total: 0` / empty arrays in `/series/query` (no error).
- `/series/raw` is reachable with the session cookie via a plain `<a download>` GET.

## Not done / limitations

- Real WebAuthn ceremonies were only exercised with a stubbed `navigator.credentials` (the test browser has no
  authenticator); the conversion helpers are unit-tested and the mock verifies challenge/type round-trips.
- Smoothing runs over the plotted (possibly downsampled) points, like TensorBoard does over its sampled points; zooming
  changes the effective smoothing window.
- Stats on downsampled data are approximate (bucket means) and flagged "≈"; zoom in for exact values.
- No run hover-highlighting across panels, no custom panel layouts/saved views.
