import type { SpeechRegion } from './speechActivity'

export const MAX_WHISPER_WINDOW_SECONDS = 29
export const MIN_WHISPER_WINDOW_SECONDS = 5
export const TARGET_SPEECH_WINDOW_SECONDS = 26
export const SPEECH_AWARE_OVERLAP_SECONDS = 1.5
export const FALLBACK_OVERLAP_SECONDS = 4

export type TranscriptionWindowTiming = {
  sliceStartTime: number
  sliceEndTime: number
  coreStartTime: number
  coreEndTime: number
}

export type TranscriptionWindowPlan = {
  windowSeconds: number
  coreSeconds: number
  overlapSeconds: number
  windows: TranscriptionWindowTiming[]
}

export type SpeechAwareWindowOptions = {
  maxModelInputSeconds: number
  targetChunkSeconds: number
  overlapSeconds: number
  hardMinWindowSeconds: number
}

export const DEFAULT_SPEECH_AWARE_WINDOW_OPTIONS: SpeechAwareWindowOptions = {
  maxModelInputSeconds: MAX_WHISPER_WINDOW_SECONDS,
  targetChunkSeconds: TARGET_SPEECH_WINDOW_SECONDS,
  overlapSeconds: SPEECH_AWARE_OVERLAP_SECONDS,
  hardMinWindowSeconds: MIN_WHISPER_WINDOW_SECONDS,
}

export function createTranscriptionWindowPlan(
  durationSeconds: number,
  requestedWindowSeconds: number,
  requestedOverlapSeconds: number,
): TranscriptionWindowPlan {
  const windowSeconds = clampFinite(
    requestedWindowSeconds,
    MIN_WHISPER_WINDOW_SECONDS,
    MAX_WHISPER_WINDOW_SECONDS,
    MAX_WHISPER_WINDOW_SECONDS,
  )
  const overlapSeconds = clampFinite(requestedOverlapSeconds, 0, windowSeconds / 4, 0)
  const coreSeconds = windowSeconds - overlapSeconds * 2
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0
  const windows: TranscriptionWindowTiming[] = []
  let coreStartTime = 0

  while (coreStartTime < duration) {
    const coreEndTime = Math.min(duration, coreStartTime + coreSeconds)

    windows.push({
      sliceStartTime: Math.max(0, coreStartTime - overlapSeconds),
      sliceEndTime: Math.min(duration, coreEndTime + overlapSeconds),
      coreStartTime,
      coreEndTime,
    })

    coreStartTime = coreEndTime
  }

  return {
    windowSeconds,
    coreSeconds,
    overlapSeconds,
    windows,
  }
}

export function createSpeechAwareTranscriptionWindowPlan(
  durationSeconds: number,
  speechRegions: SpeechRegion[],
  options?: Partial<SpeechAwareWindowOptions>,
): TranscriptionWindowPlan {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0
  const requested = { ...DEFAULT_SPEECH_AWARE_WINDOW_OPTIONS, ...options }
  const windowSeconds = clampFinite(
    requested.maxModelInputSeconds,
    MIN_WHISPER_WINDOW_SECONDS,
    MAX_WHISPER_WINDOW_SECONDS,
    MAX_WHISPER_WINDOW_SECONDS,
  )
  const overlapSeconds = clampFinite(requested.overlapSeconds, 0, windowSeconds / 4, SPEECH_AWARE_OVERLAP_SECONDS)
  const targetWindowSeconds = clampFinite(
    requested.targetChunkSeconds,
    MIN_WHISPER_WINDOW_SECONDS,
    windowSeconds,
    TARGET_SPEECH_WINDOW_SECONDS,
  )
  const coreSeconds = Math.max(0.1, targetWindowSeconds - overlapSeconds * 2)
  const regions = sanitizeRegions(speechRegions, duration)
  const ownershipSpans = splitLongRegions(regions, coreSeconds)
  const groupedSpans: Array<{ startTime: number; endTime: number }> = []

  for (const span of ownershipSpans) {
    const current = groupedSpans.at(-1)
    if (current && span.endTime - current.startTime <= coreSeconds) {
      current.endTime = span.endTime
    } else {
      groupedSpans.push({ ...span })
    }
  }

  const hardMinWindowSeconds = clampFinite(
    requested.hardMinWindowSeconds,
    0.1,
    windowSeconds,
    MIN_WHISPER_WINDOW_SECONDS,
  )
  const windows = groupedSpans.map((span) => {
    let sliceStartTime = Math.max(0, span.startTime - overlapSeconds)
    let sliceEndTime = Math.min(duration, span.endTime + overlapSeconds)
    const missingForMinimum = hardMinWindowSeconds - (sliceEndTime - sliceStartTime)
    if (missingForMinimum > 0) {
      const extendBefore = Math.min(sliceStartTime, missingForMinimum / 2)
      sliceStartTime -= extendBefore
      sliceEndTime = Math.min(duration, sliceEndTime + missingForMinimum - extendBefore)
      sliceStartTime = Math.max(0, sliceEndTime - hardMinWindowSeconds)
    }
    if (sliceEndTime - sliceStartTime > windowSeconds) {
      sliceEndTime = sliceStartTime + windowSeconds
    }

    return {
      sliceStartTime,
      sliceEndTime,
      coreStartTime: span.startTime,
      coreEndTime: span.endTime,
    }
  })

  return { windowSeconds, coreSeconds, overlapSeconds, windows }
}

function sanitizeRegions(regions: SpeechRegion[], duration: number): Array<{ startTime: number; endTime: number }> {
  const sanitized: Array<{ startTime: number; endTime: number }> = []
  for (const region of [...regions].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)) {
    const startTime = Math.min(duration, Math.max(0, region.startTime))
    const endTime = Math.min(duration, Math.max(0, region.endTime))
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      continue
    }
    const previous = sanitized.at(-1)
    if (previous && startTime <= previous.endTime) {
      previous.endTime = Math.max(previous.endTime, endTime)
    } else {
      sanitized.push({ startTime, endTime })
    }
  }
  return sanitized
}

function splitLongRegions(
  regions: Array<{ startTime: number; endTime: number }>,
  coreSeconds: number,
): Array<{ startTime: number; endTime: number }> {
  const spans: Array<{ startTime: number; endTime: number }> = []
  for (const region of regions) {
    let startTime = region.startTime
    while (startTime < region.endTime) {
      const endTime = Math.min(region.endTime, startTime + coreSeconds)
      spans.push({ startTime, endTime })
      startTime = endTime
    }
  }
  return spans
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, value))
}
