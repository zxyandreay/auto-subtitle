import { describe, expect, it } from 'vitest'
import { normalizeAsrChunks, normalizeAsrResult, placeChunkOnTimeline } from '../transcription/timestampNormalization'
import { isWordTimestampUnsupportedError } from '../transcription/timestampSupport'

describe('transcription window timestamp normalization', () => {
  it('recognizes common word-timestamp capability failures', () => {
    expect(isWordTimestampUnsupportedError(new Error('Token-level timestamps not available'))).toBe(true)
    expect(isWordTimestampUnsupportedError(new Error("return_timestamps: 'word' is not supported"))).toBe(true)
    expect(isWordTimestampUnsupportedError(new Error('GPU allocation failed'))).toBe(false)
  })

  it('does not recreate left-overlap speech at the later core start', () => {
    const segments = normalizeAsrChunks(
      [{ timestamp: [0.5, 2], text: 'Speech from the previous window.' }],
      'Speech from the previous window.',
      {
        offsetSeconds: 25,
        coreStartTime: 30,
        coreEndTime: 60,
      },
    )

    expect(segments).toEqual([])
  })

  it('preserves the real timestamp when a crossing chunk begins in the current core', () => {
    const segment = placeChunkOnTimeline(
      {
        startTime: 29.6,
        endTime: 30.4,
        text: 'Boundary phrase.',
      },
      {
        coreStartTime: 0,
        coreEndTime: 30,
      },
    )

    expect(segment?.startTime).toBe(29.6)
    expect(segment?.endTime).toBe(30.4)
  })

  it('assigns a boundary-crossing chunk to exactly one adjacent core', () => {
    const chunk = {
      startTime: 29.6,
      endTime: 30.4,
      text: 'Owned once.',
    }

    expect(
      placeChunkOnTimeline(chunk, {
        coreStartTime: 0,
        coreEndTime: 30,
      }),
    ).toMatchObject({ startTime: 29.6, endTime: 30.4 })
    expect(
      placeChunkOnTimeline(chunk, {
        coreStartTime: 30,
        coreEndTime: 60,
      }),
    ).toBeNull()
  })

  it('does not place a long left-overlap chunk into earlier silence', () => {
    const segment = placeChunkOnTimeline(
      {
        startTime: 1,
        endTime: 12,
        text: 'Speech recognized with long overlap context.',
      },
      {
        offsetSeconds: 25,
        coreStartTime: 30,
        coreEndTime: 60,
      },
    )

    expect(segment).toBeNull()
  })

  it('does not invent window timing when a model returns no timestamp chunks', () => {
    const segments = normalizeAsrChunks([], 'Untimed fallback text.', {
      offsetSeconds: 25,
      coreStartTime: 30,
      coreEndTime: 60,
    })

    expect(segments).toEqual([])
  })

  it('retains fallback behavior when normalization is used without windows', () => {
    expect(normalizeAsrChunks([], 'Untimed fallback text.')).toEqual([])
  })

  it('maps repair-window timestamps back to the absolute timeline', () => {
    const segment = placeChunkOnTimeline(
      { startTime: 0.4, endTime: 1.5, text: 'Recovered speech.' },
      { offsetSeconds: 20.25, coreStartTime: 20, coreEndTime: 23 },
    )

    expect(segment).toMatchObject({ startTime: 20.65, endTime: 21.75 })
  })

  it('creates a low-confidence text-only fallback only with speech evidence', () => {
    const result = normalizeAsrResult(
      { text: 'Recovered words', chunks: [] },
      {
        offsetSeconds: 10,
        coreStartTime: 10,
        coreEndTime: 15,
        speechRegions: [{ startTime: 11, endTime: 13 }],
      },
    )

    expect(result.segments).toEqual([
      { startTime: 11, endTime: 13, text: 'Recovered words', confidence: 0.35 },
    ])
  })

  it('does not create a text-only subtitle from silence', () => {
    const result = normalizeAsrResult(
      { text: 'Hallucinated silence', chunks: [] },
      { offsetSeconds: 10, coreStartTime: 10, coreEndTime: 15, speechRegions: [] },
    )

    expect(result.segments).toEqual([])
  })

  it('limits text-only repair evidence to the uncovered range', () => {
    const result = normalizeAsrResult(
      { text: 'Gap words', chunks: [] },
      {
        offsetSeconds: 8,
        fallbackStartTime: 10,
        fallbackEndTime: 12,
        speechRegions: [
          { startTime: 8, endTime: 9.5 },
          { startTime: 10.5, endTime: 11.5 },
        ],
      },
    )

    expect(result.segments).toEqual([
      { startTime: 10.5, endTime: 11.5, text: 'Gap words', confidence: 0.35 },
    ])
  })

  it.each([1, 2, 3, 5])('preserves explicit word timestamps for %i returned chunks', (wordCount) => {
    const chunks = Array.from({ length: wordCount }, (_, index) => ({
      timestamp: [index * 0.4, index * 0.4 + 0.3],
      text: `word${index + 1}`,
    }))

    const segments = normalizeAsrChunks(chunks, '', { timestampMode: 'word' })

    expect(segments).toHaveLength(1)
    expect(segments[0].words).toHaveLength(wordCount)
    expect(segments[0].text).toBe(chunks.map((chunk) => chunk.text).join(' '))
  })

  it('does not reinterpret short segment chunks as words', () => {
    const segments = normalizeAsrChunks(
      [
        { timestamp: [0, 1], text: 'One short segment.' },
        { timestamp: [1.1, 2], text: 'Another.' },
      ],
      '',
      { timestampMode: true },
    )

    expect(segments).toHaveLength(2)
    expect(segments.every((segment) => segment.words === undefined)).toBe(true)
  })

  it('keeps valid word chunks when neighboring chunk timestamps are partial or invalid', () => {
    const segments = normalizeAsrChunks(
      [
        { timestamp: [0, 0.3], text: 'kept' },
        { timestamp: [0.3, null], text: 'missing end' },
        { timestamp: ['bad', 0.9], text: 'invalid start' },
      ],
      '',
      { timestampMode: 'word' },
    )

    expect(segments).toHaveLength(1)
    expect(segments[0].words?.map((word) => word.text)).toEqual(['kept'])
  })

  it('joins punctuation and CJK word chunks without inserting damaging spaces', () => {
    const punctuation = normalizeAsrChunks(
      [
        { timestamp: [0, 0.2], text: 'Hello' },
        { timestamp: [0.2, 0.3], text: ',' },
        { timestamp: [0.3, 0.6], text: 'world' },
      ],
      '',
      { timestampMode: 'word' },
    )
    const cjk = normalizeAsrChunks(
      [
        { timestamp: [0, 0.2], text: '你' },
        { timestamp: [0.2, 0.4], text: '好' },
        { timestamp: [0.4, 0.5], text: '，' },
        { timestamp: [0.5, 0.7], text: '世' },
        { timestamp: [0.7, 0.9], text: '界' },
        { timestamp: [0.9, 1], text: '。' },
      ],
      '',
      { timestampMode: 'word' },
    )

    expect(punctuation[0].text).toBe('Hello, world')
    expect(cjk[0].text).toBe('你好，世界。')
  })

  it('suppresses ambiguous text-only fallback across disjoint speech spans', () => {
    const result = normalizeAsrResult(
      { text: 'Timing is ambiguous', chunks: [] },
      {
        timestampMode: true,
        coreStartTime: 0,
        coreEndTime: 8,
        speechRegions: [
          { startTime: 1, endTime: 2 },
          { startTime: 5, endTime: 6.5 },
        ],
      },
    )

    expect(result.segments).toEqual([])
  })

  it('does not create punctuation-only fallback captions', () => {
    const result = normalizeAsrResult(
      { text: '…?!', chunks: [] },
      { speechRegions: [{ startTime: 1, endTime: 2 }] },
    )

    expect(result.segments).toEqual([])
  })

  it('uses raw speech evidence rather than padded model context for fallback timing', () => {
    const result = normalizeAsrResult(
      { text: 'Raw evidence', chunks: [] },
      {
        timestampMode: true,
        speechRegions: [
          { startTime: 0.8, endTime: 2.3, rawStartTime: 1, rawEndTime: 2 },
        ],
      },
    )

    expect(result.segments).toEqual([
      { startTime: 1, endTime: 2, text: 'Raw evidence', confidence: 0.35 },
    ])
  })
})
