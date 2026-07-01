import { useState } from 'react';
import { BatteryWarning, ChevronDown, Footprints, Gauge, HeartPulse, Route, Waves } from 'lucide-react';
import type { FatigueIndicator } from '../types';

interface IndicatorListProps {
  indicators: FatigueIndicator[];
}

const icons = {
  stride: Footprints,
  decoupling: Waves,
  easyPace: Gauge,
  threshold: Route,
  load: BatteryWarning,
  recovery: HeartPulse,
};

export function IndicatorList({ indicators }: IndicatorListProps) {
  const [expandedId, setExpandedId] = useState(indicators[0]?.id ?? '');

  return (
    <section className="indicator-stack" aria-labelledby="indicator-heading">
      <div className="section-heading">
        <p>Fatigue indicators</p>
        <span>Personal baseline window</span>
      </div>
      <h2 id="indicator-heading">Signals for the selected week</h2>

      <div className="indicator-list">
        {indicators.map((indicator) => {
          const Icon = icons[indicator.id as keyof typeof icons] ?? Gauge;
          const isExpanded = indicator.id === expandedId;

          return (
            <article className={`indicator-row ${indicator.severity}`} key={indicator.id}>
              <button
                className="indicator-button"
                type="button"
                aria-expanded={isExpanded}
                onClick={() => setExpandedId(isExpanded ? '' : indicator.id)}
              >
                <span className="indicator-icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={2.1} />
                </span>
                <span className="indicator-main">
                  <span className="indicator-titleline">
                    <strong>{indicator.label}</strong>
                    <span>{indicator.deltaLabel}</span>
                  </span>
                  <span className="meter" aria-hidden="true">
                    <span style={{ width: `${Math.max(7, indicator.score)}%` }} />
                  </span>
                </span>
                <span className="indicator-value">
                  <span>{indicator.valueLabel}</span>
                  <small>{indicator.score}/100</small>
                </span>
                <ChevronDown className={isExpanded ? 'chevron open' : 'chevron'} size={18} aria-hidden="true" />
              </button>

              {isExpanded ? (
                <div className="indicator-detail">
                  <dl>
                    <div>
                      <dt>Current</dt>
                      <dd>{indicator.valueLabel}</dd>
                    </div>
                    <div>
                      <dt>Baseline</dt>
                      <dd>{indicator.baselineLabel}</dd>
                    </div>
                    <div>
                      <dt>Context</dt>
                      <dd>{indicator.supportingLabel}</dd>
                    </div>
                  </dl>
                  <p>{indicator.detail}</p>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
