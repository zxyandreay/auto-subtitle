import { describe, expect, it } from 'vitest'
import { getHistoryShortcut, isEditableShortcutTarget, isSplitShortcut } from '../utils/keyboard'

describe('subtitle history keyboard shortcuts', () => {
  it('recognizes undo and both redo shortcut forms across platforms', () => {
    expect(getHistoryShortcut(keyboard('z', { ctrlKey: true }))).toBe('undo')
    expect(getHistoryShortcut(keyboard('z', { metaKey: true }))).toBe('undo')
    expect(getHistoryShortcut(keyboard('y', { ctrlKey: true }))).toBe('redo')
    expect(getHistoryShortcut(keyboard('z', { metaKey: true, shiftKey: true }))).toBe('redo')
  })

  it('recognizes the cross-platform split-at-playhead shortcut without extra modifiers', () => {
    expect(isSplitShortcut(keyboard('k', { ctrlKey: true }))).toBe(true)
    expect(isSplitShortcut(keyboard('K', { metaKey: true }))).toBe(true)
    expect(isSplitShortcut(keyboard('k', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isSplitShortcut(keyboard('k', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(isSplitShortcut(keyboard('j', { ctrlKey: true }))).toBe(false)
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
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>>,
): Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}
