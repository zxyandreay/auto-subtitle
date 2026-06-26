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

  it('preserves the real timestamp of a chunk crossing a core boundary', () => {
    const segment = placeChunkOnTimeline(
      {
        startTime: 4.6,
        endTime: 5.4,
        text: 'Boundary phrase.',
      },
      {
        offsetSeconds: 25,
        coreStartTime: 30,
        coreEndTime: 60,
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
    ).toBeNull()
    expect(
      placeChunkOnTimeline(chunk, {
        coreStartTime: 30,
        coreEndTime: 60,
      }),
    ).toMatchObject({ startTime: 29.6, endTime: 30.4 })
  })

  it('still uses the core interval when a model returns no timestamp chunks', () => {
    const segments = normalizeAsrChunks([], 'Untimed fallback text.', {
      offsetSeconds: 25,
      coreStartTime: 30,
      coreEndTime: 60,
    })

    expect(segments).toEqual([
      {
        startTime: 30,
        endTime: 60,
        text: 'Untimed fallback text.',
      },
    ])
  })
})
