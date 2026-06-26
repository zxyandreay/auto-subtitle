# Auto Subtitle

Auto Subtitle is a local-first web app for creating, previewing, editing, importing, and exporting subtitles for videos on your computer. It is built with React, TypeScript, Vite, FFmpeg.wasm, and Transformers.js.

The selected video is handled as a browser `File` with a temporary object URL. The app does not upload the video, does not call a paid transcription API, and does not require an account, API key, backend, database, analytics, or tracking.

## Features

- Drag-and-drop video import with local privacy messaging, file metadata, size warnings, duration warnings, and validation.
- Custom video preview with play/pause, seek, volume, fullscreen, subtitle visibility, and active subtitle overlay.
- Real browser-local transcription attempt using FFmpeg.wasm for audio extraction and Transformers.js Whisper models for speech recognition.
- Worker-based transcription lifecycle with meaningful stages, model download progress when available, live editor previews, visible failures, and cancellation.
- Deterministic generated-caption cleanup for readable two-line subtitles, word-timestamp timing, reading-speed protection, smoother cuts, short-gap chaining, and overlap-window duplicate reduction.
- Subtitle editor with text and timestamp editing, immediate validation, active-row highlighting, search, add/delete, split, merge, duplicate, move, jump, range playback, undo, and redo.
- SRT and WebVTT import/export, transcript TXT export, and Auto Subtitle JSON project export/import.
- IndexedDB autosave for subtitles, settings, formatting, project metadata, and video metadata. The original video is not autosaved.
- Light, dark, and system themes.
- Keyboard shortcuts for playback, seeking, undo, and redo.

## Screenshots

Screenshots are not committed yet. Run the app locally and capture:

- Empty import state
- Video preview with subtitle overlay
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

The app offers:

- Faster model: `onnx-community/whisper-tiny`
- More accurate model: `onnx-community/whisper-base`

Both are loaded through Transformers.js as automatic speech recognition pipelines. Accuracy depends on speech clarity, noise, language, accents, overlapping speakers, device performance, browser support, model choice, and subtitle formatting preferences. Generated subtitles should be manually reviewed.

## Browser Processing Workflow

1. The user selects a local video file.
2. The app creates a temporary object URL for preview.
3. A Web Worker loads FFmpeg.wasm and Transformers.js.
4. FFmpeg.wasm extracts mono 16 kHz PCM WAV audio.
5. Transformers.js loads the selected Whisper model.
6. The ASR pipeline requests timestamped output.
7. Raw model chunks are normalized onto the video timeline, assigned to the window where speech begins, and omitted from subtitle output when reliable timestamps are unavailable.
8. After each completed audio window, partial generated subtitles are formatted and shown immediately in the subtitle editor.
9. The user can preview, seek, and edit those live subtitles while transcription continues.
10. A deterministic generated-caption pass removes overlap-window duplicates, uses word timestamps when available, improves readable duration, smooths abrupt cuts, chains short safe gaps, splits long captions, and applies two-line wrapping.
11. The final formatted results settle into editable subtitle entries.
12. The user edits and exports SRT, VTT, TXT, or JSON locally.

## Generated Caption Readability

Generated captions use a deterministic, local-only post-processing pass informed by public subtitle guidance from Netflix, BBC, and DCMP:

- captions target about 21 characters per second and use the app's readable minimum duration when timing room allows
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

When importing project JSON, the app validates the schema and asks you to select the original video again. Saved video name and duration are used as comparison hints only.

## Keyboard Shortcuts

- Space: play or pause when focus is not in an input
- Arrow Left: seek backward 5 seconds
- Arrow Right: seek forward 5 seconds
- Ctrl+Z: undo subtitle edits
- Ctrl+Shift+Z or Ctrl+Y: redo subtitle edits
- Enter on a subtitle row: seek to that subtitle start

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
- The current FFmpeg.wasm path writes the selected file into FFmpeg's in-memory filesystem before extraction. That is not true streaming for arbitrary containers.
- Transformers.js chunking is used for long audio, but the extracted audio buffer is still held in browser memory.
- Codec support depends on the browser and FFmpeg.wasm build.
- WebGPU is optional. The app attempts supported WebAssembly or CPU fallback paths, but speed can be much slower.
- Word-level timestamps depend on model support and may fall back to coarser chunks.
- Generated subtitle synchronization is improved by deterministic post-processing, but it is not guaranteed perfect and should be reviewed manually.

## Troubleshooting

- Node.js missing: install Node.js from `https://nodejs.org/` and reopen the launcher.
- PowerShell blocks `npm.ps1`: the launcher uses `npm.cmd`; manual PowerShell users can run `npm.cmd install`.
- Model download fails: check network access, browser storage, and whether the model host is reachable.
- FFmpeg initialization fails: try a Chromium-based browser and restart the dev server.
- Video cannot be decoded: try MP4/H.264 or WebM/VP9. MOV and MKV support depends heavily on codecs.
- Empty or silent audio: confirm the source video has an audio track.
- Browser becomes slow: use a shorter file, the faster model, or close other memory-heavy apps.

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
