import { describe, expect, it } from 'vitest'
import {
  createRepairWindowPlans,
  selectRepairSegments,
} from '../transcription/repair'

describe('transcription repair planning', () => {
  it('adds bounded context around uncovered speech', () => {
    const windows = createRepairWindowPlans([{ startTime: 10, endTime: 12 }], 30)

    expect(windows).toEqual([
      {
        gapStartTime: 10,
        gapEndTime: 12,
        sliceStartTime: 9.25,
        sliceEndTime: 12.75,
      },
    ])
  })

  it('limits repair work and skips sub-threshold gaps', () => {
    const gaps = Array.from({ length: 25 }, (_, index) => ({
      startTime: index,
      endTime: index + (index === 0 ? 0.4 : 0.8),
    }))

    expect(createRepairWindowPlans(gaps, 30)).toHaveLength(20)
  })

  it('splits a long gap into contiguous owned ranges without exceeding the model input limit', () => {
    const windows = createRepairWindowPlans([{ startTime: 0, endTime: 65 }], 65, {
      maxModelInputSeconds: 29,
      contextSeconds: 0.75,
    })

    expect(windows).toHaveLength(3)
    expect(windows[0].gapStartTime).toBe(0)
    expect(windows.at(-1)?.gapEndTime).toBe(65)
    for (let index = 0; index < windows.length; index += 1) {
      expect(windows[index].sliceEndTime - windows[index].sliceStartTime).toBeLessThanOrEqual(29)
      if (index > 0) {
        expect(windows[index].gapStartTime).toBe(windows[index - 1].gapEndTime)
      }
    }
  })

  it('deduplicates repair candidates against nearby existing segments', () => {
    const existing = [{ startTime: 9, endTime: 10.2, text: 'already captured words' }]
    const selected = selectRepairSegments(
      existing,
      [
        { startTime: 9.8, endTime: 11, text: 'Already captured words.' },
        { startTime: 10.3, endTime: 11.5, text: 'newly recovered phrase' },
      ],
      { startTime: 10.2, endTime: 12 },
    )

    expect(selected).toHaveLength(1)
    expect(selected[0].text).toBe('newly recovered phrase')
  })

  it('keeps repeated words when the matching subtitle is not near the repair range', () => {
    const selected = selectRepairSegments(
      [{ startTime: 1, endTime: 2, text: 'Thank you.' }],
      [{ startTime: 20, endTime: 21, text: 'Thank you' }],
      { startTime: 19.8, endTime: 21.2 },
    )

    expect(selected).toHaveLength(1)
  })

  it('keeps an intentional immediate repeat when its timing does not overlap', () => {
    const selected = selectRepairSegments(
      [{ startTime: 0, endTime: 1, text: 'Thank you' }],
      [{ startTime: 1.1, endTime: 2, text: 'Thank you' }],
      { startTime: 1.05, endTime: 2.1 },
    )

    expect(selected).toHaveLength(1)
    expect(selected[0].text).toBe('Thank you')
  })

  it('keeps only word-timed content owned by the uncovered gap', () => {
    const selected = selectRepairSegments(
      [
        { startTime: 8, endTime: 9.5, text: 'old context' },
        { startTime: 12.5, endTime: 14, text: 'next context' },
      ],
      [{
        startTime: 8.5,
        endTime: 13.5,
        text: 'old context recovered words next context',
        words: [
          { text: 'old', startTime: 8.6, endTime: 8.9 },
          { text: 'context', startTime: 9, endTime: 9.3 },
          { text: 'recovered', startTime: 10.2, endTime: 10.8 },
          { text: 'words', startTime: 10.9, endTime: 11.4 },
          { text: 'next', startTime: 12.6, endTime: 12.9 },
          { text: 'context', startTime: 13, endTime: 13.3 },
        ],
      }],
      { startTime: 10, endTime: 12 },
    )

    expect(selected).toHaveLength(1)
    expect(selected[0].text).toBe('recovered words')
    expect(selected[0].words?.map((word) => word.text)).toEqual(['recovered', 'words'])
    expect(selected[0]).toMatchObject({ startTime: 10.2, endTime: 11.4 })
  })

  it('prevents accepted repair candidates from overlapping one another', () => {
    const selected = selectRepairSegments(
      [],
      [
        { startTime: 10, endTime: 11.2, text: 'first recovered phrase' },
        { startTime: 10.8, endTime: 12, text: 'different second phrase' },
      ],
      { startTime: 10, endTime: 12 },
    )

    expect(selected).toHaveLength(2)
    expect(selected[0].endTime + 0.08).toBeLessThanOrEqual(selected[1].startTime)
  })

  it('preserves CJK punctuation when trimming timestamped repair words', () => {
    const selected = selectRepairSegments(
      [],
      [{
        startTime: 1,
        endTime: 2,
        text: '你好，世界。',
        words: [
          { text: '你', startTime: 1, endTime: 1.1 },
          { text: '好', startTime: 1.1, endTime: 1.2 },
          { text: '，', startTime: 1.2, endTime: 1.25 },
          { text: '世', startTime: 1.3, endTime: 1.4 },
          { text: '界', startTime: 1.4, endTime: 1.5 },
          { text: '。', startTime: 1.5, endTime: 1.55 },
        ],
      }],
      { startTime: 1, endTime: 2 },
    )

    expect(selected[0].text).toBe('你好，世界。')
  })

  it('does not keep a repaired word whose end crosses the owned gap', () => {
    const selected = selectRepairSegments(
      [],
      [{
        startTime: 1,
        endTime: 2.3,
        text: 'inside crossing',
        words: [
          { text: 'inside', startTime: 1.2, endTime: 1.6 },
          { text: 'crossing', startTime: 1.8, endTime: 2.2 },
        ],
      }],
      { startTime: 1, endTime: 2 },
    )

    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ text: 'inside', startTime: 1.2, endTime: 1.6 })
    expect(selected[0].words?.map((word) => word.text)).toEqual(['inside'])
  })

  it('rejects a different repair cue when an existing cue has the same start', () => {
    const selected = selectRepairSegments(
      [{ startTime: 1, endTime: 2, text: 'existing cue' }],
      [{ startTime: 1, endTime: 1.8, text: 'different repair' }],
      { startTime: 1, endTime: 2 },
    )

    expect(selected).toEqual([])
  })
})
