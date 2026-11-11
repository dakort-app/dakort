// App-wide state: the session and folder lists and the live state, kept in
// step with the stream. Components read it with useStore and open
// transcripts listen for rows to catch up on.

import { useSyncExternalStore } from 'react'
import { api, AuthError } from './api'
import { learnWindow } from './contextwindow'
import { applyEvent, emptyLive, type Live } from './live'
import { showFavicon } from './favicon'
import { finishedIn, flat, folderKey, followMoves, isUnread, loadTabs as loadLocalTabs, movedPath, sameFolder } from './local'
import { folderHash, parseRoute } from './route'
import { Stream, type StreamState } from './stream'
import type { Ev, Folder, Move, Session } from './types'

// A prompt on its way: shown under the transcript until its row is there.
export type Pending = {
  id: string // the prompt id
  session: string // empty until a new session's POST answers
  text: string
  images: string[] // preview URLs
  at: number
  row?: string // the row uuid, once the stream echoes the prompt
}

export type State = {
  sessions: Session[]
  folders: Folder[]
  live: Live
  stream: StreamState
  loaded: boolean
  error: string
  pending: Record<string, Pending>
  context: Record<string, number> // per session, from its last assistant row
  replyModel: Record<string, string> // per session: the model of that row (the context bar's window)
  rowWindow: Record<string, number> // per session: the context window its transcript states (Codex)
  lastReply: Record<string, number> // per session, ms: when its last assistant row was written
  cacheLife: Record<string, string> // per session: the prompt cache its replies write to, "1h" or "5m"
  finished: string[] // sessions that finished a turn while not on screen, newest last
  tabs: Record<string, string[]> // per folder (folderKey): its open tabs, shared by every device; absent until asked for
  latest: string // a newer release's tag, once the server has found one; '' until then
  update: string // the tag the server is installing by itself; '' until then
  build: string // the server's version, from the snapshot
}

let state: State = {
  sessions: [],
  folders: [],
  live: emptyLive,
  stream: 'connecting',
  loaded: false,
  error: '',
  pending: {},
  context: {},
  replyModel: {},
  rowWindow: {},
  lastReply: {},
  cacheLife: {},
  finished: [],
  tabs: {},
  latest: '',
  update: '',
  build: '',
}
const listeners = new Set<() => void>()

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pick(state),
  )
}

export const getState = () => state

// Transcripts on screen register here to hear that their session's file
// grew (or that events were missed, which means the same: catch up). uuid
// is the row an appended event announced: the CLI reports a row before it
// is in the file, so the transcript retries until it shows up.
type CatchUp = (uuid?: string) => void
const catchUps = new Map<string, Set<CatchUp>>()

export function onCatchUp(session: string, f: CatchUp): () => void {
  let s = catchUps.get(session)
  if (!s) catchUps.set(session, (s = new Set()))
  s.add(f)
  return () => s!.delete(f)
}

function catchUp(session?: string, uuid?: string) {
  if (session) catchUps.get(session)?.forEach((f) => f(uuid))
  else catchUps.forEach((s) => s.forEach((f) => f()))
}

function fail(e: unknown) {
  if (e instanceof AuthError) set({ stream: 'auth' })
  else set({ error: String(e instanceof Error ? e.message : e) })
}

let refreshing: Promise<void> | null = null
let again = false

// refreshLists refetches both lists; calls during a fetch fold into one more.
export function refreshLists(): Promise<void> {
  if (refreshing) {
    again = true
    return refreshing
  }
  refreshing = (async () => {
    try {
      do {
        again = false
        const [sessions, folders, moves] = await Promise.all([api.sessions(), api.folders(), api.moves().catch(() => [])])
        followRenames(moves)
        set({ sessions, folders, loaded: true, error: '' })
        dropReadElsewhere()
      } while (again)
    } catch (e) {
      fail(e)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

// followRenames keeps up with folders renamed here or on another device:
// this browser's tabs and drafts follow, and a page on the old folder goes
// to the new one, in place of the old address in its history.
function followRenames(moves: Move[]) {
  followMoves(moves)
  const r = parseRoute(location.hash)
  if (r.page !== 'folder') return
  const to = movedPath(r.folder, moves)
  if (to !== r.folder) location.replace(folderHash(to))
}

// Prompt ids the stream has carried, with their session: a second ack for
// a send whose POST answer was lost.
const acks = new Map<string, string>()
export const ackedSession = (promptId: string) => acks.get(promptId)

export function addPending(p: Pending) {
  set({ pending: { ...state.pending, [p.id]: p } })
}

export function updatePending(id: string, patch: Partial<Pending>) {
  const p = state.pending[id]
  if (p) set({ pending: { ...state.pending, [id]: { ...p, ...patch } } })
}

export function dropPending(...ids: string[]) {
  if (!ids.some((id) => state.pending[id])) return
  const pending = { ...state.pending }
  for (const id of ids) {
    const p = pending[id]
    if (p) p.images.forEach((u) => URL.revokeObjectURL(u))
    delete pending[id]
  }
  set({ pending })
}

export function setContext(session: string, n: number) {
  if (state.context[session] !== n) set({ context: { ...state.context, [session]: n } })
}

export function setReplyModel(session: string, model: string) {
  if (state.replyModel[session] !== model) set({ replyModel: { ...state.replyModel, [session]: model } })
}

export function setRowWindow(session: string, n: number) {
  if (state.rowWindow[session] !== n) set({ rowWindow: { ...state.rowWindow, [session]: n } })
}

export function setCacheLife(session: string, life: string) {
  if (state.cacheLife[session] !== life) set({ cacheLife: { ...state.cacheLife, [session]: life } })
}

export function setLastReply(session: string, ms: number) {
  if (state.lastReply[session] !== ms) set({ lastReply: { ...state.lastReply, [session]: ms } })
}

// Which sessions are on screen (two with a split view), so a turn
// finishing elsewhere can say so. showing adds one and returns its removal.
const viewing = new Map<string, number>()
export function showing(id: string): () => void {
  if (!id) return () => {}
  viewing.set(id, (viewing.get(id) ?? 0) + 1)
  if (state.finished.includes(id)) dismissFinished(id)
  return () => {
    const n = (viewing.get(id) ?? 1) - 1
    if (n > 0) viewing.set(id, n)
    else viewing.delete(id)
  }
}

export function dismissFinished(id: string) {
  set({ finished: state.finished.filter((x) => x !== id) })
  showCount()
}

// The page title names the folder on screen, so Chrome tabs open on
// different folders tell apart. The tab's icon marks a turn finished unseen
// in that folder only: when every tab marked every finish, three tabs on
// three projects all said so and none said where. The home screen, on no
// folder, marks them all.
let place = ''
let placeFolder = ''
export function setPlace(name: string, folder = '') {
  place = name
  placeFolder = folder
  showCount()
}

// The title is just the folder's name ("Dakort" at home): the tab's icon
// says it is Dakort and whether a turn finished unseen, so neither a
// suffix nor a count takes the tab's narrow width any more.
function showCount() {
  document.title = place || 'Dakort'
  showIcon()
}

// The tab's icon by the same rule as the count: a turn finished unseen in
// this tab's folder (every folder, at home), else one running there or
// background tasks (agents, commands) that outlived their turn: those
// once left the icon idle while agents worked.
function showIcon() {
  const here = (id: string) => !placeFolder || sameFolder(state.sessions.find((s) => s.id === id)?.folder, placeFolder)
  const working = [...Object.keys(state.live.turns), ...Object.keys(state.live.tasks)].some(here)
  if (finishedIn(state.finished, state.sessions, placeFolder)) showFavicon('done')
  else showFavicon(working ? 'run' : 'idle')
}
listeners.add(showIcon)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  for (const id of viewing.keys()) if (state.finished.includes(id)) dismissFinished(id)
})

// No system notifications: the Windows popups were found intrusive. The
// toast and the count in the page title are enough.

function finishedElsewhere(id: string) {
  const onScreen = viewing.has(id) && document.visibilityState === 'visible'
  if (onScreen) return
  seenWhenFinished.set(id, state.sessions.find((s) => s.id === id)?.seen)
  set({ finished: [...state.finished.filter((x) => x !== id), id] })
  showCount()
}

// Read on another device: the server's seen time for it has moved since it
// finished, and it is no longer unread. (Not merely "not unread": a list
// fetched before the index has the turn's last row would say so too.)
const seenWhenFinished = new Map<string, string | undefined>()
function dropReadElsewhere() {
  const read = state.finished.filter((id) => {
    const s = state.sessions.find((x) => x.id === id)
    return s && s.seen !== seenWhenFinished.get(id) && !isUnread(s)
  })
  if (read.length) set({ finished: state.finished.filter((id) => !read.includes(id)) })
  if (read.length) showCount()
}

// Collapse asks a session's transcript to show only its newest rows, after
// a send, so the reply is not buried under pages read earlier.
const collapses = new Map<string, Set<() => void>>()

export function onCollapse(session: string, f: () => void): () => void {
  let s = collapses.get(session)
  if (!s) collapses.set(session, (s = new Set()))
  s.add(f)
  return () => s!.delete(f)
}

export function collapse(session: string) {
  collapses.get(session)?.forEach((f) => f())
}

function handle(e: Ev) {
  events.push(e)
  if (events.length > 200) events.shift()
  if (e.promptId && e.session) {
    acks.set(e.promptId, e.session)
    const p = state.pending[e.promptId]
    if (p && (!p.session || (e.type === 'appended' && e.uuid && !p.row))) {
      updatePending(e.promptId, { session: e.session, ...(e.type === 'appended' && e.uuid ? { row: e.uuid } : {}) })
    }
  }
  set({ live: applyEvent(state.live, e) })
  switch (e.type) {
    case 'snapshot':
      // A fresh connect or a gap: lists and transcripts may be behind.
      refreshLists()
      catchUp()
      if (e.build) {
        newBuild(e.build)
        set({ build: e.build })
      }
      if (e.latest) set({ latest: e.latest })
      set({ update: e.update ?? '' })
      break
    case 'release':
      set({ latest: e.latest ?? '', update: e.update ?? '' })
      break
    case 'tabs':
      if (e.folder) set({ tabs: { ...state.tabs, [folderKey(e.folder)]: e.tabs ?? [] } })
      break
    case 'sessions':
    case 'folders':
      refreshLists()
      break
    case 'appended':
      catchUp(e.session, e.uuid)
      break
    case 'turn':
      // A new session's file appears with its first turn; and the list's
      // running marks come from here as well as from the list.
      if (e.state === 'done') {
        // The CLI says how big the turn's model's context is.
        if (e.result?.contextWindow) learnWindow(e.result.model ?? '', e.result.contextWindow)
        refreshLists()
        // An idle compaction is housekeeping, not a reply to announce.
        if (e.session && !e.idle) finishedElsewhere(e.session)
      }
      break
  }
}

let stream: Stream | null = null

export function startStore() {
  if (stream) return
  stream = new Stream(handle, streamState)
  stream.start()
  refreshLists()
  // For poking at from the browser console.
  Object.assign(window, { dakort: { getState, stream, events } })
}

// The last few events, newest last, for the console.
const events: Ev[] = []

// The open tabs per folder are shared through the server (tabs.go). The
// first look at a folder asks for its list; a folder the server has no
// list for yet is seeded with what this browser had, so a browser from
// before carries its tabs over. Changes made here go up at once; changes
// made elsewhere arrive as tabs events.

// Out of touch, a page's lists may be behind: it hears no tabs events, and
// a reconnect replays the missed events, not the lists. A phone waking with
// the list from before it slept sent that list up and closed, on every
// device, the tabs opened meanwhile. So the lists go when the stream does
// (shareTabs sends nothing for a folder without one) and come back fresh
// from the server when it is open again.
const followed = new Set<string>()
function streamState(s: StreamState) {
  if (s !== 'open' && state.stream === 'open') set({ tabs: {} })
  if (s === 'open' && state.stream !== 'open') for (const folder of followed) loadSharedTabs(folder)
  set({ stream: s })
}

export async function loadSharedTabs(folder: string) {
  followed.add(folder)
  const key = folderKey(folder)
  try {
    const { ids } = await api.tabs(folder)
    if (state.stream !== 'open') return // asked again once it is
    if (ids) {
      set({ tabs: { ...state.tabs, [key]: ids } })
      return
    }
    const mine = flat(loadLocalTabs(folder))
    set({ tabs: { ...state.tabs, [key]: mine } })
    if (mine.length) await api.setTabs(folder, mine)
  } catch {
    // the next look, or the next snapshot, asks again
  }
}

export function shareTabs(folder: string, ids: string[]) {
  const key = folderKey(folder)
  const cur = state.tabs[key]
  if (!cur || (cur.length === ids.length && cur.every((id, i) => id === ids[i]))) return
  set({ tabs: { ...state.tabs, [key]: ids } })
  api.setTabs(folder, ids).catch(() => {
    // the next change tries again
  })
}

// A page outlives the server it came from: a deploy restarts the server
// with a new build between turns, the stream reconnects, and the page
// would go on running the old code (tabs open since the morning showed
// the old count rule all day). The snapshot names the build; a page from
// another one reloads, at once when nobody is looking at it, else the
// moment it is hidden. Drafts and tabs are kept, so nothing is lost.
let loadedBuild = ''
function newBuild(build: string) {
  if (!loadedBuild) {
    loadedBuild = build
    return
  }
  if (build === loadedBuild) return
  const reload = () => location.reload()
  if (document.visibilityState !== 'visible') reload()
  else document.addEventListener('visibilitychange', () => document.visibilityState !== 'visible' && reload(), { once: true })
}
