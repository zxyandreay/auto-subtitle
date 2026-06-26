import { AlertTriangle, Cpu, DownloadCloud, Loader2, Square, Wand2 } from 'lucide-react'
import type { BrowserCapabilities } from '../transcription/capabilities'
import type { TranscriptionProgress, TranscriptionSettings } from '../transcription/types'
import { TRANSCRIPTION_MODELS } from '../transcription/types'

type TranscriptionPanelProps = {
  settings: TranscriptionSettings
  capabilities: BrowserCapabilities
  capabilityWarnings: string[]
  progress: TranscriptionProgress
  busy: boolean
  hasVideo: boolean
  onSettingsChange: (settings: TranscriptionSettings) => void
  onStart: () => void
  onCancel: () => void
}

const LANGUAGES = [
  ['auto', 'Auto detect'],
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
  hasVideo,
  onSettingsChange,
  onStart,
  onCancel,
}: TranscriptionPanelProps) {
  const selectedModel = TRANSCRIPTION_MODELS.find((model) => model.id === settings.modelId) ?? TRANSCRIPTION_MODELS[0]
  const cannotRun = !capabilities.webAssembly || !capabilities.webWorkers

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
            {TRANSCRIPTION_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
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
            <option value="wasm">WASM</option>
            <option value="cpu">CPU</option>
          </select>
        </label>

        <label>
          Chunk length
          <input
            min={15}
            max={60}
            step={5}
            type="number"
            value={settings.chunkLengthSeconds}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                chunkLengthSeconds: Number(event.target.value),
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
              })
            }
          />
        </label>
      </div>

      <div className="model-note">
        <DownloadCloud size={16} />
        <span>
          {selectedModel.description} Expect {selectedModel.estimatedSize}; browser cache is used when supported.
        </span>
      </div>

      {capabilityWarnings.length ? (
        <div className="capability-list">
          {capabilityWarnings.map((warning) => (
            <p className="notice notice--warning" key={warning}>
              <AlertTriangle size={15} />
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <div className="progress-card" aria-live="polite" role="status">
        <div>
          <strong>{stageLabel(progress.stage)}</strong>
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
          disabled={!hasVideo || busy || cannotRun}
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
    'downloading-model': 'Downloading model',
    'preparing-video': 'Preparing video',
    'extracting-audio': 'Extracting audio',
    transcribing: 'Transcribing',
    'formatting-subtitles': 'Formatting subtitles',
    complete: 'Complete',
    cancelled: 'Cancelled',
    failed: 'Failed',
  }

  return labels[stage]
}
