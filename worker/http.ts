// Small shared HTTP helpers for the Worker routes.

/** A bare `YYYY-MM-DD` `from` bound works as-is against ISO timestamps. */
export function normalizeFrom(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value.trim() : undefined;
}

/** A bare `YYYY-MM-DD` `to` bound is pushed to end-of-day so it stays inclusive. */
export function normalizeTo(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T23:59:59.999Z` : trimmed;
}
