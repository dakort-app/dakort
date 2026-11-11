import { useEffect, useRef, useState } from 'react'
import { api, HTTPError } from './api'
import type { SignInState } from './api'

// The notice under a turn that failed because the CLI is not signed in,
// with the sign-in itself: the server runs the CLI's own login command
// and the page shows its link. Claude's link ends on a page with a code
// to paste back here; Codex's shows a one-time code to type on its page
// and finishes by itself. Both work from a phone. The terminal way stays
// as the fallback line.
export function SignIn({ cli }: { cli: 'claude' | 'codex' }) {
  const who = cli === 'codex' ? 'Codex' : 'Claude'
  const [st, setSt] = useState<SignInState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [code, setCode] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const start = async () => {
    setBusy(true)
    setErr('')
    try {
      setSt(await api.signIn(cli))
    } catch (e) {
      setErr(e instanceof HTTPError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const paste = async () => {
    if (!code.trim()) {
      input.current?.focus()
      return
    }
    setBusy(true)
    setErr('')
    try {
      setSt(await api.signInCode(cli, code))
    } catch (e) {
      setErr(e instanceof HTTPError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // While waiting, ask for the state now and then: Codex finishes on its
  // own once the code is typed, and Claude once the code is pasted.
  const waiting = st?.state === 'waiting'
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => api.signInState(cli).then(setSt).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [waiting, cli])

  if (st?.state === 'done') {
    return <div className="notice info signin">Signed in. Send your message again.</div>
  }
  if (!st || st.state === 'failed') {
    return (
      <div className="notice error signin">
        <div>
          {who} is not signed in on this machine.
          {st?.error ? ` The sign-in failed: ${st.error}` : ''}
        </div>
        <div className="row-buttons">
          <button className="btn primary" onClick={start} disabled={busy}>
            {busy ? 'Starting…' : st ? 'Try again' : 'Sign in'}
          </button>
        </div>
        <div className="faint small">
          Or, in a terminal on the computer, run <code>{cli}</code> once and sign in there.
        </div>
        {err && <div>{err}</div>}
      </div>
    )
  }
  return (
    <div className="notice error signin">
      <div>
        Open{' '}
        <a href={st.url} target="_blank" rel="noopener noreferrer">
          the {who} sign-in page
        </a>{' '}
        and sign in there.
        {cli === 'codex' && st.code ? (
          <>
            {' '}
            It asks for this code: <code className="signin-code">{st.code}</code>
          </>
        ) : null}
      </div>
      {cli === 'claude' ? (
        <>
          <div>Then paste the code it shows you here.</div>
          <div className="row-buttons">
            <input
              ref={input}
              className="signin-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && paste()}
              placeholder="the code"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn primary" onClick={paste} disabled={busy}>
              {busy ? 'Checking…' : 'Done'}
            </button>
          </div>
        </>
      ) : (
        <div className="faint small">Waiting for the sign-in to finish…</div>
      )}
      {err && <div>{err}</div>}
    </div>
  )
}
