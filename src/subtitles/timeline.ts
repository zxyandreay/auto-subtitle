import type { SubtitleEntry } from '../types/subtitles'
import { roundTime } from '../utils/time'

export type TimelineDragMode = 'start' | 'end' | 'move'

type TimelineEditOptions = {
  entry: SubtitleEntry
  mode: TimelineDragMode
  deltaTime: number
  duration?: number
  minDuration: number
  pixelsPerSecond: number
  playhead?: number
  previous?: SubtitleEntry
  next?: SubtitleEntry
}

type TimelineTiming = Pick<SubtitleEntry, 'startTime' | 'endTime'>

const MIN_VALID_DURATION_SECONDS = 0.1
const SNAP_PIXELS = 6
const MAX_SNAP_SECONDS = 0.15
const GRID_SECONDS = 0.5

export function calculateTimelineEdit({
  entry,
  mode,
  deltaTime,
  duration,
  minDuration,
  pixelsPerSecond,
  playhead,
  previous,
  next,
}: TimelineEditOptions): TimelineTiming {
  const knownDuration = duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined
  const preferredMinimum = Math.max(MIN_VALID_DURATION_SECONDS, minDuration)
  const effectiveMinimum = knownDuration === undefined ? preferredMinimum : Math.min(preferredMinimum, knownDuration)
  const snapThreshold = Math.min(MAX_SNAP_SECONDS, SNAP_PIXELS / Math.max(1, pixelsPerSecond))
  const explicitTargets = [playhead, previous?.endTime, next?.startTime].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  )

  if (mode === 'move') {
    const cueDuration = Math.max(MIN_VALID_DURATION_SECONDS, entry.endTime - entry.startTime)
    let startTime = entry.startTime + deltaTime
    let endTime = startTime + cueDuration

    if (startTime < 0) {
      endTime -= startTime
      startTime = 0
    }
    if (knownDuration !== undefined && endTime > knownDuration) {
      startTime -= endTime - knownDuration
      endTime = knownDuration
    }
    startTime = Math.max(0, startTime)

    const explicitAdjustment = closestMoveAdjustment(startTime, endTime, explicitTargets, snapThreshold)
    const gridAdjustment = closestGridMoveAdjustment(startTime, endTime, snapThreshold)
    const adjustment = explicitAdjustment ?? gridAdjustment ?? 0
    startTime += adjustment
    endTime += adjustment

    if (startTime < 0) {
      endTime -= startTime
      startTime = 0
    }
    if (knownDuration !== undefined && endTime > knownDuration) {
      startTime -= endTime - knownDuration
      endTime = knownDuration
    }

    return { startTime: roundTime(Math.max(0, startTime)), endTime: roundTime(endTime) }
  }

  if (mode === 'start') {
    const rawStart = entry.startTime + deltaTime
    const snappedStart = snapBoundary(rawStart, explicitTargets, snapThreshold)
    const gridStart = snapGrid(rawStart, snapThreshold)
    const maximumStart = entry.endTime - effectiveMinimum
    return {
      startTime: roundTime(Math.max(0, Math.min(snappedStart ?? gridStart ?? rawStart, maximumStart))),
      endTime: roundTime(entry.endTime),
    }
  }

  const rawEnd = entry.endTime + deltaTime
  const snappedEnd = snapBoundary(rawEnd, explicitTargets, snapThreshold)
  const gridEnd = snapGrid(rawEnd, snapThreshold)
  const minimumEnd = entry.startTime + effectiveMinimum
  return {
    startTime: roundTime(entry.startTime),
    endTime: roundTime(Math.max(minimumEnd, Math.min(snappedEnd ?? gridEnd ?? rawEnd, knownDuration ?? Infinity))),
  }
}

function snapBoundary(value: number, targets: number[], threshold: number): number | undefined {
  const target = targets
    .map((candidate) => ({ candidate, distance: Math.abs(candidate - value) }))
    .filter(({ distance }) => distance <= threshold)
    .sort((a, b) => a.distance - b.distance)[0]
  return target?.candidate
}

function snapGrid(value: number, threshold: number): number | undefined {
  const target = Math.round(value / GRID_SECONDS) * GRID_SECONDS
  return Math.abs(target - value) <= threshold ? target : undefined
}

function closestMoveAdjustment(
  startTime: number,
  endTime: number,
  targets: number[],
  threshold: number,
): number | undefined {
  const adjustment = targets
    .flatMap((target) => [target - startTime, target - endTime])
    .filter((value) => Math.abs(value) <= threshold)
    .sort((a, b) => Math.abs(a) - Math.abs(b))[0]
  return adjustment
}

function closestGridMoveAdjustment(startTime: number, endTime: number, threshold: number): number | undefined {
  const adjustments = [
    Math.round(startTime / GRID_SECONDS) * GRID_SECONDS - startTime,
    Math.round(endTime / GRID_SECONDS) * GRID_SECONDS - endTime,
  ]
  return adjustments.filter((value) => Math.abs(value) <= threshold).sort((a, b) => Math.abs(a) - Math.abs(b))[0]
}
