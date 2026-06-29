# Selected Subtitle Regeneration Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start adjustable timeline regeneration from the selected subtitle and remove duplicate buttons and the idle timeline Regenerate button.

**Architecture:** Route the existing `startTimelineRegeneration` callback into `PlayerSubtitleEditor` instead of `SubtitleTimeline`. Remove duplicate-only props and callbacks from the React component chain while leaving subtitle domain utilities intact.

**Tech Stack:** React 19, TypeScript, Vitest, Vite.

---

### Task 1: Specify The New Action Layout

**Files:**
- Test: `src/tests/player-subtitle-editor.test.tsx`
- Test: `src/tests/subtitle-timeline-component.test.tsx`
- Test: `src/tests/subtitle-selection-sync.test.tsx`

- [ ] **Step 1: Write failing component tests**

Update the player-editor test to require **Regenerate selected subtitle**, verify its callback and disabled state, and assert that **Duplicate selected subtitle** is absent. Update the timeline test to assert that **Start timeline regeneration range** is absent when no range exists while active-range controls remain. Update the subtitle-row integration test to assert that **Duplicate subtitle** is absent.

```ts
click(button('Regenerate selected subtitle'))
expect(onRegenerate).toHaveBeenCalledOnce()
expect(buttonOrNull('Duplicate selected subtitle')).toBeNull()
expect(buttonOrNull('Start timeline regeneration range')).toBeNull()
expect(buttonOrNull('Duplicate subtitle')).toBeNull()
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm.cmd test -- --run src/tests/player-subtitle-editor.test.tsx src/tests/subtitle-timeline-component.test.tsx src/tests/subtitle-selection-sync.test.tsx
```

Expected: FAIL because the player still renders Duplicate and the timeline still renders the idle Regenerate action.

### Task 2: Relocate Regeneration And Remove Duplicate UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/VideoPlayer.tsx`
- Modify: `src/components/PlayerSubtitleEditor.tsx`
- Modify: `src/components/SubtitleTimeline.tsx`
- Modify: `src/components/SubtitleEditor.tsx`

- [ ] **Step 1: Implement the selected-cue action**

Replace the player editor's `onDuplicate` prop with `canRegenerate` and `onRegenerate`. Render a Refresh icon button labeled **Regenerate selected subtitle** and route the existing `VideoPlayer.onStartRegeneration` callback to it.

```tsx
<IconButton
  label="Regenerate selected subtitle"
  disabled={!canRegenerate}
  onClick={onRegenerate}
>
  <RefreshCw size={16} />
</IconButton>
```

- [ ] **Step 2: Remove obsolete UI paths**

Remove `onStartRegeneration` from `SubtitleTimeline`, its idle toolbar button, and the unused Refresh import. Remove the main-row duplicate button, callback prop, and inline duplicate creation. Remove `duplicateSubtitleFromPlayer`, its import, and duplicate props from `App` and `VideoPlayer`.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run the command from Task 1 Step 2. Expected: all focused tests pass.

### Task 3: Documentation, Verification, And Delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/project-state.md`

- [ ] **Step 1: Update workflow documentation**

Describe regeneration as a selected-subtitle action that creates the adjustable timeline range. Remove duplicate from documented editor actions and remove references to the idle timeline Regenerate toolbar action.

- [ ] **Step 2: Run all verification gates**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Stage, review, commit, and push**

Stage only the listed components, tests, and documentation. Review `git diff --cached --check` and `git diff --cached --stat`, then run:

```powershell
git commit -m "refactor(editor): move timeline regeneration action"
git push origin main
```

Expected: the working tree is clean and local `main` matches `origin/main`.
