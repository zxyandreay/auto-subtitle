import { describe, expect, it } from 'vitest'
import { createTranscriptionSettingsSnapshot } from '../transcription/settingsSnapshot'
import { DEFAULT_TRANSCRIPTION_SETTINGS } from '../transcription/types'

describe('transcription settings snapshot', () => {
  it('deep-copies and freezes settings used by a worker job', () => {
    const source = {
      ...DEFAULT_TRANSCRIPTION_SETTINGS,
      formatting: { ...DEFAULT_TRANSCRIPTION_SETTINGS.formatting },
    }
    const snapshot = createTranscriptionSettingsSnapshot(source, 'resolved-model')

    expect(snapshot).not.toBe(source)
    expect(snapshot.formatting).not.toBe(source.formatting)
    expect(snapshot.modelId).toBe('resolved-model')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.formatting)).toBe(true)

    source.language = 'japanese'
    source.formatting.maxCharsPerLine = 60
    expect(snapshot.language).toBe(DEFAULT_TRANSCRIPTION_SETTINGS.language)
    expect(snapshot.formatting.maxCharsPerLine).toBe(DEFAULT_TRANSCRIPTION_SETTINGS.formatting.maxCharsPerLine)
  })
})
