import { AlertTriangle, Cpu, DownloadCloud, Loader2, Square, Wand2 } from 'lucide-react'
import type { BrowserCapabilities } from '../transcription/capabilities'
import {
  getSpeechModelOption,
  getSpeechModelWarnings,
  isModelCompatibleWithSettings,
  SPEECH_MODELS,
} from '../transcription/models'
import type { TranscriptionProgress, TranscriptionSettings } from '../transcription/types'

type TranscriptionPanelProps = {
  settings: TranscriptionSettings
  capabilities: BrowserCapabilities
  capabilityWarnings: string[]
  progress: TranscriptionProgress
  busy: boolean
  locked?: boolean
  hasVideo: boolean
  onSettingsChange: (settings: TranscriptionSettings) => void
  onStart: () => void
  onCancel: () => void
}

const LANGUAGES = [
  ['auto', 'Auto (English fallback)'],
  ['english', 'English'],
  ['spanish', 'Spanish'],
  ['french', 'French'],
  ['german', 'German'],
  ['japanese', 'Japanese'],
  ['korean', 'Korean'],
  ['chinese', 'Chinese'],
]

export function TranscriptionPanel({
  settings,
  capabilities,
  capabilityWarnings,
  progress,
  busy,
  locked = false,
  hasVideo,
  onSettingsChange,
  onStart,
  onCancel,
}: TranscriptionPanelProps) {
  const selectedModel = getSpeechModelOption(settings.modelId)
  const cannotRun = !capabilities.webAssembly || !capabilities.webWorkers
  const warnings = [
    ...capabilityWarnings,
    ...(settings.language === 'auto'
      ? ['This Transformers.js version cannot detect Whisper language automatically. Auto uses English; choose the spoken language for multilingual audio.']
      : []),
    ...getSpeechModelWarnings(settings, { webGpu: capabilities.webGpu, dtype: settings.dtype }),
  ].filter((warning, index, allWarnings) => allWarnings.indexOf(warning) === index)
  const progressPercent =
    progress.progress === undefined ? null : `${Math.round(Math.max(0, Math.min(1, progress.progress)) * 100)}%`

  return (
    <section className="transcription-panel" aria-label="Transcription settings">
      <div className="panel-heading">
        <div>
          <h2>Local transcription</h2>
          <p>Video and extracted audio stay in this browser. Model files download on first use.</p>
        </div>
        <Cpu aria-hidden="true" size={22} />
      </div>

      <div className="settings-grid">
        <label>
          Spoken language
          <select
            value={settings.language}
            onChange={(event) => onSettingsChange({ ...settings, language: event.target.value })}
          >
            {LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Output
          <select
            value={settings.task}
            onChange={(event) =>
              onSettingsChange({ ...settings, task: event.target.value as TranscriptionSettings['task'] })
            }
          >
            <option value="transcribe">Same language</option>
            <option value="translate">Translate to English</option>
          </select>
        </label>

        <label>
          Model
          <select
            value={settings.modelId}
            onChange={(event) => onSettingsChange({ ...settings, modelId: event.target.value })}
          >
            {SPEECH_MODELS.map((model) => (
              <option
                disabled={!isModelCompatibleWithSettings(model.id, settings)}
                key={model.id}
                value={model.id}
              >
                {`${model.label} - ${model.shortLabel} (${model.languages === 'english-only' ? 'English only' : 'Multilingual'}${model.highResource ? ', high resource' : ''})`}
              </option>
            ))}
          </select>
        </label>

        <label>
          Engine
          <select
            value={settings.executionProvider}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                executionProvider: event.target.value as TranscriptionSettings['executionProvider'],
              })
            }
          >
            <option value="auto">Auto</option>
            <option value="webgpu">WebGPU</option>
            <option value="wasm">WASM (CPU)</option>
          </select>
        </label>

        <label>
          Chunk length
          <input
            min={15}
            max={29}
            step={1}
            type="number"
            value={settings.chunkLengthSeconds}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                chunkLengthSeconds: Math.min(29, Number(event.target.value)),
                maxModelInputSeconds: Math.min(29, Number(event.target.value)),
              })
            }
          />
        </label>

        <label>
          Overlap
          <input
            min={0}
            max={15}
            step={1}
            type="number"
            value={settings.strideLengthSeconds}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                strideLengthSeconds: Number(event.target.value),
                fallbackOverlapSeconds: Number(event.target.value),
              })
            }
          />
        </label>

        <label>
          Precision
          <select
            value={settings.dtype}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                dtype: event.target.value as TranscriptionSettings['dtype'],
              })
            }
          >
            <option value="auto">Auto</option>
            <option value="q8">q8</option>
            <option value="fp32">Full precision</option>
          </select>
        </label>
      </div>

      <div className="model-note">
        <DownloadCloud size={16} />
        <span>
          <strong>{selectedModel.shortLabel}</strong> is {selectedModel.languages === 'english-only' ? 'English only' : 'multilingual'}.
          {' '}
          {selectedModel.description} First use can download model files; later runs use the browser cache when available.
          {selectedModel.warning ? ` ${selectedModel.warning}` : ''}
        </span>
      </div>

      {warnings.length ? (
        <div className="capability-list">
          {warnings.map((warning) => (
            <p className="notice notice--warning" key={warning}>
              <AlertTriangle size={15} />
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div className="progress-card" aria-live="polite" role="status">
        <div>
          <strong className="progress-card__title">
            {stageLabel(progress.stage)}
            {progressPercent ? <span>{progressPercent}</span> : null}
          </strong>
          <span>{progress.message}</span>
        </div>
        {progress.progress !== undefined ? (
          <progress max={1} value={progress.progress} />
        ) : busy ? (
          <div className="indeterminate" aria-hidden="true" />
        ) : null}
      </div>

      <div className="transcription-actions">
        <button
          className="button button--primary"
          disabled={!hasVideo || busy || locked || cannotRun}
          type="button"
          onClick={onStart}
        >
          {busy ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
          Transcribe locally
        </button>
        <button className="button button--ghost" disabled={!busy} type="button" onClick={onCancel}>
          <Square size={15} />
          Cancel
        </button>
      </div>
    </section>
  )
}

function stageLabel(stage: TranscriptionProgress['stage']): string {
  const labels: Record<TranscriptionProgress['stage'], string> = {
    idle: 'Ready',
    'loading-engine': 'Loading transcription engine',
    'downloading-model': 'Loading speech model',
    'preparing-video': 'Preparing video',
    'extracting-audio': 'Extracting audio',
    'analyzing-speech': 'Analyzing speech activity',
    'planning-windows': 'Planning speech-aware windows',
    transcribing: 'Transcribing',
    'checking-coverage': 'Checking subtitle coverage',
    'repairing-coverage': 'Recovering missed speech',
    'refining-timing': 'Refining subtitle timing',
    'formatting-subtitles': 'Formatting subtitles',
    complete: 'Complete',
    cancelled: 'Cancelled',
    failed: 'Failed',
  }

  return labels[stage]
}
