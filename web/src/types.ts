// The server's JSON, as internal/transcript, internal/index and
// internal/server/hub.go define it.

export type Block = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  isError?: boolean
  content?: Block[]
  mediaType?: string
  asset?: string
  size?: number
}

export type Row = {
  uuid: string
  parent?: string
  role: 'user' | 'assistant' | 'system'
  time: string
  offset: number
  end: number
  meta?: boolean
  compactSummary?: boolean
  sidechain?: boolean
  messageId?: string
  model?: string
  stopReason?: string
  apiError?: boolean
  context?: number // prompt size of the call that wrote an assistant row
  cacheTtl?: string // the prompt cache that call wrote to: "1h" or "5m"
  window?: number // the model's context window, where the transcript says (Codex)
  subtype?: string
  level?: string
  preTokens?: number // compact_boundary: context before
  postTokens?: number // and after, when the CLI records it
  content?: string
  blocks?: Block[]
}

export type Page = { rows: Row[]; atStart?: boolean; next: number }

export type Session = {
  id: string
  provider: string
  title: string
  cwd: string
  project: string
  created: string
  updated: string
  seen?: string // read up to this updated time, on any device; unread when updated is later
  size: number
  heldBy?: number
  used?: { model?: string; mode?: string } // what it last ran with, from its transcript, whoever sent it
  folder?: string
  running?: boolean
  model?: string
  effort?: string
  ultracode?: boolean
  chrome?: boolean // Claude in Chrome on for its turns
  permissionMode?: string
  idleCompact?: boolean // compacted shortly before its prompt cache expires; on unless switched off
}

export type Folder = {
  path: string
  open?: boolean
  updated?: string
  sessions: number
  running?: boolean
  missing?: boolean
}

// A renamed folder, old path to new (move.go).
export type Move = { from: string; to: string }

// A process a session's turn started and left running (leftovers.go).
export type Leftover = { pid: number; name: string; command?: string; dir?: string; started?: string }
// One named outside its session: a rename refused by it.
export type LeftoverRef = Leftover & { session: string; title?: string }

export type Permission = {
  id: string
  tool: string
  input?: unknown
  description?: string
  reason?: string
  blockedPath?: string
}

export type Result = {
  ok: boolean
  interrupted?: boolean
  text?: string
  errors?: string[]
  reason?: string
  costUsd?: number
  usage?: Record<string, unknown>
  model?: string // the turn's model
  contextWindow?: number // its context window in tokens, when the CLI said
  signIn?: boolean // failed as the CLI is not signed in
}

export type LiveBlock = { kind: 'text' | 'thinking'; text: string }

// A background command or monitor the session's CLI runs between turns.
export type Task = { id: string; type: string; description: string }

// A message sent while a turn ran, waiting on the server (queue.go).
export type Queued = { promptId: string; text: string; images?: number; error?: string }

export type LiveTurnJSON = {
  session: string
  promptId?: string
  state: 'starting' | 'running'
  blocks?: Record<string, LiveBlock>
  permissions?: Permission[]
}

export type Ev = {
  type: string
  session?: string
  promptId?: string
  state?: string
  index?: number
  kind?: string
  text?: string
  uuid?: string
  permission?: Permission
  requestId?: string
  decision?: string
  result?: Result
  error?: string
  turns?: LiveTurnJSON[]
  tasks?: Task[] // tasks: the session's background tasks now
  background?: Record<string, Task[]> // snapshot: every session's
  queue?: Queued[] // queue: the session's queued messages now
  queues?: Record<string, Queued[]> // snapshot: every session's
  leftovers?: Leftover[] // leftovers: what the session's last turn left running
  allLeftovers?: Record<string, Leftover[]> // snapshot: every session's
  gap?: boolean
  idle?: boolean // turn: an idle compaction the server started
  folder?: string // tabs: the folder whose open tabs changed
  tabs?: string[] // tabs: its open tabs now (absent: none)
  build?: string // snapshot: the server's version; a page from another build reloads itself once hidden
  latest?: string // release, snapshot: a newer release's tag
  update?: string // release, snapshot: the tag the server is installing by itself (not shown; the page stays quiet)
}
