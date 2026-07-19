const DEFAULT_NORMALIZATION = Object.freeze({
  unicodeForm: 'NFKC',
  lowercase: true,
  stripPunctuation: true,
  collapseWhitespace: true,
  cerIgnoreWhitespace: true,
})

const DEFAULT_CONSTRAINTS = Object.freeze({
  maxCps: 21,
  maxLineLength: 42,
  maximumLines: 2,
  minimumSpeechOverlapRatio: 0.5,
})

// Cue alignment currently uses three dense matrices. Keep its worst-case
// allocation bounded (~17 MB for one million cells) and report the metric as
// unavailable instead of risking an out-of-memory failure on a long fixture.
const MAX_CUE_ALIGNMENT_CELLS = 1_000_000

export function evaluateBenchmarkCase(manifestCase, reference, candidate) {
  const normalization = { ...DEFAULT_NORMALIZATION, ...manifestCase.normalization }
  const constraints = { ...DEFAULT_CONSTRAINTS, ...manifestCase.constraints }
  const language = manifestCase.language
  const textMetric = manifestCase.textMetric ?? 'wer'
  const referenceTranscript = reference.transcript ?? transcriptFromTimedEntries(reference.words ?? reference.subtitles ?? [])
  const candidateTranscript = candidate.transcript ?? transcriptFromTimedEntries(candidate.subtitles ?? candidate.words ?? [])
  const text = calculateTextMetrics(referenceTranscript, candidateTranscript, normalization, language, textMetric)
  const referenceWords = reference.words ?? wordsFromSubtitles(reference.subtitles ?? [])
  const candidateWords = candidate.words ?? wordsFromSubtitles(candidate.subtitles ?? [])
  const speechIntervals = reference.speechIntervals ?? deriveSpeechIntervals(referenceWords, reference.subtitles)

  return {
    text,
    wordTiming: calculateWordTimingMetrics(referenceWords, candidateWords, normalization, language),
    cueTiming: calculateCueTimingMetrics(
      reference.subtitles,
      candidate.subtitles,
      normalization,
      language,
      textMetric,
    ),
    speechCoverage: calculateSpeechCoverageMetrics(
      speechIntervals,
      candidate.subtitles,
      constraints.minimumSpeechOverlapRatio,
    ),
    duplication: calculateDuplicationMetrics(
      referenceTranscript,
      candidateTranscript,
      normalization,
      language,
      textMetric,
    ),
    subtitleQuality: calculateSubtitleQualityMetrics(candidate.subtitles ?? [], constraints),
    performance: calculatePerformanceMetrics(candidate.telemetry, manifestCase.durationSeconds),
  }
}

export function calculateTextMetrics(referenceText, candidateText, normalization, language, primaryMetric = 'wer') {
  const normalizedReference = normalizeText(referenceText, normalization, language)
  const normalizedCandidate = normalizeText(candidateText, normalization, language)
  const referenceWords = wordTokens(normalizedReference)
  const candidateWords = wordTokens(normalizedCandidate)
  const wordAlignment = alignSequences(referenceWords, candidateWords)
  const wordCounts = countAlignmentOperations(wordAlignment)
  const referenceCharacters = characterTokens(normalizedReference, normalization.cerIgnoreWhitespace)
  const candidateCharacters = characterTokens(normalizedCandidate, normalization.cerIgnoreWhitespace)
  const characterDistance = levenshteinDistance(referenceCharacters, candidateCharacters)
  const maximumCharacterCount = Math.max(referenceCharacters.length, candidateCharacters.length)

  return {
    primaryMetric,
    exactNormalizedMatch: normalizedReference === normalizedCandidate,
    normalizedSimilarity: roundMetric(
      maximumCharacterCount === 0 ? 1 : 1 - characterDistance / maximumCharacterCount,
    ),
    referenceNormalizedLength: Array.from(normalizedReference).length,
    candidateNormalizedLength: Array.from(normalizedCandidate).length,
    wer: {
      rate: referenceWords.length === 0 ? null : roundMetric(wordCounts.errors / referenceWords.length),
      errors: wordCounts.errors,
      substitutions: wordCounts.substitutions,
      deletions: wordCounts.deletions,
      insertions: wordCounts.insertions,
      referenceTokenCount: referenceWords.length,
      candidateTokenCount: candidateWords.length,
    },
    cer: {
      rate: referenceCharacters.length === 0 ? null : roundMetric(characterDistance / referenceCharacters.length),
      errors: characterDistance,
      referenceCharacterCount: referenceCharacters.length,
      candidateCharacterCount: candidateCharacters.length,
    },
  }
}

export function calculateWordTimingMetrics(referenceWords, candidateWords, normalization, language) {
  if (!Array.isArray(referenceWords) || !Array.isArray(candidateWords)) {
    return null
  }

  const referenceTokens = flattenTimedWords(referenceWords, normalization, language)
  const candidateTokens = flattenTimedWords(candidateWords, normalization, language)
  if (referenceTokens.length === 0) {
    return null
  }

  const alignment = alignSequences(
    referenceTokens.map((word) => word.token),
    candidateTokens.map((word) => word.token),
  )
  const startErrors = []
  const endErrors = []

  for (const operation of alignment) {
    if (operation.type !== 'equal') {
      continue
    }
    const referenceWord = referenceTokens[operation.referenceIndex]
    const candidateWord = candidateTokens[operation.candidateIndex]
    startErrors.push(candidateWord.startTime - referenceWord.startTime)
    endErrors.push(candidateWord.endTime - referenceWord.endTime)
  }

  return {
    referenceWordCount: referenceTokens.length,
    candidateWordCount: candidateTokens.length,
    matchedWordCount: startErrors.length,
    referenceMatchRatio: roundRatio(startErrors.length, referenceTokens.length),
    startErrorSeconds: errorStatistics(startErrors),
    endErrorSeconds: errorStatistics(endErrors),
  }
}

export function calculateCueTimingMetrics(
  referenceSubtitles,
  candidateSubtitles,
  normalization,
  language,
  textMetric,
) {
  if (!Array.isArray(referenceSubtitles) || !Array.isArray(candidateSubtitles)) {
    return null
  }

  const referenceCues = referenceSubtitles.filter(isUsableTimedText)
  const candidateCues = candidateSubtitles.filter(isUsableTimedText)
  if (referenceCues.length === 0) {
    return null
  }

  const alignmentCellCount = (referenceCues.length + 1) * (candidateCues.length + 1)
  if (candidateCues.length > 0 && alignmentCellCount > MAX_CUE_ALIGNMENT_CELLS) {
    return {
      available: false,
      unavailableReason: 'cue-alignment-cell-limit',
      referenceCueCount: referenceCues.length,
      candidateCueCount: candidateCues.length,
      requiredAlignmentCells: alignmentCellCount,
      maximumAlignmentCells: MAX_CUE_ALIGNMENT_CELLS,
    }
  }

  const matches = alignCues(
    referenceCues,
    candidateCues,
    normalization,
    language,
    textMetric === 'cer',
  )
  const onsetErrors = matches.map(({ referenceIndex, candidateIndex }) => (
    candidateCues[candidateIndex].startTime - referenceCues[referenceIndex].startTime
  ))
  const offsetErrors = matches.map(({ referenceIndex, candidateIndex }) => (
    candidateCues[candidateIndex].endTime - referenceCues[referenceIndex].endTime
  ))

  return {
    available: true,
    referenceCueCount: referenceCues.length,
    candidateCueCount: candidateCues.length,
    matchedCueCount: matches.length,
    referenceMatchRatio: roundRatio(matches.length, referenceCues.length),
    meanMatchSimilarity: matches.length
      ? roundMetric(mean(matches.map((match) => match.similarity)))
      : null,
    onsetErrorSeconds: errorStatistics(onsetErrors),
    offsetErrorSeconds: errorStatistics(offsetErrors),
  }
}

export function calculateSpeechCoverageMetrics(referenceSpeechIntervals, candidateSubtitles, minimumSpeechOverlapRatio) {
  if (!Array.isArray(referenceSpeechIntervals) || !Array.isArray(candidateSubtitles)) {
    return null
  }

  const referenceSpeech = unionIntervals(referenceSpeechIntervals)
  const candidateCues = candidateSubtitles.filter(isUsableTimedText)
  const candidateIntervals = unionIntervals(candidateCues)
  const referenceDuration = totalIntervalDuration(referenceSpeech)
  const candidateDuration = totalIntervalDuration(candidateIntervals)
  const coveredReferenceDuration = intervalIntersectionDuration(referenceSpeech, candidateIntervals)
  const candidateOverSpeechDuration = intervalIntersectionDuration(candidateIntervals, referenceSpeech)
  const missedSpeechDuration = Math.max(0, referenceDuration - coveredReferenceDuration)
  const overSilenceDuration = Math.max(0, candidateDuration - candidateOverSpeechDuration)
  let mostlySilenceCueCount = 0

  for (const cue of candidateCues) {
    const duration = cue.endTime - cue.startTime
    const speechOverlap = intervalIntersectionDuration([cue], referenceSpeech)
    if (duration > 0 && speechOverlap / duration < minimumSpeechOverlapRatio) {
      mostlySilenceCueCount += 1
    }
  }

  return {
    referenceSpeechDurationSeconds: roundMetric(referenceDuration),
    coveredReferenceSpeechDurationSeconds: roundMetric(coveredReferenceDuration),
    missedSpeechDurationSeconds: roundMetric(missedSpeechDuration),
    missedSpeechRatio: roundRatio(missedSpeechDuration, referenceDuration),
    candidateCaptionDurationSeconds: roundMetric(candidateDuration),
    candidateOverSilenceDurationSeconds: roundMetric(overSilenceDuration),
    candidateOverSilenceRatio: roundRatio(overSilenceDuration, candidateDuration),
    mostlySilenceCueCount,
    evaluatedCueCount: candidateCues.length,
    minimumSpeechOverlapRatio,
  }
}

export function calculateDuplicationMetrics(
  referenceText,
  candidateText,
  normalization,
  language,
  textMetric,
) {
  const useCharacters = textMetric === 'cer'
  const referenceNormalized = normalizeText(referenceText, normalization, language)
  const candidateNormalized = normalizeText(candidateText, normalization, language)
  const referenceUnits = useCharacters
    ? characterTokens(referenceNormalized, true)
    : wordTokens(referenceNormalized)
  const candidateUnits = useCharacters
    ? characterTokens(candidateNormalized, true)
    : wordTokens(candidateNormalized)
  const maximumPhraseSize = useCharacters ? 8 : 5
  const referenceAdjacent = countAdjacentDuplicates(referenceUnits)
  const candidateAdjacent = countAdjacentDuplicates(candidateUnits)
  const referencePhrases = countRepeatedPhraseTokens(referenceUnits, 2, maximumPhraseSize)
  const candidatePhrases = countRepeatedPhraseTokens(candidateUnits, 2, maximumPhraseSize)
  const excessAdjacent = Math.max(0, candidateAdjacent - referenceAdjacent)
  const excessPhraseTokens = Math.max(0, candidatePhrases.tokenCount - referencePhrases.tokenCount)

  return {
    unit: useCharacters ? 'character' : 'word',
    candidateUnitCount: candidateUnits.length,
    adjacentDuplicateUnitCount: candidateAdjacent,
    adjacentDuplicateUnitRate: roundRatio(candidateAdjacent, candidateUnits.length),
    excessAdjacentDuplicateUnitCount: excessAdjacent,
    excessAdjacentDuplicateUnitRate: roundRatio(excessAdjacent, candidateUnits.length),
    repeatedPhraseOccurrenceCount: candidatePhrases.occurrenceCount,
    repeatedPhraseTokenCount: candidatePhrases.tokenCount,
    repeatedPhraseTokenRate: roundRatio(candidatePhrases.tokenCount, candidateUnits.length),
    excessRepeatedPhraseTokenCount: excessPhraseTokens,
    excessRepeatedPhraseTokenRate: roundRatio(excessPhraseTokens, candidateUnits.length),
    referenceAdjacentDuplicateUnitCount: referenceAdjacent,
    referenceRepeatedPhraseTokenCount: referencePhrases.tokenCount,
  }
}

export function calculateSubtitleQualityMetrics(subtitles, constraints) {
  const invalidTimestampCount = subtitles.filter((subtitle) => !isValidInterval(subtitle)).length
  const invalidWordTimestampCount = subtitles.reduce(
    (count, subtitle) => count + (subtitle.words ?? []).filter((word) => !isValidInterval(word)).length,
    0,
  )
  const validCues = subtitles.filter(isValidInterval).slice().sort(compareIntervals)
  let overlapCount = 0
  let overlapDurationSeconds = 0

  for (let firstIndex = 0; firstIndex < validCues.length; firstIndex += 1) {
    const first = validCues[firstIndex]
    for (let secondIndex = firstIndex + 1; secondIndex < validCues.length; secondIndex += 1) {
      const second = validCues[secondIndex]
      if (second.startTime >= first.endTime) {
        break
      }
      overlapCount += 1
      overlapDurationSeconds += Math.max(0, Math.min(first.endTime, second.endTime) - second.startTime)
    }
  }

  let cpsViolationCount = 0
  let maxObservedCps = 0
  let lineLengthViolationCount = 0
  let captionLineLengthViolationCount = 0
  let maximumLineCountViolationCount = 0
  let maxObservedLineLength = 0

  for (const cue of validCues) {
    const duration = cue.endTime - cue.startTime
    const characterCount = Array.from(cue.text.replace(/\s/gu, '')).length
    const cps = duration > 0 ? characterCount / duration : Number.POSITIVE_INFINITY
    maxObservedCps = Math.max(maxObservedCps, cps)
    if (cps > constraints.maxCps) {
      cpsViolationCount += 1
    }

    const lines = cue.text.split(/\r?\n/u)
    let captionHasLineViolation = false
    for (const line of lines) {
      const lineLength = Array.from(line).length
      maxObservedLineLength = Math.max(maxObservedLineLength, lineLength)
      if (lineLength > constraints.maxLineLength) {
        lineLengthViolationCount += 1
        captionHasLineViolation = true
      }
    }
    if (captionHasLineViolation) {
      captionLineLengthViolationCount += 1
    }
    if (lines.length > constraints.maximumLines) {
      maximumLineCountViolationCount += 1
    }
  }

  return {
    cueCount: subtitles.length,
    validCueCount: validCues.length,
    invalidTimestampCount,
    invalidWordTimestampCount,
    overlapCount,
    overlapDurationSeconds: roundMetric(overlapDurationSeconds),
    cpsViolationCount,
    maxObservedCps: validCues.length ? roundMetric(maxObservedCps) : null,
    maxCps: constraints.maxCps,
    lineLengthViolationCount,
    captionLineLengthViolationCount,
    maxObservedLineLength,
    maxLineLength: constraints.maxLineLength,
    maximumLineCountViolationCount,
    maximumLines: constraints.maximumLines,
  }
}

export function calculatePerformanceMetrics(telemetry, manifestDurationSeconds) {
  if (!telemetry) {
    return null
  }

  const audioDurationSeconds = telemetry.audioDurationSeconds ?? manifestDurationSeconds ?? null
  const totalProcessingMs = telemetry.totalProcessingMs ?? null
  const inferenceMs = telemetry.stageDurationsMs?.inference ?? null

  return {
    stageDurationsMs: Object.fromEntries(
      Object.entries(telemetry.stageDurationsMs ?? {})
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, value]) => [key, roundMetric(value)]),
    ),
    totalProcessingMs: totalProcessingMs === null ? null : roundMetric(totalProcessingMs),
    audioDurationSeconds: audioDurationSeconds === null ? null : roundMetric(audioDurationSeconds),
    realTimeFactor: totalProcessingMs === null || !audioDurationSeconds
      ? null
      : roundMetric(totalProcessingMs / 1000 / audioDurationSeconds),
    inferenceRealTimeFactor: inferenceMs === null || !audioDurationSeconds
      ? null
      : roundMetric(inferenceMs / 1000 / audioDurationSeconds),
    modelLoadState: telemetry.modelLoadState ?? 'unknown',
    memory: telemetry.memory
      ? {
          peakBytes: telemetry.memory.peakBytes,
          method: telemetry.memory.method,
          approximate: telemetry.memory.approximate ?? true,
        }
      : null,
    workerMessages: telemetry.workerMessages
      ? {
          count: telemetry.workerMessages.count,
          totalBytes: telemetry.workerMessages.totalBytes,
          sizeMethod: telemetry.workerMessages.sizeMethod ?? 'json-utf8-approximation',
          byType: telemetry.workerMessages.byType ?? null,
        }
      : null,
  }
}

export function summarizeCaseMetrics(cases) {
  const summary = {
    caseCount: cases.length,
    text: summarizeText(cases),
    wordTiming: summarizeTiming(cases, 'wordTiming', 'matchedWordCount'),
    cueTiming: summarizeTiming(cases, 'cueTiming', 'matchedCueCount'),
    speechCoverage: summarizeSpeechCoverage(cases),
    duplication: summarizeDuplication(cases),
    subtitleQuality: summarizeSubtitleQuality(cases),
    performance: summarizePerformance(cases),
  }
  return summary
}

function summarizeText(cases) {
  const werCases = cases.filter(({ metrics }) => ['wer', 'both'].includes(metrics.text.primaryMetric))
  const cerCases = cases.filter(({ metrics }) => ['cer', 'both'].includes(metrics.text.primaryMetric))
  let wordErrors = 0
  let referenceWords = 0
  let characterErrors = 0
  let referenceCharacters = 0
  const similarities = []
  let exactMatchCount = 0

  for (const item of werCases) {
    const text = item.metrics.text
    wordErrors += text.wer.errors
    referenceWords += text.wer.referenceTokenCount
  }
  for (const item of cerCases) {
    const text = item.metrics.text
    characterErrors += text.cer.errors
    referenceCharacters += text.cer.referenceCharacterCount
  }
  for (const item of cases) {
    const text = item.metrics.text
    similarities.push(text.normalizedSimilarity)
    if (text.exactNormalizedMatch) {
      exactMatchCount += 1
    }
  }

  return {
    wer: referenceWords === 0 ? null : roundMetric(wordErrors / referenceWords),
    werCaseCount: werCases.length,
    wordErrors,
    referenceWordCount: referenceWords,
    cer: referenceCharacters === 0 ? null : roundMetric(characterErrors / referenceCharacters),
    cerCaseCount: cerCases.length,
    characterErrors,
    referenceCharacterCount: referenceCharacters,
    meanNormalizedSimilarity: similarities.length ? roundMetric(mean(similarities)) : null,
    exactMatchCount,
  }
}

function summarizeTiming(cases, key, matchedCountKey) {
  const evaluated = cases.map((item) => item.metrics[key]).filter(Boolean)
  if (evaluated.length === 0) {
    return null
  }

  const available = evaluated.filter((timing) => timing.available !== false)
  const unavailable = evaluated.filter((timing) => timing.available === false)

  const matchedCount = available.reduce((total, timing) => total + timing[matchedCountKey], 0)
  const endField = key === 'cueTiming' ? 'offsetErrorSeconds' : 'endErrorSeconds'
  const startField = key === 'cueTiming' ? 'onsetErrorSeconds' : 'startErrorSeconds'
  const startMean = weightedMean(
    available.map((timing) => [timing[startField]?.meanAbsolute ?? null, timing[matchedCountKey]]),
  )
  const endMean = weightedMean(
    available.map((timing) => [timing[endField]?.meanAbsolute ?? null, timing[matchedCountKey]]),
  )

  return {
    availableCaseCount: available.length,
    unavailableCaseCount: unavailable.length,
    unevaluatedCaseCount: cases.length - evaluated.length,
    unavailableReasons: [...new Set(unavailable.map((timing) => timing.unavailableReason))].sort(),
    matchedCount,
    meanAbsoluteStartOrOnsetErrorSeconds: startMean,
    meanAbsoluteEndOrOffsetErrorSeconds: endMean,
  }
}

function summarizeSpeechCoverage(cases) {
  const values = cases.map((item) => item.metrics.speechCoverage).filter(Boolean)
  if (values.length === 0) {
    return null
  }

  const reference = sum(values.map((value) => value.referenceSpeechDurationSeconds))
  const missed = sum(values.map((value) => value.missedSpeechDurationSeconds))
  const candidate = sum(values.map((value) => value.candidateCaptionDurationSeconds))
  const silence = sum(values.map((value) => value.candidateOverSilenceDurationSeconds))
  return {
    referenceSpeechDurationSeconds: roundMetric(reference),
    missedSpeechDurationSeconds: roundMetric(missed),
    missedSpeechRatio: roundRatio(missed, reference),
    candidateCaptionDurationSeconds: roundMetric(candidate),
    candidateOverSilenceDurationSeconds: roundMetric(silence),
    candidateOverSilenceRatio: roundRatio(silence, candidate),
    mostlySilenceCueCount: sum(values.map((value) => value.mostlySilenceCueCount)),
  }
}

function summarizeDuplication(cases) {
  const values = cases.map((item) => item.metrics.duplication)
  return {
    word: summarizeDuplicationUnit(values.filter((value) => value.unit === 'word')),
    character: summarizeDuplicationUnit(values.filter((value) => value.unit === 'character')),
  }
}

function summarizeDuplicationUnit(values) {
  if (values.length === 0) {
    return null
  }
  const units = sum(values.map((value) => value.candidateUnitCount))
  const adjacent = sum(values.map((value) => value.adjacentDuplicateUnitCount))
  const excessAdjacent = sum(values.map((value) => value.excessAdjacentDuplicateUnitCount))
  const phraseTokens = sum(values.map((value) => value.repeatedPhraseTokenCount))
  const excessPhraseTokens = sum(values.map((value) => value.excessRepeatedPhraseTokenCount))
  return {
    availableCaseCount: values.length,
    candidateUnitCount: units,
    adjacentDuplicateUnitCount: adjacent,
    adjacentDuplicateUnitRate: roundRatio(adjacent, units),
    excessAdjacentDuplicateUnitCount: excessAdjacent,
    excessAdjacentDuplicateUnitRate: roundRatio(excessAdjacent, units),
    repeatedPhraseTokenCount: phraseTokens,
    repeatedPhraseTokenRate: roundRatio(phraseTokens, units),
    excessRepeatedPhraseTokenCount: excessPhraseTokens,
    excessRepeatedPhraseTokenRate: roundRatio(excessPhraseTokens, units),
  }
}

function summarizeSubtitleQuality(cases) {
  const values = cases.map((item) => item.metrics.subtitleQuality)
  return {
    cueCount: sum(values.map((value) => value.cueCount)),
    invalidTimestampCount: sum(values.map((value) => value.invalidTimestampCount)),
    invalidWordTimestampCount: sum(values.map((value) => value.invalidWordTimestampCount)),
    overlapCount: sum(values.map((value) => value.overlapCount)),
    overlapDurationSeconds: roundMetric(sum(values.map((value) => value.overlapDurationSeconds))),
    cpsViolationCount: sum(values.map((value) => value.cpsViolationCount)),
    lineLengthViolationCount: sum(values.map((value) => value.lineLengthViolationCount)),
    captionLineLengthViolationCount: sum(values.map((value) => value.captionLineLengthViolationCount)),
    maximumLineCountViolationCount: sum(values.map((value) => value.maximumLineCountViolationCount)),
  }
}

function summarizePerformance(cases) {
  const values = cases.map((item) => item.metrics.performance).filter(Boolean)
  if (values.length === 0) {
    return null
  }

  const stageNames = new Set(values.flatMap((value) => Object.keys(value.stageDurationsMs)))
  const stageDurationsMs = {}
  for (const stage of [...stageNames].sort()) {
    const measured = values
      .map((value) => value.stageDurationsMs[stage])
      .filter((value) => value !== undefined && value !== null)
    const measuredTotalMs = roundMetric(sum(measured))
    stageDurationsMs[stage] = {
      totalMs: measured.length === cases.length ? measuredTotalMs : null,
      measuredTotalMs,
      measuredCaseCount: measured.length,
      missingCaseCount: cases.length - measured.length,
      totalCaseCount: cases.length,
    }
  }

  const totalProcessing = values
    .map((value) => value.totalProcessingMs)
    .filter((value) => value !== null)
  const realTimeFactors = values
    .map((value) => value.realTimeFactor)
    .filter((value) => value !== null)
  const memoryPeaks = values
    .map((value) => value.memory?.peakBytes ?? null)
    .filter((value) => value !== null)
  const messageValues = values.map((value) => value.workerMessages).filter(Boolean)

  return {
    availableCaseCount: values.length,
    missingTelemetryCaseCount: cases.length - values.length,
    totalCaseCount: cases.length,
    stageDurationsMs,
    totalProcessingMs: totalProcessing.length ? roundMetric(sum(totalProcessing)) : null,
    meanRealTimeFactor: realTimeFactors.length ? roundMetric(mean(realTimeFactors)) : null,
    peakObservedMemoryBytes: memoryPeaks.length ? Math.max(...memoryPeaks) : null,
    workerMessageCount: messageValues.length ? sum(messageValues.map((value) => value.count)) : null,
    workerMessageBytes: messageValues.length ? sum(messageValues.map((value) => value.totalBytes)) : null,
  }
}

function normalizeText(text, normalization, language) {
  let output = String(text ?? '').normalize(normalization.unicodeForm)
  if (normalization.lowercase) {
    output = localeLowercase(output, language)
  }
  if (normalization.stripPunctuation) {
    output = output.replace(/[\p{P}\p{S}]+/gu, ' ')
  }
  if (normalization.collapseWhitespace) {
    output = output.replace(/\s+/gu, ' ').trim()
  }
  return output
}

function localeLowercase(value, language) {
  try {
    const locale = language && language !== 'auto' ? Intl.getCanonicalLocales(language)[0] : undefined
    return locale ? value.toLocaleLowerCase(locale) : value.toLowerCase()
  } catch {
    return value.toLowerCase()
  }
}

function wordTokens(text) {
  return text ? text.split(/\s+/u).filter(Boolean) : []
}

function characterTokens(text, ignoreWhitespace) {
  const characters = Array.from(text)
  return ignoreWhitespace ? characters.filter((character) => !/\s/u.test(character)) : characters
}

function levenshteinDistance(reference, candidate) {
  return levenshteinRow(reference, candidate).at(-1) ?? 0
}

function levenshteinRow(reference, candidate) {
  let previous = new Uint32Array(candidate.length + 1)
  for (let index = 0; index <= candidate.length; index += 1) {
    previous[index] = index
  }

  for (let referenceIndex = 0; referenceIndex < reference.length; referenceIndex += 1) {
    const current = new Uint32Array(candidate.length + 1)
    current[0] = referenceIndex + 1
    for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
      const substitution = previous[candidateIndex] + (reference[referenceIndex] === candidate[candidateIndex] ? 0 : 1)
      const deletion = previous[candidateIndex + 1] + 1
      const insertion = current[candidateIndex] + 1
      current[candidateIndex + 1] = Math.min(substitution, deletion, insertion)
    }
    previous = current
  }
  return previous
}

function alignSequences(reference, candidate) {
  const operations = []
  alignRange(reference, 0, reference.length, candidate, 0, candidate.length, operations)
  return operations
}

function alignRange(reference, referenceStart, referenceEnd, candidate, candidateStart, candidateEnd, output) {
  const referenceLength = referenceEnd - referenceStart
  const candidateLength = candidateEnd - candidateStart
  if (referenceLength === 0) {
    for (let index = candidateStart; index < candidateEnd; index += 1) {
      output.push({ type: 'insert', candidateIndex: index })
    }
    return
  }
  if (candidateLength === 0) {
    for (let index = referenceStart; index < referenceEnd; index += 1) {
      output.push({ type: 'delete', referenceIndex: index })
    }
    return
  }
  if (referenceLength === 1 || candidateLength === 1) {
    output.push(...alignSmall(
      reference.slice(referenceStart, referenceEnd),
      candidate.slice(candidateStart, candidateEnd),
      referenceStart,
      candidateStart,
    ))
    return
  }

  const referenceMiddle = referenceStart + Math.floor(referenceLength / 2)
  const candidateSlice = candidate.slice(candidateStart, candidateEnd)
  const leftCosts = levenshteinRow(reference.slice(referenceStart, referenceMiddle), candidateSlice)
  const rightCosts = levenshteinRow(
    reference.slice(referenceMiddle, referenceEnd).reverse(),
    candidateSlice.slice().reverse(),
  )
  let bestSplit = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let index = 0; index <= candidateLength; index += 1) {
    const cost = leftCosts[index] + rightCosts[candidateLength - index]
    if (cost < bestCost) {
      bestCost = cost
      bestSplit = index
    }
  }
  const candidateMiddle = candidateStart + bestSplit
  alignRange(reference, referenceStart, referenceMiddle, candidate, candidateStart, candidateMiddle, output)
  alignRange(reference, referenceMiddle, referenceEnd, candidate, candidateMiddle, candidateEnd, output)
}

function alignSmall(reference, candidate, referenceOffset, candidateOffset) {
  const width = candidate.length + 1
  const distances = new Uint32Array((reference.length + 1) * width)
  const directions = new Uint8Array((reference.length + 1) * width)
  for (let index = 1; index <= reference.length; index += 1) {
    distances[index * width] = index
    directions[index * width] = 2
  }
  for (let index = 1; index <= candidate.length; index += 1) {
    distances[index] = index
    directions[index] = 3
  }
  for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
    for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) {
      const cell = referenceIndex * width + candidateIndex
      const equal = reference[referenceIndex - 1] === candidate[candidateIndex - 1]
      const diagonal = distances[(referenceIndex - 1) * width + candidateIndex - 1] + (equal ? 0 : 1)
      const deletion = distances[(referenceIndex - 1) * width + candidateIndex] + 1
      const insertion = distances[referenceIndex * width + candidateIndex - 1] + 1
      const best = Math.min(diagonal, deletion, insertion)
      distances[cell] = best
      directions[cell] = diagonal === best ? 1 : deletion === best ? 2 : 3
    }
  }

  const output = []
  let referenceIndex = reference.length
  let candidateIndex = candidate.length
  while (referenceIndex > 0 || candidateIndex > 0) {
    const direction = directions[referenceIndex * width + candidateIndex]
    if (direction === 1) {
      const type = reference[referenceIndex - 1] === candidate[candidateIndex - 1] ? 'equal' : 'substitute'
      output.push({
        type,
        referenceIndex: referenceOffset + referenceIndex - 1,
        candidateIndex: candidateOffset + candidateIndex - 1,
      })
      referenceIndex -= 1
      candidateIndex -= 1
    } else if (direction === 2) {
      output.push({ type: 'delete', referenceIndex: referenceOffset + referenceIndex - 1 })
      referenceIndex -= 1
    } else {
      output.push({ type: 'insert', candidateIndex: candidateOffset + candidateIndex - 1 })
      candidateIndex -= 1
    }
  }
  return output.reverse()
}

function countAlignmentOperations(alignment) {
  const counts = { substitutions: 0, deletions: 0, insertions: 0, errors: 0 }
  for (const operation of alignment) {
    if (operation.type === 'substitute') {
      counts.substitutions += 1
    } else if (operation.type === 'delete') {
      counts.deletions += 1
    } else if (operation.type === 'insert') {
      counts.insertions += 1
    }
  }
  counts.errors = counts.substitutions + counts.deletions + counts.insertions
  return counts
}

function flattenTimedWords(words, normalization, language) {
  return words.flatMap((word) => {
    if (!isValidInterval(word) || typeof word.text !== 'string') {
      return []
    }
    return wordTokens(normalizeText(word.text, normalization, language)).map((token) => ({
      token,
      startTime: word.startTime,
      endTime: word.endTime,
    }))
  })
}

function alignCues(reference, candidate, normalization, language, useCharacters) {
  if (candidate.length === 0) {
    return []
  }
  const width = candidate.length + 1
  const costs = new Float64Array((reference.length + 1) * width)
  const directions = new Uint8Array((reference.length + 1) * width)
  const similarities = new Float64Array(reference.length * candidate.length)
  for (let index = 1; index <= reference.length; index += 1) {
    costs[index * width] = index
    directions[index * width] = 2
  }
  for (let index = 1; index <= candidate.length; index += 1) {
    costs[index] = index
    directions[index] = 3
  }

  for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
    const referenceUnits = cueUnits(reference[referenceIndex - 1].text, normalization, language, useCharacters)
    for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) {
      const candidateUnits = cueUnits(candidate[candidateIndex - 1].text, normalization, language, useCharacters)
      const similarity = diceSimilarity(referenceUnits, candidateUnits)
      similarities[(referenceIndex - 1) * candidate.length + candidateIndex - 1] = similarity
      const diagonal = similarity >= 0.25
        ? costs[(referenceIndex - 1) * width + candidateIndex - 1] + 1 - similarity
        : Number.POSITIVE_INFINITY
      const deletion = costs[(referenceIndex - 1) * width + candidateIndex] + 1
      const insertion = costs[referenceIndex * width + candidateIndex - 1] + 1
      const best = Math.min(diagonal, deletion, insertion)
      const cell = referenceIndex * width + candidateIndex
      costs[cell] = best
      directions[cell] = diagonal <= best + Number.EPSILON && similarity >= 0.25
        ? 1
        : deletion <= insertion
          ? 2
          : 3
    }
  }

  const matches = []
  let referenceIndex = reference.length
  let candidateIndex = candidate.length
  while (referenceIndex > 0 || candidateIndex > 0) {
    const direction = directions[referenceIndex * width + candidateIndex]
    if (direction === 1) {
      matches.push({
        referenceIndex: referenceIndex - 1,
        candidateIndex: candidateIndex - 1,
        similarity: similarities[(referenceIndex - 1) * candidate.length + candidateIndex - 1],
      })
      referenceIndex -= 1
      candidateIndex -= 1
    } else if (direction === 2) {
      referenceIndex -= 1
    } else {
      candidateIndex -= 1
    }
  }
  return matches.reverse()
}

function cueUnits(text, normalization, language, useCharacters) {
  const normalized = normalizeText(text, normalization, language)
  return useCharacters ? characterTokens(normalized, true) : wordTokens(normalized)
}

function diceSimilarity(first, second) {
  if (first.length === 0 || second.length === 0) {
    return first.length === second.length ? 1 : 0
  }
  const counts = new Map()
  for (const unit of first) {
    counts.set(unit, (counts.get(unit) ?? 0) + 1)
  }
  let intersection = 0
  for (const unit of second) {
    const remaining = counts.get(unit) ?? 0
    if (remaining > 0) {
      intersection += 1
      counts.set(unit, remaining - 1)
    }
  }
  return (2 * intersection) / (first.length + second.length)
}

function countAdjacentDuplicates(tokens) {
  let count = 0
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] === tokens[index - 1]) {
      count += 1
    }
  }
  return count
}

function countRepeatedPhraseTokens(tokens, minimumSize, maximumSize) {
  let occurrenceCount = 0
  let tokenCount = 0
  let index = minimumSize
  while (index < tokens.length) {
    let matchSize = 0
    const largest = Math.min(maximumSize, index, tokens.length - index)
    for (let size = largest; size >= minimumSize; size -= 1) {
      let matches = true
      for (let offset = 0; offset < size; offset += 1) {
        if (tokens[index - size + offset] !== tokens[index + offset]) {
          matches = false
          break
        }
      }
      if (matches) {
        matchSize = size
        break
      }
    }
    if (matchSize > 0) {
      occurrenceCount += 1
      tokenCount += matchSize
      index += matchSize
    } else {
      index += 1
    }
  }
  return { occurrenceCount, tokenCount }
}

function wordsFromSubtitles(subtitles) {
  return subtitles.flatMap((subtitle) => Array.isArray(subtitle.words) ? subtitle.words : [])
}

function transcriptFromTimedEntries(entries) {
  return entries.map((entry) => entry.text ?? '').join(' ').replace(/\s+/gu, ' ').trim()
}

function deriveSpeechIntervals(words, subtitles) {
  if (Array.isArray(words) && words.length > 0) {
    return words.filter(isValidInterval).map(({ startTime, endTime }) => ({ startTime, endTime }))
  }
  if (Array.isArray(subtitles)) {
    return subtitles.filter(isValidInterval).map(({ startTime, endTime }) => ({ startTime, endTime }))
  }
  return null
}

function unionIntervals(intervals) {
  const sorted = intervals.filter(isValidInterval).map(({ startTime, endTime }) => ({ startTime, endTime })).sort(compareIntervals)
  const merged = []
  for (const interval of sorted) {
    const previous = merged.at(-1)
    if (!previous || interval.startTime > previous.endTime) {
      merged.push({ ...interval })
    } else {
      previous.endTime = Math.max(previous.endTime, interval.endTime)
    }
  }
  return merged
}

function intervalIntersectionDuration(first, second) {
  const left = unionIntervals(first)
  const right = unionIntervals(second)
  let firstIndex = 0
  let secondIndex = 0
  let duration = 0
  while (firstIndex < left.length && secondIndex < right.length) {
    const start = Math.max(left[firstIndex].startTime, right[secondIndex].startTime)
    const end = Math.min(left[firstIndex].endTime, right[secondIndex].endTime)
    duration += Math.max(0, end - start)
    if (left[firstIndex].endTime <= right[secondIndex].endTime) {
      firstIndex += 1
    } else {
      secondIndex += 1
    }
  }
  return duration
}

function totalIntervalDuration(intervals) {
  return intervals.reduce((total, interval) => total + interval.endTime - interval.startTime, 0)
}

function isUsableTimedText(value) {
  return isValidInterval(value) && typeof value.text === 'string' && value.text.trim().length > 0
}

function isValidInterval(value) {
  return Boolean(
    value
    && Number.isFinite(value.startTime)
    && Number.isFinite(value.endTime)
    && value.startTime >= 0
    && value.endTime > value.startTime,
  )
}

function compareIntervals(first, second) {
  return first.startTime - second.startTime || first.endTime - second.endTime
}

function errorStatistics(errors) {
  if (errors.length === 0) {
    return null
  }
  const absolute = errors.map(Math.abs)
  return {
    meanAbsolute: roundMetric(mean(absolute)),
    medianAbsolute: roundMetric(median(absolute)),
    meanSigned: roundMetric(mean(errors)),
  }
}

function weightedMean(values) {
  let total = 0
  let weight = 0
  for (const [value, itemWeight] of values) {
    if (value === null || itemWeight <= 0) {
      continue
    }
    total += value * itemWeight
    weight += itemWeight
  }
  return weight ? roundMetric(total / weight) : null
}

function mean(values) {
  return sum(values) / values.length
}

function median(values) {
  const sorted = values.slice().sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function roundRatio(numerator, denominator) {
  return denominator === 0 ? null : roundMetric(numerator / denominator)
}

function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null
}
