const TIMESTAMP_PARTS = /^(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?$/
const RAW_SECONDS = /^\d+([.,]\d+)?$/

export function roundTime(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export function parseTimestamp(value: string): number | null {
  const input = value.trim().replace(',', '.')

  if (!input || input.startsWith('-')) {
    return null
  }

  if (RAW_SECONDS.test(input)) {
    const seconds = Number(input)
    return Number.isFinite(seconds) ? seconds : null
  }

  if (!TIMESTAMP_PARTS.test(input)) {
    return null
  }

  const [first = '0', second = '0', third = '0'] = input.split(':')
  const hasHours = input.split(':').length === 3
  const hours = hasHours ? Number(first) : 0
  const minutes = hasHours ? Number(second) : Number(first)
  const seconds = Number(hasHours ? third : second)

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null
  }

  return roundTime(hours * 3600 + minutes * 60 + seconds)
}

export function formatTimestamp(
  seconds: number,
  options: { millisecondsSeparator?: ',' | '.'; alwaysHours?: boolean } = {},
): string {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const totalMilliseconds = Math.round(safeSeconds * 1000)
  const milliseconds = totalMilliseconds % 1000
  const totalSeconds = Math.floor(totalMilliseconds / 1000)
  const displaySeconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const separator = options.millisecondsSeparator ?? '.'

  const hourPrefix =
    options.alwaysHours || hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''

  return `${hourPrefix}${String(minutes).padStart(2, '0')}:${String(displaySeconds).padStart(2, '0')}${separator}${String(milliseconds).padStart(3, '0')}`
}

export function formatSrtTimestamp(seconds: number): string {
  return formatTimestamp(seconds, {
    alwaysHours: true,
    millisecondsSeparator: ',',
  })
}

export function formatVttTimestamp(seconds: number): string {
  return formatTimestamp(seconds, {
    alwaysHours: true,
    millisecondsSeparator: '.',
  })
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '00:00'
  }

  return formatTimestamp(seconds, { millisecondsSeparator: '.', alwaysHours: seconds >= 3600 }).replace(
    /\.000$/,
    '',
  )
}

export function clampTime(seconds: number, duration?: number): number {
  const upper = duration === undefined ? Number.POSITIVE_INFINITY : Math.max(0, duration)
  return Math.min(Math.max(0, roundTime(seconds)), upper)
}
