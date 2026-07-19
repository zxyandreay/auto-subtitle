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

    expect(refined[0].endTime).toBeLessThanOrEqual(refined[1].startTime)
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

  it('uses raw VAD evidence without applying model-context padding twice', () => {
    const refined = refineSegmentsToSpeechBoundaries(
      [{ startTime: 1.1, endTime: 1.9, text: 'Raw boundaries' }],
      [{ startTime: 0.8, endTime: 2.3, rawStartTime: 1, rawEndTime: 2 }],
    )

    expect(refined[0].startTime).toBe(0.92)
    expect(refined[0].endTime).toBe(2.18)
  })

  it('prefers word timestamps over conflicting VAD evidence', () => {
    const words = [
      { text: 'word', startTime: 1.2, endTime: 1.5 },
      { text: 'timing', startTime: 1.55, endTime: 1.8 },
    ]
    const refined = refineSegmentsToSpeechBoundaries(
      [{ startTime: 1, endTime: 2, text: 'word timing', words }],
      [{ startTime: 0.7, endTime: 2.4, rawStartTime: 0.9, rawEndTime: 2.1 }],
    )

    expect(refined[0].startTime).toBe(1.12)
    expect(refined[0].endTime).toBe(1.98)
    expect(refined[0].words).toEqual(words)
  })

  it('leaves already-correct word-padded timestamps unchanged', () => {
    const refined = refineSegmentsToSpeechBoundaries(
      [
        {
          startTime: 0.92,
          endTime: 2.18,
          text: 'already correct',
          words: [
            { text: 'already', startTime: 1, endTime: 1.4 },
            { text: 'correct', startTime: 1.5, endTime: 2 },
          ],
        },
      ],
      [{ startTime: 0.5, endTime: 2.5, rawStartTime: 0.8, rawEndTime: 2.2 }],
    )

    expect(refined[0].startTime).toBe(0.92)
    expect(refined[0].endTime).toBe(2.18)
  })

  it('resolves overlap even when the original cue timestamps overlap', () => {
    const refined = refineSegmentsToSpeechBoundaries(
      [
        { startTime: 1, endTime: 2.1, text: 'first' },
        { startTime: 2.05, endTime: 3, text: 'second' },
      ],
      [],
      { minimumGapSeconds: 0.08 },
    )

    expect(refined[0].endTime).toBeLessThanOrEqual(refined[1].startTime)
    expect(refined[0].endTime).toBeGreaterThan(refined[0].startTime)
    expect(refined[1].endTime).toBeGreaterThan(refined[1].startTime)
  })

  it('does not cut rapid word evidence to manufacture the configured display gap', () => {
    const refined = refineSegmentsToSpeechBoundaries(
      [
        {
          startTime: 0.4,
          endTime: 1,
          text: 'first response',
          words: [{ text: 'response', startTime: 0.67, endTime: 1 }],
        },
        {
          startTime: 1.05,
          endTime: 1.6,
          text: 'second response',
          words: [{ text: 'second', startTime: 1.05, endTime: 1.35 }],
        },
      ],
      [],
      { minimumGapSeconds: 0.08 },
    )

    expect(refined[0].endTime).toBe(1)
    expect(refined[1].startTime).toBe(1.05)
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

  it('preserves boundary punctuation when trimming a duplicated prefix', () => {
    const reconciled = reconcileBoundarySegments(
      [{
        startTime: 23,
        endTime: 26,
        text: 'hello there',
        words: [
          { startTime: 23, endTime: 24, text: 'hello' },
          { startTime: 24.2, endTime: 25.8, text: 'there' },
        ],
      }],
      [{ startTime: 25.5, endTime: 27, text: 'hello there, friend' }],
      26,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual(['hello there,', 'friend'])
    expect(reconciled[0].words?.at(-1)?.text).toBe('there,')
  })

  it('preserves punctuation when the overlap consumes a whole incoming segment', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 23, endTime: 26, text: 'we say hello there' }],
      [
        { startTime: 25, endTime: 26.2, text: 'hello there,' },
        { startTime: 26, endTime: 27, text: 'friend' },
      ],
      26,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual(['we say hello there,', 'friend'])
  })

  it('trims word metadata and uses the first retained word timestamp', () => {
    const reconciled = reconcileBoundarySegments(
      [
        {
          startTime: 1,
          endTime: 2,
          text: 'one two',
          words: [
            { text: 'one', startTime: 1, endTime: 1.3 },
            { text: 'two', startTime: 1.4, endTime: 1.7 },
          ],
        },
      ],
      [
        {
          startTime: 1.4,
          endTime: 2.8,
          text: 'one two three four',
          words: [
            { text: 'one', startTime: 1.05, endTime: 1.3 },
            { text: 'two', startTime: 1.4, endTime: 1.7 },
            { text: 'three', startTime: 2.1, endTime: 2.35 },
            { text: 'four', startTime: 2.4, endTime: 2.7 },
          ],
        },
      ],
      2,
    )

    expect(reconciled).toHaveLength(2)
    expect(reconciled[1].text).toBe('three four')
    expect(reconciled[1].startTime).toBe(2.1)
    expect(reconciled[1].endTime).toBe(2.7)
    expect(reconciled[1].words?.map((word) => word.text)).toEqual(['three', 'four'])
  })

  it('aligns a bounded sequence of segments on both sides of a boundary', () => {
    const reconciled = reconcileBoundarySegments(
      [
        { startTime: 22, endTime: 24, text: 'alpha beta' },
        { startTime: 24, endTime: 26, text: 'gamma delta' },
      ],
      [
        { startTime: 23.5, endTime: 24.8, text: 'alpha beta' },
        { startTime: 24.8, endTime: 27, text: 'gamma delta new words' },
      ],
      26,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual([
      'alpha beta',
      'gamma delta',
      'new words',
    ])
  })

  it('preserves an intentional repeated phrase when its timing does not overlap', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 1, text: 'Thank you again' }],
      [{ startTime: 1.1, endTime: 2.1, text: 'Thank you again' }],
      1,
    )

    expect(reconciled).toHaveLength(2)
  })

  it('deduplicates one-word segment-timestamp overlap without word metadata', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 1.2, text: 'Hello' }],
      [{ startTime: 0.9, endTime: 1.8, text: 'hello.' }],
      1,
    )

    expect(reconciled).toHaveLength(1)
  })

  it('preserves an adjacent intentional one-word repeat', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 0.8, text: 'No' }],
      [{ startTime: 0.9, endTime: 1.5, text: 'No' }],
      0.8,
    )

    expect(reconciled).toHaveLength(2)
  })

  it('does not deduplicate order-changing text with the same bag of words', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 1.2, text: 'dog bites man' }],
      [{ startTime: 0.8, endTime: 2, text: 'man bites dog' }],
      1,
    )

    expect(reconciled).toHaveLength(2)
  })

  it('uses a character fallback for languages without whitespace', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 1.2, text: '你好世界' }],
      [{ startTime: 0.9, endTime: 2, text: '世界和平' }],
      1.2,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual(['你好世界', '和平'])
  })

  it('preserves a unique no-word suffix when both candidates end together', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 2, text: 'alpha beta' }],
      [{ startTime: 1, endTime: 2, text: 'alpha beta unique ending' }],
      2,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual(['alpha beta', 'unique ending'])
    expect(reconciled[1].startTime).toBe(1.5)
    expect(reconciled[1].endTime).toBe(2)
  })

  it('prefers a full duplicate with usable word timestamps', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 2, text: 'alpha beta.', confidence: 0.95 }],
      [
        {
          startTime: 0.1,
          endTime: 1.9,
          text: 'alpha beta',
          confidence: 0.7,
          words: [
            { text: 'alpha', startTime: 0.2, endTime: 0.8 },
            { text: 'beta', startTime: 1, endTime: 1.7 },
          ],
        },
      ],
      2,
    )

    expect(reconciled).toHaveLength(1)
    expect(reconciled[0].text).toBe('alpha beta')
    expect(reconciled[0].words).toHaveLength(2)
  })

  it('prefers materially higher confidence before punctuation richness', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 2, text: 'alpha beta.', confidence: 0.6 }],
      [{ startTime: 0.1, endTime: 1.9, text: 'alpha beta', confidence: 0.85 }],
      2,
    )

    expect(reconciled).toEqual([
      { startTime: 0.1, endTime: 1.9, text: 'alpha beta', confidence: 0.85, words: undefined },
    ])
  })

  it('prefers richer punctuation when confidence is not materially different', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 2, text: 'alpha beta', confidence: 0.8 }],
      [{ startTime: 0.1, endTime: 1.9, text: 'alpha beta.', confidence: 0.85 }],
      2,
    )

    expect(reconciled[0].text).toBe('alpha beta.')
  })

  it('does not prefer unstable repeated punctuation', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 2, text: 'alpha beta.', confidence: 0.8 }],
      [{ startTime: 0.1, endTime: 1.9, text: 'alpha,,,, beta', confidence: 0.8 }],
      2,
    )

    expect(reconciled[0].text).toBe('alpha beta.')
  })

  it('does not replace good word timing with a punctuation-only duplicate', () => {
    const reconciled = reconcileBoundarySegments(
      [
        {
          startTime: 0,
          endTime: 2,
          text: 'alpha beta',
          confidence: 0.7,
          words: [
            { text: 'alpha', startTime: 0.1, endTime: 0.8 },
            { text: 'beta', startTime: 1, endTime: 1.7 },
          ],
        },
      ],
      [{ startTime: 0.1, endTime: 1.9, text: 'alpha, beta!', confidence: 0.95 }],
      2,
    )

    expect(reconciled).toHaveLength(1)
    expect(reconciled[0].text).toBe('alpha beta')
    expect(reconciled[0].words).toHaveLength(2)
  })

  it('uses a character fallback for Thai text without whitespace', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 1.2, text: 'สวัสดีโลก' }],
      [{ startTime: 0.9, endTime: 2, text: 'โลกสงบ' }],
      1.2,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual(['สวัสดีโลก', 'สงบ'])
  })

  it('keeps Thai combining marks distinct during boundary comparison', () => {
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 1.2, text: 'กิข' }],
      [{ startTime: 0.9, endTime: 2, text: 'กีขใหม่' }],
      1.2,
    )

    expect(reconciled.map((segment) => segment.text)).toEqual(['กิข', 'กีขใหม่'])
  })

  it('bounds character comparison while retaining a unique suffix', () => {
    const repeatedBoundary = '界'.repeat(64)
    const reconciled = reconcileBoundarySegments(
      [{ startTime: 0, endTime: 1.5, text: `前${'文'.repeat(2_000)}${repeatedBoundary}` }],
      [{ startTime: 1, endTime: 2, text: `${repeatedBoundary}新` }],
      1.5,
      { maxComparisonUnits: 64 },
    )

    expect(reconciled.at(-1)?.text).toBe('新')
  })
})
