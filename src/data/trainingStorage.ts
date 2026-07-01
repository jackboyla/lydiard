import type { ImportedTrainingData } from './importActivities';

const STORAGE_KEY = 'lydiard.importedTraining.v1';

export function loadImportedTraining(): ImportedTrainingData | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as ImportedTrainingData;

    if (!Array.isArray(parsed.weeks) || parsed.weeks.length === 0) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveImportedTraining(training: ImportedTrainingData): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(training));
}

export function clearImportedTraining(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
