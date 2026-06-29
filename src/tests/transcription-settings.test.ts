import { describe, expect, it } from 'vitest'
import { parseProjectJson } from '../subtitles/exporters'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'
import {
  buildRegenerationSettings,
  createRegenerationPreferences,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  normalizeTranscriptionSettings,
} from '../transcription/types'

describe('accurate-local defaults', () => {
  it('uses the synchronization-focused transcription defaults', () => {
    expect(DEFAULT_TRANSCRIPTION_SETTINGS).toMatchObject({
      executionProvider: 'auto',
      dtype: 'q8',
      task: 'transcribe',
      language: 'auto',
      chunkLengthSeconds: 29,
      strideLengthSeconds: 4,
      maxModelInputSeconds: 29,
      targetChunkSeconds: 26,
      speechAwareOverlapSeconds: 1.5,
      fallbackOverlapSeconds: 4,
      hardMinWindowSeconds: 5,
      vadEnabled: true,
      vadPrePaddingMs: 200,
      vadPostPaddingMs: 300,
    })
    expect(DEFAULT_FORMATTING_PREFERENCES).toMatchObject({
      maxCharsPerLine: 42,
      maxCharsPerSubtitle: 84,
      minDuration: 1.1,
      maxDuration: 6,
      gapBetweenSubtitles: 0.08,
      useWordTimestamps: true,
      subtitleLeadIn: 0.08,
      subtitleTailPadding: 0.18,
      targetMaxCps: 20,
      hardMaxCps: 21,
      closeGapsBelow: 0.5,
    })
  })

  it('fills new settings when normalizing a legacy settings object', () => {
    const { settings } = normalizeTranscriptionSettings({
      language: 'english',
      chunkLengthSeconds: 30,
      formatting: { maxCharsPerLine: 36 },
    })

    expect(settings.language).toBe('english')
    expect(settings.maxModelInputSeconds).toBe(29)
    expect(settings.vadEnabled).toBe(true)
    expect(settings.formatting.maxCharsPerLine).toBe(36)
    expect(settings.formatting.gapBetweenSubtitles).toBe(0.08)
  })

  it('fills missing new formatting fields when importing a legacy project', () => {
    const result = parseProjectJson(
      JSON.stringify({
        metadata: { appName: 'Auto Subtitle', schemaVersion: 1, exportedAt: '2025-01-01T00:00:00.000Z' },
        subtitles: [],
        formatting: { maxCharsPerLine: 38, maxCharsPerSubtitle: 76, minDuration: 1, maxDuration: 5, gapBetweenSubtitles: 0.04, useWordTimestamps: false },
        transcriptionSettings: { language: 'english', chunkLengthSeconds: 30 },
      }),
    )

    expect(result.errors).toEqual([])
    expect(result.project?.formatting.subtitleLeadIn).toBe(0.08)
    expect(result.project?.formatting.closeGapsBelow).toBe(0.5)
    expect(result.project?.transcriptionSettings).toMatchObject({
      language: 'english',
      maxModelInputSeconds: 29,
      vadEnabled: true,
    })
  })

  it('creates session regeneration preferences from applicable transcription settings', () => {
    expect(createRegenerationPreferences(DEFAULT_TRANSCRIPTION_SETTINGS)).toEqual({
      language: 'auto',
      task: 'transcribe',
      modelId: DEFAULT_TRANSCRIPTION_SETTINGS.modelId,
      executionProvider: 'auto',
      dtype: 'q8',
      useWordTimestamps: true,
      alternativeCount: 3,
    })
  })

  it('builds an immutable regeneration settings snapshot without changing global settings', () => {
    const globalSettings = structuredClone(DEFAULT_TRANSCRIPTION_SETTINGS)
    const snapshot = buildRegenerationSettings(globalSettings, {
      language: 'english',
      task: 'transcribe',
      modelId: 'distil-whisper/distil-large-v3',
      executionProvider: 'webgpu',
      dtype: 'fp32',
      useWordTimestamps: false,
      alternativeCount: 5,
    })

    expect(snapshot).toMatchObject({
      language: 'english',
      modelId: 'distil-whisper/distil-large-v3',
      executionProvider: 'webgpu',
      dtype: 'fp32',
      formatting: { useWordTimestamps: false },
    })
    snapshot.formatting.maxCharsPerLine = 10
    expect(globalSettings.formatting.maxCharsPerLine).toBe(42)
    expect(globalSettings).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS)
  })
})
