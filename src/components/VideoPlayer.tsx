import { Captions, Maximize, Pause, Play, RotateCcw, Volume2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { SubtitleEntry } from '../types/subtitles'
import { formatDuration } from '../utils/time'
import { IconButton } from './IconButton'

type VideoPlayerProps = {
  src: string | null
  duration: number
  currentTime: number
  videoRef: RefObject<HTMLVideoElement | null>
  subtitles: SubtitleEntry[]
  subtitlesVisible: boolean
  seekRequest?: { time: number; id: number }
  playRangeRequest?: { startTime: number; endTime: number; id: number }
  playToggleRequest?: number
  onDuration: (duration: number) => void
  onTime: (time: number) => void
  onRangePlaybackEnd?: () => void
  onToggleSubtitles: () => void
}

export function VideoPlayer({
  src,
  duration,
  currentTime,
  videoRef,
  subtitles,
  subtitlesVisible,
  seekRequest,
  playRangeRequest,
  playToggleRequest,
  onDuration,
  onTime,
  onRangePlaybackEnd,
  onToggleSubtitles,
}: VideoPlayerProps) {
  const rangeEndRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.85)

  const activeSubtitle = useMemo(
    () => subtitles.find((entry) => currentTime >= entry.startTime && currentTime <= entry.endTime),
    [currentTime, subtitles],
  )

  const seekTo = useCallback((time: number) => {
    if (!videoRef.current) {
      return
    }
    videoRef.current.currentTime = time
    onTime(time)
  }, [onTime, videoRef])

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

  return (
    <section className="video-panel" aria-label="Video preview">
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
              const next = Number(event.target.value)
              setVolume(next)
              if (videoRef.current) {
                videoRef.current.volume = next
              }
            }}
          />
        </label>

        <IconButton
          label={subtitlesVisible ? 'Hide subtitles' : 'Show subtitles'}
          variant={subtitlesVisible ? 'soft' : 'ghost'}
          onClick={onToggleSubtitles}
        >
          <Captions size={17} />
        </IconButton>

        <IconButton
          label="Fullscreen"
          disabled={!src}
          onClick={() => {
            if (videoRef.current?.parentElement?.requestFullscreen) {
              void videoRef.current.parentElement.requestFullscreen()
            }
          }}
        >
          <Maximize size={17} />
        </IconButton>
      </div>
    </section>
  )
}
