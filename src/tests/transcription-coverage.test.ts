import { describe, expect, it } from 'vitest'
import { calculateSubtitleCoverage, findUncoveredSpeechRanges } from '../transcription/coverage'

describe('transcription coverage', () => {
  it('calculates merged subtitle coverage', () => {
    const coverage = calculateSubtitleCoverage(
      [
        { startTime: 0, endTime: 1, text: 'one' },
        { startTime: 0.8, endTime: 2, text: 'two' },
        { startTime: 3, endTime: 4, text: 'three' },
      ],
      6,
    )

    expect(coverage.coveredDuration).toBe(3)
    expect(coverage.audioDuration).toBe(6)
    expect(coverage.coverageRatio).toBe(0.5)
    expect(coverage.ranges).toEqual([
      { startTime: 0, endTime: 2 },
      { startTime: 3, endTime: 4 },
    ])
  })

  it('finds a materially uncovered speech range', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 0, endTime: 3 }],
      [{ startTime: 0, endTime: 0.8, text: 'covered opening' }],
    )

    expect(gaps).toHaveLength(1)
    expect(gaps[0].startTime).toBeCloseTo(0.9, 5)
    expect(gaps[0].endTime).toBe(3)
  })

  it('ignores tiny gaps between covered subtitle ranges', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 0, endTime: 2 }],
      [
        { startTime: 0, endTime: 0.9, text: 'first' },
        { startTime: 1.1, endTime: 2, text: 'second' },
      ],
    )

    expect(gaps).toEqual([])
  })
})
