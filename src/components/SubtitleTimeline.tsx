import { LocateFixed, Magnet, Play, RefreshCw, RotateCcw, RotateCw, Scissors, Settings2, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useSubtitleTimelineDrag } from '../hooks/useSubtitleTimelineDrag'
import { useRegenerationRangeDrag } from '../hooks/useRegenerationRangeDrag'
import {
  buildTimelineSnapTargets,
  calculateTimelineEdit,
  calculateTimelineEditWithSnap,
  snapTimelineTime,
  type TimelineDragMode,
  type TimelineSnapMatch,
  type TimelineSnapTarget,
} from '../subtitles/timeline'
import { validateSubtitles } from '../subtitles/validation'
import { MAX_REGENERATION_RANGE_SECONDS } from '../transcription/regeneration'
import type { RegenerationRange } from '../transcription/types'
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
  canRedo: boolean
  canSplitAtPlayhead: boolean
  canUndo: boolean
  canRegenerate: boolean
  regenerationRange?: RegenerationRange
  onRedo: () => void
  onSplitAtPlayhead: () => void
  onUndo: () => void
  onStartRegeneration: () => void
  onChangeRegenerationRange: (range: RegenerationRange) => void
  onPreviewRegeneration: () => void
  onConfigureRegeneration: () => void
  onCancelRegeneration: () => void
  onUpdate: (id: string, patch: Pick<SubtitleEntry, 'startTime' | 'endTime'>) => void
  onSelect: (id: string) => void
  onSeek: (time: number) => void
}

const MIN_PIXELS_PER_SECOND = 12
const MAX_PIXELS_PER_SECOND = 96
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
  canRedo,
  canSplitAtPlayhead,
  canUndo,
  canRegenerate,
  regenerationRange,
  onRedo,
  onSplitAtPlayhead,
  onUndo,
  onStartRegeneration,
  onChangeRegenerationRange,
  onPreviewRegeneration,
  onConfigureRegeneration,
  onCancelRegeneration,
  onUpdate,
  onSelect,
  onSeek,
}: SubtitleTimelineProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const playheadDragRef = useRef<{ pointerId: number; captureElement: HTMLElement } | null>(null)
  const trackClickSnapTimeoutRef = useRef<number | undefined>(undefined)
  const [viewportWidth, setViewportWidth] = useState(FALLBACK_VIEWPORT_WIDTH)
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND)
  const [followPlayhead, setFollowPlayhead] = useState(true)
  const [snappingEnabled, setSnappingEnabled] = useState(true)
  const [playheadDragTime, setPlayheadDragTime] = useState<number>()
  const [playheadSnap, setPlayheadSnap] = useState<TimelineSnapMatch>()
  const [trackClickSnap, setTrackClickSnap] = useState<TimelineSnapMatch>()
  const timelineDuration = Math.max(duration ?? 0, entries.at(-1)?.endTime ?? 0, 30)
  const effectivePixelsPerSecond = pixelsPerSecond
  const trackWidth = Math.max(viewportWidth, timelineDuration * effectivePixelsPerSecond)
  const issues = useMemo(() => validateSubtitles(entries, duration), [duration, entries])
  const issuesById = useMemo(() => groupIssues(issues), [issues])

  const { activeSnap: cueSnap, beginDrag, cancelDrag, endDrag, moveDrag, preview, shouldSuppressClick } = useSubtitleTimelineDrag({
    entries,
    duration,
    minDuration,
    pixelsPerSecond: effectivePixelsPerSecond,
    playhead: currentTime,
    snappingEnabled,
    onUpdate,
  })

  const {
    activeSnap: regenerationSnap,
    beginDrag: beginRegenerationDrag,
    cancelDrag: cancelRegenerationDrag,
    endDrag: endRegenerationDrag,
    moveDrag: moveRegenerationDrag,
    preview: regenerationPreview,
  } = useRegenerationRangeDrag({
    entries,
    range: regenerationRange,
    duration,
    pixelsPerSecond: effectivePixelsPerSecond,
    playhead: currentTime,
    snappingEnabled,
    onChange: onChangeRegenerationRange,
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
    return () => {
      if (trackClickSnapTimeoutRef.current !== undefined) {
        window.clearTimeout(trackClickSnapTimeoutRef.current)
      }
    }
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
    if (!viewport || !playing || !followPlayhead) {
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
  }, [currentTime, effectivePixelsPerSecond, followPlayhead, playing])

  const handlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      entry: SubtitleEntry,
      mode: TimelineDragMode,
    ) => {
      onSelect(entry.id)
      beginDrag(event, entry, mode)
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
        snappingDisabled: !snappingEnabled || event.altKey,
      })
      onSelect(entry.id)
      onUpdate(entry.id, timing)
    },
    [duration, minDuration, onSelect, onUpdate, snappingEnabled],
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

  const calculatePlayheadTime = useCallback(
    (clientX: number, snappingBypassed: boolean) => {
      const trackLeft = trackRef.current?.getBoundingClientRect().left ?? 0
      const maximum = duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : timelineDuration
      const proposedTime = Math.max(0, Math.min(maximum, (clientX - trackLeft) / effectivePixelsPerSecond))
      return snapTimelineTime(
        proposedTime,
        buildTimelineSnapTargets({ entries, duration }),
        effectivePixelsPerSecond,
        !snappingEnabled || snappingBypassed,
      )
    },
    [duration, effectivePixelsPerSecond, entries, snappingEnabled, timelineDuration],
  )

  const beginPlayheadDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    playheadDragRef.current = { pointerId: event.pointerId, captureElement: event.currentTarget }
    if (trackClickSnapTimeoutRef.current !== undefined) {
      window.clearTimeout(trackClickSnapTimeoutRef.current)
      trackClickSnapTimeoutRef.current = undefined
    }
    setTrackClickSnap(undefined)
    setPlayheadDragTime(currentTime)
    setPlayheadSnap(undefined)
  }, [currentTime])

  const movePlayheadDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (playheadDragRef.current?.pointerId !== event.pointerId) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const result = calculatePlayheadTime(event.clientX, event.altKey)
    setPlayheadDragTime(result.time)
    setPlayheadSnap(result.snap)
    onSeek(result.time)
  }, [calculatePlayheadTime, onSeek])

  const finishPlayheadDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = playheadDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    const result = calculatePlayheadTime(event.clientX, event.altKey)
    playheadDragRef.current = null
    setPlayheadDragTime(undefined)
    setPlayheadSnap(undefined)
    onSeek(result.time)
    try {
      drag.captureElement.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }, [calculatePlayheadTime, onSeek])

  const cancelPlayheadDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = playheadDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    playheadDragRef.current = null
    setPlayheadDragTime(undefined)
    setPlayheadSnap(undefined)
    try {
      drag.captureElement.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }, [])

  const handlePlayheadKeyboard = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    let proposedTime: number | undefined
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const direction = event.key === 'ArrowRight' ? 1 : -1
      proposedTime = currentTime + direction * (event.shiftKey ? 0.5 : 0.1)
    } else if (event.key === 'Home') {
      proposedTime = 0
    } else if (event.key === 'End' && duration !== undefined) {
      proposedTime = duration
    }
    if (proposedTime === undefined) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const maximum = duration !== undefined && duration > 0 ? duration : timelineDuration
    const result = snapTimelineTime(
      Math.max(0, Math.min(maximum, proposedTime)),
      buildTimelineSnapTargets({ entries, duration }),
      effectivePixelsPerSecond,
      !snappingEnabled || event.altKey,
    )
    onSeek(result.time)
  }, [currentTime, duration, effectivePixelsPerSecond, entries, onSeek, snappingEnabled, timelineDuration])

  const toggleSnapping = useCallback(() => {
    if (snappingEnabled) {
      if (trackClickSnapTimeoutRef.current !== undefined) {
        window.clearTimeout(trackClickSnapTimeoutRef.current)
        trackClickSnapTimeoutRef.current = undefined
      }
      setPlayheadSnap(undefined)
      setTrackClickSnap(undefined)
    }
    setSnappingEnabled((enabled) => !enabled)
  }, [snappingEnabled])

  const handleRegenerationKeyboard = useCallback(
    (event: KeyboardEvent<HTMLElement>, mode: TimelineDragMode) => {
      if (!regenerationRange || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      const result = calculateTimelineEditWithSnap({
        entry: {
          id: 'timeline-regeneration-range',
          index: 0,
          startTime: regenerationRange.startTime,
          endTime: regenerationRange.endTime,
          text: '',
        },
        mode,
        deltaTime: direction * (event.shiftKey ? 0.5 : 0.1),
        duration,
        minDuration: 0.1,
        maxDuration: MAX_REGENERATION_RANGE_SECONDS,
        pixelsPerSecond: Number.POSITIVE_INFINITY,
        snapTargets: buildTimelineSnapTargets({ entries, playhead: currentTime, duration }),
        snappingDisabled: !snappingEnabled || event.altKey,
      })
      onChangeRegenerationRange(result.timing)
    },
    [currentTime, duration, entries, onChangeRegenerationRange, regenerationRange, snappingEnabled],
  )

  const handleTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return
      }
      const result = calculatePlayheadTime(event.clientX, event.altKey)
      if (trackClickSnapTimeoutRef.current !== undefined) {
        window.clearTimeout(trackClickSnapTimeoutRef.current)
      }
      setTrackClickSnap(result.snap)
      if (result.snap) {
        trackClickSnapTimeoutRef.current = window.setTimeout(() => {
          setTrackClickSnap(undefined)
          trackClickSnapTimeoutRef.current = undefined
        }, 700)
      } else {
        trackClickSnapTimeoutRef.current = undefined
      }
      onSeek(result.time)
    },
    [calculatePlayheadTime, onSeek],
  )

  const renderedPlayheadTime = playheadDragTime ?? currentTime
  const activeSnap = regenerationSnap ?? playheadSnap ?? cueSnap ?? trackClickSnap
  const snapTarget = activeSnap?.target
  const renderedRegenerationRange = regenerationPreview ?? regenerationRange

  return (
    <section className="subtitle-timeline" aria-label="Interactive subtitle timeline">
      <div className="subtitle-timeline__toolbar">
        <strong>Subtitle timeline</strong>
        <span>{`${pixelsPerSecond} px/s`}</span>
        <div className="subtitle-timeline__tools">
          <IconButton
            label="Undo subtitle edit from timeline"
            disabled={!canUndo}
            title="Undo subtitle edit (Ctrl+Z / Cmd+Z)"
            onClick={onUndo}
          >
            <RotateCcw size={16} />
          </IconButton>
          <IconButton
            label="Redo subtitle edit from timeline"
            disabled={!canRedo}
            title="Redo subtitle edit (Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z)"
            onClick={onRedo}
          >
            <RotateCw size={16} />
          </IconButton>
          <IconButton
            label="Split selected subtitle at playhead"
            disabled={!canSplitAtPlayhead}
            title="Split selected subtitle at playhead (Ctrl+K / Cmd+K)"
            onClick={onSplitAtPlayhead}
          >
            <Scissors size={16} />
          </IconButton>
          {regenerationRange ? (
            <>
              <IconButton
                label="Preview regeneration range"
                disabled={!canRegenerate}
                title="Play the selected regeneration range once"
                onClick={onPreviewRegeneration}
              >
                <Play size={16} />
              </IconButton>
              <IconButton
                label="Configure regeneration"
                disabled={!canRegenerate}
                title="Choose regeneration model and settings"
                variant="soft"
                onClick={onConfigureRegeneration}
              >
                <Settings2 size={16} />
              </IconButton>
              <IconButton
                label="Cancel timeline regeneration range"
                title="Clear the regeneration range"
                onClick={onCancelRegeneration}
              >
                <X size={16} />
              </IconButton>
            </>
          ) : (
            <IconButton
              label="Start timeline regeneration range"
              disabled={!canRegenerate}
              title="Choose a timeline range to regenerate"
              onClick={onStartRegeneration}
            >
              <RefreshCw size={16} />
            </IconButton>
          )}
          <IconButton
            label={snappingEnabled ? 'Disable timeline magnetic snapping' : 'Enable timeline magnetic snapping'}
            variant={snappingEnabled ? 'soft' : 'ghost'}
            onClick={toggleSnapping}
          >
            <Magnet size={16} />
          </IconButton>
          <label className="subtitle-timeline__zoom">
            <span className="sr-only">Zoom subtitle timeline</span>
            <input
              aria-label="Zoom subtitle timeline"
              max={MAX_PIXELS_PER_SECOND}
              min={MIN_PIXELS_PER_SECOND}
              step={1}
              title={`Timeline zoom: ${pixelsPerSecond} pixels per second`}
              type="range"
              value={pixelsPerSecond}
              onChange={(event) => setPixelsPerSecond(Number(event.target.value))}
            />
          </label>
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
        <div
          ref={trackRef}
          className={`subtitle-timeline__track ${renderedRegenerationRange ? 'subtitle-timeline__track--regeneration' : ''}`}
          style={{ width: trackWidth }}
          onClick={handleTrackClick}
        >
          {activeSnap ? (
            <div
              className="subtitle-timeline__snap-guide"
              style={{ transform: `translateX(${activeSnap.target.time * effectivePixelsPerSecond}px)` }}
            >
              <span>{`Snap: ${activeSnap.target.label} ${formatTimestamp(activeSnap.target.time, { alwaysHours: true })}`}</span>
            </div>
          ) : null}
          {renderedRegenerationRange ? (
            <TimelineRegenerationRange
              duration={duration ?? timelineDuration}
              range={renderedRegenerationRange}
              pixelsPerSecond={effectivePixelsPerSecond}
              onCancelDrag={cancelRegenerationDrag}
              onEndDrag={endRegenerationDrag}
              onKeyDown={handleRegenerationKeyboard}
              onMoveDrag={moveRegenerationDrag}
              onPointerDown={beginRegenerationDrag}
            />
          ) : null}
          <button
            aria-label="Timeline playhead"
            aria-valuemax={duration || timelineDuration}
            aria-valuemin={0}
            aria-valuenow={renderedPlayheadTime}
            aria-valuetext={formatTimestamp(renderedPlayheadTime, { alwaysHours: true })}
            className={`subtitle-timeline__playhead ${playheadDragTime !== undefined ? 'subtitle-timeline__playhead--dragging' : ''} ${cueSnap?.target.kind === 'playhead' ? 'subtitle-timeline__playhead--snap-target' : ''}`}
            role="slider"
            type="button"
            style={{ transform: `translateX(${renderedPlayheadTime * effectivePixelsPerSecond}px)` }}
            onKeyDown={handlePlayheadKeyboard}
            onPointerCancel={cancelPlayheadDrag}
            onPointerDown={beginPlayheadDrag}
            onPointerMove={movePlayheadDrag}
            onPointerUp={finishPlayheadDrag}
          >
            {playheadDragTime !== undefined ? (
              <span className="subtitle-timeline__playhead-time">
                {formatTimestamp(renderedPlayheadTime, { alwaysHours: true })}
              </span>
            ) : null}
          </button>
          {entries.map((entry) => {
            const renderedEntry = preview?.id === entry.id ? preview : entry
            return (
              <SubtitleTimelineCue
                active={currentTime >= renderedEntry.startTime && currentTime <= renderedEntry.endTime}
                dragging={preview?.id === entry.id}
                entry={renderedEntry}
                issues={issuesById.get(entry.id) ?? EMPTY_ISSUES}
                key={entry.id}
                pixelsPerSecond={effectivePixelsPerSecond}
                selected={entry.id === selectedId}
                snapTarget={snapTarget}
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

type TimelineRegenerationRangeProps = {
  range: RegenerationRange
  duration: number
  pixelsPerSecond: number
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, mode: TimelineDragMode) => void
  onMoveDrag: (event: ReactPointerEvent<HTMLElement>) => void
  onEndDrag: (event: ReactPointerEvent<HTMLElement>) => void
  onCancelDrag: (event: ReactPointerEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>, mode: TimelineDragMode) => void
}

function TimelineRegenerationRange({
  range,
  duration,
  pixelsPerSecond,
  onPointerDown,
  onMoveDrag,
  onEndDrag,
  onCancelDrag,
  onKeyDown,
}: TimelineRegenerationRangeProps) {
  const valueText = `${formatTimestamp(range.startTime, { alwaysHours: true })} to ${formatTimestamp(range.endTime, { alwaysHours: true })}`
  const pointerProps = {
    onPointerCancel: onCancelDrag,
    onPointerMove: onMoveDrag,
    onPointerUp: onEndDrag,
  }

  return (
    <div
      className="subtitle-timeline__regeneration-range"
      style={{
        left: range.startTime * pixelsPerSecond,
        width: Math.max(1, (range.endTime - range.startTime) * pixelsPerSecond),
      }}
    >
      <button
        aria-label="Adjust regeneration range start"
        aria-valuemax={Math.max(0, range.endTime - 0.1)}
        aria-valuemin={0}
        aria-valuenow={range.startTime}
        aria-valuetext={formatTimestamp(range.startTime, { alwaysHours: true })}
        className="subtitle-timeline__regeneration-handle subtitle-timeline__regeneration-handle--start"
        role="slider"
        type="button"
        onKeyDown={(event) => onKeyDown(event, 'start')}
        onPointerDown={(event) => onPointerDown(event, 'start')}
        {...pointerProps}
      />
      <button
        aria-label="Move regeneration range"
        aria-valuemax={Math.max(0, duration - (range.endTime - range.startTime))}
        aria-valuemin={0}
        aria-valuenow={range.startTime}
        aria-valuetext={valueText}
        className="subtitle-timeline__regeneration-body"
        role="slider"
        type="button"
        onKeyDown={(event) => onKeyDown(event, 'move')}
        onPointerDown={(event) => onPointerDown(event, 'move')}
        {...pointerProps}
      >
        <span>{valueText}</span>
      </button>
      <button
        aria-label="Adjust regeneration range end"
        aria-valuemax={Math.min(duration, range.startTime + MAX_REGENERATION_RANGE_SECONDS)}
        aria-valuemin={range.startTime + 0.1}
        aria-valuenow={range.endTime}
        aria-valuetext={formatTimestamp(range.endTime, { alwaysHours: true })}
        className="subtitle-timeline__regeneration-handle subtitle-timeline__regeneration-handle--end"
        role="slider"
        type="button"
        onKeyDown={(event) => onKeyDown(event, 'end')}
        onPointerDown={(event) => onPointerDown(event, 'end')}
        {...pointerProps}
      />
    </div>
  )
}

type SubtitleTimelineCueProps = {
  entry: SubtitleEntry
  pixelsPerSecond: number
  active: boolean
  dragging: boolean
  selected: boolean
  issues: ValidationIssue[]
  snapTarget?: TimelineSnapTarget
  onActivate: (entry: SubtitleEntry) => void
  onPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    entry: SubtitleEntry,
    mode: TimelineDragMode,
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
  snapTarget,
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
  const startIsSnapTarget = snapTarget?.subtitleId === entry.id && snapTarget.kind === 'subtitle-start'
  const endIsSnapTarget = snapTarget?.subtitleId === entry.id && snapTarget.kind === 'subtitle-end'

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
        className={`subtitle-timeline__handle subtitle-timeline__handle--start ${startIsSnapTarget ? 'subtitle-timeline__handle--snap-target' : ''}`}
        type="button"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => onKeyboardEdit(event, entry, 'start')}
        onPointerCancel={onCancelDrag}
        onPointerDown={(event) => {
          event.stopPropagation()
          onPointerDown(event, entry, 'start')
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
        onPointerDown={(event) => onPointerDown(event, entry, 'move')}
        onPointerMove={onMoveDrag}
        onPointerUp={onEndDrag}
      >
        <span className="subtitle-timeline__cue-text">
          <b>{entry.index}</b> {entry.text || 'Empty subtitle'}
        </span>
      </button>
      <button
        aria-label={`Adjust end time for subtitle ${entry.index}`}
        className={`subtitle-timeline__handle subtitle-timeline__handle--end ${endIsSnapTarget ? 'subtitle-timeline__handle--snap-target' : ''}`}
        type="button"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => onKeyboardEdit(event, entry, 'end')}
        onPointerCancel={onCancelDrag}
        onPointerDown={(event) => {
          event.stopPropagation()
          onPointerDown(event, entry, 'end')
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
