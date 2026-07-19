import type {
  DiagnosticEnvironment,
  DiagnosticEvent,
  DiagnosticEventInput,
  DiagnosticReport,
} from './types'

const STORAGE_KEY = 'auto-subtitle-diagnostics-v1'
const DEFAULT_MAX_EVENTS = 1_000
const DEFAULT_MAX_BYTES = 2_000_000
const DEFAULT_MAX_STRING_LENGTH = 12_000
const DEFAULT_PERSIST_DELAY_MS = 250

type DiagnosticLogOptions = {
  maxEvents?: number
  maxBytes?: number
  maxStringLength?: number
  persistDelayMs?: number
  now?: () => Date
  sessionId?: string
}

type StoredDiagnosticLog = {
  schemaVersion: 1
  events: DiagnosticEvent[]
}

export class DiagnosticLog {
  private readonly storage: Storage | null
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly maxStringLength: number
  private readonly persistDelayMs: number
  private readonly now: () => Date
  private readonly sessionId: string
  private events: DiagnosticEvent[]
  private eventSizes: number[]
  private totalEventBytes: number
  private nextSequence: number
  private persistenceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    storage: Storage | null,
    options: DiagnosticLogOptions = {},
  ) {
    this.storage = storage
    this.maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS)
    this.maxBytes = Math.max(1_000, options.maxBytes ?? DEFAULT_MAX_BYTES)
    this.maxStringLength = Math.max(40, options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH)
    this.persistDelayMs = Math.max(0, options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS)
    this.now = options.now ?? (() => new Date())
    this.sessionId = options.sessionId ?? createSessionId()
    this.events = this.readStoredEvents()
    this.eventSizes = this.events.map(serializedEventBytes)
    this.totalEventBytes = serializedArrayBytes(this.eventSizes)
    this.trimToLimits()
    this.nextSequence = (this.events.at(-1)?.sequence ?? 0) + 1
  }

  record(input: DiagnosticEventInput): DiagnosticEvent {
    const event: DiagnosticEvent = {
      sequence: this.nextSequence,
      timestamp: input.timestamp ?? this.now().toISOString(),
      sessionId: this.sessionId,
      source: input.source,
      category: input.category,
      message: input.message,
      level: input.level ?? 'info',
      jobId: input.jobId,
      data: input.data === undefined ? undefined : sanitizeValue(input.data, this.maxStringLength),
    }
    this.nextSequence += 1
    this.events.push(event)
    const eventSize = serializedEventBytes(event)
    this.eventSizes.push(eventSize)
    this.totalEventBytes += eventSize + (this.eventSizes.length > 1 ? 1 : 0)
    this.trimToLimits()
    this.schedulePersist()
    return structuredCloneSafe(event)
  }

  getEvents(): DiagnosticEvent[] {
    return structuredCloneSafe(this.events)
  }

  clear(): void {
    this.cancelScheduledPersist()
    this.events = []
    this.eventSizes = []
    this.totalEventBytes = serializedArrayBytes(this.eventSizes)
    this.nextSequence = 1
    try {
      this.storage?.removeItem(STORAGE_KEY)
    } catch {
      // Diagnostics must never interfere with the app when storage is unavailable.
    }
  }

  createReport(context?: unknown, environment: DiagnosticEnvironment = readEnvironment()): DiagnosticReport {
    this.flush()
    return {
      schemaVersion: 1,
      exportedAt: this.now().toISOString(),
      privacy: 'Contains settings, file metadata, recognized text, and timing decisions. Contains no audio or video bytes.',
      environment: sanitizeValue(environment, this.maxStringLength) as DiagnosticEnvironment,
      context: context === undefined ? undefined : sanitizeValue(context, this.maxStringLength),
      events: this.getEvents(),
    }
  }

  flush(): void {
    this.cancelScheduledPersist()
    this.persistNow()
  }

  private readStoredEvents(): DiagnosticEvent[] {
    try {
      const serialized = this.storage?.getItem(STORAGE_KEY)
      if (!serialized) {
        return []
      }
      const stored = JSON.parse(serialized) as StoredDiagnosticLog
      if (stored.schemaVersion !== 1 || !Array.isArray(stored.events)) {
        return []
      }
      return stored.events.slice(-this.maxEvents)
    } catch {
      return []
    }
  }

  private trimToLimits(): void {
    if (this.events.length > this.maxEvents) {
      const removeCount = this.events.length - this.maxEvents
      this.events.splice(0, removeCount)
      this.eventSizes.splice(0, removeCount)
      this.totalEventBytes = serializedArrayBytes(this.eventSizes)
    }

    while (this.events.length > 1 && this.totalEventBytes > this.maxBytes) {
      this.events.shift()
      const removedSize = this.eventSizes.shift() ?? 0
      this.totalEventBytes -= removedSize + 1
    }
  }

  private schedulePersist(): void {
    if (!this.storage || this.persistenceTimer !== null) {
      return
    }

    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null
      this.persistNow()
    }, this.persistDelayMs)
  }

  private cancelScheduledPersist(): void {
    if (this.persistenceTimer === null) {
      return
    }

    clearTimeout(this.persistenceTimer)
    this.persistenceTimer = null
  }

  private persistNow(): void {
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ schemaVersion: 1, events: this.events } satisfies StoredDiagnosticLog),
      )
    } catch {
      // Keep the in-memory copy when localStorage is disabled or its quota is full.
    }
  }
}

let sharedLog: DiagnosticLog | undefined

export function getDiagnosticLog(): DiagnosticLog {
  if (!sharedLog) {
    let storage: Storage | null = null
    try {
      storage = typeof window === 'undefined' ? null : window.localStorage
    } catch {
      storage = null
    }
    sharedLog = new DiagnosticLog(storage)
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => sharedLog?.flush(), { once: true })
    }
  }
  return sharedLog
}

export function recordDiagnosticEvent(event: DiagnosticEventInput): DiagnosticEvent {
  return getDiagnosticLog().record(event)
}

function sanitizeValue(value: unknown, maxStringLength: number, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length <= maxStringLength) {
      return value
    }
    const headLength = Math.ceil(maxStringLength * 0.7)
    const tailLength = maxStringLength - headLength
    return {
      truncated: true,
      originalLength: value.length,
      head: value.slice(0, headLength),
      tail: value.slice(-tailLength),
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  if (value === undefined) {
    return undefined
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (depth >= 6) {
    return '[maximum diagnostic depth reached]'
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, 200).map((item) => sanitizeValue(item, maxStringLength, depth + 1))
    return value.length > kept.length ? [...kept, { omittedItems: value.length - kept.length }] : kept
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, item] of entries.slice(0, 100)) {
      output[key] = sanitizeValue(item, maxStringLength, depth + 1)
    }
    if (entries.length > 100) {
      output.omittedProperties = entries.length - 100
    }
    return output
  }
  return String(value)
}

function readEnvironment(): DiagnosticEnvironment {
  if (typeof navigator === 'undefined') {
    return {}
  }
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : undefined,
  }
}

function serializedEventBytes(event: DiagnosticEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

function serializedArrayBytes(eventSizes: number[]): number {
  return 2 + eventSizes.reduce((total, size) => total + size, 0) + Math.max(0, eventSizes.length - 1)
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createSessionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
