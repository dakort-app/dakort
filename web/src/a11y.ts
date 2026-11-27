import type { KeyboardEvent } from 'react'

// activate makes a clickable row that is not a <button> work from the
// keyboard as well: Enter or Space on the row itself (not on a button or
// field inside it) does what a click does. Pair it with tabIndex={0} and
// a role.
export const activate =
  (f: () => void) =>
  (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    f()
  }

// scrolledEdge is a ref for a sheet: it marks the sheet data-scrolled
// while a list inside it is scrolled down, so the header's rule shows only
// when rows pass under it.
export function scrolledEdge(el: HTMLElement | null) {
  if (!el || el.dataset.edge) return
  el.dataset.edge = '1'
  el.addEventListener('scroll', (e) => el.toggleAttribute('data-scrolled', (e.target as HTMLElement).scrollTop > 0), true)
}
