import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AuthError, getJSON, HTTPError } from './api'
import { Markdown } from './Markdown'
import { isRelative } from './mdrender'

// CodeMirror and pdf.js load with the first file that needs them, not
// with the app.
const CodeView = lazy(() => import('./CodeView').then((m) => ({ default: m.CodeView })))
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })))
const DocxView = lazy(() => import('./DocxView').then((m) => ({ default: m.DocxView })))

export const extOf = (path: string) => (path.split('.').pop() ?? '').toLowerCase()

// A file tab: Markdown rendered (with a Source toggle), images and Word
// documents shown, text in the code view. It checks the file's size and time every few seconds
// while on screen and reloads when either changes (Claude edits files
// from this app, the terminal, or VS Code alike). PDFs watch themselves.

export const fileURL = (kind: 'list' | 'raw' | 'stat', root: string, path: string) =>
  `/api/files/${kind}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`

// SaveButton downloads the file as it is on disk, to the laptop's
// Downloads or the phone's files. The server marks it an attachment too,
// since a phone's browser would open a PDF in place despite download.
export function SaveButton({ root, path }: { root: string; path: string }) {
  return (
    <a className="btn small-btn" href={fileURL('raw', root, path) + '&download=1'} download={path.split('/').pop()} title="Save a copy of the file">
      Save
    </a>
  )
}

const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const maxText = 2 << 20
const pollEvery = 3000

// A spot to jump to when a tab opens or is already open: a line in a
// source file, or boxes on PDF pages (from SyncTeX). n changes on every
// request, so asking for the same spot twice jumps twice.
export type SyncBox = { page: number; x: number; y: number; w: number; h: number }
export type Jump = { line?: number; boxes?: SyncBox[]; n: number }
export type Opener = (path: string, jump?: Omit<Jump, 'n'>) => void

export const synctexURL = (kind: 'view' | 'edit', root: string, q: Record<string, string | number>) =>
  `/api/files/synctex/${kind}?root=${encodeURIComponent(root)}&` +
  Object.entries(q)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

type Stat = { size: number; mtime: string }
type Loaded = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'large'; size: number }

// join resolves a relative link against the folder of the file it is in.
export function join(fromFile: string, href: string): string {
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of href.split(/[?#]/)[0].split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(decodeURIComponent(seg))
  }
  return parts.join('/')
}

type FileProps = { root: string; path: string; onOpen: Opener; jump?: Jump; active?: boolean }

export function FileView({ root, path, onOpen, jump, active = true }: FileProps) {
  const ext = extOf(path)
  // SyncTeX forward: a click on a line number of a .tex file shows that
  // spot in the PDF.
  const showInPdf = async (line: number) => {
    try {
      const r = await getJSON<{ pdf: string; boxes: SyncBox[] }>(synctexURL('view', root, { tex: path, line }))
      onOpen(r.pdf, { boxes: r.boxes })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  const [stat, setStat] = useState<Stat | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [err, setErr] = useState('')
  const [source, setSource] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  // Watch the file: a change in size or time means a reload.
  useEffect(() => {
    if (ext === 'pdf') return // the PDF view watches its file itself
    let dead = false
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const s = await getJSON<Stat>(fileURL('stat', root, path))
        if (!dead) setStat((old) => (old && old.size === s.size && old.mtime === s.mtime ? old : s))
      } catch (e) {
        if (!dead) setErr(e instanceof HTTPError && e.status === 404 ? 'The file is gone.' : e instanceof AuthError ? 'Not logged in.' : String(e))
      }
    }
    check()
    const t = window.setInterval(check, pollEvery)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [root, path])

  useEffect(() => {
    if (!stat || images.has(ext) || ext === 'pdf' || ext === 'docx') return
    if (stat.size > maxText) {
      setLoaded({ kind: 'large', size: stat.size })
      return
    }
    let dead = false
    fetch(fileURL('raw', root, path), { cache: 'no-cache' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const buf = new Uint8Array(await r.arrayBuffer())
        if (dead) return
        // A NUL byte early on means binary, not text.
        if (buf.subarray(0, 8192).includes(0)) setLoaded({ kind: 'binary' })
        else setLoaded({ kind: 'text', text: new TextDecoder().decode(buf) })
        setErr('')
      })
      .catch((e) => !dead && setErr(String(e instanceof Error ? e.message : e)))
    return () => {
      dead = true
    }
  }, [root, path, stat?.size, stat?.mtime])

  const head = (
    <div className="file-head">
      <span className="ellipsis grow small faint">{path}</span>
      {ext === 'md' && (
        <button className="btn small-btn" onClick={() => setSource(!source)}>
          {source ? 'Preview' : 'Source'}
        </button>
      )}
      <SaveButton root={root} path={path} />
    </div>
  )

  let body
  if (err && !loaded) body = <div className="center error">{err}</div>
  else if (ext === 'pdf') {
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <PdfView root={root} path={path} target={jump} onSource={(p, line) => onOpen(p, { line })} />
      </Suspense>
    )
  }
  else if (ext === 'docx') {
    // Redrawn when the file changes (Claude or Word saved it).
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <DocxView root={root} path={path} version={stat ? stat.size + ':' + stat.mtime : ''} />
      </Suspense>
    )
  }
  else if (images.has(ext)) {
    body = (
      <div className="file-image">
        <img src={fileURL('raw', root, path) + (stat ? '&v=' + encodeURIComponent(stat.mtime) : '')} alt={path} />
      </div>
    )
  } else if (!loaded) body = <div className="center faint">Loading…</div>
  else if (loaded.kind === 'binary') body = <div className="center faint">A binary file; nothing to show.</div>
  else if (loaded.kind === 'large') body = <div className="center faint">Too large to view here ({(loaded.size / 1e6).toFixed(1)} MB).</div>
  else if (ext === 'md' && !source) {
    const resolve = (href: string, kind: 'image' | 'link') => {
      const target = join(path, href)
      return kind === 'image' ? fileURL('raw', root, target) : '#'
    }
    body = (
      <div
        className="file-md"
        ref={scroller}
        onClick={(e) => {
          // Links to other files open as tabs.
          const a = (e.target as HTMLElement).closest('a[data-rel]') as HTMLAnchorElement | null
          if (!a) return
          e.preventDefault()
          const rel = a.dataset.rel!
          if (isRelative(rel)) onOpen(join(path, rel))
        }}
      >
        <Markdown text={loaded.text} opts={{ resolve }} />
      </div>
    )
  } else {
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <CodeView
          path={path}
          text={loaded.text}
          jump={jump}
          visible={active}
          onLineClick={['tex', 'sty', 'cls', 'bib'].includes(ext) ? showInPdf : undefined}
        />
      </Suspense>
    )
  }

  return (
    <div className="file-view">
      {/* A PDF or Word file shows its path in its own bar, saving a line. */}
      {ext !== 'pdf' && ext !== 'docx' && head}
      {err && loaded && <div className="notice error small">{err}</div>}
      {body}
    </div>
  )
}
