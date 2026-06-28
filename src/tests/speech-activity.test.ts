import { describe, expect, it } from 'vitest'
import { detectSpeechRegions, safelyDetectSpeechRegions } from '../transcription/speechActivity'

const SAMPLE_RATE = 16_000

function makeAudio(durationSeconds: number, ranges: Array<[number, number, number]>): Float32Array {
  const samples = new Float32Array(Math.floor(durationSeconds * SAMPLE_RATE))
  for (const [startTime, endTime, amplitude] of ranges) {
    const start = Math.floor(startTime * SAMPLE_RATE)
    const end = Math.min(samples.length, Math.ceil(endTime * SAMPLE_RATE))
    for (let index = start; index < end; index += 1) {
      samples[index] = index % 2 === 0 ? amplitude : -amplitude
    }
  }
  return samples
}

describe('speech activity detection', () => {
  it('ignores silence', () => {
    expect(detectSpeechRegions(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE)).toEqual([])
  })

  it('finds and pads a speech-like region', () => {
    const regions = detectSpeechRegions(makeAudio(3, [[1, 2, 0.08]]), SAMPLE_RATE)

    expect(regions).toHaveLength(1)
    expect(regions[0].startTime).toBeCloseTo(0.8, 1)
    expect(regions[0].endTime).toBeCloseTo(2.3, 1)
    expect(regions[0].averageRms).toBeGreaterThan(0.05)
  })

  it('merges nearby padded speech and clamps it to the audio bounds', () => {
    const regions = detectSpeechRegions(
      makeAudio(2, [
        [0, 0.7, 0.06],
        [0.9, 2, 0.07],
      ]),
      SAMPLE_RATE,
    )

    expect(regions).toHaveLength(1)
    expect(regions[0].startTime).toBe(0)
    expect(regions[0].endTime).toBe(2)
  })

  it('returns no regions when optional speech analysis fails', () => {
    const regions = safelyDetectSpeechRegions(new Float32Array(10), SAMPLE_RATE, undefined, () => {
      throw new Error('analysis failed')
    })

    expect(regions).toEqual([])
  })
})
