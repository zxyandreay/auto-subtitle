import type { SubtitleEntry } from '../types/subtitles'
import { makeSubtitleEntry, sortAndRenumber, splitEntryAtTime } from './formatting'

type DeleteSubtitleResult = {
  entries: SubtitleEntry[]
  selectedId?: string
}

type DuplicateSubtitleResult = {
  entries: SubtitleEntry[]
  selectedId?: string
}

type SplitSubtitleResult = {
  entries: SubtitleEntry[]
  selectedId?: string
}

export function updateSubtitleEntry(
  entries: SubtitleEntry[],
  id: string,
  patch: Partial<SubtitleEntry>,
): SubtitleEntry[] {
  return sortAndRenumber(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
}

export function deleteSubtitleEntry(entries: SubtitleEntry[], id: string): DeleteSubtitleResult {
  const sorted = sortAndRenumber(entries)
  const removedIndex = sorted.findIndex((entry) => entry.id === id)
  if (removedIndex < 0) {
    return { entries: sorted }
  }

  const nextEntries = sortAndRenumber(sorted.filter((entry) => entry.id !== id))
  return {
    entries: nextEntries,
    selectedId: nextEntries[removedIndex]?.id ?? nextEntries[removedIndex - 1]?.id,
  }
}

export function duplicateSubtitleEntry(entries: SubtitleEntry[], id: string): DuplicateSubtitleResult {
  const source = entries.find((entry) => entry.id === id)
  if (!source) {
    return { entries: sortAndRenumber(entries) }
  }

  const duration = Math.max(0.1, source.endTime - source.startTime)
  const duplicate = makeSubtitleEntry({
    startTime: source.endTime + 0.1,
    endTime: source.endTime + 0.1 + duration,
    text: source.text,
    confidence: source.confidence,
    words: source.words,
  })

  return {
    entries: sortAndRenumber([...entries, duplicate]),
    selectedId: duplicate.id,
  }
}

export function splitSubtitleEntryAtTime(
  entries: SubtitleEntry[],
  id: string,
  splitTime: number,
): SplitSubtitleResult {
  const sorted = sortAndRenumber(entries)
  const sourceIndex = sorted.findIndex((entry) => entry.id === id)
  if (sourceIndex < 0) {
    return { entries: sorted }
  }

  const split = splitEntryAtTime(sorted[sourceIndex], splitTime)
  if (!split) {
    return { entries: sorted }
  }

  const [first, second] = split
  return {
    entries: sortAndRenumber([
      ...sorted.slice(0, sourceIndex),
      first,
      second,
      ...sorted.slice(sourceIndex + 1),
    ]),
    selectedId: second.id,
  }
}
