import type { FormattingPreferences } from '../types/subtitles'
import type { RawTranscriptionSegment } from '../subtitles/formatting'
import type { DiagnosticEventInput } from '../diagnostics/types'
import { BASE_MODEL_ID, resolveCompatibleModelId, type SpeechModelId } from './models'
import { DEFAULT_REGENERATION_ALTERNATIVES } from './regenerationLimits'

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

export type RegenerationPreferences = Pick<
  TranscriptionSettings,
  'language' | 'task' | 'modelId' | 'executionProvider' | 'dtype'
> & {
  useWordTimestamps: boolean
  alternativeCount: number
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  language: 'english',
  task: 'transcribe',
  modelId: BASE_MODEL_ID,
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
  const requestedExecutionProvider = isExecutionProvider(record.executionProvider)
    ? record.executionProvider
    : fallback.executionProvider
  const usedLegacyCpuFallback = requestedExecutionProvider === 'cpu'
  const settings: TranscriptionSettings = {
    language: typeof record.language === 'string' ? record.language : fallback.language,
    task: record.task === 'translate' || record.task === 'transcribe' ? record.task : fallback.task,
    modelId: typeof record.modelId === 'string' ? record.modelId : fallback.modelId,
    // ONNX Runtime Web exposes its CPU execution path as WASM. Older saved
    // projects may still contain the legacy `cpu` value, so keep accepting it
    // above and resolve it to the supported browser device here.
    executionProvider: usedLegacyCpuFallback ? 'wasm' : requestedExecutionProvider,
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
  const reasons = [
    usedLegacyCpuFallback
      ? 'The legacy CPU engine setting now uses the browser WASM engine.'
      : undefined,
    resolved.reason,
  ].filter((reason): reason is string => Boolean(reason))

  return {
    settings: { ...settings, modelId: resolved.modelId },
    changed: usedLegacyCpuFallback || resolved.changed,
    reason: reasons.length ? reasons.join(' ') : undefined,
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
  jobId: string
  file: File
  settings: TranscriptionSettings
}

export type WorkerRegenerateRequest = {
  type: 'regenerate'
  jobId: string
  file: File
  settings: TranscriptionSettings
  range: RegenerationRange
  alternativeCount: number
  videoDuration?: number
}

export type WorkerCancelRequest = {
  type: 'cancel'
  jobId: string
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

export type WorkerPartialDelta = {
  replaceFromIndex: number
  totalSegments: number
  segments: RawTranscriptionSegment[]
  modelId: string
}

export type WorkerPartialEvent = {
  type: 'partial'
  delta: WorkerPartialDelta
}

export type WorkerErrorEvent = {
  type: 'error'
  error: {
    message: string
    details?: string
  }
}

export function createRegenerationPreferences(settings: TranscriptionSettings): RegenerationPreferences {
  return {
    language: settings.language,
    task: settings.task,
    modelId: settings.modelId,
    executionProvider: settings.executionProvider,
    dtype: settings.dtype,
    useWordTimestamps: settings.formatting.useWordTimestamps,
    alternativeCount: DEFAULT_REGENERATION_ALTERNATIVES,
  }
}

export function buildRegenerationSettings(
  settings: TranscriptionSettings,
  preferences: RegenerationPreferences,
): TranscriptionSettings {
  return {
    ...settings,
    language: preferences.language,
    task: preferences.task,
    modelId: preferences.modelId,
    executionProvider: preferences.executionProvider,
    dtype: preferences.dtype,
    formatting: {
      ...settings.formatting,
      useWordTimestamps: preferences.useWordTimestamps,
    },
  }
}

export type WorkerDiagnosticEvent = {
  type: 'diagnostic'
  event: DiagnosticEventInput
}

export type WorkerEventPayload =
  | WorkerProgressEvent
  | WorkerPartialEvent
  | WorkerCompleteEvent
  | WorkerRegenerationCompleteEvent
  | WorkerDiagnosticEvent
  | WorkerErrorEvent

export type WorkerEvent = WorkerEventPayload & {
  jobId: string
}

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
