export type SpeechRegion = {
  startTime: number
  endTime: number
  /** Unpadded detector evidence. Context padding is represented by startTime/endTime. */
  rawStartTime?: number
  rawEndTime?: number
  averageRms?: number
  confidence?: number
}

export type SpeechActivityOptions = {
  frameMs: number
  hopMs: number
  minSpeechMs: number
  mergeGapMs: number
  prePaddingMs: number
  postPaddingMs: number
  noiseFloorMultiplier: number
  minimumRmsFloor: number
  speechOffThresholdRatio: number
  noiseAdaptationRate: number
}

export const DEFAULT_SPEECH_ACTIVITY_OPTIONS: SpeechActivityOptions = {
  frameMs: 30,
  hopMs: 10,
  minSpeechMs: 250,
  mergeGapMs: 350,
  prePaddingMs: 200,
  postPaddingMs: 300,
  noiseFloorMultiplier: 2.5,
  minimumRmsFloor: 0.003,
  speechOffThresholdRatio: 0.72,
  noiseAdaptationRate: 0.025,
}

/** Compact frame data retained for deterministic, pause-aware window planning. */
export type SpeechActivityFrameSeries = {
  sampleRate: number
  frameSamples: number
  hopSamples: number
  startSamples: Uint32Array
  rms: Float32Array
  thresholds: Float32Array
  activity: Float32Array
  speech: Uint8Array
}

export type SpeechActivityAnalysis = {
  regions: SpeechRegion[]
  frames: SpeechActivityFrameSeries
}

type SpeechDetector = (
  samples: Float32Array,
  sampleRate: number,
  options?: Partial<SpeechActivityOptions>,
) => SpeechRegion[]

export function safelyDetectSpeechRegions(
  samples: Float32Array,
  sampleRate = 16_000,
  options?: Partial<SpeechActivityOptions>,
  detector: SpeechDetector = detectSpeechRegions,
): SpeechRegion[] {
  try {
    return detector(samples, sampleRate, options)
  } catch {
    return []
  }
}

export function detectSpeechRegions(
  samples: Float32Array,
  sampleRate = 16_000,
  options?: Partial<SpeechActivityOptions>,
): SpeechRegion[] {
  return analyzeSpeechActivity(samples, sampleRate, options).regions
}

export function analyzeSpeechActivity(
  samples: Float32Array,
  sampleRate = 16_000,
  options?: Partial<SpeechActivityOptions>,
): SpeechActivityAnalysis {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { regions: [], frames: emptyFrameSeries(sampleRate) }
  }

  const settings = { ...DEFAULT_SPEECH_ACTIVITY_OPTIONS, ...options }
  const duration = samples.length / sampleRate
  const frameSamples = Math.max(1, Math.round((positive(settings.frameMs, 30) / 1000) * sampleRate))
  const hopSamples = Math.max(1, Math.round((positive(settings.hopMs, 10) / 1000) * sampleRate))
  const frameCount = Math.ceil(samples.length / hopSamples)
  const startSamples = new Uint32Array(frameCount)
  const rms = new Float32Array(frameCount)
  const thresholds = new Float32Array(frameCount)
  const activity = new Float32Array(frameCount)
  const speech = new Uint8Array(frameCount)

  calculateRollingRms(samples, frameSamples, hopSamples, startSamples, rms)

  const sortedRms = rms.slice().sort()
  const noisePercentile = sortedRms[Math.floor((sortedRms.length - 1) * 0.2)] ?? 0
  const minimumRmsFloor = positive(settings.minimumRmsFloor, 0.003)
  const noiseFloorMultiplier = positive(settings.noiseFloorMultiplier, 2.5)
  const offThresholdRatio = clampFinite(settings.speechOffThresholdRatio, 0.1, 0.95, 0.72)
  const adaptationRate = clampFinite(settings.noiseAdaptationRate, 0.001, 0.25, 0.025)
  let localNoiseFloor = Math.max(0, noisePercentile)
  let speaking = false

  for (let index = 0; index < frameCount; index += 1) {
    const frameRms = rms[index]
    const onThreshold = Math.max(minimumRmsFloor, Math.min(0.03, localNoiseFloor * noiseFloorMultiplier))
    const offThreshold = Math.max(minimumRmsFloor * offThresholdRatio, onThreshold * offThresholdRatio)
    thresholds[index] = onThreshold

    speaking = speaking ? frameRms > offThreshold : frameRms > onThreshold
    speech[index] = speaking ? 1 : 0
    activity[index] = clampFinite(
      (frameRms - offThreshold) / Math.max(minimumRmsFloor, onThreshold - offThreshold),
      0,
      1,
      0,
    )

    // Quiet observations track the local floor quickly. Active frames can only raise
    // it slowly and by a bounded amount, so gradual noise changes recover without a
    // single speech burst immediately suppressing subsequent quiet speech.
    const boundedObservation = Math.min(frameRms, Math.max(minimumRmsFloor, localNoiseFloor * 1.25))
    const effectiveRate = speaking ? adaptationRate * 0.08 : adaptationRate
    localNoiseFloor = Math.max(0, localNoiseFloor + (boundedObservation - localNoiseFloor) * effectiveRate)
  }

  smoothSpeechFrames(speech)
  const frames = { sampleRate, frameSamples, hopSamples, startSamples, rms, thresholds, activity, speech }
  const rawRegions = collectRawRegions(frames, samples.length, settings)
  const mergeGapSeconds = Math.max(0, settings.mergeGapMs) / 1000
  const mergedRawRegions = mergeRegions(rawRegions, mergeGapSeconds)
  const prePadding = Math.max(0, settings.prePaddingMs) / 1000
  const postPadding = Math.max(0, settings.postPaddingMs) / 1000
  const paddedRegions = mergedRawRegions.map((region) => ({
    ...region,
    rawStartTime: region.rawStartTime ?? region.startTime,
    rawEndTime: region.rawEndTime ?? region.endTime,
    startTime: Math.max(0, region.startTime - prePadding),
    endTime: Math.min(duration, region.endTime + postPadding),
  }))

  return {
    frames,
    // Keep detector regions distinct even when their model-context padding
    // overlaps. Window planning can merge padded context, while coverage and
    // timing refinement still need the real pause between raw boundaries.
    regions: paddedRegions.filter((region) => region.endTime > region.startTime),
  }
}

function calculateRollingRms(
  samples: Float32Array,
  frameSamples: number,
  hopSamples: number,
  startSamples: Uint32Array,
  rms: Float32Array,
): void {
  let windowStart = 0
  let windowEnd = 0
  let sumSquares = 0

  for (let frameIndex = 0; frameIndex < startSamples.length; frameIndex += 1) {
    const startSample = frameIndex * hopSamples
    const endSample = Math.min(samples.length, startSample + frameSamples)
    startSamples[frameIndex] = startSample

    while (windowStart < Math.min(startSample, windowEnd)) {
      const value = samples[windowStart]
      sumSquares -= value * value
      windowStart += 1
    }
    if (startSample > windowEnd) {
      windowStart = startSample
      windowEnd = startSample
      sumSquares = 0
    }
    while (windowEnd < endSample) {
      const value = samples[windowEnd]
      sumSquares += value * value
      windowEnd += 1
    }

    rms[frameIndex] = Math.sqrt(Math.max(0, sumSquares) / Math.max(1, endSample - startSample))
  }
}

function collectRawRegions(
  frames: SpeechActivityFrameSeries,
  sampleCount: number,
  settings: SpeechActivityOptions,
): SpeechRegion[] {
  const minSpeechSeconds = Math.max(0, settings.minSpeechMs) / 1000
  const regions: SpeechRegion[] = []
  let runStart = -1

  for (let index = 0; index <= frames.speech.length; index += 1) {
    const isSpeech = frames.speech[index] === 1
    if (isSpeech && runStart < 0) {
      runStart = index
    }
    if (isSpeech || runStart < 0) {
      continue
    }

    const rawStartTime = frames.startSamples[runStart] / frames.sampleRate
    const finalFrameIndex = index - 1
    const rawEndTime = Math.min(
      sampleCount,
      frames.startSamples[finalFrameIndex] + frames.frameSamples,
    ) / frames.sampleRate
    if (rawEndTime - rawStartTime >= minSpeechSeconds) {
      let totalRms = 0
      let totalActivity = 0
      for (let frameIndex = runStart; frameIndex <= finalFrameIndex; frameIndex += 1) {
        totalRms += frames.rms[frameIndex]
        totalActivity += frames.activity[frameIndex]
      }
      const frameCount = finalFrameIndex - runStart + 1
      regions.push({
        startTime: rawStartTime,
        endTime: rawEndTime,
        rawStartTime,
        rawEndTime,
        averageRms: totalRms / frameCount,
        confidence: totalActivity / frameCount,
      })
    }
    runStart = -1
  }

  return regions
}

function smoothSpeechFrames(frames: Uint8Array): void {
  const original = frames.slice()
  for (let index = 1; index < frames.length - 1; index += 1) {
    if (original[index] === 1 && original[index - 1] === 0 && original[index + 1] === 0) {
      frames[index] = 0
    }
    if (original[index] === 0 && original[index - 1] === 1 && original[index + 1] === 1) {
      frames[index] = 1
    }
  }
}

function mergeRegions(regions: SpeechRegion[], maximumGapSeconds: number): SpeechRegion[] {
  const merged: SpeechRegion[] = []
  for (const region of regions) {
    const previous = merged.at(-1)
    if (previous && region.startTime - previous.endTime <= maximumGapSeconds) {
      const previousRawStart = previous.rawStartTime ?? previous.startTime
      const previousRawEnd = previous.rawEndTime ?? previous.endTime
      const regionRawStart = region.rawStartTime ?? region.startTime
      const regionRawEnd = region.rawEndTime ?? region.endTime
      const previousDuration = previousRawEnd - previousRawStart
      const regionDuration = regionRawEnd - regionRawStart
      const totalDuration = Math.max(0.001, previousDuration + regionDuration)
      previous.endTime = Math.max(previous.endTime, region.endTime)
      previous.rawStartTime = Math.min(previousRawStart, regionRawStart)
      previous.rawEndTime = Math.max(previousRawEnd, regionRawEnd)
      previous.averageRms = weightedOptional(previous.averageRms, region.averageRms, previousDuration, regionDuration, totalDuration)
      previous.confidence = weightedOptional(previous.confidence, region.confidence, previousDuration, regionDuration, totalDuration)
      continue
    }
    merged.push({ ...region })
  }
  return merged
}

function weightedOptional(
  first: number | undefined,
  second: number | undefined,
  firstWeight: number,
  secondWeight: number,
  totalWeight: number,
): number | undefined {
  return first !== undefined && second !== undefined
    ? (first * firstWeight + second * secondWeight) / totalWeight
    : first ?? second
}

function emptyFrameSeries(sampleRate: number): SpeechActivityFrameSeries {
  return {
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 0,
    frameSamples: 0,
    hopSamples: 0,
    startSamples: new Uint32Array(),
    rms: new Float32Array(),
    thresholds: new Float32Array(),
    activity: new Float32Array(),
    speech: new Uint8Array(),
  }
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(maximum, Math.max(minimum, value))
}
