// What this browser remembers on its own: open tabs per folder, layout
// choices. Which sessions have been read is the server's, shared by every
// device (markSeen below).

import { postJSON } from './api'
import type { Move, Session } from './types'

// A pane's tabs. The workspace has one pane, or two side by side on a
// laptop (split view, from a contributor's branch): the first pane's tabs stay at
// the top level, so a list saved before the split reads as it was; the
// second pane is `right`, `focus` says which pane the explorer and new tabs
// act on, and `ratio` is the first pane's share of the width.
export type Pane = { ids: string[]; active: string }
export type Tabs = Pane & { right?: Pane; focus?: 'right'; ratio?: number }

// One folder, two spellings: Windows ignores case and the CLIs record the
// drive letter both ways, and the server spells a folder as its newest
// session does. A Codex session in C:\ made c:\'s tabs look sessionless
// and they were dropped.
export const folderKey = (p: string) => (/^[a-z]:[\\/]/i.test(p) ? p.toLowerCase() : p)
export const sameFolder = (a: string | undefined, b: string) => a !== undefined && folderKey(a) === folderKey(b)

const tabsKey = (folder: string) => 'dakort.tabs:' + folderKey(folder)
const lastKey = 'dakort.lastFolder'

// The folder last on screen, where the app opens next time.
export const lastFolder = () => localStorage.getItem(lastKey) ?? ''
export const setLastFolder = (folder: string) => localStorage.setItem(lastKey, folder)

// movedPath is where a folder is now, after the renames (move.go): the
// folder itself or one inside it. Unmoved, it is p as given.
export function movedPath(p: string, moves: Move[]): string {
  for (const m of moves) {
    const k = folderKey(p)
    const from = folderKey(m.from).replace(/[\\/]+$/, '')
    if (k === from || (k.startsWith(from) && /^[\\/]/.test(k.slice(from.length)))) p = m.to + p.slice(from.length)
  }
  return p
}

// followMoves carries what this browser keeps under a renamed folder's old
// path (its tabs, the draft of a new session there, the folder last on
// screen) over to the new one; another device's own keep follows the next
// time it loads the lists. Once moved, the old keys are gone, so it runs
// once per rename.
export function followMoves(moves: Move[]) {
  if (!moves.length) return
  const rekey = (prefix: string, toKey: (p: string) => string = (p) => p) => {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      const p = key.slice(prefix.length)
      const to = movedPath(p, moves)
      if (to === p) continue
      const next = prefix + toKey(to)
      if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key) ?? '')
      localStorage.removeItem(key)
    }
  }
  rekey('dakort.tabs:', folderKey)
  rekey('dakort.draft:new:')
  const last = lastFolder()
  if (last && movedPath(last, moves) !== last) setLastFolder(movedPath(last, moves))
}

// Whether the explorer shows on a laptop, also in the next folder.
const explorerShownKey = 'dakort.explorerShown'
export const explorerShown = () => localStorage.getItem(explorerShownKey) !== '0'
export const setExplorerShown = (on: boolean) => localStorage.setItem(explorerShownKey, on ? '1' : '0')

// How the explorer sorts: newest first unless A–Z was picked.
const filesSortKey = 'dakort.filesSort'
export const filesByName = () => localStorage.getItem(filesSortKey) === 'name'
export const setFilesByName = (on: boolean) => localStorage.setItem(filesSortKey, on ? 'name' : 'date')

// The explorer's width on a laptop, as dragged.
const explorerKey = 'dakort.explorerWidth'
export const explorerWidth = () => Number(localStorage.getItem(explorerKey)) || 280
export const setExplorerWidth = (w: number) => localStorage.setItem(explorerKey, String(Math.round(w)))

export function loadTabs(folder: string): Tabs {
  try {
    // saved under the spelling itself before folderKey
    const t = JSON.parse(localStorage.getItem(tabsKey(folder)) ?? localStorage.getItem('dakort.tabs:' + folder) ?? '')
    if (Array.isArray(t.ids)) {
      const strings = (l: unknown[]) => l.filter((x): x is string => typeof x === 'string')
      const out: Tabs = { ids: strings(t.ids), active: String(t.active ?? '') }
      if (Array.isArray(t.right?.ids) && t.right.ids.length) {
        out.right = { ids: strings(t.right.ids), active: String(t.right.active ?? '') }
        if (t.focus === 'right') out.focus = 'right'
      }
      if (typeof t.ratio === 'number') out.ratio = clampRatio(t.ratio)
      return out
    }
  } catch {
    // none saved yet
  }
  return { ids: [], active: '' }
}

export function saveTabs(folder: string, t: Tabs) {
  localStorage.setItem(tabsKey(folder), JSON.stringify(t))
}

// NEW is the tab for a session not started yet; FILE prefixes file tabs
// (the rest is the path inside the folder, with forward slashes).
export const NEW = 'new'
export const FILE = 'f:'

// Sessions started here a moment ago, which the list may not have yet.
const fresh = new Map<string, number>()
export const markFresh = (id: string) => fresh.set(id, Date.now())
const isFresh = (id: string) => Date.now() - (fresh.get(id) ?? 0) < 120_000

// The agent a session was just started with, for the moments before the
// list has it ("Starting Claude…" showed over a new Codex session).
const startedWith = new Map<string, string>()
export const noteProvider = (id: string, provider: string) => startedWith.set(id, provider)
export const providerOf = (id: string, listed?: string) => listed || startedWith.get(id) || 'claude'

// The open tabs are the project's, shared by every device through the
// server (tabs.go): the list of what is open, in order. What stays here is
// the view: which tab is on screen, the split, the drafts. reconcile
// brings this device's view in line with the shared list: tabs closed
// elsewhere go, tabs opened elsewhere come in (into the focused pane),
// and each pane follows the shared order. keep says which absent tabs
// stay anyway (a new-session tab holding a draft typed here). flat is
// what this device tells the server.
export function reconcile(t: Tabs, shared: string[] | undefined, keep: (id: string) => boolean = () => false): Tabs {
  if (!shared) return t
  const at = new Map(shared.map((id, i) => [id, i]))
  const order = (ids: string[]) => [...ids].sort((a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity))
  const stay = (id: string) => at.has(id) || keep(id) || isFresh(id)
  const have = new Set([...t.ids, ...(t.right?.ids ?? [])])
  const incoming = shared.filter((id) => !have.has(id))
  const f = focusOf(t)
  let left = t.ids.filter(stay)
  let right = (t.right?.ids ?? []).filter(stay)
  if (f === 1) right = [...right, ...incoming]
  else left = [...left, ...incoming]
  left = order(left)
  right = order(right)
  const pick = (was: Pane, ids: string[]) => {
    if (ids.includes(was.active)) return was.active
    const i = was.ids.indexOf(was.active)
    return ids[Math.min(Math.max(i, 0), ids.length - 1)] ?? ''
  }
  const out: Tabs = { ids: left, active: pick({ ids: t.ids, active: t.active }, left) }
  if (right.length) {
    out.right = { ids: right, active: pick(t.right ?? { ids: [], active: '' }, right) }
    if (t.focus === 'right') out.focus = 'right'
  }
  if (t.ratio !== undefined) out.ratio = t.ratio
  return withPane(out, 0, { ids: out.ids, active: out.active }, focusOf(out))
}

export const flat = (t: Tabs): string[] => [...t.ids, ...(t.right?.ids ?? [])]

// tabsFor drops tabs whose session is gone (from every folder, when exists
// is given: a session missing from this folder's list for a moment is no
// reason to close its tab), adds sessions with a turn running or finished
// work not seen (work started in a terminal, or a session nobody has open,
// shows up on its own) at the front, where a phone shows them, newest
// first, and opens the folder's latest session when no tab is left (or a
// new one in a folder with none). sessions is the folder's, newest first.
// A tab closed by hand stays closed: closing marks the session read, so
// only new activity brings it back.
export function tabsFor(t: Tabs, sessions: Session[], running: (id: string) => boolean = () => false, exists?: (id: string) => boolean): Tabs {
  const known = new Set(sessions.map((s) => s.id))
  const there = exists ?? ((id: string) => known.has(id))
  const keep = (id: string) => id === NEW || id.startsWith(FILE) || there(id) || isFresh(id)
  let right = (t.right?.ids ?? []).filter(keep)
  let ids = t.ids.filter((id) => keep(id) && !right.includes(id))
  for (const s of [...sessions].reverse()) {
    if (ids.includes(s.id) || right.includes(s.id) || !(running(s.id) || isUnread(s))) continue
    ids = [s.id, ...ids]
  }
  let leftActive = t.active
  // The first pane emptied: the second takes its place.
  if (!ids.length && right.length) {
    ids = right
    leftActive = t.right!.active
    right = []
  }
  if (!ids.length) ids = sessions.length ? [sessions[0].id] : [NEW]
  const out: Tabs = { ids, active: ids.includes(leftActive) ? leftActive : (ids[0] ?? '') }
  if (right.length) {
    out.right = { ids: right, active: right.includes(t.right!.active) ? t.right!.active : right[0] }
    if (t.focus === 'right') out.focus = 'right'
  }
  if (t.ratio !== undefined) out.ratio = t.ratio
  return out
}

// Split view. Panes are numbered 0 (left, the only one without a split)
// and 1 (right). A tab is in one pane at a time.
export type PaneNo = 0 | 1
export const clampRatio = (r: number) => Math.max(0.25, Math.min(0.75, r || 0.5))
export const focusOf = (t: Tabs): PaneNo => (t.right && t.focus === 'right' ? 1 : 0)
export const paneOf = (t: Tabs, id: string): PaneNo | -1 => (t.ids.includes(id) ? 0 : t.right?.ids.includes(id) ? 1 : -1)
export const pane = (t: Tabs, p: PaneNo): Pane => (p === 1 ? (t.right ?? { ids: [], active: '' }) : { ids: t.ids, active: t.active })

// withPane puts a pane's new tabs in place and tidies: an empty second
// pane closes the split, an empty first pane hands over to the second.
export function withPane(t: Tabs, p: PaneNo, next: Pane, focus: PaneNo = focusOf(t)): Tabs {
  let left: Pane = p === 0 ? next : { ids: t.ids, active: t.active }
  let right: Pane | undefined = p === 1 ? next : t.right
  if (!left.ids.length && right?.ids.length) {
    left = right
    right = undefined
    focus = 0
  }
  if (right && !right.ids.length) right = undefined
  const out: Tabs = { ids: left.ids, active: left.active }
  if (right) {
    out.right = right
    if (focus === 1) out.focus = 'right'
  }
  if (t.ratio !== undefined) out.ratio = t.ratio
  return out
}

// selectTab shows a tab: where it already is, else in the given pane (the
// focused one by default), and focuses that pane.
export function selectTab(t: Tabs, id: string, into: PaneNo = focusOf(t)): Tabs {
  const at = paneOf(t, id)
  const p: PaneNo = at === -1 ? (t.right ? into : 0) : at
  const cur = pane(t, p)
  return withPane(t, p, { ids: cur.ids.includes(id) ? cur.ids : [...cur.ids, id], active: id }, p)
}

export function closeTab(t: Tabs, id: string): Tabs {
  const p = paneOf(t, id)
  if (p === -1) return t
  const cur = pane(t, p)
  const i = cur.ids.indexOf(id)
  const ids = cur.ids.filter((x) => x !== id)
  return withPane(t, p, { ids, active: cur.active === id ? (ids[Math.min(i, ids.length - 1)] ?? '') : cur.active })
}

// moveTab takes a tab into a pane (making the second pane if need be), at
// a place in its strip (the end by default), active there and focused.
export function moveTab(t: Tabs, id: string, to: PaneNo, at?: number): Tabs {
  const from = paneOf(t, id)
  if (from === -1) return selectTab(t, id, to)
  // Take it out without collapsing anything yet: the move may refill the
  // pane it leaves (a reorder) or empty it on purpose.
  const src = pane(t, from)
  const i = src.ids.indexOf(id)
  const rest = src.ids.filter((x) => x !== id)
  const srcPane: Pane = { ids: rest, active: src.active === id ? (rest[Math.min(i, rest.length - 1)] ?? '') : src.active }
  const dst = from === to ? srcPane : pane(t, to)
  const ids = [...dst.ids]
  ids.splice(at === undefined ? ids.length : Math.max(0, Math.min(at, ids.length)), 0, id)
  const placed: Pane = { ids, active: id }
  const left = to === 0 ? placed : from === 0 ? srcPane : pane(t, 0)
  const right: Pane = to === 1 ? placed : from === 1 ? srcPane : pane(t, 1)
  return withPane({ ...t, ids: left.ids, active: left.active, right }, 1, right, to)
}

// split opens the second pane with a tab: the given one moved over, or,
// when it is the first pane's only tab, a new session beside it.
export function split(t: Tabs, id: string): Tabs {
  if (t.right || t.ids.length > 1) return moveTab(t, id, 1)
  if (id === NEW) return t
  return { ...t, right: { ids: [NEW], active: NEW }, focus: 'right' }
}

// splitBeside is the split button: the tab on screen stays where it is and
// a new session opens beside it, as a split in VS Code or Chrome keeps the
// current page on the left (as expected; moving the tab over did
// not read as a split). A new-session tab already open goes over instead.
export function splitBeside(t: Tabs): Tabs {
  if (t.right) return t
  if (t.ids.includes(NEW)) return t.ids.length > 1 ? moveTab(t, NEW, 1) : t
  return { ...t, right: { ids: [NEW], active: NEW }, focus: 'right' }
}

// unsplit closes the second pane; its tabs go back to the first.
export function unsplit(t: Tabs): Tabs {
  if (!t.right) return t
  const out: Tabs = { ids: [...t.ids, ...t.right.ids.filter((x) => !t.ids.includes(x))], active: t.active }
  if (t.ratio !== undefined) out.ratio = t.ratio
  return out
}

// merged is one list of every tab, for a phone, which shows one pane.
export const merged = (t: Tabs): Pane => ({ ids: [...t.ids, ...(t.right?.ids ?? [])], active: pane(t, focusOf(t)).active })

// Seen is the server's (seen.go), shared by every device: each session in
// the list says how far it has been read. It was kept per browser, so an
// answer read on the phone stayed unread on the laptop. Marking takes
// effect here at once and goes to the server a moment later (a running
// turn moves updated with every row; one post for the lot), and every
// device's list then carries it.
const markedHere = new Map<string, string>()
const posting = new Map<string, number>()

const seenOf = (s: Session) => {
  const here = markedHere.get(s.id)
  return here && (!s.seen || Date.parse(here) > Date.parse(s.seen)) ? here : s.seen
}

// Only a page someone is looking at reads: now that seen is shared, a
// phone on the desk or a background browser tab with the session open
// would otherwise mark every answer read the moment it finished.
export function markSeen(s: Session) {
  if (document.visibilityState !== 'visible' || !isUnread(s)) return
  markedHere.set(s.id, s.updated)
  clearTimeout(posting.get(s.id))
  posting.set(
    s.id,
    window.setTimeout(() => {
      posting.delete(s.id)
      postJSON(`/api/sessions/${s.id}/seen`, { updated: markedHere.get(s.id) }).catch(() => {
        // the next look marks it again
        markedHere.delete(s.id)
      })
    }, 800),
  )
}

// A session with no seen time (a server from before seen.go) is read.
export function isUnread(s: Session): boolean {
  const seen = seenOf(s)
  return !!seen && Date.parse(s.updated) > Date.parse(seen)
}

// finishedIn is how many of the sessions that finished unseen belong to
// the folder on screen (every one, on the home screen): the count in the
// page title.
export const finishedIn = (ids: string[], sessions: Session[], folder: string) =>
  folder ? ids.filter((id) => sameFolder(sessions.find((s) => s.id === id)?.folder, folder)).length : ids.length

// resumeCommand continues a session in a terminal. The terminal's /resume
// picker does not list sessions the CLI ran headless (all of Dakort's), but
// --resume with the id opens them; the CLI looks for the id in the
// project of the folder it runs in, hence the cd. `;` and single quotes
// read the same in PowerShell, bash and zsh.
export function resumeCommand(s: Pick<Session, 'id' | 'provider' | 'cwd'>): string {
  const run = s.provider === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`
  if (!s.cwd) return run
  const dir = s.cwd.includes("'") ? `"${s.cwd}"` : `'${s.cwd}'`
  return `cd ${dir}; ${run}`
}
