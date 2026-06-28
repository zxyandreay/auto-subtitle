import { describe, expect, it } from 'vitest'
import { createRepairWindowPlans, selectRepairSegments } from '../transcription/repair'

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
})
