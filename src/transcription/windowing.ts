export const MAX_WHISPER_WINDOW_SECONDS = 30
export const MIN_WHISPER_WINDOW_SECONDS = 5

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

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, value))
}
