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
      { startTime: 10.92, endTime: 13.18, text: 'Recovered words', confidence: 0.35 },
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
      { startTime: 10.42, endTime: 11.68, text: 'Gap words', confidence: 0.35 },
    ])
  })
})
