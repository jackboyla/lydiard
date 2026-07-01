# Lydiard Progress

## Ongoing Instructions

- Keep this progress file updated as product decisions, implementation details, and outstanding tasks change.
- Maintain a concise conversation log so the current direction survives context loss.
- Preserve the user's intent that insights should be personalized to the runner, not based on generic population averages.
- Agent-made commits should use Jack Boylan's configured git identity and must not include agent co-author trailers.

## Conversation Log

- 2026-06-10: User wants a running companion/analysis app inspired by the provided fatigue indicator and trend screenshots. It should use Strava or Garmin Connect data, whichever is easiest and most useful, and should identify fatigue traps using insights relative to the user's own history.
- 2026-06-10: Built a first React/Vite dashboard using sample Strava-ready weekly history. Researched official Strava and Garmin developer docs. Chose Strava as the MVP connector path because it has a public OAuth API and single-athlete development mode; Garmin remains a later richer connector because official activity/health APIs require approval and may involve commercial licensing.
- 2026-06-10: Implemented personalized fatigue analysis with rolling baselines for stride length, HR-pace decoupling, easy pace at fixed HR, LT2 estimate, acute/chronic load, and recovery floor. Current sample week is intentionally flagged as "Fatigue trap likely" to exercise the target scenario.
- 2026-06-11: User asked to use real data. Added browser-local CSV import for Strava bulk export `activities.csv`, Garmin Connect activity CSV, and generic activity CSVs. Imported data now replaces the sample dataset and persists in local storage.
- 2026-06-11: The importer derives weekly blocks from activity rows: distance, duration, training load, acute/chronic ratio, easy pace, threshold proxy, cadence-derived stride, aerobic-cost proxy, long run, and quality-session count. Summary CSV cannot provide true stream decoupling, so the app now labels that signal honestly as a proxy after CSV import.
- 2026-06-11: User asked to use Strava login instead of bulk downloads. Added a local Express OAuth backend, Strava auth URL/callback/token refresh/status/disconnect routes, Strava summary activity sync, Vite `/api` proxy, and frontend Connect Strava / Sync Strava controls.
- 2026-06-11: User asked how to collect HRV/sleep data after the importer warned that recovery is neutral. Current importer only activates recovery when activity rows include recognized HRV or sleep columns; a proper standalone health-data import remains a product gap.
- 2026-06-11: User challenged whether fatigue should depend on sleep data. Clarified that the model should primarily deduce fatigue from run data, with sleep/HRV only as a low-weight supporting recovery signal.
- 2026-06-11: User asked for the weekly volume chart to switch between weekly mileage and time, and for the UI to default to dark theme.
- 2026-06-11: Added a weekly volume `Mileage` / `Time` toggle to the load story chart, darkened the default UI palette, and updated chart colors/tooltips for the dark theme.
- 2026-07-01: User asked for (1) a Strava-style single-map view of the training log with low-click UX, and (2) a sync architected so AI agents can natively query training over any period. Clarified: the agent is ChatGPT Scheduled Tasks using an API key (goal = injury-risk analysis + a 1–3 week plan); it must be hosted free with no always-on local machine; map = MapLibre + free tiles; store routes + full GPS/HR streams.
- 2026-07-01: Chose an "one synced store, three consumers" architecture on Cloudflare: a Cron Worker syncs Strava (summary + polyline, then per-activity streams) into D1 (hosted SQLite); the frontend (MapLibre map + dashboard), a public REST API, and a Bearer-key agent API + `/openapi.json` all read the same D1. Source of truth moved off browser localStorage → D1.
- 2026-07-01: Implemented it end to end. Split the pure weekly derivation into `src/data/deriveWeekly.ts` (papaparse-free, shared by Worker + frontend) and extended it to accept true stream-derived decoupling. Added the Worker (`worker/*`), D1 migrations, MapLibre `MapView`, a map-first `App` with date-range + color-by + Map/Dashboard toggle, and the ChatGPT agent guide (`docs/agent-api.md`). Verified locally with seeded D1 (48 activities / 12 weeks): all endpoints, 401/200 auth gating, and the rendered map/detail/dashboard screenshots.

## Vision

Create a personal running companion that turns a runner's own training history into clear, week-by-week signals about fitness, fatigue, and trajectory.

## High Level Requirements

- Import running activity data from a practical source, initially favoring the source with the clearest API path.
- Analyze the runner relative to their own rolling baselines and recent history.
- Detect likely fatigue traps using multiple personalized indicators rather than single-rule thresholds.
- Present fatigue indicators, week-by-week trends, best-performance context, and training-load story in a calm dashboard.
- Keep room for future AI-generated narrative analysis once the underlying metrics are trustworthy.

## Project Plan

1. Confirm viable data-source strategy for Strava versus Garmin. Completed.
2. Scaffold a web app suitable for an interactive analytics dashboard. Completed.
3. Build a first dashboard with sample personal-history data and fatigue analysis logic. Completed.
4. Add documentation for data integration and next implementation steps. Completed.
5. Verify the app runs locally and inspect the UI. Completed.
6. Add real Strava OAuth and activity ingestion. Completed for summary activities.
7. Replace sample weekly blocks with derived features from imported activities. Completed for CSV import.
8. Add persistence for raw activities, derived weekly features, and analysis runs. Completed — moved to Cloudflare D1 as the single source of truth (raw activities + routes + streams + derived weekly features).
9. Add Strava stream ingestion for true decoupling and route/grade context. Completed — the Cron Worker backfills per-activity GPS + HR/cadence streams (rate-limit aware) and computes true first/second-half HR-pace decoupling.
10. Add Garmin health/recovery import for HRV, sleep, stress, and related metrics.
11. Add a weekly volume mileage/time toggle and make the default UI theme dark. Completed.
12. Add a Strava-style single-map training-log view (MapLibre + free tiles), map-first UX with date-range + color-by + click-to-detail. Completed.
13. Make the sync agent-native: host it free on Cloudflare (Worker + D1 + Cron + Pages) with a Bearer-key REST API + `/openapi.json` for ChatGPT Scheduled Tasks (injury-risk + 1–3 week planning). Completed.

## Architecture (2026-07-01)

"One synced store, three consumers." Cloudflare only, free tier, no local machine:

- **Cron Worker** (`worker/`, Hono) — refreshes the Strava token, incrementally fetches summary activities (with `summary_polyline`), backfills per-activity streams, computes true decoupling, and recomputes weekly features. Runs every 4h via a Cron Trigger.
- **D1 (SQLite)** — `athlete`, `activities` (+route), `activity_streams`, `weekly_features`, `sync_state`. Single source of truth.
- **Consumers:** the MapLibre map + dashboard (Cloudflare Pages), a public REST API (`/api/*`), and a Bearer-key agent API (`/api/agent/*`) + `/openapi.json` for ChatGPT.
- **Shared pure code:** `src/data/deriveWeekly.ts` (weekly derivation) and `src/analysis/fatigue.ts` run in both the Worker and the browser. Setup + agent usage documented in `docs/agent-api.md`.

## Outstanding Tasks

- Provision production Cloudflare resources: `wrangler d1 create lydiard` (paste id into wrangler.toml), set secrets (`STRAVA_CLIENT_SECRET`, `AGENT_API_KEY`) + `[vars]`, deploy the Worker, deploy Pages with `VITE_API_BASE`, and run the one-time `/auth/strava/login`.
- Validate stream-derived decoupling and stride against the user's real Strava devices once connected.
- Retire the legacy Express server (`server/stravaServer.ts`) after production parity is confirmed.
- Add Garmin health/recovery import so recovery is not neutral (HRV, sleep, stress).
- Consider frontend code-splitting (maplibre-gl + recharts) — build warns the bundle exceeds 500 kB.
- Optional: use stream `latlng` for a high-resolution single-activity zoom (overview currently uses the summary polyline).

## Verification Log

- 2026-06-10: `npm run build` passed.
- 2026-06-10: Playwright desktop screenshot saved to `progress/screenshots/dashboard-desktop.png`.
- 2026-06-10: Playwright mobile screenshot saved to `progress/screenshots/dashboard-mobile.png`.
- 2026-06-10: Desktop and mobile checks confirmed no horizontal overflow and visible fatigue-trap state.
- 2026-06-10: Browser console check completed with no warnings after adding explicit chart initial dimensions.
- 2026-06-11: `npm run build` passed after real-data import changes.
- 2026-06-11: Generated Strava-style CSV parser check produced expected weekly blocks.
- 2026-06-11: Generated Garmin-style CSV parser check confirmed day-first date parsing and expected week grouping.
- 2026-06-11: Playwright file-upload smoke test passed on mobile with local-storage persistence, two charts, no horizontal overflow, and no browser errors.
- 2026-06-11: `npm run build` passed after Strava OAuth backend/frontend changes.
- 2026-06-11: Local Strava backend `/api/strava/status` and Vite proxy `/api/strava/status` return setup-needed status without credentials.
- 2026-06-11: Playwright mobile smoke test confirmed Connect Strava setup state, no browser errors, both charts rendered, and no horizontal overflow.
- 2026-06-11: `npm run build` passed after weekly volume toggle and dark theme changes; Vite still reports the known large bundle warning.
- 2026-06-11: Playwright desktop/mobile smoke test confirmed dark `color-scheme`, dark chart surfaces, `Mileage` as the default weekly volume tab, selectable `Time` tab, no horizontal overflow, and no browser console errors.
- 2026-06-11: Screenshots saved to `progress/screenshots/dark-volume-desktop.png` and `progress/screenshots/dark-volume-mobile.png`.
- 2026-07-01: Typecheck passed for the app (`tsconfig.app.json`), node/server (`tsconfig.node.json`), and Worker (`tsconfig.worker.json`). `npm run build` passed (known large-bundle warning remains).
- 2026-07-01: Seeded a local D1 (`scripts/seed-fixture.ts` — 48 activities across 12 weeks with encoded polylines + one streamed activity, weekly features derived by the real pipeline). Applied migrations and ran `wrangler dev`.
- 2026-07-01: Verified every endpoint against local D1: `/api/status` (connected, 48 activities, 1 streamed, 12 weeks), `/api/activities`, `/api/weeks`, `/api/analysis`, `/api/activities/:id` (streams + decoupling), `/openapi.json`. Agent `/api/agent/plan-context` returns 401 without a Bearer key and 200 (full plan bundle) with it.
- 2026-07-01: Playwright screenshots (no console errors): `progress/screenshots/map-view-desktop.png` (routes on dark CARTO basemap, colored by fatigue), `map-view-selected.png` (click → highlighted route + activity detail card), `dashboard-view.png`, and `map-view-mobile.png`.
