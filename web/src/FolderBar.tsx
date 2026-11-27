import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { activate } from './a11y'
import { api, HTTPError, postJSON } from './api'
import { releasesURL, useConfig } from './config'
import { StreamDot } from './Home'
import { Mark } from './mark'
import { CloseIcon, CopyIcon, DevicesIcon, Icon, MoonIcon, PencilIcon, PlusIcon, ProjectIcon, SettingsIcon, TerminalIcon } from './icons'
import { copyText } from './clip'
import { keepInView } from './PopMenu'
import { busy, tasksTitle, working } from './live'
import { followMoves, isUnread, sameFolder } from './local'
import { OpenFolder } from './OpenFolder'
import { baseName, folderHash } from './route'
import { refreshLists, useStore } from './store'
import { isDark, setDark } from './theme'
import { ErrorMark } from './ToolView'
import type { Folder, LeftoverRef } from './types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { menuItem, menuLabel, menuSeparator, menuShortcut, menuSurface } from '@/lib/menu'
import { SwitchLook } from '@/lib/switch'
import { toastClass } from '@/lib/toast'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

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
    if (mine.some((s) => live.turns[s.id]?.permissions.length)) return 'needs'
    if (mine.some((s) => working(live, s.id))) return 'run'
    if (f.path !== current && mine.some((s) => isUnread(s) && failed(live.ended[s.id]))) return 'fail'
    if (f.path !== current && mine.some(isUnread)) return 'unread'
    if (mine.some((s) => busy(live, s.id))) return 'tasks'
    return ''
  }
  // The row's state goes in its trailing slot, the one column every
  // project row and the file tree's change letters share (VS Code's
  // decorations); the folder mark stays in the lead, so every row starts
  // the same. The close × takes the slot under the pointer.
  const mark = (f: Folder) => {
    const st = state(f)
    return st ? <span className={'dot ' + st} role="img" aria-label={titles[st as Activity]} /> : null
  }
  const lead = <span className="lead"><ProjectIcon /></span>
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
    setRowMenu(null)
    setRenaming(f.path)
  }
  // A row's menu (right-click, or a long press on a phone): the whole
  // path on top, then Rename, Copy path and Close. A phone has no hover to
  // show the path, and a long press used to rename at once.
  const [rowMenu, setRowMenu] = useState<{ f: Folder; at: DOMRect } | null>(null)
  const [copied, setCopied] = useState('')
  useEffect(() => {
    if (!rowMenu) return
    const off = (e: Event) => !(e.target as HTMLElement).closest?.('.row-menu') && setRowMenu(null)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setRowMenu(null)
    addEventListener('pointerdown', off, true)
    addEventListener('keydown', esc)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('keydown', esc)
    }
  }, [rowMenu])
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(''), 2500)
    return () => clearTimeout(t)
  }, [copied])
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
      className={cn('folder-row', 'rounded-md text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground', f.path === current && 'on bg-sidebar-accent font-medium text-sidebar-accent-foreground')}
      role="button"
      tabIndex={0}
      aria-current={f.path === current || undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'F2') return startRename(f)
        activate(() => (after?.(), go(f)))(e)
      }}
      onClick={() => {
        if (renaming === f.path) return
        after?.()
        go(f)
      }}
      onDoubleClick={() => startRename(f)}
      onContextMenu={(e) => {
        e.preventDefault()
        clearTimeout(press.current)
        setRowMenu({ f, at: e.currentTarget.getBoundingClientRect() })
      }}
      onTouchStart={(e) => {
        const el = e.currentTarget
        press.current = window.setTimeout(() => renaming !== f.path && setRowMenu({ f, at: el.getBoundingClientRect() }), 500)
      }}
      onTouchEnd={() => clearTimeout(press.current)}
      onTouchMove={() => clearTimeout(press.current)}
      aria-keyshortcuts="F2"
    >
      {lead}
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
      {/* Under the pointer on a laptop; always there, quietly, on a touch
          screen, which has no hover to bring it out. */}
      <span className="row-end">
        {mark(f)}
        <button
          className="folder-x"
          aria-label={'Close project ' + baseName(f.path)}
          title="Close"
          onClick={(e) => {
            e.stopPropagation()
            after?.()
            close(f)
          }}
        >
          <CloseIcon sm />
        </button>
      </span>
    </div>
    {renameError?.path === f.path && (
      <div className="folder-error small" role="alert">
        <div className="row">
          <ErrorMark />
          <span className="grow">
            <span className="folder-error-title">Could not rename the folder.</span> {renameError.msg}
          </span>
          <button className="folder-x" aria-label="Dismiss" onClick={() => setRenameError(null)}>
            <CloseIcon sm />
          </button>
        </div>
        {renameError.leftovers?.map((p) => (
          <div key={p.session + p.pid} className="row leftover">
            <span className="ellipsis grow">
              {p.name}
              {p.title ? <span className="faint"> · {p.title}</span> : null}
            </span>
            <Button variant="outline" size="xs" onClick={() => stopAndRetry(f, p, renameError.name)}>
              Stop
            </Button>
          </div>
        ))}
      </div>
    )}
    </Fragment>
  )
  const menu = rowMenu && (
    <div
      className={cn('tab-menu row-menu', menuSurface, 'fixed z-30 flex min-w-48 flex-col slide-in-from-top-2')}
      role="menu"
      aria-label={baseName(rowMenu.f.path)}
      ref={keepInView}
      style={{ left: Math.max(8, Math.min(rowMenu.at.left, innerWidth - 268)), top: rowMenu.at.bottom + 4, width: Math.min(260, innerWidth - 16) }}
    >
      <div className={cn('menu-title', menuLabel)}>{rowMenu.f.path}</div>
      <button className={menuItem} role="menuitem" onClick={() => startRename(rowMenu.f)}>
        <PencilIcon />
        <span className="grow">Rename</span>
        <kbd className={menuShortcut}>F2</kbd>
      </button>
      <button
        className={menuItem}
        role="menuitem"
        onClick={() => {
          const path = rowMenu.f.path
          setRowMenu(null)
          copyText(path).then((ok) => setCopied(ok ? 'Copied the path' : 'Copy failed'))
        }}
      >
        <CopyIcon />
        Copy path
      </button>
      <div role="separator" className={menuSeparator} />
      <button className={menuItem} role="menuitem" onClick={() => (setRowMenu(null), close(rowMenu.f))}>
        <CloseIcon />
        Close project
      </button>
    </div>
  )
  const sheet = (
    <>
      {picking && <OpenFolder onClose={() => setPicking(false)} />}
      {menu}
      {copied && (
        <div className={toastClass} role="status">
          {copied}
        </div>
      )}
    </>
  )
  return { open, state, row, sheet, pick: () => setPicking(true) }
}

// FolderList is the sidebar's "Projects" section: a header (hide first,
// where the show button sits once hidden, so the toggle does not move;
// the label folds the list; + opens another project) over the rows. Other
// devices and the theme are labelled rows at the sidebar's foot
// (DrawerFoot), on a laptop as on a phone, not bare icons here.
export function FolderList({ current }: { current: string }) {
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
    const working = (f: Folder) => f.path !== current && ['needs', 'run', 'tasks'].includes(state(f))
    const recent = open
      .filter((f) => f.path !== current && !working(f))
      .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
      .slice(0, Math.max(0, maxRows - 1 - open.filter(working).length))
    shown = open.filter((f) => f.path === current || working(f) || recent.includes(f))
  }
  const hidden = open.filter((f) => !shown.includes(f))
  const elsewhere = others(open, current, state)

  return (
    <div className={cn('folder-list', all && 'all')}>
      {/* A section header after VS Code's: the disclosure flush left, the
          title, and its action on the right, shown under the pointer. */}
      <div className="side-head">
        <button className="fold" onClick={fold} aria-expanded={!folded}>
          <Icon name="chevron-right" sm className={'fold-caret' + (folded ? '' : ' open')} />
          <span className="explorer-title">Projects</span>
        </button>
        <StreamDot />
        {/* Folded, the projects' news rides on the header, on the label's
            line (VS Code's badge on a folded section). */}
        {folded && elsewhere && <ActivityDot st={elsewhere} />}
        <span className="grow" />
        <span className="side-actions">
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" onClick={pick} aria-label="Open project" title="Open project">
            <PlusIcon />
          </Button>
        </span>
      </div>
      {!folded && (
        <>
          {shown.map((f) => row(f))}
          {hidden.length > 0 && (
            <div className={cn('folder-row more text-muted-foreground', 'rounded-md text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground')} role="button" tabIndex={0} onKeyDown={activate(() => setAll(true))} onClick={() => setAll(true)}>
              <span className="lead" />
              <span className="grow">{hidden.length} more…</span>
              <span className="row-end">{hidden.some((f) => state(f)) && <ActivityDot st={others(hidden, '', state)} />}</span>
            </div>
          )}
          {all && open.length > maxRows + 1 && (
            <div className={cn('folder-row more text-muted-foreground', 'rounded-md text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground')} role="button" tabIndex={0} onKeyDown={activate(() => setAll(false))} onClick={() => setAll(false)}>
              <span className="lead" />
              Fewer
            </div>
          )}
        </>
      )}
      <VersionLine />
      {sheet}
    </div>
  )
}

// Brand is the sidebar's top line: Dakort's mark and name, quiet, as
// Linear, Cursor and Zed head theirs. On the tab bar's line.
export function Brand() {
  return (
    <div className="brand" aria-hidden="true">
      <Mark />
      <span className="brand-name">Dakort</span>
    </div>
  )
}

// DrawerFoot is the phone drawer's foot: the terminal (the header's room
// goes to the tab's title there) and the settings menu. On a laptop the
// sidebar has no foot, so the file tree keeps the whole height, and the
// settings are a gear at the tab bar's end (Cursor's, VS Code's Manage).
export function DrawerFoot({ onDevices, onTerminal }: { onDevices: () => void; onTerminal: () => void }) {
  const row = cn('foot-row', 'rounded-md text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground')
  return (
    <div className="drawer-foot">
      <button className={row} onClick={onTerminal}>
        <span className="lead">
          <TerminalIcon />
        </span>
        <span className="grow">Terminal</span>
      </button>
      <SettingsMenu onDevices={onDevices} side="top">
        <button className={row}>
          <span className="lead">
            <SettingsIcon />
          </span>
          <span className="grow">Settings</span>
        </button>
      </SettingsMenu>
    </div>
  )
}

// SettingsMenu holds what used to sit at the sidebar's foot: Other devices
// and the theme, then the version, quiet, at the end (Linear's and Claude
// desktop's account menu).
export function SettingsMenu({ onDevices, children, side = 'bottom' }: { onDevices: () => void; children: ReactNode; side?: 'top' | 'bottom' | 'right' }) {
  const [dark, setDarkState] = useState(isDark)
  const build = useStore((s) => s.build)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="end" className="settings-menu min-w-52">
        <DropdownMenuItem onSelect={onDevices}>
          <DevicesIcon />
          Other devices
        </DropdownMenuItem>
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={dark}
          onSelect={(e) => {
            e.preventDefault()
            setDark(!dark)
            setDarkState(!dark)
          }}
        >
          <MoonIcon />
          <span className="grow">Dark mode</span>
          <SwitchLook on={dark} className="ml-4" />
        </DropdownMenuItem>
        {build && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Dakort {build}</DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// tipPath is a path as a tip shows it: a line may break after a slash
// and never at a hyphen (a hyphen at a line's end reads as the
// typesetter's, and is dropped when the path is retyped).
export const tipPath = (p: string) => p.replace(/-/g, '\u2011').replace(/([\\/])/g, '$1\u200b')

// A failed last turn: an error, or a result that says it did not finish.
export function failed(e?: { result?: { ok: boolean }; error?: string }): boolean {
  return !!e && (!!e.error || e.result?.ok === false)
}

// VersionLine, under the folder list, shows only for a server that
// leaves updates to the person (dakort setup -auto-update=false), once
// it has heard of a newer release (a release event, or the snapshot):
// the tag and the line to run on the computer. A server that updates
// itself says nothing here; the version is in the Open project sheet and
// on the PROJECTS header's tooltip. Under the list, so every device sees
// it and it never covers the work.
function VersionLine() {
  const latest = useStore((s) => s.latest)
  const auto = useConfig().autoUpdate
  if (!latest || auto) return null
  return (
    <div className="notice info release">
      Dakort{' '}
      <a href={releasesURL} target="_blank" rel="noopener noreferrer">
        {latest}
      </a>{' '}
      is out. On the computer: <code>dakort update</code>
    </div>
  )
}

// What the other open folders are doing: 'run' when a turn runs in one
// (it wins: it is what "is it still working?" asks), 'unread' when one
// has finished work not yet seen, 'tasks' when only background tasks run
// in one, else ''.
type Activity = '' | 'needs' | 'run' | 'fail' | 'unread' | 'tasks'
const titles: Record<Activity, string> = { '': '', needs: 'Needs you: a permission to answer', run: 'Working', fail: 'Failed, not seen', unread: 'Finished, not seen', tasks: tasksTitle }
function others(open: Folder[], current: string, state: (f: Folder) => string): Activity {
  const rest = open.filter((f) => f.path !== current).map(state)
  return rest.includes('needs') ? 'needs' : rest.includes('run') ? 'run' : rest.includes('fail') ? 'fail' : rest.includes('unread') ? 'unread' : rest.includes('tasks') ? 'tasks' : ''
}

// The dot for the other folders, where they are out of sight: pulsing while
// one works, a ring while only background tasks run, still once one has
// finished.
export function ActivityDot({ st }: { st: Activity }) {
  if (!st) return null
  return <span className={'dot ' + st} role="img" aria-label={titles[st] + ' (another project)'} />
}

// With the explorer hidden, a dot on its button says the same.
export function useOtherActivity(current: string): Activity {
  const { open, state } = useFolders(current)
  return others(open, current, state)
}
