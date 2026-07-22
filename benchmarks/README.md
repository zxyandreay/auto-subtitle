# Local transcription benchmark

This directory contains a deterministic scorer for local Auto Subtitle runs. It does not include media, reference transcripts, model files, or measured accuracy/performance results. Put only material you are legally allowed to use under `fixtures.local/`; that directory and generated `results/` are gitignored except for their `.gitkeep` files.

The benchmark tooling has three separate jobs:

1. Optionally capture one unedited run through the real browser app.
2. Score a captured transcription against local references.
3. Compare two reports made from the same references without calling either one an improvement.

The deterministic scorer does not run Whisper itself. The optional Playwright capture command drives the actual local app in an installed Chrome or Edge browser, while the scorer remains a separate reproducible step. Neither tool copies media or references into the repository, and no paid or cloud transcription service is used.

## Directory layout

```text
benchmarks/
  README.md
  fixtures.local/             local media, references, project exports, telemetry
    .gitkeep
  manifests/
    example.json              committed schema example; placeholder files are intentionally absent
    baseline.local.json       suggested ignored run descriptor
    candidate.local.json      suggested ignored run descriptor
  results/
    .gitkeep
    baseline.json             generated and ignored
    candidate.json            generated and ignored
    comparison.json           generated and ignored
```

Paths inside a manifest are relative to that manifest. Paths inside a run descriptor are relative to that run descriptor. The scorer streams each media file through SHA-256 so reports cannot silently compare different media with the same name. Set `mediaSha256` in the manifest when you also want the scorer to verify a known hash.

## Validate the scorer

Run the deterministic synthetic self-test before collecting real results:

```bash
npm run benchmark:self-test
```

The output says `status: "passed"` when WER/CER operation accounting and suite filtering, timing statistics, bounded cue matching, invalid/overlap checks, missing-stage handling, real-time factor, message telemetry, settings-source checks, and comparison direction behave as expected. Its values are synthetic test inputs, not product benchmark numbers.

The multiline commands below use Bash continuations. PowerShell equivalents are provided as single-line `npm.cmd` commands, which also avoid systems that block `npm.ps1`.

## Prepare local references

Copy `manifests/example.json` to a name ending in `.local.json`, then replace every placeholder path. A manifest has this shape:

```ts
type BenchmarkManifest = {
  schemaVersion: 1
  name: string
  description?: string
  cases: Array<{
    id: string                         // unique within the suite
    media: string                     // required local media path
    mediaSha256?: string              // optional lowercase/uppercase SHA-256
    durationSeconds?: number          // fallback when telemetry omits audio duration
    language: string                  // BCP-47 code is recommended, for example en or zh
    textMetric?: 'wer' | 'cer' | 'both'
    normalization?: {
      unicodeForm?: 'NFC' | 'NFD' | 'NFKC' | 'NFKD'
      lowercase?: boolean
      stripPunctuation?: boolean
      collapseWhitespace?: boolean
      cerIgnoreWhitespace?: boolean
    }
    constraints?: {
      maxCps?: number
      maxLineLength?: number
      maximumLines?: number
      minimumSpeechOverlapRatio?: number // 0..1; default 0.5
    }
    settings?: Record<string, unknown> // frozen settings snapshot used for comparability checks
    reference: {
      transcriptFile?: string
      wordsFile?: string
      subtitlesFile?: string
      speechIntervalsFile?: string
    }
  }>
}
```

At least one reference file is required. Supplying all four enables all deterministic accuracy/timing metrics:

- `transcriptFile`: UTF-8 plain text.
- `wordsFile`: JSON array, or `{ "words": [...] }`, of `{ text, startTime, endTime }` entries in seconds.
- `subtitlesFile`: SRT, VTT, a JSON subtitle array, or an Auto Subtitle project-like `{ "subtitles": [...] }` object.
- `speechIntervalsFile`: JSON array, or `{ "intervals": [...] }`, of `{ startTime, endTime }` ground-truth speech intervals in seconds.

If explicit speech intervals are absent, the scorer derives them from timed reference words and then from reference cues. Explicit human-checked speech intervals are preferable for missed-speech and silence-placement measurements.

Reference timing must satisfy `0 <= startTime < endTime`. Candidate cue intervals may be reversed or negative so the scorer can count them as invalid, but their fields must still be finite JSON numbers.

## Capture a browser run

Use the same media, browser version, hardware, model, language, provider, precision, timestamp mode, VAD settings, window settings, and formatting settings for a controlled before/after comparison.

### Automated local capture

Start the app with `local-launch.bat`, then run the optional Playwright capture command. It requires an installed Chrome or Edge browser and uses a headed browser because WebGPU availability and performance can differ in headless mode.

```bash
npm run benchmark:capture -- \
  --video benchmarks/fixtures.local/example.mp4 \
  --out-dir benchmarks/fixtures.local/captures/baseline \
  --case-id example-english \
  --language english \
  --model onnx-community/whisper-base \
  --provider wasm \
  --dtype q8 \
  --word-timestamps
```

PowerShell:

```powershell
npm.cmd run benchmark:capture -- --video benchmarks/fixtures.local/example.mp4 --out-dir benchmarks/fixtures.local/captures/baseline --case-id example-english --language english --model onnx-community/whisper-base --provider wasm --dtype q8 --word-timestamps
```

Run `npm run benchmark:capture -- --help` for the complete setting list, including formatting, timeout, browser channel, and profile options. Run `npm run benchmark:capture -- --self-test` to validate the diagnostic-to-telemetry mapping without opening a browser.

The command:

- accepts only a loopback app URL, selects the local video through the app, and never modifies or copies the video or any reference file;
- uses a dedicated persistent profile under `.cache/` by default, or `--profile <path>`, so browser model caches survive between captures;
- clears only `auto-subtitle-diagnostics-v1` before the measured run; it does not clear Cache Storage, IndexedDB, or the browser profile;
- runs the app's full local pipeline, downloads the project and diagnostic exports, and validates that both describe the same frozen settings;
- maps one complete diagnostic job into validated telemetry and writes a one-case local run descriptor; and
- refuses to start when any planned artifact exists unless `--overwrite` is explicit.

The output directory receives `<case-id>.auto-subtitle.json`, `<case-id>.diagnostics.json`, `<case-id>.telemetry.json`, and `<case-id>.run.local.json`. Keep the output under `benchmarks/fixtures.local/` so it stays ignored. The generated run descriptor points only to the project and telemetry beside it; it does not contain or alter reference paths.

The profile preserves downloaded browser data, but `modelLoadState` is copied only from the worker's measured `cold`/`warm` diagnostic. Do not relabel a run based merely on whether network downloads appeared. Use a fresh dedicated profile when you intentionally need an empty browser cache, and record that protocol alongside results.

### Manual capture

1. Start the app with `local-launch.bat`.
2. Decide whether the run is cold or warm. For a cold run, clear the selected model from browser storage/cache first. For a warm run, load it once before starting the measured run. Record the choice as telemetry rather than guessing it later.
3. Transcribe each local fixture without editing the generated text or timing.
4. Export an Auto Subtitle project JSON. It preserves cue and word timing when available.
5. Export the debug log for evidence. Copy only actually measured stage, memory, and worker-message values into a telemetry JSON file. Omit unavailable fields; never estimate them from progress percentages.
6. Create an ignored run descriptor such as `benchmarks/manifests/baseline.local.json`.

A run descriptor can point directly at an Auto Subtitle project plus optional telemetry:

```json
{
  "schemaVersion": 1,
  "label": "baseline",
  "notes": "Describe the commit and whether model cache state was controlled.",
  "environment": {
    "browser": "record the exact browser and version",
    "platform": "record the OS and architecture",
    "hardware": "record the CPU/GPU or device label",
    "hardwareConcurrency": "record navigator.hardwareConcurrency",
    "crossOriginIsolated": "record true or false"
  },
  "cases": [
    {
      "id": "example-english",
      "project": "../fixtures.local/example.baseline.auto-subtitle.json",
      "telemetry": "../fixtures.local/example.baseline.telemetry.json",
      "settings": {
        "language": "english",
        "task": "transcribe",
        "modelId": "onnx-community/whisper-base",
        "executionProvider": "wasm",
        "dtype": "q8",
        "useWordTimestamps": true
      }
    }
  ]
}
```

Environment values may be strings, numbers, or booleans. Use actual values rather than the descriptive placeholders above. A settings object in the run should exactly match the settings object frozen in the manifest; a mismatch is reported as a comparability warning. When a result artifact or Auto Subtitle project also records settings, every descriptor setting must agree with the artifact. For project exports, the harness maps `formatting.useWordTimestamps` to the descriptor's flattened `useWordTimestamps` field. Conflicting sources are reported and make performance comparison uncontrolled.

Alternatively, `result` can point to a purpose-built result artifact instead of `project`. Exactly one of `project` or `result` is required per case.

## Case-result schema

A purpose-built result artifact has this exact supported shape. `transcript`, `subtitles`, and `words` are optional individually, but at least one is required.

```ts
type BenchmarkCaseResult = {
  schemaVersion: 1
  caseId: string
  transcript?: string
  subtitles?: Array<{
    text: string
    startTime: number
    endTime: number
    confidence?: number
    words?: Array<{
      text: string
      startTime: number
      endTime: number
    }>
  }>
  words?: Array<{
    text: string
    startTime: number
    endTime: number
  }>
  metadata?: {
    source?: string
    settings?: Record<string, unknown>
    [key: string]: unknown
  }
  telemetry?: BenchmarkTelemetry
}
```

When `transcript` is absent, cue or word text is joined chronologically. When top-level `words` is absent, word timing is collected from subtitle `words` arrays.

## Telemetry schema

Telemetry is optional and must contain measurements collected by the browser/worker instrumentation. The scorer does not invent missing values or derive stage duration from UI progress percentages.

```ts
type BenchmarkTelemetry = {
  audioDurationSeconds?: number
  totalProcessingMs?: number
  modelLoadState?: 'cold' | 'warm' | 'unknown'
  stageDurationsMs?: {
    audioExtraction?: number
    modelLoading?: number
    vadAnalysis?: number
    windowPlanning?: number
    inference?: number
    coverageRepair?: number
    timingRefinement?: number
    formatting?: number
    [stageName: string]: number | undefined
  }
  memory?: {
    peakBytes: number
    method: string
    approximate?: boolean
  }
  workerMessages?: {
    count: number
    totalBytes: number
    sizeMethod?: string
    byType?: Record<string, {
      count: number
      bytes: number
    }>
  }
}
```

Use `performance.measureUserAgentSpecificMemory()` only when the browser exposes it and record that method. `performance.memory.usedJSHeapSize` is a Chromium-specific fallback. Both are approximations for this app: they may omit or differently attribute WebGPU allocations, model buffers, WASM linear memory, browser media buffers, and shared backing stores. Keep `approximate: true` unless the measurement method is known to cover the relevant allocations.

Worker-message bytes should be measured where messages cross the worker/provider boundary. JSON UTF-8 length is an acceptable approximation for the current plain-object result messages when labeled `json-utf8-approximation`; it is not the structured-clone wire size. Do not serialize audio or model buffers merely to measure message size.

### Map current diagnostics into telemetry

The automated capture command enforces the mapping below for one complete, unedited job and rejects missing, duplicate, truncated, or invalid diagnostic evidence. For a manual capture, copy only the mapped measurements; do not paste a diagnostic `data` object unchanged because its field names are not the benchmark schema.

| Diagnostic event | Diagnostic field | Telemetry field | Notes |
| --- | --- | --- | --- |
| App `transcription-completed` | `data.totalDurationMs` | `totalProcessingMs` | Preferred total: it includes worker execution and final main-thread formatting. Worker `job-performance.data.totalDurationMs` is worker-only. |
| App `transcription-completed` | `data.audioDurationSeconds` | `audioDurationSeconds` | Omit when duration was unavailable. |
| Worker `job-performance` | `data.modelLoad` | `modelLoadState` | Values are already `cold` or `warm`. |
| Worker `job-performance` | `data.stageDurationsMs["extracting-audio"]` | `stageDurationsMs.audioExtraction` | Includes FFmpeg initialization and local extraction. |
| Worker `job-performance` | `data.stageDurationsMs["downloading-model"]` | `stageDurationsMs.modelLoading` | Covers cache/model pipeline loading; the label also applies to a warm lookup. |
| Worker `job-performance` | `data.stageDurationsMs["analyzing-speech"]` | `stageDurationsMs.vadAnalysis` | Local VAD analysis. |
| Worker `job-performance` | `data.stageDurationsMs["planning-windows"]` | `stageDurationsMs.windowPlanning` | Speech-aware or fallback window planning. |
| Worker `job-performance` | `data.stageDurationsMs.transcribing` | `stageDurationsMs.inference` | Includes ASR calls plus bounded reconciliation/diagnostic overhead between worker stage transitions. |
| Worker `job-performance` | `data.stageDurationsMs["checking-coverage"]` | `stageDurationsMs.coverageCheck` | Optional additional stage. |
| Worker `job-performance` | `data.stageDurationsMs["repairing-coverage"]` | `stageDurationsMs.coverageRepair` | Present only when repair work ran. |
| Worker `job-performance` | `data.stageDurationsMs["refining-timing"]` | `stageDurationsMs.timingRefinement` | Final worker timing refinement. |
| App `formatted-transcription-preview` and `formatted-transcription` | `data.formattingDurationMs` | `stageDurationsMs.formatting` | Sum every preview duration plus the final duration for total main-thread formatting work. If bounded diagnostic retention omitted any preview event, omit this stage rather than reporting a partial sum. Do not use the worker `formatting-subtitles` stage: it is an orchestration boundary and may include model disposal. |
| App `worker-message-metrics` | `data.messageCount` | `workerMessages.count` | Counts all worker-to-main events observed by the provider. |
| App `worker-message-metrics` | `data.approximateJsonBytes` | `workerMessages.totalBytes` | Set `sizeMethod` to `json-utf8-approximation`. |
| App `worker-message-metrics` | `data.messageCountsByType` plus `data.approximateJsonBytesByType` | `workerMessages.byType` | For each event type, combine the count and byte values into `{ "count": ..., "bytes": ... }`. |

For sampled Chromium heap diagnostics, use the maximum observed `approximateJsHeapBytes` from the same job as `memory.peakBytes`, set `memory.method` to `performance.memory.usedJSHeapSize-sampled`, and keep `memory.approximate: true`. This is a sampled JS-heap high-water mark, not total browser, WASM, GPU, or process memory.

## Score a run

```bash
npm run benchmark -- \
  --manifest benchmarks/manifests/example.local.json \
  --run benchmarks/manifests/baseline.local.json \
  --out benchmarks/results/baseline.json
```

PowerShell:

```powershell
npm.cmd run benchmark -- --manifest benchmarks/manifests/example.local.json --run benchmarks/manifests/baseline.local.json --out benchmarks/results/baseline.json
```

The command validates every schema, verifies and hashes the local media, loads references/results, prints a JSON report to stdout, and writes the same report to `--out` when supplied. The committed `example.json` intentionally fails until its placeholder files are supplied.

For scoring an already captured artifact after media was intentionally moved away, add `--allow-missing-media`. The report records a null media hash and warns that media identity was not verified; do not use such a report as a controlled before/after comparison.

## Metrics

All text normalization is explicit in the manifest and deterministic. Defaults are NFKC, lowercase, punctuation/symbol removal, collapsed whitespace, and ignored whitespace for CER.

| Metric | Definition |
| --- | --- |
| WER | Word-token Levenshtein substitutions + deletions + insertions divided by reference word count. Operation counts, denominators, and a bounded readable difference list are included. Empty-reference rate is `null`. |
| CER | Unicode-code-point Levenshtein distance divided by reference character count. It uses code points, not runtime-dependent grapheme segmentation, and is used for readable differences when CER is the case's primary metric. Empty-reference rate is `null`. |
| Normalized similarity | `1 - character edit distance / max(reference length, candidate length)` after configured normalization. |
| Word start/end error | Exact normalized words are matched through deterministic monotonic edit alignment. Per-case output reports mean, median, and maximum absolute error, mean signed error, match coverage, and counts within 250 ms, 500 ms, and 1 second. |
| Cue onset/offset error | Reference and candidate cues are matched monotonically using normalized multiset Dice text similarity. Matches below 0.25 are omitted. Per-case output reports mean, median, and maximum absolute error, signed error, tolerance counts, and a bounded cue-difference list. Dense alignment is capped at 1,000,000 matrix cells; larger cases report `available: false` with counts and a reason instead of risking an out-of-memory failure. |
| Missed speech | Duration of unioned reference speech intervals not covered by valid candidate cue intervals. |
| Silence placement | Duration of unioned candidate cues outside reference speech, plus cue count below the configured speech-overlap ratio. Lead/tail display padding therefore remains visible in this metric. |
| Duplicate unit rate | Adjacent duplicate words for WER cases or characters for CER cases. `excess` variants subtract the same aggregate duplicate count found in the reference to reduce penalties for legitimate repetition. Suite summaries keep word and character units separate. |
| Duplicate phrase rate | Tokens in the second copy of an immediately repeated 2-5 word phrase, or 2-8 character phrase for CER. Raw and reference-discounted counts/rates are reported. |
| Subtitle overlap | Count and summed duration of every overlapping valid cue pair after chronological sorting. |
| Invalid timestamps | Cue and word counts with negative, zero/reversed duration. Non-numeric values fail schema validation. |
| Cue duration/gaps | Minimum, maximum, mean, and median valid cue duration; inter-cue gap distribution; and optional minimum/maximum duration violations from manifest constraints. |
| CPS violations | Valid cues whose non-whitespace Unicode code-point count divided by duration exceeds `maxCps`. |
| Line violations | Lines longer than `maxLineLength`, affected caption count, and captions exceeding `maximumLines`. |
| Stage/total time | Supplied measured milliseconds; per-case stage keys are preserved. Suite stage summaries report measured and missing case counts, a measured subtotal, and a complete `totalMs` only when every suite case supplied that stage. |
| Real-time factor | `totalProcessingMs / 1000 / audioDurationSeconds`. Inference RTF is also emitted when the `inference` stage exists. |
| Memory/messages | Supplied peak memory method/value and worker message count/bytes/by-type values. Missing values stay `null`. |

Word and cue medians are per case. Suite WER includes only `wer`/`both` cases, suite CER includes only `cer`/`both` cases, and duplicate rates are split into word and character summaries. Other suite summaries aggregate compatible duration totals, violation counts, message totals, and weighted mean timing errors; they do not fabricate a median from per-case medians or treat missing stage measurements as zero.

Each suite-level stage value has the shape `{ totalMs, measuredTotalMs, measuredCaseCount, missingCaseCount, totalCaseCount }`. `measuredTotalMs` is explicitly a subtotal of available measurements; `totalMs` is `null` unless `missingCaseCount` is zero.

## Compare baseline and candidate

Create a second captured run with the same manifest and references, then score and compare:

```bash
npm run benchmark -- \
  --manifest benchmarks/manifests/example.local.json \
  --run benchmarks/manifests/candidate.local.json \
  --out benchmarks/results/candidate.json

npm run benchmark:compare -- \
  --baseline benchmarks/results/baseline.json \
  --candidate benchmarks/results/candidate.json \
  --out benchmarks/results/comparison.json
```

PowerShell:

```powershell
npm.cmd run benchmark -- --manifest benchmarks/manifests/example.local.json --run benchmarks/manifests/candidate.local.json --out benchmarks/results/candidate.json
npm.cmd run benchmark:compare -- --baseline benchmarks/results/baseline.json --candidate benchmarks/results/candidate.json --out benchmarks/results/comparison.json
```

Comparison requires the same suite fingerprint, case ids, and per-case reference fingerprints. It records missing or different environments rather than treating two empty environment objects as a controlled match. A descriptor/artifact settings conflict also makes `performanceControlled` false. Numeric values are emitted as:

```ts
type NumericDelta = {
  baseline: number
  candidate: number
  candidateMinusBaseline: number
  relativePercent: number | null
}
```

The comparison deliberately does not label a delta as improved or regressed. For example, lower WER is generally desirable, while higher normalized similarity is generally desirable; whether a difference is meaningful still depends on fixture coverage, environment control, and repeated real-media runs. Timing and memory deltas are marked uncontrolled when environment or settings differ.

## Report schema

`run` produces this top-level JSON shape without embedding reference or recognized transcript text:

```ts
type BenchmarkReport = {
  schemaVersion: 1
  kind: 'auto-subtitle-benchmark-report'
  generatedAt: string
  manifest: {
    name: string
    description?: string
    path: string
    schemaVersion: 1
    suiteFingerprint: string
  }
  run: {
    label: string
    notes?: string
    path: string
    environment: Record<string, unknown>
    environmentFingerprint: string
  }
  cases: Array<{
    id: string
    referenceFingerprint: string
    media: {
      fileName: string
      missing: boolean
      sizeBytes: number | null
      sha256: string | null
    }
    settings: Record<string, unknown> | null
    settingsSourcesMatch: boolean
    metrics: Record<string, unknown>
  }>
  summary: Record<string, unknown>
  warnings: string[]
  interpretation: string
}
```

The output path, local project/result paths, reference contents, media bytes, audio samples, and model data are not copied into the report.

## Limitations

- A single fixture or run is not evidence of a general accuracy or performance improvement. Use varied speech, noise, music, silence, speakers, languages, and durations, and repeat timing runs.
- WER/CER normalization can materially change scores. Keep it frozen between reports and publish it alongside any result.
- Cue alignment is deterministic but cannot perfectly resolve radically different segmentation. Inspect matched cue counts and match ratios before interpreting onset/offset errors.
- Cue alignment above the documented matrix-cell cap is explicitly unavailable. Split very long fixtures into stable, non-overlapping cases if cue timing is required, while keeping whole-file text and performance runs separate.
- Reference cue timing and speech intervals must be human-checked; VAD output is not ground truth for evaluating the same VAD.
- Browser memory APIs are incomplete. Treat memory output as an observed approximation, not total process or GPU memory.
- Cold and warm model timings answer different questions. Do not average them together without labeling the mix.
- The harness does not upload media and does not automate model downloads. Network/cache behavior remains part of the captured browser run, not the deterministic scorer.
