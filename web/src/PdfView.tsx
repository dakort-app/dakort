// The legacy build: pdf.js 6 calls Map.getOrInsertComputed, which the
// iPhone's Safari of 2026-11-20 lacks ("this.#t.getOrInsertComputed is not
// a function", no PDF opened); the legacy build carries it, for 120 KB.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { TextLayer, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { getJSON, HTTPError } from './api'
import { FindBar } from './FindBar'
import { Crumb, downloadURL, fileURL, DownloadButton, mod, synctexURL, Tool, type Jump, type SyncBox } from './FileView'
import { CloseIcon, DownloadIcon, FindIcon, FitPageIcon, FitWidthIcon, MinusIcon, PlusIcon, SyncIcon } from './viewicons'
import { ToolMenu } from './ToolMenu'
import { find, foldQuery, pageText, type FindOpts, type Hit, type PageText, type Run } from './pdffind'
import { GAP, posAt, scrollFor, tops, type Pos } from './pdfpos'
import { useStore } from './store'
import './FindBar.css'
import './PdfView.css'
import { cn } from '@/lib/utils'
import { segList } from '@/lib/seg'
import { Badge } from '@/components/ui/badge'

// The PDF tab, for the LaTeX loop: Claude recompiles, the view refreshes
// and stays on the same spot. A new version is only shown once it is
// complete (the server refuses a PDF without its final %%EOF) and loaded
// and its visible pages drawn; until then the old one stays, with a badge
// saying so. See BRIEF, "Plan for piece 7".

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// A drag that starts in a text layer marks it "selecting" until the
// pointer comes up anywhere (see .textLayer.selecting in styles.css).
document.addEventListener('pointerdown', (e) => {
  ;(e.target as Element | null)?.closest?.('.textLayer')?.classList.add('selecting')
})
document.addEventListener('pointerup', () => {
  document.querySelectorAll('.textLayer.selecting').forEach((l) => l.classList.remove('selecting'))
})

// One worker for every document: pdf.js otherwise starts a new one, and
// parses its 1.3 MB script again, for each load and each recompile.
let worker: pdfjs.PDFWorker | null = null
const sharedWorker = () => (worker ??= new pdfjs.PDFWorker())

const pollEvery = 1000
const pad = 12

type Size = { w: number; h: number } // CSS px at zoom 1
type Doc = { pdf: PDFDocumentProxy; sizes: Size[]; key: string; pre: Map<number, HTMLCanvasElement> }
type Stat = { size: number; mtime: string; complete?: boolean }
type Status = '' | 'updating' | 'missing' | 'error'

async function sizesOf(pdf: PDFDocumentProxy): Promise<Size[]> {
  const out: Size[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const vp = (await pdf.getPage(i)).getViewport({ scale: 1 })
    out.push({ w: vp.width, h: vp.height })
  }
  return out
}

// Fit is the page width ('fit') or the whole of the largest page ('page').
type Zoom = number | 'fit' | 'page'

function fitScale(mode: 'fit' | 'page', sizes: Size[], width: number, height: number) {
  const byWidth = (width - 2 * pad - 1) / Math.max(...sizes.map((s) => s.w))
  return mode === 'page' ? Math.min(byWidth, (height - 2 * GAP) / Math.max(...sizes.map((s) => s.h))) : byWidth
}

// Where each character of a run starts, in the run's own width: the
// characters measured in the font family pdf.js names for the run (the one
// its text layer draws the selectable text in), scaled to the run's width.
// Taking every character as equally wide put a match a character or two
// off on proportional text.
let measurer: CanvasRenderingContext2D | null = null
const widths = new Map<string, number>()
function advances(str: string, family: string, w: number): number[] | undefined {
  measurer ??= document.createElement('canvas').getContext('2d')
  if (!measurer || !str) return undefined
  measurer.font = `100px ${family}`
  const out = [0]
  for (const c of str) {
    const k = family + '\n' + c
    let cw = widths.get(k)
    if (cw === undefined) widths.set(k, (cw = measurer.measureText(c).width))
    out.push(out[out.length - 1] + cw)
    if (c.length === 2) out.push(out[out.length - 1]) // a surrogate pair is two string positions
  }
  const total = out[out.length - 1]
  return total > 0 ? out.map((v) => (v / total) * w) : undefined
}

// A page's text runs, placed in PDF points from the page's top-left.
async function runsOf(pdf: PDFDocumentProxy, index: number): Promise<Run[]> {
  const page = await pdf.getPage(index + 1)
  const vp = page.getViewport({ scale: 1 })
  const out: Run[] = []
  const content = await page.getTextContent()
  for (const it of content.items) {
    if (!('str' in it)) continue
    const t = it.transform as number[]
    const h = it.height || Math.hypot(t[2], t[3])
    const [x, y] = vp.convertToViewportPoint(t[4], t[5]) as number[]
    const family = content.styles[it.fontName]?.fontFamily ?? 'sans-serif'
    out.push({ str: it.str, x, top: y - h, w: it.width, h, eol: it.hasEOL, adv: advances(it.str, family, it.width) })
  }
  return out
}

async function draw(pdf: PDFDocumentProxy, index: number, scale: number, canvas: HTMLCanvasElement) {
  const page = await pdf.getPage(index + 1)
  const dpr = window.devicePixelRatio || 1
  const vp = page.getViewport({ scale: scale * dpr })
  canvas.width = Math.floor(vp.width)
  canvas.height = Math.floor(vp.height)
  await page.render({ canvas, viewport: vp }).promise
}

function savedPos(key: string): Pos {
  try {
    const p = JSON.parse(sessionStorage.getItem(key) ?? '')
    if (Number.isInteger(p.page) && p.page >= 0 && typeof p.frac === 'number') return { page: p.page, frac: p.frac }
  } catch {
    // nothing saved
  }
  return { page: 0, frac: 0 }
}

type Props = {
  root: string
  path: string
  target?: Jump // SyncTeX forward: boxes to show
  onSource: (path: string, line: number) => void // SyncTeX inverse
}

type Flash = SyncBox & { n: number }

export function PdfView({ root, path, target, onSource }: Props) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [syncing, setSyncing] = useState(false) // the next tap goes to the source
  const [flash, setFlash] = useState<Flash | null>(null)
  const [note, setNote] = useState('')
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  // Find: the query, its matches once Enter is pressed (null while being
  // typed), and the one shown.
  const [finding, setFinding] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [cur, setCur] = useState(0)
  const findBox = useRef<HTMLInputElement>(null)
  const texts = useRef<{ key: string; pages: Map<number, PageText> } | null>(null)
  const searching = useRef(false)
  const [status, setStatus] = useState<Status>('')
  const [err, setErr] = useState('')
  const [page, setPage] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  // The reader's spot outlives the view: a page reload (a new build reloads
  // the page once it is hidden) or a switch of project remounts it, and it
  // opened again on page 1.
  const spotKey = 'pdfpos:' + root + '|' + path
  const pos = useRef<Pos>(savedPos(spotKey))
  const restore = useRef(true)
  const loading = useRef(false)
  const docRef = useRef<Doc | null>(null)
  docRef.current = doc
  const ended = useStore((s) => s.live.ended)

  // Fit leaves a pixel of slack: content exactly as wide as the box can
  // leave Chrome showing a horizontal scrollbar with nothing to scroll.
  const scaleFor = (sizes: Size[]) => (typeof zoom === 'number' ? zoom : sizes.length && width ? fitScale(zoom, sizes, width, height) : 1)
  const scale = doc ? scaleFor(doc.sizes) : 1
  const heights = doc ? doc.sizes.map((s) => s.h * scale) : []
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const scaleForRef = useRef(scaleFor)
  scaleForRef.current = scaleFor

  // A file tab not in front is display:none: its box measures 0 and scrolls
  // to 0. Nothing is read from it or written to it then (a recompile seen
  // from the chat tab took 0 for the reader's spot), and the spot is put
  // back when the tab is shown again.
  const hidden = useRef(false)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const el = box.current!
    const ro = new ResizeObserver(() => {
      if (!el.clientWidth) {
        hidden.current = true
        return
      }
      if (hidden.current) {
        hidden.current = false
        restore.current = true
        setShown((n) => n + 1)
      }
      setWidth(el.clientWidth)
      setHeight(el.clientHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Look for a new version: on a timer while on screen, and at once when
  // a turn ends (Claude may have just recompiled).
  useEffect(() => {
    let dead = false
    const check = async () => {
      if (dead || loading.current || document.visibilityState !== 'visible') return
      let st: Stat
      try {
        st = await getJSON<Stat>(fileURL('stat', root, path))
      } catch (e) {
        if (!dead) setStatus(e instanceof HTTPError && e.status === 404 ? 'missing' : 'error')
        return
      }
      const key = st.size + ':' + st.mtime
      if (dead || key === docRef.current?.key) {
        if (!dead && docRef.current) setStatus('')
        return
      }
      if (!st.complete) {
        if (docRef.current) setStatus('updating')
        return
      }
      loading.current = true
      try {
        await load(key)
      } finally {
        loading.current = false
      }
    }
    const load = async (key: string) => {
      const r = await fetch(fileURL('raw', root, path), { cache: 'no-store' })
      if (r.status === 503) return setStatus('updating') // still being written; next poll
      if (!r.ok) {
        setStatus('error')
        setErr(`HTTP ${r.status}`)
        return
      }
      let pdf: PDFDocumentProxy | null = null
      try {
        pdf = await pdfjs.getDocument({ data: new Uint8Array(await r.arrayBuffer()), worker: sharedWorker() }).promise
        const sizes = await sizesOf(pdf)
        // Draw the pages around the reader's spot before swapping, so the
        // switch shows a finished page, not a blank one.
        const old = docRef.current
        const el = box.current
        if (old && el && el.clientHeight) pos.current = posAt(old.sizes.map((s) => s.h * scaleRef.current), el.scrollTop + el.clientHeight / 2)
        const sc = scaleForRef.current(sizes)
        const pre = new Map<number, HTMLCanvasElement>()
        const at = Math.min(pos.current.page, sizes.length - 1)
        for (const i of [at - 1, at, at + 1].filter((i) => i >= 0 && i < sizes.length)) {
          const c = document.createElement('canvas')
          await draw(pdf, i, sc, c)
          pre.set(i, c)
        }
        if (dead) {
          pdf.loadingTask.destroy()
          return
        }
        restore.current = true
        setDoc({ pdf, sizes, key, pre })
        setStatus('')
        setErr('')
        old?.pdf.loadingTask.destroy()
      } catch (e) {
        pdf?.loadingTask.destroy()
        // A broken file keeps the old render; the next change tries again.
        if (!dead) {
          setStatus('error')
          setErr(String(e instanceof Error ? e.message : e))
        }
      }
    }
    check()
    const t = window.setInterval(check, pollEvery)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [root, path, ended, width > 0])

  useEffect(
    () => () => {
      docRef.current?.pdf.loadingTask.destroy()
    },
    [],
  )

  // Put the reader back on their spot after a new version or any change of
  // scale: a zoom, and also fit-width following the window or the
  // explorer opening (seen in Chrome: without this, page 2 slid to page 1).
  // The spot is the middle of the view, not its top edge: the top edge is
  // often still on the page before the one being read (the end of the
  // Acknowledgements above the start of the Introduction), and Fit page
  // jumped there. snapTop puts the spot's page at the top instead.
  const lastScale = useRef(scale)
  const snapTop = useRef(false)
  useLayoutEffect(() => {
    const el = box.current
    const rescaled = lastScale.current !== scale
    lastScale.current = scale
    if (!el || !doc || !(restore.current || rescaled)) return
    if (!el.clientHeight) {
      restore.current = true // when shown
      return
    }
    restore.current = false
    if (snapTop.current) el.scrollTop = tops(heights).tops[Math.min(pos.current.page, heights.length - 1)] - GAP
    else el.scrollTop = scrollFor(heights, pos.current) - el.clientHeight / 2
    snapTop.current = false
  }, [doc, scale, shown])

  // Scroll so a spot on a page (PDF points from its top-left) sits a third
  // of the way down the view.
  const scrollTo = (page: number, y: number) => {
    const el = box.current
    if (!el || !doc) return
    const top = tops(heights).tops[Math.min(page, heights.length - 1)] + y * scale
    el.scrollTop = Math.max(0, top - el.clientHeight / 3)
    pos.current = posAt(heights, el.scrollTop + el.clientHeight / 2)
  }

  // SyncTeX forward: show the spot a source line produced, with a brief
  // highlight. Waits for the document if the tab has just opened.
  useEffect(() => {
    const b = target?.boxes?.[0]
    if (!b || !doc) return
    scrollTo(b.page - 1, b.y)
    setFlash({ ...b, n: target!.n })
    const t = window.setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [target?.n, doc !== null])

  // SyncTeX inverse: Ctrl+click (or the Source button, then a tap) on a page
  // opens the source line that produced that spot.
  const toSource = async (page: number, x: number, y: number) => {
    setSyncing(false)
    try {
      const r = await getJSON<{ path?: string; line: number; outside?: boolean }>(
        synctexURL('edit', root, { pdf: path, page: page + 1, x: x.toFixed(1), y: y.toFixed(1) }),
      )
      if (r.outside || !r.path) setNote('That text comes from a file outside this project (a class or package).')
      else onSource(r.path, r.line)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // The server's "no SyncTeX data: compile with -synctex=1", in words.
      setNote(/no synctex/i.test(m) ? 'synctex' : 'Could not find the source: ' + m.replace(/\.?$/, '.'))
    }
  }

  // A link inside the document: go to its page (and spot, for an XYZ
  // destination, whose y counts from the page's bottom).
  const goToDest = async (dest: unknown) => {
    if (!doc) return
    try {
      const explicit = typeof dest === 'string' ? await doc.pdf.getDestination(dest) : (dest as unknown[])
      if (!explicit) return
      const ref = explicit[0]
      const index = typeof ref === 'number' ? ref : await doc.pdf.getPageIndex(ref as { num: number; gen: number })
      const kind = (explicit[1] as { name?: string })?.name
      const yUp = kind === 'XYZ' && typeof explicit[3] === 'number' ? (explicit[3] as number) : null
      scrollTo(index, yUp === null ? 0 : Math.max(0, doc.sizes[index].h - yUp))
    } catch {
      // a broken link goes nowhere
    }
  }

  // The phone's floating page count shows while the pages move (a scroll,
  // a zoom, the PDF arriving) and fades 1.5 s after, off the page's corner.
  const [moving, setMoving] = useState(false)
  const still = useRef(0)
  const poke = () => {
    setMoving(true)
    clearTimeout(still.current)
    still.current = window.setTimeout(() => setMoving(false), 1500)
  }
  useEffect(() => {
    if (doc) poke()
  }, [doc, zoom])
  useEffect(() => () => clearTimeout(still.current), [])

  const onScroll = () => {
    poke()
    const el = box.current!
    if (!el.clientHeight) return // hidden; the scroll to 0 is not the reader's
    pos.current = posAt(heights, el.scrollTop + el.clientHeight / 2)
    setPage(pos.current.page)
    try {
      sessionStorage.setItem(spotKey, JSON.stringify(pos.current))
    } catch {
      // storage full or off: the spot lasts as long as the view
    }
  }

  const zoomBy = (f: number) => {
    restore.current = true
    setZoom(Math.min(Math.max(scale * f, 0.25), 5))
  }

  // Fit goes to the width, and from the width to the whole page being read
  // (the one in the middle of the view).
  const fit = () => {
    restore.current = true
    if (zoom === 'fit') {
      snapTop.current = true
      setZoom('page')
    } else setZoom('fit')
  }

  // A recompile moves the text; its matches are looked for again on Enter.
  useEffect(() => setHits(null), [doc])
  // A switch flipped after a search runs it again with the new rule.
  const [findOpts, setFindOpts] = useState<FindOpts>({})
  const searched = useRef(false)
  useEffect(() => {
    if (searched.current) findNext(false)
  }, [findOpts])

  const openFind = () => {
    setFinding(true)
    requestAnimationFrame(() => findBox.current?.select())
  }
  const closeFind = () => {
    setFinding(false)
    setHits(null)
    searched.current = false
  }
  const show = (list: Hit[], i: number) => {
    setCur(i)
    if (list[i]) scrollTo(list[i].page - 1, list[i].y)
  }
  // Enter looks for the query on every page (each page's text is read once
  // per version) and shows the first match from the top of the view down;
  // Shift+Enter, the first from its bottom up. Again goes on in that
  // direction, round the end of the document.
  const findNext = async (back: boolean) => {
    const want = foldQuery(q)
    if (!doc || !want || searching.current) return
    if (hits) {
      if (hits.length) show(hits, (cur + (back ? -1 : 1) + hits.length) % hits.length)
      return
    }
    searching.current = true
    searched.current = true
    try {
      if (texts.current?.key !== doc.key) texts.current = { key: doc.key, pages: new Map() }
      const cache = texts.current.pages
      const list: Hit[] = []
      for (let i = 0; i < doc.sizes.length; i++) {
        if (!cache.has(i)) cache.set(i, pageText(await runsOf(doc.pdf, i)))
        list.push(...find(cache.get(i)!, want, i + 1, findOpts))
      }
      setHits(list)
      // Spots as page + fraction of it, the view's edges as the same.
      const at = (h: Hit) => h.page - 1 + h.y / doc.sizes[h.page - 1].h
      const el = box.current
      const edge = (y: number) => {
        const p = posAt(heights, y)
        return p.page + p.frac
      }
      let from: number
      if (!el) from = 0
      else if (back) {
        const bottom = edge(el.scrollTop + el.clientHeight)
        from = list.findLastIndex((h) => at(h) <= bottom)
        if (from < 0) from = list.length - 1
      } else {
        const top = edge(el.scrollTop)
        from = list.findIndex((h) => at(h) >= top)
        if (from < 0) from = 0
      }
      show(list, from)
    } catch {
      setHits([])
    } finally {
      searching.current = false
    }
  }
  const hit = hits?.[cur] ?? null

  return (
    <div
      className="pdf-view"
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          openFind()
        }
      }}
    >
      <div className="pdf-bar">
        {/* A dash while loading holds the count's place, so the path does
            not jump 27 px as the PDF arrives. */}
        <span className={'pdf-count' + (doc ? '' : ' pending')}>{doc ? `${page + 1} / ${doc.sizes.length}` : '– / –'}</span>
        {/* The whole sentence, or on a phone a short form that fits with
            the sentence in its tip (a tap shows it). */}
        {status === 'updating' && <Badge variant="secondary" className="badge">Updating…</Badge>}
        {status === 'missing' && (
          <Badge variant="outline" className="badge warn text-[var(--warn)]" data-tip="Last version shown" data-tip-tap="">
            <span className="badge-long">File missing, showing the last version</span>
            <span className="badge-short">Last version</span>
          </Badge>
        )}
        {status === 'error' && (
          <Badge variant="outline" className="badge warn text-[var(--warn)]" data-tip={'Could not load the new version: ' + err} data-tip-tap="">
            <span className="badge-long">Could not load the new version</span>
            <span className="badge-short">Not updated</span>
          </Badge>
        )}
        <Crumb path={path} />
        <Tool
          label="Source"
          tip={`Source: tap a spot to open its source line (or ${mod === '⌘' ? '⌘-click' : 'Ctrl+click'} it)`}
          icon={<SyncIcon />}
          on={syncing}
          className="wide-only"
          onClick={() => setSyncing(!syncing)}
        />
        <span className={cn('seg', segList)}>
          <Tool label="Find" keys="Mod+F" icon={<FindIcon />} on={finding} onClick={() => (finding ? closeFind() : openFind())} />
          <Tool label="Zoom out" icon={<MinusIcon />} className="bare" onClick={() => zoomBy(1 / 1.2)} />
          {/* The zoom, in the group as viewers show it: a fixed slot, so
              nothing moves as it changes. (A phone's is in the floating count.) */}
          <span className="seg-level wide-only" aria-label={`Zoom ${Math.round(scale * 100)}%`}>
            {doc ? Math.round(scale * 100) + '%' : '–'}
          </span>
          {/* Named for what a click does, not for the current fit. */}
          <Tool
            label={zoom === 'fit' ? 'Fit page' : 'Fit width'}
            tip={zoom === 'fit' ? 'Fit page: show the whole page' : 'Fit width: the page as wide as the view'}
            icon={zoom === 'fit' ? <FitPageIcon /> : <FitWidthIcon />}
            onClick={fit}
          />
          <Tool label="Zoom in" icon={<PlusIcon />} className="bare narrow-last" onClick={() => zoomBy(1.2)} />
          <DownloadButton root={root} path={path} className="wide-only" />
        </span>
        <ToolMenu
          title={path.split('/').pop()!}
          tools={[
            { label: syncing ? 'Stop picking a spot' : 'Source: tap a spot', icon: <SyncIcon />, onPick: () => setSyncing(!syncing) },
            { label: 'Download', icon: <DownloadIcon />, href: downloadURL(root, path), download: path.split('/').pop() },
          ]}
        />
      </div>
      {finding && (
        <FindBar
          label="Find in PDF"
          q={q}
          onQuery={(v) => {
            setQ(v)
            setHits(null)
          }}
          opts={findOpts}
          onOpts={(o) => {
            setHits(null)
            setFindOpts(o)
          }}
          total={hits ? hits.length : null}
          cur={cur}
          onStep={findNext}
          onClose={closeFind}
          input={findBox}
        />
      )}
      {/* Picking a spot for its source: said plainly, with a way out, as the
          Source button that shows it is in the ⋯ menu on a phone. */}
      {syncing && (
        <div className="sync-note" role="status">
          <SyncIcon />
          <span className="grow">Tap a spot to see its source</span>
          <Tool label="Cancel" icon={null} text className="sync-cancel" onClick={() => setSyncing(false)} />
        </div>
      )}
      {note && (
        // Announced: it is the only answer to a tap in Source mode.
        <div className="notice info pdf-note" role={note.startsWith('Could not') ? 'alert' : 'status'}>
          <span className="grow">
            {note === 'synctex' ? (
              <>
                This PDF has no SyncTeX data. Build it with <code>-synctex=1</code> to jump from it to its source.
              </>
            ) : (
              note
            )}
          </span>
          <Tool label="Dismiss" icon={<CloseIcon />} className="bare" onClick={() => setNote('')} />
        </div>
      )}
      {/* A phone's bar has no room for the page count: it floats over the pages. */}
      {doc && (
        <span className={'pdf-count-float' + (moving ? ' on' : '')} aria-hidden="true">
          p. {page + 1} / {doc.sizes.length}
          {typeof zoom === 'number' && ` · ${Math.round(scale * 100)}%`}
        </span>
      )}
      <div className={'pdf-pages' + (typeof zoom === 'number' ? '' : ' fit') + (syncing ? ' syncing' : '')} ref={box} onScroll={onScroll}>
        {!doc && <div className="center faint">{status === 'missing' ? 'The file is gone.' : err || 'Loading…'}</div>}
        {doc &&
          doc.sizes.map((s, i) => (
            <PdfPage
              key={doc.key + ':' + i}
              doc={doc}
              index={i}
              w={s.w * scale}
              h={s.h * scale}
              scale={scale}
              scroller={box}
              flash={flash && flash.page === i + 1 ? flash : null}
              hit={hit && hit.page === i + 1 ? hit : null}
              onPick={(x, y, ctrl) => (ctrl || syncing) && toSource(i, x, y)}
              onDest={goToDest}
            />
          ))}
      </div>
    </div>
  )
}

// name: what the link says it does, its accessible name and its tip (the
// address, or the page it goes to).
type Link = { left: number; top: number; width: number; height: number; url?: string; dest?: unknown; name: string }

// The page (from 0) a link inside the document goes to, or -1.
async function destPage(doc: Doc, dest: unknown) {
  try {
    const explicit = typeof dest === 'string' ? await doc.pdf.getDestination(dest) : (dest as unknown[])
    const ref = explicit?.[0]
    if (ref == null) return -1
    return typeof ref === 'number' ? ref : await doc.pdf.getPageIndex(ref as { num: number; gen: number })
  } catch {
    return -1
  }
}

// Only these leave the app from a PDF link; anything else (javascript:,
// file:, launch actions) is dropped.
const safeURL = (u: string) => /^(https?:|mailto:)/i.test(u)

type PageProps = {
  doc: Doc
  index: number
  w: number
  h: number
  scale: number
  scroller: RefObject<HTMLDivElement | null>
  flash: Flash | null
  hit: Hit | null // the match Find is showing
  onPick: (x: number, y: number, ctrl: boolean) => void // PDF points from the top-left
  onDest: (dest: unknown) => void
}

// PdfPage is a box of the page's exact size holding, once it comes near
// the view (and again on zoom), the drawn page, a transparent text layer
// for selecting and copying, and the page's links. A long paper does not
// draw every page up front.
function PdfPage({ doc, index, w, h, scale, scroller, flash, hit, onPick, onDest }: PageProps) {
  const host = useRef<HTMLDivElement>(null)
  const canvasSlot = useRef<HTMLDivElement>(null)
  const textSlot = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [links, setLinks] = useState<Link[]>([])
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: scroller.current, rootMargin: '100% 0px' })
    io.observe(host.current!)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    const slot = canvasSlot.current!
    const pre = doc.pre.get(index)
    if (pre && Math.abs(pre.width - Math.floor(doc.sizes[index].w * scale * (window.devicePixelRatio || 1))) <= 2) {
      doc.pre.delete(index)
      slot.replaceChildren(pre)
    } else if (near) {
      let dead = false
      const c = document.createElement('canvas')
      draw(doc.pdf, index, scale, c)
        .then(() => !dead && slot.replaceChildren(c))
        .catch(() => {})
      return () => {
        dead = true
      }
    }
  }, [near, scale, doc])

  // Text and links, built once the page is near and rebuilt on zoom.
  useEffect(() => {
    if (!near) return
    let dead = false
    let layer: TextLayer | null = null
    ;(async () => {
      const page = await doc.pdf.getPage(index + 1)
      if (dead) return
      const vp = page.getViewport({ scale })
      const slot = textSlot.current!
      slot.replaceChildren()
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: slot, viewport: vp })
      await layer.render().catch(() => {})
      // pdf.js's full viewer adds this marker; while a drag selects (the
      // layer is "selecting") it covers the page, so dragging past the end
      // of a line does not select the rest of the page.
      const end = document.createElement('div')
      end.className = 'endOfContent'
      slot.append(end)
      const anns = await page.getAnnotations({ intent: 'display' })
      if (dead) return
      const out: Link[] = []
      for (const a of anns as { subtype?: string; rect: number[]; url?: string; dest?: unknown }[]) {
        if (a.subtype !== 'Link' || (!a.url && !a.dest)) continue
        if (a.url && !safeURL(a.url)) continue
        const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]) as number[]
        const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]) as number[]
        const page = a.url ? -1 : await destPage(doc, a.dest)
        const name = a.url ? a.url.replace(/^mailto:/i, 'Email ') : page >= 0 ? `Go to page ${page + 1}` : 'Go to a place in this document'
        out.push({ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), url: a.url, dest: a.dest, name })
      }
      if (dead) return
      setLinks(out)
    })().catch(() => {})
    return () => {
      dead = true
      layer?.cancel()
    }
  }, [near, scale, doc])

  return (
    <div
      className="pdf-page"
      ref={host}
      style={{ width: w, height: h, ['--total-scale-factor' as string]: scale }}
      onClick={(e) => {
        const r = host.current!.getBoundingClientRect()
        onPick((e.clientX - r.left) / scale, (e.clientY - r.top) / scale, e.ctrlKey || e.metaKey)
      }}
    >
      <div className="pdf-canvas" ref={canvasSlot} />
      <div className="textLayer" ref={textSlot} />
      {links.map((l, i) => (
        <a
          key={i}
          className="pdf-link"
          style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
          href={l.url ?? '#'}
          aria-label={l.name}
          data-tip={l.name}
          target={l.url ? '_blank' : undefined}
          rel="noopener noreferrer"
          onClick={(e) => {
            e.stopPropagation()
            if (!l.url) {
              e.preventDefault()
              onDest(l.dest)
            }
          }}
        />
      ))}
      {flash && (
        <div
          key={flash.n}
          className="pdf-flash"
          style={{ left: flash.x * scale - 4, top: flash.y * scale - 3, width: flash.w * scale + 8, height: flash.h * scale + 6 }}
        />
      )}
      {hit && (
        <div
          className="pdf-hit"
          style={{ left: hit.x * scale - 2, top: hit.y * scale - 2, width: hit.w * scale + 4, height: hit.h * scale + 5 }}
        />
      )}
    </div>
  )
}
