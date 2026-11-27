// One tooltip for the whole app, for a mouse, a keyboard and a finger.
//
// The app explains its controls in `title` attributes. A browser shows a
// title only on mouse hover, late, and wherever the system puts it; on a
// phone (no hover) it never shows at all, so what the cache clock or the
// context meter meant could not be read there. This module takes over every
// `title` (and `data-tip`) without touching the components:
//
// - mouse: the tip shows after a short rest on the element, beside it;
// - keyboard: it shows while the element has a visible focus;
// - touch: a long press shows it (the tap that ends the press does not
//   also click), and elements marked `data-tip-tap` show it on a plain tap
//   (for controls whose only job is to explain, such as the cache clock).
//
// The tip is placed above the element, or below when there is no room
// (beside it, on its right, where the element asks: data-tip-place),
// and kept inside the visible part of the screen: the visual viewport, so
// on iOS it stays above the on-screen keyboard. Escape, a scroll or a tap
// elsewhere closes it. The native title is moved to data-tip on first
// contact so the browser's own tooltip does not show as well.

import { keyLabel } from './keys'

const DELAY = 450 // ms of hover before the tip shows (the system's is longer)
const PRESS = 450 // ms of press before it shows on touch
const GAP = 6 // px between the element and the tip (shadcn's Tooltip sits this close)
const EDGE = 8 // px kept clear of the screen's edges

let tip: HTMLDivElement | null = null
let anchor: Element | null = null
let timer = 0
let swallowClick = false
let clicked: HTMLElement | null = null // pressed with the mouse: its tip waits for the pointer to leave
let pressStart: { x: number; y: number } | null = null

const tipped = (t: EventTarget | null): HTMLElement | null =>
  t instanceof Element ? (t.closest('[title], [data-tip]') as HTMLElement | null) : null

// textOf moves a native title into data-tip (once), so only ours shows,
// and keeps the element's accessible name if the title was all it had.
function textOf(el: HTMLElement): string {
  const t = el.getAttribute('title')
  if (t !== null) {
    el.removeAttribute('title')
    if (t) {
      el.dataset.tip = t
      if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', t)
    }
  }
  return el.dataset.tip ?? ''
}

// iconOnly: the app's rule for tips. A tip names a control that shows no
// words of its own (an icon button), in a word or three; a row or a button
// that reads its name aloud already needs none. Elements marked
// data-tip-tap (the cache clock, a cut-off cell) explain themselves on a
// tap and keep theirs.
function iconOnly(el: HTMLElement): boolean {
  if (el.hasAttribute('data-tip-tap')) return true
  // innerText: words hidden at this width (a toolbar's label) do not count.
  return !el.innerText?.trim() || el.matches('.meter')
}

function show(el: HTMLElement) {
  // A hide still pending (the focusout of the control just left, a Tab
  // away) must not close the tip this one opens.
  clearTimeout(timer)
  const text = textOf(el)
  if (!text || el.closest('select, option') || !iconOnly(el)) return
  if (!tip) {
    tip = document.createElement('div')
    // shadcn's Tooltip look (new-york TooltipContent); styles.css keeps
    // the arrow and the fade, placed by script as before.
    tip.className = 'tip max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background'
    tip.id = 'tip'
    tip.setAttribute('role', 'tooltip')
    tip.addEventListener('pointerleave', () => hideSoon())
    tip.addEventListener('pointerenter', () => clearTimeout(timer))
    document.body.appendChild(tip)
  }
  tip.textContent = text
  // A shortcut (data-tip-key, keys.ts) as a muted key chip after the words.
  const key = el.dataset.tipKey
  if (key) {
    const k = document.createElement('kbd')
    k.className = 'tip-key'
    k.textContent = keyLabel(key)
    tip.append(k)
  }
  tip.dataset.open = ''
  anchor = el
  el.setAttribute('aria-describedby', 'tip')
  place()
}

// place puts the tip above the anchor, or below it, inside the visual
// viewport (which excludes the iOS keyboard), never off an edge.
function place() {
  if (!tip || !anchor) return
  const vv = window.visualViewport
  const top0 = vv?.offsetTop ?? 0
  const left0 = vv?.offsetLeft ?? 0
  const w = vv?.width ?? window.innerWidth
  const h = vv?.height ?? window.innerHeight
  tip.style.maxWidth = Math.min(300, w - 2 * EDGE) + 'px'
  tip.style.left = '0px'
  tip.style.top = '0px'
  // As wide as its longest line: a wrapped box keeps its full width,
  // which left an empty band on the right of a two-line tip.
  tip.style.width = ''
  tip.style.textWrap = ''
  const range = document.createRange()
  range.selectNodeContents(tip)
  const lines = Array.from(range.getClientRects())
  if (lines.length > 1) {
    const cs = getComputedStyle(tip)
    const inner = Math.max(...lines.map((r) => r.right)) - Math.min(...lines.map((r) => r.left))
    tip.style.width = Math.ceil(inner + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) + 'px'
    // Balanced again at the narrower width it would wrap anew; the lines
    // found at full width all fit, so plain wrapping keeps them.
    tip.style.textWrap = 'wrap'
  }
  const a = anchor.getBoundingClientRect()
  const t = tip.getBoundingClientRect()
  // data-tip-place="right" (the activity bar's icons, at the window's
  // left edge) puts it beside the element, centred on it, while it fits.
  if (anchor.getAttribute('data-tip-place') === 'right' && a.right + GAP + t.width <= left0 + w - EDGE) {
    const y = Math.min(Math.max(a.top + a.height / 2 - t.height / 2, top0 + EDGE), top0 + h - EDGE - t.height)
    tip.style.left = Math.round(a.right + GAP) + 'px'
    tip.style.top = Math.round(y) + 'px'
    tip.dataset.side = 'right'
    return
  }
  const above = a.top - GAP - t.height
  const below = a.bottom + GAP
  // data-tip-place="below" (a row under a field, whose tip would cover
  // the field) goes below while there is room there.
  const fitsBelow = below + t.height <= top0 + h - EDGE
  let y = anchor.getAttribute('data-tip-place') === 'below' && fitsBelow ? below : above >= top0 + EDGE ? above : below
  if (y + t.height > top0 + h - EDGE) y = Math.max(top0 + EDGE, top0 + h - EDGE - t.height)
  let x = a.left + a.width / 2 - t.width / 2
  x = Math.min(Math.max(x, left0 + EDGE), left0 + w - EDGE - t.width)
  tip.style.left = Math.round(x) + 'px'
  tip.style.top = Math.round(y) + 'px'
  tip.dataset.side = y < a.top ? 'above' : 'below'
}

function hide() {
  clearTimeout(timer)
  if (tip) delete tip.dataset.open
  anchor?.removeAttribute('aria-describedby')
  anchor = null
}

// hideTip takes the tip down now (a menu opening over its anchor).
export function hideTip() {
  clearTimeout(timer)
  hide()
}

function hideSoon() {
  clearTimeout(timer)
  timer = window.setTimeout(hide, 120)
}

export function startTips() {
  // Mouse: rest on an element to see its tip.
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return
    const el = tipped(e.target)
    if (el) textOf(el) // the native title must be gone before the browser's delay
    if (el && el === clicked) return // just clicked: no tip until the pointer leaves it
    if (el === anchor) return clearTimeout(timer)
    if (tip?.contains(e.target as Node)) return
    clearTimeout(timer)
    if (!el) return hideSoon()
    timer = window.setTimeout(() => show(el), anchor ? 0 : DELAY)
  })
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return
    const to = e.relatedTarget as Node | null
    if (clicked && !(to && clicked.contains(to))) clicked = null
    if (to && (anchor?.contains(to) || tip?.contains(to))) return
    if (!tipped(to)) hideSoon()
  })

  // Touch: a long press shows the tip and keeps the release from clicking;
  // data-tip-tap elements show it on a tap.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (tip?.contains(e.target as Node)) return
      const el = tipped(e.target)
      if (anchor && el !== anchor) hide()
      // A press closes a hover tip; on a tap-tip the click toggles it.
      if (e.pointerType === 'mouse') {
        clicked = el
        if (el !== anchor || !el?.hasAttribute('data-tip-tap')) hide()
        return
      }
      if (!el) return
      pressStart = { x: e.clientX, y: e.clientY }
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        swallowClick = true
        show(el)
      }, PRESS)
    },
    true,
  )
  const cancelPress = () => {
    if (!anchor) clearTimeout(timer)
    pressStart = null
  }
  document.addEventListener(
    'pointermove',
    (e) => {
      if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress()
    },
    true,
  )
  document.addEventListener('pointerup', cancelPress, true)
  document.addEventListener('pointercancel', cancelPress, true)
  document.addEventListener(
    'click',
    (e) => {
      if (swallowClick) {
        swallowClick = false
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const el = tipped(e.target)
      if (el?.hasAttribute('data-tip-tap')) {
        if (anchor === el) hide()
        else show(el)
      }
    },
    true,
  )
  // A long press on iOS otherwise opens the callout or selects the label.
  document.addEventListener('contextmenu', (e) => {
    if (anchor && tipped(e.target) === anchor) e.preventDefault()
  })

  // Keyboard: a visible focus shows the tip; Escape closes it.
  document.addEventListener('focusin', (e) => {
    const el = tipped(e.target)
    if (el && (e.target as Element).matches(':focus-visible')) show(el)
  })
  document.addEventListener('focusout', () => hideSoon())
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && anchor) hide()
  })

  // Anything that moves the page moves the anchor away.
  document.addEventListener('scroll', () => anchor && hide(), true)
  window.addEventListener('resize', () => anchor && place())
  window.visualViewport?.addEventListener('resize', () => anchor && place())
}
