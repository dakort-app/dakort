import { lazy, Suspense, useState } from 'react'
import { HTTPError, postJSON } from './api'
import { Icon } from './icons'
import { useStore } from './store'
import { ProjectRoot } from './ToolView'
import type { Permission } from './types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// What the tool would do, as an open tool call shows it (ToolBody.tsx: a
// command, or the edit as a diff), from the same lazily loaded chunk.
const PermInput = lazy(() => import('./ToolBody').then((m) => ({ default: m.PermInput })))

// The CLI asks before running a tool. The first answer from any device
// wins; the others see the card close when the decision comes down the
// stream (a 409 here means another device already answered). Claude takes
// a reason with a denial; Codex's approvals carry none, so its Deny is
// one tap.
export function PermissionCard({ session, perm, more }: { session: string; perm: Permission; more: number }) {
  const codex = useStore((s) => s.sessions.find((x) => x.id === session)?.provider === 'codex')
  const folder = useStore((s) => s.sessions.find((x) => x.id === session)?.folder) ?? ''
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
    <div className="permission" role="region" aria-label="Approval">
      <div className="perm-card">
        <div className="perm-title">
          <Icon name="triangle-alert" sm className="perm-mark" />
          <span className="perm-q">Allow {perm.tool}?</span>
          {more > 0 && (
            <span className="perm-more" title={`${more} more waiting after this one`} data-tip-tap="">
              {more} more
            </span>
          )}
        </div>
        {perm.description && <div className="perm-desc">{perm.description}</div>}
        {perm.reason && <div className="perm-reason">{perm.reason}</div>}
        <Suspense fallback={<div className="perm-input" />}>
          <ProjectRoot.Provider value={folder}>
            <PermInput tool={perm.tool} input={perm.input} />
          </ProjectRoot.Provider>
        </Suspense>
        {perm.blockedPath && <div className="perm-reason">Path: {perm.blockedPath}</div>}
        {denying && (
          <Input
            className="perm-why"
            autoFocus
            placeholder="Tell Claude what to do instead (optional)"
            aria-label="What to do instead"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && answer(false)}
          />
        )}
        {error && <div className="perm-error">{error}</div>}
        <div className="perm-buttons">
          {denying || codex ? (
            <Button variant="outline" size="sm" disabled={sending} onClick={() => answer(false)}>
              Deny
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={sending} onClick={() => setDenying(true)}>
              Deny…
            </Button>
          )}
          <Button variant="default" size="sm" disabled={sending} onClick={() => answer(true)}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  )
}

