import type { RawTranscriptionSegment } from '../subtitles/formatting'

type TextRepetition = {
  phrase: string
  tokenSize: number
  occurrences: number
  coverageRatio: number
}

type TextSummary = {
  length: number
  tokenCount: number
  uniqueTokenRatio: number
  preview: string
  repetition?: TextRepetition
}

export function summarizeAsrResult(result: unknown): {
  text?: TextSummary
  chunkCount: number
  chunks?: Array<{ timestamp?: unknown; text?: string; textLength?: number }>
  omittedChunks?: number
} {
  const normalized = Array.isArray(result) ? result[0] : result
  if (!isRecord(normalized)) {
    return { chunkCount: 0 }
  }
  const text = typeof normalized.text === 'string' ? summarizeText(normalized.text) : undefined
  const chunks = Array.isArray(normalized.chunks) ? normalized.chunks : []
  const keptChunks = chunks.slice(0, 100).flatMap((chunk) => {
    if (!isRecord(chunk)) {
      return []
    }
    const chunkText = typeof chunk.text === 'string' ? chunk.text : undefined
    return [
      {
        timestamp: chunk.timestamp,
        text: chunkText === undefined ? undefined : sampleText(chunkText, 2_000),
        textLength: chunkText?.length,
      },
    ]
  })
  return {
    text,
    chunkCount: chunks.length,
    chunks: keptChunks.length ? keptChunks : undefined,
    omittedChunks: chunks.length > keptChunks.length ? chunks.length - keptChunks.length : undefined,
  }
}

export function summarizeSegments(segments: RawTranscriptionSegment[]): {
  count: number
  segments: Array<{
    startTime: number
    endTime: number
    confidence?: number
    wordCount: number
    text: TextSummary
  }>
  omittedSegments?: number
} {
  const kept = segments.slice(0, 200).map((segment) => ({
    startTime: segment.startTime,
    endTime: segment.endTime,
    confidence: segment.confidence,
    wordCount: segment.words?.length ?? 0,
    text: summarizeText(segment.text, 2_000),
  }))
  return {
    count: segments.length,
    segments: kept,
    omittedSegments: segments.length > kept.length ? segments.length - kept.length : undefined,
  }
}

export function summarizeText(text: string, previewLength = 8_000): TextSummary {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const tokens = normalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return {
    length: text.length,
    tokenCount: tokens.length,
    uniqueTokenRatio: tokens.length ? round(new Set(tokens).size / tokens.length) : 0,
    preview: sampleText(normalized, previewLength),
    repetition: findDominantRepetition(tokens.slice(0, 5_000)),
  }
}

function findDominantRepetition(tokens: string[]): TextRepetition | undefined {
  let best: TextRepetition | undefined
  for (let tokenSize = 2; tokenSize <= Math.min(8, Math.floor(tokens.length / 3)); tokenSize += 1) {
    const counts = new Map<string, number>()
    for (let index = 0; index <= tokens.length - tokenSize; index += 1) {
      const phrase = tokens.slice(index, index + tokenSize).join(' ')
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
    }
    for (const [phrase, occurrences] of counts) {
      if (occurrences < 3) {
        continue
      }
      const coverageRatio = Math.min(1, (occurrences * tokenSize) / tokens.length)
      const candidate = { phrase, tokenSize, occurrences, coverageRatio: round(coverageRatio) }
      if (!best || candidate.coverageRatio > best.coverageRatio || (candidate.coverageRatio === best.coverageRatio && tokenSize > best.tokenSize)) {
        best = candidate
      }
    }
  }
  return best && best.coverageRatio >= 0.3 ? best : undefined
}

function sampleText(text: string, maximumLength: number): string {
  if (text.length <= maximumLength) {
    return text
  }
  const headLength = Math.ceil(maximumLength * 0.75)
  const tailLength = maximumLength - headLength
  return `${text.slice(0, headLength)}\n… [${text.length - maximumLength} characters omitted] …\n${text.slice(-tailLength)}`
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
