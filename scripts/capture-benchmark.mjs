#!/usr/bin/env node

import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import {
  BenchmarkCaptureError,
  assertCapturedSettings,
  buildLocalRunDescriptor,
  deriveBenchmarkTelemetry,
  validateBenchmarkTelemetry,
  validateCapturedProject,
} from './benchmark/capture.mjs'

const DIAGNOSTIC_STORAGE_KEY = 'auto-subtitle-diagnostics-v1'
const DEFAULT_APP_URL = 'http://127.0.0.1:5173'
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000

const HELP = `Usage:
  npm run benchmark:capture -- --video <path> --out-dir <path> --case-id <id> [options]

Required:
  --video <path>                  Local video read by the app; it is never copied or modified
  --out-dir <path>                Directory for project, diagnostics, telemetry, and run descriptor
  --case-id <id>                  Safe artifact/case id (letters, digits, dot, underscore, hyphen)

Browser and app:
  --app-url <url>                 Running local app URL (default: ${DEFAULT_APP_URL})
  --browser-channel <channel>     Installed browser: chrome or msedge (default: chrome)
  --profile <path>                Dedicated persistent browser profile; keeps model cache warm
  --timeout <milliseconds>        Transcription completion timeout (default: ${DEFAULT_TIMEOUT_MS})
  --overwrite                     Explicitly replace this case's four existing artifacts

Transcription settings:
  --language <value>              auto, english, spanish, french, german, japanese, korean, chinese
  --task <value>                  transcribe or translate
  --model <model-id>              Exact model option value shown by the app
  --provider <value>              auto, webgpu, or wasm
  --dtype <value>                 auto, q8, or fp32
  --chunk-length <seconds>        15..29
  --fallback-overlap <seconds>    0..15

Formatting settings:
  --max-chars-per-line <number>       24..60
  --max-chars-per-subtitle <number>   36..140
  --min-duration <seconds>            0.4..3
  --max-duration <seconds>            2..12
  --min-gap <seconds>                 0..0.5
  --word-timestamps                   Enable word timestamps
  --no-word-timestamps                Disable word timestamps

Utility:
  --self-test                     Validate deterministic diagnostic-to-telemetry mapping
  --help                          Show this help

The app must already be running. Diagnostics are cleared for this capture without clearing
Cache Storage, IndexedDB, or the persistent profile, so downloaded model data remains cached.
Artifacts are <case-id>.auto-subtitle.json, .diagnostics.json, .telemetry.json, and .run.local.json.
`

main().catch((error) => {
  const issues = Array.isArray(error?.issues) && error.issues.length
    ? `\n${error.issues.map((issue) => `  - ${issue}`).join('\n')}`
    : ''
  console.error(`Benchmark capture failed: ${error instanceof Error ? error.message : String(error)}${issues}`)
  process.exitCode = 1
})

async function main() {
  const values = parseOptions(process.argv.slice(2))
  if (values.help) {
    process.stdout.write(HELP)
    return
  }
  if (values['self-test']) {
    runSelfTest()
    return
  }

  const options = await normalizeOptions(values)
  await preflightArtifacts(options)
  const result = await captureBenchmark(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function parseOptions(args) {
  try {
    return parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        video: { type: 'string' },
        'out-dir': { type: 'string' },
        'case-id': { type: 'string' },
        'app-url': { type: 'string' },
        'browser-channel': { type: 'string' },
        profile: { type: 'string' },
        timeout: { type: 'string' },
        overwrite: { type: 'boolean' },
        language: { type: 'string' },
        task: { type: 'string' },
        model: { type: 'string' },
        provider: { type: 'string' },
        dtype: { type: 'string' },
        'chunk-length': { type: 'string' },
        'fallback-overlap': { type: 'string' },
        'max-chars-per-line': { type: 'string' },
        'max-chars-per-subtitle': { type: 'string' },
        'min-duration': { type: 'string' },
        'max-duration': { type: 'string' },
        'min-gap': { type: 'string' },
        'word-timestamps': { type: 'boolean' },
        'no-word-timestamps': { type: 'boolean' },
        'self-test': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch (error) {
    throw new BenchmarkCaptureError(`${error.message}\n\n${HELP}`)
  }
}

async function normalizeOptions(values) {
  for (const name of ['video', 'out-dir', 'case-id']) {
    if (!nonEmptyString(values[name])) {
      throw new BenchmarkCaptureError(`--${name} is required.\n\n${HELP}`)
    }
  }
  const caseId = values['case-id']
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(caseId)
    || caseId.endsWith('.')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(caseId)
  ) {
    throw new BenchmarkCaptureError(
      '--case-id must be 1-100 safe filename characters, must not end in a dot, and must not use a reserved Windows device name.',
    )
  }

  const video = resolve(values.video)
  const videoStat = await stat(video).catch(() => null)
  if (!videoStat?.isFile()) {
    throw new BenchmarkCaptureError(`--video must point to an existing file: ${video}`)
  }
  const outDir = resolve(values['out-dir'])
  const browserChannel = values['browser-channel'] === 'edge' ? 'msedge' : (values['browser-channel'] ?? 'chrome')
  requireChoice(browserChannel, ['chrome', 'msedge'], '--browser-channel')
  const profile = resolve(values.profile ?? `.cache/auto-subtitle-browser-profile-${browserChannel}`)
  if (sameOrInside(profile, outDir)) {
    throw new BenchmarkCaptureError('--profile must be outside --out-dir so browser cache is not mixed with run artifacts.')
  }

  const appUrl = validateLocalAppUrl(values['app-url'] ?? DEFAULT_APP_URL)
  if (values['word-timestamps'] && values['no-word-timestamps']) {
    throw new BenchmarkCaptureError('Use only one of --word-timestamps or --no-word-timestamps.')
  }

  const settings = {
    language: optionalChoice(values.language, ['auto', 'english', 'spanish', 'french', 'german', 'japanese', 'korean', 'chinese'], '--language'),
    task: optionalChoice(values.task, ['transcribe', 'translate'], '--task'),
    model: values.model,
    provider: optionalChoice(values.provider, ['auto', 'webgpu', 'wasm'], '--provider'),
    dtype: optionalChoice(values.dtype, ['auto', 'q8', 'fp32'], '--dtype'),
    chunkLength: optionalNumber(values['chunk-length'], 15, 29, '--chunk-length'),
    fallbackOverlap: optionalNumber(values['fallback-overlap'], 0, 15, '--fallback-overlap'),
    maxCharsPerLine: optionalNumber(values['max-chars-per-line'], 24, 60, '--max-chars-per-line'),
    maxCharsPerSubtitle: optionalNumber(values['max-chars-per-subtitle'], 36, 140, '--max-chars-per-subtitle'),
    minDuration: optionalNumber(values['min-duration'], 0.4, 3, '--min-duration'),
    maxDuration: optionalNumber(values['max-duration'], 2, 12, '--max-duration'),
    minGap: optionalNumber(values['min-gap'], 0, 0.5, '--min-gap'),
    wordTimestamps: values['word-timestamps'] ? true : values['no-word-timestamps'] ? false : undefined,
  }
  if (
    settings.minDuration !== undefined
    && settings.maxDuration !== undefined
    && settings.minDuration > settings.maxDuration
  ) {
    throw new BenchmarkCaptureError('--min-duration cannot exceed --max-duration.')
  }

  const timeoutMs = optionalNumber(values.timeout, 1_000, 24 * 60 * 60 * 1_000, '--timeout') ?? DEFAULT_TIMEOUT_MS
  return {
    video,
    outDir,
    caseId,
    appUrl,
    browserChannel,
    profile,
    timeoutMs,
    overwrite: values.overwrite === true,
    settings,
    artifacts: artifactPlan(outDir, caseId),
  }
}

async function preflightArtifacts(options) {
  const existing = []
  for (const target of Object.values(options.artifacts)) {
    const targetStat = await lstat(target).catch(() => null)
    if (targetStat?.isDirectory()) {
      throw new BenchmarkCaptureError(`Artifact target is a directory and cannot be replaced: ${target}`)
    }
    if (targetStat) {
      existing.push(target)
    }
  }
  if (existing.length && !options.overwrite) {
    throw new BenchmarkCaptureError(
      'Capture artifacts already exist. No browser was opened and nothing was overwritten; pass --overwrite to replace them.',
      existing,
    )
  }
}

async function captureBenchmark(options) {
  await mkdir(options.outDir, { recursive: true })
  await mkdir(options.profile, { recursive: true })
  const temporary = temporaryPlan(options)
  let context
  try {
    const { chromium } = await import('playwright')
    context = await chromium.launchPersistentContext(options.profile, {
      acceptDownloads: true,
      channel: options.browserChannel,
      headless: false,
    })
    await context.addInitScript(
      ({ marker, storageKey }) => {
        try {
          if (sessionStorage.getItem(marker) !== 'cleared') {
            localStorage.removeItem(storageKey)
            sessionStorage.setItem(marker, 'cleared')
          }
        } catch {
          // The app handles unavailable storage; capture validation will reject stale/missing diagnostics.
        }
      },
      { marker: `auto-subtitle-capture-${process.pid}-${Date.now()}`, storageKey: DIAGNOSTIC_STORAGE_KEY },
    )

    const page = context.pages()[0] ?? await context.newPage()
    page.setDefaultTimeout(Math.min(options.timeoutMs, 30_000))
    const browserErrors = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        browserErrors.push(message.text())
      }
    })

    await page.goto(options.appUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(options.timeoutMs, 30_000) })
    await page.getByRole('heading', { name: 'Auto Subtitle', exact: true }).waitFor()
    await page.locator('input[type="file"][accept*="video"]').setInputFiles(options.video)
    await page.getByRole('heading', { name: 'Video ready', exact: true }).waitFor()
    await page.waitForFunction(() => {
      const video = document.querySelector('video')
      const durationRow = [...document.querySelectorAll('.file-facts > div')]
        .find((row) => row.querySelector('dt')?.textContent?.trim() === 'Duration')
      const renderedDuration = durationRow?.querySelector('dd')?.textContent?.trim()
      return (
        video instanceof HTMLVideoElement
        && Number.isFinite(video.duration)
        && video.duration > 0
        && Boolean(renderedDuration)
        && renderedDuration !== 'Waiting for metadata'
      )
    })

    await applySettings(page, options.settings)
    await page.getByRole('button', { name: 'Transcribe locally', exact: true }).click()
    const terminalStage = await page.waitForFunction(
      () => {
        const label = document.querySelector('.progress-card__title')?.textContent?.trim() ?? ''
        if (label.startsWith('Complete')) return 'complete'
        if (label.startsWith('Failed')) return 'failed'
        if (label.startsWith('Cancelled')) return 'cancelled'
        return null
      },
      undefined,
      { timeout: options.timeoutMs },
    ).then((handle) => handle.jsonValue())
    if (terminalStage !== 'complete') {
      const status = await page.locator('.progress-card').textContent()
      throw new BenchmarkCaptureError(`The app ended in ${terminalStage} state: ${status?.replace(/\s+/gu, ' ').trim()}`)
    }

    await captureDownload(page, page.getByRole('button', { name: 'JSON', exact: true }), temporary.project)
    await captureDownload(page, page.getByRole('button', { name: 'Export debug log', exact: true }), temporary.diagnostics)

    const project = validateCapturedProject(await readJson(temporary.project, 'project export'))
    const diagnosticReport = await readJson(temporary.diagnostics, 'diagnostic export')
    const derived = deriveBenchmarkTelemetry(diagnosticReport)
    const settings = assertCapturedSettings(project, derived.settings)
    assertRequestedSettings(settings, options.settings)
    validateBenchmarkTelemetry(derived.telemetry)

    const browserVersion = context.browser()?.version() ?? 'unknown'
    const runDescriptor = buildLocalRunDescriptor({
      caseId: options.caseId,
      projectFile: basename(options.artifacts.project),
      telemetryFile: basename(options.artifacts.telemetry),
      settings,
      diagnosticEnvironment: diagnosticReport.environment,
      browserChannel: options.browserChannel,
      browserVersion,
      appUrl: options.appUrl,
    })
    await writeJson(temporary.telemetry, derived.telemetry)
    await writeJson(temporary.run, runDescriptor)
    await commitArtifacts(temporary, options.artifacts, options.overwrite)

    return {
      status: 'captured',
      caseId: options.caseId,
      browser: { channel: options.browserChannel, version: browserVersion },
      modelLoadState: derived.telemetry.modelLoadState,
      subtitleCount: project.subtitles.length,
      artifacts: Object.fromEntries(
        Object.entries(options.artifacts).map(([key, path]) => [key, relative(process.cwd(), path) || path]),
      ),
      browserErrors: browserErrors.length ? browserErrors : undefined,
    }
  } catch (error) {
    if (isBrowserLaunchError(error)) {
      throw new BenchmarkCaptureError(
        `Could not launch installed ${options.browserChannel}. Install that browser or choose the other channel. ${error.message}`,
      )
    }
    throw error
  } finally {
    await context?.close().catch(() => undefined)
    await Promise.all(Object.values(temporary).map((path) => rm(path, { force: true }).catch(() => undefined)))
  }
}

async function applySettings(page, settings) {
  await selectIfSet(page, 'Spoken language', settings.language)
  await selectIfSet(page, 'Output', settings.task)
  await selectIfSet(page, 'Model', settings.model)
  await selectIfSet(page, 'Engine', settings.provider)
  await selectIfSet(page, 'Precision', settings.dtype)
  await fillIfSet(page, 'Chunk length', settings.chunkLength)
  await fillIfSet(page, 'Fallback overlap', settings.fallbackOverlap)
  await fillIfSet(page, 'Characters per line', settings.maxCharsPerLine)
  await fillIfSet(page, 'Characters per subtitle', settings.maxCharsPerSubtitle)
  await fillIfSet(page, 'Minimum duration', settings.minDuration)
  await fillIfSet(page, 'Maximum duration', settings.maxDuration)
  await fillIfSet(page, 'Minimum gap', settings.minGap)
  if (settings.wordTimestamps !== undefined) {
    const checkbox = wrappedLabelControl(page, 'Use word timestamps', 'input')
    if (settings.wordTimestamps) {
      await checkbox.check()
    } else {
      await checkbox.uncheck()
    }
  }
}

function assertRequestedSettings(actual, requested) {
  const expected = [
    ['language', requested.language, actual.language],
    ['task', requested.task, actual.task],
    ['model', requested.model, actual.modelId],
    ['provider', requested.provider, actual.executionProvider],
    ['dtype', requested.dtype, actual.dtype],
    ['chunk length', requested.chunkLength, actual.chunkLengthSeconds],
    ['fallback overlap', requested.fallbackOverlap, actual.fallbackOverlapSeconds],
    ['characters per line', requested.maxCharsPerLine, actual.formatting?.maxCharsPerLine],
    ['characters per subtitle', requested.maxCharsPerSubtitle, actual.formatting?.maxCharsPerSubtitle],
    ['minimum duration', requested.minDuration, actual.formatting?.minDuration],
    ['maximum duration', requested.maxDuration, actual.formatting?.maxDuration],
    ['minimum gap', requested.minGap, actual.formatting?.gapBetweenSubtitles],
    ['word timestamps', requested.wordTimestamps, actual.formatting?.useWordTimestamps],
  ]
  const mismatches = expected
    .filter(([, requestedValue, actualValue]) => requestedValue !== undefined && !Object.is(requestedValue, actualValue))
    .map(([label, requestedValue, actualValue]) => `${label}: requested ${String(requestedValue)}, captured ${String(actualValue)}`)
  if (mismatches.length) {
    throw new BenchmarkCaptureError('The app did not apply every requested capture setting.', mismatches)
  }
}

async function selectIfSet(page, label, value) {
  if (value !== undefined) {
    await wrappedLabelControl(page, label, 'select').selectOption(value)
  }
}

async function fillIfSet(page, label, value) {
  if (value !== undefined) {
    await wrappedLabelControl(page, label, 'input').fill(String(value))
  }
}

function wrappedLabelControl(page, label, element) {
  return page.locator('label').filter({ hasText: label }).locator(element).first()
}

async function captureDownload(page, button, destination) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    button.click(),
  ])
  await download.saveAs(destination)
  const failure = await download.failure()
  if (failure) {
    throw new BenchmarkCaptureError(`Browser download failed: ${failure}`)
  }
}

async function commitArtifacts(temporary, artifacts, overwrite) {
  for (const key of ['project', 'diagnostics', 'telemetry', 'run']) {
    const target = artifacts[key]
    const existing = await lstat(target).catch(() => null)
    if (existing?.isDirectory()) {
      throw new BenchmarkCaptureError(`Artifact target became a directory during capture: ${target}`)
    }
    if (existing && !overwrite) {
      throw new BenchmarkCaptureError(`Artifact appeared during capture and was not overwritten: ${target}`)
    }
    if (existing) {
      await rm(target, { force: true })
    }
    await rename(temporary[key], target)
  }
}

function artifactPlan(outDir, caseId) {
  return {
    project: resolve(outDir, `${caseId}.auto-subtitle.json`),
    diagnostics: resolve(outDir, `${caseId}.diagnostics.json`),
    telemetry: resolve(outDir, `${caseId}.telemetry.json`),
    run: resolve(outDir, `${caseId}.run.local.json`),
  }
}

function temporaryPlan(options) {
  const nonce = `${process.pid}-${Date.now()}`
  return Object.fromEntries(
    Object.entries(options.artifacts).map(([key]) => [key, resolve(options.outDir, `.${options.caseId}.${nonce}.${key}.tmp`)]),
  )
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new BenchmarkCaptureError(`Could not parse the downloaded ${label}: ${error.message}`)
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}

function validateLocalAppUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new BenchmarkCaptureError(`--app-url must be a valid URL: ${value}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BenchmarkCaptureError('--app-url must use http or https.')
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && !hostname.endsWith('.localhost')) {
    throw new BenchmarkCaptureError('--app-url must be loopback/local so the selected media is never uploaded to a remote site.')
  }
  return url.href.replace(/\/$/u, '')
}

function optionalNumber(value, minimum, maximum, label) {
  if (value === undefined) {
    return undefined
  }
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new BenchmarkCaptureError(`${label} must be a number from ${minimum} to ${maximum}.`)
  }
  return number
}

function optionalChoice(value, choices, label) {
  if (value === undefined) {
    return undefined
  }
  requireChoice(value, choices, label)
  return value
}

function requireChoice(value, choices, label) {
  if (!choices.includes(value)) {
    throw new BenchmarkCaptureError(`${label} must be one of: ${choices.join(', ')}.`)
  }
}

function sameOrInside(candidate, parent) {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function isBrowserLaunchError(error) {
  return error instanceof Error && /executable|browser.*(not found|closed)|launch/i.test(error.message)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function runSelfTest() {
  const report = {
    schemaVersion: 1,
    environment: { userAgent: 'Synthetic Chrome', hardwareConcurrency: 8, crossOriginIsolated: true },
    events: [
      event(1, 'app', 'app-session'),
      event(2, 'app', 'transcription-started', { settings: syntheticSettings() }),
      event(3, 'app', 'formatted-transcription-preview', { formattingDurationMs: 4, approximateJsHeapBytes: 100 }),
      event(4, 'transcription-worker', 'job-performance', {
        jobKind: 'transcription',
        outcome: 'complete',
        modelLoad: 'warm',
        stageDurationsMs: {
          'extracting-audio': 10,
          'downloading-model': 20,
          'analyzing-speech': 30,
          'planning-windows': 40,
          transcribing: 50,
          'checking-coverage': 5,
          'repairing-coverage': 6,
          'refining-timing': 7,
        },
      }),
      event(5, 'app', 'worker-message-metrics', {
        jobKind: 'transcription',
        messageCount: 3,
        approximateJsonBytes: 90,
        messageCountsByType: { progress: 2, complete: 1 },
        approximateJsonBytesByType: { progress: 60, complete: 30 },
      }),
      event(6, 'app', 'formatted-transcription', { formattingDurationMs: 6, approximateJsHeapBytes: 150 }),
      event(7, 'app', 'transcription-completed', {
        totalDurationMs: 1_000,
        audioDurationSeconds: 10,
        modelId: 'synthetic-model',
      }),
      event(8, 'app', 'diagnostic-export'),
    ],
  }
  const derived = deriveBenchmarkTelemetry(report)
  assert.deepEqual(derived.telemetry.stageDurationsMs, {
    audioExtraction: 10,
    modelLoading: 20,
    vadAnalysis: 30,
    windowPlanning: 40,
    inference: 50,
    coverageCheck: 5,
    coverageRepair: 6,
    timingRefinement: 7,
    formatting: 10,
  })
  assert.deepEqual(derived.telemetry.memory, {
    peakBytes: 150,
    method: 'performance.memory.usedJSHeapSize-sampled',
    approximate: true,
  })
  assert.equal(derived.telemetry.workerMessages.byType.complete.bytes, 30)
  assert.equal(derived.telemetry.modelLoadState, 'warm')
  assert.throws(
    () => validateBenchmarkTelemetry({ ...derived.telemetry, totalProcessingMs: -1 }),
    BenchmarkCaptureError,
  )
  assert.throws(
    () => validateBenchmarkTelemetry({
      ...derived.telemetry,
      workerMessages: { ...derived.telemetry.workerMessages, count: 4 },
    }),
    BenchmarkCaptureError,
  )
  assert.throws(
    () => deriveBenchmarkTelemetry({ ...report, events: report.events.slice(1) }),
    BenchmarkCaptureError,
  )

  const project = validateCapturedProject({
    metadata: { schemaVersion: 1 },
    subtitles: [{ text: 'Synthetic', startTime: 0, endTime: 1 }],
    transcriptionSettings: syntheticSettings(),
  })
  assert.deepEqual(assertCapturedSettings(project, derived.settings), syntheticSettings())
  assert.throws(
    () => assertCapturedSettings(project, { ...syntheticSettings(), language: 'japanese' }),
    BenchmarkCaptureError,
  )
  const descriptor = buildLocalRunDescriptor({
    caseId: 'synthetic',
    projectFile: 'synthetic.auto-subtitle.json',
    telemetryFile: 'synthetic.telemetry.json',
    settings: derived.settings,
    diagnosticEnvironment: report.environment,
    browserChannel: 'chrome',
    browserVersion: 'synthetic',
    appUrl: DEFAULT_APP_URL,
  })
  assert.equal(descriptor.cases[0].project, './synthetic.auto-subtitle.json')
  process.stdout.write(`${JSON.stringify({ status: 'passed', checks: 10 }, null, 2)}\n`)
}

function event(sequence, source, category, data) {
  return { sequence, timestamp: new Date(0).toISOString(), sessionId: 'synthetic', source, category, message: category, data }
}

function syntheticSettings() {
  return {
    language: 'english',
    task: 'transcribe',
    modelId: 'synthetic-model',
    executionProvider: 'wasm',
    dtype: 'q8',
    formatting: { useWordTimestamps: true },
  }
}
