import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileDropZone } from './components/FileDropZone'
import { FormattingPanel } from './components/FormattingPanel'
import { ProjectToolbar } from './components/ProjectToolbar'
import { RegenerationDialog, type FormattedRegenerationCandidate } from './components/RegenerationDialog'
import { SubtitleEditor } from './components/SubtitleEditor'
import { TranscriptionPanel } from './components/TranscriptionPanel'
import { VideoPlayer } from './components/VideoPlayer'
import { useUndoableSubtitles } from './hooks/useUndoableSubtitles'
import { getDurationWarning, validateVideoFile, type VideoFileState } from './media/video'
import { clearAutosave, loadAutosave, saveAutosave, type AutosaveRecord } from './project/storage'
import {
  formatSubtitleText,
  formatTranscriptionSegments,
  makeSubtitleEntry,
  normalizeOverlaps,
  removeEmptyEntries,
  shiftEntries,
  sortAndRenumber,
} from './subtitles/formatting'
import { createProjectExport, exportProjectJson, exportSrt, exportTranscript, exportVtt, parseProjectJson } from './subtitles/exporters'
import { parseSubtitleFile } from './subtitles/importers'
import {
  createLiveTranscriptionPreviewState,
  markLiveTranscriptionPreviewEdits,
  mergeLiveTranscriptionPreview,
  type LiveTranscriptionPreviewState,
} from './subtitles/livePreview'
import { replaceEntriesInRange } from './subtitles/regeneration'
import { applyTheme, loadThemePreference, saveThemePreference, type ThemePreference } from './theme'
import { detectBrowserCapabilities, getCapabilityWarnings } from './transcription/capabilities'
import {
  startBrowserWhisperRegeneration,
  startBrowserWhisperTranscription,
  type RegenerationJob,
  type TranscriptionJob,
} from './transcription/browserWhisperProvider'
import { resolveCompatibleModelId } from './transcription/models'
import type {
  RegenerationRange,
  TranscriptionProgress,
  TranscriptionResult,
  TranscriptionSettings,
} from './transcription/types'
import { DEFAULT_TRANSCRIPTION_SETTINGS, normalizeTranscriptionSettings } from './transcription/types'
import type { SubtitleEntry } from './types/subtitles'
import { baseName, downloadTextFile } from './utils/format'
import './styles/app.css'

const FILE_SIZE_WARNING_MB = 500
const DURATION_WARNING_MINUTES = 30

const IDLE_PROGRESS: TranscriptionProgress = {
  stage: 'idle',
  message: 'Select a video or import subtitles to begin.',
}

const IDLE_REGENERATION_PROGRESS: TranscriptionProgress = {
  stage: 'idle',
  message: 'Adjust the range, then generate local alternatives.',
}

type Notice = {
  tone: 'success' | 'warning' | 'error'
  message: string
  details?: string
}

type RegenerationDialogState = {
  range: RegenerationRange
  originalEntries: SubtitleEntry[]
}

function App() {
  const [theme, setTheme] = useState<ThemePreference>(() => loadThemePreference())
  const [video, setVideo] = useState<VideoFileState | null>(null)
  const [videoWarnings, setVideoWarnings] = useState<string[]>([])
  const [videoErrors, setVideoErrors] = useState<string[]>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [subtitlesVisible, setSubtitlesVisible] = useState(true)
  const [settings, setSettings] = useState(DEFAULT_TRANSCRIPTION_SETTINGS)
  const [progress, setProgress] = useState<TranscriptionProgress>(IDLE_PROGRESS)
  const [busy, setBusy] = useState(false)
  const [regenerationBusy, setRegenerationBusy] = useState(false)
  const [regenerationDialog, setRegenerationDialog] = useState<RegenerationDialogState | null>(null)
  const [regenerationCandidates, setRegenerationCandidates] = useState<FormattedRegenerationCandidate[]>([])
  const [regenerationProgress, setRegenerationProgress] = useState(IDLE_REGENERATION_PROGRESS)
  const [regenerationError, setRegenerationError] = useState('')
  const [regenerationPreviewEntries, setRegenerationPreviewEntries] = useState<SubtitleEntry[] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [autosave, setAutosave] = useState<AutosaveRecord | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showOnlyErrors, setShowOnlyErrors] = useState(false)
  const [shiftMilliseconds, setShiftMilliseconds] = useState(250)
  const [includeTranscriptTimestamps, setIncludeTranscriptTimestamps] = useState(false)
  const [seekRequest, setSeekRequest] = useState<{ time: number; id: number }>()
  const [playRangeRequest, setPlayRangeRequest] = useState<{ startTime: number; endTime: number; id: number }>()
  const [playToggleRequest, setPlayToggleRequest] = useState(0)
  const videoElementRef = useRef<HTMLVideoElement | null>(null)
  const jobRef = useRef<TranscriptionJob | null>(null)
  const regenerationJobRef = useRef<RegenerationJob | null>(null)
  const { subtitles, canRedo, canUndo, clear, commit, preview, redo, replace, undo } = useUndoableSubtitles()
  const subtitlesRef = useRef<SubtitleEntry[]>(subtitles)
  const livePreviewStateRef = useRef<LiveTranscriptionPreviewState | null>(null)

  const capabilities = useMemo(() => detectBrowserCapabilities(), [])
  const capabilityWarnings = useMemo(() => getCapabilityWarnings(capabilities), [capabilities])
  const activeSubtitle = subtitles.find((entry) => currentTime >= entry.startTime && currentTime <= entry.endTime)

  const handleSettingsChange = useCallback((nextSettings: TranscriptionSettings) => {
    const resolved = resolveCompatibleModelId(nextSettings)
    setSettings({ ...nextSettings, modelId: resolved.modelId })
    if (resolved.changed && resolved.reason) {
      setNotice({ tone: 'warning', message: resolved.reason })
    }
  }, [])

  useEffect(() => {
    subtitlesRef.current = subtitles
  }, [subtitles])

  const requestSeek = useCallback((time: number) => {
    setSeekRequest({ time, id: Date.now() })
    setCurrentTime(time)
  }, [])

  const capturePlayheadTime = useCallback(() => {
    const exactTime = videoElementRef.current?.currentTime ?? currentTime
    videoElementRef.current?.pause()
    setPlayRangeRequest(undefined)
    setCurrentTime(exactTime)
    return exactTime
  }, [currentTime])

  useEffect(() => {
    applyTheme(theme)
    saveThemePreference(theme)
  }, [theme])

  useEffect(() => {
    loadAutosave()
      .then((record) => setAutosave(record))
      .catch((error: unknown) =>
        setNotice({
          tone: 'warning',
          message: 'Autosave could not be loaded.',
          details: error instanceof Error ? error.message : String(error),
        }),
      )
  }, [])

  useEffect(() => {
    if (!subtitles.length && !video) {
      return
    }

    const timeout = window.setTimeout(() => {
      const project = createProjectExport(
        subtitles,
        settings.formatting,
        {
          videoFileName: video?.file.name,
          videoSize: video?.file.size,
          videoDuration: video?.duration,
        },
        settings,
      )

      saveAutosave(project)
        .then(() => setAutosave({ key: 'autosave', savedAt: new Date().toISOString(), project }))
        .catch((error: unknown) =>
          setNotice({
            tone: 'warning',
            message: 'Autosave failed.',
            details: error instanceof Error ? error.message : String(error),
          }),
        )
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [settings, subtitles, video])

  useEffect(() => {
    return () => {
      if (video?.objectUrl) {
        URL.revokeObjectURL(video.objectUrl)
      }
      jobRef.current?.cancel()
      regenerationJobRef.current?.cancel()
    }
  }, [video?.objectUrl])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isEditing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable

      if (isEditing) {
        return
      }

      if (event.code === 'Space') {
        event.preventDefault()
        setPlayToggleRequest((value) => value + 1)
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        requestSeek(Math.max(0, currentTime - 5))
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        requestSeek(Math.min(video?.duration ?? currentTime + 5, currentTime + 5))
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      }

      if (
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') ||
        ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z')
      ) {
        event.preventDefault()
        redo()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentTime, redo, requestSeek, undo, video?.duration])

  const handleSelectVideo = (file: File) => {
    const validation = validateVideoFile(file, {
      fileSizeWarningMb: FILE_SIZE_WARNING_MB,
      durationWarningMinutes: DURATION_WARNING_MINUTES,
    })
    setVideoErrors(validation.errors)
    setVideoWarnings(validation.warnings)

    if (validation.errors.length) {
      return
    }

    if (video?.objectUrl) {
      URL.revokeObjectURL(video.objectUrl)
    }

    setVideo({
      file,
      objectUrl: URL.createObjectURL(file),
      duration: 0,
    })
    setCurrentTime(0)
    setNotice({
      tone: 'success',
      message: 'Video selected. It stays in your browser as a temporary object URL.',
    })
  }

  const handleRemoveVideo = () => {
    if (video?.objectUrl) {
      URL.revokeObjectURL(video.objectUrl)
    }
    setVideo(null)
    setVideoWarnings([])
    setVideoErrors([])
    setCurrentTime(0)
    setProgress(IDLE_PROGRESS)
    regenerationJobRef.current?.cancel()
    regenerationJobRef.current = null
    setRegenerationBusy(false)
    setRegenerationDialog(null)
    setRegenerationPreviewEntries(null)
  }

  const handleDuration = (duration: number) => {
    if (!Number.isFinite(duration)) {
      setVideoErrors(['The browser could not read this video duration. The codec may be unsupported.'])
      return
    }

    setVideo((current) => (current ? { ...current, duration } : current))
    const warning = getDurationWarning(duration, DURATION_WARNING_MINUTES)
    if (warning) {
      setVideoWarnings((warnings) => (warnings.includes(warning) ? warnings : [...warnings, warning]))
    }
  }

  const commitSubtitleChanges = useCallback(
    (entries: SubtitleEntry[]) => {
      const nextEntries = sortAndRenumber(entries)
      const livePreviewState = livePreviewStateRef.current
      if (livePreviewState) {
        markLiveTranscriptionPreviewEdits(subtitlesRef.current, nextEntries, livePreviewState)
      }

      subtitlesRef.current = nextEntries
      commit(nextEntries)
    },
    [commit],
  )

  const replaceSubtitleEntries = useCallback(
    (entries: SubtitleEntry[]) => {
      const nextEntries = sortAndRenumber(entries)
      livePreviewStateRef.current = null
      subtitlesRef.current = nextEntries
      replace(nextEntries)
    },
    [replace],
  )

  const applyLiveTranscriptionPreview = useCallback(
    (
      result: TranscriptionResult,
      transcriptionSettings: TranscriptionSettings,
      videoDuration: number | undefined,
      final: boolean,
    ) => {
      const generatedEntries = formatTranscriptionSegments(
        result.segments,
        transcriptionSettings.formatting,
        videoDuration,
      )
      if (!final && generatedEntries.length === 0) {
        return subtitlesRef.current
      }

      const livePreviewState = livePreviewStateRef.current
      const nextEntries = livePreviewState
        ? mergeLiveTranscriptionPreview(subtitlesRef.current, generatedEntries, livePreviewState)
        : generatedEntries

      subtitlesRef.current = nextEntries
      if (final) {
        replace(nextEntries)
      } else {
        preview(nextEntries)
      }

      return nextEntries
    },
    [preview, replace],
  )

  const handleStartTranscription = async () => {
    if (!video || regenerationBusy) {
      return
    }

    const resolvedModel = resolveCompatibleModelId(settings)
    const transcriptionSettings = { ...settings, modelId: resolvedModel.modelId }
    if (resolvedModel.changed) {
      setSettings(transcriptionSettings)
    }
    const videoDuration = video.duration || undefined
    livePreviewStateRef.current = createLiveTranscriptionPreviewState(subtitlesRef.current)
    setNotice(resolvedModel.reason ? { tone: 'warning', message: resolvedModel.reason } : null)
    setBusy(true)
    setProgress({
      stage: 'loading-engine',
      message: 'Starting local transcription worker.',
      progress: 0.01,
    })

    const job = startBrowserWhisperTranscription(video.file, transcriptionSettings, {
      onProgress: setProgress,
      onPartial: (partial) =>
        applyLiveTranscriptionPreview(partial, transcriptionSettings, videoDuration, false),
    })
    jobRef.current = job

    try {
      const result = await job.done
      const nextEntries = applyLiveTranscriptionPreview(result, transcriptionSettings, videoDuration, true)
      setProgress({
        stage: 'complete',
        message: `Created ${nextEntries.length} editable subtitle entries with ${result.modelId}.`,
        progress: 1,
      })
      setNotice({
        tone: 'success',
        message: `Transcription complete. Review ${nextEntries.length} generated subtitle entries before export.`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = message.toLowerCase().includes('cancelled')
      setProgress((current) => ({
        stage: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Transcription was cancelled.' : 'Transcription failed.',
        progress: current.progress,
        technicalDetails: message,
      }))
      setNotice({
        tone: cancelled ? 'warning' : 'error',
        message: cancelled
          ? 'Transcription cancelled. The editor is ready for manual subtitles or imports.'
          : 'Transcription failed. The subtitle editor remains available.',
        details: message,
      })
    } finally {
      setBusy(false)
      jobRef.current = null
      livePreviewStateRef.current = null
    }
  }

  const handleCancelTranscription = () => {
    jobRef.current?.cancel()
    jobRef.current = null
    livePreviewStateRef.current = null
    setBusy(false)
    setProgress((current) => ({
      stage: 'cancelled',
      message: 'Transcription cancelled. Worker resources were released.',
      progress: current.progress,
    }))
  }

  const closeRegenerationDialog = () => {
    regenerationJobRef.current?.cancel()
    regenerationJobRef.current = null
    setRegenerationBusy(false)
    setRegenerationDialog(null)
    setRegenerationCandidates([])
    setRegenerationError('')
    setRegenerationPreviewEntries(null)
    setPlayRangeRequest(undefined)
  }

  const openRegenerationDialog = (entry: SubtitleEntry) => {
    if (!video || busy || regenerationBusy) {
      return
    }

    videoElementRef.current?.pause()
    const range = { startTime: entry.startTime, endTime: entry.endTime }
    const originalEntries = subtitlesRef.current.filter(
      (subtitle) => subtitle.endTime > range.startTime && subtitle.startTime < range.endTime,
    )
    setRegenerationDialog({ range, originalEntries })
    setRegenerationCandidates([])
    setRegenerationProgress(IDLE_REGENERATION_PROGRESS)
    setRegenerationError('')
    setRegenerationPreviewEntries(null)
  }

  const generateRegenerationCandidates = async (range: RegenerationRange) => {
    if (!video || busy || regenerationBusy) {
      return
    }

    const resolvedModel = resolveCompatibleModelId(settings)
    const transcriptionSettings = { ...settings, modelId: resolvedModel.modelId }
    if (resolvedModel.changed) {
      setSettings(transcriptionSettings)
      if (resolvedModel.reason) {
        setNotice({ tone: 'warning', message: resolvedModel.reason })
      }
    }
    const videoDuration = video.duration || undefined
    const originalEntries = subtitlesRef.current.filter(
      (entry) => entry.endTime > range.startTime && entry.startTime < range.endTime,
    )
    setRegenerationDialog({ range, originalEntries })
    setRegenerationCandidates([])
    setRegenerationPreviewEntries(null)
    setRegenerationError('')
    setRegenerationBusy(true)
    setRegenerationProgress({
      stage: 'loading-engine',
      message: 'Starting local subtitle regeneration.',
      progress: 0.01,
    })

    const job = startBrowserWhisperRegeneration(
      video.file,
      transcriptionSettings,
      range,
      videoDuration,
      { onProgress: setRegenerationProgress },
    )
    regenerationJobRef.current = job

    try {
      const result = await job.done
      const candidates = result.candidates.flatMap((candidate): FormattedRegenerationCandidate[] => {
        const formattedEntries = formatTranscriptionSegments(
          candidate.segments,
          transcriptionSettings.formatting,
          videoDuration,
        ).map(({ id: _id, index: _index, ...entry }) => makeSubtitleEntry(entry))
        const entries = replaceEntriesInRange(
          [],
          formattedEntries,
          result.range,
          transcriptionSettings.formatting,
          videoDuration,
        )
        return entries.length ? [{ id: candidate.id, entries }] : []
      })
      setRegenerationCandidates(candidates)
      setRegenerationProgress({
        stage: 'complete',
        message: candidates.length
          ? `Created ${candidates.length} local ${candidates.length === 1 ? 'alternative' : 'alternatives'}.`
          : 'No distinct timestamped speech was found in this range.',
        progress: 1,
      })
      if (!candidates.length) {
        setRegenerationError('No distinct timestamped speech was found. The current subtitles are unchanged.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('cancelled')) {
        setRegenerationError(message)
        setRegenerationProgress({
          stage: 'failed',
          message: 'Subtitle regeneration failed. The current subtitles are unchanged.',
          technicalDetails: message,
        })
      }
    } finally {
      setRegenerationBusy(false)
      regenerationJobRef.current = null
    }
  }

  const previewRegenerationCandidate = (entries: SubtitleEntry[], range: RegenerationRange) => {
    const previewEntries = replaceEntriesInRange(
      subtitlesRef.current,
      entries,
      range,
      settings.formatting,
      video?.duration,
    )
    setRegenerationPreviewEntries(previewEntries)
    setSubtitlesVisible(true)
    setPlayRangeRequest({ startTime: range.startTime, endTime: range.endTime, id: Date.now() })
  }

  const applyRegenerationCandidate = (entries: SubtitleEntry[] | null, range: RegenerationRange) => {
    if (entries) {
      commitSubtitleChanges(
        replaceEntriesInRange(
          subtitlesRef.current,
          entries,
          range,
          settings.formatting,
          video?.duration,
        ),
      )
      setNotice({ tone: 'success', message: 'Applied the regenerated subtitle alternative.' })
    }
    closeRegenerationDialog()
  }

  const handleImportFile = async (file: File) => {
    try {
      const content = await file.text()

      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = parseProjectJson(content)
        if (!parsed.project) {
          setNotice({
            tone: 'error',
            message: 'Project import failed.',
            details: parsed.errors.join('\n'),
          })
          return
        }

        replaceSubtitleEntries(parsed.project.subtitles)
        const restored = normalizeTranscriptionSettings(parsed.project.transcriptionSettings, {
          ...settings,
          formatting: parsed.project.formatting,
        })
        setSettings({ ...restored.settings, formatting: parsed.project.formatting })
        setNotice({
          tone: parsed.warnings.length ? 'warning' : 'success',
          message: buildProjectImportMessage(parsed.project.metadata.videoFileName, parsed.project.metadata.videoDuration),
          details: parsed.warnings.join('\n') || undefined,
        })
        return
      }

      const result = parseSubtitleFile(file.name, content)
      if (!result.entries.length) {
        setNotice({
          tone: 'error',
          message: 'No subtitles were imported.',
          details: result.warnings.join('\n'),
        })
        return
      }

      replaceSubtitleEntries(result.entries)
      setNotice({
        tone: result.warnings.length ? 'warning' : 'success',
        message: `Imported ${result.entries.length} subtitle entries from ${file.name}.`,
        details: result.warnings.join('\n'),
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: 'Import failed.',
        details: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleExport = (kind: 'srt' | 'vtt' | 'txt' | 'json') => {
    const name = baseName(video?.file.name ?? 'auto-subtitle')

    try {
      if (kind === 'srt') {
        downloadTextFile(`${name}.srt`, exportSrt(subtitles), 'application/x-subrip;charset=utf-8')
      }
      if (kind === 'vtt') {
        downloadTextFile(`${name}.vtt`, exportVtt(subtitles), 'text/vtt;charset=utf-8')
      }
      if (kind === 'txt') {
        downloadTextFile(`${name}.txt`, exportTranscript(subtitles, includeTranscriptTimestamps), 'text/plain;charset=utf-8')
      }
      if (kind === 'json') {
        const project = createProjectExport(
          subtitles,
          settings.formatting,
          {
            videoFileName: video?.file.name,
            videoSize: video?.file.size,
            videoDuration: video?.duration,
          },
          settings,
        )
        downloadTextFile(`${name}.auto-subtitle.json`, exportProjectJson(project), 'application/json;charset=utf-8')
      }

      setNotice({
        tone: 'success',
        message: `Exported ${kind.toUpperCase()} locally.`,
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: 'Export failed.',
        details: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const jumpSubtitle = (direction: 1 | -1) => {
    if (!subtitles.length) {
      return
    }

    const next =
      direction > 0
        ? subtitles.find((entry) => entry.startTime > currentTime + 0.05)
        : [...subtitles].reverse().find((entry) => entry.endTime < currentTime - 0.05)

    if (next) {
      requestSeek(next.startTime)
    }
  }

  const reformatExisting = () => {
    commitSubtitleChanges(
      subtitles.map((entry) => ({
        ...entry,
        text: formatSubtitleText(entry.text, settings.formatting),
      })),
    )
  }

  const restoreAutosave = () => {
    if (!autosave) {
      return
    }

    replaceSubtitleEntries(autosave.project.subtitles)
    const restored = normalizeTranscriptionSettings(autosave.project.transcriptionSettings, {
      ...settings,
      formatting: autosave.project.formatting,
    })
    setSettings({ ...restored.settings, formatting: autosave.project.formatting })
    setNotice({
      tone: restored.reason ? 'warning' : 'success',
      message: buildProjectImportMessage(autosave.project.metadata.videoFileName, autosave.project.metadata.videoDuration),
      details: restored.reason,
    })
  }

  return (
    <main className="app-shell">
      <ProjectToolbar
        entryCount={subtitles.length}
        hasAutosave={Boolean(autosave)}
        theme={theme}
        onClearAutosave={() => {
          clearAutosave()
            .then(() => {
              setAutosave(null)
              setNotice({ tone: 'success', message: 'Autosave data cleared from IndexedDB.' })
            })
            .catch((error: unknown) =>
              setNotice({
                tone: 'error',
                message: 'Could not clear autosave.',
                details: error instanceof Error ? error.message : String(error),
              }),
            )
        }}
        onClearSubtitles={() => {
          if (window.confirm('Clear all subtitle entries? This can be undone only if you have not refreshed the app.')) {
            const livePreviewState = livePreviewStateRef.current
            if (livePreviewState) {
              markLiveTranscriptionPreviewEdits(subtitlesRef.current, [], livePreviewState)
            }
            subtitlesRef.current = []
            clear()
          }
        }}
        onExport={handleExport}
        onImportFile={(file) => void handleImportFile(file)}
        onRestoreAutosave={restoreAutosave}
        onThemeChange={setTheme}
      />

      {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}

      <div className="workspace">
        <div className="workspace__left">
          <FileDropZone
            errors={videoErrors}
            video={video}
            warnings={videoWarnings}
            onRemoveVideo={handleRemoveVideo}
            onSelectFile={handleSelectVideo}
          />

          <VideoPlayer
            currentTime={currentTime}
            duration={video?.duration ?? 0}
            playRangeRequest={playRangeRequest}
            playToggleRequest={playToggleRequest}
            seekRequest={seekRequest}
            src={video?.objectUrl ?? null}
            subtitles={regenerationPreviewEntries ?? subtitles}
            subtitlesVisible={subtitlesVisible}
            videoRef={videoElementRef}
            onDuration={handleDuration}
            onTime={setCurrentTime}
            onRangePlaybackEnd={() => setRegenerationPreviewEntries(null)}
            onToggleSubtitles={() => setSubtitlesVisible((visible) => !visible)}
          />

          <div className="utility-grid">
            <TranscriptionPanel
              busy={busy}
              capabilities={capabilities}
              capabilityWarnings={capabilityWarnings}
              hasVideo={Boolean(video)}
              progress={progress}
              settings={settings}
              locked={regenerationBusy}
              onCancel={handleCancelTranscription}
              onSettingsChange={handleSettingsChange}
              onStart={() => void handleStartTranscription()}
            />

            <FormattingPanel
              preferences={settings.formatting}
              onChange={(formatting) => setSettings((current) => ({ ...current, formatting }))}
              onReformat={reformatExisting}
            />
          </div>
        </div>

        <div className="workspace__right">
          <GlobalTools
            canRedo={canRedo}
            canUndo={canUndo}
            includeTranscriptTimestamps={includeTranscriptTimestamps}
            shiftMilliseconds={shiftMilliseconds}
            onIncludeTranscriptTimestampsChange={setIncludeTranscriptTimestamps}
            onJumpNext={() => jumpSubtitle(1)}
            onJumpPrevious={() => jumpSubtitle(-1)}
            onNormalize={() => {
              if (
                window.confirm(
                  'Normalize subtitle timing? This may alter manually edited timestamps to remove overlaps.',
                )
              ) {
                commitSubtitleChanges(normalizeOverlaps(subtitles, settings.formatting, video?.duration))
              }
            }}
            onRedo={redo}
            onRemoveEmpty={() => commitSubtitleChanges(removeEmptyEntries(subtitles))}
            onRenumber={() => commitSubtitleChanges(sortAndRenumber(subtitles))}
            onShiftBackward={() =>
              commitSubtitleChanges(shiftEntries(subtitles, -Math.abs(shiftMilliseconds), video?.duration))
            }
            onShiftForward={() =>
              commitSubtitleChanges(shiftEntries(subtitles, Math.abs(shiftMilliseconds), video?.duration))
            }
            onShiftMillisecondsChange={setShiftMilliseconds}
            onUndo={undo}
          />

          <SubtitleEditor
            activeEntryId={activeSubtitle?.id}
            autoScroll={autoScroll}
            duration={video?.duration}
            entries={subtitles}
            formatting={settings.formatting}
            showOnlyErrors={showOnlyErrors}
            canRegenerate={Boolean(video) && !busy && !regenerationBusy}
            capturePlayheadTime={capturePlayheadTime}
            onAutoScrollChange={setAutoScroll}
            onChange={commitSubtitleChanges}
            onPlayRange={(startTime, endTime) => setPlayRangeRequest({ startTime, endTime, id: Date.now() })}
            onRegenerate={openRegenerationDialog}
            onSeek={requestSeek}
            onShowOnlyErrorsChange={setShowOnlyErrors}
          />
        </div>
      </div>

      {regenerationDialog ? (
        <RegenerationDialog
          busy={regenerationBusy}
          candidates={regenerationCandidates}
          error={regenerationError}
          originalEntries={regenerationDialog.originalEntries}
          progress={regenerationProgress}
          range={regenerationDialog.range}
          videoDuration={video?.duration || undefined}
          onApply={applyRegenerationCandidate}
          onCancel={closeRegenerationDialog}
          onGenerate={(range) => void generateRegenerationCandidates(range)}
          onPreview={previewRegenerationCandidate}
        />
      ) : null}
    </main>
  )
}

type GlobalToolsProps = {
  canUndo: boolean
  canRedo: boolean
  shiftMilliseconds: number
  includeTranscriptTimestamps: boolean
  onShiftMillisecondsChange: (value: number) => void
  onShiftForward: () => void
  onShiftBackward: () => void
  onNormalize: () => void
  onRemoveEmpty: () => void
  onRenumber: () => void
  onUndo: () => void
  onRedo: () => void
  onJumpPrevious: () => void
  onJumpNext: () => void
  onIncludeTranscriptTimestampsChange: (value: boolean) => void
}

function GlobalTools({
  canUndo,
  canRedo,
  shiftMilliseconds,
  includeTranscriptTimestamps,
  onShiftMillisecondsChange,
  onShiftForward,
  onShiftBackward,
  onNormalize,
  onRemoveEmpty,
  onRenumber,
  onUndo,
  onRedo,
  onJumpPrevious,
  onJumpNext,
  onIncludeTranscriptTimestampsChange,
}: GlobalToolsProps) {
  return (
    <section className="global-tools" aria-label="Global subtitle tools">
      <div className="panel-heading panel-heading--compact">
        <div>
          <h2>Timing tools</h2>
          <p>Shift, clean, navigate, and undo edits.</p>
        </div>
        <SlidersHorizontal aria-hidden="true" size={20} />
      </div>

      <div className="tool-row">
        <label>
          Shift ms
          <input
            min={1}
            step={25}
            type="number"
            value={shiftMilliseconds}
            onChange={(event) => onShiftMillisecondsChange(Number(event.target.value))}
          />
        </label>
        <button className="button button--ghost" type="button" onClick={onShiftBackward}>
          Back
        </button>
        <button className="button button--ghost" type="button" onClick={onShiftForward}>
          Forward
        </button>
      </div>

      <div className="tool-row tool-row--wrap">
        <button className="button button--soft" disabled={!canUndo} type="button" onClick={onUndo}>
          <RotateCcw size={15} />
          Undo
        </button>
        <button className="button button--soft" disabled={!canRedo} type="button" onClick={onRedo}>
          Redo
        </button>
        <button className="button button--soft" type="button" onClick={onNormalize}>
          Normalize
        </button>
        <button className="button button--soft" type="button" onClick={onRemoveEmpty}>
          Remove empty
        </button>
        <button className="button button--soft" type="button" onClick={onRenumber}>
          Renumber
        </button>
      </div>

      <div className="tool-row tool-row--wrap">
        <button className="button button--ghost" type="button" onClick={onJumpPrevious}>
          <ChevronLeft size={15} />
          Previous subtitle
        </button>
        <button className="button button--ghost" type="button" onClick={onJumpNext}>
          Next subtitle
          <ChevronRight size={15} />
        </button>
      </div>

      <label className="toggle-line toggle-line--panel">
        <input
          checked={includeTranscriptTimestamps}
          type="checkbox"
          onChange={(event) => onIncludeTranscriptTimestampsChange(event.target.checked)}
        />
        Include timestamps in TXT export
      </label>
    </section>
  )
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <aside className={`notice-banner notice-banner--${notice.tone}`} role="status">
      {notice.tone === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <div>
        <strong>{notice.message}</strong>
        {notice.details ? (
          <details>
            <summary>Details</summary>
            <pre>{notice.details}</pre>
          </details>
        ) : null}
      </div>
      <button className="notice-banner__close" type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </aside>
  )
}

function buildProjectImportMessage(videoFileName?: string, videoDuration?: number): string {
  if (!videoFileName) {
    return 'Project subtitles restored. Select the original video again to preview timing.'
  }

  const durationNote = videoDuration ? ` The saved duration was ${Math.round(videoDuration)} seconds.` : ''
  return `Project restored. Select the original video again: ${videoFileName}.${durationNote}`
}

export default App
