import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parse, sniff } from './csv'
import { useEdges } from './edges'
import './CsvView.css'

// A CSV or TSV file as a table: the first row as a header that stays at
// the top, row numbers down the left, and only the rows in view drawn, so
// a file of a hundred thousand rows scrolls as lightly as ten. Cells keep
// to one line (the whole value on hover); columns are as wide as their
// longest value among the first rows, within bounds, and mostly numeric
// ones align right.

// The row height in CsvView.css (.csv-table td, the --ctl and --ctl-lg
// tokens): 32 px on a touch screen, 28 with a mouse.
const rowH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 32 : 28
const maxRows = 100_000
const sample = 500
const spare = 12 // rows drawn beyond the view each way

const numeric = /^[-+]?[\d.,\s]*\d[\d.,\s]*%?$/

export function CsvView({ text, tsv }: { text: string; tsv: boolean }) {
  const { head, body, more, cols } = useMemo(() => {
    const { rows, more } = parse(text, tsv ? '\t' : sniff(text), maxRows + 1)
    const head = rows[0] ?? []
    const body = rows.slice(1)
    let cols = head.length
    for (const r of body) if (r.length > cols) cols = r.length
    return { head, body, more, cols }
  }, [text, tsv])

  const { widths, right } = useMemo(() => {
    const widths: number[] = []
    const right: boolean[] = []
    const some = body.slice(0, sample)
    for (let c = 0; c < cols; c++) {
      // By the cells, the header counting for 14 characters at most: a
      // long header over short numbers made a 328 px column whose numbers,
      // aligned right, sat off a phone's edge. A cut header shows whole on
      // a tap (below).
      let w = Math.min((head[c] ?? '').length, 14)
      let nums = 0
      let filled = 0
      for (const r of some) {
        const v = r[c] ?? ''
        if (v.length > w) w = v.length
        if (v) {
          filled++
          if (numeric.test(v)) nums++
        }
      }
      widths.push(Math.min(Math.max(w, 3), 40) + 2)
      right.push(filled > 0 && nums / filled >= 0.8)
    }
    return { widths, right }
  }, [head, body, cols])

  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, h: 600 })
  const edges = useEdges(box, [text])
  useLayoutEffect(() => {
    const b = box.current
    if (!b) return
    const ro = new ResizeObserver(() => setView({ top: b.scrollTop, h: b.clientHeight }))
    ro.observe(b)
    return () => ro.disconnect()
  }, [])

  const numW = String(body.length).length + 2
  // A column's width counts its padding and rule (the table's layout is
  // fixed, styles in CsvView.css): the longest text and a character to
  // spare (w has two), then 8 px a side and 1.
  const colW = (w: number) => `calc(${w - 1}ch + 2 * var(--sp-2) + 1px)`
  // And never wider than the view beside the pinned row numbers, with a
  // gutter (100cqw: .csv-box is a size container): at the end of a swipe a
  // column's start is not under the row numbers, on any phone's width.
  const capped = (w: number) => `min(${colW(w)}, calc(100cqw - ${colW(numW)} - 2 * var(--sp-3)))`
  const first = Math.max(0, Math.floor(view.top / rowH) - spare)
  const last = Math.min(body.length, Math.ceil((view.top + view.h) / rowH) + spare)
  const cell = (v: string | undefined, c: number) => (
    <td key={c} className={right[c] ? 'num' : undefined}>
      {v}
    </td>
  )

  // A cell its column cuts short ("…") gets its whole text, with the
  // column's name, as a tip a tap shows (tips.ts: a mouse rests on it, a
  // finger taps it). Decided from the drawn width: the cap on a column
  // depends on the screen. After every render, as rows come and go.
  useLayoutEffect(() => {
    const table = box.current?.querySelector('table')
    if (!table) return
    const mark = (cell: HTMLTableCellElement, v: string, tip: string) => {
      if (v && cell.scrollWidth > cell.clientWidth + 1) {
        cell.dataset.tip = tip
        cell.setAttribute('data-tip-tap', '')
      } else if (cell.dataset.tip) {
        delete cell.dataset.tip
        cell.removeAttribute('data-tip-tap')
      }
    }
    // The header's names too, when cut.
    const top = table.tHead?.rows[0]
    if (top) for (let c = 1; c < top.cells.length; c++) mark(top.cells[c], head[c - 1] ?? '', head[c - 1] ?? '')
    for (const tr of table.tBodies[0]?.rows ?? []) {
      const row = Number(tr.dataset.row)
      for (let c = 1; c < tr.cells.length; c++) {
        const v = body[row]?.[c - 1] ?? ''
        mark(tr.cells[c], v, head[c - 1] ? `${head[c - 1]}: ${v}` : v)
      }
    }
  })

  return (
    <div className="file-csv">
      <div
        className="csv-box"
        ref={box}
        onScroll={(e) => {
          setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })
          edges.measure()
        }}
        {...edges.attrs}
      >
        <table className="csv-table">
          <colgroup>
            <col style={{ width: colW(numW) }} />
            {widths.map((w, c) => (
              <col key={c} style={{ width: capped(w) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="rn" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} className={right[c] ? 'num' : undefined} title={head[c]}>
                  {head[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && <tr style={{ height: first * rowH }} aria-hidden="true" />}
            {body.slice(first, last).map((r, i) => (
              <tr key={first + i} data-row={first + i}>
                <td className="rn">{first + i + 1}</td>
                {Array.from({ length: cols }, (_, c) => cell(r[c], c))}
              </tr>
            ))}
            {last < body.length && <tr style={{ height: (body.length - last) * rowH }} aria-hidden="true" />}
          </tbody>
        </table>
      </div>
      <div className="csv-foot small faint">
        {more ? `The first ${maxRows.toLocaleString()} rows` : `${body.length.toLocaleString()} ${body.length === 1 ? 'row' : 'rows'}`} × {cols}{' '}
        {cols === 1 ? 'column' : 'columns'}
      </div>
    </div>
  )
}
