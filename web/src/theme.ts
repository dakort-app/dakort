// Light or dark, picked on this device (light until dark is picked; the
// system's setting plays no part, by choice). The page carries it as
// <html data-theme="light|dark">, which the stylesheet keys off;
// index.html sets it before the first paint so a dark page does not flash
// light.

const key = 'dakort.theme'
const listeners = new Set<() => void>()

export const isDark = () => localStorage.getItem(key) === 'dark'

export function setDark(dark: boolean) {
  localStorage.setItem(key, dark ? 'dark' : 'light')
  apply(dark)
  listeners.forEach((f) => f())
}

// The page's theme, and the browser's own bar (theme-color: the installed
// app's title bar, a phone's status bar) in the page's background.
function apply(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  const meta = document.querySelector<HTMLMetaElement>('meta[name=theme-color]')
  if (meta) meta.content = dark ? '#1f1e1c' : '#fdfcfa'
}

export function onTheme(f: () => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

apply(isDark())
