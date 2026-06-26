import type { FormattingPreferences, SubtitleEntry, SubtitleWord } from '../types/subtitles'
import { createId } from '../utils/ids'
import { clampTime, roundTime } from '../utils/time'

export type RawTranscriptionSegment = {
  startTime: number
  endTime: number
  text: string
  confidence?: number
  words?: SubtitleWord[]
}

export function normalizeSubtitleText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function splitIntoSubtitleLines(text: string, maxCharsPerLine: number): string {
  const normalized = normalizeSubtitleText(text).replace(/\n+/g, ' ')

  if (normalized.length <= maxCharsPerLine) {
    return normalized
  }

  const words = normalized.split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxCharsPerLine || !current) {
      current = next
      continue
    }

    lines.push(current)
    current = word
  }

  if (current) {
    lines.push(current)
  }

  if (lines.length <= 2) {
    return balanceShortLastLine(lines, maxCharsPerLine).join('\n')
  }

  const midpoint = Math.ceil(lines.length / 2)
  const first = lines.slice(0, midpoint).join(' ')
  const second = lines.slice(midpoint).join(' ')
  return balanceShortLastLine([first, second], maxCharsPerLine).join('\n')
}

export function formatSubtitleText(text: string, preferences: FormattingPreferences): string {
  return splitIntoSubtitleLines(text, Math.max(18, preferences.maxCharsPerLine))
}

export function makeSubtitleEntry(
  values: Omit<SubtitleEntry, 'id' | 'index'> & { id?: string; index?: number },
): SubtitleEntry {
  return {
    id: values.id ?? createId(),
    index: values.index ?? 1,
    startTime: roundTime(values.startTime),
    endTime: roundTime(values.endTime),
    text: normalizeSubtitleText(values.text),
    confidence: values.confidence,
    words: values.words,
  }
}

export function sortAndRenumber(entries: SubtitleEntry[]): SubtitleEntry[] {
  return [...entries]
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
    .map((entry, index) => ({ ...entry, index: index + 1 }))
}

export function shiftEntries(entries: SubtitleEntry[], shiftMilliseconds: number, duration?: number): SubtitleEntry[] {
  const shiftSeconds = shiftMilliseconds / 1000
  return sortAndRenumber(
    entries.map((entry) => {
      const shiftedStart = clampTime(entry.startTime + shiftSeconds, duration)
      const shiftedEnd = clampTime(entry.endTime + shiftSeconds, duration)
      const minimumEnd = duration === undefined ? shiftedStart + 0.1 : Math.min(duration, shiftedStart + 0.1)

      return {
        ...entry,
        startTime: shiftedStart,
        endTime: Math.max(shiftedEnd, minimumEnd),
      }
    }),
  )
}

export function removeEmptyEntries(entries: SubtitleEntry[]): SubtitleEntry[] {
  return sortAndRenumber(entries.filter((entry) => normalizeSubtitleText(entry.text).length > 0))
}

export function normalizeOverlaps(
  entries: SubtitleEntry[],
  preferences: Pick<FormattingPreferences, 'gapBetweenSubtitles' | 'minDuration'>,
  duration?: number,
): SubtitleEntry[] {
  const sorted = sortAndRenumber(entries)
  const normalized: SubtitleEntry[] = []

  for (const entry of sorted) {
    const previous = normalized.at(-1)
    let startTime = clampTime(entry.startTime, duration)
    let endTime = clampTime(Math.max(entry.endTime, startTime + preferences.minDuration), duration)

    if (previous && startTime < previous.endTime + preferences.gapBetweenSubtitles) {
      startTime = roundTime(previous.endTime + preferences.gapBetweenSubtitles)
      endTime = Math.max(endTime, roundTime(startTime + preferences.minDuration))
    }

    if (duration !== undefined) {
      endTime = Math.min(endTime, duration)
      if (startTime >= endTime) {
        startTime = Math.max(0, endTime - preferences.minDuration)
      }
    }

    normalized.push({
      ...entry,
      startTime: roundTime(startTime),
      endTime: roundTime(endTime),
    })
  }

  return sortAndRenumber(normalized)
}

export function splitEntry(entry: SubtitleEntry): [SubtitleEntry, SubtitleEntry] {
  const plainText = normalizeSubtitleText(entry.text).replace(/\n+/g, ' ')
  const splitIndex = findNaturalSplit(plainText)
  const firstText = plainText.slice(0, splitIndex).trim()
  const secondText = plainText.slice(splitIndex).trim()
  const duration = Math.max(0.2, entry.endTime - entry.startTime)
  const ratio = firstText.length / Math.max(plainText.length, 1)
  const splitTime = roundTime(entry.startTime + duration * Math.min(0.75, Math.max(0.25, ratio)))

  return [
    makeSubtitleEntry({
      startTime: entry.startTime,
      endTime: splitTime,
      text: firstText || plainText,
      confidence: entry.confidence,
    }),
    makeSubtitleEntry({
      startTime: splitTime,
      endTime: entry.endTime,
      text: secondText || plainText,
      confidence: entry.confidence,
    }),
  ]
}

export function mergeEntries(first: SubtitleEntry, second: SubtitleEntry): SubtitleEntry {
  return makeSubtitleEntry({
    startTime: Math.min(first.startTime, second.startTime),
    endTime: Math.max(first.endTime, second.endTime),
    text: normalizeSubtitleText(`${first.text}\n${second.text}`),
    confidence:
      first.confidence !== undefined && second.confidence !== undefined
        ? roundTime((first.confidence + second.confidence) / 2, 4)
        : first.confidence ?? second.confidence,
    words: [...(first.words ?? []), ...(second.words ?? [])],
  })
}

export function formatTranscriptionSegments(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
): SubtitleEntry[] {
  const entries: SubtitleEntry[] = []

  for (const segment of segments) {
    const text = normalizeSubtitleText(segment.text)
    if (!text) {
      continue
    }

    if (segment.words?.length && preferences.useWordTimestamps) {
      entries.push(...groupWords(segment.words, preferences, duration))
      continue
    }

    const splitSegments = splitLongSegment(segment, preferences)
    for (const splitSegment of splitSegments) {
      const formatted = formatSubtitleText(splitSegment.text, preferences)
      if (formatted) {
        entries.push(
          makeSubtitleEntry({
            startTime: clampTime(splitSegment.startTime, duration),
            endTime: clampTime(splitSegment.endTime, duration),
            text: formatted,
            confidence: splitSegment.confidence,
          }),
        )
      }
    }
  }

  return normalizeOverlaps(removeEmptyEntries(entries), preferences, duration)
}

function groupWords(words: SubtitleWord[], preferences: FormattingPreferences, duration?: number): SubtitleEntry[] {
  const entries: SubtitleEntry[] = []
  let group: SubtitleWord[] = []

  const flush = () => {
    if (!group.length) {
      return
    }

    const text = group.map((word) => word.text).join(' ')
    entries.push(
      makeSubtitleEntry({
        startTime: clampTime(group[0].startTime, duration),
        endTime: clampTime(group[group.length - 1].endTime, duration),
        text: formatSubtitleText(text, preferences),
        words: group,
      }),
    )
    group = []
  }

  for (const word of words) {
    const candidate = [...group, word]
    const candidateText = candidate.map((item) => item.text).join(' ')
    const candidateDuration = candidate.at(-1)!.endTime - candidate[0].startTime
    const previous = group.at(-1)
    const pause = previous ? word.startTime - previous.endTime : 0

    if (
      group.length > 0 &&
      (candidateText.length > preferences.maxCharsPerSubtitle ||
        candidateDuration > preferences.maxDuration ||
        pause > 0.9)
    ) {
      flush()
    }

    group.push(word)
  }

  flush()
  return entries
}

function splitLongSegment(
  segment: RawTranscriptionSegment,
  preferences: FormattingPreferences,
): RawTranscriptionSegment[] {
  const text = normalizeSubtitleText(segment.text).replace(/\n+/g, ' ')
  const duration = Math.max(0.1, segment.endTime - segment.startTime)

  if (text.length <= preferences.maxCharsPerSubtitle && duration <= preferences.maxDuration) {
    return [segment]
  }

  const parts = splitTextByLength(text, preferences.maxCharsPerSubtitle)
  return parts.map((part, index) => {
    const startRatio = index / parts.length
    const endRatio = (index + 1) / parts.length
    return {
      ...segment,
      startTime: roundTime(segment.startTime + duration * startRatio),
      endTime: roundTime(segment.startTime + duration * endRatio),
      text: part,
    }
  })
}

function splitTextByLength(text: string, maxLength: number): string[] {
  const parts: string[] = []
  let remaining = text.trim()

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength + 1)
    const punctuation = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '))
    const splitAt = punctuation > maxLength * 0.45 ? punctuation + 1 : Math.max(slice.lastIndexOf(' '), maxLength)
    parts.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }

  if (remaining) {
    parts.push(remaining)
  }

  return parts
}

function findNaturalSplit(text: string): number {
  const midpoint = Math.floor(text.length / 2)
  const candidates = [', ', '; ', ': ', '. ', '? ', '! ', ' ']

  for (const candidate of candidates) {
    const before = text.lastIndexOf(candidate, midpoint)
    if (before > text.length * 0.25) {
      return before + candidate.length
    }

    const after = text.indexOf(candidate, midpoint)
    if (after > -1 && after < text.length * 0.75) {
      return after + candidate.length
    }
  }

  return midpoint
}

function balanceShortLastLine(lines: string[], maxCharsPerLine: number): string[] {
  if (lines.length !== 2) {
    return lines
  }

  const [first, second] = lines
  if (second.length > 6 || first.length <= maxCharsPerLine) {
    return lines
  }

  const words = first.split(' ')
  const moved = words.pop()
  if (!moved) {
    return lines
  }

  const newSecond = `${moved} ${second}`
  const newFirst = words.join(' ')
  return newFirst && newSecond.length <= maxCharsPerLine ? [newFirst, newSecond] : lines
}
