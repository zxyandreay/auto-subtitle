import { makeSubtitleEntry, sortAndRenumber } from './formatting'
import type { SubtitleEntry } from '../types/subtitles'
import { parseTimestamp } from '../utils/time'

export type SubtitleImportResult = {
  entries: SubtitleEntry[]
  warnings: string[]
}

export function parseSubtitleFile(fileName: string, content: string): SubtitleImportResult {
  const lowerName = fileName.toLowerCase()

  if (lowerName.endsWith('.srt')) {
    return parseSrt(content)
  }

  if (lowerName.endsWith('.vtt')) {
    return parseVtt(content)
  }

  return {
    entries: [],
    warnings: ['Unsupported subtitle file. Import an SRT or VTT file.'],
  }
}

export function parseSrt(content: string): SubtitleImportResult {
  const warnings: string[] = []
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const blocks = normalized ? normalized.split(/\n{2,}/) : []
  const entries: SubtitleEntry[] = []

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length < 2) {
      continue
    }

    const timeLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeLineIndex === -1) {
      warnings.push(`Skipped block without a timestamp: ${lines[0]}`)
      continue
    }

    const parsed = parseCueTiming(lines[timeLineIndex])
    if (!parsed) {
      warnings.push(`Skipped block with malformed timing: ${lines[timeLineIndex]}`)
      continue
    }

    const text = lines.slice(timeLineIndex + 1).join('\n')
    entries.push(
      makeSubtitleEntry({
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        text,
      }),
    )
  }

  return { entries: sortAndRenumber(entries), warnings }
}

export function parseVtt(content: string): SubtitleImportResult {
  const warnings: string[] = []
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const withoutBom = normalized.replace(/^\uFEFF/, '')
  const lines = withoutBom.split('\n')

  if (!lines[0]?.trim().startsWith('WEBVTT')) {
    warnings.push('Missing WEBVTT header. The file was parsed leniently.')
  }

  const blocks = withoutBom
    .replace(/^WEBVTT[^\n]*(\n|$)/, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  const entries: SubtitleEntry[] = []

  for (const block of blocks) {
    if (block.startsWith('NOTE')) {
      continue
    }

    const blockLines = block.split('\n')
    const timeLineIndex = blockLines.findIndex((line) => line.includes('-->'))
    if (timeLineIndex === -1) {
      continue
    }

    const parsed = parseCueTiming(blockLines[timeLineIndex])
    if (!parsed) {
      warnings.push(`Skipped cue with malformed timing: ${blockLines[timeLineIndex]}`)
      continue
    }

    const text = blockLines.slice(timeLineIndex + 1).join('\n')
    entries.push(
      makeSubtitleEntry({
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        text,
      }),
    )
  }

  return { entries: sortAndRenumber(entries), warnings }
}

function parseCueTiming(line: string): { startTime: number; endTime: number } | null {
  const [startRaw, endRaw] = line.split('-->').map((part) => part.trim().split(/\s+/)[0])
  const startTime = parseTimestamp(startRaw ?? '')
  const endTime = parseTimestamp(endRaw ?? '')

  if (startTime === null || endTime === null) {
    return null
  }

  return { startTime, endTime }
}
