import { useCallback, useReducer } from 'react'
import { sortAndRenumber } from '../subtitles/formatting'
import type { SubtitleEntry } from '../types/subtitles'

type HistoryState = {
  past: SubtitleEntry[][]
  present: SubtitleEntry[]
  future: SubtitleEntry[][]
}

type HistoryAction =
  | { type: 'commit'; entries: SubtitleEntry[] }
  | { type: 'preview'; entries: SubtitleEntry[] }
  | { type: 'replace'; entries: SubtitleEntry[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clear' }

const initialState: HistoryState = {
  past: [],
  present: [],
  future: [],
}

export function useUndoableSubtitles() {
  const [state, dispatch] = useReducer(historyReducer, initialState)

  const commit = useCallback((entries: SubtitleEntry[]) => {
    dispatch({ type: 'commit', entries })
  }, [])

  const replace = useCallback((entries: SubtitleEntry[]) => {
    dispatch({ type: 'replace', entries })
  }, [])

  const preview = useCallback((entries: SubtitleEntry[]) => {
    dispatch({ type: 'preview', entries })
  }, [])

  const clear = useCallback(() => {
    dispatch({ type: 'clear' })
  }, [])

  const undo = useCallback(() => {
    dispatch({ type: 'undo' })
  }, [])

  const redo = useCallback(() => {
    dispatch({ type: 'redo' })
  }, [])

  return {
    subtitles: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    commit,
    preview,
    replace,
    clear,
    undo,
    redo,
  }
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'commit': {
      const next = sortAndRenumber(action.entries)
      if (sameSubtitleEntries(state.present, next)) {
        return state
      }
      return {
        past: [...state.past, state.present].slice(-80),
        present: next,
        future: [],
      }
    }
    case 'preview':
      return {
        past: state.past,
        present: sortAndRenumber(action.entries),
        future: [],
      }
    case 'replace':
      return {
        past: [],
        present: sortAndRenumber(action.entries),
        future: [],
      }
    case 'clear':
      return initialState
    case 'undo': {
      const previous = state.past.at(-1)
      if (!previous) {
        return state
      }

      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (!next) {
        return state
      }

      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
      }
    }
  }
}

function sameSubtitleEntries(first: SubtitleEntry[], second: SubtitleEntry[]): boolean {
  return (
    first.length === second.length &&
    first.every((entry, index) => {
      const other = second[index]
      return (
        entry.id === other.id &&
        entry.index === other.index &&
        entry.startTime === other.startTime &&
        entry.endTime === other.endTime &&
        entry.text === other.text &&
        entry.confidence === other.confidence &&
        sameSubtitleWords(entry.words, other.words)
      )
    })
  )
}

function sameSubtitleWords(first: SubtitleEntry['words'], second: SubtitleEntry['words']): boolean {
  if (first === second) {
    return true
  }
  return (
    first?.length === second?.length &&
    Boolean(
      first?.every((word, index) => {
        const other = second?.[index]
        return (
          word.text === other?.text &&
          word.startTime === other.startTime &&
          word.endTime === other.endTime &&
          word.confidence === other.confidence
        )
      }),
    )
  )
}
