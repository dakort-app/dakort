import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, HTTPError } from './api'
import { landed as previewLanded, liveBlocks } from './live'
import { providerOf } from './local'
import { copyText } from './clip'
import { CheckIcon, CopyIcon, Icon } from './icons'
import { Markdown } from './Markdown'
import { PromptText } from './PromptText'
import { latestTitle, titles } from './thinking'
import { answer, group, landed, type Item, type Part, type TaskNews } from './rows'
import { readableError, segments } from './tools'
import { retryPrompt } from './Composer'
import { Chevron, ErrorMark, Media, ProjectRoot, Thumb, ToolRow, ToolRun } from './ToolView'
import { dropPending, onCatchUp, onCollapse, setCacheLife, setContext, setLastReply, setReplyModel, setRowWindow, useStore, type Pending } from './store'
import type { LiveBlock, Row } from './types'
import { append, canReveal, collapse, fromTail, hasOlder, pinIndex, prepend, reveal, type Win } from './window'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

// The sign-in shows only when the CLI is signed out: its own chunk.
const SignIn = lazy(() => import('./SignIn').then((m) => ({ default: m.SignIn })))

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
  const folder = useStore((s) => s.sessions.find((x) => x.id === id)?.folder) ?? ''
  const codex = providerOf(id, listed) === 'codex'
  const [win, setWin] = useState<Win | null>(null)
  const [err, setErr] = useState('')
  // Bumped by Retry on a transcript that failed to load.
  const [attempt, setAttempt] = useState(0)
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
  const anchor = useRef<{ key: string; bottom: number } | null>(null)
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
  }, [id, attempt])

  const older = async () => {
    const w = winRef.current
    if (loadingOlder.current || !w || !w.rows.length || !hasOlder(w)) return
    loadingOlder.current = true
    try {
      let next = w
      if (!canReveal(next, olderStep)) {
        const p = await api.tail(id, next.rows[0].offset, olderStep)
        next = prepend(winRef.current ?? next, p)
      }
      next = reveal(next, olderStep)
      winRef.current = next
      // Hold in place what is on screen as the rows land, not as they were
      // asked for: a scroll while the page was on its way was undone, the
      // view jumping back by that much. The first item still visible, by
      // its bottom edge: its own older rows may arrive and grow it at the
      // top. Rendered at once, so no scroll comes between the look and the
      // render.
      const top = box.current?.getBoundingClientRect().top ?? 0
      const items = Array.from(box.current?.querySelectorAll<HTMLElement>('[data-anchor]') ?? [])
      const seen = items.find((el) => el.getBoundingClientRect().bottom > top) ?? items[0]
      anchor.current = seen ? { key: seen.dataset.anchor!, bottom: seen.getBoundingClientRect().bottom } : null
      flushSync(() => setWin(next))
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
  // the stream echoed, or (if a gap swallowed the echo) by their text in a
  // row that came after the send. sent holds the last row there when each
  // was first seen.
  const allPending = useStore((s) => s.pending)
  const pending = Object.values(allPending).filter((p) => p.session === id)
  const sent = useRef<Record<string, string>>({})
  if (win) for (const p of pending) sent.current[p.id] ??= win.rows.at(-1)?.uuid ?? ''
  const done = win ? pending.filter((p) => landed(p, win.rows, sent.current[p.id])) : []
  useEffect(() => {
    if (done.length) dropPending(...done.map((p) => p.id))
  }, [done.map((p) => p.id).join()])
  const waitingPrompts = pending.filter((p) => !done.includes(p)).sort((a, b) => a.at - b.at)
  // The session ending on an error row (nothing sent since): the latest
  // turn's failure, already in words on the page.
  const lastItem = shown.at(-1)
  const lastError = !waitingPrompts.length && lastItem?.kind === 'notice' && lastItem.tone === 'error' ? lastItem : undefined
  // A turn that failed while this page watched (not one in the history)
  // can be tried again: its prompt, as text (one with images is not).
  const lastPrompt = shown.findLast((it) => it.kind === 'prompt')
  const failedHere = !!ended && (!!ended.error || (!!ended.result && !ended.result.ok && !ended.result.interrupted && !ended.result.signIn))
  const tryAgain =
    !turn && failedHere && !waitingPrompts.length && lastPrompt?.kind === 'prompt' && lastPrompt.text && !lastPrompt.media.length
      ? () => retryPrompt(id, lastPrompt.text)
      : undefined

  // The context meter reads the last assistant row's size.
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
      else if (same) el.scrollTop += same.getBoundingClientRect().bottom - a.bottom
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

  if (err && !win)
    return (
      <LoadFailed
        err={err}
        retry={() => {
          setErr('')
          setAttempt((n) => n + 1)
        }}
      />
    )
  // A prompt just sent stays on screen while its session loads (a new
  // session's first prompt went away for that moment).
  if (!win)
    return waitingPrompts.length ? (
      <div className="transcript">
        {waitingPrompts.map((p) => (
          <WaitingPrompt key={p.id} p={p} />
        ))}
      </div>
    ) : (
      <div className="transcript center faint">Loading…</div>
    )
  return (
    <ProjectRoot.Provider value={folder}>
      <div
        className="transcript"
        ref={box}
        onClick={(e) => openLink(e, folder)}
        onScroll={onScroll}
        onTouchStart={() => (touching.current = true)}
        onTouchEnd={() => {
          touching.current = false
          onScroll()
        }}
      >
        {hasOlder(win) ? (
          <button type="button" className="older" onClick={older}>
            <span className="shimmer">Loading older messages…</span>
          </button>
        ) : (
          <div className="stamp session-start">{startLine(shown[0])}</div>
        )}
        {shown.map((it, i) => (
          <ItemView
            key={it.key}
            item={it}
            prev={i ? shown[i - 1] : hasOlder(win) ? undefined : it}
            anchor={win.rows[it.last].uuid}
            end={win.rows[it.last].time}
            prevEnd={i ? win.rows[shown[i - 1].last].time : undefined}
            live={!!turn && i === shown.length - 1}
            retry={it === lastError ? tryAgain : undefined}
          />
        ))}
        {waitingPrompts.map((p) => (
          <WaitingPrompt key={p.id} p={p} />
        ))}
        {(turn || live.length > 0) && (
          <div className={'reply live' + (turn && live.length && live[live.length - 1].kind !== 'thinking' ? ' streaming' : '')}>
            {/* Thinking is a word on the status line, not a line of its own:
                its row is empty (the CLI keeps no thinking text) and shows
                nothing, so a "Thinking…" line came and went at every step. */}
            {live.map((b, i) => (b.kind === 'thinking' ? null : <Markdown key={i} text={b.text} opts={replyLinks} />))}
            {turn && (
              <div className={'working' + (turn.permissions?.length ? ' needs-you' : '')} role="status">
                {/* The turn's one running mark: its state in muted words, a
                    light passing over them (no ring, nothing in the accent). */}
                {turn.permissions?.length ? (
                  <>
                    <WarnIcon />
                    {`Waiting for you: allow ${turn.permissions[0].tool}?`}
                  </>
                ) : (
                  <span className="shimmer">
                    {turn.state === 'starting' ? `Starting ${codex ? 'Codex' : 'Claude'}…` : fresh.at(-1)?.kind === 'thinking' ? `${latestTitle(fresh.at(-1)!.text) ?? 'Thinking'}…` : 'Working…'}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {!turn && ended?.error && <ErrorNote text={ended.error} retry={tryAgain} />}
        {/* The sign-in, once: from the turn that just failed, or from the
            session's last row, which a reload still has. A failed turn whose
            error the transcript already shows says nothing more (its bare
            terminal_reason, "api_error", read as a second failure). */}
        {!turn && (ended?.result?.signIn || lastError?.signIn) ? (
          <Suspense fallback={null}>
            <SignIn cli={codex ? 'codex' : 'claude'} />
          </Suspense>
        ) : !turn && !lastError && ended?.result && !ended.result.ok && !ended.result.interrupted && (
          <ErrorNote text={ended.result.errors?.join('\n') || ended.result.text || ''} retry={tryAgain} />
        )}
        {err && (
          <div className="notice error catch-up" role="status">
            <span>Not up to date ({err}). Trying again…</span>
          </div>
        )}
      </div>
    </ProjectRoot.Provider>
  )
}

// LoadFailed is a transcript that did not load: what happened in words,
// Try again, and the server's own words under Details.
function LoadFailed({ err, retry }: { err: string; retry: () => void }) {
  const [open, setOpen] = useState(false)
  const why = /input\/output|\bEIO\b|no such file|ENOENT|permission denied|EACCES/i.test(err)
    ? "The session’s file couldn’t be read on the computer."
    : /^HTTP 5\d\d|\b50[0-9]\b/.test(err)
      ? 'The server had a problem sending it.'
      : /^HTTP 404|not found/i.test(err)
        ? 'The server has no such session.'
        : 'The server could not send it.'
  return (
    <div className="transcript center error load-failed" role="alert">
      <Icon name="circle-x" className="mark-x load-failed-mark" />
      <div className="load-failed-head">Couldn’t load this session</div>
      <div className="load-failed-why">{why}</div>
      <Button type="button" variant="default" size="sm" onClick={retry}>
        Try again
      </Button>
      <button type="button" className="details-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron />
        Details
      </button>
      {open && <pre className="raw load-failed-raw">{err}</pre>}
    </div>
  )
}

// WaitingPrompt is a prompt on its way, marked Sending until its row is in.
export function WaitingPrompt({ p }: { p: Pick<Pending, 'text' | 'images'> }) {
  return (
    <div className="item-wrap">
      <div className="prompt pending">
        {p.images.map((u) => (
          <Thumb key={u} src={u} />
        ))}
        {p.text && <PromptText text={p.text} />}
      </div>
      <div className="sending">
        <span className="shimmer">Sending…</span>
      </div>
    </div>
  )
}

const WarnIcon = () => <span className="dot needs mark-warn" aria-hidden />

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

export function tokens(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

// The start of a session says when it began, with the date even today
// (a time alone left the day unsaid); its first item then needs no time
// of its own (they stood as two centred lines, one over the other).
function startLine(first?: Item): string {
  const when = first ? when_(Date.parse(first.time), true) : ''
  return when ? `Start of the session · ${when}` : 'Start of the session'
}

// A centred time goes over an item 5 minutes or more after the one above
// it ended (not began: a long reply's own time is its end, under it, and
// the same minute stood twice, once under the reply and once centred).
function stamp(it: Item, prev?: Item, prevEnd?: string): string {
  const t = Date.parse(it.time)
  if (!t) return ''
  if (prev === it) return '' // the first item, timed by the start line
  const p = prev ? Date.parse(prevEnd || prev.time) : 0
  if (p && t - p < 5 * 60_000) return ''
  return when_(t)
}

// A time today, "Nov 24, 3:40 PM" on other days (or always, dated).
function when_(t: number, dated = false): string {
  if (!t) return ''
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today && !dated
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// An item's key is its first row, which rows arriving below never change.
// Older rows fetched above can extend an item upward and change that, so
// the scroll anchor is its last row instead.
function ItemView({ item, prev, prevEnd, anchor, end, live, retry }: { item: Item; prev?: Item; prevEnd?: string; anchor: string; end: string; live: boolean; retry?: () => void }) {
  // A compaction is a marker, not a message: no time over it (its time is
  // the label's tip), the stamp and the line stood stacked. A background
  // task's message carries its own time.
  const own = item.kind === 'notice' && (item.tone === 'divider' || item.tone === 'task')
  const when = own ? '' : stamp(item, prev, prevEnd)
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
        <ReplyView parts={item.parts} live={live} at={end} />
      ) : (
        <Notice item={item} retry={retry} />
      )}
    </div>
  )
}

// The reply's footer: Copy, and when it finished.
function CopyReply({ parts, at }: { parts: Part[]; at: string }) {
  const [state, setState] = useState<'' | 'copied' | 'failed'>('')
  const text = answer(parts)
  useEffect(() => {
    if (!state) return
    const t = window.setTimeout(() => setState(''), 1500)
    return () => clearTimeout(t)
  }, [state])
  // The time goes with Copy: a reply of tool rows alone (one cut off, say)
  // stood as a lone time, a second one by the next reply's.
  if (!text) return null
  const when = when_(Date.parse(at))
  return (
    <div className="reply-actions">
      {text && (
        <button
          type="button"
          className={'copy-btn' + (state ? ' ' + state : '')}
          title="Copy the answer as Markdown"
          aria-label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
          onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}
        >
          {state === 'copied' ? <CheckIcon sm /> : <CopyIcon sm />}
          {state === 'failed' ? <span>Copy failed</span> : <span className="copy-label">{state === 'copied' ? 'Copied' : 'Copy'}</span>}
        </button>
      )}
      {when && <span className="reply-time">{when}</span>}
    </div>
  )
}

function Notice({ item, retry }: { item: Extract<Item, { kind: 'notice' }>; retry?: () => void }) {
  if (item.tone === 'divider') return <Compaction item={item} at={when_(Date.parse(item.time))} />
  if (item.tone === 'output') {
    // A command's printout (/context, /usage): Markdown, in a card.
    return (
      <div className="notice output">
        <Markdown text={item.text} />
      </div>
    )
  }
  if (item.tone === 'error') return <ErrorNote text={item.text} retry={retry} />
  if (item.tone === 'task' && item.tasks?.length) return <TaskMessage tasks={item.tasks} at={when_(Date.parse(item.time))} />
  // Interrupted: when, muted beside it, as a reply's time (a turn that
  // ends here has no Copy line to carry one).
  const at = item.text === 'Interrupted' ? when_(Date.parse(item.time)) : ''
  return (
    <div className={'notice ' + item.tone}>
      {item.text}
      {at && <span className="reply-time">{at}</span>}
    </div>
  )
}

// TaskMessage is a background task's news as what it is, a message to
// Claude that starts a new turn: a bubble on the right like a prompt, but
// marked as the system's (its label, the task's name, how it ended, and
// when), so the reply under it reads as its answer.
function TaskMessage({ tasks, at }: { tasks: TaskNews[]; at: string }) {
  return (
    <div className="task-msg" role="note">
      {tasks.map((t, i) => (
        <div key={i} className="task-msg-one">
          <div className="task-msg-head">
            <Icon name="bot" sm />
            <span>{t.label}</span>
            {i === 0 && at && <span className="reply-time">{at}</span>}
          </div>
          <div className="task-msg-name">
            {t.name}
            {t.detail && <span className="task-msg-detail"> · {t.detail}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

// Compaction is one unit, as Claude desktop and Cursor mark theirs: a
// hairline with what happened in its middle, the summary a disclosure
// under it. (No idle line: the composer's Cold chip says the cache went.)
// Open, the summary's head stays at the top while it scrolls by, and a
// Hide at its end closes it from below too (it was a long way back up).
function Compaction({ item, at }: { item: Extract<Item, { kind: 'notice' }>; at?: string }) {
  const [open, setOpen] = useState(false)
  const head = useRef<HTMLDivElement>(null)
  const close = () => {
    setOpen(false)
    // Back to the line, if closing from below left it out of view.
    requestAnimationFrame(() => {
      const el = head.current
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'center' })
    })
  }
  return (
    <div className={'compaction' + (open ? ' open' : '')} ref={head}>
      <div className="compaction-line">
        <span className="compaction-label" title={at}>{item.text}</span>
      </div>
      {item.detail && !open && (
        <div className="compaction-sub">
          <button type="button" className="compaction-btn" aria-expanded={false} onClick={() => setOpen(true)}>
            Summary
            <Chevron />
          </button>
        </div>
      )}
      {open && item.detail && (
        <div className="compaction-summary">
          <div className="compaction-head">
            <button type="button" className="compaction-btn" aria-expanded onClick={close}>
              Summary of the earlier conversation
              <Chevron />
            </button>
          </div>
          <div className="compaction-body">
            <Markdown text={item.detail} />
          </div>
          <div className="compaction-foot">
            <button type="button" className="compaction-btn" onClick={close}>
              Hide summary
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ErrorNote is a failure in words: an API error's JSON becomes a sentence,
// with the original a tap away.
// A turn that failed on this page can be tried again: the composer sends
// its prompt once more, with the chips as they are.
function ErrorNote({ text, retry }: { text: string; retry?: () => void }) {
  const [open, setOpen] = useState(false)
  const r = readableError(text)
  return (
    <div className="notice error" role="status">
      <div className="notice-row">
        <ErrorMark />
        <div className="notice-text">
          <div className="notice-title">{r.title ?? 'The turn failed'}</div>
          {r.text && <div className="notice-why pre-line">{r.text}</div>}
        </div>
      </div>
      {(r.raw || retry) && (
        <div className="notice-actions">
          {retry && (
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          )}
          {r.raw && (
            <button type="button" className="details-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <Chevron />
              Details
            </button>
          )}
        </div>
      )}
      {open && r.raw && <pre className="raw">{r.raw}</pre>}
    </div>
  )
}

// A reply: its parts in order, each run of tool calls on one line.
function ReplyView({ parts, live, at }: { parts: Part[]; live: boolean; at: string }) {
  const segs = useMemo(() => segments(parts), [parts])
  const part = (p: Part, i: number) => <PartView key={i} part={p} live={live} />
  return (
    <div className="reply">
      {segs.map((s) => (s.kind === 'tools' ? <ToolRun key={s.at} parts={s.parts} render={part} /> : part(s.part, s.at)))}
      {/* Copy and the time once the turn has ended: while it runs, the
          working line is the only thing under the reply. */}
      {!live && <CopyReply parts={parts} at={at} />}
    </div>
  )
}

// A relative link in a reply names a file in the project ("[the readme](README.md)"):
// it opens in a tab (Workspace listens), where the browser went to a 404.
const replyLinks = { resolve: (href: string, kind: 'image' | 'link') => (kind === 'link' ? '#' : href) }
function openLink(e: React.MouseEvent, folder: string) {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-rel]')
  if (!a) return
  e.preventDefault()
  const path = a.dataset.rel!.replace(/[#?].*$/, '').replace(/^\.\//, '')
  if (path) window.dispatchEvent(new CustomEvent('dakort:open-file', { detail: { folder, path } }))
}

function PartView({ part, live }: { part: Part; live: boolean }) {
  switch (part.kind) {
    case 'text':
      return <Markdown text={part.text} opts={replyLinks} />
    case 'thinking':
      return <Thinking text={part.text} />
    case 'tool':
      return <ToolRow use={part.use} result={part.result} live={live} />
    case 'media':
      return <Media block={part.block} />
  }
}

// Thinking shows when it has text (recent CLIs record most of it empty;
// those left a bare "Thought" line each, noise): a row that says it is
// thinking with a line of it, the whole a tap away, so it never reads as
// part of the reply. A summary made of titled steps (Codex's) previews
// just the titles, and opens to the whole of it as markdown.
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const steps = useMemo(() => titles(text), [text])
  if (!text.trim()) return null
  const preview = (steps.length ? steps.join(' · ') : text).replace(/\s+/g, ' ').trim()
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={'thinking' + (open ? ' open' : '')}>
      <CollapsibleTrigger asChild>
        <button type="button" className="thinking-row">
          <Chevron />
          <span className="thinking-label">Thinking</span>
          {!open && <span className="thinking-preview">{preview}</span>}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="thinking-body">{steps.length ? <Markdown text={text} /> : text}</CollapsibleContent>
    </Collapsible>
  )
}
