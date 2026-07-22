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

/**
 * Removes ASR evidence that no longer describes a manually edited cue.
 * Line wrapping and cue padding that still contains every timestamped word are
 * harmless. Entries with a new ID are left alone so regenerated cues retain
 * the fresh word timings and confidence supplied by the transcription worker.
 */
export function invalidateStaleAsrMetadata(
  previousEntries: SubtitleEntry[],
  nextEntries: SubtitleEntry[],
): SubtitleEntry[] {
  const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]))

  return nextEntries.map((entry) => {
    const previous = previousById.get(entry.id)
    if (!previous || (entry.words === undefined && entry.confidence === undefined)) {
      return entry
    }

    const semanticTextChanged = semanticSubtitleText(previous.text) !== semanticSubtitleText(entry.text)
    const timingChanged = previous.startTime !== entry.startTime || previous.endTime !== entry.endTime
    const hasFreshWordMetadata = Boolean(entry.words?.length && !sameSubtitleWords(previous.words, entry.words))
    const timingRemainsCompatible =
      !timingChanged ||
      Boolean(
        entry.words?.length &&
        entry.words.every(
          (word) => word.startTime >= entry.startTime - 0.001 && word.endTime <= entry.endTime + 0.001,
        ),
      )

    if ((!semanticTextChanged && timingRemainsCompatible) || hasFreshWordMetadata) {
      return entry
    }

    const { confidence: _confidence, words: _words, ...withoutStaleMetadata } = entry
    return withoutStaleMetadata
  })
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

function semanticSubtitleText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function sameSubtitleWords(first: SubtitleEntry['words'], second: SubtitleEntry['words']): boolean {
  if (first === second) {
    return true
  }
  return (
    first?.length === second?.length &&
    Boolean(
      first?.every((word, index) => {
        const other = second?.[index]
        return (
          word.text === other?.text &&
          word.startTime === other.startTime &&
          word.endTime === other.endTime &&
          word.confidence === other.confidence
        )
      }),
    )
  )
}
