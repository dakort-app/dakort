import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, assetURL, HTTPError } from './api'
import { cacheLifeMs, useConfig } from './config'
import { landed as previewLanded, liveBlocks } from './live'
import { providerOf } from './local'
import { copyText } from './clip'
import { CheckIcon, CopyIcon } from './icons'
import { Markdown } from './Markdown'
import { PromptText } from './PromptText'
import { SignIn } from './SignIn'
import { latestTitle, titles } from './thinking'
import { answer, group, promptText, resultText, toolSummary, type Item, type Part } from './rows'
import { dropPending, onCatchUp, onCollapse, setCacheLife, setContext, setLastReply, setReplyModel, setRowWindow, useStore, type Pending } from './store'
import type { Block, LiveBlock, Row } from './types'
import { append, canReveal, collapse, fromTail, hasOlder, pinIndex, prepend, reveal, type Win } from './window'

// How close to the top an idle scroll position must be to load older rows:
// two screens, so the next batch is usually in before the top is reached
// (loading only at the top threw the reader to the middle as the button
// they were reaching for moved away). And how many rows a batch has.
const nearTop = 400
const olderStep = 100
// How often, and how many times, to look for an announced row in the file.
const rowWait = 250
const rowWaitTries = 40

export function Transcript({ id }: { id: string }) {
  // The prompt-cache note is Claude's; Codex has no such clock.
  const listed = useStore((s) => s.sessions.find((x) => x.id === id)?.provider)
  const codex = providerOf(id, listed) === 'codex'
  const [win, setWin] = useState<Win | null>(null)
  const [err, setErr] = useState('')
  const winRef = useRef(win)
  winRef.current = win
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)
  const touching = useRef(false)
  const loadingOlder = useRef(false)
  const idle = useRef(0)
  // The first rendered item and where it was on screen before older rows
  // went in above it; the layout effect puts it back there. Mobile Safari
  // has no scroll anchoring, so this is done by hand.
  const anchor = useRef<{ key: string; top: number } | null>(null)
  const turn = useStore((s) => s.live.turns[id])
  const ended = useStore((s) => s.live.ended[id])

  // Catch-ups run one at a time; a request during one runs once after it.
  // Rows announced by the stream but not yet in the file (the CLI reports a
  // row before writing it) are retried for a while.
  const catching = useRef(false)
  const again = useRef(false)
  const waiting = useRef(new Set<string>())
  const tries = useRef(0)
  const retry = useRef(0)
  const failed = useRef(0) // catch-ups failed in a row
  const catchUp = async (uuid?: string) => {
    if (uuid) {
      waiting.current.add(uuid)
      tries.current = 0
    }
    if (catching.current) {
      again.current = true
      return
    }
    catching.current = true
    clearTimeout(retry.current)
    try {
      do {
        again.current = false
        const w = winRef.current
        if (!w) break
        let p
        try {
          p = await api.after(id, w.next)
        } catch (e) {
          // A new session's file does not exist until its first rows.
          if (e instanceof HTTPError && e.status === 404 && !w.rows.length) break
          throw e
        }
        setWin((cur) => (cur ? append(cur, p) : cur))
        winRef.current = winRef.current && append(winRef.current, p)
        for (const r of p.rows) waiting.current.delete(r.uuid)
      } while (again.current)
      // A failure shown before (a 502 from a proxy once stayed on screen
      // for good) is over once a catch-up goes through. (Not a failed first
      // load: there is nothing on screen to catch up.)
      if (winRef.current) setErr('')
      failed.current = 0
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e))
      // Try again by itself, later each time, in case no event comes along.
      if (failed.current < 6) {
        clearTimeout(retry.current)
        retry.current = window.setTimeout(() => catchUp(), 2000 * 2 ** failed.current++)
      }
      return
    } finally {
      catching.current = false
    }
    if (waiting.current.size) {
      if (++tries.current > rowWaitTries) waiting.current.clear()
      else retry.current = window.setTimeout(() => catchUp(), rowWait)
    }
  }

  useEffect(() => {
    let dead = false
    stick.current = true
    api
      .tail(id)
      .then((p) => {
        if (dead) return
        const w = fromTail(p)
        winRef.current = w
        setWin(w)
        catchUp() // rows appended while the page was on its way
      })
      .catch((e) => {
        if (dead) return
        if (e instanceof HTTPError && e.status === 404) {
          // Started a moment ago; its rows arrive by catch-up.
          const w = fromTail({ rows: [], atStart: true, next: 0 })
          winRef.current = w
          setWin(w)
        } else setErr(String(e instanceof Error ? e.message : e))
      })
    const off = onCatchUp(id, catchUp)
    const offCollapse = onCollapse(id, () => {
      stick.current = true
      setWin((cur) => cur && collapse(cur))
    })
    return () => {
      dead = true
      off()
      offCollapse()
      clearTimeout(retry.current)
    }
  }, [id])

  const older = async () => {
    const w = winRef.current
    if (loadingOlder.current || !w || !w.rows.length || !hasOlder(w)) return
    loadingOlder.current = true
    // Hold in place what is on screen: the first item still visible, not
    // the first in the list, which may be off screen and may grow when the
    // older rows of its own reply arrive above it.
    const top = box.current?.getBoundingClientRect().top ?? 0
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>('[data-anchor]') ?? [])
    const seen = items.find((el) => el.getBoundingClientRect().bottom > top) ?? items[0]
    anchor.current = seen ? { key: seen.dataset.anchor!, top: seen.getBoundingClientRect().top } : null
    try {
      let next = w
      if (!canReveal(next, olderStep)) {
        const p = await api.tail(id, next.rows[0].offset, olderStep)
        next = prepend(winRef.current ?? next, p)
      }
      next = reveal(next, olderStep)
      winRef.current = next
      setWin(next)
      setErr('')
    } catch (e) {
      anchor.current = null
      loadingOlder.current = false
      setErr(String(e instanceof Error ? e.message : e))
    }
  }

  const items = useMemo(() => (win ? group(win.rows) : []), [win?.rows])
  const pin = win ? pinIndex(win) : 0
  const shown = items.filter((it) => it.last >= pin)
  // A finished text's preview goes the moment the CLI reports it, but its
  // row lands later: a fetch later, or (the CLI writing it with the next
  // block) only once a long tool call after it is written. Keep each until
  // its row is in, for as long as the turn runs (a 5 s limit took it away
  // while a Write was composed, and it came back seconds later), and 5 s
  // past the turn's end. In the gap the page also shrank, and someone
  // reading higher up was snapped to the end.
  const fresh = liveBlocks(turn)
  const rows = win?.rows ?? []
  const prev = useRef<Record<number, LiveBlock>>({})
  const held = useRef<LiveBlock[]>([])
  const blocks = turn?.blocks ?? {}
  for (const [i, b] of Object.entries(prev.current)) {
    const now = blocks[Number(i)]
    if (b.kind === 'text' && b.text.trim() && !(now && now.text.startsWith(b.text))) held.current = [...held.current, b]
  }
  prev.current = blocks
  const endedAt = useRef(0)
  if (turn) endedAt.current = 0
  else if (!endedAt.current) endedAt.current = Date.now()
  held.current = held.current.filter((b) => !previewLanded([b], rows, 0) && !(endedAt.current && Date.now() - endedAt.current > 5000))
  const live = [...held.current, ...fresh]
  const [, tick] = useState(0)
  useEffect(() => {
    if (turn || !held.current.length) return
    const t = window.setTimeout(() => tick((n) => n + 1), 5100)
    return () => clearTimeout(t)
  }, [!!turn, held.current.length])

  // Prompts on their way, until their row is in the transcript: by the uuid
  // the stream echoed, or (if a gap swallowed the echo) by their text.
  const allPending = useStore((s) => s.pending)
  const pending = Object.values(allPending).filter((p) => p.session === id)
  const done = win ? pending.filter((p) => landed(p, win.rows)) : []
  useEffect(() => {
    if (done.length) dropPending(...done.map((p) => p.id))
  }, [done.map((p) => p.id).join()])
  const waitingPrompts = pending.filter((p) => !done.includes(p)).sort((a, b) => a.at - b.at)

  // The context meter reads the last assistant row's size.
  const lastRow = win?.rows[win.rows.length - 1]
  const context = win ? lastContext(win.rows) : 0
  useEffect(() => {
    if (win) setContext(id, context) // 0 after a compaction that did not record its size
  }, [id, context, !!win])
  // And the bar beside it the window of the model that wrote that row.
  const replyModel = win ? (win.rows.findLast((r) => r.role === 'assistant' && r.model && r.context)?.model ?? '') : ''
  useEffect(() => {
    if (replyModel) setReplyModel(id, replyModel)
  }, [id, replyModel])
  const rowWindow = win ? (win.rows.findLast((r) => r.window)?.window ?? 0) : 0
  useEffect(() => {
    if (rowWindow) setRowWindow(id, rowWindow)
  }, [id, rowWindow])

  // The cache clock counts from Claude's last reply.
  const lastReplyAt = win ? lastAssistantTime(win.rows) : 0
  useEffect(() => {
    if (lastReplyAt) setLastReply(id, lastReplyAt)
  }, [id, lastReplyAt])
  // And it lives as long as the replies say (the last one that wrote it).
  const life = win ? (win.rows.findLast((r) => r.cacheTtl)?.cacheTtl ?? '') : ''
  useEffect(() => {
    if (life) setCacheLife(id, life)
  }, [id, life])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const a = anchor.current
    if (a) {
      anchor.current = null
      // At the bottom (a short tail fills less than the box, so older rows
      // load at once), stay there: anchoring the first row instead let the
      // bottom drift when the rows below it changed height meanwhile.
      const same = el.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(a.key)}"]`)
      if (stick.current) el.scrollTop = el.scrollHeight
      else if (same) el.scrollTop += same.getBoundingClientRect().top - a.top
      loadingOlder.current = false
    } else if (stick.current && !touching.current) {
      // Not under a finger: moving the view while it drags fights it.
      el.scrollTop = el.scrollHeight
    }
  })

  // Heights change without a render too: the window resized, a phone
  // keyboard, a code block or image filling in late. Stay at the bottom if
  // the view was there. The box and its rows are watched; the rows change
  // with every render, so they are watched afresh after each.
  const resized = useRef<ResizeObserver | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = (resized.current ??= new ResizeObserver(() => {
      if (stick.current && !touching.current && box.current) box.current.scrollTop = box.current.scrollHeight
    }))
    ro.disconnect()
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
  })
  useEffect(() => () => resized.current?.disconnect(), [])

  const onScroll = () => {
    const el = box.current!
    // Right at the bottom: follow. Away from it only when the view moved
    // up (the person scrolled): rows growing underneath (a re-wrap, late
    // content) leave scrollTop where it was, and a scroll event in that
    // moment used to stop the following at random. "Right at" is 2 px, not
    // the old 80: within 80 the first nudge up while a reply printed still
    // counted as the bottom, and the next chunk yanked the view back down.
    // (Content shrinking clamps scrollTop to the very bottom, so it counts.)
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) stick.current = true
    else if (el.scrollTop < lastTop.current - 2) stick.current = false
    lastTop.current = el.scrollTop
    // Load older rows only once scrolling has settled: changing scrollTop
    // during an iOS momentum fling gets overridden by the fling.
    clearTimeout(idle.current)
    idle.current = window.setTimeout(() => {
      if (!touching.current && el.scrollTop < Math.max(nearTop, 2 * el.clientHeight)) older()
    }, 150)
  }

  if (err && !win) return <div className="transcript center error">{err}</div>
  if (!win) return <div className="transcript center faint">Loading…</div>
  return (
    <div
      className="transcript"
      ref={box}
      onScroll={onScroll}
      onTouchStart={() => (touching.current = true)}
      onTouchEnd={() => {
        touching.current = false
        onScroll()
      }}
    >
      {hasOlder(win) ? (
        <div className="faint small center-text older" onClick={older}>
          Loading older messages…
        </div>
      ) : (
        <div className="faint small center-text">Start of the session</div>
      )}
      {shown.map((it, i) => (
        <ItemView key={it.key} item={it} prev={shown[i - 1]} anchor={win.rows[it.last].uuid} />
      ))}
      {waitingPrompts.map((p) => (
        <div key={p.id} className="item-wrap">
          <div className="prompt pending">
            {p.images.map((u) => (
              <Thumb key={u} src={u} />
            ))}
            {p.text && <PromptText text={p.text} />}
          </div>
        </div>
      ))}
      {(turn || live.length > 0) && (
        <div className="reply live">
          {/* Thinking is a word on the status line, not a line of its own:
              its row is empty (the CLI keeps no thinking text) and shows
              nothing, so a "Thinking…" line came and went at every step. */}
          {live.map((b, i) => (b.kind === 'thinking' ? null : <Markdown key={i} text={b.text} />))}
          {turn && (
            <div className="faint small working">
              {turn.state === 'starting' ? `Starting ${codex ? 'Codex' : 'Claude'}…` : fresh.at(-1)?.kind === 'thinking' ? `${latestTitle(fresh.at(-1)!.text) ?? 'Thinking'}…` : 'Working…'}
            </div>
          )}
        </div>
      )}
      {!turn && ended?.error && <div className="notice error">{ended.error}</div>}
      {!turn && ended?.result?.signIn ? (
        <SignIn cli={codex ? 'codex' : 'claude'} />
      ) : !turn && ended?.result && !ended.result.ok && !ended.result.interrupted && (
        <div className="notice error pre-line">{ended.result.errors?.join('\n') || ended.result.reason || 'The turn failed.'}</div>
      )}
      {!turn && !waitingPrompts.length && lastRow && !codex && <IdleNote at={lastRow.time} context={context} life={life} />}
      {err && <div className="notice error">{err}</div>}
    </div>
  )
}

const landedSkew = 2 * 60_000

function landed(p: Pending, rows: Row[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (p.row && r.uuid === p.row) return true
    if (!p.row && r.role === 'user' && Date.parse(r.time) >= p.at - landedSkew && promptText(r) === p.text) return true
    if (Date.parse(r.time) < p.at - landedSkew) break
  }
  return false
}

function lastAssistantTime(rows: Row[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'assistant' && !rows[i].apiError) return Date.parse(rows[i].time) || 0
  return 0
}

// lastContext is the context as of the last reply, or, when a compaction
// came after it, the compacted size (0 if the CLI did not record one).
function lastContext(rows: Row[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].subtype === 'compact_boundary') return rows[i].postTokens ?? 0
    if (rows[i].context) return rows[i].context!
  }
  return 0
}

// Past the prompt cache's life, the next message pays to read the whole
// context in again, which on a big session is worth knowing before
// sending from a phone.
function IdleNote({ at, context, life }: { at: string; context: number; life: string }) {
  const cfg = useConfig()
  const idle = Date.now() - Date.parse(at)
  if (!(idle > cacheLifeMs(cfg, life))) return null
  const h = Math.floor(idle / 3_600_000)
  const span = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((idle % 3_600_000) / 60_000)}m`
  return (
    <div className="notice info">
      Idle {span}. The prompt cache has likely expired
      {context ? `, so the next message reads about ${tokens(context)} tokens in again.` : '.'}
    </div>
  )
}

export function tokens(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function stamp(it: Item, prev?: Item): string {
  const t = Date.parse(it.time)
  if (!t) return ''
  const p = prev ? Date.parse(prev.time) : 0
  if (p && t - p < 5 * 60_000) return ''
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// An item's key is its first row, which rows arriving below never change.
// Older rows fetched above can extend an item upward and change that, so
// the scroll anchor is its last row instead.
function ItemView({ item, prev, anchor }: { item: Item; prev?: Item; anchor: string }) {
  const when = stamp(item, prev)
  return (
    <div data-anchor={anchor} className="item-wrap">
      {when && <div className="stamp">{when}</div>}
      {item.kind === 'prompt' ? (
        <div className="prompt">
          {item.media.map((b, i) => (
            <Media key={i} block={b} />
          ))}
          {item.text && <PromptText text={item.text} />}
        </div>
      ) : item.kind === 'reply' ? (
        <div className="reply">
          {item.parts.map((p, i) => (
            <PartView key={i} part={p} />
          ))}
          <CopyReply parts={item.parts} />
        </div>
      ) : (
        <Notice item={item} />
      )}
    </div>
  )
}

function CopyReply({ parts }: { parts: Part[] }) {
  const [state, setState] = useState<'' | 'copied' | 'failed'>('')
  const text = answer(parts)
  useEffect(() => {
    if (!state) return
    const t = window.setTimeout(() => setState(''), 1500)
    return () => clearTimeout(t)
  }, [state])
  if (!text) return null
  return (
    <div className="reply-actions">
      <button
        type="button"
        className={'copy-btn' + (state ? ' ' + state : '')}
        title="Copy the answer as Markdown"
        aria-label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}
      >
        {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
        {state === 'failed' && <span>Copy failed</span>}
      </button>
    </div>
  )
}

function Notice({ item }: { item: Extract<Item, { kind: 'notice' }> }) {
  const [open, setOpen] = useState(false)
  if (item.tone === 'divider') {
    return (
      <div className="divider" onClick={() => item.detail && setOpen(!open)}>
        <span>{item.text}</span>
        {open && item.detail && <Markdown text={item.detail} />}
      </div>
    )
  }
  if (item.tone === 'output') {
    // A command's printout (/context, /usage): Markdown, in a card.
    return (
      <div className="notice output">
        <Markdown text={item.text} />
      </div>
    )
  }
  return <div className={'notice ' + item.tone}>{item.text}</div>
}

function PartView({ part }: { part: Part }) {
  switch (part.kind) {
    case 'text':
      return <Markdown text={part.text} />
    case 'thinking':
      return <Thinking text={part.text} />
    case 'tool':
      return <Tool use={part.use} result={part.result} />
    case 'media':
      return <Media block={part.block} />
  }
}

// Thinking shows when it has text (recent CLIs record most of it empty;
// those left a bare "Thought" line each, noise): a few lines in grey
// italics, the rest a tap away. A summary made of titled steps (Codex's)
// shows just the titles, and opens to the whole of it as markdown.
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const steps = useMemo(() => titles(text), [text])
  if (!text.trim()) return null
  if (steps.length && open)
    return (
      <div className="thinking open md-thinking" onClick={() => setOpen(false)}>
        <Markdown text={text} />
      </div>
    )
  return (
    <div className={'thinking' + (open ? ' open' : '')} onClick={() => setOpen(!open)} title={open ? '' : 'Show all'}>
      {steps.length ? steps.join('\n') : text}
    </div>
  )
}

// Tool calls stay one line until tapped, and their bodies are not built
// until then (some results are hundreds of KB).
function Tool({ use, result }: { use: Block; result?: Block }) {
  const [open, setOpen] = useState(false)
  const status = !result ? 'pending' : result.isError ? 'failed' : 'ok'
  return (
    <div className={'tool ' + status}>
      <div className="tool-line clickable" onClick={() => setOpen(!open)}>
        <span className="tool-dot" />
        <span className="ellipsis">{toolSummary(use)}</span>
      </div>
      {open && (
        <div className="tool-body">
          <div className="pre small">{JSON.stringify(use.input, null, 2)}</div>
          {result && <ResultBody block={result} />}
        </div>
      )}
    </div>
  )
}

const maxResult = 20_000

function ResultBody({ block }: { block: Block }) {
  const text = resultText(block)
  const media = (block.content ?? []).filter((c) => c.type === 'image' || c.type === 'document')
  return (
    <>
      {text && (
        <div className={'pre small result' + (block.isError ? ' error' : '')}>
          {text.length > maxResult ? text.slice(0, maxResult) + `\n… ${text.length - maxResult} more characters` : text}
        </div>
      )}
      {media.map((b, i) => (
        <Media key={i} block={b} />
      ))}
    </>
  )
}

// Thumb is an image as a thumbnail; a click shows it large in a popup that
// a click anywhere, or Escape, closes.
function Thumb({ src }: { src: string }) {
  const [big, setBig] = useState(false)
  useEffect(() => {
    if (!big) return
    const off = (e: KeyboardEvent) => e.key === 'Escape' && setBig(false)
    window.addEventListener('keydown', off)
    return () => window.removeEventListener('keydown', off)
  }, [big])
  return (
    <>
      <img className="thumb" src={src} alt="" loading="lazy" onClick={() => setBig(true)} />
      {big && (
        <div className="lightbox" onClick={() => setBig(false)} role="dialog" aria-label="Image">
          <img src={src} alt="" />
        </div>
      )}
    </>
  )
}

function Media({ block }: { block: Block }) {
  if (!block.asset) return <span className="faint small">[{block.type}]</span>
  if (block.type === 'image') return <Thumb src={assetURL(block.asset)} />

  return (
    <a className="small" href={assetURL(block.asset)} target="_blank" rel="noreferrer">
      PDF ({Math.round((block.size ?? 0) / 1024)} KB)
    </a>
  )
}
