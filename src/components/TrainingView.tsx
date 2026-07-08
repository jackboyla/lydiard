import { useMemo, useState } from 'react';
import {
  Activity,
  CalendarDays,
  Gauge,
  HeartPulse,
  ShieldAlert,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPace } from '../analysis/fatigue';
import { activityPaceSecPerKm, toWeekIdUtc } from '../data/mapRoutes';
import type { ActivitySummary, WeeklyAnalysis } from '../types';

interface TrainingViewProps {
  activities: ActivitySummary[];
  analyses: WeeklyAnalysis[];
  usingSample: boolean;
}

const QUICK_MONTHS = [3, 6, 12, 24];

export function TrainingView({ activities, analyses, usingSample }: TrainingViewProps) {
  const [months, setMonths] = useState(6);

  const model = useMemo(() => buildTrainingModel(activities, analyses, months), [activities, analyses, months]);
  const latest = model.chartRows[model.chartRows.length - 1];
  const latestAnalysis = model.scopedAnalyses[model.scopedAnalyses.length - 1] ?? analyses[analyses.length - 1];
  const projectedEasy = latestAnalysis ? formatPace(latestAnalysis.week.easyPaceSecPerKm) : '-';
  const hrCoverage = model.runCount > 0 ? `${model.hrCount}/${model.runCount}` : '-';
  const powerCoverage = model.runCount > 0 ? `${model.powerCount}/${model.runCount}` : '-';

  return (
    <main className="training-view" aria-label="Training history">
      <section className="training-toolbar" aria-label="Training range">
        <div>
          <p className="eyebrow">
            <Activity size={15} aria-hidden="true" />
            Training log
          </p>
          <h2>Last {months} months</h2>
        </div>
        <div className="training-range-controls">
          <div className="segmented compact-segmented" role="group" aria-label="Quick month range">
            {QUICK_MONTHS.map((value) => (
              <button
                key={value}
                type="button"
                className={months === value ? 'active' : ''}
                aria-pressed={months === value}
                onClick={() => setMonths(value)}
              >
                {value}m
              </button>
            ))}
          </div>
          <label className="month-stepper" htmlFor="training-months">
            <span>Months</span>
            <input
              id="training-months"
              type="number"
              min={1}
              max={60}
              step={1}
              value={months}
              onChange={(event) => setMonths(clampMonthInput(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="training-grid" aria-label="Fitness and fatigue">
        <article className="chart-card training-chart-card">
          <div className="chart-header">
            <div>
              <p>Fitness and fatigue</p>
              <h2>Personal load index</h2>
            </div>
            <span className="chart-pill">0-100</span>
          </div>
          <div className="fitness-chart">
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={0}
              minHeight={0}
              initialDimension={{ width: 900, height: 340 }}
            >
              <LineChart data={model.chartRows} margin={{ top: 14, right: 20, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#2c3440" vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: '#92a0b3', fontSize: 12 }} />
                <YAxis
                  domain={[0, 100]}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: '#92a0b3', fontSize: 12 }}
                  width={44}
                />
                <Tooltip
                  cursor={{ stroke: '#465365', strokeWidth: 1 }}
                  contentStyle={{
                    border: '1px solid #303946',
                    borderRadius: 8,
                    backgroundColor: '#171b21',
                    color: '#edf2f7',
                    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.32)',
                  }}
                  formatter={(value, name) => [`${Math.round(Number(value))}/100`, name]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.weekLabel ?? ''}
                />
                <Legend verticalAlign="top" align="right" iconType="line" wrapperStyle={{ color: '#99a6b8' }} />
                <Line
                  type="monotone"
                  dataKey="fitness"
                  name="Fitness"
                  stroke="#22b982"
                  strokeWidth={3}
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 5, fill: '#22b982' }}
                />
                <Line
                  type="monotone"
                  dataKey="fatigue"
                  name="Fatigue"
                  stroke="#ff5a66"
                  strokeWidth={3}
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 5, fill: '#ff5a66' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </article>

        <aside className="training-kpis" aria-label="Current training metrics">
          <TrainingKpi
            icon={<TrendingUp size={18} />}
            label="Fitness"
            value={latest ? `${latest.fitness}/100` : '-'}
            detail={latestAnalysis ? `${latestAnalysis.week.chronicLoad} chronic` : 'no data'}
          />
          <TrainingKpi
            icon={<ShieldAlert size={18} />}
            label="Fatigue"
            value={latest ? `${latest.fatigue}/100` : '-'}
            detail={latestAnalysis ? `${latestAnalysis.week.acuteLoad} acute` : 'no data'}
          />
          <TrainingKpi
            icon={<Gauge size={18} />}
            label="Projected easy"
            value={projectedEasy}
            detail={latestAnalysis ? `${latestAnalysis.week.easyHeartRate} bpm anchor` : 'no data'}
          />
          <TrainingKpi
            icon={<CalendarDays size={18} />}
            label="Runs"
            value={String(model.runCount)}
            detail={`${Math.round(model.distanceKm)} km`}
          />
          <TrainingKpi
            icon={<HeartPulse size={18} />}
            label="Heart rate"
            value={hrCoverage}
            detail={model.averageHeartRate ? `${Math.round(model.averageHeartRate)} bpm avg` : 'not recorded'}
          />
          <TrainingKpi
            icon={<Zap size={18} />}
            label="Power"
            value={powerCoverage}
            detail={model.averageWatts ? `${Math.round(model.averageWatts)} W avg` : 'not recorded'}
          />
        </aside>
      </section>

      <section className="chart-card training-table-card" aria-label="Run history">
        <div className="chart-header">
          <div>
            <p>Runs</p>
            <h2>Heart rate, power, projected easy pace</h2>
          </div>
          <span className="chart-pill">{model.runCount} runs</span>
        </div>

        {model.rows.length > 0 ? (
          <div className="training-table-wrap">
            <table className="training-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Run</th>
                  <th>Distance</th>
                  <th>Pace</th>
                  <th>Heart rate</th>
                  <th>Power</th>
                  <th>Projected easy</th>
                  <th>Fitness</th>
                  <th>Fatigue</th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <tr key={row.activity.id}>
                    <td>
                      <strong>{formatRunDate(row.activity.startDateLocal || row.activity.startDate)}</strong>
                      <span>{row.weekLabel}</span>
                    </td>
                    <td>
                      <strong>{row.activity.name}</strong>
                      <span>{row.activity.sportType}</span>
                    </td>
                    <td>{row.activity.distanceKm.toFixed(1)} km</td>
                    <td>{formatPace(row.paceSecPerKm)}</td>
                    <td>{row.activity.averageHeartRate ? `${Math.round(row.activity.averageHeartRate)} bpm` : '-'}</td>
                    <td>{row.activity.averageWatts ? `${Math.round(row.activity.averageWatts)} W` : '-'}</td>
                    <td>{row.projectedEasySecPerKm ? formatPace(row.projectedEasySecPerKm) : '-'}</td>
                    <td>{row.fitnessIndex !== undefined ? `${row.fitnessIndex}/100` : '-'}</td>
                    <td>
                      <span className={`fatigue-chip ${row.severity ?? 'steady'}`}>
                        {row.fatigueIndex !== undefined ? `${row.fatigueIndex}/100` : '-'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="training-empty">
            <Activity size={28} aria-hidden="true" />
            <h3>{usingSample ? 'Connect Strava for run rows' : 'No runs in this range'}</h3>
          </div>
        )}
      </section>
    </main>
  );
}

function TrainingKpi({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="training-kpi">
      <span aria-hidden="true">{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function buildTrainingModel(activities: ActivitySummary[], analyses: WeeklyAnalysis[], months: number) {
  const maxLoad = Math.max(
    1,
    ...analyses.flatMap((analysis) => [analysis.week.acuteLoad, analysis.week.chronicLoad]),
  );
  const weekById = new Map(analyses.map((analysis) => [analysis.week.weekStart, analysis]));
  const anchorMs = latestTimestamp(activities, analyses);
  const fromMs = subtractMonths(anchorMs, months);

  const scopedAnalyses = analyses.filter((analysis) => new Date(analysis.week.weekStart).getTime() >= fromMs);
  const scopedActivities = activities
    .filter((activity) => isRunLike(activity))
    .filter((activity) => new Date(activity.startDate).getTime() >= fromMs)
    .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());

  const chartRows = scopedAnalyses.map((analysis) => ({
    label: formatWeekTick(analysis.week.weekStart),
    weekLabel: analysis.week.label,
    fitness: loadIndex(analysis.week.chronicLoad, maxLoad),
    fatigue: loadIndex(analysis.week.acuteLoad, maxLoad),
  }));

  const rows = scopedActivities.map((activity) => {
    const weekId = toWeekIdUtc(activity.startDate);
    const analysis = weekById.get(weekId);
    return {
      activity,
      paceSecPerKm: activityPaceSecPerKm(activity),
      weekLabel: analysis?.week.label ?? formatWeekTick(weekId),
      projectedEasySecPerKm: analysis?.week.easyPaceSecPerKm,
      fitnessIndex: analysis ? loadIndex(analysis.week.chronicLoad, maxLoad) : undefined,
      fatigueIndex: analysis ? loadIndex(analysis.week.acuteLoad, maxLoad) : undefined,
      severity: analysis?.severity,
    };
  });

  const hrWeighted = weightedAverage(
    scopedActivities
      .filter((activity) => activity.averageHeartRate)
      .map((activity) => [activity.averageHeartRate as number, activity.movingTimeSec] as const),
  );
  const powerWeighted = weightedAverage(
    scopedActivities
      .filter((activity) => activity.averageWatts)
      .map((activity) => [activity.averageWatts as number, activity.movingTimeSec] as const),
  );

  return {
    scopedAnalyses,
    chartRows,
    rows,
    runCount: scopedActivities.length,
    distanceKm: scopedActivities.reduce((total, activity) => total + activity.distanceKm, 0),
    hrCount: scopedActivities.filter((activity) => activity.averageHeartRate).length,
    powerCount: scopedActivities.filter((activity) => activity.averageWatts).length,
    averageHeartRate: hrWeighted,
    averageWatts: powerWeighted,
  };
}

function latestTimestamp(activities: ActivitySummary[], analyses: WeeklyAnalysis[]): number {
  const timestamps = [
    ...activities.map((activity) => new Date(activity.startDate).getTime()),
    ...analyses.map((analysis) => new Date(analysis.week.weekStart).getTime()),
  ].filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
}

function subtractMonths(anchorMs: number, months: number): number {
  const date = new Date(anchorMs);
  date.setMonth(date.getMonth() - months);
  return date.getTime();
}

function loadIndex(value: number, maxLoad: number): number {
  return Math.round(Math.min(100, Math.max(0, (value / maxLoad) * 100)));
}

function weightedAverage(values: ReadonlyArray<readonly [number, number]>): number | undefined {
  const totalWeight = values.reduce((total, [, weight]) => total + weight, 0);
  if (totalWeight <= 0) {
    return undefined;
  }
  return values.reduce((total, [value, weight]) => total + value * weight, 0) / totalWeight;
}

function isRunLike(activity: ActivitySummary): boolean {
  return /run|jog|race/i.test(`${activity.sportType} ${activity.name}`);
}

function clampMonthInput(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.min(60, Math.max(1, Math.round(parsed)));
}

function formatRunDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

function formatWeekTick(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso));
}
