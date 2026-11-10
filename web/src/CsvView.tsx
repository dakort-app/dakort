import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parse, sniff } from './csv'

// A CSV or TSV file as a table: the first row as a header that stays at
// the top, row numbers down the left, and only the rows in view drawn, so
// a file of a hundred thousand rows scrolls as lightly as ten. Cells keep
// to one line (the whole value on hover); columns are as wide as their
// longest value among the first rows, within bounds, and mostly numeric
// ones align right.

const rowH = 26
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
      let w = (head[c] ?? '').length
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
  useLayoutEffect(() => {
    const b = box.current
    if (!b) return
    const ro = new ResizeObserver(() => setView({ top: b.scrollTop, h: b.clientHeight }))
    ro.observe(b)
    return () => ro.disconnect()
  }, [])

  const numW = String(body.length).length + 2
  const first = Math.max(0, Math.floor(view.top / rowH) - spare)
  const last = Math.min(body.length, Math.ceil((view.top + view.h) / rowH) + spare)
  const cell = (v: string | undefined, c: number) => (
    <td key={c} className={right[c] ? 'num' : undefined} title={v && v.length > widths[c] - 2 ? v : undefined}>
      {v}
    </td>
  )

  return (
    <div className="file-csv">
      <div className="csv-box" ref={box} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
        <table className="csv-table">
          <colgroup>
            <col style={{ width: numW + 'ch' }} />
            {widths.map((w, c) => (
              <col key={c} style={{ width: w + 'ch' }} />
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
              <tr key={first + i}>
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
