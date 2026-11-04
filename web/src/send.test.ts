import { describe, expect, it } from 'vitest'
import { newPromptId, sendPrompt } from './send'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// A fetch that plays back answers in order; a thrown error is a lost one.
function fake(...answers: (Response | Error)[]) {
  const bodies: string[] = []
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body))
    const a = answers.shift()
    if (!a || a instanceof Error) throw a ?? new Error('no answer')
    return a
  }) as unknown as typeof fetch
  return { f, bodies }
}

const body = { promptId: 'p1', text: 'hi' }

describe('sending a prompt', () => {
  it('makes ids shaped like a v4 uuid', () => {
    const id = newPromptId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newPromptId()).not.toBe(id)
  })

  it('takes the POST answer as the ack', async () => {
    const { f } = fake(json(202, { session: 's1', promptId: 'p1' }))
    expect(await sendPrompt({ url: '/x', body, acked: () => undefined, fetch: f })).toEqual({ ok: true, session: 's1' })
  })

  it('retries a lost answer with the same prompt id', async () => {
    const { f, bodies } = fake(new Error('reset'), json(200, { session: 's1', promptId: 'p1', duplicate: true }))
    expect(await sendPrompt({ url: '/x', body, acked: () => undefined, fetch: f })).toEqual({ ok: true, session: 's1' })
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[1]).promptId).toBe('p1')
  })

  it('believes the stream when the answer is lost', async () => {
    const { f, bodies } = fake(new Error('reset'))
    expect(await sendPrompt({ url: '/x', body, acked: () => 's9', fetch: f })).toEqual({ ok: true, session: 's9' })
    expect(bodies).toHaveLength(1)
  })

  it('gives the prompt back when nothing says it arrived', async () => {
    const { f } = fake(new Error('a'), new Error('b'))
    const r = await sendPrompt({ url: '/x', body, acked: () => undefined, fetch: f })
    expect(r.ok === false && r.kind).toBe('lost')
  })

  it('tells the four kinds of refusal apart', async () => {
    const cases: [Response, string][] = [
      [json(409, { error: 'held', heldBy: 4242 }), 'held'],
      [json(409, { error: 'a turn is already running' }), 'busy'],
      [json(503, { error: '3 turns are already running' }), 'full'],
      [new Response('not logged in', { status: 401 }), 'auth'],
      [json(400, { error: 'empty prompt' }), 'error'],
    ]
    for (const [resp, kind] of cases) {
      const r = await sendPrompt({ url: '/x', body, acked: () => undefined, fetch: fake(resp).f })
      expect(r.ok === false && r.kind).toBe(kind)
      if (kind === 'held') expect(r.ok === false && r.kind === 'held' && r.heldBy).toBe(4242)
    }
  })

  it('times out a POST that hangs', async () => {
    const hang = (async (_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch
    const r = await sendPrompt({ url: '/x', body, acked: () => undefined, fetch: hang, timeoutMs: 20 })
    expect(r.ok === false && r.kind).toBe('lost')
  })
})
