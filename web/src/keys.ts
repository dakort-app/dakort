// Keyboard shortcuts as the tips show them: a muted key chip after the
// tip's words, in the platform's own way. A shortcut is written once, as
// 'Ctrl+`' or 'Mod+F' (Mod: ⌘ on a Mac, Ctrl elsewhere), and shown as ⌃`
// or ⌘F on a Mac, Ctrl+` or Ctrl+F elsewhere.

export const isMac = typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform)

const macKeys: Record<string, string> = { Mod: '⌘', Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩' }

export function keyLabel(spec: string, mac = isMac): string {
  const parts = spec.split(/\+(?!$)/) // 'Ctrl++' keeps its plus
  if (mac) return parts.map((k) => macKeys[k] ?? k).join('')
  return parts.map((k) => (k === 'Mod' || k === 'Cmd' ? 'Ctrl' : k)).join('+')
}
