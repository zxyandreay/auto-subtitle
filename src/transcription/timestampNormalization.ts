import type { RawTranscriptionSegment } from '../subtitles/formatting'

export type AsrTimelineOptions = {
  offsetSeconds?: number
  coreStartTime?: number
  coreEndTime?: number
}

export type NormalizedAsrResult = {
  segments: RawTranscriptionSegment[]
  text: string
}

export function normalizeAsrResult(result: unknown, options: AsrTimelineOptions): NormalizedAsrResult {
  const normalizedResult = Array.isArray(result) ? result[0] : result
  const chunks = isRecord(normalizedResult) ? normalizedResult.chunks : undefined
  const text = isRecord(normalizedResult) && typeof normalizedResult.text === 'string' ? normalizedResult.text.trim() : ''

  return {
    segments: normalizeAsrChunks(chunks, text, options),
    text,
  }
}

export function normalizeAsrChunks(
  chunks: unknown,
  fallbackText: string,
  options?: AsrTimelineOptions,
): RawTranscriptionSegment[] {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return createFallbackSegment(fallbackText, options)
  }

  const parsed = chunks
    .map((chunk) => normalizeChunk(chunk))
    .filter((chunk): chunk is RawTranscriptionSegment => chunk !== null)

  if (parsed.length === 0) {
    return createFallbackSegment(fallbackText, options)
  }

  const normalized = parsed
    .map((chunk) => placeChunkOnTimeline(chunk, options))
    .filter((chunk): chunk is RawTranscriptionSegment => chunk !== null)

  // Valid timestamped chunks outside this core belong to an adjacent window.
  // Reusing the whole-window fallback text here would place overlap speech late.
  if (normalized.length === 0) {
    return []
  }

  const looksWordLevel = normalized.length > 3 && normalized.every((chunk) => chunk.text.split(/\s+/).length <= 2)
  if (!looksWordLevel) {
    return normalized
  }

  return [
    {
      startTime: normalized[0].startTime,
      endTime: normalized.at(-1)!.endTime,
      text: normalized.map((chunk) => chunk.text).join(' '),
      words: normalized.map((chunk) => ({
        text: chunk.text.trim(),
        startTime: chunk.startTime,
        endTime: chunk.endTime,
      })),
    },
  ]
}

export function placeChunkOnTimeline(
  chunk: RawTranscriptionSegment,
  options?: AsrTimelineOptions,
): RawTranscriptionSegment | null {
  const offset = options?.offsetSeconds ?? 0
  const absoluteStart = chunk.startTime + offset
  const absoluteEnd = chunk.endTime + offset
  if (!Number.isFinite(absoluteStart) || !Number.isFinite(absoluteEnd) || absoluteEnd <= absoluteStart) {
    return null
  }

  if (options?.coreStartTime !== undefined && absoluteStart < options.coreStartTime) {
    return null
  }
  if (options?.coreEndTime !== undefined && absoluteStart >= options.coreEndTime) {
    return null
  }

  const startTime = roundSeconds(Math.max(0, absoluteStart))
  const endTime = roundSeconds(Math.max(0, absoluteEnd))
  if (endTime <= startTime) {
    return null
  }

  return {
    ...chunk,
    startTime,
    endTime,
    words: chunk.words?.map((word) => ({
      ...word,
      startTime: roundSeconds(Math.max(0, word.startTime + offset)),
      endTime: roundSeconds(Math.max(0, word.endTime + offset)),
    })),
  }
}

function createFallbackSegment(
  fallbackText: string,
  options?: AsrTimelineOptions,
): RawTranscriptionSegment[] {
  const text = fallbackText.trim()
  if (!text || options?.coreStartTime !== undefined || options?.coreEndTime !== undefined) {
    return []
  }

  const startTime = 0
  const endTime = Math.max(1, text.length / 14)
  return [
    {
      startTime: roundSeconds(startTime),
      endTime: roundSeconds(endTime),
      text,
    },
  ]
}

function normalizeChunk(chunk: unknown): RawTranscriptionSegment | null {
  if (typeof chunk !== 'object' || chunk === null) {
    return null
  }

  const record = chunk as { timestamp?: unknown; text?: unknown }
  if (!Array.isArray(record.timestamp) || typeof record.text !== 'string') {
    return null
  }

  const startTime = record.timestamp[0]
  const endTime = record.timestamp[1]
  const text = record.text.trim()
  if (
    !text ||
    typeof startTime !== 'number' ||
    typeof endTime !== 'number' ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime <= startTime
  ) {
    return null
  }

  return { startTime, endTime, text }
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
