import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  XAxis,
  YAxis,
  usePlotArea,
  useXAxisInverseScale,
  useXAxisScale,
  useYAxisScale,
} from 'recharts';
import { formatPace } from '../analysis/fatigue';
import type { TrainingLoadModel } from '../analysis/loadModel';

const MIN_PACE_SECONDS = 150;
const MAX_PACE_SECONDS = 360;
const MIN_HEART_RATE = 70;
const MAX_HEART_RATE = 220;
const MIN_PROFILE_POINTS = 24;
const MAX_PROFILE_POINTS = 64;

interface PaceHeartRateObservation {
  pace: number;
  heartRate: number;
  activityName: string;
  date: string;
}

interface PaceHeartRateProfilePoint {
  pace: number;
  outerRange: [number, number];
  innerRange: [number, number];
  median: number;
  nearbyRuns: number;
}

interface PaceHeartRateModel {
  observations: PaceHeartRateObservation[];
  profile: PaceHeartRateProfilePoint[];
  runCount: number;
  neighborCount: number;
  paceDomain: [number, number];
  heartRateDomain: [number, number];
}

interface PaceHoverState {
  index: number;
  point: PaceHeartRateProfilePoint;
  anchorX: number;
  alignLeft: boolean;
  top: number;
}

export function HeartRateByPaceChart({ loadModel }: { loadModel: TrainingLoadModel }) {
  const model = buildHeartRateByPaceModel(loadModel);
  const [hoveredProfile, setHoveredProfile] = useState<PaceHoverState | null>(null);
  useEffect(() => setHoveredProfile(null), [loadModel]);

  return (
    <article className="chart-card heart-rate-pace-card">
      <div className="chart-header heart-rate-pace-head">
        <div>
          <p>Continuous pace profile</p>
          <h2>Heart rate across your paces</h2>
          <small>Each dot is one run at its exact average pace; runs slower than 6:00/km are excluded.</small>
        </div>
        {model.runCount > 0 && (
          <div className="heart-rate-pace-count">
            <strong>{model.runCount}</strong>
            <span>{model.runCount === 1 ? 'run' : 'runs'} · exact pace</span>
          </div>
        )}
      </div>

      {model.observations.length === 0 ? (
        <p className="heart-rate-pace-empty">Runs with both heart-rate and pace data are needed for this profile.</p>
      ) : (
        <>
          <div className="heart-rate-pace-legend" aria-label="Pace profile legend">
            <span><i className="heart-rate-pace-outer-key" />Typical range</span>
            <span><i className="heart-rate-pace-inner-key" />Middle 50%</span>
            <span><i className="heart-rate-pace-median-key" />Median</span>
            <span><i className="heart-rate-pace-dot-key" />Each run</span>
          </div>
          <div className="heart-rate-pace-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0} initialDimension={{ width: 900, height: 340 }}>
              <ComposedChart data={model.profile} margin={{ top: 14, right: 20, bottom: 16, left: 0 }}>
                <defs>
                  <linearGradient id="heart-rate-pace-outer-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--green)" stopOpacity={0.16} />
                    <stop offset="100%" stopColor="var(--green)" stopOpacity={0.045} />
                  </linearGradient>
                  <linearGradient id="heart-rate-pace-inner-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--green)" stopOpacity={0.34} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.16} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border-soft)" vertical={false} />
                <XAxis
                  dataKey="pace"
                  type="number"
                  domain={model.paceDomain}
                  reversed
                  allowDataOverflow
                  tickFormatter={(value) => formatPace(Number(value)).replace('/km', '')}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--subtle)', fontSize: 12 }}
                  tickCount={7}
                  minTickGap={24}
                  height={48}
                  label={{ value: 'Average pace (/km) · slower → faster', position: 'insideBottom', offset: -10, fill: 'var(--subtle)', fontSize: 12 }}
                />
                <YAxis
                  dataKey="heartRate"
                  domain={model.heartRateDomain}
                  allowDataOverflow
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'var(--subtle)', fontSize: 12 }}
                  width={54}
                  tickCount={6}
                  label={{ value: 'bpm', angle: -90, position: 'insideLeft', fill: 'var(--subtle)', fontSize: 12 }}
                />
                <Area
                  type="monotone"
                  dataKey="outerRange"
                  name="Typical range"
                  stroke="none"
                  fill="url(#heart-rate-pace-outer-fill)"
                  isAnimationActive={false}
                  activeDot={false}
                />
                <Area
                  type="monotone"
                  dataKey="innerRange"
                  name="Middle 50%"
                  stroke="none"
                  fill="url(#heart-rate-pace-inner-fill)"
                  isAnimationActive={false}
                  activeDot={false}
                />
                <Scatter
                  className="heart-rate-pace-points"
                  name="Run"
                  data={model.observations}
                  dataKey="heartRate"
                  fill="var(--accent)"
                  fillOpacity={0.36}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="median"
                  name="Median"
                  stroke="var(--accent)"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: 'var(--surface)', stroke: 'var(--accent)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
                <PaceHoverLayer
                  profile={model.profile}
                  hoveredProfile={hoveredProfile}
                  onHover={setHoveredProfile}
                />
              </ComposedChart>
            </ResponsiveContainer>
            {hoveredProfile && <PaceHeartRateTooltip hover={hoveredProfile} />}
          </div>
          <p className="heart-rate-pace-note">
            Typical range is the local 10th–90th percentile. Curves use the {model.neighborCount} nearest-pace {model.neighborCount === 1 ? 'run' : 'runs'}, without fixed pace blocks; paces slower than 6:00/km are excluded.
          </p>
        </>
      )}
    </article>
  );
}

export function buildHeartRateByPaceModel(loadModel: TrainingLoadModel): PaceHeartRateModel {
  const observations = loadModel.sessions.flatMap((session) => {
    const heartRate = session.activity.averageHeartRate;
    const pace = session.paceSecPerKm;
    if (
      heartRate === undefined ||
      !Number.isFinite(heartRate) ||
      heartRate < MIN_HEART_RATE ||
      heartRate > MAX_HEART_RATE ||
      !Number.isFinite(pace) ||
      pace < MIN_PACE_SECONDS ||
      pace > MAX_PACE_SECONDS
    ) {
      return [];
    }
    return [{
      pace,
      heartRate,
      activityName: session.activity.name,
      date: session.activity.startDateLocal || session.activity.startDate,
    }];
  }).sort((a, b) => a.pace - b.pace);

  if (observations.length === 0) {
    return {
      observations: [],
      profile: [],
      runCount: 0,
      neighborCount: 0,
      paceDomain: [300, 420],
      heartRateDomain: [100, 190],
    };
  }

  const paces = observations.map(({ pace }) => pace);
  const heartRates = observations.map(({ heartRate }) => heartRate);
  const minPace = Math.min(...paces);
  const maxPace = Math.max(...paces);
  const paceSpan = Math.max(1, maxPace - minPace);
  const profilePointCount = Math.min(
    MAX_PROFILE_POINTS,
    Math.max(MIN_PROFILE_POINTS, Math.ceil(paceSpan / 5)),
  );
  const neighborCount = Math.min(
    observations.length,
    Math.max(1, Math.min(45, Math.round(Math.sqrt(observations.length) * 1.5))),
  );
  const profile = Array.from({ length: profilePointCount }, (_, index) => {
    const pace = profilePointCount === 1
      ? minPace
      : minPace + (paceSpan * index) / (profilePointCount - 1);
    const nearbyHeartRates = observations
      .map((observation) => ({
        distance: Math.abs(observation.pace - pace),
        heartRate: observation.heartRate,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, neighborCount)
      .map(({ heartRate }) => heartRate)
      .sort((a, b) => a - b);
    return {
      pace,
      outerRange: [quantile(nearbyHeartRates, 0.1), quantile(nearbyHeartRates, 0.9)] as [number, number],
      innerRange: [quantile(nearbyHeartRates, 0.25), quantile(nearbyHeartRates, 0.75)] as [number, number],
      median: quantile(nearbyHeartRates, 0.5),
      nearbyRuns: nearbyHeartRates.length,
    };
  });

  const pacePadding = Math.max(4, paceSpan * 0.015);
  const heartRateMin = Math.max(MIN_HEART_RATE, Math.floor((Math.min(...heartRates) - 5) / 10) * 10);
  const heartRateMax = Math.min(MAX_HEART_RATE, Math.ceil((Math.max(...heartRates) + 5) / 10) * 10);

  return {
    observations,
    profile,
    runCount: observations.length,
    neighborCount,
    paceDomain: [
      Math.max(MIN_PACE_SECONDS, minPace - pacePadding),
      Math.min(MAX_PACE_SECONDS, maxPace + pacePadding),
    ],
    heartRateDomain: [heartRateMin, Math.max(heartRateMin + 10, heartRateMax)],
  };
}

function quantile(sorted: number[], percentile: number): number {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const fraction = index - lower;
  const upper = sorted[lower + 1];
  return upper === undefined ? sorted[lower] : sorted[lower] + fraction * (upper - sorted[lower]);
}

function PaceHoverLayer({
  profile,
  hoveredProfile,
  onHover,
}: {
  profile: PaceHeartRateProfilePoint[];
  hoveredProfile: PaceHoverState | null;
  onHover: Dispatch<SetStateAction<PaceHoverState | null>>;
}) {
  const plot = usePlotArea();
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const invertX = useXAxisInverseScale();
  if (!plot || !xScale || !yScale || !invertX || profile.length === 0) return null;

  const activeX = hoveredProfile ? Number(xScale(hoveredProfile.point.pace)) : undefined;
  const activeY = hoveredProfile ? Number(yScale(hoveredProfile.point.median)) : undefined;

  return (
    <g className="heart-rate-pace-hover-layer">
      {hoveredProfile && Number.isFinite(activeX) && Number.isFinite(activeY) && (
        <>
          <line x1={activeX} x2={activeX} y1={plot.y} y2={plot.y + plot.height} className="heart-rate-pace-hover-cursor" />
          <circle cx={activeX} cy={activeY} r={4} className="heart-rate-pace-hover-dot" />
        </>
      )}
      <rect
        x={plot.x}
        y={plot.y}
        width={plot.width}
        height={plot.height}
        fill="transparent"
        onPointerMove={(event) => {
          const svg = event.currentTarget.ownerSVGElement;
          if (!svg) return;
          const pointerX = event.clientX - svg.getBoundingClientRect().left;
          const pace = Number(invertX(pointerX));
          if (!Number.isFinite(pace)) return;
          let nearestIndex = 0;
          for (let index = 1; index < profile.length; index += 1) {
            if (Math.abs(profile[index].pace - pace) < Math.abs(profile[nearestIndex].pace - pace)) nearestIndex = index;
          }
          const point = profile[nearestIndex];
          const anchorX = event.clientX;
          const alignLeft = anchorX > window.innerWidth * 0.62;
          const top = Math.max(12, Math.min(window.innerHeight - 96, event.clientY - 42));
          onHover((current) => current?.index === nearestIndex &&
            Math.abs(current.anchorX - anchorX) < 4 &&
            Math.abs(current.top - top) < 4
              ? current
              : { index: nearestIndex, point, anchorX, alignLeft, top });
        }}
        onPointerLeave={() => onHover(null)}
      />
    </g>
  );
}

function PaceHeartRateTooltip({ hover }: { hover: PaceHoverState }) {
  const point = hover.point;
  return (
    <div
      className={`heart-rate-pace-tooltip${hover.alignLeft ? ' align-left' : ''}`}
      style={{ left: hover.anchorX + (hover.alignLeft ? -12 : 12), top: hover.top }}
    >
      <span>{formatPace(point.pace)}</span>
      <strong>{Math.round(point.median)} bpm median</strong>
      <small>Middle 50% {Math.round(point.innerRange[0])}–{Math.round(point.innerRange[1])} · typical {Math.round(point.outerRange[0])}–{Math.round(point.outerRange[1])}</small>
    </div>
  );
}
