import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalVideoDropOverlay } from '../components/GlobalVideoDropOverlay'
import { FileDropZone } from '../components/FileDropZone'
import { findFirstValidVideoFile } from '../media/video'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('global video file drop', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('accepts a supported video anywhere and prevents browser file navigation', () => {
    const onDropFiles = vi.fn()
    const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' })
    renderOverlay(onDropFiles)

    dispatchWindowDrag('dragenter', fileTransfer([video]))
    expect(container.textContent).toContain('Drop your video anywhere to load it')

    const drop = dispatchWindowDrag('drop', fileTransfer([video]))
    expect(drop.defaultPrevented).toBe(true)
    expect(onDropFiles).toHaveBeenCalledWith([video])
    expect(container.querySelector('.global-video-drop')).toBeNull()
  })

  it('does not activate or intercept non-file and internal drags', () => {
    const onDropFiles = vi.fn()
    renderOverlay(onDropFiles)

    const drag = dispatchWindowDrag('dragenter', { types: ['text/plain'], items: [], files: fileList([]) })

    expect(drag.defaultPrevented).toBe(false)
    expect(container.querySelector('.global-video-drop')).toBeNull()
    expect(onDropFiles).not.toHaveBeenCalled()
  })

  it('clears the overlay when the browser omits file types on the final dragleave', () => {
    renderOverlay(() => undefined)
    const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' })
    dispatchWindowDrag('dragenter', fileTransfer([video]))

    dispatchWindowDrag('dragleave', { types: [], items: [], files: fileList([]) })

    expect(container.querySelector('.global-video-drop')).toBeNull()
  })

  it('selects the first valid video when a drop contains mixed files', () => {
    const invalid = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    const video = new File(['video'], 'clip.webm', { type: 'video/webm' })

    expect(
      findFirstValidVideoFile([invalid, video], {
        fileSizeWarningMb: 500,
        durationWarningMinutes: 30,
      }),
    ).toEqual({ file: video, rejectedCount: 1 })
  })

  it('lets the existing drop zone handle a file once and still clears the page overlay', () => {
    const onGlobalDrop = vi.fn()
    const onSelectFile = vi.fn()
    const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' })
    act(() => {
      root.render(
        <>
          <GlobalVideoDropOverlay onDropFiles={onGlobalDrop} />
          <FileDropZone
            errors={[]}
            video={null}
            warnings={[]}
            onRemoveVideo={() => undefined}
            onSelectFile={onSelectFile}
          />
        </>,
      )
    })
    dispatchWindowDrag('dragenter', fileTransfer([video]))

    dispatchDrag(container.querySelector('.drop-zone')!, 'drop', fileTransfer([video]))

    expect(onSelectFile).toHaveBeenCalledOnce()
    expect(onGlobalDrop).not.toHaveBeenCalled()
    expect(container.querySelector('.global-video-drop')).toBeNull()
  })

  function renderOverlay(onDropFiles: (files: File[]) => void) {
    act(() => root.render(<GlobalVideoDropOverlay onDropFiles={onDropFiles} />))
  }
})

type DataTransferStub = {
  types: string[]
  items: Array<{ kind: string; type: string }>
  files: FileList
  dropEffect?: string
}

function fileTransfer(files: File[]): DataTransferStub {
  return {
    types: ['Files'],
    items: files.map((file) => ({ kind: 'file', type: file.type })),
    files: fileList(files),
  }
}

function fileList(files: File[]): FileList {
  return {
    ...files,
    length: files.length,
    item: (index: number) => files[index] ?? null,
  } as FileList
}

function dispatchWindowDrag(type: string, dataTransfer: DataTransferStub): Event {
  return dispatchDrag(window, type, dataTransfer)
}

function dispatchDrag(target: EventTarget, type: string, dataTransfer: DataTransferStub): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  act(() => target.dispatchEvent(event))
  return event
}
