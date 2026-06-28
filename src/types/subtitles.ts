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
  subtitleLeadIn: number
  subtitleTailPadding: number
  targetMaxCps: number
  hardMaxCps: number
  closeGapsBelow: number
}

export const DEFAULT_FORMATTING_PREFERENCES: FormattingPreferences = {
  maxCharsPerLine: 42,
  maxCharsPerSubtitle: 84,
  minDuration: 1.1,
  maxDuration: 6,
  gapBetweenSubtitles: 0.08,
  useWordTimestamps: true,
  subtitleLeadIn: 0.08,
  subtitleTailPadding: 0.18,
  targetMaxCps: 20,
  hardMaxCps: 21,
  closeGapsBelow: 0.5,
}

export type ProjectMetadata = {
  appName: 'Auto Subtitle'
  schemaVersion: 1
  exportedAt: string
  videoFileName?: string
  videoSize?: number
  videoDuration?: number
}

export type AutoSubtitleProject = {
  metadata: ProjectMetadata
  subtitles: SubtitleEntry[]
  formatting: FormattingPreferences
  transcriptionSettings?: Record<string, unknown>
}
