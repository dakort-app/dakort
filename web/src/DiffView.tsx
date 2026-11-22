import { useEffect, useState } from 'react'
import { getJSON } from './api'

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

type Props = { root: string; path: string; version: string }

export function DiffView({ root, path, version }: Props) {
  const [lines, setLines] = useState<Line[] | null>(null)
  const [cut, setCut] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    let dead = false
    getJSON<{ diff: string; cut?: boolean }>(`/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
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
  }, [root, path, version])
  if (err) return <div className="center error">{err}</div>
  if (!lines) return <div className="center faint">Loading…</div>
  if (!lines.length) return <div className="center faint">No changes since the last commit.</div>
  return (
    <div className="diff-view" aria-label="Changes since the last commit">
      {lines.map((l, i) =>
        l.kind === 'gap' ? (
          <div key={i} className="diff-gap">
            {l.text || ' '}
          </div>
        ) : l.kind === 'note' ? (
          <div key={i} className="diff-gap">
            {l.text}
          </div>
        ) : (
          <div key={i} className={'diff-line diff-' + l.kind}>
            <span className="diff-no">{l.old ?? ''}</span>
            <span className="diff-no">{l.new ?? ''}</span>
            <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
            <span className="diff-text">{l.text || ' '}</span>
          </div>
        ),
      )}
      {cut && <div className="diff-gap">The diff is too long; the rest is not shown.</div>}
    </div>
  )
}
