import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { getJSON, HTTPError, postJSON } from './api'
import { fileURL } from './FileView'
import { FileIcon, FolderIcon, Icon } from './icons'
import { filesChanged, useStore } from './store'
import { ChevronIcon } from './viewicons'
import { markOf, markTitle, useGit } from './git'
import { Button } from '@/components/ui/button'
import { toastClass } from '@/lib/toast'
import { cn } from '@/lib/utils'

// The folder's files, one level fetched per expand, like VS Code's
// explorer. Expanded folders are listed again after every turn, since
// Claude may have added or removed files, and after an upload from here. Folders come first either way;
// by date, each group is newest first (a folder's time changes when a file
// is added or removed in it, not when one inside is edited). A file can be
// deleted from here, with Undo (below).

type Entry = { name: string; dir?: boolean; size: number; mtime?: string }

// What the tree showed, by project. On a phone the drawer closes when a
// file opens and the explorer goes with it, so coming back started at the
// top with every folder shut.
const kept = new Map<string, { open: Set<string>; lists: Record<string, Entry[]>; scroll: number }>()

const time = (e: Entry) => Date.parse(e.mtime ?? '') || 0
const newestFirst = (l: Entry[]) => [...l].sort((a, b) => +!!b.dir - +!!a.dir || time(b) - time(a))

type Props = { root: string; onOpen: (path: string) => void; active?: string; byName?: boolean; collapse?: number }

export function Explorer({ root, onOpen, active, byName, collapse = 0 }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => kept.get(root)?.open ?? new Set(['']))
  // Collapse all (the header's action): only the top level stays open.
  const collapsed = useRef(collapse)
  useEffect(() => {
    if (collapse === collapsed.current) return
    collapsed.current = collapse
    setOpen(new Set(['']))
  }, [collapse])
  const [lists, setLists] = useState<Record<string, Entry[]>>(() => kept.get(root)?.lists ?? {})
  const box = useRef<HTMLDivElement>(null)
  const scroll = useRef(kept.get(root)?.scroll ?? 0)
  useEffect(() => {
    kept.set(root, { open, lists, scroll: scroll.current })
  }, [root, open, lists])
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = scroll.current
  }, [])
  const [err, setErr] = useState<{ dir: string; why: string } | null>(null)
  const ended = useStore((s) => s.live.ended)
  const changed = useStore((s) => s.files)

  const load = async (dir: string) => {
    try {
      const l = await getJSON<Entry[]>(fileURL('list', root, dir))
      setLists((cur) => ({ ...cur, [dir]: l }))
      setErr(null)
    } catch (e) {
      if (dir && e instanceof HTTPError && e.status === 404) {
        // An expanded folder was moved or deleted since (by Claude, say):
        // forget it and what was open under it; the parent's list no
        // longer shows it.
        const gone = (p: string) => p === dir || p.startsWith(dir + '/')
        setOpen((cur) => new Set([...cur].filter((p) => !gone(p))))
        setLists((cur) => Object.fromEntries(Object.entries(cur).filter(([p]) => !gone(p))))
        return
      }
      setErr({ dir, why: String(e instanceof Error ? e.message : e) })
    }
  }

  useEffect(() => {
    open.forEach((d) => load(d))
  }, [root, ended, changed])

  const toggle = (dir: string) => {
    const next = new Set(open)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (!lists[dir]) load(dir)
    }
    setOpen(next)
  }

  // Deleting a file: a right-click (a long press on a phone) asks, the
  // file goes to the server's trash (filetrash.go), and Undo stays offered
  // for a while. Folders are not deleted here.
  const [ask, setAsk] = useState('')
  // Keeping the file puts the focus back on its row.
  const keep = () => {
    const p = ask
    setAsk('')
    focusRow(p)
  }
  const [undo, setUndo] = useState<{ trash: string; path: string } | null>(null)
  const [delErr, setDelErr] = useState('')
  const errPath = useRef('')
  // The focus lands on a row (the one named, once the list has it), or
  // on the first row: never on the page, after the toast it was in goes.
  const focusRow = (p: string, tries = 10) =>
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(p)}"]`)
      if (row) return row.focus({ preventScroll: true })
      if (tries > 0) return void setTimeout(() => focusRow(p, tries - 1), 60)
      document.querySelector<HTMLElement>('.tree-row')?.focus({ preventScroll: true })
    })
  const dismissErr = () => {
    setDelErr('')
    focusRow(errPath.current, 0)
  }
  const press = useRef(0)
  const pressed = useRef(false) // a long press opened the question; the tap that ends it opens nothing
  // Undo goes after 10 s, but not while it has the focus (it was moved
  // there from Delete): then it waits until the focus leaves.
  useEffect(() => {
    if (!undo) return
    let t = 0
    const tick = () => {
      if (document.activeElement?.closest('.explorer .toast')) t = window.setTimeout(tick, 1000)
      else setUndo(null)
    }
    t = window.setTimeout(tick, 10_000)
    return () => clearTimeout(t)
  }, [undo])
  const remove = async (path: string) => {
    setAsk('')
    setDelErr('')
    try {
      const r = await postJSON<{ trash: string }>(fileURL('delete', root, path), {})
      setUndo({ trash: r.trash, path })
      filesChanged()
    } catch (e) {
      errPath.current = path
      setDelErr(`Could not delete ${path}: ` + (e instanceof Error ? e.message : e))
    }
  }
  const restore = async () => {
    if (!undo) return
    setUndo(null)
    try {
      await postJSON('/api/files/restore', { trash: undo.trash })
      filesChanged()
      focusRow(undo.path) // back in the list, where Undo was
    } catch (e) {
      errPath.current = undo.path
      setDelErr(`Could not put ${undo.path} back: ` + (e instanceof Error ? e.message : e))
    }
  }

  // Changed files in git's colours, as VS Code shows them; a folder with
  // a change inside gets a dot.
  const git = useGit(root)
  const marks: Record<string, string> = {}
  const branchOf: Record<string, string> = Object.fromEntries((git?.repos ?? []).filter((r) => r.path && r.branch).map((r) => [r.path, r.branch!]))
  if (git?.repo && git.files.length)
    for (const [dir, l] of Object.entries(lists))
      for (const e of l) {
        const p = dir ? dir + '/' + e.name : e.name
        const m = markOf(git, p, !!e.dir)
        if (m) marks[p] = m
      }

  const rows = (dir: string, depth: number): ReactNode[] =>
    (byName ? (lists[dir] ?? []) : newestFirst(lists[dir] ?? [])).flatMap((e) => {
      const p = dir ? dir + '/' + e.name : e.name
      const row = (
        <div
          key={p}
          className={cn('tree-row', 'rounded-md text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground', p === active && 'current bg-sidebar-accent font-medium text-sidebar-accent-foreground')}
          style={{ ['--depth' as string]: depth }}
          onClick={() => {
            if (pressed.current) return void (pressed.current = false)
            if (e.dir) toggle(p)
            else onOpen(p)
          }}
          onContextMenu={(ev) => {
            if (e.dir) return
            ev.preventDefault()
            setAsk(p)
          }}
          onTouchStart={() => {
            pressed.current = false
            if (!e.dir) press.current = window.setTimeout(() => ((pressed.current = true), setAsk(p)), 550)
          }}
          onTouchEnd={() => clearTimeout(press.current)}
          onTouchMove={() => clearTimeout(press.current)}
          onKeyDown={(ev) => {
            // Delete, or the menu key / Shift+F10, asks to delete a file,
            // as a right click or a long press does.
            if (!e.dir && (ev.key === 'Delete' || ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey))) {
              ev.preventDefault()
              setAsk(p)
              return
            }
            if (ev.key !== 'Enter' && ev.key !== ' ') return
            ev.preventDefault()
            if (e.dir) toggle(p)
            else onOpen(p)
          }}
          data-path={p}
          role="treeitem"
          tabIndex={0}
          aria-level={depth + 1}
          aria-expanded={e.dir ? open.has(p) : undefined}
          aria-selected={p === active}
        >
          <span className={'tree-caret' + (e.dir && open.has(p) ? ' open' : '')}>{e.dir && <ChevronIcon sm />}</span>
          {e.dir ? <FolderIcon /> : <FileIcon path={e.name} size={16} />}
          <span className={'ellipsis' + (marks[p] ? ' git-' + marks[p] : '')}>
            {e.name}
            {e.dir && branchOf[p] && <span className="tree-branch"> {branchOf[p]}</span>}
          </span>
          {marks[p] && (
            <span className={'git-mark git-' + marks[p] + (e.dir ? ' git-dir' : '')} role="img" aria-label={e.dir ? 'Changes inside' : markTitle[marks[p]]}>
              {e.dir ? '' : marks[p]}
            </span>
          )}
        </div>
      )
      if (!e.dir || !open.has(p)) return [row]
      // An open folder with nothing in it says so, rather than looking
      // like one that failed or is still loading.
      const empty = lists[p] && !lists[p].length && (
        <div key={p + '/'} className="tree-empty" style={{ ['--depth' as string]: depth + 1 }} role="none">
          <span className="tree-caret" />
          Empty
        </div>
      )
      return [row, ...rows(p, depth + 1), empty]
    })

  return (
    <div
      className="explorer"
      role="tree"
      aria-label="Files"
      ref={box}
      onScroll={(e) => {
        scroll.current = e.currentTarget.scrollTop
        const k = kept.get(root)
        if (k) k.scroll = scroll.current
      }}
    >
      {err && (
        // The app's own sentence first, the server's reason under it.
        <div className="explorer-err" role="alert">
          <Icon name="circle-x" sm className="mark-x" />
          <span className="explorer-err-text">
            <b>Couldn't read {err.dir ? err.dir : 'the folder'}.</b>
            <span className="explorer-err-why">{err.why}</span>
          </span>
          <Button variant="outline" size="xs" onClick={() => open.forEach((d) => load(d))}>
            Retry
          </Button>
        </div>
      )}
      {rows('', 0)}
      {lists[''] && !lists[''].length && <div className="faint small pad">No files.</div>}
      {ask && (
        <div
          className={toastClass}
          role="dialog"
          aria-label={`Delete ${ask}`}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') keep()
          }}
        >
          <span className="ellipsis">Delete {ask}?</span>
          <Button variant="destructive" size="xs" onClick={() => remove(ask)} autoFocus>
            Delete
          </Button>
          <button className="tab-x light" aria-label="Keep it" onClick={keep}>
            <Icon name="x" sm />
          </button>
        </div>
      )}
      {!ask && undo && (
        <div className={toastClass} role="status">
          <span className="ellipsis">Deleted {undo.path}</span>
          {/* The focus moves here from the Delete just pressed. */}
          <Button variant="outline" size="xs" onClick={restore} autoFocus>
            Undo
          </Button>
        </div>
      )}
      {!ask && !undo && delErr && (
        <div className={toastClass} role="alert">
          <span className="toast-msg" title={delErr}>
            {delErr}
          </span>
          <button className="tab-x light" aria-label="Dismiss" onClick={dismissErr} autoFocus>
            <Icon name="x" sm />
          </button>
        </div>
      )}
    </div>
  )
}
