import { describe, expect, it } from 'vitest'
import { GAP, posAt, scrollFor, tops } from './pdfpos'

describe('position in a PDF', () => {
  const pages = [1000, 1000, 1000]

  it('stacks pages with gaps', () => {
    expect(tops(pages)).toEqual({ tops: [GAP, 1010 + GAP, 2020 + GAP], total: 3040 })
  })

  it('round-trips a spot', () => {
    for (const y of [0, 10, 500, 1020, 1600, 2900]) {
      expect(Math.abs(scrollFor(pages, posAt(pages, y)) - Math.max(y, GAP))).toBeLessThan(1)
    }
  })

  it('keeps the spot when zoom changes the page heights', () => {
    const p = posAt(pages, 1520) // half way down page 2
    expect(p.page).toBe(1)
    expect(p.frac).toBeCloseTo(0.5, 2)
    const zoomed = pages.map((h) => h * 2)
    expect(posAt(zoomed, scrollFor(zoomed, p)).page).toBe(1)
    expect(scrollFor(zoomed, p)).toBeCloseTo(tops(zoomed).tops[1] + 1000, 0)
  })

  it('clamps when a recompile drops pages', () => {
    const p = posAt(pages, 2500) // on page 3
    expect(scrollFor([1000, 1000], p)).toBeLessThanOrEqual(tops([1000, 1000]).total)
    expect(posAt([1000, 1000], scrollFor([1000, 1000], p)).page).toBe(1)
  })

  it('handles an empty document', () => {
    expect(posAt([], 100)).toEqual({ page: 0, frac: 0 })
    expect(scrollFor([], { page: 3, frac: 0.5 })).toBe(0)
  })
})
