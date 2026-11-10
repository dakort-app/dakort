// How many tokens a model's context holds, for the composer's context bar.
//
// The real number comes from the CLI: every Claude turn's result lists each
// model it used with its contextWindow (modelUsage), and the server passes
// the turn's own on (result.model, result.contextWindow). The page keeps
// what it has seen per model in localStorage, so a session that has not
// run since still gets its model's real window.
//
// Until a model has run on this device, a table stands in: measured
// 2026-10-31 with /context (claude 2.1.299, a second account), which prints
// "Tokens: 18k / 1m" without an API call. The window can depend on the
// account and changes with releases, so anything not in it is a guess,
// marked as assumed.

export type Window = { tokens: number; assumed: boolean }

const M = 1_000_000
const K200 = 200_000

const measured: Record<string, number> = {
  'claude-opus-5-5': M,
  'claude-fable-5-1': M,
  'claude-sonnet-5-5': M,
  'claude-haiku-5-5': M,
  'claude-opus-5': M,
  'claude-sonnet-5': M,
  'claude-fable-5': M,
  'claude-opus-4-8': M,
  'claude-opus-4-7': M,
  'claude-opus-4-6': K200,
  'claude-sonnet-4-6': K200,
  'claude-haiku-4-5': K200,
}

// A dated id (claude-haiku-4-5-20251001) is its model.
const undated = (m: string) => m.replace(/-\d{8}$/, '')

// tableWindow is the stand-in for a model no turn has reported yet: the
// measured value, "[1m]" models (1M, as measured for claude-opus-4-6[1m]),
// else a guess by generation (Claude 5 models 1M, older 200k). Not for
// other agents' models: Codex's window is unknown until it says.
export function tableWindow(model: string): Window | null {
  if (!model) return null
  if (model.endsWith('[1m]')) return { tokens: M, assumed: false }
  const m = undated(model)
  if (m in measured) return { tokens: measured[m], assumed: false }
  if (!m.startsWith('claude-')) return null
  return { tokens: /^claude-[a-z]+-[5-9]/.test(m) ? M : K200, assumed: true }
}

const key = 'dakort.windows'
let seen: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}')
  } catch {
    return {}
  }
})()

// learnWindow keeps a window a turn reported (the turn's model as the CLI
// named it, and the bare id too, as transcripts name it without "[1m]").
export function learnWindow(model: string, tokens: number) {
  if (!model || !(tokens > 0)) return
  const next = { ...seen, [model]: tokens }
  if (!model.endsWith('[1m]')) next[undated(model)] = tokens
  if (JSON.stringify(next) === JSON.stringify(seen)) return
  seen = next
  try {
    localStorage.setItem(key, JSON.stringify(seen))
  } catch {
    // private mode: kept for this page only
  }
}

// windowFor: what a turn reported for the model, else what the transcript
// states (Codex's task_started), else the table.
export function windowFor(model: string | undefined, stated = 0, learned: Record<string, number> = seen): Window | null {
  const n = model ? (learned[model] ?? learned[undated(model)]) : 0
  if (n > 0) return { tokens: n, assumed: false }
  if (stated > 0) return { tokens: stated, assumed: false }
  return model ? tableWindow(model) : null
}
