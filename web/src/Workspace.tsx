import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { useLastProvider } from './Composer'
import { Explorer } from './Explorer'
import { FileView, type Jump, type Opener } from './FileView'
import { FolderList, useOtherActivity } from './FolderBar'
import { StreamDot } from './Home'
import { AgentIcon, FileIcon, HistoryIcon, NewChatIcon, SidebarIcon, SplitIcon, UnsplitIcon } from './icons'
import { FILE, providerOf, sameFolder, filesByName, setFilesByName, isUnread, loadTabs, markFresh, markSeen, NEW, saveTabs, setExplorerWidth, setLastFolder, tabsFor, type Tabs, explorerWidth, explorerShown, setExplorerShown, reconcile, flat, folderKey } from './local'
import { loadSharedTabs, shareTabs } from './store'
import { clampRatio, closeTab as closeIn, focusOf, merged, moveTab, pane, selectTab, split, splitBeside, unsplit, withPane, type Pane, type PaneNo } from './local'
import { ago, baseName } from './route'
import { postJSON } from './api'
import { SessionView } from './SessionView'
import { refreshLists, setPlace, useStore } from './store'
import type { Session } from './types'

const wide = () => typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches
// The same, re-rendering when the window crosses the line: a split view
// shows on a laptop only, and a phone (or a narrow window) gets one pane.
const useWide = () =>
  useSyncExternalStore((l) => {
    const m = matchMedia('(min-width: 900px)')
    m.addEventListener('change', l)
    return () => m.removeEventListener('change', l)
  }, wide)

// A folder's workspace, laid out like VS Code with the Claude extension:
// the explorer on the left (a drawer on a phone) and a tab strip where a
// tab is a session or a file. The latest session opens by default; the
// history button adds older ones. On a laptop the editor can split in two
// panes side by side, each with its own tabs (a PDF beside a session, two
// sessions; from a contributor's branch); the explorer and new tabs act on the
// focused pane.
export function Workspace({ folder }: { folder: string }) {
  const sessions = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.loaded)
  const live = useStore((s) => s.live)
  const mine = useMemo(() => sessions.filter((s) => sameFolder(s.folder, folder)), [sessions, folder])
  const all = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions])
  const [saved, setSaved] = useState<Tabs>(() => loadTabs(folder))
  const [history, setHistory] = useState<PaneNo | null>(null)
  const isWide = useWide()
  const newProvider = useLastProvider()
  // On a phone the explorer is a drawer and starts closed. On a laptop,
  // showing or hiding it sticks, also in the next folder.
  const [files, setFilesState] = useState(() => wide() && explorerShown())
  const otherActivity = useOtherActivity(folder)
  const [byName, setByName] = useState(filesByName)
  const sortFiles = (name: boolean) => {
    setByName(name)
    setFilesByName(name)
  }
  const setFiles = (on: boolean) => {
    setFilesState(on)
    if (wide()) setExplorerShown(on)
  }

  // The open tabs are the project's, shared through the server; this
  // browser keeps the view (active tab, split). A new-session tab with a
  // draft typed here stays even when closed elsewhere.
  const shared = useStore((s) => s.tabs[folderKey(folder)])
  useEffect(() => {
    loadSharedTabs(folder)
  }, [folder])
  const hasDraft = (id: string) => id === NEW && !!(localStorage.getItem('made.draft:new:' + folder) || localStorage.getItem('made.draft:new:' + folderKey(folder)))
  // Before the list has loaded, keep the saved tabs as they are.
  const tabs = loaded ? tabsFor(reconcile(saved, shared, hasDraft), mine, (id) => !!live.turns[id], (id) => all.has(id)) : saved
  const update = (t: Tabs) => {
    setSaved(t)
    saveTabs(folder, t)
    shareTabs(folder, flat(t))
  }
  // Keep what tabsFor picked (the latest session, when nothing was open):
  // left unsaved, "latest" was picked again on every render, so a turn in
  // another session made it the newest and the view jumped to it. What it
  // picked, and what reconcile brought in, is the project's list too.
  const tabsKey = JSON.stringify(tabs)
  useEffect(() => {
    if (!loaded) return
    if (tabsKey !== JSON.stringify(saved)) setSaved(tabs)
    saveTabs(folder, tabs)
    if (shared) shareTabs(folder, flat(tabs))
  }, [loaded, folder, tabsKey])

  // Split view: two panes on a laptop. A phone shows one, with every tab
  // in it, on the focused pane's tab; acting there keeps the split for
  // the laptop's next look, except a reorder, which makes one list.
  const splitOn = isWide && !!tabs.right
  const focus = focusOf(tabs)
  const panes: PaneNo[] = splitOn ? [0, 1] : [0]
  const view = (p: PaneNo): Pane => (splitOn ? pane(tabs, p) : merged(tabs))
  const setFocus = (p: PaneNo) => {
    if (splitOn && focus !== p) update(withPane(tabs, p, pane(tabs, p), p))
  }

  useEffect(() => setLastFolder(folder), [folder])
  useEffect(() => {
    setPlace(baseName(folder), folder)
    return () => setPlace('')
  }, [folder])
  // A phone's drawer closes on a switch of folder: the workspace stays
  // mounted, so it was still open over the new folder.
  useEffect(() => {
    if (!wide()) setFilesState(false)
  }, [folder])

  // The bar between the explorer and the editor drags the explorer's width
  // (laptop only; on a phone the explorer is a drawer). Double-click resets.
  // While dragging, the width goes straight onto the page: a render per
  // mouse move re-rendered the whole transcript and fell behind the mouse.
  // It becomes state once, on release.
  const [paneW, setPaneW] = useState(explorerWidth)
  const clamp = (w: number) => Math.max(160, Math.min(w, window.innerWidth * 0.6))
  const resize = (w: number) => {
    setPaneW(clamp(w))
    setExplorerWidth(clamp(w))
  }
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault() // or the drag selects text on its way
    const el = e.currentTarget
    const body = el.parentElement!
    const x0 = e.clientX
    let w = paneW
    el.setPointerCapture(e.pointerId)
    el.onpointermove = (m) => {
      w = clamp(paneW + m.clientX - x0)
      body.style.setProperty('--explorer-w', w + 'px')
    }
    el.onpointerup = el.onpointercancel = () => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null
      resize(w)
    }
  }

  const byId = new Map(mine.map((s) => [s.id, s]))
  // The sessions on screen, one per pane, count as read; a hidden page
  // marks nothing, and reads once it comes back in front.
  const shown = panes.map((p) => byId.get(view(p).active)).filter((s): s is Session => !!s)
  useEffect(() => {
    const mark = () => shown.forEach(markSeen)
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [shown.map((s) => s.id + s.updated).join()])

  // On a phone most tabs are off screen; keep the active one in view, also
  // once the list arrives and the tabs widen to their titles, and when a
  // tab arriving at the front pushes it along.
  useEffect(() => {
    document.querySelectorAll('.tab.active').forEach((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  }, [loaded, tabsKey, splitOn])

  // A tab shows where it is, else opens in the given pane (the focused one).
  const select = (id: string, into?: PaneNo) => update(selectTab(tabs, id, into))
  // Closing counts the session as read, so unread work does not reopen
  // it on every device the next moment; new activity still does.
  const closeTab = (id: string) => {
    const s = byId.get(id)
    if (s) markSeen(s)
    update(closeIn(tabs, id))
  }
  // Open a file tab, optionally at a spot (SyncTeX between .tex and PDF).
  const [jumps, setJumps] = useState<Record<string, Jump>>({})
  const openFile = (path: string, jump?: Parameters<Opener>[1], into?: PaneNo) => {
    select(FILE + path, into)
    if (jump) setJumps((cur) => ({ ...cur, [path]: { ...jump, n: (cur[path]?.n ?? 0) + 1 } }))
    if (!wide()) setFiles(false) // on a phone the file takes the screen
  }
  const focusedActive = view(splitOn ? focus : 0).active
  const activeFile = focusedActive.startsWith(FILE) ? focusedActive.slice(FILE.length) : ''
  // Deleting goes to the server's trash; Undo stays offered for a while.
  const [confirm, setConfirm] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [undo, setUndo] = useState<{ trash: string; title: string; id: string } | null>(null)
  useEffect(() => {
    if (!undo) return
    const t = window.setTimeout(() => setUndo(null), 10_000)
    return () => clearTimeout(t)
  }, [undo])
  const remove = async (s: Session) => {
    setDeleteError('')
    try {
      const r = await postJSON<{ trash: string }>(`/api/sessions/${s.id}/delete`, {})
      setConfirm('')
      setUndo({ trash: r.trash, title: s.title, id: s.id })
      refreshLists()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    }
  }
  const restore = async () => {
    if (!undo) return
    try {
      await postJSON(`/api/trash/${undo.trash}/restore`, {})
      select(undo.id)
      setUndo(null)
      refreshLists()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e))
    }
  }

  // The new-session tab becomes the session once its first send is in,
  // in whichever pane it is.
  const started = (id: string) => {
    markFresh(id)
    const swap = (p: Pane): Pane => ({ ids: p.ids.map((x) => (x === NEW ? id : x)), active: p.active === NEW ? id : p.active })
    update({ ...tabs, ...swap(tabs), ...(tabs.right ? { right: swap(tabs.right) } : {}) })
  }

  // Renaming a session from its tab: double-click (a long press on a
  // phone, or Rename in a laptop's right-click menu) turns the title into
  // a field; Enter names it through the CLI's /rename, Escape or leaving
  // the field keeps the old name. The new name shows at once, until the
  // list carries it.
  const [renaming, setRenaming] = useState('')
  const [named, setNamed] = useState<{ id: string; title: string } | null>(null)
  const [renameError, setRenameError] = useState('')
  const press = useRef(0)
  // Dragging a tab moves it, with a mouse (at any window width): the tab
  // follows the mouse, and on the release it takes the slot its middle is
  // in, wherever the mouse is then (past the last tab too). On a laptop it
  // can also go to the other pane (let go over it), or, with one pane,
  // open to the side (let go over the right half of the content). Plain
  // pointer events: the browser's own drag and drop never delivered the
  // drop here.
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null)
  const [dropHint, setDropHint] = useState<'side' | PaneNo | null>(null)
  const dragTab = (e: PointerEvent, id: string, from: PaneNo) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const x0 = e.clientX
    const strip = (e.currentTarget as HTMLElement).closest('.tabs')
    // the middles of the tabs as they stand
    const middles = (nav: Element | null | undefined) =>
      [...(nav?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])].map((el) => {
        const r = el.getBoundingClientRect()
        return { id: el.dataset.tab!, mid: r.left + r.width / 2 }
      })
    const mids = middles(strip)
    const shownIds = view(from).ids
    // Where a drop at (x, y) would go, besides this strip.
    const target = (x: number, y: number): 'side' | PaneNo | null => {
      if (!wide()) return null
      const under = document.elementFromPoint(x, y)
      const sec = under?.closest<HTMLElement>('[data-pane]')
      if (!sec) return null
      const p = Number(sec.dataset.pane) as PaneNo
      if (splitOn) return p !== from ? p : null
      const main = under?.closest('.ws-main')
      if (!main || shownIds.length < 2) return null
      const r = main.getBoundingClientRect()
      return x > r.left + r.width / 2 ? 'side' : null
    }
    let moved = false
    let hint: 'side' | PaneNo | null = null
    const move = (ev: globalThis.PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 6) return
      if (!moved) document.documentElement.classList.add('tab-dragging') // no text selection on the way
      moved = true
      setDrag({ id, dx: ev.clientX - x0 })
      const h = target(ev.clientX, ev.clientY)
      if (h !== hint) setDropHint((hint = h))
    }
    const up = (ev: globalThis.PointerEvent) => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      setDrag(null)
      setDropHint(null)
      if (!moved) return
      document.documentElement.classList.remove('tab-dragging')
      getSelection()?.removeAllRanges()
      const h = target(ev.clientX, ev.clientY)
      if (h === 'side') return update(split(tabs, id))
      if (h === 0 || h === 1) {
        const there = middles(document.querySelector(`[data-pane="${h}"] .tabs`))
        return update(moveTab(tabs, id, h, there.filter((m) => m.mid < ev.clientX).length))
      }
      const mid = mids.find((m) => m.id === id)!.mid + ev.clientX - x0
      const ids = mids.filter((m) => m.id !== id && m.mid < mid).map((m) => m.id)
      ids.push(id, ...mids.filter((m) => m.id !== id && m.mid >= mid).map((m) => m.id))
      if (ids.join() === shownIds.join()) return
      if (splitOn) update(withPane(tabs, from, { ids, active: pane(tabs, from).active }, from))
      else update({ ids, active: view(0).active, ...(tabs.ratio !== undefined ? { ratio: tabs.ratio } : {}) })
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  // The bar between the panes drags the split (a quarter to three
  // quarters); double-click halves it. Like the explorer's, the width goes
  // straight onto the page while dragging and into state on release.
  const ratio = clampRatio(tabs.ratio ?? 0.5)
  const startPaneDrag = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const body = el.parentElement!
    const a = body.querySelector('[data-pane="0"]')!.getBoundingClientRect()
    const b = body.querySelector('[data-pane="1"]')!.getBoundingClientRect()
    let r = ratio
    el.setPointerCapture(e.pointerId)
    el.onpointermove = (m) => {
      r = clampRatio((m.clientX - a.left) / (b.right - a.left))
      body.style.setProperty('--split', String(r))
    }
    el.onpointerup = el.onpointercancel = () => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null
      update({ ...tabs, ratio: r })
    }
  }

  // A tab's menu (right-click on a laptop): rename, the other pane, close.
  // On a phone a long press still renames.
  const [menu, setMenu] = useState<{ id: string; p: PaneNo; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const off = (e: Event) => !(e.target as HTMLElement).closest?.('.tab-menu') && setMenu(null)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    addEventListener('pointerdown', off, true)
    addEventListener('blur', off)
    addEventListener('keydown', esc)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('blur', off)
      removeEventListener('keydown', esc)
    }
  }, [menu])

  useEffect(() => {
    if (named && byId.get(named.id)?.title === named.title) setNamed(null)
  }, [named, sessions])
  useEffect(() => {
    if (!renameError) return
    const t = window.setTimeout(() => setRenameError(''), 6000)
    return () => clearTimeout(t)
  }, [renameError])
  const canRename = (id: string) => !id.startsWith(FILE) && id !== NEW && byId.has(id)
  const startRename = (id: string) => {
    clearTimeout(press.current)
    if (canRename(id)) setRenaming(id)
  }
  const rename = async (id: string, value: string) => {
    setRenaming('')
    const title = value.trim().replace(/\s+/g, ' ')
    if (!title || title === byId.get(id)?.title) return
    setNamed({ id, title })
    try {
      await postJSON(`/api/sessions/${id}/rename`, { title })
      refreshLists()
    } catch (e) {
      setNamed(null)
      setRenameError('Could not rename: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // What a tab shows, in the strip and in the phone's tab overview.
  const [overview, setOverview] = useState(false)
  const tabLabel = (id: string) =>
    id.startsWith(FILE)
      ? baseName(id.slice(FILE.length))
      : named?.id === id
        ? named.title
        : (byId.get(id)?.title ?? (loaded && id !== NEW && !live.turns[id] ? id.slice(0, 8) : 'New session'))
  const tabDot = (id: string) => {
    const s = byId.get(id)
    if (live.turns[id]) return <span className="dot run" title="working" />
    if (s && !shown.includes(s) && isUnread(s)) return <span className="dot unread" title="finished, not seen" />
    return null
  }
  // Files by their type; sessions by their agent's mark (a new one by the
  // agent its composer will start).
  const tabIcon = (id: string) =>
    id.startsWith(FILE) ? <FileIcon path={id.slice(FILE.length)} /> : <AgentIcon provider={id === NEW ? newProvider : providerOf(id, byId.get(id)?.provider)} />

  // One pane: its tab strip, with the buttons that act on it, and what its
  // active tab shows.
  const renderPane = (p: PaneNo) => {
    const v = view(p)
    const last = p === panes[panes.length - 1]
    const activeFileHere = v.active.startsWith(FILE) ? v.active.slice(FILE.length) : ''
    const session = byId.get(v.active)
    return (
      <section
        key={'pane' + p}
        className={'panel editor-panel' + (splitOn && focus === p ? ' focused' : '') + (dropHint === p ? ' drop-target' : '')}
        data-pane={p}
        onPointerDownCapture={() => setFocus(p)}
        onFocusCapture={() => setFocus(p)}
      >
        <div className="tabs-row">
          {!files && p === 0 && (
            <button className="icon dotted" onClick={() => setFiles(true)} aria-label="Show the sidebar" title="Show projects and files">
              <SidebarIcon />
              {otherActivity && <span className="dot unread" title="activity in another project" />}
            </button>
          )}
          <TabStrip ids={v.ids.join(',')}>
            {v.ids.map((id) => (
              <div
                key={id}
                className={'tab' + (id === v.active ? ' active' : '') + (drag?.id === id ? ' dragging' : '')}
                style={drag?.id === id ? { transform: `translateX(${drag.dx}px)` } : undefined}
                onClick={() => select(id)}
                title={tabLabel(id) + (canRename(id) ? ' (double-click to rename)' : '')}
                onDoubleClick={() => startRename(id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (isWide) setMenu({ id, p, x: e.clientX, y: e.clientY })
                  else startRename(id)
                }}
                data-tab={id}
                onPointerDown={(e) => renaming !== id && dragTab(e, id, p)}
                onTouchStart={() => (press.current = window.setTimeout(() => startRename(id), 550))}
                onTouchEnd={() => clearTimeout(press.current)}
                onTouchMove={() => clearTimeout(press.current)}
              >
                {tabDot(id)}
                {tabIcon(id)}
                {renaming === id ? (
                  <input
                    className="tab-rename"
                    autoFocus
                    defaultValue={tabLabel(id)}
                    aria-label="New name"
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename(id, e.currentTarget.value)
                      if (e.key === 'Escape') setRenaming('')
                    }}
                    onBlur={() => setRenaming('')}
                  />
                ) : (
                  <span className="ellipsis">{tabLabel(id)}</span>
                )}
                <button
                  className="tab-x"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </TabStrip>
          {!splitOn && (
            <button className="tab-count" onClick={() => setOverview(true)} aria-label={`${v.ids.length} open tabs`} title="Open tabs">
              {v.ids.length}
            </button>
          )}
          {isWide && !splitOn && (
            <button
              className="icon split-btn"
              onClick={() => update(splitBeside(tabs))}
              disabled={v.ids.length < 2 && v.active === NEW}
              aria-label="Split the editor"
              title="Split: a new session beside this tab"
            >
              <SplitIcon />
            </button>
          )}
          <button className="icon" onClick={() => setHistory(history === p ? null : p)} aria-label="Session history" title="Session history">
            <HistoryIcon />
          </button>
          <button className="icon" onClick={() => select(NEW, p)} aria-label="New session" title="New session">
            <NewChatIcon />
          </button>
          {splitOn && p === 1 && (
            <button className="icon" onClick={() => update(unsplit(tabs))} aria-label="Close the split" title="Close the split (its tabs move to the left pane)">
              <UnsplitIcon />
            </button>
          )}
          {!files && last && <StreamDot />}
        </div>
        <main className="ws-main">
          {/* Open file tabs stay mounted, hidden when not active, so going
            back and forth between a .tex file and its PDF does not reload
            the PDF each time. */}
          {v.ids
            .filter((id) => id.startsWith(FILE))
            .map((id) => {
              const f = id.slice(FILE.length)
              return (
                <div key={id} className="file-slot" hidden={f !== activeFileHere}>
                  <FileView root={folder} path={f} onOpen={(path, jump) => openFile(path, jump, p)} jump={jumps[f]} active={f === activeFileHere} />
                </div>
              )
            })}
          {activeFileHere ? null : v.active ? (
            <SessionView key={v.active} id={v.active === NEW ? '' : v.active} session={session} folder={folder} onStarted={started} />
          ) : (
            <div className="center faint">{loaded ? 'No session open. Pick one from the history.' : 'Loading…'}</div>
          )}
          {dropHint === 'side' && p === 0 && <div className="drop-side">Open to the side</div>}
        </main>
      </section>
    )
  }

  const tabsHere = view(0)
  return (
    <div className="workspace">
      <div className={'ws-body' + (splitOn ? ' split' : '')} style={{ '--explorer-w': paneW + 'px', '--split': ratio } as CSSProperties}>
        {files && (
          <aside className="panel explorer-panel">
            {/* The hide button at the top left, where the show button sits once hidden. */}
            <FolderList
              current={folder}
              hide={
                <button className="icon" onClick={() => setFiles(false)} aria-label="Hide the sidebar" title="Hide the sidebar">
                  <SidebarIcon />
                </button>
              }
            />
            <div className="panel-head">
              <span className="small faint explorer-title">FILES</span>
              <span className="grow" />
              <span className="files-sort">
                <button className={'chip-btn' + (byName ? '' : ' on')} onClick={() => sortFiles(false)} title="Newest first">
                  Recent
                </button>
                <button className={'chip-btn' + (byName ? ' on' : '')} onClick={() => sortFiles(true)} title="By name">
                  A–Z
                </button>
              </span>
            </div>
            <Explorer root={folder} onOpen={(path) => openFile(path)} active={activeFile} byName={byName} />
          </aside>
        )}
        {/* On a phone a tap anywhere beside the drawer closes it (hidden on a laptop). */}
        {files && <div className="drawer-back" onClick={() => setFiles(false)} />}
        {files && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize; double-click to reset"
            onPointerDown={startDrag}
            onDoubleClick={() => resize(280)}
          />
        )}
        {panes.map((p) => [
          p === 1 && (
            <div
              key="pane-splitter"
              className="pane-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the panes"
              title="Drag to resize; double-click to split in half"
              onPointerDown={startPaneDrag}
              onDoubleClick={() => update({ ...tabs, ratio: 0.5 })}
            />
          ),
          renderPane(p),
        ])}
      </div>
      {overview && (
        <div className="sheet-back" onClick={() => setOverview(false)}>
          <div className="sheet tab-overview" onClick={(e) => e.stopPropagation()}>
            <header className="bar">
              <b>Open tabs</b>
              <span className="grow" />
              <button className="icon" onClick={() => setOverview(false)} aria-label="Close">
                ×
              </button>
            </header>
            <ul className="list scroll">
              {tabsHere.ids.map((id) => (
                <li
                  key={id}
                  className={'item' + (id === tabsHere.active ? ' current' : '')}
                  onClick={() => {
                    select(id)
                    setOverview(false)
                  }}
                >
                  {tabDot(id) ?? <span className="dot" />}
                  {tabIcon(id)}
                  <div className="item-main">
                    <div className="ellipsis">{tabLabel(id)}</div>
                    <div className="faint small ellipsis">
                      {id.startsWith(FILE)
                        ? id.slice(FILE.length)
                        : live.turns[id]
                          ? 'working…'
                          : byId.get(id)
                            ? ago(byId.get(id)!.updated)
                            : ''}
                    </div>
                  </div>
                  <button
                    className="icon"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(id)
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
              <li
                className="item"
                onClick={() => {
                  select(NEW)
                  setOverview(false)
                }}
              >
                <NewChatIcon />
                <div className="item-main">New session</div>
              </li>
            </ul>
          </div>
        </div>
      )}
      {history !== null && (
        <div className="sheet-back" onClick={() => setHistory(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <header className="bar">
              <b>Sessions in {baseName(folder)}</b>
              <span className="grow" />
              <button className="icon" onClick={() => setHistory(null)} aria-label="Close">
                ×
              </button>
            </header>
            <ul className="list scroll">
              {mine.map((s) => (
                <li
                  key={s.id}
                  className={'item' + (tabs.ids.includes(s.id) || tabs.right?.ids.includes(s.id) ? ' current' : '')}
                  onClick={() => {
                    select(s.id, history)
                    setHistory(null)
                  }}
                >
                  <div className="item-main">
                    <div className="item-title ellipsis">
                      {live.turns[s.id] && <span className="dot run" />}
                      {s.title}
                      {s.provider === 'codex' && <span className="prov-tag">Codex</span>}
                    </div>
                    <div className="faint small">
                      {ago(s.updated)} · {(s.size / 1e6).toFixed(1)} MB{s.heldBy ? ` · open in another Claude (pid ${s.heldBy})` : ''}
                    </div>
                    {confirm === s.id && (
                      <div className="row-buttons left" onClick={(e) => e.stopPropagation()}>
                        <span className="small">Delete this session?</span>
                        <button className="btn small-btn" onClick={() => setConfirm('')}>
                          Cancel
                        </button>
                        <button className="btn small-btn danger" onClick={() => remove(s)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                  {confirm !== s.id && !live.turns[s.id] && (
                    <button
                      className="icon"
                      title="Delete session"
                      aria-label="Delete session"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirm(s.id)
                      }}
                    >
                      🗑
                    </button>
                  )}
                </li>
              ))}
              {!mine.length && <li className="faint pad">No sessions in this project.</li>}
            </ul>
            {deleteError && <p className="error pad small">{deleteError}</p>}
          </div>
        </div>
      )}
      {menu && (
        <div className="tab-menu" role="menu" style={{ left: Math.min(menu.x, innerWidth - 220), top: menu.y }}>
          {canRename(menu.id) && (
            <button role="menuitem" onClick={() => (setMenu(null), startRename(menu.id))}>
              Rename
            </button>
          )}
          {splitOn ? (
            <button role="menuitem" onClick={() => (setMenu(null), update(moveTab(tabs, menu.id, menu.p === 0 ? 1 : 0)))}>
              Move to the {menu.p === 0 ? 'right' : 'left'} pane
            </button>
          ) : (
            view(0).ids.length > 1 && (
              <button role="menuitem" onClick={() => (setMenu(null), update(split(tabs, menu.id)))}>
                Open to the side
              </button>
            )
          )}
          <button role="menuitem" onClick={() => (setMenu(null), closeTab(menu.id))}>
            Close
          </button>
        </div>
      )}
      {renameError && (
        <div className="toast">
          <span className="ellipsis">{renameError}</span>
          <button className="tab-x light" aria-label="Dismiss" onClick={() => setRenameError('')}>
            ×
          </button>
        </div>
      )}
      {undo && (
        <div className="toast">
          <span className="ellipsis">Deleted “{undo.title}”</span>
          <button className="btn small-btn" onClick={restore}>
            Undo
          </button>
        </div>
      )}
    </div>
  )
}

// TabStrip is a pane's row of tabs. Tabs past either end of it: on a
// laptop an arrow shows on that side, and a click brings the next hidden
// tab fully into view, one tab a click. A plain wheel scrolls the row too
// (Shift+wheel always did). ids changes with the tabs, to measure again.
function TabStrip({ ids, children }: { ids: string; children: ReactNode }) {
  const strip = useRef<HTMLElement>(null)
  const [beyond, setBeyond] = useState({ left: false, right: false })
  const measure = () => {
    const el = strip.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setBeyond((h) => (h.left === left && h.right === right ? h : { left, right }))
  }
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const t of el.children) ro.observe(t) // titles arrive and widen their tabs
    return () => ro.disconnect()
  }, [ids])
  const stepTabs = (dir: 1 | -1) => {
    const el = strip.current
    if (!el) return
    const all = [...el.querySelectorAll<HTMLElement>('[data-tab]')]
    const from = el.scrollLeft,
      to = from + el.clientWidth
    // The first and last tabs go all the way to the end, padding included.
    if (dir > 0) {
      const t = all.find((t) => t.offsetLeft + t.offsetWidth > to + 1)
      if (t) el.scrollLeft = t === all.at(-1) ? el.scrollWidth : t.offsetLeft + t.offsetWidth - el.clientWidth
    } else {
      const t = all.findLast((t) => t.offsetLeft < from - 1)
      if (t) el.scrollLeft = t === all[0] ? 0 : t.offsetLeft
    }
  }
  // Both arrows stay while the row overflows, the one with nothing past it
  // greyed: one coming and going resized the row, and the tab just brought
  // into view was cut off again.
  const over = beyond.left || beyond.right
  return (
    <>
      {over && (
        <button className="tab-arrow" disabled={!beyond.left} onClick={() => stepTabs(-1)} aria-label="Show the tab before" title="Tabs to the left">
          «
        </button>
      )}
      <nav
        className="tabs"
        ref={strip}
        onScroll={measure}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {children}
      </nav>
      {over && (
        <button className="tab-arrow" disabled={!beyond.right} onClick={() => stepTabs(1)} aria-label="Show the tab after" title="Tabs to the right">
          »
        </button>
      )}
    </>
  )
}
