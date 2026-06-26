import type { SubtitleEntry, ValidationIssue } from '../types/subtitles'

export function validateSubtitles(entries: SubtitleEntry[], duration?: number): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const sorted = [...entries].sort((a, b) => a.startTime - b.startTime)

  for (const entry of sorted) {
    if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.endTime)) {
      issues.push(issue(entry.id, 'error', 'malformed-time', 'Timestamp is not a valid number.'))
    }

    if (entry.startTime < 0 || entry.endTime < 0) {
      issues.push(issue(entry.id, 'error', 'negative-time', 'Timestamp cannot be negative.'))
    }

    if (entry.endTime <= entry.startTime) {
      issues.push(issue(entry.id, 'error', 'invalid-range', 'End time must be after start time.'))
    }

    if (duration !== undefined && (entry.startTime > duration || entry.endTime > duration)) {
      issues.push(issue(entry.id, 'warning', 'beyond-duration', 'Timestamp is beyond the video duration.'))
    }

    if (!entry.text.trim()) {
      issues.push(issue(entry.id, 'warning', 'empty-text', 'Subtitle text is empty.'))
    }
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]

    if (current.startTime < previous.endTime) {
      issues.push(issue(current.id, 'error', 'overlap', 'This subtitle overlaps the previous entry.'))
      issues.push(issue(previous.id, 'error', 'overlap', 'This subtitle overlaps the next entry.'))
    }
  }

  return issues
}

export function getIssuesForEntry(
  entryId: string,
  entries: SubtitleEntry[],
  duration?: number,
): ValidationIssue[] {
  return validateSubtitles(entries, duration).filter((item) => item.entryId === entryId)
}

function issue(entryId: string, level: 'error' | 'warning', code: string, message: string): ValidationIssue {
  return { entryId, level, code, message }
}
