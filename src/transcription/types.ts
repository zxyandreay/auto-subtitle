import type { FormattingPreferences } from '../types/subtitles'
import type { RawTranscriptionSegment } from '../subtitles/formatting'

export type TranscriptionStage =
  | 'idle'
  | 'loading-engine'
  | 'downloading-model'
  | 'preparing-video'
  | 'extracting-audio'
  | 'transcribing'
  | 'formatting-subtitles'
  | 'complete'
  | 'cancelled'
  | 'failed'

export type ExecutionProvider = 'auto' | 'webgpu' | 'wasm' | 'cpu'

export type TranscriptionModelOption = {
  id: string
  label: string
  description: string
  estimatedSize: string
}

export const TRANSCRIPTION_MODELS: TranscriptionModelOption[] = [
  {
    id: 'onnx-community/whisper-tiny',
    label: 'Faster model',
    description: 'Small multilingual Whisper model. Lower memory use, faster first pass, less accurate.',
    estimatedSize: 'hundreds of MB on first download',
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'More accurate model',
    description: 'Larger multilingual Whisper model. Better accuracy, higher memory and download cost.',
    estimatedSize: 'larger first download',
  },
]

export type TranscriptionSettings = {
  language: string
  task: 'transcribe' | 'translate'
  modelId: string
  executionProvider: ExecutionProvider
  chunkLengthSeconds: number
  strideLengthSeconds: number
  dtype: 'auto' | 'q8' | 'fp32'
  formatting: FormattingPreferences
}

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  language: 'auto',
  task: 'transcribe',
  modelId: TRANSCRIPTION_MODELS[0].id,
  executionProvider: 'auto',
  chunkLengthSeconds: 30,
  strideLengthSeconds: 5,
  dtype: 'auto',
  formatting: {
    maxCharsPerLine: 42,
    maxCharsPerSubtitle: 84,
    minDuration: 1.1,
    maxDuration: 6,
    gapBetweenSubtitles: 0.04,
    useWordTimestamps: false,
  },
}

export type TranscriptionProgress = {
  stage: TranscriptionStage
  message: string
  progress?: number
  technicalDetails?: string
}

export type TranscriptionResult = {
  segments: RawTranscriptionSegment[]
  text: string
  modelId: string
}

export type WorkerStartRequest = {
  type: 'start'
  file: File
  settings: TranscriptionSettings
}

export type WorkerCancelRequest = {
  type: 'cancel'
}

export type WorkerRequest = WorkerStartRequest | WorkerCancelRequest

export type WorkerProgressEvent = {
  type: 'progress'
  progress: TranscriptionProgress
}

export type WorkerCompleteEvent = {
  type: 'complete'
  result: TranscriptionResult
}

export type WorkerPartialEvent = {
  type: 'partial'
  result: TranscriptionResult
}

export type WorkerErrorEvent = {
  type: 'error'
  error: {
    message: string
    details?: string
  }
}

export type WorkerEvent = WorkerProgressEvent | WorkerPartialEvent | WorkerCompleteEvent | WorkerErrorEvent
