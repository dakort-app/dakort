// tools.ts: how a tool call reads on screen: a verb, what it acted on, and
// for an edit its size (+N −M; a read's or a command's length stays in
// the open row, as Claude desktop's rows show none), the change an edit makes as a line diff, and runs of calls folded into
// one line. Pure functions; ToolView.tsx draws them.

import type { Block } from './types'
import type { Part } from './rows'
import { commandLabel } from './cmdlabel'

type Input = Record<string, unknown>
const inputOf = (use: Block): Input => (use.input && typeof use.input === 'object' ? (use.input as Input) : {})
const str = (inp: Input, k: string) => (typeof inp[k] === 'string' ? (inp[k] as string) : '')
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export type ToolHead = {
  verb: string // what was done, in words
  target: string // what it was done to: a file name, a command, a pattern
  mono: boolean // the target is code (a path, a command), set in the mono face
  tip: string // the target in full (the whole path, the whole command)
}

// toolHead is a call's one line, in plain words: Claude's own description
// where the call has one, else words made from it (cmdlabel.ts for a
// command), and for files the file's name (the whole path is the tip).
// A command, a pattern or a script never shows here: the open row has it.
export function toolHead(use: Block): ToolHead {
  const inp = inputOf(use)
  const name = use.name ?? 'tool'
  const file = str(inp, 'file_path') || str(inp, 'notebook_path') || str(inp, 'path')
  const fileHead = (verb: string): ToolHead => ({ verb, target: baseName(file), mono: true, tip: file })
  const said = oneLine(str(inp, 'description'))
  switch (name) {
    case 'Read':
      return fileHead('Read')
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return fileHead('Edit')
    case 'Write':
      return fileHead('Write')
    case 'Bash':
    case 'PowerShell':
      return { verb: said || commandLabel(str(inp, 'command')), target: '', mono: false, tip: '' }
    case 'Grep':
      return { verb: said || 'Search the code', target: '', mono: false, tip: '' }
    case 'Glob':
      return { verb: said || 'Find files', target: '', mono: false, tip: '' }
    case 'WebFetch': {
      const url = str(inp, 'url')
      const host = /^https?:\/\/(www\.)?([^/?#]+)/.exec(url)?.[2] ?? ''
      return { verb: 'Read a web page', target: host, mono: false, tip: url }
    }
    case 'WebSearch':
      return { verb: 'Search the web', target: oneLine(str(inp, 'query')), mono: false, tip: str(inp, 'query') }
    case 'Task':
    case 'Agent':
      return { verb: said || 'Run an agent', target: '', mono: false, tip: '' }
    case 'TodoWrite': {
      const n = Array.isArray(inp.todos) ? inp.todos.length : 0
      return { verb: 'Update the to-do list', target: n ? `${n} item${n === 1 ? '' : 's'}` : '', mono: false, tip: '' }
    }
  }
  // Any other tool: its description, else its name in words (MCP tools
  // are mcp__server__tool: the tool, and the server as a tip). Its input
  // (often code or a query) waits in the open row.
  if (said) return { verb: said, target: '', mono: false, tip: '' }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  const words = (s: string) => {
    const w = s.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    return w[0].toUpperCase() + w.slice(1)
  }
  if (mcp) return { verb: words(mcp[2]), target: '', mono: false, tip: mcp[1] }
  return { verb: words(name), target: '', mono: false, tip: '' }
}

// --- Diffs ---------------------------------------------------------------

export type DiffLine = { op: ' ' | '+' | '-'; text: string }

const lines = (s: string) => {
  if (!s) return []
  const l = s.split(/\r?\n/)
  if (l.at(-1) === '') l.pop()
  return l
}

// Past this many cells the middle of a change is shown as removed then
// added, without matching lines inside it (an edit is rarely that big).
const lcsLimit = 250_000

// lineDiff is the change from a to b, line by line: lines in both are
// context, the rest removed (-) or added (+), removals first.
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = lines(a)
  const y = lines(b)
  let pre = 0
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
  let suf = 0
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++
  const out: DiffLine[] = x.slice(0, pre).map((text) => ({ op: ' ', text }))
  const xm = x.slice(pre, x.length - suf)
  const ym = y.slice(pre, y.length - suf)
  const n = xm.length
  const m = ym.length
  if (n && m && n * m <= lcsLimit) {
    // Longest common subsequence, then walked from the start.
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) t[i * w + j] = xm[i] === ym[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && xm[i] === ym[j]) {
        out.push({ op: ' ', text: xm[i++] })
        j++
      } else if (j >= m || (i < n && t[(i + 1) * w + j] >= t[i * w + j + 1])) out.push({ op: '-', text: xm[i++] })
      else out.push({ op: '+', text: ym[j++] })
    }
  } else {
    for (const text of xm) out.push({ op: '-', text })
    for (const text of ym) out.push({ op: '+', text })
  }
  for (const text of x.slice(x.length - suf)) out.push({ op: ' ', text })
  return out
}

export type EditChange = { path: string; hunks: DiffLine[][]; add: number; del: number }

// editChange is what an Edit, MultiEdit, Write or NotebookEdit call
// changes, from its input (the file itself is not at hand): undefined for
// other tools.
export function editChange(use: Block): EditChange | undefined {
  const inp = inputOf(use)
  const path = str(inp, 'file_path') || str(inp, 'notebook_path')
  let hunks: DiffLine[][]
  switch (use.name) {
    case 'Edit':
      hunks = [lineDiff(str(inp, 'old_string'), str(inp, 'new_string'))]
      break
    case 'MultiEdit':
      hunks = (Array.isArray(inp.edits) ? (inp.edits as Input[]) : []).map((e) => lineDiff(str(e, 'old_string'), str(e, 'new_string')))
      break
    case 'Write':
      hunks = [lines(str(inp, 'content')).map((text) => ({ op: '+', text }))]
      break
    case 'NotebookEdit':
      hunks = [lines(str(inp, 'new_source')).map((text) => ({ op: '+', text }))]
      break
    default:
      return undefined
  }
  let add = 0
  let del = 0
  for (const h of hunks) for (const l of h) l.op === '+' ? add++ : l.op === '-' && del++
  return { path, hunks, add, del }
}

// --- Runs of calls ---------------------------------------------------------

export type Segment = { kind: 'part'; part: Part; at: number } | { kind: 'tools'; parts: Part[]; at: number }

// segments folds each run of three or more tool calls in a reply (with the
// thinking between them) into one; text and lone calls stay as they are.
export function segments(parts: Part[]): Segment[] {
  const out: Segment[] = []
  let i = 0
  while (i < parts.length) {
    if (parts[i].kind !== 'tool') {
      out.push({ kind: 'part', part: parts[i], at: i })
      i++
      continue
    }
    // From this call to the last call before the next text or media.
    let end = i
    let tools = 0
    for (let j = i; j < parts.length && (parts[j].kind === 'tool' || parts[j].kind === 'thinking'); j++) {
      if (parts[j].kind === 'tool') {
        end = j
        tools++
      }
    }
    if (tools >= 3) {
      out.push({ kind: 'tools', parts: parts.slice(i, end + 1), at: i })
      i = end + 1
    } else {
      out.push({ kind: 'part', part: parts[i], at: i })
      i++
    }
  }
  return out
}

export type RunSummary = { steps: number; files: number; add: number; del: number; failed: number; running: number; label: string; phrases: [string, string][] }

// What each kind of call did, for a run's line: a verb and its noun.
const kinds: [RegExp, string, string, string][] = [
  [/^Read$/, 'read', 'file', 'files'],
  [/^(Edit|MultiEdit|Write|NotebookEdit)$/, 'edited', 'file', 'files'],
  [/^(Bash|PowerShell)$/, 'ran', 'command', 'commands'],
  [/^(Grep|Glob|WebSearch)$/, 'ran', 'search', 'searches'],
  [/^WebFetch$/, 'fetched', 'page', 'pages'],
  [/^(Task|Agent)$/, 'ran', 'agent', 'agents'],
]

// summary is a run's line: what its calls did in words ("Read 3 files ·
// edited 2 files · ran 1 command"), lines added and removed, and how many
// failed or are still going.
export function summary(parts: Part[]): RunSummary {
  const files = new Set<string>()
  const s: RunSummary = { steps: 0, files: 0, add: 0, del: 0, failed: 0, running: 0, label: '', phrases: [] }
  // Per kind: the calls, or for edits and reads the distinct files.
  const seen = new Map<number, Set<string>>()
  let other = 0
  for (const p of parts) {
    if (p.kind !== 'tool') continue
    s.steps++
    if (!p.result) s.running++
    else if (p.result.isError) s.failed++
    const ch = editChange(p.use)
    if (ch) {
      if (ch.path) files.add(ch.path)
      s.add += ch.add
      s.del += ch.del
    }
    const k = kinds.findIndex(([re]) => re.test(p.use.name ?? ''))
    if (k < 0) {
      other++
      continue
    }
    const inp = (p.use.input ?? {}) as Record<string, unknown>
    const key = k <= 1 && typeof inp.file_path === 'string' ? inp.file_path : String(s.steps)
    if (!seen.has(k)) seen.set(k, new Set())
    seen.get(k)!.add(key)
  }
  s.files = files.size
  // In the order the kinds are listed, agents next to commands. Each a
  // verb (the line sets it in bold) and what it was done to.
  for (const [k, set] of [...seen].sort((a, b) => a[0] - b[0])) {
    const [, verb, one, many] = kinds[k]
    s.phrases.push([verb, `${set.size} ${set.size === 1 ? one : many}`])
  }
  if (other) s.phrases.push(['', `${other} other ${other === 1 ? 'step' : 'steps'}`])
  if (s.phrases[0][0]) s.phrases[0][0] = s.phrases[0][0][0].toUpperCase() + s.phrases[0][0].slice(1)
  else s.phrases[0][1] = s.phrases[0][1][0].toUpperCase() + s.phrases[0][1].slice(1)
  s.label = s.phrases.map(([v, r]) => (v ? v + ' ' + r : r)).join(' · ')
  return s
}

// --- Errors ----------------------------------------------------------------

// readableError turns an API error ("API Error: 529 {"type":"error",...}")
// into words: a title that names the cause where it is a known one, and
// what to do, keeping the original for a Details toggle. Text that is not
// such an error comes back as it is, with no title and no raw part.
export function readableError(text: string): { title?: string; text: string; raw?: string } {
  const at = text.indexOf('{')
  if (at < 0) return { text }
  let body: { error?: { type?: string; message?: string }; message?: string; type?: string }
  try {
    body = JSON.parse(text.slice(at))
  } catch {
    return { text }
  }
  const err = body?.error ?? body
  const type = err?.type ?? ''
  const said = typeof err?.message === 'string' ? err.message.trim() : ''
  const later = 'Try again in a moment.'
  const known: Record<string, [string, string]> = {
    overloaded_error: ['The API is overloaded', later],
    rate_limit_error: ['The rate limit was reached', later],
    api_error: ['The API had an internal error', later],
    authentication_error: ['The API did not accept the login', ''],
    permission_error: ['The API refused this request', 'The account lacks permission for it.'],
    request_too_large: ['The request was too large', ''],
  }
  // The status code and the type stay in the original, under Details.
  if (known[type]) return { title: known[type][0], text: known[type][1], raw: text }
  return said ? { text: said[0].toUpperCase() + said.slice(1).replace(/([^.!?])$/, '$1.'), raw: text } : { text }
}
