export type SpeechRegion = {
  startTime: number
  endTime: number
  averageRms?: number
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
}

type AnalyzedFrame = {
  startTime: number
  endTime: number
  rms: number
  speech: boolean
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
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return []
  }

  const settings = { ...DEFAULT_SPEECH_ACTIVITY_OPTIONS, ...options }
  const duration = samples.length / sampleRate
  const frameSamples = Math.max(1, Math.round((settings.frameMs / 1000) * sampleRate))
  const hopSamples = Math.max(1, Math.round((settings.hopMs / 1000) * sampleRate))
  const frames: AnalyzedFrame[] = []

  for (let startSample = 0; startSample < samples.length; startSample += hopSamples) {
    const endSample = Math.min(samples.length, startSample + frameSamples)
    let sumSquares = 0
    for (let index = startSample; index < endSample; index += 1) {
      sumSquares += samples[index] * samples[index]
    }
    frames.push({
      startTime: startSample / sampleRate,
      endTime: endSample / sampleRate,
      rms: Math.sqrt(sumSquares / Math.max(1, endSample - startSample)),
      speech: false,
    })
  }

  const sortedRms = frames.map((frame) => frame.rms).sort((a, b) => a - b)
  const noisePercentile = sortedRms[Math.floor((sortedRms.length - 1) * 0.2)] ?? 0
  const adaptiveThreshold = Math.min(0.03, noisePercentile * positive(settings.noiseFloorMultiplier, 2.5))
  const speechThreshold = Math.max(positive(settings.minimumRmsFloor, 0.003), adaptiveThreshold)

  for (const frame of frames) {
    frame.speech = frame.rms > speechThreshold
  }
  smoothSpeechFrames(frames)

  const minSpeechSeconds = Math.max(0, settings.minSpeechMs) / 1000
  const mergeGapSeconds = Math.max(0, settings.mergeGapMs) / 1000
  const rawRegions: SpeechRegion[] = []
  let runStart = -1

  for (let index = 0; index <= frames.length; index += 1) {
    const speech = frames[index]?.speech ?? false
    if (speech && runStart < 0) {
      runStart = index
    }
    if (speech || runStart < 0) {
      continue
    }

    const runFrames = frames.slice(runStart, index)
    const startTime = runFrames[0].startTime
    const endTime = runFrames.at(-1)!.endTime
    if (endTime - startTime >= minSpeechSeconds) {
      rawRegions.push({
        startTime,
        endTime,
        averageRms: runFrames.reduce((total, frame) => total + frame.rms, 0) / runFrames.length,
      })
    }
    runStart = -1
  }

  const merged = mergeRegions(rawRegions, mergeGapSeconds)
  const prePadding = Math.max(0, settings.prePaddingMs) / 1000
  const postPadding = Math.max(0, settings.postPaddingMs) / 1000
  return mergeRegions(
    merged.map((region) => ({
      ...region,
      startTime: Math.max(0, region.startTime - prePadding),
      endTime: Math.min(duration, region.endTime + postPadding),
    })),
    0,
  ).filter((region) => region.endTime > region.startTime)
}

function smoothSpeechFrames(frames: AnalyzedFrame[]): void {
  const original = frames.map((frame) => frame.speech)
  for (let index = 1; index < frames.length - 1; index += 1) {
    if (original[index] && !original[index - 1] && !original[index + 1]) {
      frames[index].speech = false
    }
    if (!original[index] && original[index - 1] && original[index + 1]) {
      frames[index].speech = true
    }
  }
}

function mergeRegions(regions: SpeechRegion[], maximumGapSeconds: number): SpeechRegion[] {
  const merged: SpeechRegion[] = []
  for (const region of regions) {
    const previous = merged.at(-1)
    if (previous && region.startTime - previous.endTime <= maximumGapSeconds) {
      const previousDuration = previous.endTime - previous.startTime
      const regionDuration = region.endTime - region.startTime
      const weightedRms =
        previous.averageRms !== undefined && region.averageRms !== undefined
          ? (previous.averageRms * previousDuration + region.averageRms * regionDuration) /
            Math.max(0.001, previousDuration + regionDuration)
          : previous.averageRms ?? region.averageRms
      previous.endTime = Math.max(previous.endTime, region.endTime)
      previous.averageRms = weightedRms
      continue
    }
    merged.push({ ...region })
  }
  return merged
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}
