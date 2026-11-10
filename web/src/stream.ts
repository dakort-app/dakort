// The event stream. EventSource reconnects by itself and sends the last id
// it saw, but it cannot be trusted on its own: a half-open connection
// (office proxy, sleeping phone) stays "open" and silent, and Safari keeps
// dead streams after the page was in the background. So a watchdog
// recreates the stream after 40 s without anything (pings come every 15
// s), and so does coming back to the page. A stream this code recreates
// does not send Last-Event-ID, so the last id travels as ?last=.
//
// The last id lives in memory, not in sessionStorage: a resumed stream
// replays only what came after it, with no snapshot, and a reloaded page
// starts knowing nothing. Kept across a reload, it hid a running turn
// (no Stop, no dot) until the turn ended. A fresh page gets the snapshot.

import type { Ev } from './types'

const silence = 40_000

export type StreamState = 'connecting' | 'open' | 'auth'

export class Stream {
  private es: EventSource | null = null
  private heard = 0
  private timer = 0
  private retry = 0
  private stopped = false
  private last = ''
  private onEvent: (e: Ev) => void
  private onState: (s: StreamState) => void

  constructor(onEvent: (e: Ev) => void, onState: (s: StreamState) => void) {
    this.onEvent = onEvent
    this.onState = onState
  }

  start() {
    this.stopped = false
    this.open()
    this.timer = window.setInterval(() => {
      if (Date.now() - this.heard > silence) this.open()
    }, 5000)
    document.addEventListener('visibilitychange', this.onVisible)
  }

  stop() {
    this.stopped = true
    this.es?.close()
    this.es = null
    clearInterval(this.timer)
    clearTimeout(this.retry)
    document.removeEventListener('visibilitychange', this.onVisible)
  }

  private onVisible = () => {
    // More than one missed ping means the stream may be dead.
    if (document.visibilityState === 'visible' && Date.now() - this.heard > 20_000) this.open()
  }

  private open() {
    if (this.stopped) return
    this.es?.close()
    clearTimeout(this.retry)
    this.heard = Date.now()
    this.onState('connecting')
    const es = new EventSource(`/api/events?last=${encodeURIComponent(this.last)}`)
    this.es = es
    es.onopen = () => {
      this.heard = Date.now()
      this.onState('open')
    }
    es.onmessage = (m) => {
      if (es !== this.es) return
      this.heard = Date.now()
      if (m.lastEventId) this.last = m.lastEventId
      let e: Ev
      try {
        e = JSON.parse(m.data)
      } catch {
        return
      }
      if (e.type !== 'ping') this.onEvent(e)
    }
    es.onerror = () => {
      if (es !== this.es || es.readyState !== EventSource.CLOSED) return // it retries by itself
      // EventSource gives up on a non-200 answer. A 401 retries silently
      // forever otherwise, so find out which it was.
      fetch('/api/sessions', { cache: 'no-store' })
        .then((r) => {
          if (r.status === 401) this.onState('auth')
          else this.retry = window.setTimeout(() => this.open(), 2000)
        })
        .catch(() => {
          this.retry = window.setTimeout(() => this.open(), 2000)
        })
    }
  }
}
