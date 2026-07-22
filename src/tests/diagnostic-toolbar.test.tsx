import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectToolbar } from '../components/ProjectToolbar'

describe('diagnostic log toolbar action', () => {
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

  it('exports the local debug report from a clearly labeled action', () => {
    const onExportDiagnostics = vi.fn()
    act(() => {
      root.render(
        <ProjectToolbar
          entryCount={0}
          hasAutosave={false}
          theme="light"
          onClearAutosave={() => undefined}
          onClearSubtitles={() => undefined}
          onExport={() => undefined}
          onExportDiagnostics={onExportDiagnostics}
          onImportFile={() => undefined}
          onRestoreAutosave={() => undefined}
          onThemeChange={() => undefined}
        />,
      )
    })

    const button = [...container.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === 'Export debug log',
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(onExportDiagnostics).toHaveBeenCalledOnce()
  })

  it('locks replacement and publication actions during an active job', () => {
    act(() => {
      root.render(
        <ProjectToolbar
          entryCount={2}
          hasAutosave
          locked
          theme="light"
          onClearAutosave={() => undefined}
          onClearSubtitles={() => undefined}
          onExport={() => undefined}
          onExportDiagnostics={() => undefined}
          onImportFile={() => undefined}
          onRestoreAutosave={() => undefined}
          onThemeChange={() => undefined}
        />,
      )
    })

    const disabledLabels = ['Import', 'Restore', 'SRT', 'VTT', 'TXT', 'JSON']
    for (const label of disabledLabels) {
      const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
      expect(button?.disabled, label).toBe(true)
    }
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Export debug log"]')?.disabled).toBe(false)
  })
})
