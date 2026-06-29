# Selected Subtitle Regeneration Action Design

## Summary

Move timeline-range regeneration entry from the timeline toolbar to the selected subtitle's player-editor actions. Remove duplicate buttons from both subtitle editing surfaces.

## Interaction

- Replace **Duplicate selected subtitle** with **Regenerate selected subtitle** in `PlayerSubtitleEditor`.
- Disable the new action when regeneration is unavailable. Activating it initializes the existing adjustable timeline range from the selected cue.
- Remove the idle **Start timeline regeneration range** button beside the timeline Magnet control.
- Preserve Preview, Configure, and Cancel controls while a regeneration range is active.
- Remove **Duplicate subtitle** from main subtitle rows so the UI exposes no duplicate action.

## Boundaries And Verification

- Remove obsolete duplicate callbacks and timeline-start props across `App`, `VideoPlayer`, `PlayerSubtitleEditor`, `SubtitleTimeline`, and `SubtitleEditor`.
- Keep the existing subtitle-duplication domain utility unchanged; this change removes its UI entry points only.
- Preserve subtitle-row regeneration, selected-cue range initialization, dragging, resizing, preview, configuration, cancellation, and application.
- Test the player action, disabled state, removed timeline button, active-range controls, and removed row duplicate action. Run the full test, typecheck, lint, and build commands before committing.
