import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranscriptionPanel } from '../components/TranscriptionPanel'
import { DISTIL_LARGE_V3_MODEL_ID, LARGE_V3_TURBO_MODEL_ID } from '../transcription/models'
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  type TranscriptionProgress,
  type TranscriptionSettings,
} from '../transcription/types'

describe('TranscriptionPanel model choices', () => {
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

  it('shows all model metadata and disables Distil outside English transcription', () => {
    renderPanel({ language: 'japanese', task: 'transcribe' })

    const options = modelSelect().options
    expect(options).toHaveLength(4)
    expect(options[2].textContent).toContain('High accuracy model')
    expect(options[2].textContent).toContain('Large v3 Turbo')
    expect(options[3].textContent).toContain('English only')
    expect(options[3].textContent).toMatch(/\)$/)
    expect(options[3].disabled).toBe(true)
    expect(options[2].disabled).toBe(false)
  })

  it('disables transcription-only high-quality models for translation', () => {
    renderPanel({ language: 'english', task: 'translate' })

    expect(option(LARGE_V3_TURBO_MODEL_ID).disabled).toBe(true)
    expect(option(DISTIL_LARGE_V3_MODEL_ID).disabled).toBe(true)
  })

  it('shows actionable high-resource warnings without blocking the user', () => {
    renderPanel({
      modelId: LARGE_V3_TURBO_MODEL_ID,
      language: 'japanese',
      executionProvider: 'wasm',
      dtype: 'fp32',
    })

    expect(container.textContent).toContain('multilingual')
    expect(container.textContent).toContain('WebGPU and q8 are recommended')
    expect(container.textContent).toContain('This model is high-resource')
    expect(container.textContent).toContain('Full precision may require significantly more memory')
    expect(container.textContent).toContain('WASM CPU execution may be very slow')
    expect(button('Transcribe locally').disabled).toBe(false)
  })

  it('labels model progress as loading instead of always downloading', () => {
    renderPanel({}, { stage: 'downloading-model', message: 'Reading model files from browser cache.' })

    expect(container.textContent).toContain('Loading speech model')
  })

  it('explains the installed engine language fallback instead of claiming automatic detection', () => {
    renderPanel({ language: 'auto' })

    expect(container.textContent).toContain('Auto (English fallback)')
    expect(container.textContent).toContain('cannot detect Whisper language automatically')
    expect(container.textContent).toContain('Auto uses English')
  })

  it('discloses when the selected model cannot provide word timestamps', () => {
    renderPanel({
      modelId: DISTIL_LARGE_V3_MODEL_ID,
      language: 'english',
      formatting: {
        ...DEFAULT_TRANSCRIPTION_SETTINGS.formatting,
        useWordTimestamps: true,
      },
    })

    expect(container.textContent).toContain('does not expose word alignment timestamps')
    expect(container.textContent).toContain('segment timestamps without a failed retry')
  })

  it('offers WASM as the browser CPU path without an unsupported CPU device option', () => {
    renderPanel()

    const engine = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.trim().startsWith('Engine'))!
      .querySelector('select')!
    expect([...engine.options].map((item) => [item.value, item.textContent])).toEqual([
      ['auto', 'Auto'],
      ['webgpu', 'WebGPU'],
      ['wasm', 'WASM (CPU)'],
    ])
  })

  it('freezes every transcription setting while a job is busy and keeps cancel available', () => {
    renderPanel({}, { stage: 'transcribing', message: 'Working.' }, true)

    expect([...container.querySelectorAll('select, input')].every((control) => control.hasAttribute('disabled'))).toBe(true)
    expect(button('Transcribe locally').disabled).toBe(true)
    expect(button('Cancel').disabled).toBe(false)
    expect(container.textContent).toContain('Fallback overlap')
  })

  function renderPanel(
    overrides: Partial<TranscriptionSettings> = {},
    progress: TranscriptionProgress = { stage: 'idle', message: 'Ready.' },
    busy = false,
  ) {
    act(() => {
      root.render(
        <TranscriptionPanel
          busy={busy}
          capabilities={{
            webAssembly: true,
            webWorkers: true,
            indexedDb: true,
            sharedArrayBuffer: true,
            crossOriginIsolated: true,
            webGpu: false,
            audioContext: true,
            wasmFallback: true,
          }}
          capabilityWarnings={[]}
          hasVideo
          progress={progress}
          settings={{ ...DEFAULT_TRANSCRIPTION_SETTINGS, ...overrides }}
          onCancel={() => undefined}
          onSettingsChange={() => undefined}
          onStart={() => undefined}
        />,
      )
    })
  }

  function modelSelect(): HTMLSelectElement {
    return [...container.querySelectorAll('label')].find((label) => label.textContent?.trim().startsWith('Model'))!
      .querySelector('select')!
  }

  function option(value: string): HTMLOptionElement {
    return modelSelect().querySelector(`option[value="${value}"]`)!
  }

  function button(label: string): HTMLButtonElement {
    return [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!
  }
})
