import { Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isAcceptedVideoMimeType } from '../media/video'

type GlobalVideoDropOverlayProps = {
  onDropFiles: (files: File[]) => void
}

type DragSupport = 'supported' | 'unsupported' | 'neutral'

export function GlobalVideoDropOverlay({ onDropFiles }: GlobalVideoDropOverlayProps) {
  const dragDepthRef = useRef(0)
  const onDropFilesRef = useRef(onDropFiles)
  const [dragSupport, setDragSupport] = useState<DragSupport>()
  onDropFilesRef.current = onDropFiles

  useEffect(() => {
    const clearDrag = () => {
      dragDepthRef.current = 0
      setDragSupport(undefined)
    }

    const handleDragEnter = (event: DragEvent) => {
      if (!hasExternalFiles(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      dragDepthRef.current += 1
      setDragSupport(getDragSupport(event.dataTransfer))
    }

    const handleDragOver = (event: DragEvent) => {
      if (!hasExternalFiles(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    }

    const handleDragLeave = () => {
      if (dragDepthRef.current === 0) {
        return
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) {
        setDragSupport(undefined)
      }
    }

    const handleDrop = (event: DragEvent) => {
      if (!hasExternalFiles(event.dataTransfer)) {
        return
      }
      const handledByChild = event.defaultPrevented
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files ?? [])
      clearDrag()
      if (files.length && !handledByChild) {
        onDropFilesRef.current(files)
      }
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)
    window.addEventListener('dragend', clearDrag)
    window.addEventListener('blur', clearDrag)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
      window.removeEventListener('dragend', clearDrag)
      window.removeEventListener('blur', clearDrag)
    }
  }, [])

  if (!dragSupport) {
    return null
  }

  const unsupported = dragSupport === 'unsupported'
  return (
    <div
      aria-live="polite"
      className={`global-video-drop ${unsupported ? 'global-video-drop--unsupported' : ''}`}
      role="status"
    >
      <div className="global-video-drop__message">
        <Upload aria-hidden="true" size={34} />
        <strong>{unsupported ? 'Unsupported file type' : 'Drop your video anywhere to load it'}</strong>
        <span>{unsupported ? 'Choose an MP4, WebM, MOV, or MKV file.' : 'Your video stays local in this browser.'}</span>
      </div>
    </div>
  )
}

function hasExternalFiles(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes('Files'))
}

function getDragSupport(dataTransfer: DataTransfer | null): DragSupport {
  const fileItems = Array.from(dataTransfer?.items ?? []).filter((item) => item.kind === 'file')
  if (!fileItems.length || fileItems.some((item) => !item.type)) {
    return 'neutral'
  }
  return fileItems.some((item) => isAcceptedVideoMimeType(item.type)) ? 'supported' : 'unsupported'
}
