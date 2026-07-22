import type { FormattingPreferences, SubtitleEntry, SubtitleWord } from '../types/subtitles'
import { createId } from '../utils/ids'
import { clampTime, roundTime } from '../utils/time'

export type RawTranscriptionSegment = {
  startTime: number
  endTime: number
  text: string
  confidence?: number
  words?: SubtitleWord[]
  /** Internal evidence that a segment began in an overlap context before its owned window. */
  boundaryContextPrefix?: boolean
}

const PROFESSIONAL_MIN_SUBTITLE_DURATION_SECONDS = 5 / 6
const PAUSE_SPLIT_SECONDS = 0.35
const CLAUSE_BOUNDARY_PAUSE_SECONDS = 0.2
const LONG_PAUSE_SPLIT_SECONDS = 0.75
const DUPLICATE_GAP_SECONDS = 0.75
const TINY_GAP_SECONDS = 0.12
const MAX_EXTENSION_PAST_AUDIO_SECONDS = 0.5
const MIN_GENERATED_CAPTION_DURATION = 0.25
const DEFAULT_MANUAL_SUBTITLE_DURATION_SECONDS = 2
const MIN_MANUAL_SUBTITLE_DURATION_SECONDS = 0.1

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
  const limit = Math.max(1, Math.floor(maxCharsPerLine))

  if (normalized.length <= limit) {
    return normalized
  }

  const words = normalized.split(/\s+/).filter(Boolean)
  const bestSplit = findBestLineSplit(words, limit)
  if (bestSplit !== null) {
    return `${words.slice(0, bestSplit).join(' ')}\n${words.slice(bestSplit).join(' ')}`
  }

  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= limit || !current) {
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
    return balanceShortLastLine(lines, limit).join('\n')
  }

  const midpoint = Math.ceil(lines.length / 2)
  const first = lines.slice(0, midpoint).join(' ')
  const second = lines.slice(midpoint).join(' ')
  return balanceShortLastLine([first, second], limit).join('\n')
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

export function makeSubtitleEntryAtTime(startTime: number, duration?: number): SubtitleEntry {
  const safeDuration = duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined
  const safeStartTime = Number.isFinite(startTime) ? Math.max(0, startTime) : 0
  const boundedStartTime = roundTime(Math.min(safeStartTime, safeDuration ?? Number.POSITIVE_INFINITY))
  if (safeDuration !== undefined && boundedStartTime >= safeDuration) {
    return makeSubtitleEntry({
      startTime: Math.max(0, safeDuration - Math.min(MIN_MANUAL_SUBTITLE_DURATION_SECONDS, safeDuration)),
      endTime: safeDuration,
      text: 'New subtitle',
    })
  }
  const preferredEndTime = roundTime(boundedStartTime + DEFAULT_MANUAL_SUBTITLE_DURATION_SECONDS)
  const boundedEndTime =
    safeDuration !== undefined && safeDuration > boundedStartTime
      ? Math.min(safeDuration, preferredEndTime)
      : preferredEndTime

  return makeSubtitleEntry({
    startTime: boundedStartTime,
    endTime: boundedEndTime,
    text: 'New subtitle',
  })
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
      const finalEnd = Math.max(shiftedEnd, minimumEnd)
      const shiftedWordCandidates = entry.words?.map((word) => {
        const startTime = roundTime(Math.max(shiftedStart, clampTime(word.startTime + shiftSeconds, duration)))
        const endTime = roundTime(Math.min(finalEnd, clampTime(word.endTime + shiftSeconds, duration)))

        return endTime > startTime ? { ...word, startTime, endTime } : undefined
      })
      const shiftedWords = shiftedWordCandidates?.filter((word): word is SubtitleWord => Boolean(word))
      const wordsRemainValid = shiftedWords?.length === shiftedWordCandidates?.length

      return {
        ...entry,
        startTime: shiftedStart,
        endTime: finalEnd,
        confidence: wordsRemainValid ? entry.confidence : undefined,
        words: wordsRemainValid ? shiftedWords : undefined,
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
  const { firstText, plainText, secondText } = splitEntryText(entry)
  const duration = Math.max(0.2, entry.endTime - entry.startTime)
  const ratio = firstText.length / Math.max(plainText.length, 1)
  const splitTime = roundTime(entry.startTime + duration * Math.min(0.75, Math.max(0.25, ratio)))

  return buildSplitEntries(entry, splitTime, firstText, secondText, plainText)
}

export function canSplitEntryAtTime(
  entry: SubtitleEntry,
  splitTime: number,
  minimumSideDuration = 0.1,
): boolean {
  if (
    !Number.isFinite(entry.startTime) ||
    !Number.isFinite(entry.endTime) ||
    !Number.isFinite(splitTime) ||
    !Number.isFinite(minimumSideDuration)
  ) {
    return false
  }

  const roundedSplitTime = roundTime(splitTime)
  const minimum = Math.max(0.1, minimumSideDuration)
  return (
    roundTime(roundedSplitTime - entry.startTime) >= minimum &&
    roundTime(entry.endTime - roundedSplitTime) >= minimum
  )
}

export function splitEntryAtTime(
  entry: SubtitleEntry,
  splitTime: number,
  minimumSideDuration = 0.1,
): [SubtitleEntry, SubtitleEntry] | undefined {
  if (!canSplitEntryAtTime(entry, splitTime, minimumSideDuration)) {
    return undefined
  }

  const { firstText, plainText, secondText } = splitEntryText(entry)
  return buildSplitEntries(entry, roundTime(splitTime), firstText, secondText, plainText)
}

function splitEntryText(entry: SubtitleEntry): {
  plainText: string
  firstText: string
  secondText: string
} {
  const plainText = normalizeSubtitleText(entry.text).replace(/\n+/g, ' ')
  const splitIndex = findNaturalSplit(plainText)
  return {
    plainText,
    firstText: plainText.slice(0, splitIndex).trim(),
    secondText: plainText.slice(splitIndex).trim(),
  }
}

function buildSplitEntries(
  entry: SubtitleEntry,
  splitTime: number,
  firstText: string,
  secondText: string,
  plainText: string,
): [SubtitleEntry, SubtitleEntry] {

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
  const entries = optimizeGeneratedCaptions(segments, preferences, duration).flatMap((segment, index) => {
    const text = formatSubtitleText(segment.text, preferences)
    if (!text) {
      return []
    }

    return [
      makeSubtitleEntry({
        id: `generated-${index + 1}`,
        index: index + 1,
        startTime: segment.startTime,
        endTime: segment.endTime,
        text,
        confidence: segment.confidence,
        words: segment.words,
      }),
    ]
  })

  return sortAndRenumber(entries)
}

export function optimizeGeneratedCaptions(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  const normalized = normalizeGeneratedSegments(segments, preferences, duration)
  const deduped = dedupeOverlappingSegments(normalized, preferences, duration)
  const extended = extendSegmentDurationsBeforeSplitting(deduped, preferences, duration)
  const split = extended.flatMap((segment) => splitGeneratedSegment(segment, preferences, duration))
  const readable = improveGeneratedCaptionDurations(split, preferences, duration)
  const smoothed = smoothAbruptGeneratedCaptions(readable, preferences, duration)
  const rebalanced = improveGeneratedCaptionDurations(smoothed, preferences, duration)
  const overlapNormalized = normalizeGeneratedCaptionOverlaps(rebalanced, preferences, duration)
  // Resolving an overlap can squeeze a middle cue below the readable minimum.
  // Give that newly abrupt fragment one final chance to merge with a compatible
  // neighbor, then normalize once more to preserve monotonic, non-overlapping time.
  const finallySmoothed = smoothAbruptGeneratedCaptions(overlapNormalized, preferences, duration, true)
  return normalizeGeneratedCaptionOverlaps(finallySmoothed, preferences, duration)
}

export function calculateCharactersPerSecond(text: string, startTime: number, endTime: number): number {
  const duration = endTime - startTime
  if (!Number.isFinite(duration) || duration <= 0) {
    return Number.POSITIVE_INFINITY
  }

  return countReadableCharacters(text) / duration
}

export function calculateReadableDuration(text: string, preferences: FormattingPreferences): number {
  const readableDuration = countReadableCharacters(text) / preferences.targetMaxCps
  const minimum = getMinimumGeneratedCaptionDuration(preferences)
  return roundTime(Math.min(preferences.maxDuration, Math.max(minimum, readableDuration)))
}

export function needsSplitForReadability(
  text: string,
  startTime: number,
  endTime: number,
  preferences: FormattingPreferences,
): boolean {
  const normalized = normalizeSubtitleText(text).replace(/\n+/g, ' ')
  const duration = endTime - startTime
  const unbrokenCharacterCount = /\s/u.test(normalized) ? 0 : splitGraphemeClusters(normalized).length
  return (
    normalized.length > getMaxGeneratedCaptionCharacters(preferences) ||
    unbrokenCharacterCount > Math.max(1, Math.floor(preferences.maxCharsPerLine)) ||
    duration > preferences.maxDuration ||
    calculateCharactersPerSecond(normalized, startTime, endTime) > preferences.hardMaxCps
  )
}

export function normalizeForDuplicateComparison(text: string): string {
  return normalizeSubtitleText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenSimilarity(first: string, second: string): number {
  const firstTokens = tokenizeForComparison(first)
  const secondTokens = tokenizeForComparison(second)
  if (!firstTokens.length && !secondTokens.length) {
    return 1
  }
  if (!firstTokens.length || !secondTokens.length) {
    return 0
  }

  const remaining = new Map<string, number>()
  for (const token of secondTokens) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1)
  }

  let matches = 0
  for (const token of firstTokens) {
    const count = remaining.get(token) ?? 0
    if (count > 0) {
      matches += 1
      remaining.set(token, count - 1)
    }
  }

  return matches / Math.max(firstTokens.length, secondTokens.length)
}

export function dedupeOverlappingSegments(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  const deduped: RawTranscriptionSegment[] = []

  for (const segment of sortRawSegments(segments)) {
    const previous = deduped.at(-1)
    if (previous && areNearDuplicateSegments(previous, segment)) {
      deduped[deduped.length - 1] = chooseDuplicateSegment(previous, segment, preferences, duration)
      continue
    }

    deduped.push(segment)
  }

  return deduped
}

function normalizeGeneratedSegments(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  return sortRawSegments(segments)
    .flatMap((segment): RawTranscriptionSegment[] => {
      const text = normalizeSubtitleText(segment.text).replace(/\n+/g, ' ')
      if (!text) {
        return []
      }

      const usableWords = getUsableWords(segment, duration)
      const wordStart = usableWords.at(0)?.startTime
      const wordEnd = usableWords.at(-1)?.endTime
      const fallbackStart = normalizeSegmentTime(segment.startTime, 0, duration)
      const fallbackEnd = normalizeSegmentTime(segment.endTime, fallbackStart + preferences.minDuration, duration)
      const startTime =
        wordStart === undefined
          ? fallbackStart
          : normalizeSegmentTime(wordStart - preferences.subtitleLeadIn, fallbackStart, duration)
      const endTime =
        wordEnd === undefined
          ? fallbackEnd
          : normalizeSegmentTime(wordEnd + preferences.subtitleTailPadding, fallbackEnd, duration)
      const safeEndTime = endTime > startTime ? endTime : normalizeSegmentTime(startTime + preferences.minDuration, startTime + 0.1, duration)

      return [
        {
          ...segment,
          startTime: roundTime(Math.max(0, startTime)),
          endTime: roundTime(safeEndTime),
          text,
          words: usableWords.length ? usableWords : undefined,
        },
      ]
    })
    .filter((segment) => segment.endTime > segment.startTime)
}

function extendSegmentDurationsBeforeSplitting(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  const sorted = sortRawSegments(segments)

  return sorted.map((segment, index) => {
    if (segment.words?.length || hasLowConfidenceTiming(segment)) {
      return segment
    }

    const next = sorted[index + 1]
    const minimumGap = next ? getMinimumPreservedGap(segment, next, preferences) : 0
    const maxEnd = Math.min(
      duration ?? Number.POSITIVE_INFINITY,
      next === undefined ? Number.POSITIVE_INFINITY : next.startTime - minimumGap,
    )
    const desiredEnd = segment.startTime + calculateTotalReadableDuration(segment.text, preferences)
    const endTime = Math.min(maxEnd, Math.max(segment.endTime, desiredEnd))

    return {
      ...segment,
      endTime: roundTime(Math.max(segment.startTime + MIN_GENERATED_CAPTION_DURATION, endTime)),
    }
  })
}

function splitGeneratedSegment(
  segment: RawTranscriptionSegment,
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  if (segment.words?.length) {
    return splitWordTimedSegment(segment, preferences, duration)
  }

  return splitPlainTimedSegment(segment, preferences, duration)
}

function splitWordTimedSegment(
  segment: RawTranscriptionSegment,
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  const words = getUsableWords(segment, duration)
  if (!words.length) {
    return splitPlainTimedSegment({ ...segment, words: undefined }, preferences, duration)
  }

  const groups: SubtitleWord[][] = []
  let startIndex = 0

  while (startIndex < words.length) {
    const endIndex = findBestWordGroupEnd(words, startIndex, preferences)
    groups.push(words.slice(startIndex, endIndex + 1))
    startIndex = endIndex + 1
  }

  return groups.map((group) => {
    const text = joinSubtitleWords(group.map((word) => word.text))
    const startTime = normalizeSegmentTime(group[0].startTime - preferences.subtitleLeadIn, 0, duration)
    const endTime = normalizeSegmentTime(
      group[group.length - 1].endTime + preferences.subtitleTailPadding,
      group[0].startTime,
      duration,
    )

    return {
      ...segment,
      startTime: roundTime(startTime),
      endTime: roundTime(Math.max(endTime, startTime + MIN_GENERATED_CAPTION_DURATION)),
      text,
      words: group,
    }
  })
}

function splitPlainTimedSegment(
  segment: RawTranscriptionSegment,
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  const text = normalizeSubtitleText(segment.text).replace(/\n+/g, ' ')
  if (!text) {
    return []
  }

  const parts = splitTextIntoReadableParts(text, segment.endTime - segment.startTime, preferences)
  const evidenceDuration = Math.max(0, segment.endTime - segment.startTime)
  if (
    hasLowConfidenceTiming(segment) &&
    countReadableCharacters(text) / Math.max(1, preferences.hardMaxCps) > evidenceDuration
  ) {
    // Untimestamped fallback text is intentionally low confidence. If it cannot
    // be displayed readably inside its one raw-speech span, suppress it instead
    // of manufacturing extra time over confirmed silence.
    return []
  }
  if (parts.length <= 1) {
    return [
      {
        ...segment,
        text,
        endTime: roundTime(Math.min(duration ?? Number.POSITIVE_INFINITY, segment.endTime)),
      },
    ]
  }

  const preferredMinimumDuration = getMinimumGeneratedCaptionDuration(preferences)
  const weights = parts.map((part) => Math.max(preferredMinimumDuration, calculateTotalReadableDuration(part, preferences)))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const totalDuration = evidenceDuration
  const minimumPartDuration =
    totalDuration >= preferredMinimumDuration * parts.length
      ? preferredMinimumDuration
      : totalDuration / parts.length
  let cursor = segment.startTime

  return parts.map((part, index) => {
    const isLast = index === parts.length - 1
    const remainingParts = parts.length - index - 1
    const partDuration = isLast ? segment.endTime - cursor : totalDuration * (weights[index] / totalWeight)
    const latestEnd = segment.endTime - minimumPartDuration * remainingParts
    const targetEnd = cursor + Math.max(minimumPartDuration, partDuration)
    const endTime = isLast ? segment.endTime : roundTime(Math.min(latestEnd, targetEnd))
    const caption = {
      ...segment,
      startTime: roundTime(cursor),
      endTime: roundTime(Math.max(endTime, cursor + minimumPartDuration)),
      text: part,
      words: undefined,
    }
    cursor = caption.endTime
    return caption
  })
}

function improveGeneratedCaptionDurations(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  const sorted = sortRawSegments(segments)

  return sorted.map((segment, index) => {
    const next = sorted[index + 1]
    const minimumGap = next ? getMinimumPreservedGap(segment, next, preferences) : 0
    const maxEnd = Math.min(
      duration ?? Number.POSITIVE_INFINITY,
      next === undefined ? segment.startTime + preferences.maxDuration : next.startTime - minimumGap,
      segment.startTime + preferences.maxDuration,
    )

    if (segment.words?.length) {
      const words = getUsableWords(segment, duration)
      const firstWord = words.at(0)
      const lastWord = words.at(-1)
      if (!firstWord || !lastWord) {
        return segment
      }

      const desiredEnd = segment.startTime + calculateReadableDuration(segment.text, preferences)
      const wordTimedEnd = lastWord.endTime + preferences.subtitleTailPadding
      return {
        ...segment,
        startTime: roundTime(Math.max(0, firstWord.startTime - preferences.subtitleLeadIn)),
        endTime: roundTime(Math.min(duration ?? Number.POSITIVE_INFINITY, maxEnd, Math.max(segment.endTime, desiredEnd, wordTimedEnd))),
        words,
      }
    }


    if (hasLowConfidenceTiming(segment)) {
      return segment
    }

    const desiredEnd = segment.startTime + calculateReadableDuration(segment.text, preferences)
    return {
      ...segment,
      endTime: roundTime(Math.min(maxEnd, Math.max(segment.endTime, desiredEnd))),
    }
  })
}

function smoothAbruptGeneratedCaptions(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
  segmentOnly = false,
): RawTranscriptionSegment[] {
  const smoothed: RawTranscriptionSegment[] = []

  for (const segment of sortRawSegments(segments)) {
    const previous = smoothed.at(-1)
    if (
      previous &&
      (!segmentOnly || (!previous.words?.length && !segment.words?.length)) &&
      shouldMergeAbruptCaptions(previous, segment, preferences, duration)
    ) {
      smoothed[smoothed.length - 1] = mergeRawSegments(previous, segment, duration)
      continue
    }

    smoothed.push(segment)
  }

  return smoothed
}

function shouldMergeAbruptCaptions(
  first: RawTranscriptionSegment,
  second: RawTranscriptionSegment,
  preferences: FormattingPreferences,
  duration?: number,
): boolean {
  const gap = second.startTime - first.endTime
  if (gap < -preferences.gapBetweenSubtitles || gap > preferences.closeGapsBelow) {
    return false
  }

  if (isMeaningfulGeneratedBoundary(first, second)) {
    return false
  }

  if (!isAbruptGeneratedCaption(first, preferences) && !isAbruptGeneratedCaption(second, preferences)) {
    return false
  }

  const text = joinCaptionText(first.text, second.text)
  const startTime = Math.min(first.startTime, second.startTime)
  const endTime = Math.min(duration ?? Number.POSITIVE_INFINITY, Math.max(first.endTime, second.endTime))
  if (
    text.length > getMaxGeneratedCaptionCharacters(preferences) ||
    endTime - startTime > preferences.maxDuration ||
    calculateCharactersPerSecond(text, startTime, endTime) > preferences.hardMaxCps
  ) {
    return false
  }

  return true
}

function isAbruptGeneratedCaption(segment: RawTranscriptionSegment, preferences: FormattingPreferences): boolean {
  const duration = segment.endTime - segment.startTime
  const wordCount = tokenizeForComparison(segment.text).length
  return (
    duration < getMinimumGeneratedCaptionDuration(preferences) ||
    calculateCharactersPerSecond(segment.text, segment.startTime, segment.endTime) > preferences.hardMaxCps ||
    (wordCount <= 2 && duration < getMinimumGeneratedCaptionDuration(preferences) + 0.2)
  )
}

function mergeRawSegments(
  first: RawTranscriptionSegment,
  second: RawTranscriptionSegment,
  duration?: number,
): RawTranscriptionSegment {
  const words = [...(first.words ?? []), ...(second.words ?? [])]
  return {
    ...first,
    startTime: roundTime(Math.min(first.startTime, second.startTime)),
    endTime: roundTime(Math.min(duration ?? Number.POSITIVE_INFINITY, Math.max(first.endTime, second.endTime))),
    text: joinCaptionText(first.text, second.text),
    confidence:
      first.confidence !== undefined && second.confidence !== undefined
        ? roundTime((first.confidence + second.confidence) / 2, 4)
        : first.confidence ?? second.confidence,
    words: words.length ? words : undefined,
  }
}

function normalizeGeneratedCaptionOverlaps(
  segments: RawTranscriptionSegment[],
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment[] {
  const normalized: RawTranscriptionSegment[] = []

  for (const segment of sortRawSegments(segments)) {
    const next = {
      ...segment,
      startTime: clampTime(segment.startTime, duration),
      endTime: clampTime(segment.endTime, duration),
    }

    const previous = normalized.at(-1)
    if (previous) {
      const requiredStart = previous.endTime + preferences.gapBetweenSubtitles
      const actualGap = next.startTime - previous.endTime

      if (actualGap < preferences.gapBetweenSubtitles) {
        const trimmedPreviousEnd = roundTime(next.startTime - preferences.gapBetweenSubtitles)
        const previousContentEnd = getContentEndTime(previous)

        if (trimmedPreviousEnd >= previous.startTime + MIN_GENERATED_CAPTION_DURATION && trimmedPreviousEnd >= previousContentEnd) {
          previous.endTime = trimmedPreviousEnd
        } else {
          const shiftedStart = roundTime(requiredStart)
          const currentContentStart = getContentStartTime(next)
          if (!next.words?.length || shiftedStart <= currentContentStart + preferences.subtitleLeadIn) {
            next.startTime = shiftedStart
          } else if (previousContentEnd >= previous.startTime + MIN_GENERATED_CAPTION_DURATION) {
            previous.endTime = roundTime(Math.min(previous.endTime, previousContentEnd))
          } else {
            next.startTime = shiftedStart
          }
        }
      } else if (
        actualGap > preferences.gapBetweenSubtitles &&
        actualGap < preferences.closeGapsBelow &&
        !isMeaningfulGeneratedBoundary(previous, next)
      ) {
        const chainedPreviousEnd = roundTime(next.startTime - preferences.gapBetweenSubtitles)
        if (canExtendCaptionEnd(previous, chainedPreviousEnd, preferences, duration)) {
          previous.endTime = chainedPreviousEnd
        } else if (actualGap < TINY_GAP_SECONDS) {
          const chainedStart = roundTime(requiredStart)
          const currentContentStart = getContentStartTime(next)
          if (!next.words?.length || chainedStart <= currentContentStart + preferences.subtitleLeadIn) {
            next.startTime = chainedStart
          }
        }
      }

      if (previous.endTime > next.startTime) {
        const earliestBoundary = previous.startTime + 0.001
        const latestBoundary = next.endTime - 0.001
        const contentMidpoint = (getContentEndTime(previous) + getContentStartTime(next)) / 2
        const boundary = roundTime(Math.min(latestBoundary, Math.max(earliestBoundary, contentMidpoint)))
        previous.endTime = roundTime(Math.min(previous.endTime, boundary))
        next.startTime = roundTime(Math.max(next.startTime, previous.endTime))
      }
    }

    if (next.endTime <= next.startTime) {
      next.endTime = roundTime(next.startTime + MIN_GENERATED_CAPTION_DURATION)
    }

    if (duration !== undefined) {
      next.endTime = Math.min(duration, next.endTime)
    }

    if (next.endTime > next.startTime) {
      normalized.push(next)
    }
  }

  return sortRawSegments(normalized)
}

function splitTextIntoReadableParts(
  text: string,
  duration: number,
  preferences: FormattingPreferences,
): string[] {
  const queue = [normalizeSubtitleText(text).replace(/\n+/g, ' ')]
  const parts: string[] = []
  const maximumOperations = Math.max(100, text.length * 2 + 1)
  let guard = 0

  while (queue.length && guard < maximumOperations) {
    guard += 1
    const current = queue.shift() ?? ''
    const estimatedDuration = estimatePartDuration(current, text, duration)
    if (!current || !needsSplitForReadability(current, 0, estimatedDuration, preferences)) {
      if (current) {
        parts.push(current)
      }
      continue
    }

    const splitIndex = findBestCaptionTextSplit(current, preferences)
    if (splitIndex === null) {
      parts.push(current)
      continue
    }

    const first = current.slice(0, splitIndex).trim()
    const second = current.slice(splitIndex).trim()
    if (!first || !second) {
      parts.push(current)
      continue
    }

    queue.unshift(second)
    queue.unshift(first)
  }

  // Each successful split strictly shortens its inputs, so the input-derived
  // bound is enough to finish without discarding or emitting an oversized tail.
  if (queue.length) {
    throw new Error('Subtitle text splitting exceeded its deterministic operation bound.')
  }

  return parts
}

function findBestCaptionTextSplit(text: string, preferences: FormattingPreferences): number | null {
  const strong = findPunctuationSplit(text, /[.!?]["')\]]?\s+/g, preferences)
  if (strong !== null) {
    return strong
  }

  const soft = findPunctuationSplit(text, /[,;:\u2013\u2014]["')\]]?\s+/g, preferences)
  if (soft !== null) {
    return soft
  }

  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= 2) {
    return findUnbrokenTextSplit(text, preferences)
  }

  const capacity = getMaxGeneratedCaptionCharacters(preferences)
  const target = text.length > capacity * 2 ? Math.ceil(text.length / 2) : Math.min(capacity, Math.ceil(text.length / 2))
  let best: { index: number; score: number } | null = null
  let offset = 0

  for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
    offset += words[wordIndex - 1].length + (wordIndex === 1 ? 0 : 1)
    const first = words.slice(0, wordIndex).join(' ')
    const second = words.slice(wordIndex).join(' ')
    if (
      !isViableRecursivePart(first, text.length) ||
      !isViableRecursivePart(second, text.length)
    ) {
      continue
    }
    if (isAvoidableOneUnitCaption(first, second, capacity)) {
      continue
    }

    const score =
      Math.abs(first.length - target) +
      phraseBreakPenalty(words[wordIndex - 1], words[wordIndex]) +
      orphanCaptionPenalty(first, second)
    if (!best || score < best.score) {
      best = { index: offset + 1, score }
    }
  }

  return best?.index ?? null
}

function findPunctuationSplit(
  text: string,
  pattern: RegExp,
  preferences: FormattingPreferences,
): number | null {
  let match: RegExpExecArray | null
  let best: { index: number; score: number } | null = null
  const capacity = getMaxGeneratedCaptionCharacters(preferences)
  const target = text.length > capacity * 2 ? Math.ceil(text.length / 2) : Math.min(capacity, Math.ceil(text.length / 2))

  while ((match = pattern.exec(text)) !== null) {
    const index = match.index + match[0].trimEnd().length
    const first = text.slice(0, index).trim()
    const second = text.slice(index).trim()
    if (
      !isViableRecursivePart(first, text.length) ||
      !isViableRecursivePart(second, text.length)
    ) {
      continue
    }
    if (isAvoidableOneUnitCaption(first, second, capacity)) {
      continue
    }

    const score = Math.abs(first.length - target) + orphanCaptionPenalty(first, second)
    if (!best || score < best.score) {
      best = { index, score }
    }
  }

  return best?.index ?? null
}

function isViableRecursivePart(text: string, sourceLength: number): boolean {
  return Boolean(text) && text.length < sourceLength
}

function findUnbrokenTextSplit(text: string, preferences: FormattingPreferences): number | null {
  if (/\s/u.test(text)) {
    return null
  }
  const characters = splitGraphemeClusters(text)
  const lineLimit = Math.max(1, Math.floor(preferences.maxCharsPerLine))
  if (characters.length <= lineLimit) {
    return null
  }

  const target = Math.min(lineLimit, Math.ceil(characters.length / 2))
  const punctuation = /[.!?;:,\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u2026\u2014]/u
  let splitCharacterIndex = target
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < characters.length; index += 1) {
    if (!punctuation.test(characters[index - 1])) {
      continue
    }
    const distance = Math.abs(index - target)
    if (distance < bestDistance) {
      splitCharacterIndex = index
      bestDistance = distance
    }
  }

  return characters.slice(0, splitCharacterIndex).join('').length
}

function findBestWordGroupEnd(
  words: SubtitleWord[],
  startIndex: number,
  preferences: FormattingPreferences,
): number {
  const lastIndex = words.length - 1
  const remainingText = joinSubtitleWords(words.slice(startIndex).map((word) => word.text))
  const remainingDuration = words[lastIndex].endTime - words[startIndex].startTime
  const preferredNaturalBoundary = findPreferredNaturalWordBoundary(words, startIndex)

  if (!needsSplitForReadability(remainingText, 0, remainingDuration, preferences)) {
    return preferredNaturalBoundary ?? lastIndex
  }

  let best: { index: number; score: number } | null = null

  for (let index = startIndex; index < lastIndex; index += 1) {
    const group = words.slice(startIndex, index + 1)
    const text = joinSubtitleWords(group.map((word) => word.text))
    const groupDuration = group.at(-1)!.endTime - group[0].startTime
    const remainingCount = lastIndex - index
    const nextWord = words[index + 1]
    const pauseAfter = Math.max(0, nextWord.startTime - words[index].endTime)
    const possibleDisplayDuration =
      groupDuration +
      preferences.subtitleLeadIn +
      preferences.subtitleTailPadding +
      Math.min(Math.max(0, pauseAfter - preferences.gapBetweenSubtitles), MAX_EXTENSION_PAST_AUDIO_SECONDS)
    const readableShortfall = Math.max(0, calculateReadableDuration(text, preferences) - possibleDisplayDuration)
    const remainingWords = words.slice(index + 1)
    const remainingText = joinSubtitleWords(remainingWords.map((word) => word.text))
    const remainingDisplayDuration = remainingWords.length
      ? words[lastIndex].endTime -
        remainingWords[0].startTime +
        preferences.subtitleLeadIn +
        preferences.subtitleTailPadding
      : 0
    const remainingShortfall = remainingWords.length
      ? Math.max(0, calculateReadableDuration(remainingText, preferences) - remainingDisplayDuration)
      : 0
    const maxCaptionCharacters = getMaxGeneratedCaptionCharacters(preferences)
    const overLimitPenalty =
      text.length > maxCaptionCharacters || groupDuration > preferences.maxDuration ? 800 : 0
    const oneWordFragmentPenalty =
      (group.length <= 1 || remainingCount <= 1) && pauseAfter < LONG_PAUSE_SPLIT_SECONDS
        ? 140
        : 0
    const score =
      overLimitPenalty +
      readableShortfall * 90 +
      remainingShortfall * 45 +
      Math.abs(text.length - maxCaptionCharacters * 0.75) +
      phraseBreakPenalty(words[index].text, nextWord.text) +
      wordBoundaryBonus(words[index].text, pauseAfter) +
      (preferredNaturalBoundary === index ? -70 : 0) +
      oneWordFragmentPenalty +
      (possibleDisplayDuration < getMinimumGeneratedCaptionDuration(preferences) && group.length > 1 ? 55 : 0)

    if (!best || score < best.score) {
      best = { index, score }
    }
  }

  return best?.index ?? Math.min(lastIndex, startIndex + 1)
}

function findPreferredNaturalWordBoundary(words: SubtitleWord[], startIndex: number): number | null {
  const lastIndex = words.length - 1
  const totalText = joinSubtitleWords(words.slice(startIndex).map((word) => word.text))
  const targetLength = totalText.length / 2
  let best: { index: number; score: number } | null = null

  for (let index = startIndex; index < lastIndex; index += 1) {
    const pauseAfter = Math.max(0, words[index + 1].startTime - words[index].endTime)
    const firstCount = index - startIndex + 1
    const secondCount = lastIndex - index
    const hasBalancedSides = firstCount >= 2 && secondCount >= 2
    const isLongPause = pauseAfter + 0.001 >= LONG_PAUSE_SPLIT_SECONDS
    const isNaturalBoundary =
      isLongPause ||
      (hasBalancedSides && pauseAfter + 0.001 >= PAUSE_SPLIT_SECONDS) ||
      (
        hasBalancedSides &&
        hasStrongPunctuation(words[index].text) &&
        pauseAfter + 0.001 >= CLAUSE_BOUNDARY_PAUSE_SECONDS
      )
    if (!isNaturalBoundary) {
      continue
    }

    const firstText = joinSubtitleWords(words.slice(startIndex, index + 1).map((word) => word.text))
    const score =
      Math.abs(firstText.length - targetLength) +
      phraseBreakPenalty(words[index].text, words[index + 1].text) +
      wordBoundaryBonus(words[index].text, pauseAfter) +
      (!isLongPause && (firstCount <= 1 || secondCount <= 1) ? 140 : 0)
    if (!best || score < best.score) {
      best = { index, score }
    }
  }

  return best?.index ?? null
}

function wordBoundaryBonus(previousText: string, pauseAfter: number): number {
  let bonus = hasStrongPunctuation(previousText) ? -85 : hasSoftPunctuation(previousText) ? -40 : 0
  if (pauseAfter + 0.001 >= LONG_PAUSE_SPLIT_SECONDS) {
    bonus -= 140
  } else if (pauseAfter + 0.001 >= PAUSE_SPLIT_SECONDS) {
    bonus -= 95
  } else if (pauseAfter + 0.001 >= CLAUSE_BOUNDARY_PAUSE_SECONDS) {
    bonus -= 30
  }
  return bonus
}

function chooseDuplicateSegment(
  first: RawTranscriptionSegment,
  second: RawTranscriptionSegment,
  preferences: FormattingPreferences,
  duration?: number,
): RawTranscriptionSegment {
  const preferred = scoreDuplicateCandidate(second, preferences) > scoreDuplicateCandidate(first, preferences) ? second : first
  const other = preferred === first ? second : first
  const preferredText = normalizeForDuplicateComparison(preferred.text)
  const otherText = normalizeForDuplicateComparison(other.text)
  const shouldUseLongerText = otherText.includes(preferredText) && other.text.length > preferred.text.length
  const text = shouldUseLongerText ? other.text : preferred.text
  const textEvidence = shouldUseLongerText ? other : preferred
  const mergedStart = Math.min(first.startTime, second.startTime)
  const mergedEnd = Math.max(first.endTime, second.endTime)
  const mergedDuration = mergedEnd - mergedStart
  const readableDuration = calculateReadableDuration(text, preferences)
  const canMergeTiming =
    !preferred.words?.length &&
    mergedDuration <= preferences.maxDuration &&
    mergedDuration <= Math.max(readableDuration + 0.8, preferred.endTime - preferred.startTime + 0.5)

  return {
    ...preferred,
    startTime: roundTime(canMergeTiming ? mergedStart : preferred.startTime),
    endTime: roundTime(canMergeTiming ? Math.min(duration ?? Number.POSITIVE_INFINITY, mergedEnd) : preferred.endTime),
    text,
    words: textEvidence.words,
  }
}

function scoreDuplicateCandidate(segment: RawTranscriptionSegment, preferences: FormattingPreferences): number {
  const wordScore = segment.words?.length ? 4 : 0
  const textScore = Math.min(3, countReadableCharacters(segment.text) / 40)
  const duration = segment.endTime - segment.startTime
  const readableDuration = calculateReadableDuration(segment.text, preferences)
  const timingScore = -Math.abs(duration - readableDuration) / Math.max(readableDuration, 0.1)

  return wordScore + textScore + timingScore
}

function areNearDuplicateSegments(first: RawTranscriptionSegment, second: RawTranscriptionSegment): boolean {
  const gap =
    first.endTime < second.startTime
      ? second.startTime - first.endTime
      : second.endTime < first.startTime
        ? first.startTime - second.endTime
        : 0

  if (gap > DUPLICATE_GAP_SECONDS) {
    return false
  }

  const firstText = normalizeForDuplicateComparison(first.text)
  const secondText = normalizeForDuplicateComparison(second.text)
  if (!firstText || !secondText) {
    return false
  }

  const shorter = firstText.length <= secondText.length ? firstText : secondText
  const longer = firstText.length > secondText.length ? firstText : secondText
  return (
    firstText === secondText ||
    (shorter.length >= 12 && longer.includes(shorter)) ||
    tokenSimilarity(firstText, secondText) >= 0.82
  )
}

function sortRawSegments(segments: RawTranscriptionSegment[]): RawTranscriptionSegment[] {
  return [...segments].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
}

function getUsableWords(segment: RawTranscriptionSegment, duration?: number): SubtitleWord[] {
  const words = (segment.words ?? [])
    .map((word) => {
      const text = normalizeSubtitleText(word.text).replace(/\n+/g, ' ')
      const startTime = clampTime(word.startTime, duration)
      const endTime = clampTime(word.endTime, duration)
      return { ...word, text, startTime, endTime }
    })
    .filter((word) => word.text && Number.isFinite(word.startTime) && Number.isFinite(word.endTime) && word.endTime > word.startTime)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)

  if (!words.length) {
    return []
  }

  const segmentTokens = tokenizeForComparison(segment.text)
  const wordTokens = tokenizeForComparison(words.map((word) => word.text).join(' '))
  if (segmentTokens.length > 2 && wordTokens.length < segmentTokens.length * 0.65) {
    return []
  }

  return words
}

function normalizeSegmentTime(value: number, fallback: number, duration?: number): number {
  const safeValue = Number.isFinite(value) ? value : fallback
  return clampTime(safeValue, duration)
}

function calculateTotalReadableDuration(text: string, preferences: FormattingPreferences): number {
  return roundTime(
    Math.max(getMinimumGeneratedCaptionDuration(preferences), countReadableCharacters(text) / preferences.targetMaxCps),
  )
}

function getMinimumGeneratedCaptionDuration(preferences: FormattingPreferences): number {
  return Math.min(
    preferences.maxDuration,
    Math.max(MIN_GENERATED_CAPTION_DURATION, PROFESSIONAL_MIN_SUBTITLE_DURATION_SECONDS, preferences.minDuration),
  )
}

function getMaxGeneratedCaptionCharacters(preferences: FormattingPreferences): number {
  const lineCapacity = Math.max(1, Math.floor(preferences.maxCharsPerLine)) * 2
  return Math.max(1, Math.min(preferences.maxCharsPerSubtitle, lineCapacity))
}

function countReadableCharacters(text: string): number {
  return normalizeSubtitleText(text).replace(/\s+/g, ' ').trim().length
}

function tokenizeForComparison(text: string): string[] {
  const normalized = normalizeForDuplicateComparison(text)
  return normalized ? normalized.split(' ') : []
}

function estimatePartDuration(part: string, original: string, totalDuration: number): number {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    return 0
  }

  return totalDuration * (Math.max(1, part.length) / Math.max(1, original.length))
}

function getContentStartTime(segment: RawTranscriptionSegment): number {
  return segment.words?.at(0)?.startTime ?? segment.startTime
}

function getContentEndTime(segment: RawTranscriptionSegment): number {
  return segment.words?.at(-1)?.endTime ?? segment.endTime
}

function getMinimumPreservedGap(
  first: RawTranscriptionSegment,
  second: RawTranscriptionSegment,
  preferences: FormattingPreferences,
): number {
  const contentGap = Math.max(0, getContentStartTime(second) - getContentEndTime(first))
  const displayGap = Math.max(0, second.startTime - first.endTime)
  let preferredGap = preferences.gapBetweenSubtitles

  if (contentGap + 0.001 >= PAUSE_SPLIT_SECONDS || displayGap + 0.001 >= PAUSE_SPLIT_SECONDS) {
    preferredGap = Math.min(PAUSE_SPLIT_SECONDS, displayGap)
  }

  return Math.max(preferences.gapBetweenSubtitles, preferredGap)
}

function isMeaningfulGeneratedBoundary(
  first: RawTranscriptionSegment,
  second: RawTranscriptionSegment,
): boolean {
  const contentGap = Math.max(0, getContentStartTime(second) - getContentEndTime(first))
  return contentGap + 0.001 >= PAUSE_SPLIT_SECONDS
}

function canExtendCaptionEnd(
  segment: RawTranscriptionSegment,
  targetEnd: number,
  preferences: FormattingPreferences,
  duration?: number,
): boolean {
  if (hasLowConfidenceTiming(segment)) {
    return false
  }
  if (targetEnd <= segment.endTime) {
    return false
  }
  if (duration !== undefined && targetEnd > duration) {
    return false
  }
  if (targetEnd - segment.startTime > preferences.maxDuration) {
    return false
  }
  if (targetEnd - getContentEndTime(segment) > MAX_EXTENSION_PAST_AUDIO_SECONDS) {
    return false
  }

  return targetEnd >= segment.startTime + MIN_GENERATED_CAPTION_DURATION
}

function hasLowConfidenceTiming(segment: RawTranscriptionSegment): boolean {
  return segment.confidence !== undefined && segment.confidence < 0.5
}

function joinCaptionText(first: string, second: string): string {
  return normalizeSubtitleText(`${first} ${second}`).replace(/\n+/g, ' ')
}

function joinSubtitleWords(words: string[]): string {
  let output = ''
  for (const word of words) {
    const token = normalizeSubtitleText(word).replace(/\n+/g, ' ')
    if (!token) {
      continue
    }
    const joinsPrevious =
      !output ||
      /^[,.;:!?%\])}\u3001\u3002\uff0c\uff01\uff1f]/u.test(token) ||
      /^(?:['\u2019](?:s|re|ve|ll|d|m|t)|n't\b)/iu.test(token) ||
      /[([{\u2018\u201c]$/u.test(output) ||
      (containsCjkCharacter(token[0] ?? '') &&
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u2026\u2014\u2019\u201d\uff09\u3011\u300b\u300d\u300f]*$/u.test(output))
    output += joinsPrevious ? token : ` ${token}`
  }
  return output.trim()
}

function containsCjkCharacter(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
}

function splitGraphemeClusters(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(value), ({ segment }) => segment)
  }

  // Modern supported browsers expose Intl.Segmenter. Keep a deterministic
  // fallback for older embedded runtimes so combining marks and ZWJ sequences
  // are not split away from their base character.
  const clusters: string[] = []
  for (const character of Array.from(value)) {
    const previous = clusters.at(-1)
    if (
      previous &&
      (/^\p{M}$/u.test(character) || character === '\u200d' || previous.endsWith('\u200d'))
    ) {
      clusters[clusters.length - 1] += character
    } else {
      clusters.push(character)
    }
  }
  return clusters
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

function findBestLineSplit(words: string[], maxCharsPerLine: number): number | null {
  if (words.length <= 1) {
    return null
  }

  let best: { index: number; score: number } | null = null

  for (let index = 1; index < words.length; index += 1) {
    const first = words.slice(0, index).join(' ')
    const second = words.slice(index).join(' ')
    if (first.length > maxCharsPerLine || second.length > maxCharsPerLine) {
      continue
    }

    const previous = words[index - 1]
    const next = words[index]
    const score =
      Math.abs(first.length - second.length) * 1.7 +
      phraseBreakPenalty(previous, next) +
      orphanLinePenalty(first, second, maxCharsPerLine) +
      (hasStrongPunctuation(previous) ? -22 : 0) +
      (hasSoftPunctuation(previous) ? -12 : 0) +
      sentenceMixingPenalty(first, second)

    if (!best || score < best.score) {
      best = { index, score }
    }
  }

  return best?.index ?? null
}

function phraseBreakPenalty(previous: string, next: string): number {
  const previousWord = normalizePhraseWord(previous)
  const nextWord = normalizePhraseWord(next)
  const unsafePreviousWords = new Set([
    'a',
    'an',
    'the',
    'to',
    'of',
    'in',
    'on',
    'at',
    'by',
    'for',
    'from',
    'with',
    'about',
    'as',
    'into',
    'over',
    'after',
    'before',
    'under',
    'between',
    'and',
    'but',
    'or',
    'so',
    'because',
    'if',
    'that',
    'which',
    'who',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'am',
    'do',
    'does',
    'did',
    'have',
    'has',
    'had',
    'will',
    'would',
    'can',
    'could',
    'should',
    'may',
    'might',
    'must',
    'i',
    'you',
    'he',
    'she',
    'it',
    'we',
    'they',
  ])

  let penalty = unsafePreviousWords.has(previousWord) ? 35 : 0
  if (previousWord === 'to' && nextWord) {
    penalty += 40
  }
  if (isCapitalizedWord(previous) && isCapitalizedWord(next)) {
    penalty += 28
  }
  if (nextWord === "'s" || nextWord === 's') {
    penalty += 50
  }

  return penalty
}

function orphanLinePenalty(first: string, second: string, maxCharsPerLine: number): number {
  const firstWords = first.split(/\s+/).filter(Boolean)
  const secondWords = second.split(/\s+/).filter(Boolean)
  const shortThreshold = Math.min(9, maxCharsPerLine * 0.25)
  let penalty = 0

  if (firstWords.length <= 1 || first.length < shortThreshold) {
    penalty += 22
  }
  if (secondWords.length <= 1 || second.length < shortThreshold) {
    penalty += 45
  }

  return penalty
}

function orphanCaptionPenalty(first: string, second: string): number {
  const firstWords = first.split(/\s+/).filter(Boolean)
  const secondWords = second.split(/\s+/).filter(Boolean)
  return (firstWords.length <= 1 ? 35 : 0) + (secondWords.length <= 1 ? 55 : 0)
}

function isAvoidableOneUnitCaption(first: string, second: string, capacity: number): boolean {
  const firstUnits = first.split(/\s+/u).filter(Boolean)
  const secondUnits = second.split(/\s+/u).filter(Boolean)
  const shortLength = Math.max(4, Math.min(18, capacity * 0.45))
  return (
    (firstUnits.length <= 1 && first.length <= shortLength && secondUnits.length >= 3) ||
    (secondUnits.length <= 1 && second.length <= shortLength && firstUnits.length >= 3)
  )
}

function sentenceMixingPenalty(first: string, second: string): number {
  const firstHasInternalSentenceEnd = /[.!?]\s+\S/.test(first)
  const secondStartsLowercase = /^[a-z]/.test(second)
  return (firstHasInternalSentenceEnd ? 18 : 0) + (secondStartsLowercase && hasStrongPunctuation(first) ? 8 : 0)
}

function normalizePhraseWord(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
}

function hasStrongPunctuation(word: string): boolean {
  return /[.!?]["')\]]?$/.test(word)
}

function hasSoftPunctuation(word: string): boolean {
  return /[,;:\u2013\u2014]["')\]]?$/.test(word)
}

function isCapitalizedWord(word: string): boolean {
  return /^[A-Z][a-z]+[,.!?]?$/u.test(word)
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
