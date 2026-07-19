import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export class BenchmarkInputError extends Error {
  constructor(message, issues = []) {
    super(message)
    this.name = 'BenchmarkInputError'
    this.issues = issues
  }
}

export async function loadBenchmarkSuite(manifestPathInput, runPathInput, options = {}) {
  const manifestPath = resolve(manifestPathInput)
  const runPath = resolve(runPathInput)
  const manifest = await readJson(manifestPath)
  const run = await readJson(runPath)
  validateManifest(manifest, manifestPath)
  validateRunDescriptor(run, runPath)

  const manifestDirectory = dirname(manifestPath)
  const runDirectory = dirname(runPath)
  const manifestCases = new Map(manifest.cases.map((item) => [item.id, item]))
  const runCaseIds = new Set(run.cases.map((item) => item.id))
  const warnings = []
  const unknownRunCases = run.cases.filter((item) => !manifestCases.has(item.id)).map((item) => item.id)
  if (unknownRunCases.length) {
    throw new BenchmarkInputError('The run descriptor contains cases that are not in the manifest.', unknownRunCases)
  }
  const missingRunCases = manifest.cases.filter((item) => !runCaseIds.has(item.id)).map((item) => item.id)
  if (missingRunCases.length) {
    warnings.push(`Run omits ${missingRunCases.length} manifest case(s): ${missingRunCases.join(', ')}`)
  }

  const loadedCases = []
  for (const runCase of run.cases) {
    const manifestCase = manifestCases.get(runCase.id)
    const media = await inspectMedia(manifestCase, manifestDirectory, options.allowMissingMedia === true)
    if (media.missing) {
      warnings.push(`Case ${runCase.id}: media is missing; scoring continues because --allow-missing-media was set.`)
    }
    const reference = await loadReference(manifestCase.reference, manifestDirectory)
    const candidate = await loadCandidate(runCase, runDirectory)
    if (candidate.caseId !== runCase.id) {
      throw new BenchmarkInputError(
        `Result caseId ${JSON.stringify(candidate.caseId)} does not match run case ${JSON.stringify(runCase.id)}.`,
      )
    }

    const normalization = normalizedNormalization(manifestCase.normalization)
    const constraints = normalizedConstraints(manifestCase.constraints)
    const fingerprint = sha256Text(stableStringify({
      id: manifestCase.id,
      language: manifestCase.language,
      textMetric: manifestCase.textMetric ?? 'wer',
      durationSeconds: manifestCase.durationSeconds ?? null,
      normalization,
      constraints,
      mediaSha256: media.sha256,
      reference,
    }))
    const expectedSettings = manifestCase.settings ?? null
    const descriptorSettings = runCase.settings ?? null
    const artifactSettings = candidate.metadata?.settings ?? null
    const settingsSourcesMatch = settingsSnapshotsAgree(descriptorSettings, artifactSettings)
    if (!settingsSourcesMatch) {
      warnings.push(
        `Case ${runCase.id}: run descriptor settings conflict with settings recorded in the result artifact.`,
      )
    }
    const actualSettings = descriptorSettings ?? artifactSettings
    if (expectedSettings && stableStringify(expectedSettings) !== stableStringify(actualSettings)) {
      warnings.push(`Case ${runCase.id}: run settings do not match the frozen manifest settings.`)
    }
    if (!reference.words) {
      warnings.push(`Case ${runCase.id}: word timestamp metrics are unavailable because no timed reference words were supplied.`)
    }
    if (!reference.subtitles) {
      warnings.push(`Case ${runCase.id}: cue onset/offset metrics are unavailable because no reference subtitles were supplied.`)
    }
    if (!candidate.telemetry) {
      warnings.push(`Case ${runCase.id}: performance, memory, and worker-message metrics are unavailable because telemetry was not supplied.`)
    }

    loadedCases.push({
      manifestCase: {
        ...manifestCase,
        normalization,
        constraints,
      },
      reference,
      candidate,
      fingerprint,
      media,
      settings: actualSettings,
      settingsSourcesMatch,
    })
  }

  const suiteFingerprint = sha256Text(stableStringify(
    loadedCases.map((item) => ({ id: item.manifestCase.id, fingerprint: item.fingerprint })),
  ))

  return {
    manifest: {
      name: manifest.name,
      description: manifest.description,
      path: portableRelativePath(manifestPath),
      schemaVersion: manifest.schemaVersion,
      suiteFingerprint,
    },
    run: {
      label: run.label,
      notes: run.notes,
      path: portableRelativePath(runPath),
      environment: run.environment ?? {},
      environmentFingerprint: sha256Text(stableStringify(run.environment ?? {})),
    },
    cases: loadedCases,
    warnings,
  }
}

export async function readBenchmarkReport(pathInput) {
  const path = resolve(pathInput)
  const report = await readJson(path)
  validateBenchmarkReport(report, path)
  return { report, path }
}

export function validateBenchmarkReport(report, path = '<benchmark report>') {
  const issues = []
  if (!isRecord(report)) {
    throw new BenchmarkInputError(`${path} must contain a JSON object.`)
  }
  if (report.schemaVersion !== 1) {
    issues.push('schemaVersion must be 1')
  }
  if (report.kind !== 'auto-subtitle-benchmark-report') {
    issues.push('kind must be "auto-subtitle-benchmark-report"')
  }
  if (!isRecord(report.manifest) || typeof report.manifest.suiteFingerprint !== 'string') {
    issues.push('manifest.suiteFingerprint must be a string')
  }
  if (!isRecord(report.run) || typeof report.run.label !== 'string') {
    issues.push('run.label must be a string')
  }
  if (!Array.isArray(report.cases)) {
    issues.push('cases must be an array')
  } else {
    for (const [index, item] of report.cases.entries()) {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.referenceFingerprint !== 'string') {
        issues.push(`cases[${index}] must contain string id and referenceFingerprint`)
      }
      if (!isRecord(item?.metrics)) {
        issues.push(`cases[${index}].metrics must be an object`)
      }
      if (item?.settingsSourcesMatch !== undefined && typeof item.settingsSourcesMatch !== 'boolean') {
        issues.push(`cases[${index}].settingsSourcesMatch must be boolean when supplied`)
      }
    }
  }
  if (issues.length) {
    throw new BenchmarkInputError(`${path} is not a valid benchmark report.`, issues)
  }
}

export function stableStringify(value) {
  return JSON.stringify(sortJsonValue(value))
}

export function portableRelativePath(path) {
  const result = relative(process.cwd(), path)
  return (result || '.').replaceAll('\\', '/')
}

function validateManifest(manifest, path) {
  const issues = []
  if (!isRecord(manifest)) {
    throw new BenchmarkInputError(`${path} must contain a JSON object.`)
  }
  if (manifest.schemaVersion !== 1) {
    issues.push('schemaVersion must be 1')
  }
  if (!nonEmptyString(manifest.name)) {
    issues.push('name must be a non-empty string')
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    issues.push('cases must be a non-empty array')
  } else {
    const ids = new Set()
    for (const [index, item] of manifest.cases.entries()) {
      const prefix = `cases[${index}]`
      if (!isRecord(item)) {
        issues.push(`${prefix} must be an object`)
        continue
      }
      if (!nonEmptyString(item.id)) {
        issues.push(`${prefix}.id must be a non-empty string`)
      } else if (ids.has(item.id)) {
        issues.push(`${prefix}.id duplicates ${JSON.stringify(item.id)}`)
      } else {
        ids.add(item.id)
      }
      if (!nonEmptyString(item.media)) {
        issues.push(`${prefix}.media must be a non-empty path string`)
      }
      if (!nonEmptyString(item.language)) {
        issues.push(`${prefix}.language must be a non-empty string`)
      }
      if (item.textMetric !== undefined && !['wer', 'cer', 'both'].includes(item.textMetric)) {
        issues.push(`${prefix}.textMetric must be "wer", "cer", or "both"`)
      }
      if (item.durationSeconds !== undefined && !positiveNumber(item.durationSeconds)) {
        issues.push(`${prefix}.durationSeconds must be a positive finite number`)
      }
      if (item.mediaSha256 !== undefined && (
        typeof item.mediaSha256 !== 'string' || !SHA256_PATTERN.test(item.mediaSha256.toLowerCase())
      )) {
        issues.push(`${prefix}.mediaSha256 must be a 64-character hexadecimal SHA-256`)
      }
      validateReferenceDescriptor(item.reference, `${prefix}.reference`, issues)
      validateNormalization(item.normalization, `${prefix}.normalization`, issues)
      validateConstraints(item.constraints, `${prefix}.constraints`, issues)
      if (item.settings !== undefined && !isRecord(item.settings)) {
        issues.push(`${prefix}.settings must be an object when supplied`)
      }
    }
  }
  if (issues.length) {
    throw new BenchmarkInputError(`${path} is not a valid benchmark manifest.`, issues)
  }
}

function validateRunDescriptor(run, path) {
  const issues = []
  if (!isRecord(run)) {
    throw new BenchmarkInputError(`${path} must contain a JSON object.`)
  }
  if (run.schemaVersion !== 1) {
    issues.push('schemaVersion must be 1')
  }
  if (!nonEmptyString(run.label)) {
    issues.push('label must be a non-empty string')
  }
  if (run.environment !== undefined && !isRecord(run.environment)) {
    issues.push('environment must be an object when supplied')
  }
  if (!Array.isArray(run.cases) || run.cases.length === 0) {
    issues.push('cases must be a non-empty array')
  } else {
    const ids = new Set()
    for (const [index, item] of run.cases.entries()) {
      const prefix = `cases[${index}]`
      if (!isRecord(item)) {
        issues.push(`${prefix} must be an object`)
        continue
      }
      if (!nonEmptyString(item.id)) {
        issues.push(`${prefix}.id must be a non-empty string`)
      } else if (ids.has(item.id)) {
        issues.push(`${prefix}.id duplicates ${JSON.stringify(item.id)}`)
      } else {
        ids.add(item.id)
      }
      const hasResult = nonEmptyString(item.result)
      const hasProject = nonEmptyString(item.project)
      if (hasResult === hasProject) {
        issues.push(`${prefix} must contain exactly one of result or project`)
      }
      if (item.telemetry !== undefined && !nonEmptyString(item.telemetry) && !isRecord(item.telemetry)) {
        issues.push(`${prefix}.telemetry must be a path string or object when supplied`)
      }
      if (item.settings !== undefined && !isRecord(item.settings)) {
        issues.push(`${prefix}.settings must be an object when supplied`)
      }
    }
  }
  if (issues.length) {
    throw new BenchmarkInputError(`${path} is not a valid benchmark run descriptor.`, issues)
  }
}

function validateReferenceDescriptor(reference, prefix, issues) {
  if (!isRecord(reference)) {
    issues.push(`${prefix} must be an object`)
    return
  }
  const fields = ['transcriptFile', 'wordsFile', 'subtitlesFile', 'speechIntervalsFile']
  for (const field of fields) {
    if (reference[field] !== undefined && !nonEmptyString(reference[field])) {
      issues.push(`${prefix}.${field} must be a non-empty path string`)
    }
  }
  if (!fields.some((field) => nonEmptyString(reference[field]))) {
    issues.push(`${prefix} must contain at least one reference file`)
  }
}

function validateNormalization(normalization, prefix, issues) {
  if (normalization === undefined) {
    return
  }
  if (!isRecord(normalization)) {
    issues.push(`${prefix} must be an object`)
    return
  }
  if (
    normalization.unicodeForm !== undefined
    && !['NFC', 'NFD', 'NFKC', 'NFKD'].includes(normalization.unicodeForm)
  ) {
    issues.push(`${prefix}.unicodeForm must be NFC, NFD, NFKC, or NFKD`)
  }
  for (const field of ['lowercase', 'stripPunctuation', 'collapseWhitespace', 'cerIgnoreWhitespace']) {
    if (normalization[field] !== undefined && typeof normalization[field] !== 'boolean') {
      issues.push(`${prefix}.${field} must be boolean`)
    }
  }
}

function validateConstraints(constraints, prefix, issues) {
  if (constraints === undefined) {
    return
  }
  if (!isRecord(constraints)) {
    issues.push(`${prefix} must be an object`)
    return
  }
  for (const field of ['maxCps', 'maxLineLength', 'maximumLines']) {
    if (constraints[field] !== undefined && !positiveNumber(constraints[field])) {
      issues.push(`${prefix}.${field} must be a positive finite number`)
    }
  }
  if (
    constraints.minimumSpeechOverlapRatio !== undefined
    && (!finiteNumber(constraints.minimumSpeechOverlapRatio)
      || constraints.minimumSpeechOverlapRatio < 0
      || constraints.minimumSpeechOverlapRatio > 1)
  ) {
    issues.push(`${prefix}.minimumSpeechOverlapRatio must be between 0 and 1`)
  }
}

async function inspectMedia(manifestCase, directory, allowMissing) {
  const mediaPath = resolvePath(directory, manifestCase.media)
  let mediaStat
  try {
    mediaStat = await stat(mediaPath)
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') {
      return { fileName: basename(mediaPath), missing: true, sizeBytes: null, sha256: null }
    }
    throw new BenchmarkInputError(`Could not read benchmark media for case ${manifestCase.id}: ${mediaPath}`)
  }
  if (!mediaStat.isFile()) {
    throw new BenchmarkInputError(`Benchmark media for case ${manifestCase.id} is not a file: ${mediaPath}`)
  }
  const sha256 = await sha256File(mediaPath)
  if (manifestCase.mediaSha256 && sha256 !== manifestCase.mediaSha256.toLowerCase()) {
    throw new BenchmarkInputError(
      `Media SHA-256 mismatch for case ${manifestCase.id}. Expected ${manifestCase.mediaSha256}, received ${sha256}.`,
    )
  }
  return { fileName: basename(mediaPath), missing: false, sizeBytes: mediaStat.size, sha256 }
}

async function loadReference(descriptor, directory) {
  const transcript = descriptor.transcriptFile
    ? (await readFile(resolvePath(directory, descriptor.transcriptFile), 'utf8')).trim()
    : undefined
  const words = descriptor.wordsFile
    ? extractArray(await readJson(resolvePath(directory, descriptor.wordsFile)), 'words', descriptor.wordsFile)
    : undefined
  const subtitles = descriptor.subtitlesFile
    ? await readSubtitles(resolvePath(directory, descriptor.subtitlesFile))
    : undefined
  const speechIntervals = descriptor.speechIntervalsFile
    ? extractArray(
        await readJson(resolvePath(directory, descriptor.speechIntervalsFile)),
        'intervals',
        descriptor.speechIntervalsFile,
      )
    : undefined

  validateTimedEntries(words, 'reference words', true)
  validateTimedEntries(subtitles, 'reference subtitles', true)
  validateIntervals(speechIntervals, 'reference speech intervals')
  const derivedTranscript = transcript
    ?? words?.map((word) => word.text).join(' ')
    ?? subtitles?.map((subtitle) => subtitle.text).join(' ')
    ?? ''
  return {
    transcript: derivedTranscript,
    words,
    subtitles,
    speechIntervals,
  }
}

async function loadCandidate(descriptor, directory) {
  let candidate
  if (descriptor.result) {
    candidate = await readJson(resolvePath(directory, descriptor.result))
    validateCaseResult(candidate, descriptor.result)
  } else {
    const project = await readJson(resolvePath(directory, descriptor.project))
    validateProject(project, descriptor.project)
    candidate = {
      schemaVersion: 1,
      caseId: descriptor.id,
      transcript: project.subtitles.map((subtitle) => subtitle.text).join(' ').replace(/\s+/gu, ' ').trim(),
      subtitles: project.subtitles,
      metadata: {
        source: 'auto-subtitle-project',
        settings: project.transcriptionSettings,
      },
    }
  }

  if (descriptor.telemetry !== undefined) {
    candidate.telemetry = typeof descriptor.telemetry === 'string'
      ? await readJson(resolvePath(directory, descriptor.telemetry))
      : descriptor.telemetry
  }
  validateTelemetry(candidate.telemetry, `${descriptor.id}.telemetry`)
  return candidate
}

function validateCaseResult(result, path) {
  const issues = []
  if (!isRecord(result)) {
    throw new BenchmarkInputError(`${path} must contain a JSON object.`)
  }
  if (result.schemaVersion !== 1) {
    issues.push('schemaVersion must be 1')
  }
  if (!nonEmptyString(result.caseId)) {
    issues.push('caseId must be a non-empty string')
  }
  if (result.transcript !== undefined && typeof result.transcript !== 'string') {
    issues.push('transcript must be a string when supplied')
  }
  if (result.subtitles !== undefined && !Array.isArray(result.subtitles)) {
    issues.push('subtitles must be an array when supplied')
  }
  if (result.words !== undefined && !Array.isArray(result.words)) {
    issues.push('words must be an array when supplied')
  }
  if (typeof result.transcript !== 'string' && !Array.isArray(result.subtitles) && !Array.isArray(result.words)) {
    issues.push('at least one of transcript, subtitles, or words must be supplied')
  }
  if (issues.length) {
    throw new BenchmarkInputError(`${path} is not a valid benchmark case result.`, issues)
  }
  validateTimedEntries(result.subtitles, `${path} subtitles`, false)
  validateTimedEntries(result.words, `${path} words`, false)
  validateTelemetry(result.telemetry, `${path} telemetry`)
}

function validateProject(project, path) {
  if (!isRecord(project) || !isRecord(project.metadata) || project.metadata.schemaVersion !== 1) {
    throw new BenchmarkInputError(`${path} is not an Auto Subtitle schema-v1 project.`)
  }
  if (!Array.isArray(project.subtitles)) {
    throw new BenchmarkInputError(`${path} project subtitles must be an array.`)
  }
  validateTimedEntries(project.subtitles, `${path} project subtitles`, false)
}

function validateTimedEntries(entries, label, requireValidInterval) {
  if (entries === undefined) {
    return
  }
  const issues = []
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      issues.push(`${label}[${index}] must be an object`)
      continue
    }
    if (typeof entry.text !== 'string') {
      issues.push(`${label}[${index}].text must be a string`)
    }
    if (!finiteNumber(entry.startTime) || !finiteNumber(entry.endTime)) {
      issues.push(`${label}[${index}] must have finite numeric startTime and endTime`)
    } else if (requireValidInterval && (entry.startTime < 0 || entry.endTime <= entry.startTime)) {
      issues.push(`${label}[${index}] must have 0 <= startTime < endTime`)
    }
    if (entry.words !== undefined) {
      if (!Array.isArray(entry.words)) {
        issues.push(`${label}[${index}].words must be an array`)
      } else {
        try {
          validateTimedEntries(entry.words, `${label}[${index}].words`, requireValidInterval)
        } catch (error) {
          issues.push(...(error.issues ?? [error.message]))
        }
      }
    }
  }
  if (issues.length) {
    throw new BenchmarkInputError(`${label} failed schema validation.`, issues)
  }
}

function validateIntervals(intervals, label) {
  if (intervals === undefined) {
    return
  }
  const issues = []
  for (const [index, interval] of intervals.entries()) {
    if (
      !isRecord(interval)
      || !finiteNumber(interval.startTime)
      || !finiteNumber(interval.endTime)
      || interval.startTime < 0
      || interval.endTime <= interval.startTime
    ) {
      issues.push(`${label}[${index}] must have 0 <= startTime < endTime`)
    }
  }
  if (issues.length) {
    throw new BenchmarkInputError(`${label} failed schema validation.`, issues)
  }
}

function validateTelemetry(telemetry, label) {
  if (telemetry === undefined) {
    return
  }
  const issues = []
  if (!isRecord(telemetry)) {
    throw new BenchmarkInputError(`${label} must be an object.`)
  }
  for (const field of ['totalProcessingMs', 'audioDurationSeconds']) {
    if (telemetry[field] !== undefined && !nonNegativeNumber(telemetry[field])) {
      issues.push(`${field} must be a non-negative finite number`)
    }
  }
  if (telemetry.audioDurationSeconds === 0) {
    issues.push('audioDurationSeconds must be greater than zero')
  }
  if (telemetry.modelLoadState !== undefined && !['cold', 'warm', 'unknown'].includes(telemetry.modelLoadState)) {
    issues.push('modelLoadState must be cold, warm, or unknown')
  }
  if (telemetry.stageDurationsMs !== undefined) {
    if (!isRecord(telemetry.stageDurationsMs)) {
      issues.push('stageDurationsMs must be an object')
    } else {
      for (const [stage, duration] of Object.entries(telemetry.stageDurationsMs)) {
        if (!nonNegativeNumber(duration)) {
          issues.push(`stageDurationsMs.${stage} must be a non-negative finite number`)
        }
      }
    }
  }
  if (telemetry.memory !== undefined) {
    if (!isRecord(telemetry.memory)) {
      issues.push('memory must be an object')
    } else {
      if (!nonNegativeNumber(telemetry.memory.peakBytes)) {
        issues.push('memory.peakBytes must be a non-negative finite number')
      }
      if (!nonEmptyString(telemetry.memory.method)) {
        issues.push('memory.method must be a non-empty string')
      }
      if (telemetry.memory.approximate !== undefined && typeof telemetry.memory.approximate !== 'boolean') {
        issues.push('memory.approximate must be boolean')
      }
    }
  }
  if (telemetry.workerMessages !== undefined) {
    if (!isRecord(telemetry.workerMessages)) {
      issues.push('workerMessages must be an object')
    } else {
      if (!nonNegativeInteger(telemetry.workerMessages.count)) {
        issues.push('workerMessages.count must be a non-negative integer')
      }
      if (!nonNegativeNumber(telemetry.workerMessages.totalBytes)) {
        issues.push('workerMessages.totalBytes must be a non-negative finite number')
      }
      if (telemetry.workerMessages.sizeMethod !== undefined && !nonEmptyString(telemetry.workerMessages.sizeMethod)) {
        issues.push('workerMessages.sizeMethod must be a non-empty string')
      }
      if (telemetry.workerMessages.byType !== undefined) {
        if (!isRecord(telemetry.workerMessages.byType)) {
          issues.push('workerMessages.byType must be an object')
        } else {
          for (const [type, value] of Object.entries(telemetry.workerMessages.byType)) {
            if (
              !isRecord(value)
              || !nonNegativeInteger(value.count)
              || !nonNegativeNumber(value.bytes)
            ) {
              issues.push(`workerMessages.byType.${type} must contain non-negative count and bytes`)
            }
          }
        }
      }
    }
  }
  if (issues.length) {
    throw new BenchmarkInputError(`${label} failed schema validation.`, issues)
  }
}

async function readSubtitles(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.json') {
    const value = await readJson(path)
    const subtitles = Array.isArray(value) ? value : value.subtitles
    if (!Array.isArray(subtitles)) {
      throw new BenchmarkInputError(`${path} must contain an array or an object with a subtitles array.`)
    }
    return subtitles
  }
  const content = await readFile(path, 'utf8')
  if (extension === '.srt' || extension === '.vtt') {
    return parseTimedText(content, extension)
  }
  throw new BenchmarkInputError(`${path} must use .srt, .vtt, or .json for reference subtitles.`)
}

function parseTimedText(content, extension) {
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim()
  const body = extension === '.vtt' ? normalized.replace(/^WEBVTT[^\n]*(?:\n|$)/u, '') : normalized
  const blocks = body.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean)
  const subtitles = []
  for (const block of blocks) {
    if (block.startsWith('NOTE')) {
      continue
    }
    const lines = block.split('\n')
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0) {
      continue
    }
    const [startValue, endValue] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/u)[0])
    const startTime = parseTimestamp(startValue)
    const endTime = parseTimestamp(endValue)
    if (startTime === null || endTime === null) {
      throw new BenchmarkInputError(`Invalid subtitle timestamp line: ${lines[timingIndex]}`)
    }
    subtitles.push({
      startTime,
      endTime,
      text: lines.slice(timingIndex + 1).join('\n').trim(),
    })
  }
  return subtitles
}

function parseTimestamp(value) {
  if (!value) {
    return null
  }
  const parts = value.replace(',', '.').split(':')
  if (parts.some((part) => !/^\d+(?:\.\d+)?$/u.test(part))) {
    return null
  }
  const numbers = parts.map(Number)
  if (numbers.some((part) => !Number.isFinite(part))) {
    return null
  }
  if (numbers.length === 3) {
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
  }
  if (numbers.length === 2) {
    return numbers[0] * 60 + numbers[1]
  }
  return numbers.length === 1 ? numbers[0] : null
}

function extractArray(value, field, path) {
  const result = Array.isArray(value) ? value : value?.[field]
  if (!Array.isArray(result)) {
    throw new BenchmarkInputError(`${path} must contain an array or an object with a ${field} array.`)
  }
  return result
}

async function readJson(path) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new BenchmarkInputError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(content)
  } catch (error) {
    throw new BenchmarkInputError(`Could not parse JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedNormalization(value = {}) {
  return {
    unicodeForm: value.unicodeForm ?? 'NFKC',
    lowercase: value.lowercase ?? true,
    stripPunctuation: value.stripPunctuation ?? true,
    collapseWhitespace: value.collapseWhitespace ?? true,
    cerIgnoreWhitespace: value.cerIgnoreWhitespace ?? true,
  }
}

function normalizedConstraints(value = {}) {
  return {
    maxCps: value.maxCps ?? 21,
    maxLineLength: value.maxLineLength ?? 42,
    maximumLines: value.maximumLines ?? 2,
    minimumSpeechOverlapRatio: value.minimumSpeechOverlapRatio ?? 0.5,
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    )
  }
  return value
}

function resolvePath(directory, path) {
  return isAbsolute(path) ? path : resolve(directory, path)
}

function settingsSnapshotsAgree(descriptorSettings, artifactSettings) {
  if (!isRecord(descriptorSettings) || !isRecord(artifactSettings)) {
    return true
  }

  const comparableArtifact = {
    ...artifactSettings,
    ...(isRecord(artifactSettings.formatting)
      ? { useWordTimestamps: artifactSettings.formatting.useWordTimestamps }
      : {}),
  }
  return isJsonSubset(descriptorSettings, comparableArtifact)
}

function isJsonSubset(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && stableStringify(expected) === stableStringify(actual)
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      return false
    }
    return Object.entries(expected).every(([key, value]) => (
      Object.hasOwn(actual, key) && isJsonSubset(value, actual[key])
    ))
  }
  return Object.is(expected, actual)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveNumber(value) {
  return finiteNumber(value) && value > 0
}

function nonNegativeNumber(value) {
  return finiteNumber(value) && value >= 0
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
