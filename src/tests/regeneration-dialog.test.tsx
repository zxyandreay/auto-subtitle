import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RegenerationDialog, type FormattedRegenerationCandidate } from '../components/RegenerationDialog'
import { makeSubtitleEntry } from '../subtitles/formatting'
import { DISTIL_LARGE_V3_MODEL_ID, LARGE_V3_TURBO_MODEL_ID } from '../transcription/models'
import {
  createRegenerationPreferences,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  type TranscriptionProgress,
} from '../transcription/types'

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

  it('blocks generation when the edited range exceeds 29 seconds', () => {
    renderDialog()
    changeInput(input('Regeneration end time'), '00:00:43.000')

    expect(container.textContent).toContain('Regeneration ranges cannot exceed 29 seconds.')
    expect(button('Generate alternatives').disabled).toBe(true)
  })

  it('shows applicable regeneration-only settings and disables incompatible models', () => {
    renderDialog({
      preferences: {
        ...createRegenerationPreferences(DEFAULT_TRANSCRIPTION_SETTINGS),
        language: 'japanese',
      },
    })

    expect(select('Regeneration spoken language').value).toBe('japanese')
    expect(select('Regeneration output').value).toBe('transcribe')
    expect(select('Regeneration model').options).toHaveLength(4)
    expect(select('Regeneration model').querySelector<HTMLOptionElement>(`option[value="${DISTIL_LARGE_V3_MODEL_ID}"]`)?.disabled).toBe(true)
    expect(select('Regeneration timestamp detail').value).toBe('word')
  })

  it('keeps changed settings session-local and invalidates displayed candidates', () => {
    const onPreferencesChange = vi.fn()
    renderDialog({
      candidates: [formattedCandidate('candidate-1', 'Alternative.')],
      onPreferencesChange,
    })
    expect(container.textContent).toContain('Alternative 1')

    changeSelect(select('Regeneration model'), LARGE_V3_TURBO_MODEL_ID)

    expect(onPreferencesChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: LARGE_V3_TURBO_MODEL_ID }))
    expect(container.textContent).not.toContain('Alternative 1')
  })

  it('reports valid precise range edits back to the timeline on blur', () => {
    const onRangeChange = vi.fn()
    renderDialog({ onRangeChange })
    changeInput(input('Regeneration start time'), '00:00:11.000')
    blur(input('Regeneration start time'))

    expect(onRangeChange).toHaveBeenCalledWith({ startTime: 11, endTime: 18.9 })
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
          preferences={createRegenerationPreferences(DEFAULT_TRANSCRIPTION_SETTINGS)}
          capabilities={{
            webAssembly: true,
            webWorkers: true,
            indexedDb: true,
            sharedArrayBuffer: true,
            crossOriginIsolated: true,
            webGpu: true,
            audioContext: true,
            wasmFallback: true,
          }}
          capabilityWarnings={[]}
          range={{ startTime: 12.4, endTime: 18.9 }}
          videoDuration={60}
          onApply={() => undefined}
          onCancel={() => undefined}
          onGenerate={() => undefined}
          onPreview={() => undefined}
          onPreferencesChange={() => undefined}
          onRangeChange={() => undefined}
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

  function select(label: string): HTMLSelectElement {
    return container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
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

function changeSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function blur(element: HTMLElement): void {
  act(() => element.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
