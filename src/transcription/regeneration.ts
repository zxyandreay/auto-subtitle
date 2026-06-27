import { normalizeForDuplicateComparison } from '../subtitles/formatting'
import type { RegenerationCandidate, RegenerationRange } from './types'

export const MAX_REGENERATION_RANGE_SECONDS = 30
export const MAX_REGENERATION_CONTEXT_SECONDS = 2
export const MAX_REGENERATION_CANDIDATES = 3

export type RegenerationDecodingProfile = {
  id: string
  doSample: boolean
  temperature?: number
  topK?: number
}

export const REGENERATION_DECODING_PROFILES: RegenerationDecodingProfile[] = [
  { id: 'greedy', doSample: false },
  { id: 'sample-04', doSample: true, temperature: 0.4, topK: 30 },
  { id: 'sample-075', doSample: true, temperature: 0.75, topK: 40 },
  { id: 'sample-09', doSample: true, temperature: 0.9, topK: 50 },
  { id: 'sample-10', doSample: true, temperature: 1, topK: 50 },
]

export type RegenerationAudioRange = {
  extractionStartTime: number
  extractionEndTime: number
}

export function validateRegenerationRange(range: RegenerationRange, videoDuration?: number): string | null {
  if (!Number.isFinite(range.startTime) || !Number.isFinite(range.endTime)) {
    return 'Start and end times must be valid numbers.'
  }
  if (range.startTime < 0 || range.endTime < 0) {
    return 'Start and end times cannot be negative.'
  }
  if (range.endTime <= range.startTime) {
    return 'End time must be after start time.'
  }
  if (range.endTime - range.startTime > MAX_REGENERATION_RANGE_SECONDS) {
    return `Regeneration ranges cannot exceed ${MAX_REGENERATION_RANGE_SECONDS} seconds.`
  }
  if (videoDuration !== undefined && videoDuration > 0 && range.endTime > videoDuration) {
    return 'The regeneration range must stay within the video duration.'
  }
  return null
}

export function planRegenerationAudioRange(
  range: RegenerationRange,
  videoDuration?: number,
): RegenerationAudioRange {
  const rangeDuration = range.endTime - range.startTime
  const contextBudget = Math.max(0, MAX_REGENERATION_RANGE_SECONDS - rangeDuration)
  const contextPerSide = Math.min(MAX_REGENERATION_CONTEXT_SECONDS, contextBudget / 2)
  const leftContext = Math.min(contextPerSide, range.startTime)
  const availableRight =
    videoDuration !== undefined && videoDuration > 0
      ? Math.max(0, videoDuration - range.endTime)
      : Number.POSITIVE_INFINITY
  const rightContext = Math.min(contextPerSide, availableRight)

  return {
    extractionStartTime: roundMilliseconds(range.startTime - leftContext),
    extractionEndTime: roundMilliseconds(range.endTime + rightContext),
  }
}

export function dedupeRegenerationCandidates(
  candidates: RegenerationCandidate[],
  maximum = MAX_REGENERATION_CANDIDATES,
): RegenerationCandidate[] {
  const seen = new Set<string>()
  const unique: RegenerationCandidate[] = []

  for (const candidate of candidates) {
    const normalized = normalizeForDuplicateComparison(candidate.text)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    unique.push(candidate)
    if (unique.length >= maximum) {
      break
    }
  }

  return unique
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000
}
