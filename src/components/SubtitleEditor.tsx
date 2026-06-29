import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  formatSubtitleText,
  makeSubtitleEntry,
  makeSubtitleEntryAtTime,
  mergeEntries,
  removeEmptyEntries,
  sortAndRenumber,
  splitEntry,
} from '../subtitles/formatting'
import { getIssuesForEntry, validateSubtitles } from '../subtitles/validation'
import type { FormattingPreferences, SubtitleEntry, ValidationIssue } from '../types/subtitles'
import { IconButton } from './IconButton'
import { SubtitleTimestampInput } from './SubtitleTimestampInput'

type SubtitleEditorProps = {
  entries: SubtitleEntry[]
  activeEntryId?: string
  selectedEntryId?: string
  duration?: number
  formatting: FormattingPreferences
  autoScroll: boolean
  showOnlyErrors: boolean
  canRegenerate: boolean
  capturePlayheadTime: () => number
  onAutoScrollChange: (enabled: boolean) => void
  onShowOnlyErrorsChange: (enabled: boolean) => void
  onChange: (entries: SubtitleEntry[]) => void
  onSeek: (time: number) => void
  onSelectEntry: (id: string) => void
  onPlayRange: (startTime: number, endTime: number) => void
  onRegenerate: (entry: SubtitleEntry) => void
}

export function SubtitleEditor({
  entries,
  activeEntryId,
  selectedEntryId,
  duration,
  formatting,
  autoScroll,
  showOnlyErrors,
  canRegenerate,
  capturePlayheadTime,
  onAutoScrollChange,
  onShowOnlyErrorsChange,
  onChange,
  onSeek,
  onSelectEntry,
  onPlayRange,
  onRegenerate,
}: SubtitleEditorProps) {
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [entryToFocusId, setEntryToFocusId] = useState<string>()
  const activeRef = useRef<HTMLDivElement | null>(null)
  const issues = useMemo(() => validateSubtitles(entries, duration), [duration, entries])
  const issueIds = useMemo(() => new Set(issues.map((issue) => issue.entryId)), [issues])
  const matches = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase()
    if (!lowerQuery) {
      return []
    }
    return entries.filter((entry) => entry.text.toLowerCase().includes(lowerQuery)).map((entry) => entry.id)
  }, [entries, query])
  const visibleEntries = showOnlyErrors ? entries.filter((entry) => issueIds.has(entry.id)) : entries

  useEffect(() => {
    setMatchIndex(0)
  }, [query])

  useEffect(() => {
    if (autoScroll && !entryToFocusId && activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [activeEntryId, autoScroll, entryToFocusId])

  const commit = (next: SubtitleEntry[]) => onChange(sortAndRenumber(next))

  const updateEntry = (id: string, patch: Partial<SubtitleEntry>) => {
    commit(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  }

  const commitNewEntry = (nextEntries: SubtitleEntry[], entryId: string) => {
    if (showOnlyErrors) {
      onShowOnlyErrorsChange(false)
    }
    setEntryToFocusId(entryId)
    onSelectEntry(entryId)
    commit(nextEntries)
  }

  const insertAtPlayhead = () => {
    const next = makeSubtitleEntryAtTime(capturePlayheadTime(), duration)
    commitNewEntry([...entries, next], next.id)
  }

  const insertAt = (index: number, placement: 'before' | 'after') => {
    const anchor = entries[index]
    const startTime = anchor
      ? placement === 'before'
        ? Math.max(0, anchor.startTime - 2)
        : anchor.endTime + 0.1
      : 0
    const endTime = anchor
      ? placement === 'before'
        ? Math.max(startTime + 1, anchor.startTime - 0.1)
        : anchor.endTime + 2
      : 2
    const next = makeSubtitleEntry({ startTime, endTime, text: 'New subtitle' })
    const position = placement === 'before' ? index : index + 1
    commitNewEntry([...entries.slice(0, position), next, ...entries.slice(position)], next.id)
  }

  const jumpToMatch = (direction: 1 | -1) => {
    if (!matches.length) {
      return
    }
    const nextIndex = (matchIndex + direction + matches.length) % matches.length
    setMatchIndex(nextIndex)
    const entry = entries.find((item) => item.id === matches[nextIndex])
    if (entry) {
      onSeek(entry.startTime)
    }
  }

  return (
    <section className="editor-panel" aria-label="Subtitle editor">
      <div className="panel-heading">
        <div>
          <h2>Subtitle editor</h2>
          <p>
            {entries.length} entries
            {issues.length ? `, ${issues.length} validation ${issues.length === 1 ? 'issue' : 'issues'}` : ', no issues'}
          </p>
        </div>
        <button
          aria-label="Add subtitle at current video time"
          className="button button--soft"
          title="Add subtitle at current video time"
          type="button"
          onClick={insertAtPlayhead}
        >
          <Plus size={16} />
          Add
        </button>
      </div>

      <div className="editor-tools">
        <label className="search-box">
          <Search size={16} />
          <input
            aria-label="Search subtitle text"
            placeholder="Search subtitles"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="match-nav">
          <span>
            {matches.length ? `${matchIndex + 1}/${matches.length}` : '0/0'}
          </span>
          <IconButton label="Previous search match" onClick={() => jumpToMatch(-1)}>
            <ArrowUp size={16} />
          </IconButton>
          <IconButton label="Next search match" onClick={() => jumpToMatch(1)}>
            <ArrowDown size={16} />
          </IconButton>
        </div>
        <label className="toggle-line">
          <input
            checked={showOnlyErrors}
            type="checkbox"
            onChange={(event) => onShowOnlyErrorsChange(event.target.checked)}
          />
          Errors
        </label>
        <label className="toggle-line">
          <input
            checked={autoScroll}
            type="checkbox"
            onChange={(event) => onAutoScrollChange(event.target.checked)}
          />
          Auto-scroll
        </label>
      </div>

      <div className="subtitle-list" role="list">
        {visibleEntries.length ? (
          visibleEntries.map((entry) => {
            const index = entries.findIndex((item) => item.id === entry.id)
            const entryIssues = getIssuesForEntry(entry.id, entries, duration)
            const isActive = entry.id === activeEntryId
            const isSelected = entry.id === selectedEntryId
            const isMatch = matches[matchIndex] === entry.id

            return (
              <SubtitleRow
                refCallback={isActive ? (element) => (activeRef.current = element) : undefined}
                key={entry.id}
                entry={entry}
                formatting={formatting}
                issues={entryIssues}
                isActive={isActive}
                isSelected={isSelected}
                isMatch={isMatch}
                focusText={entry.id === entryToFocusId}
                onAddAfter={() => insertAt(index, 'after')}
                onAddBefore={() => insertAt(index, 'before')}
                onFocusHandled={() => setEntryToFocusId(undefined)}
                onDelete={() => commit(entries.filter((item) => item.id !== entry.id))}
                onMergeNext={() => {
                  const next = entries[index + 1]
                  if (next) {
                    commit([...entries.slice(0, index), mergeEntries(entry, next), ...entries.slice(index + 2)])
                  }
                }}
                onMergePrevious={() => {
                  const previous = entries[index - 1]
                  if (previous) {
                    commit([...entries.slice(0, index - 1), mergeEntries(previous, entry), ...entries.slice(index + 1)])
                  }
                }}
                onMoveDown={() => {
                  if (index < entries.length - 1) {
                    const next = [...entries]
                    const moved = next[index]
                    next[index] = next[index + 1]
                    next[index + 1] = moved
                    commit(next.map((item, itemIndex) => ({ ...item, index: itemIndex + 1 })))
                  }
                }}
                onMoveUp={() => {
                  if (index > 0) {
                    const next = [...entries]
                    const moved = next[index]
                    next[index] = next[index - 1]
                    next[index - 1] = moved
                    commit(next.map((item, itemIndex) => ({ ...item, index: itemIndex + 1 })))
                  }
                }}
                onPlayRange={() => onPlayRange(entry.startTime, entry.endTime)}
                onRegenerate={() => onRegenerate(entry)}
                onSeek={() => onSeek(entry.startTime)}
                onSelect={() => onSelectEntry(entry.id)}
                onSplit={() => {
                  const [first, second] = splitEntry(entry)
                  commit([...entries.slice(0, index), first, second, ...entries.slice(index + 1)])
                }}
                onUpdate={(patch) => updateEntry(entry.id, patch)}
                regenerationDisabled={!canRegenerate}
              />
            )
          })
        ) : (
          <div className="empty-editor">
            <p>No subtitles yet.</p>
            <button className="button button--primary" type="button" onClick={insertAtPlayhead}>
              <Plus size={16} />
              Create first subtitle
            </button>
          </div>
        )}
      </div>

      {entries.length ? (
        <div className="editor-footer">
          <button className="button button--ghost" type="button" onClick={() => commit(removeEmptyEntries(entries))}>
            Remove empty entries
          </button>
        </div>
      ) : null}
    </section>
  )
}

type SubtitleRowProps = {
  entry: SubtitleEntry
  issues: ValidationIssue[]
  formatting: FormattingPreferences
  isActive: boolean
  isSelected: boolean
  isMatch: boolean
  focusText: boolean
  refCallback?: (element: HTMLDivElement | null) => void
  onUpdate: (patch: Partial<SubtitleEntry>) => void
  onSeek: () => void
  onSelect: () => void
  onPlayRange: () => void
  onRegenerate: () => void
  onAddBefore: () => void
  onAddAfter: () => void
  onFocusHandled: () => void
  onDelete: () => void
  onSplit: () => void
  onMergePrevious: () => void
  onMergeNext: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  regenerationDisabled: boolean
}

function SubtitleRow({
  entry,
  issues,
  formatting,
  isActive,
  isSelected,
  isMatch,
  focusText,
  refCallback,
  onUpdate,
  onSeek,
  onSelect,
  onPlayRange,
  onRegenerate,
  onAddBefore,
  onAddAfter,
  onFocusHandled,
  onDelete,
  onSplit,
  onMergePrevious,
  onMergeNext,
  onMoveUp,
  onMoveDown,
  regenerationDisabled,
}: SubtitleRowProps) {
  const hasError = issues.some((issue) => issue.level === 'error')
  const textRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!focusText || !textRef.current) {
      return
    }

    textRef.current.scrollIntoView({ block: 'nearest' })
    textRef.current.focus()
    textRef.current.select()
    onFocusHandled()
  }, [focusText, onFocusHandled])

  return (
    <div
      ref={refCallback}
      className={`subtitle-row ${isActive ? 'subtitle-row--active' : ''} ${isSelected ? 'subtitle-row--selected' : ''} ${isMatch ? 'subtitle-row--match' : ''} ${hasError ? 'subtitle-row--error' : ''}`}
      data-editor-subtitle-id={entry.id}
      role="listitem"
      tabIndex={0}
      onFocusCapture={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          onSeek()
        }
      }}
    >
      <div className="subtitle-row__top">
        <button className="row-index" type="button" onClick={onSeek}>
          {entry.index}
        </button>
        <SubtitleTimestampInput
          label={`Start time for subtitle ${entry.index}`}
          value={entry.startTime}
          onCommit={(value) => onUpdate({ startTime: value })}
        />
        <SubtitleTimestampInput
          label={`End time for subtitle ${entry.index}`}
          value={entry.endTime}
          onCommit={(value) => onUpdate({ endTime: value })}
        />
        <div className="row-actions">
          <IconButton label="Regenerate subtitle" disabled={regenerationDisabled} onClick={onRegenerate}>
            <RefreshCw size={15} />
          </IconButton>
          <IconButton label="Play subtitle range" onClick={onPlayRange}>
            <CornerDownRight size={15} />
          </IconButton>
          <IconButton label="Split subtitle" onClick={onSplit}>
            <Scissors size={15} />
          </IconButton>
          <IconButton label="Move subtitle up" onClick={onMoveUp}>
            <ArrowUp size={15} />
          </IconButton>
          <IconButton label="Move subtitle down" onClick={onMoveDown}>
            <ArrowDown size={15} />
          </IconButton>
          <IconButton label="Delete subtitle" variant="danger" onClick={onDelete}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>

      <textarea
        ref={textRef}
        aria-label={`Subtitle ${entry.index} text`}
        value={entry.text}
        onChange={(event) => onUpdate({ text: event.target.value })}
        onBlur={(event) => onUpdate({ text: formatSubtitleText(event.target.value, formatting) })}
      />

      <div className="row-secondary-actions">
        <button type="button" onClick={onAddBefore}>
          Add before
        </button>
        <button type="button" onClick={onAddAfter}>
          Add after
        </button>
        <button type="button" onClick={onMergePrevious}>
          Merge previous
        </button>
        <button type="button" onClick={onMergeNext}>
          Merge next
        </button>
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
  )
}
