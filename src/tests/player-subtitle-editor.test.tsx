import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerSubtitleEditor } from '../components/PlayerSubtitleEditor'
import { makeSubtitleEntry, sortAndRenumber } from '../subtitles/formatting'
import { DEFAULT_FORMATTING_PREFERENCES, type SubtitleEntry } from '../types/subtitles'

const entries = sortAndRenumber([
  makeSubtitleEntry({ id: 'first', startTime: 1, endTime: 2, text: 'First subtitle' }),
  makeSubtitleEntry({ id: 'second', startTime: 3, endTime: 5, text: 'Second subtitle' }),
])

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PlayerSubtitleEditor', () => {
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

  it('parses a timestamp draft and commits the selected subtitle update', () => {
    const onUpdate = vi.fn()
    renderEditor({ onUpdate })

    changeInput(input('Start time for subtitle 2'), '00:00:02.500')
    blur(input('Start time for subtitle 2'))

    expect(onUpdate).toHaveBeenCalledWith('second', { startTime: 2.5 })
  })

  it('keeps malformed timestamp text visible without committing it', () => {
    const onUpdate = vi.fn()
    renderEditor({ onUpdate })

    changeInput(input('End time for subtitle 2'), 'bad time')
    blur(input('End time for subtitle 2'))

    expect(input('End time for subtitle 2').value).toBe('bad time')
    expect(input('End time for subtitle 2').getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain('Use HH:MM:SS.mmm, MM:SS.mmm, or seconds.')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('reformats subtitle text on blur through the update callback', () => {
    renderHarness()

    const textarea = input('Subtitle 2 text') as HTMLTextAreaElement
    changeInput(textarea, 'A subtitle line that should wrap into a balanced second line')
    blur(textarea)

    expect(textarea.value).toContain('\n')
  })

  it('exposes navigation, range playback, duplication, and deletion actions', () => {
    const onSelect = vi.fn()
    const onPlayRange = vi.fn()
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    renderEditor({ onSelect, onPlayRange, onDuplicate, onDelete })

    click(button('Previous subtitle'))
    click(button('Play selected subtitle range'))
    click(button('Duplicate selected subtitle'))
    click(button('Delete selected subtitle'))

    expect(onSelect).toHaveBeenCalledWith('first')
    expect(onPlayRange).toHaveBeenCalledWith(3, 5)
    expect(onDuplicate).toHaveBeenCalledWith('second')
    expect(onDelete).toHaveBeenCalledWith('second')
  })

  function renderEditor(overrides: Partial<React.ComponentProps<typeof PlayerSubtitleEditor>> = {}) {
    act(() => {
      root.render(
        <PlayerSubtitleEditor
          entries={entries}
          entry={entries[1]}
          formatting={DEFAULT_FORMATTING_PREFERENCES}
          onDelete={() => undefined}
          onDuplicate={() => undefined}
          onPlayRange={() => undefined}
          onSeek={() => undefined}
          onSelect={() => undefined}
          onUpdate={() => undefined}
          {...overrides}
        />,
      )
    })
  }

  function renderHarness() {
    function Harness() {
      const [state, setState] = useState<SubtitleEntry[]>(entries)
      return (
        <PlayerSubtitleEditor
          entries={state}
          entry={state[1]}
          formatting={{ ...DEFAULT_FORMATTING_PREFERENCES, maxCharsPerLine: 24 }}
          onDelete={() => undefined}
          onDuplicate={() => undefined}
          onPlayRange={() => undefined}
          onSeek={() => undefined}
          onSelect={() => undefined}
          onUpdate={(id, patch) =>
            setState((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
          }
        />
      )
    }

    act(() => root.render(<Harness />))
  }

  function input(label: string): HTMLInputElement | HTMLTextAreaElement {
    return container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement
  }

  function button(label: string): HTMLButtonElement {
    return container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
  }
})

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function blur(input: HTMLElement): void {
  act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
