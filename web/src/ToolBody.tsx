import { useContext, useState, type ReactNode } from 'react'
import { copyText } from './clip'
import { CheckIcon, CopyIcon, Icon } from './icons'
import { resultText } from './rows'
import { baseName, editChange, type DiffLine, type EditChange } from './tools'
import { Counts, Media, ProjectRoot } from './ToolView'
import type { Block } from './types'
import './ToolBody.css'

// An open tool call (ToolView.tsx), in its own chunk: an edit as a diff, a
// command as a terminal, other calls as their fields, the raw JSON behind
// a toggle. The permission card shows what a tool would do the same way.

const maxResult = 20_000
const shortOutput = 14 // lines of output shown before "Show all"
const shortDiff = 80 // lines of a diff shown before "Show all"
const dirOf = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length)).replace(/[\\/]+$/, '')
// A path inside the project, from the project's folder.
const within = (p: string, root: string) => (root && p.startsWith(root) && /[\\/]/.test(p[root.length] ?? '') ? p.slice(root.length + 1) : p)

export default function ToolBody({ use, result, change }: { use: Block; result?: Block; change?: EditChange }) {
  const [raw, setRaw] = useState(false)
  const inp = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<string, unknown>
  const text = resultText(result)
  const media = (result?.content ?? []).filter((c) => c.type === 'image' || c.type === 'document')
  const shell = (use.name === 'Bash' || use.name === 'PowerShell') && typeof inp.command === 'string'
  let body: ReactNode
  if (raw) {
    body = (
      <>
        <pre className="raw">{JSON.stringify(use.input, null, 2)}</pre>
        {result && <pre className="raw">{clip(text)}</pre>}
      </>
    )
  } else if (change) {
    // An edit's result is "The file … has been updated": only a failure says something.
    body = (
      <>
        <DiffCard change={change} />
        {result?.isError && <Output text={text} failed />}
      </>
    )
  } else if (shell) {
    body = <Terminal command={inp.command as string} output={result ? text : undefined} failed={!!result?.isError} />
  } else {
    body = (
      <>
        <Fields input={inp} />
        {result && (text || !media.length) && <Output text={text} failed={!!result.isError} />}
      </>
    )
  }
  return (
    <div className="tool-body">
      {body}
      {!raw && media.map((b, i) => <Media key={i} block={b} />)}
      <button type="button" className="raw-toggle" aria-pressed={raw} onClick={() => setRaw(!raw)}>
        <Icon name="braces" sm />
        {raw ? 'Formatted' : 'Raw'}
      </button>
    </div>
  )
}

const clip = (s: string, n = maxResult) => (s.length > n ? s.slice(0, n) + `\n… ${s.length - n} more characters` : s)

// DiffCard is an edit as a unified diff: the file and its counts over the
// changed lines, each with a gutter bar and its sign as well as its wash.
function DiffCard({ change, limit = shortDiff }: { change: EditChange; limit?: number }) {
  const [all, setAll] = useState(false)
  const total = change.hunks.reduce((n, h) => n + h.length, 0)
  let left = all ? Infinity : limit
  const dir = dirOf(within(change.path, useContext(ProjectRoot)))
  return (
    <div className="diff-card">
      <div className="diff-head">
        <span className="diff-path" title={change.path}>
          {/* The file bar's form of a path: its folder, then its name. */}
          {dir && <span className="diff-dir">{dir}/</span>}
          <b>{baseName(change.path) || 'file'}</b>
        </span>
        <Counts add={change.add} del={change.del} />
      </div>
      <div className="diff-lines" role="table" aria-label={`Changes to ${change.path}`}>
        {change.hunks.map((h, k) => {
          if (left <= 0) return null
          const shown = h.slice(0, left)
          left -= shown.length
          return (
            <div key={k} className="diff-hunk">
              {shown.map((l, i) => (
                <Line key={i} line={l} />
              ))}
            </div>
          )
        })}
      </div>
      {total > limit && (
        <button type="button" className="show-all" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${total} lines`}
        </button>
      )}
    </div>
  )
}

function Line({ line }: { line: DiffLine }) {
  const cls = line.op === '+' ? 'add' : line.op === '-' ? 'del' : 'ctx'
  return (
    <div className={'diff-line ' + cls} role="row">
      <span className="diff-sign" aria-label={line.op === '+' ? 'added' : line.op === '-' ? 'removed' : undefined}>
        {line.op === '-' ? '−' : line.op}
      </span>
      <span className="diff-text">{line.text || ' '}</span>
    </div>
  )
}

// Terminal is a command and what it printed; a failure is marked with a
// cross and the word, the output itself stays readable.
function Terminal({ command, output, failed }: { command: string; output?: string; failed?: boolean }) {
  return (
    <div className="term">
      <div className="term-cmd">
        <span className="term-text">
          <span className="term-prompt" aria-hidden="true">
            $
          </span>
          {command}
        </span>
        <CopyButton text={command} />
      </div>
      {output !== undefined && <Output text={output} failed={failed} inTerm />}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={'code-copy' + (done ? ' copied' : '')}
      aria-label={done ? 'Copied' : 'Copy the command'}
      title="Copy"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        }
      }}
    >
      <CopyIcon />
      <CheckIcon />
      <span className="code-copy-label">Copy</span>
      <span className="code-copy-done">Copied</span>
    </button>
  )
}

// Output is what a call printed; a failure is a red bar at its edge (the
// row above already says Failed).
function Output({ text, failed, inTerm }: { text: string; failed?: boolean; inTerm?: boolean }) {
  const [all, setAll] = useState(false)
  const body = clip(text.replace(/\s+$/, ''))
  const n = body ? body.split('\n').length : 0
  const long = n > shortOutput
  return (
    <div className={'term-out-wrap' + (inTerm ? '' : ' term') + (failed ? ' failed' : '')}>
      {body ? (
        <pre className={'term-out' + (long && !all ? ' short' : '')}>{body}</pre>
      ) : (
        <div className="term-empty">{failed ? '' : 'No output'}</div>
      )}
      {long && (
        <button type="button" className="show-all" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${n} lines`}
        </button>
      )}
    </div>
  )
}

// Fields is a call's input as names and values, long text in the code face.
function Fields({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== '')
  if (!entries.length) return null
  return (
    <dl className="kv">
      {entries.map(([k, v]) => {
        const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
        return (
          <div key={k} className="kv-row">
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd className={typeof v === 'string' && !/\n/.test(v) && v.length < 120 ? '' : 'mono-block'}>{clip(s, 4000)}</dd>
          </div>
        )
      })}
    </dl>
  )
}

// PermInput shows what the tool would do in the form a person checks it:
// the command for a shell, the change as a diff for an edit or a write.
export function PermInput({ tool, input }: { tool: string; input: unknown }) {
  const inp = (input ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof inp[k] === 'string' ? (inp[k] as string) : '')
  if ((tool === 'Bash' || tool === 'PowerShell') && s('command')) {
    return (
      <div className="perm-input">
        <Terminal command={clip(s('command'), 4000)} />
      </div>
    )
  }
  const change = s('file_path') ? editChange({ type: 'tool_use', name: tool, input }) : undefined
  if (change) {
    return (
      <div className="perm-input">
        <DiffCard change={change} limit={200} />
      </div>
    )
  }
  if (input === undefined) return null
  return <pre className="perm-input raw">{clip(JSON.stringify(input, null, 2), 4000)}</pre>
}
