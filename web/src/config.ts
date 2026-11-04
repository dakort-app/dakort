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
}

// A CLI the app runs: whether it is installed here and, if not, the
// command that installs it and where to type it. The app never installs
// one itself.
export type CLI = { name: 'claude' | 'codex'; found: boolean; install?: string; shell: string; signIn: string }

let config: Promise<Config> | null = null
export const loadConfig = () => (config ??= getJSON<Config>('/api/config').catch(() => ({})))

export function useConfig(): Config {
  const [cfg, setCfg] = useState<Config>({})
  useEffect(() => {
    loadConfig().then(setCfg)
  }, [])
  return cfg
}

// The prompt cache's life: what the session's own replies say they wrote
// ("1h" or "5m"), else the settings (an hour unless they say 5m).
export const cacheLifeMs = (cfg: Config, life?: string) => ((life || cfg.cacheTtl) === '5m' ? 5 : 60) * 60_000
