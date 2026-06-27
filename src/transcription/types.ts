import type { FormattingPreferences } from '../types/subtitles'
import type { RawTranscriptionSegment } from '../subtitles/formatting'
import { resolveCompatibleModelId, TINY_MODEL_ID, type SpeechModelId } from './models'

export type TranscriptionStage =
  | 'idle'
  | 'loading-engine'
  | 'downloading-model'
  | 'preparing-video'
  | 'extracting-audio'
  | 'transcribing'
  | 'formatting-subtitles'
  | 'complete'
  | 'cancelled'
  | 'failed'

export type ExecutionProvider = 'auto' | 'webgpu' | 'wasm' | 'cpu'

export type TranscriptionSettings = {
  language: string
  task: 'transcribe' | 'translate'
  modelId: SpeechModelId | string
  executionProvider: ExecutionProvider
  chunkLengthSeconds: number
  strideLengthSeconds: number
  dtype: 'auto' | 'q8' | 'fp32'
  formatting: FormattingPreferences
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  language: 'auto',
  task: 'transcribe',
  modelId: TINY_MODEL_ID,
  executionProvider: 'auto',
  chunkLengthSeconds: 30,
  strideLengthSeconds: 5,
  dtype: 'auto',
  formatting: {
    maxCharsPerLine: 42,
    maxCharsPerSubtitle: 84,
    minDuration: 1.1,
    maxDuration: 6,
    gapBetweenSubtitles: 0.04,
    useWordTimestamps: false,
  },
}

export function normalizeTranscriptionSettings(
  value: unknown,
  fallback: TranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS,
): { settings: TranscriptionSettings; changed: boolean; reason?: string } {
  const record = isRecord(value) ? value : {}
  const settings: TranscriptionSettings = {
    language: typeof record.language === 'string' ? record.language : fallback.language,
    task: record.task === 'translate' || record.task === 'transcribe' ? record.task : fallback.task,
    modelId: typeof record.modelId === 'string' ? record.modelId : fallback.modelId,
    executionProvider: isExecutionProvider(record.executionProvider)
      ? record.executionProvider
      : fallback.executionProvider,
    chunkLengthSeconds: finiteNumberOrDefault(record.chunkLengthSeconds, fallback.chunkLengthSeconds),
    strideLengthSeconds: finiteNumberOrDefault(record.strideLengthSeconds, fallback.strideLengthSeconds),
    dtype: record.dtype === 'q8' || record.dtype === 'fp32' || record.dtype === 'auto' ? record.dtype : fallback.dtype,
    formatting: normalizeStoredFormatting(record.formatting, fallback.formatting),
  }
  const resolved = resolveCompatibleModelId(settings)

  return {
    settings: { ...settings, modelId: resolved.modelId },
    changed: resolved.changed,
    reason: resolved.reason,
  }
}

export type TranscriptionProgress = {
  stage: TranscriptionStage
  message: string
  progress?: number
  technicalDetails?: string
}

export type TranscriptionResult = {
  segments: RawTranscriptionSegment[]
  text: string
  modelId: string
}

export type RegenerationRange = {
  startTime: number
  endTime: number
}

export type RegenerationCandidate = {
  id: string
  segments: RawTranscriptionSegment[]
  text: string
}

export type RegenerationResult = {
  range: RegenerationRange
  candidates: RegenerationCandidate[]
  modelId: string
}

export type WorkerStartRequest = {
  type: 'start'
  file: File
  settings: TranscriptionSettings
}

export type WorkerRegenerateRequest = {
  type: 'regenerate'
  file: File
  settings: TranscriptionSettings
  range: RegenerationRange
  videoDuration?: number
}

export type WorkerCancelRequest = {
  type: 'cancel'
}

export type WorkerRequest = WorkerStartRequest | WorkerRegenerateRequest | WorkerCancelRequest

export type WorkerProgressEvent = {
  type: 'progress'
  progress: TranscriptionProgress
}

export type WorkerCompleteEvent = {
  type: 'complete'
  result: TranscriptionResult
}

export type WorkerRegenerationCompleteEvent = {
  type: 'regeneration-complete'
  result: RegenerationResult
}

export type WorkerPartialEvent = {
  type: 'partial'
  result: TranscriptionResult
}

export type WorkerErrorEvent = {
  type: 'error'
  error: {
    message: string
    details?: string
  }
}

export type WorkerEvent =
  | WorkerProgressEvent
  | WorkerPartialEvent
  | WorkerCompleteEvent
  | WorkerRegenerationCompleteEvent
  | WorkerErrorEvent

function normalizeStoredFormatting(value: unknown, fallback: FormattingPreferences): FormattingPreferences {
  if (!isRecord(value)) {
    return fallback
  }

  return {
    maxCharsPerLine: finiteNumberOrDefault(value.maxCharsPerLine, fallback.maxCharsPerLine),
    maxCharsPerSubtitle: finiteNumberOrDefault(value.maxCharsPerSubtitle, fallback.maxCharsPerSubtitle),
    minDuration: finiteNumberOrDefault(value.minDuration, fallback.minDuration),
    maxDuration: finiteNumberOrDefault(value.maxDuration, fallback.maxDuration),
    gapBetweenSubtitles: finiteNumberOrDefault(value.gapBetweenSubtitles, fallback.gapBetweenSubtitles),
    useWordTimestamps:
      typeof value.useWordTimestamps === 'boolean' ? value.useWordTimestamps : fallback.useWordTimestamps,
  }
}

function isExecutionProvider(value: unknown): value is ExecutionProvider {
  return value === 'auto' || value === 'webgpu' || value === 'wasm' || value === 'cpu'
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
