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

export function refineSegmentsToSpeechBoundaries(
  segments: RawTranscriptionSegment[],
  speechRegions: SpeechRegion[],
  options?: Partial<TimingRefinementOptions>,
): RawTranscriptionSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const sorted = [...segments].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
  const refined = sorted.map((segment) => {
    const onset = nearestBoundary(segment.startTime, speechRegions.map((region) => region.startTime), settings.startSearchSeconds)
    const offset = nearestBoundary(segment.endTime, speechRegions.map((region) => region.endTime), settings.endSearchSeconds)
    const snappedStart = onset === undefined ? segment.startTime : Math.max(0, onset - settings.leadInSeconds)
    const snappedEnd = offset === undefined ? segment.endTime : offset + settings.tailPaddingSeconds
    const startTime =
      Math.abs(snappedStart - segment.startTime) <= settings.startSearchSeconds + Number.EPSILON * 10
        ? snappedStart
        : segment.startTime
    const endTime =
      Math.abs(snappedEnd - segment.endTime) <= settings.endSearchSeconds + Number.EPSILON * 10
        ? snappedEnd
        : segment.endTime

    if (endTime <= startTime) {
      return segment
    }
    return { ...segment, startTime: round(startTime), endTime: round(endTime) }
  })

  for (let index = 1; index < refined.length; index += 1) {
    const previous = refined[index - 1]
    const current = refined[index]
    if (previous.endTime + settings.minimumGapSeconds <= current.startTime) {
      continue
    }

    previous.endTime = sorted[index - 1].endTime
    current.startTime = sorted[index].startTime
  }

  return refined
}

function nearestBoundary(value: number, boundaries: number[], searchSeconds: number): number | undefined {
  return boundaries
    .filter((boundary) => Math.abs(boundary - value) <= searchSeconds)
    .sort((first, second) => Math.abs(first - value) - Math.abs(second - value))[0]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
