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
- 2026-07-07: User asked for an accessible web page that shows training over the last N months in one view, including heart rate, power when recorded, projected easy pace for each run, and Strava-like fitness/fatigue over time. Implementation direction: add a dedicated Training view alongside Map/Dashboard; expose Strava average watts through D1/API; derive per-run projected easy pace from the weekly fixed-HR easy pace model; show fitness and fatigue on the same 0-100 scale.
- 2026-07-07: Added the Training view. It includes an N-month selector, same-scale fitness/fatigue load-index chart, KPI tiles, and a per-run table with date, distance, pace, HR, power, projected easy pace, fitness, and fatigue. Added optional `averageWatts` from Strava through the shared activity type, Worker mapper, D1 upsert/read path, OpenAPI schema, local fixture seed, and migration `0002_activity_power.sql`.
- 2026-07-07: User reported fake-looking map/training data and Strava sync not changing anything. Investigation found the local D1 was still seeded with fixture activities and fake `seed-access` / `seed-refresh` tokens, so `/api/sync` failed with Strava 401 while the UI continued showing fixture rows. Next fix: surface `sync_state.last_error` in the UI and clear local fixture data before reconnecting Strava.
- 2026-07-07: Cleared local fixture data and fake athlete tokens. Added local `.dev.vars` OAuth overrides so local Strava login uses `http://localhost:8787/auth/strava/callback` and redirects back to `http://localhost:5173`. Updated docs to distinguish fixture data from real training. Changed the Training view so sample weeks are not shown as real fitness/fatigue history when no synced activities exist.
- 2026-07-07: User wants phone access to the website on Cloudflare free tier, like the API. Verified official Cloudflare docs: Workers can deploy static assets with the Worker, static asset requests are free/unlimited, and assets have no storage cost. Chose same-Worker static assets over a separate Pages project so API/OAuth/web app share one `workers.dev` origin and D1 store.
- 2026-07-07: User can access the deployed site but sees `Last Strava sync failed: 403 Application Status Inactive`. Current diagnosis: Strava is rejecting the API application itself, not the site password or Cloudflare deployment. Strava's June 2026 developer program update says Standard Tier API access now requires an active Strava subscription for the developer/app owner, and affected inactive apps return 403s until reactivated. Need make the UI show this as a specific Strava-app action item and add a clean reset/reconnect path.
- 2026-07-07: Added friendly handling for `Application Status Inactive`, a protected `POST /api/strava/disconnect` endpoint that clears stored Strava tokens/sync error while keeping existing activities, and a header unlink button with confirmation. Updated docs with the Strava inactive recovery path.
- 2026-07-07: User confirmed they are no longer a Strava subscriber. This likely explains the inactive API app: for a personal Standard Tier Strava API app, the app owner now needs an active Strava subscription unless they are on Extended Access or using a transition code. Cloudflare hosting remains free; automatic Strava API sync may not be free under Strava's current terms.
- 2026-07-07: User asked whether Garmin Connect can be pulled automatically instead of manually. Official Garmin Connect Activity API supports automatic access to detailed activities and FIT/GPX/TCX files after user consent, but only after Garmin approval/evaluation; Health API is positioned for corporate wellness, population health, and patient monitoring. Conclusion: possible if Garmin approves the app, but there is no obvious self-serve free personal OAuth equivalent to the old Strava path.
- 2026-07-07: User asked whether AI/a script can automate Garmin export/import. Product stance: technically yes via an unofficial scraper/browser automation or private Garmin Connect endpoints, but it cannot run reliably inside Cloudflare Workers and carries credential/MFA/brittleness/terms risk. A scheduled GitHub Action or small external job could download FIT files and post them to our Worker, but official Garmin API approval remains the robust path.
- 2026-07-07: User pushed to try the automated Garmin path. Implemented an experimental unofficial pipeline: `POST /api/ingest/activities` bearer-key endpoint, `scripts/garmin-sync.ts` using `garmin-connect` + `fit-file-parser` + `adm-zip`, `npm run garmin:sync`, scripts typecheck config, and `.github/workflows/garmin-sync.yml` scheduled every 6 hours. The script logs into Garmin Connect, downloads original ZIPs, extracts FIT, parses route/HR/cadence/power streams, encodes summary polylines, and ingests normalized activities. Cloudflare `INGEST_API_KEY` and GitHub `LYDIARD_INGEST_KEY` are set; user still needs to add `GARMIN_USERNAME` and `GARMIN_PASSWORD` GitHub secrets.
- 2026-07-08: User shared the GitHub Actions Garmin sync failure log. The runner logged into Garmin successfully, then Garmin returned `429 Too Many Requests` while fetching activities. GitHub secrets for Garmin username/password and the Lydiard ingest key were present. Updated the runner to retry Garmin login/list/download calls with exponential backoff, soft-exit successfully on persistent Garmin rate limits, reduce the scheduled cadence to twice daily, lower the default activity list window, and cache Garmin session files in GitHub Actions once a login succeeds to reduce pressure on Garmin's private endpoints.
- 2026-07-08: User pivoted to `diegoscarabelli/garmin-health-data` after running a local 30-day extract. Audit of `garmin_data.db` showed SQLite integrity OK and no foreign-key issues. Training-log coverage is good: 26 running activities from 2026-06-09 through 2026-07-07, all with GPS paths and FIT time-series, 24 with HR streams, and 24 with positive power samples. 2026-06-28 is present only as a hiking activity, so it should not appear as a run. Health/recovery coverage is incomplete: sleep, HRV, stress, body battery, training readiness, and VO2 max tables are empty.
- 2026-07-08: Reworked the Garmin automation around `garmin-health-data`: added a SQLite audit script, a SQLite-to-Lydiard importer, replace-mode ingest, power stream storage, Garmin source labelling in weekly features/status/UI, git ignores for generated Garmin DB/files, and a twice-daily GitHub Action that installs/runs `garmin-health-data`, verifies/audits the DB, then imports Garmin runs into Cloudflare D1. Removed the old direct `garmin-connect` Node scraper path.
- 2026-07-08: Deployed the Garmin health-data pivot to Cloudflare and pushed it to `main`. Manual GitHub workflow run `28940213050` completed successfully, extracted/audited Garmin data, imported 26 Garmin running activities into production D1, and saved the Garmin health cache for future twice-daily runs.

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
14. Add a one-view Training page for the last N months with run table, HR/power availability, projected easy pace, and shared-scale fitness/fatigue trend. Completed.
15. Pivot scheduled training sync from Strava/direct Garmin scraping to `garmin-health-data` SQLite import. Completed for activity/route/HR/power streams; recovery tables are audited but currently empty in the extracted data.

## Architecture (2026-07-01)

"One synced store, three consumers." Cloudflare only, free tier, no local machine:

- **GitHub Actions Garmin sync** — twice daily, runs `garmin-health-data` to maintain `garmin_data.db`, audits database/table coverage, and posts normalized Garmin runs to the Worker ingest endpoint.
- **D1 (SQLite)** — `athlete`, `activities` (+route), `activity_streams`, `weekly_features`, `sync_state`. Single source of truth.
- **Consumers:** the same Worker now serves the phone-accessible React app as static assets (Map, Training, Dashboard), the public REST API (`/api/*`), and a Bearer-key agent API (`/api/agent/*`) + `/openapi.json` for ChatGPT.
- **Shared pure code:** `src/data/deriveWeekly.ts` (weekly derivation) and `src/analysis/fatigue.ts` run in both the Worker and the browser. Setup + agent usage documented in `docs/agent-api.md`.

## Outstanding Tasks

- Validate stream-derived decoupling, cadence, and power against the user's Garmin/FIT devices once more history is imported.
- Retire the legacy Express server (`server/stravaServer.ts`) after production parity is confirmed.
- Investigate why `garmin-health-data` produced empty recovery tables for sleep, HRV, stress, body battery, training readiness, and VO2 max; the current importer audits those gaps and keeps recovery neutral.
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
- 2026-07-07: `npm run build` passed after adding the Training view and power plumbing (known large-bundle warning remains).
- 2026-07-07: `npm run typecheck:worker` passed.
- 2026-07-07: Applied local D1 migrations (`0001_init.sql`, `0002_activity_power.sql`) and seeded local fixture data. Verified Vite page returns 200, unauthenticated `/api/status` returns 401 when `SITE_PASSWORD` is set, authenticated `/api/activities` returns 48 activities with `averageWatts` and heart-rate fields, and `/api/weeks` returns 12 weeks with easy pace / acute / chronic load data.
- 2026-07-07: In-app browser was unavailable in this Codex session (`agent.browsers.list()` returned no browsers), so no visual browser screenshot was captured for the Training view.
- 2026-07-07: After clearing fixture data, local `/api/status` reports disconnected with 0 activities / 0 weeks and no sync error. Verified the local OAuth login URL now uses `redirect_uri=http://localhost:8787/auth/strava/callback`. `npm run build` passed. Playwright screenshot of the empty real-data state saved to `progress/screenshots/training-empty-after-clear.png`.
- 2026-07-07: Configured Worker static assets (`dist`) with SPA fallback and worker-first routing for `/api/*`, `/auth/*`, and `/openapi.json`. Verified locally: `http://localhost:8787/` and `/training` return HTML, static JS returns 200, `/api/status` returns 401 without the site password and 200 with it.
- 2026-07-07: Applied remote D1 migration `0002_activity_power.sql` and deployed version `c7cecebf-0d61-4902-817f-1e966199077b` to `https://lydiard.lydiard.workers.dev`. Verified deployed `/` and `/training` return 200 HTML, and deployed `/api/status` returns 401 without the site password. Local `local-pw` does not match the production `SITE_PASSWORD`.
- 2026-07-07: `npm run build` and `npm run typecheck:worker` passed after the Strava inactive/reset patch. Verified local `POST /api/strava/disconnect` returns 200 with the site password. Deployed version `5689ae6d-5517-4485-9e47-e37af3890d72`; verified deployed root serves bundle `index-BB4XZvwY.js` and deployed disconnect endpoint returns 401 without the site password.
- 2026-07-07: `npm run typecheck:scripts` passed for the Garmin puller. Local ingest endpoint verification: unauthenticated `POST /api/ingest/activities` returns 401, authenticated empty payload returns 400, authenticated one-activity smoke payload returns 200 and then the local test row was cleared from D1.
- 2026-07-07: `npm run build`, `npm run typecheck:worker`, and `npm run typecheck:scripts` passed after Garmin automation changes. Deployed Worker version `da99f0ab-bad8-41c0-9cd7-94596d1a88a2`; deployed `POST /api/ingest/activities` returns 401 without bearer auth.
- 2026-07-08: `npm run typecheck:worker`, `npm run typecheck:scripts`, and `npm run build` passed after adding Garmin rate-limit retry/soft-fail handling and lowering the scheduled sync cadence.
- 2026-07-08: Manual GitHub workflow run `28930067267` completed successfully after 7m37s. The log showed Garmin still returned `429 Too Many Requests` on all four login attempts, but the runner backed off for 60s/120s/240s and exited successfully instead of failing the workflow.
- 2026-07-08: Manual GitHub workflow run `28930632843` verified the Garmin session cache wiring. The cache restored with a miss, Garmin still returned `429 Too Many Requests` on all four login attempts, no token path existed to save, and the workflow still completed successfully after 7m24s.
- 2026-07-08: `npm run garmin:audit` passed against local `garmin_data.db`: 386.2 MB DB, integrity OK, 0 foreign-key issues, 26 runs / 289.3 km, 26 paths, 26 FIT time-series, 24 HR streams, 24 power streams, latest run 2026-07-07. Empty recovery tables were reported as warnings, not corruption.
- 2026-07-08: `npm run garmin:import-db -- --dry-run` prepared 26 Garmin running activities and reported 24 with HR, 24 with power, 26 with streams, replacing enabled.
- 2026-07-08: Applied local D1 migration `0003_activity_stream_power.sql`, ran local Worker, and imported local Garmin DB into local D1 through `POST /api/ingest/activities`: response `{ok:true, source:"garmin-health-data", replace:true, upserted:26, streamsSaved:26, weekCount:5}`. Local API verification: status source `garmin-health-data`, latest activity 2026-07-07, no 2026-06-28 run, latest run has HR, average watts, power stream, HR stream, route stream, and decoupling.
- 2026-07-08: `npm run typecheck:scripts`, `npm run typecheck:worker`, and `npm run build` passed after the Garmin health-data pivot. Applied remote D1 migration `0003_activity_stream_power.sql` and deployed Worker version `21a201ec-b0ff-4585-865d-06d3a8380326`; removed the old Worker cron trigger so scheduled sync now lives in GitHub Actions.
- 2026-07-08: First post-pivot GitHub workflow run `28940156724` failed before Garmin extraction because `actions/setup-python` pip caching requires a Python dependency file and this repo has none. Removed the pip cache setting; the workflow still caches Garmin tokens/data separately.
- 2026-07-08: Manual GitHub workflow run `28940213050` succeeded on commit `9e5260c0decfc2a88c3ab20378ecfa47a300ef02`. Audit output: DB 386.3 MB, integrity OK, 0 foreign-key issues, 26 running activities / 289.3 km from 2026-06-09 through 2026-07-07, 26 paths, 26 FIT time-series, 24 HR streams, 24 power streams, and 2026-06-28 classified as hiking only. Import output: `{ok:true, source:"garmin-health-data", replace:true, upserted:26, streamsSaved:26, weekCount:5}`.
- 2026-07-08: Production D1 verification after workflow import: 26 activities, first start `2026-06-09T10:36:19.000Z`, latest start `2026-07-07T13:01:02.000Z`, 0 rows on 2026-06-28, 24 activities with average HR, 24 with average watts, 26 stream rows, 24 HR streams, 24 power streams, 5 weekly feature rows, `sync_state.last_error` null, and `sync_state.last_result.source` = `garmin-health-data`.
