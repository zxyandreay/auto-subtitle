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
import {
  createRepairWindowPlans,
  selectRepairSegments,
} from '../transcription/repair'
import {
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
import {
  analyzeSpeechActivity as analyzeSpeechActivityFrames,
  type SpeechActivityFrameSeries,
  type SpeechRegion,
} from '../transcription/speechActivity'
import { refineSegmentsToSpeechBoundaries } from '../transcription/timingRefinement'
import { normalizeTranscriptionSettings } from '../transcription/types'
import type {
  RegenerationCandidate,
  RegenerationRange,
  TranscriptionSettings,
  TranscriptionStage,
  WorkerEvent,
  WorkerEventPayload,
  WorkerRequest,
} from '../transcription/types'
import {
  createSpeechAwareTranscriptionWindowPlan,
  createTranscriptionWindowPlan,
} from '../transcription/windowing'

let cancelled = false
let activeJobId: string | null = null

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
    if (request.jobId !== activeJobId) {
      return
    }
    cancelled = true
    postDiagnostic('job-cancelled', 'The worker received a cancellation request.', undefined, 'warning')
    return
  }

  if (activeJobId) {
    postForJob(request.jobId, {
      type: 'error',
      error: { message: 'Another transcription worker job is already running.' },
    })
    return
  }

  cancelled = false
  activeJobId = request.jobId
  terminalJobId = request.jobId
  lastOverallProgress = 0
  startJobMetrics(request.type === 'regenerate' ? 'regeneration' : 'transcription')
  postDiagnostic('job-requested', 'A local transcription worker job was requested.', {
    jobKind: request.type === 'regenerate' ? 'regeneration' : 'transcription',
    file: { name: request.file.name, size: request.file.size, type: request.file.type },
    settings: request.settings,
    range: request.type === 'regenerate' ? request.range : undefined,
    videoDuration: request.type === 'regenerate' ? request.videoDuration : undefined,
    alternativeCount: request.type === 'regenerate' ? request.alternativeCount : undefined,
  })
  const languageResolvedSettings = resolveAutomaticLanguageFallback(request.settings)
  const normalized = normalizeTranscriptionSettings(languageResolvedSettings)
  if (normalized.reason) {
    postDiagnostic('settings-normalized', 'Resolved saved settings for the browser runtime.', {
      reason: normalized.reason,
      requestedExecutionProvider: request.settings.executionProvider,
      effectiveExecutionProvider: normalized.settings.executionProvider,
    })
  }
  const effectiveSettings = normalized.settings
  const task =
    request.type === 'regenerate'
      ? regenerate(
          request.file,
          effectiveSettings,
          request.range,
          request.alternativeCount,
          request.videoDuration,
        )
      : transcribe(request.file, effectiveSettings)

  void task.catch((error: unknown) => {
    finishJobMetrics(cancelled ? 'cancelled' : 'failed')
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
  }).finally(() => {
    if (activeJobId === request.jobId) {
      activeJobId = null
      terminalJobId = ''
      jobMetrics = null
    }
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
  // Full extraction temporarily holds the media input, FFmpeg MEMFS/WASM data,
  // WAV bytes, and decoded Float32 PCM. Do not overlap that peak with a warm
  // model from a previous job; bounded regeneration can still reuse it safely.
  if (cachedTranscriber) {
    await disposeCachedTranscriber('Released the warm model before full-file audio extraction.')
  }
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
  const speechAnalysis = analyzeSpeechActivityForJob(audio, effectiveSettings)
  const speechRegions = speechAnalysis.regions
  postDiagnostic('speech-activity', 'Completed local speech activity analysis.', {
    regionCount: speechRegions.length,
    regions: speechRegions,
    vadEnabled: effectiveSettings.vadEnabled,
    frameCount: speechAnalysis.frames?.activity.length ?? 0,
    frameHopSamples: speechAnalysis.frames?.hopSamples,
  })

  assertNotCancelled()
  postProgress(
    'planning-windows',
    speechRegions.length ? 'Planning speech-aware transcription windows.' : 'Planning safe fallback windows.',
  )
  const windows = createTranscriptionWindows(audio, effectiveSettings, speechRegions, speechAnalysis.frames)
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

  assertNotCancelled()
  postProgress(
    'downloading-model',
    `Loading ${model.shortLabel} from the browser cache or model repository.`,
    undefined,
    getModelTechnicalDetails(model, effectiveSettings),
  )

  const transcriber = await loadTranscriber(effectiveSettings)

  assertNotCancelled()
  postProgress('transcribing', 'Transcribing speech locally with Whisper.')
  const result = await transcribeInWindows(transcriber, audio, effectiveSettings, speechRegions, windows)
  postDiagnostic('transcription-result', 'Completed the worker transcription pipeline.', {
    text: result.text,
    segments: summarizeSegments(result.segments),
  })

  assertNotCancelled()
  postProgress('formatting-subtitles', 'Converting model timestamps into editable subtitle segments.')
  await releaseHighResourceTranscriber(model)
  finishJobMetrics('complete')
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
  await disposeIncompatibleTranscriber(effectiveSettings)

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
    await releaseHighResourceTranscriber(model)
    postRegenerationComplete(range, [], effectiveSettings.modelId, requestedAlternativeCount)
    return
  }

  postProgress('analyzing-speech', 'Analyzing speech activity in the selected range.')
  const speechRegions = analyzeSpeechActivityForJob(audio, effectiveSettings).regions.map((region) => ({
    ...region,
    startTime: region.startTime + extractionRange.extractionStartTime,
    endTime: region.endTime + extractionRange.extractionStartTime,
    rawStartTime: region.rawStartTime === undefined
      ? undefined
      : region.rawStartTime + extractionRange.extractionStartTime,
    rawEndTime: region.rawEndTime === undefined
      ? undefined
      : region.rawEndTime + extractionRange.extractionStartTime,
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

  const candidates: RegenerationCandidate[] = []
  let timestampMode = getInitialTimestampMode(effectiveSettings)

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
        timestampMode: attempt.timestampMode,
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
  await releaseHighResourceTranscriber(model)
  postRegenerationComplete(range, candidates, effectiveSettings.modelId, requestedAlternativeCount)
}

async function loadTranscriber(settings: TranscriptionSettings): Promise<BrowserAsrTranscriber> {
  const runtime = resolveSpeechModelRuntimeSettings(settings)
  const model = getSpeechModelOption(runtime.settings.modelId)
  const cacheKey = createTranscriberCacheKey(runtime.settings)
  if (cachedTranscriber?.key === cacheKey) {
    if (jobMetrics) {
      jobMetrics.modelLoad = 'warm'
    }
    postDiagnostic('model-cache-hit', 'Reused the compatible in-memory speech model pipeline.', {
      modelId: runtime.settings.modelId,
      executionProvider: runtime.settings.executionProvider,
      dtype: runtime.settings.dtype,
    })
    return cachedTranscriber.transcriber
  }

  if (cachedTranscriber) {
    await disposeCachedTranscriber('The requested model runtime is incompatible with the warm pipeline.')
  }

  const { env, pipeline } = await import('@huggingface/transformers')
  env.allowLocalModels = false
  env.allowRemoteModels = true
  env.useBrowserCache = true

  try {
    const transcriber = (await pipeline('automatic-speech-recognition', runtime.settings.modelId, {
      device: runtime.settings.executionProvider,
      dtype: runtime.settings.dtype === 'auto' ? undefined : runtime.settings.dtype,
      progress_callback: (data: unknown) => {
        const progress = getDownloadProgress(data)
        postProgress(
          'downloading-model',
          progress ? `Model download/cache progress: ${progress.message}` : 'Reading speech model files.',
          progress?.progress,
          getModelTechnicalDetails(model, runtime.settings),
        )
      },
    })) as BrowserAsrTranscriber
    cachedTranscriber = { key: cacheKey, transcriber }
    if (jobMetrics) {
      jobMetrics.modelLoad = 'cold'
    }
    return transcriber
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not load ${model.shortLabel} with ${runtime.settings.executionProvider}/${runtime.settings.dtype}. ${details}`,
    )
  }
}

function createTranscriberCacheKey(settings: TranscriptionSettings): string {
  return [settings.modelId, settings.executionProvider, settings.dtype].join('\u0000')
}

async function disposeIncompatibleTranscriber(settings: TranscriptionSettings): Promise<void> {
  if (cachedTranscriber && cachedTranscriber.key !== createTranscriberCacheKey(settings)) {
    await disposeCachedTranscriber('The requested model runtime is incompatible with the warm pipeline.')
  }
}

async function releaseHighResourceTranscriber(model: SpeechModelOption): Promise<void> {
  if (model.highResource) {
    await disposeCachedTranscriber('High-resource speech models are released after each job to bound browser memory.')
  }
}

async function disposeCachedTranscriber(reason: string): Promise<void> {
  const cached = cachedTranscriber
  cachedTranscriber = null
  if (!cached) {
    return
  }

  try {
    await cached.transcriber.dispose?.()
    postDiagnostic('model-disposed', 'Disposed the warm speech model pipeline.', { reason })
  } catch (error) {
    postDiagnostic(
      'model-dispose-failed',
      'The old speech model pipeline reported an error during disposal; loading will continue with a fresh pipeline.',
      { reason, error: serializeError(error) },
      'warning',
    )
  }
}

function resolveAutomaticLanguageFallback(settings: TranscriptionSettings): TranscriptionSettings {
  if (settings.language !== 'auto') {
    return settings
  }

  postDiagnostic(
    'automatic-language-fallback',
    'This Transformers.js runtime does not detect Whisper language automatically; using English for this legacy setting.',
    { requestedLanguage: 'auto', effectiveLanguage: 'english' },
    'warning',
  )
  return { ...settings, language: 'english' }
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
  finishJobMetrics('complete')
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
  windows: TranscriptionWindow[],
): Promise<NormalizedAsrResult> {
  let allSegments: RawTranscriptionSegment[] = []
  let lastPostedSegments: RawTranscriptionSegment[] = []
  let timestampMode = getInitialTimestampMode(settings)

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
      timestampMode: attempt.timestampMode,
      offsetSeconds: window.sliceStartTime,
      coreStartTime: window.coreStartTime,
      coreEndTime: window.coreEndTime,
      retainCrossingSegmentSuffix: true,
      speechRegions,
    })
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
    lastPostedSegments = postPartialResult(allSegments, lastPostedSegments, settings.modelId)
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
        timestampMode: attempt.timestampMode,
        offsetSeconds: startSample / audio.sampleRate,
        fallbackStartTime: repairWindow.gapStartTime,
        fallbackEndTime: repairWindow.gapEndTime,
        speechRegions,
      })
      const gap = { startTime: repairWindow.gapStartTime, endTime: repairWindow.gapEndTime }
      const repairCandidates = selectRepairSegments(allSegments, normalized.segments, gap, {
        minimumSubtitleGapSeconds: settings.formatting.gapBetweenSubtitles,
      })
      const recovered = repairCandidates
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
        lastPostedSegments = postPartialResult(allSegments, lastPostedSegments, settings.modelId)
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
  postPartialResult(allSegments, lastPostedSegments, settings.modelId)

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
  const options = createAsrCallOptions(
    settings,
    timestampMode,
    decodingProfile,
  )

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

function getInitialTimestampMode(settings: TranscriptionSettings): TimestampMode {
  if (!settings.formatting.useWordTimestamps) {
    return true
  }

  const model = getSpeechModelOption(settings.modelId)
  if (model.supportsWordTimestamps) {
    return 'word'
  }

  postDiagnostic(
    'word-timestamp-model-limit',
    `${model.shortLabel} does not expose the alignment data required for word timestamps; using segment timestamps without a failed retry.`,
    { modelId: model.id, requestedTimestampMode: 'word', actualTimestampMode: true },
    'warning',
  )
  return true
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
  activityFrames?: SpeechActivityFrameSeries,
): TranscriptionWindow[] {
  const duration = audio.samples.length / audio.sampleRate
  const maximumInputSeconds = Math.min(settings.maxModelInputSeconds, settings.chunkLengthSeconds)
  const speechAwarePlan = speechRegions.length
    ? createSpeechAwareTranscriptionWindowPlan(duration, speechRegions, {
        maxModelInputSeconds: maximumInputSeconds,
        targetChunkSeconds: Math.min(settings.targetChunkSeconds, maximumInputSeconds),
        overlapSeconds: settings.speechAwareOverlapSeconds,
        hardMinWindowSeconds: settings.hardMinWindowSeconds,
        activityFrames,
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

function analyzeSpeechActivityForJob(
  audio: DecodedAudio,
  settings: TranscriptionSettings,
): { regions: SpeechRegion[]; frames?: SpeechActivityFrameSeries } {
  if (!settings.vadEnabled) {
    return { regions: [] }
  }
  try {
    return analyzeSpeechActivityFrames(audio.samples, audio.sampleRate, {
      frameMs: settings.vadFrameMs,
      hopMs: settings.vadHopMs,
      minSpeechMs: settings.vadMinSpeechMs,
      mergeGapMs: settings.vadMergeGapMs,
      prePaddingMs: settings.vadPrePaddingMs,
      postPaddingMs: settings.vadPostPaddingMs,
      noiseFloorMultiplier: settings.vadNoiseFloorMultiplier,
      minimumRmsFloor: settings.vadMinimumRmsFloor,
    })
  } catch (error) {
    postDiagnostic(
      'speech-activity-fallback',
      'Speech activity analysis failed, so the job will use safe timeline windows.',
      { error: serializeError(error) },
      'warning',
    )
    return { regions: [] }
  }
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

function postPartialResult(
  segments: RawTranscriptionSegment[],
  previousSegments: RawTranscriptionSegment[],
  modelId: string,
): RawTranscriptionSegment[] {
  let replaceFromIndex = 0
  const prefixLimit = Math.min(segments.length, previousSegments.length)
  while (
    replaceFromIndex < prefixLimit &&
    areSegmentsExactlyEqual(segments[replaceFromIndex], previousSegments[replaceFromIndex])
  ) {
    replaceFromIndex += 1
  }

  if (replaceFromIndex === segments.length && replaceFromIndex === previousSegments.length) {
    return previousSegments
  }

  const event: WorkerEventPayload = {
    type: 'partial',
    delta: {
      replaceFromIndex,
      totalSegments: segments.length,
      segments: segments.slice(replaceFromIndex),
      modelId,
    },
  }
  if (jobMetrics) {
    jobMetrics.partialMessageCount += 1
    jobMetrics.partialMessageBytes += approximateJsonBytes({ ...event, jobId: activeJobId })
  }
  post(event)
  return segments
}

function areSegmentsExactlyEqual(first: RawTranscriptionSegment, second: RawTranscriptionSegment): boolean {
  if (first === second) {
    return true
  }
  if (
    first.startTime !== second.startTime ||
    first.endTime !== second.endTime ||
    first.text !== second.text ||
    first.confidence !== second.confidence
  ) {
    return false
  }
  const firstWords = first.words ?? []
  const secondWords = second.words ?? []
  return firstWords.length === secondWords.length && firstWords.every((word, index) => {
    const other = secondWords[index]
    return (
      word.text === other.text &&
      word.startTime === other.startTime &&
      word.endTime === other.endTime &&
      word.confidence === other.confidence
    )
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
  trackJobStage(stage)
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

function getModelTechnicalDetails(model: SpeechModelOption, settings: TranscriptionSettings): string {
  return `${model.label} (${model.id}); ${model.highResource ? 'high-resource; ' : ''}engine ${settings.executionProvider}; dtype ${settings.dtype}`
}

function post(event: WorkerEventPayload): void {
  if (!activeJobId) {
    return
  }
  postForJob(activeJobId, event)
}

function postForJob(jobId: string, event: WorkerEventPayload): void {
  self.postMessage({ ...event, jobId } satisfies WorkerEvent)
}

type CachedTranscriber = {
  key: string
  transcriber: BrowserAsrTranscriber
}

type JobMetrics = {
  jobKind: 'transcription' | 'regeneration'
  startedAt: number
  activeStage?: TranscriptionStage
  stageStartedAt: number
  stageDurationsMs: Partial<Record<TranscriptionStage, number>>
  partialMessageCount: number
  partialMessageBytes: number
  modelLoad?: 'cold' | 'warm'
  finished: boolean
}

let cachedTranscriber: CachedTranscriber | null = null
let jobMetrics: JobMetrics | null = null

function startJobMetrics(jobKind: JobMetrics['jobKind']): void {
  const now = performance.now()
  jobMetrics = {
    jobKind,
    startedAt: now,
    stageStartedAt: now,
    stageDurationsMs: {},
    partialMessageCount: 0,
    partialMessageBytes: 0,
    finished: false,
  }
}

function trackJobStage(stage: TranscriptionStage): void {
  const metrics = jobMetrics
  if (!metrics || metrics.finished || metrics.activeStage === stage) {
    return
  }

  const now = performance.now()
  closeTrackedStage(metrics, now)
  metrics.activeStage = stage
  metrics.stageStartedAt = now
}

function finishJobMetrics(outcome: 'complete' | 'cancelled' | 'failed'): void {
  const metrics = jobMetrics
  if (!metrics || metrics.finished) {
    return
  }

  const now = performance.now()
  closeTrackedStage(metrics, now)
  metrics.finished = true
  const stageDurationsMs = Object.fromEntries(
    Object.entries(metrics.stageDurationsMs).map(([stage, duration]) => [stage, Math.round(duration)]),
  )
  postDiagnostic('job-performance', 'Recorded bounded worker performance measurements.', {
    jobKind: metrics.jobKind,
    outcome,
    totalDurationMs: Math.round(now - metrics.startedAt),
    stageDurationsMs,
    modelLoad: metrics.modelLoad,
    partialMessageCount: metrics.partialMessageCount,
    approximatePartialMessageBytes: metrics.partialMessageBytes,
  })
}

function closeTrackedStage(metrics: JobMetrics, now: number): void {
  if (!metrics.activeStage) {
    return
  }
  metrics.stageDurationsMs[metrics.activeStage] =
    (metrics.stageDurationsMs[metrics.activeStage] ?? 0) + Math.max(0, now - metrics.stageStartedAt)
}

function approximateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
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
