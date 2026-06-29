# Auto Subtitle

Auto Subtitle is a local-first web app for creating, previewing, editing, importing, and exporting subtitles for videos on your computer. It is built with React, TypeScript, Vite, FFmpeg.wasm, and Transformers.js.

The selected video is handled as a browser `File` with a temporary object URL. The app does not upload the video, does not call a paid transcription API, and does not require an account, API key, backend, database, analytics, or tracking.

## Features

- Page-wide drag-and-drop video import with a responsive supported-file overlay, local privacy messaging, file metadata, size warnings, duration warnings, and validation.
- Interactive video workspace with play/pause, seek, volume, subtitle visibility, active overlay, fullscreen editing, and a continuously zoomable magnetic subtitle timeline with click/drag seeking and precise playhead splitting.
- Real browser-local transcription attempt using FFmpeg.wasm for audio extraction and Transformers.js Whisper models for speech recognition.
- Worker-based transcription lifecycle with meaningful stages, model download progress when available, live editor previews, visible failures, and cancellation.
- Browser-local diagnostic logging with a bounded persisted history and an exportable JSON report for investigating intermittent transcription behavior.
- Speech-aware local timing with lightweight VAD, silence-preferred 29-second windows, coverage-gap recovery, speech-boundary snapping, word-timestamp fallback, and conservative overlap-word reconciliation.
- Deterministic generated-caption cleanup for readable two-line subtitles, word-timestamp timing, reading-speed protection, smoother cuts, short-gap chaining, and overlap-window duplicate reduction.
- Synchronized player and list editors with playhead-accurate insertion, text and timestamp editing, timeline dragging, validation, search, delete, split, merge, move, range playback, undo, and redo.
- Local subtitle regeneration for editable ranges up to 29 seconds, with the original plus one to five requested Whisper alternatives, temporary video preview, cancellation, and one-step undoable replacement.
- SRT and WebVTT import/export, transcript TXT export, and Auto Subtitle JSON project export/import.
- IndexedDB autosave for subtitles, settings, formatting, project metadata, and video metadata. The original video is not autosaved.
- Light, dark, and system themes.
- Crisp compact local/system typography with lighter UI emphasis, tabular timing figures, and a deliberately bold video-caption overlay.
- Caption-symbol branding shared by the app header and SVG browser-tab icon, without letter-based marks.
- Keyboard shortcuts for playback, seeking, subtitle timeline nudging and splitting, undo, and redo.

## Screenshots

Screenshots are not committed yet. Run the app locally and capture:

- Empty import state
- Video preview with subtitle overlay
- Interactive subtitle timeline and player editing panel
- Fullscreen subtitle editing workspace
- Subtitle editor with validation issues
- Transcription failure or progress state

## Privacy

Auto Subtitle is designed to keep media local:

- The selected video is not copied into the repository or `public/`.
- The app creates a temporary object URL and revokes it when the video is replaced, removed, or the app unmounts.
- Extracted audio is processed inside browser memory by FFmpeg.wasm.
- Transcription runs in a Web Worker through Transformers.js.
- No analytics, tracking, authentication, Supabase, Firebase, or external AI API calls are included.

Model files are downloaded by Transformers.js on first use and cached by the browser when supported. That download goes to the model host, but your video and extracted audio are not uploaded by this app.

When the app is started through `local-launch.bat`, transcription progress and generated caption text are also sent to the local Vite dev server so the launcher terminal can show live progress. This stays on `127.0.0.1`.

Diagnostic events are stored only in this browser's local storage. They may include file metadata, transcription settings, recognized text, speech regions, window timing, coverage/repair decisions, errors, and final subtitle entries, but never audio or video bytes. Use the **Debug log** button in the top toolbar after reproducing a problem to export a JSON report for investigation. The history is bounded to the most recent 1,000 events and approximately 2 MB; oversized text is sampled with its original length retained.

## System Requirements

- Node.js and npm
- A modern desktop browser
- Enough memory for FFmpeg.wasm, the selected video, extracted audio, and the selected Whisper model
- Network access for first-run dependency/model downloads

Chromium-based browsers are recommended for the first release. Firefox and Safari support varies by codec, WebAssembly behavior, WebGPU support, and media decoding.

## Launch On Windows

Double-click:

```bat
local-launch.bat
```

The launcher:

- switches to the repository directory
- checks for Node.js and npm
- installs dependencies with `npm ci` when possible
- starts Vite on `http://127.0.0.1:5173`
- opens the app in the default browser
- shows local transcription progress and generated caption text in the terminal
- stops the Vite process tree when you press Enter, lose console input, or close the launcher terminal
- keeps the terminal open if an error occurs

## Manual Commands

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run preview
```

## Transcription Models

| Model | Best for | Languages | Translation | Resource level |
| --- | --- | --- | --- | --- |
| Tiny (`onnx-community/whisper-tiny`) | Fast tests and lower-resource devices | Multilingual | Yes | Low |
| Base (`onnx-community/whisper-base`) | Balanced default use | Multilingual | Yes | Medium |
| Large v3 Turbo (`onnx-community/whisper-large-v3-turbo`) | High-accuracy transcription | Multilingual | No | High |
| Distil Large v3 (`distil-whisper/distil-large-v3`) | Fast, high-quality English transcription | English only | No | High |

All four models use the same local Transformers.js automatic speech recognition pipeline for full transcription, live partial captions, final results, and range regeneration. Large v3 Turbo and Distil Large v3 are high-resource models; WebGPU with `q8` precision is recommended, while CPU/WASM or `fp32` can be much slower or require substantially more memory.

Distil Large v3 is enabled only for an explicitly selected English language and the transcription task. Large v3 Turbo is transcription-only. If a language or task change makes the selected model incompatible, Auto Subtitle switches to a compatible multilingual model and shows a non-blocking notice. Tiny and Base remain available for both transcription and translation.

The first use of a model can download its files from Hugging Face. Transformers.js uses the browser cache when supported, so later jobs can read unchanged files locally instead of downloading them again. Accuracy still depends on speech clarity, noise, language, accents, overlapping speakers, device performance, browser support, model choice, and subtitle formatting preferences. Generated subtitles should be manually reviewed.

## Browser Processing Workflow

1. The user selects a local video file.
2. The app creates a temporary object URL for preview.
3. A Web Worker loads FFmpeg.wasm and Transformers.js.
4. FFmpeg.wasm extracts mono 16 kHz PCM WAV audio and pads delayed audio-track starts from media time zero.
5. The worker analyzes the decoded samples with a deterministic frame-based speech activity detector. It estimates a local noise floor, smooths isolated frames, merges nearby speech, and adds bounded pre/post speech padding.
6. Detected speech regions are packed into windows near 26 seconds. Boundaries prefer silence, context overlap is normally 1.5 seconds, and every model input is capped at 29 seconds. If speech analysis yields no usable regions, contiguous fixed windows use a 4-second overlap and the same 29-second ceiling.
7. The compatibility resolver validates the selected model, language, and task, then Transformers.js loads the resolved model from browser cache or the model repository. The ASR pipeline requests word timestamps by default; if the export does not support them, the current call is retried with segment timestamps and later windows stay in segment mode.
8. Raw model chunks are mapped from exact sample-slice offsets back to the full video timeline. Adjacent-window text is reconciled conservatively so duplicate overlap words are removed while unique boundary words remain.
9. Speech regions are compared with normalized subtitle coverage. Likely uncovered speech can trigger one bounded repair pass of at most 20 local windows, using the already loaded transcriber.
10. Text-only ASR output becomes a low-confidence subtitle only when speech evidence supplies a safe interval; text returned over silence is not turned into a cue.
11. Generated segment timestamps are snapped to nearby speech onsets/offsets with small lead-in/tail padding when this cannot create an overlap.
12. Partial generated subtitles are shown in the editor while transcription continues, then the existing readability formatter splits, wraps, de-duplicates, and normalizes the final generated cues.
13. The user reviews, edits, and exports SRT, VTT, TXT, or JSON locally.

The 29-second ceiling leaves safety margin below Whisper's fixed input context. The overlap behavior follows the chunk and stride concepts exposed by the [Transformers.js ASR pipeline](https://huggingface.co/docs/transformers.js/v3.0.0/api/pipelines) and [Whisper documentation](https://huggingface.co/docs/transformers/model_doc/whisper).

## Accurate-local Defaults

New and legacy projects are normalized to safe missing-field defaults without changing the project schema. The default profile uses automatic language detection and execution provider selection, `q8` model weights, word timestamps with segment fallback, VAD enabled, a 29-second maximum input, 26-second speech-aware target windows, 1.5-second speech-aware overlap, and 4-second fixed-window fallback overlap.

Generated formatting defaults are a 0.08-second lead-in, 0.18-second tail, 1.1-to-6-second cue duration, 0.08-second inter-cue gap, 42 characters per line, 84 per cue, a 20 CPS target with a 21 CPS hard limit, and safe closure of gaps below 0.5 seconds.

## Regenerating A Subtitle Range

1. Select a video and create, import, or generate subtitles.
2. Select a cue and use **Regenerate selected subtitle** in the player subtitle editor. It creates an adjustable timeline range from that cue. The main subtitle editor's row-level Regenerate action remains available as a direct dialog entry point.
3. Drag the amber range to move it, drag either edge to resize it, or use the timestamp fields for exact values. A range can cover one or many cues but cannot exceed 29 seconds.
4. Use **Preview range** to play the current section once. The range remains selected when playback stops.
5. Open **Configure regeneration** and choose the language, output, model, engine, precision, timestamp detail, and **Alternatives** count for this run. You can request one to five alternatives; the default is three. These choices persist for later regenerations in the current browser session without changing full-transcription settings.
6. Generate alternatives. The worker extracts the range once, loads the selected Whisper model once, and performs up to five bounded sequential decoding passes locally, stopping when it finds the requested number of distinct results.
7. Compare the unchanged current cues with the generated alternatives, then preview any choice against the video. Empty or duplicate decoding results can produce fewer alternatives than requested.
8. Apply an alternative to replace all overlapping cues as one undoable edit, or keep the original unchanged.

Range movement, resizing, and keyboard edits use the timeline's magnetic cue-boundary, playhead, video-boundary, and half-second-grid snapping. Hold Alt/Option to bypass snapping. Regeneration inherits the current caption-formatting preferences and freezes all settings when generation starts. Full transcription and regeneration cannot run at the same time, avoiding concurrent model and FFmpeg memory pressure.

The regeneration dialog remains available while the media workspace is fullscreen. It is mounted inside the active fullscreen workspace so the browser can display it without forcing fullscreen to close.

## Generated Caption Readability

Generated captions use a deterministic, local-only post-processing pass informed by public subtitle guidance from Netflix, BBC, and DCMP:

- captions target about 20 characters per second, enforce a 21 CPS hard limit during timing decisions, and use the app's readable minimum duration when timing room allows
- very short generated captions are extended before they are split or exported
- adjacent abrupt captions can be merged when the combined caption remains within the existing line, duration, and reading-speed limits
- gaps below about half a second are chained by extending the previous caption when safe, reducing visible flicker without pulling the next caption ahead of its words
- word-timed cuts are penalized when they would create a very short phrase flash, even if the phrase ends in punctuation

## Import And Export

Supported imports:

- `.srt`
- `.vtt`
- `.json` Auto Subtitle project files

Supported exports:

- `.srt` SubRip using `HH:MM:SS,mmm`
- `.vtt` WebVTT using `HH:MM:SS.mmm`
- `.txt` readable transcript, with optional timestamps
- `.auto-subtitle.json` project data without the original video

When importing project JSON, the app validates the schema, normalizes saved model compatibility, and asks you to select the original video again. Saved video name and duration are used as comparison hints only. Existing projects that store Tiny or Base continue to restore unchanged; unknown model IDs fall back to Base.

## Keyboard Shortcuts

- Space: play or pause when focus is not in an input
- Arrow Left: seek backward 5 seconds
- Arrow Right: seek forward 5 seconds
- Ctrl+Z: undo subtitle edits
- Ctrl+Shift+Z or Ctrl+Y: redo subtitle edits
- Ctrl+K or Cmd+K: split the selected subtitle at the playhead when both halves will be at least 0.1 seconds
- Enter on a subtitle row: seek to that subtitle start
- Enter or Space on a timeline cue: select the cue and seek to its start
- Arrow Left or Arrow Right on a timeline cue: move it by 0.1 seconds
- Arrow Left or Arrow Right on a focused timeline handle: adjust that start or end boundary by 0.1 seconds
- Hold Shift with a timeline Arrow key: use a 0.5-second adjustment
- Arrow Left or Arrow Right on the focused timeline playhead: seek by 0.1 seconds; Home/End seek to timeline boundaries
- Hold Alt/Option while clicking the empty timeline or dragging a cue edge, cue body, or playhead: temporarily disable magnetic snapping
- Arrow Left or Arrow Right on a regeneration range or handle: move or resize it by 0.1 seconds
- Hold Shift with a regeneration range Arrow key: move or resize it by 0.5 seconds; hold Alt/Option to bypass snapping

## Player Subtitle Editing

The video player includes a horizontally scrollable subtitle timeline with continuous 12–96 pixels-per-second zoom, dedicated Undo/Redo controls, an enabled-by-default Magnet toggle, and an enabled-by-default playhead-follow toggle. The Magnet button controls locking for cue movement, start/end handles, playhead movement, and empty-track clicks; Alt/Option remains a temporary bypass while Magnet is enabled. Cue blocks show their text, timing, active/selected state, and existing validation severity. Clicking a cue selects it and seeks to its start. Clicking empty space in the timeline—including the bands above or below cue cards—seeks magnetically to that point when Magnet is enabled. Drag the cue body to preserve its duration while moving it, or drag either handle to change its start or end. A 10-pixel magnetic threshold snaps either moving edge to any other subtitle boundary, the media playhead, timeline start, known video end, or a lower-priority half-second grid. A guide and target accent show the active snap. Overlaps remain visible as validation errors instead of being silently removed.

The timeline playhead is directly draggable and keyboard accessible. It seeks the media responsively, snaps to subtitle boundaries, shows a timestamp while dragging, works in fullscreen at every zoom level, and never adds subtitle undo history. Cue timing previews remain local and commit once on pointer release, so one completed gesture is one undo step.

Timeline regeneration mode adds a temporary amber selection above the cue track. Its body slides the selected section without changing its duration, its handles resize either boundary, and its toolbar actions preview, configure, or cancel the selection. Range edits are temporary UI state: they do not change subtitle history or project autosave.

Select a cue, place the playhead at least 0.1 seconds inside each edge, then use the timeline Split button or Ctrl/Cmd+K to cut it at the exact millisecond-rounded playhead time. The text uses the same natural split as the main editor, the second half remains selected, and the entire cut is one undoable edit.

Selecting a cue opens the player subtitle editor for text, timestamp, navigation, range playback, duplication, and deletion. **Add subtitle** pauses playback and inserts a focused cue at the exact playhead. Player changes and the main subtitle list share the same undoable subtitle state and synchronize selection immediately. The main list editor's optional Auto-scroll control starts disabled.

Fullscreen targets the whole editing workspace rather than only the video, keeping the timeline, editor, add/delete actions, playback controls, volume, and subtitle visibility available. Tablet layouts stack these tools; narrow layouts use a horizontally scrolling timeline and a collapsible sticky editor panel with touch-sized actions.

Video files can also be dropped anywhere over the app. The page-level overlay accepts the first valid MP4, WebM, MOV, or MKV from a mixed drop, prevents browser navigation, ignores internal/non-file drags, and keeps the file in the existing browser-only object URL flow.

## Architecture

```text
src/
  components/       React UI panels and controls
  hooks/            undoable subtitle history
  media/            video file validation
  project/          IndexedDB autosave
  subtitles/        formatting, import, export, validation
  tests/            Vitest coverage for subtitle logic
  transcription/    provider types, capabilities, worker bridge
  utils/            IDs, downloads, timestamp helpers
  workers/          FFmpeg.wasm + Transformers.js transcription worker
```

The transcription provider boundary is intentionally small so another local engine can be added later without rewriting the editor.

## Known Limitations

- Browser transcription is demanding. Large videos can require significant memory and time.
- Large v3 Turbo and Distil Large v3 can exceed device memory on lower-resource browsers. WebGPU and `q8` are recommended, but the app does not block CPU/WASM use.
- The current FFmpeg.wasm path writes the selected file into FFmpeg's in-memory filesystem before extraction. That is not true streaming for arbitrary containers.
- Transformers.js chunking is used for long audio, but the extracted audio buffer is still held in browser memory.
- Codec support depends on the browser and FFmpeg.wasm build.
- WebGPU is optional. The app attempts supported WebAssembly or CPU fallback paths, but speed can be much slower.
- Word-level timestamps depend on model support and may fall back to coarser chunks.
- Speech activity analysis can be imperfect with music, sustained background noise, overlapping speakers, or very quiet speech. A missed VAD region cannot trigger coverage repair.
- Coverage recovery is deliberately limited to one pass and 20 ranges so difficult audio cannot cause an unbounded transcription loop.
- Range regeneration starts a fresh worker and model pipeline for each request. Browser caching avoids unchanged model downloads, but repeated requests still require local initialization and audio extraction. Requesting more alternatives can require more decoding passes.
- Generated subtitle synchronization is improved by speech-aware windowing, bounded recovery, and deterministic post-processing, but it is not guaranteed perfect and should be reviewed manually.

## Troubleshooting

- Node.js missing: install Node.js from `https://nodejs.org/` and reopen the launcher.
- PowerShell blocks `npm.ps1`: the launcher uses `npm.cmd`; manual PowerShell users can run `npm.cmd install`.
- Model download fails: check network access, browser storage, and whether the model host is reachable.
- FFmpeg initialization fails: try a Chromium-based browser and restart the dev server.
- Video cannot be decoded: try MP4/H.264 or WebM/VP9. MOV and MKV support depends heavily on codecs.
- Empty or silent audio: confirm the source video has an audio track.
- Browser becomes slow: use a shorter file, the faster model, or close other memory-heavy apps.
- Regeneration worker fails before loading: the app automatically starts one fresh worker when the first worker crashes before sending any message. If the retry also fails, the error includes the browser's worker message and source location when available; reload the page after a long development hot-reload session and export a new debug log if it persists.
- Intermittent repeated or silent-area subtitles: reproduce the issue, click **Debug log**, and keep the exported JSON with the affected video timestamp. The report contains recognized text, so review it before sharing.

## Dependency And License Notes

Project source code is MIT licensed. See [LICENSE](LICENSE).

Important dependency/license considerations:

- React, Vite, Vitest, lucide-react, and the app source are permissively licensed.
- `@huggingface/transformers` is Apache-2.0.
- `@ffmpeg/ffmpeg` is MIT.
- `@ffmpeg/core` is GPL-2.0-or-later. If you redistribute production builds that bundle FFmpeg core files, review FFmpeg and dependency licensing obligations for your distribution.
- Whisper model repositories have their own model cards and terms on Hugging Face. Review the selected model cards before redistribution or commercial packaging.

This section is informational and not legal advice.

## Development Notes

- Do not commit `node_modules`, `dist`, model caches, generated media, user videos, extracted audio, subtitle exports, logs, or secrets.
- Keep transcription failures visible in the UI. Do not replace failed transcription with fabricated subtitles.
- Keep import/export and manual editing usable even if browser transcription is unavailable.

## Future Improvements

- More memory-efficient audio extraction for browsers that support streaming media pipelines.
- Optional local model preflight and cache inspection.
- More languages and model choices with clearer size estimates.
- Side-by-side waveform timing adjustments.
- More advanced subtitle timing controls for reviewing generated captions.
- Real sample screenshots in the README.
