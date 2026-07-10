# Analysis chart relocation and date-axis fix

## Ongoing instructions

- Keep the CTL/ATL load model under Analysis rather than Calendar.
- Put all charts before supporting cards and metrics on the Analysis page.
- Prevent historical months from appearing to repeat while hovering horizontally across long-range charts.

## Plan

1. Extract the CTL/ATL chart from Calendar into a reusable Analysis component. Complete.
2. Convert all Analysis x-axes from ambiguous display labels to UTC timestamps. Complete.
3. Use year-qualified ticks for long spans and full dates in tooltips. Complete.
4. Verify desktop/mobile ordering, hover, click selection, and overflow. Complete.

## Decisions

- Analysis shows the CTL/ATL chart first, then the selectable weekly trend, then weekly volume and fitness.
- Calendar keeps the four current load KPIs but no longer renders the CTL/ATL graph.
- Long-range axes render month plus year; tooltips render weekday, day, month, and year.
- The chart date formatter uses UTC so a week cannot shift to the prior local date.

## Verification

- `npm run build` passed.
- `npx tsc --noEmit` passed.
- `git diff --check` passed.
- Playwright verified three charts lead Analysis on desktop and mobile.
- Horizontal hover samples crossed 2017, 2019, 2022, and 2025 with distinct full-date tooltips.
- Clicking a January 2018 trend point updated the selected-week readout to January 2018.
- Calendar contains zero CTL/ATL chart cards and still contains four current-load KPIs.
- Desktop and 390 px mobile both have zero document/main horizontal overflow.

## Artifacts

- `progress/screenshots/analysis-charts-top-desktop.png`
- `progress/screenshots/analysis-charts-top-mobile.png`
- `progress/screenshots/analysis-charts-top-date-axis.png`

## Outstanding

- None for this request.
