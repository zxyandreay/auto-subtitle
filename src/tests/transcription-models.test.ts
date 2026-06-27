import { describe, expect, it } from 'vitest'
import {
  BASE_MODEL_ID,
  DISTIL_LARGE_V3_MODEL_ID,
  getSpeechModelWarnings,
  isKnownSpeechModelId,
  isModelCompatibleWithSettings,
  LARGE_V3_TURBO_MODEL_ID,
  resolveCompatibleModelId,
  resolveSpeechModelRuntimeSettings,
  SPEECH_MODELS,
  TINY_MODEL_ID,
} from '../transcription/models'
import { DEFAULT_TRANSCRIPTION_SETTINGS, normalizeTranscriptionSettings } from '../transcription/types'

const compatibleSettings = {
  modelId: BASE_MODEL_ID,
  language: 'english',
  task: 'transcribe' as const,
  executionProvider: 'auto' as const,
}

describe('speech model registry', () => {
  it('accepts every registered model id', () => {
    expect(SPEECH_MODELS).toHaveLength(4)
    expect(SPEECH_MODELS.every((model) => isKnownSpeechModelId(model.id))).toBe(true)
  })

  it('falls back to Base for an unknown model id', () => {
    const result = resolveCompatibleModelId({ ...compatibleSettings, modelId: 'retired/model' })

    expect(result.modelId).toBe(BASE_MODEL_ID)
    expect(result.changed).toBe(true)
  })

  it('allows Distil Large v3 for explicit English transcription', () => {
    const settings = { ...compatibleSettings, modelId: DISTIL_LARGE_V3_MODEL_ID }

    expect(isModelCompatibleWithSettings(DISTIL_LARGE_V3_MODEL_ID, settings)).toBe(true)
    expect(resolveCompatibleModelId(settings)).toEqual({
      modelId: DISTIL_LARGE_V3_MODEL_ID,
      changed: false,
    })
  })

  it.each(['japanese', 'korean', 'auto'])('moves Distil away from %s transcription', (language) => {
    const result = resolveCompatibleModelId({
      ...compatibleSettings,
      modelId: DISTIL_LARGE_V3_MODEL_ID,
      language,
    })

    expect(result.modelId).toBe(LARGE_V3_TURBO_MODEL_ID)
    expect(result.changed).toBe(true)
  })

  it('moves Distil to Base for translation', () => {
    const result = resolveCompatibleModelId({
      ...compatibleSettings,
      modelId: DISTIL_LARGE_V3_MODEL_ID,
      task: 'translate',
    })

    expect(result.modelId).toBe(BASE_MODEL_ID)
    expect(result.changed).toBe(true)
  })

  it('allows Large v3 Turbo for transcription', () => {
    const settings = { ...compatibleSettings, modelId: LARGE_V3_TURBO_MODEL_ID }

    expect(isModelCompatibleWithSettings(LARGE_V3_TURBO_MODEL_ID, settings)).toBe(true)
    expect(resolveCompatibleModelId(settings).changed).toBe(false)
  })

  it('moves Large v3 Turbo to Base for translation', () => {
    const result = resolveCompatibleModelId({
      ...compatibleSettings,
      modelId: LARGE_V3_TURBO_MODEL_ID,
      task: 'translate',
    })

    expect(result.modelId).toBe(BASE_MODEL_ID)
    expect(result.changed).toBe(true)
  })

  it.each([TINY_MODEL_ID, BASE_MODEL_ID])('keeps existing model %s compatible', (modelId) => {
    expect(resolveCompatibleModelId({ ...compatibleSettings, modelId }).modelId).toBe(modelId)
    expect(
      resolveCompatibleModelId({ ...compatibleSettings, modelId, language: 'korean', task: 'translate' }).modelId,
    ).toBe(modelId)
  })

  it('keeps old tiny and base project values recognizable', () => {
    expect(isKnownSpeechModelId('onnx-community/whisper-tiny')).toBe(true)
    expect(isKnownSpeechModelId('onnx-community/whisper-base')).toBe(true)
  })

  it('never chooses an English-only fallback for non-English or translation settings', () => {
    const settings = [
      { ...compatibleSettings, modelId: 'unknown/model', language: 'japanese' },
      { ...compatibleSettings, modelId: DISTIL_LARGE_V3_MODEL_ID, language: 'korean' },
      { ...compatibleSettings, modelId: DISTIL_LARGE_V3_MODEL_ID, task: 'translate' as const },
      { ...compatibleSettings, modelId: LARGE_V3_TURBO_MODEL_ID, task: 'translate' as const },
    ]

    expect(settings.map((value) => resolveCompatibleModelId(value).modelId)).not.toContain(DISTIL_LARGE_V3_MODEL_ID)
  })

  it('restores valid saved settings and fills missing legacy fields from defaults', () => {
    const restored = normalizeTranscriptionSettings({
      modelId: LARGE_V3_TURBO_MODEL_ID,
      language: 'japanese',
      task: 'transcribe',
      executionProvider: 'webgpu',
      dtype: 'q8',
    })

    expect(restored.settings).toMatchObject({
      modelId: LARGE_V3_TURBO_MODEL_ID,
      language: 'japanese',
      task: 'transcribe',
      executionProvider: 'webgpu',
      dtype: 'q8',
      chunkLengthSeconds: DEFAULT_TRANSCRIPTION_SETTINGS.chunkLengthSeconds,
    })
    expect(restored.reason).toBeUndefined()
  })

  it('normalizes incompatible restored settings and reports the reason once', () => {
    const restored = normalizeTranscriptionSettings({
      modelId: DISTIL_LARGE_V3_MODEL_ID,
      language: 'korean',
      task: 'transcribe',
      executionProvider: 'wasm',
    })

    expect(restored.settings.modelId).toBe(BASE_MODEL_ID)
    expect(restored.reason).toContain('English-only')
  })

  it('reports high-resource device, execution, and precision warnings', () => {
    expect(
      getSpeechModelWarnings(
        { ...compatibleSettings, modelId: LARGE_V3_TURBO_MODEL_ID, executionProvider: 'wasm' },
        { webGpu: false, dtype: 'fp32' },
      ),
    ).toEqual([
      'This model is high-resource. WebGPU is recommended. It may be slow or fail on this device.',
      'Full precision may require significantly more memory.',
      'CPU/WASM execution may be very slow for this model.',
    ])
  })

  it('forces Distil inference to explicit English transcription', () => {
    const runtime = resolveSpeechModelRuntimeSettings({
      ...compatibleSettings,
      modelId: DISTIL_LARGE_V3_MODEL_ID,
      language: 'en-US',
    })

    expect(runtime.settings).toMatchObject({
      modelId: DISTIL_LARGE_V3_MODEL_ID,
      language: 'english',
      task: 'transcribe',
    })
  })

  it('resolves incompatible runtime settings without changing a valid translation task', () => {
    const runtime = resolveSpeechModelRuntimeSettings({
      ...compatibleSettings,
      modelId: LARGE_V3_TURBO_MODEL_ID,
      task: 'translate',
    })

    expect(runtime.settings).toMatchObject({ modelId: BASE_MODEL_ID, task: 'translate', language: 'english' })
    expect(runtime.reason).toContain('not available for translation')
  })
})
