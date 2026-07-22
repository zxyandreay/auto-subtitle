import { Bug, FileDown, FileJson, FileText, FolderOpen, Moon, Sun, Trash2, Upload } from 'lucide-react'
import type { ChangeEvent } from 'react'
import { useRef } from 'react'
import type { ThemePreference } from '../theme'
import { IconButton } from './IconButton'
import { SubtitleLogo } from './SubtitleLogo'

type ProjectToolbarProps = {
  theme: ThemePreference
  entryCount: number
  hasAutosave: boolean
  locked?: boolean
  onThemeChange: (theme: ThemePreference) => void
  onImportFile: (file: File) => void
  onRestoreAutosave: () => void
  onClearAutosave: () => void
  onExport: (kind: 'srt' | 'vtt' | 'txt' | 'json') => void
  onExportDiagnostics: () => void
  onClearSubtitles: () => void
}

export function ProjectToolbar({
  theme,
  entryCount,
  hasAutosave,
  locked = false,
  onThemeChange,
  onImportFile,
  onRestoreAutosave,
  onClearAutosave,
  onExport,
  onExportDiagnostics,
  onClearSubtitles,
}: ProjectToolbarProps) {
  const importRef = useRef<HTMLInputElement | null>(null)

  const handleImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.item(0)
    if (file) {
      onImportFile(file)
    }
    event.currentTarget.value = ''
  }

  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <SubtitleLogo />
        </div>
        <div>
          <h1>Auto Subtitle</h1>
          <p>Local-first subtitle generation and editing</p>
        </div>
      </div>

      <input
        ref={importRef}
        accept=".srt,.vtt,.json,application/json,text/vtt"
        className="sr-only"
        disabled={locked}
        type="file"
        onChange={handleImport}
      />

      <nav className="toolbar" aria-label="Project actions">
        <span className="privacy-indicator">Local processing</span>
        <button className="button button--ghost" disabled={locked} type="button" onClick={() => importRef.current?.click()}>
          <Upload size={16} />
          Import
        </button>
        <button className="button button--ghost" disabled={locked || !hasAutosave} type="button" onClick={onRestoreAutosave}>
          <FolderOpen size={16} />
          Restore
        </button>
        <div className="export-menu" aria-label="Export subtitles">
          <button className="button button--soft" disabled={locked || !entryCount} type="button" onClick={() => onExport('srt')}>
            <FileDown size={16} />
            SRT
          </button>
          <button className="button button--soft" disabled={locked || !entryCount} type="button" onClick={() => onExport('vtt')}>
            <FileText size={16} />
            VTT
          </button>
          <button className="button button--soft" disabled={locked || !entryCount} type="button" onClick={() => onExport('txt')}>
            TXT
          </button>
          <button className="button button--soft" disabled={locked || !entryCount} type="button" onClick={() => onExport('json')}>
            <FileJson size={16} />
            JSON
          </button>
        </div>
        <IconButton label="Clear autosave" disabled={locked || !hasAutosave} onClick={onClearAutosave}>
          <Trash2 size={16} />
        </IconButton>
        <IconButton label="Clear subtitles" disabled={locked || !entryCount} onClick={onClearSubtitles}>
          <Trash2 size={16} />
        </IconButton>
        <button aria-label="Export debug log" className="button button--ghost" type="button" onClick={onExportDiagnostics}>
          <Bug size={16} />
          Debug log
        </button>
        <select
          aria-label="Theme"
          className="theme-select"
          value={theme}
          onChange={(event) => onThemeChange(event.target.value as ThemePreference)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <span className="theme-icon" aria-hidden="true">
          {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        </span>
      </nav>
    </header>
  )
}
