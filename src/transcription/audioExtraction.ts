export const AUDIO_TIMELINE_FILTER = 'aresample=async=1:first_pts=0'

export function buildAudioExtractionArgs(inputName: string, outputName: string): string[] {
  return [
    '-i',
    inputName,
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
