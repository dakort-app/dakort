import { useEffect, useMemo, useState } from 'react'
import { getJSON } from './api'
import { fileURL } from './FileView'
import { FileIcon, FolderIcon } from './icons'

// What is inside a zip, tar, tar.gz or gz file, as a tree like the
// explorer's: folders fold, each file with its size and date. The server
// lists it (archive.go) without unpacking anything. A lone folder at the
// top (an archive of one project) starts open.

type Entry = { name: string; size: number; dir?: boolean; mtime?: string }
type Node = { name: string; path: string; dir: boolean; size: number; mtime?: string; kids: Node[] }

// tree builds the folders from the names, including folders a zip names
// only through the files inside them.
function tree(entries: Entry[]): Node {
  const root: Node = { name: '', path: '', dir: true, size: 0, kids: [] }
  const dirs = new Map<string, Node>([['', root]])
  const dirOf = (p: string): Node => {
    const have = dirs.get(p)
    if (have) return have
    const cut = p.lastIndexOf('/')
    const parent = dirOf(cut < 0 ? '' : p.slice(0, cut))
    const n: Node = { name: p.slice(cut + 1), path: p, dir: true, size: 0, kids: [] }
    parent.kids.push(n)
    dirs.set(p, n)
    return n
  }
  for (const e of entries) {
    const p = e.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!p) continue
    if (e.dir) {
      const d = dirOf(p)
      d.mtime = e.mtime
      continue
    }
    const cut = p.lastIndexOf('/')
    dirOf(cut < 0 ? '' : p.slice(0, cut)).kids.push({ name: p.slice(cut + 1), path: p, dir: false, size: e.size, mtime: e.mtime, kids: [] })
  }
  const sort = (n: Node) => {
    n.kids.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })))
    for (const k of n.kids) {
      if (k.dir) {
        sort(k)
        k.size = k.kids.reduce((s, c) => s + Math.max(c.size, 0), 0)
      }
    }
  }
  sort(root)
  return root
}

export const bytes = (n: number) =>
  n < 0 ? '' : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`

const day = (t?: string) => (t && !t.startsWith('0001') ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')

export function ArchiveView({ root, path, version }: { root: string; path: string; version: string }) {
  const [list, setList] = useState<{ entries: Entry[]; truncated?: boolean } | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!version) return
    let dead = false
    getJSON<{ entries: Entry[]; truncated?: boolean }>(fileURL('archive', root, path)).then(
      (l) => {
        if (dead) return
        setList(l)
        setErr('')
      },
      (e) => !dead && setErr(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      dead = true
    }
  }, [root, path, version])

  const top = useMemo(() => (list ? tree(list.entries) : null), [list])
  // An archive of one folder starts with it open.
  useEffect(() => {
    if (top?.kids.length === 1 && top.kids[0].dir) setOpen(new Set([top.kids[0].path]))
  }, [top])

  if (err) return <div className="center error">{err}</div>
  if (!top || !list) return <div className="center faint">Loading…</div>

  const files = list.entries.filter((e) => !e.dir)
  const total = files.reduce((s, e) => s + Math.max(e.size, 0), 0)
  const toggle = (p: string) => {
    const next = new Set(open)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setOpen(next)
  }
  const rows: React.ReactNode[] = []
  const walk = (n: Node, depth: number) => {
    for (const k of n.kids) {
      const on = open.has(k.path)
      rows.push(
        <div
          key={k.path + (k.dir ? '/' : '')}
          className={'archive-row' + (k.dir ? ' dir' : '')}
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={k.dir ? () => toggle(k.path) : undefined}
          title={k.path}
          role={k.dir ? 'button' : undefined}
          aria-expanded={k.dir ? on : undefined}
        >
          <span className="archive-twisty faint">{k.dir ? (on ? '▾' : '▸') : ''}</span>
          {k.dir ? <FolderIcon /> : <FileIcon path={k.name} />}
          <span className="ellipsis grow">{k.name}</span>
          <span className="archive-size faint small">{bytes(k.size)}</span>
          <span className="archive-date faint small">{day(k.mtime)}</span>
        </div>,
      )
      if (k.dir && on) walk(k, depth + 1)
    }
  }
  walk(top, 0)

  return (
    <div className="file-csv">
      <div className="csv-box archive-list">{rows.length ? rows : <div className="center faint">An empty archive.</div>}</div>
      <div className="csv-foot small faint">
        {files.length.toLocaleString()} {files.length === 1 ? 'file' : 'files'}, {bytes(total)} unpacked
        {list.truncated ? ` (the first ${list.entries.length.toLocaleString()} entries)` : ''}
      </div>
    </div>
  )
}
