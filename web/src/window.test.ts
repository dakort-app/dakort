import { describe, expect, it } from 'vitest'
import type { Page, Row } from './types'
import { append, canReveal, collapse, fromTail, hasOlder, pinIndex, prepend, reveal } from './window'

// Rows a..: each 10 bytes long, starting at offset 10*i.
const rows = (from: number, to: number): Row[] =>
  Array.from({ length: to - from }, (_, k) => {
    const i = from + k
    return { uuid: 'r' + i, role: 'user', time: '', offset: i * 10, end: i * 10 + 10 }
  })
const page = (from: number, to: number, atStart = false): Page => ({ rows: rows(from, to), atStart, next: to * 10 })
const ids = (w: { rows: Row[] }) => w.rows.map((r) => r.uuid).join(',')

describe('render window', () => {
  it('pins by row, so rows above or below never move it', () => {
    let w = fromTail(page(100, 150))
    expect(w.pin).toBe('r100')
    w = append(w, page(150, 152))
    w = prepend(w, page(50, 100))
    expect(w.pin).toBe('r100')
    expect(pinIndex(w)).toBe(50)
    expect(w.rows).toHaveLength(102)
  })

  it('reveals loaded rows, and asks for a fetch when there are not enough', () => {
    let w = fromTail(page(100, 150))
    expect(hasOlder(w)).toBe(true)
    expect(canReveal(w)).toBe(false) // nothing above is loaded yet
    w = prepend(w, page(60, 100))
    expect(canReveal(w)).toBe(false) // 40 loaded, a step is 50, and more exist
    w = prepend(w, page(0, 60, true))
    expect(canReveal(w)).toBe(true)
    w = reveal(w)
    expect(w.pin).toBe('r50')
    w = reveal(reveal(w))
    expect(w.pin).toBe('r0')
    expect(hasOlder(w)).toBe(false)
  })

  it('reveals a short remainder at the start of the file', () => {
    let w = prepend(fromTail(page(30, 80)), page(0, 30, true))
    expect(canReveal(w)).toBe(true)
    w = reveal(w)
    expect(w.pin).toBe('r0')
  })

  it('drops rows it already has, and keeps the catch-up cursor', () => {
    let w = fromTail(page(0, 10, true))
    w = append(w, { rows: rows(8, 12), next: 120 })
    expect(ids(w)).toBe('r0,r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11')
    expect(w.next).toBe(120)
    w = append(w, { rows: [], next: 125 })
    expect(w.next).toBe(125)
  })

  it('collapses to the tail after a send, never downward past the pin', () => {
    let w = prepend(fromTail(page(100, 150)), page(0, 100, true))
    w = reveal(reveal(w))
    expect(w.pin).toBe('r0')
    w = append(w, page(150, 160))
    w = collapse(w)
    expect(w.pin).toBe('r110')
    expect(collapse(fromTail(page(0, 20, true))).pin).toBe('r0')
  })

  it('handles an empty session that gains rows', () => {
    let w = fromTail({ rows: [], atStart: true, next: 0 })
    expect(hasOlder(w)).toBe(false)
    w = append(w, page(0, 2))
    expect(w.pin).toBe('r0')
  })
})
