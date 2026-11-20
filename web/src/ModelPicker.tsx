import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { loadConfig, useConfig, type ClaudeModel, type Config } from './config'
import { AgentIcon, GlobeIcon } from './icons'
import { MenuOption, MenuSwitch, PopMenu, RowText } from './PopMenu'

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
// The session's page carries the check and its settings (effort; for
// Claude also Ultracode, Chrome and, once the session exists, compaction
// when idle), each a label with a short caption under it and the full
// explanation in its tooltip.

export type Choice = { model: string; effort: string; ultracode: boolean; chrome: boolean }

// The Claude list comes from the CLI's own answer (GET /api/config); this
// one stands in until it arrives, and when the CLI cannot be asked.
const fallback: ClaudeModel[] = [
  { id: 'opus', full: 'claude-opus-5-5', label: 'Opus 5.5', desc: 'Complex work and everyday tasks' },
  { id: 'fable', full: 'claude-fable-5-1', label: 'Fable 5.1', desc: 'The hardest problems' },
  { id: 'sonnet', full: 'claude-sonnet-5-5', label: 'Sonnet 5.5', desc: 'Efficient for simpler tasks' },
  { id: 'haiku', full: 'claude-haiku-5-5', label: 'Haiku 5.5', desc: 'Fastest, for quick answers' },
]
let models = fallback
loadConfig().then((cfg: Config) => {
  if (cfg.claude?.models.length) models = cfg.claude.models
})
const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
const effortLabel = (e: string) => (e === 'xhigh' ? 'XHigh' : e ? e[0].toUpperCase() + e.slice(1) : 'Default')

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
  const codex = current === 'codex'
  const who = agentName(current)
  const defaultEffort = (codex ? cfg.codex?.defaultEffort : cfg.defaultEffort) ?? ''
  // Codex's models each say which efforts they take.
  const steps = (codex && cfg.codex?.models.find((m) => m.id === (value.model || defaultOf('codex')))?.efforts) || efforts

  const shownModel = value.model || defaultOf(current)
  const chip = (shownModel ? labelOf(current, shownModel) : 'Default') + ' · ' + effortLabel(value.effort || defaultEffort)

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

  // The session's own settings, under its models.
  const settings = () => (
    <>
      <div className="picker-row static" title={`How much the model thinks before it answers. Default leaves it to ${who} for the model${defaultEffort ? ` (${effortLabel(defaultEffort)} here)` : ''}.`}>
        <RowText label="Effort" caption="How hard it thinks" />
        {/* Default sends no --effort and the CLI picks; it sat at the
            left of the scale and read as the lowest, so it stands apart. */}
        <button
          type="button"
          data-item
          className={'effort-default' + (value.effort === '' ? ' on' : '')}
          title={`Whatever ${who} picks for the model`}
          aria-label="Effort Default"
          aria-pressed={value.effort === ''}
          onClick={() => onChange({ ...value, effort: '' })}
        >
          Default
        </button>
        <div className="effort">
          {steps.map((e) => (
            <button
              type="button"
              key={e}
              data-item
              className={'effort-step' + (value.effort === e ? ' on' : '')}
              title={effortLabel(e)}
              aria-label={'Effort ' + effortLabel(e)}
              aria-pressed={value.effort === e}
              onClick={() => onChange({ ...value, effort: e })}
            />
          ))}
        </div>
      </div>
      {!codex && (
        <MenuSwitch
          label="Ultracode"
          caption="Multi-agent workflows"
          title="Ultracode: the session's turns run multi-agent workflows."
          on={value.ultracode}
          onToggle={() => onChange({ ...value, ultracode: !value.ultracode })}
        />
      )}
      {/* Off by default: its 18 tools cost context on every turn. */}
      {!codex && (
        <MenuSwitch
          label="Chrome"
          caption="Browse with Claude in Chrome"
          title="Drive your Chrome through the Claude extension. Off by default: its tools cost context on every turn."
          on={value.chrome}
          onToggle={() => onChange({ ...value, chrome: !value.chrome })}
        />
      )}
      {!codex && idleCompact && (
        <MenuSwitch
          label="Compact when idle"
          caption="Summarise before the cache expires"
          title="Over 200k tokens, compact the session about 5 minutes before its prompt cache expires, so a later message reads a short summary instead of the whole context."
          on={idleCompact.on}
          onToggle={idleCompact.toggle}
        />
      )}
    </>
  )

  const body = (p: Agent) => {
    const mine = p === current
    const name = agentName(p)
    const why = blocked(p)
    const shown = !onSwitch || p === page
    const pick = (id: string) => {
      if (mine) return onChange({ ...value, model: id })
      onSwitch?.(p, { model: id, effort: '', ultracode: false, chrome: false })
    }
    const def = defaultOf(p)
    // One page at a time, each as tall as its own rows (the panel scrolls
    // past its max height); the one not on show is out of the layout and
    // inert (no focus, no arrows).
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
              {[{ id: '', label: 'Default (recommended)', desc: def ? labelOf(p, def) : `From your ${name} settings` }, ...lists[p]].map((m) => (
                <MenuOption key={m.id || 'default'} on={mine && value.model === m.id} label={m.label} desc={m.desc} onPick={() => pick(m.id)} />
              ))}
            </div>
            {mine && settings()}
          </>
        )}
      </div>
    )
  }

  // Each page has its own height, and the panel grows and shrinks from its
  // top (it hangs above the chip), so the switch would move as the page
  // turns. A mouse click keeps the panel's height until the pointer leaves
  // the switch, so it never slides away under the pointer (and a second
  // click lands on a tab, not a model). Taps and keys turn at once.
  const held = useRef<HTMLElement | null>(null)
  const viaMouse = useRef(false)
  const hold = (panel: HTMLElement) => {
    if (held.current === panel) return
    panel.style.height = panel.getBoundingClientRect().height + 'px' // border-box
    held.current = panel
  }
  const release = () => {
    if (held.current) held.current.style.height = ''
    held.current = null
  }
  // Turning the page: from the top of the list, and the focus on its tab.
  const turn = (p: Agent, focus = false) => {
    const panel = tabs.current[p]?.closest<HTMLElement>('.picker-panel')
    if (panel && viaMouse.current && p !== page) hold(panel)
    viaMouse.current = false
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
      label={`Model and settings: ${who}, ${chip}${extras.length ? ', ' + extras.join(', ') : ''}`}
      onOpen={() => {
        release()
        setPage(current)
      }}
      chip={
        <>
          <AgentIcon provider={current} size={12} />
          {chip}
          {value.ultracode && !codex && <span className="ultra-dot" title="Ultracode on" />}
          {value.chrome && !codex && (
            <span className="chip-chrome" title="Chrome on">
              <GlobeIcon />
            </span>
          )}
        </>
      }
    >
      {onSwitch ? (
        <div className="picker-paged" onKeyDown={onKey}>
          {/* Pinned atop the panel while a page scrolls (a phone's). */}
          <div className="picker-tabs" onPointerLeave={release}>
            <div className="picker-seg" role="tablist" aria-label="Agent">
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
                  className={'picker-tab' + (page === p ? ' on' : '')}
                  onPointerDown={(e) => (viaMouse.current = e.pointerType === 'mouse')}
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
