import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerDownRight,
  Crosshair,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { formatSubtitleText } from '../subtitles/formatting'
import { getIssuesForEntry } from '../subtitles/validation'
import type { FormattingPreferences, SubtitleEntry } from '../types/subtitles'
import { IconButton } from './IconButton'
import { SubtitleTimestampInput } from './SubtitleTimestampInput'

type PlayerSubtitleEditorProps = {
  entry?: SubtitleEntry
  entries: SubtitleEntry[]
  duration?: number
  formatting: FormattingPreferences
  focusRequest?: number
  canRegenerate: boolean
  onUpdate: (id: string, patch: Partial<SubtitleEntry>) => void
  onDelete: (id: string) => void
  onRegenerate: () => void
  onSelect: (id: string) => void
  onSeek: (time: number) => void
  onPlayRange: (startTime: number, endTime: number) => void
}

export const PlayerSubtitleEditor = memo(function PlayerSubtitleEditor({
  entry,
  entries,
  duration,
  formatting,
  focusRequest,
  canRegenerate,
  onUpdate,
  onDelete,
  onRegenerate,
  onSelect,
  onSeek,
  onPlayRange,
}: PlayerSubtitleEditorProps) {
  const [collapsed, setCollapsed] = useState(false)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const selectedIndex = entry ? entries.findIndex((item) => item.id === entry.id) : -1
  const previous = selectedIndex > 0 ? entries[selectedIndex - 1] : undefined
  const next = selectedIndex >= 0 ? entries[selectedIndex + 1] : undefined
  const issues = entry ? getIssuesForEntry(entry.id, entries, duration) : []

  useEffect(() => {
    if (!focusRequest || !entry || !textRef.current) {
      return
    }
    setCollapsed(false)
    textRef.current.focus()
    textRef.current.select()
  }, [entry, focusRequest])

  return (
    <section className={`player-subtitle-editor ${collapsed ? 'player-subtitle-editor--collapsed' : ''}`} aria-label="Player subtitle editor">
      <div className="player-subtitle-editor__heading">
        <div>
          <strong>{entry ? `Subtitle ${entry.index}` : 'Subtitle editor'}</strong>
          <span>{entry ? 'Selected in the player' : 'Select a subtitle cue to edit it here'}</span>
        </div>
        <IconButton
          label={collapsed ? 'Expand player subtitle editor' : 'Collapse player subtitle editor'}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </IconButton>
      </div>

      {!collapsed && entry ? (
        <div className="player-subtitle-editor__body">
          <div className="player-subtitle-editor__timing">
            <SubtitleTimestampInput
              label={`Start time for subtitle ${entry.index}`}
              value={entry.startTime}
              onCommit={(startTime) => onUpdate(entry.id, { startTime })}
            />
            <SubtitleTimestampInput
              label={`End time for subtitle ${entry.index}`}
              value={entry.endTime}
              onCommit={(endTime) => onUpdate(entry.id, { endTime })}
            />
          </div>

          <textarea
            ref={textRef}
            aria-label={`Subtitle ${entry.index} text`}
            value={entry.text}
            onBlur={(event) => onUpdate(entry.id, { text: formatSubtitleText(event.currentTarget.value, formatting) })}
            onChange={(event) => onUpdate(entry.id, { text: event.target.value })}
          />

          <div className="player-subtitle-editor__actions" aria-label="Selected subtitle actions">
            <IconButton label="Previous subtitle" disabled={!previous} onClick={() => previous && onSelect(previous.id)}>
              <ChevronLeft size={16} />
            </IconButton>
            <IconButton label="Next subtitle" disabled={!next} onClick={() => next && onSelect(next.id)}>
              <ChevronRight size={16} />
            </IconButton>
            <IconButton label="Seek to selected subtitle start" onClick={() => onSeek(entry.startTime)}>
              <Crosshair size={16} />
            </IconButton>
            <IconButton label="Play selected subtitle range" onClick={() => onPlayRange(entry.startTime, entry.endTime)}>
              <CornerDownRight size={16} />
            </IconButton>
            <IconButton
              label="Regenerate selected subtitle"
              disabled={!canRegenerate}
              onClick={onRegenerate}
            >
              <RefreshCw size={16} />
            </IconButton>
            <IconButton label="Delete selected subtitle" variant="danger" onClick={() => onDelete(entry.id)}>
              <Trash2 size={16} />
            </IconButton>
          </div>

          {issues.length ? (
            <ul className="issue-list" aria-live="polite">
              {issues.map((issue) => (
                <li className={`issue-list__item issue-list__item--${issue.level}`} key={`${issue.code}-${issue.message}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
})
