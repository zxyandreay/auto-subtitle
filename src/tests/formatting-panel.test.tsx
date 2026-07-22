import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FormattingPanel } from '../components/FormattingPanel'
import { DEFAULT_FORMATTING_PREFERENCES } from '../types/subtitles'

describe('FormattingPanel job lock', () => {
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

  it('disables formatting changes and destructive reformatting while a job is active', () => {
    const onChange = vi.fn()
    const onReformat = vi.fn()
    act(() => {
      root.render(
        <FormattingPanel
          disabled
          preferences={DEFAULT_FORMATTING_PREFERENCES}
          onChange={onChange}
          onReformat={onReformat}
        />,
      )
    })

    expect([...container.querySelectorAll('input')].every((input) => input.disabled)).toBe(true)
    const reformat = container.querySelector<HTMLButtonElement>('button')
    expect(reformat?.disabled).toBe(true)
    act(() => reformat?.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(onReformat).not.toHaveBeenCalled()
  })
})
