// modal.ts makes every sheet a proper dialog for the keyboard and for a
// screen reader, without touching each one: when a sheet (a .sheet with
// role="dialog" inside its .sheet-back) appears, it is marked aria-modal,
// the focus moves into it (unless something inside already has it), Tab
// and Shift+Tab stay inside it, Escape closes it the way a tap on the dim
// page does, and when it goes the focus returns to what opened it. The
// sheets' own markup and closing logic are unchanged.

const focusable =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

type Open = { sheet: HTMLElement; back: HTMLElement; opener: Element | null }
const open: Open[] = []

const visible = (el: HTMLElement) => el.offsetParent !== null || el === document.activeElement

// The last thing focused outside every sheet: a sheet that focuses a field
// of its own as it mounts has taken the focus before it is seen here, and
// one that replaced another (Browse from Open project) finds the focus on
// the page, so the focus at that moment is not what opened it.
let outside: Element | null = null

function take(back: HTMLElement) {
  const sheet = back.querySelector<HTMLElement>(':scope > .sheet[role="dialog"]')
  if (!sheet || open.some((o) => o.sheet === sheet)) return
  sheet.setAttribute('aria-modal', 'true')
  const at = document.activeElement
  open.push({ sheet, back, opener: at && at !== document.body && !sheet.contains(at) ? at : outside })
  // After the sheet's own effects (a field it focuses itself, autoFocus).
  requestAnimationFrame(() => {
    if (!sheet.isConnected || sheet.contains(document.activeElement)) return
    const first = Array.from(sheet.querySelectorAll<HTMLElement>(focusable)).find(visible)
    ;(first ?? sheet).focus({ preventScroll: true })
    if (!first && !sheet.hasAttribute('tabindex')) sheet.tabIndex = -1
  })
}

function release() {
  for (let i = open.length - 1; i >= 0; i--) {
    const o = open[i]
    if (o.sheet.isConnected) continue
    open.splice(i, 1)
    // What opened it, or (a sheet opened from a sheet now gone, as Browse
    // from Open project) the last thing focused outside the sheets.
    const back = o.opener?.isConnected ? o.opener : outside
    if (back instanceof HTMLElement && back.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus({ preventScroll: true })
  }
}

export function startModal() {
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof Element && !e.target.closest('.sheet-back')) outside = e.target
  })
  new MutationObserver(() => {
    document.querySelectorAll<HTMLElement>('.sheet-back').forEach(take)
    release()
  }).observe(document.body, { childList: true, subtree: true })

  document.addEventListener('keydown', (e) => {
    const top = open[open.length - 1]
    if (!top || !top.sheet.isConnected) return
    if (e.key === 'Escape' && !e.defaultPrevented) {
      // A menu open inside the sheet, or opened from it (a portalled menu,
      // as Browse's sort), closes first (it handles its own).
      if (top.sheet.querySelector('[role="menu"], [role="listbox"]') || document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]')) return
      e.preventDefault()
      top.back.click() // the dim page's own close
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(top.sheet.querySelectorAll<HTMLElement>(focusable)).filter(visible)
    if (!items.length) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const at = document.activeElement
    if (!top.sheet.contains(at)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && at === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  })
}
