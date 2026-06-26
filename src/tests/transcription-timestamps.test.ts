import { describe, expect, it } from 'vitest'
import { normalizeAsrChunks, placeChunkOnTimeline } from '../transcription/timestampNormalization'

describe('transcription window timestamp normalization', () => {
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
    expect(normalizeAsrChunks([], 'Untimed fallback text.')).toEqual([
      { startTime: 0, endTime: 1.571, text: 'Untimed fallback text.' },
    ])
  })
})
