import { describe, expect, it } from 'vitest'
import { AUDIO_TIMELINE_FILTER, buildAudioExtractionArgs } from '../transcription/audioExtraction'

describe('audio extraction arguments', () => {
  it('pads delayed audio tracks from media time zero before creating the WAV', () => {
    expect(buildAudioExtractionArgs('input.mp4', 'audio.wav')).toEqual([
      '-i',
      'input.mp4',
      '-vn',
      '-af',
      AUDIO_TIMELINE_FILTER,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-acodec',
      'pcm_s16le',
      '-f',
      'wav',
      'audio.wav',
    ])
    expect(AUDIO_TIMELINE_FILTER).toBe('aresample=async=1:first_pts=0')
  })
})
