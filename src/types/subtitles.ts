export type SubtitleWord = {
  text: string
  startTime: number
  endTime: number
  confidence?: number
}

export type SubtitleEntry = {
  id: string
  index: number
  startTime: number
  endTime: number
  text: string
  confidence?: number
  words?: SubtitleWord[]
}

export type ValidationLevel = 'error' | 'warning'

export type ValidationIssue = {
  entryId: string
  level: ValidationLevel
  code: string
  message: string
}

export type FormattingPreferences = {
  maxCharsPerLine: number
  maxCharsPerSubtitle: number
  minDuration: number
  maxDuration: number
  gapBetweenSubtitles: number
  useWordTimestamps: boolean
}

export const DEFAULT_FORMATTING_PREFERENCES: FormattingPreferences = {
  maxCharsPerLine: 42,
  maxCharsPerSubtitle: 84,
  minDuration: 1.1,
  maxDuration: 6,
  gapBetweenSubtitles: 0.04,
  useWordTimestamps: true,
}

export type ProjectMetadata = {
  appName: 'Auto Subtitles'
  schemaVersion: 1
  exportedAt: string
  videoFileName?: string
  videoSize?: number
  videoDuration?: number
}

export type AutoSubtitlesProject = {
  metadata: ProjectMetadata
  subtitles: SubtitleEntry[]
  formatting: FormattingPreferences
  transcriptionSettings?: Record<string, unknown>
}
