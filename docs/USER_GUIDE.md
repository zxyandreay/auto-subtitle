# Auto Subtitle User Guide

This guide covers the normal Auto Subtitle workflow and practical operating notes. For architecture, state flow, and implementation details, see [Project State](./project-state.md).

## Normal Workflow

1. Open the local app.
2. Choose or drop an MP4, WebM, MOV, or MKV video.
3. Review the **Local transcription** settings.
4. Select **Transcribe locally** and keep the browser tab open while the worker extracts audio and creates editable subtitle cues.
5. Review the draft against the source video.
6. Export SRT, WebVTT, TXT, or an Auto Subtitle project JSON file.

Generated subtitles should always be reviewed before publishing. Names, punctuation, repeated words, speaker overlap, background noise, and tight timing can still need manual correction.

## Video Input

Supported video inputs are selected by extension or browser MIME type:

- `.mp4`
- `.webm`
- `.mov`
- `.mkv`

Codec support depends on the browser and FFmpeg.wasm. MP4/H.264 and WebM/VP9 are usually easier to handle than arbitrary MOV or MKV files.

The app warns when a file is larger than 500 MB or longer than 30 minutes because browser transcription can become memory intensive. These warnings do not block use.

## Transcription Settings

### Spoken Language

The app currently offers Auto (English fallback), English, Spanish, French, German, Japanese, Korean, and Chinese. New projects default to explicit English.

Legacy or manually selected `auto` language settings resolve to English in the current Transformers.js integration. Choose the spoken language explicitly for non-English media.

### Output

- **Same language:** Transcribes speech in the selected language.
- **Translate to English:** Uses Whisper translation when the selected model supports it.

Large v3 Turbo and Distil Large v3 are transcription-only in this app. If settings become incompatible, the app switches to a compatible model and shows a warning.

### Models

| Model | Best for | Languages | Translation | Resource level |
| --- | --- | --- | --- | --- |
| Tiny (`onnx-community/whisper-tiny`) | Fast tests and lower-resource devices | Multilingual | Yes | Low |
| Base (`onnx-community/whisper-base`) | Balanced default use | Multilingual | Yes | Medium |
| Large v3 Turbo (`onnx-community/whisper-large-v3-turbo`) | Higher-quality multilingual transcription | Multilingual | No | High |
| Distil Large v3 (`distil-whisper/distil-large-v3`) | English-only transcription | English only | No | High |

First use of a model can download model files from the model host. Later runs use the browser cache when available.

### Engine and Precision

- **Engine:** `Auto`, `WebGPU`, or `WASM (CPU)`
- **Precision:** `auto`, `q8`, or `fp32`

WebGPU with `q8` is recommended for high-resource models. WASM CPU execution can be much slower, and `fp32` can use substantially more memory.

### Chunking

The app keeps model inputs at or below 29 seconds. It uses speech-aware windowing when possible and falls back to fixed windows with overlap when speech activity analysis does not produce usable regions.

## Editing Subtitles

The editor keeps generated, imported, and manually created cues in one subtitle list.

Useful review actions include:

- Play, pause, seek, adjust volume, and toggle visible captions.
- Drag the timeline playhead or click the timeline to seek.
- Move cue blocks or handles on the magnetic timeline.
- Edit text and timestamps in the selected-cue player editor.
- Add, delete, split, merge, move, search, and validate rows in the main subtitle editor.
- Shift all cue timing forward or backward.
- Remove empty cues, normalize overlaps, and renumber entries.
- Undo and redo subtitle edits.

Overlaps and malformed timestamps remain visible as validation issues rather than being silently discarded.

## Regenerating a Subtitle Range

1. Select a video and create, import, or generate subtitles.
2. Select a cue and use **Regenerate selected subtitle** from the player subtitle editor or row actions.
3. Adjust the range by dragging it on the timeline or editing its timestamps. A range can cover one or more cues but cannot exceed 29 seconds.
4. Use **Preview range** to check the selected section.
5. Open the regeneration dialog and choose language, output, model, engine, precision, timestamp detail, and alternatives count.
6. Generate alternatives. The worker extracts the selected range and runs bounded local decoding passes.
7. Compare the original cues with generated alternatives, preview a choice, and apply it or keep the original.

Applying an alternative replaces overlapping cues as one undoable edit. Full transcription and regeneration cannot run at the same time. Compatible low-resource model pipelines can stay warm briefly for sequential bounded regeneration, but incompatible or high-resource pipelines are released to limit memory use.

## Import and Export

### Imports

- `.srt`
- `.vtt`
- `.json` Auto Subtitle project files

Project JSON import validates the schema, restores subtitles and formatting, normalizes saved model compatibility, and asks you to select the original video again. Saved video name and duration are only comparison hints.

### Exports

| Export | File contents |
| --- | --- |
| `.srt` | SubRip cues using `HH:MM:SS,mmm` |
| `.vtt` | WebVTT cues using `HH:MM:SS.mmm` |
| `.txt` | Plain transcript, optionally timestamped |
| `.auto-subtitle.json` | Project data with subtitles, formatting, metadata, and transcription settings |

Project JSON does not include the original video file.

## Autosave and Local Data

Autosave stores project data in browser IndexedDB under the `auto-subtitle` database. It includes subtitles, settings, formatting preferences, project metadata, and video metadata. It does not store the original video.

Theme preference and diagnostic history are stored in localStorage. Diagnostic history is bounded to 1,000 events and approximately 2 MB.

## Debug Logs

Use **Debug log** in the top toolbar after reproducing a problem. The exported report can include:

- Browser environment details
- File metadata
- Transcription settings
- Recognized text
- Speech regions and timing decisions
- Coverage and repair decisions
- Worker-stage durations and approximate message metrics
- Errors and generated subtitle entries

Debug logs do not include audio or video bytes, but they can contain recognized text. Review a log before sharing it.

## Benchmarking Local Runs

The benchmark harness is a deterministic scorer for captured local artifacts. It does not run Whisper itself and does not commit media, model files, references, or measured benchmark results.

Use `npm run benchmark:self-test` to validate the scorer with synthetic data. For real runs, follow [Benchmark Guide](../benchmarks/README.md) and keep local manifests, fixtures, telemetry, and results in the gitignored benchmark paths.

## Keyboard Shortcuts

| Shortcut | Behavior |
| --- | --- |
| Space | Play or pause when focus is not in an input |
| Arrow Left | Seek backward 5 seconds |
| Arrow Right | Seek forward 5 seconds |
| Ctrl+Z or Cmd+Z | Undo subtitle edits |
| Ctrl+Shift+Z, Cmd+Shift+Z, Ctrl+Y, or Cmd+Y | Redo subtitle edits |
| Ctrl+K or Cmd+K | Split the selected subtitle at the playhead when both halves can be at least 0.1 seconds |
| Enter on a subtitle row | Seek to that subtitle start |
| Enter or Space on a timeline cue | Select the cue and seek to its start |
| Arrow Left or Arrow Right on a timeline cue | Move it by 0.1 seconds |
| Shift plus timeline Arrow key | Use a 0.5-second adjustment |
| Arrow Left or Arrow Right on a focused timeline handle | Adjust that boundary by 0.1 seconds |
| Arrow Left or Arrow Right on the focused timeline playhead | Seek by 0.1 seconds |
| Home or End on the focused timeline playhead | Seek to timeline boundaries |
| Alt or Option during timeline clicks or drags | Temporarily disable magnetic snapping |
| Arrow Left or Arrow Right on a regeneration range or handle | Move or resize it by 0.1 seconds |
| Shift plus regeneration range Arrow key | Move or resize by 0.5 seconds |

## Troubleshooting

- **Node.js missing or unsupported:** install Node.js `20.19+` or `22.12+` and reopen the launcher.
- **PowerShell blocks `npm.ps1`:** the Windows launcher uses `npm.cmd`; manual PowerShell users can run `npm.cmd install`.
- **Model download fails:** check network access, browser storage, and whether the model host is reachable.
- **FFmpeg initialization fails:** try a Chromium-based browser and restart the dev server.
- **Video cannot be decoded:** try MP4/H.264 or WebM/VP9. MOV and MKV support depends heavily on codecs.
- **Empty or silent audio:** confirm the source video has an audio track.
- **Browser becomes slow:** use a shorter file, a smaller model, `q8` precision, or close other memory-heavy apps.
- **Regeneration worker fails before loading:** the app retries one startup failure. If it still fails, reload the page after a long development hot-reload session and export a new debug log.
- **Repeated or silent-area subtitles:** reproduce the issue, export a debug log, and keep the affected video timestamp for investigation.

## Deeper Implementation Notes

The root README stays intentionally concise. See [Project State](./project-state.md) for architecture diagrams, storage details, transcription pipeline notes, testing coverage, and extension points. See the [Audit](./transcription-accuracy-performance-audit.md) for the July 2026 accuracy and performance review.
