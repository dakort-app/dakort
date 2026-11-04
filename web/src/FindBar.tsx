import type { RefObject } from 'react'

// FindBar sits under a document viewer's bar (PDF, Word): Enter goes to the
// next match, Shift+Enter or ↑ to the one before, × or Escape closes. The
// viewer does the finding; total is null until a search has run.
type Props = {
  label: string
  q: string
  onQuery: (q: string) => void
  total: number | null
  cur: number
  onStep: (back: boolean) => void
  onClose: () => void
  input: RefObject<HTMLInputElement | null>
}

export function FindBar({ label, q, onQuery, total, cur, onStep, onClose, input }: Props) {
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
          }
        }}
        placeholder={label}
        aria-label={label}
      />
      <span className="small faint">{total === null ? '' : total ? `${cur + 1} / ${total}` : 'no matches'}</span>
      <button type="button" className="btn small-btn" onClick={() => onStep(true)} aria-label="Previous match">
        ↑
      </button>
      <button type="submit" className="btn small-btn" aria-label="Next match">
        ↓
      </button>
      <button type="button" className="icon" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        ×
      </button>
    </form>
  )
}
