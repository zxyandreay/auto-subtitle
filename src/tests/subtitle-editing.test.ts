import { describe, expect, it } from 'vitest'
import {
  deleteSubtitleEntry,
  duplicateSubtitleEntry,
  invalidateStaleAsrMetadata,
  splitSubtitleEntryAtTime,
  updateSubtitleEntry,
} from '../subtitles/editing'
import { makeSubtitleEntry } from '../subtitles/formatting'

const entries = [
  makeSubtitleEntry({ id: 'first', startTime: 1, endTime: 2, text: 'First' }),
  makeSubtitleEntry({ id: 'second', startTime: 3, endTime: 5, text: 'Second' }),
  makeSubtitleEntry({ id: 'third', startTime: 6, endTime: 7, text: 'Third' }),
]

describe('shared subtitle editing helpers', () => {
  it('updates a subtitle and keeps chronological numbering', () => {
    const result = updateSubtitleEntry(entries, 'second', { startTime: 0.5 })

    expect(result.map((entry) => entry.id)).toEqual(['second', 'first', 'third'])
    expect(result.map((entry) => entry.index)).toEqual([1, 2, 3])
  })

  it('deletes a subtitle and selects the nearest remaining cue', () => {
    const result = deleteSubtitleEntry(entries, 'second')

    expect(result.entries.map((entry) => entry.id)).toEqual(['first', 'third'])
    expect(result.selectedId).toBe('third')
  })

  it('selects the previous cue when the last subtitle is deleted', () => {
    expect(deleteSubtitleEntry(entries, 'third').selectedId).toBe('second')
  })

  it('duplicates subtitle text and duration after the source cue', () => {
    const result = duplicateSubtitleEntry(entries, 'second')
    const duplicate = result.entries.find((entry) => entry.id === result.selectedId)

    expect(duplicate?.text).toBe('Second')
    expect(duplicate?.startTime).toBe(5.1)
    expect(duplicate?.endTime).toBe(7.1)
  })

  it('replaces one subtitle at the playhead and selects the second half', () => {
    const result = splitSubtitleEntryAtTime(entries, 'second', 4)
    const secondHalf = result.entries.find((entry) => entry.id === result.selectedId)

    expect(result.entries).toHaveLength(4)
    expect(result.entries.map((entry) => [entry.startTime, entry.endTime])).toEqual([
      [1, 2],
      [3, 4],
      [4, 5],
      [6, 7],
    ])
    expect(secondHalf?.startTime).toBe(4)
    expect(secondHalf?.endTime).toBe(5)
  })

  it('leaves entries unchanged when the requested timeline split is invalid', () => {
    const result = splitSubtitleEntryAtTime(entries, 'second', 3.05)

    expect(result.entries.map((entry) => entry.id)).toEqual(['first', 'second', 'third'])
    expect(result.selectedId).toBeUndefined()
  })

  it('invalidates word timestamps and confidence after a semantic text edit', () => {
    const original = makeSubtitleEntry({
      id: 'timed',
      startTime: 1,
      endTime: 3,
      text: 'Original text',
      confidence: 0.9,
      words: [{ text: 'Original text', startTime: 1.1, endTime: 2.8, confidence: 0.8 }],
    })

    const [updated] = invalidateStaleAsrMetadata([original], [{ ...original, text: 'Corrected text' }])

    expect(updated.words).toBeUndefined()
    expect(updated.confidence).toBeUndefined()
  })

  it('preserves metadata for harmless line wrapping and padding changes', () => {
    const original = makeSubtitleEntry({
      id: 'timed',
      startTime: 1,
      endTime: 3,
      text: 'Two wrapped words',
      confidence: 0.9,
      words: [
        { text: 'Two', startTime: 1.2, endTime: 1.5 },
        { text: 'wrapped words', startTime: 1.6, endTime: 2.7 },
      ],
    })
    const wrappedAndPadded = { ...original, startTime: 0.9, endTime: 3.1, text: 'Two\nwrapped words' }

    expect(invalidateStaleAsrMetadata([original], [wrappedAndPadded])[0]).toEqual(wrappedAndPadded)
  })

  it('invalidates unchanged metadata when a timing edit excludes its words', () => {
    const original = makeSubtitleEntry({
      id: 'timed',
      startTime: 1,
      endTime: 3,
      text: 'Timed text',
      confidence: 0.9,
      words: [{ text: 'Timed text', startTime: 1.2, endTime: 2.8 }],
    })

    const [updated] = invalidateStaleAsrMetadata([original], [{ ...original, startTime: 2, endTime: 4 }])

    expect(updated.words).toBeUndefined()
    expect(updated.confidence).toBeUndefined()
  })

  it('retains fresh metadata on newly regenerated cues', () => {
    const regenerated = makeSubtitleEntry({
      id: 'regenerated',
      startTime: 1,
      endTime: 3,
      text: 'Fresh result',
      confidence: 0.95,
      words: [{ text: 'Fresh result', startTime: 1.1, endTime: 2.9 }],
    })

    expect(invalidateStaleAsrMetadata(entries, [regenerated])[0]).toEqual(regenerated)
  })
})
