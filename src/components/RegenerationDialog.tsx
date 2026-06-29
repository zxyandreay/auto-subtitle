import { Loader2, Play, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserCapabilities } from '../transcription/capabilities'
import {
  getSpeechModelOption,
  getSpeechModelWarnings,
  isModelCompatibleWithSettings,
  resolveCompatibleModelId,
  SPEECH_MODELS,
} from '../transcription/models'
import { validateRegenerationRange } from '../transcription/regeneration'
import type {
  RegenerationPreferences,
  RegenerationRange,
  TranscriptionProgress,
} from '../transcription/types'
import type { SubtitleEntry } from '../types/subtitles'
import { formatTimestamp, parseTimestamp } from '../utils/time'

export type FormattedRegenerationCandidate = {
  id: string
  entries: SubtitleEntry[]
}

type RegenerationDialogProps = {
  range: RegenerationRange
  videoDuration?: number
  originalEntries: SubtitleEntry[]
  candidates: FormattedRegenerationCandidate[]
  progress: TranscriptionProgress
  busy: boolean
  error: string
  preferences: RegenerationPreferences
  capabilities: BrowserCapabilities
  capabilityWarnings: string[]
  onGenerate: (range: RegenerationRange, preferences: RegenerationPreferences) => void
  onPreview: (entries: SubtitleEntry[], range: RegenerationRange) => void
  onApply: (entries: SubtitleEntry[] | null, range: RegenerationRange) => void
  onPreferencesChange: (preferences: RegenerationPreferences) => void
  onRangeChange: (range: RegenerationRange) => void
  onCancel: () => void
}

const ORIGINAL_OPTION_ID = 'original'
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

export function RegenerationDialog({
  range,
  videoDuration,
  originalEntries,
  candidates,
  progress,
  busy,
  error,
  preferences,
  capabilities,
  capabilityWarnings,
  onGenerate,
  onPreview,
  onApply,
  onPreferencesChange,
  onRangeChange,
  onCancel,
}: RegenerationDialogProps) {
  const [startDraft, setStartDraft] = useState(() => formatTimestamp(range.startTime, { alwaysHours: true }))
  const [endDraft, setEndDraft] = useState(() => formatTimestamp(range.endTime, { alwaysHours: true }))
  const [selectedId, setSelectedId] = useState(ORIGINAL_OPTION_ID)
  const [rangeDirty, setRangeDirty] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [compatibilityNotice, setCompatibilityNotice] = useState('')
  const startRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setStartDraft(formatTimestamp(range.startTime, { alwaysHours: true }))
    setEndDraft(formatTimestamp(range.endTime, { alwaysHours: true }))
    setRangeDirty(false)
    setSelectedId(ORIGINAL_OPTION_ID)
  }, [range.endTime, range.startTime])

  useEffect(() => {
    startRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const parsedRange = useMemo<RegenerationRange | null>(() => {
    const startTime = parseTimestamp(startDraft)
    const endTime = parseTimestamp(endDraft)
    return startTime === null || endTime === null ? null : { startTime, endTime }
  }, [endDraft, startDraft])
  const validationError = parsedRange
    ? validateRegenerationRange(parsedRange, videoDuration)
    : 'Enter valid start and end timestamps.'
  const visibleCandidates = rangeDirty || settingsDirty ? [] : candidates
  const selectedEntries =
    selectedId === ORIGINAL_OPTION_ID
      ? originalEntries
      : visibleCandidates.find((candidate) => candidate.id === selectedId)?.entries

  const markRangeDirty = () => {
    setRangeDirty(true)
    setSelectedId(ORIGINAL_OPTION_ID)
  }

  const updatePreferences = (nextPreferences: RegenerationPreferences) => {
    const resolved = resolveCompatibleModelId(nextPreferences)
    setCompatibilityNotice(resolved.reason ?? '')
    setSettingsDirty(true)
    setSelectedId(ORIGINAL_OPTION_ID)
    onPreferencesChange({ ...nextPreferences, modelId: resolved.modelId })
  }

  const selectedModel = getSpeechModelOption(preferences.modelId)
  const warnings = [
    ...capabilityWarnings,
    ...getSpeechModelWarnings(preferences, { webGpu: capabilities.webGpu, dtype: preferences.dtype }),
  ].filter((warning, index, allWarnings) => allWarnings.indexOf(warning) === index)
  const cannotRun = !capabilities.webAssembly || !capabilities.webWorkers

  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby="regeneration-dialog-title"
        aria-modal="true"
        className="regeneration-dialog"
        role="dialog"
      >
        <div className="regeneration-dialog__header">
          <div>
            <h2 id="regeneration-dialog-title">Regenerate subtitles</h2>
            <p>Compare local Whisper alternatives for a range up to 29 seconds.</p>
          </div>
          <button aria-label="Close regeneration dialog" className="icon-button icon-button--ghost" type="button" onClick={onCancel}>
            <X size={17} />
          </button>
        </div>

        <div className="regeneration-range">
          <label>
            Start
            <input
              ref={startRef}
              aria-label="Regeneration start time"
              value={startDraft}
              onChange={(event) => {
                setStartDraft(event.target.value)
                markRangeDirty()
              }}
              onBlur={() => {
                if (parsedRange && !validationError) {
                  onRangeChange(parsedRange)
                }
              }}
            />
          </label>
          <span>to</span>
          <label>
            End
            <input
              aria-label="Regeneration end time"
              value={endDraft}
              onChange={(event) => {
                setEndDraft(event.target.value)
                markRangeDirty()
              }}
              onBlur={() => {
                if (parsedRange && !validationError) {
                  onRangeChange(parsedRange)
                }
              }}
            />
          </label>
        </div>

        {validationError ? <p className="notice notice--error">{validationError}</p> : null}

        <div className="settings-grid regeneration-settings">
          <label>
            Spoken language
            <select
              aria-label="Regeneration spoken language"
              disabled={busy}
              value={preferences.language}
              onChange={(event) => updatePreferences({ ...preferences, language: event.target.value })}
            >
              {LANGUAGES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Output
            <select
              aria-label="Regeneration output"
              disabled={busy}
              value={preferences.task}
              onChange={(event) => updatePreferences({
                ...preferences,
                task: event.target.value as RegenerationPreferences['task'],
              })}
            >
              <option value="transcribe">Same language</option>
              <option value="translate">Translate to English</option>
            </select>
          </label>
          <label>
            Model
            <select
              aria-label="Regeneration model"
              disabled={busy}
              value={preferences.modelId}
              onChange={(event) => updatePreferences({ ...preferences, modelId: event.target.value })}
            >
              {SPEECH_MODELS.map((model) => (
                <option
                  disabled={!isModelCompatibleWithSettings(model.id, preferences)}
                  key={model.id}
                  value={model.id}
                >
                  {`${model.label} - ${model.shortLabel}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Engine
            <select
              aria-label="Regeneration engine"
              disabled={busy}
              value={preferences.executionProvider}
              onChange={(event) => updatePreferences({
                ...preferences,
                executionProvider: event.target.value as RegenerationPreferences['executionProvider'],
              })}
            >
              <option value="auto">Auto</option>
              <option value="webgpu">WebGPU</option>
              <option value="wasm">WASM</option>
              <option value="cpu">CPU</option>
            </select>
          </label>
          <label>
            Precision
            <select
              aria-label="Regeneration precision"
              disabled={busy}
              value={preferences.dtype}
              onChange={(event) => updatePreferences({
                ...preferences,
                dtype: event.target.value as RegenerationPreferences['dtype'],
              })}
            >
              <option value="auto">Auto</option>
              <option value="q8">q8</option>
              <option value="fp32">Full precision</option>
            </select>
          </label>
          <label>
            Timestamp detail
            <select
              aria-label="Regeneration timestamp detail"
              disabled={busy}
              value={preferences.useWordTimestamps ? 'word' : 'segment'}
              onChange={(event) => updatePreferences({
                ...preferences,
                useWordTimestamps: event.target.value === 'word',
              })}
            >
              <option value="word">Word timestamps</option>
              <option value="segment">Segment timestamps</option>
            </select>
          </label>
        </div>

        <div className="model-note regeneration-model-note">
          <span><strong>{selectedModel.shortLabel}</strong>: {selectedModel.description}</span>
        </div>
        {compatibilityNotice ? <p className="notice notice--warning">{compatibilityNotice}</p> : null}
        {warnings.length ? (
          <div className="capability-list">
            {warnings.map((warning) => <p className="notice notice--warning" key={warning}>{warning}</p>)}
          </div>
        ) : null}

        <div className="regeneration-generate-row">
          <button
            className="button button--soft"
            disabled={busy || cannotRun || Boolean(validationError)}
            type="button"
            onClick={() => {
              if (parsedRange && !validationError) {
                setRangeDirty(false)
                setSettingsDirty(false)
                setSelectedId(ORIGINAL_OPTION_ID)
                onGenerate(parsedRange, preferences)
              }
            }}
          >
            {busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            Generate alternatives
          </button>
          <span>{visibleCandidates.length ? `${visibleCandidates.length} alternatives` : 'Original remains unchanged until Apply.'}</span>
        </div>

        {busy ? (
          <div className="regeneration-progress" aria-live="polite" role="status">
            <strong>{progress.message}</strong>
            {progress.progress !== undefined ? <progress max={1} value={progress.progress} /> : <div className="indeterminate" />}
          </div>
        ) : null}

        {error ? <p className="notice notice--error">{error}</p> : null}

        <div className="regeneration-options" role="radiogroup" aria-label="Regeneration choices">
          <RegenerationChoice
            checked={selectedId === ORIGINAL_OPTION_ID}
            entries={originalEntries}
            label="Keep current subtitles"
            value={ORIGINAL_OPTION_ID}
            onSelect={setSelectedId}
          />
          {visibleCandidates.map((candidate, index) => (
            <RegenerationChoice
              checked={selectedId === candidate.id}
              entries={candidate.entries}
              key={candidate.id}
              label={`Alternative ${index + 1}`}
              value={candidate.id}
              onSelect={setSelectedId}
            />
          ))}
        </div>

        <div className="regeneration-dialog__actions">
          <button className="button button--ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button button--ghost"
            disabled={busy || !parsedRange || !selectedEntries}
            type="button"
            onClick={() => {
              if (parsedRange && selectedEntries) {
                onPreview(selectedEntries, parsedRange)
              }
            }}
          >
            <Play size={16} />
            Preview selected
          </button>
          <button
            className="button button--primary"
            disabled={busy || !parsedRange || !selectedEntries}
            type="button"
            onClick={() => {
              if (parsedRange) {
                onApply(selectedId === ORIGINAL_OPTION_ID ? null : selectedEntries ?? null, parsedRange)
              }
            }}
          >
            {selectedId === ORIGINAL_OPTION_ID ? 'Keep original' : 'Apply alternative'}
          </button>
        </div>
      </section>
    </div>
  )
}

type RegenerationChoiceProps = {
  value: string
  label: string
  entries: SubtitleEntry[]
  checked: boolean
  onSelect: (value: string) => void
}

function RegenerationChoice({ value, label, entries, checked, onSelect }: RegenerationChoiceProps) {
  return (
    <label className={`regeneration-choice ${checked ? 'regeneration-choice--selected' : ''}`}>
      <input
        aria-label={label}
        checked={checked}
        name="regeneration-choice"
        type="radio"
        value={value}
        onChange={() => onSelect(value)}
      />
      <span>
        <strong>{label}</strong>
        <span>{entries.length ? `${entries.length} ${entries.length === 1 ? 'cue' : 'cues'}` : 'No timestamped speech'}</span>
        {entries.map((entry) => (
          <span className="regeneration-choice__cue" key={entry.id}>
            <span>{formatTimestamp(entry.startTime)} - {formatTimestamp(entry.endTime)}</span>
            {entry.text}
          </span>
        ))}
      </span>
    </label>
  )
}
