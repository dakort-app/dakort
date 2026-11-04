// The transcript's render window. The browser holds the rows it fetched
// (paged by byte offset) and renders from a pinned row to the end. The pin
// is a row's uuid, never a count, so new rows arriving at the bottom or
// older ones fetched above never move what is on screen.

import type { Page, Row } from './types'

export type Win = {
  rows: Row[]
  pin: string // uuid of the first rendered row; '' when there are no rows
  atStart: boolean // nothing older exists in the file
  next: number // byte offset to catch up from (rows?after=)
}

// Rows revealed per step upward, and kept when collapsing to the tail.
export const STEP = 50

export function fromTail(p: Page): Win {
  return { rows: p.rows, pin: p.rows[0]?.uuid ?? '', atStart: !!p.atStart, next: p.next }
}

export function pinIndex(w: Win): number {
  const i = w.rows.findIndex((r) => r.uuid === w.pin)
  return i < 0 ? 0 : i
}

// prepend adds an older page above. The pin stays where it was.
export function prepend(w: Win, p: Page): Win {
  const have = new Set(w.rows.map((r) => r.uuid))
  const older = p.rows.filter((r) => !have.has(r.uuid))
  return { ...w, rows: [...older, ...w.rows], atStart: !!p.atStart, pin: w.pin || (older[0]?.uuid ?? '') }
}

// append adds rows caught up with rows?after=.
export function append(w: Win, p: Page): Win {
  const have = new Set(w.rows.map((r) => r.uuid))
  const newer = p.rows.filter((r) => !have.has(r.uuid))
  const rows = newer.length ? [...w.rows, ...newer] : w.rows
  return { ...w, rows, next: p.next, pin: w.pin || (rows[0]?.uuid ?? '') }
}

// canReveal says whether n more rows above the pin are already loaded.
export function canReveal(w: Win, n = STEP): boolean {
  return pinIndex(w) >= n || (w.atStart && pinIndex(w) > 0)
}

// reveal moves the pin up by n loaded rows.
export function reveal(w: Win, n = STEP): Win {
  const i = Math.max(0, pinIndex(w) - n)
  return { ...w, pin: w.rows[i]?.uuid ?? '' }
}

// collapse pins the last n rows, after a send.
export function collapse(w: Win, n = STEP): Win {
  const i = Math.max(0, w.rows.length - n)
  if (i <= pinIndex(w)) return w
  return { ...w, pin: w.rows[i].uuid }
}

// hasOlder says whether anything exists above the rendered rows.
export function hasOlder(w: Win): boolean {
  return pinIndex(w) > 0 || !w.atStart
}
