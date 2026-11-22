import { useEffect, useState, type ReactNode } from 'react'
import { getJSON } from './api'
import { fileURL } from './FileView'
import { askDiff, markTitle, useGit, type GitFile, type GitRepo } from './git'
import { FileIcon, FolderIcon } from './icons'
import { baseName } from './route'

// The files changed since the last commit, as in VS Code's Source Control
// view: a tap opens the file showing its diff. With changes in more than
// one repository (a project of several, or one inside another), each gets
// a heading with its branch, and paths are shown from its folder. A new
// folder git does not track yet is one row, since git names the folder
// and not its files; it opens like a folder in the explorer, everything
// in it new.

type Props = { root: string; onOpen: (path: string) => void; active?: string }
type Entry = { name: string; dir?: boolean }

export function Changes({ root, onOpen, active }: Props) {
  const git = useGit(root)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [lists, setLists] = useState<Record<string, Entry[]>>({})
  // Open folders are listed again when git's answer changes.
  useEffect(() => {
    open.forEach((d) => load(d))
  }, [git])
  if (!git) return <div className="explorer faint small pad">Loading…</div>
  if (!git.repo) return <div className="explorer faint small pad">This folder is not in a git repository.</div>
  if (!git.files.length) return <div className="explorer faint small pad">No changes since the last commit.</div>

  async function load(dir: string) {
    try {
      const l = await getJSON<Entry[]>(fileURL('list', root, dir))
      const byName = [...l].sort((a, b) => +!!b.dir - +!!a.dir || a.name.localeCompare(b.name))
      setLists((cur) => ({ ...cur, [dir]: byName }))
    } catch {
      setLists((cur) => ({ ...cur, [dir]: [] }))
    }
  }
  const toggle = (dir: string) => {
    const next = new Set(open)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      load(dir)
    }
    setOpen(next)
  }
  const openFile = (p: string) => {
    askDiff(root, p)
    onOpen(p)
  }

  // A file row, or a new folder's row with what is in it when open.
  const row = (p: string, label: ReactNode, st: string, dir: boolean, depth: number): ReactNode[] => {
    const shown = dir && open.has(p)
    const me = (
      <div
        key={p}
        className={'tree-row change-row' + (p === active ? ' current' : '')}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (dir ? toggle(p) : openFile(p))}
        title={dir ? p + ': a new folder, not yet tracked by git' : p}
      >
        <span className="tree-caret">{dir ? (shown ? '▾' : '▸') : ''}</span>
        {dir ? <FolderIcon size={15} /> : <FileIcon path={p} size={15} />}
        <span className="ellipsis">{label}</span>
        <span className={'git-mark git-' + st} title={markTitle[st]}>
          {st}
        </span>
      </div>
    )
    if (!shown) return [me]
    const inside = lists[p]
    if (!inside) return [me]
    return [me, ...inside.flatMap((e) => row(p + '/' + e.name, <span className="change-name git-U">{e.name}</span>, 'U', !!e.dir, depth + 1))]
  }

  // A changed path, named from its repository's folder.
  const changed = (f: GitFile, from: string, depth: number) => {
    const dir = f.path.endsWith('/')
    const p = dir ? f.path.slice(0, -1) : f.path
    const inRepo = from ? p.slice(from.length + 1) : p
    const slash = inRepo.lastIndexOf('/')
    const label = (
      <>
        <span className={'change-name git-' + f.st}>{inRepo.slice(slash + 1)}</span>
        {slash > 0 && <span className="faint small"> {inRepo.slice(0, slash)}</span>}
      </>
    )
    return row(p, label, f.st, dir, depth)
  }

  const withFiles = git.repos.filter((r) => git.files.some((f) => f.repo === r.path))
  if (withFiles.length < 2) return <div className="explorer">{git.files.flatMap((f) => changed(f, '', 0))}</div>
  const heading = (r: GitRepo) => (
    <div key={'repo:' + r.path} className="change-repo small" title={(r.path || baseName(root)) + (r.branch ? ` is on branch ${r.branch}` : '')}>
      <span className="ellipsis">{r.path ? baseName(r.path) : baseName(root)}</span>
      {r.branch && <span className="faint"> · {r.branch}</span>}
      {!!r.ahead && <span className="faint"> ↑{r.ahead}</span>}
      {!!r.behind && <span className="faint"> ↓{r.behind}</span>}
    </div>
  )
  return (
    <div className="explorer">
      {withFiles.flatMap((r) => [heading(r), ...git.files.filter((f) => f.repo === r.path).flatMap((f) => changed(f, r.path, 1))])}
    </div>
  )
}
