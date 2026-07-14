import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPace } from '../analysis/fatigue';
import type { ActivityLapView } from '../data/activityLaps';
import type { ActivityDetail } from '../types';

interface DistanceHeartRatePoint {
  distanceKm: number;
  heartRate: number;
}

interface DistancePowerPoint {
  distanceKm: number;
  power: number;
}

interface StreamSummary {
  average: number;
  maximum: number;
}

export function ActivityRunCharts({
  detail,
  loading,
  laps,
}: {
  detail: ActivityDetail | null;
  loading: boolean;
  laps: ActivityLapView[];
}) {
  const heartRatePoints = buildDistanceHeartRatePoints(detail);
  const powerPoints = buildDistancePowerPoints(detail);
  const heartRateSummary = summarizeDistanceStream(detail, 'heartRate');
  const powerSummary = summarizeDistanceStream(detail, 'power');
  const recorded = laps.some((lap) => lap.source === 'recorded');

  return (
    <section className="activity-stream-charts" aria-label="Run charts">
      <article className="activity-stream-chart activity-lap-profile">
        <header>
          <div><span>Splits</span><h3>Recorded lap profile</h3></div>
          <small>{laps.length > 0 ? `${laps.length} ${recorded ? 'recorded laps' : 'derived splits'}` : loading ? 'Loading…' : 'No lap data'}</small>
        </header>
        {laps.length > 0 ? (
          <LapProfileChart detail={detail} laps={laps} />
        ) : (
          <p className="activity-chart-empty">{loading ? 'Loading recorded laps…' : 'Recorded laps or a continuous distance stream are needed for this chart.'}</p>
        )}
      </article>

      <article className="activity-stream-chart activity-distance-hr-chart">
        <header>
          <div><span>Continuous effort</span><h3>Heart rate over distance</h3></div>
          <small>{heartRatePoints.length > 0 ? `${heartRatePoints.at(-1)?.distanceKm.toFixed(1)} km` : loading ? 'Loading…' : 'No HR stream'}</small>
        </header>
        {heartRatePoints.length > 1 ? (
          <div className="activity-chart-canvas">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} initialDimension={{ width: 700, height: 270 }}>
              <LineChart data={heartRatePoints} margin={{ top: 12, right: 14, bottom: 20, left: 0 }}>
                <CartesianGrid stroke="var(--border-soft)" vertical={false} />
                <XAxis
                  dataKey="distanceKm"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(value) => Number(value).toFixed(0)}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--subtle)', fontSize: 11 }}
                  label={{ value: 'Distance (km)', position: 'insideBottom', offset: -10, fill: 'var(--subtle)', fontSize: 11 }}
                />
                <YAxis
                  dataKey="heartRate"
                  domain={['dataMin - 5', 'dataMax + 5']}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--subtle)', fontSize: 11 }}
                  width={42}
                  label={{ value: 'bpm', angle: -90, position: 'insideLeft', fill: 'var(--subtle)', fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
                  contentStyle={{ border: '1px solid var(--border)', borderRadius: 10, backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                  labelFormatter={(value) => `${Number(value).toFixed(2)} km`}
                  formatter={(value) => [`${Math.round(Number(value))} bpm`, 'Heart rate']}
                />
                <Line
                  type="linear"
                  dataKey="heartRate"
                  name="Heart rate"
                  stroke="var(--danger)"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: 'var(--surface)', stroke: 'var(--danger)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="activity-chart-empty">{loading ? 'Loading distance and heart-rate streams…' : 'Distance-aligned heart-rate samples are not available for this run.'}</p>
        )}
        <ChartSummary summary={heartRateSummary} unit="bpm" averageLabel="Average HR" maximumLabel="Maximum HR" />
      </article>

      <article className="activity-stream-chart activity-distance-power-chart">
        <header>
          <div><span>Continuous output</span><h3>Power over distance</h3></div>
          <small>{powerPoints.length > 0 ? `${powerPoints.at(-1)?.distanceKm.toFixed(1)} km` : loading ? 'Loading…' : 'No power stream'}</small>
        </header>
        {powerPoints.length > 1 ? (
          <div className="activity-chart-canvas">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} initialDimension={{ width: 700, height: 270 }}>
              <LineChart data={powerPoints} margin={{ top: 12, right: 14, bottom: 20, left: 0 }}>
                <CartesianGrid stroke="var(--border-soft)" vertical={false} />
                <XAxis
                  dataKey="distanceKm"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(value) => Number(value).toFixed(0)}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--subtle)', fontSize: 11 }}
                  label={{ value: 'Distance (km)', position: 'insideBottom', offset: -10, fill: 'var(--subtle)', fontSize: 11 }}
                />
                <YAxis
                  dataKey="power"
                  domain={['dataMin - 10', 'dataMax + 10']}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--subtle)', fontSize: 11 }}
                  width={48}
                  label={{ value: 'watts', angle: -90, position: 'insideLeft', fill: 'var(--subtle)', fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
                  contentStyle={{ border: '1px solid var(--border)', borderRadius: 10, backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                  labelFormatter={(value) => `${Number(value).toFixed(2)} km`}
                  formatter={(value) => [`${Math.round(Number(value))} W`, 'Power']}
                />
                <Line
                  type="linear"
                  dataKey="power"
                  name="Power"
                  stroke="var(--note)"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: 'var(--surface)', stroke: 'var(--note)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="activity-chart-empty">{loading ? 'Loading distance and power streams…' : 'Distance-aligned power samples are not available for this run.'}</p>
        )}
        <ChartSummary summary={powerSummary} unit="W" averageLabel="Average power" maximumLabel="Maximum power" />
      </article>
    </section>
  );
}

function ChartSummary({
  summary,
  unit,
  averageLabel,
  maximumLabel,
}: {
  summary: StreamSummary | undefined;
  unit: string;
  averageLabel: string;
  maximumLabel: string;
}) {
  return (
    <div className="activity-chart-summary" aria-label={`${averageLabel} and ${maximumLabel}`}>
      <span><small>{averageLabel}</small><strong>{summary ? `${Math.round(summary.average)} ${unit}` : '—'}</strong></span>
      <span><small>{maximumLabel}</small><strong>{summary ? `${Math.round(summary.maximum)} ${unit}` : '—'}</strong></span>
    </div>
  );
}

function LapProfileChart({ detail, laps }: { detail: ActivityDetail | null; laps: ActivityLapView[] }) {
  const model = buildLapProfileModel(detail, laps);
  return (
    <div className="lap-profile-shell">
      <div className="lap-profile-scroll">
        <svg
          viewBox={`0 0 ${model.width} ${model.height}`}
          style={{ width: `${model.width}px`, height: `${model.height}px` }}
          role="img"
          aria-label="Lap pace by lap number"
        >
          {model.ticks.map((tick) => (
            <g key={tick.value} className="lap-profile-grid">
              <line x1={model.left} y1={tick.y} x2={model.width - model.right} y2={tick.y} />
              <text x={model.left - 8} y={tick.y + 4} textAnchor="end">{formatPace(tick.value).replace('/km', '')}</text>
            </g>
          ))}
          {model.backgroundPath && <path className="lap-profile-trace" d={model.backgroundPath} />}
          {model.bars.map((bar) => (
            <g key={`${bar.lap.index}-${bar.x}`}>
              <rect
                className={`lap-profile-bar zone-${bar.lap.zone.key}`}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={model.bottom - bar.y}
                rx={Math.min(7, bar.width / 3)}
              >
                <title>{`Lap ${bar.lap.label}: ${bar.lap.distanceKm.toFixed(2)} km · ${formatPace(bar.lap.paceSecPerKm)} · ${bar.lap.zone.label}`}</title>
              </rect>
              {bar.showLabel && <text className="lap-profile-label" x={bar.x + bar.width / 2} y={model.bottom + 22} textAnchor="middle">{bar.lap.label}</text>}
            </g>
          ))}
          <text className="lap-profile-unit" x={8} y={model.bottom - 3}>/km</text>
          <text className="lap-profile-axis-title" x={(model.left + model.width - model.right) / 2} y={model.height - 4} textAnchor="middle">Lap number</text>
        </svg>
      </div>
      <p>Bar width follows lap distance. The grey trace is continuous pace; colour shows the split zone.</p>
    </div>
  );
}

function buildLapProfileModel(detail: ActivityDetail | null, laps: ActivityLapView[]) {
  const height = 292;
  const left = 56;
  const right = 14;
  const top = 12;
  const bottom = 244;
  const distanceWidth = laps.reduce((total, lap) => total + Math.max(9, lap.distanceKm * 54), 0);
  const width = Math.max(650, left + right + distanceWidth);
  const paceTrace = buildContinuousPaceTrace(detail);
  const lapPaces = laps.map((lap) => lap.paceSecPerKm)
    .filter((pace) => Number.isFinite(pace) && pace >= 90 && pace <= 720)
    .sort((a, b) => a - b);
  const activityPace = detail && detail.distanceKm > 0 ? detail.movingTimeSec / detail.distanceKm : undefined;
  const fast = lapPaces.length ? Math.max(90, Math.floor((lapPaces[0] - 10) / 30) * 30) : 150;
  const representativeSlow = Math.max(percentile(lapPaces, 0.85) ?? 330, activityPace ? activityPace * 1.25 : 0);
  const slow = Math.min(600, Math.ceil((representativeSlow + 10) / 30) * 30);
  const domainSlow = slow <= fast ? fast + 60 : slow;
  const plotHeight = bottom - top;
  const yForPace = (pace: number) => top + ((Math.min(domainSlow, Math.max(fast, pace)) - fast) / (domainSlow - fast)) * plotHeight;
  const contentWidth = width - left - right;
  const rawWidth = Math.max(1, distanceWidth);
  let cursor = left;
  const bars = laps.map((lap, index) => {
    const allocated = Math.max(9, lap.distanceKm * 54) * (contentWidth / rawWidth);
    const gap = Math.min(3, allocated * 0.12);
    const bar = {
      lap,
      x: cursor + gap / 2,
      y: yForPace(lap.paceSecPerKm),
      width: Math.max(2, allocated - gap),
      showLabel: allocated >= 22 || index === 0 || index === laps.length - 1 || lap.zone.key === 'strides',
    };
    cursor += allocated;
    return bar;
  });
  const totalTraceDistance = paceTrace.at(-1)?.distanceKm ?? 0;
  const backgroundPath = totalTraceDistance > 0
    ? `M ${left} ${bottom} ${paceTrace.map((point) => {
      const x = left + (point.distanceKm / totalTraceDistance) * contentWidth;
      return `L ${x.toFixed(2)} ${yForPace(point.paceSecPerKm).toFixed(2)}`;
    }).join(' ')} L ${width - right} ${bottom} Z`
    : '';
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const value = fast + ((domainSlow - fast) * index) / 4;
    return { value, y: yForPace(value) };
  });
  return { width, height, left, right, bottom, bars, ticks, backgroundPath };
}

function percentile(sorted: number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const position = Math.min(sorted.length - 1, Math.max(0, fraction * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function buildContinuousPaceTrace(detail: ActivityDetail | null): Array<{ distanceKm: number; paceSecPerKm: number }> {
  const distance = detail?.streams?.distanceM;
  if (!distance || distance.length < 2) return [];
  const velocity = detail?.streams?.velocity;
  const time = detail?.streams?.timeSec;
  const count = Math.min(distance.length, velocity?.length ?? time?.length ?? 0);
  if (count < 2) return [];
  const stride = Math.max(1, Math.ceil(count / 500));
  const points: Array<{ distanceKm: number; paceSecPerKm: number }> = [];
  for (let index = stride; index < count; index += stride) {
    const distanceKm = distance[index] / 1000;
    const speed = velocity?.[index];
    const deltaDistance = distance[index] - distance[Math.max(0, index - stride)];
    const deltaTime = time ? time[index] - time[Math.max(0, index - stride)] : 0;
    const paceSecPerKm = speed && speed > 0.2 ? 1000 / speed : deltaDistance > 0 && deltaTime > 0 ? deltaTime / (deltaDistance / 1000) : 0;
    if (Number.isFinite(distanceKm) && Number.isFinite(paceSecPerKm) && paceSecPerKm >= 90 && paceSecPerKm <= 720) {
      points.push({ distanceKm, paceSecPerKm });
    }
  }
  return points;
}

export function buildDistanceHeartRatePoints(detail: ActivityDetail | null): DistanceHeartRatePoint[] {
  const distance = detail?.streams?.distanceM;
  const heartRate = detail?.streams?.heartrate;
  if (!distance || !heartRate) return [];
  const count = Math.min(distance.length, heartRate.length);
  if (count < 2) return [];
  const stride = Math.max(1, Math.ceil(count / 700));
  const points: DistanceHeartRatePoint[] = [];
  for (let index = 0; index < count; index += stride) {
    const distanceKm = distance[index] / 1000;
    const bpm = heartRate[index];
    if (Number.isFinite(distanceKm) && distanceKm >= 0 && Number.isFinite(bpm) && bpm >= 40 && bpm <= 240) {
      points.push({ distanceKm, heartRate: bpm });
    }
  }
  const finalIndex = count - 1;
  const finalDistanceKm = distance[finalIndex] / 1000;
  const finalHeartRate = heartRate[finalIndex];
  if (
    Number.isFinite(finalDistanceKm) &&
    Number.isFinite(finalHeartRate) &&
    finalHeartRate >= 40 &&
    finalHeartRate <= 240 &&
    points.at(-1)?.distanceKm !== finalDistanceKm
  ) {
    points.push({ distanceKm: finalDistanceKm, heartRate: finalHeartRate });
  }
  return points;
}

export function buildDistancePowerPoints(detail: ActivityDetail | null): DistancePowerPoint[] {
  const distance = detail?.streams?.distanceM;
  const power = detail?.streams?.power;
  if (!distance || !power) return [];
  const count = Math.min(distance.length, power.length);
  if (count < 2) return [];
  const stride = Math.max(1, Math.ceil(count / 700));
  const points: DistancePowerPoint[] = [];
  for (let index = 0; index < count; index += stride) {
    const distanceKm = distance[index] / 1000;
    const watts = power[index];
    if (Number.isFinite(distanceKm) && distanceKm >= 0 && Number.isFinite(watts) && watts > 0 && watts <= 2000) {
      points.push({ distanceKm, power: watts });
    }
  }
  const finalIndex = count - 1;
  const finalDistanceKm = distance[finalIndex] / 1000;
  const finalPower = power[finalIndex];
  if (
    Number.isFinite(finalDistanceKm) &&
    Number.isFinite(finalPower) &&
    finalPower > 0 &&
    finalPower <= 2000 &&
    points.at(-1)?.distanceKm !== finalDistanceKm
  ) {
    points.push({ distanceKm: finalDistanceKm, power: finalPower });
  }
  return points;
}

function summarizeDistanceStream(
  detail: ActivityDetail | null,
  metric: 'heartRate' | 'power',
): StreamSummary | undefined {
  const distance = detail?.streams?.distanceM;
  const values = metric === 'heartRate' ? detail?.streams?.heartrate : detail?.streams?.power;
  if (!distance || !values) return undefined;
  const count = Math.min(distance.length, values.length);
  let total = 0;
  let validCount = 0;
  let maximum = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const value = values[index];
    const valid = metric === 'heartRate'
      ? Number.isFinite(value) && value >= 40 && value <= 240
      : Number.isFinite(value) && value > 0 && value <= 2000;
    if (!Number.isFinite(distance[index]) || distance[index] < 0 || !valid) continue;
    total += value;
    validCount += 1;
    maximum = Math.max(maximum, value);
  }
  return validCount > 0 ? { average: total / validCount, maximum } : undefined;
}
