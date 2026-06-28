import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appStyles = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')

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
})
