import { describe, expect, it } from 'vitest'
import {
  MAX_WHISPER_WINDOW_SECONDS,
  createSpeechAwareTranscriptionWindowPlan,
  createTranscriptionWindowPlan,
} from '../transcription/windowing'
import type { SpeechActivityFrameSeries } from '../transcription/speechActivity'

function makeFrameSeries(durationSeconds: number, quietTimes: number[]): SpeechActivityFrameSeries {
  const sampleRate = 10
  const frameCount = durationSeconds * sampleRate
  const startSamples = Uint32Array.from({ length: frameCount }, (_, index) => index)
  const activity = new Float32Array(frameCount).fill(0.9)
  const speech = new Uint8Array(frameCount).fill(1)
  for (const quietTime of quietTimes) {
    const index = Math.round(quietTime * sampleRate)
    activity[index] = 0.01
    speech[index] = 0
  }
  return {
    sampleRate,
    frameSamples: 1,
    hopSamples: 1,
    startSamples,
    rms: new Float32Array(frameCount),
    thresholds: new Float32Array(frameCount),
    activity,
    speech,
  }
}

describe('transcription window planning', () => {
  it('keeps overlap inside Whisper\'s safe 29-second input budget', () => {
    const plan = createTranscriptionWindowPlan(120, 30, 5)

    expect(plan.windowSeconds).toBe(29)
    expect(plan.overlapSeconds).toBe(5)
    expect(plan.coreSeconds).toBe(19)

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

    expect(plan.coreSeconds).toBe(29)
    expect(plan.windows.map(({ coreStartTime, coreEndTime }) => [coreStartTime, coreEndTime])).toEqual([
      [0, 29],
      [29, 58],
      [58, 61],
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

  it('packs speech regions into model-safe windows while preserving ownership coverage', () => {
    const regions = [
      { startTime: 1, endTime: 8 },
      { startTime: 10, endTime: 18 },
      { startTime: 40, endTime: 45 },
    ]
    const plan = createSpeechAwareTranscriptionWindowPlan(50, regions)

    expect(plan.windows.length).toBeGreaterThan(1)
    for (const window of plan.windows) {
      expect(window.sliceEndTime - window.sliceStartTime).toBeLessThanOrEqual(29)
    }
    for (const region of regions) {
      expect(
        plan.windows.some(
          (window) => window.coreStartTime <= region.startTime && window.coreEndTime >= region.endTime,
        ),
      ).toBe(true)
    }
  })

  it('splits a long speech region into contiguous model-safe ownership windows', () => {
    const plan = createSpeechAwareTranscriptionWindowPlan(70, [{ startTime: 0, endTime: 70 }])

    expect(plan.windows.length).toBeGreaterThan(2)
    expect(plan.windows[0].coreStartTime).toBe(0)
    expect(plan.windows.at(-1)?.coreEndTime).toBe(70)
    for (let index = 0; index < plan.windows.length; index += 1) {
      const window = plan.windows[index]
      expect(window.sliceEndTime - window.sliceStartTime).toBeLessThanOrEqual(29)
      if (index > 0) {
        expect(window.coreStartTime).toBe(plan.windows[index - 1].coreEndTime)
      }
    }
  })

  it('moves a long-speech boundary to the lowest-activity frame near the target', () => {
    const plan = createSpeechAwareTranscriptionWindowPlan(
      70,
      [{ startTime: 0, endTime: 70 }],
      {
        activityFrames: makeFrameSeries(70, [23.8]),
        boundarySearchSeconds: 1.5,
      },
    )

    expect(plan.windows[0].coreEndTime).toBe(23.8)
    expect(plan.windows[1].coreStartTime).toBe(23.8)
    for (const window of plan.windows) {
      expect(window.sliceEndTime - window.sliceStartTime).toBeLessThanOrEqual(29)
    }
  })

  it('does not chase a pause outside the configured boundary search radius', () => {
    const plan = createSpeechAwareTranscriptionWindowPlan(
      70,
      [{ startTime: 0, endTime: 70 }],
      {
        activityFrames: makeFrameSeries(70, [25]),
        boundarySearchSeconds: 1,
      },
    )

    expect(plan.windows[0].coreEndTime).toBe(23)
  })

  it('uses exact frame sample positions and deterministic earlier tie-breaking', () => {
    const plan = createSpeechAwareTranscriptionWindowPlan(
      70,
      [{ startTime: 0, endTime: 70 }],
      {
        activityFrames: makeFrameSeries(70, [22.5, 23.5]),
        boundarySearchSeconds: 1,
      },
    )

    expect(plan.windows[0].coreEndTime).toBe(22.5)
    expect(plan.windows[1].coreStartTime).toBe(plan.windows[0].coreEndTime)
  })

  it('falls back to deterministic duration splits for genuinely continuous speech', () => {
    const plan = createSpeechAwareTranscriptionWindowPlan(
      70,
      [{ startTime: 0, endTime: 70 }],
      {
        activityFrames: makeFrameSeries(70, []),
        boundarySearchSeconds: 1.5,
      },
    )

    expect(plan.windows[0].coreEndTime).toBe(23)
    expect(plan.windows.at(-1)?.coreEndTime).toBe(70)
  })

  it('finds late pause boundaries without rescanning earlier frame history', () => {
    const frames = makeFrameSeries(400, [386.8])
    const plan = createSpeechAwareTranscriptionWindowPlan(
      400,
      [{ startTime: 340, endTime: 400 }],
      { activityFrames: frames, boundarySearchSeconds: 1.5 },
    )

    expect(plan.windows[1].coreEndTime).toBe(386.8)
    expect(plan.windows.every((window) => window.sliceEndTime - window.sliceStartTime <= 29)).toBe(true)
  })
})
