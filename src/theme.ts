import type { ThemeMode } from '../shared/preferences.ts'

/** Resolve the preference into the concrete theme applied to the document.
    An unknown value (older server) behaves like `auto` instead of breaking. */
export function resolveTheme(theme: ThemeMode | undefined): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Apply the theme to <html> so CSS tokens and `color-scheme` switch together. */
export function applyTheme(theme: ThemeMode | undefined) {
  const resolved = resolveTheme(theme)
  document.documentElement.dataset.theme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#090f0c' : '#f2f4ee')
  return resolved
}

/** Follow operating-system appearance changes, used while the theme is `auto`. */
export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = () => onChange()
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
