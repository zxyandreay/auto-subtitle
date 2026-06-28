import { useEffect, useId, useState } from 'react'
import { formatTimestamp, parseTimestamp } from '../utils/time'

type SubtitleTimestampInputProps = {
  label: string
  value: number
  onCommit: (value: number) => void
}

export function SubtitleTimestampInput({ label, value, onCommit }: SubtitleTimestampInputProps) {
  const [draft, setDraft] = useState(formatTimestamp(value, { alwaysHours: true }))
  const [error, setError] = useState('')
  const errorId = useId()

  useEffect(() => {
    setDraft(formatTimestamp(value, { alwaysHours: true }))
    setError('')
  }, [value])

  return (
    <label className={`timestamp-field ${error ? 'timestamp-field--error' : ''}`}>
      <span className="sr-only">{label}</span>
      <input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={Boolean(error)}
        aria-label={label}
        value={draft}
        onBlur={() => {
          const parsed = parseTimestamp(draft)
          if (parsed === null) {
            setError('Use HH:MM:SS.mmm, MM:SS.mmm, or seconds.')
            return
          }
          setError('')
          onCommit(parsed)
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(parseTimestamp(event.target.value) === null ? 'Invalid time' : '')
        }}
      />
      {error ? (
        <span className="timestamp-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  )
}
