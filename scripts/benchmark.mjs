#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { compareBenchmarkReports } from './benchmark/comparison.mjs'
import {
  BenchmarkInputError,
  loadBenchmarkSuite,
  readBenchmarkReport,
} from './benchmark/io.mjs'
import {
  calculateCueTimingMetrics,
  calculateDuplicationMetrics,
  calculateSubtitleQualityMetrics,
  calculateTextMetrics,
  evaluateBenchmarkCase,
  summarizeCaseMetrics,
} from './benchmark/metrics.mjs'

const HELP = `Auto Subtitle local benchmark harness

Usage:
  node scripts/benchmark.mjs run --manifest <manifest.json> --run <run.json> [--out <report.json>]
  node scripts/benchmark.mjs compare --baseline <report.json> --candidate <report.json> [--out <comparison.json>]
  node scripts/benchmark.mjs self-test

Options:
  --allow-missing-media  Score an offline artifact without verifying its media file. The report records the missing media.
  --out <path>           Write the emitted JSON to this path in addition to stdout.
  --help                 Show this message.
`

async function main() {
  const [command = 'help', ...argumentsList] = process.argv.slice(2)
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return
  }
  const options = parseOptions(argumentsList)
  if (options.help) {
    process.stdout.write(HELP)
    return
  }

  if (command === 'run') {
    const manifestPath = requiredOption(options, 'manifest')
    const runPath = requiredOption(options, 'run')
    const suite = await loadBenchmarkSuite(manifestPath, runPath, {
      allowMissingMedia: options.allowMissingMedia === true,
    })
    const cases = suite.cases.map((item) => ({
      id: item.manifestCase.id,
      referenceFingerprint: item.fingerprint,
      media: item.media,
      settings: item.settings,
      settingsSourcesMatch: item.settingsSourcesMatch,
      metrics: evaluateBenchmarkCase(item.manifestCase, item.reference, item.candidate),
    }))
    const report = {
      schemaVersion: 1,
      kind: 'auto-subtitle-benchmark-report',
      generatedAt: new Date().toISOString(),
      manifest: suite.manifest,
      run: suite.run,
      cases,
      summary: summarizeCaseMetrics(cases),
      warnings: suite.warnings,
      interpretation: 'Metrics are measurements of the supplied local artifacts. No accuracy or performance improvement is inferred.',
    }
    await emitJson(report, options.out)
    return
  }

  if (command === 'compare') {
    const baselinePath = requiredOption(options, 'baseline')
    const candidatePath = requiredOption(options, 'candidate')
    const { report: baseline } = await readBenchmarkReport(baselinePath)
    const { report: candidate } = await readBenchmarkReport(candidatePath)
    const comparison = compareBenchmarkReports(baseline, candidate)
    await emitJson(comparison, options.out)
    return
  }

  if (command === 'self-test') {
    const result = await runSelfTest()
    await emitJson(result, options.out)
    return
  }

  throw new BenchmarkInputError(`Unknown command ${JSON.stringify(command)}.\n\n${HELP}`)
}

function parseOptions(argumentsList) {
  const options = {}
  const booleanOptions = new Set(['allow-missing-media', 'help'])
  const valueOptions = new Set(['manifest', 'run', 'out', 'baseline', 'candidate'])
  for (let index = 0; index < argumentsList.length; index += 1) {
    const item = argumentsList[index]
    if (!item.startsWith('--')) {
      throw new BenchmarkInputError(`Unexpected positional argument ${JSON.stringify(item)}.`)
    }
    const name = item.slice(2)
    const camelName = name.replace(/-([a-z])/gu, (_, character) => character.toUpperCase())
    if (booleanOptions.has(name)) {
      options[camelName] = true
      continue
    }
    if (!valueOptions.has(name)) {
      throw new BenchmarkInputError(`Unknown option --${name}.`)
    }
    const value = argumentsList[index + 1]
    if (!value || value.startsWith('--')) {
      throw new BenchmarkInputError(`Option --${name} requires a value.`)
    }
    options[camelName] = value
    index += 1
  }
  return options
}

function requiredOption(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BenchmarkInputError(`Missing required option --${name}.`)
  }
  return value
}

async function emitJson(value, outputPath) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (outputPath) {
    const absolutePath = resolve(outputPath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, serialized, 'utf8')
  }
  process.stdout.write(serialized)
}

async function runSelfTest() {
  const manifestCase = {
    id: 'synthetic-self-test',
    language: 'en',
    textMetric: 'wer',
    durationSeconds: 3,
    normalization: {
      unicodeForm: 'NFKC',
      lowercase: true,
      stripPunctuation: true,
      collapseWhitespace: true,
      cerIgnoreWhitespace: true,
    },
    constraints: {
      maxCps: 21,
      maxLineLength: 42,
      maximumLines: 2,
      minimumSpeechOverlapRatio: 0.5,
      minimumCueDurationSeconds: 0.5,
      maximumCueDurationSeconds: 1.1,
    },
  }
  const reference = {
    transcript: 'Alpha beta gamma',
    words: [
      { text: 'Alpha', startTime: 0, endTime: 0.4 },
      { text: 'beta', startTime: 0.5, endTime: 0.9 },
      { text: 'gamma', startTime: 1, endTime: 1.4 },
    ],
    subtitles: [
      { text: 'Alpha beta', startTime: 0, endTime: 1 },
      { text: 'gamma', startTime: 1.1, endTime: 1.5 },
    ],
    speechIntervals: [
      { startTime: 0, endTime: 0.4 },
      { startTime: 0.5, endTime: 0.9 },
      { startTime: 1, endTime: 1.4 },
    ],
  }
  const candidate = {
    caseId: 'synthetic-self-test',
    transcript: 'alpha beta delta gamma',
    words: [
      { text: 'alpha', startTime: 0.1, endTime: 0.5 },
      { text: 'beta', startTime: 0.6, endTime: 1 },
      { text: 'gamma', startTime: 1.1, endTime: 1.5 },
    ],
    subtitles: [
      { text: 'Alpha beta', startTime: 0.1, endTime: 1.25 },
      { text: 'gamma', startTime: 1.2, endTime: 1.6 },
      { text: 'invalid', startTime: 2, endTime: 1.9 },
    ],
    telemetry: {
      audioDurationSeconds: 3,
      totalProcessingMs: 3000,
      modelLoadState: 'warm',
      stageDurationsMs: {
        audioExtraction: 500,
        vadAnalysis: 100,
        inference: 2000,
        formatting: 100,
      },
      memory: {
        peakBytes: 123456,
        method: 'synthetic-self-test',
        approximate: true,
      },
      workerMessages: {
        count: 10,
        totalBytes: 1000,
        sizeMethod: 'json-utf8-approximation',
      },
    },
  }
  const metrics = evaluateBenchmarkCase(manifestCase, reference, candidate)
  const checks = []
  checkClose(metrics.text.wer.rate, 1 / 3, 'WER counts one inserted token', checks)
  checkEqual(metrics.text.wer.insertions, 1, 'WER insertion breakdown', checks)
  checkEqual(metrics.text.differences.totalDifferenceCount, 1, 'readable text difference count', checks)
  checkEqual(metrics.text.differences.entries[0].type, 'insertion', 'readable text difference type', checks)
  checkClose(metrics.wordTiming.startErrorSeconds.meanAbsolute, 0.1, 'mean word-start absolute error', checks)
  checkClose(metrics.wordTiming.endErrorSeconds.medianAbsolute, 0.1, 'median word-end absolute error', checks)
  checkClose(metrics.wordTiming.startErrorSeconds.maximumAbsolute, 0.1, 'maximum word-start error', checks)
  checkEqual(
    metrics.wordTiming.startErrorSeconds.withinTolerances['250ms'].count,
    3,
    'word starts within 250 ms count',
    checks,
  )
  checkEqual(metrics.cueTiming.matchedCueCount, 2, 'monotonic cue matching', checks)
  checkClose(metrics.cueTiming.offsetErrorSeconds.maximumAbsolute, 0.25, 'maximum cue-offset error', checks)
  checkEqual(
    metrics.cueTiming.offsetErrorSeconds.withinTolerances['250ms'].percentage,
    100,
    'cue offsets within 250 ms percentage',
    checks,
  )
  checkEqual(metrics.cueTiming.differences.totalDifferenceCount, 2, 'per-cue difference count', checks)
  checkClose(metrics.speechCoverage.missedSpeechDurationSeconds, 0.1, 'missed speech duration', checks)
  checkClose(metrics.speechCoverage.candidateOverSilenceDurationSeconds, 0.4, 'silence placement duration', checks)
  checkEqual(metrics.subtitleQuality.invalidTimestampCount, 1, 'invalid cue count', checks)
  checkEqual(metrics.subtitleQuality.overlapCount, 1, 'overlap count', checks)
  checkClose(metrics.subtitleQuality.cueDurationSeconds.minimum, 0.4, 'minimum cue duration', checks)
  checkClose(metrics.subtitleQuality.cueDurationSeconds.maximum, 1.15, 'maximum cue duration', checks)
  checkClose(metrics.subtitleQuality.interCueGapSeconds.minimum, -0.05, 'minimum inter-cue gap', checks)
  checkEqual(
    metrics.subtitleQuality.minimumCueDurationViolationCount,
    1,
    'minimum cue-duration violation count',
    checks,
  )
  checkEqual(
    metrics.subtitleQuality.maximumCueDurationViolationCount,
    1,
    'maximum cue-duration violation count',
    checks,
  )
  checkClose(metrics.performance.realTimeFactor, 1, 'real-time factor', checks)
  checkEqual(metrics.performance.workerMessages.count, 10, 'worker message count', checks)

  const cjkText = calculateTextMetrics('你好世界', '你好世間', manifestCase.normalization, 'zh', 'cer')
  checkClose(cjkText.cer.rate, 0.25, 'CER uses Unicode code points', checks)
  const duplication = calculateDuplicationMetrics(
    'alpha beta gamma',
    'alpha beta alpha beta gamma',
    manifestCase.normalization,
    'en',
    'wer',
  )
  checkEqual(duplication.repeatedPhraseTokenCount, 2, 'immediate repeated phrase tokens', checks)
  const quality = calculateSubtitleQualityMetrics(
    [
      { text: 'a'.repeat(30), startTime: 0, endTime: 1 },
      { text: 'b'.repeat(43), startTime: 2, endTime: 12 },
    ],
    manifestCase.constraints,
  )
  checkEqual(quality.cpsViolationCount, 1, 'CPS violation count', checks)
  checkEqual(quality.lineLengthViolationCount, 1, 'line-length violation count', checks)
  checkClose(quality.cueDurationSeconds.mean, 5.5, 'cue-duration mean', checks)
  checkClose(quality.interCueGapSeconds.mean, 1, 'inter-cue gap mean', checks)
  checkEqual(quality.maximumCueDurationViolationCount, 1, 'standalone maximum-duration violation', checks)

  const boundedTextDifferences = calculateTextMetrics(
    '',
    Array.from({ length: 60 }, (_, index) => `extra${index}`).join(' '),
    manifestCase.normalization,
    'en',
    'wer',
  ).differences
  checkEqual(boundedTextDifferences.totalDifferenceCount, 60, 'full text difference count', checks)
  checkEqual(boundedTextDifferences.returnedDifferenceCount, 50, 'bounded text difference details', checks)
  checkEqual(boundedTextDifferences.omittedDifferenceCount, 10, 'omitted text difference count', checks)
  const longTextDifference = calculateTextMetrics(
    '',
    'x'.repeat(200),
    manifestCase.normalization,
    'en',
    'wer',
  ).differences.entries[0]
  checkEqual(longTextDifference.candidateTextTruncated, true, 'long difference text is marked truncated', checks)
  checkEqual(Array.from(longTextDifference.candidateText).length, 160, 'long difference text is bounded', checks)

  const cueDifferenceReference = Array.from({ length: 60 }, (_, index) => ({
    text: `word${index}`,
    startTime: index * 2,
    endTime: index * 2 + 1,
  }))
  const cueDifferenceCandidate = cueDifferenceReference.map((cue) => ({
    ...cue,
    startTime: cue.startTime + 0.1,
    endTime: cue.endTime + 0.1,
  }))
  const boundedCueDifferences = calculateCueTimingMetrics(
    cueDifferenceReference,
    cueDifferenceCandidate,
    manifestCase.normalization,
    'en',
    'wer',
  ).differences
  checkEqual(boundedCueDifferences.totalDifferenceCount, 60, 'full cue difference count', checks)
  checkEqual(boundedCueDifferences.returnedDifferenceCount, 50, 'bounded cue difference details', checks)
  checkEqual(boundedCueDifferences.omittedDifferenceCount, 10, 'omitted cue difference count', checks)

  const wordCaseMetrics = evaluateBenchmarkCase(
    { ...manifestCase, id: 'word-summary', textMetric: 'wer' },
    { transcript: 'alpha beta' },
    { caseId: 'word-summary', transcript: 'alpha gamma' },
  )
  const characterCaseMetrics = evaluateBenchmarkCase(
    { ...manifestCase, id: 'character-summary', language: 'ja', textMetric: 'cer' },
    { transcript: 'abc' },
    { caseId: 'character-summary', transcript: 'axc' },
  )
  const mixedMetricSummary = summarizeCaseMetrics([
    { id: 'word-summary', metrics: wordCaseMetrics },
    { id: 'character-summary', metrics: characterCaseMetrics },
  ])
  checkClose(mixedMetricSummary.text.wer, 0.5, 'suite WER excludes CER-only cases', checks)
  checkEqual(mixedMetricSummary.text.referenceWordCount, 2, 'suite WER denominator uses WER cases', checks)
  checkClose(mixedMetricSummary.text.cer, 1 / 3, 'suite CER excludes WER-only cases', checks)
  checkEqual(mixedMetricSummary.text.referenceCharacterCount, 3, 'suite CER denominator uses CER cases', checks)
  checkEqual(mixedMetricSummary.duplication.word.candidateUnitCount, 2, 'word duplication summary stays separate', checks)
  checkEqual(
    mixedMetricSummary.duplication.character.candidateUnitCount,
    3,
    'character duplication summary stays separate',
    checks,
  )

  const firstTimedMetrics = evaluateBenchmarkCase(
    { ...manifestCase, id: 'first-timed' },
    { transcript: 'alpha' },
    {
      caseId: 'first-timed',
      transcript: 'alpha',
      telemetry: { stageDurationsMs: { inference: 100 } },
    },
  )
  const secondTimedMetrics = evaluateBenchmarkCase(
    { ...manifestCase, id: 'second-timed' },
    { transcript: 'beta' },
    {
      caseId: 'second-timed',
      transcript: 'beta',
      telemetry: { stageDurationsMs: { formatting: 20 } },
    },
  )
  const incompleteStageSummary = summarizeCaseMetrics([
    { id: 'first-timed', metrics: firstTimedMetrics },
    { id: 'second-timed', metrics: secondTimedMetrics },
  ]).performance.stageDurationsMs.inference
  checkEqual(incompleteStageSummary.totalMs, null, 'incomplete stage total remains null', checks)
  checkEqual(incompleteStageSummary.measuredTotalMs, 100, 'measured stage subtotal is explicit', checks)
  checkEqual(incompleteStageSummary.measuredCaseCount, 1, 'stage measured-case count', checks)
  checkEqual(incompleteStageSummary.missingCaseCount, 1, 'stage missing-case count', checks)

  const syntheticSummary = summarizeCaseMetrics([{ id: manifestCase.id, metrics }])
  checkClose(
    syntheticSummary.cueTiming.maximumAbsoluteEndOrOffsetErrorSeconds,
    0.25,
    'suite maximum cue-offset error',
    checks,
  )
  checkEqual(
    syntheticSummary.cueTiming.endOrOffsetWithinTolerances['250ms'].count,
    2,
    'suite cue-offset tolerance count',
    checks,
  )
  checkEqual(
    syntheticSummary.subtitleQuality.minimumCueDurationViolationCount,
    1,
    'suite minimum-duration violation count',
    checks,
  )

  const manyCues = Array.from({ length: 1_000 }, (_, index) => ({
    text: `cue ${index}`,
    startTime: index * 2,
    endTime: index * 2 + 1,
  }))
  const boundedCueTiming = calculateCueTimingMetrics(
    manyCues,
    manyCues,
    manifestCase.normalization,
    'en',
    'wer',
  )
  checkEqual(boundedCueTiming.available, false, 'oversized cue alignment reports unavailable', checks)
  checkEqual(
    boundedCueTiming.unavailableReason,
    'cue-alignment-cell-limit',
    'oversized cue alignment reason',
    checks,
  )

  const baseReport = {
    schemaVersion: 1,
    kind: 'auto-subtitle-benchmark-report',
    manifest: { suiteFingerprint: 'self-test' },
    run: { label: 'baseline', environment: { browser: 'self-test' } },
    cases: [{
      id: 'synthetic',
      referenceFingerprint: 'reference',
      settings: {},
      settingsSourcesMatch: false,
      metrics,
    }],
    summary: {
      text: { wer: 0.5 },
      cueTiming: {
        endOrOffsetWithinTolerances: {
          '250ms': { toleranceSeconds: 0.25, count: 1, evaluatedCount: 2, percentage: 50 },
        },
      },
    },
  }
  const candidateReport = structuredClone(baseReport)
  candidateReport.run.label = 'candidate'
  candidateReport.summary.text.wer = 0.25
  candidateReport.summary.cueTiming.endOrOffsetWithinTolerances['250ms'].percentage = 100
  const comparison = compareBenchmarkReports(baseReport, candidateReport)
  checkClose(
    comparison.summaryNumericDeltas['text.wer'].candidateMinusBaseline,
    -0.25,
    'comparison uses candidate minus baseline',
    checks,
  )
  checkClose(
    comparison.summaryNumericDeltas[
      'cueTiming.endOrOffsetWithinTolerances.250ms.percentage'
    ].candidateMinusBaseline,
    50,
    'comparison includes tolerance percentages',
    checks,
  )
  checkEqual(
    comparison.comparability.settingsSourcesMatch,
    false,
    'comparison is uncontrolled when settings sources conflict',
    checks,
  )
  const missingEnvironmentBaseline = structuredClone(baseReport)
  const missingEnvironmentCandidate = structuredClone(candidateReport)
  missingEnvironmentBaseline.run.environment = {}
  missingEnvironmentCandidate.run.environment = {}
  const missingEnvironmentComparison = compareBenchmarkReports(
    missingEnvironmentBaseline,
    missingEnvironmentCandidate,
  )
  checkEqual(
    missingEnvironmentComparison.comparability.environmentRecorded,
    false,
    'comparison records missing environment details',
    checks,
  )
  checkEqual(
    missingEnvironmentComparison.comparability.environmentMatch,
    false,
    'missing environments are not treated as a match',
    checks,
  )

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'auto-subtitle-benchmark-self-test-'))
  try {
    const mediaPath = join(temporaryDirectory, 'fixture.bin')
    const transcriptPath = join(temporaryDirectory, 'reference.txt')
    const resultPath = join(temporaryDirectory, 'result.json')
    const manifestPath = join(temporaryDirectory, 'manifest.json')
    const runPath = join(temporaryDirectory, 'run.json')
    await writeFile(mediaPath, 'deterministic non-media fixture', 'utf8')
    await writeFile(transcriptPath, 'schema validation works', 'utf8')
    await writeFile(resultPath, JSON.stringify({
      schemaVersion: 1,
      caseId: 'io-self-test',
      transcript: 'schema validation works',
      metadata: { settings: { modelId: 'artifact-model' } },
    }), 'utf8')
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      name: 'io-self-test',
      cases: [{
        id: 'io-self-test',
        media: 'fixture.bin',
        language: 'en',
        textMetric: 'wer',
        constraints: {
          minimumCueDurationSeconds: 0.5,
          maximumCueDurationSeconds: 6,
        },
        settings: { modelId: 'self-test' },
        reference: { transcriptFile: 'reference.txt' },
      }],
    }), 'utf8')
    await writeFile(runPath, JSON.stringify({
      schemaVersion: 1,
      label: 'io-self-test',
      environment: { runtime: 'synthetic' },
      cases: [{
        id: 'io-self-test',
        result: 'result.json',
        settings: { modelId: 'self-test' },
      }],
    }), 'utf8')
    const loadedSuite = await loadBenchmarkSuite(manifestPath, runPath)
    checkEqual(loadedSuite.cases.length, 1, 'manifest and run schema loading', checks)
    checkEqual(loadedSuite.cases[0].media.sha256.length, 64, 'streamed media SHA-256 fingerprint', checks)
    checkClose(
      loadedSuite.cases[0].manifestCase.constraints.minimumCueDurationSeconds,
      0.5,
      'optional minimum-duration constraint loading',
      checks,
    )
    checkClose(
      loadedSuite.cases[0].manifestCase.constraints.maximumCueDurationSeconds,
      6,
      'optional maximum-duration constraint loading',
      checks,
    )
    checkEqual(loadedSuite.cases[0].settingsSourcesMatch, false, 'descriptor/artifact settings conflict detection', checks)
    checkEqual(
      loadedSuite.warnings.some((warning) => warning.includes('descriptor settings conflict')),
      true,
      'descriptor/artifact settings conflict warning',
      checks,
    )
    await writeFile(resultPath, JSON.stringify({
      schemaVersion: 1,
      caseId: 'io-self-test',
      transcript: 'schema validation works',
      metadata: {
        settings: {
          modelId: 'self-test',
          formatting: { useWordTimestamps: true },
          additionalArtifactField: 'allowed',
        },
      },
    }), 'utf8')
    await writeFile(runPath, JSON.stringify({
      schemaVersion: 1,
      label: 'io-self-test',
      environment: { runtime: 'synthetic' },
      cases: [{
        id: 'io-self-test',
        result: 'result.json',
        settings: { modelId: 'self-test', useWordTimestamps: true },
      }],
    }), 'utf8')
    const matchingSettingsSuite = await loadBenchmarkSuite(manifestPath, runPath)
    checkEqual(
      matchingSettingsSuite.cases[0].settingsSourcesMatch,
      true,
      'descriptor settings may be a matching subset of artifact settings',
      checks,
    )
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      name: 'invalid-duration-constraints',
      cases: [{
        id: 'io-self-test',
        media: 'fixture.bin',
        language: 'en',
        constraints: {
          minimumCueDurationSeconds: 7,
          maximumCueDurationSeconds: 6,
        },
        reference: { transcriptFile: 'reference.txt' },
      }],
    }), 'utf8')
    let invalidDurationConstraintRejected = false
    try {
      await loadBenchmarkSuite(manifestPath, runPath)
    } catch (error) {
      invalidDurationConstraintRejected = error instanceof BenchmarkInputError
        && error.issues.some((issue) => issue.includes('must not exceed'))
    }
    checkEqual(
      invalidDurationConstraintRejected,
      true,
      'inverted duration constraints are rejected',
      checks,
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }

  return {
    schemaVersion: 1,
    kind: 'auto-subtitle-benchmark-self-test',
    status: 'passed',
    checkCount: checks.length,
    checks,
    note: 'Synthetic values validate scorer behavior only; they are not project benchmark results.',
  }
}

function checkEqual(actual, expected, name, checks) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, received ${actual}`)
  }
  checks.push(name)
}

function checkClose(actual, expected, name, checks) {
  if (actual === null || Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${name}: expected approximately ${expected}, received ${actual}`)
  }
  checks.push(name)
}

main().catch((error) => {
  const lines = [error instanceof Error ? error.message : String(error)]
  if (error instanceof BenchmarkInputError && error.issues.length) {
    lines.push(...error.issues.map((issue) => `- ${issue}`))
  }
  process.stderr.write(`${lines.join('\n')}\n`)
  process.exitCode = 1
})
