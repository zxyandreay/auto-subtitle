import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useUndoableSubtitles } from '../hooks/useUndoableSubtitles'
import { makeSubtitleEntry } from '../subtitles/formatting'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('undoable subtitle history', () => {
  let container: HTMLDivElement
  let root: Root
  let history: ReturnType<typeof useUndoableSubtitles>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root.render(<Harness />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('does not add an identical blur-style commit that consumes the first undo', () => {
    const entry = makeSubtitleEntry({ id: 'cue', startTime: 0, endTime: 2, text: 'New subtitle' })

    act(() => history.commit([entry]))
    act(() => history.commit([{ ...entry }]))
    act(() => history.undo())

    expect(history.subtitles).toEqual([])
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)
  })

  function Harness() {
    history = useUndoableSubtitles()
    return <span>{history.subtitles.length}</span>
  }
})
