# Timeline Range Regeneration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add draggable timeline range regeneration with preview and session-local runtime settings.

**Architecture:** Extend the controlled subtitle timeline with temporary range state and a dedicated pointer hook that reuses existing snap calculations. Keep worker orchestration in `App`, expand the current dialog, and capture one immutable settings snapshot per generated candidate set.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Transformers.js, FFmpeg.wasm, Vite.

---

### Task 1: Range math and drag behavior

**Files:** `src/subtitles/regeneration.ts`, `src/subtitles/timeline.ts`, `src/hooks/useRegenerationRangeDrag.ts`, and their unit tests.

- [ ] Add failing tests for cue/playhead initialization, video-boundary clamping, and the 29-second limit.
- [ ] Add optional maximum-duration support to shared timeline edit calculations.
- [ ] Implement pointer-captured range move/resize previews with shared snapping and one controlled change on release.
- [ ] Run the focused range and timeline utility tests.

### Task 2: Timeline workflow

**Files:** `src/components/SubtitleTimeline.tsx`, `src/components/VideoPlayer.tsx`, `src/App.tsx`, `src/styles/app.css`, and component tests.

- [ ] Add failing tests for start, range rendering, move/resize, keyboard input, preview, configure, and cancel actions.
- [ ] Add the temporary amber range, accessible controls, toolbar actions, and responsive touch targets.
- [ ] Initialize from the selected cue or playhead and route preview through the existing range player.
- [ ] Keep range changes outside subtitle history and autosave; preserve row-based regeneration.

### Task 3: Regeneration-only settings and snapshots

**Files:** `src/transcription/types.ts`, `src/components/RegenerationDialog.tsx`, `src/App.tsx`, and dialog/settings tests.

- [ ] Add failing tests for preference creation, immutable snapshot construction, controls, compatibility, candidate invalidation, and precise range synchronization.
- [ ] Add session-local language, output, model, engine, precision, and timestamp preferences.
- [ ] Resolve models without changing full-transcription settings.
- [ ] Use the captured request settings for candidate formatting, preview, and atomic apply.

### Task 4: Documentation and delivery

**Files:** `README.md`, `docs/project-state.md`, design/plan records, and all modified source/tests.

- [ ] Document the timeline workflow, settings lifetime, shortcuts, state, architecture, and failure behavior.
- [ ] Run `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run lint`, and `npm.cmd run build`.
- [ ] Review `git diff --check`, the working tree, and staged diff for unrelated changes or secrets.
- [ ] Commit as `feat(editor): add timeline range regeneration` and push `main` to `origin/main`.
