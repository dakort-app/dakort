import { useEffect, useState } from 'react'
import { getJSON } from './api'

// What "default" means on this machine: the model, effort, permission mode
// and prompt-cache lifetime the user's Claude settings name, and, when
// Codex is installed, its models and its config's defaults. Fetched once
// per page.
export type ClaudeModel = { id: string; full: string; label: string; desc?: string; efforts?: string[] }
export type CodexModel = { id: string; label: string; description?: string; efforts?: string[]; defaultEffort?: string }
export type Config = {
  defaultModel?: string
  defaultEffort?: string
  defaultMode?: string
  cacheTtl?: string
  claude?: { models: ClaudeModel[]; defaultModel?: string } // from the CLI; absent until it answers
  codex?: { models: CodexModel[]; defaultModel?: string; defaultEffort?: string }
  clis?: CLI[]
  autoUpdate?: boolean // the server installs newer releases by itself
}

// A CLI the app runs: whether it is installed here and, if not, the
// command that installs it and where to type it. The app never installs
// one itself.
export type CLI = { name: 'claude' | 'codex'; found: boolean; install?: string; shell: string; signIn: string }

export const releasesURL = 'https://github.com/dakort-app/dakort/releases'

let config: Promise<Config> | null = null
export const loadConfig = () => (config ??= getJSON<Config>('/api/config').catch(() => ({})))

// A page can stay open for days, and the CLI's models change under it (a
// CLI update brings a new one). refreshConfig asks again, at most once a
// minute, and hands the answer to everything that showed the old one; a
// failed ask keeps what there is. The server holds the CLI's list for an
// hour, so asking often starts no CLI.
const listeners = new Set<(c: Config) => void>()
export const onConfig = (fn: (c: Config) => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
let asked = 0
export function refreshConfig(now = Date.now()) {
  if (now - asked < 60_000) return
  asked = now
  getJSON<Config>('/api/config')
    .then((c) => {
      config = Promise.resolve(c)
      listeners.forEach((fn) => fn(c))
    })
    .catch(() => {})
}

export function useConfig(): Config {
  const [cfg, setCfg] = useState<Config>({})
  useEffect(() => {
    loadConfig().then(setCfg)
    return onConfig(setCfg)
  }, [])
  return cfg
}

// The prompt cache's life: what the session's own replies say they wrote
// ("1h" or "5m"), else the settings (an hour unless they say 5m).
export const cacheLifeMs = (cfg: Config, life?: string) => ((life || cfg.cacheTtl) === '5m' ? 5 : 60) * 60_000
