import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { activate, scrolledEdge } from './a11y'
import { tipPath } from './FolderBar'
import { api, getJSON } from './api'
import { ago, baseName, folderHash, parentPath } from './route'
import { CloseIcon, FolderIcon, Icon, ProjectIcon, SearchIcon } from './icons'
import { releasesURL } from './config'
import { refreshLists, useStore } from './store'
import { ErrorMark } from './ToolView'
import type { Folder, Session } from './types'
import { Button } from '@/components/ui/button'
import { sheetBack, sheetPanel } from '@/lib/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { crumbs } from './crumbs'
import { SortMenu } from './SortMenu'

// Problem is a failure in words: what could not be done, in the app's own
// sentence, with the server's reason under it and a Try again when the
// same thing can simply be asked again. (The raw reason alone, in red,
// read as a log line.)
export type Fault = { title: string; why: string }
export function Problem({ title, why, retry, className }: Fault & { retry?: () => void; className?: string }) {
  return (
    <div className={'notice error problem' + (className ? ' ' + className : '')} role="alert">
      <div className="notice-row">
        <ErrorMark />
        <div className="notice-text">
          <div className="notice-title">{title}</div>
          {why && <div className="notice-why">{why}</div>}
        </div>
      </div>
      {retry && (
        <div className="notice-actions">
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}
const reason = (e: unknown) => String(e instanceof Error ? e.message : e)

// Open project and Browse are one dialog with two views: the same height
// on a laptop, so going to Browse and back does not move it (a class, as
// the panel's own height is a utility the stylesheet's layer cannot beat).
const OPEN_SHEET = 'open-sheet min-[900px]:h-[min(40rem,85dvh)]'

// openProject opens a folder as a project and goes to it.
export async function openProject(path: string) {
  const { path: opened } = await api.openFolder(path)
  refreshLists()
  location.hash = folderHash(opened)
}

// ProjectRow is a folder not open yet, as the Open project sheet and the
// empty home page list it: the name and its age, then the session count
// and the latest session's title. The parent folder joins that line only
// when two rows share a name (the same parent on every row said nothing);
// the whole path is in the row's tip.
export function ProjectRow({ f, latest, showPath, onPick }: { f: Folder; latest?: Session; showPath?: boolean; onPick: (path: string) => void }) {
  return (
    <li className="item project-row" role="button" tabIndex={0} data-tip={tipPath(f.path)} data-tip-place="below" onKeyDown={activate(() => onPick(f.path))} onClick={() => onPick(f.path)}>
      <ProjectIcon />
      <div className="item-main">
        <div className="item-line">
          <span className="item-title ellipsis">{baseName(f.path)}</span>
          <span className="faint small age">{ago(f.updated)}</span>
        </div>
        <div className="faint small ellipsis">
          {showPath ? 'in ' + baseName(parentPath(f.path)) + ' · ' : ''}
          {f.sessions} session{f.sessions === 1 ? '' : 's'}
          {latest ? ' · ' + latest.title : ''}
        </div>
      </div>
    </li>
  )
}

// OpenFolder lists every folder Claude has sessions in that is not open
// yet, and can browse the disk for one that has none.
export function OpenFolder(props: { onClose: () => void }) {
  const folders = useStore((s) => s.folders)
  const sessions = useStore((s) => s.sessions)
  const build = useStore((s) => s.build) // the one place the version shows, with the projects header's tooltip
  const [q, setQ] = useState('')
  const [err, setErr] = useState<Fault | null>(null)
  const [browsing, setBrowsing] = useState(false)
  // On a phone the sheet is as tall as its rows until the filter is
  // tapped; then it takes the tall size and keeps it, so the keyboard
  // does not cover it and typing does not shrink it under the keys.
  const [typing, setTyping] = useState(false)
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const needle = q.trim().toLowerCase()
  const recent = folders.filter((f) => !f.open && !f.missing && (!needle || f.path.toLowerCase().includes(needle)))
  const latest = (path: string) => sessions.find((s) => s.folder === path)
  const pick = async (path: string) => {
    try {
      await openProject(path)
      props.onClose()
    } catch (e) {
      setErr({ title: 'Could not open that project.', why: reason(e) })
    }
  }
  if (browsing) return <Browse onPick={pick} onBack={() => setBrowsing(false)} onClose={props.onClose} err={err} />
  return (
    <div className={sheetBack()} onClick={props.onClose}>
      <div className={sheetPanel({ tall: typing || !coarse, className: OPEN_SHEET })} role="dialog" aria-label="Open project" ref={scrolledEdge} onClick={(e) => e.stopPropagation()}>
        <header className="bar">
          <b>Open project</b>
          <span className="grow" />
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={props.onClose} aria-label="Cancel">
            <CloseIcon />
          </Button>
        </header>
        <div className="filter-row">
          <span className="filter-box">
            <SearchIcon />
            <Input className="filter h-8 pl-[calc(var(--sp-3)+var(--icon)+var(--sp-3)-1px)]" type="search" autoFocus={!coarse} onFocus={() => setTyping(true)} placeholder="Filter recent projects" aria-label="Filter recent projects" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
          <Button variant="outline" size="sm" onClick={() => setBrowsing(true)}>
            Browse…
          </Button>
        </div>
        {err && <Problem {...err} className="in-sheet" />}
        <ul className="list scroll">
          {recent.map((f) => (
            <ProjectRow key={f.path} f={f} latest={latest(f.path)} showPath={recent.some((g) => g !== f && baseName(g.path) === baseName(f.path))} onPick={pick} />
          ))}
          {!recent.length && <li className="faint pad">Nothing matches.</li>}
        </ul>
        {build && (
          <div className="sheet-foot">
            <span className="sheet-version faint small">
              <a href={releasesURL} target="_blank" rel="noopener noreferrer">
                Dakort {build}
              </a>
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

type Listing = { path: string; parent?: string; dirs: string[]; changed?: Record<string, string> }

// How Browse sorts, remembered on this device.
const sortKey = 'dakort.browseSort'

// Browse walks the disk one folder at a time from the home folder, or from
// a path pasted in (the quick way on a phone).
function Browse(props: { onPick: (path: string) => void; onBack: () => void; onClose: () => void; err: Fault | null }) {
  const [list, setList] = useState<Listing | null>(null)
  // editing is the path being typed in place of the breadcrumb, null
  // while the breadcrumb shows.
  const [editing, setEditing] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const selectAll = useRef(false)
  const edit = (value: string, all: boolean) => {
    selectAll.current = all
    setEditing(value)
  }
  // Just opened: the whole path selected (typing replaces it), or the
  // caret after the key that opened it.
  const opened = editing !== null
  useLayoutEffect(() => {
    const f = field.current
    if (!opened || !f) return
    f.focus()
    if (selectAll.current) f.select()
    else f.setSelectionRange(f.value.length, f.value.length)
  }, [opened])
  // A key on the breadcrumb: a character starts a path with it, Enter or
  // F2 edits this one, Backspace goes up a folder.
  const crumbKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !list) return
    const onStep = (e.target as HTMLElement).tagName === 'BUTTON'
    if (e.key.length === 1 && !(e.key === ' ' && onStep)) {
      e.preventDefault()
      edit(e.key, false)
    } else if (e.key === 'F2' || (e.key === 'Enter' && !onStep)) {
      e.preventDefault()
      edit(list.path, true)
    } else if (e.key === 'Backspace' && up && !busy) {
      e.preventDefault()
      go(up)
    }
  }
  // A long path shows its end, where Browse stands.
  useLayoutEffect(() => {
    if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth
  })
  const [err, setErr] = useState<(Fault & { retry?: () => void }) | null>(null)
  // slow is true while a listing has taken more than a moment (a big
  // folder's dates are looked for inside it): it says so, and Up waits.
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [makeErr, setMakeErr] = useState('')
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
    setBusy(true)
    const t = window.setTimeout(() => setSlow(true), 300)
    try {
      const l = await getJSON<Listing>('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''))
      setList(l)
      setErr(null)
    } catch (e) {
      setErr({ title: 'Could not read that folder.', why: reason(e), retry: () => go(path) })
    } finally {
      clearTimeout(t)
      setBusy(false)
      setSlow(false)
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
      setMakeErr('')
      go(path)
    } catch (e) {
      setMakeErr(reason(e))
    }
  }
  const sep = list?.path.includes('\\') ? '\\' : '/'
  const join = (name: string) => (list!.path.endsWith(sep) ? list!.path + name : list!.path + sep + name)
  // At the top of the disk there is nowhere up to go: no parent, or one
  // that is the folder itself (a drive's root).
  const up = list?.parent && list.parent !== list.path ? list.parent : ''
  return (
    <div className={sheetBack()} onClick={props.onClose}>
      <div className={sheetPanel({ tall: true, className: OPEN_SHEET })} role="dialog" aria-label="Browse" ref={scrolledEdge} onClick={(e) => e.stopPropagation()}>
        <header className="bar">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={props.onBack} aria-label="Back to recent projects">
            <Icon name="chevron-left" />
          </Button>
          <b>Browse</b>
          <span className="grow" />
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={props.onClose} aria-label="Cancel">
            <CloseIcon />
          </Button>
        </header>
        {/* The path as a breadcrumb: a step goes there, its empty end (or
            a key typed on it) turns it into a field, Enter goes, Escape
            cancels. Sort and New folder sit on its right. */}
        <div className="crumb-row">
          {editing !== null ? (
            <form
              className="crumb-edit"
              onSubmit={(e) => {
                e.preventDefault()
                const to = editing.trim()
                setEditing(null)
                if (to) go(to)
              }}
            >
              <Input
                className="filter h-8"
                ref={field}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEditing(null))}
                onBlur={() => setEditing(null)}
                placeholder="Paste a folder path"
                aria-label="Folder path"
                name="path"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
            </form>
          ) : (
            <div className="crumbs" role="group" aria-label="Folder path" data-path={list?.path ?? ''} tabIndex={-1} ref={strip} onKeyDown={crumbKey}>
              {crumbs(list?.path ?? '').map((c, i, all) => (
                <Fragment key={c.path}>
                  {i > 0 && <Icon name="chevron-right" sm className="crumb-sep" />}
                  <button
                    type="button"
                    className={cn('crumb', i === all.length - 1 && 'here')}
                    aria-current={i === all.length - 1 ? 'location' : undefined}
                    disabled={busy}
                    onClick={() => (i < all.length - 1 ? go(c.path) : edit(c.path, true))}
                  >
                    {c.label}
                  </button>
                </Fragment>
              ))}
              <button type="button" className="crumb-end" aria-label="Type a folder path" onClick={() => edit(list?.path ?? '', true)} />
            </div>
          )}
          <SortMenu byName={!byDate} onChange={(name) => sortBy(!name)} size="icon-sm" className="size-8" />
          <Button variant="ghost" size="icon-sm" className="size-8 text-muted-foreground hover:text-foreground" disabled={!list || naming !== null} onClick={() => setNaming('')} aria-label="New folder" title="New folder">
            <Icon name="folder-plus" />
          </Button>
        </div>
        {(err ?? props.err) && <Problem {...(err ?? props.err)!} className="in-sheet" />}
        {naming !== null && (
          <form
            className="filter-row new-folder"
            onSubmit={(e) => {
              e.preventDefault()
              make()
            }}
          >
            <Input
              className="filter h-7 text-sm"
              autoFocus
              value={naming}
              onChange={(e) => (setNaming(e.target.value), setMakeErr(''))}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNaming(null))}
              placeholder="Folder name"
              aria-label="New folder name"
            />
            <Button variant="default" size="sm" className="h-7 px-2.5 text-xs" type="submit" disabled={!naming.trim()}>
              Create
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground" type="button" onClick={() => (setNaming(null), setMakeErr(''))}>
              Cancel
            </Button>
          </form>
        )}
        {naming !== null && makeErr && <Problem title="Could not make the folder." why={makeErr} className="in-sheet" />}
        <ul className="list scroll" aria-busy={busy}>
          {slow && <li className="faint pad">Loading…</li>}
          {dirs.map((d) => (
            <li key={d} className="item browse-dir" role="button" tabIndex={0} onKeyDown={activate(() => go(join(d)))} onClick={() => go(join(d))}>
              <FolderIcon />
              <span className="grow ellipsis">{d}</span>
              <span className="faint small">{ago(changed(d))}</span>
              <Icon name="chevron-right" sm className="faint" />
            </li>
          ))}
          {list && !slow && !list.dirs.length && <li className="faint pad">No folders inside.</li>}
        </ul>
        {list && (
          <div className="sheet-foot justify-end">
            <Button variant="default" size="sm" onClick={() => props.onPick(list.path)}>
              Open as project
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
