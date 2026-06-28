import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  buildTimelineSnapTargets,
  calculateTimelineEditWithSnap,
  type TimelineDragMode,
  type TimelineSnapMatch,
} from '../subtitles/timeline'
import type { SubtitleEntry } from '../types/subtitles'

type DragState = {
  entry: SubtitleEntry
  mode: TimelineDragMode
  pointerId: number
  startClientX: number
  captureElement: HTMLElement
  moved: boolean
}

type UseSubtitleTimelineDragOptions = {
  entries: SubtitleEntry[]
  duration?: number
  minDuration: number
  pixelsPerSecond: number
  playhead: number
  onUpdate: (id: string, patch: Pick<SubtitleEntry, 'startTime' | 'endTime'>) => void
}

export function useSubtitleTimelineDrag({
  entries,
  duration,
  minDuration,
  pixelsPerSecond,
  playhead,
  onUpdate,
}: UseSubtitleTimelineDragOptions) {
  const dragRef = useRef<DragState | null>(null)
  const suppressClickIdRef = useRef<string | undefined>(undefined)
  const playheadRef = useRef(playhead)
  const [preview, setPreview] = useState<SubtitleEntry>()
  const [activeSnap, setActiveSnap] = useState<TimelineSnapMatch>()
  playheadRef.current = playhead

  const calculate = useCallback(
    (drag: DragState, clientX: number, snappingDisabled: boolean) => {
      return calculateTimelineEditWithSnap({
        entry: drag.entry,
        mode: drag.mode,
        deltaTime: (clientX - drag.startClientX) / Math.max(0.01, pixelsPerSecond),
        duration,
        minDuration,
        pixelsPerSecond,
        snapTargets: buildTimelineSnapTargets({
          entries,
          movingSubtitleId: drag.entry.id,
          playhead: playheadRef.current,
          duration,
        }),
        snappingDisabled,
      })
    },
    [duration, entries, minDuration, pixelsPerSecond],
  )

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, entry: SubtitleEntry, mode: TimelineDragMode) => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        entry,
        mode,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        captureElement: event.currentTarget,
        moved: false,
      }
      setPreview(entry)
      setActiveSnap(undefined)
    },
    [],
  )

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) {
        return
      }
      event.preventDefault()
      const result = calculate(drag, event.clientX, event.altKey)
      drag.moved ||= Math.abs(event.clientX - drag.startClientX) >= 3
      setPreview({ ...drag.entry, ...result.timing })
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
      const result = calculate(drag, event.clientX, event.altKey)
      if (drag.moved) {
        suppressClickIdRef.current = drag.entry.id
      }
      dragRef.current = null
      setPreview(undefined)
      setActiveSnap(undefined)
      try {
        drag.captureElement.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture may already be released by the browser.
      }
      if (
        result.timing.startTime !== drag.entry.startTime ||
        result.timing.endTime !== drag.entry.endTime
      ) {
        onUpdate(drag.entry.id, result.timing)
      }
    },
    [calculate, onUpdate],
  )

  const cancelDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    setPreview(undefined)
    setActiveSnap(undefined)
    try {
      drag.captureElement.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }, [])

  const shouldSuppressClick = useCallback((id: string) => {
    if (suppressClickIdRef.current !== id) {
      return false
    }
    suppressClickIdRef.current = undefined
    return true
  }, [])

  return { activeSnap, beginDrag, cancelDrag, endDrag, moveDrag, preview, shouldSuppressClick }
}
