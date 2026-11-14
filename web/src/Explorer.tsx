import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getJSON, HTTPError, postJSON } from './api'
import { fileURL } from './FileView'
import { FileIcon, FolderIcon } from './icons'
import { filesChanged, useStore } from './store'

// The folder's files, one level fetched per expand, like VS Code's
// explorer. Expanded folders are listed again after every turn, since
// Claude may have added or removed files, and after an upload from here. Folders come first either way;
// by date, each group is newest first (a folder's time changes when a file
// is added or removed in it, not when one inside is edited). A file can be
// deleted from here, with Undo (below).

type Entry = { name: string; dir?: boolean; size: number; mtime?: string }

const time = (e: Entry) => Date.parse(e.mtime ?? '') || 0
const newestFirst = (l: Entry[]) => [...l].sort((a, b) => +!!b.dir - +!!a.dir || time(b) - time(a))

type Props = { root: string; onOpen: (path: string) => void; active?: string; byName?: boolean }

export function Explorer({ root, onOpen, active, byName }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']))
  const [lists, setLists] = useState<Record<string, Entry[]>>({})
  const [err, setErr] = useState('')
  const ended = useStore((s) => s.live.ended)
  const changed = useStore((s) => s.files)

  const load = async (dir: string) => {
    try {
      const l = await getJSON<Entry[]>(fileURL('list', root, dir))
      setLists((cur) => ({ ...cur, [dir]: l }))
      setErr('')
    } catch (e) {
      if (dir && e instanceof HTTPError && e.status === 404) {
        // An expanded folder was moved or deleted since (by Claude, say):
        // forget it and what was open under it; the parent's list no
        // longer shows it.
        const gone = (p: string) => p === dir || p.startsWith(dir + '/')
        setOpen((cur) => new Set([...cur].filter((p) => !gone(p))))
        setLists((cur) => Object.fromEntries(Object.entries(cur).filter(([p]) => !gone(p))))
        return
      }
      setErr(String(e instanceof Error ? e.message : e))
    }
  }

  useEffect(() => {
    open.forEach((d) => load(d))
  }, [root, ended, changed])

  const toggle = (dir: string) => {
    const next = new Set(open)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (!lists[dir]) load(dir)
    }
    setOpen(next)
  }

  // Deleting a file: a right-click (a long press on a phone) asks, the
  // file goes to the server's trash (filetrash.go), and Undo stays offered
  // for a while. Folders are not deleted here.
  const [ask, setAsk] = useState('')
  const [undo, setUndo] = useState<{ trash: string; path: string } | null>(null)
  const [delErr, setDelErr] = useState('')
  const press = useRef(0)
  const pressed = useRef(false) // a long press opened the question; the tap that ends it opens nothing
  useEffect(() => {
    if (!undo) return
    const t = window.setTimeout(() => setUndo(null), 10_000)
    return () => clearTimeout(t)
  }, [undo])
  const remove = async (path: string) => {
    setAsk('')
    setDelErr('')
    try {
      const r = await postJSON<{ trash: string }>(fileURL('delete', root, path), {})
      setUndo({ trash: r.trash, path })
      filesChanged()
    } catch (e) {
      setDelErr(`Could not delete ${path}: ` + (e instanceof Error ? e.message : e))
    }
  }
  const restore = async () => {
    if (!undo) return
    setUndo(null)
    try {
      await postJSON('/api/files/restore', { trash: undo.trash })
      filesChanged()
    } catch (e) {
      setDelErr(`Could not put ${undo.path} back: ` + (e instanceof Error ? e.message : e))
    }
  }

  const rows = (dir: string, depth: number): ReactNode[] =>
    (byName ? (lists[dir] ?? []) : newestFirst(lists[dir] ?? [])).flatMap((e) => {
      const p = dir ? dir + '/' + e.name : e.name
      const row = (
        <div
          key={p}
          className={'tree-row' + (p === active ? ' current' : '')}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            if (pressed.current) return void (pressed.current = false)
            if (e.dir) toggle(p)
            else onOpen(p)
          }}
          onContextMenu={(ev) => {
            if (e.dir) return
            ev.preventDefault()
            setAsk(p)
          }}
          onTouchStart={() => {
            pressed.current = false
            if (!e.dir) press.current = window.setTimeout(() => ((pressed.current = true), setAsk(p)), 550)
          }}
          onTouchEnd={() => clearTimeout(press.current)}
          onTouchMove={() => clearTimeout(press.current)}
          title={p}
        >
          <span className="tree-caret">{e.dir ? (open.has(p) ? '▾' : '▸') : ''}</span>
          {e.dir ? <FolderIcon size={15} /> : <FileIcon path={e.name} size={15} />}
          <span className="ellipsis">{e.name}</span>
        </div>
      )
      return e.dir && open.has(p) ? [row, ...rows(p, depth + 1)] : [row]
    })

  return (
    <div className="explorer">
      {err && <div className="error small pad">{err}</div>}
      {rows('', 0)}
      {lists[''] && !lists[''].length && <div className="faint small pad">Empty folder.</div>}
      {ask && (
        <div className="toast" role="dialog" aria-label="Delete file">
          <span className="ellipsis">Delete {ask}?</span>
          <button className="btn small-btn" onClick={() => remove(ask)}>
            Delete
          </button>
          <button className="tab-x light" aria-label="Keep it" onClick={() => setAsk('')}>
            ×
          </button>
        </div>
      )}
      {!ask && undo && (
        <div className="toast">
          <span className="ellipsis">Deleted {undo.path}</span>
          <button className="btn small-btn" onClick={restore}>
            Undo
          </button>
        </div>
      )}
      {!ask && !undo && delErr && (
        <div className="toast">
          <span className="ellipsis">{delErr}</span>
          <button className="tab-x light" aria-label="Dismiss" onClick={() => setDelErr('')}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
