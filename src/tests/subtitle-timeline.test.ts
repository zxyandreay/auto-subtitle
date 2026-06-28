import { describe, expect, it } from 'vitest'
import { makeSubtitleEntry } from '../subtitles/formatting'
import {
  buildTimelineSnapTargets,
  calculateTimelineEdit,
  calculateTimelineEditWithSnap,
  findNearestTimelineSnap,
  type TimelineSnapTarget,
} from '../subtitles/timeline'

const entry = makeSubtitleEntry({ id: 'cue', startTime: 2, endTime: 4, text: 'Move me' })

describe('subtitle timeline timing edits', () => {
  it('chooses the nearest subtitle edge inside a pixel-derived threshold', () => {
    const other = makeSubtitleEntry({ id: 'other', startTime: 5, endTime: 7, text: 'Other' })
    const targets = buildTimelineSnapTargets({
      entries: [entry, other],
      movingSubtitleId: entry.id,
      playhead: 6,
      duration: 10,
    })

    expect(findNearestTimelineSnap(5.08, targets, 0.1)?.target).toMatchObject({
      kind: 'subtitle-start',
      subtitleId: 'other',
      time: 5,
    })
  })

  it('excludes the moving subtitle own edges from snap targets', () => {
    const targets = buildTimelineSnapTargets({ entries: [entry], movingSubtitleId: entry.id })

    expect(targets.some((target) => target.subtitleId === entry.id)).toBe(false)
  })

  it('uses priority to choose subtitle edges over grid targets at the same distance', () => {
    const targets: TimelineSnapTarget[] = [
      snapTarget(4.9, 'grid', 0),
      snapTarget(5.1, 'subtitle-end', 300),
    ]

    expect(findNearestTimelineSnap(5, targets, 0.2)?.target.kind).toBe('subtitle-end')
  })

  it('moves a subtitle while preserving its duration', () => {
    const result = calculateTimelineEdit({
      entry,
      mode: 'move',
      deltaTime: 1.25,
      minDuration: 1.1,
      pixelsPerSecond: 24,
    })

    expect(result).toEqual({ startTime: 3.25, endTime: 5.25 })
  })

  it('clamps a moved subtitle to the known video boundaries', () => {
    expect(
      calculateTimelineEdit({
        entry,
        mode: 'move',
        deltaTime: -5,
        duration: 10,
        minDuration: 1.1,
        pixelsPerSecond: 24,
      }),
    ).toEqual({ startTime: 0, endTime: 2 })

    expect(
      calculateTimelineEdit({
        entry,
        mode: 'move',
        deltaTime: 10,
        duration: 5,
        minDuration: 1.1,
        pixelsPerSecond: 24,
      }),
    ).toEqual({ startTime: 3, endTime: 5 })
  })

  it('resizes start and end without allowing an invalid range', () => {
    expect(
      calculateTimelineEdit({
        entry,
        mode: 'start',
        deltaTime: 5,
        minDuration: 1.1,
        pixelsPerSecond: 24,
      }),
    ).toEqual({ startTime: 2.9, endTime: 4 })

    expect(
      calculateTimelineEdit({
        entry,
        mode: 'end',
        deltaTime: -5,
        minDuration: 1.1,
        pixelsPerSecond: 24,
      }),
    ).toEqual({ startTime: 2, endTime: 3.1 })
  })

  it('snaps to the playhead before a nearby half-second grid mark', () => {
    const snapTargets = buildTimelineSnapTargets({ entries: [], playhead: 1.95 })
    expect(findNearestTimelineSnap(1.94, snapTargets, 10 / 48)?.target.kind).toBe('playhead')
    expect(
      calculateTimelineEditWithSnap({
        entry,
        mode: 'start',
        deltaTime: -0.06,
        minDuration: 1.1,
        pixelsPerSecond: 48,
        snapTargets,
      }).snap?.target.kind,
    ).toBe('playhead')
    expect(
      calculateTimelineEdit({
        entry,
        mode: 'start',
        deltaTime: -0.06,
        minDuration: 1.1,
        pixelsPerSecond: 48,
        playhead: 1.95,
      }),
    ).toEqual({ startTime: 1.95, endTime: 4 })
  })

  it('temporarily disables magnetic snapping', () => {
    const result = calculateTimelineEditWithSnap({
      entry,
      mode: 'start',
      deltaTime: -0.06,
      minDuration: 1.1,
      pixelsPerSecond: 48,
      snapTargets: [snapTarget(1.95, 'playhead', 250)],
      snappingDisabled: true,
    })

    expect(result).toEqual({ timing: { startTime: 1.94, endTime: 4 } })
  })

  it('snaps either body edge while preserving cue duration', () => {
    const result = calculateTimelineEditWithSnap({
      entry,
      mode: 'move',
      deltaTime: 0.96,
      minDuration: 1.1,
      pixelsPerSecond: 24,
      snapTargets: [snapTarget(5, 'subtitle-start', 300)],
    })

    expect(result.timing).toEqual({ startTime: 3, endTime: 5 })
    expect(result.snap?.sourceEdge).toBe('end')
  })

  it('keeps minimum duration when start or end snap targets are invalid', () => {
    expect(
      calculateTimelineEditWithSnap({
        entry,
        mode: 'start',
        deltaTime: 1.45,
        minDuration: 1.1,
        pixelsPerSecond: 48,
        snapTargets: [snapTarget(3.5, 'subtitle-end', 300)],
      }),
    ).toEqual({ timing: { startTime: 2.9, endTime: 4 } })

    expect(
      calculateTimelineEditWithSnap({
        entry,
        mode: 'end',
        deltaTime: -1.45,
        minDuration: 1.1,
        pixelsPerSecond: 48,
        snapTargets: [snapTarget(2.5, 'subtitle-start', 300)],
      }),
    ).toEqual({ timing: { startTime: 2, endTime: 3.1 } })
  })

  it('uses nearby half-second marks when no explicit snap target is close', () => {
    expect(
      calculateTimelineEdit({
        entry,
        mode: 'end',
        deltaTime: 0.46,
        minDuration: 1.1,
        pixelsPerSecond: 48,
      }),
    ).toEqual({ startTime: 2, endTime: 4.5 })
  })

  it('does not silently prevent an overlap that validation should expose', () => {
    const previous = makeSubtitleEntry({ id: 'previous', startTime: 0, endTime: 1.5, text: 'Previous' })

    expect(
      calculateTimelineEdit({
        entry,
        mode: 'move',
        deltaTime: -1,
        minDuration: 1.1,
        pixelsPerSecond: 96,
        previous,
      }),
    ).toEqual({ startTime: 1, endTime: 3 })
  })
})

function snapTarget(
  time: number,
  kind: TimelineSnapTarget['kind'],
  priority: number,
): TimelineSnapTarget {
  return { time, kind, priority, label: kind }
}
