import type { SessionLoad, TrainingLoadModel } from '../analysis/loadModel';

interface ZoneLedgerRow {
  key: string;
  label: string;
  range: string;
  distanceKm: number;
  durationSec: number;
  percentage: number;
}

const ZONES = [
  { key: 'recovery', label: 'Recovery', range: '<68% threshold', min: -Infinity, max: 0.68 },
  { key: 'easy', label: 'Easy aerobic', range: '68–78% threshold', min: 0.68, max: 0.78 },
  { key: 'steady', label: 'Steady / LT1', range: '78–88% threshold', min: 0.78, max: 0.88 },
  { key: 'threshold', label: 'Threshold / LT2', range: '88–102% threshold', min: 0.88, max: 1.02 },
  { key: 'vo2', label: 'VO₂ / high intensity', range: '≥102% threshold', min: 1.02, max: Infinity },
] as const;

export function ProgressZoneBreakdown({ loadModel }: { loadModel: TrainingLoadModel }) {
  const rows = buildProgressZoneLedger(loadModel.sessions);
  const totalDistance = rows.reduce((sum, row) => sum + row.distanceKm, 0);
  const totalSeconds = rows.reduce((sum, row) => sum + row.durationSec, 0);
  const first = loadModel.sessions[0]?.activity.startDateLocal ?? loadModel.sessions[0]?.activity.startDate;
  const last = loadModel.sessions.at(-1)?.activity.startDateLocal ?? loadModel.sessions.at(-1)?.activity.startDate;

  return (
    <article className="product-card progress-zone-ledger" aria-labelledby="progress-zone-ledger-heading">
      <header>
        <div>
          <span>Zone ledger</span>
          <h2 id="progress-zone-ledger-heading">Where your running landed</h2>
          <p>Run-level volume assigned from each session's average pace and elevation intensity.</p>
        </div>
        <small>{first && last ? `${formatShortDate(first)} – ${formatShortDate(last)}` : 'No runs in range'}</small>
      </header>

      {totalSeconds > 0 ? (
        <>
          <div className="progress-zone-total">
            <strong>{totalDistance.toFixed(1)} km</strong>
            <span>{formatZoneDuration(totalSeconds)} · {loadModel.sessions.length} {loadModel.sessions.length === 1 ? 'run' : 'runs'}</span>
          </div>
          <div className="progress-zone-stack" aria-label="Training time by zone">
            {rows.filter((row) => row.durationSec > 0).map((row) => (
              <i
                key={row.key}
                className={`zone-${row.key}`}
                style={{ width: `${row.percentage}%` }}
                title={`${row.label}: ${row.percentage.toFixed(1)}%`}
              />
            ))}
          </div>
          <div className="progress-zone-table" role="table" aria-label="Running volume by zone">
            <div className="progress-zone-table-head" role="row">
              <span role="columnheader">Zone</span>
              <span role="columnheader">Distance</span>
              <span role="columnheader">Time</span>
              <span role="columnheader">%</span>
            </div>
            {rows.map((row) => (
              <div key={row.key} className="progress-zone-row" role="row">
                <span role="cell"><i className={`zone-${row.key}`} /><strong>{row.label}</strong><small>{row.range}</small></span>
                <span role="cell">{row.distanceKm.toFixed(1)} km</span>
                <span role="cell">{formatZoneDuration(row.durationSec)}</span>
                <strong role="cell">{Math.round(row.percentage)}%</strong>
              </div>
            ))}
          </div>
          <p className="progress-zone-method">This summarizes whole runs; it does not claim second-by-second stream time-in-zone.</p>
        </>
      ) : (
        <p className="progress-zone-empty">No runs fall inside this Progress range.</p>
      )}
    </article>
  );
}

export function buildProgressZoneLedger(sessions: SessionLoad[]): ZoneLedgerRow[] {
  const totals = ZONES.map((zone) => ({ ...zone, distanceKm: 0, durationSec: 0 }));
  for (const session of sessions) {
    const zone = totals.find((candidate) =>
      session.externalIntensityFactor >= candidate.min && session.externalIntensityFactor < candidate.max,
    );
    if (!zone) continue;
    zone.distanceKm += session.activity.distanceKm;
    zone.durationSec += session.activity.movingTimeSec;
  }
  const totalSeconds = totals.reduce((sum, zone) => sum + zone.durationSec, 0);
  return totals.map((zone) => ({
    key: zone.key,
    label: zone.label,
    range: zone.range,
    distanceKm: zone.distanceKm,
    durationSec: zone.durationSec,
    percentage: totalSeconds > 0 ? (zone.durationSec / totalSeconds) * 100 : 0,
  }));
}

function formatZoneDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${rest}m`;
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }).format(new Date(iso));
}
