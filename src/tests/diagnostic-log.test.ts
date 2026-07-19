import { afterEach, describe, expect, it, vi } from 'vitest'
import { summarizeAsrResult, summarizeSegments } from '../diagnostics/asrDiagnostics'
import { DiagnosticLog } from '../diagnostics/diagnosticLog'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('diagnostic log', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists structured events and restores them in sequence', () => {
    const storage = new MemoryStorage()
    const now = () => new Date('2026-06-28T08:00:00.000Z')
    const first = new DiagnosticLog(storage, { now, sessionId: 'session-one' })

    first.record({ source: 'app', category: 'job', message: 'Started', data: { model: 'tiny' } })
    first.record({ source: 'transcription-worker', category: 'window', message: 'Normalized', jobId: 'job-1' })
    first.flush()

    const restored = new DiagnosticLog(storage, { now, sessionId: 'session-two' })
    expect(restored.getEvents()).toMatchObject([
      { sequence: 1, sessionId: 'session-one', category: 'job', message: 'Started' },
      { sequence: 2, sessionId: 'session-one', category: 'window', jobId: 'job-1' },
    ])
  })

  it('bounds event count and truncates oversized recognized text with its original length', () => {
    const storage = new MemoryStorage()
    const log = new DiagnosticLog(storage, {
      maxEvents: 2,
      maxStringLength: 40,
      now: () => new Date('2026-06-28T08:00:00.000Z'),
      sessionId: 'bounded',
    })

    log.record({ source: 'app', category: 'one', message: 'one' })
    log.record({ source: 'app', category: 'two', message: 'two' })
    log.record({
      source: 'app',
      category: 'three',
      message: 'three',
      data: { recognizedText: 'looping phrase '.repeat(20) },
    })

    const events = log.getEvents()
    expect(events.map((event) => event.category)).toEqual(['two', 'three'])
    expect(events[1].data).toMatchObject({
      recognizedText: expect.objectContaining({ truncated: true, originalLength: 300 }),
    })
  })

  it('keeps recording in memory when browser storage fails', () => {
    const failingStorage = new MemoryStorage()
    failingStorage.setItem = () => {
      throw new Error('quota exceeded')
    }
    const log = new DiagnosticLog(failingStorage, { sessionId: 'memory-only' })

    expect(() => log.record({ source: 'app', category: 'safe', message: 'Still recorded' })).not.toThrow()
    expect(log.getEvents()).toHaveLength(1)
  })

  it('coalesces rapid diagnostic events into one deferred storage write', () => {
    vi.useFakeTimers()
    const storage = new MemoryStorage()
    const write = vi.spyOn(storage, 'setItem')
    const log = new DiagnosticLog(storage, { sessionId: 'debounced', persistDelayMs: 50 })

    log.record({ source: 'app', category: 'one', message: 'one' })
    log.record({ source: 'app', category: 'two', message: 'two' })
    log.record({ source: 'app', category: 'three', message: 'three' })

    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(49)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledOnce()
  })

  it('creates a versioned report with environment and reproduction context', () => {
    const log = new DiagnosticLog(new MemoryStorage(), {
      now: () => new Date('2026-06-28T08:00:00.000Z'),
      sessionId: 'report',
    })
    log.record({ source: 'app', category: 'job', message: 'Started' })

    const report = log.createReport(
      { subtitleCount: 12, video: { name: 'sample.mp4', size: 1234, duration: 30 } },
      { userAgent: 'test-browser', language: 'en-US', hardwareConcurrency: 8, crossOriginIsolated: true },
    )

    expect(report).toMatchObject({
      schemaVersion: 1,
      exportedAt: '2026-06-28T08:00:00.000Z',
      environment: { userAgent: 'test-browser', hardwareConcurrency: 8 },
      context: { subtitleCount: 12, video: { name: 'sample.mp4' } },
      events: [{ category: 'job' }],
    })
  })
})

describe('ASR diagnostic summaries', () => {
  it('captures repetition evidence and timestamped chunk samples without model binaries', () => {
    const repeated = 'can be a person who '.repeat(30).trim()
    const summary = summarizeAsrResult({
      text: repeated,
      chunks: [
        { timestamp: [1, 2], text: 'can be a person who' },
        { timestamp: [2, 3], text: 'can be a person who' },
      ],
    })

    expect(summary.text).toMatchObject({ length: repeated.length, tokenCount: 150 })
    expect(summary.text?.repetition?.occurrences).toBeGreaterThan(10)
    expect(summary.chunkCount).toBe(2)
    expect(summary.chunks?.[0]).toMatchObject({ timestamp: [1, 2], text: 'can be a person who' })
  })

  it('summarizes normalized segments with timing, confidence, words, and repetition flags', () => {
    const segments = summarizeSegments([
      {
        startTime: 4,
        endTime: 7,
        text: 'Thank you. Thank you. Thank you. Thank you.',
        confidence: 0.35,
        words: [{ text: 'Thank', startTime: 4, endTime: 4.5 }],
      },
    ])

    expect(segments).toMatchObject({
      count: 1,
      segments: [
        {
          startTime: 4,
          endTime: 7,
          confidence: 0.35,
          wordCount: 1,
          text: expect.objectContaining({ repetition: expect.any(Object) }),
        },
      ],
    })
  })
})
