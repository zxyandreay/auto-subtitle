# Selectable Regeneration Alternatives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users request one to five distinct subtitle-regeneration alternatives while preserving the current default of three.

**Architecture:** Add a session-only count to `RegenerationPreferences` and pass it through the existing immutable internal worker request. A small leaf module owns the 1–5 bounds and normalization so the dialog, settings factory, regeneration utilities, and worker share one rule without introducing an import cycle.

**Tech Stack:** React 19, TypeScript, Web Workers, Vitest, Vite.

---

### Task 1: Alternative Count Rules And Preferences

**Files:**
- Create: `src/transcription/regenerationLimits.ts`
- Modify: `src/transcription/types.ts`
- Modify: `src/transcription/regeneration.ts`
- Test: `src/tests/transcription-settings.test.ts`
- Test: `src/tests/regeneration-utils.test.ts`

- [ ] **Step 1: Write failing tests for the default and supported bounds**

Add expectations that `createRegenerationPreferences(DEFAULT_TRANSCRIPTION_SETTINGS)` contains `alternativeCount: 3`, and that a new `normalizeRegenerationAlternativeCount` helper keeps 1 and 5, rounds supported fractional values, clamps finite out-of-range values, and defaults non-finite values to 3.

```ts
expect(createRegenerationPreferences(DEFAULT_TRANSCRIPTION_SETTINGS)).toEqual(
  expect.objectContaining({ alternativeCount: 3 }),
)
expect(normalizeRegenerationAlternativeCount(0)).toBe(1)
expect(normalizeRegenerationAlternativeCount(4.4)).toBe(4)
expect(normalizeRegenerationAlternativeCount(9)).toBe(5)
expect(normalizeRegenerationAlternativeCount(Number.NaN)).toBe(3)
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm.cmd test -- --run src/tests/transcription-settings.test.ts src/tests/regeneration-utils.test.ts
```

Expected: FAIL because the preference field and normalization helper do not exist.

- [ ] **Step 3: Add the leaf limits module and preference field**

Create constants for minimum 1, maximum 5, and default 3 plus the normalizer. Extend `RegenerationPreferences` with `alternativeCount: number`, initialize it from the default constant, and keep `buildRegenerationSettings` unchanged because the count is not a transcription setting.

```ts
export const MIN_REGENERATION_ALTERNATIVES = 1
export const MAX_REGENERATION_ALTERNATIVES = 5
export const DEFAULT_REGENERATION_ALTERNATIVES = 3

export function normalizeRegenerationAlternativeCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REGENERATION_ALTERNATIVES
  return Math.max(MIN_REGENERATION_ALTERNATIVES, Math.min(MAX_REGENERATION_ALTERNATIVES, Math.round(value)))
}
```

Update the regeneration utility's default candidate cap to the maximum exported by the leaf module while keeping worker requests responsible for their selected cap.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: both files pass.

### Task 2: Dialog Selection And Candidate Invalidation

**Files:**
- Modify: `src/components/RegenerationDialog.tsx`
- Test: `src/tests/regeneration-dialog.test.tsx`

- [ ] **Step 1: Write a failing dialog behavior test**

Render the real dialog, assert the default control value, select five alternatives, and verify the session preference callback and candidate invalidation.

```ts
expect(select('Regeneration alternative count').value).toBe('3')
changeSelect(select('Regeneration alternative count'), '5')
expect(onPreferencesChange).toHaveBeenCalledWith(expect.objectContaining({ alternativeCount: 5 }))
expect(container.textContent).not.toContain('Alternative 1')
```

- [ ] **Step 2: Run the dialog test and verify RED**

Run:

```powershell
npm.cmd test -- --run src/tests/regeneration-dialog.test.tsx
```

Expected: FAIL because the labeled select is absent.

- [ ] **Step 3: Add the Alternatives select**

Add the control to the existing regeneration settings grid. Render values 1–5 from the shared limits, disable it while busy, convert the selected value to a number, and call the existing `updatePreferences` path so old candidates clear consistently.

```tsx
<label>
  Alternatives
  <select
    aria-label="Regeneration alternative count"
    disabled={busy}
    value={preferences.alternativeCount}
    onChange={(event) => updatePreferences({
      ...preferences,
      alternativeCount: normalizeRegenerationAlternativeCount(Number(event.target.value)),
    })}
  >
    {alternativeCounts.map((count) => <option key={count} value={count}>{count}</option>)}
  </select>
</label>
```

- [ ] **Step 4: Run the dialog test and verify GREEN**

Run the command from Step 2. Expected: all dialog tests pass.

### Task 3: Immutable Worker Request And Requested Candidate Limit

**Files:**
- Modify: `src/transcription/types.ts`
- Modify: `src/transcription/browserWhisperProvider.ts`
- Modify: `src/workers/transcription.worker.ts`
- Modify: `src/App.tsx`
- Test: `src/tests/browser-whisper-provider.test.ts`
- Test: `src/tests/regeneration-utils.test.ts`

- [ ] **Step 1: Write failing request and limit tests**

Update provider tests to pass `5` and require every initial or restarted `regenerate` message to contain `alternativeCount: 5`. Add a real deduplication test that requests two unique candidates from a larger input.

```ts
expect(restartedWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
  type: 'regenerate',
  alternativeCount: 5,
}))
expect(dedupeRegenerationCandidates(candidates, 2)).toHaveLength(2)
```

- [ ] **Step 2: Run the provider and utility tests and verify RED**

Run:

```powershell
npm.cmd test -- --run src/tests/browser-whisper-provider.test.ts src/tests/regeneration-utils.test.ts
```

Expected: FAIL because the provider and worker request do not accept the count.

- [ ] **Step 3: Thread the count through the request snapshot**

Add `alternativeCount` to `WorkerRegenerateRequest`, add the count before callbacks in `startBrowserWhisperRegeneration`, and include it in the one request object reused by startup recovery. Pass `preferences.alternativeCount` from `App` and store it in `RegenerationRequestContext` for an immutable UI request snapshot.

Normalize the count at the worker boundary, pass it into `regenerate`, cap deduplication and stopping against it, and update progress and diagnostics.

```ts
const requestedAlternativeCount = normalizeRegenerationAlternativeCount(request.alternativeCount)
// ...
const uniqueCandidates = dedupeRegenerationCandidates(candidates, requestedAlternativeCount)
if (candidates.length >= requestedAlternativeCount) break
```

- [ ] **Step 4: Run all focused regeneration tests and verify GREEN**

Run:

```powershell
npm.cmd test -- --run src/tests/transcription-settings.test.ts src/tests/regeneration-utils.test.ts src/tests/regeneration-dialog.test.tsx src/tests/browser-whisper-provider.test.ts
```

Expected: all focused tests pass.

### Task 4: Documentation And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/project-state.md`
- Review: `docs/superpowers/specs/2026-06-29-selectable-regeneration-alternatives-design.md`
- Review: `docs/superpowers/plans/2026-06-29-selectable-regeneration-alternatives.md`

- [ ] **Step 1: Update user and architecture documentation**

Document the 1–5 selector, default of three, session-local behavior, bounded five-profile execution, and the possibility of fewer distinct results. Update the project-state component, request flow, regeneration details, tests, and limitation sections.

- [ ] **Step 2: Run every verification gate**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
git diff --check
```

Expected: 0 test failures and exit code 0 for every command.

- [ ] **Step 3: Stage only related files and review the commit**

```powershell
git status --short
git add -- README.md docs/project-state.md docs/superpowers/specs/2026-06-29-selectable-regeneration-alternatives-design.md docs/superpowers/plans/2026-06-29-selectable-regeneration-alternatives.md src/App.tsx src/components/RegenerationDialog.tsx src/transcription/browserWhisperProvider.ts src/transcription/regeneration.ts src/transcription/regenerationLimits.ts src/transcription/types.ts src/workers/transcription.worker.ts src/tests/browser-whisper-provider.test.ts src/tests/regeneration-dialog.test.tsx src/tests/regeneration-utils.test.ts src/tests/transcription-settings.test.ts
git diff --cached --check
git diff --cached --stat
```

Expected: only the selectable-alternatives feature, tests, and documentation are staged.

- [ ] **Step 4: Commit and push**

```powershell
git commit -m "feat(editor): select regeneration alternatives"
git push origin main
```

Expected: `main` and `origin/main` point to the new commit and the working tree is clean.
