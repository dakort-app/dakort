import { useEffect, useState } from 'react'
import { getJSON } from './api'
import type { DiffSide } from './git'

// A file's change since the last commit, as git's unified diff drawn the
// way a review shows it: the old and new line numbers, removed lines red,
// added green, and a gap between the changed places.

type Line = { kind: 'add' | 'del' | 'same' | 'gap' | 'note'; text: string; old?: number; new?: number }

export function parseDiff(diff: string): Line[] {
  const out: Line[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const l of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(l)
    if (h) {
      o = +h[1]
      n = +h[2]
      inHunk = true
      out.push({ kind: 'gap', text: h[3].trim() })
      continue
    }
    if (!inHunk) {
      if (l.startsWith('Binary files')) out.push({ kind: 'note', text: 'A binary file changed.' })
      continue
    }
    if (l.startsWith('+')) out.push({ kind: 'add', text: l.slice(1), new: n++ })
    else if (l.startsWith('-')) out.push({ kind: 'del', text: l.slice(1), old: o++ })
    else if (l.startsWith(' ')) out.push({ kind: 'same', text: l.slice(1), old: o++, new: n++ })
    else if (l.startsWith('\\')) continue // "\ No newline at end of file"
    else if (l.startsWith('diff ')) inHunk = false // the next file's header
  }
  return out
}

type Props = { root: string; path: string; version: string; side?: DiffSide }

// Read only. With a side (opened from Changes), the change against the
// branch's upstream: everything not pushed yet, committed or not. Without
// one, the change since the last commit (the file bar's Diff).
export function DiffView({ root, path, version, side }: Props) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [cut, setCut] = useState(false)
  const [err, setErr] = useState('')
  const q = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}` + (side ? '&base=upstream' : '')
  useEffect(() => {
    let dead = false
    getJSON<{ diff: string; cut?: boolean }>('/api/git/diff?' + q)
      .then((r) => {
        if (dead) return
        setLines(parseDiff(r.diff))
        setCut(!!r.cut)
        setErr('')
      })
      .catch((e) => !dead && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      dead = true
    }
  }, [q, version])

  if (err) return <div className="center error">{err}</div>
  if (!lines) return <div className="center faint">Loading…</div>
  const empty = side ? 'Nothing here differs from the remote.' : 'No changes since the last commit.'
  // The lines by hunk: each hunk is a block, its head first.
  const blocks: Line[][] = []
  for (const l of lines) {
    if (l.kind === 'gap' || !blocks.length) blocks.push([])
    blocks[blocks.length - 1].push(l)
  }
  const row = (l: Line, i: number) =>
    l.kind === 'gap' || l.kind === 'note' ? null : (
      <div key={i} className={'diff-line diff-' + l.kind}>
        <span className="diff-no">{l.old ?? ''}</span>
        <span className="diff-no">{l.new ?? ''}</span>
        <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
        <span className="diff-text">{l.text || ' '}</span>
      </div>
    )
  return (
    <div className="diff-wrap">
      {!lines.length ? (
        <div className="center faint">{empty}</div>
      ) : (
        <div className="diff-view" aria-label={side ? 'Changes not on the remote' : 'Changes since the last commit'}>
          {blocks.map((b, bi) => {
            const head = b[0]
            return (
              <div key={bi} className="diff-hunk">
                {head.kind === 'gap' ? (
                  <div className="diff-gap">
                    <span className="diff-at">{head.text}</span>
                  </div>
                ) : head.kind === 'note' ? (
                  <div className="diff-gap">{head.text}</div>
                ) : null}
                {b.map(row)}
              </div>
            )
          })}
          {cut && <div className="diff-gap">The diff is too long; the rest is not shown.</div>}
        </div>
      )}
    </div>
  )
}
