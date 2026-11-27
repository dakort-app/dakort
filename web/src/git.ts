import { useEffect, useSyncExternalStore } from 'react'
import { getJSON } from './api'
import { useStore } from './store'

// What git says about a project's folder (server: git.go), one copy per
// folder for the explorer, the Changes list and the file tabs alike. It is
// asked again after every turn, after a change made from this page, when
// the page comes back into view, and every few seconds while it is in
// view, since a commit or an edit from a terminal says nothing to us.

// x is the change staged (in the index), y the one not staged, each a
// mark or empty; ia/id and wa/wd the lines added and removed on each side.
export type GitFile = { path: string; st: string; repo: string; x?: string; y?: string; ia?: number; id?: number; wa?: number; wd?: number }
// upstream is where it pulls and pushes ("origin/main"), remote whether it
// has anywhere to push, head the commit's short hash; detached is a
// checked out commit, back the branch it was left from.
export type GitRepo = {
  path: string
  branch?: string
  ahead?: number
  behind?: number
  upstream?: string
  remote?: boolean
  head?: string
  detached?: boolean
  back?: string
  local?: GitFile[] // every tracked file not on the upstream, committed or not
}
export type GitState = { repo: boolean; branch?: string; ahead?: number; behind?: number; repos: GitRepo[]; files: GitFile[] }

const every = 5000
const states = new Map<string, GitState>()
const users = new Map<string, number>()
const timers = new Map<string, () => void>()
const subs = new Set<() => void>()
const asking = new Set<string>()
// Folders asked for again while an answer was on its way: that answer may
// predate the change that prompted the ask (a discard during a poll left
// the discarded file listed until the next poll), so one more ask follows.
const again = new Set<string>()
const emit = () => subs.forEach((f) => f())

async function ask(root: string) {
  if (asking.has(root)) {
    again.add(root)
    return
  }
  asking.add(root)
  try {
    const st = await getJSON<GitState>('/api/git?root=' + encodeURIComponent(root))
    if (JSON.stringify(st) !== JSON.stringify(states.get(root))) {
      states.set(root, st)
      emit()
    }
  } catch {
    // a lost connection; the next round asks again
  } finally {
    asking.delete(root)
    if (again.delete(root)) ask(root)
  }
}

// useGit is the folder's state, kept fresh while anything shows it.
export function useGit(root: string): GitState | undefined {
  const ended = useStore((s) => s.live.ended)
  const changed = useStore((s) => s.files)
  // One timer per folder, however many views show it.
  useEffect(() => {
    const n = (users.get(root) ?? 0) + 1
    users.set(root, n)
    if (n === 1) {
      const tick = () => document.visibilityState === 'visible' && ask(root)
      const t = window.setInterval(tick, every)
      document.addEventListener('visibilitychange', tick)
      timers.set(root, () => {
        clearInterval(t)
        document.removeEventListener('visibilitychange', tick)
      })
    }
    return () => {
      const n = (users.get(root) ?? 1) - 1
      users.set(root, n)
      if (n === 0) {
        timers.get(root)?.()
        timers.delete(root)
      }
    }
  }, [root])
  useEffect(() => {
    ask(root)
  }, [root, ended, changed])
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => states.get(root),
  )
}

// The innermost repository holding a path: '' for the folder's own, a
// repository's path for one below, null for none.
export function repoOf(st: GitState, path: string): string | null {
  let best: string | null = null
  for (const r of st.repos)
    if (r.path === '' ? best === null : path === r.path || path.startsWith(r.path + '/'))
      if (best === null || r.path.length > best.length) best = r.path
  return best
}

// markOf is a path's mark, as the innermost repository holding it says:
// its own, or one on a new folder around it; for a folder, a dot when
// something under it changed, in any repository.
export function markOf(st: GitState | undefined, path: string, dir: boolean): string {
  if (!st?.repo) return ''
  const repo = repoOf(st, path)
  let under = ''
  for (const f of st.files) {
    if (f.repo === repo && (f.path === path || (f.path.endsWith('/') && (path + '/').startsWith(f.path)))) return f.st
    if (dir && f.path.startsWith(path + '/')) under = 'M'
  }
  return under
}

export const markTitle: Record<string, string> = {
  M: 'Modified since the last commit',
  A: 'Added, not yet committed',
  D: 'Deleted, not yet committed',
  R: 'Renamed, not yet committed',
  U: 'New, not yet tracked by git',
  C: 'A merge conflict',
}

// gitChanged asks for the folder's state again now, after a change made
// from this page.
export const gitChanged = (root: string) => ask(root)

// A request to show a file's diff, for a file tab already open: the
// Changes list sets it, the tab takes it. side "remote" is the change
// against the upstream of repository repo (what is not pushed); none is
// the change since the last commit (the file bar's Diff).
export type DiffSide = { side: 'remote'; repo: string }
let diffAsk: { key: string; n: number; side?: DiffSide } = { key: '', n: 0 }
export const diffTaken = { n: 0 } // the last request a tab took
const diffSubs = new Set<() => void>()
export function askDiff(root: string, path: string, side?: DiffSide) {
  diffAsk = { key: root + '\n' + path, n: diffAsk.n + 1, side }
  diffSubs.forEach((f) => f())
}
export function useDiffAsk() {
  return useSyncExternalStore(
    (f) => (diffSubs.add(f), () => diffSubs.delete(f)),
    () => diffAsk,
  )
}
