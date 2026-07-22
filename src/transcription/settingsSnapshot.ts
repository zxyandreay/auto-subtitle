import type { TranscriptionSettings } from './types'

/** Creates an isolated, immutable settings value for one worker job. */
export function createTranscriptionSettingsSnapshot(
  settings: TranscriptionSettings,
  modelId: string = settings.modelId,
): TranscriptionSettings {
  const formatting = Object.freeze({ ...settings.formatting })
  return Object.freeze({
    ...settings,
    modelId,
    formatting,
  })
}
