import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer } from '../components/VideoPlayer'
import { makeSubtitleEntry, sortAndRenumber } from '../subtitles/formatting'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'

const subtitles = sortAndRenumber([
  makeSubtitleEntry({ id: 'first', startTime: 1, endTime: 3, text: 'Canonical subtitle' }),
  makeSubtitleEntry({ id: 'second', startTime: 4, endTime: 6, text: 'Second subtitle' }),
])

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('VideoPlayer subtitle workspace', () => {
  let container: HTMLDivElement
  let root: Root
  let fullscreenElement: Element | null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    fullscreenElement = null
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    })
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => {
        fullscreenElement = container.querySelector('.video-panel')
        document.dispatchEvent(new Event('fullscreenchange'))
        return Promise.resolve()
      }),
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(() => {
        fullscreenElement = null
        document.dispatchEvent(new Event('fullscreenchange'))
        return Promise.resolve()
      }),
    })
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('pauses and adds a subtitle at the media element exact playhead', () => {
    const onAddSubtitleAt = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    renderPlayer({ onAddSubtitleAt, videoRef })
    const video = container.querySelector('video')!
    video.currentTime = 12.345

    click(button('Add subtitle at current video time'))

    expect(video.pause).toHaveBeenCalled()
    expect(onAddSubtitleAt).toHaveBeenCalledWith(12.345)
  })

  it('uses preview subtitles only for the video overlay', () => {
    const preview = [makeSubtitleEntry({ id: 'preview', startTime: 1, endTime: 3, text: 'Preview subtitle' })]
    renderPlayer({ currentTime: 2, overlaySubtitles: preview, selectedSubtitleId: 'first' })

    expect(container.querySelector('.subtitle-overlay')?.textContent).toContain('Preview subtitle')
    expect((container.querySelector('textarea[aria-label="Subtitle 1 text"]') as HTMLTextAreaElement).value).toBe(
      'Canonical subtitle',
    )
  })

  it('selects a timeline subtitle through the controlled callback', () => {
    const onSelectSubtitle = vi.fn()
    renderPlayer({ onSelectSubtitle })

    click(container.querySelector('[data-subtitle-id="second"]') as HTMLElement)

    expect(onSelectSubtitle).toHaveBeenCalledWith('second')
  })

  it('seeks the media element directly while dragging the timeline playhead', () => {
    const onTime = vi.fn()
    const onUpdateSubtitle = vi.fn()
    renderPlayer({ onTime, onUpdateSubtitle })
    const playhead = button('Timeline playhead')
    const video = container.querySelector('video')!

    pointer(playhead, 'pointerdown', 12, 0)
    pointer(playhead, 'pointermove', 12, 72)

    expect(video.currentTime).toBe(3)
    expect(onTime).toHaveBeenLastCalledWith(3)
    expect(onUpdateSubtitle).not.toHaveBeenCalled()
  })

  it('forwards timeline history and split controls', () => {
    const onSplitAtPlayhead = vi.fn()
    const onUndo = vi.fn()
    renderPlayer({
      canSplitAtPlayhead: true,
      canUndo: true,
      onSplitAtPlayhead,
      onUndo,
    } as Partial<React.ComponentProps<typeof VideoPlayer>>)

    click(button('Undo subtitle edit from timeline'))
    click(button('Split selected subtitle at playhead'))

    expect(onUndo).toHaveBeenCalledOnce()
    expect(onSplitAtPlayhead).toHaveBeenCalledOnce()
  })

  it('forwards timeline regeneration range state and actions', () => {
    const onCancelRegeneration = vi.fn()
    const onConfigureRegeneration = vi.fn()
    const onPreviewRegeneration = vi.fn()
    const onStartRegeneration = vi.fn()
    renderPlayer({
      canRegenerate: true,
      regenerationRange: { startTime: 1, endTime: 4 },
      onCancelRegeneration,
      onConfigureRegeneration,
      onPreviewRegeneration,
      onStartRegeneration,
    })

    expect(container.querySelector('.subtitle-timeline__regeneration-range')).not.toBeNull()
    click(button('Preview regeneration range'))
    click(button('Configure regeneration'))
    click(button('Cancel timeline regeneration range'))

    expect(onPreviewRegeneration).toHaveBeenCalledOnce()
    expect(onConfigureRegeneration).toHaveBeenCalledOnce()
    expect(onCancelRegeneration).toHaveBeenCalledOnce()
    expect(onStartRegeneration).not.toHaveBeenCalled()
  })

  it('enters and exits fullscreen on the whole player workspace', async () => {
    renderPlayer()
    const workspace = container.querySelector('.video-panel') as HTMLElement

    click(button('Enter fullscreen subtitle workspace'))
    await act(async () => Promise.resolve())

    expect(workspace.requestFullscreen).toHaveBeenCalled()
    expect(button('Exit fullscreen subtitle workspace')).not.toBeNull()
    expect(button('Split selected subtitle at playhead')).not.toBeNull()

    click(button('Exit fullscreen subtitle workspace'))
    await act(async () => Promise.resolve())

    expect(document.exitFullscreen).toHaveBeenCalled()
    expect(button('Enter fullscreen subtitle workspace')).not.toBeNull()
  })

  it('recovers when fullscreen is denied', async () => {
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => Promise.reject(new Error('Denied'))),
    })
    renderPlayer()

    click(button('Enter fullscreen subtitle workspace'))
    await act(async () => Promise.resolve())

    expect(container.textContent).toContain('Fullscreen is unavailable or was denied.')
    expect(button('Enter fullscreen subtitle workspace')).not.toBeNull()
  })

  function renderPlayer(overrides: Partial<React.ComponentProps<typeof VideoPlayer>> = {}) {
    act(() => {
      root.render(
        <VideoPlayer
          canRedo={false}
          canSplitAtPlayhead={false}
          canUndo={false}
          canRegenerate={false}
          currentTime={0}
          duration={20}
          formatting={DEFAULT_FORMATTING_PREFERENCES}
          src="blob:test-video"
          subtitles={subtitles}
          subtitlesVisible
          videoRef={createRef<HTMLVideoElement>()}
          onAddSubtitleAt={() => undefined}
          onDeleteSubtitle={() => undefined}
          onDuplicateSubtitle={() => undefined}
          onDuration={() => undefined}
          onPlayRange={() => undefined}
          onRedo={() => undefined}
          onSeek={() => undefined}
          onSelectSubtitle={() => undefined}
          onSplitAtPlayhead={() => undefined}
          onTime={() => undefined}
          onToggleSubtitles={() => undefined}
          onUndo={() => undefined}
          onUpdateSubtitle={() => undefined}
          onCancelRegeneration={() => undefined}
          onChangeRegenerationRange={() => undefined}
          onConfigureRegeneration={() => undefined}
          onPreviewRegeneration={() => undefined}
          onStartRegeneration={() => undefined}
          {...overrides}
        />,
      )
    })
  }

  function button(label: string): HTMLButtonElement {
    return container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
  }
})

function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function pointer(element: HTMLElement, type: string, pointerId: number, clientX: number): void {
  const event = new Event(type, { bubbles: true })
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    pointerId: { value: pointerId },
  })
  act(() => element.dispatchEvent(event))
}
