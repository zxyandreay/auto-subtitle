import type {
  RegenerationRange,
  RegenerationResult,
  TranscriptionProgress,
  TranscriptionResult,
  TranscriptionSettings,
  WorkerEvent,
  WorkerRequest,
} from './types'
import type { DiagnosticEventInput } from '../diagnostics/types'

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

export function startBrowserWhisperTranscription(
  file: File,
  settings: TranscriptionSettings,
  callbacks: TranscriptionCallbacks,
): TranscriptionJob {
  const worker = new Worker(new URL('../workers/transcription.worker.ts', import.meta.url), {
    type: 'module',
  })

  let settled = false
  let rejectDone: (error: Error) => void = () => undefined

  const done = new Promise<TranscriptionResult>((resolve, reject) => {
    rejectDone = reject

    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const data = event.data

      if (data.type === 'progress') {
        callbacks.onProgress(data.progress)
        return
      }

      if (data.type === 'partial') {
        callbacks.onPartial?.(data.result)
        return
      }

      if (data.type === 'diagnostic') {
        callbacks.onDiagnostic?.(data.event)
        return
      }

      settled = true
      worker.terminate()

      if (data.type === 'complete') {
        resolve(data.result)
        return
      }

      if (data.type === 'error') {
        reject(new Error(data.error.details ? `${data.error.message}\n${data.error.details}` : data.error.message))
        return
      }

      reject(new Error('The transcription worker returned an unexpected result.'))
    }

    worker.onerror = (event) => {
      settled = true
      worker.terminate()
      reject(new Error(event.message || 'The transcription worker crashed.'))
    }
  })

  worker.postMessage({
    type: 'start',
    file,
    settings,
  } satisfies WorkerRequest)

  return {
    done,
    cancel: () => {
      if (settled) {
        return
      }

      settled = true
      worker.postMessage({ type: 'cancel' } satisfies WorkerRequest)
      worker.terminate()
      rejectDone(new Error('Transcription cancelled by the user.'))
    },
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
  let worker: Worker | null = null
  let settled = false
  let receivedWorkerMessage = false
  let retriedStartup = false
  let rejectDone: (error: Error) => void = () => undefined
  const request = {
    type: 'regenerate',
    file,
    settings,
    range,
    videoDuration,
    alternativeCount,
  } satisfies WorkerRequest

  const done = new Promise<RegenerationResult>((resolve, reject) => {
    rejectDone = reject

    const startWorker = () => {
      const activeWorker = new Worker(new URL('../workers/transcription.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker = activeWorker

      activeWorker.onmessage = (event: MessageEvent<WorkerEvent>) => {
        receivedWorkerMessage = true
        const data = event.data

        if (data.type === 'progress') {
          callbacks.onProgress(data.progress)
          return
        }

        if (data.type === 'partial') {
          return
        }

        if (data.type === 'diagnostic') {
          callbacks.onDiagnostic?.(data.event)
          return
        }

        settled = true
        activeWorker.terminate()

        if (data.type === 'regeneration-complete') {
          resolve(data.result)
          return
        }

        if (data.type === 'error') {
          reject(new Error(data.error.details ? `${data.error.message}\n${data.error.details}` : data.error.message))
          return
        }

        reject(new Error('The regeneration worker returned an unexpected result.'))
      }

      activeWorker.onerror = (event) => {
        activeWorker.terminate()

        if (!settled && !receivedWorkerMessage && !retriedStartup) {
          retriedStartup = true
          callbacks.onDiagnostic?.({
            source: 'app',
            category: 'regeneration-worker-startup-retry',
            message: 'The regeneration worker crashed before startup; creating one fresh worker.',
            level: 'warning',
            data: getWorkerErrorDetails(event),
          })
          try {
            startWorker()
          } catch (restartError) {
            settled = true
            reject(new Error(
              restartError instanceof Error
                ? `The regeneration worker could not restart: ${restartError.message}`
                : 'The regeneration worker could not restart.',
            ))
          }
          return
        }

        settled = true
        reject(createWorkerCrashError(event, 'regeneration'))
      }

      activeWorker.postMessage(request)
    }

    startWorker()
  })

  return {
    done,
    cancel: () => {
      if (settled) {
        return
      }

      settled = true
      worker?.postMessage({ type: 'cancel' } satisfies WorkerRequest)
      worker?.terminate()
      rejectDone(new Error('Regeneration cancelled by the user.'))
    },
  }
}

function createWorkerCrashError(event: ErrorEvent, jobKind: 'regeneration' | 'transcription'): Error {
  const label = jobKind === 'regeneration' ? 'regeneration' : 'transcription'
  const location = event.filename
    ? ` (${event.filename}${event.lineno ? `:${event.lineno}${event.colno ? `:${event.colno}` : ''}` : ''})`
    : ''
  const message = event.message?.trim()

  return new Error(
    message
      ? `The ${label} worker crashed: ${message}${location}`
      : `The ${label} worker crashed before it could report an error${location}.`,
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
