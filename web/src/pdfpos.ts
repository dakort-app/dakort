// Where the reader is in a PDF, as a page and a fraction of it, so the
// spot survives a recompile that changes page sizes or zoom. Pages stack
// top to bottom with a fixed gap; heights come from the PDF itself.

export const GAP = 10

export type Pos = { page: number; frac: number } // page is 0-based; frac in [0, 1)

// tops returns each page's top offset, and the total height.
export function tops(heights: number[]): { tops: number[]; total: number } {
  const out: number[] = []
  let y = GAP
  for (const h of heights) {
    out.push(y)
    y += h + GAP
  }
  return { tops: out, total: y }
}

export function posAt(heights: number[], scrollTop: number): Pos {
  if (!heights.length) return { page: 0, frac: 0 }
  const t = tops(heights).tops
  let i = 0
  while (i + 1 < t.length && t[i + 1] <= scrollTop) i++
  const frac = Math.min(Math.max((scrollTop - t[i]) / heights[i], 0), 0.9999)
  return { page: i, frac }
}

// scrollFor places the same spot in a document with these heights; a page
// past the end clamps to the last one.
export function scrollFor(heights: number[], p: Pos): number {
  if (!heights.length) return 0
  const page = Math.min(p.page, heights.length - 1)
  return tops(heights).tops[page] + p.frac * heights[page]
}
