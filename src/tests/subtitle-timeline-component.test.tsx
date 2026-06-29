import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubtitleTimeline } from '../components/SubtitleTimeline'
import { makeSubtitleEntry, sortAndRenumber } from '../subtitles/formatting'

const entries = sortAndRenumber([
  makeSubtitleEntry({ id: 'first', startTime: 1, endTime: 3, text: 'First subtitle' }),
  makeSubtitleEntry({ id: 'second', startTime: 2.5, endTime: 4, text: 'Second subtitle' }),
])

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SubtitleTimeline', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders accessible active, selected, and validation cue states', () => {
    renderTimeline({ currentTime: 2.75, selectedId: 'second' })

    const cue = timelineCue(2)
    expect(cue.getAttribute('aria-label')).toContain('Subtitle 2')
    expect(cue.getAttribute('aria-label')).toContain('Second subtitle')
    expect(cue.getAttribute('aria-pressed')).toBe('true')
    expect(cue.parentElement?.className).toContain('subtitle-timeline__cue--active')
    expect(cue.parentElement?.className).toContain('subtitle-timeline__cue--error')
    expect(button('Adjust start time for subtitle 2')).not.toBeNull()
    expect(button('Adjust end time for subtitle 2')).not.toBeNull()
  })

  it('selects and seeks a clicked cue', () => {
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    renderTimeline({ onSelect, onSeek })

    click(timelineCue(1))

    expect(onSelect).toHaveBeenCalledWith('first')
    expect(onSeek).toHaveBeenCalledWith(1)
  })

  it('seeks a snapped empty-track click and lets Alt bypass snapping', () => {
    const onSeek = vi.fn()
    renderTimeline({ onSeek })
    const track = container.querySelector('.subtitle-timeline__track') as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, width: 240 }))

    clickAt(track, 66)
    expect(onSeek).toHaveBeenLastCalledWith(3)
    expect(container.querySelector('.subtitle-timeline__snap-guide')?.textContent).toContain('subtitle 1 end')

    clickAt(track, 66, true)
    expect(onSeek).toHaveBeenLastCalledWith(2.75)
  })

  it('toggles magnetic snapping for empty-track clicks', () => {
    const onSeek = vi.fn()
    renderTimeline({ onSeek })
    const track = container.querySelector('.subtitle-timeline__track') as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(rect({ left: 0, width: 240 }))
    const disableMagnet = button('Disable timeline magnetic snapping')

    expect(disableMagnet.className).toContain('icon-button--soft')
    clickAt(track, 66)
    expect(onSeek).toHaveBeenLastCalledWith(3)

    click(disableMagnet)
    expect(button('Enable timeline magnetic snapping').className).toContain('icon-button--ghost')
    clickAt(track, 66)
    expect(onSeek).toHaveBeenLastCalledWith(2.75)
    expect(container.querySelector('.subtitle-timeline__snap-guide')).toBeNull()
  })

  it('disables magnetic snapping for playhead, cue, and boundary drags', () => {
    const onSeek = vi.fn()
    const onUpdate = vi.fn()
    renderTimeline({ onSeek, onUpdate })
    click(button('Disable timeline magnetic snapping'))

    const playhead = button('Timeline playhead')
    pointer(playhead, 'pointerdown', 13, 0)
    pointer(playhead, 'pointermove', 13, 66)
    expect(onSeek).toHaveBeenLastCalledWith(2.75)

    const cue = timelineCue(1)
    pointer(cue, 'pointerdown', 14, 100)
    pointer(cue, 'pointermove', 14, 121)
    pointer(cue, 'pointerup', 14, 121)
    expect(onUpdate).toHaveBeenNthCalledWith(1, 'first', { startTime: 1.875, endTime: 3.875 })

    const startHandle = button('Adjust start time for subtitle 1')
    pointer(startHandle, 'pointerdown', 15, 100)
    pointer(startHandle, 'pointermove', 15, 113)
    pointer(startHandle, 'pointerup', 15, 113)
    expect(onUpdate).toHaveBeenNthCalledWith(2, 'first', { startTime: 1.542, endTime: 3 })
    expect(container.querySelector('.subtitle-timeline__snap-guide')).toBeNull()
  })

  it('renders dedicated history and split controls with their enabled states', () => {
    const onRedo = vi.fn()
    const onSplitAtPlayhead = vi.fn()
    const onUndo = vi.fn()
    renderTimeline({
      canRedo: false,
      canSplitAtPlayhead: true,
      canUndo: true,
      onRedo,
      onSplitAtPlayhead,
      onUndo,
    } as Partial<React.ComponentProps<typeof SubtitleTimeline>>)

    const undo = button('Undo subtitle edit from timeline')
    const redo = button('Redo subtitle edit from timeline')
    const split = button('Split selected subtitle at playhead')
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(true)
    expect(split.disabled).toBe(false)

    click(undo)
    click(split)
    expect(onUndo).toHaveBeenCalledOnce()
    expect(onRedo).not.toHaveBeenCalled()
    expect(onSplitAtPlayhead).toHaveBeenCalledOnce()
  })

  it('supports keyboard movement and boundary nudging without global seek propagation', () => {
    const onUpdate = vi.fn()
    renderTimeline({ onUpdate })

    keyDown(timelineCue(1), 'ArrowRight')
    keyDown(button('Adjust start time for subtitle 1'), 'ArrowRight', true)

    expect(onUpdate).toHaveBeenNthCalledWith(1, 'first', { startTime: 1.1, endTime: 3.1 })
    expect(onUpdate).toHaveBeenNthCalledWith(2, 'first', { startTime: 1.5, endTime: 3 })
  })

  it('captures a pointer drag and commits one duration-preserving update on release', () => {
    const onUpdate = vi.fn()
    renderTimeline({ onUpdate })
    const cue = timelineCue(1)

    pointer(cue, 'pointerdown', 7, 100)
    pointer(cue, 'pointermove', 7, 124)
    expect(cue.parentElement?.className).toContain('subtitle-timeline__cue--dragging')
    expect(container.querySelector('.subtitle-timeline__snap-guide')?.textContent).toContain('subtitle 2 end')
    pointer(cue, 'pointerup', 7, 124)

    expect(cue.setPointerCapture).toHaveBeenCalledWith(7)
    expect(onUpdate).toHaveBeenCalledOnce()
    expect(onUpdate).toHaveBeenCalledWith('first', { startTime: 2, endTime: 4 })
    expect(container.querySelector('.subtitle-timeline__snap-guide')).toBeNull()
  })

  it('disables cue snapping while Alt is held', () => {
    const onUpdate = vi.fn()
    renderTimeline({ onUpdate })
    const cue = timelineCue(1)

    pointer(cue, 'pointerdown', 8, 100)
    pointer(cue, 'pointermove', 8, 113, true)
    expect(container.querySelector('.subtitle-timeline__snap-guide')).toBeNull()
    pointer(cue, 'pointerup', 8, 113, true)

    expect(onUpdate).toHaveBeenCalledWith('first', { startTime: 1.542, endTime: 3.542 })
  })

  it('drags the accessible playhead to seek without committing subtitle history', () => {
    const onSeek = vi.fn()
    const onUpdate = vi.fn()
    renderTimeline({ onSeek, onUpdate })
    const playhead = button('Timeline playhead')

    pointer(playhead, 'pointerdown', 9, 0)
    pointer(playhead, 'pointermove', 9, 72)

    expect(playhead.getAttribute('role')).toBe('slider')
    expect(onSeek).toHaveBeenLastCalledWith(3)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(container.querySelector('.subtitle-timeline__playhead-time')?.textContent).toContain('00:00:03.000')
    expect(container.querySelector('.subtitle-timeline__snap-guide')?.textContent).toContain('subtitle 1 end')

    pointer(playhead, 'pointerup', 9, 72)
    expect(container.querySelector('.subtitle-timeline__playhead-time')).toBeNull()
  })

  it('uses a continuous zoom slider and keeps the playhead-follow toggle', () => {
    renderTimeline()
    const slider = container.querySelector('input[aria-label="Zoom subtitle timeline"]') as HTMLInputElement

    expect(slider.type).toBe('range')
    expect(slider.min).toBe('12')
    expect(slider.max).toBe('96')
    expect(slider.step).toBe('1')
    expect(slider.value).toBe('24')
    expect(button('Fit subtitle timeline to width')).toBeNull()
    expect(button('Disable timeline playhead follow')).not.toBeNull()

    input(slider, '60')
    expect(slider.value).toBe('60')
    expect(timelineCue(1).parentElement?.style.left).toBe('60px')
  })

  function renderTimeline(overrides: Partial<React.ComponentProps<typeof SubtitleTimeline>> = {}) {
    act(() => {
      root.render(
        <SubtitleTimeline
          canRedo={false}
          canSplitAtPlayhead={false}
          canUndo={false}
          currentTime={0}
          duration={10}
          entries={entries}
          minDuration={1.1}
          playing={false}
          onRedo={() => undefined}
          onSeek={() => undefined}
          onSelect={() => undefined}
          onSplitAtPlayhead={() => undefined}
          onUndo={() => undefined}
          onUpdate={() => undefined}
          {...overrides}
        />,
      )
    })
  }

  function timelineCue(index: number): HTMLElement {
    return container.querySelector(`[data-subtitle-index="${index}"]`) as HTMLElement
  }

  function button(label: string): HTMLButtonElement {
    return container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
  }
})

function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function clickAt(element: HTMLElement, clientX: number, altKey = false): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { altKey, bubbles: true, clientX })))
}

function input(element: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  valueSetter?.call(element, value)
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })))
}

function keyDown(element: HTMLElement, key: string, shiftKey = false): void {
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, shiftKey })))
}

function pointer(element: HTMLElement, type: string, pointerId: number, clientX: number, altKey = false): void {
  const event = new Event(type, { bubbles: true })
  Object.defineProperties(event, {
    altKey: { value: altKey },
    button: { value: 0 },
    clientX: { value: clientX },
    pointerId: { value: pointerId },
  })
  act(() => element.dispatchEvent(event))
}

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    bottom: 64,
    height: 64,
    left: 0,
    right: 240,
    toJSON: () => ({}),
    top: 0,
    width: 240,
    x: 0,
    y: 0,
    ...overrides,
  }
}
