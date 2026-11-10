import { useEffect, useState } from 'react'
import { api, getJSON } from './api'
import { ago, baseName, folderHash, parentPath } from './route'
import { FolderIcon } from './icons'
import { refreshLists, useStore } from './store'

// OpenFolder lists every folder Claude has sessions in that is not open
// yet, and can browse the disk for one that has none.
export function OpenFolder(props: { onClose: () => void }) {
  const folders = useStore((s) => s.folders)
  const sessions = useStore((s) => s.sessions)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const needle = q.trim().toLowerCase()
  const recent = folders.filter((f) => !f.open && !f.missing && (!needle || f.path.toLowerCase().includes(needle)))
  const latest = (path: string) => sessions.find((s) => s.folder === path)
  const pick = async (path: string) => {
    try {
      const { path: opened } = await api.openFolder(path)
      refreshLists()
      props.onClose()
      location.hash = folderHash(opened)
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }
  if (browsing) return <Browse onPick={pick} onBack={() => setBrowsing(false)} onClose={props.onClose} err={err} />
  return (
    <div className="sheet-back" onClick={props.onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <header className="bar">
          <b>Open project</b>
          <span className="grow" />
          <button className="icon" onClick={props.onClose} aria-label="Cancel">
            ×
          </button>
        </header>
        <div className="filter-row">
          <input className="filter" autoFocus placeholder="Filter recent projects" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={() => setBrowsing(true)}>
            Browse…
          </button>
        </div>
        {err && <p className="error pad">{err}</p>}
        <ul className="list scroll">
          {recent.map((f) => (
            <li key={f.path} className="item" onClick={() => pick(f.path)}>
              <div className="item-main">
                <div className="item-title">
                  <b>{baseName(f.path)}</b>
                  <span className="faint small"> {parentPath(f.path)}</span>
                </div>
                <div className="faint small ellipsis">
                  {f.sessions} session{f.sessions === 1 ? '' : 's'}
                  {latest(f.path) ? ' · ' + latest(f.path)!.title : ''}
                </div>
              </div>
              <span className="faint small">{ago(f.updated)}</span>
            </li>
          ))}
          {!recent.length && <li className="faint pad">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  )
}

type Listing = { path: string; parent?: string; dirs: string[]; changed?: Record<string, string> }

// How Browse sorts, remembered on this device.
const sortKey = 'dakort.browseSort'

// Browse walks the disk one folder at a time from the home folder, or from
// a path pasted in (the quick way on a phone).
function Browse(props: { onPick: (path: string) => void; onBack: () => void; onClose: () => void; err: string }) {
  const [list, setList] = useState<Listing | null>(null)
  const [typed, setTyped] = useState('')
  const [err, setErr] = useState('')
  const [byDate, setByDate] = useState(() => localStorage.getItem(sortKey) === 'date')
  // naming is the new folder's name while it is being typed, null otherwise.
  const [naming, setNaming] = useState<string | null>(null)
  const sortBy = (date: boolean) => {
    setByDate(date)
    localStorage.setItem(sortKey, date ? 'date' : 'name')
  }
  const changed = (d: string) => list?.changed?.[d] ?? ''
  const dirs = !list ? [] : byDate ? [...list.dirs].sort((a, b) => changed(b).localeCompare(changed(a))) : list.dirs
  const go = async (path: string) => {
    try {
      const l = await getJSON<Listing>('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''))
      setList(l)
      setTyped(l.path)
      setErr('')
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }
  useEffect(() => {
    go('')
  }, [])
  // A new folder is made where Browse stands and then entered, so Open as
  // project is one tap away.
  const make = async () => {
    if (!list || !naming?.trim()) return
    try {
      const { path } = await api.mkdir(list.path, naming)
      setNaming(null)
      go(path)
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }
  const sep = list?.path.includes('\\') ? '\\' : '/'
  const join = (name: string) => (list!.path.endsWith(sep) ? list!.path + name : list!.path + sep + name)
  return (
    <div className="sheet-back" onClick={props.onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <header className="bar">
          <button className="icon" onClick={props.onBack} aria-label="Back to recent projects">
            ‹
          </button>
          <b>Browse</b>
          <span className="grow" />
          <button className="icon" onClick={props.onClose} aria-label="Cancel">
            ×
          </button>
        </header>
        <form
          className="filter-row"
          onSubmit={(e) => {
            e.preventDefault()
            go(typed.trim())
          }}
        >
          {/* Up sits by the path, always in sight; a "‹ parent" row at the
              top of the list scrolled away and went unnoticed. */}
          <button
            className="btn up"
            type="button"
            disabled={!list?.parent}
            onClick={() => list?.parent && go(list.parent)}
            aria-label="Up one folder"
            title={list?.parent ? 'Up to ' + (baseName(list.parent) || list.parent) : 'At the top'}
          >
            ↑
          </button>
          <input className="filter" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Paste a folder path" />
          <button className="btn" type="submit">
            Go
          </button>
        </form>
        {(err || props.err) && <p className="error pad">{err || props.err}</p>}
        <div className="sort-row small">
          <span className="faint">Sort:</span>
          <button className={'chip-btn' + (byDate ? '' : ' on')} onClick={() => sortBy(false)}>
            A–Z
          </button>
          <button className={'chip-btn' + (byDate ? ' on' : '')} onClick={() => sortBy(true)}>
            Recently changed
          </button>
          <span className="grow" />
          <button className="chip-btn" disabled={!list || naming !== null} onClick={() => setNaming('')}>
            + New folder
          </button>
        </div>
        {naming !== null && (
          <form
            className="filter-row new-folder"
            onSubmit={(e) => {
              e.preventDefault()
              make()
            }}
          >
            <input
              className="filter"
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNaming(null))}
              placeholder={'New folder in ' + (baseName(list?.path ?? '') || list?.path)}
              aria-label="New folder name"
            />
            <button className="btn primary" type="submit" disabled={!naming.trim()}>
              Create
            </button>
            <button className="btn" type="button" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </form>
        )}
        <ul className="list scroll">
          {dirs.map((d) => (
            <li key={d} className="item browse-dir" onClick={() => go(join(d))}>
              <FolderIcon />
              <span className="grow ellipsis">{d}</span>
              <span className="faint small">{ago(changed(d))}</span>
              <span className="faint">›</span>
            </li>
          ))}
          {list && !list.dirs.length && <li className="faint pad">No folders inside.</li>}
        </ul>
        {list && (
          <div className="sheet-foot">
            <span className="ellipsis faint small grow">{list.path}</span>
            <button className="btn primary" onClick={() => props.onPick(list.path)}>
              Open as project
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
