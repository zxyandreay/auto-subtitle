import type { SubtitleEntry } from '../types/subtitles'
import { normalizeForDuplicateComparison, sortAndRenumber } from './formatting'

export type LiveTranscriptionPreviewState = {
  baseEntryIds: Set<string>
  generatedEntryIds: Set<string>
  generatedSnapshots: Map<string, string>
  latestGeneratedEntries: Map<string, SubtitleEntry>
  editedEntryIds: Set<string>
  removedEntryIds: Set<string>
  nextGeneratedId: number
}

export function createLiveTranscriptionPreviewState(baseEntries: SubtitleEntry[] = []): LiveTranscriptionPreviewState {
  return {
    baseEntryIds: new Set(baseEntries.map((entry) => entry.id)),
    generatedEntryIds: new Set(),
    generatedSnapshots: new Map(),
    latestGeneratedEntries: new Map(),
    editedEntryIds: new Set(),
    removedEntryIds: new Set(),
    nextGeneratedId: 1,
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
  const stableGeneratedEntries = stabilizeGeneratedEntryIds(generatedEntries, state)
  const generatedIds = new Set(stableGeneratedEntries.map((entry) => entry.id))
  const nextEntries: SubtitleEntry[] = []

  for (const generated of stableGeneratedEntries) {
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

  const retainedGeneratedIds = new Set(state.latestGeneratedEntries.keys())
  for (const id of state.generatedEntryIds) {
    if (!retainedGeneratedIds.has(id)) {
      state.generatedEntryIds.delete(id)
      state.generatedSnapshots.delete(id)
    }
  }

  return sortAndRenumber(nextEntries)
}

function stabilizeGeneratedEntryIds(
  generatedEntries: SubtitleEntry[],
  state: LiveTranscriptionPreviewState,
): SubtitleEntry[] {
  const previousEntries = [...state.latestGeneratedEntries.values()].sort(
    (first, second) => first.startTime - second.startTime || first.endTime - second.endTime,
  )
  const orderedGeneratedEntries = [...generatedEntries].sort(
    (first, second) => first.startTime - second.startTime || first.endTime - second.endTime,
  )
  const availablePreviousIds = new Set(previousEntries.map((entry) => entry.id))
  const assignedIds = new Set<string>()
  let firstPossiblePrevious = 0
  let minimumPreviousIndex = 0
  const stableEntries = orderedGeneratedEntries.map((entry) => {
    while (
      firstPossiblePrevious < previousEntries.length &&
      previousEntries[firstPossiblePrevious].endTime < entry.startTime - 1.5
    ) {
      firstPossiblePrevious += 1
    }
    const possibleMatches: Array<{ previous: SubtitleEntry; index: number }> = []
    for (let index = Math.max(firstPossiblePrevious, minimumPreviousIndex); index < previousEntries.length; index += 1) {
      const previous = previousEntries[index]
      if (previous.startTime > entry.endTime + 1.5) {
        break
      }
      if (availablePreviousIds.has(previous.id)) {
        possibleMatches.push({ previous, index })
      }
    }
    const match = possibleMatches
      .map(({ previous, index }) => ({ previous, index, score: generatedEntryMatchScore(previous, entry) }))
      .filter((candidate) => candidate.score >= 2)
      .sort((first, second) => second.score - first.score || first.index - second.index)[0]
    const id = match?.previous.id ?? allocateGeneratedEntryId(entry.id, assignedIds, state)

    availablePreviousIds.delete(id)
    assignedIds.add(id)
    if (match) {
      minimumPreviousIndex = match.index + 1
    }
    return id === entry.id ? entry : { ...entry, id }
  })

  const nextLatestEntries = new Map(stableEntries.map((entry) => [entry.id, { ...entry }]))
  for (const protectedId of new Set([...state.editedEntryIds, ...state.removedEntryIds])) {
    const previous = state.latestGeneratedEntries.get(protectedId)
    if (previous && !nextLatestEntries.has(protectedId)) {
      nextLatestEntries.set(protectedId, previous)
    }
  }
  state.latestGeneratedEntries = nextLatestEntries
  return stableEntries
}

function generatedEntryMatchScore(previous: SubtitleEntry, next: SubtitleEntry): number {
  const overlap = Math.max(0, Math.min(previous.endTime, next.endTime) - Math.max(previous.startTime, next.startTime))
  const union = Math.max(previous.endTime, next.endTime) - Math.min(previous.startTime, next.startTime)
  const temporalGap = overlap > 0
    ? 0
    : Math.max(previous.startTime, next.startTime) - Math.min(previous.endTime, next.endTime)
  if (temporalGap > 1.5) {
    return Number.NEGATIVE_INFINITY
  }

  const overlapRatio = union > 0 ? overlap / union : 0
  const startCloseness = Math.max(0, 1 - Math.abs(previous.startTime - next.startTime) / 1.5)
  const endCloseness = Math.max(0, 1 - Math.abs(previous.endTime - next.endTime) / 1.5)
  const previousText = normalizeForDuplicateComparison(previous.text)
  const nextText = normalizeForDuplicateComparison(next.text)
  if (!previousText || !nextText) {
    return Number.NEGATIVE_INFINITY
  }
  const textScore = orderedTextSimilarity(previousText, nextText)
  const exactTextBonus = previousText && previousText === nextText ? 1 : 0
  if (!exactTextBonus && textScore < 0.35) {
    return Number.NEGATIVE_INFINITY
  }
  return overlapRatio * 4 + startCloseness + endCloseness + textScore * 2 + exactTextBonus
}

function orderedTextSimilarity(first: string, second: string): number {
  const whitespaceDelimited = first.includes(' ') || second.includes(' ')
  const firstUnits = whitespaceDelimited
    ? first.split(' ').filter(Boolean).slice(0, 64)
    : Array.from(first).slice(0, 128)
  const secondUnits = whitespaceDelimited
    ? second.split(' ').filter(Boolean).slice(0, 64)
    : Array.from(second).slice(0, 128)
  if (!firstUnits.length || !secondUnits.length) {
    return 0
  }

  const row = new Uint16Array(secondUnits.length + 1)
  for (const firstUnit of firstUnits) {
    let diagonal = 0
    for (let index = 1; index <= secondUnits.length; index += 1) {
      const previous = row[index]
      row[index] = firstUnit === secondUnits[index - 1]
        ? diagonal + 1
        : Math.max(row[index], row[index - 1])
      diagonal = previous
    }
  }
  return row[secondUnits.length] / Math.max(firstUnits.length, secondUnits.length)
}

function allocateGeneratedEntryId(
  requestedId: string,
  assignedIds: Set<string>,
  state: LiveTranscriptionPreviewState,
): string {
  if (!state.generatedEntryIds.has(requestedId) && !assignedIds.has(requestedId)) {
    return requestedId
  }

  let id = ''
  do {
    id = `generated-live-${state.nextGeneratedId}`
    state.nextGeneratedId += 1
  } while (state.generatedEntryIds.has(id) || assignedIds.has(id))
  return id
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
