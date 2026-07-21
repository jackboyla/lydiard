import { formatPace } from '../analysis/fatigue';
import type { ActivityLapView } from '../data/activityLaps';

// A compact, non-interactive echo of the detail view's "Recorded lap profile"
// chart, sized to sit inside a calendar run card. One zone-coloured bar per lap:
// width follows lap distance, height follows pace (faster = taller). A flat row
// reads as a steady run; a jagged row reads as a workout. The full interactive
// chart lives in ActivityRunCharts.tsx for the activity detail page.
//
// Bars reuse the `.lap-profile-bar.zone-*` classes so the palette stays in lock
// step with the detail chart across every theme/breakpoint (see styles.css).

const VIEW_W = 100; // logical units; stretched to the card width via preserveAspectRatio="none"
const VIEW_H = 32;
const TOP_PAD = 3;
const MIN_BAR_H = 6;
const GAP = 0.7;
const MIN_BAR_W = 1.2;

export function MiniLapProfile({ laps }: { laps: ActivityLapView[] }) {
  if (laps.length < 2) return null;
  const paces = laps.map((lap) => lap.paceSecPerKm).filter((pace) => Number.isFinite(pace) && pace > 0);
  if (paces.length < 2) return null;

  const minPace = Math.min(...paces);
  const maxPace = Math.max(...paces);
  const paceSpan = maxPace - minPace;
  const totalDistance = laps.reduce((sum, lap) => sum + Math.max(0.0001, lap.distanceKm), 0);
  const maxBarH = VIEW_H - TOP_PAD;
  const innerW = VIEW_W - GAP * (laps.length - 1);

  let cursor = 0;
  const bars = laps.map((lap) => {
    const width = Math.max(MIN_BAR_W, (Math.max(0.0001, lap.distanceKm) / totalDistance) * innerW);
    // Local (per-run) pace normalisation so intra-run contrast pops: a workout's
    // fast reps tower over its recoveries, while a steady run stays near-uniform.
    const heightFraction = paceSpan > 0 ? 1 - (lap.paceSecPerKm - minPace) / paceSpan : 0.6;
    const height = MIN_BAR_H + heightFraction * (maxBarH - MIN_BAR_H);
    const bar = { x: cursor, y: VIEW_H - height, width, height, zone: lap.zone.key };
    cursor += width + GAP;
    return bar;
  });

  const fastest = formatPace(minPace);
  const slowest = formatPace(maxPace);

  return (
    <span className="calendar-lap-profile" title={`Recorded laps · fastest ${fastest} · slowest ${slowest}`}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Lap profile: ${laps.length} laps, fastest ${fastest}, slowest ${slowest}`}
      >
        {bars.map((bar, index) => (
          <rect
            key={index}
            className={`lap-profile-bar zone-${bar.zone}`}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={Math.min(1, bar.width / 3)}
          />
        ))}
      </svg>
    </span>
  );
}
