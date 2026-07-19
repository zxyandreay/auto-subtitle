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
  minimumGapOverlapRatio: number
}

const DEFAULT_OPTIONS: RepairOptions = {
  contextSeconds: 0.75,
  maxModelInputSeconds: 29,
  maxRepairRanges: 20,
  minimumGapSeconds: 0.5,
  minimumSubtitleGapSeconds: 0.08,
  minimumGapOverlapRatio: 0.5,
}

export function createRepairWindowPlans(
  gaps: TimeRange[],
  audioDuration: number,
  options?: Partial<RepairOptions>,
): RepairWindowPlan[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const contextSeconds = Math.max(0, settings.contextSeconds)
  const maxModelInputSeconds = Math.max(0.1, settings.maxModelInputSeconds)
  const maximumOwnedSeconds = Math.max(0.1, maxModelInputSeconds - contextSeconds * 2)
  const maxRepairRanges = Math.max(0, Math.floor(settings.maxRepairRanges))
  const plans: RepairWindowPlan[] = []

  for (const gap of gaps.filter((candidate) => candidate.endTime - candidate.startTime >= settings.minimumGapSeconds)) {
    let gapStartTime = gap.startTime
    while (gapStartTime < gap.endTime && plans.length < maxRepairRanges) {
      const gapEndTime = Math.min(gap.endTime, gapStartTime + maximumOwnedSeconds)
      let sliceStartTime = Math.max(0, gapStartTime - contextSeconds)
      let sliceEndTime = Math.min(audioDuration, gapEndTime + contextSeconds)
      if (sliceEndTime - sliceStartTime > maxModelInputSeconds) {
        sliceEndTime = Math.min(audioDuration, sliceStartTime + maxModelInputSeconds)
        sliceStartTime = Math.max(0, sliceEndTime - maxModelInputSeconds)
      }
      plans.push({ gapStartTime, gapEndTime, sliceStartTime, sliceEndTime })
      gapStartTime = gapEndTime
    }
    if (plans.length >= maxRepairRanges) {
      break
    }
  }

  return plans
}

export function selectRepairSegments(
  existing: RawTranscriptionSegment[],
  candidates: RawTranscriptionSegment[],
  gap: TimeRange,
  options?: Partial<RepairOptions>,
): RawTranscriptionSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const selected: RawTranscriptionSegment[] = []
  for (const originalCandidate of [...candidates].sort(
    (first, second) => first.startTime - second.startTime || first.endTime - second.endTime,
  )) {
    const candidate = constrainCandidateToGap(originalCandidate, gap, settings.minimumGapOverlapRatio)
    if (
      !candidate ||
      !candidate.text.trim() ||
      !Number.isFinite(candidate.startTime) ||
      !Number.isFinite(candidate.endTime) ||
      candidate.endTime <= candidate.startTime ||
      candidate.endTime <= gap.startTime ||
      candidate.startTime >= gap.endTime ||
      [...existing, ...selected].some(
        (segment) => rangesOverlap(segment, candidate) && areSimilarSegments(segment, candidate),
      )
    ) {
      continue
    }

    const occupied = [...existing, ...selected].sort(
      (first, second) => first.startTime - second.startTime || first.endTime - second.endTime,
    )
    const previous = occupied.filter((segment) => segment.startTime <= candidate.startTime).at(-1)
    const next = occupied.find((segment) => segment.startTime > candidate.startTime)
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
    const words = candidate.words?.filter(
      (word) => word.startTime >= startTime && word.endTime <= endTime,
    )
    if (candidate.words?.length && !words?.length) {
      continue
    }
    const acceptedStartTime = words?.length ? Math.max(startTime, words[0].startTime) : startTime
    const acceptedEndTime = words?.length ? Math.min(endTime, words.at(-1)!.endTime) : endTime
    if (acceptedEndTime <= acceptedStartTime) {
      continue
    }
    selected.push({
      ...candidate,
      startTime: round(acceptedStartTime),
      endTime: round(acceptedEndTime),
      text: words?.length ? joinRepairWords(words.map((word) => word.text)) : candidate.text,
      words: words?.length ? words : undefined,
    })
  }
  return selected
}

function constrainCandidateToGap(
  candidate: RawTranscriptionSegment,
  gap: TimeRange,
  minimumGapOverlapRatio: number,
): RawTranscriptionSegment | null {
  const validWords = candidate.words
    ?.filter(
      (word) =>
        word.text.trim() &&
        Number.isFinite(word.startTime) &&
        Number.isFinite(word.endTime) &&
        word.endTime > word.startTime &&
        word.startTime >= gap.startTime &&
        word.endTime <= gap.endTime,
    )
    .sort((first, second) => first.startTime - second.startTime || first.endTime - second.endTime)
  if (candidate.words?.length) {
    if (!validWords?.length) {
      return null
    }
    return {
      ...candidate,
      startTime: Math.max(gap.startTime, validWords[0].startTime),
      endTime: Math.min(gap.endTime, validWords.at(-1)!.endTime),
      text: joinRepairWords(validWords.map((word) => word.text)),
      words: validWords,
    }
  }

  const overlap = Math.max(0, Math.min(candidate.endTime, gap.endTime) - Math.max(candidate.startTime, gap.startTime))
  const candidateDuration = candidate.endTime - candidate.startTime
  if (candidateDuration <= 0 || overlap / candidateDuration < Math.max(0, minimumGapOverlapRatio)) {
    return null
  }
  return candidate
}

function rangesOverlap(first: RawTranscriptionSegment, second: RawTranscriptionSegment): boolean {
  return first.startTime < second.endTime && second.startTime < first.endTime
}

function joinRepairWords(words: string[]): string {
  let result = ''
  for (const word of words) {
    const token = word.trim()
    if (!token) {
      continue
    }
    const joinsPrevious =
      !result ||
      /^[,.;:!?%\])}\u3001\u3002\uff0c\uff01\uff1f]/u.test(token) ||
      /[([{\u2018\u201c]$/u.test(result) ||
      (containsCjk(token[0] ?? '') &&
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u2026\u2014\u2019\u201d\uff09\u3011\u300b\u300d\u300f]*$/u.test(result))
    result += joinsPrevious ? token : ` ${token}`
  }
  return result.trim()
}

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
