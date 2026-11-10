import type { RefObject } from 'react'
import type { FindOpts } from './pdffind'

// FindBar sits under a document viewer's bar (PDF, Word): Enter or ↓ finds
// downward from the view, Shift+Enter or ↑ upward, × or Escape closes. Aa
// matches case, ab whole words only (Alt+C and Alt+W, as in VS Code). The
// viewer does the finding; total is null until a search has run.
type Props = {
  label: string
  q: string
  onQuery: (q: string) => void
  opts: FindOpts
  onOpts: (o: FindOpts) => void
  total: number | null
  cur: number
  onStep: (back: boolean) => void
  onClose: () => void
  input: RefObject<HTMLInputElement | null>
}

export function FindBar({ label, q, onQuery, opts, onOpts, total, cur, onStep, onClose, input }: Props) {
  const flip = (k: keyof FindOpts) => onOpts({ ...opts, [k]: !opts[k] })
  return (
    <form
      className="pdf-find"
      onSubmit={(e) => {
        e.preventDefault()
        onStep(false)
      }}
    >
      <input
        ref={input}
        className="filter"
        autoFocus
        value={q}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault()
            onStep(true)
          } else if (e.altKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'w')) {
            e.preventDefault()
            flip(e.key.toLowerCase() === 'c' ? 'matchCase' : 'wholeWord')
          }
        }}
        placeholder={label}
        aria-label={label}
      />
      <button
        type="button"
        className={'btn small-btn find-opt' + (opts.matchCase ? ' on' : '')}
        aria-pressed={!!opts.matchCase}
        onClick={() => flip('matchCase')}
        title="Match case (Alt+C)"
      >
        Aa
      </button>
      <button
        type="button"
        className={'btn small-btn find-opt word' + (opts.wholeWord ? ' on' : '')}
        aria-pressed={!!opts.wholeWord}
        onClick={() => flip('wholeWord')}
        title="Whole words only (Alt+W)"
      >
        ab
      </button>
      <span className="small faint">{total === null ? '' : total ? `${cur + 1} / ${total}` : 'no matches'}</span>
      <button type="button" className="btn small-btn" onClick={() => onStep(true)} aria-label="Previous match" title="Find upward (Shift+Enter)">
        ↑
      </button>
      <button type="submit" className="btn small-btn" aria-label="Next match" title="Find downward (Enter)">
        ↓
      </button>
      <button type="button" className="icon" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        ×
      </button>
    </form>
  )
}
