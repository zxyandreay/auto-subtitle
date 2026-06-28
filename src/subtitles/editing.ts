import type { SubtitleEntry } from '../types/subtitles'
import { makeSubtitleEntry, sortAndRenumber } from './formatting'

type DeleteSubtitleResult = {
  entries: SubtitleEntry[]
  selectedId?: string
}

type DuplicateSubtitleResult = {
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
