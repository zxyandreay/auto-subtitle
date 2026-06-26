import { describe, expect, it } from 'vitest'
import {
  calculateCharactersPerSecond,
  formatSubtitleText,
  formatTranscriptionSegments,
  makeSubtitleEntry,
  mergeEntries,
  type RawTranscriptionSegment,
  shiftEntries,
  sortAndRenumber,
  splitEntry,
} from '../subtitles/formatting'
import { createProjectExport, exportSrt, exportVtt, parseProjectJson } from '../subtitles/exporters'
import { parseSrt, parseVtt } from '../subtitles/importers'
import { validateSubtitles } from '../subtitles/validation'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'
import { formatSrtTimestamp, formatVttTimestamp, parseTimestamp } from '../utils/time'

describe('timestamp utilities', () => {
  it('parses supported timestamp formats', () => {
    expect(parseTimestamp('00:01:02.345')).toBe(62.345)
    expect(parseTimestamp('01:02.345')).toBe(62.345)
    expect(parseTimestamp('62.345')).toBe(62.345)
    expect(parseTimestamp('00:01:02,345')).toBe(62.345)
  })

  it('rejects malformed timestamps', () => {
    expect(parseTimestamp('-1')).toBeNull()
    expect(parseTimestamp('01:99.000')).toBeNull()
    expect(parseTimestamp('not a time')).toBeNull()
  })

  it('formats SRT and VTT timestamps', () => {
    expect(formatSrtTimestamp(3723.4)).toBe('01:02:03,400')
    expect(formatVttTimestamp(3723.4)).toBe('01:02:03.400')
  })
})

describe('subtitle import and export', () => {
  it('generates valid SRT', () => {
    const srt = exportSrt([
      makeSubtitleEntry({ startTime: 1.2, endTime: 3.85, text: 'This is an example subtitle.' }),
    ])

    expect(srt).toBe('1\n00:00:01,200 --> 00:00:03,850\nThis is an example subtitle.\n')
  })

  it('generates valid VTT', () => {
    const vtt = exportVtt([
      makeSubtitleEntry({ startTime: 1.2, endTime: 3.85, text: 'This is an example subtitle.' }),
    ])

    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:01.200 --> 00:00:03.850')
  })

  it('parses SRT and preserves line breaks', () => {
    const result = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nHello\nworld\n')

    expect(result.warnings).toEqual([])
    expect(result.entries[0].text).toBe('Hello\nworld')
    expect(result.entries[0].startTime).toBe(1)
  })

  it('parses VTT cues', () => {
    const result = parseVtt('WEBVTT\n\n00:00:03.000 --> 00:00:04.500\nA cue\n')

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].endTime).toBe(4.5)
  })
})

describe('subtitle editing logic', () => {
  it('sorts and renumbers entries', () => {
    const entries = sortAndRenumber([
      makeSubtitleEntry({ startTime: 5, endTime: 6, text: 'second' }),
      makeSubtitleEntry({ startTime: 1, endTime: 2, text: 'first' }),
    ])

    expect(entries.map((entry) => entry.text)).toEqual(['first', 'second'])
    expect(entries.map((entry) => entry.index)).toEqual([1, 2])
  })

  it('validates overlapping entries', () => {
    const first = makeSubtitleEntry({ startTime: 1, endTime: 3, text: 'one' })
    const second = makeSubtitleEntry({ startTime: 2.5, endTime: 4, text: 'two' })

    expect(validateSubtitles([first, second]).some((issue) => issue.code === 'overlap')).toBe(true)
  })

  it('shifts subtitles without creating negative times', () => {
    const shifted = shiftEntries(
      [makeSubtitleEntry({ startTime: 0.1, endTime: 1.1, text: 'early' })],
      -500,
      10,
    )

    expect(shifted[0].startTime).toBe(0)
    expect(shifted[0].endTime).toBe(0.6)
  })

  it('splits and merges subtitle entries', () => {
    const entry = makeSubtitleEntry({
      startTime: 10,
      endTime: 16,
      text: 'This sentence should split near the middle without dropping words.',
    })
    const [first, second] = splitEntry(entry)
    const merged = mergeEntries(first, second)

    expect(first.endTime).toBe(second.startTime)
    expect(merged.text).toContain('This sentence')
    expect(merged.startTime).toBe(10)
    expect(merged.endTime).toBe(16)
  })

  it('formats long text into readable lines', () => {
    const formatted = formatSubtitleText(
      'A subtitle line should be readable and split near natural word boundaries.',
      DEFAULT_FORMATTING_PREFERENCES,
    )

    expect(formatted.split('\n').length).toBeLessThanOrEqual(2)
    expect(formatted).not.toContain('  ')
  })
})

describe('generated caption optimization', () => {
  const generatedPreferences = DEFAULT_FORMATTING_PREFERENCES

  it('breaks readable generated caption lines without splitting connected phrases', () => {
    const formatted = formatSubtitleText('We are aiming to get a better television service', generatedPreferences)
    const lines = formatted.split('\n')

    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.length <= generatedPreferences.maxCharsPerLine)).toBe(true)
    expect(lines[1]).toBe('a better television service')
  })

  it('splits long generated sentences at punctuation before arbitrary boundaries', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 12,
          text: 'This is the first complete thought. This is the second complete thought, with a little more detail to keep it readable.',
        },
      ],
      generatedPreferences,
      20,
    )

    expect(entries.length).toBeGreaterThan(1)
    expect(entries[0].text.replace(/\n/g, ' ')).toContain('This is the first complete thought.')
    expect(entries[1].text.replace(/\n/g, ' ')).toContain('This is the second complete thought')
    expect(entries.map((entry) => entry.index)).toEqual(entries.map((_, index) => index + 1))
    expect(entries.map((entry) => entry.startTime)).toEqual([...entries.map((entry) => entry.startTime)].sort((a, b) => a - b))
    expectGeneratedLinesToRespectPreferences(entries)
  })

  it('protects reading speed by extending or splitting very dense captions', () => {
    const segment: RawTranscriptionSegment = {
      startTime: 0,
      endTime: 0.8,
      text: 'This caption contains far too many characters to fit inside less than one second while still being readable.',
    }
    const originalCps = calculateCharactersPerSecond(segment.text, segment.startTime, segment.endTime)
    const entries = formatTranscriptionSegments([segment], generatedPreferences, 10)
    const optimizedCps = Math.max(
      ...entries.map((entry) => calculateCharactersPerSecond(entry.text, entry.startTime, entry.endTime)),
    )

    expect(entries.at(-1)?.endTime).toBeGreaterThan(segment.endTime)
    expect(optimizedCps).toBeLessThan(originalCps)
    expect(optimizedCps).toBeLessThanOrEqual(22)
    expectGeneratedLinesToRespectPreferences(entries)
  })

  it('uses word timestamps to tighten generated caption start and end times', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 8,
          text: 'Hello world again',
          words: [
            { text: 'Hello', startTime: 1, endTime: 1.35 },
            { text: 'world', startTime: 1.42, endTime: 1.85 },
            { text: 'again', startTime: 2.05, endTime: 2.4 },
          ],
        },
      ],
      { ...generatedPreferences, useWordTimestamps: true },
      10,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].startTime).toBeCloseTo(0.92, 3)
    expect(entries[0].endTime).toBeCloseTo(2.58, 3)
  })

  it('deduplicates repeated generated captions near chunk boundaries', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 2.5,
          text: 'This line repeats near the boundary.',
        },
        {
          startTime: 2,
          endTime: 4,
          text: 'This line repeats near the boundary.',
        },
      ],
      generatedPreferences,
      8,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].text.replace(/\n/g, ' ')).toBe('This line repeats near the boundary.')
  })
})

describe('project import validation', () => {
  it('validates an exported Auto Subtitle project', () => {
    const project = createProjectExport(
      [makeSubtitleEntry({ startTime: 0, endTime: 2, text: 'Saved text' })],
      DEFAULT_FORMATTING_PREFERENCES,
      { videoFileName: 'demo.mp4', videoDuration: 2 },
    )

    const result = parseProjectJson(JSON.stringify(project))

    expect(result.errors).toEqual([])
    expect(result.project?.subtitles[0].text).toBe('Saved text')
  })

  it('rejects malformed project data safely', () => {
    const result = parseProjectJson('{"metadata":{},"subtitles":"bad"}')

    expect(result.project).toBeUndefined()
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

function expectGeneratedLinesToRespectPreferences(entries: { text: string }[]): void {
  for (const entry of entries) {
    const lines = entry.text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(lines.every((line) => line.length <= DEFAULT_FORMATTING_PREFERENCES.maxCharsPerLine)).toBe(true)
  }
}
