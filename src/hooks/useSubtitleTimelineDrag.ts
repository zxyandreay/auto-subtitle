import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { calculateTimelineEdit, type TimelineDragMode } from '../subtitles/timeline'
import type { SubtitleEntry } from '../types/subtitles'

type DragState = {
  entry: SubtitleEntry
  mode: TimelineDragMode
  pointerId: number
  startClientX: number
  captureElement: HTMLElement
  previous?: SubtitleEntry
  next?: SubtitleEntry
  moved: boolean
}

type UseSubtitleTimelineDragOptions = {
  duration?: number
  minDuration: number
  pixelsPerSecond: number
  playhead: number
  onUpdate: (id: string, patch: Pick<SubtitleEntry, 'startTime' | 'endTime'>) => void
}

export function useSubtitleTimelineDrag({
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
  playheadRef.current = playhead

  const calculate = useCallback(
    (drag: DragState, clientX: number) => {
      return calculateTimelineEdit({
        entry: drag.entry,
        mode: drag.mode,
        deltaTime: (clientX - drag.startClientX) / Math.max(1, pixelsPerSecond),
        duration,
        minDuration,
        pixelsPerSecond,
        playhead: playheadRef.current,
        previous: drag.previous,
        next: drag.next,
      })
    },
    [duration, minDuration, pixelsPerSecond],
  )

  const beginDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      entry: SubtitleEntry,
      mode: TimelineDragMode,
      previous?: SubtitleEntry,
      next?: SubtitleEntry,
    ) => {
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
        previous,
        next,
        moved: false,
      }
      setPreview(entry)
    },
    [],
  )

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) {
        return
      }
      const timing = calculate(drag, event.clientX)
      drag.moved ||= Math.abs(event.clientX - drag.startClientX) >= 3
      setPreview({ ...drag.entry, ...timing })
    },
    [calculate],
  )

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) {
        return
      }
      const timing = calculate(drag, event.clientX)
      if (drag.moved) {
        suppressClickIdRef.current = drag.entry.id
      }
      dragRef.current = null
      setPreview(undefined)
      try {
        drag.captureElement.releasePointerCapture(event.pointerId)
      } catch {
        // Pointer capture may already be released by the browser.
      }
      if (
        timing.startTime !== drag.entry.startTime ||
        timing.endTime !== drag.entry.endTime
      ) {
        onUpdate(drag.entry.id, timing)
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

  return { beginDrag, cancelDrag, endDrag, moveDrag, preview, shouldSuppressClick }
}
