/** A Garmin activity candidate on the same local calendar date as a plan row. */
export interface PlanActualCandidate {
  movingTimeSec: number;
}

export interface PlanDurationPair {
  expectedIndex: number;
  candidateIndex: number;
  expectedMinutes: number;
  actualMinutes: number;
  deltaMinutes: number;
}

export interface PlanDurationMatch {
  expectedMinutes: number[];
  actualMinutes: number[];
  pairs: PlanDurationPair[];
  matched: boolean;
  maxDeltaMinutes: number | null;
}

/**
 * Extract run durations such as `57m`, `AM 40m PM 30m`, `61 min`, or
 * `1h 10m`. A combined hours/minutes expression is returned as one duration.
 * Non-run annotations such as `+ gym` are deliberately ignored.
 */
export function extractActualMinuteTokens(text: string): number[] {
  const minutes: number[] = [];
  const pattern = /(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?(?:\s*(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?|(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const hours = match[1] ? Number(match[1]) : 0;
    const minutePart = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : 0;
    const value = hours * 60 + minutePart;
    if (Number.isFinite(value) && value > 0) {
      minutes.push(value);
    }
  }
  return minutes;
}

/**
 * Match each duration token to one same-day Garmin run. Matching maximizes the
 * number of pairs first, then minimizes total duration error. A row is fully
 * matched only when token and candidate counts agree and every pair is within
 * the tolerance; this makes missing or extra runs visible during preflight.
 */
export function matchPlanActualDurations(
  actualText: string,
  candidates: PlanActualCandidate[],
  toleranceMinutes = 2,
): PlanDurationMatch {
  const expectedMinutes = extractActualMinuteTokens(actualText);
  const actualMinutes = candidates.map((candidate) => candidate.movingTimeSec / 60);

  let bestPairs: PlanDurationPair[] = [];
  let bestDelta = Number.POSITIVE_INFINITY;

  const search = (
    expectedIndex: number,
    usedCandidates: Set<number>,
    pairs: PlanDurationPair[],
    totalDelta: number,
  ): void => {
    if (expectedIndex >= expectedMinutes.length) {
      if (pairs.length > bestPairs.length || (pairs.length === bestPairs.length && totalDelta < bestDelta)) {
        bestPairs = [...pairs];
        bestDelta = totalDelta;
      }
      return;
    }

    // Keep exploring partial assignments so a later expected token can still
    // match when the current token has no candidate inside the tolerance.
    search(expectedIndex + 1, usedCandidates, pairs, totalDelta);

    for (let candidateIndex = 0; candidateIndex < actualMinutes.length; candidateIndex += 1) {
      if (usedCandidates.has(candidateIndex)) {
        continue;
      }
      const deltaMinutes = Math.abs(expectedMinutes[expectedIndex] - actualMinutes[candidateIndex]);
      if (deltaMinutes > toleranceMinutes) {
        continue;
      }
      usedCandidates.add(candidateIndex);
      pairs.push({
        expectedIndex,
        candidateIndex,
        expectedMinutes: expectedMinutes[expectedIndex],
        actualMinutes: actualMinutes[candidateIndex],
        deltaMinutes,
      });
      search(expectedIndex + 1, usedCandidates, pairs, totalDelta + deltaMinutes);
      pairs.pop();
      usedCandidates.delete(candidateIndex);
    }
  };

  search(0, new Set<number>(), [], 0);
  bestPairs.sort((left, right) => left.expectedIndex - right.expectedIndex);
  const maxDeltaMinutes = bestPairs.length > 0 ? Math.max(...bestPairs.map((pair) => pair.deltaMinutes)) : null;

  return {
    expectedMinutes,
    actualMinutes,
    pairs: bestPairs,
    matched:
      expectedMinutes.length > 0 &&
      expectedMinutes.length === actualMinutes.length &&
      bestPairs.length === expectedMinutes.length,
    maxDeltaMinutes,
  };
}
