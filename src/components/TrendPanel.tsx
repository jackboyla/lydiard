import {
  Area,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrendMetricKey, WeeklyAnalysis } from '../types';
import { formatPace } from '../analysis/fatigue';

interface TrendPanelProps {
  analyses: WeeklyAnalysis[];
  metric: TrendMetricKey;
  selectedIndex: number;
  onMetricChange: (metric: TrendMetricKey) => void;
  onWeekSelect: (index: number) => void;
}

const metricOptions: Array<{ key: TrendMetricKey; label: string }> = [
  { key: 'fatigue', label: 'Fatigue' },
  { key: 'stride', label: 'Stride' },
  { key: 'easyPace', label: 'Easy pace' },
  { key: 'threshold', label: 'LT2' },
  { key: 'acRatio', label: 'AC ratio' },
];

export function TrendPanel({ analyses, metric, selectedIndex, onMetricChange, onWeekSelect }: TrendPanelProps) {
  const safeSelectedIndex = Math.min(selectedIndex, analyses.length - 1);
  const data = analyses.map((analysis, index) => ({
    index,
    label: analysis.week.label,
    value: valueForMetric(analysis, metric),
    riskScore: analysis.riskScore,
    severity: analysis.severity,
    display: displayForMetric(analysis, metric),
  }));

  const selected = analyses[safeSelectedIndex];
  const title = titleForMetric(metric);

  return (
    <section className="chart-card trend-panel" aria-labelledby="trend-heading">
      <div className="chart-header">
        <div>
          <p>Week by week trend</p>
          <h2 id="trend-heading">{title}</h2>
        </div>
        <div className="segmented" role="tablist" aria-label="Trend metric">
          {metricOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={metric === option.key}
              className={metric === option.key ? 'active' : ''}
              onClick={() => onMetricChange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="trend-layout">
        <div className="trend-chart">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0}
            initialDimension={{ width: 900, height: 390 }}
          >
            <LineChart
              data={data}
              margin={{ top: 16, right: 16, left: 0, bottom: 0 }}
              onClick={(state) => {
                if (typeof state?.activeTooltipIndex === 'number') {
                  onWeekSelect(state.activeTooltipIndex);
                }
              }}
            >
              <defs>
                <linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#22b982" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#22b982" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#2c3440" vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: '#92a0b3', fontSize: 12 }} />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fill: '#92a0b3', fontSize: 12 }}
                tickFormatter={(value) => axisLabelForMetric(value, metric)}
                width={56}
                domain={domainForMetric(metric)}
              />
              <Tooltip
                cursor={{ stroke: '#465365', strokeWidth: 1 }}
                contentStyle={{
                  border: '1px solid #303946',
                  borderRadius: 8,
                  backgroundColor: '#171b21',
                  color: '#edf2f7',
                  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.32)',
                }}
                formatter={(_, __, item) => [item.payload.display, title]}
              />
              <Area
                type="linear"
                dataKey="value"
                fill="url(#trendFill)"
                stroke="none"
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="value"
                stroke="#22b982"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                connectNulls
                isAnimationActive={false}
                dot={(props) => <TrendDot {...props} selectedIndex={safeSelectedIndex} />}
                activeDot={{ r: 7, fill: '#0d1015', stroke: '#ffffff', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <aside className="trend-readout">
          <span>{selected.week.year}</span>
          <strong>{displayForMetric(selected, metric)}</strong>
          <p>{selected.week.label}</p>
          <dl>
            <div>
              <dt>Distance</dt>
              <dd>{selected.week.distanceKm} km</dd>
            </div>
            <div>
              <dt>Load</dt>
              <dd>{selected.week.trainingLoad}</dd>
            </div>
            <div>
              <dt>Long run</dt>
              <dd>{selected.week.longRunKm} km</dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  );
}

function TrendDot(props: {
  cx?: number;
  cy?: number;
  payload?: { severity: string; index: number };
  selectedIndex: number;
}) {
  if (typeof props.cx !== 'number' || typeof props.cy !== 'number' || !props.payload) {
    return null;
  }

  const color =
    props.payload.severity === 'high' ? '#ff5a66' : props.payload.severity === 'watch' ? '#f2c94c' : '#22b982';
  const selected = props.payload.index === props.selectedIndex;

  return (
    <circle
      cx={props.cx}
      cy={props.cy}
      r={selected ? 6 : 5}
      fill={color}
      stroke={selected ? '#0d1015' : '#ffffff'}
      strokeWidth={selected ? 2 : 1.5}
    />
  );
}

function valueForMetric(analysis: WeeklyAnalysis, metric: TrendMetricKey): number {
  if (metric === 'fatigue') {
    return analysis.riskScore;
  }

  if (metric === 'stride') {
    return analysis.week.strideLengthCm;
  }

  if (metric === 'easyPace') {
    return analysis.week.easyPaceSecPerKm;
  }

  if (metric === 'threshold') {
    return analysis.week.thresholdPaceSecPerKm;
  }

  return analysis.week.acRatio;
}

function displayForMetric(analysis: WeeklyAnalysis, metric: TrendMetricKey): string {
  if (metric === 'fatigue') {
    return `${analysis.riskScore}/100`;
  }

  if (metric === 'stride') {
    return `${analysis.week.strideLengthCm} cm stride`;
  }

  if (metric === 'easyPace') {
    return formatPace(analysis.week.easyPaceSecPerKm);
  }

  if (metric === 'threshold') {
    return formatPace(analysis.week.thresholdPaceSecPerKm);
  }

  return analysis.week.acRatio.toFixed(2);
}

function titleForMetric(metric: TrendMetricKey): string {
  if (metric === 'fatigue') {
    return 'Fatigue pressure';
  }

  if (metric === 'stride') {
    return 'Stride length';
  }

  if (metric === 'easyPace') {
    return 'Easy pace at fixed HR';
  }

  if (metric === 'threshold') {
    return 'Threshold pace trend';
  }

  return 'Acute/chronic load ratio';
}

function axisLabelForMetric(value: number, metric: TrendMetricKey): string {
  if (metric === 'easyPace' || metric === 'threshold') {
    return formatPace(value).replace('/km', '');
  }

  if (metric === 'acRatio') {
    return value.toFixed(2);
  }

  return Math.round(value).toString();
}

function domainForMetric(metric: TrendMetricKey): [string | number, string | number] {
  if (metric === 'fatigue') {
    return [0, 100];
  }

  return ['dataMin - 4', 'dataMax + 4'];
}
