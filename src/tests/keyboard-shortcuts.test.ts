import { describe, expect, it } from 'vitest'
import { getHistoryShortcut, isEditableShortcutTarget } from '../utils/keyboard'

describe('subtitle history keyboard shortcuts', () => {
  it('recognizes undo and both redo shortcut forms across platforms', () => {
    expect(getHistoryShortcut(keyboard('z', { ctrlKey: true }))).toBe('undo')
    expect(getHistoryShortcut(keyboard('z', { metaKey: true }))).toBe('undo')
    expect(getHistoryShortcut(keyboard('y', { ctrlKey: true }))).toBe('redo')
    expect(getHistoryShortcut(keyboard('z', { metaKey: true, shiftKey: true }))).toBe('redo')
  })

  it('ignores shortcuts inside form and contenteditable fields', () => {
    const input = document.createElement('input')
    const editor = document.createElement('div')
    const nested = document.createElement('span')
    const plainTextEditor = document.createElement('div')
    editor.contentEditable = 'true'
    plainTextEditor.contentEditable = 'plaintext-only'
    editor.append(nested)

    expect(isEditableShortcutTarget(input)).toBe(true)
    expect(isEditableShortcutTarget(nested)).toBe(true)
    expect(isEditableShortcutTarget(plainTextEditor)).toBe(true)
    expect(isEditableShortcutTarget(document.createElement('button'))).toBe(false)
  })
})

function keyboard(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>>,
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'> {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}
