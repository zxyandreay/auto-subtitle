import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import coreUrl from '@ffmpeg/core?url'
import wasmUrl from '@ffmpeg/core/wasm?url'
import type { RawTranscriptionSegment } from '../subtitles/formatting'
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

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data

  if (request.type === 'cancel') {
    cancelled = true
    return
  }

  cancelled = false
  transcribe(request.file, request.settings).catch((error: unknown) => {
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
    const result = await transcribeWithTimestampFallback(transcriber, audio.samples, settings)

    assertNotCancelled()
    postProgress('formatting-subtitles', 'Converting model timestamps into editable subtitle segments.')
    const normalizedResult = Array.isArray(result) ? result[0] : result
    const segments = normalizeAsrChunks(normalizedResult?.chunks, normalizedResult?.text ?? '')

    post({
      type: 'complete',
      result: {
        segments,
        text: typeof normalizedResult?.text === 'string' ? normalizedResult.text.trim() : '',
        modelId: settings.modelId,
      },
    })
  } finally {
    if ('dispose' in transcriber && typeof transcriber.dispose === 'function') {
      await transcriber.dispose()
    }
  }
}

async function transcribeWithTimestampFallback(
  transcriber: BrowserAsrTranscriber,
  samples: Float32Array,
  settings: TranscriptionSettings,
): Promise<unknown> {
  const options = createAsrCallOptions(settings)

  if (options.return_timestamps !== 'word') {
    return transcriber(samples, options)
  }

  try {
    return await transcriber(samples, options)
  } catch (error) {
    if (!isWordTimestampUnsupportedError(error)) {
      throw error
    }

    assertNotCancelled()
    postProgress(
      'transcribing',
      'Word timestamps are not available for this model export. Retrying with segment timestamps.',
    )

    return transcriber(samples, {
      ...options,
      return_timestamps: true,
    })
  }
}

function createAsrCallOptions(settings: TranscriptionSettings): AsrCallOptions {
  return {
    return_timestamps: settings.formatting.useWordTimestamps ? 'word' : true,
    chunk_length_s: settings.chunkLengthSeconds,
    stride_length_s: settings.strideLengthSeconds,
    language: settings.language === 'auto' ? undefined : settings.language,
    task: settings.task,
  }
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
    const exitCode = await ffmpeg.exec([
      '-i',
      inputName,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-acodec',
      'pcm_s16le',
      '-f',
      'wav',
      outputName,
    ])

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

function normalizeAsrChunks(chunks: unknown, fallbackText: string): RawTranscriptionSegment[] {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return fallbackText.trim()
      ? [
          {
            startTime: 0,
            endTime: Math.max(1, fallbackText.length / 14),
            text: fallbackText,
          },
        ]
      : []
  }

  const normalized = chunks
    .map((chunk) => normalizeChunk(chunk))
    .filter((chunk): chunk is RawTranscriptionSegment => chunk !== null)

  const looksWordLevel = normalized.length > 3 && normalized.every((chunk) => chunk.text.split(/\s+/).length <= 2)
  if (!looksWordLevel) {
    return normalized
  }

  return [
    {
      startTime: normalized[0].startTime,
      endTime: normalized.at(-1)!.endTime,
      text: normalized.map((chunk) => chunk.text).join(' '),
      words: normalized.map((chunk) => ({
        text: chunk.text.trim(),
        startTime: chunk.startTime,
        endTime: chunk.endTime,
      })),
    },
  ]
}

function normalizeChunk(chunk: unknown): RawTranscriptionSegment | null {
  if (typeof chunk !== 'object' || chunk === null) {
    return null
  }

  const record = chunk as { timestamp?: unknown; text?: unknown }
  if (!Array.isArray(record.timestamp) || typeof record.text !== 'string') {
    return null
  }

  const start = Number(record.timestamp[0])
  const end = Number(record.timestamp[1])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null
  }

  return {
    startTime: start,
    endTime: end,
    text: record.text.trim(),
  }
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
  post({
    type: 'progress',
    progress: {
      stage,
      message,
      progress,
    },
  })
}

function post(event: WorkerEvent): void {
  self.postMessage(event)
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
