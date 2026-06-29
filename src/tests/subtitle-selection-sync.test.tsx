import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubtitleEditor } from '../components/SubtitleEditor'
import { SubtitleTimeline } from '../components/SubtitleTimeline'
import { makeSubtitleEntry, sortAndRenumber } from '../subtitles/formatting'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'

const entries = sortAndRenumber([
  makeSubtitleEntry({ id: 'first', startTime: 1, endTime: 2, text: 'First subtitle' }),
  makeSubtitleEntry({ id: 'second', startTime: 3, endTime: 4, text: 'Second subtitle' }),
])

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('player and main editor subtitle selection', () => {
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

  it('shares selected subtitle state between the timeline and editor rows', () => {
    function Harness() {
      const [selectedId, setSelectedId] = useState('first')
      return (
        <>
          <SubtitleTimeline
            canRedo={false}
            canSplitAtPlayhead={false}
            canUndo={false}
            canRegenerate={false}
            currentTime={0}
            duration={10}
            entries={entries}
            minDuration={1.1}
            playing={false}
            selectedId={selectedId}
            onRedo={() => undefined}
            onSeek={() => undefined}
            onSelect={setSelectedId}
            onSplitAtPlayhead={() => undefined}
            onUndo={() => undefined}
            onUpdate={() => undefined}
            onCancelRegeneration={() => undefined}
            onChangeRegenerationRange={() => undefined}
            onConfigureRegeneration={() => undefined}
            onPreviewRegeneration={() => undefined}
            onStartRegeneration={() => undefined}
          />
          <SubtitleEditor
            activeEntryId="first"
            autoScroll={false}
            canRegenerate={false}
            capturePlayheadTime={() => 0}
            duration={10}
            entries={entries}
            formatting={DEFAULT_FORMATTING_PREFERENCES}
            selectedEntryId={selectedId}
            showOnlyErrors={false}
            onAutoScrollChange={() => undefined}
            onChange={() => undefined}
            onPlayRange={() => undefined}
            onRegenerate={() => undefined}
            onSeek={() => undefined}
            onSelectEntry={setSelectedId}
            onShowOnlyErrorsChange={() => undefined}
          />
        </>
      )
    }

    act(() => root.render(<Harness />))

    click(container.querySelector('[data-subtitle-id="second"]') as HTMLElement)
    expect(editorRow('second').className).toContain('subtitle-row--selected')

    focus(editorRow('first'))
    expect(container.querySelector('[data-subtitle-id="first"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  function editorRow(id: string): HTMLElement {
    return container.querySelector(`[data-editor-subtitle-id="${id}"]`) as HTMLElement
  }
})

function click(element: HTMLElement): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function focus(element: HTMLElement): void {
  act(() => element.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
}
