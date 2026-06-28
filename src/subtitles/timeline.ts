import type { SubtitleEntry } from '../types/subtitles'
import { roundTime } from '../utils/time'

export type TimelineDragMode = 'start' | 'end' | 'move'

export type TimelineSnapTargetKind =
  | 'subtitle-start'
  | 'subtitle-end'
  | 'playhead'
  | 'timeline-start'
  | 'timeline-end'
  | 'grid'

export type TimelineSnapTarget = {
  time: number
  kind: TimelineSnapTargetKind
  subtitleId?: string
  label: string
  priority: number
}

export type TimelineSnapMatch = {
  target: TimelineSnapTarget
  distance: number
  sourceEdge?: 'start' | 'end'
}

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
  snapTargets?: TimelineSnapTarget[]
  snappingDisabled?: boolean
}

type TimelineTiming = Pick<SubtitleEntry, 'startTime' | 'endTime'>

export type TimelineEditResult = {
  timing: TimelineTiming
  snap?: TimelineSnapMatch
}

type BuildTimelineSnapTargetsOptions = {
  entries: SubtitleEntry[]
  movingSubtitleId?: string
  playhead?: number
  duration?: number
}

const MIN_VALID_DURATION_SECONDS = 0.1
export const TIMELINE_SNAP_PIXELS = 10
const GRID_SNAP_PIXELS = 4
const MAX_GRID_SNAP_SECONDS = 0.1
const GRID_SECONDS = 0.5
const SNAP_PRIORITY = {
  subtitle: 300,
  playhead: 250,
  boundary: 200,
  grid: 100,
} as const

export function buildTimelineSnapTargets({
  entries,
  movingSubtitleId,
  playhead,
  duration,
}: BuildTimelineSnapTargetsOptions): TimelineSnapTarget[] {
  const targets: TimelineSnapTarget[] = []

  for (const entry of entries) {
    if (entry.id === movingSubtitleId) {
      continue
    }
    targets.push(
      {
        time: entry.startTime,
        kind: 'subtitle-start',
        subtitleId: entry.id,
        label: `subtitle ${entry.index} start`,
        priority: SNAP_PRIORITY.subtitle,
      },
      {
        time: entry.endTime,
        kind: 'subtitle-end',
        subtitleId: entry.id,
        label: `subtitle ${entry.index} end`,
        priority: SNAP_PRIORITY.subtitle,
      },
    )
  }

  if (isFiniteTime(playhead)) {
    targets.push({
      time: playhead,
      kind: 'playhead',
      label: 'playhead',
      priority: SNAP_PRIORITY.playhead,
    })
  }

  targets.push({
    time: 0,
    kind: 'timeline-start',
    label: 'timeline start',
    priority: SNAP_PRIORITY.boundary,
  })

  if (isFiniteTime(duration) && duration > 0) {
    targets.push({
      time: duration,
      kind: 'timeline-end',
      label: 'video end',
      priority: SNAP_PRIORITY.boundary,
    })
  }

  return targets
}

export function findNearestTimelineSnap(
  time: number,
  targets: TimelineSnapTarget[],
  thresholdSeconds: number,
): TimelineSnapMatch | undefined {
  return targets
    .filter((target) => Number.isFinite(target.time))
    .map((target) => ({ target, distance: Math.abs(target.time - time) }))
    .filter(({ distance }) => distance <= thresholdSeconds)
    .sort(compareSnapMatches)[0]
}

export function calculateTimelineEdit(options: TimelineEditOptions): TimelineTiming {
  return calculateTimelineEditWithSnap(options).timing
}

export function calculateTimelineEditWithSnap({
  entry,
  mode,
  deltaTime,
  duration,
  minDuration,
  pixelsPerSecond,
  playhead,
  previous,
  next,
  snapTargets,
  snappingDisabled = false,
}: TimelineEditOptions): TimelineEditResult {
  const knownDuration = isFiniteTime(duration) && duration > 0 ? duration : undefined
  const preferredMinimum = Math.max(MIN_VALID_DURATION_SECONDS, minDuration)
  const effectiveMinimum = knownDuration === undefined ? preferredMinimum : Math.min(preferredMinimum, knownDuration)
  const snapThreshold = TIMELINE_SNAP_PIXELS / Math.max(0.01, pixelsPerSecond)
  const gridThreshold = Math.min(MAX_GRID_SNAP_SECONDS, GRID_SNAP_PIXELS / Math.max(0.01, pixelsPerSecond))
  const targets = snapTargets ?? legacySnapTargets(playhead, previous, next, knownDuration)

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

    const snap = snappingDisabled
      ? undefined
      : findMoveSnap(startTime, endTime, targets, snapThreshold, gridThreshold, knownDuration)
    if (snap) {
      const sourceTime = snap.sourceEdge === 'start' ? startTime : endTime
      const adjustment = snap.target.time - sourceTime
      startTime += adjustment
      endTime += adjustment
    }

    return {
      timing: {
        startTime: roundTime(Math.max(0, startTime)),
        endTime: roundTime(Math.min(endTime, knownDuration ?? Infinity)),
      },
      snap,
    }
  }

  if (mode === 'start') {
    const rawStart = entry.startTime + deltaTime
    const maximumStart = entry.endTime - effectiveMinimum
    const validTargets = targets.filter((target) => target.time >= 0 && target.time <= maximumStart)
    const snap = snappingDisabled
      ? undefined
      : findBoundarySnap(rawStart, validTargets, snapThreshold, gridThreshold, 0, maximumStart, 'start')
    return {
      timing: {
        startTime: roundTime(Math.max(0, Math.min(snap?.target.time ?? rawStart, maximumStart))),
        endTime: roundTime(entry.endTime),
      },
      snap,
    }
  }

  const rawEnd = entry.endTime + deltaTime
  const minimumEnd = entry.startTime + effectiveMinimum
  const maximumEnd = knownDuration ?? Infinity
  const validTargets = targets.filter((target) => target.time >= minimumEnd && target.time <= maximumEnd)
  const snap = snappingDisabled
    ? undefined
    : findBoundarySnap(rawEnd, validTargets, snapThreshold, gridThreshold, minimumEnd, maximumEnd, 'end')
  return {
    timing: {
      startTime: roundTime(entry.startTime),
      endTime: roundTime(Math.max(minimumEnd, Math.min(snap?.target.time ?? rawEnd, maximumEnd))),
    },
    snap,
  }
}

export function snapTimelineTime(
  time: number,
  targets: TimelineSnapTarget[],
  pixelsPerSecond: number,
  snappingDisabled = false,
): { time: number; snap?: TimelineSnapMatch } {
  if (snappingDisabled) {
    return { time: roundTime(time) }
  }
  const snapThreshold = TIMELINE_SNAP_PIXELS / Math.max(0.01, pixelsPerSecond)
  const gridThreshold = Math.min(MAX_GRID_SNAP_SECONDS, GRID_SNAP_PIXELS / Math.max(0.01, pixelsPerSecond))
  const snap = findBoundarySnap(time, targets, snapThreshold, gridThreshold)
  return { time: roundTime(snap?.target.time ?? time), snap }
}

function findMoveSnap(
  startTime: number,
  endTime: number,
  targets: TimelineSnapTarget[],
  threshold: number,
  gridThreshold: number,
  duration?: number,
): TimelineSnapMatch | undefined {
  return (['start', 'end'] as const)
    .map((sourceEdge) => {
      const sourceTime = sourceEdge === 'start' ? startTime : endTime
      const minimumTarget = sourceEdge === 'start' ? 0 : endTime - startTime
      const maximumTarget = sourceEdge === 'start' ? (duration ?? Infinity) - (endTime - startTime) : duration ?? Infinity
      const validTargets = targets.filter((target) => target.time >= minimumTarget && target.time <= maximumTarget)
      return findBoundarySnap(
        sourceTime,
        validTargets,
        threshold,
        gridThreshold,
        minimumTarget,
        maximumTarget,
        sourceEdge,
      )
    })
    .filter((match): match is TimelineSnapMatch => Boolean(match))
    .sort(compareSnapMatches)[0]
}

function findBoundarySnap(
  time: number,
  targets: TimelineSnapTarget[],
  threshold: number,
  gridThreshold: number,
  minimum = -Infinity,
  maximum = Infinity,
  sourceEdge?: 'start' | 'end',
): TimelineSnapMatch | undefined {
  const candidates = [...targets]
  const gridTime = Math.round(time / GRID_SECONDS) * GRID_SECONDS
  if (gridTime >= minimum && gridTime <= maximum && Math.abs(gridTime - time) <= gridThreshold) {
    candidates.push({
      time: gridTime,
      kind: 'grid',
      label: 'half-second grid',
      priority: SNAP_PRIORITY.grid,
    })
  }
  const match = findNearestTimelineSnap(time, candidates, threshold)
  return match ? { ...match, sourceEdge } : undefined
}

function legacySnapTargets(
  playhead?: number,
  previous?: SubtitleEntry,
  next?: SubtitleEntry,
  duration?: number,
): TimelineSnapTarget[] {
  const entries = [previous, next].filter((entry): entry is SubtitleEntry => Boolean(entry))
  return buildTimelineSnapTargets({ entries, playhead, duration }).filter((target) => {
    if (previous && target.subtitleId === previous.id) {
      return target.kind === 'subtitle-end'
    }
    if (next && target.subtitleId === next.id) {
      return target.kind === 'subtitle-start'
    }
    return true
  })
}

function compareSnapMatches(first: TimelineSnapMatch, second: TimelineSnapMatch): number {
  const distanceDifference = first.distance - second.distance
  if (Math.abs(distanceDifference) > 1e-9) {
    return distanceDifference
  }
  return second.target.priority - first.target.priority
}

function isFiniteTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}
