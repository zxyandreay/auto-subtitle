import { LocateFixed, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useSubtitleTimelineDrag } from '../hooks/useSubtitleTimelineDrag'
import { calculateTimelineEdit, type TimelineDragMode } from '../subtitles/timeline'
import { validateSubtitles } from '../subtitles/validation'
import type { SubtitleEntry, ValidationIssue } from '../types/subtitles'
import { formatTimestamp } from '../utils/time'
import { IconButton } from './IconButton'

type SubtitleTimelineProps = {
  entries: SubtitleEntry[]
  duration?: number
  currentTime: number
  playing: boolean
  selectedId?: string
  minDuration: number
  onUpdate: (id: string, patch: Pick<SubtitleEntry, 'startTime' | 'endTime'>) => void
  onSelect: (id: string) => void
  onSeek: (time: number) => void
}

const ZOOM_LEVELS = [12, 24, 48, 96]
const DEFAULT_PIXELS_PER_SECOND = 24
const FALLBACK_VIEWPORT_WIDTH = 640
const EMPTY_ISSUES: ValidationIssue[] = []

export function SubtitleTimeline({
  entries,
  duration,
  currentTime,
  playing,
  selectedId,
  minDuration,
  onUpdate,
  onSelect,
  onSeek,
}: SubtitleTimelineProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(FALLBACK_VIEWPORT_WIDTH)
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND)
  const [fit, setFit] = useState(false)
  const [followPlayhead, setFollowPlayhead] = useState(true)
  const timelineDuration = Math.max(duration ?? 0, entries.at(-1)?.endTime ?? 0, 30)
  const effectivePixelsPerSecond = fit
    ? Math.max(0.01, viewportWidth / Math.max(1, timelineDuration))
    : pixelsPerSecond
  const trackWidth = Math.max(viewportWidth, timelineDuration * effectivePixelsPerSecond)
  const issues = useMemo(() => validateSubtitles(entries, duration), [duration, entries])
  const issuesById = useMemo(() => groupIssues(issues), [issues])

  const { beginDrag, cancelDrag, endDrag, moveDrag, preview, shouldSuppressClick } = useSubtitleTimelineDrag({
    duration,
    minDuration,
    pixelsPerSecond: effectivePixelsPerSecond,
    playhead: currentTime,
    onUpdate,
  })

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const updateWidth = () => setViewportWidth(viewport.clientWidth || FALLBACK_VIEWPORT_WIDTH)
    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }
    const observer = new ResizeObserver(updateWidth)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!selectedId) {
      return
    }
    const cue = [...(viewportRef.current?.querySelectorAll<HTMLElement>('[data-subtitle-id]') ?? [])].find(
      (element) => element.dataset.subtitleId === selectedId,
    )
    cue?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selectedId])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !playing || !followPlayhead || fit) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const playheadX = currentTime * effectivePixelsPerSecond
      const leftBoundary = viewport.scrollLeft + viewport.clientWidth * 0.15
      const rightBoundary = viewport.scrollLeft + viewport.clientWidth * 0.85
      if (playheadX < leftBoundary || playheadX > rightBoundary) {
        viewport.scrollLeft = Math.max(0, playheadX - viewport.clientWidth / 2)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentTime, effectivePixelsPerSecond, fit, followPlayhead, playing])

  const handlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      entry: SubtitleEntry,
      mode: TimelineDragMode,
      previous?: SubtitleEntry,
      next?: SubtitleEntry,
    ) => {
      onSelect(entry.id)
      beginDrag(event, entry, mode, previous, next)
    },
    [beginDrag, onSelect],
  )

  const handleKeyboardEdit = useCallback(
    (event: KeyboardEvent<HTMLElement>, entry: SubtitleEntry, mode: TimelineDragMode) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      const deltaTime = direction * (event.shiftKey ? 0.5 : 0.1)
      const timing = calculateTimelineEdit({
        entry,
        mode,
        deltaTime,
        duration,
        minDuration,
        pixelsPerSecond: Number.POSITIVE_INFINITY,
      })
      onSelect(entry.id)
      onUpdate(entry.id, timing)
    },
    [duration, minDuration, onSelect, onUpdate],
  )

  const activateCue = useCallback(
    (entry: SubtitleEntry) => {
      if (!shouldSuppressClick(entry.id)) {
        onSelect(entry.id)
        onSeek(entry.startTime)
      }
    },
    [onSeek, onSelect, shouldSuppressClick],
  )

  const changeZoom = (direction: -1 | 1) => {
    const currentIndex = ZOOM_LEVELS.indexOf(pixelsPerSecond)
    const nextIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, currentIndex + direction))
    setFit(false)
    setPixelsPerSecond(ZOOM_LEVELS[nextIndex])
  }

  return (
    <section className="subtitle-timeline" aria-label="Interactive subtitle timeline">
      <div className="subtitle-timeline__toolbar">
        <strong>Subtitle timeline</strong>
        <span>{fit ? 'Fit' : `${pixelsPerSecond} px/s`}</span>
        <div className="subtitle-timeline__tools">
          <IconButton label="Zoom subtitle timeline out" disabled={!fit && pixelsPerSecond === ZOOM_LEVELS[0]} onClick={() => changeZoom(-1)}>
            <ZoomOut size={16} />
          </IconButton>
          <IconButton label="Fit subtitle timeline to width" variant={fit ? 'soft' : 'ghost'} onClick={() => setFit(true)}>
            <Maximize2 size={16} />
          </IconButton>
          <IconButton label="Zoom subtitle timeline in" disabled={!fit && pixelsPerSecond === ZOOM_LEVELS.at(-1)} onClick={() => changeZoom(1)}>
            <ZoomIn size={16} />
          </IconButton>
          <IconButton
            label={followPlayhead ? 'Disable timeline playhead follow' : 'Enable timeline playhead follow'}
            variant={followPlayhead ? 'soft' : 'ghost'}
            onClick={() => setFollowPlayhead((value) => !value)}
          >
            <LocateFixed size={16} />
          </IconButton>
        </div>
      </div>

      <div ref={viewportRef} className="subtitle-timeline__viewport" tabIndex={0}>
        <div className="subtitle-timeline__track" style={{ width: trackWidth }}>
          <div
            className="subtitle-timeline__playhead"
            aria-hidden="true"
            style={{ transform: `translateX(${currentTime * effectivePixelsPerSecond}px)` }}
          />
          {entries.map((entry, index) => {
            const renderedEntry = preview?.id === entry.id ? preview : entry
            return (
              <SubtitleTimelineCue
                active={currentTime >= renderedEntry.startTime && currentTime <= renderedEntry.endTime}
                dragging={preview?.id === entry.id}
                entry={renderedEntry}
                issues={issuesById.get(entry.id) ?? EMPTY_ISSUES}
                key={entry.id}
                next={entries[index + 1]}
                pixelsPerSecond={effectivePixelsPerSecond}
                previous={entries[index - 1]}
                selected={entry.id === selectedId}
                onActivate={activateCue}
                onCancelDrag={cancelDrag}
                onEndDrag={endDrag}
                onKeyboardEdit={handleKeyboardEdit}
                onMoveDrag={moveDrag}
                onPointerDown={handlePointerDown}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}

type SubtitleTimelineCueProps = {
  entry: SubtitleEntry
  pixelsPerSecond: number
  active: boolean
  dragging: boolean
  selected: boolean
  issues: ValidationIssue[]
  previous?: SubtitleEntry
  next?: SubtitleEntry
  onActivate: (entry: SubtitleEntry) => void
  onPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    entry: SubtitleEntry,
    mode: TimelineDragMode,
    previous?: SubtitleEntry,
    next?: SubtitleEntry,
  ) => void
  onMoveDrag: (event: ReactPointerEvent<HTMLElement>) => void
  onEndDrag: (event: ReactPointerEvent<HTMLElement>) => void
  onCancelDrag: (event: ReactPointerEvent<HTMLElement>) => void
  onKeyboardEdit: (event: KeyboardEvent<HTMLElement>, entry: SubtitleEntry, mode: TimelineDragMode) => void
}

const SubtitleTimelineCue = memo(function SubtitleTimelineCue({
  entry,
  pixelsPerSecond,
  active,
  dragging,
  selected,
  issues,
  previous,
  next,
  onActivate,
  onPointerDown,
  onMoveDrag,
  onEndDrag,
  onCancelDrag,
  onKeyboardEdit,
}: SubtitleTimelineCueProps) {
  const hasError = issues.some((issue) => issue.level === 'error')
  const hasWarning = issues.some((issue) => issue.level === 'warning')
  const className = [
    'subtitle-timeline__cue',
    active && 'subtitle-timeline__cue--active',
    selected && 'subtitle-timeline__cue--selected',
    dragging && 'subtitle-timeline__cue--dragging',
    hasError && 'subtitle-timeline__cue--error',
    !hasError && hasWarning && 'subtitle-timeline__cue--warning',
  ]
    .filter(Boolean)
    .join(' ')
  const label = `Subtitle ${entry.index}, ${formatTimestamp(entry.startTime)} to ${formatTimestamp(entry.endTime)}: ${entry.text}`

  return (
    <div
      className={className}
      style={{
        left: entry.startTime * pixelsPerSecond,
        width: Math.max(18, (entry.endTime - entry.startTime) * pixelsPerSecond),
      }}
    >
      <button
        aria-label={`Adjust start time for subtitle ${entry.index}`}
        className="subtitle-timeline__handle subtitle-timeline__handle--start"
        type="button"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => onKeyboardEdit(event, entry, 'start')}
        onPointerCancel={onCancelDrag}
        onPointerDown={(event) => {
          event.stopPropagation()
          onPointerDown(event, entry, 'start', previous, next)
        }}
        onPointerMove={onMoveDrag}
        onPointerUp={onEndDrag}
      />
      <button
        aria-label={label}
        aria-pressed={selected}
        className="subtitle-timeline__cue-body"
        data-subtitle-id={entry.id}
        data-subtitle-index={entry.index}
        type="button"
        onClick={() => onActivate(entry)}
        onKeyDown={(event) => onKeyboardEdit(event, entry, 'move')}
        onPointerCancel={onCancelDrag}
        onPointerDown={(event) => onPointerDown(event, entry, 'move', previous, next)}
        onPointerMove={onMoveDrag}
        onPointerUp={onEndDrag}
      >
        <span className="subtitle-timeline__cue-text">
          <b>{entry.index}</b> {entry.text || 'Empty subtitle'}
        </span>
      </button>
      <button
        aria-label={`Adjust end time for subtitle ${entry.index}`}
        className="subtitle-timeline__handle subtitle-timeline__handle--end"
        type="button"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => onKeyboardEdit(event, entry, 'end')}
        onPointerCancel={onCancelDrag}
        onPointerDown={(event) => {
          event.stopPropagation()
          onPointerDown(event, entry, 'end', previous, next)
        }}
        onPointerMove={onMoveDrag}
        onPointerUp={onEndDrag}
      />
    </div>
  )
})

function groupIssues(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const grouped = new Map<string, ValidationIssue[]>()
  for (const issue of issues) {
    grouped.set(issue.entryId, [...(grouped.get(issue.entryId) ?? []), issue])
  }
  return grouped
}
