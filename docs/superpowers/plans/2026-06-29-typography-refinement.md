# Typography Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved Crisp compact typography system across the editor without changing layout, behavior, themes, or caption-overlay legibility.

**Architecture:** Define global font, scale, and weight tokens in `src/index.css`, then consume them in the existing component selectors in `src/styles/app.css`. Keep the change CSS-driven so React markup and behavior remain untouched; protect the system with deterministic stylesheet assertions and existing UI tests.

**Tech Stack:** React 19, TypeScript, CSS custom properties, Vitest, Vite.

---

### Task 1: Lock the typography contract with a failing test

**Files:**
- Modify: `src/tests/editor-layout.test.ts`
- Test: `src/tests/editor-layout.test.ts`

- [ ] **Step 1: Add the stylesheet source and typography assertions**

Add `indexStyles` beside the existing stylesheet fixtures and a test that requires the approved tokens and weight hierarchy:

```ts
const indexStyles = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

it('uses the crisp compact typography scale without heavy UI controls', () => {
  expect(indexStyles).toMatch(/--font-ui:/)
  expect(indexStyles).toMatch(/--font-size-xs:\s*11px;/)
  expect(indexStyles).toMatch(/--font-size-sm:\s*12px;/)
  expect(indexStyles).toMatch(/--font-size-md:\s*13px;/)
  expect(indexStyles).toMatch(/--font-size-lg:\s*15px;/)
  expect(indexStyles).toMatch(/--font-size-xl:\s*17px;/)
  expect(indexStyles).toMatch(/--font-weight-medium:\s*500;/)
  expect(indexStyles).toMatch(/--font-weight-semibold:\s*600;/)
  expect(appStyles).toMatch(/\.button,\s*\.icon-button\s*{[^}]*font-weight:\s*var\(--font-weight-semibold\);/)
  expect(appStyles).toMatch(/\.settings-grid label,[\s\S]*?\.tool-row label\s*{[^}]*font-weight:\s*var\(--font-weight-semibold\);/)
  expect(appStyles).toMatch(/\.subtitle-overlay\s*{[^}]*font-weight:\s*var\(--font-weight-bold\);/)
})
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run: `npm.cmd test -- --run src/tests/editor-layout.test.ts`

Expected: FAIL because the typography tokens and semibold selector rules do not exist yet.

### Task 2: Implement the Crisp compact CSS system

**Files:**
- Modify: `src/index.css`
- Modify: `src/styles/app.css`
- Test: `src/tests/editor-layout.test.ts`

- [ ] **Step 1: Define global typography tokens**

Add these tokens to `src/index.css` and use the font token for the root stack:

```css
:root {
  --font-ui: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-size-xs: 11px;
  --font-size-sm: 12px;
  --font-size-md: 13px;
  --font-size-lg: 15px;
  --font-size-xl: 17px;
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.45;
}
```

- [ ] **Step 2: Apply the hierarchy to existing UI selectors**

In `src/styles/app.css`:

- Set `strong`, panel headings, brand heading, and dialog heading to semibold; use `17px` for primary headings and `15px` for compact headings.
- Set buttons, privacy indicator, file metadata labels, notice dismiss, form/tool labels, toggles, timeline snap text, row indices, and secondary row actions to semibold instead of 700/800.
- Use medium weight for secondary metadata where emphasis is useful but boldness is not.
- Use `letter-spacing: -0.01em` only on headings and `0.04em` on uppercase file-fact labels.
- Use the 11/12/13/15/17px tokens in the selectors touched by this pass and maintain 1.4–1.5 line heights for descriptions and editable text.
- Keep `.subtitle-overlay` at `var(--font-weight-bold)` and preserve its existing size and contrast.

Representative rules:

```css
strong {
  font-weight: var(--font-weight-semibold);
}

.brand h1,
.panel-heading h2,
.drop-zone h2,
.regeneration-dialog__header h2 {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
}

.button,
.icon-button {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.subtitle-overlay {
  font-weight: var(--font-weight-bold);
}
```

- [ ] **Step 3: Run the focused tests and typecheck**

Run: `npm.cmd test -- --run src/tests/editor-layout.test.ts src/tests/subtitle-timeline-component.test.tsx src/tests/player-subtitle-editor.test.tsx`

Expected: PASS.

Run: `npm.cmd run typecheck`

Expected: PASS.

### Task 3: Document the typography system

**Files:**
- Modify: `README.md`
- Modify: `docs/project-state.md`

- [ ] **Step 1: Update user-facing documentation**

Add a short README feature note stating that the interface uses a compact local/system typography scale with lighter UI emphasis and a deliberately bold video-caption overlay.

- [ ] **Step 2: Update architecture documentation**

Document the typography tokens, 11/12/13/15/17px scale, 400/500/600 UI weights, and the 700 caption-overlay exception in `docs/project-state.md` near the theme/style description.

### Task 4: Verify and deliver

**Files:**
- Review: all modified files

- [ ] **Step 1: Run the complete verification suite**

Run these commands and require exit code 0:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

- [ ] **Step 2: Review the final diff**

Run:

```powershell
git diff --check
git status --short --branch
git diff --stat
```

Confirm there are no generated artifacts, unrelated changes, external font assets, debug statements, or layout/behavior edits.

- [ ] **Step 3: Commit and push**

Stage the implementation, tests, documentation, and this plan; review with `git diff --cached`, then commit:

```powershell
git commit -m "style(ui): refine application typography"
git push origin main
```
