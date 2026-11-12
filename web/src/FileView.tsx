import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AuthError, getJSON, HTTPError, postJSON } from './api'
import { Markdown } from './Markdown'
import { isRelative } from './mdrender'

// CodeMirror and pdf.js load with the first file that needs them, not
// with the app.
const CodeView = lazy(() => import('./CodeView').then((m) => ({ default: m.CodeView })))
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })))
const DocxView = lazy(() => import('./DocxView').then((m) => ({ default: m.DocxView })))
const CsvView = lazy(() => import('./CsvView').then((m) => ({ default: m.CsvView })))
const tables = new Set(['csv', 'tsv'])
const ArchiveView = lazy(() => import('./ArchiveView').then((m) => ({ default: m.ArchiveView })))
// Matches the server's archiveKind (archive.go): .tar.gz ends in gz.
const isArchive = (path: string) => /\.(zip|tar|tgz|gz)$/i.test(path)

export const extOf = (path: string) => (path.split('.').pop() ?? '').toLowerCase()

// A file tab: Markdown rendered and CSV as a table (each with a Source
// toggle), images and Word documents shown, text in the code view. It checks the file's size and time every few seconds
// while on screen and reloads when either changes (Claude edits files
// from this app, the terminal, or VS Code alike). PDFs watch themselves.

export const fileURL = (kind: 'list' | 'raw' | 'stat' | 'open' | 'archive' | 'save' | 'delete', root: string, path: string) =>
  `/api/files/${kind}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`

// DownloadButton downloads the file as it is on disk, to the laptop's
// Downloads or the phone's files. The server marks it an attachment too,
// since a phone's browser would open a PDF in place despite download.
export function DownloadButton({ root, path }: { root: string; path: string }) {
  return (
    <a className="btn small-btn" href={fileURL('raw', root, path) + '&download=1'} download={path.split('/').pop()} title="Download a copy of the file">
      Download
    </a>
  )
}

// Whether this browser runs on the computer Dakort runs on, asked once.
// There an HTML file opens in the computer's own browser, fully working,
// and an office file the app does not show in Excel, LibreOffice or the
// like; elsewhere an HTML file opens in a sandboxed tab with no scripts.
// Never inside the app.
let local: Promise<boolean> | null = null
const isLocal = () => (local ??= getJSON<{ local: boolean }>('/api/here').then((r) => r.local, () => false))
function useLocal() {
  const [here, setHere] = useState<boolean | null>(null)
  useEffect(() => {
    isLocal().then(setHere)
  }, [])
  return here
}

// The office files the app leaves to the computer's own programs; matches
// officeExts in openlocal.go.
const office = new Set(['xlsx', 'xls', 'ods', 'numbers', 'pptx', 'ppt', 'odp', 'key', 'odt', 'doc', 'rtf'])

function OpenButton({ root, path, html }: { root: string; path: string; html: boolean }) {
  const here = useLocal()
  const [msg, setMsg] = useState('')
  if (here === null) return null
  if (!here) {
    if (!html) return null
    return (
      <a className="btn small-btn" href={fileURL('raw', root, path) + '&html=1'} target="_blank" rel="noopener noreferrer" title="A plain view: no scripts, and pictures or styles in other files may be missing">
        Open in new tab
      </a>
    )
  }
  return (
    <button
      className="btn small-btn"
      title={msg || (html ? "Open the page in this computer's browser" : 'Open the file with its program on this computer')}
      onClick={() =>
        postJSON(fileURL('open', root, path), {}).then(
          () => setMsg(''),
          (e) => setMsg(e instanceof Error ? e.message : String(e)),
        )
      }
    >
      {msg ? 'Could not open' : html ? 'Open in browser' : 'Open on the computer'}
    </button>
  )
}

// What an office file tab says instead of "a binary file".
function OfficeNote({ path }: { path: string }) {
  const here = useLocal()
  const ext = extOf(path)
  const sheet = ['xlsx', 'xls', 'ods', 'numbers'].includes(ext)
  return (
    <div className="center faint office-note">
      <p>Dakort does not show .{ext} files.</p>
      <p>
        {here ? 'Open on the computer, above, opens it in its program. ' : 'On the computer Dakort runs on, a button here opens it in its program. '}
        {sheet ? 'Or ask the agent to export a sheet as CSV, which opens here as a table.' : 'Or ask the agent to save it as PDF, which opens here.'}
      </p>
    </div>
  )
}

// The types the server serves as pictures and media (files.go); the
// browser draws and plays them itself.
const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])
const videos = new Set(['mp4', 'm4v', 'webm'])
const sounds = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac'])
const maxText = 2 << 20
const pollEvery = 3000
// A touch screen: there an editable view brings up the keyboard on any tap.
const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

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
// etag is a hash of the bytes (files.go), the version a save checks
// against; utf8 false means the bytes are not UTF-8, shown with
// replacement marks, so saving would damage the file.
type Loaded = { kind: 'text'; text: string; etag: string; utf8: boolean } | { kind: 'binary' } | { kind: 'large'; size: number }

// The file tabs with unsaved edits, by root and path: closing one asks.
export const unsaved = new Set<string>()
export const fileKey = (root: string, path: string) => root + '\n' + path

function decode(buf: Uint8Array): { text: string; utf8: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), utf8: true }
  } catch {
    return { text: new TextDecoder().decode(buf), utf8: false }
  }
}

// An edit in progress: the text and version it started from (or last
// saved), which stay on screen whatever the file does meanwhile.
type Edit = { text: string; base: string }

// join resolves a relative link against the folder of the file it is in.
export function join(fromFile: string, href: string): string {
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of href.split(/[?#]/)[0].split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(decodeURIComponent(seg))
  }
  return parts.join('/')
}

// agentBusy: an agent is working in this folder, so it may write this file.
type FileProps = { root: string; path: string; onOpen: Opener; jump?: Jump; active?: boolean; agentBusy?: boolean }

export function FileView({ root, path, onOpen, jump, active = true, agentBusy = false }: FileProps) {
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
    // An SVG is text too, for its Source view.
    if (!stat || (images.has(ext) && ext !== 'svg') || videos.has(ext) || sounds.has(ext) || isArchive(path) || office.has(ext) || ext === 'pdf' || ext === 'docx') return
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
        else setLoaded({ kind: 'text', ...decode(buf), etag: r.headers.get('ETag') ?? '' })
        setErr('')
      })
      .catch((e) => !dead && setErr(String(e instanceof Error ? e.message : e)))
    return () => {
      dead = true
    }
  }, [root, path, stat?.size, stat?.mtime])

  // Editing, as VS Code does it: the text on screen is the user's until
  // they save or revert. A change on disk is taken in while nothing is
  // typed yet; with unsaved typing it is announced, and a save is refused
  // by the server (412) until the user picks Reload or Overwrite. On a
  // laptop a text file's source is always editable; on a phone it takes
  // Edit, since any tap on an editable view brings up the keyboard.
  const [edit, setEdit] = useState<Edit | null>(null)
  const [phoneEdit, setPhoneEdit] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const [conflict, setConflict] = useState(false)
  const doc = useRef<(() => string) | null>(null)
  const typed = useRef(0) // counts changes, so typing during a save stays unsaved
  const text = loaded?.kind === 'text' ? loaded : null
  const key = fileKey(root, path)
  const editing = !!text?.utf8 && (!touch || phoneEdit)

  useEffect(() => {
    if (!editing || !text) return
    if (!edit) return setEdit({ text: text.text, base: text.etag })
    // While saving, the new version may come in before the save's answer.
    if (text.etag === edit.base || saving) return
    if (dirty) setConflict(true)
    else setEdit({ text: text.text, base: text.etag })
  }, [text?.etag, editing])

  useEffect(() => {
    if (dirty) unsaved.add(key)
    else unsaved.delete(key)
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      unsaved.delete(key)
    }
  }, [dirty, key])

  // Phone only: Edit opens the source for editing, Done closes it.
  const startEdit = () => {
    setSource(true) // Markdown, CSV and SVG are edited as source
    setPhoneEdit(true)
  }
  const stopEdit = () => {
    if (dirty && !confirm('Discard your unsaved changes?')) return
    setPhoneEdit(false)
    setEdit(null)
    setDirty(false)
    setConflict(false)
    setSaveErr('')
  }
  const save = async (overwrite = false) => {
    if (!edit || !doc.current || saving) return
    const body = doc.current()
    const n = typed.current
    setSaving(true)
    setSaveErr('')
    try {
      const r = await postJSON<{ etag: string }>(fileURL('save', root, path), { text: body, base: overwrite ? '*' : edit.base })
      setEdit({ text: body, base: r.etag })
      setConflict(false)
      if (typed.current === n) setDirty(false)
    } catch (e) {
      if (e instanceof HTTPError && e.status === 412) setConflict(true)
      else setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  // Drop the typing and take the file as it is on disk now.
  const reload = () => {
    if (!text) return
    setEdit({ text: text.text, base: text.etag })
    setDirty(false)
    setConflict(false)
    setSaveErr('')
  }
  const onEdit = () => {
    typed.current++
    setDirty(true)
  }
  const head = (
    <div className="file-head">
      <span className="ellipsis grow small faint">
        {path}
        {dirty && ' •'}
      </span>
      {dirty && (
        <>
          <button className="btn small-btn primary" onClick={() => save()} disabled={saving} title="Save (Ctrl+S)">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="btn small-btn" onClick={reload} title="Drop your changes and take the file as it is on disk">
            Revert
          </button>
        </>
      )}
      {touch && phoneEdit && (
        <button className="btn small-btn" onClick={stopEdit}>
          Done
        </button>
      )}
      {touch && !phoneEdit && text?.utf8 && (
        <button className="btn small-btn" onClick={startEdit} title="Edit the file here">
          Edit
        </button>
      )}
      {/* Unsaved typing lives in the source view, so it stays on screen. */}
      {!dirty && !phoneEdit && (ext === 'md' || ext === 'svg' || tables.has(ext)) && (
        <button className="btn small-btn" onClick={() => setSource(!source)}>
          {source ? (ext === 'md' ? 'Preview' : ext === 'svg' ? 'Picture' : 'Table') : 'Source'}
        </button>
      )}
      {!dirty && (ext === 'html' || ext === 'htm' || office.has(ext)) && <OpenButton root={root} path={path} html={!office.has(ext)} />}
      {!dirty && <DownloadButton root={root} path={path} />}
    </div>
  )
  const editNotes = dirty && (
    <>
      {conflict && (
        <div className="notice error small edit-conflict">
          The file changed on disk since you started editing.{' '}
          <button className="btn small-btn" onClick={reload} title="Drop your changes and take the file as it is now">
            Reload
          </button>{' '}
          <button className="btn small-btn" onClick={() => save(true)} title="Replace the file on disk with your version">
            Overwrite
          </button>
        </div>
      )}
      {saveErr && <div className="notice error small">{saveErr}</div>}
      {!conflict && agentBusy && <div className="notice info small">An agent is working in this folder and may change this file. A save is refused if it does.</div>}
    </>
  )

  // A new version of the file gets a new address, so the browser loads it.
  const versioned = fileURL('raw', root, path) + (stat ? '&v=' + encodeURIComponent(stat.mtime) : '')
  let body
  if (err && !loaded) body = <div className="center error">{err}</div>
  else if (ext === 'pdf') {
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <PdfView root={root} path={path} target={jump} onSource={(p, line) => onOpen(p, { line })} />
      </Suspense>
    )
  }
  else if (office.has(ext)) body = <OfficeNote path={path} />
  else if (isArchive(path)) {
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <ArchiveView root={root} path={path} version={stat ? stat.size + ':' + stat.mtime : ''} />
      </Suspense>
    )
  } else if (ext === 'docx') {
    // Redrawn when the file changes (Claude or Word saved it).
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <DocxView root={root} path={path} version={stat ? stat.size + ':' + stat.mtime : ''} />
      </Suspense>
    )
  }
  else if (images.has(ext) && !(ext === 'svg' && source)) {
    body = (
      <div className="file-image">
        <img src={versioned} alt={path} />
      </div>
    )
  } else if (videos.has(ext)) {
    body = (
      <div className="file-image">
        <video src={versioned} controls playsInline preload="metadata" />
      </div>
    )
  } else if (sounds.has(ext)) {
    body = (
      <div className="file-image">
        <audio src={versioned} controls preload="metadata" />
      </div>
    )
  } else if (!loaded) body = <div className="center faint">Loading…</div>
  else if (loaded.kind === 'binary') body = <div className="center faint">A binary file; nothing to show.</div>
  else if (loaded.kind === 'large') body = <div className="center faint">Too large to view here ({(loaded.size / 1e6).toFixed(1)} MB).</div>
  else if (tables.has(ext) && !source) {
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <CsvView text={loaded.text} tsv={ext === 'tsv'} />
      </Suspense>
    )
  } else if (ext === 'md' && !source) {
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
          text={edit ? edit.text : loaded.text}
          jump={jump}
          visible={active}
          onLineClick={['tex', 'sty', 'cls', 'bib'].includes(ext) ? showInPdf : undefined}
          editing={editing && !!edit}
          onEdit={onEdit}
          onSave={() => save()}
          doc={doc}
        />
      </Suspense>
    )
  }

  return (
    <div className="file-view">
      {/* A PDF or Word file shows its path in its own bar, saving a line. */}
      {ext !== 'pdf' && ext !== 'docx' && head}
      {err && loaded && <div className="notice error small">{err}</div>}
      {editNotes}
      {body}
    </div>
  )
}
