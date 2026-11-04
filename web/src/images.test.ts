import { describe, expect, it } from 'vitest'
import { scaleFor } from './images'

const size = (w: number, h: number) => {
  const k = scaleFor(w, h)
  return [Math.round(w * k), Math.round(h * k)]
}

describe('images', () => {
  it('shrink to what Claude takes: 2576 px on the long edge, 3.75 megapixels', () => {
    // A 4K laptop screen: the pixel count binds, not the edge.
    const [w, h] = size(3840, 2400)
    expect(w * h).toBeLessThanOrEqual(3_750_000)
    expect(w).toBeGreaterThan(2400)
    // A long strip: the edge binds.
    expect(size(6000, 400)[0]).toBe(2576)
    // A 1080p screenshot goes as it is.
    expect(scaleFor(1920, 1080)).toBe(1)
  })
})
