export type DiagnosticLevel = 'info' | 'warning' | 'error'

export type DiagnosticEventInput = {
  source: 'app' | 'transcription-worker'
  category: string
  message: string
  level?: DiagnosticLevel
  jobId?: string
  data?: unknown
  timestamp?: string
}

export type DiagnosticEvent = {
  sequence: number
  timestamp: string
  sessionId: string
  source: DiagnosticEventInput['source']
  category: string
  message: string
  level: DiagnosticLevel
  jobId?: string
  data?: unknown
}

export type DiagnosticEnvironment = {
  userAgent?: string
  language?: string
  hardwareConcurrency?: number
  crossOriginIsolated?: boolean
}

export type DiagnosticReport = {
  schemaVersion: 1
  exportedAt: string
  privacy: string
  environment: DiagnosticEnvironment
  context?: unknown
  events: DiagnosticEvent[]
}
