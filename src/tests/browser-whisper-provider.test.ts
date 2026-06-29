import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startBrowserWhisperRegeneration,
  startBrowserWhisperTranscription,
} from '../transcription/browserWhisperProvider'
import { DEFAULT_TRANSCRIPTION_SETTINGS, type WorkerEvent } from '../transcription/types'

class MockWorker {
  static instances: MockWorker[] = []
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    MockWorker.instances.push(this)
  }

  emit(data: WorkerEvent): void {
    this.onmessage?.({ data } as MessageEvent<WorkerEvent>)
  }

  emitError(message = ''): void {
    this.onerror?.({
      message,
      filename: 'transcription.worker.js',
      lineno: 1,
      colno: 1,
    } as ErrorEvent)
  }
}

describe('browser Whisper diagnostic events', () => {
  beforeEach(() => {
    MockWorker.instances = []
    vi.stubGlobal('Worker', MockWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards diagnostics without settling or terminating the worker job', async () => {
    const onDiagnostic = vi.fn()
    const job = startBrowserWhisperTranscription(
      new File(['video'], 'sample.mp4', { type: 'video/mp4' }),
      DEFAULT_TRANSCRIPTION_SETTINGS,
      { onProgress: vi.fn(), onDiagnostic },
    )
    const worker = MockWorker.instances[0]
    const diagnostic = {
      source: 'transcription-worker' as const,
      category: 'asr-window-result',
      message: 'Captured raw ASR output.',
      jobId: 'job-1',
      data: { textLength: 9000 },
    }

    worker.emit({ type: 'diagnostic', event: diagnostic })

    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic)
    expect(worker.terminate).not.toHaveBeenCalled()

    worker.emit({
      type: 'complete',
      result: { modelId: 'model', segments: [], text: '' },
    })
    await expect(job.done).resolves.toMatchObject({ modelId: 'model' })
  })

  it('restarts regeneration once when the worker crashes before its first message', async () => {
    const file = new File(['video'], 'sample.mp4', { type: 'video/mp4' })
    const range = { startTime: 12, endTime: 18 }
    const onDiagnostic = vi.fn()
    const job = startBrowserWhisperRegeneration(
      file,
      DEFAULT_TRANSCRIPTION_SETTINGS,
      range,
      60,
      5,
      { onProgress: vi.fn(), onDiagnostic },
    )
    void job.done.catch(() => undefined)
    const firstWorker = MockWorker.instances[0]

    firstWorker.emitError()

    expect(firstWorker.terminate).toHaveBeenCalledOnce()
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      source: 'app',
      category: 'regeneration-worker-startup-retry',
      level: 'warning',
    }))
    expect(MockWorker.instances).toHaveLength(2)
    const restartedWorker = MockWorker.instances[1]
    expect(restartedWorker.postMessage).toHaveBeenCalledWith({
      type: 'regenerate',
      file,
      settings: DEFAULT_TRANSCRIPTION_SETTINGS,
      range,
      videoDuration: 60,
      alternativeCount: 5,
    })

    restartedWorker.emit({
      type: 'regeneration-complete',
      result: { range, candidates: [], modelId: DEFAULT_TRANSCRIPTION_SETTINGS.modelId },
    })

    await expect(job.done).resolves.toMatchObject({ range })
  })

  it('reports browser worker details when the fresh startup also fails', async () => {
    const job = startBrowserWhisperRegeneration(
      new File(['video'], 'sample.mp4', { type: 'video/mp4' }),
      DEFAULT_TRANSCRIPTION_SETTINGS,
      { startTime: 12, endTime: 18 },
      60,
      4,
      { onProgress: vi.fn() },
    )
    const rejection = expect(job.done).rejects.toThrow(
      'The regeneration worker crashed: Failed to load module script. (transcription.worker.js:1:1)',
    )

    MockWorker.instances[0].emitError()
    MockWorker.instances[1].emitError('Failed to load module script.')

    await rejection
    expect(MockWorker.instances).toHaveLength(2)
  })
})
