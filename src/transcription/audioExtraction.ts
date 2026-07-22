export const AUDIO_TIMELINE_FILTER = 'aresample=async=1:first_pts=0'

export type AudioExtractionRange = {
  startTime: number
  endTime: number
}

export function buildAudioExtractionArgs(
  inputName: string,
  outputName: string,
  range?: AudioExtractionRange,
): string[] {
  const seekArgs = range ? ['-ss', formatSeconds(range.startTime)] : []
  const durationArgs = range ? ['-t', formatSeconds(range.endTime - range.startTime)] : []

  return [
    ...seekArgs,
    '-i',
    inputName,
    ...durationArgs,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    AUDIO_TIMELINE_FILTER,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-acodec',
    'pcm_s16le',
    '-f',
    'wav',
    outputName,
  ]
}

function formatSeconds(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}
