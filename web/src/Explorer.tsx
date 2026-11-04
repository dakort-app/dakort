import { useEffect, useState, type ReactNode } from 'react'
import { getJSON } from './api'
import { fileURL } from './FileView'
import { FileIcon, FolderIcon } from './icons'
import { useStore } from './store'

// The folder's files, one level fetched per expand, like VS Code's
// explorer. Expanded folders are listed again after every turn, since
// Claude may have added or removed files. Folders come first either way;
// by date, each group is newest first (a folder's time changes when a file
// is added or removed in it, not when one inside is edited).

type Entry = { name: string; dir?: boolean; size: number; mtime?: string }

const time = (e: Entry) => Date.parse(e.mtime ?? '') || 0
const newestFirst = (l: Entry[]) => [...l].sort((a, b) => +!!b.dir - +!!a.dir || time(b) - time(a))

type Props = { root: string; onOpen: (path: string) => void; active?: string; byName?: boolean }

export function Explorer({ root, onOpen, active, byName }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']))
  const [lists, setLists] = useState<Record<string, Entry[]>>({})
  const [err, setErr] = useState('')
  const ended = useStore((s) => s.live.ended)

  const load = async (dir: string) => {
    try {
      const l = await getJSON<Entry[]>(fileURL('list', root, dir))
      setLists((cur) => ({ ...cur, [dir]: l }))
      setErr('')
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }

  useEffect(() => {
    open.forEach((d) => load(d))
  }, [root, ended])

  const toggle = (dir: string) => {
    const next = new Set(open)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (!lists[dir]) load(dir)
    }
    setOpen(next)
  }

  const rows = (dir: string, depth: number): ReactNode[] =>
    (byName ? (lists[dir] ?? []) : newestFirst(lists[dir] ?? [])).flatMap((e) => {
      const p = dir ? dir + '/' + e.name : e.name
      const row = (
        <div
          key={p}
          className={'tree-row' + (p === active ? ' current' : '')}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (e.dir ? toggle(p) : onOpen(p))}
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
    </div>
  )
}
