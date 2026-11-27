import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { getJSON, postJSON } from './api'
import { copyText } from './clip'
import { ChevronDownIcon, CloseIcon, CopyIcon, Icon, MoreIcon, PlusIcon, TerminalIcon } from './icons'
import { keepInView, menuKeys } from './PopMenu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { menuItem, menuLabel, menuSeparator, menuShortcut, menuSurface } from '@/lib/menu'

// The terminal panel under the editor, as in VS Code: shells in the
// project's folder, as many as wanted, one tab each. The shells run in the
// server (terms.go), so they go on while the panel is hidden or the page
// reloads, and a page drawing one again gets what it printed so far; a
// restart of the server ends them. On a phone it takes the whole screen,
// with a row of the keys a phone's keyboard lacks above it (Phone keys,
// below). Loaded with the panel, not with the app.
//
// A tab's menu (a right-click or the menu key on a laptop, ⋯ or a long
// press on a phone) holds what a toolbar would: Select text, the text
// size, Close. It is the editor tabs' menu: the same look (.tab-menu) and
// keys (menuKeys).

type Term = { id: string; name: string; n: number; exited?: boolean }

// What a terminal view offers the panel: send keys to its shell, take or
// drop the focus (the phone's keyboard comes and goes with it), and what
// it shows as plain text, a line wrapped on screen joined again.
type Port = { send: (data: string) => void; focus: () => void; blur: () => void; text: () => string }

const url = (id: string, what: string) => `/api/terms/${id}/${what}`

// The text size, per device: a step at a time from the menu, within reason.
const SIZES = { min: 10, max: 20 }
const sizeKey = (phone?: boolean) => 'dakort.termFont' + (phone ? '.phone' : '')
const savedSize = (phone?: boolean) => {
  const n = Number(localStorage.getItem(sizeKey(phone)))
  return n >= SIZES.min && n <= SIZES.max ? n : phone ? 12 : 13
}

export function TerminalPanel({ folder, onHide, phone }: { folder: string; onHide: () => void; phone?: boolean }) {
  const [terms, setTerms] = useState<Term[] | null>(null)
  const [active, setActive] = useState('')
  const [err, setErr] = useState('')
  const ports = useRef(new Map<string, Port>())
  // Ctrl and Alt in the key row: held for the next key typed, then let go.
  const [mods, setMods] = useState({ ctrl: false, alt: false })
  const modsRef = useRef(mods)
  modsRef.current = mods
  const viewport = usePhoneViewport(phone)
  const [size, setSizeState] = useState(() => savedSize(phone))
  const setSize = (n: number) => {
    const v = Math.max(SIZES.min, Math.min(SIZES.max, n))
    setSizeState(v)
    localStorage.setItem(sizeKey(phone), String(v))
  }
  // The plain text of a terminal, shown to be selected (Select text).
  const [plain, setPlain] = useState<{ id: string; text: string } | null>(null)

  const open = async () => {
    try {
      const t = await postJSON<Term>('/api/terms', { folder, cols: 100, rows: 24 })
      setTerms((cur) => [...(cur ?? []), t])
      setActive(t.id)
      setErr('')
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
    }
  }
  const close = (id: string) => {
    postJSON(url(id, 'close'), {}).catch(() => {})
    const left = (terms ?? []).filter((t) => t.id !== id)
    setTerms(left)
    if (plain?.id === id) setPlain(null)
    if (id === active) setActive(left.at(-1)?.id ?? '')
    if (!left.length) onHide()
  }
  const pick = (id: string) => {
    setActive(id)
    if (plain && plain.id !== id) setPlain(null)
  }

  // The project's shells; none yet opens one.
  useEffect(() => {
    let gone = false
    getJSON<Term[]>(`/api/terms?folder=${encodeURIComponent(folder)}`)
      .then((l) => {
        if (gone) return
        setTerms(l)
        if (l.length) setActive(l.at(-1)!.id)
        else open()
      })
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
    return () => {
      gone = true
    }
  }, [folder])

  // Ctrl and Alt from the row on what is typed next: a letter after Ctrl
  // becomes its control code (Ctrl then c is ^C, \x03), Alt puts Escape
  // before it (as a terminal's Meta does), and both let go.
  const modded = (d: string) => {
    const { ctrl, alt } = modsRef.current
    if (!ctrl && !alt) return d
    setMods({ ctrl: false, alt: false })
    if (ctrl) {
      const c = d.length === 1 ? d.toLowerCase().charCodeAt(0) : 0
      if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96)
      else if (d === '[') d = '\x1b'
      else if (d === ' ') d = '\x00'
    }
    return alt ? '\x1b' + d : d
  }

  // A key from the row goes to the shown shell, and the focus back to it.
  const key = (data: string) => {
    const p = ports.current.get(active)
    if (!p) return
    p.send(modded(data))
    p.focus()
  }

  // The tab menu: by the tab (or the ⋯ that opened it), inside the window.
  // Opened from the keyboard, the focus goes to its first row; Escape,
  // Tab or a pick give it back to the tab.
  const [menu, setMenu] = useState<{ id: string; at: DOMRect; key?: boolean } | null>(null)
  const menuEl = useRef<HTMLDivElement | null>(null)
  const press = useRef(0)
  const rows = () => Array.from(menuEl.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
  const openMenu = (id: string, el: Element, key = false) => {
    clearTimeout(press.current)
    setMenu({ id, at: el.getBoundingClientRect(), key })
  }
  const closeMenu = () => {
    const id = menu?.id
    const inside = !!menuEl.current?.contains(document.activeElement)
    setMenu(null)
    if (inside && id)
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (!a || a === document.body) document.querySelector<HTMLElement>(`[data-term="${CSS.escape(id)}"]`)?.focus()
      })
  }
  useEffect(() => {
    if (!menu) return
    if (menu.key) rows()[0]?.focus()
    const off = (e: Event) => !(e.target as HTMLElement).closest?.('.term-menu') && setMenu(null)
    // With the focus outside it (a right-click leaves it in the shell):
    // Escape closes it, the arrows go into it.
    const keys = (e: KeyboardEvent) => {
      if (menuEl.current?.contains(document.activeElement)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMenu(null)
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        const r = rows()
        r[e.key === 'ArrowDown' || e.key === 'Home' ? 0 : r.length - 1]?.focus()
      }
    }
    addEventListener('pointerdown', off, true)
    addEventListener('blur', off)
    addEventListener('keydown', keys, true)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('blur', off)
      removeEventListener('keydown', keys, true)
    }
  }, [menu])

  const list = terms ?? []
  const place = (id: string) => list.findIndex((t) => t.id === id) + 1
  const tabKeys = (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
    if (e.target !== e.currentTarget) return
    // Arrows move along the row; Enter or Space shows the tab, Delete
    // closes it, the menu key opens its menu.
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = (e.key === 'ArrowRight' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null
      next?.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(id)
    } else if (e.key === 'Delete') close(id)
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      openMenu(id, e.currentTarget, true)
    }
  }

  const showPlain = (id: string) => {
    const text = ports.current.get(id)?.text() ?? ''
    pick(id)
    setPlain({ id, text })
  }

  return (
    <section className={'term-panel' + (phone ? ' phone' : '')} aria-label="Terminal" style={viewport}>
      <div className="tabs-row term-head many">
        {phone && (
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={onHide} aria-label="Hide the terminal" title="Back">
            <Icon name="chevron-left" />
          </Button>
        )}
        {/* A tab is the terminal mark and its place in the row (1, 2, 3),
            renumbered when one closes; the shell's name is in the tooltip. */}
        <nav className="tabs term-tabs" role="tablist" aria-label="Terminals">
          {list.map((t, i) => (
            <div
              key={t.id}
              className={'tab term-tab' + (t.id === active ? ' active' : '')}
              role="tab"
              aria-selected={t.id === active}
              aria-label={`Terminal ${i + 1}`}
              aria-keyshortcuts="Delete"
              tabIndex={t.id === active ? 0 : -1}
              data-term={t.id}
              onClick={() => pick(t.id)}
              onKeyDown={(e) => tabKeys(e, t.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(t.id, e.currentTarget)
              }}
              // A touch screen: a long press opens the menu, as on the editor's tabs.
              onTouchStart={(e) => {
                const el = e.currentTarget
                press.current = window.setTimeout(() => openMenu(t.id, el), 500)
              }}
              onTouchEnd={() => clearTimeout(press.current)}
              onTouchMove={() => clearTimeout(press.current)}
              title={(t.exited ? 'The shell has ended' : t.name) + (phone ? '' : ' (right-click for more)')}
            >
              <TerminalIcon sm />
              <span className={t.exited ? 'faint' : ''}>{i + 1}</span>
              <button
                className="tab-x"
                aria-label={`Close terminal ${i + 1}`}
                title="Close shell"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  close(t.id)
                }}
              >
                <CloseIcon sm />
              </button>
            </div>
          ))}
        </nav>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={open} aria-label="New terminal" title="New terminal">
          <PlusIcon />
        </Button>
        {phone ? (
          <Button variant="ghost" size="icon-sm"
            className={cn('text-muted-foreground hover:text-foreground', (menu) && 'open')}
            onClick={(e) => (menu ? setMenu(null) : active && openMenu(active, e.currentTarget))}
            aria-label="Terminal menu"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            title="More"
          >
            <MoreIcon />
          </Button>
        ) : (
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={onHide} aria-label="Hide the terminal" title="Hide">
            <ChevronDownIcon />
          </Button>
        )}
      </div>
      {err && <div className="error small pad">{err}</div>}
      <div className="term-body">
        {list.map((t) => (
          <TermView
            key={t.id}
            folder={folder}
            term={t}
            shown={t.id === active && plain?.id !== t.id}
            fontSize={size}
            port={(p) => (p ? ports.current.set(t.id, p) : ports.current.delete(t.id))}
            filter={modded}
            onExit={() => setTerms((cur) => cur?.map((x) => (x.id === t.id ? { ...x, exited: true } : x)) ?? cur)}
          />
        ))}
        {plain && plain.id === active && (
          <PlainText
            text={plain.text}
            phone={phone}
            onDone={() => {
              setPlain(null)
              if (!phone) requestAnimationFrame(() => ports.current.get(active)?.focus())
            }}
          />
        )}
      </div>
      {phone && (
        <PhoneKeys
          mods={mods}
          onMod={(m) => {
            setMods({ ...mods, [m]: !mods[m] })
            ports.current.get(active)?.focus()
          }}
          onKey={key}
          onPaste={async () => {
            try {
              const text = await navigator.clipboard.readText()
              if (text) key(text)
            } catch (e) {
              setErr('Could not paste: ' + (e instanceof Error ? e.message : String(e)))
            }
          }}
          onHideKeyboard={() => {
            ports.current.get(active)?.blur()
            ;(document.activeElement as HTMLElement | null)?.blur?.()
          }}
        />
      )}
      {menu &&
        (() => {
          const n = place(menu.id)
          const t = list.find((x) => x.id === menu.id)
          if (!t) return null
          // Under the tab, or over it when there is no room below; never
          // past an edge of the window. From the ⋯ at the row's end, it
          // ends at the button's right.
          const w = Math.min(phone ? 280 : 240, innerWidth - 16)
          const left = Math.max(8, Math.min(menu.at.left, innerWidth - w - 8))
          const where = menu.at.bottom + 200 < innerHeight ? { top: menu.at.bottom + 4 } : { bottom: innerHeight - menu.at.top + 4 }
          return (
            <div
              className={cn('tab-menu term-menu', menuSurface, 'fixed z-30 flex min-w-48 flex-col slide-in-from-top-2')}
              role="menu"
              aria-label={`Terminal ${n}`}
              ref={(el) => {
                menuEl.current = el
                keepInView(el)
              }}
              style={{ left, width: w, ...where }}
              onKeyDown={(e) =>
                menuKeys(e, rows(), closeMenu, () => {
                  e.preventDefault()
                  closeMenu()
                })
              }
            >
              <div className={cn('menu-title', menuLabel)} aria-hidden="true">
                Terminal {n} · {t.name}
              </div>
              <button className={menuItem} role="menuitem" tabIndex={-1} onClick={() => (closeMenu(), showPlain(menu.id))}>
                <Icon name="text-select" />
                <span className="grow">Select text</span>
              </button>
              {/* The size steps in place: the menu stays open to step again. */}
              <div className="term-size flex items-center gap-2 py-0.5 pl-2 text-sm [&>svg]:size-4 [&>svg]:text-muted-foreground" role="group" aria-label="Text size">
                <Icon name="type" />
                <span className="grow whitespace-nowrap">Text size</span>
                <button className={cn(menuItem, 'w-auto')} role="menuitem" tabIndex={-1} aria-label="Smaller text" title="Smaller text" disabled={size <= SIZES.min} onClick={() => setSize(size - 1)}>
                  <Icon name="minus" />
                </button>
                <span className="term-size-n" aria-live="polite">
                  {size}
                </span>
                <button className={cn(menuItem, 'w-auto')} role="menuitem" tabIndex={-1} aria-label="Larger text" title="Larger text" disabled={size >= SIZES.max} onClick={() => setSize(size + 1)}>
                  <Icon name="plus" />
                </button>
              </div>
              <div role="separator" className={menuSeparator} />
              <button className={menuItem} role="menuitem" tabIndex={-1} onClick={() => (closeMenu(), close(menu.id))}>
                <CloseIcon />
                <span className="grow">Close</span>
                <kbd className={menuShortcut} aria-hidden="true">
                  Del
                </kbd>
              </button>
            </div>
          )
        })()}
    </section>
  )
}

// Select text: what the terminal shows as plain text, over it, where the
// page's own selection works (a long press and the handles on a phone,
// where the terminal's drawn text cannot be selected). Copy all, Done or
// Escape go back.
function PlainText({ text, phone, onDone }: { text: string; phone?: boolean; onDone: () => void }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const el = pre.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    if (!phone) el.focus({ preventScroll: true })
  }, [])
  return (
    <div
      className="term-plain"
      role="region"
      aria-label="The terminal's text"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onDone()
        }
      }}
    >
      <pre ref={pre} tabIndex={0}>
        {text}
      </pre>
      <div className="term-plain-bar">
        <Button
 variant="outline" size="sm"
          onClick={() =>
            copyText(text).then((ok) => {
              setCopied(ok)
              if (ok) setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          <CopyIcon /> {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button variant="default" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

// Phone keys: the ones a phone's keyboard lacks or hides two pages deep,
// in a row that scrolls sideways (faded where it is cut), with the key
// that puts the keyboard away pinned at its end. A key keeps the focus in
// the terminal, so the keyboard stays up. Paste shows where the page may
// read the clipboard (https or this machine); elsewhere the browser's own
// paste works in the terminal.
type Key = { label: string; data: string; name: string; icon?: 'arrow-left' | 'arrow-up' | 'arrow-down' | 'arrow-right'; sym?: boolean }
const PHONE_KEYS: (Key | 'ctrl' | 'alt')[] = [
  { label: 'Esc', data: '\x1b', name: 'Escape' },
  { label: 'Tab', data: '\t', name: 'Tab' },
  'ctrl',
  'alt',
  { label: '←', data: '\x1b[D', name: 'Left', icon: 'arrow-left' },
  { label: '↑', data: '\x1b[A', name: 'Up', icon: 'arrow-up' },
  { label: '↓', data: '\x1b[B', name: 'Down', icon: 'arrow-down' },
  { label: '→', data: '\x1b[C', name: 'Right', icon: 'arrow-right' },
  { label: '|', data: '|', name: 'Pipe', sym: true },
  { label: '~', data: '~', name: 'Tilde', sym: true },
  { label: '/', data: '/', name: 'Slash', sym: true },
  { label: '-', data: '-', name: 'Dash', sym: true },
]

type KeysProps = {
  mods: { ctrl: boolean; alt: boolean }
  onMod: (m: 'ctrl' | 'alt') => void
  onKey: (data: string) => void
  onPaste: () => void
  onHideKeyboard: () => void
}

function PhoneKeys({ mods, onMod, onKey, onPaste, onHideKeyboard }: KeysProps) {
  const row = useRef<HTMLDivElement>(null)
  const canPaste = typeof window !== 'undefined' && window.isSecureContext && !!navigator.clipboard?.readText
  // The fade sits on whichever edge cuts a key.
  const edges = () => {
    const el = row.current
    if (!el) return
    el.toggleAttribute('data-more-left', el.scrollLeft > 1)
    el.toggleAttribute('data-more-right', el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }
  useEffect(() => {
    edges()
    const ro = new ResizeObserver(edges)
    if (row.current) ro.observe(row.current)
    return () => ro.disconnect()
  }, [])
  const keep = (e: { preventDefault: () => void }) => e.preventDefault() // the focus stays in the terminal
  return (
    <div className="term-keys" role="toolbar" aria-label="Keys">
      <div className="term-keys-row" ref={row} onScroll={edges}>
        {PHONE_KEYS.map((k) =>
          k === 'ctrl' || k === 'alt' ? (
            <button key={k} className={'term-key' + (mods[k] ? ' on' : '')} aria-label={k === 'ctrl' ? 'Ctrl' : 'Alt'} aria-pressed={mods[k]} onPointerDown={keep} onClick={() => onMod(k)}>
              {k === 'ctrl' ? 'Ctrl' : 'Alt'}
            </button>
          ) : (
            <button key={k.name} className={'term-key' + (k.icon ? ' arrow' : k.sym ? ' sym' : '')} aria-label={k.name} onPointerDown={keep} onClick={() => onKey(k.data)}>
              {k.icon ? <Icon name={k.icon} /> : k.label}
            </button>
          ),
        )}
        {canPaste && (
          <button className="term-key" aria-label="Paste" onPointerDown={keep} onClick={onPaste}>
            <Icon name="clipboard" /> Paste
          </button>
        )}
      </div>
      <button className="term-key arrow term-key-hide" aria-label="Hide the keyboard" title="Hide keyboard" onPointerDown={keep} onClick={onHideKeyboard}>
        <Icon name="keyboard-off" />
      </button>
    </div>
  )
}

// On a phone the panel fills what the keyboard leaves of the screen, so
// the key row sits just above it: iOS shrinks the visual viewport for the
// keyboard, not the page, and a fixed box would end behind the keyboard.
function usePhoneViewport(phone?: boolean) {
  const [box, setBox] = useState<{ top: number; height: number } | undefined>()
  useEffect(() => {
    const vv = window.visualViewport
    if (!phone || !vv) return
    const fit = () => setBox({ top: vv.offsetTop, height: vv.height })
    fit()
    vv.addEventListener('resize', fit)
    vv.addEventListener('scroll', fit)
    return () => {
      vv.removeEventListener('resize', fit)
      vv.removeEventListener('scroll', fit)
    }
  }, [phone])
  return box
}

// The 16 colours programs pick from, from the page's own colours, so the
// terminal follows the theme as the rest of the page does (light is read
// outdoors on a phone, where a dark slab is the hardest thing to read).
// Each is a colour the page already uses for text and passes 4.5:1 on the
// panel: green the done colour, red the error, yellow the warning, blue
// the accent, magenta and cyan the code's keyword and number colours, the
// bright ones the code's string, type and function colours where there is
// a step brighter. White is the second text colour (a light page has no
// light text that reads) and bright white the text itself. Black is the
// text on a light page and a dark grey on a dark one, where programs use
// it as a background; as text there the minimum contrast lifts it.
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string) => css.getPropertyValue(n).trim()
  const dark = document.documentElement.dataset.theme === 'dark'
  return {
    black: dark ? v('--line') : v('--text'),
    red: v('--err'),
    green: v('--ok'),
    yellow: v('--warn'),
    blue: v('--unread'),
    magenta: v('--syn-kw'),
    cyan: v('--syn-num'),
    white: v('--text-2'),
    brightBlack: v('--faint'),
    brightRed: v('--err'),
    brightGreen: v('--syn-str'),
    brightYellow: v('--syn-type'),
    brightBlue: v('--syn-fn'),
    brightMagenta: v('--syn-kw'),
    brightCyan: v('--syn-num'),
    brightWhite: v('--text'),
    background: v('--panel'),
    foreground: v('--text'),
    cursor: v('--text'),
    cursorAccent: v('--panel'),
    selectionBackground: v('--accent-soft'),
    selectionInactiveBackground: v('--hover'),
    scrollbarSliderBackground: v('--scroll-thumb'),
    scrollbarSliderHoverBackground: v('--scroll-thumb-hover'),
    scrollbarSliderActiveBackground: v('--scroll-thumb-hover'),
  }
}

// Rows 20 px apart at 13 px, as code is set elsewhere on the page (the
// factor is on the font's own height, 15 px at 13 px).
const LINE_HEIGHT = 1.34

type ViewProps = {
  folder: string
  term: Term
  shown: boolean
  fontSize: number
  port: (p: Port | null) => void
  filter: (typed: string) => string
  onExit: () => void
}

function TermView({ folder, term, shown, fontSize, port, filter, onExit }: ViewProps) {
  const box = useRef<HTMLDivElement>(null)
  const xt = useRef<{ x: XTerm; fit: FitAddon; refit: () => void } | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    const css = getComputedStyle(document.documentElement)
    const x = new XTerm({
      fontFamily: css.getPropertyValue('--mono').trim() || 'monospace',
      fontSize,
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme(),
      // Bold stays in its own colour (the bright set is another colour
      // here, not a lighter one).
      drawBoldTextInBrightColors: false,
      // A colour too faint on this background (a program's own 256 or
      // true colours, black on the dark page) is darkened or lightened
      // until it reads, as VS Code does.
      minimumContrastRatio: 4.5,
      allowProposedApi: false,
      // The scrollbar 8 px wide, not 14: it is drawn over the text's last
      // column while it shows (scrolling, or under the pointer).
      overviewRuler: { width: 8 },
    })
    const fit = new FitAddon()
    x.loadAddon(fit)
    x.open(box.current!)
    const themed = new MutationObserver(() => (x.options.theme = theme()))
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // What is typed goes in order, one request at a time, the rest
    // gathered meanwhile (a paste, fast typing).
    let pending = ''
    let sending = false
    const send = async () => {
      if (sending || !pending) return
      sending = true
      const data = pending
      pending = ''
      try {
        await postJSON(url(term.id, 'in'), { data })
      } catch {
        // the shell ended; its tab says so
      }
      sending = false
      send()
    }
    const typed = x.onData((d) => {
      pending += filterRef.current(d)
      send()
    })
    port({
      send: (d) => {
        pending += d
        send()
      },
      focus: () => x.focus(),
      blur: () => x.blur(),
      text: () => plainText(x),
    })

    // Size: fit to the box, tell the shell (after the box settles).
    let last = ''
    let timer = 0
    const resize = () => {
      if (!box.current?.offsetParent) return // hidden
      try {
        fit.fit()
      } catch {
        return
      }
      const now = `${x.cols}x${x.rows}`
      if (now === last) return
      last = now
      clearTimeout(timer)
      timer = window.setTimeout(() => postJSON(url(term.id, 'resize'), { cols: x.cols, rows: x.rows }).catch(() => {}), 80)
    }
    xt.current = { x, fit, refit: resize }
    const ro = new ResizeObserver(resize)
    ro.observe(box.current!)
    resize()

    // The output: what was kept, then live. The stream ends with the
    // shell, or when the connection drops (a sleep, the server going
    // away); the list says which, and a dropped one is read again from the
    // start, redrawn. A server that restarted no longer has the shell.
    const stop = new AbortController()
    const read = async () => {
      for (let tries = 0; !stop.signal.aborted; tries++) {
        let ended = false
        try {
          const r = await fetch(url(term.id, 'out'), { signal: stop.signal, cache: 'no-store' })
          if (r.status === 404 || r.status === 401) ended = true
          else if (r.ok && r.body) {
            x.reset()
            const rd = r.body.getReader()
            for (;;) {
              const { value, done } = await rd.read()
              if (done) break
              x.write(value)
              tries = 0
            }
            const l = await getJSON<Term[]>(`/api/terms?folder=${encodeURIComponent(folder)}`)
            const me = l.find((t) => t.id === term.id)
            ended = !me || !!me.exited
          }
        } catch {
          if (stop.signal.aborted) return
        }
        if (ended) {
          x.write('\r\n\x1b[2m[the shell has ended]\x1b[0m\r\n')
          onExit()
          return
        }
        await new Promise((res) => setTimeout(res, Math.min(5000, 500 * (tries + 1))))
      }
    }
    read()

    return () => {
      stop.abort()
      ro.disconnect()
      themed.disconnect()
      typed.dispose()
      port(null)
      clearTimeout(timer)
      x.dispose()
      xt.current = null
    }
  }, [term.id])

  // A new text size: the cells change, so the rows and columns do too.
  useEffect(() => {
    const t = xt.current
    if (!t || t.x.options.fontSize === fontSize) return
    t.x.options.fontSize = fontSize
    t.refit()
  }, [fontSize])

  // Shown again: fit to the box (it had none while hidden) and take the keys.
  useEffect(() => {
    if (!shown || !xt.current) return
    const { x, fit } = xt.current
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        // not laid out yet
      }
      postJSON(url(term.id, 'resize'), { cols: x.cols, rows: x.rows }).catch(() => {})
      x.focus()
    })
  }, [shown])

  return <div ref={box} className="term-view" style={{ display: shown ? undefined : 'none' }} />
}

// plainText is what the terminal holds, scrollback and screen, as text: a
// line the screen wrapped is joined to the one before it, and the empty
// rows under the last line are left off.
function plainText(x: XTerm): string {
  const b = x.buffer.active
  const lines: string[] = []
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i)
    if (!line) continue
    // A row that runs on into the next keeps its trailing spaces.
    const s = line.translateToString(!b.getLine(i + 1)?.isWrapped)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += s
    else lines.push(s)
  }
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  return lines.join('\n')
}
