import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPace } from '../analysis/fatigue';
import type { SessionLoad, TrainingLoadModel } from '../analysis/loadModel';
import { chartSpanDays, formatChartDate, formatChartTick, utcDayTimestamp } from './chartDates';

interface EfficiencyPoint {
  weekId: string;
  ts: number;
  pace: number;
  runs: number;
  minutes: number;
  averageHeartRate: number;
}

export function AerobicEfficiencyChart({ loadModel }: { loadModel: TrainingLoadModel }) {
  const model = buildEfficiencyModel(loadModel);
  if (model.points.length === 0) {
    return (
      <article className="chart-card aerobic-efficiency-card">
        <div className="chart-header">
          <div><p>Pace at aerobic HR</p><h2>Aerobic efficiency</h2></div>
        </div>
        <p className="aerobic-efficiency-empty">A few 25–100 minute aerobic runs with heart-rate data are needed for this trend.</p>
      </article>
    );
  }
  const latest = model.points[model.points.length - 1];
  const best = model.points.reduce((fastest, point) => point.pace < fastest.pace ? point : fastest, model.points[0]);
  const spanDays = chartSpanDays(model.points.map((point) => point.ts));

  return (
    <article className="chart-card aerobic-efficiency-card">
      <div className="chart-header aerobic-efficiency-head">
        <div>
          <p>Pace at aerobic HR</p>
          <h2>Aerobic efficiency</h2>
          <small>Pace normalized to your {model.anchorHeartRate} bpm aerobic anchor.</small>
        </div>
        <div className="aerobic-efficiency-current">
          <strong>{formatPace(latest.pace)}</strong>
          <span>best {formatPace(best.pace)} · at {model.anchorHeartRate} bpm</span>
        </div>
      </div>
      <div className="aerobic-efficiency-legend">
        <span>Latest <strong>{formatPace(latest.pace)}</strong></span>
        <span>Best form <strong>{formatPace(best.pace)}</strong></span>
        <span>3-wk trend <strong>{model.trend}</strong></span>
      </div>
      <div className="aerobic-efficiency-chart">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} initialDimension={{ width: 900, height: 280 }}>
          <LineChart data={model.points} margin={{ top: 16, right: 18, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#2c3440" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(value) => formatChartTick(Number(value), spanDays)}
              minTickGap={48}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#92a0b3', fontSize: 12 }}
            />
            <YAxis
              dataKey="pace"
              reversed
              domain={['dataMin - 8', 'dataMax + 8']}
              tickFormatter={(value) => formatPace(Number(value)).replace('/km', '')}
              tickLine={false}
              axisLine={false}
              tick={{ fill: '#92a0b3', fontSize: 12 }}
              width={48}
            />
            <Tooltip
              cursor={{ stroke: '#465365', strokeWidth: 1 }}
              contentStyle={{ border: '1px solid #303946', borderRadius: 8, backgroundColor: '#171b21', color: '#edf2f7' }}
              formatter={(_, __, item) => [
                `${formatPace(item.payload.pace)} · ${item.payload.runs} comparable ${item.payload.runs === 1 ? 'run' : 'runs'} · ${item.payload.averageHeartRate} bpm actual`,
                'Aerobic pace',
              ]}
              labelFormatter={(value) => formatChartDate(Number(value))}
            />
            <ReferenceLine y={best.pace} stroke="#f2c94c" strokeDasharray="5 5" />
            <Line
              type="monotone"
              dataKey="pace"
              stroke="#6fa8ff"
              strokeWidth={3}
              dot={{ r: 4, fill: '#6fa8ff', strokeWidth: 0 }}
              activeDot={{ r: 6, fill: '#ffffff', stroke: '#6fa8ff', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="aerobic-efficiency-confidence">
        Confidence {model.confidence} · {model.eligibleRuns} comparable runs · {Math.round(model.eligibleMinutes)} min eligible
      </p>
    </article>
  );
}

function buildEfficiencyModel(loadModel: TrainingLoadModel) {
  const heartRates = loadModel.sessions
    .map((session) => session.activity.averageHeartRate)
    .filter((value): value is number => Boolean(value && value >= 90 && value <= 210))
    .sort((a, b) => a - b);
  const fallbackAnchor = heartRates[Math.floor(heartRates.length * 0.45)] ?? 150;
  const anchorHeartRate = Math.round(loadModel.thresholds.thresholdHeartRate
    ? loadModel.thresholds.thresholdHeartRate * 0.86
    : fallbackAnchor);
  const eligible = loadModel.sessions.filter((session) => isComparableAerobicRun(session, anchorHeartRate));
  const byWeek = new Map<string, SessionLoad[]>();
  for (const session of eligible) {
    const bucket = byWeek.get(session.weekId) ?? [];
    bucket.push(session);
    byWeek.set(session.weekId, bucket);
  }
  const points: EfficiencyPoint[] = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekId, sessions]) => {
    const totalSeconds = sessions.reduce((sum, session) => sum + session.activity.movingTimeSec, 0);
    const pace = sessions.reduce((sum, session) => {
      const heartRate = session.activity.averageHeartRate as number;
      const normalizedPace = session.paceSecPerKm * heartRate / anchorHeartRate;
      return sum + normalizedPace * session.activity.movingTimeSec;
    }, 0) / totalSeconds;
    const averageHeartRate = sessions.reduce((sum, session) => sum + (session.activity.averageHeartRate as number) * session.activity.movingTimeSec, 0) / totalSeconds;
    return {
      weekId,
      ts: utcDayTimestamp(weekId),
      pace: Math.round(pace),
      runs: sessions.length,
      minutes: totalSeconds / 60,
      averageHeartRate: Math.round(averageHeartRate),
    };
  });
  const recent = mean(points.slice(-3).map((point) => point.pace));
  const prior = mean(points.slice(-6, -3).map((point) => point.pace));
  const delta = recent !== undefined && prior !== undefined ? prior - recent : 0;
  return {
    anchorHeartRate,
    points,
    eligibleRuns: eligible.length,
    eligibleMinutes: eligible.reduce((sum, session) => sum + session.activity.movingTimeSec / 60, 0),
    confidence: eligible.length >= 10 ? 'high' : eligible.length >= 5 ? 'medium' : 'low',
    trend: Math.abs(delta) < 2 ? 'steady' : delta > 0 ? 'improving' : 'easing',
  };
}

function isComparableAerobicRun(session: SessionLoad, anchorHeartRate: number): boolean {
  const activity = session.activity;
  return Boolean(
    activity.averageHeartRate &&
    Math.abs(activity.averageHeartRate - anchorHeartRate) <= 10 &&
    activity.movingTimeSec >= 25 * 60 &&
    activity.movingTimeSec <= 100 * 60 &&
    activity.distanceKm >= 4 &&
    session.externalIntensityFactor <= 0.9 &&
    session.paceSecPerKm >= 150 &&
    session.paceSecPerKm <= 600,
  );
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}
