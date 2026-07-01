# Data Integration Notes

Accessed on 2026-06-10.

## Recommendation

Start with Strava login for the MVP, keep CSV import as fallback, then add Garmin once the analysis model is proven.

Strava is the easiest first source because its public developer docs cover OAuth, single-athlete development, activity reads, streams, webhooks, and rate limits. This fits a personal companion app where the first user is one athlete.

Garmin is potentially more useful later because FIT files and health metrics can expose richer running dynamics, sleep, stress, and other recovery context. The official Garmin Connect Developer Program is approval-oriented, and the Health API page also notes that commercial use requires a license fee payment.

## MVP Shape

- Use Strava OAuth with `activity:read_all` where private activity access is needed.
- Fetch recent runs from `/athlete/activities` first, then add detailed activity streams for time, distance, altitude, velocity, heart rate, cadence, and moving state.
- Derive weekly features from the athlete's own history: easy pace at fixed HR, stride estimate from pace and cadence, HR-pace drift, load, threshold estimate, and recovery proxies.
- Store derived weekly features separately from raw activities so analysis can be regenerated when the model changes.
- Keep CSV import available for fast testing and for data that is not available through Strava.

## Garmin Later

- Garmin Activity API can provide full activity detail files in `.FIT`, GPX, and TCX formats after approval.
- Garmin Health API can provide all-day health summaries such as heart rate, sleep, stress, Pulse Ox, Body Battery, respiration, and related metrics after approval.
- Avoid unofficial Garmin Connect scraping for the product path.

## Sources

- Strava Getting Started: https://developers.strava.com/docs/getting-started/
- Strava Authentication: https://developers.strava.com/docs/authentication/
- Strava Rate Limits: https://developers.strava.com/docs/rate-limits/
- Strava Changelog: https://developers.strava.com/docs/changelog/
- Garmin Activity API: https://developer.garmin.com/gc-developer-program/activity-api/
- Garmin Health API: https://developer.garmin.com/gc-developer-program/health-api/
