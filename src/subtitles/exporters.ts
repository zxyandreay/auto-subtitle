import { sortAndRenumber } from './formatting'
import { validateSubtitles } from './validation'
import type { AutoSubtitlesProject, FormattingPreferences, SubtitleEntry } from '../types/subtitles'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'
import { formatSrtTimestamp, formatVttTimestamp } from '../utils/time'

export function exportSrt(entries: SubtitleEntry[]): string {
  const validEntries = exportableEntries(entries)
  const body = validEntries
    .map(
      (entry, index) =>
        `${index + 1}\n${formatSrtTimestamp(entry.startTime)} --> ${formatSrtTimestamp(entry.endTime)}\n${entry.text.trim()}`,
    )
    .join('\n\n')

  return `${body}\n`
}

export function exportVtt(entries: SubtitleEntry[]): string {
  const validEntries = exportableEntries(entries)
  const body = validEntries
    .map(
      (entry) =>
        `${formatVttTimestamp(entry.startTime)} --> ${formatVttTimestamp(entry.endTime)}\n${entry.text.trim()}`,
    )
    .join('\n\n')

  return `WEBVTT\n\n${body}\n`
}

export function exportTranscript(entries: SubtitleEntry[], includeTimestamps: boolean): string {
  return exportableEntries(entries)
    .map((entry) => {
      if (!includeTimestamps) {
        return entry.text.replace(/\n/g, ' ')
      }

      return `[${formatVttTimestamp(entry.startTime)}] ${entry.text.replace(/\n/g, ' ')}`
    })
    .join('\n')
}

export function createProjectExport(
  entries: SubtitleEntry[],
  formatting: FormattingPreferences,
  metadata: {
    videoFileName?: string
    videoSize?: number
    videoDuration?: number
  },
  transcriptionSettings?: Record<string, unknown>,
): AutoSubtitlesProject {
  return {
    metadata: {
      appName: 'Auto Subtitles',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      ...metadata,
    },
    subtitles: sortAndRenumber(entries),
    formatting,
    transcriptionSettings,
  }
}

export function exportProjectJson(project: AutoSubtitlesProject): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

export function parseProjectJson(content: string): { project?: AutoSubtitlesProject; errors: string[] } {
  try {
    const parsed = JSON.parse(content) as unknown
    return validateProject(parsed)
  } catch (error) {
    return {
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`],
    }
  }
}

export function validateProject(value: unknown): { project?: AutoSubtitlesProject; errors: string[] } {
  const errors: string[] = []

  if (!isRecord(value)) {
    return { errors: ['Project file must contain an object.'] }
  }

  const metadata = value.metadata
  if (!isRecord(metadata) || metadata.appName !== 'Auto Subtitles' || metadata.schemaVersion !== 1) {
    errors.push('Project metadata is missing or uses an unsupported schema.')
  }

  if (!Array.isArray(value.subtitles)) {
    errors.push('Project subtitles must be an array.')
  }

  const subtitles = Array.isArray(value.subtitles)
    ? value.subtitles.flatMap((entry, index) => normalizeProjectEntry(entry, index, errors))
    : []

  const formatting = normalizeFormatting(value.formatting)
  const project: AutoSubtitlesProject = {
    metadata: {
      appName: 'Auto Subtitles',
      schemaVersion: 1,
      exportedAt:
        isRecord(metadata) && typeof metadata.exportedAt === 'string'
          ? metadata.exportedAt
          : new Date().toISOString(),
      videoFileName: isRecord(metadata) && typeof metadata.videoFileName === 'string' ? metadata.videoFileName : undefined,
      videoSize: isRecord(metadata) && typeof metadata.videoSize === 'number' ? metadata.videoSize : undefined,
      videoDuration:
        isRecord(metadata) && typeof metadata.videoDuration === 'number' ? metadata.videoDuration : undefined,
    },
    subtitles: sortAndRenumber(subtitles),
    formatting,
    transcriptionSettings: isRecord(value.transcriptionSettings) ? value.transcriptionSettings : undefined,
  }

  const validationErrors = validateSubtitles(project.subtitles, project.metadata.videoDuration)
    .filter((issue) => issue.level === 'error')
    .map((issue) => `Subtitle ${issue.entryId}: ${issue.message}`)

  return { project: errors.length === 0 ? project : undefined, errors: [...errors, ...validationErrors] }
}

function exportableEntries(entries: SubtitleEntry[]): SubtitleEntry[] {
  const invalidIds = new Set(
    validateSubtitles(entries)
      .filter((issue) => issue.level === 'error')
      .map((issue) => issue.entryId),
  )

  return sortAndRenumber(entries).filter((entry) => !invalidIds.has(entry.id) && entry.text.trim())
}

function normalizeProjectEntry(entry: unknown, index: number, errors: string[]): SubtitleEntry[] {
  if (!isRecord(entry)) {
    errors.push(`Subtitle ${index + 1} is not an object.`)
    return []
  }

  if (
    typeof entry.startTime !== 'number' ||
    typeof entry.endTime !== 'number' ||
    typeof entry.text !== 'string'
  ) {
    errors.push(`Subtitle ${index + 1} is missing text or numeric timestamps.`)
    return []
  }

  return [
    {
      id: typeof entry.id === 'string' ? entry.id : `imported-${index + 1}`,
      index: index + 1,
      startTime: entry.startTime,
      endTime: entry.endTime,
      text: entry.text,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
      words: Array.isArray(entry.words) ? entry.words.filter(isWord) : undefined,
    },
  ]
}

function normalizeFormatting(value: unknown): FormattingPreferences {
  if (!isRecord(value)) {
    return DEFAULT_FORMATTING_PREFERENCES
  }

  return {
    maxCharsPerLine: numberOrDefault(value.maxCharsPerLine, DEFAULT_FORMATTING_PREFERENCES.maxCharsPerLine),
    maxCharsPerSubtitle: numberOrDefault(
      value.maxCharsPerSubtitle,
      DEFAULT_FORMATTING_PREFERENCES.maxCharsPerSubtitle,
    ),
    minDuration: numberOrDefault(value.minDuration, DEFAULT_FORMATTING_PREFERENCES.minDuration),
    maxDuration: numberOrDefault(value.maxDuration, DEFAULT_FORMATTING_PREFERENCES.maxDuration),
    gapBetweenSubtitles: numberOrDefault(
      value.gapBetweenSubtitles,
      DEFAULT_FORMATTING_PREFERENCES.gapBetweenSubtitles,
    ),
    useWordTimestamps:
      typeof value.useWordTimestamps === 'boolean'
        ? value.useWordTimestamps
        : DEFAULT_FORMATTING_PREFERENCES.useWordTimestamps,
  }
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    typeof value.startTime === 'number' &&
    typeof value.endTime === 'number'
  )
}
