// Live state: what the stream says is happening now, folded event by event
// like hub.apply on the server. Pure, so it can be tested without a DOM.

import type { Ev, Leftover, LiveBlock, Permission, Queued, Result, Row, Task } from './types'

export type LiveTurn = {
  session: string
  promptId?: string
  state: 'starting' | 'running'
  blocks: Record<number, LiveBlock> // the reply's parts not yet in the transcript
  permissions: Permission[]
}

export type Ended = { result?: Result; error?: string }

export type Live = {
  turns: Record<string, LiveTurn> // by session
  ended: Record<string, Ended> // each session's last finished turn
  tasks: Record<string, Task[]> // by session: background tasks, which outlive turns
  queue: Record<string, Queued[]> // by session: messages waiting for the turn to end
  leftovers: Record<string, Leftover[]> // by session: processes its last turn left running
}

export const emptyLive: Live = { turns: {}, ended: {}, tasks: {}, queue: {}, leftovers: {} }

export function applyEvent(live: Live, e: Ev): Live {
  const s = e.session ?? ''
  const t = live.turns[s]
  switch (e.type) {
    case 'snapshot': {
      // A fresh connect or a gap: the snapshot is the whole truth about
      // running turns. Anything it does not list has ended or was answered.
      const turns: Record<string, LiveTurn> = {}
      for (const lt of e.turns ?? []) {
        const blocks: Record<number, LiveBlock> = {}
        for (const [i, b] of Object.entries(lt.blocks ?? {})) blocks[Number(i)] = b
        turns[lt.session] = {
          session: lt.session,
          promptId: lt.promptId,
          state: lt.state,
          blocks,
          permissions: lt.permissions ?? [],
        }
      }
      return { ...live, turns, tasks: e.background ?? {}, queue: e.queues ?? {}, leftovers: e.allLeftovers ?? {} }
    }
    case 'leftovers': {
      const leftovers = { ...live.leftovers }
      if (e.leftovers?.length) leftovers[s] = e.leftovers
      else delete leftovers[s]
      return { ...live, leftovers }
    }
    case 'tasks': {
      const tasks = { ...live.tasks }
      if (e.tasks?.length) tasks[s] = e.tasks
      else delete tasks[s]
      return { ...live, tasks }
    }
    case 'queue': {
      const queue = { ...live.queue }
      if (e.queue?.length) queue[s] = e.queue
      else delete queue[s]
      return { ...live, queue }
    }
    case 'turn': {
      if (e.state === 'done') {
        const turns = { ...live.turns }
        delete turns[s]
        return { ...live, turns, ended: { ...live.ended, [s]: { result: e.result, error: e.error } } }
      }
      const next: LiveTurn = t
        ? { ...t, state: e.state as LiveTurn['state'] }
        : { session: s, state: e.state as LiveTurn['state'], blocks: {}, permissions: [] }
      if (e.promptId) next.promptId = e.promptId
      return { ...live, turns: { ...live.turns, [s]: next } }
    }
    case 'delta': {
      if (!t) return live
      const i = e.index ?? 0
      const old = t.blocks[i]
      const b: LiveBlock = { kind: (old?.kind ?? e.kind) as LiveBlock['kind'], text: (old?.text ?? '') + (e.text ?? '') }
      return { ...live, turns: { ...live.turns, [s]: { ...t, blocks: { ...t.blocks, [i]: b } } } }
    }
    case 'appended':
      // A complete assistant message is in the transcript; the previews
      // of it are stale.
      if (!t || e.kind !== 'assistant') return live
      return { ...live, turns: { ...live.turns, [s]: { ...t, blocks: {} } } }
    case 'permission':
      if (!t || !e.permission) return live
      return { ...live, turns: { ...live.turns, [s]: { ...t, permissions: [...t.permissions, e.permission] } } }
    case 'permissionDone':
      if (!t) return live
      return {
        ...live,
        turns: { ...live.turns, [s]: { ...t, permissions: t.permissions.filter((p) => p.id !== e.requestId) } },
      }
  }
  return live
}

// busy says what a session is doing now: 'run' while a turn runs, 'tasks'
// while only its background tasks do (agents, commands, monitors: the turn
// that started them has ended and a prompt is taken at once), '' when
// neither. Without 'tasks' a session with agents out read as idle.
export function busy(live: Live, id: string): '' | 'run' | 'tasks' {
  if (live.turns[id]) return 'run'
  return live.tasks[id]?.length ? 'tasks' : ''
}
export const tasksTitle = 'agents or commands running in the background; a message is answered now'

// landed says whether finished previews are on screen as rows now: each text
// in an assistant row with the same text, and a thinking block (shown only as
// "Thinking…", its row's text may be empty) once any row has come after
// count, the number of rows there were while it streamed. Any row landing
// was not enough: the thinking row or the prompt echo, fetched late, took a
// reply's preview away before its own row came.
export function landed(blocks: LiveBlock[], rows: Row[], count: number): boolean {
  const recent = rows.slice(-50)
  return blocks.every((b) =>
    b.kind === 'thinking'
      ? rows.length !== count
      : recent.some((r) => r.role === 'assistant' && r.blocks?.some((x) => x.type === 'text' && x.text?.trim() === b.text.trim())),
  )
}

// liveBlocks lists a turn's previews in order.
export function liveBlocks(t: LiveTurn | undefined): LiveBlock[] {
  if (!t) return []
  return Object.keys(t.blocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => t.blocks[i])
}
