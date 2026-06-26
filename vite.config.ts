import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

type TerminalLogPayload = {
  type?: string
  jobId?: string
  fileName?: string
  modelId?: string
  stage?: string
  message?: string
  progress?: number
  startTime?: number
  endTime?: number
  text?: string
  segmentCount?: number
}

const TERMINAL_LOG_PATH = '/__auto_subtitle_terminal'
const TERMINAL_BAR_WIDTH = 28

function autoSubtitleTerminalPlugin(): Plugin {
  let lastProgressLength = 0

  const finishProgressLine = () => {
    if (!lastProgressLength) {
      return
    }

    process.stdout.write('\n')
    lastProgressLength = 0
  }

  const writeProgressLine = (line: string) => {
    const columns = process.stdout.columns || 100
    const trimmed = line.length > columns - 1 ? `${line.slice(0, Math.max(0, columns - 4))}...` : line
    const padding = ' '.repeat(Math.max(0, lastProgressLength - trimmed.length))
    process.stdout.write(`\r${trimmed}${padding}`)
    lastProgressLength = trimmed.length
  }

  const logLine = (line: string) => {
    finishProgressLine()
    console.log(line)
  }

  return {
    name: 'auto-subtitle-terminal-progress',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(TERMINAL_LOG_PATH, (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405
          response.end()
          return
        }

        let body = ''
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
          if (body.length > 1_000_000) {
            request.destroy()
          }
        })

        request.on('end', () => {
          try {
            renderTerminalLog(JSON.parse(body) as TerminalLogPayload, writeProgressLine, logLine)
          } catch (error) {
            logLine(`[Auto Subtitle] Could not read terminal progress event: ${String(error)}`)
          }

          response.statusCode = 204
          response.end()
        })
      })
    },
  }
}

function renderTerminalLog(
  payload: TerminalLogPayload,
  writeProgressLine: (line: string) => void,
  logLine: (line: string) => void,
): void {
  if (payload.type === 'start') {
    logLine(`[Auto Subtitle] Transcribing ${payload.fileName ?? 'selected video'} with ${payload.modelId ?? 'Whisper'}`)
    return
  }

  if (payload.type === 'progress') {
    writeProgressLine(formatProgressLine(payload))
    return
  }

  if (payload.type === 'caption') {
    logLine(`[Caption ${formatTerminalTime(payload.startTime)} -> ${formatTerminalTime(payload.endTime)}] ${trimTerminalText(payload.text)}`)
    return
  }

  if (payload.type === 'complete') {
    logLine(`[Auto Subtitle] Complete: ${payload.segmentCount ?? 0} caption segment(s) created.`)
    return
  }

  if (payload.type === 'error') {
    logLine(`[Auto Subtitle] Failed: ${payload.message ?? 'Transcription failed.'}`)
  }
}

function formatProgressLine(payload: TerminalLogPayload): string {
  const progress = clampProgress(payload.progress ?? 0)
  const filled = Math.round(progress * TERMINAL_BAR_WIDTH)
  const bar = `${'#'.repeat(filled)}${'-'.repeat(TERMINAL_BAR_WIDTH - filled)}`
  const percent = `${Math.round(progress * 100).toString().padStart(3, ' ')}%`
  const label = payload.message ?? payload.stage ?? 'Working'
  return `[Auto Subtitle] [${bar}] ${percent} ${label}`
}

function formatTerminalTime(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '--:--'
  }

  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`
}

function trimTerminalText(value: string | undefined): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), autoSubtitleTerminalPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
