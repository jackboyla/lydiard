import magnessPrinciples from '../MAGNESS_PRINCIPLES.md';
import scullionPrinciples from '../SCULLION_PRINCIPLES.md';

export const EXPERT_WISDOM_SOURCES = [
  {
    id: 'scullion',
    title: "Stephen Scullion's Training Principles",
    filename: 'SCULLION_PRINCIPLES.md',
    content: scullionPrinciples,
  },
  {
    id: 'magness',
    title: "Steve Magness's Base-Training Principles",
    filename: 'MAGNESS_PRINCIPLES.md',
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
