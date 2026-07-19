import { describe, expect, it } from 'vitest'
import {
  calculateCharactersPerSecond,
  canSplitEntryAtTime,
  formatSubtitleText,
  formatTranscriptionSegments,
  makeSubtitleEntry,
  makeSubtitleEntryAtTime,
  mergeEntries,
  type RawTranscriptionSegment,
  shiftEntries,
  sortAndRenumber,
  splitEntry,
  splitEntryAtTime,
} from '../subtitles/formatting'
import { createProjectExport, exportSrt, exportTranscript, exportVtt, parseProjectJson } from '../subtitles/exporters'
import { parseSrt, parseVtt } from '../subtitles/importers'
import {
  createLiveTranscriptionPreviewState,
  markLiveTranscriptionPreviewEdits,
  mergeLiveTranscriptionPreview,
} from '../subtitles/livePreview'
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

  it('exports generated low-confidence fallback segments and omits invalid entries', () => {
    const valid = makeSubtitleEntry({ startTime: 1, endTime: 2.5, text: 'Recovered locally', confidence: 0.35 })
    const invalid = makeSubtitleEntry({ startTime: 4, endTime: 3, text: 'Invalid timing' })

    const srt = exportSrt([valid, invalid])

    expect(srt).toContain('Recovered locally')
    expect(srt).not.toContain('Invalid timing')
  })

  it('preserves plain and timestamped TXT transcript export', () => {
    const entries = [
      makeSubtitleEntry({ startTime: 1.2, endTime: 2.4, text: 'First\nline' }),
      makeSubtitleEntry({ startTime: 3, endTime: 4, text: 'Second line' }),
    ]

    expect(exportTranscript(entries, false)).toBe('First line\nSecond line')
    expect(exportTranscript(entries, true)).toBe('[00:00:01.200] First line\n[00:00:03.000] Second line')
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
  it('creates a manual subtitle at the exact playhead time', () => {
    const entry = makeSubtitleEntryAtTime(12.3456, 60)

    expect(entry.startTime).toBe(12.346)
    expect(entry.endTime).toBe(14.346)
    expect(entry.text).toBe('New subtitle')
  })

  it('shortens a playhead subtitle to stay within the known video duration', () => {
    const entry = makeSubtitleEntryAtTime(9.75, 10)

    expect(entry.startTime).toBe(9.75)
    expect(entry.endTime).toBe(10)
  })

  it('creates the smallest valid manual subtitle when the playhead is at the video end', () => {
    const entry = makeSubtitleEntryAtTime(10, 10)

    expect(entry.startTime).toBe(9.9)
    expect(entry.endTime).toBe(10)
  })

  it('does not treat a zero metadata duration as a known video boundary', () => {
    const entry = makeSubtitleEntryAtTime(12.5, 0)

    expect(entry.startTime).toBe(12.5)
    expect(entry.endTime).toBe(14.5)
  })

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

  it('splits an entry at an exact rounded timeline time using the editor text split', () => {
    const entry = makeSubtitleEntry({
      startTime: 10,
      endTime: 16,
      text: 'This sentence should split near the middle without dropping words.',
      confidence: 0.82,
    })
    const [naturalFirst, naturalSecond] = splitEntry(entry)
    const result = splitEntryAtTime(entry, 12.3456)

    expect(result).toBeDefined()
    const [first, second] = result!
    expect(first.endTime).toBe(12.346)
    expect(second.startTime).toBe(12.346)
    expect([first.text, second.text]).toEqual([naturalFirst.text, naturalSecond.text])
    expect([first.confidence, second.confidence]).toEqual([0.82, 0.82])
  })

  it('requires at least 0.1 seconds on each side of a timeline split', () => {
    const entry = makeSubtitleEntry({ startTime: 10, endTime: 12, text: 'Split this subtitle safely.' })

    expect(canSplitEntryAtTime(entry, 10.1)).toBe(true)
    expect(canSplitEntryAtTime(entry, 11.9)).toBe(true)
    expect(canSplitEntryAtTime(entry, 10.099)).toBe(false)
    expect(canSplitEntryAtTime(entry, 11.901)).toBe(false)
    expect(canSplitEntryAtTime(entry, Number.NaN)).toBe(false)
    expect(splitEntryAtTime(entry, 10.099)).toBeUndefined()
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

  it('extends very short generated captions toward the readable minimum when safe', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 0.4,
          text: 'Okay.',
        },
      ],
      generatedPreferences,
      5,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].endTime - entries[0].startTime).toBeGreaterThanOrEqual(generatedPreferences.minDuration)
  })

  it('does not extend low-confidence text-only timing beyond its speech evidence', () => {
    const entries = formatTranscriptionSegments(
      [{ startTime: 1, endTime: 1.4, text: 'Maybe', confidence: 0.35 }],
      generatedPreferences,
      5,
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ startTime: 1, endTime: 1.4, confidence: 0.35 })
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

  it('preserves punctuation and CJK spacing from word-timestamp chunks', () => {
    const tokens = ['你', '好', '，', '世', '界', '。']
    const entries = formatTranscriptionSegments(
      [{
        startTime: 0,
        endTime: 2,
        text: '你好，世界。',
        words: tokens.map((text, index) => ({
          text,
          startTime: index * 0.2,
          endTime: index * 0.2 + 0.15,
        })),
      }],
      { ...generatedPreferences, useWordTimestamps: true },
      3,
    )

    expect(entries.map((entry) => entry.text.replace(/\n/g, '')).join('')).toBe('你好，世界。')
  })

  it('splits long no-whitespace segment-timestamp text without losing characters', () => {
    const text = '这是一个没有空格但需要按照可读长度稳定分段的字幕句子。'.repeat(4)
    const entries = formatTranscriptionSegments(
      [{ startTime: 0, endTime: 12, text }],
      { ...generatedPreferences, maxCharsPerLine: 20, maxCharsPerSubtitle: 40 },
      15,
    )

    expect(entries.map((entry) => entry.text.replace(/\n/g, '')).join('')).toBe(text)
    expect(entries.every((entry) => entry.text.split('\n').every((line) => Array.from(line).length <= 20))).toBe(true)
  })

  it('keeps combining-mark graphemes intact when splitting no-whitespace text', () => {
    const text = 'กำลังทดสอบคำบรรยายภาษาไทยที่ไม่มีช่องว่าง'.repeat(3)
    const entries = formatTranscriptionSegments(
      [{ startTime: 0, endTime: 12, text }],
      { ...generatedPreferences, maxCharsPerLine: 12, maxCharsPerSubtitle: 24 },
      15,
    )

    expect(entries.map((entry) => entry.text.replace(/\n/g, '')).join('')).toBe(text)
    expect(entries.every((entry) => !/^\p{M}/u.test(entry.text))).toBe(true)
  })

  it('does not reintroduce overlap when display padding surrounds rapid word-timed captions', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 1,
          text: 'First response',
          words: [
            { text: 'First', startTime: 0.4, endTime: 0.65 },
            { text: 'response', startTime: 0.67, endTime: 1 },
          ],
        },
        {
          startTime: 1.05,
          endTime: 2,
          text: 'Second response',
          words: [
            { text: 'Second', startTime: 1.05, endTime: 1.35 },
            { text: 'response', startTime: 1.37, endTime: 2 },
          ],
        },
      ],
      { ...generatedPreferences, useWordTimestamps: true },
      3,
    )

    expect(entries).toHaveLength(2)
    expect(entries[0].endTime).toBeLessThanOrEqual(entries[1].startTime)
    expect(entries[0].endTime).toBeGreaterThan(entries[0].startTime)
    expect(entries[1].endTime).toBeGreaterThan(entries[1].startTime)
  })

  it('avoids abrupt word-timed cuts after very short phrases', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 4,
          text: 'We agree. This should continue as one readable phrase before the next caption.',
          words: [
            { text: 'We', startTime: 0, endTime: 0.12 },
            { text: 'agree.', startTime: 0.14, endTime: 0.32 },
            { text: 'This', startTime: 0.44, endTime: 0.62 },
            { text: 'should', startTime: 0.64, endTime: 0.82 },
            { text: 'continue', startTime: 0.84, endTime: 1.1 },
            { text: 'as', startTime: 1.12, endTime: 1.22 },
            { text: 'one', startTime: 1.24, endTime: 1.4 },
            { text: 'readable', startTime: 1.42, endTime: 1.72 },
            { text: 'phrase', startTime: 1.74, endTime: 2.02 },
            { text: 'before', startTime: 2.04, endTime: 2.24 },
            { text: 'the', startTime: 2.26, endTime: 2.36 },
            { text: 'next', startTime: 2.38, endTime: 2.56 },
            { text: 'caption.', startTime: 2.58, endTime: 2.9 },
          ],
        },
      ],
      { ...generatedPreferences, useWordTimestamps: true },
      6,
    )

    expect(entries[0].text.replace(/\n/g, ' ')).not.toBe('We agree.')
    expect(entries[0].endTime - entries[0].startTime).toBeGreaterThanOrEqual(generatedPreferences.minDuration)
    expectGeneratedLinesToRespectPreferences(entries)
  })

  it('chains short generated gaps by extending the previous caption when safe', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 1.2,
          text: 'First readable caption.',
        },
        {
          startTime: 1.45,
          endTime: 2.8,
          text: 'Second readable caption.',
        },
      ],
      generatedPreferences,
      5,
    )

    expect(entries).toHaveLength(2)
    const gap = entries[1].startTime - entries[0].endTime
    expect(gap).toBeLessThanOrEqual(generatedPreferences.gapBetweenSubtitles + 0.001)
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

  it('does not pair longer duplicate text with a shorter candidate\'s stale word list', () => {
    const entries = formatTranscriptionSegments(
      [
        {
          startTime: 0,
          endTime: 1.5,
          text: 'keep all words',
          words: [
            { text: 'keep', startTime: 0, endTime: 0.3 },
            { text: 'all', startTime: 0.35, endTime: 0.6 },
            { text: 'words', startTime: 0.65, endTime: 1 },
          ],
        },
        {
          startTime: 0.1,
          endTime: 2,
          text: 'keep all words here',
        },
      ],
      { ...generatedPreferences, useWordTimestamps: true },
      4,
    )

    expect(entries.map((entry) => entry.text.replace(/\n/g, ' ')).join(' ')).toBe('keep all words here')
  })

  it('never drops transcript text when a pathological caption exceeds the split-work guard', () => {
    const text = Array.from({ length: 700 }, (_, index) => `word${index}.`).join(' ')
    const entries = formatTranscriptionSegments(
      [{ startTime: 0, endTime: 700, text }],
      {
        ...generatedPreferences,
        maxCharsPerLine: 24,
        maxCharsPerSubtitle: 48,
        minDuration: 0.25,
        maxDuration: 2,
        hardMaxCps: 100,
      },
      750,
    )
    const outputTokens = entries.flatMap((entry) => entry.text.replace(/\n/g, ' ').split(/\s+/)).filter(Boolean)

    expect(outputTokens).toEqual(text.split(/\s+/))
    expect(entries.every((entry) => entry.endTime - entry.startTime <= 2.001)).toBe(true)
    const maximumLineLength = Math.max(...entries.flatMap((entry) => entry.text.split('\n').map((line) => line.length)))
    const longestEntry = entries.find((entry) => entry.text.split('\n').some((line) => line.length === maximumLineLength))
    expect(maximumLineLength, longestEntry?.text).toBeLessThanOrEqual(24)
    expect(entries.every((entry) => calculateCharactersPerSecond(entry.text, entry.startTime, entry.endTime) <= 100.01)).toBe(true)
  })

  it('suppresses unreadable low-confidence text instead of extending it over silence', () => {
    const entries = formatTranscriptionSegments(
      [{
        startTime: 1,
        endTime: 1.4,
        text: 'This untimed fallback is much too dense for its speech evidence.',
        confidence: 0.35,
      }],
      generatedPreferences,
      5,
    )

    expect(entries).toEqual([])
  })
})

describe('live transcription preview merging', () => {
  it('shows generated captions while dropping pre-existing base subtitles', () => {
    const base = [makeSubtitleEntry({ id: 'manual-existing', startTime: 0, endTime: 2, text: 'old subtitle' })]
    const generated = [makeSubtitleEntry({ id: 'generated-1', startTime: 1, endTime: 3, text: 'live caption' })]
    const state = createLiveTranscriptionPreviewState(base)

    const merged = mergeLiveTranscriptionPreview(base, generated, state)

    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('generated-1')
    expect(merged[0].text).toBe('live caption')
  })

  it('preserves user edits to streamed captions during later partial updates', () => {
    const state = createLiveTranscriptionPreviewState()
    const firstGenerated = [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 2, text: 'first draft' })]
    const firstPreview = mergeLiveTranscriptionPreview([], firstGenerated, state)
    const editedPreview = [{ ...firstPreview[0], text: 'edited by user' }]

    markLiveTranscriptionPreviewEdits(firstPreview, editedPreview, state)

    const secondGenerated = [
      makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 2.5, text: 'updated draft' }),
      makeSubtitleEntry({ id: 'generated-2', startTime: 2.6, endTime: 4, text: 'next live caption' }),
    ]
    const merged = mergeLiveTranscriptionPreview(editedPreview, secondGenerated, state)

    expect(merged).toHaveLength(2)
    expect(merged[0].text).toBe('edited by user')
    expect(merged[1].text).toBe('next live caption')
  })

  it('keeps deleted streamed captions removed during later partial updates', () => {
    const state = createLiveTranscriptionPreviewState()
    const firstGenerated = [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 2, text: 'remove me' })]
    const firstPreview = mergeLiveTranscriptionPreview([], firstGenerated, state)

    markLiveTranscriptionPreviewEdits(firstPreview, [], state)

    const merged = mergeLiveTranscriptionPreview([], firstGenerated, state)

    expect(merged).toEqual([])
  })

  it('keeps an edited caption attached to its timing when a later repair inserts an earlier cue', () => {
    const state = createLiveTranscriptionPreviewState()
    const initial = [
      makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: 'opening' }),
      makeSubtitleEntry({ id: 'generated-2', startTime: 3, endTime: 4, text: 'keep this edit' }),
    ]
    const firstPreview = mergeLiveTranscriptionPreview([], initial, state)
    const editedPreview = firstPreview.map((entry) =>
      entry.id === 'generated-2' ? { ...entry, text: 'edited by user' } : entry,
    )
    markLiveTranscriptionPreviewEdits(firstPreview, editedPreview, state)

    const afterRepair = [
      makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: 'opening' }),
      makeSubtitleEntry({ id: 'generated-2', startTime: 1.5, endTime: 2.2, text: 'recovered words' }),
      makeSubtitleEntry({ id: 'generated-3', startTime: 3, endTime: 4, text: 'keep this edit' }),
    ]
    const merged = mergeLiveTranscriptionPreview(editedPreview, afterRepair, state)

    expect(merged.map((entry) => [entry.startTime, entry.text])).toEqual([
      [0, 'opening'],
      [1.5, 'recovered words'],
      [3, 'edited by user'],
    ])
    expect(merged.at(-1)?.id).toBe('generated-2')
  })

  it('does not let an unrelated overlapping insertion steal an edited caption id', () => {
    const state = createLiveTranscriptionPreviewState()
    const initial = [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 2, text: 'keep this wording' })]
    const firstPreview = mergeLiveTranscriptionPreview([], initial, state)
    const editedPreview = [{ ...firstPreview[0], text: 'edited by user' }]
    markLiveTranscriptionPreviewEdits(firstPreview, editedPreview, state)

    const merged = mergeLiveTranscriptionPreview(
      editedPreview,
      [
        makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: 'unrelated insertion' }),
        makeSubtitleEntry({ id: 'generated-2', startTime: 1, endTime: 2, text: 'keep this wording' }),
      ],
      state,
    )

    expect(merged.map((entry) => entry.text)).toEqual(['unrelated insertion', 'edited by user'])
    expect(merged[1].id).toBe('generated-1')
  })

  it('prunes obsolete unedited generated snapshots across partial updates', () => {
    const state = createLiveTranscriptionPreviewState()
    let current: ReturnType<typeof makeSubtitleEntry>[] = []
    for (let index = 0; index < 20; index += 1) {
      current = mergeLiveTranscriptionPreview(
        current,
        [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: `unique${index}` })],
        state,
      )
    }

    expect(state.generatedEntryIds.size).toBeLessThanOrEqual(2)
    expect(state.generatedSnapshots.size).toBeLessThanOrEqual(2)
  })

  it('drops a stale generated cue when an unrelated replacement arrives', () => {
    const state = createLiveTranscriptionPreviewState()
    const initial = mergeLiveTranscriptionPreview(
      [],
      [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: 'old cue' })],
      state,
    )
    const merged = mergeLiveTranscriptionPreview(
      initial,
      [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: 'entirely different' })],
      state,
    )

    expect(merged.map((entry) => entry.text)).toEqual(['entirely different'])
  })

  it('does not treat reordered words as stable text evidence', () => {
    const state = createLiveTranscriptionPreviewState()
    const initial = mergeLiveTranscriptionPreview(
      [],
      [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: 'dog bites man' })],
      state,
    )
    const merged = mergeLiveTranscriptionPreview(
      initial,
      [makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 1, text: 'man bites dog' })],
      state,
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].text).toBe('man bites dog')
    expect(merged[0].id).not.toBe(initial[0].id)
  })

  it('does not cross-match generated cue identities when cue order changes', () => {
    const state = createLiveTranscriptionPreviewState()
    const initial = mergeLiveTranscriptionPreview(
      [],
      [
        makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 2, text: 'alpha cue' }),
        makeSubtitleEntry({ id: 'generated-2', startTime: 1, endTime: 3, text: 'beta cue' }),
      ],
      state,
    )
    const merged = mergeLiveTranscriptionPreview(
      initial,
      [
        makeSubtitleEntry({ id: 'generated-1', startTime: 0, endTime: 2.5, text: 'beta cue' }),
        makeSubtitleEntry({ id: 'generated-2', startTime: 0.5, endTime: 3, text: 'alpha cue' }),
      ],
      state,
    )

    expect(merged[0].id).toBe(initial[1].id)
    expect(merged[1].id).not.toBe(initial[0].id)
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

  it('preserves known saved speech models and normalizes unknown model ids to Base', () => {
    const knownProject = createProjectExport([], DEFAULT_FORMATTING_PREFERENCES, {}, {
      modelId: 'onnx-community/whisper-large-v3-turbo',
      language: 'japanese',
      task: 'transcribe',
      executionProvider: 'webgpu',
    })
    const unknownProject = createProjectExport([], DEFAULT_FORMATTING_PREFERENCES, {}, {
      modelId: 'retired/model',
      language: 'english',
      task: 'transcribe',
      executionProvider: 'auto',
    })

    expect(parseProjectJson(JSON.stringify(knownProject)).project?.transcriptionSettings?.modelId).toBe(
      'onnx-community/whisper-large-v3-turbo',
    )
    expect(parseProjectJson(JSON.stringify(unknownProject)).project?.transcriptionSettings?.modelId).toBe(
      'onnx-community/whisper-base',
    )
  })

  it('normalizes incompatible saved model settings during project import', () => {
    const project = createProjectExport([], DEFAULT_FORMATTING_PREFERENCES, {}, {
      modelId: 'distil-whisper/distil-large-v3',
      language: 'korean',
      task: 'transcribe',
      executionProvider: 'wasm',
    })

    expect(parseProjectJson(JSON.stringify(project)).project?.transcriptionSettings?.modelId).toBe(
      'onnx-community/whisper-base',
    )
    expect(parseProjectJson(JSON.stringify(project)).warnings).toEqual([
      'Distil Large v3 is English-only, so the model was switched to Base for this language.',
    ])
  })
})

function expectGeneratedLinesToRespectPreferences(entries: { text: string }[]): void {
  for (const entry of entries) {
    const lines = entry.text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(lines.every((line) => line.length <= DEFAULT_FORMATTING_PREFERENCES.maxCharsPerLine)).toBe(true)
  }
}
