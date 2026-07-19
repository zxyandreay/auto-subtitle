import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disposeBrowserWhisperWorker,
  startBrowserWhisperRegeneration,
  startBrowserWhisperTranscription,
} from '../transcription/browserWhisperProvider'
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  normalizeTranscriptionSettings,
  type TranscriptionResult,
  type WorkerEvent,
  type WorkerRequest,
} from '../transcription/types'

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

function postedRequest(worker: MockWorker, callIndex = 0): WorkerRequest {
  return worker.postMessage.mock.calls[callIndex][0] as WorkerRequest
}

function completeTranscription(worker: MockWorker, request: WorkerRequest): void {
  worker.emit({
    type: 'complete',
    jobId: request.jobId,
    result: { modelId: DEFAULT_TRANSCRIPTION_SETTINGS.modelId, segments: [], text: '' },
  })
}

describe('browser Whisper reusable worker provider', () => {
  beforeEach(() => {
    disposeBrowserWhisperWorker()
    MockWorker.instances = []
    vi.stubGlobal('Worker', MockWorker)
  })

  afterEach(() => {
    disposeBrowserWhisperWorker()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('forwards diagnostics without settling or terminating the warm worker', async () => {
    const onDiagnostic = vi.fn()
    const job = startBrowserWhisperTranscription(
      new File(['video'], 'sample.mp4', { type: 'video/mp4' }),
      DEFAULT_TRANSCRIPTION_SETTINGS,
      { onProgress: vi.fn(), onDiagnostic },
    )
    const worker = MockWorker.instances[0]
    const request = postedRequest(worker)
    const diagnostic = {
      source: 'transcription-worker' as const,
      category: 'asr-window-result',
      message: 'Captured raw ASR output.',
      jobId: request.jobId,
      data: { textLength: 9000 },
    }

    worker.emit({ type: 'diagnostic', jobId: request.jobId, event: diagnostic })

    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic)
    expect(worker.terminate).not.toHaveBeenCalled()

    completeTranscription(worker, request)
    await expect(job.done).resolves.toMatchObject({ modelId: DEFAULT_TRANSCRIPTION_SETTINGS.modelId })
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('maps a legacy CPU setting to browser WASM without rewriting legacy auto language', () => {
    const normalized = normalizeTranscriptionSettings({
      ...DEFAULT_TRANSCRIPTION_SETTINGS,
      language: 'auto',
      executionProvider: 'cpu',
    })

    expect(DEFAULT_TRANSCRIPTION_SETTINGS).toMatchObject({
      language: 'english',
      modelId: 'onnx-community/whisper-base',
    })
    expect(normalized).toMatchObject({
      changed: true,
      settings: { language: 'auto', executionProvider: 'wasm' },
    })
    expect(normalized.reason).toContain('legacy CPU')
  })

  it('reconstructs full partial snapshots from changed-suffix deltas', async () => {
    const onPartial = vi.fn()
    const job = startBrowserWhisperTranscription(
      new File(['video'], 'sample.mp4'),
      DEFAULT_TRANSCRIPTION_SETTINGS,
      { onProgress: vi.fn(), onPartial },
    )
    const worker = MockWorker.instances[0]
    const request = postedRequest(worker)

    worker.emit({
      type: 'partial',
      jobId: request.jobId,
      delta: {
        replaceFromIndex: 0,
        totalSegments: 2,
        modelId: 'model',
        segments: [
          { startTime: 0, endTime: 1, text: 'Hello' },
          { startTime: 1, endTime: 2, text: 'world' },
        ],
      },
    })
    worker.emit({
      type: 'partial',
      jobId: request.jobId,
      delta: {
        replaceFromIndex: 1,
        totalSegments: 3,
        modelId: 'model',
        segments: [
          { startTime: 1, endTime: 2, text: 'brave' },
          { startTime: 2, endTime: 3, text: 'world' },
        ],
      },
    })

    expect(onPartial).toHaveBeenNthCalledWith(1, expect.objectContaining({
      text: 'Hello world',
      segments: expect.arrayContaining([expect.objectContaining({ text: 'world' })]),
    }))
    expect(onPartial).toHaveBeenNthCalledWith(2, expect.objectContaining({
      text: 'Hello brave world',
      segments: [
        expect.objectContaining({ text: 'Hello' }),
        expect.objectContaining({ text: 'brave' }),
        expect.objectContaining({ text: 'world' }),
      ],
    }))

    completeTranscription(worker, request)
    await job.done
  })

  it('isolates internal delta state from a mutating partial callback', async () => {
    const observedSecondSnapshot: string[] = []
    let callbackCount = 0
    const onPartial = vi.fn((result: TranscriptionResult) => {
      callbackCount += 1
      if (callbackCount === 1) {
        result.segments[0].text = 'mutated by consumer'
        result.segments[0].words![0].text = 'mutated word'
      } else {
        observedSecondSnapshot.push(result.text, result.segments[0].text, result.segments[0].words![0].text)
      }
    })
    const job = startBrowserWhisperTranscription(
      new File(['video'], 'sample.mp4'),
      DEFAULT_TRANSCRIPTION_SETTINGS,
      { onProgress: vi.fn(), onPartial },
    )
    const worker = MockWorker.instances[0]
    const request = postedRequest(worker)

    worker.emit({
      type: 'partial',
      jobId: request.jobId,
      delta: {
        replaceFromIndex: 0,
        totalSegments: 1,
        modelId: 'model',
        segments: [{
          startTime: 0,
          endTime: 1,
          text: 'stable prefix',
          words: [{ startTime: 0, endTime: 1, text: 'stable prefix' }],
        }],
      },
    })
    worker.emit({
      type: 'partial',
      jobId: request.jobId,
      delta: {
        replaceFromIndex: 1,
        totalSegments: 2,
        modelId: 'model',
        segments: [{ startTime: 1, endTime: 2, text: 'new suffix' }],
      },
    })

    expect(observedSecondSnapshot).toEqual(['stable prefix new suffix', 'stable prefix', 'stable prefix'])
    completeTranscription(worker, request)
    await job.done
  })

  it('reports total worker-to-main message count and approximate bytes by event type', async () => {
    const onDiagnostic = vi.fn()
    const job = startBrowserWhisperTranscription(
      new File(['video'], 'sample.mp4'),
      DEFAULT_TRANSCRIPTION_SETTINGS,
      { onProgress: vi.fn(), onDiagnostic },
    )
    const worker = MockWorker.instances[0]
    const request = postedRequest(worker)

    worker.emit({
      type: 'progress',
      jobId: request.jobId,
      progress: { stage: 'transcribing', message: 'Working', progress: 0.5 },
    })
    worker.emit({
      type: 'diagnostic',
      jobId: request.jobId,
      event: { source: 'transcription-worker', category: 'test', message: 'Test diagnostic.' },
    })
    completeTranscription(worker, request)
    await job.done

    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      category: 'worker-message-metrics',
      data: expect.objectContaining({
        messageCount: 3,
        approximateJsonBytes: expect.any(Number),
        messageCountsByType: { progress: 1, diagnostic: 1, complete: 1 },
      }),
    }))
  })

  it('reuses one worker for sequential compatible and incompatible runtime requests', async () => {
    const file = new File(['video'], 'sample.mp4')
    const first = startBrowserWhisperTranscription(file, DEFAULT_TRANSCRIPTION_SETTINGS, { onProgress: vi.fn() })
    const worker = MockWorker.instances[0]
    const firstRequest = postedRequest(worker)
    completeTranscription(worker, firstRequest)
    await first.done

    const second = startBrowserWhisperTranscription(
      file,
      { ...DEFAULT_TRANSCRIPTION_SETTINGS, dtype: 'fp32' },
      { onProgress: vi.fn() },
    )
    const secondRequest = postedRequest(worker, 1)

    expect(MockWorker.instances).toHaveLength(1)
    expect(secondRequest.jobId).not.toBe(firstRequest.jobId)
    expect(secondRequest).toMatchObject({ type: 'start', settings: { dtype: 'fp32' } })
    completeTranscription(worker, secondRequest)
    await second.done
  })

  it('evicts a warm worker before a large media extraction', async () => {
    const firstFile = new File(['video'], 'small.mp4')
    const first = startBrowserWhisperTranscription(firstFile, DEFAULT_TRANSCRIPTION_SETTINGS, {
      onProgress: vi.fn(),
    })
    const firstWorker = MockWorker.instances[0]
    completeTranscription(firstWorker, postedRequest(firstWorker))
    await first.done

    const largeFile = new File(['video'], 'large.mp4')
    Object.defineProperty(largeFile, 'size', { value: 256 * 1024 * 1024 })
    const onDiagnostic = vi.fn()
    const second = startBrowserWhisperTranscription(largeFile, DEFAULT_TRANSCRIPTION_SETTINGS, {
      onProgress: vi.fn(),
      onDiagnostic,
    })

    expect(firstWorker.terminate).toHaveBeenCalledOnce()
    expect(MockWorker.instances).toHaveLength(2)
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      category: 'warm-worker-evicted-for-large-media',
    }))

    const secondWorker = MockWorker.instances[1]
    completeTranscription(secondWorker, postedRequest(secondWorker))
    await second.done
  })

  it('rejects a concurrent request without posting it to the active worker', async () => {
    const file = new File(['video'], 'sample.mp4')
    const first = startBrowserWhisperTranscription(file, DEFAULT_TRANSCRIPTION_SETTINGS, { onProgress: vi.fn() })
    const worker = MockWorker.instances[0]
    const second = startBrowserWhisperTranscription(file, DEFAULT_TRANSCRIPTION_SETTINGS, { onProgress: vi.fn() })

    await expect(second.done).rejects.toThrow('already running')
    expect(worker.postMessage).toHaveBeenCalledTimes(1)

    const request = postedRequest(worker)
    completeTranscription(worker, request)
    await first.done
  })

  it('terminates immediately on cancellation and creates a fresh worker for the next job', async () => {
    const file = new File(['video'], 'sample.mp4')
    const first = startBrowserWhisperTranscription(file, DEFAULT_TRANSCRIPTION_SETTINGS, { onProgress: vi.fn() })
    const firstWorker = MockWorker.instances[0]
    const firstRequest = postedRequest(firstWorker)
    const rejection = expect(first.done).rejects.toThrow('cancelled by the user')

    first.cancel()

    await rejection
    expect(firstWorker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel', jobId: firstRequest.jobId })
    expect(firstWorker.terminate).toHaveBeenCalledOnce()

    const second = startBrowserWhisperTranscription(file, DEFAULT_TRANSCRIPTION_SETTINGS, { onProgress: vi.fn() })
    expect(MockWorker.instances).toHaveLength(2)
    const secondWorker = MockWorker.instances[1]
    const secondRequest = postedRequest(secondWorker)
    completeTranscription(secondWorker, secondRequest)
    await second.done
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
    const firstRequest = postedRequest(firstWorker)

    firstWorker.emitError()

    expect(firstWorker.terminate).toHaveBeenCalledOnce()
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      source: 'app',
      category: 'regeneration-worker-startup-retry',
      level: 'warning',
    }))
    expect(MockWorker.instances).toHaveLength(2)
    const restartedWorker = MockWorker.instances[1]
    expect(postedRequest(restartedWorker)).toEqual(firstRequest)

    restartedWorker.emit({
      type: 'regeneration-complete',
      jobId: firstRequest.jobId,
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
    expect(MockWorker.instances[1].terminate).toHaveBeenCalledOnce()
  })

  it('evicts the warm worker after the idle timeout', async () => {
    vi.useFakeTimers()
    const job = startBrowserWhisperTranscription(
      new File(['video'], 'sample.mp4'),
      DEFAULT_TRANSCRIPTION_SETTINGS,
      { onProgress: vi.fn() },
    )
    const worker = MockWorker.instances[0]
    completeTranscription(worker, postedRequest(worker))
    await job.done

    vi.advanceTimersByTime(119_999)
    expect(worker.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
