// Finding words in a PDF, or a Word file. pdf.js gives a page's text as
// runs, each with a position (a Word file's runs are its text nodes); the
// runs are joined into one string (lower case, ligatures split, white
// space collapsed) that remembers, for each of its characters, the run and
// offset it came from, so a match maps back to a box on the page or a
// range in the document.

export type Run = { str: string; x: number; top: number; w: number; h: number; eol?: boolean } // PDF points from the page's top-left
export type PageText<R = Run> = { text: string; at: { run: number; ch: number }[]; runs: R[] }
export type Hit = { page: number; x: number; y: number; w: number; h: number } // page counts from 1, as in a SyncBox

const fold = (s: string) => s.normalize('NFKC').toLowerCase()

export const foldQuery = (q: string) => fold(q).replace(/\s+/g, ' ').trim()

// eol marks a run that ends a line or paragraph: a space follows it.
export function pageText<R extends { str: string; eol?: boolean }>(runs: R[]): PageText<R> {
  let text = ''
  const at: PageText['at'] = []
  const space = (run: number, ch: number) => {
    if (text && !text.endsWith(' ')) {
      text += ' '
      at.push({ run, ch })
    }
  }
  runs.forEach((r, i) => {
    for (let j = 0; j < r.str.length; j++) {
      const f = fold(r.str[j])
      if (/^\s*$/.test(f)) {
        if (f) space(i, j)
        continue
      }
      for (let k = 0; k < f.length; k++) {
        text += f[k]
        at.push({ run: i, ch: j })
      }
    }
    if (r.eol) space(i, r.str.length)
  })
  return { text, at, runs }
}

// find returns every match of a folded query on one page. A match across
// runs on the same line gets one box from its start to its end; one that
// wraps to the next line is boxed on its first line only.
export function find(pt: PageText, q: string, page: number): Hit[] {
  const per = (r: Run) => (r.str.length ? r.w / r.str.length : 0)
  return spans(pt, q).map(({ s, e }) => {
    const rs = pt.runs[s.run]
    const re = pt.runs[e.run]
    const x = rs.x + per(rs) * s.ch
    const sameLine = Math.abs(re.top - rs.top) < rs.h / 2
    const x2 = sameLine ? re.x + per(re) * (e.ch + 1) : rs.x + rs.w
    return { page, x, y: rs.top, w: Math.max(x2 - x, 1), h: rs.h }
  })
}

// spans returns where each match of a folded query starts and ends (its
// first and last characters, as run and offset).
export function spans<R>(pt: PageText<R>, q: string) {
  const out: { s: PageText['at'][number]; e: PageText['at'][number] }[] = []
  if (!q) return out
  for (let k = pt.text.indexOf(q); k >= 0; k = pt.text.indexOf(q, k + 1)) out.push({ s: pt.at[k], e: pt.at[k + q.length - 1] })
  return out
}
