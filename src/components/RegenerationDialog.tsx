import { Loader2, Play, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { validateRegenerationRange } from '../transcription/regeneration'
import type { RegenerationRange, TranscriptionProgress } from '../transcription/types'
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
  onGenerate: (range: RegenerationRange) => void
  onPreview: (entries: SubtitleEntry[], range: RegenerationRange) => void
  onApply: (entries: SubtitleEntry[] | null, range: RegenerationRange) => void
  onCancel: () => void
}

const ORIGINAL_OPTION_ID = 'original'

export function RegenerationDialog({
  range,
  videoDuration,
  originalEntries,
  candidates,
  progress,
  busy,
  error,
  onGenerate,
  onPreview,
  onApply,
  onCancel,
}: RegenerationDialogProps) {
  const [startDraft, setStartDraft] = useState(() => formatTimestamp(range.startTime, { alwaysHours: true }))
  const [endDraft, setEndDraft] = useState(() => formatTimestamp(range.endTime, { alwaysHours: true }))
  const [selectedId, setSelectedId] = useState(ORIGINAL_OPTION_ID)
  const [rangeDirty, setRangeDirty] = useState(false)
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
  const visibleCandidates = rangeDirty ? [] : candidates
  const selectedEntries =
    selectedId === ORIGINAL_OPTION_ID
      ? originalEntries
      : visibleCandidates.find((candidate) => candidate.id === selectedId)?.entries

  const markRangeDirty = () => {
    setRangeDirty(true)
    setSelectedId(ORIGINAL_OPTION_ID)
  }

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
            />
          </label>
        </div>

        {validationError ? <p className="notice notice--error">{validationError}</p> : null}

        <div className="regeneration-generate-row">
          <button
            className="button button--soft"
            disabled={busy || Boolean(validationError)}
            type="button"
            onClick={() => {
              if (parsedRange && !validationError) {
                setRangeDirty(false)
                setSelectedId(ORIGINAL_OPTION_ID)
                onGenerate(parsedRange)
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
