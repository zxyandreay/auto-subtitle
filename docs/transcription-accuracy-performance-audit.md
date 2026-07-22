# Transcription accuracy and performance audit

- Audit date: 2026-07-19
- Follow-up implementation update: 2026-07-23
- Pre-change baseline: `996148a357b9b53c24f0a1cae6acf02cf6813a0a`
- Scope: the browser-local FFmpeg.wasm and Transformers.js transcription path, its deterministic post-processing, live editor integration, diagnostics, and local benchmark tooling.

This audit is specific to this repository. It covers `src/workers/transcription.worker.ts`, every module under `src/transcription/` involved in extraction through timing repair, `src/subtitles/formatting.ts`, `src/subtitles/livePreview.ts`, transactional subtitle state and metadata invalidation, `src/diagnostics/`, the related tests, the optional benchmark capture/scorer, and the project documentation. The installed lockfile resolves `@huggingface/transformers` to 4.2.0, `@ffmpeg/ffmpeg` to 0.12.15, `@ffmpeg/core` to 0.12.10, and `@ffmpeg/util` to 0.12.2.

Terminology used below:

- **Confirmed** means the behavior was established from the checked-in source, the installed dependency source/types, or a deterministic test.
- **Real-media validation required** means the code path is understood, but no legally usable local audio fixture was available in this environment to measure its recognition quality or browser resource use.
- **Raw speech boundary** means the unpadded detector evidence in `SpeechRegion.rawStartTime` and `rawEndTime`.
- **Model-context region** means the raw boundary expanded by VAD pre/post padding in `SpeechRegion.startTime` and `endTime`.
- **Display padding** means the configurable subtitle lead-in and tail applied around content timing.

## 1. Current pipeline summary

The application remains a fully local single-page browser application. Model files can be fetched on first use and then cached by the browser, but the selected media is not uploaded. `vite.config.ts` binds the development and preview servers to `127.0.0.1`, supplies cross-origin isolation headers, and uses ES module workers. `local-launch.bat` still starts that Vite path.

### End-to-end data flow

| Stage | Current implementation |
| --- | --- |
| Video selection | `src/App.tsx` retains the browser `File` in `VideoFileState` and creates an object URL for the local player. Validation remains in `src/media/video.ts`. |
| Job boundary | `startBrowserWhisperTranscription` or `startBrowserWhisperRegeneration` in `src/transcription/browserWhisperProvider.ts` assigns a job ID and posts the `File` plus a frozen settings snapshot to the reusable module worker. Only one transcription or regeneration may run at a time. |
| Audio extraction | `extractAudio` in `src/workers/transcription.worker.ts` creates an FFmpeg instance, calls `fetchFile(file)`, writes the media to FFmpeg's in-memory filesystem, and executes arguments from `buildAudioExtractionArgs` in `src/transcription/audioExtraction.ts`. `-map 0:a:0` selects the first audio stream deterministically. The `aresample=async=1:first_pts=0` filter preserves a zero-based media timeline and inserts/resamples delayed audio as FFmpeg requires. Output is mono 16 kHz, signed 16-bit PCM WAV; no denoising or loudness normalization is applied. |
| PCM decode | `decodePcmWav` validates RIFF/WAVE and converts every PCM16 sample into a worker-owned `Float32Array`. A sampled whole-buffer RMS check rejects effectively empty audio instead of fabricating captions. |
| Speech analysis | `analyzeSpeechActivity` in `src/transcription/speechActivity.ts` computes rolling frame RMS, a locally adapting noise floor, separate speech-on and speech-off thresholds, hysteresis, and isolated-frame smoothing. It returns compact typed frame arrays plus raw speech boundaries and separately padded model-context regions. Failure returns no regions and activates safe fixed-window planning. |
| Window planning | `createSpeechAwareTranscriptionWindowPlan` in `src/transcription/windowing.ts` packs detected speech into model-safe core ownership spans. Long regions search a bounded radius around the ideal split and choose a deterministic non-speech or lowest-activity frame. Slice overlap supplies context, core ownership remains non-overlapping, and no slice can exceed the 29-second model budget. `createTranscriptionWindowPlan` is the contiguous fixed-window fallback. |
| Model resolution | `resolveSpeechModelRuntimeSettings` in `src/transcription/models.ts` preserves Tiny, Base, Large v3 Turbo, and Distil Large v3 compatibility rules and records word-timestamp capability. New settings default to Base, explicit English, `q8`, word timestamps, and automatic supported-device selection. Legacy `cpu` settings normalize to the actual browser CPU path, `wasm`. |
| Model loading | `loadTranscriber` in `src/workers/transcription.worker.ts` creates a Transformers.js automatic-speech-recognition pipeline keyed by model ID, execution provider, and dtype. Compatible low-resource pipelines can remain warm for bounded regeneration. Incompatible and high-resource pipelines are disposed; the outer worker also has an explicit and idle cleanup path. |
| Whisper inference | `transcribeInWindows` supplies one already bounded `Float32Array.subarray` to Transformers.js at a time with internal pipeline chunking disabled. It requests `return_timestamps: 'word'` only when the preference is enabled and the model registry supports it. Distil Large v3 uses segment timestamps directly; `transcribeWindowWithTimestampFallback` retries only a recognized unexpected word-timestamp capability failure and keeps segment mode for later calls. The worker leaves `max_new_tokens` unset so the installed library retains its seek-based timestamp continuation. |
| Timestamp normalization | `normalizeAsrResult` and `normalizeAsrChunks` in `src/transcription/timestampNormalization.ts` receive the actual successful timestamp mode. Window-relative timestamps are offset to the media timeline, chunks are owned by onset-based core boundaries, word chunks are merged only in explicit word mode, and malformed chunks are discarded. |
| Text-only fallback | If a result contains text but no usable chunks, `createFallbackSegment` requires exactly one merged raw-speech evidence span. The cue is bounded to that span and eight seconds, marked with algorithmic confidence `0.35`, and suppressed when evidence is absent, punctuation-only, or split across multiple speech islands. |
| Hallucination safety | Text without usable chunks requires unambiguous raw-speech evidence, and coverage repair is bounded. The pipeline does not delete sparse repeated segment text solely from RMS activity and repetition because that evidence cannot distinguish noise hallucinations from legitimate chants, stutters, or emphatic dialogue. |
| Boundary reconciliation | `reconcileBoundarySegments` in `src/transcription/reconciliation.ts` compares at most three segments and 512 normalized units on each side of a core boundary. It uses ordered suffix/prefix matching, prefers usable word timing and materially stronger confidence, retains punctuation, and uses a character fallback for several no-whitespace scripts. A segment-only suffix that crossed into the owned core is explicitly marked, allowing a nearby duplicated context prefix to be trimmed without requiring falsely overlapping segment timestamps; unmarked adjacent repeats remain. |
| Coverage check and repair | `findUncoveredSpeechRanges` in `src/transcription/coverage.ts` compares raw speech with reliable word ranges or speech-overlapping segment evidence. Low-confidence, implausibly long, poorly represented, and mostly-silence evidence cannot hide a miss. `createRepairWindowPlans` and `selectRepairSegments` in `src/transcription/repair.ts` perform one bounded pass of at most 20 model-safe ranges and retain only content owned by each gap. |
| Timing refinement | `refineSegmentsToSpeechBoundaries` in `src/transcription/timingRefinement.ts` uses monotonic word timestamps first and nearby raw VAD starts/ends second. Onset and offset use separate search radii. Display padding is applied once, results are rounded to milliseconds, and adjacent cues are made non-overlapping without cutting valid rapid-dialogue word evidence solely to manufacture a cosmetic gap. |
| Generated cue formatting | `optimizeGeneratedCaptions` applies length, CPS, pause, punctuation, duration, overlap, and line rules. After overlap normalization, one final segment-only smoothing pass can merge a newly squeezed micro-cue with a compatible neighbor, followed by another non-overlap pass. Word-timed localization and meaningful pauses are protected. |
| Streaming preview | `postPartialResult` sends a changed-suffix delta. `applyPartialDelta` validates and reconstructs the accumulated snapshot. `formatTranscriptionSegments` and `mergeLiveTranscriptionPreview` produce stable editable rows, while `useUndoableSubtitles` stages them in an id-scoped transaction. User edits remain visible; success commits once, and cancellation/failure restores committed history. |
| Editor and output | Generated and imported data still converge on `SubtitleEntry[]`. Autosave reads committed entries rather than an active preview. Semantic text edits or incompatible timing edits invalidate stale ASR words/confidence, while import/export remains schema-compatible. |

### Installed Transformers.js behavior

The installed ASR type declares `return_timestamps?: boolean | 'word'`, `chunk_length_s`, `stride_length_s`, `force_full_sequences`, `language`, `task`, and `num_frames`, in addition to generic generation parameters. The implementation in `node_modules/@huggingface/transformers/src/models/whisper/modeling_whisper.js` contains a language-detection TODO and defaults an unspecified multilingual language to English. Therefore the former `language: 'auto'` setting did not independently detect language per window; it repeatedly relied on an English fallback.

Generic generation code in 4.2.0 supports controls including sampling temperature, `top_k`, `top_p`, beams, `repetition_penalty`, and `no_repeat_ngram_size`. The Python Whisper controls commonly named `no_speech_threshold`, average-log-probability threshold, compression-ratio threshold, `condition_on_previous_text`, and array-based temperature fallback are not exposed as equivalent ASR options by this installed pipeline. They were not copied blindly into the browser call.

## 2. Confirmed weaknesses

The following weaknesses existed at the baseline commit and were confirmed from source or deterministic reproduction:

1. **Timestamp mode was inferred from output shape.** `normalizeAsrChunks` guessed that chunks represented words only when there were more than three chunks and every chunk contained at most two whitespace-delimited tokens. Valid one-, two-, and three-word results lost word metadata, while short segment chunks could be misclassified.

2. **The default language behavior was mislabeled.** Defaults were Tiny plus `language: 'auto'`, but Transformers.js 4.2.0 does not implement the expected Whisper language detection. Omitting the language selected English in the installed model code.

3. **The text-only fallback selected one arbitrary speech island.** It assigned a window's complete text to the longest padded speech region, even when the result could cover several disjoint regions. It also expanded that already padded interval with display padding.

4. **VAD repeatedly summed overlapping samples.** Each 30 ms frame recomputed all sample squares despite the 10 ms hop. It also allocated an object for every frame, used one global 20th-percentile threshold for the whole file, had no separate off threshold, and discarded raw boundaries after padding.

5. **Long speech was split only by elapsed duration.** `splitLongRegions` could not use the frame evidence to prefer a nearby pause. The maximum input limit was safe, but the chosen boundary could unnecessarily cut a word.

6. **Timing refinement reused padded VAD regions as acoustic evidence.** It then applied subtitle lead/tail padding, permitting accidental double padding. It ignored available word timing and reverted both adjacent cues when a snap caused a conflict instead of resolving the pair from content evidence.

7. **Boundary reconciliation considered only the last accumulated cue at each step.** Near-duplicate choice relied on bag-like token similarity, a duplicated prefix advanced timestamps proportionally by token count, usable word timestamps were not used to trim the suffix, and scripts without whitespace had weak support. This could either preserve duplicate text or remove a legitimate repeated phrase.

8. **Coverage was duration-only.** Any non-empty cue interval counted as coverage, including a low-confidence fallback or a long caption lying mostly over silence. Padded VAD regions were treated as speech, and a large absolute miss could be ignored when it was a small fraction of one long region.

9. **Repair truncated long misses and retained stale context.** One long uncovered range was centered into one model-sized window, so its ends could remain unprocessed. Accepted word metadata and text were not rebuilt after clamping to the owned gap, and selected repair cues were not all considered when finding neighbors.

10. **Every job rebuilt the worker and model.** Full transcription always terminated its worker and disposed the pipeline at completion. Range regeneration had a separate worker implementation and only it received a bounded startup retry.

11. **Partial results retransmitted the full accumulated segment array.** For a long file, every window increased structured-clone payload and main-thread reconstruction work. Formatting then regenerated positional IDs; inserting an earlier repaired cue could cause an existing user edit to follow the wrong generated row.

12. **Diagnostics amplified long jobs.** Every event reserialized the complete retained history to calculate its size and then rewrote all of it to `localStorage`. Although storage was bounded, write and serialization work grew with history length.

13. **Several formatter edge cases could damage output.** A fixed split-work guard could leave queued transcript text un-emitted, low-confidence untimestamped text could be stretched for readability beyond its evidence, padded word-timed captions could overlap after splitting, CJK word pieces gained inappropriate spaces, and choosing a longer duplicate could retain the shorter candidate's stale word list.

14. **The `cpu` UI/runtime value did not name the installed browser execution device.** Transformers.js uses `wasm` for its browser CPU execution path. Legacy projects needed an explicit compatibility mapping rather than passing the stale value through.

## 3. Suspected weaknesses that still need real-media validation

These are plausible risks, not measured regressions or improvements:

- The enhanced VAD is still energy-based. Loud music, steady tonal noise, crowd ambience, breathing, and sound effects can resemble speech in RMS. It has no pitch, spectral flux, harmonicity, or neural speech posterior.

- The adapting noise floor may still miss very quiet speech after a loud/noisy interval, while a slowly rising non-speech source can remain active long enough to be treated as speech. The deterministic synthetic tests do not represent microphones, compression, or mastering.

- A lowest-activity frame inside genuinely continuous speech may be a quiet phoneme rather than a word boundary. The bounded search is safer than a blind duration split, but only word-aligned real references can establish the net timing effect.

- Base is a technically more defensible new-project default than Tiny for an accuracy-oriented editor, but its WER/CER, latency, memory, and failure rate across actual target devices have not been measured here. Existing projects retain their saved models.

- The reconciliation thresholds need multilingual and conversational evaluation, especially stutters, intentional repetitions, code switching, agglutinative languages, and punctuation changes between windows.

- Word timestamps returned by a model are not ground truth. Timestamp refinement now preserves them as primary evidence, but different exports, quantization choices, languages, singing, overlapping speakers, and noise can make those word boundaries inaccurate.

- Coverage repair cannot recover speech that the VAD never detects. Conversely, a false-positive VAD island can trigger a bounded but unnecessary repair call.

- Keeping a low-resource model warm is expected to improve compatible range-regeneration startup, but actual warm-load savings and GPU/WASM resource release behavior are browser- and device-specific.

- Delta messages reduce worker-to-main payloads, but the provider still rebuilds a complete snapshot and the app still reformats that snapshot. Very long jobs may therefore retain main-thread work that grows with subtitle count.

- `performance.memory.usedJSHeapSize` is Chromium-specific and does not reliably include WASM linear memory, WebGPU buffers, browser media state, or all shared backing stores. It is not a process peak measurement.

- Segment-timestamp captions without whitespace now have a punctuation-preferred grapheme-cluster fallback, but natural break quality for Thai, Khmer, Lao, Myanmar, and mixed-script text still needs real-media/reference validation; preserving text and line limits does not prove a linguistically natural split.

- Segment-only output cannot expose a pause hidden inside one broad model segment. The formatter can protect inter-segment gaps and use punctuation, but word-timed pause quality still depends on the selected model export.

- Deterministic first-stream selection prevents accidental FFmpeg auto-selection changes, but files with multiple language/commentary tracks still require remuxing because the UI has no audio-track selector.

- An experimental duration-scaled `max_new_tokens` ceiling was rejected after review of the installed Transformers.js implementation showed that setting it bypasses Whisper's timestamp seek loop. Model-safe audio windows remain the non-destructive work bound.

- An experimental repeated low-information filter was rejected because legitimate repeated cues over sustained activity can satisfy the same evidence pattern as music hallucinations. Uncertain text is retained for review rather than silently deleted.

## 4. Baseline benchmark design

### Committed harness

The local tooling keeps browser capture separate from deterministic scoring:

```text
benchmarks/
  README.md
  fixtures.local/
    .gitkeep
  manifests/
    example.json
  results/
    .gitkeep
scripts/
  benchmark.mjs
  capture-benchmark.mjs
  benchmark/
```

`benchmarks/fixtures.local/*`, `benchmarks/results/*`, and `benchmarks/manifests/*.local.json` are ignored except for the two `.gitkeep` files. No copyrighted media, model cache, transcript result, or invented measurement is committed. `example.json` is a schema example and is expected to fail until the placeholder paths are replaced with local material.

The workflow is:

1. Run `npm run benchmark:self-test` to validate the scorer on synthetic data.

2. Create a local manifest with legally usable media plus human-checked transcript, word, cue, and speech-interval references as available.

3. Start the app through `local-launch.bat`. Either capture manually or run `npm run benchmark:capture -- --video <path> --out-dir <ignored-path> --case-id <id> ...` to drive one unedited job through installed Chrome or Edge and validate its project, diagnostics, settings, and telemetry.

4. Score a capture with `npm run benchmark -- --manifest <manifest.local.json> --run <run.local.json> --out <result.json>`.

5. Capture a candidate under the same browser, hardware, media, model, language, execution provider, dtype, timestamp mode, VAD, window, and formatting settings.

6. Compare reports with `npm run benchmark:compare -- --baseline <baseline.json> --candidate <candidate.json> --out <comparison.json>`.

The scorer hashes media with SHA-256, fingerprints the suite and references, checks setting sources, and flags environment or setting differences. It reports `candidateMinusBaseline` without labeling it an improvement, because lower is desirable for some metrics and higher for others and because statistical significance is outside the scorer.

### Accuracy, timing, and readability metrics

- Word error rate with insertion, deletion, and substitution counts for space-delimited languages.

- Unicode-code-point character error rate for configured CER cases.

- NFKC-based normalized transcript similarity under manifest-controlled punctuation, case, and whitespace rules.

- Mean and median absolute word-start and word-end error, signed mean error, matched count, and match coverage from deterministic monotonic word alignment.

- Mean, median, and maximum absolute cue onset and offset error plus signed mean error from bounded monotonic cue alignment.

- Counts and percentages of matched cue starts and ends within 250 ms, 500 ms, and 1,000 ms tolerances.

- Missed reference speech duration and candidate cue duration outside reference speech.

- Raw and reference-discounted adjacent duplicate-unit and repeated-phrase rates, with word and character summaries kept separate.

- Subtitle overlap count/duration, invalid cue and word timestamps, CPS violations, maximum line-length violations, excess-line violations, cue-duration distribution, and adjacent-gap distribution.

- Optional minimum/maximum cue-duration violations when a benchmark manifest supplies those readability constraints.

- Bounded normalized text and cue-difference samples for inspection without allowing a pathological transcript or segmentation mismatch to make the report unbounded.

### Performance and memory telemetry

The manifest supports measured extraction, model loading, VAD, window planning, inference, coverage repair, timing refinement, formatting, total time, audio duration, total/inference real-time factor, cold/warm model state, approximate memory, and worker message counts/bytes by event type. Missing values stay `null`; missing stage values are not treated as zero.

Current diagnostic mappings are documented in `benchmarks/README.md`:

- Worker `job-performance` supplies bounded stage durations and cold/warm state.

- App `formatted-transcription-preview` and `formatted-transcription` supply measured main-thread formatting durations.

- App `transcription-completed` supplies total elapsed time, audio duration, and real-time factor.

- Provider `worker-message-metrics` counts every observed worker-to-main event and estimates its UTF-8 JSON size by type.

- Sampled `approximateJsHeapBytes` can be recorded only as an explicitly approximate Chromium JS-heap high-water mark.

Two telemetry caveats matter when interpreting a capture. First, `transcription-completed.data.audioDurationSeconds` is currently populated from the selected video's metadata duration, not independently from the decoded PCM length; treat it as media-timeline duration and use the worker's `decoded-audio.data.durationSeconds` when an audio-only denominator is required. Second, heap samples are taken during preview/final formatting and failure settlement, not continuously during FFmpeg extraction or model inference, so their maximum can miss the actual allocation peak.

The scorer does not run Whisper itself. That keeps comparison deterministic and fast. The optional capture command supplies the actual browser path and requires a running loopback app, installed Chrome or Edge, local media, and an available/cached model; neither command is part of the normal unit-test suite.

## 5. Implemented changes

### Prioritization and risk matrix

Impact labels are expected direction based on the mechanism, not measured real-media gains.

| Change | Accuracy impact | Timing impact | Performance impact | Implementation / regression risk | Browser compatibility | Memory / download cost | Testability | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Benchmark scorer and telemetry | Indirect, enables measurement | Indirect | Small diagnostic overhead | Low / low | Node scorer plus existing browser APIs | Negligible / none | High | Implemented |
| Optional browser capture and bounded report detail | Indirect, captures reproducible evidence | Indirect | Capture runs the real local workload | Low / low | Installed Chrome or Edge plus loopback app | Reuses browser/model cache / none added to app | High mapping coverage; local integration required | Implemented |
| Deterministic first audio stream and bounded speech packing | Medium when source selection or fragmented speech matters | Medium | Adaptive grouping avoids one model call per short detected region while respecting the combined-span budget | Low / low | Existing FFmpeg and pure planning logic | None / none | High | Implemented |
| Model capability-aware timestamp request | Neutral text | Medium | Avoids one known failed Distil request | Low / low | Registry plus existing fallback | None / none | High | Implemented |
| Duration-scaled Whisper token ceiling | Can truncate dense output by bypassing timestamp seek | Neutral timing | Apparent speed gain was unsafe | Low / high | Existing generation option | None / none | Review exposed library interaction | Rejected and removed |
| Repeated low-information activity filter | Can delete legitimate repetition | Can remove correctly timed cues | Can avoid calls only by suppressing evidence | Medium / high | Pure logic and RMS VAD | None / none | Counterexample reproduced | Rejected and removed |
| Context-marked prefix trimming | Reduces duplicated overlap text | Preserves unique crossing suffixes | Bounded comparison work | Medium / medium | Pure logic | One internal boolean / none | High | Implemented |
| Final segment-only micro-cue smoothing | Neutral recognition | Improves duration/readability after overlap repair | Small bounded second pass | Low / low | Pure logic | None / none | High | Implemented |
| Pause/punctuation-aware cue boundaries | Neutral recognition | Medium | Small bounded scoring work | Medium / low | Pure logic | None / none | High | Implemented |
| Transactional live preview and stale ASR invalidation | Preserves manual correction evidence | Preserves committed timing on failure | Small reducer/snapshot work | Medium / medium | React state and plain objects | Bounded draft alongside committed state / none | High reducer coverage | Implemented |
| Explicit ASR timestamp mode | High for short word results | High | Neutral | Low / low | Matches installed ASR type | None / none | High | Implemented |
| Conservative text-only fallback | High hallucination safety | High silence-placement safety | May add bounded repair calls | Low / low | Pure logic | None / none | High | Implemented |
| Rolling adaptive RMS and raw boundaries | Medium, condition-dependent | Medium | High VAD CPU reduction expected from complexity | Medium / medium | Typed arrays and standard JS | About 6.1 MB/hour of retained frame arrays at 10 ms hop / none | High | Implemented |
| Low-activity boundary search | Medium, condition-dependent | Medium | Small planning cost | Medium / medium | Pure logic | Uses existing frame arrays / none | High | Implemented |
| Word-first timing and one-time padding | Low text impact | High | Neutral | Medium / medium | Pure logic | None / none | High | Implemented |
| Time-aware sequence reconciliation | High duplicate-suppression potential | Medium | Bounded comparison work | Medium / medium | Unicode property escapes already used by project | Small bounded arrays / none | High | Implemented |
| Evidence-aware coverage and split repair | Medium-to-high recovery potential | Medium | May add warranted repair inference | Medium / medium | Pure logic | Bounded to 20 ranges / none | High | Implemented |
| Delta partial protocol and stable preview IDs | Neutral text | Neutral | High message reduction expected on long jobs | Medium / medium | Structured clone of plain objects | Lower message payload; full reconstructed snapshots remain / none | High | Implemented |
| Reusable worker and selective model warmth | Neutral text | Neutral | High for compatible regeneration expected | Medium / medium | Worker behavior already required | Can retain a low-resource model for two idle minutes / no new download | High at provider boundary; browser profiling needed | Implemented conservatively |
| True streaming decode | Neutral | Neutral | Potentially high | High / high | Container- and browser-dependent | Potentially large reduction / none | Low without browser fixtures | Deferred |
| Local neural VAD | Potentially high but unmeasured | Potentially medium | Negative startup/inference cost | High / medium | Provider/model dependent | Additional model memory and download | Medium | Deferred |

### Timestamp, fallback, and language behavior

- `AsrTimestampMode` and `AsrTimelineOptions.timestampMode` make word versus segment normalization explicit. The worker passes the mode that actually succeeded after fallback.

- Model metadata now declares whether word timestamps are supported. Distil Large v3 begins directly in segment mode; a recognized unexpected alignment/cross-attention error still retries once and changes later calls in that job to segment mode.

- The worker leaves `max_new_tokens` unset for timestamped Whisper calls. This retains Transformers.js seek-based continuation when a slice is not fully transcribed in one pass and avoids a hidden truncation/performance tradeoff.

- One through many word chunks are retained, malformed neighboring chunks do not invalidate valid chunks, segment chunks remain segments, and punctuation/CJK word joining avoids inserted spaces that change the transcript.

- Text-only output is emitted only within one raw speech span and is marked low confidence. Ambiguous multi-island and silence-only results produce no caption; the existing bounded coverage path is allowed to retry rather than placing text over confirmed silence.

- New projects default to Base and explicit English. The UI labels the legacy automatic choice as an English fallback, and the worker emits `automatic-language-fallback` if an old project still supplies `auto`. This is an honesty and consistency fix, not language detection.

- Legacy `cpu` settings normalize to `wasm` without breaking old project JSON. No model entry was removed or renamed.

### Speech analysis and windows

- `calculateRollingRms` changes overlapping-frame energy analysis from repeated frame summation to one forward rolling sum.

- `SpeechActivityFrameSeries` uses typed arrays for sample starts, RMS, thresholds, activity, and speech decisions. `SpeechRegion` now preserves raw boundaries separately from model-context padding and includes bounded activity confidence.

- Separate on/off thresholds and `speechOffThresholdRatio` implement hysteresis. `noiseAdaptationRate` updates a bounded local floor more quickly during quiet frames and slowly during active frames.

- `chooseLowActivityBoundary` deterministically prefers non-speech, then lower activity, then proximity to the target, then the earlier exact frame. It searches only the configured radius and retains duration splitting for continuous speech or missing frame data.

- Separate detected regions are packed together while their combined ownership span fits the target core budget. The 1.5-second value is contextual overlap around that ownership span, not a maximum silence gap. Core spans remain contiguous within a long region, slice overlap remains contextual, and sample-derived slice lengths remain capped at the configured maximum and the hard 29-second ceiling.

### Reconciliation, coverage, repair, and timing

- Boundary alignment now spans a short sequence on both sides, uses a linear prefix-function overlap search for the bounded units, and requires time overlap before removing text. A one-unit overlap is accepted when both sides have complete word timing or when each overlapping segment consists of exactly that one normalized unit. Time overlap is still required, so an adjacent intentional one-word repeat is preserved.

- Duplicate choice prefers complete monotonic word timing, then a material confidence advantage, then stable punctuation evidence. It does not treat reordered bags of words as equal. Character fallback covers Han, Hiragana, Katakana, Hangul, Thai, Lao, Khmer, and Myanmar-style text, with combining marks retained.

- When usable words exist, trimming uses their real timestamps and rebuilds text/metadata. Proportional segment timing is only the bounded fallback when word timing cannot locate a retained suffix. Punctuation between the removed overlap and unique suffix is transferred to the supported existing boundary instead of being silently discarded or left as a leading punctuation-only fragment.

- Coverage uses raw VAD intervals. Word evidence must be valid, bounded in duration, ordered enough to represent the segment text, clamped to the segment, and intersect raw speech. Low-confidence or mostly-silence segment intervals are ignored. A large two-second absolute gap can trigger repair even when its ratio within a long speech region is below the ratio threshold.

- Long repair gaps are split into contiguous owned ranges that each leave context inside the model limit. Word-timed candidates are trimmed to the gap, stale context text is rebuilt, and all accepted candidates participate in non-overlap checks. Similar text is rejected only when its actual time range overlaps, so an intentional immediate repeat in the next non-overlapping interval is preserved. Repair remains one pass and at most 20 windows.

- Timing refinement uses word content starts/ends first and raw VAD boundaries second. Its onset and offset searches are separate, boundary lookup is deterministic, display padding is not compounded with VAD padding, and adjacency is resolved on integer milliseconds.

### Subtitle formatting and live responsiveness

- Word-timed grouping preserves punctuation and CJK spacing and rechecks overlaps after applying display padding.

- Low-confidence text-only cues are not extended beyond their evidence. If their text cannot meet the hard CPS limit inside that evidence, it is suppressed instead of stretched over silence.

- Recursive plain-text splitting is now input-bounded and cannot silently drop a queued tail. Punctuation and phrase penalties remain deterministic and dependency-free.

- `findUnbrokenTextSplit` gives oversized segment-timestamp text without spaces a punctuation-preferred grapheme-cluster fallback, preserving every character and combining sequence while bringing lines within the configured length. Word-timestamp joining remains punctuation/CJK-aware.

- Duplicate selection no longer combines one candidate's text with another candidate's stale word list.

- `stabilizeGeneratedEntryIds` uses bounded timing, ordered-text similarity, and monotonic previous-cue ownership. A repair insertion before an edited cue therefore does not shift positional IDs, and reordered candidates cannot cross-match identities and misattach the user's edit.

- Word-timed grouping now considers an internal pause of at least 350 ms a natural split even when the whole cue fits its hard limits, grades punctuation plus shorter clause pauses, and lets a pause of at least 750 ms override the normal penalty against a one-word side. Segment-only punctuation splitting avoids avoidable one-word cues.

- Later duration extension, fragment smoothing, and gap closing preserve measured word/segment pauses of at least 350 ms instead of flattening them into mechanically continuous captions.

- Full transcription previews now live in an id-scoped subtitle transaction. Partial worker updates and manual edits alter only its draft; success becomes one undoable commit, while cancellation or failure exposes the untouched committed entries and history. Autosave reads committed entries.

- `invalidateStaleAsrMetadata` removes word/confidence evidence after semantic text changes or timing edits that no longer contain the words, while retaining safe wrapping/padding and fresh regenerated metadata.

- No text-only repeated-cue filter runs after ASR. The attempted RMS-plus-repetition heuristic was removed after a legitimate repeated-dialogue counterexample demonstrated possible data loss.

- Segment-only chunks that begin in left overlap but retain at least 0.5 seconds inside the owned core are kept with `boundaryContextPrefix` evidence. Reconciliation may trim a matching nearby prefix only when it has at least two units. A single repeated word is retained because coarse segment timing cannot prove it belongs to overlap context.

- After normal overlap resolution, the formatter performs a final smoothing pass only for segment-timed neighbors. It merges an abrupt micro-cue only when the gap, meaningful-boundary, combined length, maximum duration, and hard-CPS checks all pass, then normalizes overlap again.

### Worker lifecycle, messages, reliability, and diagnostics

- Full and range extraction now pass `-map 0:a:0`, so FFmpeg always uses the first audio stream rather than relying on implicit stream selection. Mono 16 kHz conversion and delayed-track compensation are unchanged.

- One provider worker handles sequential transcription and regeneration jobs, tags all messages with job IDs, rejects concurrent work, ignores stale events, retries one pre-message startup crash, and terminates immediately on cancellation or a reported crash.

- The worker caches a compatible pipeline by model/provider/dtype. It disposes incompatible pipelines, high-resource models after each job, all warm state after two idle minutes, and all state on explicit app/video cleanup. Before full-file extraction it releases any warm model to avoid overlapping model memory with the extraction peak. The provider additionally evicts warm state before media of at least 256 MiB.

- FFmpeg remains per-extraction and is always cleaned up in `finally`; this avoids retaining its WASM filesystem beside an idle model.

- Partial messages carry `replaceFromIndex`, `totalSegments`, and only the changed suffix. The provider validates the delta and rebuilds the public snapshot so existing callback consumers remain compatible.

- Provider diagnostics report counts and approximate JSON bytes for every worker-to-main message by type. Worker diagnostics report stage durations and whether model loading was cold or warm. The app records preview/final formatting time, total job time, real-time factor, and optional sampled Chromium heap.

- `DiagnosticLog` keeps its existing 1,000-event and approximately 2 MB limits, but tracks event sizes incrementally and coalesces persistence for 250 ms. `flush()` and a `pagehide` handler preserve final local state without rewriting the complete history for every event.

- The benchmark report includes maximum timing errors, 250/500/1,000 ms tolerance bands, cue duration/gap summaries, optional duration-constraint violations, and bounded normalized text/cue difference samples. The optional Playwright capture command validates project/settings/diagnostic consistency and writes ignored local artifacts without modifying the source video or reference.

### Deterministic regression coverage

Focused tests now cover:

- one-to-many word chunks, short segment chunks, invalid/partial timestamp arrays, core boundaries, ambiguous fallback, raw evidence, and punctuation/CJK joining in `src/tests/transcription-timestamps.test.ts`;

- rolling RMS equivalence, hysteresis, changing noise floor, and raw pauses under overlapping padding in `src/tests/speech-activity.test.ts`;

- internal pauses, out-of-radius silence, continuous speech, exact sample positions, deterministic ties, and late-window planning in `src/tests/transcription-windowing.test.ts`;

- model-safe window packing and direct model capability handling in `src/tests/transcription-windowing.test.ts`, `src/tests/transcription-settings.test.ts`, and `src/tests/transcription-models.test.ts`;

- word-first timing, conflicting VAD, correct unchanged timing, rapid dialogue, overlaps, multi-segment and no-whitespace reconciliation, legitimate repetition, confidence, punctuation, and bounded long comparisons in `src/tests/timing-refinement.test.ts`;

- confidence/word/text/speech-overlap coverage and large absolute misses in `src/tests/transcription-coverage.test.ts`;

- split long repairs, gap-owned words, CJK punctuation, crossing words, duplicates, and accepted-candidate non-overlap in `src/tests/transcription-repair.test.ts`;

- delta reconstruction, all-message metrics, worker reuse, large-media eviction, concurrency, cancellation, crash recovery, and idle cleanup in `src/tests/browser-whisper-provider.test.ts`;

- low-confidence timing, readable splitting without text loss, word-timestamp CJK captions, long no-whitespace and combining-mark text, post-padding overlap, duplicate metadata, stable monotonic edit/delete IDs, and SRT/VTT/TXT/project compatibility in `src/tests/subtitle-utils.test.ts`;

- meaningful-pause segmentation, one-word avoidance, transactional commit/rollback/stale-id behavior, immutable settings snapshots, and ASR metadata invalidation in the subtitle utility, undoable-subtitle, settings-snapshot, and subtitle-editing suites;

- marked overlap-context prefix trimming, intentional-repeat preservation, and final segment-only micro-cue smoothing in the timestamp, timing-refinement, and subtitle utility suites;

- coalesced bounded persistence in `src/tests/diagnostic-log.test.ts` and legacy settings/UI behavior in the model, settings, transcription-panel, and regeneration-dialog suites.

## 6. Rejected approaches and reasons

| Approach | Decision | Repository-specific reason |
| --- | --- | --- |
| Paid/cloud transcription, upload service, backend, auth, or analytics | Rejected | Violates the product's local-only architecture and explicit constraints. No media upload path was added. |
| Python Whisper decoding arguments copied into Transformers.js | Rejected | The installed 4.2.0 ASR surface does not expose equivalent no-speech/log-probability/compression/previous-token/temperature-fallback semantics. Unknown options would be misleading and could be ignored or forwarded unpredictably. |
| Aggressive generic repetition penalties | Deferred | `repetition_penalty` and `no_repeat_ngram_size` exist in generic generation code, but they can remove legitimate stutters, names, lyrics, or rhetorical repetition. Boundary reconciliation and evidence filtering are deterministic and locally testable; decoding penalties require real-media A/B results first. |
| Automatic language detection per window | Rejected as a claim | The installed Whisper implementation has no detector. Repeating an unspecified language per window actually repeats an English fallback. The app now defaults to explicit English and asks non-English users to choose a language. |
| Separate language-identification model | Deferred | It would add download, startup, licensing review, memory, browser support, and failure-mode costs. A representative-audio strategy is worth revisiting only with a small verified local detector and fallback. |
| Large model as the universal default | Rejected | Large v3 Turbo and Distil Large v3 are high-resource, have language/task restrictions, and can fail on common devices. Base is the balanced new-project default; Tiny and both large choices remain available. |
| One bundled Fast/Balanced/Accurate settings switch | Deferred | The existing registry already exposes model tiers and advanced controls. Coupling model, provider, dtype, VAD, and window settings without device/fixture measurements would turn unverified assumptions into policy. The benchmark should first establish useful profiles. |
| Browser-local neural VAD | Deferred | It may improve speech/music discrimination, but adds a second model download, memory, startup latency, licensing work, WebGPU/WASM compatibility risk, and another failure path. The rolling adaptive RMS detector is a smaller isolated change with safe fixed-window fallback. |
| Add zero-crossing or spectral features immediately | Deferred | These can help certain noises but can also promote music/percussion. No representative local corpus was available to tune or prove thresholds, and a spectral implementation increases CPU and memory work. Frame data is now retained so an enhanced mode can be evaluated later. |
| Replace FFmpeg with `AudioContext.decodeAudioData` | Rejected as the primary path | Browser-native codec/container coverage is inconsistent for MP4, WebM, MOV, and MKV; delayed tracks and extraction ranges also need reliable timeline behavior. It may become an optional fast path only with FFmpeg fallback and browser tests. |
| Change WAV to raw PCM solely to save memory | Deferred | Removing the small WAV header does not remove the dominant MEMFS output, transferred `Uint8Array`, and decoded Float32 allocations. The current RIFF validation is deterministic and tested. A useful improvement must change buffer lifetime or streaming, not only the container header. |
| Keep FFmpeg.wasm warm | Rejected for this change | Its WASM linear memory and MEMFS would coexist with model state between jobs. Current extraction creates, deletes, and terminates FFmpeg in one `try/finally`, bounding stale state at the cost of initialization time. |
| Keep Turbo/Distil pipelines indefinitely | Rejected | High-resource model state can be larger than the audio and app data combined. It is explicitly released after each job; lower-resource warmth is time-bounded and visible in diagnostics. |
| Full streaming/range decode rewrite | Deferred | FFmpeg.wasm currently requires the selected compressed file in its in-memory filesystem. True arbitrary-container streaming would be a separate architecture change with high regression risk for codec coverage, cancellation, and delayed timelines. |
| Full NLP dependency for phrase splitting | Rejected | Download and bundle cost, multilingual ambiguity, and lack of speaker metadata outweigh the unmeasured benefit. Existing punctuation, timing, and small phrase penalties remain deterministic. |
| Dependency upgrades | Rejected for this audit | The implemented fixes do not require a version bump. Keeping the lockfile stable isolates behavioral changes and avoids mixing an ASR/runtime migration with algorithm changes. |

## 7. Before-and-after measurements when available

### Pre-change deterministic baseline

The baseline was captured on commit `996148a` with Node 24.14.1 and npm 11.11.0. On this PowerShell host, `npm.cmd` was used because the local execution policy blocks the `npm.ps1` shim; it invokes the same package scripts.

| Check | Baseline result |
| --- | --- |
| `npm.cmd run typecheck` | Passed; 19.51 s command time |
| `npm.cmd run lint` | Passed; 2.23 s command time |
| `npm.cmd test` | Passed; 27 files, 195 tests; 32.29 s command time, 5.04 s Vitest-reported test time |
| `npm.cmd run build` | Passed; 10.44 s command time, 3.50 s Vite build phase |

Selected baseline production asset sizes reported by Vite were 32,232.41 kB for the FFmpeg WASM asset, 23,567.05 kB for the ONNX Runtime WASM asset, 516.60 kB for the Transformers JavaScript chunk, and 320.13 kB for the application JavaScript chunk. These are transfer/build artifacts, not runtime peak memory.

### Post-change deterministic evidence

At the 2026-07-23 follow-up, `npm.cmd run benchmark:self-test` passed 66 checks. The added checks cover bounded difference details, maximum timing error, tolerance bands, cue-duration and gap distributions, optional duration constraints, and their suite/comparison aggregation. `npm.cmd run benchmark:capture -- --self-test` passed 10 diagnostic-to-telemetry mapping and validation checks without opening a browser. All values are synthetic tooling inputs, not application benchmark results.

The following table is the historical branch-wide gate recorded at the original audit checkpoint; it is not a substitute for the final validation of the follow-up implementation:

| Check | Post-change result |
| --- | --- |
| `npm.cmd run typecheck` | Passed |
| `npm.cmd run lint` | Passed |
| `npm.cmd test` | Passed; 27 files, 280 tests; 33.10 s Vitest duration and 7.19 s reported test execution |
| `npm.cmd run build` | Passed; 14.20 s command time and 1.84 s Vite build phase |
| `npm.cmd run benchmark:self-test` | Passed; 36 deterministic scorer checks |
| `local-launch.bat` smoke test | Passed with `AUTO_SUBTITLE_NO_BROWSER=1`; Vite reported ready on `127.0.0.1:5173` in 477 ms and stopped cleanly on Enter |

At that original checkpoint, the FFmpeg WASM, ONNX Runtime WASM, and Transformers JavaScript production artifacts remained 32,232.41 kB, 23,567.05 kB, and 516.60 kB respectively. The raw main application JavaScript artifact changed from 320.13 kB to 329.87 kB (+9.74 kB, about 3.0%). Hashed filenames and gzip sizes are build artifacts, not runtime-memory or throughput measurements. The test-count and build-size changes are historical reproducibility data, not accuracy or speed gains.

### Private Matrix reference benchmark

The follow-up used one private English Matrix clip and its manually corrected Auto Subtitle project JSON as the reference. The video, reference JSON, generated projects, diagnostic logs, reports, model files, and final build artifacts remain ignored and are not committed. The values below reproduce the deterministic scorer's baseline and final outputs at their recorded precision; they are not claims about other media. Here, **Baseline** and **Final** identify the two captured subtitle outputs, not an additional source-control revision beyond the audit baseline named above.

#### Text and cue alignment

| Metric | Baseline | Final |
| --- | ---: | ---: |
| Word error rate | `0.305263` | `0.115789` |
| Word errors | `58` (`8` substitutions, `33` deletions, `17` insertions) | `22` (`0` substitutions, `0` deletions, `22` insertions) |
| Character error rate | `0.2625` | `0.061111` |
| Normalized transcript similarity | `0.7375` | `0.942408` |
| Candidate cue count | `35` | `37` |
| Matched cue count | `23` | `27` |

The final-code output substantially reduced text error on this fixture and eliminated measured substitutions and deletions. Its 22 remaining word errors were insertions: an isolated repair hallucination, one repeated five-word phrase in the pill-choice section, and several music/outro fragments. The safer pipeline retains those uncertain repetitions because the rejected RMS-plus-text filter could erase legitimate speech.

#### Cue timing

| Metric | Baseline | Final | Direction on this fixture |
| --- | ---: | ---: | --- |
| Mean absolute onset error | `1.253217 s` | `1.005407 s` | Better |
| Median absolute onset error | `0.542 s` | `0.708 s` | Worse |
| Maximum absolute onset error | `9.146 s` | `9.146 s` | Unchanged |
| Matched onsets within 500 ms | `47.826087%` | `40.740741%` | Worse |
| Mean absolute offset error | `1.443087 s` | `0.991 s` | Better |
| Median absolute offset error | `0.52 s` | `0.724 s` | Worse |
| Maximum absolute offset error | `10.001 s` | `4.747 s` | Better |
| Matched offsets within 500 ms | `47.826087%` | `40.740741%` | Worse |

Timing was mixed. Mean onset and offset error improved and maximum offset error fell, but both median errors and both 500 ms match percentages worsened; maximum onset error was unchanged. The matched set also grew from 23 to 27 cues, so the summaries do not contain identical pairs. Distil Large v3 does not provide word timestamps in this app, and this segment-only result does not support a blanket synchronization-improvement claim.

#### Speech coverage and readability

| Metric | Baseline | Final |
| --- | ---: | ---: |
| Missed reference speech | `17.4118%` (`11.548 s`) | `3.4709%` (`2.302 s`) |
| Candidate duration outside reference speech | `49.3645%` (`53.4 s`) | `47.9055%` (`58.873 s`) |
| Mostly-silence cues | `14` | `13` |
| Overlaps / invalid cues | `0` / `0` | `0` / `0` |
| Minimum-duration violations | `2` | `0` |
| CPS violations | `1` | `0` |

Reference-speech coverage and deterministic readability checks improved for this sample, but absolute cue duration outside the reference grew by 5.473 seconds to 58.873 seconds and 13 cues remained mostly over silence. The lower outside-speech ratio comes from the candidate's longer total cue duration, not less false-positive time. These figures expose the residual music hallucinations and show why the final transcript still requires review.

#### Indicative performance

| Metric | Baseline | Final |
| --- | ---: | ---: |
| Total job time | `2,420,817.29 ms` | `1,290,337.85 ms` |
| Total real-time factor | `15.059353` | `8.026898` |
| Primary inference time | `1,037,229 ms` | `721,643 ms` |
| Coverage-repair time | `1,274,655 ms` | `464,144 ms` |

The harness verified the same media, settings, browser/version, hardware-concurrency metadata, and cold model-load state. Nevertheless, these runtime numbers remain indicative because developer tests overlapped part of the baseline run. The final capture kept other workloads idle and retained Transformers.js seek-based timestamp decoding; its roughly 46.7% lower total time cannot be attributed to one change or generalized to other devices.

This benchmark supports a large text-accuracy, reference-coverage, and readability improvement for one private English fixture, with mixed cue-timing results. It does not reduce absolute false-positive cue time, does not eliminate music hallucinations, and does not establish general accuracy or performance across other speakers, languages, accents, noise conditions, models, browsers, or devices.

## 8. Memory and performance findings

### Audio, model, worker, and subtitle retention

| Data / owner | Copy or view behavior | Lifetime and release |
| --- | --- | --- |
| Original `File` on main thread | Browser file/blob handle retained by `VideoFileState`; the player object URL references the same browser-managed data. | Retained until the video is removed/replaced or the app unmounts and the object URL is revoked. |
| Provider request | Posting a `File` uses structured-clone file/blob semantics; whether backing bytes are shared is browser implementation-dependent. The provider also retains the request while the job is active. | Job request and partial arrays are cleared on settle/cancel/failure. |
| `fetchFile(file)` in transcription worker | `@ffmpeg/util` uses `FileReader.readAsArrayBuffer` and returns a `Uint8Array` view of that same new buffer; creating the view is not another full copy. | `FFmpeg.writeFile` transfers the underlying buffer to FFmpeg's nested worker, detaching it from the transcription worker. |
| FFmpeg input | The nested worker passes the transferred bytes to `ffmpeg.FS.writeFile`, which places data in FFmpeg's in-memory filesystem/WASM environment. Runtime internals may copy or map it further. | Deleted in `extractAudio`'s `finally`; the FFmpeg nested worker is then terminated. |
| WAV output in FFmpeg | Mono PCM16 WAV exists in MEMFS while the compressed input can still exist. At 16 kHz mono PCM16 it is about 32,000 bytes/s, or 115.2 MB/hour, plus a small header. | `readFile` returns a `Uint8Array` whose buffer is transferred to the transcription worker; MEMFS files are then deleted and FFmpeg terminated. |
| WAV `Uint8Array` in transcription worker | Owns the transferred output buffer. `DataView` in `decodePcmWav` is only a view. | Can remain live through PCM conversion until the function stack and references are released. |
| Decoded `Float32Array` | New full-size allocation, about 64,000 bytes/s or 230.4 MB/hour. WAV bytes and Float32 PCM overlap during decode, so their audio-only overlap is about 345.6 MB/hour before allocator overhead. | Held for the complete transcription because VAD, primary windows, and repair all reuse it. Released when the worker/job no longer references it; cancellation terminates the worker immediately. |
| VAD frames | `Uint32Array` starts, three `Float32Array` feature series plus thresholds, and `Uint8Array` speech decisions total roughly 17 bytes per 10 ms frame, about 6.1 MB/hour before array-object overhead. | Held with the job for window planning, then eligible for release after the job. This is materially smaller than object-per-frame storage. |
| Per-window audio | `audio.samples.subarray(start, end)` shares the full Float32 backing store; it is not a JS copy. Transformers.js may create feature/tensor buffers internally. | Window view is short-lived, but the full backing buffer remains because later windows/repair need it. |
| Model files and tensors | Browser cache retains downloaded files independently. A loaded pipeline holds ONNX sessions, WASM/WebGPU tensors, and runtime buffers in the reusable outer worker. | Incompatible/high-resource models are disposed, low-resource idle state is evicted after two minutes, full extraction first releases any old model, and explicit/cancel/crash cleanup terminates the worker. Actual GPU reclamation timing is runtime/browser-dependent. |
| Worker results | No audio or model buffer crosses to the main app. Partial events clone only a changed suffix; final result clones the full segment array. | Provider reconstructs a full partial snapshot for callbacks, then clears job-owned arrays at settlement. |
| Main-thread subtitles | Raw snapshot, formatted `SubtitleEntry[]`, editor state, undo history, and stable live-preview snapshots can coexist. | Governed by current React/editor lifecycle. Delta messages reduce transport but do not yet make formatting incremental. |
| Diagnostics | Sanitized text/timing/settings only; no audio, video bytes, or model weights. Maximum 1,000 events and approximately 2 MB serialized storage. | In-memory history lives for the session; local storage persists until cleared. Writes are debounced and flushed on report/pagehide. |

Regeneration uses `-ss` and `-t` to limit decoded output, but it still writes the complete compressed `File` into FFmpeg MEMFS. Range extraction therefore reduces WAV/PCM duration but is not true input streaming.

### Complexity changes

- VAD energy calculation changes from approximately `frameCount * frameSamples` sample visits to a rolling forward scan plus per-frame bookkeeping. Percentile sorting remains `O(frameCount log frameCount)`.

- Boundary selection searches only a bounded time radius and starts with a binary search into exact frame sample positions.

- Reconciliation bounds text comparison to three segments and 512 units. Exact suffix/prefix alignment uses a linear prefix function; the bounded evidence-ranking paths cannot grow with the complete video transcript.

- Coverage intersection/subtraction uses sorted merged ranges and advancing indexes instead of rescanning every cue for every region.

- Repair remains capped at 20 inference windows and cannot recurse.

- Worker delta transport avoids repeatedly cloning an unchanged prefix. It does not eliminate the worker's prefix comparison, provider snapshot reconstruction, React formatting of the accumulated result, or final full result.

- Diagnostic byte tracking is incremental and rapid persistence is coalesced, removing complete-history serialization and storage writes from every event.

### Resource lifecycle trade-off

This implementation deliberately prioritizes bounded peak memory over maximum warmth:

- FFmpeg is not retained.

- A model from a prior job is disposed before a full-file extraction, so compressed input, FFmpeg MEMFS/WASM, output WAV, decoded PCM, and an old model do not all overlap.

- Compatible low-resource state is most useful for sequential bounded regeneration. High-resource state is never kept indefinitely.

- For regeneration inputs below the provider's 256 MiB eviction guard, a compatible Tiny/Base pipeline can still overlap the compressed `File` and FFmpeg MEMFS copy. This is the explicit warmth-versus-memory trade-off; the threshold is a conservative policy guard, not a measured safe peak for every device.

- Cancellation and crashes sacrifice warmth by terminating the worker, which is the safer way to release uncertain WASM/WebGPU state and prevent stale results.

## 9. Accuracy and timing findings

### Deterministic findings

| Area | Finding | Evidence |
| --- | --- | --- |
| Word chunks | A successful `'word'` request now remains word-level for one, two, three, or more valid chunks. | Explicit mode in `timestampNormalization.ts`; short-result tests in `transcription-timestamps.test.ts`. |
| Segment chunks | One- or two-word segment text is no longer inferred to be word metadata. | Segment-mode regression test. |
| Window ownership | A chunk is owned by its absolute onset and cannot be recreated at the later core merely because it crosses a boundary. | Core-boundary timestamp tests. |
| Text without chunks | It is never assigned to silence or arbitrarily distributed across disjoint speech spans. | Silence, raw-evidence, and ambiguous-fallback tests. |
| VAD padding | Raw acoustic evidence and model-context padding are distinguishable through the final repair/refinement stages. | `SpeechRegion` fields plus raw-pause and double-padding tests. |
| Window limits | Context slices remain within 29 seconds and core ownership has no internal gap in split long speech. | Windowing tests using exact sample positions and continuous regions. |
| Repetition | Only ordered suffix/prefix text with overlapping timing evidence is removed; unique suffixes and non-overlapping intentional repetitions remain. One-word segment duplicates are removed only when their segment times overlap. | Multi-segment, one-word, reordered-text, stutter/repetition, no-whitespace, and timestamp-conflict cases. |
| Coverage | A long low-confidence or mostly-silence cue cannot hide raw detected speech; reliable word ranges are preferred. | Coverage tests for low confidence, text representation, long word spans, and silence overlap. |
| Cue boundaries | Word evidence controls content timing, VAD is secondary, and final adjacency is millisecond-stable. | Word/VAD conflict, correct timing, rapid dialogue, and overlap tests. |
| Formatting | Readability splitting does not silently lose queued text, low-confidence fallback does not gain silence, word-timed CJK punctuation is retained, and long no-whitespace segment text has a punctuation-preferred grapheme-cluster fallback. | Subtitle utility regressions and export tests. |

### Expected VAD behavior by condition

This table documents expected algorithm behavior, not measured recognition quality.

| Condition | Expected current behavior | Remaining risk |
| --- | --- | --- |
| Quiet speech | Hysteresis helps retain a quieter trailing phoneme once speech is active; the adaptive floor can recover as quiet observations accumulate. | Speech below the minimum RMS floor or after sustained loud noise can still be missed. |
| Loud background music | Sustained high RMS is likely to be treated as active. Text-only fallback still requires localized speech evidence, and repair is bounded. | RMS alone cannot distinguish music from repeated dialogue, so uncertain recognized text is retained; the Matrix fixture produced music-related insertions. |
| Constant fan / air-conditioner | The local floor can adapt upward and stop classifying a stable source as new speech. | Strong modulation or a floor clamped by the current thresholds can remain active. |
| Sudden sound effect | One isolated active frame is smoothed out and a run shorter than 250 ms is rejected. | Longer effects can be treated as speech. |
| Clipped audio | Finite samples produce high RMS and likely continuous activity. | No clipping detector or restoration exists; ASR quality can be poor. |
| Gradually changing noise floor | Bounded local adaptation follows quiet observations instead of using one immutable threshold for the file. | Tuning rate and cap still need varied real recordings. |
| Multiple speakers at different volumes | The off threshold helps continuity within an active turn. Separate islands can adapt independently over time. | A much quieter speaker can remain below threshold, especially after a loud speaker/noise source. |
| Long pauses | Raw pauses longer than the 350 ms merge gap remain available; model-context padding is stored separately. | Pauses at or below the configured merge gap intentionally become one raw region. |
| Breathing / mouth noise | Very short isolated events are suppressed. | Longer or loud breathing can pass an RMS-only classifier. |
| Speech at time zero | Raw onset clamps to zero; pre-padding does not produce a negative time. | First phonemes below threshold can still be lost. |
| Delayed audio track | FFmpeg's `aresample=async=1:first_pts=0` and absolute window offsets retain a zero-based timeline including delay. | Only argument construction is deterministic-tested; container-specific behavior needs browser media fixtures. |

### Subtitle segmentation findings

`formatTranscriptionSegments` still enforces maximum line/subtitle length, duration, CPS, non-overlap, and balanced line scoring. It prefers punctuation and natural phrase boundaries and uses actual word boundaries when word timing exists. A measured pause of at least 350 ms is a preferred split and is protected from later merging/gap closing; punctuation with about 200 ms of pause is secondary evidence. Small dependency-free penalties discourage one-word sides and splitting articles from nouns, prepositions from objects, auxiliaries from verbs, numbers from units, and obvious name-like sequences. A pause of at least 750 ms can justify a naturally isolated one-word phrase.

Formatting may apply the explicitly configured 80 ms display lead-in before a first word and 180 ms tail after a last word; it does not alter the stored word evidence or apply VAD context padding again. It will accept less than the configured 80 ms inter-cue display gap for rapid dialogue rather than trim spoken-word evidence. After overlap normalization, a second segment-only smoothing pass can merge a newly squeezed micro-cue only when no meaningful boundary is lost and combined duration, text length, and CPS stay valid. No speaker diarization is present, so speaker changes cannot be a segmentation signal.

## 10. Remaining limitations

1. No real FFmpeg-plus-Whisper browser job runs in Vitest. The optional Playwright capture command can exercise that path locally, but model download, ONNX execution, FFmpeg worker memory, browser codecs, WebGPU behavior, and end-to-end cancellation are not normal CI coverage.

2. The follow-up has one private English Matrix benchmark. It showed large text/reference-coverage gains and mixed timing, while absolute false-positive cue time increased. Baseline runtime was confounded by overlapping tests. One fixture is not evidence for other languages, speakers, audio conditions, models, browsers, or devices.

3. The complete compressed media is still loaded into FFmpeg's in-memory filesystem. Full decoded PCM remains resident for the complete transcription and bounded repair pass. During compatible regeneration below the 256 MiB input guard, a warm Tiny/Base pipeline can overlap that compressed-input/MEMFS allocation. This is not streaming, and the fixed guard still needs device profiling.

4. Audio-only PCM conversion can temporarily require roughly 345.6 MB per hour for WAV plus Float32 data, before FFmpeg, input media, model, tensor, VAD, browser, and app overhead.

5. RMS VAD cannot reliably distinguish speech from music, long effects, or all environmental noise. A destructive repetition heuristic was rejected because it could erase legitimate dialogue; music hallucinations therefore remain possible. Missed VAD speech cannot be found by coverage repair.

6. Automatic language detection is not implemented. Legacy auto settings deliberately fall back to English, and users must select a known non-English language.

7. No safe model confidence, no-speech probability, average log probability, or compression ratio is exposed by the current integration. The `0.35` text-fallback confidence is an algorithmic marker, not a calibrated Whisper probability.

8. Coverage repair is deliberately one pass and 20 ranges. It can leave difficult or very fragmented audio unresolved rather than risking an infinite loop.

9. Character-based reconciliation covers common no-whitespace scripts, and segment-timestamp formatting preserves grapheme clusters at generic punctuation/length boundaries. Language-specific tokenization and phrase segmentation are still incomplete, so the chosen breaks may be unnatural for Thai, Khmer, Lao, Myanmar, or mixed-script text.

10. The application has no diarization or reliable speaker-change signal. Overlapping speakers and very rapid turn-taking remain difficult for both Whisper and subtitle segmentation.

11. Delta transport does not make the full UI path incremental. Provider snapshots, formatting, editor reconciliation, and React state can still copy accumulated arrays.

12. Warm model behavior and cleanup are best-effort abstractions over browser runtimes. `dispose()` and worker termination do not provide a portable synchronous proof that GPU/process memory has been returned to the OS.

13. Approximate JSON byte counts are not structured-clone wire sizes, and sampled JS heap is not total browser memory.

14. The app's current RTF denominator is video metadata duration. It may differ from decoded PCM duration for unusual tracks, and the benchmark must state which denominator it uses.

15. The benchmark's deterministic cue matching is bounded and cannot perfectly compare radically different segmentations. Human-checked reference timing and match coverage must accompany any interpretation.

16. Browser-native media support differs across Chrome, Edge, Firefox, and Safari. FFmpeg preserves broad container support, but available memory, WebGPU, cross-origin isolation, and model execution still vary by browser/device.

17. Generated subtitles always require human review. When transcription fails or timing evidence is ambiguous, the implementation prefers an explicit failure, empty result, or bounded retry over fabricated captions.

18. Files with several audio streams use the first stream. There is no UI track selector, and an intended secondary language/commentary track must be remuxed first.

19. Segment-only timestamps cannot reveal pauses inside one broad ASR segment. Punctuation/proportional timing remains a fallback rather than acoustic alignment.

20. Whisper's timestamp seek loop can still take substantial time on noisy or difficult windows. The app does not impose a generic token cap because doing so bypasses that continuation path in the installed library.

## 11. Recommended future work

Recommendations are ordered to preserve the audit's measurement-first, isolated-change strategy.

1. **Build a legally usable local benchmark suite.** Include clean studio speech, quiet speech, loud music under speech, stationary and changing fan noise, effects, clipped audio, multiple speakers, long pauses, immediate and delayed starts, overlapping dialogue, at least one no-whitespace language, and files from each supported container. Record cold and warm runs separately and repeat performance runs.

2. **Publish controlled Base-versus-Tiny profile evidence.** Measure WER/CER, timestamp error, total RTF, failures, and memory on a low-resource WASM device and two WebGPU classes. Use the results to decide whether Fast/Balanced/Accurate should bundle provider, dtype, timestamp, VAD, and window settings rather than only model labels.

3. **Tune the current VAD with real frame references before adding features.** Export bounded threshold/activity summaries, not samples. Evaluate false-positive and false-negative duration. Only then compare an enhanced local mode using spectral flux/zero-crossing features or a small licensed neural VAD, including download/startup/memory/fallback costs.

4. **Add a verified representative-audio language strategy.** If a future Transformers.js/runtime version exposes Whisper language detection, detect once from bounded representative raw-speech spans, report confidence, reuse the result across windows, and retain explicit user override. Do not reintroduce a silent auto claim.

5. **Prototype optional lower-memory extraction behind FFmpeg fallback.** Candidate approaches include chunked FFmpeg input when supported or browser-native decode for verified codecs. Measure peak allocation and delayed-track correctness before changing the default. Raw PCM alone is not sufficient.

6. **Make main-thread formatting incremental.** Use the worker delta's stable prefix to format only the changed boundary suffix, while retaining a periodic/full final validation pass. Benchmark editor edit preservation, message bytes, formatting time, and retained arrays on multi-hour synthetic subtitle streams.

7. **Refine segment-mode no-whitespace splitting.** Build on the grapheme-safe `findUnbrokenTextSplit` with optional lightweight script-specific sentence cues. Expand the combining-mark regression beyond Thai to Khmer, Lao, Myanmar, emoji/ZWJ, and mixed-script long segments while preserving exact text, timing, CPS, and line limits.

8. **Extend optional local browser capture into a sustainable integration suite.** Keep a tiny redistributable generated-tone/synthetic-speech fixture only if licensing permits, or retain the ignored Playwright fixture protocol. Test FFmpeg extraction, worker startup/crash/cancel, model cache cold/warm labeling, and output schema without making CI download large models by default.

9. **Expand diagnostics only where actionable.** Record the selected boundary reason and aggregate VAD threshold/activity percentiles, plus repair outcome categories. Continue bounding all data and never serialize PCM, media bytes, weights, or unlimited transcript text.

10. **Evaluate decoding controls through the harness.** Test supported generic penalties and sampling only on a fixture set containing legitimate repetitions and stutters. Adopt a control only if duplicate/hallucination metrics improve without increasing WER/CER or deletion of reference repetitions.

11. **Calibrate evidence quality if the runtime exposes it.** If future model output provides documented no-speech or token confidence values, thread them through `RawTranscriptionSegment`, reconciliation, coverage, repair, and diagnostics with deterministic thresholds and backward-compatible project serialization.

12. **Keep architecture changes separate.** A streaming decoder, neural VAD, runtime upgrade, and profile redesign should not land as one change. Benchmark and regression-test each layer so a quality or compatibility regression can be attributed and reverted safely.
