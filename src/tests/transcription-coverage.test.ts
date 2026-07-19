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

  it('uses word timing rather than the wider display interval as coverage evidence', () => {
    const coverage = calculateSubtitleCoverage(
      [
        {
          startTime: 0,
          endTime: 5,
          text: 'first second',
          words: [
            { text: 'first', startTime: 1, endTime: 2 },
            { text: 'second', startTime: 3, endTime: 4 },
          ],
        },
      ],
      5,
    )

    expect(coverage.ranges).toEqual([
      { startTime: 1, endTime: 2 },
      { startTime: 3, endTime: 4 },
    ])
    expect(coverage.coveredDuration).toBe(2)
  })

  it('checks raw speech rather than padded VAD context', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 0.8, endTime: 2.3, rawStartTime: 1, rawEndTime: 2 }],
      [],
    )

    expect(gaps).toEqual([{ startTime: 1, endTime: 2 }])
  })

  it('does not let a low-confidence fallback mask missed speech', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 0, endTime: 2 }],
      [{ startTime: 0, endTime: 2, text: 'uncertain fallback', confidence: 0.35 }],
    )

    expect(gaps).toEqual([{ startTime: 0, endTime: 2 }])
  })

  it('does not let a caption spanning mostly silence count as speech coverage', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 10, endTime: 12 }],
      [{ startTime: 0, endTime: 30, text: 'one long unsupported caption' }],
    )

    expect(gaps).toEqual([{ startTime: 10, endTime: 12 }])
  })

  it('repairs a large absolute miss even when it is below the region-wide ratio threshold', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 0, endTime: 10 }],
      [{ startTime: 0, endTime: 7, text: 'covered opening' }],
    )

    expect(gaps).toHaveLength(1)
    expect(gaps[0].startTime).toBeCloseTo(7.1, 5)
    expect(gaps[0].endTime).toBe(10)
  })

  it('does not trust word timing from a low-confidence segment', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 0, endTime: 2 }],
      [
        {
          startTime: 0,
          endTime: 2,
          text: 'uncertain words',
          confidence: 0.2,
          words: [
            { text: 'uncertain', startTime: 0, endTime: 1 },
            { text: 'words', startTime: 1, endTime: 2 },
          ],
        },
      ],
    )

    expect(gaps).toEqual([{ startTime: 0, endTime: 2 }])
  })

  it('does not let an incomplete word list promote a wide segment to coverage', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 0, endTime: 4 }],
      [
        {
          startTime: 0,
          endTime: 4,
          text: 'one two three four',
          words: [{ text: 'one', startTime: 0, endTime: 4 }],
        },
      ],
    )

    expect(gaps).toEqual([{ startTime: 0, endTime: 4 }])
  })

  it('rejects an implausibly long word interval as speech coverage', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 10, endTime: 12 }],
      [
        {
          startTime: 0,
          endTime: 30,
          text: 'hallucination',
          words: [{ text: 'hallucination', startTime: 0, endTime: 30 }],
        },
      ],
    )

    expect(gaps).toEqual([{ startTime: 10, endTime: 12 }])
  })

  it('clamps reliable word evidence to the segment and raw speech ranges', () => {
    const gaps = findUncoveredSpeechRanges(
      [{ startTime: 1, endTime: 3, rawStartTime: 1.5, rawEndTime: 2.5 }],
      [
        {
          startTime: 1.4,
          endTime: 2.6,
          text: 'bounded',
          words: [{ text: 'bounded', startTime: 1.2, endTime: 2.8 }],
        },
      ],
    )

    expect(gaps).toEqual([])
  })
})
