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

  it('keeps committed subtitles and both history stacks untouched when a draft rolls back', () => {
    const first = makeSubtitleEntry({ id: 'first', startTime: 0, endTime: 2, text: 'First' })
    const second = makeSubtitleEntry({ id: 'second', startTime: 2, endTime: 4, text: 'Second' })
    const partial = makeSubtitleEntry({ id: 'partial', startTime: 0, endTime: 1, text: 'Partial' })

    act(() => history.commit([first]))
    act(() => history.commit([second]))
    act(() => history.undo())
    act(() => history.beginTransaction(1))
    act(() => history.stageTransaction(1, [partial]))

    expect(history.subtitles).toEqual([{ ...partial, index: 1 }])
    expect(history.committedSubtitles).toEqual([{ ...first, index: 1 }])
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)

    act(() => history.rollbackTransaction(1))
    expect(history.subtitles).toEqual([{ ...first, index: 1 }])
    expect(history.transactionActive).toBe(false)
    expect(history.canRedo).toBe(true)

    act(() => history.redo())
    expect(history.subtitles).toEqual([{ ...second, index: 1 }])
  })

  it('commits all partial and draft edits as one undoable action', () => {
    const base = makeSubtitleEntry({ id: 'base', startTime: 0, endTime: 2, text: 'Base' })
    const partial = makeSubtitleEntry({ id: 'generated', startTime: 0, endTime: 2, text: 'Partial' })
    const edited = { ...partial, text: 'Edited draft' }
    const final = { ...edited, text: 'Final draft' }

    act(() => history.commit([base]))
    act(() => history.beginTransaction(10))
    act(() => history.stageTransaction(10, [partial]))
    act(() => history.editTransaction(10, [edited]))
    act(() => history.commitTransaction(10, [final]))

    expect(history.subtitles[0]?.text).toBe('Final draft')
    expect(history.committedSubtitles[0]?.text).toBe('Final draft')
    act(() => history.undo())
    expect(history.subtitles).toEqual([{ ...base, index: 1 }])
  })

  it('ignores stale completion and rollback actions from an older transaction', () => {
    const base = makeSubtitleEntry({ id: 'base', startTime: 0, endTime: 2, text: 'Base' })
    const newer = makeSubtitleEntry({ id: 'newer', startTime: 0, endTime: 2, text: 'Newer partial' })
    const stale = makeSubtitleEntry({ id: 'stale', startTime: 0, endTime: 2, text: 'Stale final' })

    act(() => history.commit([base]))
    act(() => history.beginTransaction(20))
    act(() => history.rollbackTransaction(20))
    act(() => history.beginTransaction(21))
    act(() => history.stageTransaction(21, [newer]))
    act(() => history.commitTransaction(20, [stale]))
    act(() => history.rollbackTransaction(20))

    expect(history.transactionActive).toBe(true)
    expect(history.subtitles).toEqual([{ ...newer, index: 1 }])
    expect(history.committedSubtitles).toEqual([{ ...base, index: 1 }])
  })

  function Harness() {
    history = useUndoableSubtitles()
    return <span>{history.subtitles.length}</span>
  }
})
