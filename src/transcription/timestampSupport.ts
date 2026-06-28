export function isWordTimestampUnsupportedError(error: unknown): boolean {
  const message = (error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)).toLowerCase()
  return (
    message.includes('cross attentions to extract timestamps') ||
    message.includes('token-level timestamps not available') ||
    message.includes('output_attentions=true') ||
    (message.includes('word') && message.includes('timestamp') && message.includes('not support')) ||
    (message.includes("return_timestamps: 'word'") && message.includes('not available'))
  )
}
