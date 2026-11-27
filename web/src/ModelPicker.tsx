import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { loadConfig, onConfig, refreshConfig, useConfig, type ClaudeModel, type Config } from './config'
import { AgentIcon, ChevronDownIcon, GlobeIcon } from './icons'
import { MenuOption, MenuSwitch, PopMenu, RowText } from './PopMenu'
import { Button } from '@/components/ui/button'
import { menuItem } from '@/lib/menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { segItem, segList } from '@/lib/seg'

// The session's agent, model and settings in one panel above the composer,
// after the VS Code extension's picker. Empty means the CLI's own default
// (from the user's Claude settings, or Codex's config).
//
// The agent is chosen when a session starts. A new session's panel has a
// switch atop it, Claude's mark and OpenAI's, that turns between two
// pages: Claude's models and the models Codex offers the account. It opens
// on the agent picked so far; turning the page picks nothing, and a model
// on the other page makes the session that agent's, in place (onSwitch).
// A session with history keeps its agent (a transcript cannot change
// hands): its panel is its own agent's page alone, no switch.
//
// Each page has the same layout: Default and the newest models (the rest
// behind More models), then the settings that apply to that agent (effort
// for both, a compact menu on its row; for Claude also Chrome and, once
// the session exists, compaction when idle), each a label with a short
// caption under it. Ultracode is not offered here (review of 2026-11-24).

export type Choice = { model: string; effort: string; ultracode: boolean; chrome: boolean }

// The Claude list comes from the CLI's own answer (GET /api/config); this
// one stands in until it arrives, and when the CLI cannot be asked.
const fallback: ClaudeModel[] = [
  { id: 'opus', full: 'claude-opus-5-5', label: 'Opus 5.5', desc: 'Complex work and everyday tasks' },
  { id: 'fable', full: 'claude-fable-5-2', label: 'Fable 5.2', desc: 'The hardest problems' },
  { id: 'sonnet', full: 'claude-sonnet-5-5', label: 'Sonnet 5.5', desc: 'Efficient for simpler tasks' },
  { id: 'haiku', full: 'claude-haiku-5-5', label: 'Haiku 5.5', desc: 'Fastest, for quick answers' },
]
let models = fallback
const take = (cfg: Config) => {
  if (cfg.claude?.models.length) models = cfg.claude.models
}
loadConfig().then(take)
onConfig(take) // a later answer (the panel asks again as it opens)
const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
const effortLabel = (e: string) => (e === 'xhigh' ? 'XHigh' : e ? e[0].toUpperCase() + e.slice(1) : 'Default')

// rowOf splits the CLI's line for a model ("Opus 5.5 · Best for everyday,
// complex tasks · $4/$20 per Mtok") into the row's parts: the name with
// its version, then what it is for with the price after it, as the
// caption (the row has no tip: it would cover the rows below).
export function rowOf(label: string, desc: string) {
  const bits = desc.split(' · ').map((b) => b.trim()).filter(Boolean)
  let name = label
  // (Only a part of its own: "GPT-6.1 Terra Codex model." is a caption.)
  if (bits.length > 1 && bits[0].toLowerCase().startsWith(label.toLowerCase())) name = bits.shift()!
  return { name, caption: bits.join(' · ') }
}

export const modelLabel = (id: string) => models.find((m) => m.id === id)?.label ?? id

// aliasOf turns a full model id from a transcript (claude-opus-5-5) into
// the picker's alias, only when the alias names that very model; an older
// one (claude-opus-4-1) keeps its id, so continuing does not switch it.
export const aliasOf = (id: string) => models.find((m) => id === m.full || id.startsWith(m.full + '['))?.id ?? id

type Agent = 'claude' | 'codex'
const agents: Agent[] = ['claude', 'codex']
const agentName = (p: string) => (p === 'codex' ? 'Codex' : 'Claude')

type Props = {
  value: Choice
  provider: string
  onChange: (c: Choice) => void // a pick of the session's own agent
  // A model of the other agent, in a new session: it becomes that agent's.
  // Absent for a session with history, which shows its own agent only.
  onSwitch?: (provider: string, c: Choice) => void
  // The session's compaction when idle (Claude, an existing session only).
  idleCompact?: { on: boolean; toggle: () => void }
}

export function ModelPicker({ value, onChange, onSwitch, provider, idleCompact }: Props) {
  const cfg = useConfig()
  const current: Agent = provider === 'codex' ? 'codex' : 'claude'
  // The page on show: the session's agent's as the panel opens.
  const [page, setPage] = useState<Agent>(current)
  const tabs = useRef<Partial<Record<Agent, HTMLButtonElement | null>>>({})
  const uid = useId()
  const lists = {
    claude: (cfg.claude?.models.length ? cfg.claude.models : models).map((m) => ({ id: m.id, label: m.label, desc: m.desc ?? '' })),
    codex: (cfg.codex?.models ?? []).map((m) => ({ id: m.id, label: m.label, desc: m.description ?? '' })),
  }
  const labelOf = (p: Agent, id: string) => (p === 'codex' ? lists.codex.find((m) => m.id === id)?.label ?? id : modelLabel(id))
  // Claude's default: the settings' pick, else what the CLI says "default"
  // means. (The settings may name a full id, claude-opus-5-5: shown by its name.)
  const defaultOf = (p: Agent) => (p === 'codex' ? cfg.codex?.defaultModel : aliasOf(cfg.defaultModel || cfg.claude?.defaultModel || '')) ?? ''
  // What Default is, and where that comes from: the user's settings, else
  // the CLI's own pick (Claude's; Codex's comes from its config).
  const defaultCaption = (p: Agent) => {
    const def = defaultOf(p)
    if (!def) return `From your ${agentName(p)} settings`
    const fromSettings = p === 'codex' || !!cfg.defaultModel
    return `${labelOf(p, def)} (${fromSettings ? 'from your settings' : `${agentName(p)}'s default`})`
  }
  const codex = current === 'codex'
  const who = agentName(current)
  const defaultEffort = (codex ? cfg.codex?.defaultEffort : cfg.defaultEffort) ?? ''

  const shownModel = value.model || defaultOf(current)
  // The chip names the effort only when one applies (picked here, or set
  // in the settings): "Opus · Default" read as if Default were the model.
  const shownEffort = value.effort || defaultEffort
  const chip = (shownModel ? labelOf(current, shownModel) : 'Default') + (shownEffort ? ' · ' + effortLabel(shownEffort) : '')

  // Why an agent's models cannot be picked: not installed, or (Codex)
  // installed but it listed no models, which is how a missing sign-in shows.
  const blocked = (p: Agent): ReactNode => {
    const cli = cfg.clis?.find((c) => c.name === p)
    if (cli && !cli.found)
      return (
        <>
          Not installed. In {cli.shell}, run <code>{cli.install}</code>, then run <code>{cli.signIn}</code> once to sign in, and reload this page.
        </>
      )
    if (p === 'codex' && !cfg.codex)
      return cfg.clis ? (
        <>
          Codex listed no models. Run <code>codex</code> once in a terminal to sign in, then reload this page.
        </>
      ) : (
        'Asking Codex for its models…'
      )
    return null
  }

  // A page's settings, under its models: the same rows for both agents,
  // each where it applies (effort for both; Chrome, and compaction once
  // the session exists, for Claude). On the other agent's page a change
  // makes the session that agent's, as a model picked there does.
  const settings = (p: Agent, v: Choice, set: (c: Choice) => void) => {
    const isCodex = p === 'codex'
    const defEffort = (isCodex ? cfg.codex?.defaultEffort : cfg.defaultEffort) ?? ''
    const steps = (isCodex && cfg.codex?.models.find((m) => m.id === (v.model || defaultOf('codex')))?.efforts) || efforts
    return (
      <div className="picker-settings">
        {/* Effort as one row with its label, a compact menu at its end
            (Cursor's and Claude desktop's way), not a strip of six. */}
        <div className="picker-row static setting-row px-2 pointer-coarse:px-3">
          <RowText label="Effort" caption="How hard it thinks" />
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="effort-select h-7 min-w-24 justify-between gap-1 px-2.5 font-normal" data-item aria-label={'Effort: ' + effortLabel(v.effort)}>
                {effortLabel(v.effort)}
                <ChevronDownIcon sm />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="effort-menu min-w-36">
              <DropdownMenuRadioGroup value={v.effort || 'default'} onValueChange={(e) => set({ ...v, effort: e === 'default' ? '' : e })}>
                <DropdownMenuRadioItem value="default">
                  Default
                  {defEffort && <span className="ml-auto pl-3 text-xs text-muted-foreground">{effortLabel(defEffort)}</span>}
                </DropdownMenuRadioItem>
                <DropdownMenuSeparator />
                {steps.map((e) => (
                  <DropdownMenuRadioItem key={e} value={e}>
                    {effortLabel(e)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Ultracode is not offered; a session that has it on keeps a
            switch to turn it off. */}
        {!isCodex && v.ultracode && <MenuSwitch label="Ultracode" caption="On for this session" on onToggle={() => set({ ...v, ultracode: false })} />}
        {/* Off by default: its 18 tools cost context on every turn. */}
        {!isCodex && <MenuSwitch label="Chrome" caption="Browse with Claude in Chrome" on={v.chrome} onToggle={() => set({ ...v, chrome: !v.chrome })} />}
        {!isCodex && p === current && idleCompact && (
          <MenuSwitch label="Compact when idle" caption="Summarise before the cache expires" on={idleCompact.on} onToggle={idleCompact.toggle} />
        )}
      </div>
    )
  }

  // The models a page shows at first: Default, the newest of each family
  // (GPT-6.2-Sol over GPT-6.1-Sol, Opus 5.5 over an older Opus) and the one
  // in use; the rest wait behind More models.
  const [more, setMore] = useState<Partial<Record<Agent, boolean>>>({})
  const firstOf = <M extends { id: string; label: string }>(list: M[], inUse: string): M[] => {
    const ver = (l: string) => parseFloat(/(\d+(?:\.\d+)?)/.exec(l)?.[1] ?? '0')
    const fam = (l: string) => l.replace(/[\d.\s-]+/g, ' ').trim().toLowerCase()
    const best = new Map<string, number>()
    for (const m of list) best.set(fam(m.label), Math.max(best.get(fam(m.label)) ?? 0, ver(m.label)))
    const top = list.filter((m) => ver(m.label) === best.get(fam(m.label)) || m.id === inUse)
    return top.length >= list.length - 1 ? list : top
  }

  const body = (p: Agent) => {
    const mine = p === current
    const name = agentName(p)
    const why = blocked(p)
    const shown = !onSwitch || p === page
    const pick = (id: string) => {
      if (mine) return onChange({ ...value, model: id })
      onSwitch?.(p, { model: id, effort: '', ultracode: false, chrome: false })
    }
    const v: Choice = mine ? value : { model: '', effort: '', ultracode: false, chrome: false }
    const set = (c: Choice) => (mine ? onChange(c) : onSwitch?.(p, c))
    const all = lists[p]
    const first = firstOf(all, mine ? value.model : '')
    const rows = more[p] ? all : first
    // Both pages lie in one cell of a grid, the one not on show hidden and
    // inert, so the panel is as tall as the taller page and never jumps as
    // the page turns.
    const tabbed = onSwitch ? { role: 'tabpanel', 'aria-labelledby': `${uid}-${p}-tab` } : {}
    return (
      <div
        key={p}
        id={`${uid}-${p}`}
        {...tabbed}
        className={'picker-page' + (shown ? ' on' : '') + (mine ? ' mine' : ' other') + (why ? ' off' : '')}
        data-agent={p}
        inert={!shown}
      >
        {why ? (
          <div className="picker-row picker-off faint small" aria-disabled="true">
            {why}
          </div>
        ) : (
          <>
            {/* A pick keeps the panel open: the effort is often set in the
                same visit, as in the VS Code picker. */}
            <div role="listbox" aria-label={`${name} model`}>
              <MenuOption stacked on={mine && value.model === ''} label="Default" desc={defaultCaption(p)} onPick={() => pick('')} />
              {rows.map((m) => {
                const r = rowOf(m.label, m.desc)
                return <MenuOption stacked key={m.id} on={mine && value.model === m.id} label={r.name} desc={r.caption} onPick={() => pick(m.id)} />
              })}
              {first.length < all.length && (
                <button type="button" data-item className={cn('picker-row more-models', menuItem, 'pointer-coarse:px-3')} aria-expanded={!!more[p]} onClick={() => setMore({ ...more, [p]: !more[p] })}>
                  <ChevronDownIcon sm />
                  {more[p] ? 'Fewer models' : `More models (${all.length - first.length})`}
                </button>
              )}
            </div>
            {settings(p, v, set)}
          </>
        )}
      </div>
    )
  }

  // Turning the page: from the top of the list, and the focus on its tab.
  const turn = (p: Agent, focus = false) => {
    const panel = tabs.current[p]?.closest<HTMLElement>('.picker-panel')
    setPage(p)
    if (panel) panel.scrollTop = 0
    if (focus) tabs.current[p]?.focus()
  }
  // Left and Right turn the page from anywhere in the panel (two pages, so
  // either way is the other one); Up and Down stay the list's.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    turn(page === 'claude' ? 'codex' : 'claude', true)
  }

  const extras = [value.ultracode && !codex && 'Ultracode on', value.chrome && !codex && 'Chrome on'].filter(Boolean)
  return (
    <PopMenu
      className="model-menu"
      sheetTitle="Model and settings"
      label={`Model and settings: ${who}, ${chip}${extras.length ? ', ' + extras.join(', ') : ''}`}
      onOpen={() => {
        setPage(current)
        refreshConfig() // in the background; the panel shows what it has
      }}
      chip={
        <>
          <AgentIcon provider={current} size={12} />
          {chip}
          {value.chrome && !codex && (
            <span className="chip-chrome">
              <GlobeIcon />
            </span>
          )}
        </>
      }
    >
      {onSwitch ? (
        <div className="picker-paged" onKeyDown={onKey}>
          {/* Pinned atop the panel while a page scrolls (a phone's). */}
          <div className="picker-tabs">
            <div className={cn('picker-seg', segList, 'flex w-full')} role="tablist" aria-label="Agent">
              {agents.map((p) => (
                <button
                  key={p}
                  ref={(el) => {
                    tabs.current[p] = el
                  }}
                  type="button"
                  id={`${uid}-${p}-tab`}
                  role="tab"
                  aria-selected={page === p}
                  aria-controls={`${uid}-${p}`}
                  tabIndex={page === p ? 0 : -1}
                  data-item
                  data-agent={p}
                  className={cn('picker-tab', segItem, page === p && 'on')}
                  onClick={() => turn(p)}
                >
                  <AgentIcon provider={p} size={12} />
                  {agentName(p)}
                </button>
              ))}
            </div>
          </div>
          {agents.map((p) => body(p))}
        </div>
      ) : (
        <div className="picker-paged">{body(current)}</div>
      )}
    </PopMenu>
  )
}
