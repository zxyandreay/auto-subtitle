import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileDropZone } from './components/FileDropZone'
import { FormattingPanel } from './components/FormattingPanel'
import { ProjectToolbar } from './components/ProjectToolbar'
import { SubtitleEditor } from './components/SubtitleEditor'
import { TranscriptionPanel } from './components/TranscriptionPanel'
import { VideoPlayer } from './components/VideoPlayer'
import { useUndoableSubtitles } from './hooks/useUndoableSubtitles'
import { getDurationWarning, validateVideoFile, type VideoFileState } from './media/video'
import { clearAutosave, loadAutosave, saveAutosave, type AutosaveRecord } from './project/storage'
import {
  formatSubtitleText,
  formatTranscriptionSegments,
  normalizeOverlaps,
  removeEmptyEntries,
  shiftEntries,
  sortAndRenumber,
} from './subtitles/formatting'
import { createProjectExport, exportProjectJson, exportSrt, exportTranscript, exportVtt, parseProjectJson } from './subtitles/exporters'
import { parseSubtitleFile } from './subtitles/importers'
import { applyTheme, loadThemePreference, saveThemePreference, type ThemePreference } from './theme'
import { detectBrowserCapabilities, getCapabilityWarnings } from './transcription/capabilities'
import { startBrowserWhisperTranscription, type TranscriptionJob } from './transcription/browserWhisperProvider'
import type { TranscriptionProgress } from './transcription/types'
import { DEFAULT_TRANSCRIPTION_SETTINGS } from './transcription/types'
import { baseName, downloadTextFile } from './utils/format'
import './styles/app.css'

const FILE_SIZE_WARNING_MB = 500
const DURATION_WARNING_MINUTES = 30

const IDLE_PROGRESS: TranscriptionProgress = {
  stage: 'idle',
  message: 'Select a video or import subtitles to begin.',
}

type Notice = {
  tone: 'success' | 'warning' | 'error'
  message: string
  details?: string
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
  const [notice, setNotice] = useState<Notice | null>(null)
  const [autosave, setAutosave] = useState<AutosaveRecord | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showOnlyErrors, setShowOnlyErrors] = useState(false)
  const [shiftMilliseconds, setShiftMilliseconds] = useState(250)
  const [includeTranscriptTimestamps, setIncludeTranscriptTimestamps] = useState(false)
  const [seekRequest, setSeekRequest] = useState<{ time: number; id: number }>()
  const [playRangeRequest, setPlayRangeRequest] = useState<{ startTime: number; endTime: number; id: number }>()
  const [playToggleRequest, setPlayToggleRequest] = useState(0)
  const jobRef = useRef<TranscriptionJob | null>(null)
  const { subtitles, canRedo, canUndo, clear, commit, redo, replace, undo } = useUndoableSubtitles()

  const capabilities = useMemo(() => detectBrowserCapabilities(), [])
  const capabilityWarnings = useMemo(() => getCapabilityWarnings(capabilities), [capabilities])
  const activeSubtitle = subtitles.find((entry) => currentTime >= entry.startTime && currentTime <= entry.endTime)

  const requestSeek = useCallback((time: number) => {
    setSeekRequest({ time, id: Date.now() })
    setCurrentTime(time)
  }, [])

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

  const handleStartTranscription = async () => {
    if (!video) {
      return
    }

    setNotice(null)
    setBusy(true)
    setProgress({
      stage: 'loading-engine',
      message: 'Starting local transcription worker.',
      progress: 0.01,
    })

    const job = startBrowserWhisperTranscription(video.file, settings, {
      onProgress: setProgress,
    })
    jobRef.current = job

    try {
      const result = await job.done
      const nextEntries = formatTranscriptionSegments(result.segments, settings.formatting, video.duration || undefined)
      replace(nextEntries)
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
    }
  }

  const handleCancelTranscription = () => {
    jobRef.current?.cancel()
    jobRef.current = null
    setBusy(false)
    setProgress((current) => ({
      stage: 'cancelled',
      message: 'Transcription cancelled. Worker resources were released.',
      progress: current.progress,
    }))
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

        replace(parsed.project.subtitles)
        setSettings((current) => ({
          ...current,
          formatting: parsed.project?.formatting ?? current.formatting,
        }))
        setNotice({
          tone: 'success',
          message: buildProjectImportMessage(parsed.project.metadata.videoFileName, parsed.project.metadata.videoDuration),
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

      replace(result.entries)
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
    commit(
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

    replace(autosave.project.subtitles)
    setSettings((current) => ({ ...current, formatting: autosave.project.formatting }))
    setNotice({
      tone: 'success',
      message: buildProjectImportMessage(autosave.project.metadata.videoFileName, autosave.project.metadata.videoDuration),
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
            subtitles={subtitles}
            subtitlesVisible={subtitlesVisible}
            onDuration={handleDuration}
            onTime={setCurrentTime}
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
              onCancel={handleCancelTranscription}
              onSettingsChange={setSettings}
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
                commit(normalizeOverlaps(subtitles, settings.formatting, video?.duration))
              }
            }}
            onRedo={redo}
            onRemoveEmpty={() => commit(removeEmptyEntries(subtitles))}
            onRenumber={() => commit(sortAndRenumber(subtitles))}
            onShiftBackward={() => commit(shiftEntries(subtitles, -Math.abs(shiftMilliseconds), video?.duration))}
            onShiftForward={() => commit(shiftEntries(subtitles, Math.abs(shiftMilliseconds), video?.duration))}
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
            onAutoScrollChange={setAutoScroll}
            onChange={commit}
            onPlayRange={(startTime, endTime) => setPlayRangeRequest({ startTime, endTime, id: Date.now() })}
            onSeek={requestSeek}
            onShowOnlyErrorsChange={setShowOnlyErrors}
          />
        </div>
      </div>
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
