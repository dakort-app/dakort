import { useState } from 'react'
import { HTTPError, postJSON } from './api'
import { useStore } from './store'
import type { Permission } from './types'

// The CLI asks before running a tool. The first answer from any device
// wins; the others see the card close when the decision comes down the
// stream (a 409 here means another device already answered). Claude takes
// a reason with a denial; Codex's approvals carry none, so its Deny is
// one tap.
export function PermissionCard({ session, perm, more }: { session: string; perm: Permission; more: number }) {
  const codex = useStore((s) => s.sessions.find((x) => x.id === session)?.provider === 'codex')
  const [why, setWhy] = useState('')
  const [denying, setDenying] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const answer = async (allow: boolean) => {
    setSending(true)
    setError('')
    try {
      await postJSON(`/api/sessions/${session}/permissions/${encodeURIComponent(perm.id)}`, { allow, message: why.trim() })
    } catch (e) {
      if (!(e instanceof HTTPError && e.status === 409)) setError(e instanceof Error ? e.message : String(e))
      setSending(false)
    }
  }

  return (
    <div className="permission">
      <div className="perm-title">
        Allow <b>{perm.tool}</b>?{more > 0 && <span className="faint small"> ({more} more waiting)</span>}
      </div>
      {perm.description && <div className="small">{perm.description}</div>}
      {perm.reason && <div className="faint small">{perm.reason}</div>}
      <ToolInput tool={perm.tool} input={perm.input} />
      {perm.blockedPath && <div className="faint small">Path: {perm.blockedPath}</div>}
      {denying && (
        <input
          className="filter wide"
          autoFocus
          placeholder="Tell Claude what to do instead (optional)"
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && answer(false)}
        />
      )}
      {error && <div className="error small">{error}</div>}
      <div className="row-buttons">
        {denying || codex ? (
          <button className="btn" disabled={sending} onClick={() => answer(false)}>
            Deny
          </button>
        ) : (
          <button className="btn" disabled={sending} onClick={() => setDenying(true)}>
            Deny…
          </button>
        )}
        <button className="btn primary" disabled={sending} onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </div>
  )
}

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… ${s.length - n} more characters` : s)

// ToolInput shows what the tool would do in the form a person checks it:
// the command for a shell, the file and the change for an edit.
function ToolInput({ tool, input }: { tool: string; input: unknown }) {
  const inp = (input ?? {}) as Record<string, unknown>
  const s = (k: string) => (typeof inp[k] === 'string' ? (inp[k] as string) : '')
  if ((tool === 'Bash' || tool === 'PowerShell') && s('command')) {
    return <div className="pre small perm-input">{clip(s('command'))}</div>
  }
  if ((tool === 'Edit' || tool === 'MultiEdit') && s('file_path')) {
    return (
      <div className="perm-input">
        <div className="small">{s('file_path')}</div>
        {s('old_string') && <div className="pre small diff-old">{clip(s('old_string'), 1500)}</div>}
        {s('new_string') && <div className="pre small diff-new">{clip(s('new_string'), 1500)}</div>}
      </div>
    )
  }
  if (tool === 'Write' && s('file_path')) {
    return (
      <div className="perm-input">
        <div className="small">{s('file_path')}</div>
        <div className="pre small diff-new">{clip(s('content'), 1500)}</div>
      </div>
    )
  }
  if (input === undefined) return null
  return <div className="pre small perm-input">{clip(JSON.stringify(input, null, 2))}</div>
}
