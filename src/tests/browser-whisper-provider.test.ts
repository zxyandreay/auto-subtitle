import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBrowserWhisperTranscription } from '../transcription/browserWhisperProvider'
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
})
