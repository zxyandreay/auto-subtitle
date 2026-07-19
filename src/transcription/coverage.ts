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
  largeAbsoluteGapSeconds: number
  ignoreGapBelowSeconds: number
  coverageToleranceSeconds: number
  minimumCoverageConfidence: number
  minimumSegmentSpeechOverlapRatio: number
  minimumWordTextRepresentationRatio: number
  maximumWordDurationSeconds: number
}

export const DEFAULT_COVERAGE_OPTIONS: CoverageOptions = {
  minimumUncoveredSeconds: 0.5,
  minimumUncoveredRatio: 0.4,
  largeAbsoluteGapSeconds: 2,
  ignoreGapBelowSeconds: 0.25,
  coverageToleranceSeconds: 0.1,
  minimumCoverageConfidence: 0.5,
  minimumSegmentSpeechOverlapRatio: 0.35,
  minimumWordTextRepresentationRatio: 0.6,
  maximumWordDurationSeconds: 4,
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
    segments.flatMap((segment) => coverageEvidenceForSegment(segment, boundedDuration)),
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
  const rawSpeech = mergeTimeRanges(
    speechRegions.map((region) => ({
      startTime: region.rawStartTime ?? region.startTime,
      endTime: region.rawEndTime ?? region.endTime,
    })),
  )
  if (!rawSpeech.length) {
    return []
  }

  const coveredEvidence = segments.flatMap((segment) => {
    if (
      !segment.text.trim() ||
      !isValidRange(segment) ||
      (segment.confidence !== undefined && segment.confidence < settings.minimumCoverageConfidence)
    ) {
      return []
    }
    const hasWordEvidence = (segment.words ?? []).some((word) => word.text.trim())
    if (hasWordEvidence) {
      const words = reliableWordRanges(segment, settings)
      // Do not replace incomplete or implausible word metadata with the much
      // wider segment interval: that would turn weak evidence into false coverage.
      return intersectTimeRanges(words, rawSpeech)
    }
    const speechOverlap = intersectTimeRanges([segment], rawSpeech)
    const overlapDuration = totalDuration(speechOverlap)
    const segmentDuration = segment.endTime - segment.startTime
    if (overlapDuration / segmentDuration < settings.minimumSegmentSpeechOverlapRatio) {
      return []
    }
    // Count only raw speech intersections, not display lead/tail or readability extension.
    return speechOverlap
  })
  const covered = intersectTimeRanges(
    mergeTimeRanges(coveredEvidence).map((range) => ({
      startTime: Math.max(0, range.startTime - Math.max(0, settings.coverageToleranceSeconds)),
      endTime: range.endTime + Math.max(0, settings.coverageToleranceSeconds),
    })),
    rawSpeech,
  )
  const gaps: TimeRange[] = []
  let coveredIndex = 0

  for (const region of rawSpeech) {
    while (coveredIndex < covered.length && covered[coveredIndex].endTime <= region.startTime) {
      coveredIndex += 1
    }
    const regionGaps = subtractSortedRanges(region, covered, coveredIndex).filter(
      (gap) => gap.endTime - gap.startTime >= Math.max(0, settings.ignoreGapBelowSeconds),
    )
    const uncoveredDuration = totalDuration(regionGaps)
    const uncoveredRatio = uncoveredDuration / (region.endTime - region.startTime)
    const largestGap = Math.max(0, ...regionGaps.map((gap) => gap.endTime - gap.startTime))
    if (
      uncoveredRatio < Math.max(0, settings.minimumUncoveredRatio) &&
      largestGap < Math.max(settings.minimumUncoveredSeconds, settings.largeAbsoluteGapSeconds)
    ) {
      continue
    }
    gaps.push(
      ...regionGaps.filter(
        (gap) => gap.endTime - gap.startTime >= Math.max(0, settings.minimumUncoveredSeconds),
      ),
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

function coverageEvidenceForSegment(
  segment: RawTranscriptionSegment,
  duration?: number,
): TimeRange[] {
  if (!segment.text.trim()) {
    return []
  }
  const wordRanges = usableWordRanges(segment, duration)
  if (wordRanges.length) {
    return wordRanges
  }
  if (!isValidRange(segment)) {
    return []
  }
  const range = {
    startTime: Math.min(duration ?? Number.POSITIVE_INFINITY, Math.max(0, segment.startTime)),
    endTime: Math.min(duration ?? Number.POSITIVE_INFINITY, segment.endTime),
  }
  return isValidRange(range) ? [range] : []
}

function usableWordRanges(segment: RawTranscriptionSegment, duration?: number): TimeRange[] {
  return (segment.words ?? [])
    .filter((word) => word.text.trim())
    .map((word) => ({
      startTime: Math.min(duration ?? Number.POSITIVE_INFINITY, Math.max(0, word.startTime)),
      endTime: Math.min(duration ?? Number.POSITIVE_INFINITY, word.endTime),
    }))
    .filter(isValidRange)
}

function reliableWordRanges(
  segment: RawTranscriptionSegment,
  settings: CoverageOptions,
): TimeRange[] {
  const maximumWordDuration = Math.max(0, settings.maximumWordDurationSeconds)
  const words = (segment.words ?? []).filter(
    (word) =>
      word.text.trim() &&
      isValidRange(word) &&
      word.endTime - word.startTime <= maximumWordDuration,
  )
  if (
    !words.length ||
    wordTextRepresentationRatio(segment.text, words.map((word) => word.text)) <
      Math.max(0, Math.min(1, settings.minimumWordTextRepresentationRatio))
  ) {
    return []
  }
  return intersectTimeRanges(words, [segment])
}

function wordTextRepresentationRatio(segmentText: string, wordTexts: string[]): number {
  const normalizedSegment = normalizeCoverageText(segmentText)
  if (!normalizedSegment) {
    return 0
  }
  let cursor = 0
  let representedCharacters = 0
  for (const wordText of wordTexts) {
    const normalizedWord = normalizeCoverageText(wordText)
    if (!normalizedWord) {
      continue
    }
    const matchIndex = normalizedSegment.indexOf(normalizedWord, cursor)
    if (matchIndex < 0) {
      continue
    }
    representedCharacters += normalizedWord.length
    cursor = matchIndex + normalizedWord.length
  }
  return Math.min(1, representedCharacters / normalizedSegment.length)
}

function normalizeCoverageText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '')
}

function intersectTimeRanges(first: TimeRange[], second: TimeRange[]): TimeRange[] {
  const intersections: TimeRange[] = []
  const sortedFirst = mergeTimeRanges(first)
  const sortedSecond = mergeTimeRanges(second)
  let firstIndex = 0
  let secondIndex = 0
  while (firstIndex < sortedFirst.length && secondIndex < sortedSecond.length) {
    const startTime = Math.max(sortedFirst[firstIndex].startTime, sortedSecond[secondIndex].startTime)
    const endTime = Math.min(sortedFirst[firstIndex].endTime, sortedSecond[secondIndex].endTime)
    if (endTime > startTime) {
      intersections.push({ startTime, endTime })
    }
    if (sortedFirst[firstIndex].endTime <= sortedSecond[secondIndex].endTime) {
      firstIndex += 1
    } else {
      secondIndex += 1
    }
  }
  return intersections
}

function subtractSortedRanges(region: TimeRange, coveredRanges: TimeRange[], startIndex: number): TimeRange[] {
  const gaps: TimeRange[] = []
  let cursor = region.startTime
  for (let index = startIndex; index < coveredRanges.length; index += 1) {
    const covered = coveredRanges[index]
    if (covered.startTime >= region.endTime) {
      break
    }
    if (covered.endTime <= cursor) {
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

function totalDuration(ranges: TimeRange[]): number {
  return ranges.reduce((total, range) => total + range.endTime - range.startTime, 0)
}

function isValidRange(range: TimeRange): boolean {
  return (
    Number.isFinite(range.startTime) &&
    Number.isFinite(range.endTime) &&
    range.startTime >= 0 &&
    range.endTime > range.startTime
  )
}
