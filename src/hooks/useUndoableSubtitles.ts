import { useCallback, useReducer } from 'react'
import { sortAndRenumber } from '../subtitles/formatting'
import type { SubtitleEntry } from '../types/subtitles'

type HistoryState = {
  past: SubtitleEntry[][]
  present: SubtitleEntry[]
  future: SubtitleEntry[][]
  transaction?: {
    id: number
    draft: SubtitleEntry[]
  }
}

type HistoryAction =
  | { type: 'commit'; entries: SubtitleEntry[] }
  | { type: 'replace'; entries: SubtitleEntry[] }
  | { type: 'begin-transaction'; id: number }
  | { type: 'stage-transaction'; id: number; entries: SubtitleEntry[] }
  | { type: 'edit-transaction'; id: number; entries: SubtitleEntry[] }
  | { type: 'commit-transaction'; id: number; entries: SubtitleEntry[] }
  | { type: 'rollback-transaction'; id: number }
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

  const beginTransaction = useCallback((id: number) => {
    dispatch({ type: 'begin-transaction', id })
  }, [])

  const stageTransaction = useCallback((id: number, entries: SubtitleEntry[]) => {
    dispatch({ type: 'stage-transaction', id, entries })
  }, [])

  const editTransaction = useCallback((id: number, entries: SubtitleEntry[]) => {
    dispatch({ type: 'edit-transaction', id, entries })
  }, [])

  const commitTransaction = useCallback((id: number, entries: SubtitleEntry[]) => {
    dispatch({ type: 'commit-transaction', id, entries })
  }, [])

  const rollbackTransaction = useCallback((id: number) => {
    dispatch({ type: 'rollback-transaction', id })
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
    subtitles: state.transaction?.draft ?? state.present,
    committedSubtitles: state.present,
    transactionActive: Boolean(state.transaction),
    canUndo: !state.transaction && state.past.length > 0,
    canRedo: !state.transaction && state.future.length > 0,
    commit,
    replace,
    clear,
    undo,
    redo,
    beginTransaction,
    stageTransaction,
    editTransaction,
    commitTransaction,
    rollbackTransaction,
  }
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'commit': {
      if (state.transaction) {
        return state
      }
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
    case 'begin-transaction':
      if (state.transaction) {
        return state
      }
      return {
        ...state,
        transaction: {
          id: action.id,
          draft: state.present,
        },
      }
    case 'stage-transaction':
    case 'edit-transaction':
      if (state.transaction?.id !== action.id) {
        return state
      }
      return {
        ...state,
        transaction: {
          ...state.transaction,
          draft: sortAndRenumber(action.entries),
        },
      }
    case 'commit-transaction': {
      if (state.transaction?.id !== action.id) {
        return state
      }
      const next = sortAndRenumber(action.entries)
      if (sameSubtitleEntries(state.present, next)) {
        const { transaction: _transaction, ...committedState } = state
        return committedState
      }
      return {
        past: [...state.past, state.present].slice(-80),
        present: next,
        future: [],
      }
    }
    case 'rollback-transaction': {
      if (state.transaction?.id !== action.id) {
        return state
      }
      const { transaction: _transaction, ...committedState } = state
      return committedState
    }
    case 'replace':
      if (state.transaction) {
        return state
      }
      return {
        past: [],
        present: sortAndRenumber(action.entries),
        future: [],
      }
    case 'clear':
      if (state.transaction) {
        return state
      }
      return initialState
    case 'undo': {
      if (state.transaction) {
        return state
      }
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
      if (state.transaction) {
        return state
      }
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
