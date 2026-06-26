import type {
  TranscriptionProgress,
  TranscriptionResult,
  TranscriptionSettings,
  WorkerEvent,
  WorkerRequest,
} from './types'

export type TranscriptionCallbacks = {
  onProgress: (progress: TranscriptionProgress) => void
  onPartial?: (result: TranscriptionResult) => void
}

export type TranscriptionJob = {
  done: Promise<TranscriptionResult>
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

      settled = true
      worker.terminate()

      if (data.type === 'complete') {
        resolve(data.result)
        return
      }

      reject(new Error(data.error.details ? `${data.error.message}\n${data.error.details}` : data.error.message))
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
