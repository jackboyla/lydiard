import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Zap } from 'lucide-react';
import type { PowerDurationPoint } from '../analysis/coachEngine';

const X_TICKS = [10, 60, 300, 600, 1200, 3600] as const;
const MIN_DURATION = 10;
const MAX_DURATION = 3600;
const SERIES_ORDER: PowerDurationPoint['freshness'][] = ['historic', 'building', 'recent'];

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
  const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);

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
  const selected = points?.find((point) => pointKey(point) === selectedPointKey);

  return (
    <section className="product-card power-duration-card" aria-labelledby="power-duration-title">
      <header>
        <div>
          <span><Zap size={14} aria-hidden="true" /> Power profile</span>
          <h2 id="power-duration-title">Power duration curve</h2>
          <p>Compare your best measured rolling power across three periods from the last 12 months.</p>
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
      ) : chart.series.length > 0 ? (
        <>
          <div ref={shellRef} className="power-duration-chart-shell">
            <svg
              className="power-duration-chart"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              role="img"
              aria-label={`Power duration chart with ${chart.series.length} time period curves and ${chart.points.length} measured duration records`}
            >
              <desc>Best rolling-average running power by duration, shown as simultaneous curves for 1–30 days, 31–75 days, and 76 or more days ago.</desc>
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
              {chart.series.map((series) => (
                <path
                  key={series.freshness}
                  className={`power-duration-segment freshness-${series.freshness}`}
                  d={series.linePath}
                />
              ))}
              {chart.points.map((point) => (
                <g
                  key={pointKey(point)}
                  className={`power-duration-point freshness-${point.freshness}${selectedPointKey === pointKey(point) ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${periodLabel(point.freshness)} curve, ${formatDuration(point.durationSec)}, ${point.watts} watts, set ${freshnessLabel(point.ageDays)}`}
                  onMouseEnter={() => setSelectedPointKey(pointKey(point))}
                  onFocus={() => setSelectedPointKey(pointKey(point))}
                  onClick={() => setSelectedPointKey(pointKey(point))}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setSelectedPointKey(pointKey(point));
                  }}
                >
                  <circle className="power-duration-hit" cx={point.x} cy={point.y} r={14} />
                  <circle className="power-duration-dot" cx={point.x} cy={point.y} r={5} />
                  <title>{`${periodLabel(point.freshness)} · ${formatDuration(point.durationSec)} · ${point.watts} W · ${freshnessLabel(point.ageDays)}`}</title>
                </g>
              ))}
            </svg>
          </div>

          <div className="power-duration-legend" aria-label="Power duration periods">
            <span><i className="freshness-recent" />1–30 days</span>
            <span><i className="freshness-building" />31–75 days</span>
            <span><i className="freshness-historic" />76+ days</span>
          </div>

          <div className="power-duration-detail" aria-live="polite">
            {selected ? (
              <>
                <div>
                  <small>Selected {periodLabel(selected.freshness)} effort</small>
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
    .sort((a, b) => SERIES_ORDER.indexOf(a.freshness) - SERIES_ORDER.indexOf(b.freshness)
      || a.durationSec - b.durationSec)
    .map((point) => ({ ...point, x: x(point.durationSec), y: y(point.watts) }));
  const series = SERIES_ORDER.flatMap((freshness) => {
    const seriesPoints = plotted.filter((point) => point.freshness === freshness);
    if (seriesPoints.length < 2) return [];
    return [{
      freshness,
      linePath: seriesPoints
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
        .join(' '),
    }];
  });

  return {
    width,
    height,
    left,
    rightEdge,
    top,
    bottom,
    points: plotted,
    series,
    xTicks: X_TICKS.map((value) => ({ value, x: x(value) })),
    yTicks: Array.from({ length: yMax / step + 1 }, (_, index) => {
      const value = index * step;
      return { value, y: y(value) };
    }),
  };
}

function pointKey(point: PowerDurationPoint): string {
  return `${point.freshness}:${point.durationSec}`;
}

function periodLabel(freshness: PowerDurationPoint['freshness']): string {
  if (freshness === 'recent') return '1–30 day';
  if (freshness === 'building') return '31–75 day';
  return '76+ day';
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
