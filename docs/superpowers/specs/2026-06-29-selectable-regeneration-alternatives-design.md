# Selectable Regeneration Alternatives Design

## Summary

Let users request one to five subtitle-regeneration alternatives. The dialog defaults to three, remembers the choice for the current browser session, and may return fewer results when decoding profiles produce empty or duplicate text.

## Interface And State

- Add an **Alternatives** select control to the regeneration settings grid with values 1 through 5.
- Store the selected count in `RegenerationPreferences`; initialize it to 3 and keep it outside project autosave and global transcription settings.
- Treat count changes like other regeneration-setting changes: clear prior candidates, preview state, progress, errors, and request context.
- Include the selected count in the immutable internal worker request and regeneration diagnostics.

## Worker Behavior

- Keep the existing five bounded decoding profiles.
- Normalize direct worker requests to the supported 1–5 range, defaulting invalid values to 3.
- Stop after collecting the requested number of distinct candidates or after exhausting all five profiles.
- Show progress against the requested count. Report the actual result count on completion.
- Preserve existing behavior for silence, duplicates, cancellation, worker failure, and word-timestamp fallback. Existing subtitles change only after the user applies an alternative.

## Compatibility And Verification

- Keep the project-file schema and external interfaces unchanged; only the internal module-worker request gains the requested count.
- Preserve the default three-alternative workflow for existing sessions and entry points.
- Test preference defaults, normalization, dialog selection, candidate invalidation, worker-request snapshots, requested deduplication limits, and repeated worker startup.
- Update `README.md` and `docs/project-state.md`, then run focused Vitest suites, the full test suite, typecheck, lint, and build.
