import { useEffect, useRef, useState } from 'react'
import { loadConfig, useConfig, type ClaudeModel, type Config } from './config'

// The model, effort and Ultracode for a session, chosen from a panel above
// the composer, after the VS Code extension's picker. Empty means the
// CLI's own default (from the user's Claude settings, or Codex's config).
// A Codex session lists the models Codex offers the account instead, and
// has no Ultracode.

export type Choice = { model: string; effort: string; ultracode: boolean }

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

export function ModelPicker({ value, onChange, provider }: { value: Choice; onChange: (c: Choice) => void; provider: string }) {
  const [open, setOpen] = useState(false)
  const cfg = useConfig()
  const panel = useRef<HTMLDivElement>(null)
  // Close on a tap outside.
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', off)
    return () => document.removeEventListener('pointerdown', off)
  }, [open])

  const codex = provider === 'codex'
  const who = codex ? 'Codex' : 'Claude'
  const list = codex
    ? (cfg.codex?.models ?? []).map((m) => ({ id: m.id, label: m.label, desc: m.description ?? '' }))
    : (cfg.claude?.models.length ? cfg.claude.models : models).map((m) => ({ id: m.id, label: m.label, desc: m.desc ?? '' }))
  const label = (id: string) => (codex ? list.find((m) => m.id === id)?.label ?? id : modelLabel(id))
  // Claude's default: the settings' pick, else what the CLI says "default" means.
  const defaultModel = (codex ? cfg.codex?.defaultModel : cfg.defaultModel || (cfg.claude?.defaultModel && aliasOf(cfg.claude.defaultModel))) ?? ''
  const defaultEffort = (codex ? cfg.codex?.defaultEffort : cfg.defaultEffort) ?? ''
  // Codex's models each say which efforts they take.
  const steps = (codex && cfg.codex?.models.find((m) => m.id === (value.model || defaultModel))?.efforts) || efforts

  const shownModel = value.model || defaultModel
  const chip = (shownModel ? label(shownModel) : 'Default') + ' · ' + effortLabel(value.effort || defaultEffort)

  return (
    <span className="picker" ref={panel}>
      <button className="chip-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        {chip}
        {value.ultracode && !codex && <span className="ultra-dot" title="Ultracode on" />}
      </button>
      {open && (
        <div className="picker-panel" role="listbox">
          <div className="picker-head faint small">Select a model</div>
          {[{ id: '', label: 'Default (recommended)', desc: defaultModel ? label(defaultModel) : `From your ${who} settings` }, ...list].map((m) => (
            <div
              key={m.id || 'default'}
              role="option"
              aria-selected={value.model === m.id}
              className={'picker-row' + (value.model === m.id ? ' on' : '')}
              onClick={() => onChange({ ...value, model: m.id })}
            >
              <div className="grow">
                <div>{m.label}</div>
                <div className="faint small">{m.desc}</div>
              </div>
              {value.model === m.id && <span className="check">✓</span>}
            </div>
          ))}
          <div className="picker-row static">
            <div className="grow">
              Effort <span className="faint">({effortLabel(value.effort || defaultEffort)})</span>
            </div>
            {/* Default sends no --effort and the CLI picks; it sat at the
                left of the scale and read as the lowest, so it stands apart. */}
            <button
              className={'effort-default' + (value.effort === '' ? ' on' : '')}
              title={`Whatever ${who} picks for the model`}
              aria-label="Effort Default"
              onClick={() => onChange({ ...value, effort: '' })}
            >
              Default
            </button>
            <div className="effort">
              {steps.map((e) => (
                <button
                  key={e}
                  className={'effort-step' + (value.effort === e ? ' on' : '')}
                  title={effortLabel(e)}
                  aria-label={'Effort ' + effortLabel(e)}
                  onClick={() => onChange({ ...value, effort: e })}
                />
              ))}
            </div>
          </div>
          {!codex && (
            <div className="picker-row static" onClick={() => onChange({ ...value, ultracode: !value.ultracode })}>
              <div className="grow">
                Ultracode <span className="faint small">multi-agent workflows</span>
              </div>
              <span className={'switch' + (value.ultracode ? ' on' : '')} role="switch" aria-checked={value.ultracode} />
            </div>
          )}
        </div>
      )}
    </span>
  )
}
