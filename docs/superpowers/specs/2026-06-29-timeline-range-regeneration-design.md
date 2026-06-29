# Timeline Range Regeneration Design

## Summary

Add a temporary regeneration mode to the subtitle timeline. Users can select, move, resize, preview, configure, and regenerate any video range up to 29 seconds without changing subtitle timing until they apply a generated alternative.

## Timeline Interaction

- A Regenerate toolbar action starts from the selected cue or a five-second range centered on the playhead.
- An amber range sits above the cue track. Dragging its body moves it; dragging either handle resizes it.
- Pointer and keyboard edits share the timeline's magnetic targets. Alt/Option bypasses snapping, and Shift changes the keyboard step from 0.1 to 0.5 seconds.
- Preview plays the current subtitles once through the range. Configure opens the existing regeneration dialog. Cancel clears the range.
- Range state stays outside subtitle undo history and project autosave.

## Settings And Generation

- The dialog exposes language, output, model, engine, precision, and word/segment timestamp controls.
- Regeneration settings initialize from full-transcription settings once, then remain session-local.
- Current caption formatting is inherited when generation starts.
- Each request captures an immutable range and settings snapshot used for candidate formatting, preview, and apply.
- Range or setting changes invalidate existing candidates. Failures, silence, cancellation, and empty results preserve current subtitles.

## Boundaries And Verification

- Keep the existing worker request, candidate decoding, preview overlay, and atomic replacement path.
- Keep subtitle-row regeneration as a direct dialog entry point.
- Do not change the project schema or persist regeneration-only preferences.
- Cover range math, timeline input, responsive accessibility, settings compatibility, candidate invalidation, and snapshot construction with automated tests; verify the complete test, typecheck, lint, and build commands.
