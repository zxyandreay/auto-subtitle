import type { FormattingPreferences } from '../types/subtitles'

type FormattingPanelProps = {
  preferences: FormattingPreferences
  disabled?: boolean
  onChange: (preferences: FormattingPreferences) => void
  onReformat: () => void
}

export function FormattingPanel({ preferences, disabled = false, onChange, onReformat }: FormattingPanelProps) {
  return (
    <section className="formatting-panel" aria-label="Subtitle formatting preferences">
      <div className="panel-heading panel-heading--compact">
        <div>
          <h2>Formatting</h2>
          <p>Readable defaults for one or two subtitle lines.</p>
        </div>
      </div>

      <div className="settings-grid settings-grid--compact">
        <label>
          Characters per line
          <input
            disabled={disabled}
            min={24}
            max={60}
            type="number"
            value={preferences.maxCharsPerLine}
            onChange={(event) => onChange({ ...preferences, maxCharsPerLine: Number(event.target.value) })}
          />
        </label>
        <label>
          Characters per subtitle
          <input
            disabled={disabled}
            min={36}
            max={140}
            type="number"
            value={preferences.maxCharsPerSubtitle}
            onChange={(event) => onChange({ ...preferences, maxCharsPerSubtitle: Number(event.target.value) })}
          />
        </label>
        <label>
          Minimum duration
          <input
            disabled={disabled}
            min={0.4}
            max={3}
            step={0.1}
            type="number"
            value={preferences.minDuration}
            onChange={(event) => onChange({ ...preferences, minDuration: Number(event.target.value) })}
          />
        </label>
        <label>
          Maximum duration
          <input
            disabled={disabled}
            min={2}
            max={12}
            step={0.5}
            type="number"
            value={preferences.maxDuration}
            onChange={(event) => onChange({ ...preferences, maxDuration: Number(event.target.value) })}
          />
        </label>
        <label>
          Minimum gap
          <input
            disabled={disabled}
            min={0}
            max={0.5}
            step={0.01}
            type="number"
            value={preferences.gapBetweenSubtitles}
            onChange={(event) => onChange({ ...preferences, gapBetweenSubtitles: Number(event.target.value) })}
          />
        </label>
        <label className="toggle-line toggle-line--panel">
          <input
            checked={preferences.useWordTimestamps}
            disabled={disabled}
            type="checkbox"
            onChange={(event) => onChange({ ...preferences, useWordTimestamps: event.target.checked })}
          />
          Use word timestamps
        </label>
      </div>

      <button className="button button--soft" disabled={disabled} type="button" onClick={onReformat}>
        Reapply formatting
      </button>
    </section>
  )
}
