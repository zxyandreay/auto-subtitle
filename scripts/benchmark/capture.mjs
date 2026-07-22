const STAGE_MAPPINGS = {
  'extracting-audio': 'audioExtraction',
  'downloading-model': 'modelLoading',
  'analyzing-speech': 'vadAnalysis',
  'planning-windows': 'windowPlanning',
  transcribing: 'inference',
  'checking-coverage': 'coverageCheck',
  'repairing-coverage': 'coverageRepair',
  'refining-timing': 'timingRefinement',
}

export class BenchmarkCaptureError extends Error {
  constructor(message, issues = []) {
    super(message)
    this.name = 'BenchmarkCaptureError'
    this.issues = issues
  }
}

export function deriveBenchmarkTelemetry(report) {
  validateDiagnosticReport(report)
  const events = report.events
  if (events[0]?.sequence !== 1) {
    throw new BenchmarkCaptureError(
      'The diagnostic log was truncated before capture completed; formatting telemetry would be incomplete.',
    )
  }

  const started = uniqueEvent(events, 'transcription-started', (event) => event.source === 'app')
  const completed = uniqueEvent(events, 'transcription-completed', (event) => event.source === 'app')
  if (completed.sequence <= started.sequence) {
    throw new BenchmarkCaptureError('The completion diagnostic precedes the transcription start diagnostic.')
  }

  const jobEvents = events.filter(
    (event) => event.sequence >= started.sequence && event.sequence <= completed.sequence,
  )
  const performanceEvent = uniqueEvent(
    jobEvents,
    'job-performance',
    (event) => event.source === 'transcription-worker' && dataOf(event).jobKind === 'transcription',
  )
  const messageEvent = uniqueEvent(
    jobEvents,
    'worker-message-metrics',
    (event) => event.source === 'app' && dataOf(event).jobKind === 'transcription',
  )
  const finalFormatting = uniqueEvent(jobEvents, 'formatted-transcription', (event) => event.source === 'app')

  const completedData = dataOf(completed)
  const performanceData = dataOf(performanceEvent)
  const messageData = dataOf(messageEvent)
  if (performanceData.outcome !== 'complete') {
    throw new BenchmarkCaptureError(`Worker job outcome must be complete, received ${String(performanceData.outcome)}.`)
  }

  const telemetry = {
    audioDurationSeconds: requirePositiveNumber(completedData.audioDurationSeconds, 'audioDurationSeconds'),
    totalProcessingMs: requireNonNegativeNumber(completedData.totalDurationMs, 'totalProcessingMs'),
    modelLoadState: requireEnum(performanceData.modelLoad, ['cold', 'warm'], 'modelLoadState'),
    stageDurationsMs: deriveStageDurations(performanceData.stageDurationsMs, jobEvents, finalFormatting),
    memory: deriveMemory(jobEvents),
    workerMessages: deriveWorkerMessages(messageData),
  }

  if (telemetry.memory === undefined) {
    delete telemetry.memory
  }
  validateBenchmarkTelemetry(telemetry)
  return {
    telemetry,
    settings: requireRecord(dataOf(started).settings, 'transcription-started.data.settings'),
    modelId: typeof completedData.modelId === 'string' ? completedData.modelId : undefined,
  }
}

export function validateBenchmarkTelemetry(telemetry) {
  const issues = []
  if (!isRecord(telemetry)) {
    throw new BenchmarkCaptureError('Benchmark telemetry must be an object.')
  }
  if (!positiveNumber(telemetry.audioDurationSeconds)) {
    issues.push('audioDurationSeconds must be a positive finite number')
  }
  if (!nonNegativeNumber(telemetry.totalProcessingMs)) {
    issues.push('totalProcessingMs must be a non-negative finite number')
  }
  if (!['cold', 'warm', 'unknown'].includes(telemetry.modelLoadState)) {
    issues.push('modelLoadState must be cold, warm, or unknown')
  }
  if (!isRecord(telemetry.stageDurationsMs)) {
    issues.push('stageDurationsMs must be an object')
  } else {
    for (const [stage, duration] of Object.entries(telemetry.stageDurationsMs)) {
      if (!nonNegativeNumber(duration)) {
        issues.push(`stageDurationsMs.${stage} must be a non-negative finite number`)
      }
    }
  }
  if (telemetry.memory !== undefined) {
    if (
      !isRecord(telemetry.memory)
      || !nonNegativeNumber(telemetry.memory.peakBytes)
      || !nonEmptyString(telemetry.memory.method)
      || telemetry.memory.approximate !== true
    ) {
      issues.push('memory must contain peakBytes, method, and approximate: true')
    }
  }
  validateWorkerMessages(telemetry.workerMessages, issues)
  if (issues.length) {
    throw new BenchmarkCaptureError('Derived benchmark telemetry failed validation.', issues)
  }
  return telemetry
}

export function validateCapturedProject(project) {
  const issues = []
  if (!isRecord(project)) {
    throw new BenchmarkCaptureError('The downloaded project must contain a JSON object.')
  }
  if (!isRecord(project.metadata) || project.metadata.schemaVersion !== 1) {
    issues.push('metadata.schemaVersion must be 1')
  }
  if (!Array.isArray(project.subtitles)) {
    issues.push('subtitles must be an array')
  } else {
    for (const [index, entry] of project.subtitles.entries()) {
      if (
        !isRecord(entry)
        || typeof entry.text !== 'string'
        || !finiteNumber(entry.startTime)
        || !finiteNumber(entry.endTime)
      ) {
        issues.push(`subtitles[${index}] must contain text and finite startTime/endTime values`)
      }
    }
  }
  if (!isRecord(project.transcriptionSettings)) {
    issues.push('transcriptionSettings must be present in the project export')
  }
  if (issues.length) {
    throw new BenchmarkCaptureError('The downloaded project failed capture validation.', issues)
  }
  return project
}

export function assertCapturedSettings(project, diagnosticSettings) {
  const projectSettings = requireRecord(project.transcriptionSettings, 'project.transcriptionSettings')
  if (stableStringify(projectSettings) !== stableStringify(diagnosticSettings)) {
    throw new BenchmarkCaptureError(
      'The project settings do not match the immutable settings recorded when transcription started.',
    )
  }
  return projectSettings
}

export function buildLocalRunDescriptor({
  caseId,
  projectFile,
  telemetryFile,
  settings,
  diagnosticEnvironment,
  browserChannel,
  browserVersion,
  appUrl,
}) {
  return {
    schemaVersion: 1,
    label: caseId,
    notes: `Captured from ${appUrl} with the optional Playwright browser runner. Model cache state comes from measured diagnostics.`,
    environment: {
      browserChannel,
      browserVersion,
      platform: process.platform,
      architecture: process.arch,
      userAgent: diagnosticEnvironment?.userAgent,
      language: diagnosticEnvironment?.language,
      hardwareConcurrency: diagnosticEnvironment?.hardwareConcurrency,
      crossOriginIsolated: diagnosticEnvironment?.crossOriginIsolated,
    },
    cases: [{
      id: caseId,
      project: `./${projectFile}`,
      telemetry: `./${telemetryFile}`,
      settings,
    }],
  }
}

function validateDiagnosticReport(report) {
  const issues = []
  if (!isRecord(report) || report.schemaVersion !== 1) {
    issues.push('schemaVersion must be 1')
  }
  if (!Array.isArray(report?.events) || report.events.length === 0) {
    issues.push('events must be a non-empty array')
  } else {
    let previousSequence = 0
    for (const [index, event] of report.events.entries()) {
      if (
        !isRecord(event)
        || !Number.isInteger(event.sequence)
        || event.sequence <= previousSequence
        || !nonEmptyString(event.category)
        || !nonEmptyString(event.source)
      ) {
        issues.push(`events[${index}] must have an increasing integer sequence, source, and category`)
        continue
      }
      previousSequence = event.sequence
    }
  }
  if (issues.length) {
    throw new BenchmarkCaptureError('The downloaded diagnostic report failed validation.', issues)
  }
}

function deriveStageDurations(rawDurations, jobEvents, finalFormatting) {
  const raw = requireRecord(rawDurations, 'job-performance.data.stageDurationsMs')
  const output = {}
  for (const [source, destination] of Object.entries(STAGE_MAPPINGS)) {
    if (raw[source] !== undefined) {
      output[destination] = requireNonNegativeNumber(raw[source], `stageDurationsMs.${source}`)
    }
  }
  const formattingEvents = jobEvents.filter(
    (event) => event.category === 'formatted-transcription-preview' || event === finalFormatting,
  )
  output.formatting = formattingEvents.reduce(
    (total, event) => total + requireNonNegativeNumber(dataOf(event).formattingDurationMs, `${event.category}.formattingDurationMs`),
    0,
  )
  return output
}

function deriveMemory(events) {
  const samples = events
    .map((event) => dataOf(event).approximateJsHeapBytes)
    .filter(nonNegativeNumber)
  if (!samples.length) {
    return undefined
  }
  return {
    peakBytes: Math.max(...samples),
    method: 'performance.memory.usedJSHeapSize-sampled',
    approximate: true,
  }
}

function deriveWorkerMessages(data) {
  const counts = requireRecord(data.messageCountsByType, 'worker-message-metrics.data.messageCountsByType')
  const bytes = requireRecord(
    data.approximateJsonBytesByType,
    'worker-message-metrics.data.approximateJsonBytesByType',
  )
  const types = new Set([...Object.keys(counts), ...Object.keys(bytes)])
  const byType = {}
  for (const type of types) {
    byType[type] = {
      count: requireNonNegativeInteger(counts[type], `workerMessages.byType.${type}.count`),
      bytes: requireNonNegativeNumber(bytes[type], `workerMessages.byType.${type}.bytes`),
    }
  }
  return {
    count: requireNonNegativeInteger(data.messageCount, 'workerMessages.count'),
    totalBytes: requireNonNegativeNumber(data.approximateJsonBytes, 'workerMessages.totalBytes'),
    sizeMethod: 'json-utf8-approximation',
    byType,
  }
}

function validateWorkerMessages(messages, issues) {
  if (
    !isRecord(messages)
    || !nonNegativeInteger(messages.count)
    || !nonNegativeNumber(messages.totalBytes)
    || !nonEmptyString(messages.sizeMethod)
    || !isRecord(messages.byType)
  ) {
    issues.push('workerMessages must contain count, totalBytes, sizeMethod, and byType')
    return
  }
  let byTypeCount = 0
  let byTypeBytes = 0
  let byTypeValuesValid = true
  for (const [type, value] of Object.entries(messages.byType)) {
    if (!isRecord(value) || !nonNegativeInteger(value.count) || !nonNegativeNumber(value.bytes)) {
      issues.push(`workerMessages.byType.${type} must contain non-negative count and bytes`)
      byTypeValuesValid = false
    } else {
      byTypeCount += value.count
      byTypeBytes += value.bytes
    }
  }
  if (byTypeValuesValid && byTypeCount !== messages.count) {
    issues.push('workerMessages.byType counts must sum to workerMessages.count')
  }
  if (byTypeValuesValid && byTypeBytes !== messages.totalBytes) {
    issues.push('workerMessages.byType bytes must sum to workerMessages.totalBytes')
  }
}

function uniqueEvent(events, category, predicate) {
  const matches = events.filter((event) => event.category === category && predicate(event))
  if (matches.length !== 1) {
    throw new BenchmarkCaptureError(
      `Expected exactly one ${category} diagnostic for the captured transcription; received ${matches.length}.`,
    )
  }
  return matches[0]
}

function dataOf(event) {
  return isRecord(event?.data) ? event.data : {}
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new BenchmarkCaptureError(`${label} must be an object.`)
  }
  return value
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new BenchmarkCaptureError(`${label} must be one of ${allowed.join(', ')}.`)
  }
  return value
}

function requirePositiveNumber(value, label) {
  if (!positiveNumber(value)) {
    throw new BenchmarkCaptureError(`${label} must be a positive finite number.`)
  }
  return value
}

function requireNonNegativeNumber(value, label) {
  if (!nonNegativeNumber(value)) {
    throw new BenchmarkCaptureError(`${label} must be a non-negative finite number.`)
  }
  return value
}

function requireNonNegativeInteger(value, label) {
  if (!nonNegativeInteger(value)) {
    throw new BenchmarkCaptureError(`${label} must be a non-negative integer.`)
  }
  return value
}

function stableStringify(value) {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    )
  }
  return value
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
