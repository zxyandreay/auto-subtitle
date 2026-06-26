import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import coreUrl from '@ffmpeg/core?url'
import wasmUrl from '@ffmpeg/core/wasm?url'
import type { RawTranscriptionSegment } from '../subtitles/formatting'
import { buildAudioExtractionArgs } from '../transcription/audioExtraction'
import { normalizeAsrResult, type NormalizedAsrResult } from '../transcription/timestampNormalization'
import type { TranscriptionSettings, TranscriptionStage, WorkerEvent, WorkerRequest } from '../transcription/types'

let cancelled = false

type TimestampMode = true | 'word'

type AsrCallOptions = {
  return_timestamps: TimestampMode
  chunk_length_s: number
  stride_length_s: number
  language?: string
  task: TranscriptionSettings['task']
}

type BrowserAsrTranscriber = {
  (audio: Float32Array, options: AsrCallOptions): Promise<unknown>
  dispose?: () => Promise<void> | void
}

type DecodedAudio = {
  samples: Float32Array
  sampleRate: number
}

type TranscriptionWindow = {
  index: number
  total: number
  samples: Float32Array
  sliceStartTime: number
  coreStartTime: number
  coreEndTime: number
}

type TimestampAttempt = {
  result: unknown
  timestampMode: TimestampMode
}

type TerminalLogEvent =
  | {
      type: 'start'
      fileName: string
      modelId: string
    }
  | {
      type: 'progress'
      stage: TranscriptionStage
      message: string
      progress?: number
    }
  | {
      type: 'caption'
      startTime: number
      endTime: number
      text: string
    }
  | {
      type: 'complete'
      segmentCount: number
    }
  | {
      type: 'error'
      message: string
    }

let terminalJobId = ''
let lastOverallProgress = 0

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data

  if (request.type === 'cancel') {
    cancelled = true
    return
  }

  cancelled = false
  terminalJobId = createJobId()
  lastOverallProgress = 0
  transcribe(request.file, request.settings).catch((error: unknown) => {
    postTerminalLog({
      type: 'error',
      message: error instanceof Error ? error.message : 'Transcription failed.',
    })

    if (cancelled) {
      post({
        type: 'error',
        error: { message: 'Transcription cancelled.' },
      })
      return
    }

    post({
      type: 'error',
      error: {
        message: error instanceof Error ? error.message : 'Transcription failed.',
        details: error instanceof Error ? error.stack : undefined,
      },
    })
  })
})

async function transcribe(file: File, settings: TranscriptionSettings): Promise<void> {
  assertNotCancelled()
  postTerminalLog({
    type: 'start',
    fileName: file.name,
    modelId: settings.modelId,
  })
  postProgress('loading-engine', 'Loading FFmpeg.wasm and Transformers.js.')

  const { env, pipeline } = await import('@huggingface/transformers')
  env.allowLocalModels = false
  env.allowRemoteModels = true
  env.useBrowserCache = true

  assertNotCancelled()
  postProgress('preparing-video', 'Preparing the selected video file.')
  const audio = await extractAudio(file)

  if (calculateRms(audio.samples) < 0.0008) {
    throw new Error('The extracted audio appears to be empty or silent.')
  }

  assertNotCancelled()
  postProgress('downloading-model', `Loading ${settings.modelId}. First use may download model files.`)

  const transcriber = (await pipeline('automatic-speech-recognition', settings.modelId, {
    device: settings.executionProvider,
    dtype: settings.dtype === 'auto' ? undefined : settings.dtype,
    progress_callback: (data: unknown) => {
      const progress = getDownloadProgress(data)
      postProgress(
        'downloading-model',
        progress?.message ?? 'Downloading or reading model files from browser cache.',
        progress?.progress,
      )
    },
  })) as BrowserAsrTranscriber

  try {
    assertNotCancelled()
    postProgress('transcribing', 'Transcribing speech locally with Whisper.')
    const result = await transcribeInWindows(transcriber, audio, settings)

    assertNotCancelled()
    postProgress('formatting-subtitles', 'Converting model timestamps into editable subtitle segments.')
    postTerminalLog({
      type: 'complete',
      segmentCount: result.segments.length,
    })

    post({
      type: 'complete',
      result: {
        segments: result.segments,
        text: result.text,
        modelId: settings.modelId,
      },
    })
  } finally {
    if ('dispose' in transcriber && typeof transcriber.dispose === 'function') {
      await transcriber.dispose()
    }
  }
}

async function transcribeInWindows(
  transcriber: BrowserAsrTranscriber,
  audio: DecodedAudio,
  settings: TranscriptionSettings,
): Promise<NormalizedAsrResult> {
  const windows = createTranscriptionWindows(audio, settings)
  const allSegments: RawTranscriptionSegment[] = []
  const textParts: string[] = []
  let timestampMode: TimestampMode = settings.formatting.useWordTimestamps ? 'word' : true

  for (const window of windows) {
    assertNotCancelled()
    postProgress(
      'transcribing',
      `Transcribing chunk ${window.index + 1} of ${window.total}.`,
      window.index / window.total,
    )

    const attempt = await transcribeWindowWithTimestampFallback(transcriber, window.samples, settings, timestampMode)
    timestampMode = attempt.timestampMode

    const normalized = normalizeAsrResult(attempt.result, {
      offsetSeconds: window.sliceStartTime,
      coreStartTime: window.coreStartTime,
      coreEndTime: window.coreEndTime,
    })

    if (normalized.text) {
      textParts.push(normalized.text)
    }

    allSegments.push(...normalized.segments)
    postPartialResult(allSegments, textParts, settings.modelId)
    postCaptionSegments(normalized.segments)
    postProgress(
      'transcribing',
      `Completed chunk ${window.index + 1} of ${window.total}.`,
      (window.index + 1) / window.total,
    )
  }

  return {
    segments: allSegments,
    text: textParts.join(' ').replace(/\s+/g, ' ').trim(),
  }
}

async function transcribeWindowWithTimestampFallback(
  transcriber: BrowserAsrTranscriber,
  samples: Float32Array,
  settings: TranscriptionSettings,
  timestampMode: TimestampMode,
): Promise<TimestampAttempt> {
  const options = createAsrCallOptions(settings, timestampMode)

  try {
    return {
      result: await transcriber(samples, options),
      timestampMode,
    }
  } catch (error) {
    if (timestampMode !== 'word' || !isWordTimestampUnsupportedError(error)) {
      throw error
    }

    assertNotCancelled()
    postProgress(
      'transcribing',
      'Word timestamps are not available for this model export. Retrying with segment timestamps.',
    )

    return {
      result: await transcriber(samples, {
        ...options,
        return_timestamps: true,
      }),
      timestampMode: true,
    }
  }
}

function createAsrCallOptions(settings: TranscriptionSettings, timestampMode: TimestampMode): AsrCallOptions {
  return {
    return_timestamps: timestampMode,
    chunk_length_s: 0,
    stride_length_s: 0,
    language: settings.language === 'auto' ? undefined : settings.language,
    task: settings.task,
  }
}

function createTranscriptionWindows(audio: DecodedAudio, settings: TranscriptionSettings): TranscriptionWindow[] {
  const duration = audio.samples.length / audio.sampleRate
  const coreSeconds = Math.min(30, Math.max(5, settings.chunkLengthSeconds))
  const overlapSeconds = Math.max(0, Math.min(settings.strideLengthSeconds, coreSeconds / 4))
  const windows: TranscriptionWindow[] = []
  let coreStartTime = 0

  while (coreStartTime < duration) {
    const coreEndTime = Math.min(duration, coreStartTime + coreSeconds)
    const sliceStartTime = Math.max(0, coreStartTime - overlapSeconds)
    const sliceEndTime = Math.min(duration, coreEndTime + overlapSeconds)
    const startSample = Math.floor(sliceStartTime * audio.sampleRate)
    const endSample = Math.max(startSample + 1, Math.ceil(sliceEndTime * audio.sampleRate))

    windows.push({
      index: windows.length,
      total: 0,
      samples: audio.samples.subarray(startSample, endSample),
      sliceStartTime,
      coreStartTime,
      coreEndTime,
    })

    coreStartTime = coreEndTime
  }

  return windows.map((window) => ({ ...window, total: windows.length || 1 }))
}

function isWordTimestampUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return (
    message.includes('Model outputs must contain cross attentions to extract timestamps') ||
    message.includes('token-level timestamps not available') ||
    message.includes('output_attentions=True')
  )
}

async function extractAudio(file: File): Promise<{ samples: Float32Array; sampleRate: number }> {
  postProgress('extracting-audio', 'Extracting mono 16 kHz PCM audio locally with FFmpeg.wasm.')

  const ffmpeg = new FFmpeg()
  ffmpeg.on('progress', ({ progress }) => {
    postProgress('extracting-audio', 'Extracting audio locally with FFmpeg.wasm.', clampProgress(progress))
  })

  const inputName = `input-${Date.now()}`
  const outputName = 'audio.wav'

  try {
    await ffmpeg.load({
      coreURL: coreUrl,
      wasmURL: wasmUrl,
    })

    assertNotCancelled()
    await ffmpeg.writeFile(inputName, await fetchFile(file))

    assertNotCancelled()
    const exitCode = await ffmpeg.exec(buildAudioExtractionArgs(inputName, outputName))

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}.`)
    }

    assertNotCancelled()
    const data = await ffmpeg.readFile(outputName)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    return decodePcmWav(bytes)
  } finally {
    try {
      await ffmpeg.deleteFile(inputName)
      await ffmpeg.deleteFile(outputName)
    } catch {
      // Best-effort cleanup only.
    }

    ffmpeg.terminate()
  }
}

function decodePcmWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const riff = readString(view, 0, 4)
  const wave = readString(view, 8, 4)

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('FFmpeg did not produce a valid WAV file.')
  }

  let offset = 12
  let sampleRate = 16000
  let bitsPerSample = 16
  let channels = 1
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= view.byteLength) {
    const chunkId = readString(view, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8

    if (chunkId === 'fmt ') {
      channels = view.getUint16(chunkDataOffset + 2, true)
      sampleRate = view.getUint32(chunkDataOffset + 4, true)
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true)
    }

    if (chunkId === 'data') {
      dataOffset = chunkDataOffset
      dataSize = chunkSize
      break
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2)
  }

  if (dataOffset < 0 || bitsPerSample !== 16 || channels !== 1) {
    throw new Error('Expected mono 16-bit PCM WAV audio.')
  }

  const sampleCount = Math.floor(dataSize / 2)
  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768
  }

  return { samples, sampleRate }
}

function getDownloadProgress(data: unknown): { message: string; progress?: number } | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const record = data as { status?: unknown; file?: unknown; progress?: unknown; loaded?: unknown; total?: unknown }
  const file = typeof record.file === 'string' ? record.file.split('/').at(-1) : undefined
  const status = typeof record.status === 'string' ? record.status : 'model'

  if (typeof record.progress === 'number') {
    return {
      message: `${status}${file ? `: ${file}` : ''}`,
      progress: clampProgress(record.progress / 100),
    }
  }

  if (typeof record.loaded === 'number' && typeof record.total === 'number' && record.total > 0) {
    return {
      message: `${status}${file ? `: ${file}` : ''}`,
      progress: clampProgress(record.loaded / record.total),
    }
  }

  return {
    message: `${status}${file ? `: ${file}` : ''}`,
  }
}

function postCaptionSegments(segments: RawTranscriptionSegment[]): void {
  for (const segment of segments) {
    if (!segment.text.trim()) {
      continue
    }

    postTerminalLog({
      type: 'caption',
      startTime: segment.startTime,
      endTime: segment.endTime,
      text: segment.text,
    })
  }
}

function postPartialResult(segments: RawTranscriptionSegment[], textParts: string[], modelId: string): void {
  post({
    type: 'partial',
    result: {
      segments: [...segments],
      text: textParts.join(' ').replace(/\s+/g, ' ').trim(),
      modelId,
    },
  })
}

function calculateRms(samples: Float32Array): number {
  let sum = 0
  const stride = Math.max(1, Math.floor(samples.length / 500_000))
  let count = 0

  for (let index = 0; index < samples.length; index += stride) {
    sum += samples[index] * samples[index]
    count += 1
  }

  return Math.sqrt(sum / Math.max(1, count))
}

function postProgress(stage: TranscriptionStage, message: string, progress?: number): void {
  const overallProgress = getOverallProgress(stage, progress)
  post({
    type: 'progress',
    progress: {
      stage,
      message,
      progress: overallProgress,
    },
  })
  postTerminalLog({
    type: 'progress',
    stage,
    message,
    progress: overallProgress,
  })
}

function post(event: WorkerEvent): void {
  self.postMessage(event)
}

function postTerminalLog(event: TerminalLogEvent): void {
  if (!import.meta.env.DEV || !terminalJobId) {
    return
  }

  void fetch('/__auto_subtitle_terminal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...event,
      jobId: terminalJobId,
    }),
  }).catch(() => undefined)
}

function getOverallProgress(stage: TranscriptionStage, progress = 0): number {
  const stageProgress = clampProgress(progress)
  const mapped = (() => {
    if (stage === 'loading-engine') {
      return 0.02
    }

    if (stage === 'preparing-video') {
      return 0.06
    }

    if (stage === 'extracting-audio') {
      return 0.08 + stageProgress * 0.22
    }

    if (stage === 'downloading-model') {
      return 0.3 + stageProgress * 0.25
    }

    if (stage === 'transcribing') {
      return 0.55 + stageProgress * 0.4
    }

    if (stage === 'formatting-subtitles') {
      return 0.97
    }

    if (stage === 'complete') {
      return 1
    }

    return lastOverallProgress
  })()

  lastOverallProgress = Math.max(lastOverallProgress, clampProgress(mapped))
  return lastOverallProgress
}

function assertNotCancelled(): void {
  if (cancelled) {
    throw new Error('Transcription cancelled.')
  }
}

function readString(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index))
  }
  return value
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}

function createJobId(): string {
  if ('crypto' in self && 'randomUUID' in self.crypto) {
    return self.crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
