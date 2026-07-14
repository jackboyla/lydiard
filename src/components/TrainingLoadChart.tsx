import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DailyLoadPoint } from '../analysis/loadModel';
import { MetricInfo } from './MetricInfo';
import { chartSpanDays, formatChartDate, formatChartTick, utcDayTimestamp } from './chartDates';

export function TrainingLoadChart({ daily }: { daily: DailyLoadPoint[] }) {
  const data = daily.map((point) => ({
    ...point,
    ts: utcDayTimestamp(point.day),
  }));
  const spanDays = chartSpanDays(data.map((point) => point.ts));

  return (
    <article className="chart-card training-chart-card analysis-load-chart">
      <div className="chart-header">
        <div>
          <p>Fitness and fatigue</p>
          <h2>
            CTL / ATL load model
            <MetricInfo metric="chart" />
          </h2>
        </div>
        <span className="chart-pill">load points</span>
      </div>
      <div className="fitness-chart">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0}
          initialDimension={{ width: 900, height: 320 }}
        >
          <LineChart data={data} margin={{ top: 14, right: 20, bottom: 4, left: 0 }}>
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
            <YAxis tickLine={false} axisLine={false} tick={{ fill: 'var(--subtle)', fontSize: 12 }} width={46} />
            <Tooltip
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              contentStyle={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                backgroundColor: 'var(--surface)',
                color: 'var(--text)',
                boxShadow: '0 10px 30px rgba(54, 47, 34, 0.14)',
              }}
              formatter={(value, name) => [`${Number(value).toFixed(1)}`, name]}
              labelFormatter={(value) => formatChartDate(Number(value))}
            />
            <Legend verticalAlign="top" align="right" iconType="line" wrapperStyle={{ color: 'var(--muted)' }} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Line type="monotone" dataKey="fitness" name="Fitness CTL" stroke="var(--green)" strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="fatigue" name="Fatigue ATL" stroke="var(--danger)" strokeWidth={3} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="freshness" name="Freshness" stroke="var(--warning)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}
