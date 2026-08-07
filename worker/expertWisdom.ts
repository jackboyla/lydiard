// The two wisdom files are gitignored and supplied by the deployment, so titles come from each
// file's own H1 rather than being hardcoded here. See wisdom/README.md.
import magnessPrinciples from '../wisdom/magness-principles.md';
import scullionPrinciples from '../wisdom/scullion-principles.md';

function titleOf(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

export const EXPERT_WISDOM_SOURCES = [
  {
    id: 'scullion',
    title: titleOf(scullionPrinciples, 'Primary coaching principles'),
    filename: 'wisdom/scullion-principles.md',
    content: scullionPrinciples,
  },
  {
    id: 'magness',
    title: titleOf(magnessPrinciples, 'Secondary coaching principles'),
    filename: 'wisdom/magness-principles.md',
    content: magnessPrinciples,
  },
] as const;

export type ExpertWisdomSourceId = typeof EXPERT_WISDOM_SOURCES[number]['id'];

export function getExpertWisdom(source?: string) {
  const selected = source && source !== 'all'
    ? EXPERT_WISDOM_SOURCES.filter((item) => item.id === source)
    : EXPERT_WISDOM_SOURCES;
  return {
    generatedAt: new Date().toISOString(),
    sources: selected.map((item) => ({
      ...item,
      characters: item.content.length,
    })),
    instructions:
      'Treat these files as coaching principles, not literal prescriptions. Reconcile them with the athlete profile, ' +
      'current physiology, recent training response, injury constraints, goal, and available dates before proposing sessions.',
  };
}
