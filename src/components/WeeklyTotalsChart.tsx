import { useEffect, useMemo, useRef, useState } from 'react';
import type { WeekLoadSummary } from '../analysis/loadModel';

export type WeeklyTotalsMetric = 'time' | 'distance';

const FILL_ID = 'weekly-totals-fill';

/**
 * Weekly totals as a filled trend line: the selected week drives the headline
 * distance / time / elevation readout, the same way the Strava progress chart
 * reads. Hovering or focusing a week selects it; activating it opens that week
 * in Log (on phones the first tap selects and the second opens).
 */
export function WeeklyTotalsChart({
  weeks,
  metric,
  activeWeekId,
  armedWeekId,
  onSelectWeek,
  onActivateWeek,
}: {
  weeks: WeekLoadSummary[];
  metric: WeeklyTotalsMetric;
  activeWeekId: string | null;
  armedWeekId: string | null;
  onSelectWeek: (weekId: string) => void;
  onActivateWeek: (weekId: string, pointerActivated: boolean) => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrubbing = useRef(false);
  const travelled = useRef(0);
  const startX = useRef(0);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [weeks.length]);

  const chart = useMemo(() => buildChart(weeks, metric, width), [weeks, metric, width]);
  const selected = weeks.find((week) => week.weekId === activeWeekId) ?? weeks[weeks.length - 1];
  const selectedPoint = chart.points.find((point) => point.week.weekId === selected?.weekId);

  /** The week nearest a screen x, so a thumb anywhere over the plot tracks the line. */
  const weekAtClientX = (clientX: number): string | null => {
    const svg = svgRef.current;
    if (!svg || chart.points.length === 0) return null;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width === 0) return null;
    const x = ((clientX - bounds.left) / bounds.width) * chart.width;
    let nearest = chart.points[0];
    for (const point of chart.points) {
      if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
    }
    return nearest.week.weekId;
  };

  const trackTo = (clientX: number) => {
    const weekId = weekAtClientX(clientX);
    if (weekId && weekId !== selected?.weekId) onSelectWeek(weekId);
  };

  if (!selected || chart.points.length === 0) {
    return (
      <div className="weekly-totals" role="status">
        <p className="weekly-totals-empty">No weeks in this range yet.</p>
      </div>
    );
  }

  return (
    <div className="weekly-totals">
      <div className="weekly-totals-summary" aria-live="polite">
        <h3>{formatWeekRange(selected.weekId)}</h3>
        <div className="weekly-totals-stats">
          <div>
            <span>Distance</span>
            <strong>{selected.distanceKm.toFixed(2)} km</strong>
          </div>
          <div>
            <span>Time</span>
            <strong>{formatHoursMinutes(selected.durationHours)}</strong>
          </div>
          <div>
            <span>Elev Gain</span>
            <strong>{Math.round(weekElevationM(selected)).toLocaleString()} m</strong>
          </div>
        </div>
      </div>

      <div ref={shellRef} className="weekly-totals-chart-shell">
        <svg
          ref={svgRef}
          className="weekly-totals-chart"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label={`${weeks.length} weekly totals by ${metric === 'time' ? 'training time' : 'distance'}`}
        >
          <defs>
            <linearGradient id={FILL_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="weekly-totals-fill-top" />
              <stop offset="100%" className="weekly-totals-fill-bottom" />
            </linearGradient>
          </defs>

          {chart.gridLines.map((line) => (
            <g key={line.ratio} className="weekly-totals-grid">
              <line x1={chart.left} y1={line.y} x2={chart.right} y2={line.y} />
              <text x={chart.right + 8} y={line.y + 4}>{line.label}</text>
            </g>
          ))}

          <path className="weekly-totals-area" d={chart.areaPath} fill={`url(#${FILL_ID})`} />
          <path className="weekly-totals-line" d={chart.linePath} />

          {selectedPoint && (
            <line
              className="weekly-totals-rule"
              x1={selectedPoint.x}
              y1={chart.top}
              x2={selectedPoint.x}
              y2={chart.bottom}
            />
          )}

          {chart.showMarkers && chart.points.map((point) => (
            <circle
              key={point.week.weekId}
              className="weekly-totals-dot"
              cx={point.x}
              cy={point.y}
              r={4}
            />
          ))}

          {selectedPoint && (
            <>
              <circle className="weekly-totals-halo" cx={selectedPoint.x} cy={selectedPoint.y} r={11} />
              <circle className="weekly-totals-dot selected" cx={selectedPoint.x} cy={selectedPoint.y} r={5.5} />
            </>
          )}

          {chart.monthTicks.map((tick) => (
            <text key={tick.key} className="weekly-totals-month" x={tick.x} y={chart.bottom + 20}>
              {tick.label}
            </text>
          ))}

          {/* Keyboard and screen-reader access to each week. Pointers are handled by
              the scrub surface below so a thumb can slide across the whole plot. */}
          {chart.points.map((point) => (
            <rect
              key={`hit-${point.week.weekId}`}
              className={`weekly-totals-hit${point.week.weekId === selected.weekId ? ' selected' : ''}`}
              x={point.x - chart.columnWidth / 2}
              y={chart.top}
              width={chart.columnWidth}
              height={chart.bottom - chart.top}
              role="button"
              tabIndex={0}
              aria-label={`${point.week.label}, ${formatWeekTotals(point.week)}${armedWeekId === point.week.weekId ? ', activate again to open in Log' : ''}`}
              onFocus={() => onSelectWeek(point.week.weekId)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onActivateWeek(point.week.weekId, false);
              }}
            >
              <title>{`${point.week.label} · ${formatWeekTotals(point.week)}`}</title>
            </rect>
          ))}

          <rect
            className="weekly-totals-surface"
            x={0}
            y={0}
            width={chart.width}
            height={chart.height}
            aria-hidden="true"
            onPointerDown={(event) => {
              scrubbing.current = true;
              travelled.current = 0;
              startX.current = event.clientX;
              event.currentTarget.setPointerCapture(event.pointerId);
              trackTo(event.clientX);
            }}
            onPointerMove={(event) => {
              if (scrubbing.current) {
                travelled.current = Math.max(travelled.current, Math.abs(event.clientX - startX.current));
                trackTo(event.clientX);
              } else if (event.pointerType === 'mouse') {
                trackTo(event.clientX);
              }
            }}
            onPointerUp={(event) => {
              if (!scrubbing.current) return;
              scrubbing.current = false;
              // A slide reads the weeks; only a tap in place opens one in Log.
              if (travelled.current > 8) return;
              const weekId = weekAtClientX(event.clientX);
              if (weekId) onActivateWeek(weekId, true);
            }}
            onPointerCancel={() => { scrubbing.current = false; }}
          />
        </svg>
      </div>
    </div>
  );
}

function buildChart(weeks: WeekLoadSummary[], metric: WeeklyTotalsMetric, width: number) {
  const compact = width < 520;
  const height = compact ? 200 : 240;
  const left = 12;
  const right = width - (compact ? 54 : 64);
  const top = 16;
  const bottom = height - 30;
  const values = weeks.map((week) => (metric === 'time' ? week.durationHours : week.distanceKm));
  const yMax = niceMax(Math.max(...values, 0));
  const step = weeks.length > 1 ? (right - left) / (weeks.length - 1) : 0;
  const x = (index: number) => (weeks.length > 1 ? left + index * step : (left + right) / 2);
  const y = (value: number) => bottom - (value / yMax) * (bottom - top);
  const points = weeks.map((week, index) => ({
    week,
    value: values[index],
    x: round(x(index)),
    y: round(y(values[index])),
  }));

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const areaPath = points.length > 0
    ? `${linePath} L ${last.x} ${bottom} L ${first.x} ${bottom} Z`
    : '';

  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    points,
    linePath,
    areaPath,
    columnWidth: weeks.length > 1 ? step : right - left,
    showMarkers: weeks.length > 1 && step >= 16,
    gridLines: [1, 0.5, 0].map((ratio) => ({
      ratio,
      y: round(y(yMax * ratio)),
      label: formatAxisValue(yMax * ratio, metric),
    })),
    monthTicks: buildMonthTicks(points, compact, left, right),
  };
}

/** One label per month, thinned on narrow screens so the ticks never collide. */
function buildMonthTicks(
  points: Array<{ week: WeekLoadSummary; x: number }>,
  compact: boolean,
  left: number,
  right: number,
): Array<{ key: string; x: number; label: string }> {
  const starts = points.filter((point, index) => {
    if (index === 0) return true;
    return monthKey(point.week.weekId) !== monthKey(points[index - 1].week.weekId);
  });
  const interval = starts.length > (compact ? 5 : 9) ? Math.ceil(starts.length / (compact ? 5 : 9)) : 1;
  return starts
    .filter((_, index) => index % interval === 0)
    .map((point) => ({
      key: monthKey(point.week.weekId),
      // Centred labels at either end would run off the plot, so hold them inside it.
      x: Math.min(Math.max(point.x, left + 14), right - 14),
      label: new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })
        .format(weekDate(point.week.weekId))
        .toUpperCase(),
    }));
}

function weekElevationM(week: WeekLoadSummary): number {
  return week.sessions.reduce((total, session) => total + (session.activity.elevationGainM || 0), 0);
}

function formatWeekTotals(week: WeekLoadSummary): string {
  return `${week.distanceKm.toFixed(1)} km · ${formatHoursMinutes(week.durationHours)} · ${week.activityCount} ${week.activityCount === 1 ? 'run' : 'runs'}`;
}

function formatHoursMinutes(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** "6 – 12 Jul 2026", collapsing the repeated month or year where it reads cleanly. */
function formatWeekRange(weekId: string): string {
  const start = weekDate(weekId);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const day = (date: Date) => date.getUTCDate();
  const month = (date: Date) => new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(date);
  const year = (date: Date) => date.getUTCFullYear();
  if (year(start) !== year(end)) {
    return `${day(start)} ${month(start)} ${year(start)} – ${day(end)} ${month(end)} ${year(end)}`;
  }
  if (month(start) !== month(end)) {
    return `${day(start)} ${month(start)} – ${day(end)} ${month(end)} ${year(end)}`;
  }
  return `${day(start)} – ${day(end)} ${month(end)} ${year(end)}`;
}

function formatAxisValue(value: number, metric: WeeklyTotalsMetric): string {
  if (metric === 'time') {
    return Number.isInteger(value) || value >= 10 ? `${Math.round(value)}h` : `${value.toFixed(1)}h`;
  }
  return `${Math.round(value)} km`;
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return nice * magnitude;
}

function weekDate(weekId: string): Date {
  return new Date(`${weekId}T00:00:00Z`);
}

function monthKey(weekId: string): string {
  return weekId.slice(0, 7);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
