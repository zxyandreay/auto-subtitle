import type {
  RegenerationRange,
  RegenerationResult,
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
  callbacks: Pick<TranscriptionCallbacks, 'onProgress'>,
): RegenerationJob {
  const worker = new Worker(new URL('../workers/transcription.worker.ts', import.meta.url), {
    type: 'module',
  })
  let settled = false
  let rejectDone: (error: Error) => void = () => undefined

  const done = new Promise<RegenerationResult>((resolve, reject) => {
    rejectDone = reject
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const data = event.data

      if (data.type === 'progress') {
        callbacks.onProgress(data.progress)
        return
      }

      if (data.type === 'partial') {
        return
      }

      settled = true
      worker.terminate()

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

    worker.onerror = (event) => {
      settled = true
      worker.terminate()
      reject(new Error(event.message || 'The regeneration worker crashed.'))
    }
  })

  worker.postMessage({
    type: 'regenerate',
    file,
    settings,
    range,
    videoDuration,
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
      rejectDone(new Error('Regeneration cancelled by the user.'))
    },
  }
}
