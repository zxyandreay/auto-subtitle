import { describe, expect, it, vi } from 'vitest'
import { renderTerminalLog } from '../../vite.config'

describe('terminal regeneration logging', () => {
  it('identifies the regeneration range when a job starts', () => {
    const logLine = vi.fn()

    renderTerminalLog(
      {
        type: 'start',
        jobKind: 'regeneration',
        fileName: 'sample.mp4',
        modelId: 'whisper-tiny',
        startTime: 12.4,
        endTime: 18.9,
      },
      vi.fn(),
      logLine,
    )

    expect(logLine).toHaveBeenCalledWith(
      '[Auto Subtitle] Regenerating 00:12.400 -> 00:18.900 in sample.mp4 with whisper-tiny',
    )
  })

  it('reports regeneration alternatives instead of caption segments on completion', () => {
    const logLine = vi.fn()

    renderTerminalLog(
      { type: 'complete', jobKind: 'regeneration', candidateCount: 3 },
      vi.fn(),
      logLine,
    )

    expect(logLine).toHaveBeenCalledWith('[Auto Subtitle] Regeneration complete: 3 alternative(s) created.')
  })
})
