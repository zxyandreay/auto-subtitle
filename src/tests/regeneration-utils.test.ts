import { describe, expect, it } from 'vitest'
import { makeSubtitleEntry } from '../subtitles/formatting'
import {
  constrainSegmentsToRange,
  createInitialRegenerationRange,
  replaceEntriesInRange,
} from '../subtitles/regeneration'
import {
  REGENERATION_DECODING_PROFILES,
  dedupeRegenerationCandidates,
  planRegenerationAudioRange,
  validateRegenerationRange,
} from '../transcription/regeneration'
import type { RegenerationCandidate, RegenerationRange } from '../transcription/types'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'

describe('regeneration ranges', () => {
  it('initializes from a selected cue and caps long cues to the first 29 seconds', () => {
    const selected = makeSubtitleEntry({ startTime: 12, endTime: 18, text: 'Selected' })
    const long = makeSubtitleEntry({ startTime: 20, endTime: 55, text: 'Long' })

    expect(createInitialRegenerationRange({ selectedEntry: selected, currentTime: 0, videoDuration: 60 })).toEqual({
      startTime: 12,
      endTime: 18,
    })
    expect(createInitialRegenerationRange({ selectedEntry: long, currentTime: 0, videoDuration: 60 })).toEqual({
      startTime: 20,
      endTime: 49,
    })
  })

  it('keeps selected-cue initialization valid at or beyond the video end', () => {
    const clipped = makeSubtitleEntry({ startTime: 19.95, endTime: 25, text: 'Clipped' })
    const outside = makeSubtitleEntry({ startTime: 30, endTime: 35, text: 'Outside' })

    expect(createInitialRegenerationRange({ selectedEntry: clipped, currentTime: 10, videoDuration: 20 })).toEqual({
      startTime: 19.9,
      endTime: 20,
    })
    expect(createInitialRegenerationRange({ selectedEntry: outside, currentTime: 10, videoDuration: 20 })).toEqual({
      startTime: 7.5,
      endTime: 12.5,
    })
  })

  it('initializes a five-second playhead range and preserves its duration at video boundaries', () => {
    expect(createInitialRegenerationRange({ currentTime: 20, videoDuration: 60 })).toEqual({
      startTime: 17.5,
      endTime: 22.5,
    })
    expect(createInitialRegenerationRange({ currentTime: 1, videoDuration: 60 })).toEqual({
      startTime: 0,
      endTime: 5,
    })
    expect(createInitialRegenerationRange({ currentTime: 59, videoDuration: 60 })).toEqual({
      startTime: 55,
      endTime: 60,
    })
    expect(createInitialRegenerationRange({ currentTime: 1, videoDuration: 3 })).toEqual({
      startTime: 0,
      endTime: 3,
    })
  })

  it('accepts a positive range no longer than the safe 29-second model budget', () => {
    expect(validateRegenerationRange({ startTime: 12, endTime: 41 }, 60)).toBeNull()
  })

  it('rejects invalid, excessive, and out-of-video ranges', () => {
    expect(validateRegenerationRange({ startTime: 4, endTime: 4 }, 60)).toBe('End time must be after start time.')
    expect(validateRegenerationRange({ startTime: 0, endTime: 29.001 }, 60)).toBe(
      'Regeneration ranges cannot exceed 29 seconds.',
    )
    expect(validateRegenerationRange({ startTime: 55, endTime: 61 }, 60)).toBe(
      'The regeneration range must stay within the video duration.',
    )
  })

  it('allocates context without exceeding Whisper\'s input budget', () => {
    expect(planRegenerationAudioRange({ startTime: 10, endTime: 20 }, 60)).toEqual({
      extractionStartTime: 8,
      extractionEndTime: 22,
    })
    expect(planRegenerationAudioRange({ startTime: 10, endTime: 38 }, 60)).toEqual({
      extractionStartTime: 9.5,
      extractionEndTime: 38.5,
    })
    expect(planRegenerationAudioRange({ startTime: 0, endTime: 29 }, 60)).toEqual({
      extractionStartTime: 0,
      extractionEndTime: 29,
    })
  })
})

describe('regeneration candidates', () => {
  it('uses one greedy pass and four bounded sampling attempts', () => {
    expect(REGENERATION_DECODING_PROFILES).toEqual([
      { id: 'greedy', doSample: false },
      { id: 'sample-04', doSample: true, temperature: 0.4, topK: 30 },
      { id: 'sample-075', doSample: true, temperature: 0.75, topK: 40 },
      { id: 'sample-09', doSample: true, temperature: 0.9, topK: 50 },
      { id: 'sample-10', doSample: true, temperature: 1, topK: 50 },
    ])
  })

  it('removes normalized duplicates and keeps at most three alternatives', () => {
    const candidates: RegenerationCandidate[] = [
      candidate('greedy', 'Check this subtitle.'),
      candidate('sample-04', 'check this subtitle'),
      candidate('sample-075', 'Check the subtitle.'),
      candidate('sample-09', 'Verify this subtitle.'),
      candidate('sample-10', 'Review this subtitle.'),
    ]

    expect(dedupeRegenerationCandidates(candidates).map(({ id }) => id)).toEqual([
      'greedy',
      'sample-075',
      'sample-09',
    ])
  })
})

describe('regenerated subtitle replacement', () => {
  const range: RegenerationRange = { startTime: 10, endTime: 15 }

  it('drops outside segments and clamps overlapping timing to the selected range', () => {
    expect(
      constrainSegmentsToRange(
        [
          { startTime: 7, endTime: 9, text: 'Outside.' },
          { startTime: 9.5, endTime: 12, text: 'Crosses in.' },
          { startTime: 14, endTime: 16, text: 'Crosses out.' },
        ],
        range,
      ),
    ).toEqual([
      { startTime: 10, endTime: 12, text: 'Crosses in.' },
      { startTime: 14, endTime: 15, text: 'Crosses out.' },
    ])
  })

  it('replaces every overlapping cue while preserving and respecting untouched neighbors', () => {
    const existing = [
      makeSubtitleEntry({ id: 'before', startTime: 8, endTime: 10, text: 'Before' }),
      makeSubtitleEntry({ id: 'old-1', startTime: 10, endTime: 12, text: 'Old one' }),
      makeSubtitleEntry({ id: 'old-2', startTime: 12.1, endTime: 14.5, text: 'Old two' }),
      makeSubtitleEntry({ id: 'after', startTime: 15, endTime: 17, text: 'After' }),
    ]
    const replacement = [
      makeSubtitleEntry({ id: 'new', startTime: 9.7, endTime: 15.2, text: 'Replacement' }),
    ]

    const result = replaceEntriesInRange(
      existing,
      replacement,
      range,
      DEFAULT_FORMATTING_PREFERENCES,
      30,
    )

    expect(result.map(({ id }) => id)).toEqual(['before', 'new', 'after'])
    expect(result[1]).toMatchObject({ startTime: 10.08, endTime: 14.92, text: 'Replacement' })
    expect(result.map(({ index }) => index)).toEqual([1, 2, 3])
  })

  it('returns the original entries when no replacement candidate is selected', () => {
    const existing = [makeSubtitleEntry({ id: 'original', startTime: 10, endTime: 12, text: 'Keep me' })]

    expect(
      replaceEntriesInRange(
        existing,
        null,
        range,
        DEFAULT_FORMATTING_PREFERENCES,
        30,
      ),
    ).toBe(existing)
  })

  it('does not add boundary gaps when there are no untouched neighboring cues', () => {
    const replacement = [
      makeSubtitleEntry({ id: 'new', startTime: 10, endTime: 15, text: 'Full range' }),
    ]

    const result = replaceEntriesInRange(
      [],
      replacement,
      range,
      DEFAULT_FORMATTING_PREFERENCES,
      30,
    )

    expect(result[0]).toMatchObject({ startTime: 10, endTime: 15 })
  })
})

function candidate(id: string, text: string): RegenerationCandidate {
  return {
    id,
    text,
    segments: [{ startTime: 10, endTime: 12, text }],
  }
}
