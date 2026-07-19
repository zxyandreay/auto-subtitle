import type { RawTranscriptionSegment } from '../subtitles/formatting'
import type { SpeechRegion } from './speechActivity'

export type TimingRefinementOptions = {
  startSearchSeconds: number
  endSearchSeconds: number
  leadInSeconds: number
  tailPaddingSeconds: number
  minimumGapSeconds: number
}

const DEFAULT_OPTIONS: TimingRefinementOptions = {
  startSearchSeconds: 0.2,
  endSearchSeconds: 0.3,
  leadInSeconds: 0.08,
  tailPaddingSeconds: 0.18,
  minimumGapSeconds: 0.08,
}

type RefinedEvidence = {
  segment: RawTranscriptionSegment
  contentStart: number
  contentEnd: number
}

export function refineSegmentsToSpeechBoundaries(
  segments: RawTranscriptionSegment[],
  speechRegions: SpeechRegion[],
  options?: Partial<TimingRefinementOptions>,
): RawTranscriptionSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
  const rawStarts = sortedUniqueBoundaries(
    speechRegions.map((region) => region.rawStartTime ?? region.startTime),
  )
  const rawEnds = sortedUniqueBoundaries(
    speechRegions.map((region) => region.rawEndTime ?? region.endTime),
  )
  const refined: RefinedEvidence[] = sorted.map((segment) => refineSegment(segment, rawStarts, rawEnds, settings))

  enforceMinimumGaps(refined, Math.max(0, settings.minimumGapSeconds))
  return refined.map(({ segment }) => ({
    ...segment,
    startTime: round(segment.startTime),
    endTime: round(segment.endTime),
  }))
}

function refineSegment(
  segment: RawTranscriptionSegment,
  rawStarts: number[],
  rawEnds: number[],
  settings: TimingRefinementOptions,
): RefinedEvidence {
  const words = (segment.words ?? [])
    .filter(
      (word) =>
        Number.isFinite(word.startTime) &&
        Number.isFinite(word.endTime) &&
        word.endTime > word.startTime,
    )
    .sort((first, second) => first.startTime - second.startTime || first.endTime - second.endTime)
  const firstWord = words.at(0)
  const lastWord = words.at(-1)

  let contentStart = segment.startTime
  let contentEnd = segment.endTime
  let startTime = segment.startTime
  let endTime = segment.endTime

  if (firstWord && lastWord) {
    contentStart = firstWord.startTime
    contentEnd = lastWord.endTime
    startTime = Math.max(0, contentStart - Math.max(0, settings.leadInSeconds))
    endTime = contentEnd + Math.max(0, settings.tailPaddingSeconds)
  } else {
    const onset = nearestBoundary(segment.startTime, rawStarts, Math.max(0, settings.startSearchSeconds))
    const offset = nearestBoundary(segment.endTime, rawEnds, Math.max(0, settings.endSearchSeconds))
    if (onset !== undefined) {
      contentStart = onset
      startTime = Math.max(0, onset - Math.max(0, settings.leadInSeconds))
    }
    if (offset !== undefined) {
      contentEnd = offset
      endTime = offset + Math.max(0, settings.tailPaddingSeconds)
    }
  }

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    startTime = segment.startTime
    endTime = segment.endTime
    contentStart = segment.startTime
    contentEnd = segment.endTime
  }
  return {
    segment: { ...segment, startTime: round(startTime), endTime: round(endTime) },
    contentStart,
    contentEnd,
  }
}

function enforceMinimumGaps(refined: RefinedEvidence[], minimumGapSeconds: number): void {
  const minimumGapMilliseconds = Math.ceil(minimumGapSeconds * 1000 - Number.EPSILON)
  for (let index = 1; index < refined.length; index += 1) {
    const previous = refined[index - 1]
    const current = refined[index]
    const previousStart = toMilliseconds(previous.segment.startTime)
    const previousEnd = toMilliseconds(previous.segment.endTime)
    const currentStart = toMilliseconds(current.segment.startTime)
    const currentEnd = toMilliseconds(current.segment.endTime)
    if (previousEnd + minimumGapMilliseconds <= currentStart) {
      continue
    }

    const previousContentEnd = Math.min(currentEnd - 1, Math.max(previousStart + 1, toMilliseconds(previous.contentEnd)))
    const currentContentStart = Math.min(currentEnd - 1, Math.max(previousStart + 1, toMilliseconds(current.contentStart)))

    if (previousContentEnd + minimumGapMilliseconds <= currentContentStart) {
      const lowestPreviousEnd = previousContentEnd
      const highestPreviousEnd = currentContentStart - minimumGapMilliseconds
      const desiredBoundary = Math.floor((previousEnd + currentStart - minimumGapMilliseconds) / 2)
      const previousBoundary = Math.min(highestPreviousEnd, Math.max(lowestPreviousEnd, desiredBoundary))
      previous.segment.endTime = previousBoundary / 1000
      current.segment.startTime = (previousBoundary + minimumGapMilliseconds) / 1000
      continue
    }

    if (previousContentEnd <= currentContentStart) {
      // Rapid dialogue sometimes has less silence than the configured display
      // gap. Preserve every timestamped word and accept the smaller real gap.
      previous.segment.endTime = previousContentEnd / 1000
      current.segment.startTime = currentContentStart / 1000
      continue
    }

    // Conflicting content evidence itself overlaps, so a zero-gap split is the
    // only deterministic non-overlapping representation.
    const overlapBoundary = Math.min(
      currentEnd - 1,
      Math.max(previousStart + 1, Math.floor((previousContentEnd + currentContentStart) / 2)),
    )
    previous.segment.endTime = overlapBoundary / 1000
    current.segment.startTime = overlapBoundary / 1000
  }
}

function nearestBoundary(value: number, boundaries: number[], searchSeconds: number): number | undefined {
  if (!Number.isFinite(value) || !boundaries.length) {
    return undefined
  }
  let low = 0
  let high = boundaries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (boundaries[middle] < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  const candidates = [boundaries[low - 1], boundaries[low]].filter(
    (boundary): boundary is number => boundary !== undefined && Math.abs(boundary - value) <= searchSeconds,
  )
  return candidates.sort(
    (first, second) => Math.abs(first - value) - Math.abs(second - value) || first - second,
  )[0]
}

function sortedUniqueBoundaries(boundaries: number[]): number[] {
  return [...new Set(boundaries.filter((boundary) => Number.isFinite(boundary) && boundary >= 0))].sort(
    (first, second) => first - second,
  )
}

function toMilliseconds(value: number): number {
  return Math.round(value * 1000)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
