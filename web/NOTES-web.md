# Kymo web UI — notes

Vite + Preact + TypeScript + uPlot. Runtime deps: `preact`, `uplot`, `lucide-preact` (icons, tree-shaken),
`@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` (self-hosted fonts). No UI kit. Hand-rolled router
(`src/router.tsx`). Chart pages, Settings and Admin are lazy-loaded chunks (`app.tsx`).

## Run

```sh
cd web
npm install
npm run mock          # mock API on :8080 (no deps). Flags: --port=N, --dist=DIR, --strict (admin passkey enforced), --fresh (setup token flow), --latency=MS
                      # e.g. node mock/server.mjs --port=8090 ; open http://127.0.0.1:8090 (127.0.0.1 keeps its cookie apart from localhost:8080)
KYMO_API=http://localhost:8090 npm run dev   # point the Vite proxy at another API
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

## UI structure (redesign)

- `src/styles/` — `tokens.css` (type scale, 4px spacing, radii, surfaces, semantic + plot colours for light and dark),
  `base.css`, `components.css`, `layout.css` (shell, palette), `plot.css`, `pages.css`. Theme = `<html data-theme>`, set
  before first paint in `index.html`, managed by `lib/theme.ts` (light / dark / system).
- `components/ui.tsx` (buttons, fields, switch, segmented, popover/menu, dialog, tabs, badges, skeletons, empty states),
  `overlay.tsx` (Escape layer stack, focus trap, toasts, confirm dialog, `[data-tip]` tooltips), `Shell.tsx` (sidebar,
  page header), `CommandPalette.tsx` (Ctrl/⌘K; pages add items via `lib/palette.ts`), `project.tsx` (cards, share dialog,
  sharing summary, role-gated actions), `ConfigView.tsx` (formatted config), `Snippets.tsx` (Python dict + curl).
- Card titles drop the first-level group prefix (`Grid.tsx: shortKey`). Roles come from `project.role` with a fallback
  (`api.ts: projectRole`) for servers that still send `shared`.
- uPlot axis/grid/cursor colours are functions reading cached CSS tokens; a theme change re-reads them and calls
  `redraw(false)` on live charts — no re-creation and no refetch.

## Layout

- `src/api.ts` — typed client. Every request: `credentials: "same-origin"`; non-GET requests send `X-Kymo-CSRF: 1`.
- `src/app.tsx` — route guard driven by `GET /api/v1/auth/state` (setup → `/setup`; no session → `/login?next=`;
  `passkey_required` → passkey prompt; `enroll_passkey` → forced enrollment; admin-only `/admin`). Any 401 or 403 with a
  `session_*` code re-fetches the auth state.
- `src/lib/webauthn.ts` — own base64url ⇄ ArrayBuffer conversion of webauthn-rs JSON (`{publicKey: …}`), null members are
  stripped before calling `navigator.credentials.create/get`.
- `src/lib/stats.ts` — pure numeric code over Float64Array: debiased EMA (zero-bias corrected), quickselect, quantiles,
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

Hover cost: mousemove is coalesced to one cursor update per animation frame (custom `cursor.bind`; mousedown/mouseup
flush a pending move so drags stay exact). Only each run's main series has a hover dot (no DOM nodes for raw/min/max).
The tooltip never reads layout during a move (overlay rect = uPlot's cached `u.rect`, own size via ResizeObserver) and
only rewrites its HTML when the content changed; `.plot-host` uses `contain: strict`. Measured on the mock (6 panels,
8 moves/frame): ~17 ms → ~0.2 ms median main-thread time per frame.

Click a card's title (or ⤢, or `f` while hovering) = fullscreen. Compare: shift-click cards (not their buttons) to pick
them in order (accent ring + number, floating hint); releasing Shift opens one fullscreen chart with every picked metric
(window blur drops the pick). A shift-*drag* on a chart is still the stats range and does not pick the card. The compare
chart draws one line per metric × run — coloured by run and dashed per metric, or coloured per metric when only one
run is selected — on one shared y axis; `RunInfo.key`/`dash` let a controller line carry its own metric. CSV export
gains a `metric` column there. The compare header's Normalize switch (persisted, `kymo:compareNorm`) rescales each line
to [0, 1] by the min/max of its plotted (smoothed) values over the loaded data; only the drawing changes — tooltip,
stats and CSV keep real values — and log-y is unavailable while it is on.

Shortcuts: `/` metric filter, `s` smoothing on/off, `l` log-y, `x` cycle x axis, `f` fullscreen the hovered chart,
`r` runs pane, `?` help, `[` sidebar, `g o / g p / g s` navigation, Esc closes the top-most layer.

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
- Smoothing runs over the plotted (possibly downsampled) points; zooming
  changes the effective smoothing window.
- Stats on downsampled data are approximate (bucket means) and flagged "≈"; zoom in for exact values.
- No run hover-highlighting across panels, no custom panel layouts/saved views.
