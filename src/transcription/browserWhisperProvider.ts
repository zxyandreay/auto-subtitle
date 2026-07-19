import type { DiagnosticEventInput } from '../diagnostics/types'
import type { RawTranscriptionSegment } from '../subtitles/formatting'
import type {
  RegenerationRange,
  RegenerationResult,
  TranscriptionProgress,
  TranscriptionResult,
  TranscriptionSettings,
  WorkerEvent,
  WorkerPartialDelta,
  WorkerRequest,
} from './types'

export type TranscriptionCallbacks = {
  onProgress: (progress: TranscriptionProgress) => void
  onPartial?: (result: TranscriptionResult) => void
  onDiagnostic?: (event: DiagnosticEventInput) => void
}

export type TranscriptionJob = {
  done: Promise<TranscriptionResult>
  cancel: () => void
}

export type RegenerationJob = {
  done: Promise<RegenerationResult>
  cancel: () => void
}

const WORKER_IDLE_TIMEOUT_MS = 2 * 60 * 1_000
const LARGE_MEDIA_WARM_WORKER_EVICTION_BYTES = 256 * 1024 * 1024

type ActiveJobBase = {
  jobId: string
  request: Exclude<WorkerRequest, { type: 'cancel' }>
  callbacks: TranscriptionCallbacks
  reject: (error: Error) => void
  partialSegments: RawTranscriptionSegment[]
  receivedWorkerMessage: boolean
  workerMessageCount: number
  workerMessageBytes: number
  workerMessageCountsByType: Partial<Record<WorkerEvent['type'], number>>
  workerMessageBytesByType: Partial<Record<WorkerEvent['type'], number>>
  workerMessageMetricsReported: boolean
  startupRetries: number
  settled: boolean
}

type ActiveTranscriptionJob = ActiveJobBase & {
  kind: 'transcription'
  resolve: (result: TranscriptionResult) => void
}

type ActiveRegenerationJob = ActiveJobBase & {
  kind: 'regeneration'
  resolve: (result: RegenerationResult) => void
}

type ActiveJob = ActiveTranscriptionJob | ActiveRegenerationJob

let sharedWorker: Worker | null = null
let activeJob: ActiveJob | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

export function startBrowserWhisperTranscription(
  file: File,
  settings: TranscriptionSettings,
  callbacks: TranscriptionCallbacks,
): TranscriptionJob {
  if (activeJob) {
    return rejectedJob('Another local transcription or regeneration job is already running.')
  }
  evictWarmWorkerForLargeMedia(file, callbacks)

  const jobId = createJobId()
  let active: ActiveTranscriptionJob
  const done = new Promise<TranscriptionResult>((resolve, reject) => {
    active = {
      kind: 'transcription',
      jobId,
      request: { type: 'start', jobId, file, settings },
      callbacks,
      resolve,
      reject,
      partialSegments: [],
      receivedWorkerMessage: false,
      workerMessageCount: 0,
      workerMessageBytes: 0,
      workerMessageCountsByType: {},
      workerMessageBytesByType: {},
      workerMessageMetricsReported: false,
      startupRetries: 0,
      settled: false,
    }
  })

  // The Promise executor above always runs synchronously.
  const job = active!
  startJob(job)
  return {
    done,
    cancel: () => cancelJob(job, 'Transcription cancelled by the user.'),
  }
}

export function startBrowserWhisperRegeneration(
  file: File,
  settings: TranscriptionSettings,
  range: RegenerationRange,
  videoDuration: number | undefined,
  alternativeCount: number,
  callbacks: Pick<TranscriptionCallbacks, 'onProgress' | 'onDiagnostic'>,
): RegenerationJob {
  if (activeJob) {
    return rejectedJob('Another local transcription or regeneration job is already running.')
  }
  evictWarmWorkerForLargeMedia(file, callbacks)

  const jobId = createJobId()
  let active: ActiveRegenerationJob
  const done = new Promise<RegenerationResult>((resolve, reject) => {
    active = {
      kind: 'regeneration',
      jobId,
      request: {
        type: 'regenerate',
        jobId,
        file,
        settings,
        range,
        videoDuration,
        alternativeCount,
      },
      callbacks,
      resolve,
      reject,
      partialSegments: [],
      receivedWorkerMessage: false,
      workerMessageCount: 0,
      workerMessageBytes: 0,
      workerMessageCountsByType: {},
      workerMessageBytesByType: {},
      workerMessageMetricsReported: false,
      startupRetries: 0,
      settled: false,
    }
  })

  const job = active!
  startJob(job)
  return {
    done,
    cancel: () => cancelJob(job, 'Regeneration cancelled by the user.'),
  }
}

/**
 * Immediately releases the reusable worker and any model pipeline resident in
 * it. Normal jobs use idle eviction; callers can use this for application or
 * test teardown and for explicit memory cleanup.
 */
export function disposeBrowserWhisperWorker(): void {
  const job = activeJob
  activeJob = null
  terminateSharedWorker()
  if (job && !job.settled) {
    reportWorkerMessageMetrics(job)
    job.settled = true
    job.reject(new Error('The local transcription worker was disposed.'))
  }
}

function startJob(job: ActiveJob): void {
  clearIdleTimer()
  activeJob = job
  try {
    postJobRequest(job)
  } catch (error) {
    activeJob = null
    job.settled = true
    terminateSharedWorker()
    job.reject(toError(error, `The ${job.kind} worker could not start.`))
  }
}

function postJobRequest(job: ActiveJob): void {
  getSharedWorker().postMessage(job.request)
}

function getSharedWorker(): Worker {
  if (sharedWorker) {
    return sharedWorker
  }

  const worker = new Worker(new URL('../workers/transcription.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<WorkerEvent>) => handleWorkerMessage(worker, event.data)
  worker.onerror = (event) => handleWorkerCrash(worker, event)
  sharedWorker = worker
  return worker
}

function handleWorkerMessage(worker: Worker, data: WorkerEvent): void {
  const job = activeJob
  if (worker !== sharedWorker || !job || data.jobId !== job.jobId || job.settled) {
    return
  }

  recordWorkerMessage(job, data)
  job.receivedWorkerMessage = true

  try {
    if (data.type === 'progress') {
      job.callbacks.onProgress(data.progress)
      return
    }

    if (data.type === 'partial') {
      if (job.kind !== 'transcription') {
        throw new Error('The regeneration worker returned an unexpected partial result.')
      }
      job.partialSegments = applyPartialDelta(job.partialSegments, data.delta)
      const publicSegments = cloneRawSegments(job.partialSegments)
      job.callbacks.onPartial?.({
        segments: publicSegments,
        text: transcriptText(publicSegments),
        modelId: data.delta.modelId,
      })
      return
    }

    if (data.type === 'diagnostic') {
      job.callbacks.onDiagnostic?.(data.event)
      return
    }

    if (data.type === 'complete' && job.kind === 'transcription') {
      settleSuccessfulJob(job, data.result)
      return
    }

    if (data.type === 'regeneration-complete' && job.kind === 'regeneration') {
      settleSuccessfulJob(job, data.result)
      return
    }

    if (data.type === 'error') {
      failJob(
        job,
        new Error(data.error.details ? `${data.error.message}\n${data.error.details}` : data.error.message),
      )
      return
    }

    throw new Error(`The ${job.kind} worker returned an unexpected result.`)
  } catch (error) {
    failJob(job, toError(error, `The ${job.kind} worker response could not be processed.`))
  }
}

function handleWorkerCrash(worker: Worker, event: ErrorEvent): void {
  if (worker !== sharedWorker) {
    return
  }

  const job = activeJob
  terminateSharedWorker()
  if (!job || job.settled) {
    return
  }

  if (!job.receivedWorkerMessage && job.startupRetries < 1) {
    job.startupRetries += 1
    try {
      job.callbacks.onDiagnostic?.({
        source: 'app',
        category: `${job.kind}-worker-startup-retry`,
        message: `The ${job.kind} worker crashed before startup; creating one fresh worker.`,
        level: 'warning',
        data: getWorkerErrorDetails(event),
      })
    } catch {
      // A diagnostic consumer must not prevent the one bounded startup retry.
    }
    try {
      postJobRequest(job)
    } catch (restartError) {
      failJob(
        job,
        toError(restartError, `The ${job.kind} worker could not restart.`),
      )
    }
    return
  }

  failJob(job, createWorkerCrashError(event, job.kind))
}

function settleSuccessfulJob(
  job: ActiveTranscriptionJob,
  result: TranscriptionResult,
): void
function settleSuccessfulJob(
  job: ActiveRegenerationJob,
  result: RegenerationResult,
): void
function settleSuccessfulJob(
  job: ActiveJob,
  result: TranscriptionResult | RegenerationResult,
): void {
  if (job.settled || activeJob !== job) {
    return
  }

  reportWorkerMessageMetrics(job)
  job.settled = true
  activeJob = null
  job.partialSegments = []
  scheduleIdleEviction()
  if (job.kind === 'transcription') {
    job.resolve(result as TranscriptionResult)
  } else {
    job.resolve(result as RegenerationResult)
  }
}

function failJob(job: ActiveJob, error: Error): void {
  if (job.settled) {
    return
  }

  reportWorkerMessageMetrics(job)
  job.settled = true
  if (activeJob === job) {
    activeJob = null
  }
  job.partialSegments = []
  terminateSharedWorker()
  job.reject(error)
}

function cancelJob(job: ActiveJob, message: string): void {
  if (job.settled || activeJob !== job) {
    return
  }

  reportWorkerMessageMetrics(job)
  job.settled = true
  activeJob = null
  job.partialSegments = []
  try {
    sharedWorker?.postMessage({ type: 'cancel', jobId: job.jobId } satisfies WorkerRequest)
  } finally {
    terminateSharedWorker()
    job.reject(new Error(message))
  }
}

function applyPartialDelta(
  previous: RawTranscriptionSegment[],
  delta: WorkerPartialDelta,
): RawTranscriptionSegment[] {
  if (
    !Number.isInteger(delta.replaceFromIndex) ||
    !Number.isInteger(delta.totalSegments) ||
    delta.replaceFromIndex < 0 ||
    delta.replaceFromIndex > previous.length ||
    delta.totalSegments < delta.replaceFromIndex
  ) {
    throw new Error('The transcription worker returned an invalid partial-result delta.')
  }

  const next = [...previous.slice(0, delta.replaceFromIndex), ...delta.segments]
  if (next.length !== delta.totalSegments) {
    throw new Error('The transcription worker partial-result delta had an inconsistent segment count.')
  }
  return next
}

function transcriptText(segments: RawTranscriptionSegment[]): string {
  return segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim()
}

function cloneRawSegments(segments: RawTranscriptionSegment[]): RawTranscriptionSegment[] {
  return segments.map((segment) => ({
    ...segment,
    words: segment.words?.map((word) => ({ ...word })),
  }))
}

function recordWorkerMessage(job: ActiveJob, event: WorkerEvent): void {
  const bytes = approximateJsonBytes(event)
  job.workerMessageCount += 1
  job.workerMessageBytes += bytes
  job.workerMessageCountsByType[event.type] = (job.workerMessageCountsByType[event.type] ?? 0) + 1
  job.workerMessageBytesByType[event.type] = (job.workerMessageBytesByType[event.type] ?? 0) + bytes
}

function reportWorkerMessageMetrics(job: ActiveJob): void {
  if (job.workerMessageMetricsReported) {
    return
  }
  job.workerMessageMetricsReported = true
  try {
    job.callbacks.onDiagnostic?.({
      source: 'app',
      category: 'worker-message-metrics',
      message: 'Measured worker-to-main-thread messages for the completed local job.',
      jobId: job.jobId,
      data: {
        jobKind: job.kind,
        messageCount: job.workerMessageCount,
        approximateJsonBytes: job.workerMessageBytes,
        messageCountsByType: job.workerMessageCountsByType,
        approximateJsonBytesByType: job.workerMessageBytesByType,
      },
    })
  } catch {
    // Diagnostics must never prevent a transcription job from settling.
  }
}

function evictWarmWorkerForLargeMedia(
  file: File,
  callbacks: Pick<TranscriptionCallbacks, 'onDiagnostic'>,
): void {
  if (!sharedWorker || !Number.isFinite(file.size) || file.size < LARGE_MEDIA_WARM_WORKER_EVICTION_BYTES) {
    return
  }

  terminateSharedWorker()
  try {
    callbacks.onDiagnostic?.({
      source: 'app',
      category: 'warm-worker-evicted-for-large-media',
      message: 'Released the warm speech model before extracting a large media file.',
      data: {
        fileSize: file.size,
        thresholdBytes: LARGE_MEDIA_WARM_WORKER_EVICTION_BYTES,
      },
    })
  } catch {
    // Diagnostics must never prevent a transcription job from starting.
  }
}

function approximateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}

function scheduleIdleEviction(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!activeJob) {
      terminateSharedWorker()
    }
  }, WORKER_IDLE_TIMEOUT_MS)
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function terminateSharedWorker(): void {
  clearIdleTimer()
  const worker = sharedWorker
  sharedWorker = null
  if (!worker) {
    return
  }
  worker.onmessage = null
  worker.onerror = null
  worker.terminate()
}

function rejectedJob<T>(message: string): { done: Promise<T>; cancel: () => void } {
  return {
    done: Promise.reject(new Error(message)),
    cancel: () => undefined,
  }
}

function createWorkerCrashError(event: ErrorEvent, jobKind: 'regeneration' | 'transcription'): Error {
  const location = event.filename
    ? ` (${event.filename}${event.lineno ? `:${event.lineno}${event.colno ? `:${event.colno}` : ''}` : ''})`
    : ''
  const message = event.message?.trim()

  return new Error(
    message
      ? `The ${jobKind} worker crashed: ${message}${location}`
      : `The ${jobKind} worker crashed before it could report an error${location}.`,
  )
}

function getWorkerErrorDetails(event: ErrorEvent): Record<string, unknown> {
  return {
    message: event.message || undefined,
    filename: event.filename || undefined,
    line: event.lineno || undefined,
    column: event.colno || undefined,
    error: event.error instanceof Error
      ? { name: event.error.name, message: event.error.message, stack: event.error.stack }
      : undefined,
  }
}

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage)
}

function createJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
