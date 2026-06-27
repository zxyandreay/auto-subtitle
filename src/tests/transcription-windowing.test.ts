import { describe, expect, it } from 'vitest'
import {
  MAX_WHISPER_WINDOW_SECONDS,
  createTranscriptionWindowPlan,
} from '../transcription/windowing'

describe('transcription window planning', () => {
  it('keeps overlap inside Whisper\'s 30-second input budget', () => {
    const plan = createTranscriptionWindowPlan(120, 30, 5)

    expect(plan.windowSeconds).toBe(30)
    expect(plan.overlapSeconds).toBe(5)
    expect(plan.coreSeconds).toBe(20)
    expect(plan.windows).toHaveLength(6)

    for (const window of plan.windows) {
      expect(window.sliceEndTime - window.sliceStartTime).toBeLessThanOrEqual(MAX_WHISPER_WINDOW_SECONDS)
    }
  })

  it('covers the complete timeline with contiguous, non-overlapping cores', () => {
    const duration = 73.4
    const plan = createTranscriptionWindowPlan(duration, 30, 5)

    expect(plan.windows[0]?.coreStartTime).toBe(0)
    expect(plan.windows.at(-1)?.coreEndTime).toBe(duration)

    for (let index = 1; index < plan.windows.length; index += 1) {
      expect(plan.windows[index]?.coreStartTime).toBe(plan.windows[index - 1]?.coreEndTime)
    }
  })

  it('uses the full model window as the core when overlap is disabled', () => {
    const plan = createTranscriptionWindowPlan(61, 30, 0)

    expect(plan.coreSeconds).toBe(30)
    expect(plan.windows.map(({ coreStartTime, coreEndTime }) => [coreStartTime, coreEndTime])).toEqual([
      [0, 30],
      [30, 60],
      [60, 61],
    ])
  })

  it('clamps excessive overlap without leaving gaps or exceeding the requested window', () => {
    const plan = createTranscriptionWindowPlan(50, 20, 20)

    expect(plan.overlapSeconds).toBe(5)
    expect(plan.coreSeconds).toBe(10)

    for (const window of plan.windows) {
      expect(window.sliceEndTime - window.sliceStartTime).toBeLessThanOrEqual(20)
    }
  })
})
