import { sortAndRenumber } from './formatting'
import { validateSubtitles } from './validation'
import type { AutoSubtitleProject, FormattingPreferences, SubtitleEntry } from '../types/subtitles'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  normalizeFormattingPreferences,
  normalizeTranscriptionSettings,
} from '../transcription/types'
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
): AutoSubtitleProject {
  return {
    metadata: {
      appName: 'Auto Subtitle',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      ...metadata,
    },
    subtitles: sortAndRenumber(entries),
    formatting,
    transcriptionSettings,
  }
}

export function exportProjectJson(project: AutoSubtitleProject): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

export function parseProjectJson(
  content: string,
): { project?: AutoSubtitleProject; errors: string[]; warnings: string[] } {
  try {
    const parsed = JSON.parse(content) as unknown
    return validateProject(parsed)
  } catch (error) {
    return {
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`],
      warnings: [],
    }
  }
}

export function validateProject(value: unknown): {
  project?: AutoSubtitleProject
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []

  if (!isRecord(value)) {
    return { errors: ['Project file must contain an object.'], warnings: [] }
  }

  const metadata = value.metadata
  if (!isRecord(metadata) || metadata.appName !== 'Auto Subtitle' || metadata.schemaVersion !== 1) {
    errors.push('Project metadata is missing or uses an unsupported schema.')
  }

  if (!Array.isArray(value.subtitles)) {
    errors.push('Project subtitles must be an array.')
  }

  const subtitles = Array.isArray(value.subtitles)
    ? value.subtitles.flatMap((entry, index) => normalizeProjectEntry(entry, index, errors))
    : []

  const formatting = normalizeFormattingPreferences(value.formatting, DEFAULT_FORMATTING_PREFERENCES)
  const normalizedTranscriptionSettings = isRecord(value.transcriptionSettings)
    ? normalizeTranscriptionSettings(value.transcriptionSettings, {
        ...DEFAULT_TRANSCRIPTION_SETTINGS,
        formatting,
      })
    : undefined
  const project: AutoSubtitleProject = {
    metadata: {
      appName: 'Auto Subtitle',
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
    transcriptionSettings: normalizedTranscriptionSettings
      ? { ...normalizedTranscriptionSettings.settings, formatting }
      : undefined,
  }

  const validationErrors = validateSubtitles(project.subtitles, project.metadata.videoDuration)
    .filter((issue) => issue.level === 'error')
    .map((issue) => `Subtitle ${issue.entryId}: ${issue.message}`)

  return {
    project: errors.length === 0 ? project : undefined,
    errors: [...errors, ...validationErrors],
    warnings: normalizedTranscriptionSettings?.reason ? [normalizedTranscriptionSettings.reason] : [],
  }
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
