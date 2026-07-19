import { describe, expect, it } from 'vitest'
import {
  analyzeSpeechActivity,
  detectSpeechRegions,
  safelyDetectSpeechRegions,
} from '../transcription/speechActivity'

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
    expect(regions[0].rawStartTime).toBeCloseTo(1, 1)
    expect(regions[0].rawEndTime).toBeCloseTo(2, 1)
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

  it('matches a direct RMS calculation while scanning overlapping frames once', () => {
    const samples = new Float32Array(SAMPLE_RATE * 2)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(index * 0.017) * (0.01 + (index % 97) / 10_000)
    }

    const analysis = analyzeSpeechActivity(samples, SAMPLE_RATE, { prePaddingMs: 0, postPaddingMs: 0 })
    expect(analysis.frames.rms).toBeInstanceOf(Float32Array)
    expect(analysis.frames.activity).toBeInstanceOf(Float32Array)
    expect(analysis.frames.speech).toBeInstanceOf(Uint8Array)

    for (const frameIndex of [0, 1, 37, analysis.frames.rms.length - 1]) {
      const start = analysis.frames.startSamples[frameIndex]
      const end = Math.min(samples.length, start + analysis.frames.frameSamples)
      let sumSquares = 0
      for (let index = start; index < end; index += 1) {
        sumSquares += samples[index] * samples[index]
      }
      const expected = Math.sqrt(sumSquares / Math.max(1, end - start))
      expect(analysis.frames.rms[frameIndex]).toBeCloseTo(expected, 6)
    }
  })

  it('uses a lower off threshold so a quiet trailing phoneme does not chatter off immediately', () => {
    const analysis = analyzeSpeechActivity(
      makeAudio(2, [
        [0.5, 1, 0.01],
        [1, 1.2, 0.0025],
      ]),
      SAMPLE_RATE,
      {
        minSpeechMs: 100,
        prePaddingMs: 0,
        postPaddingMs: 0,
        noiseAdaptationRate: 0.001,
      },
    )

    expect(analysis.regions).toHaveLength(1)
    expect(analysis.regions[0].rawEndTime).toBeGreaterThanOrEqual(1.18)
  })

  it('adapts its local threshold as a noise floor rises gradually', () => {
    const samples = new Float32Array(SAMPLE_RATE * 4)
    for (let index = 0; index < samples.length; index += 1) {
      const amplitude = 0.001 + (index / samples.length) * 0.018
      samples[index] = index % 2 === 0 ? amplitude : -amplitude
    }

    const { frames } = analyzeSpeechActivity(samples, SAMPLE_RATE)
    const earlyThreshold = frames.thresholds[Math.floor(frames.thresholds.length * 0.1)]
    const lateThreshold = frames.thresholds[Math.floor(frames.thresholds.length * 0.9)]

    expect(lateThreshold).toBeGreaterThan(earlyThreshold)
  })

  it('preserves a raw pause when model-context padding overlaps', () => {
    const { regions } = analyzeSpeechActivity(
      makeAudio(2.5, [
        [0.3, 0.8, 0.06],
        [1.3, 1.8, 0.06],
      ]),
      SAMPLE_RATE,
      {
        minSpeechMs: 100,
        mergeGapMs: 100,
        prePaddingMs: 300,
        postPaddingMs: 300,
        noiseAdaptationRate: 0.001,
      },
    )

    expect(regions).toHaveLength(2)
    expect(regions[0].endTime).toBeGreaterThan(regions[1].startTime)
    expect(regions[0].rawEndTime).toBeLessThan(regions[1].rawStartTime!)
  })
})
