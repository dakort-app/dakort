import { createContext, Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileIcon, Icon } from './icons'
import { assetURL } from './api'
import type { Part } from './rows'
import type { Block } from './types'
import { editChange, summary, toolHead } from './tools'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

// Tool calls in the conversation. Each is one line (a verb in words, the
// file or command it acted on in the code face, an edit's +N −M) that
// opens to what it did: an edit as a diff, a command as a terminal, other
// calls as their fields. A command Claude described shows the description
// alone; its command waits in the open body. Several in a row fold into
// one line ("Ran 5 commands"), closed until tapped, while the turn runs
// too, so a reply reads as its prose.
// The bodies are built only when opened (some results are hundreds of KB).

// The open call's body is its own chunk, fetched the first time a call
// is opened (or a permission card shows), not in the first load.
const ToolBody = lazy(() => import('./ToolBody'))

// The session's project folder: paths inside it show from there.
export const ProjectRoot = createContext('')

export const Chevron = () => <Icon name="chevron-right" sm className="chev" />
// A call's status, the marks the project rows and tabs use: the spinner
// while it runs, a green dot once it passed, a red dot if it failed.
const RunMark = () => <span className="dot run" />
const DoneMark = () => <span className="dot done" />
const FailMark = () => <span className="dot failed" />
export const Cross = () => <Icon name="x" sm className="mark-x" />
// A notice's error mark: a circled cross, apart from the plain × that
// dismisses the same notice.
export const ErrorMark = () => <Icon name="circle-x" sm className="mark-x" />

// Counts is "+N −M", each part only when not zero.
export function Counts({ add, del }: { add: number; del: number }) {
  if (!add && !del) return null
  return (
    <span className="counts">
      {add > 0 && <span className="add">+{add}</span>}
      {del > 0 && <span className="del">−{del}</span>}
    </span>
  )
}

export function ToolRow({ use, result, live }: { use: Block; result?: Block; live: boolean }) {
  const [open, setOpen] = useState(false)
  const head = toolHead(use)
  const change = useMemo(() => editChange(use), [use])
  const failed = !!result?.isError
  const running = !result && live
  // A command shows in the open body's "$" block, so not twice.
  const shell = /^(Bash|PowerShell)$/.test(use.name ?? '')
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={'tool' + (failed ? ' failed' : !result ? ' pending' : ' ok')}>
      {/* The row is words only (toolHead): a command waits in the open
          body's "$" block. */}
      <CollapsibleTrigger asChild>
      <button type="button" className={'tool-line' + (shell ? ' shell' : '')}>
        <Chevron />
        <span className="tool-mark">{failed ? <FailMark /> : result ? <DoneMark /> : running ? <RunMark /> : null}</span>
        <span className="tool-verb">{head.verb}</span>
        {head.target && (
          <span className={'tool-target' + (head.mono ? ' mono' : '')} title={head.tip && head.tip !== head.target ? head.tip : undefined}>
            {head.target}
          </span>
        )}
        {change && <Counts add={change.add} del={change.del} />}
        {failed && <span className="tool-failed">Failed</span>}
        <span className="sr-only">{failed ? '' : running ? 'running' : result ? 'done' : ''}</span>
      </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Suspense fallback={<div className="tool-body" />}>
          <ToolBody use={use} result={result} change={change} />
        </Suspense>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ToolRun is a run of calls on one line, with its worst status (a failure
// over a running call over passed); open, the calls (and the
// thinking between them) as they were.
export function ToolRun({ parts, render }: { parts: Part[]; render: (p: Part, i: number) => ReactNode }) {
  // Closed until tapped, running or not: open, a turn's commands buried
  // its prose.
  const [open, setOpen] = useState(false)
  const s = summary(parts)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={'tool-run' + (open ? ' open' : '')}>
      <CollapsibleTrigger asChild>
      <button type="button" className="tool-line run-line">
        <Chevron />
        <span className="tool-mark">{s.failed ? <FailMark /> : s.running ? <RunMark /> : <DoneMark />}</span>
        <span className="run-text">
          <span className="run-label">
            {/* Each item stays whole; the "·" starts the next one, so a
                wrapped line never ends on it. */}
            {s.phrases.map(([verb, rest], i) => (
              <Fragment key={i}>
                {i > 0 && ' '}
                <span className="run-seg">
                  {i > 0 && '· '}
                  {verb && <b>{verb}</b>} {rest}
                </span>
              </Fragment>
            ))}
          </span>
          {/* No counts and no "N failed" here: the summary says what was
              done, and the red dot that something failed; the rows inside
              have their own. */}
        </span>
      </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="tool-run-body">{parts.map(render)}</CollapsibleContent>
    </Collapsible>
  )
}

// Thumb is an image as a thumbnail; a click shows it large in a popup that
// a click anywhere (its × too), or Escape, closes.
export function Thumb({ src }: { src: string }) {
  const [big, setBig] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = () => {
    setBig(false)
    btn.current?.focus({ preventScroll: true }) // back where it was opened
  }
  useEffect(() => {
    if (!big) return
    const off = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === 'Tab') e.preventDefault() // its one control keeps the focus
    }
    window.addEventListener('keydown', off)
    return () => window.removeEventListener('keydown', off)
  }, [big])
  return (
    <>
      <button type="button" ref={btn} className="thumb-btn" aria-label="Show the image" onClick={() => setBig(true)}>
        <img className="thumb" src={src} alt="" loading="lazy" />
      </button>
      {big && (
        <div className="lightbox" onClick={close} role="dialog" aria-modal="true" aria-label="Image">
          <img src={src} alt="" />
          <button type="button" className="lightbox-x" aria-label="Close" autoFocus>
            <Icon name="x" />
          </button>
        </div>
      )}
    </>
  )
}

export function Media({ block }: { block: Block }) {
  if (!block.asset) return <span className="media-missing faint small">[{block.type}]</span>
  if (block.type === 'image') return <Thumb src={assetURL(block.asset)} />
  return (
    <a className="media-file" href={assetURL(block.asset)} target="_blank" rel="noreferrer">
      <FileIcon path="file.pdf" />
      PDF · {Math.round((block.size ?? 0) / 1024)} KB
    </a>
  )
}
