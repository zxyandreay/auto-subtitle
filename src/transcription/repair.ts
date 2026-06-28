import { normalizeForDuplicateComparison, type RawTranscriptionSegment } from '../subtitles/formatting'
import type { TimeRange } from './coverage'
import { areSimilarSegments } from './reconciliation'

export type RepairWindowPlan = {
  gapStartTime: number
  gapEndTime: number
  sliceStartTime: number
  sliceEndTime: number
}

export type RepairOptions = {
  contextSeconds: number
  maxModelInputSeconds: number
  maxRepairRanges: number
  minimumGapSeconds: number
  minimumSubtitleGapSeconds: number
}

const DEFAULT_OPTIONS: RepairOptions = {
  contextSeconds: 0.75,
  maxModelInputSeconds: 29,
  maxRepairRanges: 20,
  minimumGapSeconds: 0.5,
  minimumSubtitleGapSeconds: 0.08,
}

export function createRepairWindowPlans(
  gaps: TimeRange[],
  audioDuration: number,
  options?: Partial<RepairOptions>,
): RepairWindowPlan[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  return gaps
    .filter((gap) => gap.endTime - gap.startTime >= settings.minimumGapSeconds)
    .slice(0, settings.maxRepairRanges)
    .map((gap) => {
      let sliceStartTime = Math.max(0, gap.startTime - settings.contextSeconds)
      let sliceEndTime = Math.min(audioDuration, gap.endTime + settings.contextSeconds)
      if (sliceEndTime - sliceStartTime > settings.maxModelInputSeconds) {
        const midpoint = (gap.startTime + gap.endTime) / 2
        sliceStartTime = Math.max(0, midpoint - settings.maxModelInputSeconds / 2)
        sliceEndTime = Math.min(audioDuration, sliceStartTime + settings.maxModelInputSeconds)
        sliceStartTime = Math.max(0, sliceEndTime - settings.maxModelInputSeconds)
      }
      return { ...gap, gapStartTime: gap.startTime, gapEndTime: gap.endTime, sliceStartTime, sliceEndTime }
    })
    .map(({ startTime: _startTime, endTime: _endTime, ...window }) => window)
}

export function selectRepairSegments(
  existing: RawTranscriptionSegment[],
  candidates: RawTranscriptionSegment[],
  gap: TimeRange,
  options?: Partial<RepairOptions>,
): RawTranscriptionSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const selected: RawTranscriptionSegment[] = []
  for (const candidate of candidates) {
    if (
      !candidate.text.trim() ||
      !Number.isFinite(candidate.startTime) ||
      !Number.isFinite(candidate.endTime) ||
      candidate.endTime <= candidate.startTime ||
      candidate.endTime <= gap.startTime ||
      candidate.startTime >= gap.endTime ||
      [...existing, ...selected].some(
        (segment) => temporalDistance(segment, candidate) <= 2 && areSimilarSegments(segment, candidate),
      )
    ) {
      continue
    }

    const previous = existing.filter((segment) => segment.endTime <= gap.endTime).at(-1)
    const next = existing.find((segment) => segment.startTime >= gap.startTime)
    const startTime = Math.max(
      candidate.startTime,
      gap.startTime,
      previous ? previous.endTime + settings.minimumSubtitleGapSeconds : 0,
    )
    const endTime = Math.min(
      candidate.endTime,
      gap.endTime,
      next ? next.startTime - settings.minimumSubtitleGapSeconds : Number.POSITIVE_INFINITY,
    )
    if (endTime <= startTime || !normalizeForDuplicateComparison(candidate.text)) {
      continue
    }
    selected.push({ ...candidate, startTime: round(startTime), endTime: round(endTime) })
  }
  return selected
}

function temporalDistance(first: RawTranscriptionSegment, second: RawTranscriptionSegment): number {
  if (first.endTime < second.startTime) {
    return second.startTime - first.endTime
  }
  if (second.endTime < first.startTime) {
    return first.startTime - second.endTime
  }
  return 0
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
