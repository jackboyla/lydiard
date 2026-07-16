import { AgentPlanInputError, parseAgentPlanSubmission } from '../worker/agentPlan';
import { buildOpenApiDocument } from '../worker/openapi';

const validPlan = {
  requestId: 'agent-plan-smoke-1',
  expectedProfileVersion: 1,
  contextGeneratedAt: '2026-07-15T12:00:00.000Z',
  title: 'Two-week aerobic development block',
  goal: 'Build toward a controlled 5K while preserving consistency.',
  summary: 'Hold sustainable volume, add one controlled threshold stimulus, and retain relaxed speed.',
  startDate: '2026-07-20',
  numberOfWeeks: 2,
  expertSources: ['scullion', 'magness'],
  sessions: [{
    plannedDate: '2026-07-21',
    title: 'Controlled threshold repetitions',
    sessionType: 'threshold',
    trainingPhase: 'aerobic_conditioning',
    priority: 'key',
    plannedDurationMin: 62,
    plannedDistanceKm: 12.5,
    targets: {
      powerPctCriticalPower: { low: 0.88, high: 0.94 },
      heartRateCeiling: 174,
      paceSecPerKm: { fastSecPerKm: 205, slowSecPerKm: 218 },
    },
    workoutSteps: [
      { kind: 'warmup', durationMin: 18, note: 'Easy conversational running, then four relaxed strides.' },
      { kind: 'repetitions', count: 3, repetitionDurationSec: 600, recoveryDurationSec: 90, note: 'Start below ego; keep breathing organized and make the final repetition resemble the first.' },
      { kind: 'cooldown', durationMin: 12, note: 'Jog easily until breathing and mechanics are normal.' },
    ],
    purpose: 'Accumulate repeatable aerobic work near LT2 without turning the session into a race.',
    fallbackPlan: 'If fatigue is elevated, run 45 minutes easy and omit the threshold work.',
    coachReasoning: 'Recent aerobic running is stable enough for one controlled quality exposure, while the goal still rewards consistency over peak strain.',
    adaptationGuidance: 'Stop the work if mechanics deteriorate or pain changes gait; shorten to two repetitions if the second is already materially slower or costlier.',
  }],
} as const;

const parsed = parseAgentPlanSubmission(validPlan);
assert(parsed.numberOfWeeks === 2, 'valid plan horizon was not preserved');
assert(parsed.sessions[0].workoutSteps.length === 3, 'detailed workout steps were not preserved');
assert(parsed.sessions[0].adaptationGuidance.includes('mechanics'), 'adaptation guidance was not preserved');

expectInputError({ ...validPlan, numberOfWeeks: 13 }, '13-week plan should be rejected');
expectInputError({
  ...validPlan,
  sessions: [{ ...validPlan.sessions[0], plannedDate: '2026-08-10' }],
}, 'session outside the requested horizon should be rejected');
expectInputError({
  ...validPlan,
  sessions: [{
    ...validPlan.sessions[0],
    targets: { paceSecPerKm: { fastSecPerKm: 230, slowSecPerKm: 210 } },
  }],
}, 'reversed pace range should be rejected');
expectInputError({
  ...validPlan,
  sessions: [{ ...validPlan.sessions[0], adaptationGuidance: '' }],
}, 'missing adaptation guidance should be rejected');

const document = buildOpenApiDocument('https://example.test') as {
  info: { version: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};
const publish = document.paths['/api/agent/plans']?.post;
assert(document.info.version === '3.0.0', 'OpenAPI version was not advanced');
assert(Boolean(document.paths['/api/agent/expert-wisdom']?.get), 'expert-wisdom operation is missing');
assert(Boolean(document.paths['/api/agent/planned-sessions']?.get), 'detailed planned-sessions operation is missing');
assert(Boolean(publish), 'publish-plan operation is missing');
assert(publish['x-openai-isConsequential'] === true, 'publish-plan operation must be consequential');
assert(
  (document.components.schemas.AgentPlanPublishRequest.properties as Record<string, { maximum?: number }>).numberOfWeeks.maximum === 12,
  'OpenAPI plan horizon must match runtime validation',
);
const bareObjects: string[] = [];
visit(document, '$', (node, path) => {
  if (node.type === 'object' && (!node.properties || typeof node.properties !== 'object')) bareObjects.push(path);
});
assert(bareObjects.length === 0, `OpenAPI contains object schemas without properties: ${bareObjects.join(', ')}`);

console.log(JSON.stringify({
  horizonWeeks: parsed.numberOfWeeks,
  detailedSteps: parsed.sessions[0].workoutSteps.length,
  expertSources: parsed.expertSources,
  openApiVersion: document.info.version,
  consequential: publish['x-openai-isConsequential'],
}, null, 2));

function expectInputError(value: unknown, message: string): void {
  try {
    parseAgentPlanSubmission(value);
  } catch (error) {
    if (error instanceof AgentPlanInputError) return;
    throw error;
  }
  throw new Error(`Agent plan smoke failed: ${message}`);
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Agent plan smoke failed: ${message}`);
}

function visit(value: unknown, path: string, inspect: (node: Record<string, unknown>, path: string) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, inspect));
    return;
  }
  const record = value as Record<string, unknown>;
  inspect(record, path);
  for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`, inspect);
}
