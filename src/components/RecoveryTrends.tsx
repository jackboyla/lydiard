import { useEffect, useMemo, useRef, useState } from 'react';
import { HeartPulse, Moon } from 'lucide-react';
import {
  addDays,
  averageBefore,
  formatSleep,
  formatVersusAverage,
  nightValue,
  type RecoveryMetric,
} from '../analysis/recoveryTrend';
import type { RecoveryNight } from '../types';

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

const METRICS: Record<RecoveryMetric, { title: string; icon: typeof Moon }> = {
  sleep: { title: 'Sleep', icon: Moon },
  hrv: { title: 'HRV', icon: HeartPulse },
};

interface ChartPoint {
  day: string;
  value?: number;
  average?: number;
}

export function useRecoveryByDay(nights: RecoveryNight[]): Map<string, RecoveryNight> {
  return useMemo(() => new Map(nights.map((night) => [night.day, night])), [nights]);
}

/** Sleep and HRV side by side at the top of Log; hidden when no nights are synced. */
export function RecoveryTrends({ byDay }: { byDay: ReadonlyMap<string, RecoveryNight> }) {
  if (byDay.size === 0) return null;
  return (
    <section className="recovery-trends" aria-label="Overnight recovery">
      <RecoveryChart byDay={byDay} metric="sleep" />
      <RecoveryChart byDay={byDay} metric="hrv" />
    </section>
  );
}

function RecoveryChart({ byDay, metric }: { byDay: ReadonlyMap<string, RecoveryNight>; metric: RecoveryMetric }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(360);
  const [period, setPeriod] = useState<Period>(7);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const today = localToday();

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const points = useMemo<ChartPoint[]>(
    () => Array.from({ length: period }, (_, index) => {
      const day = addDays(today, index - period + 1);
      return { day, value: nightValue(byDay.get(day), metric), average: averageBefore(byDay, day, metric) };
    }),
    [byDay, metric, period, today],
  );
  const chart = useMemo(() => buildChart(points, width, metric), [points, width, metric]);

  const latestWithValue = [...points].reverse().find((point) => point.value !== undefined);
  const selectedIndex = Math.max(0, points.findIndex((point) => point.day === (activeDay ?? latestWithValue?.day ?? today)));
  const selected = points[selectedIndex];
  const { title, icon: Icon } = METRICS[metric];

  const trackTo = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width === 0) return;
    const x = ((clientX - bounds.left) / bounds.width) * chart.width;
    const index = Math.max(0, Math.min(points.length - 1, Math.round((x - chart.left - chart.step / 2) / chart.step)));
    setActiveDay(points[index].day);
  };
  const moveBy = (delta: number) => {
    setActiveDay(points[Math.max(0, Math.min(points.length - 1, selectedIndex + delta))].day);
  };

  const delta = selected.value !== undefined && selected.average !== undefined ? selected.value - selected.average : 0;
  const tone = selected.value === undefined || selected.average === undefined || Math.abs(delta) < 1e-9
    ? 'level'
    : delta > 0 ? 'up' : 'down';

  return (
    <article className={`product-card recovery-chart recovery-chart-${metric}`} aria-label={`${title} trend`}>
      <header className="recovery-chart-head">
        <span className="recovery-chart-title"><Icon size={15} aria-hidden="true" /> {title}</span>
        <div className="recovery-chart-periods" role="group" aria-label={`${title} period`}>
          {PERIODS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => { setPeriod(value); setActiveDay(null); }}
            >
              {value}D
            </button>
          ))}
        </div>
      </header>

      <div className="recovery-chart-readout" aria-live="polite">
        <small>{selected.day === today ? 'Today' : formatDay(selected.day)}</small>
        <strong>{selected.value === undefined ? 'No reading' : formatValue(selected.value, metric)}</strong>
        {selected.value !== undefined && (
          <span className={`recovery-chart-delta tone-${tone}`}>{formatVersusAverage(selected.value, selected.average, metric)}</span>
        )}
      </div>

      <div ref={shellRef} className="recovery-chart-shell">
        <svg
          ref={svgRef}
          className="recovery-chart-svg"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          tabIndex={0}
          aria-label={`${title} for the last ${period} days with the 7-night average. Use the arrow keys to move through the days.`}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); moveBy(-1); }
            if (event.key === 'ArrowRight') { event.preventDefault(); moveBy(1); }
          }}
        >
          {chart.gridLines.map((line) => (
            <g key={line.label} className="recovery-chart-grid">
              <line x1={chart.left} y1={line.y} x2={chart.right} y2={line.y} />
              <text x={chart.right + 6} y={line.y + 4}>{line.label}</text>
            </g>
          ))}
          <line className="recovery-chart-rule" x1={chart.x(selectedIndex)} y1={chart.top} x2={chart.x(selectedIndex)} y2={chart.bottom} />

          {metric === 'sleep'
            ? points.map((point, index) => point.value !== undefined && (
              <rect
                key={point.day}
                className={`recovery-chart-bar${point.day === today ? ' is-today' : ''}${index === selectedIndex ? ' is-selected' : ''}`}
                x={chart.x(index) - chart.barWidth / 2}
                y={chart.y(point.value)}
                width={chart.barWidth}
                height={Math.max(1, chart.bottom - chart.y(point.value))}
                rx={Math.min(3, chart.barWidth / 3)}
              />
            ))
            : (
              <>
                <path className="recovery-chart-line" d={chart.valuePath} />
                {points.map((point, index) => point.value !== undefined && (
                  <circle
                    key={point.day}
                    className={`recovery-chart-dot${point.day === today ? ' is-today' : ''}${index === selectedIndex ? ' is-selected' : ''}`}
                    cx={chart.x(index)}
                    cy={chart.y(point.value)}
                    r={index === selectedIndex ? 5 : period > 30 ? 2 : 3.5}
                  />
                ))}
              </>
            )}
          <path className="recovery-chart-average" d={chart.averagePath} />

          {chart.ticks.map((tick) => (
            <text key={tick.day} className={`recovery-chart-tick${tick.day === today ? ' is-today' : ''}`} x={tick.x} y={chart.height - 4}>
              {tick.label}
            </text>
          ))}

          <rect
            className="recovery-chart-surface"
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
              if (event.pointerType === 'mouse' || event.currentTarget.hasPointerCapture(event.pointerId)) trackTo(event.clientX);
            }}
          />
        </svg>
      </div>
      <p className="recovery-chart-key"><i aria-hidden="true" /> 7-night average</p>
    </article>
  );
}

/** That morning's sleep and HRV beside a run, against the week before it. */
export function RunRecovery({ byDay, day }: { byDay: ReadonlyMap<string, RecoveryNight>; day: string }) {
  if (byDay.size === 0) return null;
  const night = byDay.get(day);
  return (
    <section className="run-recovery" aria-label="Recovery before this run">
      {(['sleep', 'hrv'] as const).map((metric) => {
        const value = nightValue(night, metric);
        const { title, icon: Icon } = METRICS[metric];
        return (
          <div key={metric}>
            <span><Icon size={13} aria-hidden="true" /> {metric === 'sleep' ? 'Sleep before' : 'HRV that night'}</span>
            <strong>{value === undefined ? '—' : formatValue(value, metric)}</strong>
            <small>{value === undefined ? `No ${title.toLowerCase()} reading` : formatVersusAverage(value, averageBefore(byDay, day, metric), metric)}</small>
          </div>
        );
      })}
    </section>
  );
}

function buildChart(points: ChartPoint[], width: number, metric: RecoveryMetric) {
  const height = 132;
  const top = 8;
  const bottom = height - 22;
  const left = 4;
  const right = width - 40;
  const step = (right - left) / Math.max(points.length, 1);
  const x = (index: number) => round(left + step * (index + 0.5));
  const values = points.flatMap((point) => [point.value, point.average]).filter((value): value is number => value !== undefined);

  let low: number;
  let high: number;
  if (metric === 'sleep') {
    low = 0;
    high = Math.max(9 * 60, Math.ceil(Math.max(0, ...values) / 60) * 60);
  } else {
    // HRV moves a few milliseconds night to night; a zero baseline would flatten it.
    const min = values.length ? Math.min(...values) : 40;
    const max = values.length ? Math.max(...values) : 60;
    low = Math.max(0, Math.floor((min - 5) / 10) * 10);
    high = Math.ceil((max + 5) / 10) * 10;
  }
  const y = (value: number) => round(bottom - ((value - low) / Math.max(high - low, 1)) * (bottom - top));

  const gridValues = metric === 'sleep'
    ? [0, Math.round(high / 120) * 60, high].filter((value, index, all) => all.indexOf(value) === index)
    : [low, (low + high) / 2, high];

  return {
    width,
    height,
    top,
    bottom,
    left,
    right,
    step,
    x,
    y,
    barWidth: Math.max(2, Math.min(22, step * 0.62)),
    valuePath: segmentedPath(points.map((point) => point.value), x, y),
    averagePath: segmentedPath(points.map((point) => point.average), x, y),
    gridLines: gridValues.map((value) => ({
      y: y(value),
      label: metric === 'sleep' ? `${Math.round(value / 60)}h` : `${Math.round(value)}`,
    })),
    ticks: buildTicks(points, x),
  };
}

/** A line that breaks across missing nights instead of drawing through them. */
function segmentedPath(values: Array<number | undefined>, x: (index: number) => number, y: (value: number) => number): string {
  let path = '';
  let drawing = false;
  values.forEach((value, index) => {
    if (value === undefined) {
      drawing = false;
      return;
    }
    path += `${drawing ? 'L' : 'M'} ${x(index)} ${y(value)} `;
    drawing = true;
  });
  return path.trim();
}

function buildTicks(points: ChartPoint[], x: (index: number) => number) {
  if (points.length <= 7) {
    return points.map((point, index) => ({ day: point.day, x: x(index), label: weekdayInitial(point.day) }));
  }
  const every = Math.ceil(points.length / 4);
  return points
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => (points.length - 1 - index) % every === 0)
    .map(({ point, index }) => ({ day: point.day, x: x(index), label: shortDate(point.day) }));
}

function formatValue(value: number, metric: RecoveryMetric): string {
  return metric === 'sleep' ? formatSleep(value) : `${Math.round(value)} ms`;
}

function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${day}T00:00:00Z`));
}

function shortDate(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

function weekdayInitial(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
