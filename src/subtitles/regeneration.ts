import type { RawTranscriptionSegment } from './formatting'
import { sortAndRenumber } from './formatting'
import type { RegenerationRange } from '../transcription/types'
import type { FormattingPreferences, SubtitleEntry } from '../types/subtitles'
import { roundTime } from '../utils/time'

export function constrainSegmentsToRange(
  segments: RawTranscriptionSegment[],
  range: RegenerationRange,
): RawTranscriptionSegment[] {
  return segments.flatMap((segment) => {
    const startTime = Math.max(range.startTime, segment.startTime)
    const endTime = Math.min(range.endTime, segment.endTime)
    if (endTime <= startTime) {
      return []
    }

    const words = segment.words
      ?.map((word) => ({
        ...word,
        startTime: Math.max(range.startTime, word.startTime),
        endTime: Math.min(range.endTime, word.endTime),
      }))
      .filter((word) => word.endTime > word.startTime)

    return [{
      ...segment,
      startTime: roundTime(startTime),
      endTime: roundTime(endTime),
      words: words?.length ? words : undefined,
    }]
  })
}

export function replaceEntriesInRange(
  entries: SubtitleEntry[],
  replacement: SubtitleEntry[] | null,
  range: RegenerationRange,
  preferences: FormattingPreferences,
  duration?: number,
): SubtitleEntry[] {
  if (replacement === null) {
    return entries
  }

  const untouched = entries.filter((entry) => !overlapsRange(entry, range))
  const previous = [...untouched].reverse().find((entry) => entry.endTime <= range.startTime)
  const next = untouched.find((entry) => entry.startTime >= range.endTime)
  const minimumStart = previous
    ? Math.max(range.startTime, previous.endTime + preferences.gapBetweenSubtitles)
    : range.startTime
  const maximumEnd = Math.min(
    range.endTime,
    duration ?? Number.POSITIVE_INFINITY,
    next ? next.startTime - preferences.gapBetweenSubtitles : range.endTime,
  )
  let cursor = minimumStart

  const bounded = [...replacement]
    .sort((first, second) => first.startTime - second.startTime || first.endTime - second.endTime)
    .flatMap((entry) => {
      const startTime = Math.max(entry.startTime, cursor)
      const endTime = Math.min(entry.endTime, maximumEnd)
      if (endTime <= startTime) {
        return []
      }
      cursor = roundTime(endTime + preferences.gapBetweenSubtitles)
      return [{ ...entry, startTime: roundTime(startTime), endTime: roundTime(endTime) }]
    })

  return sortAndRenumber([...untouched, ...bounded])
}

function overlapsRange(entry: SubtitleEntry, range: RegenerationRange): boolean {
  return entry.endTime > range.startTime && entry.startTime < range.endTime
}
