export const MIN_REGENERATION_ALTERNATIVES = 1
export const MAX_REGENERATION_ALTERNATIVES = 5
export const DEFAULT_REGENERATION_ALTERNATIVES = 3

export function normalizeRegenerationAlternativeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_REGENERATION_ALTERNATIVES
  }

  return Math.max(
    MIN_REGENERATION_ALTERNATIVES,
    Math.min(MAX_REGENERATION_ALTERNATIVES, Math.round(value)),
  )
}
