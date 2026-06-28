import { Upload, Video, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { VideoFileState } from '../media/video'
import { formatBytes } from '../utils/format'
import { formatDuration } from '../utils/time'

type FileDropZoneProps = {
  video: VideoFileState | null
  warnings: string[]
  errors: string[]
  onSelectFile: (file: File) => void
  onRemoveVideo: () => void
}

export function FileDropZone({ video, warnings, errors, onSelectFile, onRemoveVideo }: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const [dragging, setDragging] = useState(false)

  return (
    <section
      className={`drop-zone ${dragging ? 'drop-zone--dragging' : ''}`}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        dragDepthRef.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
      }}
      onDragLeave={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) {
          return
        }
        event.stopPropagation()
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) {
          setDragging(false)
        }
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) {
          return
        }
        event.preventDefault()
        dragDepthRef.current = 0
        setDragging(false)
        const file = event.dataTransfer.files.item(0)
        if (file) {
          onSelectFile(file)
        }
      }}
    >
      <input
        ref={inputRef}
        accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mkv,.mov,.mp4,.webm"
        className="sr-only"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.item(0)
          if (file) {
            onSelectFile(file)
          }
          event.currentTarget.value = ''
        }}
      />

      <div className="drop-zone__icon" aria-hidden="true">
        {video ? <Video size={22} /> : <Upload size={22} />}
      </div>
      <div className="drop-zone__body">
        <h2>{video ? 'Video ready' : 'Choose a local video'}</h2>
        <p>
          MP4, WebM, MOV, and MKV are accepted when your browser and FFmpeg.wasm can decode the codecs.
          Processing stays on this device.
        </p>

        {video ? (
          <dl className="file-facts">
            <div>
              <dt>Name</dt>
              <dd>{video.file.name}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(video.file.size)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{video.duration ? formatDuration(video.duration) : 'Waiting for metadata'}</dd>
            </div>
          </dl>
        ) : null}

        <div className="drop-zone__actions">
          <button className="button button--primary" type="button" onClick={() => inputRef.current?.click()}>
            Choose video
          </button>
          {video ? (
            <button className="button button--ghost" type="button" onClick={onRemoveVideo}>
              <X size={16} />
              Remove
            </button>
          ) : null}
        </div>

        {[...warnings, ...errors].length ? (
          <div className="message-stack" aria-live="polite">
            {warnings.map((warning) => (
              <p className="notice notice--warning" key={warning}>
                {warning}
              </p>
            ))}
            {errors.map((error) => (
              <p className="notice notice--error" key={error}>
                {error}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
