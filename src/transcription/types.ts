import type { FormattingPreferences } from '../types/subtitles'
import type { RawTranscriptionSegment } from '../subtitles/formatting'
import { resolveCompatibleModelId, TINY_MODEL_ID, type SpeechModelId } from './models'

export type TranscriptionStage =
  | 'idle'
  | 'loading-engine'
  | 'downloading-model'
  | 'preparing-video'
  | 'extracting-audio'
  | 'analyzing-speech'
  | 'planning-windows'
  | 'transcribing'
  | 'checking-coverage'
  | 'repairing-coverage'
  | 'refining-timing'
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
  maxModelInputSeconds: number
  targetChunkSeconds: number
  speechAwareOverlapSeconds: number
  fallbackOverlapSeconds: number
  hardMinWindowSeconds: number
  vadEnabled: boolean
  vadFrameMs: number
  vadHopMs: number
  vadMinSpeechMs: number
  vadMergeGapMs: number
  vadPrePaddingMs: number
  vadPostPaddingMs: number
  vadNoiseFloorMultiplier: number
  vadMinimumRmsFloor: number
  repairEnabled: boolean
  repairContextSeconds: number
  maxRepairRanges: number
  formatting: FormattingPreferences
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  language: 'auto',
  task: 'transcribe',
  modelId: TINY_MODEL_ID,
  executionProvider: 'auto',
  chunkLengthSeconds: 29,
  strideLengthSeconds: 4,
  dtype: 'q8',
  maxModelInputSeconds: 29,
  targetChunkSeconds: 26,
  speechAwareOverlapSeconds: 1.5,
  fallbackOverlapSeconds: 4,
  hardMinWindowSeconds: 5,
  vadEnabled: true,
  vadFrameMs: 30,
  vadHopMs: 10,
  vadMinSpeechMs: 250,
  vadMergeGapMs: 350,
  vadPrePaddingMs: 200,
  vadPostPaddingMs: 300,
  vadNoiseFloorMultiplier: 2.5,
  vadMinimumRmsFloor: 0.003,
  repairEnabled: true,
  repairContextSeconds: 0.75,
  maxRepairRanges: 20,
  formatting: {
    maxCharsPerLine: 42,
    maxCharsPerSubtitle: 84,
    minDuration: 1.1,
    maxDuration: 6,
    gapBetweenSubtitles: 0.08,
    useWordTimestamps: true,
    subtitleLeadIn: 0.08,
    subtitleTailPadding: 0.18,
    targetMaxCps: 20,
    hardMaxCps: 21,
    closeGapsBelow: 0.5,
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
    chunkLengthSeconds: clampNumber(record.chunkLengthSeconds, 5, 29, fallback.chunkLengthSeconds),
    strideLengthSeconds: finiteNumberOrDefault(record.strideLengthSeconds, fallback.strideLengthSeconds),
    dtype: record.dtype === 'q8' || record.dtype === 'fp32' || record.dtype === 'auto' ? record.dtype : fallback.dtype,
    maxModelInputSeconds: clampNumber(record.maxModelInputSeconds, 5, 29, fallback.maxModelInputSeconds),
    targetChunkSeconds: clampNumber(record.targetChunkSeconds, 5, 29, fallback.targetChunkSeconds),
    speechAwareOverlapSeconds: finiteNumberOrDefault(
      record.speechAwareOverlapSeconds,
      fallback.speechAwareOverlapSeconds,
    ),
    fallbackOverlapSeconds: finiteNumberOrDefault(record.fallbackOverlapSeconds, fallback.fallbackOverlapSeconds),
    hardMinWindowSeconds: finiteNumberOrDefault(record.hardMinWindowSeconds, fallback.hardMinWindowSeconds),
    vadEnabled: booleanOrDefault(record.vadEnabled, fallback.vadEnabled),
    vadFrameMs: finiteNumberOrDefault(record.vadFrameMs, fallback.vadFrameMs),
    vadHopMs: finiteNumberOrDefault(record.vadHopMs, fallback.vadHopMs),
    vadMinSpeechMs: finiteNumberOrDefault(record.vadMinSpeechMs, fallback.vadMinSpeechMs),
    vadMergeGapMs: finiteNumberOrDefault(record.vadMergeGapMs, fallback.vadMergeGapMs),
    vadPrePaddingMs: finiteNumberOrDefault(record.vadPrePaddingMs, fallback.vadPrePaddingMs),
    vadPostPaddingMs: finiteNumberOrDefault(record.vadPostPaddingMs, fallback.vadPostPaddingMs),
    vadNoiseFloorMultiplier: finiteNumberOrDefault(
      record.vadNoiseFloorMultiplier,
      fallback.vadNoiseFloorMultiplier,
    ),
    vadMinimumRmsFloor: finiteNumberOrDefault(record.vadMinimumRmsFloor, fallback.vadMinimumRmsFloor),
    repairEnabled: booleanOrDefault(record.repairEnabled, fallback.repairEnabled),
    repairContextSeconds: finiteNumberOrDefault(record.repairContextSeconds, fallback.repairContextSeconds),
    maxRepairRanges: finiteNumberOrDefault(record.maxRepairRanges, fallback.maxRepairRanges),
    formatting: normalizeFormattingPreferences(record.formatting, fallback.formatting),
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

export function normalizeFormattingPreferences(
  value: unknown,
  fallback: FormattingPreferences,
): FormattingPreferences {
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
    subtitleLeadIn: finiteNumberOrDefault(value.subtitleLeadIn, fallback.subtitleLeadIn),
    subtitleTailPadding: finiteNumberOrDefault(value.subtitleTailPadding, fallback.subtitleTailPadding),
    targetMaxCps: finiteNumberOrDefault(value.targetMaxCps, fallback.targetMaxCps),
    hardMaxCps: finiteNumberOrDefault(value.hardMaxCps, fallback.hardMaxCps),
    closeGapsBelow: finiteNumberOrDefault(value.closeGapsBelow, fallback.closeGapsBelow),
  }
}

function isExecutionProvider(value: unknown): value is ExecutionProvider {
  return value === 'auto' || value === 'webgpu' || value === 'wasm' || value === 'cpu'
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Math.min(maximum, Math.max(minimum, finiteNumberOrDefault(value, fallback)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
