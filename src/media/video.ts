export type VideoFileState = {
  file: File
  objectUrl: string
  duration: number
}

export type VideoValidationResult = {
  errors: string[]
  warnings: string[]
}

const ACCEPTED_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv']
const ACCEPTED_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']

export function isAcceptedVideoMimeType(type: string): boolean {
  return ACCEPTED_TYPES.includes(type.toLowerCase())
}

export function findFirstValidVideoFile(
  files: Iterable<File>,
  options: { fileSizeWarningMb: number; durationWarningMinutes: number },
): { file?: File; rejectedCount: number } {
  let file: File | undefined
  let rejectedCount = 0
  for (const candidate of files) {
    if (validateVideoFile(candidate, options).errors.length) {
      rejectedCount += 1
    } else if (!file) {
      file = candidate
    }
  }
  return { file, rejectedCount }
}

export function validateVideoFile(
  file: File,
  options: { fileSizeWarningMb: number; durationWarningMinutes: number },
): VideoValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const lowerName = file.name.toLowerCase()
  const hasAcceptedExtension = ACCEPTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension))
  const hasAcceptedType = !file.type || isAcceptedVideoMimeType(file.type)

  if (!hasAcceptedExtension && !hasAcceptedType) {
    errors.push('Choose an MP4, WebM, MOV, or MKV video file.')
  }

  if (file.size === 0) {
    errors.push('The selected file is empty.')
  }

  if (file.size > options.fileSizeWarningMb * 1024 * 1024) {
    warnings.push(
      `This file is larger than ${options.fileSizeWarningMb} MB. Large videos can require significant memory and time.`,
    )
  }

  return { errors, warnings }
}

export function getDurationWarning(duration: number, durationWarningMinutes: number): string | null {
  if (duration > durationWarningMinutes * 60) {
    return `This video is longer than ${durationWarningMinutes} minutes. Browser transcription may be slow and memory intensive.`
  }

  return null
}
