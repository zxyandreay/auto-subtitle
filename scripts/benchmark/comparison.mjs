import { BenchmarkInputError, stableStringify } from './io.mjs'

export function compareBenchmarkReports(baseline, candidate) {
  if (baseline.manifest.suiteFingerprint !== candidate.manifest.suiteFingerprint) {
    throw new BenchmarkInputError(
      'Baseline and candidate reports use different manifest/reference fingerprints. Re-run both with the same manifest and local fixtures.',
    )
  }

  const baselineCases = new Map(baseline.cases.map((item) => [item.id, item]))
  const candidateCases = new Map(candidate.cases.map((item) => [item.id, item]))
  const baselineIds = [...baselineCases.keys()].sort()
  const candidateIds = [...candidateCases.keys()].sort()
  if (stableStringify(baselineIds) !== stableStringify(candidateIds)) {
    throw new BenchmarkInputError('Baseline and candidate reports do not contain the same case ids.')
  }

  const warnings = []
  const baselineEnvironment = baseline.run.environment ?? {}
  const candidateEnvironment = candidate.run.environment ?? {}
  const environmentRecorded = hasRecordedEnvironment(baselineEnvironment)
    && hasRecordedEnvironment(candidateEnvironment)
  const sameEnvironment = environmentRecorded
    && stableStringify(baselineEnvironment) === stableStringify(candidateEnvironment)
  if (!environmentRecorded) {
    warnings.push('One or both runs omit environment details; timing and memory deltas are not controlled comparisons.')
  } else if (!sameEnvironment) {
    warnings.push('Run environments differ. Accuracy deltas remain descriptive, but timing and memory deltas are not controlled comparisons.')
  }

  let sameSettings = true
  let settingsSourcesMatch = true
  let settingsRecorded = true
  let mediaVerified = true
  let modelLoadStateControlled = true
  const cases = baselineIds.map((id) => {
    const baselineCase = baselineCases.get(id)
    const candidateCase = candidateCases.get(id)
    if (baselineCase.referenceFingerprint !== candidateCase.referenceFingerprint) {
      throw new BenchmarkInputError(`Case ${id} uses different reference fingerprints.`)
    }
    const settingsMatch = stableStringify(baselineCase.settings ?? null) === stableStringify(candidateCase.settings ?? null)
    if (baselineCase.settings === null || candidateCase.settings === null) {
      settingsRecorded = false
    }
    if (!settingsMatch) {
      sameSettings = false
      warnings.push(`Case ${id} used different transcription settings; deltas are confounded by the settings change.`)
    }
    const caseSettingsSourcesMatch = baselineCase.settingsSourcesMatch !== false
      && candidateCase.settingsSourcesMatch !== false
    if (!caseSettingsSourcesMatch) {
      settingsSourcesMatch = false
      warnings.push(`Case ${id} has conflicting descriptor and artifact settings in at least one report.`)
    }
    if (
      baselineCase.media?.missing
      || candidateCase.media?.missing
      || !baselineCase.media?.sha256
      || !candidateCase.media?.sha256
    ) {
      mediaVerified = false
    }
    const baselineLoadState = baselineCase.metrics.performance?.modelLoadState ?? 'unknown'
    const candidateLoadState = candidateCase.metrics.performance?.modelLoadState ?? 'unknown'
    if (
      baselineLoadState === 'unknown'
      || candidateLoadState === 'unknown'
      || baselineLoadState !== candidateLoadState
    ) {
      modelLoadStateControlled = false
    }
    return {
      id,
      referenceFingerprint: baselineCase.referenceFingerprint,
      settingsMatch,
      settingsSourcesMatch: caseSettingsSourcesMatch,
      numericDeltas: numericDeltas(baselineCase.metrics, candidateCase.metrics),
      changedValues: changedValues(baselineCase.metrics, candidateCase.metrics),
    }
  })

  if (!settingsRecorded) {
    warnings.push('One or more cases omit a settings snapshot; performance comparability cannot be confirmed.')
  }
  if (!mediaVerified) {
    warnings.push('One or more reports were scored without a verified media SHA-256.')
  }
  if (!modelLoadStateControlled) {
    warnings.push('Cold/warm model-load state is missing or differs for one or more cases.')
  }

  return {
    schemaVersion: 1,
    kind: 'auto-subtitle-benchmark-comparison',
    generatedAt: new Date().toISOString(),
    manifest: baseline.manifest,
    baseline: {
      label: baseline.run.label,
      environment: baseline.run.environment ?? {},
    },
    candidate: {
      label: candidate.run.label,
      environment: candidate.run.environment ?? {},
    },
    comparability: {
      referencesMatch: true,
      caseSetsMatch: true,
      settingsMatch: sameSettings,
      settingsSourcesMatch,
      settingsRecorded,
      mediaVerified,
      modelLoadStateControlled,
      environmentRecorded,
      environmentMatch: sameEnvironment,
      performanceControlled: sameEnvironment
        && sameSettings
        && settingsSourcesMatch
        && settingsRecorded
        && mediaVerified
        && modelLoadStateControlled,
      note: 'Deltas are candidate minus baseline. The harness reports differences and does not label them as improvements.',
    },
    summaryNumericDeltas: numericDeltas(baseline.summary, candidate.summary),
    summaryChangedValues: changedValues(baseline.summary, candidate.summary),
    cases,
    warnings,
  }
}

function hasRecordedEnvironment(value) {
  return isRecord(value) && Object.keys(value).length > 0
}

function numericDeltas(baseline, candidate, prefix = '') {
  const output = {}
  if (!isRecord(baseline) || !isRecord(candidate)) {
    return output
  }
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort()
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key
    const baselineValue = baseline[key]
    const candidateValue = candidate[key]
    if (finiteNumber(baselineValue) && finiteNumber(candidateValue)) {
      output[path] = {
        baseline: baselineValue,
        candidate: candidateValue,
        candidateMinusBaseline: round(candidateValue - baselineValue),
        relativePercent: baselineValue === 0
          ? null
          : round(((candidateValue - baselineValue) / Math.abs(baselineValue)) * 100),
      }
    } else if (isRecord(baselineValue) && isRecord(candidateValue)) {
      Object.assign(output, numericDeltas(baselineValue, candidateValue, path))
    }
  }
  return output
}

function changedValues(baseline, candidate, prefix = '') {
  const output = {}
  if (!isRecord(baseline) || !isRecord(candidate)) {
    return output
  }
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort()
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key
    const baselineValue = baseline[key]
    const candidateValue = candidate[key]
    if (isRecord(baselineValue) && isRecord(candidateValue)) {
      Object.assign(output, changedValues(baselineValue, candidateValue, path))
      continue
    }
    if (
      (typeof baselineValue === 'boolean' || typeof baselineValue === 'string' || baselineValue === null)
      && (typeof candidateValue === 'boolean' || typeof candidateValue === 'string' || candidateValue === null)
      && baselineValue !== candidateValue
    ) {
      output[path] = { baseline: baselineValue, candidate: candidateValue }
    }
  }
  return output
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000
}
