# Real Data Import

## Manual training-plan CSV

Lydiard can migrate the daily `Date / Planned / Actual / Notes` ledger exported from the RUNMASTER
Google Sheet. Keep the exports under the gitignored `tmp/` directory because Notes may contain
private health and training details.

```bash
# Parse only; no network or database writes.
npm run plan:import -- --dry-run

# Ask Lydiard to verify every non-empty Actual row against Garmin by local date
# and moving duration (two-minute tolerance), without writing.
LYDIARD_INGEST_KEY='...' npm run plan:import -- --validate

# Import after the strict preflight passes.
LYDIARD_INGEST_KEY='...' npm run plan:import
```

The importer finds the real header after the sheet preamble, ignores `Week total`, `Week continues`,
and `Month total` rows, validates each weekday/date, and preserves decoded Planned and Notes text
without trimming it. Durations can use minutes or hours (`57m`, `1h 10m`); split Actual cells such
as `AM 40m PM 30m` match two chronological Garmin runs on the same local calendar date. `+ gym` and
`+ strides` annotations do not affect run-duration
matching; Garmin gym sessions are displayed separately by date.

The default target is the deployed Worker. For local development, use:

```bash
set -a; . ./.dev.vars; set +a
LYDIARD_INGEST_KEY="$AGENT_API_KEY" \
LYDIARD_BASE_URL=http://localhost:8787 \
npm run plan:import
```

Re-running the importer is non-destructive by default: existing plan rows are kept. `--overwrite`
explicitly resets editable Planned/Notes values from the CSV while retaining the immutable original
planned text. `--allow-unmatched` is available for an intentionally incomplete local Garmin store;
do not use it for the production migration. Plan writes are capped at 40 meaningful days per request
to stay within D1 limits; split larger exports into smaller batches.

Actual runs are never copied into the plan table. The Plan UI groups the current Garmin activity
store by `startDateLocal`, so new runs—including double days—appear automatically after every Garmin
sync. Planned sessions and Notes can be edited with the authenticated site password, and the same
date-level Notes appear on Calendar run cards and in clicked run details. Saves use per-row versions,
so a stale browser is asked to reload the saved day instead of overwriting a newer edit.

The fastest path to real analysis is Strava login through the local OAuth backend. CSV import remains available as a fallback and for Garmin activity exports.

## Strava Login

1. Create a Strava API app at https://www.strava.com/settings/api.
2. Set the app's Authorization Callback Domain to `localhost`.
3. Copy `.env.example` to `.env`.
4. Fill `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.
5. Run `npm run server` in one terminal.
6. Run `npm run dev` in another terminal.
7. Open `http://localhost:5173` and click `Connect Strava`.

The backend stores the Strava refresh token in `.local/strava-token.json`, which is gitignored. The frontend stores derived weekly analysis data in browser local storage so the dashboard survives refreshes.

Current Strava login imports summary activities from `/athlete/activities`. That is enough to avoid bulk downloads and build personalized weekly trends from your actual activity history. Stream-level data from `/activities/{id}/streams` is still the next step for true HR-pace decoupling.

## Strava

Use Strava's account bulk export and import the `activities.csv` file from the archive.

The importer detects running rows and reads these columns when present:

- `Activity Date`
- `Activity Type`
- `Activity Name`
- `Distance`
- `Moving Time` or `Elapsed Time`
- `Average Heart Rate`
- `Average Cadence`
- `Elevation Gain`
- `Relative Effort` or `Suffer Score`

Strava summary CSV is useful for weekly volume, training load, easy pace, cadence-derived stride, and broad aerobic-cost trends. It does not contain true stream-level first-half/second-half HR drift, so the app labels that signal as an aerobic-cost proxy after import.

## Garmin Connect

Use Garmin Connect's activities table export and import the CSV. The importer accepts common Garmin-style columns such as:

- `Date`
- `Activity Type`
- `Title`
- `Distance`
- `Time`
- `Avg HR`
- `Avg Run Cadence`
- `Elevation Gain` or `Total Ascent`

Garmin activity CSV helps validate the personal baseline model. Garmin health metrics such as sleep, HRV, stress, and Body Battery need a richer export or API connector later.

## Current Limits

- Summary CSV imports do not include detailed stream samples.
- HR-pace decoupling is a proxy until Strava streams or FIT/TCX files are added.
- Recovery is neutral unless HRV or sleep columns are included.
- Distance units are inferred from column names and value size; explicit `km`, `mi`, or `m` headers are best.

## Sources

- Strava bulk export: https://support.strava.com/hc/en-us/articles/216918437-Exporting-your-Data-and-Bulk-Export
- Strava API getting started: https://developers.strava.com/docs/getting-started/
- Strava API changelog: https://developers.strava.com/docs/changelog/
- Garmin Connect CSV export: https://support.garmin.com/en-US/?faq=W1TvTPW8JZ6LfJSfK512Q8
