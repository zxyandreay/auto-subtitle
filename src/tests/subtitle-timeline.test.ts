import { describe, expect, it } from 'vitest'
import { makeSubtitleEntry } from '../subtitles/formatting'
import { calculateTimelineEdit } from '../subtitles/timeline'

const entry = makeSubtitleEntry({ id: 'cue', startTime: 2, endTime: 4, text: 'Move me' })

describe('subtitle timeline timing edits', () => {
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
