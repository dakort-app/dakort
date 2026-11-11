import { renderAsync } from 'docx-preview'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FindBar } from './FindBar'
import { fileURL, DownloadButton } from './FileView'
import { foldQuery, pageText, spans, type FindOpts } from './pdffind'

// A Word file drawn in the browser by docx-preview: pages as Word lays
// them out, near enough (fonts the browser lacks are substituted). A new
// version replaces the old one in place, keeping the scroll position.
// Fit shrinks the pages to the width on a phone, never enlarges them;
// − and + zoom from there. Find marks every match with the CSS Highlight
// API (the text is real text, so no overlay is needed).

type Props = { root: string; path: string; version: string }
type Zoom = number | 'fit'
type TextRun = { str: string; eol?: boolean; node: Text }

// The document's text nodes in order, a run ending wherever the next one
// is in another paragraph or cell. docx-preview's own style elements are
// not text.
function runsOf(root: HTMLElement): TextRun[] {
  const out: TextRun[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let last: Element | null = null
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    const el = n.parentElement
    if (!el?.closest('section.docx') || el.closest('style, script')) continue
    const block = el.closest('p, td, th, li, h1, h2, h3, h4, h5, h6, section')
    if (out.length && block !== last) out[out.length - 1].eol = true
    last = block
    out.push({ str: n.data, node: n })
  }
  return out
}

const canMark = typeof CSS !== 'undefined' && 'highlights' in CSS

function mark(all: Range[], cur: Range | undefined) {
  if (!canMark) return
  if (all.length) CSS.highlights.set('docx-find', new Highlight(...all))
  else CSS.highlights.delete('docx-find')
  if (cur) CSS.highlights.set('docx-find-cur', new Highlight(cur))
  else CSS.highlights.delete('docx-find-cur')
}

export function DocxView({ root, path, version }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const scaleRef = useRef(1)
  const [finding, setFinding] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Range[] | null>(null)
  const [cur, setCur] = useState(0)
  const findBox = useRef<HTMLInputElement>(null)

  const fit = () => {
    const b = box.current
    const p = pages.current
    if (!b || !p) return
    // A transform, not zoom: WebKit's zoom dropped the thin table borders.
    // A transform keeps the layout size, so the box is given the shrunk
    // height by hand; an enlarged one overflows, and scrolls, by itself.
    const page = p.querySelector<HTMLElement>('section.docx')
    if (!page) return
    const z = zoomRef.current
    const k = z === 'fit' ? Math.min(1, (b.clientWidth - 16) / page.offsetWidth) : z
    scaleRef.current = k
    p.style.transform = k !== 1 ? `scale(${k})` : ''
    p.style.width = k !== 1 ? `${100 / k}%` : ''
    p.style.marginBottom = k < 1 ? `${-(1 - k) * p.offsetHeight}px` : ''
  }

  useEffect(() => {
    if (!version) return
    let dead = false
    fetch(fileURL('raw', root, path), { cache: 'no-cache' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const buf = await r.arrayBuffer()
        if (dead || !pages.current) return
        // Drawn off screen first, so a reload does not flash an empty page.
        const next = document.createElement('div')
        await renderAsync(buf, next, undefined, {
          className: 'docx',
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
          breakPages: true,
          useBase64URL: true,
        })
        if (dead || !pages.current) return
        const top = box.current?.scrollTop ?? 0
        pages.current.replaceChildren(...next.childNodes)
        fit()
        if (box.current) box.current.scrollTop = top
        // The old matches were in the text just replaced.
        setHits(null)
        setErr('')
        setReady(true)
      })
      .catch((e) => {
        if (!dead) setErr('Could not show this document: ' + (e instanceof Error ? e.message : String(e)))
      })
    return () => {
      dead = true
    }
  }, [root, path, version])

  useLayoutEffect(() => {
    const b = box.current
    if (!b) return
    const ro = new ResizeObserver(fit)
    ro.observe(b)
    return () => ro.disconnect()
  }, [])

  // A zoom keeps the same spot in the document in view.
  useLayoutEffect(() => {
    const b = box.current
    if (!b) return
    const frac = b.scrollTop / Math.max(1, b.scrollHeight)
    fit()
    b.scrollTop = frac * b.scrollHeight
  }, [zoom])

  const zoomBy = (f: number) => setZoom(Math.min(Math.max(scaleRef.current * f, 0.25), 4))

  useEffect(() => mark(hits ?? [], hits?.[cur]), [hits, cur])
  useEffect(() => () => mark([], undefined), [])

  const openFind = () => {
    setFinding(true)
    requestAnimationFrame(() => findBox.current?.select())
  }
  const closeFind = () => {
    setFinding(false)
    setHits(null)
    searched.current = false
  }
  // A switch flipped after a search runs it again with the new rule.
  const [findOpts, setFindOpts] = useState<FindOpts>({})
  const searched = useRef(false)
  useEffect(() => {
    if (searched.current) step(false)
  }, [findOpts])
  // Bring a match a third of the way down the view (and across, if zoomed
  // in past the width).
  const show = (list: Range[], i: number) => {
    setCur(i)
    const b = box.current
    if (!b || !list[i]) return
    const r = list[i].getBoundingClientRect()
    const v = b.getBoundingClientRect()
    b.scrollTop += r.top - v.top - b.clientHeight / 3
    if (r.left < v.left || r.right > v.right) b.scrollLeft += r.left - v.left - b.clientWidth / 3
  }
  const step = (back: boolean) => {
    const want = foldQuery(q)
    if (!want || !pages.current) return
    if (hits) {
      if (hits.length) show(hits, (cur + (back ? -1 : 1) + hits.length) % hits.length)
      return
    }
    searched.current = true
    const pt = pageText(runsOf(pages.current))
    const list = spans(pt, want, findOpts).map(({ s, e }) => {
      const r = document.createRange()
      r.setStart(pt.runs[s.run].node, s.ch)
      const end = pt.runs[e.run].node
      r.setEnd(end, Math.min(e.ch + 1, end.length))
      return r
    })
    setHits(list)
    // The first match down from the top of the view, or (Shift+Enter) up
    // from its bottom; round the end when there is none that way.
    const v = box.current?.getBoundingClientRect()
    let from: number
    if (back) {
      from = list.findLastIndex((r) => r.getBoundingClientRect().top <= (v?.bottom ?? Infinity))
      if (from < 0) from = list.length - 1
    } else {
      from = list.findIndex((r) => r.getBoundingClientRect().bottom >= (v?.top ?? 0))
      if (from < 0) from = 0
    }
    show(list, from)
  }

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
        <span className="grow ellipsis small faint" title={path}>
          {path}
        </span>
        <button className={'btn small-btn' + (finding ? ' on' : '')} onClick={() => (finding ? closeFind() : openFind())} title="Find in the document (Ctrl+F)">
          Find
        </button>
        <button className="btn small-btn" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <button className={'btn small-btn'} onClick={() => setZoom('fit')} title="Fit the width (never larger than the page)">
          Fit
        </button>
        <button className="btn small-btn" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <DownloadButton root={root} path={path} />
      </div>
      {finding && (
        <FindBar
          label="Find in document"
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
          onStep={step}
          onClose={closeFind}
          input={findBox}
        />
      )}
      <div className="file-docx" ref={box}>
        {err && <div className="notice error small">{err}</div>}
        {!ready && !err && <div className="center faint">Loading…</div>}
        <div ref={pages} />
      </div>
    </div>
  )
}
