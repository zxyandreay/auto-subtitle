import type { SubtitleEntry } from '../types/subtitles'
import { sortAndRenumber } from './formatting'

export type LiveTranscriptionPreviewState = {
  baseEntryIds: Set<string>
  generatedEntryIds: Set<string>
  generatedSnapshots: Map<string, string>
  editedEntryIds: Set<string>
  removedEntryIds: Set<string>
}

export function createLiveTranscriptionPreviewState(baseEntries: SubtitleEntry[] = []): LiveTranscriptionPreviewState {
  return {
    baseEntryIds: new Set(baseEntries.map((entry) => entry.id)),
    generatedEntryIds: new Set(),
    generatedSnapshots: new Map(),
    editedEntryIds: new Set(),
    removedEntryIds: new Set(),
  }
}

export function markLiveTranscriptionPreviewEdits(
  previousEntries: SubtitleEntry[],
  nextEntries: SubtitleEntry[],
  state: LiveTranscriptionPreviewState,
): void {
  const nextIds = new Set(nextEntries.map((entry) => entry.id))

  for (const previous of previousEntries) {
    if (state.generatedEntryIds.has(previous.id) && !nextIds.has(previous.id)) {
      state.removedEntryIds.add(previous.id)
      state.editedEntryIds.delete(previous.id)
    }
  }

  for (const entry of nextEntries) {
    if (!state.generatedEntryIds.has(entry.id)) {
      continue
    }

    const generatedSnapshot = state.generatedSnapshots.get(entry.id)
    if (generatedSnapshot !== undefined && generatedSnapshot !== snapshotSubtitleEntry(entry)) {
      state.editedEntryIds.add(entry.id)
      state.removedEntryIds.delete(entry.id)
    }
  }
}

export function mergeLiveTranscriptionPreview(
  currentEntries: SubtitleEntry[],
  generatedEntries: SubtitleEntry[],
  state: LiveTranscriptionPreviewState,
): SubtitleEntry[] {
  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry]))
  const generatedIds = new Set(generatedEntries.map((entry) => entry.id))
  const nextEntries: SubtitleEntry[] = []

  for (const generated of generatedEntries) {
    state.generatedEntryIds.add(generated.id)
    state.generatedSnapshots.set(generated.id, snapshotSubtitleEntry(generated))

    if (state.removedEntryIds.has(generated.id)) {
      continue
    }

    const current = currentById.get(generated.id)
    nextEntries.push(current && state.editedEntryIds.has(generated.id) ? current : generated)
  }

  for (const current of currentEntries) {
    const wasGenerated = state.generatedEntryIds.has(current.id)
    const wasBaseEntry = state.baseEntryIds.has(current.id)

    if (wasGenerated && state.editedEntryIds.has(current.id) && !state.removedEntryIds.has(current.id) && !generatedIds.has(current.id)) {
      nextEntries.push(current)
      continue
    }

    if (!wasGenerated && !wasBaseEntry) {
      nextEntries.push(current)
    }
  }

  return sortAndRenumber(nextEntries)
}

function snapshotSubtitleEntry(entry: SubtitleEntry): string {
  return JSON.stringify({
    startTime: entry.startTime,
    endTime: entry.endTime,
    text: entry.text,
    confidence: entry.confidence,
    words: entry.words,
  })
}
