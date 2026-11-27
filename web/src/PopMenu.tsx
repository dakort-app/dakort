import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { CheckIcon, CloseIcon, InfoIcon } from './icons'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { menuItem, menuSurface } from '@/lib/menu'
import { Switch } from '@/components/ui/switch'

// PopMenu is a menu the app draws instead of a native select: a chip that
// opens a panel above it (the model picker's look). A tap outside, Escape
// or Tab closes it; the arrows move between its rows (anything marked
// data-item), Enter or Space picks, Home and End jump; the focus goes back
// to the chip on close.
//
// The panel is placed by script (place) inside the visual viewport, so
// never off an edge or under the iOS keyboard: 6 px above its own chip
// (over the text being written, as Claude desktop's and Cursor's menus
// sit by their buttons; anchored to the composer's top it floated a
// tall draft's height away), as tall as the room there, or below it
// when there is more room below and the rows do not fit above; it
// scrolls inside past that. Its left edge is the chip's, or for a chip
// in the right half of its row, its right edge the chip's. On a phone it is a bottom sheet: docked to the
// bottom of the visible screen (above the keyboard when it is up), as wide
// as the screen, over a dimmed page that a tap closes it from, with a grab
// handle that a drag down closes it with.

const GAP = 6 // px between the chip and the panel
const EDGE = 8 // px kept clear of the screen's edges
const SHEET = '(max-width: 600px)'

type Props = {
  chip: ReactNode
  label: string // what the chip is for, for screen readers
  title?: string
  className?: string // on the wrapper, e.g. "model-menu"
  chipClass?: string // the chip's own look (default: chip-btn)
  sheetTitle: string // the phone sheet's header
  onOpen?: () => void // just before the panel shows
  children: ReactNode | ((close: () => void) => ReactNode)
}

export function PopMenu({ chip, label, title, className, chipClass = cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'chip-btn h-7 max-w-full min-w-0 justify-start gap-1.5 overflow-hidden px-2 font-normal pointer-coarse:h-11 [&_.agent-icon]:size-3.5!'), sheetTitle, onOpen, children }: Props) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const show = () => {
    onOpen?.()
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) btn.current?.focus({ preventScroll: true })
  }

  // place puts the panel by its anchor inside the visible screen.
  const place = () => {
    const p = panel.current
    const b = btn.current
    if (!p || !b) return
    const vv = window.visualViewport
    const top0 = vv?.offsetTop ?? 0
    const left0 = vv?.offsetLeft ?? 0
    const w = vv?.width ?? window.innerWidth
    const h = vv?.height ?? window.innerHeight
    const sheet = matchMedia(SHEET).matches
    p.toggleAttribute('data-sheet', sheet)
    const s = p.style
    p.dataset.side = 'above'
    if (sheet) {
      s.top = 'auto'
      s.bottom = document.documentElement.clientHeight - (top0 + h) + 'px'
      s.maxHeight = Math.round(h * 0.85) + 'px'
      s.left = left0 + 'px'
      s.width = w + 'px'
      return
    }
    const c = b.getBoundingClientRect()
    const a = { left: c.left, top: c.top, bottom: c.bottom }
    const room = { above: a.top - GAP - (top0 + EDGE), below: top0 + h - EDGE - (a.bottom + GAP) }
    const border = p.offsetHeight - p.clientHeight
    const up = p.scrollHeight + border <= room.above || room.above >= room.below
    if (up) {
      // From the bottom, so a page that changes height grows upwards and
      // the rows near the chip stay put.
      s.top = 'auto'
      s.bottom = document.documentElement.clientHeight - (a.top - GAP) + 'px'
    } else {
      s.bottom = 'auto'
      s.top = a.bottom + GAP + 'px'
    }
    s.maxHeight = Math.max(120, up ? room.above : room.below) + 'px'
    s.width = ''
    // From the chip's left edge, or back from its right edge for a chip in
    // the composer's right half (or one whose panel would run off the
    // screen).
    const pw = p.offsetWidth
    const row = b.closest('.composer-box')?.getBoundingClientRect()
    const right = row ? c.left + c.width / 2 > row.left + row.width / 2 : false
    const x0 = right || a.left + pw > left0 + w - EDGE ? c.right - pw : a.left
    const x = Math.min(Math.max(x0, left0 + EDGE), left0 + w - EDGE - pw)
    s.left = Math.round(x) + 'px'
    p.dataset.side = up ? 'above' : 'below'
  }
  useLayoutEffect(() => {
    if (!open) return
    place()
    const vv = window.visualViewport
    window.addEventListener('resize', place)
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      vv?.removeEventListener('resize', place)
      vv?.removeEventListener('scroll', place)
    }
  }, [open])

  // The sheet's grab bar and header: a drag down past a third of a row's
  // height closes it; less springs back.
  const drag = useRef<{ y: number; id: number } | null>(null)
  const grab = {
    onPointerDown: (e: ReactPointerEvent) => {
      if ((e.target as Element).closest('button')) return // the close button's own tap
      drag.current = { y: e.clientY, id: e.pointerId }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (drag.current?.id !== e.pointerId || !panel.current) return
      panel.current.style.transform = `translateY(${Math.max(0, e.clientY - drag.current.y)}px)`
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const d = drag.current
      drag.current = null
      if (!d || !panel.current) return
      panel.current.style.transform = ''
      if (e.clientY - d.y > 48) close(false)
    },
    onPointerCancel: () => {
      drag.current = null
      if (panel.current) panel.current.style.transform = ''
    },
  }

  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => {
      const t = e.target as Element
      // (A tap on a row's tip, which lives outside the menu, keeps it open.)
      // (Nor does one in a menu opened from inside it, Effort's: Radix
      // puts that in a portal of its own.)
      if (!wrap.current?.contains(t) && !t.closest?.('.tip, [data-radix-popper-content-wrapper]')) setOpen(false)
    }
    // Escape wherever the focus is (Safari does not focus a tapped button).
    // Inside the menu its own handler takes it and puts the focus back.
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || wrap.current?.contains(e.target as Node)) return
      if (document.querySelector('[data-slot=dropdown-menu-content][data-state=open]')) return // that menu's Escape first
      e.preventDefault() // not the running turn's stop
      setOpen(false)
    }
    document.addEventListener('pointerdown', off)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', off)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])

  // Rows in use: a part of the panel kept in place but out of use (inert,
  // as the model menu's page not on show) has none.
  const items = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-item]') ?? []).filter((r) => !r.closest('[inert]'))

  // Opened from the keyboard, the focus goes to the row in use (or the
  // first), so the arrows work at once; a tap leaves it, so a phone does
  // not scroll.
  const viaKey = useRef(false)
  useEffect(() => {
    if (!open || !viaKey.current) return
    viaKey.current = false
    const rows = items()
    // (A tab, the model menu's agent switch, is selected too: not that.)
    const on = (r: HTMLElement) => r.getAttribute('role') !== 'tab' && r.getAttribute('aria-selected') === 'true'
    ;(rows.find(on) ?? rows[0])?.focus()
  }, [open])

  // (Keys in a menu opened from inside the panel, Effort's, reach here
  // through React's portal; they are that menu's.)
  const onPanelKey = (e: KeyboardEvent) => {
    if (!panel.current?.contains(e.target as Node)) return
    menuKeys(e, items(), close, () => setOpen(false))
  }

  return (
    <span className={'picker' + (className ? ' ' + className : '')} ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={chipClass + (open ? ' open' : '')}
        title={open ? undefined : title}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) {
            viaKey.current = false
            setOpen(false)
          } else show()
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            viaKey.current = true
            show()
          } else if (e.key === 'Enter' || e.key === ' ') {
            viaKey.current = true // the click that follows opens it
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            close()
          }
        }}
      >
        {chip}
      </button>
      {/* A phone's sheet dims the page behind it (styles.css shows this
          only there); a tap on it closes the sheet and reaches nothing under it. */}
      {open && (
        <div
          className="menu-scrim"
          aria-hidden="true"
          onClick={() => close(false)}
        />
      )}
      {open && (
        <div id={id} ref={panel} className={cn(
            'picker-panel',
            menuSurface,
            'data-[sheet]:rounded-none data-[sheet]:rounded-t-xl data-[sheet]:border-x-0 data-[sheet]:border-b-0 data-[sheet]:pb-[max(env(safe-area-inset-bottom),0.75rem)] data-[sheet]:shadow-lg data-[sheet]:zoom-in-100 data-[sheet]:slide-in-from-bottom-full',
          )}
          role="dialog" aria-label={sheetTitle} onKeyDown={onPanelKey}>
          {/* A phone's sheet: the grab bar and a header with its title
              and a close button, as the app's other sheets have. */}
          <div className="menu-grab" {...grab}>
            <header className="bar">
              <b>{sheetTitle}</b>
              <span className="grow" />
              <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Close" onClick={() => close()}>
                <CloseIcon />
              </Button>
            </header>
          </div>
          {typeof children === 'function' ? children(() => close()) : children}
        </div>
      )}
    </span>
  )
}

// menuKeys is the keyboard of a menu's rows (rows): the arrows move
// between them, Home and End jump, Enter or Space picks, Escape closes it
// (escape, which puts the focus back on what opened it), Tab closes it
// (leave) and the focus moves on as usual. Shared by PopMenu and the tab
// menu.
export function menuKeys(e: KeyboardEvent, rows: HTMLElement[], escape: () => void, leave: () => void) {
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const go = (i: number) => rows[(i + rows.length) % rows.length]?.focus()
  switch (e.key) {
    case 'ArrowDown':
      go(at + 1)
      break
    case 'ArrowUp':
      go(at < 0 ? -1 : at - 1)
      break
    case 'Home':
      go(0)
      break
    case 'End':
      go(-1)
      break
    case 'Enter':
    case ' ':
      if (at < 0) return
      rows[at].click()
      break
    case 'Escape':
      escape()
      break
    case 'Tab':
      leave()
      return
    default:
      return
  }
  // Handled here: not the page's (Escape would stop the turn, Space scroll).
  e.preventDefault()
  e.stopPropagation()
}

// keepInView is the ref of a menu placed at a point (a tab's menu at the
// pointer, the More menu under its button): laid out, it moves, if it
// must, to lie inside the visual viewport, near the bottom or the right
// edge too.
export function keepInView(el: HTMLElement | null) {
  if (!el) return
  const vv = window.visualViewport
  const top0 = vv?.offsetTop ?? 0
  const left0 = vv?.offsetLeft ?? 0
  const r = el.getBoundingClientRect()
  const x = Math.min(Math.max(r.left, left0 + EDGE), left0 + (vv?.width ?? window.innerWidth) - EDGE - r.width)
  const y = Math.min(Math.max(r.top, top0 + EDGE), top0 + (vv?.height ?? window.innerHeight) - EDGE - r.height)
  if (Math.abs(x - r.left) > 0.5) el.style.left = Math.round(x) + 'px'
  if (Math.abs(y - r.top) > 0.5) el.style.top = Math.round(y) + 'px'
}

// MenuOption is a row of a single choice: its name, a short caption, and
// a check when it is the one in use. A laptop has them on one line; a
// phone puts the caption under the name.
type OptionProps = { on: boolean; label: ReactNode; desc?: ReactNode; title?: string; onPick: () => void; stacked?: boolean }
export function MenuOption({ on, label, desc, title, onPick, stacked }: OptionProps) {
  // Stacked: the name over its caption, one tidy column (Claude desktop's
  // model menu).
  if (stacked)
    return (
      <div role="option" aria-selected={on} tabIndex={-1} data-item title={title} className={cn('picker-row menu-opt stacked', menuItem, 'flex items-center gap-3 pointer-coarse:px-3', on && 'on')} onClick={onPick}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="opt-label">{label}</span>
          {desc ? <span className="opt-desc">{desc}</span> : null}
        </span>
        <span className="opt-check">{on && <CheckIcon />}</span>
      </div>
    )
  return (
    <div role="option" aria-selected={on} tabIndex={-1} data-item title={title} className={cn('picker-row menu-opt', menuItem, 'grid items-baseline', on && 'on')} onClick={onPick}>
      <span className="opt-label">{label}</span> {desc ? <span className="opt-desc">{desc}</span> : null}
      <span className="opt-check">{on && <CheckIcon />}</span>
    </div>
  )
}

// MenuSwitch is a setting that is one on/off switch: its name, a short
// caption on one line, the full explanation behind an info button (a tap
// shows it, on a phone too), and the switch. The whole row takes the tap.
type SwitchProps = { on: boolean; label: string; caption: string; info?: string; onToggle: () => void }
export function MenuSwitch({ on, label, caption, info, onToggle }: SwitchProps) {
  return (
    <div className={cn('picker-row static picker-switch', menuItem, 'pointer-coarse:px-3')} onClick={onToggle}>
      <RowText label={label} caption={caption} info={info} />
      <Switch className="switch pointer-coarse:box-content pointer-coarse:border-x-[6px] pointer-coarse:border-y-[13px] pointer-coarse:bg-clip-padding" checked={on} aria-label={label} tabIndex={-1} data-item />
    </div>
  )
}

// InfoButton shows a setting's explanation in the app's tip, on a tap as
// on a hover; the arrows reach it too, and its focus shows the tip.
export function InfoButton({ label, text }: { label: string; text: string }) {
  return (
    <button type="button" className="info-btn" aria-label={'About ' + label} data-tip={text} data-tip-tap="" tabIndex={-1} data-item onClick={(e) => e.stopPropagation()}>
      <InfoIcon sm />
    </button>
  )
}

// RowText is a setting's name, and under it a short caption on one line;
// its explanation, if it has one, is an info button after the name, so the
// row's end holds only its control.
export function RowText({ label, caption, info }: { label: string; caption: string; info?: string }) {
  return (
    <div className="grow row-text">
      <div className="row-label">
        {label}
        {info && <InfoButton label={label} text={info} />}
      </div>
      <div className="row-caption">{caption}</div>
    </div>
  )
}
