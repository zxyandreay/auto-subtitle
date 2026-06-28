import {
  calculateCharactersPerSecond,
  normalizeForDuplicateComparison,
  tokenSimilarity,
  type RawTranscriptionSegment,
} from '../subtitles/formatting'

export type BoundaryReconciliationOptions = {
  boundarySearchSeconds: number
  duplicateSimilarity: number
  minimumTokenOverlap: number
  maxSubtitleDuration: number
  hardMaxCps: number
}

const DEFAULT_OPTIONS: BoundaryReconciliationOptions = {
  boundarySearchSeconds: 2,
  duplicateSimilarity: 0.8,
  minimumTokenOverlap: 2,
  maxSubtitleDuration: 6,
  hardMaxCps: 21,
}

export function reconcileBoundarySegments(
  existing: RawTranscriptionSegment[],
  incoming: RawTranscriptionSegment[],
  boundaryTime: number,
  options?: Partial<BoundaryReconciliationOptions>,
): RawTranscriptionSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const output = [...existing]
  for (const originalIncoming of incoming) {
    let next = { ...originalIncoming }
    const previous = output.at(-1)
    if (!previous || !isNearBoundary(previous, next, boundaryTime, settings.boundarySearchSeconds)) {
      output.push(next)
      continue
    }

    const similarity = tokenSimilarity(previous.text, next.text)
    if (similarity >= settings.duplicateSimilarity) {
      const mergedStart = Math.min(previous.startTime, next.startTime)
      const mergedEnd = Math.max(previous.endTime, next.endTime)
      const mergedDuration = mergedEnd - mergedStart
      if (
        mergedDuration <= settings.maxSubtitleDuration &&
        calculateCharactersPerSecond(previous.text, mergedStart, mergedEnd) <= settings.hardMaxCps
      ) {
        output[output.length - 1] = { ...previous, startTime: mergedStart, endTime: mergedEnd }
      }
      continue
    }

    const previousTokens = comparisonTokens(previous.text)
    const nextTokens = originalTokens(next.text)
    const nextComparisonTokens = nextTokens.map(normalizeToken).filter(Boolean)
    const overlap = suffixPrefixOverlap(previousTokens, nextComparisonTokens)
    if (overlap >= settings.minimumTokenOverlap && overlap < nextTokens.length) {
      const originalDuration = next.endTime - next.startTime
      next = {
        ...next,
        startTime: Math.max(
          previous.endTime,
          next.startTime + originalDuration * (overlap / nextTokens.length),
        ),
        text: nextTokens.slice(overlap).join(' '),
      }
    }
    if (next.text.trim() && next.endTime > next.startTime) {
      output.push(next)
    }
  }
  return output.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
}

export function areSimilarSegments(first: RawTranscriptionSegment, second: RawTranscriptionSegment): boolean {
  const firstText = normalizeForDuplicateComparison(first.text)
  const secondText = normalizeForDuplicateComparison(second.text)
  if (!firstText || !secondText) {
    return false
  }
  return firstText === secondText || tokenSimilarity(firstText, secondText) >= DEFAULT_OPTIONS.duplicateSimilarity
}

function isNearBoundary(
  previous: RawTranscriptionSegment,
  next: RawTranscriptionSegment,
  boundaryTime: number,
  searchSeconds: number,
): boolean {
  return (
    Math.abs(previous.endTime - boundaryTime) <= searchSeconds &&
    Math.abs(next.startTime - boundaryTime) <= searchSeconds
  )
}

function suffixPrefixOverlap(previous: string[], next: string[]): number {
  const limit = Math.min(previous.length, next.length)
  for (let length = limit; length >= 1; length -= 1) {
    if (previous.slice(-length).every((token, index) => token === next[index])) {
      return length
    }
  }
  return 0
}

function comparisonTokens(text: string): string[] {
  const normalized = normalizeForDuplicateComparison(text)
  return normalized ? normalized.split(' ') : []
}

function originalTokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}
