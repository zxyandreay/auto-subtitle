import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RegenerationDialog, type FormattedRegenerationCandidate } from '../components/RegenerationDialog'
import { makeSubtitleEntry } from '../subtitles/formatting'
import type { TranscriptionProgress } from '../transcription/types'

const idleProgress: TranscriptionProgress = {
  stage: 'idle',
  message: 'Ready to regenerate.',
}

describe('RegenerationDialog', () => {
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

  it('opens with the subtitle range and current subtitles selected', () => {
    renderDialog()

    expect(input('Regeneration start time').value).toBe('00:00:12.400')
    expect(input('Regeneration end time').value).toBe('00:00:18.900')
    expect(radio('Keep current subtitles').checked).toBe(true)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('blocks generation when the edited range exceeds 30 seconds', () => {
    renderDialog()
    changeInput(input('Regeneration end time'), '00:00:43.000')

    expect(container.textContent).toContain('Regeneration ranges cannot exceed 30 seconds.')
    expect(button('Generate alternatives').disabled).toBe(true)
  })

  it('previews and applies the selected formatted alternative', () => {
    const onPreview = vi.fn()
    const onApply = vi.fn()
    const candidates = [formattedCandidate('candidate-1', 'A clearer regenerated subtitle.')]
    renderDialog({ candidates, onPreview, onApply })

    click(radio('Alternative 1'))
    click(button('Preview selected'))
    click(button('Apply alternative'))

    expect(onPreview).toHaveBeenCalledWith(candidates[0].entries, { startTime: 12.4, endTime: 18.9 })
    expect(onApply).toHaveBeenCalledWith(candidates[0].entries, { startTime: 12.4, endTime: 18.9 })
  })

  it('keeps the original as a no-change apply option', () => {
    const onApply = vi.fn()
    renderDialog({ candidates: [formattedCandidate('candidate-1', 'Alternative.')], onApply })

    click(button('Keep original'))

    expect(onApply).toHaveBeenCalledWith(null, { startTime: 12.4, endTime: 18.9 })
  })

  it('cancels from Escape', () => {
    const onCancel = vi.fn()
    renderDialog({ onCancel })

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    expect(onCancel).toHaveBeenCalledOnce()
  })

  function renderDialog(overrides: Partial<React.ComponentProps<typeof RegenerationDialog>> = {}) {
    const originalEntries = [
      makeSubtitleEntry({ id: 'original', startTime: 12.4, endTime: 18.9, text: 'Current subtitle.' }),
    ]
    act(() => {
      root.render(
        <RegenerationDialog
          busy={false}
          candidates={[]}
          error=""
          originalEntries={originalEntries}
          progress={idleProgress}
          range={{ startTime: 12.4, endTime: 18.9 }}
          videoDuration={60}
          onApply={() => undefined}
          onCancel={() => undefined}
          onGenerate={() => undefined}
          onPreview={() => undefined}
          {...overrides}
        />,
      )
    })
  }

  function input(label: string): HTMLInputElement {
    return container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
  }

  function radio(label: string): HTMLInputElement {
    return input(label)
  }

  function button(label: string): HTMLButtonElement {
    return [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!
  }
})

function formattedCandidate(id: string, text: string): FormattedRegenerationCandidate {
  return {
    id,
    entries: [makeSubtitleEntry({ id: `${id}-entry`, startTime: 12.5, endTime: 18.5, text })],
  }
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
