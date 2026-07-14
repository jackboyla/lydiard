import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { WeeklyAnalysis } from '../types';
import { chartSpanDays, formatChartDate, formatChartTick, utcDayTimestamp } from './chartDates';

interface LoadStoryProps {
  analyses: WeeklyAnalysis[];
}

type VolumeView = 'mileage' | 'time';
type VolumeKey = 'distanceKm' | 'durationHours';

export function LoadStory({ analyses }: LoadStoryProps) {
  const [volumeView, setVolumeView] = useState<VolumeView>('mileage');
  const volumeKey: VolumeKey = volumeView === 'mileage' ? 'distanceKm' : 'durationHours';
  const volumeLabel = volumeView === 'mileage' ? 'Mileage' : 'Time';
  const data = analyses.map((analysis) => ({
    ts: utcDayTimestamp(analysis.week.weekStart),
    distanceKm: analysis.week.distanceKm,
    durationHours: analysis.week.durationHours,
    chronicLoad: analysis.week.chronicLoad,
    severity: analysis.severity,
  }));
  const spanDays = chartSpanDays(data.map((point) => point.ts));

  return (
    <section className="chart-card load-story" aria-labelledby="load-heading">
      <div className="chart-header">
        <div>
          <p>Training load</p>
          <h2 id="load-heading">Weekly volume and fitness trend</h2>
        </div>
        <div className="chart-header-actions">
          <div className="segmented compact-segmented" role="tablist" aria-label="Weekly volume display">
            <button
              type="button"
              role="tab"
              aria-selected={volumeView === 'mileage'}
              className={volumeView === 'mileage' ? 'active' : ''}
              onClick={() => setVolumeView('mileage')}
            >
              Mileage
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={volumeView === 'time'}
              className={volumeView === 'time' ? 'active' : ''}
              onClick={() => setVolumeView('time')}
            >
              Time
            </button>
          </div>
          <span className="chart-pill">Last {data.length} weeks</span>
        </div>
      </div>

      <div className="load-chart">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0}
          initialDimension={{ width: 900, height: 320 }}
        >
          <ComposedChart data={data} margin={{ top: 12, right: 24, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--border-soft)" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(value) => formatChartTick(Number(value), spanDays)}
              minTickGap={54}
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--subtle)', fontSize: 12 }}
            />
            <YAxis
              yAxisId="left"
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--subtle)', fontSize: 12 }}
              tickFormatter={(value) => formatVolumeAxis(Number(value), volumeView)}
              width={44}
            />
            <YAxis yAxisId="right" orientation="right" hide />
            <Tooltip
              cursor={{ fill: 'rgba(40, 92, 69, 0.07)' }}
              contentStyle={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                backgroundColor: 'var(--surface)',
                color: 'var(--text)',
                boxShadow: '0 10px 30px rgba(54, 47, 34, 0.14)',
              }}
              formatter={(value, name) => [
                name === volumeLabel ? formatVolumeValue(Number(value), volumeView) : Math.round(Number(value)),
                name === volumeLabel ? volumeLabel : 'Fitness load',
              ]}
              labelFormatter={(value) => formatChartDate(Number(value))}
            />
            <Bar
              yAxisId="left"
              dataKey={volumeKey}
              name={volumeLabel}
              fill={volumeView === 'mileage' ? 'var(--accent)' : 'var(--green)'}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="chronicLoad"
              stroke="var(--warning)"
              strokeWidth={3}
              dot={false}
              isAnimationActive={false}
              activeDot={{ r: 5, fill: 'var(--warning)' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function formatVolumeValue(value: number, volumeView: VolumeView): string {
  if (volumeView === 'mileage') {
    return `${Math.round(value)} km`;
  }

  return `${value.toFixed(1)} h`;
}

function formatVolumeAxis(value: number, volumeView: VolumeView): string {
  if (volumeView === 'mileage') {
    return Math.round(value).toString();
  }

  return value >= 10 ? Math.round(value).toString() : value.toFixed(1);
}
