import { useEffect, useState } from 'react'
import { getJSON } from './api'
import { cn } from '@/lib/utils'
import { menuCaption, menuItem, menuSurface } from '@/lib/menu'

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
    // has: the folder lists a command of this name (a skill, say).
    has: (name: string) => !!all?.some((c) => c.name === name),
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

// A row is the command in mono (and its argument hint), and what it does on
// one line: beside it on a laptop, under it on a phone.
export function SlashMenu({ menu, pick }: { menu: ReturnType<typeof useSlashMenu>; pick: (c: Command) => void }) {
  if (!menu.open) return null
  return (
    <div className={cn('slash-menu', menuSurface, 'animate-none')} role="listbox" aria-label="Commands">
      <div className={cn('menu-head', menuCaption, 'sticky -top-1 z-10 -mx-1 -mt-1 flex justify-between gap-3 bg-popover px-3 pt-2')} aria-hidden="true">
        Commands<span className="menu-keys">↑↓ to move · Enter to pick · Esc to close</span>
      </div>
      {menu.loading && <div className={cn('slash-row slash-loading', menuCaption)}>Loading commands…</div>}
      {menu.shown.map((c, i) => (
        <div
          key={c.name}
          role="option"
          aria-selected={i === menu.sel}
          className={cn('slash-row', menuItem, 'items-baseline gap-3 hover:bg-transparent aria-selected:bg-accent aria-selected:text-accent-foreground', i === menu.sel && 'on')}
          title={'/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : '')}
          onMouseEnter={() => menu.setSel(i)}
          onMouseDown={(e) => {
            e.preventDefault() // keep the focus in the box
            pick(c)
          }}
        >
          <span className="slash-cmd">
            <span className="slash-name">/{c.name}</span>
            {c.argumentHint && (
              <span className="slash-hint">
                {/* Each word of the hint whole: it wraps between them, never inside a flag. */}
                {c.argumentHint.split(' ').map((w, k) => (
                  <span key={k}>
                    {' '}
                    <span className="nb">{w}</span>
                  </span>
                ))}
              </span>
            )}
          </span>{' '}
          {c.description && <span className="slash-desc text-muted-foreground">{c.description}</span>}
        </div>
      ))}
    </div>
  )
}
