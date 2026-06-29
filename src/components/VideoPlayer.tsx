import { Captions, Maximize, Minimize, Pause, Play, Plus, RotateCcw, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { FormattingPreferences, SubtitleEntry } from '../types/subtitles'
import type { RegenerationRange } from '../transcription/types'
import { formatDuration } from '../utils/time'
import { IconButton } from './IconButton'
import { PlayerSubtitleEditor } from './PlayerSubtitleEditor'
import { SubtitleTimeline } from './SubtitleTimeline'

type VideoPlayerProps = {
  src: string | null
  duration: number
  currentTime: number
  videoRef: RefObject<HTMLVideoElement | null>
  subtitles: SubtitleEntry[]
  overlaySubtitles?: SubtitleEntry[]
  formatting: FormattingPreferences
  selectedSubtitleId?: string
  focusSubtitleRequest?: number
  subtitlesVisible: boolean
  canRedo: boolean
  canSplitAtPlayhead: boolean
  canUndo: boolean
  canRegenerate: boolean
  regenerationRange?: RegenerationRange
  seekRequest?: { time: number; id: number }
  playRangeRequest?: { startTime: number; endTime: number; id: number }
  playToggleRequest?: number
  onDuration: (duration: number) => void
  onTime: (time: number) => void
  onRangePlaybackEnd?: () => void
  onRedo: () => void
  onSplitAtPlayhead: () => void
  onToggleSubtitles: () => void
  onUndo: () => void
  onStartRegeneration: () => void
  onChangeRegenerationRange: (range: RegenerationRange) => void
  onPreviewRegeneration: () => void
  onConfigureRegeneration: () => void
  onCancelRegeneration: () => void
  onUpdateSubtitle: (id: string, patch: Partial<SubtitleEntry>) => void
  onDeleteSubtitle: (id: string) => void
  onDuplicateSubtitle: (id: string) => void
  onAddSubtitleAt: (time: number) => void
  onSelectSubtitle: (id: string) => void
  onPlayRange: (startTime: number, endTime: number) => void
  onSeek: (time: number) => void
}

export function VideoPlayer({
  src,
  duration,
  currentTime,
  videoRef,
  subtitles,
  overlaySubtitles,
  formatting,
  selectedSubtitleId,
  focusSubtitleRequest,
  subtitlesVisible,
  canRedo,
  canSplitAtPlayhead,
  canUndo,
  canRegenerate,
  regenerationRange,
  seekRequest,
  playRangeRequest,
  playToggleRequest,
  onDuration,
  onTime,
  onRangePlaybackEnd,
  onRedo,
  onSplitAtPlayhead,
  onToggleSubtitles,
  onUndo,
  onStartRegeneration,
  onChangeRegenerationRange,
  onPreviewRegeneration,
  onConfigureRegeneration,
  onCancelRegeneration,
  onUpdateSubtitle,
  onDeleteSubtitle,
  onDuplicateSubtitle,
  onAddSubtitleAt,
  onSelectSubtitle,
  onPlayRange,
  onSeek,
}: VideoPlayerProps) {
  const workspaceRef = useRef<HTMLElement | null>(null)
  const rangeEndRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.85)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')

  const visibleOverlaySubtitles = overlaySubtitles ?? subtitles
  const activeSubtitle = useMemo(
    () => visibleOverlaySubtitles.find((entry) => currentTime >= entry.startTime && currentTime <= entry.endTime),
    [currentTime, visibleOverlaySubtitles],
  )
  const selectedSubtitle = useMemo(
    () => subtitles.find((entry) => entry.id === selectedSubtitleId),
    [selectedSubtitleId, subtitles],
  )

  const seekTo = useCallback(
    (time: number) => {
      if (!videoRef.current) {
        return
      }
      videoRef.current.currentTime = time
      onTime(time)
    },
    [onTime, videoRef],
  )

  useEffect(() => {
    if (seekRequest) {
      seekTo(seekRequest.time)
    }
  }, [seekRequest, seekTo])

  useEffect(() => {
    if (!playRangeRequest) {
      rangeEndRef.current = null
      return
    }
    if (!videoRef.current) {
      return
    }
    rangeEndRef.current = playRangeRequest.endTime
    videoRef.current.currentTime = playRangeRequest.startTime
    onTime(playRangeRequest.startTime)
    void videoRef.current.play()
  }, [onTime, playRangeRequest, videoRef])

  useEffect(() => {
    if (!playToggleRequest || !videoRef.current) {
      return
    }
    if (videoRef.current.paused) {
      void videoRef.current.play()
    } else {
      videoRef.current.pause()
    }
  }, [playToggleRequest, videoRef])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === workspaceRef.current)
      setFullscreenError('')
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const toggleFullscreen = async () => {
    setFullscreenError('')
    try {
      if (document.fullscreenElement === workspaceRef.current) {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        }
        return
      }
      if (!workspaceRef.current?.requestFullscreen) {
        throw new Error('Fullscreen unavailable')
      }
      await workspaceRef.current.requestFullscreen()
    } catch {
      setFullscreen(false)
      setFullscreenError('Fullscreen is unavailable or was denied.')
    }
  }

  return (
    <section ref={workspaceRef} className="video-panel" aria-label="Video and subtitle editing workspace">
      <div className="video-frame">
        {src ? (
          <video
            ref={videoRef}
            className="video"
            src={src}
            onDurationChange={(event) => onDuration(event.currentTarget.duration)}
            onLoadedMetadata={(event) => onDuration(event.currentTarget.duration)}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            onTimeUpdate={(event) => {
              const nextTime = event.currentTarget.currentTime
              onTime(nextTime)
              if (rangeEndRef.current !== null && nextTime >= rangeEndRef.current) {
                event.currentTarget.pause()
                rangeEndRef.current = null
                onRangePlaybackEnd?.()
              }
            }}
            onVolumeChange={(event) => setVolume(event.currentTarget.volume)}
          />
        ) : (
          <div className="video-placeholder">
            <Captions size={32} />
            <span>Select a video to preview subtitles</span>
          </div>
        )}

        {src && subtitlesVisible && activeSubtitle ? (
          <div className="subtitle-overlay" aria-live="polite">
            {activeSubtitle.text}
          </div>
        ) : null}
      </div>

      <div className="player-controls">
        <IconButton
          label={playing ? 'Pause video' : 'Play video'}
          variant="primary"
          disabled={!src}
          onClick={() => {
            if (!videoRef.current) {
              return
            }
            if (videoRef.current.paused) {
              void videoRef.current.play()
            } else {
              videoRef.current.pause()
            }
          }}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </IconButton>

        <IconButton label="Restart video" disabled={!src} onClick={() => seekTo(0)}>
          <RotateCcw size={17} />
        </IconButton>

        <span className="time-readout">
          {formatDuration(currentTime)} / {duration ? formatDuration(duration) : '00:00'}
        </span>

        <input
          aria-label="Seek video"
          className="seek"
          disabled={!src}
          max={duration || 0}
          min={0}
          step={0.01}
          type="range"
          value={Math.min(currentTime, duration || currentTime)}
          onChange={(event) => seekTo(Number(event.target.value))}
        />

        <label className="volume">
          <Volume2 size={16} />
          <input
            aria-label="Volume"
            disabled={!src}
            max={1}
            min={0}
            step={0.01}
            type="range"
            value={volume}
            onChange={(event) => {
              const nextVolume = Number(event.target.value)
              setVolume(nextVolume)
              if (videoRef.current) {
                videoRef.current.volume = nextVolume
              }
            }}
          />
        </label>

        <button
          aria-label="Add subtitle at current video time"
          className="button button--soft player-add-subtitle"
          disabled={!src}
          type="button"
          onClick={() => {
            const exactTime = videoRef.current?.currentTime ?? currentTime
            videoRef.current?.pause()
            rangeEndRef.current = null
            onAddSubtitleAt(exactTime)
          }}
        >
          <Plus size={16} />
          Add subtitle
        </button>

        <IconButton
          label={subtitlesVisible ? 'Hide subtitles' : 'Show subtitles'}
          variant={subtitlesVisible ? 'soft' : 'ghost'}
          onClick={onToggleSubtitles}
        >
          <Captions size={17} />
        </IconButton>

        <IconButton
          label={fullscreen ? 'Exit fullscreen subtitle workspace' : 'Enter fullscreen subtitle workspace'}
          disabled={!src}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
        </IconButton>
      </div>

      {fullscreenError ? (
        <p className="player-fullscreen-error" role="status">
          {fullscreenError}
        </p>
      ) : null}

      <SubtitleTimeline
        canRegenerate={canRegenerate}
        canRedo={canRedo}
        canSplitAtPlayhead={canSplitAtPlayhead}
        canUndo={canUndo}
        currentTime={currentTime}
        duration={duration || undefined}
        entries={subtitles}
        minDuration={formatting.minDuration}
        playing={playing}
        selectedId={selectedSubtitleId}
        regenerationRange={regenerationRange}
        onCancelRegeneration={onCancelRegeneration}
        onChangeRegenerationRange={onChangeRegenerationRange}
        onConfigureRegeneration={onConfigureRegeneration}
        onPreviewRegeneration={onPreviewRegeneration}
        onRedo={onRedo}
        onSeek={seekTo}
        onSelect={onSelectSubtitle}
        onSplitAtPlayhead={onSplitAtPlayhead}
        onUndo={onUndo}
        onUpdate={onUpdateSubtitle}
        onStartRegeneration={onStartRegeneration}
      />

      <PlayerSubtitleEditor
        duration={duration || undefined}
        entries={subtitles}
        entry={selectedSubtitle}
        focusRequest={focusSubtitleRequest}
        formatting={formatting}
        onDelete={onDeleteSubtitle}
        onDuplicate={onDuplicateSubtitle}
        onPlayRange={onPlayRange}
        onSeek={onSeek}
        onSelect={onSelectSubtitle}
        onUpdate={onUpdateSubtitle}
      />
    </section>
  )
}
