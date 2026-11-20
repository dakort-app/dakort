import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

// PopMenu is a menu the app draws instead of a native select: a chip that
// opens a panel above it (the model picker's look). A tap outside, Escape
// or Tab closes it; the arrows move between its rows (anything marked
// data-item), Enter or Space picks, Home and End jump; the focus goes back
// to the chip on close. On a phone the panel spans the screen above the
// composer (styles.css).

type Props = {
  chip: ReactNode
  label: string // what the chip is for, for screen readers
  title?: string
  className?: string // on the wrapper, e.g. "model-menu"
  onOpen?: () => void // just before the panel shows
  children: ReactNode | ((close: () => void) => ReactNode)
}

export function PopMenu({ chip, label, title, className, onOpen, children }: Props) {
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

  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    // Escape wherever the focus is (Safari does not focus a tapped button).
    // Inside the menu its own handler takes it and puts the focus back.
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || wrap.current?.contains(e.target as Node)) return
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

  const onPanelKey = (e: KeyboardEvent) => {
    const rows = items()
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
        close()
        break
      case 'Tab':
        setOpen(false)
        return // the focus moves on as usual
      default:
        return
    }
    // Handled here: not the page's (Escape would stop the turn, Space scroll).
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <span className={'picker' + (className ? ' ' + className : '')} ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={'chip-btn' + (open ? ' open' : '')}
        title={open ? undefined : title}
        aria-label={label}
        aria-haspopup="true"
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
      {open && (
        <div id={id} ref={panel} className="picker-panel" onKeyDown={onPanelKey}>
          {typeof children === 'function' ? children(() => close()) : children}
        </div>
      )}
    </span>
  )
}

// MenuOption is a row of a single choice: its name, a line under it, and a
// check when it is the one in use.
type OptionProps = { on: boolean; label: ReactNode; desc?: ReactNode; title?: string; onPick: () => void }
export function MenuOption({ on, label, desc, title, onPick }: OptionProps) {
  return (
    <div role="option" aria-selected={on} tabIndex={-1} data-item title={title} className={'picker-row' + (on ? ' on' : '')} onClick={onPick}>
      <div className="grow">
        <div>{label}</div>
        {desc ? <div className="faint small">{desc}</div> : null}
      </div>
      {on && <span className="check">✓</span>}
    </div>
  )
}

// MenuSwitch is a row that is one on/off switch: the whole row takes the
// tap, and it reads as a switch. Its name, a short caption under it on one
// line, and the full explanation in the tooltip.
type SwitchProps = { on: boolean; label: string; caption: string; title?: string; onToggle: () => void }
export function MenuSwitch({ on, label, caption, title, onToggle }: SwitchProps) {
  return (
    <div
      className="picker-row static picker-switch"
      role="switch"
      aria-checked={on}
      aria-label={label}
      tabIndex={-1}
      data-item
      title={title}
      onClick={onToggle}
    >
      <RowText label={label} caption={caption} />
      <span className={'switch' + (on ? ' on' : '')} aria-hidden="true" />
    </div>
  )
}

// RowText is a setting's name, and under it a short caption on one line.
export function RowText({ label, caption }: { label: string; caption: string }) {
  return (
    <div className="grow row-text">
      <div className="row-label">{label}</div>
      <div className="row-caption">{caption}</div>
    </div>
  )
}
