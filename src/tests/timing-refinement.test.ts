import { describe, expect, it } from 'vitest'
import { reconcileBoundarySegments } from '../transcription/reconciliation'
import { refineSegmentsToSpeechBoundaries } from '../transcription/timingRefinement'

describe('speech-boundary timing refinement', () => {
  it('snaps subtitle timing to nearby speech boundaries with padding', () => {
    const refined = refineSegmentsToSpeechBoundaries(
      [{ startTime: 1.12, endTime: 2.9, text: 'Speech-aligned caption' }],
      [{ startTime: 1, endTime: 3 }],
    )

    expect(refined[0].startTime).toBe(0.92)
    expect(refined[0].endTime).toBe(3.18)
  })

  it('does not snap across neighboring subtitles', () => {
    const refined = refineSegmentsToSpeechBoundaries(
      [
        { startTime: 1, endTime: 2, text: 'first' },
        { startTime: 2.08, endTime: 3, text: 'second' },
      ],
      [
        { startTime: 0.95, endTime: 2.05 },
        { startTime: 2, endTime: 3.1 },
      ],
      { minimumGapSeconds: 0.08 },
    )

    expect(refined[0].endTime).toBeLessThanOrEqual(refined[1].startTime - 0.08)
    expect(refined[0].endTime).toBeGreaterThan(refined[0].startTime)
    expect(refined[1].endTime).toBeGreaterThan(refined[1].startTime)
  })

  it('evaluates adjacent start and end snaps together before applying them', () => {
    const refined = refineSegmentsToSpeechBoundaries(
      [
        { startTime: 1, endTime: 2, text: 'first' },
        { startTime: 2.35, endTime: 3.5, text: 'second' },
      ],
      [
        { startTime: 1, endTime: 2.07 },
        { startTime: 2.23, endTime: 3.5 },
      ],
      { minimumGapSeconds: 0.08 },
    )

    expect(refined[0].endTime).toBeLessThanOrEqual(refined[1].startTime - 0.08)
  })
})

describe('adjacent-window reconciliation', () => {
  it('removes duplicate overlap text near a core boundary', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 23, endTime: 26.2, text: 'We need accurate subtitle timing.' }],
      [{ startTime: 25.4, endTime: 27, text: 'We need accurate subtitle timing' }],
      26,
    )

    expect(reconciled).toHaveLength(1)
    expect(reconciled[0].text).toBe('We need accurate subtitle timing.')
  })

  it('preserves unique words after a matching suffix and prefix', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 23, endTime: 26, text: 'We need better subtitle timing' }],
      [{ startTime: 25.5, endTime: 26.2, text: 'subtitle timing without missing words' }],
      26,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual([
      'We need better subtitle timing',
      'without missing words',
    ])
    expect(reconciled[1].startTime).toBeGreaterThanOrEqual(reconciled[0].endTime)
  })
})
