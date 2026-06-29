import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appStyles = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
const indexStyles = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')

describe('desktop subtitle editor layout', () => {
  it('lets the left workspace stack set the shared height while only the subtitle list scrolls', () => {
    expect(appStyles).toMatch(
      /@media \(min-width: 1281px\)[\s\S]*?\.workspace__right\s*{[^}]*contain:\s*size;[^}]*min-height:\s*0;/,
    )
    expect(appStyles).toMatch(
      /@media \(min-width: 1281px\)[\s\S]*?\.editor-panel\s*{[^}]*min-height:\s*0;/,
    )
    expect(appStyles).toMatch(/\.subtitle-list\s*{[^}]*overflow:\s*auto;/)
  })

  it('keeps the subtitle timeline horizontally scrollable with touch-safe drag handles', () => {
    expect(appStyles).toMatch(/\.subtitle-timeline__viewport\s*{[^}]*overflow-x:\s*auto;/)
    expect(appStyles).toMatch(/\.subtitle-timeline__cue\s*{[^}]*touch-action:\s*none;/)
    expect(appStyles).toMatch(/\.subtitle-timeline__handle\s*{[^}]*min-width:\s*24px;/)
    expect(appStyles).toMatch(/\.subtitle-timeline__playhead\s*{[^}]*touch-action:\s*none;/)
    expect(appStyles).toMatch(/\.subtitle-timeline__snap-guide\s*{[^}]*pointer-events:\s*none;/)
    expect(appStyles).toMatch(/\.subtitle-timeline__regeneration-handle\s*{[^}]*touch-action:\s*none;/)
    expect(appStyles).toMatch(/\.subtitle-timeline__regeneration-handle\s*{[^}]*width:\s*24px;/)
  })

  it('starts subtitle auto-scroll disabled', () => {
    expect(appSource).toMatch(/const \[autoScroll, setAutoScroll\] = useState\(false\)/)
  })

  it('uses the crisp compact typography scale without heavy UI controls', () => {
    expect(indexStyles).toMatch(/--font-ui:/)
    expect(indexStyles).toMatch(/--font-size-xs:\s*11px;/)
    expect(indexStyles).toMatch(/--font-size-sm:\s*12px;/)
    expect(indexStyles).toMatch(/--font-size-md:\s*13px;/)
    expect(indexStyles).toMatch(/--font-size-lg:\s*15px;/)
    expect(indexStyles).toMatch(/--font-size-xl:\s*17px;/)
    expect(indexStyles).toMatch(/--font-weight-medium:\s*500;/)
    expect(indexStyles).toMatch(/--font-weight-semibold:\s*600;/)
    expect(appStyles).toMatch(
      /\.button,\s*\.icon-button\s*{[^}]*font-weight:\s*var\(--font-weight-semibold\);/,
    )
    expect(appStyles).toMatch(
      /\.settings-grid label,[\s\S]*?\.tool-row label\s*{[^}]*font-weight:\s*var\(--font-weight-semibold\);/,
    )
    expect(appStyles).toMatch(
      /\.settings-grid input,[\s\S]*?\.subtitle-row textarea\s*{[^}]*font-weight:\s*var\(--font-weight-regular\);/,
    )
    expect(appStyles).toMatch(
      /\.subtitle-overlay\s*{[^}]*font-weight:\s*var\(--font-weight-bold\);/,
    )
  })

  it('keeps the global file overlay fixed, non-blocking, and motion-aware', () => {
    expect(appStyles).toMatch(/\.global-video-drop\s*{[^}]*inset:\s*0;[^}]*pointer-events:\s*none;[^}]*position:\s*fixed;/)
    expect(appStyles).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\.global-video-drop__message\s*{[^}]*animation:/,
    )
  })

  it('keeps the whole subtitle workspace readable in fullscreen with safe-area padding', () => {
    expect(appStyles).toMatch(/\.video-panel:fullscreen\s*{[^}]*padding:[^;]*env\(safe-area-inset-top\)/)
    expect(appStyles).toMatch(/\.video-panel:fullscreen\s*{[^}]*overflow-y:\s*auto;/)
    expect(appStyles).toMatch(/\.video-panel:fullscreen[\s\S]*?\.player-controls\s*{[^}]*position:\s*sticky;/)
  })

  it('uses a collapsible sticky player editor on narrow screens', () => {
    expect(appStyles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.player-subtitle-editor\s*{[^}]*position:\s*sticky;/,
    )
    expect(appStyles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.player-subtitle-editor__actions \.icon-button\s*{[^}]*min-height:\s*44px;/,
    )
    expect(appStyles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.regeneration-dialog\s*{[^}]*overflow-y:\s*auto;/,
    )
  })
})
