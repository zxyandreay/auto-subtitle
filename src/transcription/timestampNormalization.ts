import type { RawTranscriptionSegment } from '../subtitles/formatting'
import type { SpeechRegion } from './speechActivity'

const MINIMUM_SEGMENT_SUFFIX_ACROSS_CORE_SECONDS = 0.5

/** Transformers.js uses `true` for segment timestamps and `'word'` for words. */
export type AsrTimestampMode = 'word' | 'segment' | true

export type AsrTimelineOptions = {
  /** The mode actually used by the successful ASR request, after any fallback. */
  timestampMode?: AsrTimestampMode
  offsetSeconds?: number
  coreStartTime?: number
  coreEndTime?: number
  /** Full transcription only: keep a substantial segment suffix for boundary reconciliation. */
  retainCrossingSegmentSuffix?: boolean
  fallbackStartTime?: number
  fallbackEndTime?: number
  speechRegions?: SpeechRegion[]
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

  if (options?.timestampMode !== 'word') {
    return normalized
  }

  const words = [...normalized]
    .sort((first, second) => first.startTime - second.startTime || first.endTime - second.endTime)
    .map((chunk) => ({
      text: chunk.text.trim(),
      startTime: chunk.startTime,
      endTime: chunk.endTime,
    }))
    .filter((word) => word.text && word.endTime > word.startTime)
  if (!words.length) {
    return []
  }

  return [
    {
      startTime: words[0].startTime,
      endTime: words.at(-1)!.endTime,
      text: joinTimestampedWords(words.map((word) => word.text)),
      words,
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

  let ownedStart = absoluteStart
  if (options?.coreStartTime !== undefined && absoluteStart < options.coreStartTime) {
    const suffixDuration = absoluteEnd - options.coreStartTime
    if (
      options.timestampMode === 'word' ||
      !options.retainCrossingSegmentSuffix ||
      suffixDuration + 0.001 < MINIMUM_SEGMENT_SUFFIX_ACROSS_CORE_SECONDS
    ) {
      return null
    }
    // Segment-only Whisper output can group context from before the ownership
    // boundary with several unique sentences after it. Retain a substantial
    // crossing suffix and let bounded text reconciliation remove any repeated
    // prefix; onset-only ownership would silently discard the unique speech.
    ownedStart = options.coreStartTime
  }
  if (options?.coreEndTime !== undefined && absoluteStart >= options.coreEndTime) {
    return null
  }

  const startTime = roundSeconds(Math.max(0, ownedStart))
  const endTime = roundSeconds(Math.max(0, absoluteEnd))
  if (endTime <= startTime) {
    return null
  }

  return {
    ...chunk,
    startTime,
    endTime,
    boundaryContextPrefix: ownedStart > absoluteStart ? true : chunk.boundaryContextPrefix,
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
  if (!/[\p{L}\p{N}]/u.test(text) || !options?.speechRegions?.length) {
    return []
  }

  const rangeStart = options.fallbackStartTime ?? options.coreStartTime ?? options.offsetSeconds ?? 0
  const rangeEnd = options.fallbackEndTime ?? options.coreEndTime ?? Number.POSITIVE_INFINITY
  const evidence = mergeEvidenceRanges(
    options.speechRegions
    .map((region) => ({
      startTime: Math.max(0, rangeStart, region.rawStartTime ?? region.startTime),
      endTime: Math.min(rangeEnd, region.rawEndTime ?? region.endTime),
    }))
    .filter((region) => region.endTime - region.startTime >= 0.5)
    .sort((first, second) => first.startTime - second.startTime || first.endTime - second.endTime),
  )
  // Text without timestamp chunks cannot be safely distributed across disjoint
  // speech islands. Suppress it and let the bounded repair path retry smaller spans.
  if (evidence.length !== 1) {
    return []
  }

  const startTime = evidence[0].startTime
  const endTime = Math.min(rangeEnd, evidence[0].endTime, startTime + 8)
  if (endTime <= startTime) {
    return []
  }
  return [
    {
      startTime: roundSeconds(startTime),
      endTime: roundSeconds(endTime),
      text,
      confidence: 0.35,
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

function mergeEvidenceRanges(
  ranges: Array<{ startTime: number; endTime: number }>,
): Array<{ startTime: number; endTime: number }> {
  const merged: Array<{ startTime: number; endTime: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.startTime <= previous.endTime) {
      previous.endTime = Math.max(previous.endTime, range.endTime)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function joinTimestampedWords(words: string[]): string {
  let result = ''
  for (const word of words) {
    const token = word.trim()
    if (!token) {
      continue
    }
    if (
      !result ||
      /^[,.;:!?%\])}\u3001\u3002\uff0c\uff01\uff1f]/u.test(token) ||
      /[([{\u2018\u201c]$/u.test(result) ||
      (containsCjk(token[0] ?? '') &&
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u2026\u2014\u2019\u201d\uff09\u3011\u300b\u300d\u300f]*$/u.test(result))
    ) {
      result += token
    } else {
      result += ` ${token}`
    }
  }
  return result.trim()
}

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
