import type { RefObject } from 'react'
import { Tool } from './FileView'
import type { FindOpts } from './pdffind'
import { CloseIcon, DownIcon, UpIcon } from './viewicons'
import { toolClass } from '@/lib/tool'
import { Input } from '@/components/ui/input'

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
      <Input
        ref={input}
        className="filter h-7 px-2 pointer-coarse:h-11"
        autoFocus
        value={q}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter') {
            // By hand, not the form's submit: with no matches yet the
            // arrows are disabled, and a disabled default button would
            // stop Enter from searching at all.
            e.preventDefault()
            onStep(e.shiftKey)
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
        className={toolClass({ on: opts.matchCase, className: 'find-opt' })}
        aria-pressed={!!opts.matchCase}
        onClick={() => flip('matchCase')}
        title="Match case"
      >
        Aa
      </button>
      <button
        type="button"
        className={toolClass({ on: opts.wholeWord, className: 'find-opt word' })}
        aria-pressed={!!opts.wholeWord}
        onClick={() => flip('wholeWord')}
        title="Whole word"
      >
        ab
      </button>
      <span className="find-count">{total === null ? '' : total ? `${cur + 1} / ${total}` : 'No matches'}</span>
      <Tool label="Previous match" keys="Shift+Enter" icon={<UpIcon />} className="bare" disabled={!total} onClick={() => onStep(true)} />
      <Tool label="Next match" keys="Enter" icon={<DownIcon />} className="bare" disabled={!total} onClick={() => onStep(false)} />
      <Tool label="Close find" keys="Esc" icon={<CloseIcon />} className="bare" onClick={onClose} />
    </form>
  )
}
