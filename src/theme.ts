export type ThemePreference = 'light' | 'dark' | 'system'

const THEME_KEY = 'auto-subtitle-theme'

export function loadThemePreference(): ThemePreference {
  const saved = localStorage.getItem(THEME_KEY)
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
}

export function saveThemePreference(theme: ThemePreference): void {
  localStorage.setItem(THEME_KEY, theme)
}

export function applyTheme(theme: ThemePreference): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
  document.documentElement.dataset.theme = resolved
}
