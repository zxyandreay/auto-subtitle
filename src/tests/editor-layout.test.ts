import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appStyles = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
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
  })

  it('starts subtitle auto-scroll disabled', () => {
    expect(appSource).toMatch(/const \[autoScroll, setAutoScroll\] = useState\(false\)/)
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
  })
})
