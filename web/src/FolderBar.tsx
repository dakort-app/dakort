import { Fragment, useRef, useState, type ReactNode } from 'react'
import { api, HTTPError, postJSON } from './api'
import { StreamDot } from './Home'
import { MoonIcon, PlusIcon, SunIcon } from './icons'
import { busy, tasksTitle } from './live'
import { followMoves, isUnread, sameFolder } from './local'
import { OpenFolder } from './OpenFolder'
import { baseName, folderHash } from './route'
import { refreshLists, useStore } from './store'
import { isDark, setDark } from './theme'
import type { Folder, LeftoverRef } from './types'

// The open folders: switching, opening and closing them all happen here,
// there is no folder page and no top bar. They are a list at the top of
// the explorer (on a phone, its drawer); with the explorer hidden nothing
// takes their place but a dot on the explorer's button when another folder
// has activity. Each carries a dot: working (a turn running) or finished
// and not yet seen. Sorted by name, so rows do not jump around as sessions
// get activity.

// Rows the explorer's list shows before "+N more": the current folder and
// the most recently active others.
const maxRows = 3
const foldedKey = 'dakort.foldersFolded'

function useFolders(current: string) {
  const folders = useStore((s) => s.folders)
  const sessions = useStore((s) => s.sessions)
  const live = useStore((s) => s.live)
  const [picking, setPicking] = useState(false)

  const open = folders
    .filter((f) => (f.open && !f.missing) || f.path === current)
    .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path), undefined, { sensitivity: 'base' }))
  const state = (f: Folder) => {
    const mine = sessions.filter((s) => sameFolder(s.folder, f.path))
    if (mine.some((s) => live.turns[s.id])) return 'run'
    if (f.path !== current && mine.some(isUnread)) return 'unread'
    if (mine.some((s) => busy(live, s.id))) return 'tasks'
    return ''
  }
  const dot = (f: Folder) => {
    const st = state(f)
    return st ? <span className={'dot ' + st} title={titles[st as Activity]} /> : <span className="dot" />
  }
  const go = (f: Folder) => {
    if (f.path !== current) location.hash = folderHash(f.path)
  }
  // Closing only takes a folder off the list (on every device); it comes
  // back by itself when one of its sessions has new activity. Closing the
  // current one moves to a neighbour, or home when it was the last.
  const close = async (f: Folder) => {
    const i = open.indexOf(f)
    const next = open[i + 1] ?? open[i - 1]
    if (f.path === current && next) location.hash = folderHash(next.path)
    try {
      await api.closeFolder(f.path)
    } finally {
      // home only once the list says closed, or it would come straight back
      await refreshLists()
      if (f.path === current && !next) location.hash = '#/'
    }
  }
  // Renaming the folder itself, on disk; its sessions follow (move.go).
  // Double-click or right-click on a laptop, a long press on a phone, as
  // with tabs.
  const [renaming, setRenaming] = useState('')
  // A refusal names the processes a turn left running in the folder, if
  // that is what blocks it, each with a Stop that ends it and tries again.
  const [renameError, setRenameError] = useState<{ path: string; name: string; msg: string; leftovers?: LeftoverRef[] } | null>(null)
  const press = useRef(0)
  const startRename = (f: Folder) => {
    setRenameError(null)
    setRenaming(f.path)
  }
  const rename = async (f: Folder, name: string) => {
    setRenaming('')
    if (!name.trim() || name.trim() === baseName(f.path)) return
    try {
      const { path } = await api.renameFolder(f.path, name)
      followMoves([{ from: f.path, to: path }])
      if (f.path === current) location.replace(folderHash(path))
    } catch (e) {
      const leftovers = e instanceof HTTPError && Array.isArray(e.body.leftovers) ? (e.body.leftovers as LeftoverRef[]) : undefined
      setRenameError({ path: f.path, name, msg: e instanceof Error ? e.message : String(e), leftovers })
    }
    await refreshLists()
  }
  const stopAndRetry = async (f: Folder, p: LeftoverRef, name: string) => {
    try {
      await postJSON(`/api/sessions/${p.session}/leftovers/${p.pid}/stop`, {})
    } catch (e) {
      setRenameError({ path: f.path, name, msg: e instanceof Error ? e.message : String(e) })
      return
    }
    setRenameError(null)
    await rename(f, name)
  }
  const row = (f: Folder, after?: () => void) => (
    <Fragment key={f.path}>
    <div
      className={'folder-row' + (f.path === current ? ' on' : '')}
      onClick={() => {
        if (renaming === f.path) return
        after?.()
        go(f)
      }}
      onDoubleClick={() => startRename(f)}
      onContextMenu={(e) => {
        e.preventDefault()
        startRename(f)
      }}
      onTouchStart={() => (press.current = window.setTimeout(() => startRename(f), 550))}
      onTouchEnd={() => clearTimeout(press.current)}
      onTouchMove={() => clearTimeout(press.current)}
      title={f.path + '\n(double-click to rename the folder)'}
    >
      {dot(f)}
      {renaming === f.path ? (
        <input
          className="tab-rename grow"
          autoFocus
          defaultValue={baseName(f.path)}
          aria-label="New folder name"
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename(f, e.currentTarget.value)
            if (e.key === 'Escape') setRenaming('')
          }}
          onBlur={() => setRenaming('')}
        />
      ) : (
        <span className="ellipsis grow">{baseName(f.path)}</span>
      )}
      <span
        className="folder-x"
        role="button"
        aria-label={'Close project ' + baseName(f.path)}
        title="Close project"
        onClick={(e) => {
          e.stopPropagation()
          after?.()
          close(f)
        }}
      >
        ×
      </span>
    </div>
    {renameError?.path === f.path && (
      <div className="folder-error small" role="alert">
        <div className="row">
          <span className="grow">{renameError.msg}</span>
          <span className="folder-x" role="button" aria-label="Dismiss" onClick={() => setRenameError(null)}>
            ×
          </span>
        </div>
        {renameError.leftovers?.map((p) => (
          <div key={p.session + p.pid} className="row leftover" title={[p.command, p.started && 'since ' + new Date(p.started).toLocaleString()].filter(Boolean).join('\n')}>
            <span className="ellipsis grow">
              {p.name}
              {p.title ? <span className="faint"> · {p.title}</span> : null}
            </span>
            <button className="btn small-btn" onClick={() => stopAndRetry(f, p, renameError.name)} title="End it and rename again">
              Stop
            </button>
          </div>
        ))}
      </div>
    )}
    </Fragment>
  )
  const sheet = picking && <OpenFolder onClose={() => setPicking(false)} />
  return { open, state, row, sheet, pick: () => setPicking(true) }
}

// FolderList is the sidebar's "Projects" section: a header (folds it,
// opens another project; hide is the sidebar's hide button, last at the
// right) over the rows.
export function FolderList({ current, hide }: { current: string; hide?: ReactNode }) {
  const { open, state, row, sheet, pick } = useFolders(current)
  const [folded, setFolded] = useState(() => localStorage.getItem(foldedKey) === '1')
  const [all, setAll] = useState(false)
  const fold = () => {
    setFolded(!folded)
    localStorage.setItem(foldedKey, folded ? '0' : '1')
  }

  // Which rows show goes by latest activity, so the folders in use stay in
  // sight; the rows themselves stay in name order.
  // A "1 more" row would take the space of the folder it hides, so fold
  // only when at least two would be hidden.
  // A folder with a turn or background tasks running always shows, so its
  // dot does not hide behind "N more" (where a still dot read as finished
  // work).
  let shown = open
  if (!all && open.length > maxRows + 1) {
    const working = (f: Folder) => f.path !== current && (state(f) === 'run' || state(f) === 'tasks')
    const recent = open
      .filter((f) => f.path !== current && !working(f))
      .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
      .slice(0, Math.max(0, maxRows - 1 - open.filter(working).length))
    shown = open.filter((f) => f.path === current || working(f) || recent.includes(f))
  }
  const hidden = open.filter((f) => !shown.includes(f))
  const elsewhere = others(open, current, state)

  return (
    <div className="folder-list">
      <div className="panel-head">
        <button className="fold" onClick={fold} aria-expanded={!folded}>
          <span className="small faint explorer-title">PROJECTS</span>
          <span className="faint">{folded ? '▸' : '▾'}</span>
        </button>
        {folded && elsewhere && <ActivityDot st={elsewhere} />}
        <span className="grow" />
        <ThemeButton />
        <StreamDot />
        <button className="icon" onClick={pick} aria-label="Open project" title="Open project">
          <PlusIcon />
        </button>
        {hide}
      </div>
      {!folded && (
        <>
          {shown.map((f) => row(f))}
          {hidden.length > 0 && (
            <div className="folder-row more" onClick={() => setAll(true)}>
              {hidden.some((f) => state(f)) ? <span className="dot unread" title="finished, not seen" /> : <span className="dot" />}
              {hidden.length} more…
            </div>
          )}
          {all && open.length > maxRows + 1 && (
            <div className="folder-row more" onClick={() => setAll(false)}>
              <span className="dot" />
              Fewer
            </div>
          )}
        </>
      )}
      <ReleaseNotice />
      {sheet}
    </div>
  )
}

// ReleaseNotice says a newer release is out, once the server has heard of
// one (a release event, or the snapshot), with the line to run on the
// computer. Under the folder list, so every device sees it and it never
// covers the work.
function ReleaseNotice() {
  const latest = useStore((s) => s.latest)
  if (!latest) return null
  return (
    <div className="notice info release">
      Dakort {latest} is out. On the computer: <code>dakort update</code>
    </div>
  )
}

// ThemeButton switches light and dark, remembered on this device. It
// shows what a tap gives: the moon in light, the sun in dark.
function ThemeButton() {
  const [dark, setDarkState] = useState(isDark)
  return (
    <button
      className="icon theme-btn"
      onClick={() => {
        setDark(!dark)
        setDarkState(!dark)
      }}
      aria-label={dark ? 'Switch to light' : 'Switch to dark'}
      title={dark ? 'Switch to light' : 'Switch to dark'}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

// What the other open folders are doing: 'run' when a turn runs in one
// (it wins: it is what "is it still working?" asks), 'unread' when one
// has finished work not yet seen, 'tasks' when only background tasks run
// in one, else ''.
type Activity = '' | 'run' | 'unread' | 'tasks'
const titles: Record<Activity, string> = { '': '', run: 'working', unread: 'finished, not seen', tasks: tasksTitle }
function others(open: Folder[], current: string, state: (f: Folder) => string): Activity {
  const rest = open.filter((f) => f.path !== current).map(state)
  return rest.includes('run') ? 'run' : rest.includes('unread') ? 'unread' : rest.includes('tasks') ? 'tasks' : ''
}

// The dot for the other folders, where they are out of sight: pulsing while
// one works, a ring while only background tasks run, still once one has
// finished.
export function ActivityDot({ st }: { st: Activity }) {
  if (!st) return null
  return <span className={'dot ' + st} title={titles[st] + ' (another project)'} />
}

// With the explorer hidden, a dot on its button says the same.
export function useOtherActivity(current: string): Activity {
  const { open, state } = useFolders(current)
  return others(open, current, state)
}
