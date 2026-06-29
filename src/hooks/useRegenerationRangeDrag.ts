import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  buildTimelineSnapTargets,
  calculateTimelineEditWithSnap,
  type TimelineDragMode,
  type TimelineSnapMatch,
} from '../subtitles/timeline'
import { MAX_REGENERATION_RANGE_SECONDS } from '../transcription/regeneration'
import type { RegenerationRange } from '../transcription/types'
import type { SubtitleEntry } from '../types/subtitles'

type DragState = {
  range: RegenerationRange
  mode: TimelineDragMode
  pointerId: number
  startClientX: number
  captureElement: HTMLElement
}

type UseRegenerationRangeDragOptions = {
  entries: SubtitleEntry[]
  range?: RegenerationRange
  duration?: number
  pixelsPerSecond: number
  playhead: number
  snappingEnabled: boolean
  onChange: (range: RegenerationRange) => void
}

const MIN_REGENERATION_RANGE_SECONDS = 0.1

export function useRegenerationRangeDrag({
  entries,
  range,
  duration,
  pixelsPerSecond,
  playhead,
  snappingEnabled,
  onChange,
}: UseRegenerationRangeDragOptions) {
  const dragRef = useRef<DragState | null>(null)
  const playheadRef = useRef(playhead)
  const [preview, setPreview] = useState<RegenerationRange>()
  const [activeSnap, setActiveSnap] = useState<TimelineSnapMatch>()
  playheadRef.current = playhead

  const calculate = useCallback(
    (drag: DragState, clientX: number, snappingBypassed: boolean) => {
      return calculateTimelineEditWithSnap({
        entry: rangeAsEntry(drag.range),
        mode: drag.mode,
        deltaTime: (clientX - drag.startClientX) / Math.max(0.01, pixelsPerSecond),
        duration,
        minDuration: MIN_REGENERATION_RANGE_SECONDS,
        maxDuration: MAX_REGENERATION_RANGE_SECONDS,
        pixelsPerSecond,
        snapTargets: buildTimelineSnapTargets({ entries, playhead: playheadRef.current, duration }),
        snappingDisabled: !snappingEnabled || snappingBypassed,
      })
    },
    [duration, entries, pixelsPerSecond, snappingEnabled],
  )

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, mode: TimelineDragMode) => {
      if (event.button !== 0 || !range) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        range,
        mode,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        captureElement: event.currentTarget,
      }
      setPreview(range)
      setActiveSnap(undefined)
    },
    [range],
  )

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const result = calculate(drag, event.clientX, event.altKey)
      setPreview(result.timing)
      setActiveSnap(result.snap)
    },
    [calculate],
  )

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const result = calculate(drag, event.clientX, event.altKey)
      dragRef.current = null
      setPreview(undefined)
      setActiveSnap(undefined)
      try {
        drag.captureElement.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture may already be released by the browser.
      }
      if (
        result.timing.startTime !== drag.range.startTime ||
        result.timing.endTime !== drag.range.endTime
      ) {
        onChange(result.timing)
      }
    },
    [calculate, onChange],
  )

  const cancelDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
    setPreview(undefined)
    setActiveSnap(undefined)
    try {
      drag.captureElement.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }, [])

  return { activeSnap, beginDrag, cancelDrag, endDrag, moveDrag, preview }
}

function rangeAsEntry(range: RegenerationRange): SubtitleEntry {
  return {
    id: 'timeline-regeneration-range',
    index: 0,
    startTime: range.startTime,
    endTime: range.endTime,
    text: '',
  }
}
