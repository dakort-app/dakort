import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { useLastProvider } from './Composer'
import { Explorer } from './Explorer'
import { ActivityBar, type SideView } from './ActivityBar'
import { Changes, localCount } from './Changes'
import { useGit } from './git'
import { FileView, fileKey, unsaved, type Jump, type Opener } from './FileView'
import { ActivityDot, Brand, DrawerFoot, FolderList, failed, useOtherActivity } from './FolderBar'
import { Devices } from './Devices'
import { ErrorMark } from './ToolView'
import { StreamBanner, StreamDot } from './Home'
import { keepInView, menuKeys } from './PopMenu'
import { hideTip } from './tips'
import { AgentIcon, CloseIcon, FileIcon, HistoryIcon, NewChatIcon, PencilIcon, SidebarIcon, CollapseAllIcon, SplitIcon, TerminalIcon, TrashIcon, UnsplitIcon } from './icons'
import { FILE, providerOf, sameFolder, filesByName, setFilesByName, isUnread, loadTabs, markFresh, markSeen, NEW, saveTabs, setExplorerWidth, setLastFolder, tabsFor, type Tabs, explorerWidth, explorerShown, setExplorerShown, reconcile, flat, folderKey, resumeCommand } from './local'
import { activate, scrolledEdge } from './a11y'
import { copyText } from './clip'
import { loadSharedTabs, shareTabs } from './store'
import { clampRatio, closeTab as closeIn, focusOf, merged, moveTab, pane, selectTab, split, splitBeside, unsplit, withPane, type Pane, type PaneNo } from './local'
import { ago, baseName } from './route'
import { busy, tasksTitle, working } from './live'
import { postJSON } from './api'
import { SessionView } from './SessionView'
import { ChevronIcon } from './viewicons'
import { refreshLists, setPlace, useStore } from './store'
import type { Session } from './types'
import { Button } from '@/components/ui/button'
import { SortMenu } from './SortMenu'
import { cn } from '@/lib/utils'
import { menuItem, menuLabel, menuSeparator, menuShortcut, menuSurface } from '@/lib/menu'
import { ask } from './ask'
import { sheetBack, sheetPanel } from '@/lib/dialog'
import { toastClass } from '@/lib/toast'

const TerminalPanel = lazy(() => import('./Terminal').then((m) => ({ default: m.TerminalPanel })))

// A touch screen: no hover, so no tips on the tabs (a long press opens
// their menu instead).
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
  const [history, setHistoryState] = useState<PaneNo | null>(null)
  // On a laptop the history hangs under its button, like a menu.
  const [historyAt, setHistoryAt] = useState<DOMRect | null>(null)
  // From the activity bar it opens to the button's right, as a flyout.
  const [historyBeside, setHistoryBeside] = useState(false)
  const setHistory = (p: PaneNo | null, at?: Element, beside = false) => {
    setHistoryState(p)
    setHistoryAt(at ? at.getBoundingClientRect() : null)
    setHistoryBeside(beside)
  }
  // Other devices, opened from the sidebar; on a phone the drawer closes
  // first, so the sheet is not stacked over it.
  const [devices, setDevices] = useState(false)
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
  // The sidebar shows the files or the changes: on a laptop picked in
  // the activity bar (Changes says so when the folder is not in a
  // repository, as VS Code's does), on a phone by the sheet's own row,
  // there only in a repository.
  const git = useGit(folder)
  // Which one sticks on this device, so picking another project keeps
  // the view (the workspace is mounted anew for each project).
  const [changesState, setChangesState] = useState(() => localStorage.getItem('dakort.sideView') === 'changes')
  const setChanges = (on: boolean) => {
    setChangesState(on)
    localStorage.setItem('dakort.sideView', on ? 'changes' : 'files')
  }
  const [collapse, setCollapse] = useState(0)
  const changes = changesState && (isWide || !!git?.repo)
  const setFiles = (on: boolean) => {
    setFilesState(on)
    if (wide()) setExplorerShown(on)
  }
  // A view's button shows that view; the one shown, again, hides the
  // sidebar (VS Code's activity bar).
  const sideView: SideView | null = files ? (changes ? 'changes' : 'files') : null
  const showView = (v: SideView) => {
    if (sideView === v) return setFiles(false)
    setChanges(v === 'changes')
    if (!files) setFiles(true)
  }

  // The open tabs are the project's, shared through the server; this
  // browser keeps the view (active tab, split). A new-session tab with a
  // draft typed here stays even when closed elsewhere.
  const shared = useStore((s) => s.tabs[folderKey(folder)])
  useEffect(() => {
    loadSharedTabs(folder)
  }, [folder])
  const hasDraft = (id: string) => id === NEW && !!(localStorage.getItem('dakort.draft:new:' + folder) || localStorage.getItem('dakort.draft:new:' + folderKey(folder)))
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

  // The terminal panel under the editor. Shown or hidden and its height
  // stick on this device; its shells live in the server (Terminal.tsx).
  // A phone shows it over the whole screen instead, opened each time.
  const [phoneTerm, setPhoneTerm] = useState(false)
  const [termShown, setTermShownState] = useState(() => localStorage.getItem('dakort.termShown') === '1')
  const setTermShown = (on: boolean) => {
    setTermShownState(on)
    localStorage.setItem('dakort.termShown', on ? '1' : '0')
  }
  // Ctrl+` shows or hides it, as in VS Code; caught before the terminal,
  // which would pass it to the shell.
  const termShownRef = useRef(termShown)
  termShownRef.current = termShown
  useEffect(() => {
    if (!isWide) return
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Backquote') {
        e.preventDefault()
        e.stopPropagation()
        setTermShown(!termShownRef.current)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [isWide])
  const [termH, setTermH] = useState(() => Number(localStorage.getItem('dakort.termHeight')) || 260)
  const startTermDrag = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const panel = el.nextElementSibling as HTMLElement
    const y0 = e.clientY
    const fit = (h: number) => Math.max(100, Math.min(h, window.innerHeight * 0.75))
    let h = termH
    el.setPointerCapture(e.pointerId)
    el.onpointermove = (m) => {
      h = fit(termH + y0 - m.clientY)
      panel.style.height = h + 'px'
    }
    el.onpointerup = el.onpointercancel = () => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null
      setTermH(h)
      localStorage.setItem('dakort.termHeight', String(h))
    }
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
  // At least room for the PROJECTS header's short row (the label, a dot,
  // More, + and hide; FolderBar's useNarrow folds the rest away): at 160
  // + and hide were cut off. A width saved narrower comes back at that.
  const clamp = (w: number) => Math.max(240, Math.min(w, window.innerWidth * 0.6))
  const [paneW, setPaneW] = useState(() => clamp(explorerWidth()))
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
  // An agent working here may write the file being edited (FileView says so).
  const agentBusy = mine.some((s) => busy(live, s.id) !== '')
  // The sessions on screen, one per pane, count as read; a hidden page
  // marks nothing, and reads once it comes back in front.
  const shown = panes.map((p) => byId.get(view(p).active)).filter((s): s is Session => !!s)
  useEffect(() => {
    const mark = () => shown.forEach(markSeen)
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [shown.map((s) => s.id + s.updated).join()])

  // A tab shows where it is, else opens in the given pane (the focused one).
  const select = (id: string, into?: PaneNo) => update(selectTab(tabs, id, into))
  // Closing counts the session as read, so unread work does not reopen
  // it on every device the next moment; new activity still does.
  const closeTab = async (id: string) => {
    if (id.startsWith(FILE) && unsaved.has(fileKey(folder, id.slice(FILE.length))) && !(await ask({ title: 'Close it and discard your unsaved changes?', action: 'Discard and close', destructive: true }))) return
    const s = byId.get(id)
    if (s) markSeen(s)
    // Closed from the keyboard (its menu, Delete): the focus goes to the
    // tab that takes its place, not to the page.
    const list = document.querySelector(`[data-tab="${CSS.escape(id)}"]`)?.closest('[role="tablist"]')
    const keys = !!document.activeElement?.closest('[role="tablist"], .tab-menu')
    update(closeIn(tabs, id))
    if (keys && list)
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (a && a !== document.body && a.isConnected) return
        ;(list.isConnected ? list : document).querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
      })
  }
  // Open a file tab, optionally at a spot (SyncTeX between .tex and PDF).
  const [jumps, setJumps] = useState<Record<string, Jump>>({})
  const openFile = (path: string, jump?: Parameters<Opener>[1], into?: PaneNo) => {
    select(FILE + path, into)
    if (jump) setJumps((cur) => ({ ...cur, [path]: { ...jump, n: (cur[path]?.n ?? 0) + 1 } }))
    if (!wide()) setFiles(false) // on a phone the file takes the screen
  }
  // A file from Changes opens on its diff beside the conversation on a
  // wide screen (the mock's layout): in the second pane, made if need be,
  // when the pane in focus shows a session. Elsewhere it opens as any file.
  const openBeside = (path: string) => {
    const id = FILE + path
    const f = focusOf(tabs)
    const act = pane(tabs, f).active
    if (!wide() || !act || act.startsWith(FILE) || tabs.ids.includes(id) || tabs.right?.ids.includes(id)) return openFile(path)
    if (!tabs.right) return update({ ...tabs, right: { ids: [id], active: id }, focus: 'right' })
    openFile(path, undefined, f === 0 ? 1 : 0)
  }
  // A file a reply links to (Transcript) opens as a tab of this project.
  const openRef = useRef(openFile)
  openRef.current = openFile
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ folder: string; path: string }>).detail
      if (sameFolder(d.folder, folder)) openRef.current(d.path)
    }
    window.addEventListener('dakort:open-file', on)
    return () => window.removeEventListener('dakort:open-file', on)
  }, [folder])
  const focusedActive = view(splitOn ? focus : 0).active
  const activeFile = focusedActive.startsWith(FILE) ? focusedActive.slice(FILE.length) : ''
  // Deleting goes to the server's trash; Undo stays offered for a while.
  const [confirm, setConfirm] = useState('')
  // A failed delete shows in its own row; a failed Undo replaces the Undo
  // toast with an error that stays until dismissed (the session is still
  // in the trash, and the user believes it is back).
  const [deleteError, setDeleteError] = useState<{ id: string; why: string } | null>(null)
  const [undo, setUndo] = useState<{ trash: string; title: string; id: string; busy?: boolean; failed?: string } | null>(null)
  useEffect(() => {
    if (!undo || undo.busy || undo.failed) return
    const t = window.setTimeout(() => setUndo(null), 10_000)
    return () => clearTimeout(t)
  }, [undo])
  const remove = async (s: Session) => {
    setDeleteError(null)
    try {
      const inSheet = !!document.activeElement?.closest('.sheet')
      const r = await postJSON<{ trash: string }>(`/api/sessions/${s.id}/delete`, {})
      setConfirm('')
      setUndo({ trash: r.trash, title: s.title, id: s.id })
      refreshLists()
      // Its row is gone with the Delete pressed: the focus stays in the list.
      // The last one gone, the empty list's New session takes it (once
      // the list has been read again).
      const next = (tries: number) =>
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(`.sheet [data-trash]:not([data-trash="${CSS.escape(s.id)}"]), .sheet .history-empty .btn`)
          if (el) el.focus({ preventScroll: true })
          else if (tries > 0) setTimeout(() => next(tries - 1), 80)
        })
      if (inSheet) next(15)
    } catch (e) {
      setDeleteError({ id: s.id, why: reason(e) })
    }
  }
  const restore = async () => {
    if (!undo) return
    setUndo({ ...undo, busy: true, failed: undefined })
    try {
      await postJSON(`/api/trash/${undo.trash}/restore`, {})
      select(undo.id)
      setUndo(null)
      refreshLists()
      // The focus was on Undo, which is gone: the restored tab takes it.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tab="${CSS.escape(undo.id)}"]`)?.focus({ preventScroll: true }))
    } catch (e) {
      setUndo({ ...undo, busy: false, failed: reason(e) })
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

  // A tab's menu (right-click on a laptop, a long press on a phone):
  // rename, the other pane, the command that resumes the session in a
  // terminal, close. It hangs from the tab, inside the window; on a phone
  // it opens with the tab's whole title, which the strip may cut.
  // Opened from the keyboard (key), the focus goes to its first row; the
  // arrows, Home and End move, Enter or Space picks, and Escape, Tab or a
  // pick puts the focus back on the tab.
  const [menu, setMenu] = useState<{ id: string; p: PaneNo; at: DOMRect; key?: boolean } | null>(null)
  const tabMenu = useRef<HTMLDivElement | null>(null)
  const openMenu = (id: string, p: PaneNo, el: Element, key = false) => {
    clearTimeout(press.current)
    hideTip() // the tab's tip would cover the menu's title
    setMenu({ id, p, at: el.getBoundingClientRect(), key })
  }
  const menuRows = () => Array.from(tabMenu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
  // closeMenu shuts it; if the focus was in it, the tab gets it back (once
  // a pick has had its say: Rename's field keeps it, a closed tab has none).
  const closeMenu = () => {
    const id = menu?.id
    const inside = !!tabMenu.current?.contains(document.activeElement)
    setMenu(null)
    if (inside && id)
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (!a || a === document.body) document.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus()
      })
  }
  useEffect(() => {
    if (!menu) return
    if (menu.key) menuRows()[0]?.focus()
    const off = (e: Event) => !(e.target as HTMLElement).closest?.('.tab-menu') && setMenu(null)
    // Keys with the focus outside it (opened by a right-click): Escape
    // closes it, the arrows go into it.
    const keys = (e: KeyboardEvent) => {
      if (tabMenu.current?.contains(document.activeElement)) return
      if (e.key === 'Escape') setMenu(null)
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        const rows = menuRows()
        rows[e.key === 'ArrowDown' || e.key === 'Home' ? 0 : rows.length - 1]?.focus()
      }
    }
    addEventListener('pointerdown', off, true)
    addEventListener('blur', off)
    addEventListener('keydown', keys)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('blur', off)
      removeEventListener('keydown', keys)
    }
  }, [menu])

  useEffect(() => {
    if (named && byId.get(named.id)?.title === named.title) setNamed(null)
  }, [named, sessions])
  useEffect(() => {
    // A note goes by itself; an error stays until it is dismissed.
    if (!renameError || renameError.startsWith('Could not')) return
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
        : byId.get(id)?.title || (byId.has(id) ? 'Untitled session' : loaded && id !== NEW && !live.turns[id] ? id.slice(0, 8) : 'New session')
  // A tab's state by its shape (no room for words in the strip): a
  // triangle waits for you, a turning arc works, a still ring has tasks in
  // the background, a solid dot finished unseen.
  const tabDot = (id: string) => {
    const s = byId.get(id)
    const dot = (cls: string, says: string) => <span className={'dot ' + cls} role="img" aria-label={says} title={says} />
    if (live.turns[id]?.permissions.length) return dot('needs', 'Needs you: a permission to answer')
    if (working(live, id)) return dot('run', 'Working')
    if (s && !shown.includes(s) && isUnread(s)) return failed(live.ended[id]) ? dot('fail', 'Failed, not seen') : dot('unread', 'Finished, not seen')
    if (busy(live, id) === 'tasks') return dot('tasks', tasksTitle)
    return null
  }
  // A tab's state sits in its ×'s slot, the project rows' marks (the
  // spinner while it works, the ring with background tasks, the solid dot
  // once it finished unseen), and the × takes the slot under the pointer
  // or on the tab in use. Unseen, the name is semibold too; needing you,
  // a triangle takes the agent's mark. The words go to screen readers.
  const tabState = (id: string): { state: string; says: string } | null => {
    const s = byId.get(id)
    if (live.turns[id]?.permissions.length) return { state: 'needs', says: 'Needs you: a permission to answer' }
    if (working(live, id)) return { state: 'run', says: 'Working' }
    if (s && !shown.includes(s) && isUnread(s)) return failed(live.ended[id]) ? { state: 'fail', says: 'Failed, not seen' } : { state: 'unread', says: 'Finished, not seen' }
    if (busy(live, id) === 'tasks') return { state: 'tasks', says: 'Background tasks running' }
    return null
  }
  // Files by their type; sessions by their agent's mark (a new one by the
  // agent its composer will start).
  const tabIcon = (id: string) =>
    id.startsWith(FILE) ? <FileIcon path={id.slice(FILE.length)} /> : <AgentIcon provider={id === NEW ? newProvider : providerOf(id, byId.get(id)?.provider)} />
  const stripIcon = (id: string, state?: string) => (state === 'needs' ? <span className="dot needs tab-warn" aria-hidden /> : tabIcon(id))

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
        <div className={'tabs-row' + (v.ids.length > 1 ? ' many' : '')}>
          {p === 0 && (
            <Button variant="ghost" size="icon-sm" className="dotted side-toggle relative text-muted-foreground hover:text-foreground [&_.dot]:absolute [&_.dot]:top-0.5 [&_.dot]:right-px [&_.dot]:m-0 pointer-coarse:[&_.dot]:top-2 pointer-coarse:[&_.dot]:right-2" onClick={() => setFiles(!files)} aria-label={files ? 'Hide the sidebar' : 'Show the sidebar'} title="Sidebar">
              <SidebarIcon />
              {!files && <ActivityDot st={otherActivity} />}
            </Button>
          )}
          <TabStrip ids={v.ids.join(',')} active={v.active} onPick={(id) => select(id)}>
            {v.ids.map((id) => {
              const st = tabState(id)
              return (
              <div
                key={id}
                className={'tab' + (id === v.active ? ' active' : '') + (drag?.id === id ? ' dragging' : '')}
                data-state={st?.state}
                style={drag?.id === id ? { transform: `translateX(${drag.dx}px)` } : undefined}
                onClick={() => select(id)}
                // A touch screen has no hover: a long press opens the menu,
                // which shows the whole title, rather than a tip.
                aria-keyshortcuts={canRename(id) ? 'F2 Delete' : 'Delete'}
                onDoubleClick={() => startRename(id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(id, p, e.currentTarget)
                }}
                data-tab={id}
                role="tab"
                aria-selected={id === v.active}
                tabIndex={id === v.active ? 0 : -1}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  // Arrows move along the row; Enter or Space shows the tab,
                  // F2 renames, Delete closes, the menu key opens its menu.
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault()
                    const next = (e.key === 'ArrowRight' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null
                    if (next?.dataset.tab) next.focus()
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    select(id)
                  } else if (e.key === 'F2') startRename(id)
                  else if (e.key === 'Delete') closeTab(id)
                  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                    e.preventDefault()
                    openMenu(id, p, e.currentTarget, true)
                  }
                }}
                onPointerDown={(e) => renaming !== id && dragTab(e, id, p)}
                onTouchStart={(e) => {
                  const el = e.currentTarget
                  press.current = window.setTimeout(() => renaming !== id && openMenu(id, p, el), 500)
                }}
                onTouchEnd={() => clearTimeout(press.current)}
                onTouchMove={() => clearTimeout(press.current)}
              >
                {stripIcon(id, st?.state)}
                {st && <span className="sr-only">{st.says}: </span>}
                {renaming === id ? (
                  <input
                    className="tab-rename"
                    autoFocus
                    defaultValue={tabLabel(id)}
                    aria-label="New name"
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== 'Escape') return
                      // The focus goes back to the tab, not to the page.
                      const tab = e.currentTarget.closest<HTMLElement>('[role="tab"]')
                      if (e.key === 'Enter') rename(id, e.currentTarget.value)
                      else setRenaming('')
                      requestAnimationFrame(() => tab?.focus({ preventScroll: true }))
                    }}
                    onBlur={() => setRenaming('')}
                  />
                ) : (
                  <span className="ellipsis" dir="auto">{tabLabel(id)}</span>
                )}
                <button
                  className="tab-x"
                  aria-label="Close tab"
                  tabIndex={id === v.active ? 0 : -1} // the others' × is hidden at rest; Delete closes a tab from the keyboard
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(id)
                  }}
                >
                  <CloseIcon sm />
                  {st && st.state !== 'needs' && <span className={'dot ' + st.state} aria-hidden />}
                </button>
              </div>
              )
            })}
          </TabStrip>
          {!splitOn && v.ids.length > 1 && (
            <button
              className="tab-count"
              onClick={() => setOverview(true)}
              aria-label={`Tab ${v.ids.indexOf(v.active) + 1} of ${v.ids.length}: all open tabs`}
            >
              {/* Which one of how many, as a phone browser's tabs button: "2/5". */}
              <span>
                {v.ids.indexOf(v.active) + 1}/{v.ids.length}
              </span>
            </button>
          )}
          {isWide && !splitOn && (
            <Button
 variant="ghost" size="icon-sm" className="split-btn text-muted-foreground hover:text-foreground"
              onClick={() => update(splitBeside(tabs))}
              disabled={v.ids.length < 2 && v.active === NEW}
              aria-label="Split the editor"
              title="Split"
            >
              <SplitIcon />
            </Button>
          )}
          {/* The session history stays on the pane's bar, by the new
              session button (on a laptop the terminal is in the activity bar). */}
          <Button variant="ghost" size="icon-sm"
            className={cn('text-muted-foreground hover:text-foreground', (history === p) && 'open')}
            onClick={(e) => setHistory(history === p ? null : p, e.currentTarget)}
            aria-label="Session history"
            aria-expanded={history === p}
            title="History"
          >
            <HistoryIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={() => select(NEW, p)} aria-label="New session" title="New session">
            <NewChatIcon />
          </Button>
          {splitOn && p === 1 && (
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={() => update(unsplit(tabs))} aria-label="Close the split" title="Close split">
              <UnsplitIcon />
            </Button>
          )}
          {!files && last && <StreamDot />}
        </div>
        {p === 0 && <StreamBanner />}
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
                  <FileView root={folder} path={f} onOpen={(path, jump) => openFile(path, jump, p)} jump={jumps[f]} active={f === activeFileHere} agentBusy={agentBusy} />
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
        {isWide && (
          <ActivityBar
            view={sideView}
            onView={showView}
            changes={localCount(git)}
            terminal={termShown}
            onTerminal={() => setTermShown(!termShown)}
            onDevices={() => setDevices(true)}
          />
        )}
        {files && (
          <aside className="panel explorer-panel">
            {/* The mark heads the activity bar on a laptop; the phone's
                sheet has none, so it keeps its own line. */}
            {!isWide && <Brand />}
            <FolderList current={folder} />
            {/* The explorer's header, as VS Code's view headers: the view's
                name, its actions as small icons on the right, under the
                pointer. A phone's sheet names both views as plain words,
                the one shown in the text's colour. */}
            <div className="side-head files-head">
              {isWide ? (
                <h2 className="explorer-title">{changes ? 'Changes' : 'File explorer'}</h2>
              ) : git?.repo ? (
                <span className="side-tabs" role="tablist" aria-label="File explorer or changes">
                  <button role="tab" aria-selected={!changes} className={cn('side-tab', !changes && 'on')} onClick={() => setChanges(false)}>
                    File explorer
                  </button>
                  <button role="tab" aria-selected={changes} className={cn('side-tab', changes && 'on')} onClick={() => setChanges(true)}>
                    Changes
                    {localCount(git) > 0 && <span className="side-count">{localCount(git)}</span>}
                  </button>
                </span>
              ) : (
                <h2 className="explorer-title">File explorer</h2>
              )}
              <span className="grow" />
              {!changes && (
                <span className="side-actions files-sort">
                  <SortMenu byName={byName} onChange={sortFiles} />
                  <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" onClick={() => setCollapse((n) => n + 1)} aria-label="Collapse all" title="Collapse all">
                    <CollapseAllIcon />
                  </Button>
                </span>
              )}
            </div>
            {changes ? (
              <Changes root={folder} onOpen={openBeside} active={activeFile} />
            ) : (
              <Explorer key={folder} root={folder} onOpen={(path) => openFile(path)} active={activeFile} byName={byName} collapse={collapse} />
            )}
            {!isWide && (
              <DrawerFoot
                onDevices={() => {
                  setFiles(false)
                  setDevices(true)
                }}
                onTerminal={() => {
                  setFiles(false)
                  setPhoneTerm(true)
                }}
              />
            )}
          </aside>
        )}
        {/* On a phone a tap anywhere beside the drawer closes it (hidden on a laptop). */}
        {files && <div className="drawer-back" onClick={() => setFiles(false)} />}
        {files && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the sidebar"
            aria-valuenow={Math.round(paneW)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                resize(paneW + (e.key === 'ArrowRight' ? 16 : -16))
              }
            }}
            onPointerDown={startDrag}
            onDoubleClick={() => resize(280)}
          />
        )}
        {/* The editor's column: the panes, and under them (on a laptop) the
            terminal panel, so the sidebar keeps the whole height. */}
        <div className="ws-editor">
          <div className="ws-panes">
            {panes.map((p) => [
              p === 1 && (
                <div
                  key="pane-splitter"
                  className="pane-splitter"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the panes"
                  aria-valuenow={Math.round(ratio * 100)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                      e.preventDefault()
                      update({ ...tabs, ratio: clampRatio(ratio + (e.key === 'ArrowRight' ? 0.05 : -0.05)) })
                    }
                  }}
                  onPointerDown={startPaneDrag}
                  onDoubleClick={() => update({ ...tabs, ratio: 0.5 })}
                />
              ),
              renderPane(p),
            ])}
          </div>
          {isWide && termShown && (
            <>
              <div className="term-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" onPointerDown={startTermDrag} />
              <div className="term-wrap" style={{ height: termH }}>
                <Suspense fallback={<div className="faint small pad">Loading the terminal…</div>}>
                  <TerminalPanel key={folder} folder={folder} onHide={() => setTermShown(false)} />
                </Suspense>
              </div>
            </>
          )}
        </div>
      </div>
      {!isWide && phoneTerm && (
        <Suspense fallback={<div className="term-panel phone faint small pad">Loading the terminal…</div>}>
          <TerminalPanel key={folder} folder={folder} phone onHide={() => setPhoneTerm(false)} />
        </Suspense>
      )}
      {overview && (
        <div className={sheetBack()} onClick={() => setOverview(false)}>
          <div className={sheetPanel({ className: 'tab-overview' })} role="dialog" aria-label="Open tabs" ref={scrolledEdge} onClick={(e) => e.stopPropagation()}>
            <header className="bar">
              <b>Open tabs</b>
              <span className="grow" />
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={() => setOverview(false)} aria-label="Close">
                <CloseIcon />
              </Button>
            </header>
            <ul className={'list scroll' + (tabsHere.ids.some((id) => tabDot(id)) ? '' : ' no-state')}>
              {tabsHere.ids.map((id) => (
                <li
                  key={id}
                  className={'item' + (id === tabsHere.active ? ' current' : '')}
                  aria-current={id === tabsHere.active || undefined}
                  role="button"
                  tabIndex={0}
                  onKeyDown={activate(() => (select(id), setOverview(false)))}
                  onClick={() => {
                    select(id)
                    setOverview(false)
                  }}
                >
                  <span className="state">{tabDot(id)}</span>
                  {tabIcon(id)}
                  <div className="item-main">
                    <div className="item-title ellipsis" dir="auto">{tabLabel(id)}</div>
                    <div className="faint small ellipsis">
                      {id.startsWith(FILE)
                        ? id.slice(FILE.length)
                        : live.turns[id]?.permissions.length
                          ? 'Needs you'
                          : working(live, id)
                            ? 'Working…'
                            : busy(live, id) === 'tasks'
                              ? 'Running in the background…'
                              : byId.get(id)
                                ? ago(byId.get(id)!.updated)
                                : ''}
                    </div>
                  </div>
                  <Button
 variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(id)
                    }}
                  >
                    <CloseIcon />
                  </Button>
                </li>
              ))}
              <li
                className="item new-row"
                role="button"
                tabIndex={0}
                onKeyDown={activate(() => (select(NEW), setOverview(false)))}
                onClick={() => {
                  select(NEW)
                  setOverview(false)
                }}
              >
                <span className="state" />
                <NewChatIcon />
                <div className="item-main">New session</div>
              </li>
            </ul>
          </div>
        </div>
      )}
      {history !== null && (
        <div className={sheetBack(!!historyAt && isWide)} onClick={() => setHistory(null)}>
          <div
            className={sheetPanel({ popover: !!historyAt && isWide, className: 'history' })}
            role="dialog"
            aria-label={'Sessions in ' + baseName(folder)}
            ref={(el) => (keepInView(el), scrolledEdge(el))}
            style={
              historyAt && isWide
                ? historyBeside
                  ? { top: historyAt.top, left: historyAt.right + 6 }
                  : { top: historyAt.bottom + 4, left: Math.max(8, Math.min(historyAt.right - 400, innerWidth - 408)) }
                : undefined
            }
            onClick={(e) => e.stopPropagation()}
          >
            <header className="bar">
              <b className="ellipsis">Sessions in {baseName(folder)}</b>
              <span className="grow" />
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={() => setHistory(null)} aria-label="Close">
                <CloseIcon />
              </Button>
            </header>
            <ul className={'list scroll' + (mine.some((s) => tabDot(s.id)) ? '' : ' no-state')}>
              {byDay(mine).map(([day, list]) => (
                <Fragment key={day}>
                  <li className="list-head" role="presentation">
                    {day}
                  </li>
                  {list.map((s) => (
                    <li
                      key={s.id}
                      // The one on screen in the selection's wash; others open
                      // in a tab with their title in bold, so only one row
                      // reads as selected.
                      className={'item' + (s.id === focusedActive ? ' current' : tabs.ids.includes(s.id) || tabs.right?.ids.includes(s.id) ? ' open' : '')}
                      aria-current={s.id === focusedActive || undefined}
                      role="button"
                      tabIndex={0}
                      onKeyDown={activate(() => (select(s.id, history), setHistory(null)))}
                      onClick={() => {
                        select(s.id, history)
                        setHistory(null)
                      }}
                    >
                      <span className="state">{tabDot(s.id)}</span>
                      <AgentIcon provider={providerOf(s.id, s.provider)} />
                      <div className="item-main">
                        <div className="item-title ellipsis" dir="auto">{s.title || 'Untitled session'}</div>
                        <div className="faint small ellipsis">
                          {when(s.updated, day)}
                          {s.heldBy ? ` · open in another Claude (pid ${s.heldBy})` : ''}
                        </div>
                        {confirm === s.id && (
                          <div className="row-buttons left" onClick={(e) => e.stopPropagation()}>
                            <span className="small">Delete this session?</span>
                            {/* The focus moves here from the trash button, and back
                                to it on Cancel (both buttons replace it). */}
                            <Button
 variant="outline" size="xs"
                              autoFocus
                              onClick={() => {
                                setConfirm('')
                                requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-trash="${CSS.escape(s.id)}"]`)?.focus({ preventScroll: true }))
                              }}
                            >
                              Cancel
                            </Button>
                            <Button variant="destructive" size="xs" onClick={() => remove(s)}>
                              Delete
                            </Button>
                          </div>
                        )}
                        {deleteError?.id === s.id && (
                          <div className="folder-error" role="alert">
                            <div className="row">
                              <ErrorMark />
                              <span>
                                <span className="folder-error-title">Could not delete “{s.title}”.</span>
                                {deleteError.why}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                      {confirm !== s.id && !live.turns[s.id] && (
                        <Button
 variant="ghost" size="icon-sm" className="row-delete self-center text-muted-foreground hover:text-foreground"
                          data-trash={s.id}
                          title="Delete session"
                          aria-label="Delete session"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirm(s.id)
                          }}
                        >
                          <TrashIcon />
                        </Button>
                      )}
                    </li>
                  ))}
                </Fragment>
              ))}
              {!mine.length && (
                <li className="history-empty">
                  <span className="faint">No sessions in this project.</span>
                  <Button
 variant="outline" size="sm"
                    onClick={() => {
                      select(NEW, history ?? undefined)
                      setHistory(null)
                    }}
                  >
                    New session
                  </Button>
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
      {menu &&
        (() => {
          // Under the tab, or over it when there is no room below; never
          // past an edge of the window.
          const w = Math.min(260, innerWidth - 16)
          const left = Math.max(8, Math.min(menu.at.left, innerWidth - w - 8))
          const place = menu.at.bottom + 240 < innerHeight ? { top: menu.at.bottom + 4 } : { bottom: innerHeight - menu.at.top + 4 }
          return (
            <div
              className={cn('tab-menu', menuSurface, 'fixed z-30 flex min-w-48 flex-col slide-in-from-top-2')}
              role="menu"
              aria-label={tabLabel(menu.id)}
              ref={(el) => {
                tabMenu.current = el
                keepInView(el)
              }}
              style={{ left, width: w, ...place }}
              onKeyDown={(e) =>
                menuKeys(e, menuRows(), closeMenu, () => {
                  e.preventDefault()
                  closeMenu()
                })
              }
            >
              <div className={cn('menu-title', menuLabel)} aria-hidden="true">
                {tabLabel(menu.id)}
              </div>
              {canRename(menu.id) && (
                <button className={menuItem} role="menuitem" tabIndex={-1} onClick={() => (closeMenu(), startRename(menu.id))}>
                  <PencilIcon />
                  <span className="grow">Rename</span>
                  <kbd className={menuShortcut} aria-hidden="true">
                    F2
                  </kbd>
                </button>
              )}
              {splitOn ? (
                <button className={menuItem} role="menuitem" tabIndex={-1} onClick={() => (closeMenu(), update(moveTab(tabs, menu.id, menu.p === 0 ? 1 : 0)))}>
                  <SplitIcon />
                  Move to the {menu.p === 0 ? 'right' : 'left'} pane
                </button>
              ) : (
                isWide &&
                view(0).ids.length > 1 && (
                  <button className={menuItem} role="menuitem" tabIndex={-1} onClick={() => (closeMenu(), update(split(tabs, menu.id)))}>
                    <SplitIcon />
                    Open to the side
                  </button>
                )
              )}
              {canRename(menu.id) &&
                (() => {
                  // A second CLI writing to a session that one has open forks it
                  // (BRIEF), so not while a turn or a process has it.
                  const busy = !!live.turns[menu.id] || !!byId.get(menu.id)?.heldBy
                  return (
                    <button
                      className={menuItem}
                      role="menuitem"
                      tabIndex={-1}
                      disabled={busy}
                      title={busy ? 'It is in use; copy it once it is idle' : 'A command that continues this session in a terminal'}
                      onClick={() => {
                        const s = byId.get(menu.id)
                        closeMenu()
                        if (s) copyText(resumeCommand(s)).then((ok) => setRenameError(ok ? 'Copied: paste it in a terminal' : 'Copy failed'))
                      }}
                    >
                      <TerminalIcon />
                      Copy resume command
                    </button>
                  )
                })()}
              <div role="separator" className={menuSeparator} />
              <button className={menuItem} role="menuitem" tabIndex={-1} onClick={() => (closeMenu(), closeTab(menu.id))}>
                <CloseIcon />
                <span className="grow">Close</span>
                <kbd className={menuShortcut} aria-hidden="true">
                  Del
                </kbd>
              </button>
            </div>
          )
        })()}
      {devices && <Devices onClose={() => setDevices(false)} />}
      {renameError && (
        <div className={toastClass} role="alert">
          <span className="toast-msg" title={renameError}>
            {renameError}
          </span>
          <button className="tab-x light" aria-label="Dismiss" onClick={() => setRenameError('')}>
            <CloseIcon sm />
          </button>
        </div>
      )}
      {undo && !undo.failed && (
        <div className={toastClass} role="status">
          <span className="ellipsis">Deleted “{undo.title}”</span>
          {/* aria-disabled, not disabled: a disabled button drops the focus. */}
          <Button variant="outline" size="xs" onClick={() => !undo.busy && restore()} aria-disabled={undo.busy || undefined}>
            Undo
          </Button>
        </div>
      )}
      {undo?.failed && (
        <div className={toastClass} role="alert">
          <span className="toast-msg" title={undo.failed}>
            Could not restore “{undo.title}”: {undo.failed}
          </span>
          <Button variant="outline" size="xs" onClick={restore} autoFocus>
            Try again
          </Button>
          <button className="tab-x light" aria-label="Dismiss" onClick={() => setUndo(null)}>
            <CloseIcon sm />
          </button>
        </div>
      )}
    </div>
  )
}

// reason is an error's text for a person: a request that never reached
// the server says so, not "Load failed" or "Failed to fetch".
function reason(e: unknown): string {
  if (e instanceof TypeError) return 'Dakort could not be reached. Check the connection and try again.'
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/\.?$/, '.')
}

// when says when a session was last active, in the words its day group
// leaves out: the clock time under Today and Yesterday, the weekday or the
// date under Earlier (a relative "1d" under Earlier read as wrong).
function when(iso: string | undefined, day: string): string {
  const t = Date.parse(iso ?? '')
  if (!t) return ''
  const d = new Date(t)
  if (day !== 'Earlier') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (Date.now() - t < 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// byDay groups sessions (newest first) under Today, Yesterday and Earlier,
// by their last activity on this device's clock.
function byDay(list: Session[]): [string, Session[]][] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const yesterday = today - 86_400_000
  const groups: [string, Session[]][] = [
    ['Today', []],
    ['Yesterday', []],
    ['Earlier', []],
  ]
  for (const s of list) {
    const t = Date.parse(s.updated ?? '') || 0
    groups[t >= today ? 0 : t >= yesterday ? 1 : 2][1].push(s)
  }
  return groups.filter(([, l]) => l.length)
}

// TabStrip is a pane's row of tabs. Tabs past either end of it: on a
// laptop an arrow shows on that side, and a click brings the next hidden
// tab fully into view, one tab a click. A plain wheel scrolls the row too
// (Shift+wheel always did). ids changes with the tabs, to measure again.
//
// On a phone the row snaps: a swipe always comes to rest with a tab's
// start at the row's start, and the active tab is put there, so no tab
// shows cut at the left edge (a neighbour once showed as "lth" or a lone
// ×). The row fades out at an edge with more tabs past it. A spacer after
// the last tab, only when the tabs overflow, lets the last one come to
// the start as well.
//
// With more than one tab a phone shows one tab at a time, the whole row
// wide: a swipe brings the next one in and shows it (as a phone browser's
// address bar does), and the count beside the row opens the list. A
// neighbour peeking in at the edge read as a disabled button.
function TabStrip({ ids, active, onPick, children }: { ids: string; active: string; onPick: (id: string) => void; children: ReactNode }) {
  const strip = useRef<HTMLElement>(null)
  const end = useRef<HTMLSpanElement>(null)
  const [beyond, setBeyond] = useState({ left: false, right: false })
  // Where the row was put for the active tab: a resize puts it there again,
  // unless a swipe has moved the row since.
  const placed = useRef(-1)
  const settle = useRef(0)
  // A touch on the row since its last settle: only a swipe picks a tab.
  // A scroll the browser makes itself (WebKit puts the row back where it
  // was on reload) is answered by revealing the tab in use.
  const swiped = useRef(false)
  const narrow = () => !wide()
  const fit = () => {
    const el = strip.current
    const sp = end.current
    if (!el || !sp) return
    const all = [...el.querySelectorAll<HTMLElement>('[data-tab]')]
    const last = all.at(-1)
    if (!narrow() || !last) return void (sp.style.width = '0px')
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
    const tabsEnd = last.offsetLeft + last.offsetWidth
    sp.style.width = tabsEnd + pad > el.clientWidth ? Math.max(0, el.clientWidth - last.offsetWidth - 2 * pad) + 'px' : '0px'
  }
  const measure = () => {
    const el = strip.current
    if (!el) return
    // A title too long for its tab fades out at its end (styles.css); one
    // that fits is left alone.
    for (const t of el.querySelectorAll<HTMLElement>('.tab .ellipsis')) {
      t.toggleAttribute('data-cut', t.scrollWidth > t.clientWidth + 1)
      // Its direction as laid out (dir="auto"), for the fade at its end.
      t.toggleAttribute('data-rtl', getComputedStyle(t).direction === 'rtl')
    }
    const spacer = end.current?.offsetWidth ?? 0
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - spacer - 1
    setBeyond((h) => (h.left === left && h.right === right ? h : { left, right }))
  }
  // The active tab in full view: at the row's start on a phone, the
  // nearest end on a laptop.
  const reveal = () => {
    const el = strip.current
    const t = el?.querySelector<HTMLElement>('.tab.active')
    if (!el || !t) return
    if (narrow()) {
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
      el.scrollLeft = t.offsetLeft - pad
      placed.current = el.scrollLeft
    } else if (t.offsetLeft < el.scrollLeft) el.scrollLeft = t.offsetLeft
    else if (t.offsetLeft + t.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = t.offsetLeft + t.offsetWidth - el.clientWidth
  }
  useLayoutEffect(() => {
    fit()
    reveal()
    measure()
  }, [ids, active])
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const still = placed.current < 0 || Math.abs(el.scrollLeft - placed.current) < 2
      fit()
      if (still) reveal() // titles arrive and widen their tabs
      measure()
    })
    ro.observe(el)
    for (const t of el.querySelectorAll('[data-tab]')) ro.observe(t)
    // A title that changes, or the text size, inside a tab whose box stays
    // the same (a lone phone tab fills the row): its fade is decided anew.
    for (const t of el.querySelectorAll('.tab .ellipsis')) ro.observe(t)
    const mo = new MutationObserver(measure)
    mo.observe(el, { subtree: true, characterData: true, childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [ids])
  const stepTabs = (dir: 1 | -1) => {
    const el = strip.current
    if (!el) return
    const all = [...el.querySelectorAll<HTMLElement>('[data-tab]')]
    const from = el.scrollLeft,
      to = from + el.clientWidth
    // The first and last tabs go all the way to the end, padding included.
    // No tab past the edge, only the row's own padding: to the very end,
    // or the arrow stayed lit and did nothing.
    if (dir > 0) {
      const t = all.find((t) => t.offsetLeft + t.offsetWidth > to + 1)
      el.scrollLeft = !t || t === all.at(-1) ? el.scrollWidth : t.offsetLeft + t.offsetWidth - el.clientWidth
    } else {
      const t = all.findLast((t) => t.offsetLeft < from - 1)
      el.scrollLeft = !t || t === all[0] ? 0 : t.offsetLeft
    }
  }
  // Both arrows stay while the row overflows, the one with nothing past it
  // greyed: one coming and going resized the row, and the tab just brought
  // into view was cut off again.
  const over = beyond.left || beyond.right
  return (
    <>
      {over && (
        <Button variant="ghost" size="icon-sm" className="tab-arrow max-[899px]:hidden" disabled={!beyond.left} onClick={() => stepTabs(-1)} aria-label="Show the tab before" title="Earlier tabs">
          <ChevronIcon flip />
        </Button>
      )}
      <nav
        className="tabs"
        role="tablist"
        aria-label="Open tabs"
        ref={strip}
        data-more-left={beyond.left || undefined}
        data-more-right={beyond.right || undefined}
        onTouchStart={() => (swiped.current = true)}
        onScroll={() => {
          measure()
          // A swipe that comes to rest on another tab, on a phone, shows it.
          const el = strip.current
          clearTimeout(settle.current)
          if (!el || !narrow() || ids.indexOf(',') < 0) return
          settle.current = window.setTimeout(() => {
            if (Math.abs(el.scrollLeft - placed.current) < 2) return
            if (!swiped.current) return reveal()
            swiped.current = false
            const at = [...el.querySelectorAll<HTMLElement>('[data-tab]')].find((t) => Math.abs(t.offsetLeft - el.scrollLeft) < t.offsetWidth / 2)
            if (at?.dataset.tab && at.dataset.tab !== active) onPick(at.dataset.tab)
            else reveal()
          }, 140)
        }}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {children}
        <span className="tabs-end" ref={end} aria-hidden="true" />
      </nav>
      {over && (
        <Button variant="ghost" size="icon-sm" className="tab-arrow max-[899px]:hidden" disabled={!beyond.right} onClick={() => stepTabs(1)} aria-label="Show the tab after" title="Later tabs">
          <ChevronIcon />
        </Button>
      )}
    </>
  )
}
