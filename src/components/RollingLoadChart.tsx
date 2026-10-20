import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionLoad } from '../analysis/loadModel';

const DAY_MS = 86_400_000;

interface RollingDay {
  day: string;
  distanceKm: number;
  hours: number;
  runs: number;
  /** The 28 days to this one, scaled to a week so it sits on the same axis. */
  baseDistanceKm: number;
  baseHours: number;
}

type PanelKey = 'distance' | 'time';

/**
 * Rolling 7-day distance and time, one small multiple each on a shared day
 * axis, so the build and drop of load reads day by day rather than in weekly
 * steps. A dashed 4-week average (per week) gives each line its baseline, the
 * way acute-over-chronic views in Strava and TrainingPeaks frame a spike.
 */
export function RollingLoadChart({
  sessions,
  fromDay,
  untilDay,
}: {
  sessions: SessionLoad[];
  /** First day shown, inclusive. */
  fromDay: string;
  /** Last day shown, inclusive; clipped to today. */
  untilDay: string;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(720);
  const [activeDay, setActiveDay] = useState<string | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const days = useMemo(() => buildRollingDays(sessions, fromDay, untilDay), [sessions, fromDay, untilDay]);
  const chart = useMemo(() => buildChart(days, width), [days, width]);

  useEffect(() => { setActiveDay(null); }, [fromDay, untilDay]);

  const selectedIndex = Math.max(0, activeDay ? days.findIndex((point) => point.day === activeDay) : days.length - 1);
  const selected = days[selectedIndex];

  if (!selected) {
    return (
      <div className="rolling-load" role="status">
        <p className="weekly-totals-empty">No days in this range yet.</p>
      </div>
    );
  }

  const selectedX = chart.x(selectedIndex);

  const dayAtClientX = (clientX: number): string | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width === 0) return null;
    const x = ((clientX - bounds.left) / bounds.width) * chart.width;
    const index = Math.round((x - chart.left) / Math.max(chart.step, 1e-6));
    return days[Math.max(0, Math.min(days.length - 1, index))]?.day ?? null;
  };

  const trackTo = (clientX: number) => {
    const day = dayAtClientX(clientX);
    if (day && day !== selected.day) setActiveDay(day);
  };

  const moveBy = (delta: number) => {
    const next = days[Math.max(0, Math.min(days.length - 1, selectedIndex + delta))];
    if (next) setActiveDay(next.day);
  };

  return (
    <div className="rolling-load">
      <div className="rolling-load-summary" aria-live="polite">
        <h3>{formatWindow(selected.day)}</h3>
        <div className="rolling-load-stats">
          <div>
            <span>Distance</span>
            <strong>{selected.distanceKm.toFixed(1)} km</strong>
            <small>{formatVersusBase(selected.distanceKm, selected.baseDistanceKm)}</small>
          </div>
          <div>
            <span>Time</span>
            <strong>{formatHoursMinutes(selected.hours)}</strong>
            <small>{formatVersusBase(selected.hours, selected.baseHours)}</small>
          </div>
          <div>
            <span>Runs</span>
            <strong>{selected.runs}</strong>
            <small>in 7 days</small>
          </div>
        </div>
      </div>

      <ul className="rolling-load-legend" aria-label="Chart key">
        <li><i className="rolling-load-key-line" aria-hidden="true" />Last 7 days</li>
        <li><i className="rolling-load-key-base" aria-hidden="true" />4-week average, per week</li>
      </ul>

      <div ref={shellRef} className="weekly-totals-chart-shell">
        <svg
          ref={svgRef}
          className="rolling-load-chart"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          tabIndex={0}
          aria-label={`Rolling 7-day distance and time over ${days.length} days. Use the arrow keys to move through the days.`}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); moveBy(-1); }
            if (event.key === 'ArrowRight') { event.preventDefault(); moveBy(1); }
            if (event.key === 'Home') { event.preventDefault(); moveBy(-days.length); }
            if (event.key === 'End') { event.preventDefault(); moveBy(days.length); }
          }}
        >
          <defs>
            <linearGradient id="rolling-load-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="weekly-totals-fill-top" />
              <stop offset="100%" className="weekly-totals-fill-bottom" />
            </linearGradient>
          </defs>

          {chart.panels.map((panel) => (
            <g key={panel.key}>
              <text className="rolling-load-panel-title" x={chart.left} y={panel.top - 10}>
                {panel.key === 'distance' ? 'DISTANCE' : 'TIME'}
              </text>
              {panel.gridLines.map((line) => (
                <g key={line.ratio} className="weekly-totals-grid">
                  <line x1={chart.left} y1={line.y} x2={chart.right} y2={line.y} />
                  <text x={chart.right + 8} y={line.y + 4}>{line.label}</text>
                </g>
              ))}
              <path className="weekly-totals-area" d={panel.areaPath} fill="url(#rolling-load-fill)" />
              <path className="rolling-load-base" d={panel.basePath} />
              <path className="weekly-totals-line" d={panel.linePath} />
              <line className="weekly-totals-rule" x1={selectedX} y1={panel.top} x2={selectedX} y2={panel.bottom} />
              <circle className="weekly-totals-halo" cx={selectedX} cy={panel.y(panelValue(selected, panel.key))} r={10} />
              <circle className="weekly-totals-dot selected" cx={selectedX} cy={panel.y(panelValue(selected, panel.key))} r={5} />
            </g>
          ))}

          {chart.monthTicks.map((tick) => (
            <text key={tick.key} className="weekly-totals-month" x={tick.x} y={chart.height - 8}>
              {tick.label}
            </text>
          ))}

          <rect
            className="rolling-load-surface"
            x={0}
            y={0}
            width={chart.width}
            height={chart.height}
            aria-hidden="true"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              trackTo(event.clientX);
            }}
            onPointerMove={(event) => {
              if (event.pointerType === 'mouse' || event.currentTarget.hasPointerCapture(event.pointerId)) {
                trackTo(event.clientX);
              }
            }}
          />
        </svg>
      </div>

      <table className="sr-only">
        <caption>Rolling 7-day totals by week ending</caption>
        <thead><tr><th>7 days to</th><th>Distance (km)</th><th>Time (h)</th><th>Runs</th></tr></thead>
        <tbody>
          {days.filter((_, index) => (days.length - 1 - index) % 7 === 0).map((point) => (
            <tr key={point.day}>
              <td>{point.day}</td>
              <td>{point.distanceKm.toFixed(1)}</td>
              <td>{point.hours.toFixed(1)}</td>
              <td>{point.runs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Daily rolling sums, reading sessions from before the range so the first days are whole. */
export function buildRollingDays(sessions: SessionLoad[], fromDay: string, untilDay: string): RollingDay[] {
  const end = Math.min(dayMs(untilDay), dayMs(localToday()));
  const start = dayMs(fromDay);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const firstNeeded = start - 27 * DAY_MS;
  const perDay = new Map<number, { km: number; hours: number; runs: number }>();
  for (const session of sessions) {
    const ms = dayMs(session.day);
    if (ms < firstNeeded || ms > end) continue;
    const entry = perDay.get(ms) ?? { km: 0, hours: 0, runs: 0 };
    entry.km += session.activity.distanceKm || 0;
    entry.hours += (session.activity.movingTimeSec || 0) / 3600;
    entry.runs += 1;
    perDay.set(ms, entry);
  }

  const windowSum = (ms: number, length: number) => {
    const total = { km: 0, hours: 0, runs: 0 };
    for (let offset = 0; offset < length; offset += 1) {
      const entry = perDay.get(ms - offset * DAY_MS);
      if (!entry) continue;
      total.km += entry.km;
      total.hours += entry.hours;
      total.runs += entry.runs;
    }
    return total;
  };

  const out: RollingDay[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const week = windowSum(ms, 7);
    const month = windowSum(ms, 28);
    out.push({
      day: new Date(ms).toISOString().slice(0, 10),
      distanceKm: week.km,
      hours: week.hours,
      runs: week.runs,
      baseDistanceKm: month.km / 4,
      baseHours: month.hours / 4,
    });
  }
  return out;
}

function buildChart(days: RollingDay[], width: number) {
  const compact = width < 520;
  const panelHeight = compact ? 132 : 150;
  const panelGap = 44;
  const left = 12;
  const right = width - (compact ? 54 : 64);
  const firstTop = 28;
  const height = firstTop + panelHeight * 2 + panelGap + 30;
  const step = days.length > 1 ? (right - left) / (days.length - 1) : 0;
  const x = (index: number) => round(days.length > 1 ? left + index * step : (left + right) / 2);

  const panels = (['distance', 'time'] as PanelKey[]).map((key, panelIndex) => {
    const top = firstTop + panelIndex * (panelHeight + panelGap);
    const bottom = top + panelHeight;
    const values = days.map((point) => panelValue(point, key));
    const baseValues = days.map((point) => (key === 'distance' ? point.baseDistanceKm : point.baseHours));
    const yMax = niceMax(Math.max(...values, ...baseValues, 0));
    const y = (value: number) => round(bottom - (value / yMax) * (bottom - top));
    const linePath = pathFor(values, x, y);
    const areaPath = days.length > 0 ? `${linePath} L ${x(days.length - 1)} ${bottom} L ${x(0)} ${bottom} Z` : '';
    return {
      key,
      top,
      bottom,
      y,
      linePath,
      areaPath,
      basePath: pathFor(baseValues, x, y),
      gridLines: [1, 0.5, 0].map((ratio) => ({
        ratio,
        y: y(yMax * ratio),
        label: formatAxisValue(yMax * ratio, key),
      })),
    };
  });

  return { width, height, left, right, step, x, panels, monthTicks: buildMonthTicks(days, x, compact, left, right) };
}

function pathFor(values: number[], x: (index: number) => number, y: (value: number) => number): string {
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(value)}`).join(' ');
}

/** One label per month, thinned so they never collide on a phone. */
function buildMonthTicks(
  days: RollingDay[],
  x: (index: number) => number,
  compact: boolean,
  left: number,
  right: number,
): Array<{ key: string; x: number; label: string }> {
  const starts = days
    .map((point, index) => ({ point, index }))
    .filter(({ point, index }) => index === 0 || point.day.slice(0, 7) !== days[index - 1].day.slice(0, 7));
  const limit = compact ? 5 : 9;
  const interval = starts.length > limit ? Math.ceil(starts.length / limit) : 1;
  return starts
    .filter((_, index) => index % interval === 0)
    .map(({ point, index }) => ({
      key: point.day.slice(0, 7),
      x: Math.min(Math.max(x(index), left + 14), right - 14),
      label: new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })
        .format(new Date(dayMs(point.day)))
        .toUpperCase(),
    }));
}

function panelValue(point: RollingDay, key: PanelKey): number {
  return key === 'distance' ? point.distanceKm : point.hours;
}

function formatVersusBase(value: number, base: number): string {
  if (base <= 0) return value > 0 ? 'no 4-week base yet' : 'no runs';
  const change = Math.round(((value - base) / base) * 100);
  if (change === 0) return 'level with 4-wk avg';
  return `${change > 0 ? '+' : '−'}${Math.abs(change)}% vs 4-wk avg`;
}

/** "7 days to Fri 25 Sep 2026" */
function formatWindow(day: string): string {
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dayMs(day)));
  return `7 days to ${date}`;
}

function formatHoursMinutes(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatAxisValue(value: number, key: PanelKey): string {
  if (key === 'time') {
    return Number.isInteger(value) || value >= 10 ? `${Math.round(value)}h` : `${value.toFixed(1)}h`;
  }
  return `${Math.round(value)} km`;
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  // Finer steps than the weekly chart: a rolling line barely moves, so headroom
  // would flatten it.
  const nice = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((step) => scaled <= step) ?? 10;
  return nice * magnitude;
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
