import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import coreUrl from '@ffmpeg/core?url'
import wasmUrl from '@ffmpeg/core/wasm?url'
import { summarizeAsrResult, summarizeSegments } from '../diagnostics/asrDiagnostics'
import type { DiagnosticLevel } from '../diagnostics/types'
import type { RawTranscriptionSegment } from '../subtitles/formatting'
import { constrainSegmentsToRange } from '../subtitles/regeneration'
import { buildAudioExtractionArgs, type AudioExtractionRange } from '../transcription/audioExtraction'
import { findUncoveredSpeechRanges } from '../transcription/coverage'
import { reconcileBoundarySegments } from '../transcription/reconciliation'
import { createRepairWindowPlans, selectRepairSegments } from '../transcription/repair'
import {
  DISTIL_LARGE_V3_MODEL_ID,
  getSpeechModelOption,
  resolveSpeechModelRuntimeSettings,
  type SpeechModelOption,
} from '../transcription/models'
import {
  dedupeRegenerationCandidates,
  planRegenerationAudioRange,
  REGENERATION_DECODING_PROFILES,
  validateRegenerationRange,
  type RegenerationDecodingProfile,
} from '../transcription/regeneration'
import { normalizeRegenerationAlternativeCount } from '../transcription/regenerationLimits'
import { normalizeAsrResult, type NormalizedAsrResult } from '../transcription/timestampNormalization'
import { isWordTimestampUnsupportedError } from '../transcription/timestampSupport'
import { safelyDetectSpeechRegions, type SpeechRegion } from '../transcription/speechActivity'
import { refineSegmentsToSpeechBoundaries } from '../transcription/timingRefinement'
import { normalizeTranscriptionSettings } from '../transcription/types'
import type {
  RegenerationCandidate,
  RegenerationRange,
  TranscriptionSettings,
  TranscriptionStage,
  WorkerEvent,
  WorkerRequest,
} from '../transcription/types'
import {
  createSpeechAwareTranscriptionWindowPlan,
  createTranscriptionWindowPlan,
} from '../transcription/windowing'

let cancelled = false

type TimestampMode = true | 'word'

type AsrCallOptions = {
  return_timestamps: TimestampMode
  chunk_length_s: number
  stride_length_s: number
  language?: string
  task: TranscriptionSettings['task']
  do_sample?: boolean
  temperature?: number
  top_k?: number
}

type BrowserAsrTranscriber = {
  (audio: Float32Array, options: AsrCallOptions): Promise<unknown>
  dispose?: () => Promise<void> | void
}

type PipelineDtype =
  | 'q8'
  | 'fp32'
  | {
      encoder_model: 'q8' | 'fp32'
      decoder_model_merged: 'q8' | 'fp32'
    }

type PipelineDtypeResolution = {
  value?: PipelineDtype
  label: string
}

type DecodedAudio = {
  samples: Float32Array
  sampleRate: number
}

type TranscriptionWindow = {
  index: number
  total: number
  samples: Float32Array
  sliceStartTime: number
  coreStartTime: number
  coreEndTime: number
}

type TimestampAttempt = {
  result: unknown
  timestampMode: TimestampMode
}

type TerminalLogEvent =
  | {
      type: 'start'
      fileName: string
      modelId: string
      jobKind: 'transcription' | 'regeneration'
      startTime?: number
      endTime?: number
    }
  | {
      type: 'progress'
      stage: TranscriptionStage
      message: string
      progress?: number
    }
  | {
      type: 'caption'
      startTime: number
      endTime: number
      text: string
    }
  | {
      type: 'complete'
      segmentCount: number
      jobKind: 'transcription' | 'regeneration'
      candidateCount?: number
    }
  | {
      type: 'error'
      message: string
    }

let terminalJobId = ''
let lastOverallProgress = 0

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data

  if (request.type === 'cancel') {
    cancelled = true
    postDiagnostic('job-cancelled', 'The worker received a cancellation request.', undefined, 'warning')
    return
  }

  cancelled = false
  terminalJobId = createJobId()
  lastOverallProgress = 0
  postDiagnostic('job-requested', 'A local transcription worker job was requested.', {
    jobKind: request.type === 'regenerate' ? 'regeneration' : 'transcription',
    file: { name: request.file.name, size: request.file.size, type: request.file.type },
    settings: request.settings,
    range: request.type === 'regenerate' ? request.range : undefined,
    videoDuration: request.type === 'regenerate' ? request.videoDuration : undefined,
    alternativeCount: request.type === 'regenerate' ? request.alternativeCount : undefined,
  })
  const task =
    request.type === 'regenerate'
      ? regenerate(
          request.file,
          normalizeTranscriptionSettings(request.settings).settings,
          request.range,
          request.alternativeCount,
          request.videoDuration,
        )
      : transcribe(request.file, normalizeTranscriptionSettings(request.settings).settings)

  task.catch((error: unknown) => {
    postDiagnostic('job-failed', 'The worker job failed.', { error: serializeError(error) }, 'error')
    postTerminalLog({
      type: 'error',
      message: error instanceof Error ? error.message : 'Transcription failed.',
    })

    if (cancelled) {
      post({
        type: 'error',
        error: { message: 'Transcription cancelled.' },
      })
      return
    }

    post({
      type: 'error',
      error: {
        message: error instanceof Error ? error.message : 'Transcription failed.',
        details: error instanceof Error ? error.stack : undefined,
      },
    })
  })
})

async function transcribe(file: File, settings: TranscriptionSettings): Promise<void> {
  const runtime = resolveSpeechModelRuntimeSettings(settings)
  const effectiveSettings = runtime.settings
  const model = getSpeechModelOption(effectiveSettings.modelId)
  postDiagnostic('runtime-settings', 'Resolved transcription model and runtime settings.', {
    requestedSettings: settings,
    effectiveSettings,
    resolutionReason: runtime.reason,
    model,
  })
  assertNotCancelled()
  postTerminalLog({
    type: 'start',
    fileName: file.name,
    modelId: effectiveSettings.modelId,
    jobKind: 'transcription',
  })
  postProgress('loading-engine', 'Loading FFmpeg.wasm and Transformers.js.')
  if (runtime.reason) {
    postProgress('loading-engine', runtime.reason, undefined, `Resolved model: ${effectiveSettings.modelId}`)
  }

  assertNotCancelled()
  postProgress('preparing-video', 'Preparing the selected video file.')
  const audio = await extractAudio(file)
  const audioRms = calculateRms(audio.samples)
  postDiagnostic('decoded-audio', 'Decoded mono PCM audio for transcription.', {
    sampleRate: audio.sampleRate,
    sampleCount: audio.samples.length,
    durationSeconds: audio.samples.length / audio.sampleRate,
    rms: audioRms,
  })

  if (audioRms < 0.0008) {
    throw new Error('The extracted audio appears to be empty or silent.')
  }

  assertNotCancelled()
  postProgress('analyzing-speech', 'Analyzing speech activity locally.')
  const speechRegions = analyzeSpeechActivity(audio, effectiveSettings)
  postDiagnostic('speech-activity', 'Completed local speech activity analysis.', {
    regionCount: speechRegions.length,
    regions: speechRegions,
    vadEnabled: effectiveSettings.vadEnabled,
  })

  assertNotCancelled()
  postProgress(
    'planning-windows',
    speechRegions.length ? 'Planning speech-aware transcription windows.' : 'Planning safe fallback windows.',
  )

  assertNotCancelled()
  postProgress(
    'downloading-model',
    `Loading ${model.shortLabel} from the browser cache or model repository.`,
    undefined,
    getModelTechnicalDetails(model, effectiveSettings),
  )

  const transcriber = await loadTranscriber(effectiveSettings)

  try {
    assertNotCancelled()
    postProgress('transcribing', 'Transcribing speech locally with Whisper.')
    const result = await transcribeInWindows(transcriber, audio, effectiveSettings, speechRegions)
    postDiagnostic('transcription-result', 'Completed the worker transcription pipeline.', {
      text: result.text,
      segments: summarizeSegments(result.segments),
    })

    assertNotCancelled()
    postProgress('formatting-subtitles', 'Converting model timestamps into editable subtitle segments.')
    postTerminalLog({
      type: 'complete',
      segmentCount: result.segments.length,
      jobKind: 'transcription',
    })

    post({
      type: 'complete',
      result: {
        segments: result.segments,
        text: result.text,
        modelId: effectiveSettings.modelId,
      },
    })
  } finally {
    if ('dispose' in transcriber && typeof transcriber.dispose === 'function') {
      await transcriber.dispose()
    }
  }
}

async function regenerate(
  file: File,
  settings: TranscriptionSettings,
  range: RegenerationRange,
  alternativeCount: number,
  videoDuration?: number,
): Promise<void> {
  const requestedAlternativeCount = normalizeRegenerationAlternativeCount(alternativeCount)
  const runtime = resolveSpeechModelRuntimeSettings(settings)
  const effectiveSettings = runtime.settings
  const model = getSpeechModelOption(effectiveSettings.modelId)
  postDiagnostic('runtime-settings', 'Resolved regeneration model and runtime settings.', {
    requestedSettings: settings,
    effectiveSettings,
    resolutionReason: runtime.reason,
    model,
    range,
    videoDuration,
    requestedAlternativeCount,
  })
  const validationError = validateRegenerationRange(range, videoDuration)
  if (validationError) {
    throw new Error(validationError)
  }

  assertNotCancelled()
  postTerminalLog({
    type: 'start',
    fileName: file.name,
    modelId: effectiveSettings.modelId,
    jobKind: 'regeneration',
    startTime: range.startTime,
    endTime: range.endTime,
  })
  postProgress('loading-engine', 'Loading local regeneration tools.')
  if (runtime.reason) {
    postProgress('loading-engine', runtime.reason, undefined, `Resolved model: ${effectiveSettings.modelId}`)
  }

  const extractionRange = planRegenerationAudioRange(range, videoDuration)
  postProgress('preparing-video', 'Preparing the selected subtitle range.')
  const audio = await extractAudio(file, {
    startTime: extractionRange.extractionStartTime,
    endTime: extractionRange.extractionEndTime,
  })
  const audioRms = calculateRms(audio.samples)
  postDiagnostic('decoded-audio', 'Decoded the selected regeneration audio range.', {
    extractionRange,
    sampleRate: audio.sampleRate,
    sampleCount: audio.samples.length,
    durationSeconds: audio.samples.length / audio.sampleRate,
    rms: audioRms,
  })

  if (audioRms < 0.0008) {
    postDiagnostic('silent-range', 'The regeneration range was below the audio RMS threshold.', {
      rms: audioRms,
      threshold: 0.0008,
    }, 'warning')
    postRegenerationComplete(range, [], effectiveSettings.modelId, requestedAlternativeCount)
    return
  }

  postProgress('analyzing-speech', 'Analyzing speech activity in the selected range.')
  const speechRegions = analyzeSpeechActivity(audio, effectiveSettings).map((region) => ({
    ...region,
    startTime: region.startTime + extractionRange.extractionStartTime,
    endTime: region.endTime + extractionRange.extractionStartTime,
  }))
  postDiagnostic('speech-activity', 'Completed speech analysis for the regeneration range.', {
    regionCount: speechRegions.length,
    regions: speechRegions,
  })

  assertNotCancelled()
  postProgress(
    'downloading-model',
    `Loading ${model.shortLabel} from the browser cache or model repository for local regeneration.`,
    undefined,
    getModelTechnicalDetails(model, effectiveSettings),
  )
  const transcriber = await loadTranscriber(effectiveSettings)

  try {
    const candidates: RegenerationCandidate[] = []
    let timestampMode: TimestampMode = effectiveSettings.formatting.useWordTimestamps ? 'word' : true

    for (const [profileIndex, profile] of REGENERATION_DECODING_PROFILES.entries()) {
      assertNotCancelled()
      postProgress(
        'transcribing',
        `Generating local alternative ${Math.min(candidates.length + 1, requestedAlternativeCount)} of ${requestedAlternativeCount}.`,
        profileIndex / REGENERATION_DECODING_PROFILES.length,
      )

      const requestedTimestampMode = timestampMode
      const asrStartedAt = performance.now()
      const attempt = await transcribeWindowWithTimestampFallback(
        transcriber,
        audio.samples,
        effectiveSettings,
        timestampMode,
        profile,
      )
      timestampMode = attempt.timestampMode
      const normalized = normalizeAsrResult(attempt.result, {
        offsetSeconds: extractionRange.extractionStartTime,
        coreStartTime: range.startTime,
        coreEndTime: range.endTime,
        speechRegions,
      })
      const segments = constrainSegmentsToRange(
        refineSegmentsToSpeechBoundaries(normalized.segments, speechRegions, {
          leadInSeconds: effectiveSettings.formatting.subtitleLeadIn,
          tailPaddingSeconds: effectiveSettings.formatting.subtitleTailPadding,
          minimumGapSeconds: effectiveSettings.formatting.gapBetweenSubtitles,
        }),
        range,
      )
      const text = segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim()
      postDiagnostic('regeneration-asr-result', 'Captured a regeneration decoding result.', {
        profile,
        requestedTimestampMode,
        actualTimestampMode: attempt.timestampMode,
        durationMs: Math.round(performance.now() - asrStartedAt),
        rawResult: summarizeAsrResult(attempt.result),
        normalizedSegments: summarizeSegments(normalized.segments),
        constrainedSegments: summarizeSegments(segments),
      })

      if (text) {
        candidates.push({ id: profile.id, segments, text })
      }

      const uniqueCandidates = dedupeRegenerationCandidates(candidates, requestedAlternativeCount)
      candidates.splice(0, candidates.length, ...uniqueCandidates)
      postProgress(
        'transcribing',
        `Completed regeneration pass ${profileIndex + 1} of ${REGENERATION_DECODING_PROFILES.length}.`,
        (profileIndex + 1) / REGENERATION_DECODING_PROFILES.length,
      )

      if (candidates.length >= requestedAlternativeCount) {
        break
      }
    }

    assertNotCancelled()
    postRegenerationComplete(range, candidates, effectiveSettings.modelId, requestedAlternativeCount)
  } finally {
    if ('dispose' in transcriber && typeof transcriber.dispose === 'function') {
      await transcriber.dispose()
    }
  }
}

async function loadTranscriber(settings: TranscriptionSettings): Promise<BrowserAsrTranscriber> {
  const runtime = resolveSpeechModelRuntimeSettings(settings)
  const model = getSpeechModelOption(runtime.settings.modelId)
  const dtype = resolvePipelineDtype(runtime.settings)
  const technicalDetails = getModelTechnicalDetails(model, runtime.settings, dtype.label)
  const { env, pipeline } = await import('@huggingface/transformers')
  env.allowLocalModels = false
  env.allowRemoteModels = true
  env.useBrowserCache = true

  try {
    const transcriber = (await pipeline('automatic-speech-recognition', runtime.settings.modelId, {
      device: runtime.settings.executionProvider,
      ...(dtype.value ? { dtype: dtype.value } : {}),
      progress_callback: (data: unknown) => {
        const progress = getDownloadProgress(data)
        postProgress(
          'downloading-model',
          progress ? `Model download/cache progress: ${progress.message}` : 'Reading speech model files.',
          progress?.progress,
          technicalDetails,
        )
      },
    })) as BrowserAsrTranscriber

    postProgress('downloading-model', `${model.shortLabel} speech model is ready.`, 1, technicalDetails)
    return transcriber
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not load ${model.shortLabel} with ${runtime.settings.executionProvider}/${dtype.label}. ${details}`,
    )
  }
}


function resolvePipelineDtype(settings: TranscriptionSettings): PipelineDtypeResolution {
  if (settings.modelId === DISTIL_LARGE_V3_MODEL_ID) {
    return {
      value: {
        encoder_model: 'q8',
        decoder_model_merged: 'q8',
      },
      label: 'q8 (forced for Distil Large v3)',
    }
  }

  if (settings.dtype === 'auto') {
    return { label: 'auto' }
  }

  return {
    value: settings.dtype,
    label: settings.dtype,
  }
}

function postRegenerationComplete(
  range: RegenerationRange,
  candidates: RegenerationCandidate[],
  modelId: string,
  requestedAlternativeCount: number,
): void {
  postDiagnostic('regeneration-result', 'Completed bounded regeneration attempts.', {
    range,
    modelId,
    requestedAlternativeCount,
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      text: candidate.text,
      segments: summarizeSegments(candidate.segments),
    })),
  })
  postProgress('formatting-subtitles', 'Preparing regenerated subtitle alternatives.')
  postTerminalLog({
    type: 'complete',
    segmentCount: candidates.reduce((total, candidate) => total + candidate.segments.length, 0),
    jobKind: 'regeneration',
    candidateCount: candidates.length,
  })
  post({
    type: 'regeneration-complete',
    result: { range, candidates, modelId },
  })
}

async function transcribeInWindows(
  transcriber: BrowserAsrTranscriber,
  audio: DecodedAudio,
  settings: TranscriptionSettings,
  speechRegions: SpeechRegion[],
): Promise<NormalizedAsrResult> {
  const windows = createTranscriptionWindows(audio, settings, speechRegions)
  postDiagnostic('window-plan', 'Planned model-safe transcription windows.', {
    audioDurationSeconds: audio.samples.length / audio.sampleRate,
    sampleRate: audio.sampleRate,
    speechRegionCount: speechRegions.length,
    windows: windows.map(({ samples, ...window }) => ({
      ...window,
      sampleCount: samples.length,
      durationSeconds: samples.length / audio.sampleRate,
    })),
  })
  let allSegments: RawTranscriptionSegment[] = []
  const textParts: string[] = []
  let timestampMode: TimestampMode = settings.formatting.useWordTimestamps ? 'word' : true

  for (const window of windows) {
    assertNotCancelled()
    postProgress(
      'transcribing',
      `Transcribing chunk ${window.index + 1} of ${window.total}.`,
      window.index / window.total,
    )

    const requestedTimestampMode = timestampMode
    const asrStartedAt = performance.now()
    const attempt = await transcribeWindowWithTimestampFallback(transcriber, window.samples, settings, timestampMode)
    timestampMode = attempt.timestampMode

    const normalized = normalizeAsrResult(attempt.result, {
      offsetSeconds: window.sliceStartTime,
      coreStartTime: window.coreStartTime,
      coreEndTime: window.coreEndTime,
      speechRegions,
    })

    if (normalized.text) {
      textParts.push(normalized.text)
    }

    const beforeReconciliation = allSegments.length
    allSegments = reconcileBoundarySegments(
      allSegments,
      normalized.segments,
      window.coreStartTime,
      {
        maxSubtitleDuration: settings.formatting.maxDuration,
        hardMaxCps: settings.formatting.hardMaxCps,
      },
    )
    postDiagnostic('asr-window-result', 'Captured raw and normalized ASR output for a transcription window.', {
      window: {
        index: window.index,
        total: window.total,
        sliceStartTime: window.sliceStartTime,
        coreStartTime: window.coreStartTime,
        coreEndTime: window.coreEndTime,
        sampleCount: window.samples.length,
        durationSeconds: window.samples.length / audio.sampleRate,
      },
      requestedTimestampMode,
      actualTimestampMode: attempt.timestampMode,
      durationMs: Math.round(performance.now() - asrStartedAt),
      rawResult: summarizeAsrResult(attempt.result),
      normalized: summarizeSegments(normalized.segments),
      reconciliation: {
        priorSegmentCount: beforeReconciliation,
        resultingSegmentCount: allSegments.length,
        boundaryTime: window.coreStartTime,
      },
    })
    postPartialResult(allSegments, textParts, settings.modelId)
    postCaptionSegments(normalized.segments)
    postProgress(
      'transcribing',
      `Completed chunk ${window.index + 1} of ${window.total}.`,
      (window.index + 1) / window.total,
    )
  }

  assertNotCancelled()
  postProgress('checking-coverage', 'Checking subtitle coverage against detected speech.')
  const uncoveredRanges = findUncoveredSpeechRanges(speechRegions, allSegments)
  postDiagnostic('coverage-check', 'Compared normalized subtitles with detected speech coverage.', {
    speechRegionCount: speechRegions.length,
    segmentCount: allSegments.length,
    uncoveredRangeCount: uncoveredRanges.length,
    uncoveredRanges,
  }, uncoveredRanges.length ? 'warning' : 'info')

  if (settings.repairEnabled && uncoveredRanges.length) {
    const repairWindows = createRepairWindowPlans(uncoveredRanges, audio.samples.length / audio.sampleRate, {
      contextSeconds: settings.repairContextSeconds,
      maxModelInputSeconds: settings.maxModelInputSeconds,
      maxRepairRanges: settings.maxRepairRanges,
      minimumSubtitleGapSeconds: settings.formatting.gapBetweenSubtitles,
    })
    postDiagnostic('repair-plan', 'Planned one bounded repair pass for uncovered speech.', {
      repairWindowCount: repairWindows.length,
      repairWindows,
    })

    for (const [repairIndex, repairWindow] of repairWindows.entries()) {
      assertNotCancelled()
      postProgress(
        'repairing-coverage',
        `Recovering missed speech ${repairIndex + 1} of ${repairWindows.length}.`,
        repairIndex / repairWindows.length,
      )
      const startSample = Math.floor(repairWindow.sliceStartTime * audio.sampleRate)
      const requestedEndSample = Math.max(
        startSample + 1,
        Math.ceil(repairWindow.sliceEndTime * audio.sampleRate),
      )
      const maximumSamples = Math.max(1, Math.floor(settings.maxModelInputSeconds * audio.sampleRate))
      const endSample = Math.min(audio.samples.length, requestedEndSample, startSample + maximumSamples)
      const requestedTimestampMode = timestampMode
      const asrStartedAt = performance.now()
      const attempt = await transcribeWindowWithTimestampFallback(
        transcriber,
        audio.samples.subarray(startSample, endSample),
        settings,
        timestampMode,
      )
      timestampMode = attempt.timestampMode
      const normalized = normalizeAsrResult(attempt.result, {
        offsetSeconds: startSample / audio.sampleRate,
        fallbackStartTime: repairWindow.gapStartTime,
        fallbackEndTime: repairWindow.gapEndTime,
        speechRegions,
      })
      const gap = { startTime: repairWindow.gapStartTime, endTime: repairWindow.gapEndTime }
      const recovered = selectRepairSegments(allSegments, normalized.segments, gap, {
        minimumSubtitleGapSeconds: settings.formatting.gapBetweenSubtitles,
      })
      postDiagnostic('repair-result', 'Captured a missed-speech repair result.', {
        repairIndex,
        repairWindow,
        gap,
        requestedTimestampMode,
        actualTimestampMode: attempt.timestampMode,
        durationMs: Math.round(performance.now() - asrStartedAt),
        rawResult: summarizeAsrResult(attempt.result),
        normalized: summarizeSegments(normalized.segments),
        accepted: summarizeSegments(recovered),
      }, recovered.length ? 'info' : 'warning')
      if (recovered.length) {
        allSegments = [...allSegments, ...recovered].sort(
          (first, second) => first.startTime - second.startTime || first.endTime - second.endTime,
        )
        postCaptionSegments(recovered)
        postPartialResult(allSegments, textParts, settings.modelId)
      }
      postProgress(
        'repairing-coverage',
        `Completed missed-speech recovery ${repairIndex + 1} of ${repairWindows.length}.`,
        (repairIndex + 1) / repairWindows.length,
      )
    }
  }

  assertNotCancelled()
  postProgress('refining-timing', 'Refining subtitle timing around speech boundaries.')
  const beforeRefinement = allSegments
  allSegments = refineSegmentsToSpeechBoundaries(allSegments, speechRegions, {
    leadInSeconds: settings.formatting.subtitleLeadIn,
    tailPaddingSeconds: settings.formatting.subtitleTailPadding,
    minimumGapSeconds: settings.formatting.gapBetweenSubtitles,
  })
  postDiagnostic('timing-refinement', 'Applied final speech-boundary timing refinement.', {
    before: summarizeSegments(beforeRefinement),
    after: summarizeSegments(allSegments),
  })
  postPartialResult(allSegments, textParts, settings.modelId)

  return {
    segments: allSegments,
    text: allSegments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim(),
  }
}

async function transcribeWindowWithTimestampFallback(
  transcriber: BrowserAsrTranscriber,
  samples: Float32Array,
  settings: TranscriptionSettings,
  timestampMode: TimestampMode,
  decodingProfile?: RegenerationDecodingProfile,
): Promise<TimestampAttempt> {
  const options = createAsrCallOptions(settings, timestampMode, decodingProfile)

  try {
    return {
      result: await transcriber(samples, options),
      timestampMode,
    }
  } catch (error) {
    if (timestampMode !== 'word' || !isWordTimestampUnsupportedError(error)) {
      postDiagnostic('asr-call-failed', 'An ASR model call failed.', { error: serializeError(error) }, 'error')
      throw error
    }

    assertNotCancelled()
    postProgress(
      'transcribing',
      'Word timestamps are not available for this model export. Retrying with segment timestamps.',
    )
    postDiagnostic(
      'word-timestamp-fallback',
      'Word timestamps were unsupported; this session switched to segment timestamps.',
      { error: serializeError(error) },
      'warning',
    )

    return {
      result: await transcriber(samples, {
        ...options,
        return_timestamps: true,
      }),
      timestampMode: true,
    }
  }
}

function createAsrCallOptions(
  settings: TranscriptionSettings,
  timestampMode: TimestampMode,
  decodingProfile?: RegenerationDecodingProfile,
): AsrCallOptions {
  return {
    return_timestamps: timestampMode,
    // The worker supplies one model-safe window so it can stream each result immediately.
    chunk_length_s: 0,
    stride_length_s: 0,
    language: settings.language === 'auto' ? undefined : settings.language,
    task: settings.task,
    do_sample: decodingProfile?.doSample,
    temperature: decodingProfile?.temperature,
    top_k: decodingProfile?.topK,
  }
}

function createTranscriptionWindows(
  audio: DecodedAudio,
  settings: TranscriptionSettings,
  speechRegions: SpeechRegion[],
): TranscriptionWindow[] {
  const duration = audio.samples.length / audio.sampleRate
  const maximumInputSeconds = Math.min(settings.maxModelInputSeconds, settings.chunkLengthSeconds)
  const speechAwarePlan = speechRegions.length
    ? createSpeechAwareTranscriptionWindowPlan(duration, speechRegions, {
        maxModelInputSeconds: maximumInputSeconds,
        targetChunkSeconds: Math.min(settings.targetChunkSeconds, maximumInputSeconds),
        overlapSeconds: settings.speechAwareOverlapSeconds,
        hardMinWindowSeconds: settings.hardMinWindowSeconds,
      })
    : null
  const plan =
    speechAwarePlan?.windows.length
      ? speechAwarePlan
      : createTranscriptionWindowPlan(duration, maximumInputSeconds, settings.fallbackOverlapSeconds)
  const maxWindowSamples = Math.max(1, Math.floor(plan.windowSeconds * audio.sampleRate))

  return plan.windows.map((timing, index) => {
    const startSample = Math.floor(timing.sliceStartTime * audio.sampleRate)
    const requestedEndSample = Math.max(startSample + 1, Math.ceil(timing.sliceEndTime * audio.sampleRate))
    const endSample = Math.min(audio.samples.length, startSample + maxWindowSamples, requestedEndSample)

    return {
      index,
      total: plan.windows.length || 1,
      samples: audio.samples.subarray(startSample, endSample),
      sliceStartTime: startSample / audio.sampleRate,
      coreStartTime: timing.coreStartTime,
      coreEndTime: timing.coreEndTime,
    }
  })
}

function analyzeSpeechActivity(audio: DecodedAudio, settings: TranscriptionSettings): SpeechRegion[] {
  if (!settings.vadEnabled) {
    return []
  }
  return safelyDetectSpeechRegions(audio.samples, audio.sampleRate, {
    frameMs: settings.vadFrameMs,
    hopMs: settings.vadHopMs,
    minSpeechMs: settings.vadMinSpeechMs,
    mergeGapMs: settings.vadMergeGapMs,
    prePaddingMs: settings.vadPrePaddingMs,
    postPaddingMs: settings.vadPostPaddingMs,
    noiseFloorMultiplier: settings.vadNoiseFloorMultiplier,
    minimumRmsFloor: settings.vadMinimumRmsFloor,
  })
}

async function extractAudio(
  file: File,
  range?: AudioExtractionRange,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const message = range
    ? 'Extracting the selected mono 16 kHz audio range locally with FFmpeg.wasm.'
    : 'Extracting mono 16 kHz PCM audio locally with FFmpeg.wasm.'
  postProgress('extracting-audio', message)

  const ffmpeg = new FFmpeg()
  ffmpeg.on('progress', ({ progress }) => {
    postProgress('extracting-audio', message, clampProgress(progress))
  })

  const inputName = `input-${Date.now()}`
  const outputName = 'audio.wav'

  try {
    await ffmpeg.load({
      coreURL: coreUrl,
      wasmURL: wasmUrl,
    })

    assertNotCancelled()
    await ffmpeg.writeFile(inputName, await fetchFile(file))

    assertNotCancelled()
    const exitCode = await ffmpeg.exec(buildAudioExtractionArgs(inputName, outputName, range))

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}.`)
    }

    assertNotCancelled()
    const data = await ffmpeg.readFile(outputName)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    return decodePcmWav(bytes)
  } finally {
    try {
      await ffmpeg.deleteFile(inputName)
      await ffmpeg.deleteFile(outputName)
    } catch {
      // Best-effort cleanup only.
    }

    ffmpeg.terminate()
  }
}

function decodePcmWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const riff = readString(view, 0, 4)
  const wave = readString(view, 8, 4)

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('FFmpeg did not produce a valid WAV file.')
  }

  let offset = 12
  let sampleRate = 16000
  let bitsPerSample = 16
  let channels = 1
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= view.byteLength) {
    const chunkId = readString(view, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8

    if (chunkId === 'fmt ') {
      channels = view.getUint16(chunkDataOffset + 2, true)
      sampleRate = view.getUint32(chunkDataOffset + 4, true)
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true)
    }

    if (chunkId === 'data') {
      dataOffset = chunkDataOffset
      dataSize = chunkSize
      break
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2)
  }

  if (dataOffset < 0 || bitsPerSample !== 16 || channels !== 1) {
    throw new Error('Expected mono 16-bit PCM WAV audio.')
  }

  const sampleCount = Math.floor(dataSize / 2)
  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768
  }

  return { samples, sampleRate }
}

function getDownloadProgress(data: unknown): { message: string; progress?: number } | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const record = data as { status?: unknown; file?: unknown; progress?: unknown; loaded?: unknown; total?: unknown }
  const file = typeof record.file === 'string' ? record.file.split('/').at(-1) : undefined
  const status = typeof record.status === 'string' ? record.status : 'model'

  if (typeof record.progress === 'number') {
    return {
      message: `${status}${file ? `: ${file}` : ''}`,
      progress: clampProgress(record.progress / 100),
    }
  }

  if (typeof record.loaded === 'number' && typeof record.total === 'number' && record.total > 0) {
    return {
      message: `${status}${file ? `: ${file}` : ''}`,
      progress: clampProgress(record.loaded / record.total),
    }
  }

  return {
    message: `${status}${file ? `: ${file}` : ''}`,
  }
}

function postCaptionSegments(segments: RawTranscriptionSegment[]): void {
  for (const segment of segments) {
    if (!segment.text.trim()) {
      continue
    }

    postTerminalLog({
      type: 'caption',
      startTime: segment.startTime,
      endTime: segment.endTime,
      text: segment.text,
    })
  }
}

function postPartialResult(segments: RawTranscriptionSegment[], textParts: string[], modelId: string): void {
  post({
    type: 'partial',
    result: {
      segments: [...segments],
      text: textParts.join(' ').replace(/\s+/g, ' ').trim(),
      modelId,
    },
  })
}

function calculateRms(samples: Float32Array): number {
  let sum = 0
  const stride = Math.max(1, Math.floor(samples.length / 500_000))
  let count = 0

  for (let index = 0; index < samples.length; index += stride) {
    sum += samples[index] * samples[index]
    count += 1
  }

  return Math.sqrt(sum / Math.max(1, count))
}

function postProgress(
  stage: TranscriptionStage,
  message: string,
  progress?: number,
  technicalDetails?: string,
): void {
  const overallProgress = getOverallProgress(stage, progress)
  post({
    type: 'progress',
    progress: {
      stage,
      message,
      progress: overallProgress,
      technicalDetails,
    },
  })
  postTerminalLog({
    type: 'progress',
    stage,
    message,
    progress: overallProgress,
  })
}

function getModelTechnicalDetails(
  model: SpeechModelOption,
  settings: TranscriptionSettings,
  effectiveDtype = settings.dtype,
): string {
  return `${model.label} (${model.id}); ${model.highResource ? 'high-resource; ' : ''}engine ${settings.executionProvider}; dtype ${effectiveDtype}`
}

function post(event: WorkerEvent): void {
  self.postMessage(event)
}

function postDiagnostic(
  category: string,
  message: string,
  data?: unknown,
  level: DiagnosticLevel = 'info',
): void {
  post({
    type: 'diagnostic',
    event: {
      timestamp: new Date().toISOString(),
      source: 'transcription-worker',
      category,
      message,
      level,
      jobId: terminalJobId || undefined,
      data,
    },
  })
}

function serializeError(error: unknown): { name?: string; message: string; stack?: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) }
}

function postTerminalLog(event: TerminalLogEvent): void {
  if (!import.meta.env.DEV || !terminalJobId) {
    return
  }

  void fetch('/__auto_subtitle_terminal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...event,
      jobId: terminalJobId,
    }),
  }).catch(() => undefined)
}

function getOverallProgress(stage: TranscriptionStage, progress = 0): number {
  const stageProgress = clampProgress(progress)
  const mapped = (() => {
    if (stage === 'loading-engine') {
      return 0.02
    }

    if (stage === 'preparing-video') {
      return 0.06
    }

    if (stage === 'extracting-audio') {
      return 0.08 + stageProgress * 0.22
    }

    if (stage === 'downloading-model') {
      return 0.34 + stageProgress * 0.18
    }

    if (stage === 'analyzing-speech') {
      return 0.31
    }

    if (stage === 'planning-windows') {
      return 0.33
    }

    if (stage === 'transcribing') {
      return 0.52 + stageProgress * 0.34
    }

    if (stage === 'checking-coverage') {
      return 0.88
    }

    if (stage === 'repairing-coverage') {
      return 0.89 + stageProgress * 0.06
    }

    if (stage === 'refining-timing') {
      return 0.96
    }

    if (stage === 'formatting-subtitles') {
      return 0.98
    }

    if (stage === 'complete') {
      return 1
    }

    return lastOverallProgress
  })()

  lastOverallProgress = Math.max(lastOverallProgress, clampProgress(mapped))
  return lastOverallProgress
}

function assertNotCancelled(): void {
  if (cancelled) {
    throw new Error('Transcription cancelled.')
  }
}

function readString(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index))
  }
  return value
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}

function createJobId(): string {
  if ('crypto' in self && 'randomUUID' in self.crypto) {
    return self.crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
