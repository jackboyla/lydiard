import type { TrainingLoadModel } from '../analysis/loadModel';
import type { TrendMetricKey, WeeklyAnalysis } from '../types';
import { IndicatorList } from './IndicatorList';
import { LoadStory } from './LoadStory';
import { TrainingLoadChart } from './TrainingLoadChart';
import { TrendPanel } from './TrendPanel';
import { AerobicEfficiencyChart } from './AerobicEfficiencyChart';
import { HeartRateByPaceChart } from './HeartRateByPaceChart';

export interface AdvancedAnalysisProps {
  loadModel: TrainingLoadModel;
  analyses: WeeklyAnalysis[];
  metric: TrendMetricKey;
  selectedIndex: number;
  onMetricChange: (metric: TrendMetricKey) => void;
  onWeekSelect: (index: number) => void;
}

export default function AdvancedAnalysis({
  loadModel,
  analyses,
  metric,
  selectedIndex,
  onMetricChange,
  onWeekSelect,
}: AdvancedAnalysisProps) {
  return (
    <div className="analysis-chart-stack">
      <AerobicEfficiencyChart loadModel={loadModel} />
      <HeartRateByPaceChart loadModel={loadModel} />
      <TrainingLoadChart daily={loadModel.daily} />
      {analyses.length > 0 && (
        <TrendPanel
          analyses={analyses}
          metric={metric}
          selectedIndex={selectedIndex}
          onMetricChange={onMetricChange}
          onWeekSelect={onWeekSelect}
        />
      )}
      {analyses.length > 0 && <LoadStory analyses={analyses} />}
      {analyses[selectedIndex] && <IndicatorList indicators={analyses[selectedIndex].indicators} />}
    </div>
  );
}
