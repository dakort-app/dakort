import { describe, expect, it } from 'vitest'
import { applyEvent, emptyLive, landed, liveBlocks, type Live } from './live'
import type { Ev, LiveBlock, Row } from './types'

const run = (evs: Ev[], from: Live = emptyLive) => evs.reduce(applyEvent, from)

const perm = (id: string) => ({ id, tool: 'Bash' })

describe('live state', () => {
  it('follows a turn from start to done', () => {
    let l = run([
      { type: 'turn', session: 's', state: 'starting', promptId: 'p1' },
      { type: 'delta', session: 's', index: 1, kind: 'text', text: 'lo' },
      { type: 'turn', session: 's', state: 'running' },
      { type: 'delta', session: 's', index: 0, kind: 'thinking', text: 'hm' },
      { type: 'delta', session: 's', index: 1, kind: 'text', text: 'ng' },
    ])
    expect(l.turns.s.promptId).toBe('p1')
    expect(l.turns.s.state).toBe('running')
    expect(liveBlocks(l.turns.s)).toEqual([
      { kind: 'thinking', text: 'hm' },
      { kind: 'text', text: 'long' },
    ])
    l = run([{ type: 'appended', session: 's', kind: 'assistant', uuid: 'u' }], l)
    expect(liveBlocks(l.turns.s)).toEqual([])
    l = run([{ type: 'turn', session: 's', state: 'done', error: 'boom' }], l)
    expect(l.turns.s).toBeUndefined()
    expect(l.ended.s.error).toBe('boom')
  })

  it('keeps what a turn left running, from the snapshot and per session', () => {
    const node = { pid: 42, name: 'node.exe' }
    let l = run([{ type: 'snapshot', allLeftovers: { s: [node] } }])
    expect(l.leftovers.s).toEqual([node])
    l = run([{ type: 'leftovers', session: 't', leftovers: [{ pid: 7, name: 'sleep.exe' }] }], l)
    expect(Object.keys(l.leftovers)).toEqual(['s', 't'])
    l = run([{ type: 'leftovers', session: 's' }], l)
    expect(l.leftovers.s).toBeUndefined()
    expect(run([{ type: 'snapshot' }], l).leftovers).toEqual({})
  })

  it('ignores deltas for a turn it never saw start, as the hub does', () => {
    expect(run([{ type: 'delta', session: 'x', index: 0, kind: 'text', text: 'a' }])).toEqual(emptyLive)
  })

  it('keeps a user prompt echo from clearing previews', () => {
    const l = run([
      { type: 'turn', session: 's', state: 'running' },
      { type: 'delta', session: 's', index: 0, kind: 'text', text: 'a' },
      { type: 'appended', session: 's', kind: 'user', uuid: 'u', promptId: 'p' },
    ])
    expect(liveBlocks(l.turns.s)).toHaveLength(1)
  })

  it('adds and removes permissions', () => {
    const l = run([
      { type: 'turn', session: 's', state: 'running' },
      { type: 'permission', session: 's', permission: perm('a') },
      { type: 'permission', session: 's', permission: perm('b') },
      { type: 'permissionDone', session: 's', requestId: 'a', decision: 'allow' },
    ])
    expect(l.turns.s.permissions.map((p) => p.id)).toEqual(['b'])
  })

  it('takes a snapshot as the whole truth', () => {
    // Before the gap: two turns, one with a permission card open.
    const before = run([
      { type: 'turn', session: 'gone', state: 'running' },
      { type: 'turn', session: 's', state: 'running' },
      { type: 'permission', session: 's', permission: perm('old') },
      { type: 'delta', session: 's', index: 0, kind: 'text', text: 'stale' },
    ])
    // The snapshot's blocks arrive as an object with string keys.
    const l = applyEvent(before, {
      type: 'snapshot',
      gap: true,
      turns: [{ session: 's', state: 'running', promptId: 'p', blocks: { '2': { kind: 'text', text: 'b' }, '0': { kind: 'text', text: 'a' } }, permissions: [perm('new')] }],
    })
    expect(Object.keys(l.turns)).toEqual(['s'])
    expect(l.turns.s.permissions.map((p) => p.id)).toEqual(['new'])
    expect(liveBlocks(l.turns.s).map((b) => b.text)).toEqual(['a', 'b'])
    // And an empty snapshot clears everything (turns is omitted when empty).
    expect(applyEvent(l, { type: 'snapshot' }).turns).toEqual({})
  })
})

describe('background tasks', () => {
  it('outlive the turn, empty out, and come back whole from a snapshot', () => {
    const k = { id: 'b1', type: 'local_bash', description: 'Build' }
    let l: Live = applyEvent(emptyLive, { type: 'turn', session: 's', state: 'running' })
    l = applyEvent(l, { type: 'tasks', session: 's', tasks: [k] })
    l = applyEvent(l, { type: 'turn', session: 's', state: 'done', result: { ok: true } })
    expect(l.tasks.s).toEqual([k])
    l = applyEvent(l, { type: 'tasks', session: 's', tasks: [] })
    expect(l.tasks.s).toBeUndefined()
    l = applyEvent(l, { type: 'snapshot', turns: [], background: { t: [k] } })
    expect(l.tasks).toEqual({ t: [k] })
  })
})

describe('queued messages', () => {
  it('are the latest list, empty out, and come back from a snapshot', () => {
    const q = { promptId: 'p1', text: 'next' }
    let l: Live = applyEvent(emptyLive, { type: 'queue', session: 's', queue: [q] })
    l = applyEvent(l, { type: 'turn', session: 's', state: 'done', result: { ok: true } })
    expect(l.queue.s).toEqual([q])
    l = applyEvent(l, { type: 'queue', session: 's' })
    expect(l.queue.s).toBeUndefined()
    l = applyEvent(l, { type: 'snapshot', turns: [], queues: { t: [q] } })
    expect(l.queue).toEqual({ t: [q] })
  })
})

describe('landed', () => {
  const row = (uuid: string, role: Row['role'], blocks: Row['blocks'] = []): Row => ({ uuid, role, time: '', offset: 0, end: 0, blocks })
  const reply: LiveBlock[] = [{ kind: 'text', text: 'The sky is blue.\n' }]

  it("waits for the reply's own row, not just any row", () => {
    const before = [row('p', 'user')]
    // The thinking row lands first: the preview must stay.
    const thinking = [...before, row('t', 'assistant', [{ type: 'thinking', text: '' }])]
    expect(landed(reply, thinking, before.length)).toBe(false)
    const text = [...thinking, row('a', 'assistant', [{ type: 'text', text: 'The sky is blue.' }])]
    expect(landed(reply, text, before.length)).toBe(true)
  })

  it('lets a thinking preview go once any row comes', () => {
    const think: LiveBlock[] = [{ kind: 'thinking', text: '' }]
    expect(landed(think, [row('p', 'user')], 1)).toBe(false)
    expect(landed(think, [row('p', 'user'), row('t', 'assistant')], 1)).toBe(true)
  })
})
