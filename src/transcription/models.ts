export const TINY_MODEL_ID = 'onnx-community/whisper-tiny' as const
export const BASE_MODEL_ID = 'onnx-community/whisper-base' as const
export const LARGE_V3_TURBO_MODEL_ID = 'onnx-community/whisper-large-v3-turbo' as const
export const DISTIL_LARGE_V3_MODEL_ID = 'distil-whisper/distil-large-v3' as const

export type SpeechModelId =
  | typeof TINY_MODEL_ID
  | typeof BASE_MODEL_ID
  | typeof LARGE_V3_TURBO_MODEL_ID
  | typeof DISTIL_LARGE_V3_MODEL_ID

export type SpeechModelFamily = 'whisper-onnx' | 'distil-whisper'
export type SpeechModelTier = 'fast' | 'balanced' | 'high-accuracy' | 'english-high-quality'

export type SpeechModelOption = {
  id: SpeechModelId
  label: string
  shortLabel: string
  family: SpeechModelFamily
  tier: SpeechModelTier
  description: string
  languages: 'multilingual' | 'english-only'
  supportsTranscribe: boolean
  supportsTranslate: boolean
  supportsFullTranscription: boolean
  supportsRegeneration: boolean
  recommendedExecutionProvider: 'auto' | 'webgpu' | 'wasm'
  recommendedDtype?: 'auto' | 'q8' | 'fp32'
  highResource: boolean
  warning?: string
}

export type SpeechModelSettings = {
  modelId: string
  language: string
  task: 'transcribe' | 'translate'
  executionProvider?: 'auto' | 'webgpu' | 'wasm' | 'cpu'
}

export const SPEECH_MODELS: SpeechModelOption[] = [
  {
    id: TINY_MODEL_ID,
    label: 'Fast model',
    shortLabel: 'Tiny',
    family: 'whisper-onnx',
    tier: 'fast',
    description: 'Smallest local Whisper model. Fastest, with lower accuracy.',
    languages: 'multilingual',
    supportsTranscribe: true,
    supportsTranslate: true,
    supportsFullTranscription: true,
    supportsRegeneration: true,
    recommendedExecutionProvider: 'auto',
    recommendedDtype: 'auto',
    highResource: false,
  },
  {
    id: BASE_MODEL_ID,
    label: 'Balanced model',
    shortLabel: 'Base',
    family: 'whisper-onnx',
    tier: 'balanced',
    description: 'Balanced local Whisper model. A good default for most devices.',
    languages: 'multilingual',
    supportsTranscribe: true,
    supportsTranslate: true,
    supportsFullTranscription: true,
    supportsRegeneration: true,
    recommendedExecutionProvider: 'auto',
    recommendedDtype: 'auto',
    highResource: false,
  },
  {
    id: LARGE_V3_TURBO_MODEL_ID,
    label: 'High accuracy model',
    shortLabel: 'Large v3 Turbo',
    family: 'whisper-onnx',
    tier: 'high-accuracy',
    description: 'Higher quality multilingual local transcription. WebGPU and q8 are recommended.',
    languages: 'multilingual',
    supportsTranscribe: true,
    supportsTranslate: false,
    supportsFullTranscription: true,
    supportsRegeneration: true,
    recommendedExecutionProvider: 'webgpu',
    recommendedDtype: 'q8',
    highResource: true,
    warning: 'Large v3 Turbo is high-resource and is intended for transcription, not translation.',
  },
  {
    id: DISTIL_LARGE_V3_MODEL_ID,
    label: 'English high quality model',
    shortLabel: 'Distil Large v3',
    family: 'distil-whisper',
    tier: 'english-high-quality',
    description: 'Fast, high-quality English-only local transcription. WebGPU and q8 are recommended.',
    languages: 'english-only',
    supportsTranscribe: true,
    supportsTranslate: false,
    supportsFullTranscription: true,
    supportsRegeneration: true,
    recommendedExecutionProvider: 'webgpu',
    recommendedDtype: 'q8',
    highResource: true,
    warning: 'Distil Large v3 is for English transcription only.',
  },
]

export function isKnownSpeechModelId(modelId: string): modelId is SpeechModelId {
  return SPEECH_MODELS.some((model) => model.id === modelId)
}

export function getSpeechModelOption(modelId: string): SpeechModelOption {
  return SPEECH_MODELS.find((model) => model.id === modelId) ?? getBaseModel()
}

export function isEnglishLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase().replace('_', '-')
  return normalized === 'english' || normalized === 'en' || normalized.startsWith('en-')
}

export function isModelCompatibleWithSettings(modelId: string, settings: SpeechModelSettings): boolean {
  if (!isKnownSpeechModelId(modelId)) {
    return false
  }

  const model = getSpeechModelOption(modelId)
  if (settings.task === 'translate' && !model.supportsTranslate) {
    return false
  }

  return model.languages !== 'english-only' || (settings.task === 'transcribe' && isEnglishLanguage(settings.language))
}

export function getCompatibleFallbackModelId(settings: SpeechModelSettings): SpeechModelId {
  if (settings.task === 'translate') {
    return BASE_MODEL_ID
  }

  const canFavorHighResourceModel =
    settings.executionProvider === 'auto' || settings.executionProvider === 'webgpu'
  if (!isEnglishLanguage(settings.language) && canFavorHighResourceModel) {
    return LARGE_V3_TURBO_MODEL_ID
  }

  return BASE_MODEL_ID
}

export function resolveCompatibleModelId(settings: SpeechModelSettings): {
  modelId: SpeechModelId
  changed: boolean
  reason?: string
} {
  if (isKnownSpeechModelId(settings.modelId) && isModelCompatibleWithSettings(settings.modelId, settings)) {
    return { modelId: settings.modelId, changed: false }
  }

  const fallbackModelId = isKnownSpeechModelId(settings.modelId)
    ? getCompatibleFallbackModelId(settings)
    : BASE_MODEL_ID
  const fallbackLabel = getSpeechModelOption(fallbackModelId).shortLabel

  if (!isKnownSpeechModelId(settings.modelId)) {
    return {
      modelId: fallbackModelId,
      changed: true,
      reason: `The saved speech model is unavailable, so the model was switched to ${fallbackLabel}.`,
    }
  }

  if (settings.modelId === DISTIL_LARGE_V3_MODEL_ID && settings.task === 'translate') {
    return {
      modelId: fallbackModelId,
      changed: true,
      reason: `Distil Large v3 is transcription-only, so the model was switched to ${fallbackLabel} for translation.`,
    }
  }

  if (settings.modelId === DISTIL_LARGE_V3_MODEL_ID) {
    return {
      modelId: fallbackModelId,
      changed: true,
      reason: `Distil Large v3 is English-only, so the model was switched to ${fallbackLabel} for this language.`,
    }
  }

  return {
    modelId: fallbackModelId,
    changed: true,
    reason: `Large v3 Turbo is not available for translation, so the model was switched to ${fallbackLabel}.`,
  }
}

export function getSpeechModelWarnings(
  settings: SpeechModelSettings,
  capabilities: { webGpu: boolean; dtype: 'auto' | 'q8' | 'fp32' },
): string[] {
  const model = getSpeechModelOption(settings.modelId)
  if (!model.highResource) {
    return []
  }

  const warnings: string[] = []
  if (!capabilities.webGpu) {
    warnings.push('This model is high-resource. WebGPU is recommended. It may be slow or fail on this device.')
  }
  if (capabilities.dtype === 'fp32') {
    warnings.push('Full precision may require significantly more memory.')
  }
  if (settings.executionProvider === 'wasm' || settings.executionProvider === 'cpu') {
    warnings.push('CPU/WASM execution may be very slow for this model.')
  }
  return warnings
}

export function resolveSpeechModelRuntimeSettings<T extends SpeechModelSettings>(settings: T): {
  settings: T & { modelId: SpeechModelId }
  changed: boolean
  reason?: string
} {
  const resolved = resolveCompatibleModelId(settings)
  const runtimeSettings = {
    ...settings,
    modelId: resolved.modelId,
    ...(resolved.modelId === DISTIL_LARGE_V3_MODEL_ID
      ? { language: 'english', task: 'transcribe' as const }
      : {}),
  }

  return {
    settings: runtimeSettings,
    changed: resolved.changed,
    reason: resolved.reason,
  }
}

function getBaseModel(): SpeechModelOption {
  const model = SPEECH_MODELS.find((candidate) => candidate.id === BASE_MODEL_ID)
  if (!model) {
    throw new Error('The Base speech model is missing from the model registry.')
  }
  return model
}
