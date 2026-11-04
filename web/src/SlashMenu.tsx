import { useEffect, useState } from 'react'
import { getJSON } from './api'

// The "/" menu: typing a slash at the start of the box lists the commands
// that work here (GET /api/commands: the headless built-ins, then skills
// and custom commands), narrowed as you type; arrows and Enter (or Tab)
// pick, Escape closes, a tap picks on a phone.

export type Command = { name: string; description?: string; argumentHint?: string; builtin?: boolean }

const lists = new Map<string, Promise<Command[]>>() // by folder, for this page
const load = (folder: string) => {
  let p = lists.get(folder)
  if (!p) {
    p = getJSON<Command[]>('/api/commands?folder=' + encodeURIComponent(folder)).catch(() => {
      lists.delete(folder) // try again next time
      return []
    })
    lists.set(folder, p)
  }
  return p
}

// slashQuery is what follows a slash at the start of the text, while only
// the command name is being typed; null otherwise.
export const slashQuery = (text: string) => /^\/(\S*)$/.exec(text)?.[1] ?? null

// enabled is false for a Codex session: the commands are Claude's.
export function useSlashMenu(folder: string, text: string, enabled = true) {
  const query = enabled ? slashQuery(text) : null
  const [all, setAll] = useState<Command[] | null>(null)
  const [sel, setSel] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  useEffect(() => {
    if (query !== null && !all) load(folder).then(setAll)
  }, [query !== null, folder])
  useEffect(() => setSel(0), [query])

  const q = (query ?? '').toLowerCase()
  const shown = (all ?? []).filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => +!a.name.toLowerCase().startsWith(q) - +!b.name.toLowerCase().startsWith(q))
  const open = query !== null && closedFor !== text && (all === null || shown.length > 0)
  return {
    open,
    loading: all === null,
    shown,
    sel: Math.min(sel, Math.max(shown.length - 1, 0)),
    // onKey handles the menu's keys; true when it used the key.
    onKey(e: { key: string; preventDefault(): void }, pick: (c: Command) => void): boolean {
      if (!open) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = shown.length
        if (n) setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        return true
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && shown.length) {
        e.preventDefault()
        pick(shown[Math.min(sel, shown.length - 1)])
        return true
      }
      if (e.key === 'Escape') {
        setClosedFor(text)
        return true
      }
      return false
    },
    setSel,
  }
}

export function SlashMenu({ menu, pick }: { menu: ReturnType<typeof useSlashMenu>; pick: (c: Command) => void }) {
  if (!menu.open) return null
  return (
    <div className="slash-menu" role="listbox">
      {menu.loading && <div className="slash-row faint">Loading commands…</div>}
      {menu.shown.map((c, i) => (
        <div
          key={c.name}
          role="option"
          aria-selected={i === menu.sel}
          className={'slash-row' + (i === menu.sel ? ' on' : '')}
          onMouseEnter={() => menu.setSel(i)}
          onMouseDown={(e) => {
            e.preventDefault() // keep the focus in the box
            pick(c)
          }}
        >
          <span className="slash-name">/{c.name}</span>
          {c.argumentHint && <span className="faint small"> {c.argumentHint}</span>}
          {c.description && <div className="slash-desc faint small ellipsis">{c.description}</div>}
        </div>
      ))}
    </div>
  )
}
