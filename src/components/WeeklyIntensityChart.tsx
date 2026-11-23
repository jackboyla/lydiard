import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { weeklyIntensityMinutes, type TrainingLoadModel } from '../analysis/loadModel';
import { chartWeeks, formatShortDate, trailingMonthsStart } from './chartDates';

export default function WeeklyIntensityChart({ loadModel, today }: { loadModel: TrainingLoadModel; today: string }) {
  const [months, setMonths] = useState(3);
  const weeks = useMemo(() => {
    const start = trailingMonthsStart(today, months);
    return chartWeeks(start, today).map(({ monday, from, to }) => {
      const sessions = (loadModel.weeksById.get(monday)?.sessions ?? []).filter(({ activity }) => {
        const day = new Date(activity.startDate).toISOString().slice(0, 10);
        return day >= from && day <= to;
      });
      const hasLaps = sessions.some(({ activity }) => activity.lapProfile?.length);
      return {
        from,
        to,
        hasLaps,
        minutes: sessions.length > 0 && !hasLaps
          ? null
          : weeklyIntensityMinutes(sessions, loadModel.thresholds.thresholdPaceSecPerKm),
      };
    });
  }, [loadModel, months, today]);

  return (
    <section className="product-card rolling-load-panel" aria-labelledby="weekly-intensity-heading">
      <header className="zone-trend-head">
        <h2 id="weekly-intensity-heading">Weekly intensity minutes</h2>
        <div className="segmented progress-resolution-control" role="group" aria-label="Weekly intensity range">
          {[1, 3, 6, 12].map((option) => (
            <button key={option} type="button" aria-pressed={months === option}
              className={months === option ? 'active' : ''} onClick={() => setMonths(option)}>
              {option}M
            </button>
          ))}
        </div>
      </header>
      {weeks.some((week) => week.hasLaps) ? (
        <div className="zone-trend-chart">
          <ResponsiveContainer width="100%" height={190} minWidth={0}>
            <LineChart className="weekly-intensity-line" data={weeks} title="Weekly intensity minutes" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border-soft)" />
              <XAxis padding={{ left: 4, right: 4 }} dataKey="from" tickFormatter={formatShortDate} minTickGap={16} tickLine={false} />
              <YAxis width={60} unit=" min" allowDecimals={false} axisLine={false} tickLine={false} />
              <Tooltip
                filterNull={false}
                isAnimationActive={false}
                labelFormatter={(_, entries) => {
                  const week = entries[0]?.payload;
                  return week ? `${formatShortDate(week.from)} – ${formatShortDate(week.to)}` : '';
                }}
                formatter={(minutes) => minutes == null ? 'No lap data' : `${minutes} min`}
                contentStyle={{ background: 'var(--surface)', borderColor: 'var(--border-soft)' }}
                itemStyle={{ color: 'var(--text)' }}
                cursor={{ stroke: 'var(--border)' }}
              />
              <Line
                type="linear"
                dataKey="minutes"
                name="Recorded intensity"
                stroke="var(--accent)"
                strokeWidth={2}
                dot={{ r: 2, fill: 'var(--accent)' }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="progress-zone-empty">No recorded running laps in this range.</p>
      )}
      <p className="progress-zone-method">Counts time in recorded threshold and high-intensity laps. Weeks start on Monday (UTC).</p>
    </section>
  );
}
