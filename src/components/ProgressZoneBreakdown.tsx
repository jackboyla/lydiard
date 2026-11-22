import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SessionLoad } from '../analysis/loadModel';
import { addDays } from '../analysis/recoveryTrend';
import { toWeekIdUtc } from '../data/mapRoutes';
import { chartWeeks, formatShortDate, trailingMonthsStart } from './chartDates';

const PERIODS = ['7 days', '30 days', '3 months', '6 months'] as const;
export type ZonePeriod = typeof PERIODS[number];

const ZONES = [
  { key: 'recovery', color: '#3154db', label: 'Recovery', range: '<68% threshold', min: -Infinity, max: 0.68 },
  { key: 'easy', color: '#1fa8dc', label: 'Easy aerobic', range: '68–78% threshold', min: 0.68, max: 0.78 },
  { key: 'steady', color: '#169c70', label: 'Steady / LT1', range: '78–88% threshold', min: 0.78, max: 0.88 },
  { key: 'threshold', color: '#e07a00', label: 'Threshold / LT2', range: '88–102% threshold', min: 0.88, max: 1.02 },
  { key: 'vo2', color: '#df2d32', label: 'VO₂ / high intensity', range: '≥102% threshold', min: 1.02, max: Infinity },
] as const;

type ZoneKey = typeof ZONES[number]['key'];

export default function ProgressZoneBreakdown({ sessions, today, period, onPeriodChange }: {
  sessions: SessionLoad[];
  today: string;
  period: ZonePeriod;
  onPeriodChange: (period: ZonePeriod) => void;
}) {
  const [zoneKey, setZoneKey] = useState<ZoneKey | 'all'>('all');
  const { start, rows, weeks, runCount, totalSeconds } = useMemo(
    () => buildProgressZoneLedger(sessions, today, period), [sessions, today, period],
  );
  const totalDistance = rows.reduce((sum, row) => sum + row.distanceKm, 0);
  const selectedZone = rows.find((row) => row.key === zoneKey);

  return (
    <article className="product-card progress-zone-ledger" aria-labelledby="progress-zone-ledger-heading">
      <header>
        <div>
          <span>Zone ledger</span>
          <h2 id="progress-zone-ledger-heading">Where your running landed</h2>
          <p>Each run counts toward one zone based on its average grade-adjusted pace.</p>
        </div>
        <small>{formatShortDate(start)} – {formatShortDate(today)}</small>
      </header>

      <div className="segmented zone-period" role="group" aria-label="Zone ledger range">
        {PERIODS.map((option) => (
          <button type="button" key={option} aria-pressed={period === option} className={period === option ? 'active' : ''}
            onClick={() => onPeriodChange(option)}>{option}</button>
        ))}
      </div>

      {totalSeconds > 0 ? (
        <>
          <div className="progress-zone-total">
            <strong>{totalDistance.toFixed(1)} km</strong>
            <span>{formatZoneDuration(totalSeconds)} · {runCount} {runCount === 1 ? 'run' : 'runs'}</span>
          </div>
          <div className="progress-zone-stack" aria-label="Training time by zone">
            {rows.filter((row) => row.durationSec > 0).map((row) => (
              <i
                key={row.key}
                style={{ width: `${row.percentage}%`, background: row.color }}
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
                <span role="cell"><i style={{ background: row.color }} /><strong>{row.label}</strong><small>{row.range}</small></span>
                <span role="cell">{row.distanceKm.toFixed(1)} km</span>
                <span role="cell">{formatZoneDuration(row.durationSec)}</span>
                <strong role="cell">{Math.round(row.percentage)}%</strong>
              </div>
            ))}
          </div>
          <div className="zone-trend-head">
            <h3>Weekly time by zone</h3>
            <select aria-label="Weekly trend zone" value={zoneKey} onChange={(event) => setZoneKey(event.target.value as typeof zoneKey)}>
              <option value="all">All zones</option>
              {ZONES.map((zone) => <option key={zone.key} value={zone.key}>{zone.label}</option>)}
            </select>
          </div>
          {selectedZone?.durationSec === 0 ? (
            <p className="progress-zone-method">No running time in {selectedZone.label} during this range.</p>
          ) : (
            <>
              <div className="zone-trend-chart">
                <ResponsiveContainer width="100%" height={190} minWidth={0}>
                  <BarChart data={weeks} title="Weekly moving time by zone" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--border-soft)" />
                    <XAxis dataKey="from" tickFormatter={formatShortDate} minTickGap={16} tickLine={false} />
                    <YAxis width={50} unit="m" allowDecimals={false} axisLine={false} tickLine={false} />
                    <Tooltip
                      labelFormatter={(_, entries) => {
                        const week = entries[0]?.payload;
                        return week ? `${formatShortDate(week.from)} – ${formatShortDate(week.to)}` : '';
                      }}
                      formatter={(minutes) => formatZoneDuration(Number(minutes) * 60)}
                      contentStyle={{ background: 'var(--surface)', borderColor: 'var(--border-soft)' }}
                      itemStyle={{ color: 'var(--text)' }}
                      cursor={{ fill: 'var(--surface-control)' }}
                    />
                    {ZONES.filter((zone) => zoneKey === 'all' || zoneKey === zone.key).map((zone) => (
                      <Bar key={zone.key} dataKey={`minutes.${zone.key}`} name={zone.label} stackId="zones"
                        fill={zone.color} maxBarSize={48} isAnimationActive={false} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="progress-zone-method">Weeks start on Monday. Each bar includes only the days in the selected range.</p>
            </>
          )}
        </>
      ) : (
        <p className="progress-zone-empty">No runs fall inside this date range.</p>
      )}
    </article>
  );
}

export function buildProgressZoneLedger(sessions: SessionLoad[], today: string, period: ZonePeriod) {
  const start = periodStart(today, period);
  const weeks = chartWeeks(start, today).map((week) => ({
    ...week,
    minutes: { recovery: 0, easy: 0, steady: 0, threshold: 0, vo2: 0 },
  }));
  const byMonday = new Map(weeks.map((week) => [week.monday, week]));
  const totals = ZONES.map((zone) => ({ ...zone, distanceKm: 0, durationSec: 0 }));
  let runCount = 0;
  let totalSeconds = 0;
  for (const session of sessions) {
    if (session.day < start || session.day > today) continue;
    const zone = totals.find((candidate) =>
      session.externalIntensityFactor >= candidate.min && session.externalIntensityFactor < candidate.max,
    );
    if (!zone) continue;
    const { movingTimeSec, distanceKm } = session.activity;
    zone.distanceKm += distanceKm;
    zone.durationSec += movingTimeSec;
    byMonday.get(toWeekIdUtc(session.day))!.minutes[zone.key] += movingTimeSec / 60;
    totalSeconds += movingTimeSec;
    runCount++;
  }
  const rows = totals.map((zone) => ({
    ...zone,
    percentage: totalSeconds > 0 ? (zone.durationSec / totalSeconds) * 100 : 0,
  }));
  return { start, weeks, rows, runCount, totalSeconds };
}

function periodStart(today: string, period: ZonePeriod): string {
  if (period === '7 days') return addDays(today, -6);
  if (period === '30 days') return addDays(today, -29);
  return trailingMonthsStart(today, period === '3 months' ? 3 : 6);
}

function formatZoneDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${rest}m`;
}
