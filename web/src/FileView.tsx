import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { AuthError, getJSON, HTTPError, postJSON } from './api'
import { Markdown } from './Markdown'
import { DiffView } from './DiffView'
import { diffTaken, markOf, useDiffAsk, useGit, type DiffSide } from './git'
import { isRelative, join } from './mdrender'
import { DiffIcon, DownloadIcon, EditIcon, FindIcon, OpenIcon, PictureIcon, PreviewIcon, RevertIcon, SourceIcon, TableIcon } from './viewicons'
import { ToolMenu, type MenuTool } from './ToolMenu'
import { Problem } from './OpenFolder'
import { Button } from '@/components/ui/button'
import { ask } from './ask'
import { toolClass } from '@/lib/tool'
import { cn } from '@/lib/utils'
import { isMac } from './keys'
import { segItem, segList } from '@/lib/seg'

// CodeMirror and pdf.js load with the first file that needs them, not
// with the app.
const CodeView = lazy(() => import('./CodeView').then((m) => ({ default: m.CodeView })))
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })))
const DocxView = lazy(() => import('./DocxView').then((m) => ({ default: m.DocxView })))
const SheetView = lazy(() => import('./SheetView').then((m) => ({ default: m.SheetView })))
// Excel workbooks, read in the browser by ExcelJS (SheetView). The older
// .xls and .ods stay with the computer's programs; LibreOffice saves either
// as .xlsx.
const sheets = new Set(['xlsx', 'xlsm'])
const CsvView = lazy(() => import('./CsvView').then((m) => ({ default: m.CsvView })))
const tables = new Set(['csv', 'tsv'])
const ArchiveView = lazy(() => import('./ArchiveView').then((m) => ({ default: m.ArchiveView })))
// Matches the server's archiveKind (archive.go): .tar.gz ends in gz.
const isArchive = (path: string) => /\.(zip|tar|tgz|gz)$/i.test(path)

export const extOf = (path: string) => (path.split('.').pop() ?? '').toLowerCase()

// The source line of the block at the top of a Markdown preview: the
// first block whose bottom is below the top edge, then the first of the
// blocks inside it that is (a list is one block; the reader is at one of
// its items), and so on in.
function topLine(box: HTMLElement | null): number | null {
  return topPlace(box)?.line ?? null
}
// topPlace is topLine with how far into that block the preview is
// scrolled (px above the content's top edge), so a reload puts the reader
// back to the pixel, not only at the block's start.
function topPlace(box: HTMLElement | null): { line: number; shift: number } | null {
  if (!box) return null
  const top = box.getBoundingClientRect().top
  const edge = top + 1
  let best: HTMLElement | null = null
  for (const el of box.querySelectorAll<HTMLElement>('[data-line]')) {
    if (el.getBoundingClientRect().bottom <= edge) continue
    if (best && !best.contains(el)) break
    best = el
  }
  if (!best) return null
  const pad = parseFloat(getComputedStyle(box).paddingTop) || 0
  return { line: Number(best.dataset.line), shift: top + pad - best.getBoundingClientRect().top }
}

// Scrolls a Markdown preview so the block that starts at line, or the
// last one starting before it, is at the top.
function showLine(box: HTMLElement, line: number, shift = 0) {
  let best: HTMLElement | null = null
  for (const el of box.querySelectorAll<HTMLElement>('[data-line]')) {
    const n = Number(el.dataset.line)
    if (n <= line && (!best || n >= Number(best.dataset.line))) best = el
  }
  if (!best) return
  const pad = parseFloat(getComputedStyle(box).paddingTop) || 0
  box.scrollTop += best.getBoundingClientRect().top - box.getBoundingClientRect().top - pad + (Number(best.dataset.line) === line ? shift : 0)
}

// A file tab: Markdown rendered and CSV as a table (each with a Source
// toggle), images and Word documents shown, text in the code view. It checks the file's size and time every few seconds
// while on screen and reloads when either changes (Claude edits files
// from this app, the terminal, or VS Code alike). PDFs watch themselves.

export const fileURL = (kind: 'list' | 'raw' | 'stat' | 'open' | 'archive' | 'save' | 'delete', root: string, path: string) =>
  `/api/files/${kind}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`

// The command key as the tips name it: ⌘ on a Mac, Ctrl elsewhere.
export const mod = isMac ? '⌘' : 'Ctrl+'

// A toolbar button of the file views: an icon, its name in aria-label and
// in the tip (a word or three; tip is kept for callers, not shown), and the name as text too
// where the pane is wide (.lbl, styles.css). 44 px on a touch screen.
type ToolProps = {
  label: string
  tip?: string
  icon: ReactNode
  on?: boolean // a switch that is on (Find open, Source picking): aria-pressed
  text?: boolean // the name shows at any width (Save)
  className?: string
  keys?: string // its shortcut, shown in the tip as a key chip (keys.ts)
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>
export function Tool({ label, tip: _tip, icon, on, text, className, keys, type = 'button', ...rest }: ToolProps) {
  return (
    <button
      type={type}
      className={toolClass({ on, text, primary: /(^| )primary( |$)/.test(className ?? ''), secondary: /(^| )secondary( |$)/.test(className ?? ''), className: className?.replace(/(^| )(primary|secondary)(?= |$)/g, '') })}
      aria-label={label}
      aria-pressed={on}
      data-tip={label}
      data-tip-key={keys}
      {...rest}
    >
      {icon}
      <span className="lbl" data-label={label}>
        {label}
      </span>
    </button>
  )
}

// The path as a breadcrumb: the folders in --text-2, the file's name in
// full text colour. In a narrow pane only the parent folder shows (after
// "…/"). The whole path is in its tip, a tap away on a phone.
export function Crumb({ path, dirty }: { path: string; dirty?: boolean }) {
  const parts = path.split('/')
  const name = parts.pop()!
  const parent = parts.pop()
  // Folders show whole or not at all: when the path does not fit, the
  // folders above the parent go (data-tight 1), then the parent too (2),
  // and only then is the name itself cut. A folder cut to a stub ("d…")
  // said nothing.
  const box = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => {
      for (const level of ['', '1', '2']) {
        if (level) el.dataset.tight = level
        else delete el.dataset.tight
        // By the drawn edges, not scrollWidth's whole pixels, which let a
        // name lose its last letter under a 1 px tolerance.
        const end = el.lastElementChild?.getBoundingClientRect().right ?? 0
        if (level === '2' || end <= el.getBoundingClientRect().right + 0.25) break
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [path, dirty])
  return (
    <span className="crumb" ref={box} data-tip={path} data-tip-tap="">
      {parts.length > 0 && <span className="crumb-dir crumb-up">{parts.join('/') + '/'}</span>}
      {parent !== undefined && <span className={'crumb-dir crumb-parent' + (parts.length ? ' deep' : '')}>{parent + '/'}</span>}
      <span className="crumb-name">{name}</span>
      {dirty && (
        <span className="crumb-dirty">
          <span className="crumb-dot" aria-hidden="true" />
          <span className="lbl">Unsaved</span>
        </span>
      )}
    </span>
  )
}

export const downloadURL = (root: string, path: string) => fileURL('raw', root, path) + '&download=1'

// DownloadButton downloads the file as it is on disk, to the laptop's
// Downloads or the phone's files. The server marks it an attachment too,
// since a phone's browser would open a PDF in place despite download.
export function DownloadButton({ root, path, className }: { root: string; path: string; className?: string }) {
  return (
    <a className={toolClass({ className })} href={downloadURL(root, path)} download={path.split('/').pop()} aria-label="Download" data-tip="Download">
      <DownloadIcon />
      <span className="lbl">Download</span>
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

// The office files the app leaves to the computer's own programs; with
// the sheets above, matches officeExts in openlocal.go.
const office = new Set(['xls', 'ods', 'numbers', 'pptx', 'ppt', 'odp', 'key', 'odt', 'doc', 'rtf'])

function OpenButton({ root, path, html, onOpen }: { root: string; path: string; html: boolean; onOpen: () => void }) {
  const here = useLocal()
  if (here === null) return null
  if (!here) {
    if (!html) return null
    return (
      <a
        className={toolClass()}
        href={fileURL('raw', root, path) + '&html=1'}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open in new tab"
        data-tip="Open in new tab"
      >
        <OpenIcon />
        <span className="lbl">Open in new tab</span>
      </a>
    )
  }
  // A failure shows under the bar, in words (FileView); the button stays
  // itself, a way to try again.
  return (
    <Tool
      label={html ? 'Open in browser' : 'Open on the computer'}
      tip={html ? "Open the page in this computer's browser" : 'Open the file with its program on this computer'}
      icon={<OpenIcon />}
      onClick={onOpen}
    />
  )
}

// What an office file tab says instead of "a binary file".
function OfficeNote({ path }: { path: string }) {
  const here = useLocal()
  const ext = extOf(path)
  const sheet = ['xls', 'ods', 'numbers'].includes(ext)
  return (
    <div className="center faint office-note">
      <p>Dakort does not show .{ext} files.</p>
      <p>
        {here ? 'Open on the computer, above, opens it in its program. ' : 'On the computer Dakort runs on, a button here opens it in its program. '}
        {sheet ? 'Or save it as .xlsx (Excel and LibreOffice both can), which opens here.' : 'Or ask the agent to save it as PDF, which opens here.'}
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

  // The diff since the last commit, for a file git shows as changed:
  // Changes in the sidebar opens it, the Diff button turns it on and off.
  const git = useGit(root)
  const mark = ext === 'pdf' || ext === 'docx' ? '' : markOf(git, path, false)
  const [diffOn, setDiffOn] = useState(false)
  const [side, setSide] = useState<DiffSide | undefined>()
  const setDiff = (on: boolean, s?: DiffSide) => {
    setDiffOn(on)
    setSide(s)
  }
  const asked = useDiffAsk()
  useEffect(() => {
    if (asked.key === root + '\n' + path && asked.n > diffTaken.n) {
      diffTaken.n = asked.n
      setDiff(true, asked.side)
    }
  }, [asked])
  const diff = diffOn && (!!mark || !!side) // a file changed only in commits not pushed has no mark

  // Preview and Source of a Markdown file meet at the same place. Each
  // block of the preview knows its source line (mdrender), the editor
  // can say which line it is at (CodeView's pos) and open at one
  // (startLine). mdLine is the line at the top of whichever view shows;
  // it also holds the preview's place when the file changes under it.
  const mdLine = useRef<number | null>(null)
  const mdShift = useRef(0) // how far into that block the preview was scrolled
  const pos = useRef<(() => number) | null>(null)
  const toggleSource = () => {
    if (ext === 'md') mdLine.current = (source ? pos.current?.() : topLine(scroller.current)) ?? mdLine.current
    mdShift.current = 0
    setSource(!source)
  }
  useLayoutEffect(() => {
    if (ext === 'md' && !source && scroller.current && mdLine.current) showLine(scroller.current, mdLine.current, mdShift.current)
  }, [source, loaded])

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
    if (!stat || (images.has(ext) && ext !== 'svg') || videos.has(ext) || sounds.has(ext) || isArchive(path) || office.has(ext) || sheets.has(ext) || ext === 'pdf' || ext === 'docx') return
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
    if (ext === 'md' && !source) mdLine.current = topLine(scroller.current) ?? mdLine.current
    mdShift.current = 0
    setSource(true) // Markdown, CSV and SVG are edited as source
    setPhoneEdit(true)
  }
  // Bumped whenever typing is dropped (Done after a discard, Revert), so the
  // editor takes the file's text back even when it is the same string.
  const [revision, setRevision] = useState(0)
  const stopEdit = async () => {
    if (dirty && !(await ask({ title: 'Discard your unsaved changes?', action: 'Discard', destructive: true }))) return
    if (dirty) setRevision((r) => r + 1)
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
    setRevision((r) => r + 1) // the editor takes the text back even if it is the same string
    setDirty(false)
    setConflict(false)
    setSaveErr('')
  }
  // Revert drops every unsaved edit: it asks first.
  const revert = async () => {
    if (await ask({ title: 'Revert to the saved file?', text: 'Your unsaved changes are dropped and the file is shown as it is on disk.', action: 'Revert', destructive: true })) reload()
  }
  const onEdit = () => {
    typed.current++
    setDirty(true)
  }
  // Find, in the code view: CodeMirror's search panel (Ctrl+F does the
  // same; a phone has no keys for it).
  const find = useRef<(() => void) | null>(null)
  const [finding, setFinding] = useState(false)
  const codeShown = loaded?.kind === 'text' && !(ext === 'md' && !source) && !(tables.has(ext) && !source) && !(images.has(ext) && !(ext === 'svg' && source))
  // A narrow bar (under 440 px, a phone) keeps the name, the switch, Edit,
  // Done and Save, and puts the rest in a ⋯ menu (ToolMenu): Download,
  // Revert, and Find while editing or beside the switch, where the name
  // had 50 px ('App…').
  const switchShown = !diff && !dirty && !phoneEdit && (ext === 'md' || ext === 'svg' || tables.has(ext))
  const findInMenu = codeShown && (phoneEdit || switchShown)
  const menu: MenuTool[] = [
    ...(findInMenu ? [{ label: 'Find', icon: <FindIcon />, onPick: () => find.current?.() }] : []),
    ...(dirty ? [{ label: 'Revert to the saved file', icon: <RevertIcon />, onPick: revert, danger: true }] : []),
    ...(!dirty ? [{ label: 'Download', icon: <DownloadIcon />, href: downloadURL(root, path), download: path.split('/').pop() }] : []),
  ]
  // Open in browser / on the computer: a failure is said under the bar,
  // announced, with the server's reason (on a phone the button is an icon).
  // n counts the failures: each one mounts the note afresh, so a second
  // failure is announced again. The note stays while a retry runs (its Try
  // again keeps the focus); a retry that works hands the focus to the Open
  // button of this view (another tab's view is in the page too).
  const [openErr, setOpenErr] = useState<{ why: string; n: number } | null>(null)
  const view = useRef<HTMLDivElement>(null)
  // After the failed retry's note is mounted (an effect: a frame could
  // come before the commit), its Try again takes the focus back.
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    view.current?.querySelector<HTMLElement>('.file-problem button')?.focus({ preventScroll: true })
  }, [openErr?.n])
  const openHere = () => {
    const retrying = !!document.activeElement?.closest('.file-problem')
    const focus = (sel: string) => requestAnimationFrame(() => view.current?.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true }))
    return postJSON(fileURL('open', root, path), {}).then(
      () => {
        setOpenErr(null)
        if (retrying) focus('[aria-label^="Open "]')
      },
      (e) => {
        refocus.current = retrying
        setOpenErr((o) => ({ why: e instanceof Error ? e.message : String(e), n: (o?.n ?? 0) + 1 }))
      },
    )
  }
  const head = (
    <div className="file-head">
      <Crumb path={path} dirty={dirty} />
      {/* Find comes before the Preview / Source switch: it shows only with the
          source, and placed after it, it pushed the switch aside as it came. */}
      {codeShown && (
        <Tool label="Find" keys="Mod+F" icon={<FindIcon />} on={finding} className={findInMenu ? 'wide-only' : undefined} onClick={() => find.current?.()} />
      )}
      {!dirty && !phoneEdit && (mark || side) && (
        <Tool label="Diff" tip={diff ? 'Show the file' : side ? 'Show what is not on the remote' : 'Show what changed since the last commit'} icon={<DiffIcon />} on={diff} onClick={() => setDiff(!diff, side)} />
      )}
      {/* Unsaved typing lives in the source view, so it stays on screen. */}
      {switchShown && (
        <span className={cn('seg', segList)} role="group" aria-label="Show">
          <Tool
            label={ext === 'md' ? 'Preview' : ext === 'svg' ? 'Picture' : 'Table'}
            icon={ext === 'md' ? <PreviewIcon /> : ext === 'svg' ? <PictureIcon /> : <TableIcon />}
            on={!source}
            className={segItem}
            onClick={() => source && toggleSource()}
          />
          <Tool label="Source" tip="Source: the file as text" icon={<SourceIcon />} on={source} className={segItem} onClick={() => !source && toggleSource()} />
        </span>
      )}
      {touch && !phoneEdit && text?.utf8 && <Tool label="Edit" tip="Edit the file here" icon={<EditIcon />} onClick={startEdit} />}
      {/* Editing on a phone: Done leaves (asking first if there is unsaved
          typing), then Revert, and Save, the one filled button, last. */}
      {touch && phoneEdit && <Tool label="Done" tip="Done editing" icon={null} text className="secondary" onClick={stopEdit} />}
      {dirty && (
        <>
          <Tool label="Revert" tip="Revert: drop your changes and take the file as it is on disk" icon={null} text className="secondary wide-only" onClick={revert} />
          <Tool label={saving ? 'Saving…' : 'Save'} keys="Mod+S" icon={null} text className="primary" onClick={() => save()} disabled={saving} />
        </>
      )}
      {!dirty && (ext === 'html' || ext === 'htm' || office.has(ext) || sheets.has(ext)) && <OpenButton root={root} path={path} html={ext === 'html' || ext === 'htm'} onOpen={openHere} />}
      {!dirty && <DownloadButton root={root} path={path} className="wide-only" />}
      <ToolMenu title={path.split('/').pop()!} tools={menu} />
    </div>
  )
  const editNotes = dirty && (
    <>
      {conflict && (
        <div className="notice error small edit-conflict">
          The file changed on disk since you started editing.{' '}
          <Button variant="outline" size="xs" onClick={reload} title="Drop your changes and take the file as it is now">
            Reload
          </Button>{' '}
          <Button variant="outline" size="xs" onClick={() => save(true)} title="Replace the file on disk with your version">
            Overwrite
          </Button>
        </div>
      )}
      {saveErr && <div className="notice error small">{saveErr}</div>}
      {!conflict && agentBusy && <div className="notice info small">An agent is working in this folder and may change this file. A save is refused if it does.</div>}
    </>
  )

  // A new version of the file gets a new address, so the browser loads it.
  const versioned = fileURL('raw', root, path) + (stat ? '&v=' + encodeURIComponent(stat.mtime) : '')
  let body
  if (diff) body = <DiffView root={root} path={path} side={side} version={(stat ? stat.size + ':' + stat.mtime : '') + mark} />
  else if (err && !loaded) body = <div className="center error">{err}</div>
  else if (ext === 'pdf') {
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <PdfView root={root} path={path} target={jump} onSource={(p, line) => onOpen(p, { line })} />
      </Suspense>
    )
  }
  else if (office.has(ext)) body = <OfficeNote path={path} />
  else if (sheets.has(ext)) {
    // Read again when the file changes (the agent or Excel saved it).
    body = (
      <Suspense fallback={<div className="center faint">Loading…</div>}>
        <SheetView root={root} path={path} version={stat ? stat.size + ':' + stat.mtime : ''} size={stat?.size ?? 0} />
      </Suspense>
    )
  } else if (isArchive(path)) {
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
        onScroll={() => {
          const at = topPlace(scroller.current)
          if (at) [mdLine.current, mdShift.current] = [at.line, at.shift]
        }}
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
          revision={revision}
          jump={jump}
          visible={active}
          onLineClick={['tex', 'sty', 'cls', 'bib'].includes(ext) ? showInPdf : undefined}
          editing={editing && !!edit}
          onEdit={onEdit}
          onSave={() => save()}
          doc={doc}
          startLine={ext === 'md' ? mdLine.current ?? undefined : undefined}
          pos={pos}
          find={find}
          onFind={setFinding}
        />
      </Suspense>
    )
  }

  return (
    <div className="file-view" ref={view}>
      {/* A PDF or Word file shows its path in its own bar, saving a line. */}
      {ext !== 'pdf' && ext !== 'docx' && head}
      {err && loaded && !diff && <div className="notice error small">{err}</div>}
      {openErr && <Problem key={openErr.n} title={`Could not open ${path.split('/').pop()}.`} why={openErr.why} retry={openHere} className="file-problem" />}
      {editNotes}
      {body}
    </div>
  )
}
