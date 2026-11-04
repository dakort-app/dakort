import { describe, expect, it } from 'vitest'
import { find, foldQuery, pageText, type Run } from './pdffind'

// Runs ten points per character, one line every twenty points.
const run = (str: string, x: number, line: number, eol = false): Run => ({ str, x, top: line * 20, w: str.length * 10, h: 12, eol })

describe('find in a PDF page', () => {
  it('ignores case, ligatures and runs of white space', () => {
    const pt = pageText([run('The ﬁrst   Needle', 0, 0, true), run('needle', 0, 1)])
    expect(pt.text).toBe('the first needle needle')
    expect(find(pt, foldQuery('NEEDLE'), 1)).toHaveLength(2)
    expect(find(pt, foldQuery('first'), 1)).toHaveLength(1)
    expect(find(pt, foldQuery('  first\n needle '), 1)).toHaveLength(1)
  })

  it('boxes a match inside one run', () => {
    const [h] = find(pageText([run('a needle here', 100, 2)]), 'needle', 3)
    expect(h).toEqual({ page: 3, x: 120, y: 40, w: 60, h: 12 })
  })

  it('boxes a match spanning runs on one line from start to end', () => {
    const [h] = find(pageText([run('nee', 0, 0), run('dle', 30, 0)]), 'needle', 1)
    expect(h.x).toBe(0)
    expect(h.w).toBe(60)
  })

  it('finds a phrase broken across lines, boxed on the first line', () => {
    const pt = pageText([run('one needle', 0, 0, true), run('here', 0, 1)])
    const [h] = find(pt, foldQuery('needle here'), 1)
    expect(h).toEqual({ page: 1, x: 40, y: 0, w: 60, h: 12 })
  })

  it('finds nothing for an empty query', () => {
    expect(find(pageText([run('text', 0, 0)]), foldQuery('   '), 1)).toEqual([])
  })
})
