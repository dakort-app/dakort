import ExcelJS from 'exceljs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fileURL } from './FileView'
import { cssColour, formatValue, plainValue, themeColours, type Colour } from './sheetfmt'

// An Excel workbook read in the browser by ExcelJS and drawn as a table
// per sheet: fills, bold and italic, text colours (ARGB, the legacy
// palette, or the theme's with a tint), column widths, merged cells, and
// values through a subset of Excel's number formats (sheetfmt.ts).
// Viewing only. A new version of the file is read again in place. Big
// sheets show their first rows with a button for the rest; a huge file is
// declined, since ExcelJS builds the whole workbook in memory.

type Props = { root: string; path: string; version: string; size: number }

export const maxSheetBytes = 15 << 20
const firstRows = 2000

type Cell = {
  text: string
  title?: string
  bg: string
  fg: string
  bold: boolean
  italic: boolean
  align: 'left' | 'right' | 'center'
  colSpan: number
  rowSpan: number
}
type Sheet = { name: string; rows: (Cell | null)[][]; nrows: number; ncols: number; widths: number[]; noResult: number }

// Excel's column width is in characters of the default font; about 7px
// each at 11pt, plus padding.
const colPx = (w: number | undefined) => Math.round((w ?? 8.43) * 7 + 5)

function readSheet(ws: ExcelJS.Worksheet, theme: string[]): Sheet {
  const nrows = ws.rowCount
  const ncols = ws.columnCount
  const rows: (Cell | null)[][] = []
  // Merged ranges: the top-left cell spans, the rest are skipped.
  const span = new Map<string, { r: number; c: number }>()
  const covered = new Set<string>()
  for (const m of ws.model.merges ?? []) {
    const [a, b] = m.split(':')
    const A = ws.getCell(a)
    const B = ws.getCell(b)
    const r0 = Number(A.row)
    const c0 = Number(A.col)
    const r1 = Number(B.row)
    const c1 = Number(B.col)
    span.set(`${r0},${c0}`, { r: r1 - r0 + 1, c: c1 - c0 + 1 })
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) covered.add(`${r},${c}`)
  }
  let noResult = 0
  for (let r = 1; r <= nrows; r++) {
    const row = ws.getRow(r)
    const out: (Cell | null)[] = []
    for (let c = 1; c <= ncols; c++) {
      if (covered.has(`${r},${c}`)) {
        out.push(null)
        continue
      }
      const cell = row.getCell(c)
      const { value, formulaNoResult } = plainValue(cell.value)
      if (formulaNoResult) noResult++
      const text = formatValue(value, cell.numFmt)
      const fill = cell.fill
      const bg = fill && fill.type === 'pattern' && fill.pattern !== 'none' ? cssColour((fill.fgColor ?? fill.bgColor) as Colour, theme) : ''
      const font = cell.font
      const fg = font ? cssColour(font.color as Colour, theme) : ''
      const h = cell.alignment?.horizontal
      const align: Cell['align'] =
        h === 'right' || h === 'center' ? h : h === 'left' ? 'left' : typeof value === 'number' || value instanceof Date ? 'right' : 'left'
      const s = span.get(`${r},${c}`)
      out.push({
        text,
        title: text.length > 40 ? text : undefined,
        bg,
        fg,
        bold: !!font?.bold,
        italic: !!font?.italic,
        align,
        colSpan: s?.c ?? 1,
        rowSpan: s?.r ?? 1,
      })
    }
    rows.push(out)
  }
  const widths: number[] = []
  for (let c = 1; c <= ncols; c++) widths.push(colPx(ws.getColumn(c).width))
  return { name: ws.name, rows, nrows, ncols, widths, noResult }
}

const colName = (c: number) => {
  let s = ''
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export function SheetView({ root, path, version, size }: Props) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [err, setErr] = useState('')
  const [cur, setCur] = useState(0)
  const [all, setAll] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!version || size > maxSheetBytes) return
    let dead = false
    fetch(fileURL('raw', root, path), { cache: 'no-cache' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const buf = await r.arrayBuffer()
        if (dead) return
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(buf)
        if (dead) return
        // The theme part's XML, for colours given as a theme index.
        const themes = (wb as unknown as { _themes?: Record<string, string> })._themes
        const theme = themeColours(themes ? Object.values(themes)[0] : undefined)
        const list = wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden').map((ws) => readSheet(ws, theme))
        // Reread in place: the sheet on screen and the scroll stay.
        const top = box.current?.scrollTop ?? 0
        setSheets(list)
        setCur((i) => Math.min(i, Math.max(0, list.length - 1)))
        setErr('')
        requestAnimationFrame(() => {
          if (box.current) box.current.scrollTop = top
        })
      })
      .catch((e) => {
        if (!dead) setErr('Could not read this workbook: ' + (e instanceof Error ? e.message : String(e)))
      })
    return () => {
      dead = true
    }
  }, [root, path, version, size])

  const sheet = sheets?.[cur]
  const shown = useMemo(() => (sheet ? (all ? sheet.rows : sheet.rows.slice(0, firstRows)) : []), [sheet, all])

  if (size > maxSheetBytes) {
    return <div className="center faint office-note">Too large to view here ({(size / 1e6).toFixed(1)} MB). Open on the computer, above, opens it in its program.</div>
  }
  if (err) return <div className="center error">{err}</div>
  if (!sheet) return <div className="center faint">Loading…</div>
  const rnW = String(sheet.nrows).length + 2

  return (
    <div className="file-sheet">
      <div className="sheet-box" ref={box}>
        <table className="sheet-table" style={{ width: sheet.widths.reduce((a, b) => a + b, 0) + rnW * 8 + 'px' }}>
          <colgroup>
            <col style={{ width: rnW + 'ch' }} />
            {sheet.widths.map((w, c) => (
              <col key={c} style={{ width: w + 'px' }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="rn" />
              {sheet.widths.map((_, c) => (
                <th key={c}>{colName(c + 1)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                <td className="rn">{r + 1}</td>
                {row.map((cell, c) =>
                  cell === null ? null : (
                    <td
                      key={c}
                      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      title={cell.title}
                      style={{
                        background: cell.bg || undefined,
                        color: cell.fg || undefined,
                        fontWeight: cell.bold ? 700 : undefined,
                        fontStyle: cell.italic ? 'italic' : undefined,
                        textAlign: cell.align,
                      }}
                    >
                      {cell.text}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sheet-foot small">
        {sheets!.length > 1 && (
          <span className="sheet-tabs" role="tablist">
            {sheets!.map((s, i) => (
              <button key={s.name} role="tab" aria-selected={i === cur} className={'sheet-tab' + (i === cur ? ' on' : '')} onClick={() => setCur(i)}>
                {s.name}
              </button>
            ))}
          </span>
        )}
        <span className="faint grow ellipsis">
          {sheet.nrows.toLocaleString()} {sheet.nrows === 1 ? 'row' : 'rows'} × {sheet.ncols} {sheet.ncols === 1 ? 'column' : 'columns'}
          {sheet.noResult > 0 && ` · ${sheet.noResult} formula ${sheet.noResult === 1 ? 'cell has' : 'cells have'} no computed value (the file was never opened in a spreadsheet program)`}
        </span>
        {!all && sheet.nrows > firstRows && (
          <button className="btn small-btn" onClick={() => setAll(true)} title={`Showing the first ${firstRows.toLocaleString()} rows`}>
            Show all
          </button>
        )}
      </div>
    </div>
  )
}
