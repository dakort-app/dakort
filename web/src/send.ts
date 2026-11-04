// Sending a prompt so it cannot vanish. The POST's answer is the ack. If
// the answer is lost (a half-open connection, a phone going to sleep), the
// prompt may still have arrived: the stream says so when it carries our
// prompt id, and a second POST with the same id is recognised by the
// server rather than run twice. Only when neither says yes does the prompt
// go back to the composer.

export function newPromptId(): string {
  // crypto.randomUUID needs a secure context, and plain HTTP over
  // Tailscale is not one.
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export type Outcome =
  | { ok: true; session: string }
  | { ok: false; kind: 'held'; heldBy: number; message: string }
  | { ok: false; kind: 'busy' | 'full' | 'auth' | 'error' | 'lost'; message: string }

export type SendOptions = {
  url: string
  body: Record<string, unknown> & { promptId: string }
  // acked returns the session the stream has seen this prompt in, if any.
  acked: () => string | undefined
  timeoutMs?: number
  attempts?: number
  fetch?: typeof fetch
}

export async function sendPrompt(o: SendOptions): Promise<Outcome> {
  const doFetch = o.fetch ?? fetch
  const attempts = o.attempts ?? 2
  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000)
    let r: Response
    try {
      r = await doFetch(o.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(o.body),
        signal: ctl.signal,
      })
    } catch {
      // No answer. It may have arrived anyway.
      const s = o.acked()
      if (s) return { ok: true, session: s }
      continue
    } finally {
      clearTimeout(timer)
    }
    let data: Record<string, unknown> = {}
    try {
      data = await r.json()
    } catch {
      // an error page in plain text
    }
    const message = typeof data.error === 'string' ? data.error : `HTTP ${r.status}`
    if (r.ok) return { ok: true, session: String(data.session ?? '') }
    if (r.status === 401) return { ok: false, kind: 'auth', message: 'not logged in' }
    if (r.status === 409 && typeof data.heldBy === 'number' && data.heldBy > 0) {
      return { ok: false, kind: 'held', heldBy: data.heldBy, message }
    }
    if (r.status === 409) return { ok: false, kind: 'busy', message }
    if (r.status === 503) return { ok: false, kind: 'full', message }
    return { ok: false, kind: 'error', message }
  }
  const s = o.acked()
  if (s) return { ok: true, session: s }
  return { ok: false, kind: 'lost', message: 'No answer from the server. Your prompt is back in the box; send it again.' }
}
