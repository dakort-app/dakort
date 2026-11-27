import { useState, type ReactNode } from 'react'
import { getJSON } from './api'
import { fileURL } from './FileView'
import { askDiff, markTitle, useGit, type GitFile, type GitRepo, type GitState } from './git'
import { BranchIcon, FileIcon, FolderIcon } from './icons'
import { baseName } from './route'
import { ChevronIcon } from './viewicons'
import { cn } from '@/lib/utils'

// Changes, read only (a pared-down VS Code Source Control): per
// repository, its branch and how far it is ahead of the remote, then every
// file not on the remote yet, changed and committed but not pushed as much
// as only changed. A tap opens the file showing its diff against the
// remote. Committing, pushing and the rest are left to the agent or a
// terminal. A branch with no upstream lists what changed since the last
// commit. With more than one repository each gets a heading.
type Props = { root: string; onOpen: (path: string) => void; active?: string }

export function Changes({ root, onOpen, active }: Props) {
  const git = useGit(root)
  if (!git) return <div className="explorer changes-empty">Loading…</div>
  if (!git.repo) return <div className="explorer changes-empty">This folder is not in a git repository.</div>
  const listed = git.repos.map((r) => ({ repo: r, files: localOf(r, git.files.filter((f) => f.repo === r.path)) }))
  const shown = listed.length < 2 ? listed : listed.filter((l) => l.repo.path === '' || l.files.length || l.repo.ahead)
  return (
    <div className="explorer scm">
      {shown.map((l) => (
        <RepoChanges key={l.repo.path} root={root} repo={l.repo} files={l.files} many={shown.length > 1} onOpen={onOpen} active={active} />
      ))}
    </div>
  )
}

// What is not on the remote: with an upstream, the tracked files that
// differ from it and the untracked ones; without, the change since the
// last commit, staged or not, as one.
function localOf(repo: GitRepo, files: GitFile[]): GitFile[] {
  const out = repo.upstream ? [...(repo.local ?? []), ...files.filter((f) => f.y === 'U')] : files.map((f) => ({ ...f, wa: (f.ia ?? 0) + (f.wa ?? 0), wd: (f.id ?? 0) + (f.wd ?? 0) }))
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

// How many files are not on the remote, for the badge on Changes.
export function localCount(git: GitState | undefined): number {
  return git ? git.repos.reduce((n, r) => n + localOf(r, git.files.filter((f) => f.repo === r.path)).length, 0) : 0
}

// Where the branch stands, in a few words.
function standing(repo: GitRepo, n: number): string {
  if (repo.detached) return 'A checked out commit'
  if (!repo.upstream) return repo.remote ? 'Not published' : 'No remote'
  const parts: string[] = []
  if (repo.ahead) parts.push(repo.ahead + (repo.ahead === 1 ? ' commit' : ' commits') + ' to push')
  else if (n) parts.push('Not committed')
  if (repo.behind) parts.push(repo.behind + ' behind')
  return parts.join(' · ') || 'Up to date'
}

type RepoProps = { root: string; repo: GitRepo; files: GitFile[]; many: boolean; onOpen: (path: string) => void; active?: string }

function RepoChanges({ root, repo, files, many, onOpen, active }: RepoProps) {
  // A new folder git does not track yet is one row, since git names the
  // folder and not its files; it opens like a folder in the explorer,
  // everything in it new.
  const [dirs, setDirs] = useState<Set<string>>(new Set())
  const [lists, setLists] = useState<Record<string, { name: string; dir?: boolean }[]>>({})
  const list = async (dir: string) => {
    try {
      const l = await getJSON<{ name: string; dir?: boolean }[]>(fileURL('list', root, dir))
      setLists((cur) => ({ ...cur, [dir]: [...l].sort((a, b) => +!!b.dir - +!!a.dir || a.name.localeCompare(b.name)) }))
    } catch {
      setLists((cur) => ({ ...cur, [dir]: [] }))
    }
  }
  const openDir = (dir: string) => {
    const next = new Set(dirs)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      list(dir)
    }
    setDirs(next)
  }
  const open = (path: string) => {
    if (path.endsWith('/')) return openDir(path.slice(0, -1))
    askDiff(root, path, repo.upstream ? { side: 'remote', repo: repo.path } : undefined)
    onOpen(path)
  }
  const rowClass = (p: string) => cn('tree-row scm-row', 'rounded-md text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground', p === active && 'current bg-sidebar-accent font-medium text-sidebar-accent-foreground')

  // What is in an open new folder, each new, at its depth.
  const inside = (dir: string, depth: number): ReactNode[] =>
    (lists[dir] ?? []).flatMap((e) => {
      const p = dir + '/' + e.name
      const shown = e.dir && dirs.has(p)
      const go = () => (e.dir ? openDir(p) : open(p))
      return [
        <div key={'in' + p} className={rowClass(p)} style={{ ['--depth' as string]: depth }} data-path={p} tabIndex={0} onClick={go} onKeyDown={(ev) => ev.key === 'Enter' && ev.target === ev.currentTarget && go()}>
          {e.dir ? (
            <span className={'tree-caret' + (shown ? ' open' : '')}>
              <ChevronIcon sm />
            </span>
          ) : (
            <FileIcon path={e.name} size={16} />
          )}
          <span className="ellipsis change-name git-U">{e.name}</span>
          <span className="scm-mark git-U" role="img" aria-label={markTitle.U}>
            U
          </span>
        </div>,
        ...(shown ? inside(p, depth + 1) : []),
      ]
    })

  const row = (f: GitFile) => {
    const dir = f.path.endsWith('/')
    const p = dir ? f.path.slice(0, -1) : f.path
    const inRepo = repo.path ? p.slice(repo.path.length + 1) : p
    const slash = inRepo.lastIndexOf('/')
    const st = f.y === 'U' ? 'U' : f.st
    return (
      <div
        key={p}
        className={rowClass(p)}
        data-path={p}
        tabIndex={0}
        onClick={() => open(f.path)}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open(f.path)}
        aria-expanded={dir ? dirs.has(p) : undefined}
      >
        {dir ? <FolderIcon /> : <FileIcon path={inRepo.slice(slash + 1)} size={16} />}
        <span className="ellipsis">
          <span className={'change-name git-' + st}>{inRepo.slice(slash + 1)}</span>
          {slash > 0 && <span className="faint small"> {inRepo.slice(0, slash)}</span>}
        </span>
        <span className="scm-n">
          {!!f.wa && <span className="git-U">+{f.wa}</span>}
          {!!f.wd && <span className="git-D">−{f.wd}</span>}
        </span>
        <span className={'scm-mark git-' + st} role="img" aria-label={markTitle[st]}>
          {st}
        </span>
      </div>
    )
  }

  return (
    <div className="scm-repo">
      {many && (
        <div className="change-repo small">
          <span className="ellipsis">{repo.path ? baseName(repo.path) : baseName(root)}</span>
        </div>
      )}
      <div className="scm-branch">
        <BranchIcon />
        <span className="ellipsis scm-branch-name">{repo.detached ? repo.head : repo.branch}</span>
        <span className="scm-branch-status ellipsis" title={repo.upstream ? 'Against ' + repo.upstream : undefined}>
          {standing(repo, files.length)}
        </span>
      </div>
      {files.length ? (
        <section className="scm-group" aria-label="Not on the remote">
          {files.flatMap((f) => [row(f), ...(f.path.endsWith('/') && dirs.has(f.path.slice(0, -1)) ? inside(f.path.slice(0, -1), 2) : [])])}
        </section>
      ) : (
        <div className="changes-empty faint small">{repo.upstream ? 'Everything here is on the remote.' : 'No changes since the last commit.'}</div>
      )}
    </div>
  )
}
