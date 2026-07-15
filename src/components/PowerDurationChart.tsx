import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Zap } from 'lucide-react';
import type { PowerDurationPoint } from '../analysis/coachEngine';

const X_TICKS = [10, 60, 300, 600, 1200, 3600] as const;
const MIN_DURATION = 10;
const MAX_DURATION = 3600;

export function PowerDurationChart({
  points,
  criticalPowerWatts,
  loading,
  error,
  onRetry,
  onOpenActivity,
}: {
  points: PowerDurationPoint[] | undefined;
  criticalPowerWatts?: number;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onOpenActivity: (activityId: string) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(300, Math.round(entry.contentRect.width)));
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [loading, points?.length]);

  const chart = useMemo(() => buildChart(points ?? [], width), [points, width]);
  const selected = points?.find((point) => point.durationSec === selectedDuration);

  return (
    <section className="product-card power-duration-card" aria-labelledby="power-duration-title">
      <header>
        <div>
          <span><Zap size={14} aria-hidden="true" /> Power profile</span>
          <h2 id="power-duration-title">Power duration curve</h2>
          <p>Your best measured rolling power at each duration from the last 12 months.</p>
        </div>
        <div className="power-duration-cp" aria-label={criticalPowerWatts ? `Critical Power ${Math.round(criticalPowerWatts)} watts` : 'Critical Power unavailable'}>
          <small>Critical Power</small>
          <strong>{criticalPowerWatts ? `${Math.round(criticalPowerWatts)} W` : '—'}</strong>
        </div>
      </header>

      {loading && !points ? (
        <div className="power-duration-state" role="status">Reading power streams…</div>
      ) : error && !points ? (
        <div className="power-duration-state power-duration-error" role="alert">
          <strong>Power data couldn’t load</strong>
          <p>{error}</p>
          <button type="button" onClick={onRetry}>Try again</button>
        </div>
      ) : chart.points.length >= 2 ? (
        <>
          <div ref={shellRef} className="power-duration-chart-shell">
            <svg
              className="power-duration-chart"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              role="img"
              aria-label={`Power duration curve with ${chart.points.length} measured duration records`}
            >
              <desc>Best rolling-average running power by duration. Point colors show how recently each record was set.</desc>
              <defs>
                <linearGradient id="power-duration-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--power-recent)" stopOpacity="0.28" />
                  <stop offset="1" stopColor="var(--power-recent)" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {chart.yTicks.map((tick) => (
                <g key={tick.value} className="power-duration-grid">
                  <line x1={chart.left} y1={tick.y} x2={chart.rightEdge} y2={tick.y} />
                  <text x={chart.left - 10} y={tick.y + 4} textAnchor="end">{tick.value}</text>
                </g>
              ))}
              {chart.xTicks.map((tick) => (
                <g key={tick.value} className="power-duration-x-tick">
                  <line x1={tick.x} y1={chart.top} x2={tick.x} y2={chart.bottom} />
                  <text x={tick.x} y={chart.bottom + 25} textAnchor="middle">{formatDuration(tick.value)}</text>
                </g>
              ))}
              <text className="power-duration-y-unit" x={chart.left} y={15}>W</text>
              <path className="power-duration-area" d={chart.areaPath} />
              {chart.segments.map((segment) => (
                <line
                  key={`${segment.from.durationSec}-${segment.to.durationSec}`}
                  className={`power-duration-segment freshness-${segment.to.freshness}`}
                  x1={segment.from.x}
                  y1={segment.from.y}
                  x2={segment.to.x}
                  y2={segment.to.y}
                />
              ))}
              {chart.points.map((point) => (
                <g
                  key={point.durationSec}
                  className={`power-duration-point freshness-${point.freshness}${selectedDuration === point.durationSec ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${formatDuration(point.durationSec)}, ${point.watts} watts, set ${freshnessLabel(point.ageDays)}`}
                  onMouseEnter={() => setSelectedDuration(point.durationSec)}
                  onFocus={() => setSelectedDuration(point.durationSec)}
                  onClick={() => setSelectedDuration(point.durationSec)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setSelectedDuration(point.durationSec);
                  }}
                >
                  <circle className="power-duration-hit" cx={point.x} cy={point.y} r={14} />
                  <circle className="power-duration-dot" cx={point.x} cy={point.y} r={5} />
                  <title>{`${formatDuration(point.durationSec)} · ${point.watts} W · ${freshnessLabel(point.ageDays)}`}</title>
                </g>
              ))}
            </svg>
          </div>

          <div className="power-duration-legend" aria-label="Record freshness">
            <span><i className="freshness-recent" />1–30 days</span>
            <span><i className="freshness-building" />31–75 days</span>
            <span><i className="freshness-historic" />76+ days</span>
          </div>

          <div className="power-duration-detail" aria-live="polite">
            {selected ? (
              <>
                <div>
                  <small>Selected effort</small>
                  <strong>{formatDuration(selected.durationSec)} at {selected.watts} W</strong>
                  <span>{freshnessLabel(selected.ageDays)} · {formatDate(selected.activityDate)}</span>
                </div>
                <button type="button" onClick={() => onOpenActivity(selected.activityId)}>
                  <Activity size={15} aria-hidden="true" /> View run
                </button>
              </>
            ) : (
              <p>Select a point to inspect the run behind it.</p>
            )}
          </div>
        </>
      ) : (
        <div className="power-duration-state">
          <strong>No power curve yet</strong>
          <p>At least two durations with reliable running-power streams are needed.</p>
        </div>
      )}
    </section>
  );
}

function buildChart(points: PowerDurationPoint[], width: number) {
  const height = width < 520 ? 290 : 340;
  const left = width < 520 ? 43 : 54;
  const rightEdge = width - (width < 520 ? 10 : 18);
  const top = 28;
  const bottom = height - 48;
  const maxWatts = Math.max(100, ...points.map((point) => point.watts));
  const step = maxWatts > 700 ? 200 : 100;
  const yMax = Math.ceil(maxWatts / step) * step;
  const x = (durationSec: number) => left
    + ((Math.log10(durationSec) - Math.log10(MIN_DURATION)) / (Math.log10(MAX_DURATION) - Math.log10(MIN_DURATION)))
      * (rightEdge - left);
  const y = (watts: number) => top + (1 - watts / yMax) * (bottom - top);
  const plotted = [...points]
    .sort((a, b) => a.durationSec - b.durationSec)
    .map((point) => ({ ...point, x: x(point.durationSec), y: y(point.watts) }));
  const linePath = plotted.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = plotted.length > 1
    ? `${linePath} L ${plotted.at(-1)?.x} ${bottom} L ${plotted[0].x} ${bottom} Z`
    : '';

  return {
    width,
    height,
    left,
    rightEdge,
    top,
    bottom,
    areaPath,
    points: plotted,
    segments: plotted.slice(1).map((point, index) => ({ from: plotted[index], to: point })),
    xTicks: X_TICKS.map((value) => ({ value, x: x(value) })),
    yTicks: Array.from({ length: yMax / step + 1 }, (_, index) => {
      const value = index * step;
      return { value, y: y(value) };
    }),
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return '1h';
}

function freshnessLabel(ageDays: number): string {
  if (ageDays === 0) return 'today';
  if (ageDays === 1) return '1 day ago';
  return `${ageDays} days ago`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
    : value.slice(0, 10);
}
