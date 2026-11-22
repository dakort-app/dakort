import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { getJSON, postJSON } from './api'
import { ChevronDownIcon, PlusIcon, TerminalIcon } from './icons'

// The terminal panel under the editor, as in VS Code: shells in the
// project's folder, as many as wanted, one tab each. The shells run in the
// server (terms.go), so they go on while the panel is hidden or the page
// reloads, and a page drawing one again gets what it printed so far; a
// restart of the server ends them. On a phone it takes the whole screen,
// with a row of the keys a phone's keyboard lacks above it (Phone keys,
// below). Loaded with the panel, not with the app.

type Term = { id: string; name: string; n: number; exited?: boolean }

// What a terminal view offers the panel: send keys to its shell, take the
// focus (so the phone's keyboard stays up after a key in the row).
type Port = { send: (data: string) => void; focus: () => void }

const url = (id: string, what: string) => `/api/terms/${id}/${what}`

export function TerminalPanel({ folder, onHide, phone }: { folder: string; onHide: () => void; phone?: boolean }) {
  const [terms, setTerms] = useState<Term[] | null>(null)
  const [active, setActive] = useState('')
  const [err, setErr] = useState('')
  const ports = useRef(new Map<string, Port>())
  // Ctrl in the key row: held for the next key typed, then let go.
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl
  const viewport = usePhoneViewport(phone)

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
    if (id === active) setActive(left.at(-1)?.id ?? '')
    if (!left.length) onHide()
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

  // A key from the row goes to the shown shell, and the focus back to it.
  const key = (data: string) => {
    const p = ports.current.get(active)
    if (!p) return
    p.send(data)
    p.focus()
  }

  return (
    <section className={'term-panel' + (phone ? ' phone' : '')} aria-label="Terminal" style={viewport}>
      <div className="term-head">
        {phone && (
          <button className="icon" onClick={onHide} aria-label="Hide the terminal" title="Back; the shells go on">
            ‹
          </button>
        )}
        {/* A tab is the terminal mark and its place in the row (1, 2, 3),
            renumbered when one closes; the shell's name is in the tooltip. */}
        <nav className="term-tabs">
          {(terms ?? []).map((t, i) => (
            <div
              key={t.id}
              className={'term-tab' + (t.id === active ? ' active' : '')}
              onClick={() => setActive(t.id)}
              title={t.exited ? 'The shell has ended' : t.name}
            >
              <TerminalIcon />
              <span className={t.exited ? 'faint' : ''}>{i + 1}</span>
              <button
                className="tab-x"
                aria-label={`Close terminal ${i + 1}`}
                title="Close: ends the shell"
                onClick={(e) => {
                  e.stopPropagation()
                  close(t.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <button className="icon" onClick={open} aria-label="New terminal" title="New terminal">
          <PlusIcon />
        </button>
        {!phone && (
          <button className="icon" onClick={onHide} aria-label="Hide the terminal" title="Hide; the shells go on (Ctrl+` or the terminal button shows it again)">
            <ChevronDownIcon />
          </button>
        )}
      </div>
      {err && <div className="error small pad">{err}</div>}
      <div className="term-body">
        {(terms ?? []).map((t) => (
          <TermView
            key={t.id}
            folder={folder}
            term={t}
            shown={t.id === active}
            fontSize={phone ? 12 : 13}
            port={(p) => (p ? ports.current.set(t.id, p) : ports.current.delete(t.id))}
            // Ctrl from the row: the next letter typed becomes its control
            // code (Ctrl then c is ^C, \x03), and Ctrl lets go.
            filter={(d) => {
              if (!ctrlRef.current) return d
              setCtrl(false)
              const c = d.length === 1 ? d.toLowerCase().charCodeAt(0) : 0
              if (c >= 97 && c <= 122) return String.fromCharCode(c - 96)
              if (d === '[') return '\x1b'
              if (d === ' ') return '\x00'
              return d
            }}
            onExit={() => setTerms((cur) => cur?.map((x) => (x.id === t.id ? { ...x, exited: true } : x)) ?? cur)}
          />
        ))}
      </div>
      {phone && (
        <div className="term-keys" role="toolbar" aria-label="Keys">
          {PHONE_KEYS.map(([label, data, name], i) => [
            <button
              key={label}
              className="term-key"
              aria-label={name}
              // The focus stays in the terminal, so the keyboard stays up.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => key(data)}
            >
              {label}
            </button>,
            i === 0 && (
              <button
                key="ctrl"
                className={'term-key' + (ctrl ? ' on' : '')}
                aria-label="Ctrl"
                aria-pressed={ctrl}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  setCtrl(!ctrl)
                  ports.current.get(active)?.focus()
                }}
              >
                Ctrl
              </button>
            ),
          ])}
        </div>
      )}
    </section>
  )
}

// Phone keys: the ones a phone's keyboard lacks or hides two pages deep.
const PHONE_KEYS: [string, string, string][] = [
  ['Esc', '\x1b', 'Escape'],
  ['Tab', '\t', 'Tab'],
  ['↑', '\x1b[A', 'Up'],
  ['↓', '\x1b[B', 'Down'],
  ['←', '\x1b[D', 'Left'],
  ['→', '\x1b[C', 'Right'],
  ['|', '|', 'Pipe'],
  ['~', '~', 'Tilde'],
  ['/', '/', 'Slash'],
  ['-', '-', 'Dash'],
]

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

// The 16 colours programs pick from, as VS Code's Light+ and Dark+ themes
// have them. xterm's own set is made for a dark background, so on the
// light page a prompt's path and a typed command came out washed out.
const light = {
  black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
  brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
}
const dark = {
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
}

// The page's colours, light or dark, read again when the theme switches.
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string) => css.getPropertyValue(n).trim()
  const set = document.documentElement.dataset.theme === 'dark' ? dark : light
  return { ...set, background: v('--bg'), foreground: v('--text'), cursor: v('--text'), cursorAccent: v('--bg'), selectionBackground: v('--accent-soft') }
}

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
  const xt = useRef<{ x: XTerm; fit: FitAddon } | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    const css = getComputedStyle(document.documentElement)
    const x = new XTerm({
      fontFamily: css.getPropertyValue('--mono').trim() || 'monospace',
      fontSize,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme(),
      // A colour too faint on this background is darkened (or lightened)
      // until it reads, as VS Code does.
      minimumContrastRatio: 4.5,
      allowProposedApi: false,
    })
    const fit = new FitAddon()
    x.loadAddon(fit)
    x.open(box.current!)
    xt.current = { x, fit }
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
