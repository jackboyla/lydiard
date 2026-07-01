# Real Data Import

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
