import { describe, expect, it } from 'vitest'
import {
  deleteSubtitleEntry,
  duplicateSubtitleEntry,
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
})
