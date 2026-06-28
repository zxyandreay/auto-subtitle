export type HistoryShortcut = 'undo' | 'redo'

type HistoryShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

export function getHistoryShortcut(event: HistoryShortcutEvent): HistoryShortcut | undefined {
  if (!event.ctrlKey && !event.metaKey) {
    return undefined
  }
  const key = event.key.toLowerCase()
  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo'
  }
  return key === 'y' ? 'redo' : undefined
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    return true
  }
  if (target.matches('input, textarea, select')) {
    return true
  }
  let current: Element | null = target
  while (current) {
    const editable = current as HTMLElement
    if (
      (editable.contentEditable && editable.contentEditable !== 'inherit' && editable.contentEditable !== 'false') ||
      current.getAttribute('contenteditable') === ''
    ) {
      return true
    }
    current = current.parentElement
  }
  return false
}
