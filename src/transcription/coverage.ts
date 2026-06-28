import type { RawTranscriptionSegment } from '../subtitles/formatting'
import type { SpeechRegion } from './speechActivity'

export type TimeRange = {
  startTime: number
  endTime: number
}

export type SubtitleCoverage = {
  ranges: TimeRange[]
  coveredDuration: number
  audioDuration: number
  coverageRatio: number
}

export type CoverageOptions = {
  minimumUncoveredSeconds: number
  minimumUncoveredRatio: number
  ignoreGapBelowSeconds: number
  coverageToleranceSeconds: number
}

export const DEFAULT_COVERAGE_OPTIONS: CoverageOptions = {
  minimumUncoveredSeconds: 0.5,
  minimumUncoveredRatio: 0.4,
  ignoreGapBelowSeconds: 0.25,
  coverageToleranceSeconds: 0.1,
}

export function calculateSubtitleCoverage(
  segments: RawTranscriptionSegment[],
  audioDuration?: number,
): SubtitleCoverage {
  const boundedDuration =
    audioDuration !== undefined && Number.isFinite(audioDuration) && audioDuration >= 0
      ? audioDuration
      : undefined
  const ranges = mergeTimeRanges(
    segments
      .filter((segment) => segment.text.trim() && isValidRange(segment))
      .map(({ startTime, endTime }) => ({
        startTime: Math.min(boundedDuration ?? Number.POSITIVE_INFINITY, Math.max(0, startTime)),
        endTime: Math.min(boundedDuration ?? Number.POSITIVE_INFINITY, endTime),
      })),
  )
  const coveredDuration = ranges.reduce((total, range) => total + range.endTime - range.startTime, 0)
  const effectiveAudioDuration = boundedDuration ?? ranges.at(-1)?.endTime ?? 0
  return {
    ranges,
    coveredDuration,
    audioDuration: effectiveAudioDuration,
    coverageRatio: effectiveAudioDuration > 0 ? Math.min(1, coveredDuration / effectiveAudioDuration) : 0,
  }
}

export function findUncoveredSpeechRanges(
  speechRegions: SpeechRegion[],
  segments: RawTranscriptionSegment[],
  options?: Partial<CoverageOptions>,
): TimeRange[] {
  const settings = { ...DEFAULT_COVERAGE_OPTIONS, ...options }
  const covered = calculateSubtitleCoverage(segments).ranges.map((range) => ({
    startTime: Math.max(0, range.startTime - settings.coverageToleranceSeconds),
    endTime: range.endTime + settings.coverageToleranceSeconds,
  }))
  const gaps: TimeRange[] = []

  for (const region of mergeTimeRanges(speechRegions.filter(isValidRange))) {
    const regionGaps = subtractRanges(region, covered).filter(
      (gap) => gap.endTime - gap.startTime >= settings.ignoreGapBelowSeconds,
    )
    const uncoveredDuration = regionGaps.reduce((total, gap) => total + gap.endTime - gap.startTime, 0)
    const uncoveredRatio = uncoveredDuration / (region.endTime - region.startTime)
    if (uncoveredRatio < settings.minimumUncoveredRatio) {
      continue
    }

    gaps.push(
      ...regionGaps.filter((gap) => gap.endTime - gap.startTime >= settings.minimumUncoveredSeconds),
    )
  }

  return mergeTimeRanges(gaps)
}

export function mergeTimeRanges(ranges: TimeRange[]): TimeRange[] {
  const merged: TimeRange[] = []
  for (const range of [...ranges].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)) {
    if (!isValidRange(range)) {
      continue
    }
    const previous = merged.at(-1)
    if (previous && range.startTime <= previous.endTime) {
      previous.endTime = Math.max(previous.endTime, range.endTime)
    } else {
      merged.push({ startTime: range.startTime, endTime: range.endTime })
    }
  }
  return merged
}

function subtractRanges(region: TimeRange, coveredRanges: TimeRange[]): TimeRange[] {
  const gaps: TimeRange[] = []
  let cursor = region.startTime
  for (const covered of coveredRanges) {
    if (covered.endTime <= cursor || covered.startTime >= region.endTime) {
      continue
    }
    if (covered.startTime > cursor) {
      gaps.push({ startTime: cursor, endTime: Math.min(region.endTime, covered.startTime) })
    }
    cursor = Math.max(cursor, covered.endTime)
    if (cursor >= region.endTime) {
      break
    }
  }
  if (cursor < region.endTime) {
    gaps.push({ startTime: cursor, endTime: region.endTime })
  }
  return gaps.filter(isValidRange)
}

function isValidRange(range: TimeRange): boolean {
  return (
    Number.isFinite(range.startTime) &&
    Number.isFinite(range.endTime) &&
    range.startTime >= 0 &&
    range.endTime > range.startTime
  )
}
