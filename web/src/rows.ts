// Turning transcript rows into what the screen shows. A prompt is what the
// person typed; a reply is everything Claude did until the next prompt
// (text, thinking, and tool calls paired with their results, which arrive
// in later user rows). Context the CLI attaches is dropped, as the server's
// PromptText does.

import type { Block, Row } from './types'

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; use: Block; result?: Block }
  | { kind: 'media'; block: Block }

type Span = { key: string; first: number; last: number; time: string }

export type Item =
  | (Span & { kind: 'prompt'; text: string; media: Block[] })
  | (Span & { kind: 'reply'; parts: Part[]; model?: string })
  | (Span & { kind: 'notice'; tone: 'divider' | 'error' | 'info' | 'output' | 'task'; text: string; detail?: string })

// Context blocks start with a tag: <system-reminder>, <command-name>, ...
const attachedTag = /^<[a-z][a-z0-9_-]*(\s[^>]*)?>/

const isMedia = (b: Block) => b.type === 'image' || b.type === 'document'

export function promptText(r: Row): string {
  if (r.role !== 'user' || r.meta || r.compactSummary) return ''
  const parts: string[] = []
  for (const b of r.blocks ?? []) {
    if (b.type !== 'text') continue
    const t = (b.text ?? '').trim()
    if (!t || attachedTag.test(t) || t.startsWith('[Request interrupted by user') || t.startsWith('[Image: source:')) continue
    parts.push(t)
  }
  return parts.join('\n\n')
}

const rowText = (r: Row) => (r.blocks ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('')

// taskNotice is the line for a background task's news: the CLI wakes the
// model with a user row of <task-notification> blocks when a task ends, is
// stopped, or a monitor prints. Its summary, and the line printed if any.
// Undefined for other rows.
export function taskNotice(r: Row): string | undefined {
  if (r.role !== 'user') return undefined
  const t = rowText(r).trim()
  if (!t.startsWith('<task-notification>')) return undefined
  const lines = [...t.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(([, n]) => {
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(n)?.[1]?.trim()
    const summary = tag('summary') || 'Background task'
    const event = tag('event')
    return event ? `${summary}: ${event}` : summary
  })
  return lines.join('\n') || 'Background task'
}

// commandText is a slash command the person ran, as typed ("/context",
// "/goal ship it"): the CLI records it as <command-name>/x</command-name>
// ... <command-args>…</command-args> in a user row. Empty for other rows.
export function commandText(r: Row): string {
  if (r.role !== 'user' || r.meta) return ''
  const t = rowText(r)
  const name = /<command-name>\s*([^<\s]+)\s*<\/command-name>/.exec(t)?.[1]
  if (!name) return ''
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? ''
  return ((name.startsWith('/') ? name : '/' + name) + ' ' + args).trim()
}

// commandOutput is what a command printed (/context's table, /usage's
// report): <local-command-stdout> in a system row (a user row on older
// CLIs). Undefined for other rows.
function commandOutput(r: Row): string | undefined {
  const t = r.role === 'system' ? (r.content ?? '') : r.role === 'user' ? rowText(r) : ''
  return /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(t)?.[1]?.trim()
}

function interrupted(r: Row): boolean {
  return (r.blocks ?? []).some((b) => b.type === 'text' && (b.text ?? '').trim().startsWith('[Request interrupted by user'))
}

export function group(rows: Row[]): Item[] {
  // Tool results, by the tool_use they answer.
  const results = new Map<string, Block>()
  for (const r of rows) {
    if (r.role !== 'user') continue
    for (const b of r.blocks ?? []) if (b.type === 'tool_result' && b.id) results.set(b.id, b)
  }

  const items: Item[] = []
  let reply: Extract<Item, { kind: 'reply' }> | null = null
  const push = (it: Item) => {
    items.push(it)
    reply = it.kind === 'reply' ? it : null
  }

  rows.forEach((r, i) => {
    if (r.sidechain) return
    // Slash commands: the command as your prompt, its printout as a card.
    // /compact's own rows stay quiet: its divider says what happened (and
    // an idle compaction is not something you typed). So do /rename's: the
    // new name on the tab says it.
    const cmd = commandText(r)
    if (cmd) {
      if (!/^\/(compact|rename)\b/.test(cmd)) push({ kind: 'prompt', key: r.uuid, first: i, last: i, time: r.time, text: cmd, media: [] })
      return
    }
    const out = commandOutput(r)
    if (out !== undefined) {
      if (out && !/^(compacted\b|session renamed to:)/i.test(out)) push({ kind: 'notice', key: r.uuid, first: i, last: i, time: r.time, tone: 'output', text: out })
      return
    }
    if (r.role === 'system') {
      if (r.subtype === 'compact_boundary') {
        const k = (n: number) => Math.round(n / 1000) + 'k'
        const sizes = r.preTokens ? (r.postTokens ? `, ${k(r.preTokens)} → ${k(r.postTokens)}` : ` (was ${k(r.preTokens)})`) : ''
        push({ kind: 'notice', key: r.uuid, first: i, last: i, time: r.time, tone: 'divider', text: 'Conversation compacted' + sizes })
      } else if (r.subtype === 'api_error' || r.level === 'error') {
        push({ kind: 'notice', key: r.uuid, first: i, last: i, time: r.time, tone: 'error', text: r.content || 'API error' })
      }
      return
    }
    if (r.role === 'assistant') {
      if (r.apiError) {
        const text = (r.blocks ?? []).map((b) => b.text ?? '').join('\n').trim()
        push({ kind: 'notice', key: r.uuid, first: i, last: i, time: r.time, tone: 'error', text: text || 'API error' })
        return
      }
      if (!reply) {
        push({ kind: 'reply', key: r.uuid, first: i, last: i, time: r.time, parts: [], model: r.model })
      }
      const rep = reply!
      rep.last = i
      for (const b of r.blocks ?? []) {
        if (b.type === 'text' && b.text?.trim()) rep.parts.push({ kind: 'text', text: b.text })
        else if (b.type === 'thinking') rep.parts.push({ kind: 'thinking', text: b.text ?? '' })
        else if (b.type === 'tool_use') rep.parts.push({ kind: 'tool', use: b, result: b.id ? results.get(b.id) : undefined })
        else if (isMedia(b)) rep.parts.push({ kind: 'media', block: b })
      }
      return
    }
    // A user row.
    if (r.compactSummary) {
      const detail = (r.blocks ?? []).map((b) => b.text ?? '').join('\n').trim()
      push({ kind: 'notice', key: r.uuid, first: i, last: i, time: r.time, tone: 'divider', text: 'Summary of the earlier conversation', detail })
      return
    }
    if (r.meta) return
    const task = taskNotice(r)
    if (task) {
      push({ kind: 'notice', key: r.uuid, first: i, last: i, time: r.time, tone: 'task', text: task })
      return
    }
    const text = promptText(r)
    const media = (r.blocks ?? []).filter(isMedia)
    if (text || media.length) {
      push({ kind: 'prompt', key: r.uuid, first: i, last: i, time: r.time, text, media })
      return
    }
    if (interrupted(r)) {
      push({ kind: 'notice', key: r.uuid, first: i, last: i, time: r.time, tone: 'info', text: 'Interrupted' })
      return
    }
    // Tool results and attached context: part of the reply under way.
    if (reply) (reply as Extract<Item, { kind: 'reply' }>).last = i
  })
  return items
}

// answer is what "Copy" takes from a reply: its text after the last tool
// call, the answer itself, not the narration of the steps before it.
export function answer(parts: Part[]): string {
  return parts
    .slice(parts.findLastIndex((p) => p.kind === 'tool') + 1)
    .flatMap((p) => (p.kind === 'text' && p.text.trim() ? [p.text.trim()] : []))
    .join('\n\n')
}

// toolSummary is the one line a collapsed tool call shows.
export function toolSummary(use: Block): string {
  const inp = (use.input ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof inp[k] === 'string' ? (inp[k] as string) : '')
  const base = (p: string) => p.split(/[\\/]/).pop() || p
  let arg = ''
  switch (use.name) {
    case 'Bash':
    case 'PowerShell':
      // Claude describes each command in plain words; the command itself
      // is in the expanded call.
      arg = s('description') || s('command')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      arg = base(s('file_path') || s('notebook_path'))
      break
    case 'Grep':
    case 'Glob':
      arg = s('pattern')
      break
    case 'WebFetch':
      arg = s('url')
      break
    case 'WebSearch':
      arg = s('query')
      break
    case 'Task':
    case 'Agent':
      arg = s('description')
      break
    default:
      arg = Object.values(inp).find((v) => typeof v === 'string') as string ?? ''
  }
  arg = arg.replace(/\s+/g, ' ').trim()
  return arg ? `${use.name}: ${arg}` : use.name ?? 'tool'
}

// resultText flattens a tool result's text parts.
export function resultText(b: Block | undefined): string {
  if (!b) return ''
  if (b.text) return b.text
  return (b.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
}
