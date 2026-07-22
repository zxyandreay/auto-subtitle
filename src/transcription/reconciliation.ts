import type { RawTranscriptionSegment } from '../subtitles/formatting'

export type BoundaryReconciliationOptions = {
  boundarySearchSeconds: number
  duplicateSimilarity: number
  minimumTokenOverlap: number
  maxSubtitleDuration: number
  hardMaxCps: number
  maxSequenceSegments: number
  maxComparisonUnits: number
  minimumConfidenceAdvantage: number
}

const DEFAULT_OPTIONS: BoundaryReconciliationOptions = {
  boundarySearchSeconds: 2,
  duplicateSimilarity: 0.8,
  minimumTokenOverlap: 2,
  maxSubtitleDuration: 6,
  hardMaxCps: 21,
  maxSequenceSegments: 3,
  maxComparisonUnits: 512,
  minimumConfidenceAdvantage: 0.1,
}

type ComparisonUnit = {
  normalized: string
  startIndex: number
  segmentIndex: number
  boundaryContextPrefix?: boolean
  segmentStartTime?: number
  segmentEndTime?: number
  startTime?: number
  endTime?: number
}

/**
 * Reconciles a bounded sequence around a core boundary. Only an ordered suffix of
 * existing text may consume an ordered prefix of incoming text, and the matched
 * evidence must overlap in time. This intentionally preserves adjacent, legitimate
 * repetitions which merely happen to have the same text.
 */
export function reconcileBoundarySegments(
  existing: RawTranscriptionSegment[],
  incoming: RawTranscriptionSegment[],
  boundaryTime: number,
  options?: Partial<BoundaryReconciliationOptions>,
): RawTranscriptionSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  if (!incoming.length) {
    return [...existing]
  }

  const sortedIncoming = [...incoming].sort(
    (first, second) => first.startTime - second.startTime || first.endTime - second.endTime,
  )
  const maximumSequenceSegments = Math.max(1, Math.floor(settings.maxSequenceSegments))
  const existingTailStart = Math.max(0, existing.length - maximumSequenceSegments)
  const existingTail = existing.slice(existingTailStart)
  const incomingHead = sortedIncoming.slice(0, maximumSequenceSegments)
  const boundaryStart = boundaryTime - Math.max(0, settings.boundarySearchSeconds)
  const boundaryEnd = boundaryTime + Math.max(0, settings.boundarySearchSeconds)

  if (
    !existingTail.some((segment) => intersectsRange(segment, boundaryStart, boundaryEnd)) ||
    !incomingHead.some((segment) => intersectsRange(segment, boundaryStart, boundaryEnd))
  ) {
    return appendMonotonic(existing, sortedIncoming)
  }

  const maximumComparisonUnits = Math.max(1, Math.floor(settings.maxComparisonUnits))
  const existingUnits = buildComparisonUnits(
    existingTail,
    existingTailStart,
    maximumComparisonUnits,
    true,
  )
  const incomingUnits = buildComparisonUnits(incomingHead, 0, maximumComparisonUnits, false)
  const overlap = suffixPrefixOverlap(existingUnits, incomingUnits)
  const matchedExisting = overlap > 0 ? existingUnits.slice(-overlap) : []
  const matchedIncoming = overlap > 0 ? incomingUnits.slice(0, overlap) : []
  const minimumOverlap = Math.max(1, Math.floor(settings.minimumTokenOverlap))
  const singleWordTimestampMatch =
    overlap === 1 && hasCompleteWordTiming(matchedExisting) && hasCompleteWordTiming(matchedIncoming)
  const singleSegmentUnitMatch =
    overlap === 1 &&
    unitsForSegment(existingUnits, matchedExisting[0]?.segmentIndex).length === 1 &&
    unitsForSegment(incomingUnits, matchedIncoming[0]?.segmentIndex).length === 1
  const boundaryContextMatch = hasBoundaryContextMatch(
    overlap,
    matchedExisting,
    matchedIncoming,
    settings.boundarySearchSeconds,
  )
  const hasEnoughTextEvidence =
    overlap >= minimumOverlap || singleWordTimestampMatch || singleSegmentUnitMatch || boundaryContextMatch

  if (
    !hasEnoughTextEvidence ||
    (!hasOverlappingTimingEvidence(matchedExisting, matchedIncoming) && !boundaryContextMatch)
  ) {
    return appendMonotonic(existing, sortedIncoming)
  }

  const preferredDuplicate = findPreferredFullDuplicate(
    existing,
    existingTailStart,
    sortedIncoming[0],
    overlap,
    maximumComparisonUnits,
    settings.minimumConfidenceAdvantage,
  )
  if (preferredDuplicate !== undefined) {
    const withoutExistingDuplicate = existing.filter((_, index) => index !== preferredDuplicate)
    const withPreferredDuplicate = appendMonotonic(withoutExistingDuplicate, [cloneSegment(sortedIncoming[0])])
    return sortedIncoming.length > 1
      ? reconcileBoundarySegments(withPreferredDuplicate, sortedIncoming.slice(1), boundaryTime, settings)
      : withPreferredDuplicate
  }

  const matchedExistingEnd = matchedExisting.at(-1)?.endTime ?? matchedExisting.at(-1)?.segmentEndTime
  const boundaryPunctuation = extractBoundaryPunctuation(sortedIncoming, overlap)
  const existingWithBoundaryPunctuation = preserveBoundaryPunctuation(
    existing,
    matchedExisting.at(-1)?.segmentIndex,
    boundaryPunctuation,
  )
  const trimmedIncoming = trimIncomingPrefix(sortedIncoming, overlap, matchedExistingEnd, settings)
  return appendMonotonic(existingWithBoundaryPunctuation, trimmedIncoming)
}

export function areSimilarSegments(first: RawTranscriptionSegment, second: RawTranscriptionSegment): boolean {
  const firstNormalized = normalizeComparisonText(first.text)
  const secondNormalized = normalizeComparisonText(second.text)
  if (firstNormalized && firstNormalized === secondNormalized) {
    return true
  }
  const comparisonLimit = DEFAULT_OPTIONS.maxComparisonUnits
  const firstUnits = comparisonValues(first.text, comparisonLimit + 1)
  const secondUnits = comparisonValues(second.text, comparisonLimit + 1)
  if (!firstUnits.length || !secondUnits.length) {
    return false
  }
  // Approximate matching is deliberately bounded. Very long text is only
  // considered a duplicate when its fully normalized form matched above.
  if (firstUnits.length > comparisonLimit || secondUnits.length > comparisonLimit) {
    return false
  }
  return orderedSimilarity(firstUnits, secondUnits) >= DEFAULT_OPTIONS.duplicateSimilarity
}

function buildComparisonUnits(
  segments: RawTranscriptionSegment[],
  indexOffset: number,
  maxUnits: number,
  takeSuffix: boolean,
): ComparisonUnit[] {
  const units: ComparisonUnit[] = []
  const indexes = takeSuffix
    ? Array.from({ length: segments.length }, (_, index) => segments.length - index - 1)
    : Array.from({ length: segments.length }, (_, index) => index)
  for (const localIndex of indexes) {
    const remainingUnits = maxUnits - units.length
    if (remainingUnits <= 0) {
      break
    }
    const segment = segments[localIndex]
    const segmentIndex = localIndex + indexOffset
    const segmentUnits = textUnits(segment.text, segmentIndex, remainingUnits, takeSuffix)
    for (const unit of segmentUnits) {
      unit.segmentStartTime = segment.startTime
      unit.segmentEndTime = segment.endTime
      unit.boundaryContextPrefix = segment.boundaryContextPrefix
    }
    assignWordTiming(segmentUnits, segment.words, takeSuffix)
    if (takeSuffix) {
      units.unshift(...segmentUnits)
    } else {
      units.push(...segmentUnits)
    }
  }
  return units
}

function textUnits(
  text: string,
  segmentIndex: number,
  maxUnits = Number.POSITIVE_INFINITY,
  takeSuffix = false,
): ComparisonUnit[] {
  const boundedLimit = Number.isFinite(maxUnits)
    ? Math.max(0, Math.floor(maxUnits))
    : Number.POSITIVE_INFINITY
  if (boundedLimit === 0) {
    return []
  }
  const units: ComparisonUnit[] = []
  let ringIndex = 0
  const addUnit = (unit: ComparisonUnit): boolean => {
    if (units.length < boundedLimit) {
      units.push(unit)
      return true
    }
    if (!takeSuffix) {
      return false
    }
    units[ringIndex] = unit
    ringIndex = (ringIndex + 1) % boundedLimit
    return true
  }
  const pattern = /[\p{L}\p{N}\p{M}]+(?:['\u2019][\p{L}\p{N}\p{M}]+)*/gu
  let match: RegExpExecArray | null
  let shouldContinue = true
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0]
    if (usesCharacterFallback(raw)) {
      const graphemePattern = /\P{M}\p{M}*|\p{M}+/gu
      let grapheme: RegExpExecArray | null
      while ((grapheme = graphemePattern.exec(raw)) !== null) {
        const normalized = normalizeUnit(grapheme[0])
        if (normalized) {
          shouldContinue = addUnit({
            normalized,
            startIndex: match.index + grapheme.index,
            segmentIndex,
          })
          if (!shouldContinue) {
            break
          }
        }
      }
    } else {
      const normalized = normalizeUnit(raw)
      if (normalized) {
        shouldContinue = addUnit({ normalized, startIndex: match.index, segmentIndex })
      }
    }
    if (!shouldContinue) {
      break
    }
  }
  return takeSuffix && units.length === boundedLimit && ringIndex > 0
    ? [...units.slice(ringIndex), ...units.slice(0, ringIndex)]
    : units
}

function assignWordTiming(
  segmentUnits: ComparisonUnit[],
  words: RawTranscriptionSegment['words'],
  takeSuffix = false,
): void {
  if (!words?.length || !segmentUnits.length) {
    return
  }
  const wordUnits = words.flatMap((word, wordIndex) =>
    comparisonValues(word.text).map((normalized) => ({ normalized, wordIndex })),
  )
  const comparableWordUnits = takeSuffix
    ? wordUnits.slice(-segmentUnits.length)
    : wordUnits.slice(0, segmentUnits.length)
  if (!arraysEqual(segmentUnits.map((unit) => unit.normalized), comparableWordUnits.map((unit) => unit.normalized))) {
    return
  }
  for (let index = 0; index < segmentUnits.length; index += 1) {
    const word = words[comparableWordUnits[index].wordIndex]
    if (Number.isFinite(word.startTime) && Number.isFinite(word.endTime) && word.endTime > word.startTime) {
      segmentUnits[index].startTime = word.startTime
      segmentUnits[index].endTime = word.endTime
    }
  }
}

function suffixPrefixOverlap(existing: ComparisonUnit[], incoming: ComparisonUnit[]): number {
  if (!existing.length || !incoming.length) {
    return 0
  }
  const pattern = incoming.map((unit) => unit.normalized)
  const prefixLengths = new Uint32Array(pattern.length)
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = prefixLengths[matched - 1]
    }
    if (pattern[index] === pattern[matched]) {
      matched += 1
    }
    prefixLengths[index] = matched
  }

  let matched = 0
  for (const unit of existing) {
    while (matched > 0 && (matched === pattern.length || unit.normalized !== pattern[matched])) {
      matched = prefixLengths[matched - 1]
    }
    if (unit.normalized === pattern[matched]) {
      matched += 1
    }
  }
  return matched
}

function hasOverlappingTimingEvidence(
  existingUnits: ComparisonUnit[],
  incomingUnits: ComparisonUnit[],
): boolean {
  if (!existingUnits.length || !incomingUnits.length) {
    return false
  }
  const timedExisting = timeRangeForUnits(existingUnits)
  const timedIncoming = timeRangeForUnits(incomingUnits)
  if (timedExisting && timedIncoming) {
    return rangesOverlap(timedExisting, timedIncoming)
  }

  const existingRange = rangeForUnitSegments(existingUnits)
  const incomingRange = rangeForUnitSegments(incomingUnits)
  return existingRange !== undefined && incomingRange !== undefined && rangesOverlap(existingRange, incomingRange)
}

function hasBoundaryContextMatch(
  overlap: number,
  existingUnits: ComparisonUnit[],
  incomingUnits: ComparisonUnit[],
  boundarySearchSeconds: number,
): boolean {
  const firstIncoming = incomingUnits[0]
  if (!overlap || !firstIncoming?.boundaryContextPrefix) {
    return false
  }
  // Coarse segment timing cannot prove that one repeated lexical unit belongs
  // to overlap context. Require two units before bypassing timing evidence so
  // an intentional repeated word is never deleted on the marker alone.
  if (overlap < 2) {
    return false
  }
  const existingRange = rangeForUnitSegments(existingUnits)
  const incomingRange = rangeForUnitSegments(incomingUnits)
  if (!existingRange || !incomingRange) {
    return false
  }
  const separation = Math.max(
    0,
    incomingRange.startTime - existingRange.endTime,
    existingRange.startTime - incomingRange.endTime,
  )
  return separation <= Math.max(0, boundarySearchSeconds)
}

function timeRangeForUnits(units: ComparisonUnit[]): { startTime: number; endTime: number } | undefined {
  if (!hasCompleteWordTiming(units)) {
    return undefined
  }
  return {
    startTime: Math.min(...units.map((unit) => unit.startTime!)),
    endTime: Math.max(...units.map((unit) => unit.endTime!)),
  }
}

function hasCompleteWordTiming(units: ComparisonUnit[]): boolean {
  return units.length > 0 && units.every(
    (unit) => unit.startTime !== undefined && unit.endTime !== undefined && unit.endTime > unit.startTime,
  )
}

function unitsForSegment(units: ComparisonUnit[], segmentIndex: number | undefined): ComparisonUnit[] {
  return segmentIndex === undefined ? [] : units.filter((unit) => unit.segmentIndex === segmentIndex)
}

function rangeForUnitSegments(units: ComparisonUnit[]): { startTime: number; endTime: number } | undefined {
  if (!units.length || units.some((unit) => unit.segmentStartTime === undefined || unit.segmentEndTime === undefined)) {
    return undefined
  }
  return {
    startTime: Math.min(...units.map((unit) => unit.segmentStartTime!)),
    endTime: Math.max(...units.map((unit) => unit.segmentEndTime!)),
  }
}

function trimIncomingPrefix(
  incoming: RawTranscriptionSegment[],
  unitsToRemove: number,
  matchedExistingEnd?: number,
  options: BoundaryReconciliationOptions = DEFAULT_OPTIONS,
): RawTranscriptionSegment[] {
  const trimmed: RawTranscriptionSegment[] = []
  let remaining = unitsToRemove

  for (const segment of incoming) {
    if (remaining <= 0) {
      trimmed.push({ ...segment, words: segment.words ? [...segment.words] : undefined })
      continue
    }
    const units = textUnits(segment.text, 0)
    if (!units.length) {
      trimmed.push({ ...segment, words: segment.words ? [...segment.words] : undefined })
      continue
    }
    if (remaining >= units.length) {
      remaining -= units.length
      continue
    }

    const firstRetainedUnit = units[remaining]
    const text = segment.text.slice(firstRetainedUnit.startIndex).trim()
    const words = trimWordsAtUnitBoundary(segment.words, units, remaining)
    const firstWord = words?.at(0)
    const lastWord = words?.at(-1)
    const proportionalStart = proportionalRetainedStart(
      segment,
      units.length - remaining,
      units.length,
      options.maxSubtitleDuration,
    )
    const evidenceStart = Math.max(
      segment.startTime,
      Number.isFinite(matchedExistingEnd) ? matchedExistingEnd! : segment.startTime,
    )
    // Segment timestamps cannot locate the retained suffix precisely. Prefer the
    // non-overlapping boundary, but fall back to a bounded proportional slice
    // inside the original segment if that boundary would erase unique text.
    const nonOverlappingStart = Math.max(evidenceStart, proportionalStart)
    const segmentFallbackStart = nonOverlappingStart < segment.endTime
      ? nonOverlappingStart
      : proportionalStart
    const startTime = firstWord?.startTime ?? segmentFallbackStart
    const endTime = lastWord?.endTime ?? segment.endTime
    if (text && endTime > startTime) {
      trimmed.push({
        ...segment,
        startTime,
        endTime,
        text,
        words,
      })
    }
    remaining = 0
  }

  return trimmed
}

function extractBoundaryPunctuation(
  incoming: RawTranscriptionSegment[],
  unitsToRemove: number,
): string {
  let remaining = unitsToRemove
  for (const [segmentIndex, segment] of incoming.entries()) {
    const units = textUnits(segment.text, 0)
    if (!units.length) {
      continue
    }
    if (remaining >= units.length) {
      remaining -= units.length
      if (remaining === 0) {
        const hasUniqueSuffix = incoming
          .slice(segmentIndex + 1)
          .some((candidate) => textUnits(candidate.text, 0, 1).length > 0)
        if (!hasUniqueSuffix) {
          return ''
        }
        const finalUnit = units.at(-1)!
        return findLastBoundaryPunctuation(segment.text.slice(finalUnit.startIndex))
      }
      continue
    }
    if (remaining <= 0) {
      return ''
    }

    const previousUnit = units[remaining - 1]
    const retainedUnit = units[remaining]
    const between = segment.text.slice(previousUnit.startIndex, retainedUnit.startIndex)
    return findLastBoundaryPunctuation(between)
  }
  return ''
}

function preserveBoundaryPunctuation(
  existing: RawTranscriptionSegment[],
  segmentIndex: number | undefined,
  punctuation: string,
): RawTranscriptionSegment[] {
  if (segmentIndex === undefined || !punctuation || !existing[segmentIndex]) {
    return existing
  }
  const current = existing[segmentIndex]
  const withoutTrailingBoundary = stripTrailingBoundaryPunctuation(current.text).trimEnd()
  const text = `${withoutTrailingBoundary}${punctuation}`
  if (text === current.text) {
    return existing
  }
  const words = current.words?.map((word) => ({ ...word }))
  const lastWord = words?.at(-1)
  if (lastWord) {
    lastWord.text = `${stripTrailingBoundaryPunctuation(lastWord.text).trimEnd()}${punctuation}`
  }
  const updated = [...existing]
  updated[segmentIndex] = { ...current, text, words }
  return updated
}

function findLastBoundaryPunctuation(value: string): string {
  const matches = value.match(
    /[,.!?;:\u2026\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u2013\u2014]+(?:["'\u2019\u201d)\]}\uff09\u3011\u300b\u300d\u300f]+)?/gu,
  )
  return matches?.at(-1) ?? ''
}

function stripTrailingBoundaryPunctuation(value: string): string {
  return value.replace(
    /[,.!?;:\u2026\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u2013\u2014]+(?:["'\u2019\u201d)\]}\uff09\u3011\u300b\u300d\u300f]+)?\s*$/u,
    '',
  )
}

function findPreferredFullDuplicate(
  existing: RawTranscriptionSegment[],
  existingTailStart: number,
  incoming: RawTranscriptionSegment,
  overlapUnits: number,
  maximumComparisonUnits: number,
  minimumConfidenceAdvantage: number,
): number | undefined {
  const incomingUnits = textUnits(incoming.text, 0, maximumComparisonUnits + 1)
  if (
    !incomingUnits.length ||
    incomingUnits.length > maximumComparisonUnits ||
    overlapUnits < incomingUnits.length
  ) {
    return undefined
  }
  const incomingNormalized = normalizeComparisonText(incoming.text)
  for (let index = existing.length - 1; index >= existingTailStart; index -= 1) {
    const candidate = existing[index]
    if (
      normalizeComparisonText(candidate.text) === incomingNormalized &&
      rangesOverlap(candidate, incoming)
    ) {
      return compareDuplicateEvidence(incoming, candidate, minimumConfidenceAdvantage) > 0
        ? index
        : undefined
    }
  }
  return undefined
}

function compareDuplicateEvidence(
  first: RawTranscriptionSegment,
  second: RawTranscriptionSegment,
  minimumConfidenceAdvantage: number,
): number {
  const firstHasWordTiming = hasUsableSegmentWordTiming(first)
  const secondHasWordTiming = hasUsableSegmentWordTiming(second)
  if (firstHasWordTiming !== secondHasWordTiming) {
    return firstHasWordTiming ? 1 : -1
  }

  const firstConfidence = Number.isFinite(first.confidence) ? first.confidence! : undefined
  const secondConfidence = Number.isFinite(second.confidence) ? second.confidence! : undefined
  const materialDifference = Math.max(0.001, minimumConfidenceAdvantage)
  if (
    firstConfidence !== undefined &&
    secondConfidence !== undefined &&
    Math.abs(firstConfidence - secondConfidence) >= materialDifference
  ) {
    return firstConfidence > secondConfidence ? 1 : -1
  }

  const punctuationDifference = punctuationEvidenceScore(first.text) - punctuationEvidenceScore(second.text)
  return punctuationDifference > 0 ? 1 : punctuationDifference < 0 ? -1 : 0
}

function hasUsableSegmentWordTiming(segment: RawTranscriptionSegment): boolean {
  if (!segment.words?.length) {
    return false
  }
  const segmentUnits = textUnits(segment.text, 0).map((unit) => unit.normalized)
  const wordUnits = segment.words.flatMap((word) => comparisonValues(word.text))
  if (!segmentUnits.length || !arraysEqual(segmentUnits, wordUnits)) {
    return false
  }
  let previousEnd = Number.NEGATIVE_INFINITY
  for (const word of segment.words) {
    if (
      !Number.isFinite(word.startTime) ||
      !Number.isFinite(word.endTime) ||
      word.endTime <= word.startTime ||
      word.startTime < previousEnd
    ) {
      return false
    }
    previousEnd = word.endTime
  }
  return true
}

function punctuationEvidenceScore(text: string): number {
  const punctuation = text.match(/[.,!?;:\u2026\u3002\uFF0C\uFF01\uFF1F\uFF1B\uFF1A]/gu)?.length ?? 0
  const repeatedPunctuation = text.match(/([.,!?;:\u2026\u3002\uFF0C\uFF01\uFF1F\uFF1B\uFF1A])\1+/gu)
    ?.reduce((total, run) => total + run.length - 1, 0) ?? 0
  const hasTerminalPunctuation = /[.!?\u2026\u3002\uFF01\uFF1F]["'\u2019\u201D)\]}]*\s*$/u.test(text)
  return Math.min(3, punctuation) + (hasTerminalPunctuation ? 3 : 0) - Math.min(4, repeatedPunctuation)
}

function cloneSegment(segment: RawTranscriptionSegment): RawTranscriptionSegment {
  return {
    ...segment,
    words: segment.words?.map((word) => ({ ...word })),
  }
}

function trimWordsAtUnitBoundary(
  words: RawTranscriptionSegment['words'],
  segmentUnits: ComparisonUnit[],
  unitsToRemove: number,
): RawTranscriptionSegment['words'] {
  if (!words?.length) {
    return undefined
  }
  const wordUnits = words.flatMap((word, wordIndex) =>
    comparisonValues(word.text).map((normalized) => ({ normalized, wordIndex })),
  )
  if (!arraysEqual(segmentUnits.map((unit) => unit.normalized), wordUnits.map((unit) => unit.normalized))) {
    return undefined
  }
  const firstRetained = wordUnits[unitsToRemove]
  if (!firstRetained || (unitsToRemove > 0 && wordUnits[unitsToRemove - 1].wordIndex === firstRetained.wordIndex)) {
    return undefined
  }
  const retained = words.slice(firstRetained.wordIndex).filter(
    (word) => Number.isFinite(word.startTime) && Number.isFinite(word.endTime) && word.endTime > word.startTime,
  )
  return retained.length ? retained : undefined
}

function appendMonotonic(
  existing: RawTranscriptionSegment[],
  incoming: RawTranscriptionSegment[],
): RawTranscriptionSegment[] {
  if (!incoming.length) {
    return [...existing]
  }
  const existingIsSorted = existing.every(
    (segment, index) => index === 0 || segment.startTime >= existing[index - 1].startTime,
  )
  if (existingIsSorted && (existing.at(-1)?.startTime ?? Number.NEGATIVE_INFINITY) <= incoming[0].startTime) {
    return [...existing, ...incoming]
  }
  const output = [...existing]
  for (const segment of incoming) {
    output.push(segment)
  }
  return output.sort((first, second) => first.startTime - second.startTime || first.endTime - second.endTime)
}

function orderedSimilarity(first: string[], second: string[]): number {
  const rows = new Uint16Array(second.length + 1)
  for (const firstUnit of first) {
    let diagonal = 0
    for (let index = 1; index <= second.length; index += 1) {
      const previous = rows[index]
      rows[index] = firstUnit === second[index - 1]
        ? diagonal + 1
        : Math.max(rows[index], rows[index - 1])
      diagonal = previous
    }
  }
  return rows[second.length] / Math.max(first.length, second.length)
}

function proportionalRetainedStart(
  segment: RawTranscriptionSegment,
  retainedUnits: number,
  totalUnits: number,
  maxDuration: number,
): number {
  const segmentDuration = segment.endTime - segment.startTime
  if (!(segmentDuration > 0) || totalUnits <= 0 || retainedUnits <= 0) {
    return segment.startTime
  }
  const proportionalDuration = segmentDuration * Math.min(1, retainedUnits / totalUnits)
  const boundedDuration = Math.max(
    0.001,
    Math.min(segmentDuration, Math.max(0.001, maxDuration), proportionalDuration),
  )
  return Math.max(segment.startTime, segment.endTime - boundedDuration)
}

function comparisonValues(text: string, maxUnits = Number.POSITIVE_INFINITY): string[] {
  return textUnits(text, 0, maxUnits).map((unit) => unit.normalized)
}

function normalizeUnit(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '')
}

function normalizeComparisonText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function usesCharacterFallback(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(value)
}

function intersectsRange(segment: RawTranscriptionSegment, startTime: number, endTime: number): boolean {
  return segment.endTime >= startTime && segment.startTime <= endTime
}

function rangesOverlap(
  first: { startTime: number; endTime: number },
  second: { startTime: number; endTime: number },
): boolean {
  return first.startTime < second.endTime && second.startTime < first.endTime
}

function arraysEqual<T>(first: T[], second: T[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index])
}
