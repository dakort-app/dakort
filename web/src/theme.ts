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
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  listeners.forEach((f) => f())
}

export function onTheme(f: () => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

document.documentElement.dataset.theme = isDark() ? 'dark' : 'light'
