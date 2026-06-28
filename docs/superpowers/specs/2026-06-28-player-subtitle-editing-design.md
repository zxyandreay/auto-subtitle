# Player Subtitle Editing Design

## Goal

Turn the video preview into a local, browser-only subtitle review workspace. Users can inspect, add, edit, delete, retime, and play subtitle cues from the player, including fullscreen. The existing `SubtitleEntry[]` state, undo history, validation, autosave, import, export, and editor workflows remain authoritative.

## Architecture

`App` continues to own subtitles through `useUndoableSubtitles`. It also owns the selected subtitle ID so the player timeline, player editor, and main subtitle editor stay synchronized. App-level callbacks update, delete, add, select, seek, and play ranges. Every completed subtitle mutation calls the existing `commitSubtitleChanges` function.

`VideoPlayer` remains a controlled component and becomes a workspace shell composed from focused child components:

- `SubtitleTimeline` renders the scrollable time track, playhead, zoom controls, and cues.
- `SubtitleTimelineCue` handles cue selection, seeking, drag initiation, and keyboard timing adjustments.
- `PlayerSubtitleEditor` edits the selected cue and exposes navigation, range playback, duplication, and deletion.
- `useSubtitleTimelineDrag` manages pointer capture, local drag previews, snapping, clamping, and the final commit.
- Shared timestamp and text-editing helpers keep player edits consistent with `SubtitleEditor`.

No component keeps a second persistent subtitle collection. A drag may hold one temporary cue preview while the pointer is down; pointer release creates one undoable App-level commit.

## Subtitle Timeline

The timeline uses absolute cue positions on a track measured in pixels per second. Fit mode maps the known duration to the viewport. Zoom in and zoom out switch to a wider scrollable track. A follow-playhead toggle scrolls only when the playhead approaches a viewport edge, avoiding layout work on every media time update.

Each cue displays its number and a short text preview. It exposes its number, start, end, and text through an accessible label. Active, selected, dragging, warning, and error states use existing theme variables. Clicking a cue selects it and seeks to its start.

The left handle changes the start, the right handle changes the end, and the cue body moves the whole range. Pointer handlers call `setPointerCapture` at drag start and release capture at completion or cancellation. Dragging renders a local preview and calls the App callback once on pointer release.

Timing calculations use a pure helper so tests cover them without browser layout dependencies. The helper:

- preserves duration while moving a cue;
- clamps known-duration edits to zero and the video duration;
- enforces a positive duration and uses the formatting preference `minDuration` when the available range permits;
- snaps within a small pixel-derived threshold to the playhead, neighboring cue boundaries, and half-second marks;
- prefers explicit boundaries over grid marks when snap targets compete;
- treats neighbor boundaries as snap targets but does not silently rewrite overlaps, leaving overlap validation visible.

Focused cues support keyboard timing changes. Left and Right move a cue by 0.1 seconds; Shift changes the step to 0.5 seconds. Alt adjusts the start boundary, while Ctrl or Command adjusts the end boundary. Cue handlers stop propagation so these keys do not trigger the global five-second seek shortcut.

## Player Subtitle Editor

Selecting a timeline cue or active subtitle opens a compact editor connected to the player. It includes text, start and end timestamps, seek-to-start, play-range, previous, next, duplicate, and delete actions.

Timestamp fields use the existing `parseTimestamp` and `formatTimestamp` behavior. Invalid drafts stay visible with an accessible error until corrected. Text changes use the App commit path, and blur applies the existing `formatSubtitleText` behavior. Input and textarea events do not reach playback shortcuts.

The panel focuses its text field after a player insertion. On narrow screens it becomes a collapsible, sticky-bottom editing surface inside the player workspace; it remains part of the normal document focus order and never traps focus.

## Adding and Synchronizing Subtitles

The player provides a labeled Add subtitle button. App pauses the video through the existing playhead capture path, reads the exact media `currentTime`, creates a cue with `makeSubtitleEntryAtTime`, clamps it to the known duration, commits the sorted and renumbered array, disables error-only filtering, selects the new cue, and requests text focus in the player editor.

The selected subtitle ID is distinct from the active subtitle at the playhead. Playback may change the active highlight without stealing a user's editor selection. Selecting in either player surface or the main `SubtitleEditor` updates the App-level selected ID. Deleting the selected cue chooses the nearest remaining cue when possible.

## Fullscreen Workspace

Fullscreen targets the outer player workspace, which contains the video, subtitle overlay, controls, timeline, player editor, and mutation actions. A `fullscreenchange` listener derives fullscreen state from `document.fullscreenElement`. The same button enters or exits fullscreen and uses an explicit Exit fullscreen label while active.

Rejected or unavailable fullscreen calls leave the layout usable and do not alter subtitle state. Fullscreen CSS uses a dark focused layout, safe-area padding, touch-sized controls, vertical scrolling where needed, and responsive portrait and landscape arrangements.

## Validation and History

The existing `validateSubtitles` function remains the only validation source. Timeline cues receive their error and warning state from its results, including malformed time, negative time, invalid range, beyond duration, empty text, and overlap.

Every text, timestamp, add, duplicate, delete, keyboard nudge, or completed drag mutation creates an undoable commit through `commitSubtitleChanges`. Pointer moves do not create history entries. Import, export, autosave, transcription previews, and regeneration continue to consume the same `SubtitleEntry[]` array.

## Responsive and Accessible Interaction

Desktop keeps the video dominant with timeline and player editor below it. Tablet stacks video, controls, timeline, and editor. Mobile uses horizontally scrollable timeline content, compact grouped controls, and a collapsible bottom editing surface. Fullscreen applies safe-area padding and permits the workspace tools to scroll without hiding the video controls.

New buttons and handles have accessible names and visible focus styles. Cue blocks are keyboard focusable, use selected-state semantics, and open on Enter or Space. Handles describe the boundary they adjust. Touch targets meet at least the WCAG 2.2 24-pixel minimum and aim for 44 pixels on primary controls.

## Testing

Vitest tests cover:

- playhead insertion, duration clamping, chronological sorting, and selection;
- start, end, and text callback updates;
- move-duration preservation;
- drag clamping and minimum valid ranges;
- delete and duplicate behavior;
- player timestamp parsing and blur formatting;
- player and main-editor selection synchronization;
- keyboard timing adjustments;
- mocked fullscreen entry, exit, and `fullscreenchange` state.

Tests for timing helpers run without DOM geometry. Component tests use jsdom and mock media and fullscreen APIs only where browser behavior is unavailable.

## Documentation and Verification

README and `docs/project-state.md` will describe the timeline, player editing, fullscreen workspace, responsive layout, and keyboard controls. Completion requires fresh successful runs of `npm run typecheck`, `npm test`, and `npm run build`, followed by a focused diff review before the implementation commit and push to `main`.
